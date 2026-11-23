import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { budgetOutageIntervals } from "../core/scheduling/host-outage";
import {
  recordServiceAlive,
  recordServiceStart,
  SERVICE_ALIVE_INTERVAL_MS,
  SERVICE_DOWNTIME_HISTORY_META_KEY,
  SERVICE_DOWNTIME_RETENTION_MS,
  SERVICE_LIVENESS_META_KEY,
  serviceDowntimeIntervals,
} from "../core/scheduling/service-downtime";
import { recoveryDispatchSnapshot } from "../core/recovery/recovery-context";
import { PLANNER_ONLY_WARNINGS } from "../shared/schema/resolution-warnings";
import { OPERATOR_ONLY_WARNING_IDS, PLANNER_ONLY_WARNING_IDS, explicitOutcome } from "../bin/explicit-outcome.mjs";
import { OPERATOR_ONLY_WARNINGS } from "../core/verbs/explicit-integration";
import { unproductiveCoordinatorRuns, taskWorkIdentity } from "../core/recovery/recovery-bound";
import { ROUND_TELL_RETRY_MS } from "../core/questions/joint-review-question";
import { formatAgentId } from "../shared/agent-identity";
import { runSchema } from "../shared/contracts";
import { runStartWarnings } from "../core/verbs/explicit-run-start";
import { resolveExplicitly } from "../core/verbs/explicit-resolution";
import { explicitResolutionSchema } from "../shared/schema/task-control";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import type { Adapter } from "../core/host";
import { OPERATOR_BOARD_CALLER, submissionSchema, taskControlInputSchema } from "../shared/contracts";
import { TASK_PROGRESSING_REASON } from "../shared/task-detail-summary";
import { AUTOMATIC_BUDGET_EXTENSION_DETAIL, taskBudget } from "../shared/task-budget";
import { QueueRuntime } from "../service/runtime-owner";
import { fixture, tick } from "./support/responsible-lifecycle-fixture";
import { callerCliFixture } from "./support/caller-cli-fixture";

/**
 * Spec 068 batch 5a: budgets, caps and the round-3 question follow the approved
 * policy (Decisions 1 and 2, Tom 2026-11-22). Each case runs the real path with the
 * stored shapes the scheduler, the sweep and `next` read.
 */

const MINUTE = 60_000;
const iso = (at: number) => new Date(at).toISOString();

/** The smallest host adapter a runtime owner starts with; no task here is sent anywhere. */
function idleAdapter(root: string): Adapter {
  return {
    hostId: "paseo-fixture",
    socketPath: join(root, "callback.sock"),
    helperPath: join(root, "helper.mjs"),
    client: { isConnected: true },
    isConnected: () => true,
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
    listLiveAgents: async () => [],
  } as unknown as Adapter;
}

test("a service roll's downtime spends no task budget, measured from the drain and the next start", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-downtime-"));
  const dataDir = join(root, "nucleus");
  try {
    const first = new QueueRuntime({ dataDir, adapterFactory: () => idleAdapter(root), timers: false });
    const task = first.store.insert(
      submissionSchema.parse({
        submissionId: "downtime", title: "Downtime", repoPath: "/example", planningCommit: "a".repeat(40),
        handoffPath: "handoff.md", originAgentId: "owner",
      }),
      "paseo-fixture", "Handoff", "a".repeat(40),
    );
    // A medium task (180 minutes) whose worker started four hours ago.
    first.store.update(task.id, { phase: "working", budgetSince: iso(Date.now() - 240 * MINUTE) });
    first.store.event(task.id, "agent_created", "worker");
    first.store.db.prepare("UPDATE events SET at=? WHERE taskId=? AND kind='agent_created'").run(iso(Date.now() - 240 * MINUTE), task.id);
    assert.equal(first.store.getMeta<{ owner: string }>(SERVICE_LIVENESS_META_KEY)?.owner, first.owner, "the start stamps the owner");
    // The roll drains the old service; its drain is where downtime begins.
    await first.drain();

    // The roll took three and a half hours: the drained owner's last-alive stamp is
    // dated then, as it would be had the drain happened 210 minutes ago.
    const { Store } = await import("../core/store/store");
    const store = new Store(join(dataDir, "queue.sqlite"));
    try {
      const liveness = store.getMeta<{ owner: string; startedAt: string; aliveAt: string }>(SERVICE_LIVENESS_META_KEY)!;
      assert.equal(liveness.owner, first.owner);
      assert.ok(Date.now() - Date.parse(liveness.aliveAt) < 60_000, "the drain stamped the owner alive");
      store.setMeta(SERVICE_LIVENESS_META_KEY, { ...liveness, aliveAt: iso(Date.now() - 210 * MINUTE) });
    } finally { store.close(); }
    const second = new QueueRuntime({ dataDir, adapterFactory: () => idleAdapter(root), timers: false });
    try {
      const downtime = serviceDowntimeIntervals(second.store);
      assert.equal(downtime.length, 1, "the next start closed the window since the previous owner's drain");
      const roll = downtime.at(-1)!;
      assert.ok(Date.parse(roll.until!) - Date.parse(roll.since) >= 209 * MINUTE, `the roll window is recorded: ${JSON.stringify(roll)}`);
      const current = second.store.task(task.id);
      const runs = second.store.runs(task.id), events = second.store.eventsAll(task.id);
      const without = taskBudget(current, runs, Date.now(), events, null, []);
      assert.equal(without.exhausted, "wall_time", "the same task with the roll counted would be spent");
      const measured = taskBudget(current, runs, Date.now(), events, null, budgetOutageIntervals(second.store, current.hostId));
      assert.equal(measured.exhausted, null, `the roll is discounted: ${measured.wallMs.used / MINUTE} minutes used`);
      assert.ok(measured.wallMs.pausedMs >= 209 * MINUTE);
      // The sweep's own settle pass reads the same figure: nothing is spent, so
      // nothing is extended and no stop is written.
      second.engine.resolution.settleBudgetClock(current);
      assert.equal(second.store.eventsAll(task.id).filter(event => event.kind === "budget_extended").length, 0);
      assert.equal(second.store.task(task.id).resolution.stop, null);
    } finally { await second.drain(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the first spent budget is extended automatically with its event; the second spend stops and asks", async () => {
  const f = fixture({ responsible: true });
  try {
    // A medium task (180 minutes) whose worker reported four hours after it started.
    f.store.update(f.submitted.id, { budgetSince: iso(Date.now() - 240 * MINUTE) });
    f.recordRunStart(iso(Date.now() - 240 * MINUTE));
    await f.engine.wake();
    const extended = f.events("budget_extended");
    assert.equal(extended.length, 1, "Nucleus extended the spent budget once");
    assert.ok(extended[0]!.detail.startsWith(`${AUTOMATIC_BUDGET_EXTENSION_DETAIL};`), extended[0]!.detail);
    assert.match(extended[0]!.detail, /^automatic: Spec 068 Decision 1/);
    assert.equal(f.current().resolution.budgetExtensions, 1);
    assert.notEqual(f.current().resolution.stop?.reason, "budget", "the first spend is not a stop");
    assert.equal(f.run().role, "reviewer", "the review starts under the extended budget");
    assert.equal(f.asks.length, 0, "nobody is asked about the first spend");

    // The extended limit is spent too: 420 minutes, and the task has run for 8 hours.
    f.store.update(f.submitted.id, { budgetSince: iso(Date.now() - 480 * MINUTE) });
    f.recordRunStart(iso(Date.now() - 480 * MINUTE));
    await f.report("changes_required");
    await f.settle(2);
    const stopped = f.current();
    assert.equal(stopped.resolution.stop?.reason, "budget", stopped.reason);
    assert.match(stopped.resolution.stop!.detail, /^Budget reached: 420 minutes of wall time/);
    assert.equal(f.events("budget_extended").length, 1, "no second automatic extension");
    for (let pass = 0; pass < 30 && f.asks.length === 0; pass++) await tick();
    assert.equal(f.asks.length, 1, "the second spend raises the ordinary budget question");
    assert.match(f.asks[0]!.question, /reached its budget/);
    assert.match(f.events("operator_question")[0]!.detail, /kind budget/);
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, stopped));
    assert.equal(next.stop?.reason, "budget");
    assert.equal(next.verbs.find(view => view.verb === "extend_budget")?.available, true);
    const start = next.explicitCommands?.find(command => command.action === "run.start" && (command.args.accept as string[] | undefined)?.includes("budget"));
    assert.ok(start, "the stop carries run.start accepting the budget warning");
    assert.ok(start!.warnings?.includes("budget"));
  } finally { await f.close(); }
});

test("a revision-capped task shows a typed stop with its commands, and run.start warns only at the scheduler's own cap", async () => {
  const f = fixture({ responsible: true });
  try {
    await f.reviews(7);
    await f.settle(2);
    const capped = f.current();
    assert.equal(f.events("revision_budget_exhausted").length, 1, "the seventh changes_required review parks at the cap");
    assert.equal(capped.resolution.revisionRuns, 6);
    const read = () => ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    const parked = read();
    assert.notEqual(parked.reason, TASK_PROGRESSING_REASON);
    assert.ok(parked.stop, "the cap is the task's stop");
    const commandFor = (next: ReturnType<typeof read>) => next.explicitCommands?.find(command =>
      command.action === "run.start" && command.args.role === "worker" && (command.args.accept as string[] | undefined)?.includes("budget"));
    assert.ok(commandFor(parked), "the cap carries run.start for the worker accepting budget");
    assert.match(commandFor(parked)!.note, /Revision cap reached: 6 of 6 review rounds/);
    assert.ok(commandFor(parked)!.warnings?.includes("budget"));

    // The cap's stop is cleared without an author round starting: it is still the cap.
    const stop = f.current().resolution.stop!;
    const clearing = await resolveExplicitly(f.engine, explicitResolutionSchema.parse({
      action: "record.clear", taskId: f.current().id, version: f.current().version, kind: "stop", id: stop.since,
      reason: "Clear the stop", caller: OPERATOR_BOARD_CALLER,
    }), () => "");
    assert.equal(clearing.explicitResolution?.status, "applied");
    assert.equal(f.current().resolution.stop, null);
    const cleared = read();
    assert.equal(cleared.stop?.reason, "operator_needed");
    assert.match(cleared.stop?.detail ?? "", /^Revision cap reached: 6 of 6 review rounds/);
    assert.match(cleared.reason, /^Revision cap reached/);
    assert.equal(cleared.activity?.state, "needs_person");
    assert.ok(commandFor(cleared));

    // The planner approves a round: inside it, six rounds are not the cap.
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: "move", to: "work", taskId: f.current().id, version: f.current().version,
      instruction: "One more round on the remaining finding", reason: "The planner approved one round", caller: OPERATOR_BOARD_CALLER,
    }));
    await f.settle(2);
    assert.equal(f.run().role, "revision", "the approved round runs");
    const inRound = runStartWarnings(f.store, f.current(), { role: "worker", agent: "fresh" }).map(warning => warning.id);
    assert.equal(inRound.includes("budget"), false, `no budget warning inside an approved round: ${inRound.join(", ")}`);
  } finally { await f.close(); }
});

test("the CLI prints an explicit command's outcome first and exits non-zero unless it applied (papercut ee6e634c)", async () => {
  let status: "warnings" | "applied" | "stale" = "warnings";
  const f = await callerCliFixture(false, {
    // The service's answer to an explicit command: the task, then its resolution.
    "queue.task": (input: { version: number }) => ({
      ...f.task,
      version: status === "stale" ? input.version + 1 : input.version,
      explicitResolution: {
        status,
        warnings: status === "applied" ? [] : status === "stale" ? [] : [
          { id: "duplicate_thread", text: "Another unreleased or uncertain worker run exists on this task." },
          { id: "two_writers", text: "Another worker or executor may still be live in this task's worktree." },
        ],
        ...(status === "applied" ? { runId: "run-2" } : {}),
        next: "The next scheduler pass handles the task.",
      },
    }),
  });
  try {
    const payload = { taskId: f.task.id, version: f.task.version, role: "worker", agent: "fresh", replacing: "run-1", reason: "Replace the uncertain worker" };
    const refused = await f.invoke("host", "queue-cli.mjs", ["run.start", "-"], payload);
    assert.equal(refused.code, 2, refused.stderr);
    assert.ok(refused.stderr.startsWith("warnings: duplicate_thread, two_writers"), refused.stderr);
    assert.match(refused.stderr, /not applied; resend with "accept": \["duplicate_thread","two_writers"\]/);
    assert.equal(JSON.parse(refused.stdout).explicitResolution.status, "warnings", "the JSON body stays for machines");
    assert.equal(f.calls.at(-1)?.input.action, "run.start");

    status = "stale";
    const stale = await f.invoke("host", "queue-cli.mjs", ["run.start", "-"], payload);
    assert.equal(stale.code, 2);
    assert.match(stale.stderr, /^stale: not applied/);

    status = "applied";
    const applied = await f.invoke("host", "queue-cli.mjs", ["run.start", "-"], { ...payload, accept: ["duplicate_thread", "two_writers"] });
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stderr, /^applied \(run run-2\)/);
  } finally { await f.close(); }
});

/** The service liveness record lives in meta; this is the meta surface it reads and writes. */
function metaStore() {
  const meta = new Map<string, unknown>();
  return {
    getMeta: <T>(key: string) => meta.get(key) as T,
    setMeta: (key: string, value: unknown) => { meta.set(key, value); },
  };
}

test("a beat records the time the monotonic clock did not see (sleep); an event-loop stall of the same wall length records nothing", () => {
  const store = metaStore();
  const start = Date.parse("2026-11-20T08:00:00.000Z");
  const second = 1_000_000_000n, minute = 60n * second;
  recordServiceStart(store, "owner-sleep", iso(start), 1_000n * second);
  recordServiceAlive(store, "owner-sleep", iso(start + SERVICE_ALIVE_INTERVAL_MS), 1_000n * second + minute);
  // A seven-minute event-loop stall: the beat is late, but both clocks advanced.
  const stalled = start + 8 * MINUTE;
  recordServiceAlive(store, "owner-sleep", iso(stalled), 1_000n * second + 8n * minute);
  assert.deepEqual(serviceDowntimeIntervals(store), [], "a stall advances both clocks, so nothing is downtime");
  // Seven hours of sleep: the wall clock moved on, the monotonic clock one minute.
  const woke = stalled + 421 * MINUTE;
  recordServiceAlive(store, "owner-sleep", iso(woke), 1_000n * second + 9n * minute);
  assert.deepEqual(serviceDowntimeIntervals(store), [{ since: iso(woke - 420 * MINUTE), until: iso(woke) }],
    "only the time the monotonic clock did not see is downtime");
  assert.equal(store.getMeta<{ aliveAt: string }>(SERVICE_LIVENESS_META_KEY).aliveAt, iso(woke));
  // Another owner's record is never touched.
  recordServiceAlive(store, "owner-other", iso(woke + 600 * MINUTE), 1_000n * second + 10n * minute);
  assert.equal(serviceDowntimeIntervals(store).length, 1);
});

test("service downtime history keeps entries by age, not by count", () => {
  const store = metaStore();
  const now = Date.parse("2026-11-23T08:00:00.000Z");
  const old = now - SERVICE_DOWNTIME_RETENTION_MS - 60 * MINUTE;
  // Three hundred rolls inside the retention, plus one older than it.
  store.setMeta(SERVICE_DOWNTIME_HISTORY_META_KEY, [
    { since: iso(old - MINUTE), until: iso(old) },
    ...Array.from({ length: 300 }, (_, index) => ({
      since: iso(now - (index + 2) * 60 * MINUTE), until: iso(now - (index + 2) * 60 * MINUTE + MINUTE),
    })),
  ]);
  store.setMeta(SERVICE_LIVENESS_META_KEY, { owner: "owner-a", startedAt: iso(now - 2 * MINUTE), aliveAt: iso(now - MINUTE) });
  recordServiceStart(store, "owner-retention", iso(now));
  const history = serviceDowntimeIntervals(store);
  assert.equal(history.length, 301, "every recent roll is kept, past the old count limit of 200");
  assert.ok(history.every(entry => Date.parse(entry.until!) >= now - SERVICE_DOWNTIME_RETENTION_MS), "the older entry is dropped");
  assert.deepEqual(history.at(-1), { since: iso(now - MINUTE), until: iso(now) });
});

/** A task with no live run whose worker started eight hours ago, so a medium budget is spent. */
function spentTask(f: ReturnType<typeof fixture>, phase: string, budgetExtensions: number) {
  f.store.update(f.submitted.id, {
    phase: phase as never, prHead: "b".repeat(40), agentActive: false, agentIntent: false,
    budgetSince: iso(Date.now() - 480 * MINUTE),
    resolution: { ...f.current().resolution, budgetExtensions, stop: null },
  });
  f.recordRunStart(iso(Date.now() - 480 * MINUTE));
}
const budgetCommand = (next: ReturnType<typeof ownerTaskNext>) => next.explicitCommands?.find(command =>
  command.action === "run.start" && (command.args.accept as string[] | undefined)?.includes("budget"));

test("a merging task with a second spent budget is offered no run, and its first spend is not extended there", async () => {
  const f = fixture({ responsible: true });
  try {
    spentTask(f, "merging", 1);
    const merging = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.equal(budgetCommand(merging), undefined, `no run is next while merging: ${JSON.stringify(merging.explicitCommands)}`);
    assert.notEqual(merging.stop?.reason, "budget");

    // The first spend while merging keeps its one automatic extension for a stage that needs a run.
    spentTask(f, "merging", 0);
    f.engine.resolution.settleBudgetClock(f.current());
    assert.equal(f.events("budget_extended").length, 0, "the sweep extends nothing while merging");
    assert.equal(f.current().resolution.stop, null);
  } finally { await f.close(); }
});

test("a first spend is not shown as needing a person before the sweep extends it; a second spend is", async () => {
  const f = fixture({ responsible: true });
  try {
    spentTask(f, "changes_requested", 0);
    const first = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.notEqual(first.stop?.reason, "budget", "the first spend is the sweep's to extend");
    assert.notEqual(first.activity?.detail, "Budget reached");
    assert.equal(budgetCommand(first), undefined, "no accept-budget command for a first spend");
    assert.equal(runStartWarnings(f.store, f.current(), { role: "worker", agent: "retained" })
      .some(warning => warning.id === "budget"), false, "run.start names no budget warning for a first spend");

    spentTask(f, "changes_requested", 1);
    const second = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.equal(second.stop?.reason, "budget");
    assert.equal(second.activity?.state, "needs_person");
    assert.ok(budgetCommand(second), "the second spend carries run.start accepting budget");
    // The coordinator's snapshot leaves out a command it would be refused.
    const snapshot = recoveryDispatchSnapshot(collectOwnerVerbFacts(f.store, f.current()),
      { cause: "budget", target: "worker", recoveryRunId: "recovery" });
    assert.equal((snapshot.explicitCommands ?? []).some(command =>
      ((command.args as { accept?: string[] }).accept ?? []).includes("budget")), false);
  } finally { await f.close(); }
});

test("a round-3 tell lost before its intent is sent by the task's next pass; one with an intent is never resent", async () => {
  const f = fixture({ responsible: true });
  const tells = () => f.prompts.filter(prompt => prompt.messageId.startsWith("ns-review-round-"));
  const told = async (count: number) => {
    for (let i = 0; i < 50 && f.events("review_round_planner_told").length < count; i++) await tick();
  };
  try {
    await f.reviews(3);
    await f.settle(2);
    await told(1);
    assert.equal(tells().length, 1);
    // The service stopped after the continued marker and before the tell's intent.
    f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind IN ('review_round_planner_tell_intent','review_round_planner_told')")
      .run(f.submitted.id);
    await f.settle(2);
    await told(1);
    assert.equal(tells().length, 2, "the task's pass sends the lost tell");
    assert.equal(f.events("review_round_planner_tell_intent").length, 1);
    assert.equal(f.events("review_round_continued").length, 1, "the round is continued once");

    // A tell whose intent is recorded but whose outcome is not may have landed: never resent.
    f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind='review_round_planner_told'").run(f.submitted.id);
    await f.settle(2);
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(tells().length, 2);
  } finally { await f.close(); }
});

test("the CLI marks the warning IDs only a planner or the operator board may accept, matching the service's sets", () => {
  assert.deepEqual([...PLANNER_ONLY_WARNING_IDS].sort(), [...PLANNER_ONLY_WARNINGS].sort());
  assert.deepEqual([...OPERATOR_ONLY_WARNING_IDS].sort(), [...OPERATOR_ONLY_WARNINGS].sort());
  const outcome = explicitOutcome({ explicitResolution: { status: "warnings", warnings: [
    { id: "duplicate_thread", text: "" }, { id: "budget", text: "" }, { id: "unverified_merge", text: "" },
  ] } })!;
  assert.equal(outcome.line,
    'warnings: duplicate_thread, budget, unverified_merge (not applied; resend with "accept": ["duplicate_thread","budget","unverified_merge"] to apply; '
    + "only the live responsible planner or the operator board may accept budget; only the operator board may accept unverified_merge)");
});

test("a round-3 tell missed for want of a planner is retried on a later pass; it is sent once one exists", async () => {
  const f = fixture({ responsible: true });
  const tells = () => f.prompts.filter(prompt => prompt.messageId.startsWith("ns-review-round-"));
  try {
    const resolution = f.engine.resolution as unknown as { taskPlannerFor: (task: unknown) => Promise<unknown>; projectPlannerFor: (task: unknown) => Promise<unknown> };
    const taskPlanner = resolution.taskPlannerFor.bind(resolution), projectPlanner = resolution.projectPlannerFor.bind(resolution);
    let planner = false;
    resolution.taskPlannerFor = async task => planner ? taskPlanner(task) : null;
    resolution.projectPlannerFor = async task => planner ? projectPlanner(task) : { planner: null };
    await f.reviews(3);
    await f.settle(2);
    for (let i = 0; i < 30 && !f.events("review_round_planner_tell_missed").length; i++) await tick();
    assert.equal(f.events("review_round_planner_tell_missed").length, 1);
    assert.equal(tells().length, 0);
    await f.settle(2);
    assert.equal(f.events("review_round_planner_tell_missed").length, 1, "a retry inside the interval does nothing, and a repeat miss is one event");

    // A planner exists now, and the retry interval has passed.
    planner = true;
    const realNow = Date.now;
    Date.now = () => realNow() + ROUND_TELL_RETRY_MS + 1_000;
    try {
      await f.settle(2);
      for (let i = 0; i < 50 && !f.events("review_round_planner_told").length; i++) await tick();
    } finally { Date.now = realNow; }
    assert.equal(tells().length, 1, "the missed tell is sent on a later pass");
    assert.equal(f.events("review_round_planner_tell_intent").length, 1);
  } finally { await f.close(); }
});

test("a revision launch past the cap holds and goes to the planner ladder, never a coordinator, until a planner or the operator accepts a round", async () => {
  const f = fixture({ responsible: true });
  try {
    await f.reviews(7);
    await f.settle(2);
    assert.equal(f.events("revision_budget_exhausted").length, 1);
    const revisions = () => f.store.runs(f.current().id).filter(run => run.role === "revision").length;
    const escalations = () => f.events("planner_escalation");
    const capCoordinators = () => f.events("telemetry_recovery").filter(event => /Revision cap/.test(event.detail));
    const atCap = revisions();
    assert.equal(escalations().length, 1, "the cap park escalated to the planner");
    const capEscalation = escalations()[0]!.detail.split(":", 1)[0]!;
    const phaseSet = (caller: string) => resolveExplicitly(f.engine, explicitResolutionSchema.parse({
      action: "phase.set", taskId: f.current().id, version: f.current().version, to: "changes_requested",
      reason: "Send it back to the worker", caller, accept: ["live_runs"],
    }), () => "");

    // The operator board, without accepting the cap, moves the phase: the launch holds
    // and joins the cap's open escalation.
    assert.equal((await phaseSet(OPERATOR_BOARD_CALLER)).explicitResolution?.status, "applied");
    await f.settle(3);
    assert.equal(revisions(), atCap, "no seventh revision run starts");
    assert.equal(f.current().resolution.stop?.reason, "escalated", f.current().resolution.stop?.detail);
    assert.ok(f.current().resolution.stop?.detail.includes(capEscalation), "the hold waits on the cap's open escalation");
    assert.equal(escalations().length, 1, "no second question while the first is open");
    assert.equal(capCoordinators().length, 0, "no coordinator is launched for the hold");

    // The escalation is settled without a round; a coordinator then moves the phase.
    const cleared = await resolveExplicitly(f.engine, explicitResolutionSchema.parse({
      action: "record.clear", taskId: f.current().id, version: f.current().version, kind: "escalation", id: capEscalation,
      reason: "Clear the escalation", caller: OPERATOR_BOARD_CALLER,
    }), () => "");
    assert.equal(cleared.explicitResolution?.status, "applied", JSON.stringify(cleared.explicitResolution));
    const coordinator = runSchema.parse({
      id: "cap-coordinator", taskId: f.current().id, role: "recovery", generation: 1, head: f.current().prHead,
      base: f.current().prHead, agentId: "cap-coordinator-agent", workspaceId: "workspace", profile: null,
      status: "running", createdAt: new Date().toISOString(), lastObservedAt: null, idleSince: null, active: true,
      completion: null, released: false,
    });
    f.store.putRun(coordinator);
    f.store.update(f.current().id, { phase: "needs_attention", resolution: { ...f.current().resolution, stop: null,
      recovery: { id: "cap-episode", key: "cap", generation: 1, runId: coordinator.id, agentId: coordinator.agentId,
        status: "running", summary: "Cap", idleSince: null, incidentId: null } } });
    const caller = formatAgentId(f.current().hostId ?? "host", coordinator.agentId!);
    assert.equal((await phaseSet(caller)).explicitResolution?.status, "applied");
    // While its run is unreleased, the coordinator's snapshot offers no command it would be refused.
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.ok(next.explicitCommands?.some(command => command.warnings?.includes("budget")), JSON.stringify(next.explicitCommands));
    const snapshot = recoveryDispatchSnapshot(collectOwnerVerbFacts(f.store, f.current()),
      { cause: "cap", target: "worker", recoveryRunId: coordinator.id });
    assert.equal((snapshot.explicitCommands ?? []).some(command =>
      (command.warnings ?? []).some(id => (PLANNER_ONLY_WARNINGS as ReadonlySet<string>).has(id))), false, JSON.stringify(snapshot.explicitCommands));
    f.store.putRun({ ...f.store.run(coordinator.id)!, released: true, active: false, status: "finished" });
    await f.settle(3);
    assert.equal(revisions(), atCap, "the coordinator's phase.set starts no revision either");
    assert.equal(f.current().resolution.stop?.reason, "escalated");
    assert.equal(escalations().length, 2, "the hold opens a new cap escalation for the planner");
    assert.equal(capCoordinators().length, 0);

    // The operator board accepts the round through run.start: it launches.
    const accepted = await resolveExplicitly(f.engine, explicitResolutionSchema.parse({
      action: "run.start", taskId: f.current().id, version: f.current().version, role: "worker", agent: "retained",
      reason: "One more round", caller: OPERATOR_BOARD_CALLER,
      accept: ["budget", "duplicate_thread", "two_writers", "head_mismatch"],
    }), () => "");
    assert.equal(accepted.explicitResolution?.status, "applied", JSON.stringify(accepted.explicitResolution));
    assert.equal(revisions(), atCap + 1, "the accepted round's revision starts");
  } finally { await f.close(); }
});

test("an author-round control at the cap records its acceptance only when it applies, a forced move included", async () => {
  const f = fixture({ responsible: true });
  try {
    await f.reviews(7);
    await f.settle(2);
    const accepted = () => f.events("revision_cap_accepted");
    const move = (extra: Record<string, unknown> = {}) => f.engine.performTaskControl(taskControlInputSchema.parse({
      action: "move", to: "work", taskId: f.current().id, version: f.current().version,
      instruction: "One more round", reason: "The planner approved one round", caller: OPERATOR_BOARD_CALLER, ...extra,
    }));
    // The retained worker is busy, so the move refuses after its authority passed.
    const worker = f.current().agentId!;
    f.states.set(worker, { ...f.states.get(worker)!, status: "running", active: true });
    await assert.rejects(move(), /not positively idle/);
    assert.equal(accepted().length, 0, "a refused move grants nothing");
    f.idle(worker);
    await move();
    assert.equal(accepted().length, 1, "the applied move records the acceptance");
    assert.match(accepted()[0]!.detail, /^move to=work by /);
  } finally { await f.close(); }

  const g = fixture({ responsible: true });
  try {
    await g.reviews(7);
    await g.settle(2);
    await g.engine.performTaskControl(taskControlInputSchema.parse({
      action: "move", to: "work", force: true, taskId: g.current().id, version: g.current().version,
      instruction: "One more round", reason: "Force one more round", caller: OPERATOR_BOARD_CALLER,
    }));
    assert.equal(g.events("revision_cap_accepted").length, 1, "a forced move at the cap records the acceptance");
    assert.match(g.events("revision_cap_accepted")[0]!.detail, /^force move to=work/);
    await g.settle(2);
    assert.equal(g.run().role, "revision", "the forced round's revision launches");
  } finally { await g.close(); }
});

test("a coordinator run that only sent messages is charged; one whose command changed state is not", () => {
  const f = fixture({ responsible: true });
  try {
    const task = f.current();
    f.store.update(task.id, { prHead: head40 });
    const current = f.current();
    const recovery = (id: string) => runSchema.parse({
      id, taskId: current.id, role: "recovery", generation: 1, head: head40, base: head40, agentId: `${id}-agent`,
      workspaceId: "workspace", profile: null, status: "finished", createdAt: new Date().toISOString(),
      lastObservedAt: null, idleSince: null, active: false, completion: null, released: true,
    });
    const launch = (id: string) => {
      f.store.putRun(recovery(id));
      f.store.event(current.id, "telemetry_recovery", JSON.stringify({ runId: id, work: taskWorkIdentity(f.current(), f.store) }));
    };
    const resolution = (command: string) => f.store.event(current.id, "owner_resolution", JSON.stringify({ command, source: "coordinator" }));
    launch("coord-1");
    resolution("message.send");
    assert.equal(unproductiveCoordinatorRuns(f.store, current.id), 1, "a message changes no task or run state");
    launch("coord-2");
    resolution("record.clear");
    assert.equal(unproductiveCoordinatorRuns(f.store, current.id), 0, "a state-changing command ends the charged chain");
  } finally { void f.close(); }
});
const head40 = "c".repeat(40);
