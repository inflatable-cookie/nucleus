import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { formatAgentId } from "../shared/agent-identity";
import { OPERATOR_BOARD_CALLER, runSchema, submissionSchema, taskControlTaskSchema } from "../shared/contracts";
import type { Adapter } from "../core/host";
import { runSettlementFence } from "../core/intake/run-settlement";
import { plannerEscalations } from "../core/questions/ladder/records";
import { blockingRecoveryEffects } from "../core/recovery/recovery-effects";
import { resolutionCreationRestartRefusal } from "../core/recovery/absent-creation/restarts";
import { collectOwnerVerbFacts, ownerPendingEffects } from "../core/verbs/owner-verbs";
import { taskControlOperation } from "../core/verbs/task-control-key";
import { QueueRuntime } from "../service/runtime-owner";
import { callCatalogueMethod } from "../service/transport/dispatch";

const head = "a".repeat(40);
const host = "paseo-fixture";
const repo = "/example";
const planner = formatAgentId(host, "live-planner");

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "explicit-resolution-"));
  const calls: string[] = [];
  const adapter = {
    hostId: host, socketPath: join(root, "callback.sock"), helperPath: join(root, "helper.mjs"),
    client: { isConnected: true }, isConnected: () => true,
    connect: async () => {}, close: async () => {}, catalog: async () => ({ providers: [] }),
    listLiveAgents: async () => [{ id: "live-planner", title: "Planner", directory: repo, workspaceId: null }],
    originAgent: async (id: string) => ({ id, title: id, workspaceId: null, archived: id === "retired-planner" }),
    stopAgentTurn: async (id: string) => { calls.push(`stop ${id}`); },
    archiveAgent: async (id: string) => { calls.push(`archive ${id}`); },
  } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: join(root, "nucleus"), adapterFactory: () => adapter, timers: false });
  t.after(async () => {
    await runtime.drain();
    rmSync(root, { recursive: true, force: true });
  });
  const store = runtime.store;
  store.setMeta("paused", true);
  await runtime.ensureBootstrap();
  store.upsertProject({ key: "example", name: "Example", repositories: [{ origin: null, path: repo }] });
  store.setProjectPlanner({ key: "example", agentId: formatAgentId(host, "retired-planner"), setBy: "operator" });
  const task = store.insert(submissionSchema.parse({ submissionId: "fixture", title: "Fixture", repoPath: repo,
    planningCommit: head, handoffPath: "handoff.md", originAgentId: "owner" }), host, "Handoff", head);
  const current = () => store.task(task.id);
  const run = (id: string, role: "reviewer" | "recovery", agentId: string | null) => runSchema.parse({
    id, role, agentId, taskId: task.id, hostId: host, workspaceId: "workspace", status: agentId ? "running" : "uncertain",
    generation: 1, head, base: head, profile: null, createdAt: new Date().toISOString(),
    lastObservedAt: null, idleSince: null, active: agentId ? true : null, completion: null, released: false,
  });
  const command = async (args: Record<string, unknown>) => taskControlTaskSchema.parse(await callCatalogueMethod(runtime, "queue.task", {
    reference: task.reference, version: current().version, caller: OPERATOR_BOARD_CALLER, reason: "Settle the recorded occurrence", ...args,
  }));
  const audit = () => store.eventsAll(task.id).filter(event => event.kind === "owner_resolution");
  return { store, current, run, command, audit, calls, runtime };
}

test("run.release changes an agentless reviewer's durable fence and revokes its credential", async t => {
  const { store, current, run, command, audit, calls } = await fixture(t);
  const reviewer = run("review-run", "reviewer", null);
  store.putRun(reviewer);
  store.setCredential(reviewer.id, "test-secret");
  store.update(current().id, { phase: "reviewing", prHead: head, resolution: { ...current().resolution, currentRunId: reviewer.id } });
  assert.match(runSettlementFence({ store, task: current() }, reviewer) ?? "", /uncertain/);

  const version = current().version;
  const args = { action: "run.release", run: reviewer.id };
  const probe = await command(args);
  assert.deepEqual(probe.explicitResolution?.warnings.map(x => x.id), ["live_turn", "unreported_result"]);
  assert.equal(probe.version, version);
  assert.equal((await command({ ...args, accept: ["live_turn"] })).explicitResolution?.status, "warnings");
  assert.equal(audit().length, 0);

  const result = await command({ ...args, accept: ["live_turn", "unreported_result"] });
  assert.equal(result.explicitResolution?.status, "applied");
  assert.match(result.explicitResolution?.next ?? "", /scheduler/);
  assert.equal(result.phase, "reviewing");
  assert.equal(current().resolution.currentRunId, null);
  assert.equal(store.run(reviewer.id)?.released, true);
  assert.equal(runSettlementFence({ store, task: current() }, store.run(reviewer.id)!), null);
  assert.throws(() => store.authenticate(reviewer.id, "test-secret"), /unauthorized/i);
  assert.deepEqual(calls, []);
  assert.equal(audit().length, 1);
  assert.deepEqual(JSON.parse(audit()[0].detail).accepted, ["live_turn", "unreported_result"]);
  const stale = await command({ ...args, version, accept: ["live_turn", "unreported_result"] });
  assert.equal(stale.explicitResolution?.status, "stale");
  assert.equal(stale.version, result.version);
  assert.equal(audit().length, 1);
});

test("record.clear settles a route operation and a notice on the underlying records", async t => {
  const { store, current, command, audit } = await fixture(t);
  const task = current();
  const control = { taskId: task.id, version: task.version, action: "route" as const, role: "reviewer" as const,
    profileId: "next-reviewer", now: true, reason: "Choose a reviewer route" };
  const { payload, key } = taskControlOperation(control);
  const accepted = store.acceptOperation({ key, kind: "task_control", taskId: task.id, inputHash: "b".repeat(64), payload });
  assert.ok("operation" in accepted);
  const operation = store.putOperation({ ...accepted.operation, state: "needs_attention", diagnostic: "Delivery unknown" });
  store.putNotice({ id: "notice", taskId: task.id, agentId: "owner", text: "Delivery unknown", status: "uncertain",
    error: "", kind: "attention", recipientAgentId: "", workspaceId: null, sources: [], originEntry: true });
  const blockers = () => blockingRecoveryEffects(store, current()).map(effect => effect.identity);
  assert.deepEqual(blockers(), [operation.id, "notice"]);
  for (const id of [`task_control_operation.${operation.id}`, "attention-notice.notice"]) {
    const args = { action: "record.clear", kind: "effect", id, caller: planner };
    assert.equal((await command(args)).explicitResolution?.warnings[0].id, "effect_may_land");
    assert.equal((await command({ ...args, accept: ["effect_may_land"] })).explicitResolution?.status, "applied");
  }
  assert.deepEqual(blockers(), []);
  assert.equal(store.operation(operation.id)?.state, "failed");
  store.putNotice({ ...store.notices(task.id)[0]!, status: "uncertain", error: "Late response" });
  assert.equal(store.notices(task.id)[0]?.status, "superseded");
  assert.ok(audit().every(event => JSON.parse(event.detail).source === "project_planner"));
});

test("the coordinator can release or clear its task records within its authority", async t => {
  const { store, current, run, command, audit, calls } = await fixture(t);
  const coordinator = run("recovery-run", "recovery", "coordinator");
  const reviewer = run("review-run", "reviewer", "reviewer");
  store.putRun(coordinator);
  store.putRun(reviewer);
  store.update(current().id, { resolution: { ...current().resolution, currentRunId: reviewer.id,
    recoveryActive: true, recovery: { id: "episode", key: "key", generation: 1, runId: coordinator.id, agentId: coordinator.agentId,
      status: "running", summary: "Mechanical stop", idleSince: null, incidentId: null } } });
  const caller = formatAgentId(host, "coordinator");
  const release = { action: "run.release", run: reviewer.id, archive: true, caller, accept: ["live_turn", "unreported_result"] };
  const hold = { action: "record.clear", kind: "hold", id: "dispatch", caller };
  store.update(current().id, { holds: { dispatch: { owner: planner, reason: "Planner hold", at: new Date().toISOString(), generation: 1, until: null } } });
  assert.equal((await command(hold)).explicitResolution?.warnings[0].id, "hold_owner");
  await assert.rejects(command({ ...hold, accept: ["hold_owner"] }), /only the live responsible planner/i);
  await assert.rejects(command({ ...release, caller: formatAgentId(host, "reviewer") }), /requires this task's coordinator/);
  await assert.rejects(command({ ...release, run: "other-task-run" }), /belongs to this task/);
  store.update(current().id, { critical: true });
  await assert.rejects(command(release), /critical task/);
  assert.equal(audit().length, 0);
  assert.deepEqual(calls, []);
  assert.equal((await command({ ...hold, caller: planner })).explicitResolution?.status, "applied");
  store.update(current().id, { critical: false });
  assert.equal((await command(release)).explicitResolution?.status, "applied");
  assert.deepEqual(calls, ["stop reviewer", "archive reviewer"]);
});

test("record.clear retires an owned-tool hold and a stale escalation without using its snapshot", async t => {
  const { store, current, command, runtime } = await fixture(t);
  const id = "prior-escalation";
  const taskId = current().id;
  store.event(taskId, "owned_tool_hold", JSON.stringify({ runId: "old", reason: "unreadable timeline" }));
  store.event(taskId, "planner_escalation", `${id}: cause blocked-tool; run old`);
  store.event(taskId, "planner_escalation_payload", `${id}: ${JSON.stringify({ id, runId: "old", binding: "old snapshot" })}`);
  runtime.engine.resolution.waiting(current(), "The text was edited", "escalated", { fact: { code: "escalation", subject: id } });
  const tool = { action: "record.clear", kind: "effect", id: "owned_tool.old" };
  assert.equal((await command(tool)).explicitResolution?.warnings[0].id, "owned_tool");
  await command({ ...tool, accept: ["owned_tool"] });
  assert.ok(!ownerPendingEffects(collectOwnerVerbFacts(store, current())).some(effect => effect.effect === tool.id));
  assert.equal((await command({ action: "record.clear", kind: "escalation", id })).explicitResolution?.status, "applied");
  assert.equal(plannerEscalations(store.eventsAll(taskId))[0]?.answered, true);
  assert.equal(current().resolution.stop, null);
});

test("creation restart decisions read the stored stop fact across detail edits", async t => {
  const { store, current, run, runtime } = await fixture(t);
  const reviewer = run("review-run", "reviewer", null);
  store.putRun(reviewer);
  store.update(current().id, { prHead: head });
  runtime.engine.resolution.ensureIncident(current(), reviewer, "Uncertain launch", "exact_lookup");
  runtime.engine.resolution.waiting(current(), "Exact reviewer creation lookup is unavailable", "lifecycle");
  const task = current();
  const stop = task.resolution.stop!;
  assert.equal(resolutionCreationRestartRefusal(task, reviewer), stop.detail);
  store.update(task.id, { resolution: { ...task.resolution, stop: { ...stop, detail: "Renamed diagnostic" } } });
  assert.equal(resolutionCreationRestartRefusal(current(), reviewer), "Renamed diagnostic");
});
