/**
 * Spec 068 batch 5b orphan phases: a non-terminal phase with no live run, no
 * stop and no hold returns to ordinary admission for its role through the
 * owner's own move verb, or records a typed stop naming why it can't. A
 * deliberate hold is never readmitted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR_BOARD_CALLER, runSchema, type Task } from "../shared/contracts";
import { resolveExplicitly } from "../core/verbs/explicit-resolution";
import { ORPHAN_PHASE_READMITTED, ORPHAN_PHASE_STOPPED, ORPHAN_READMISSION_BOUND, orphanPhase } from "../core/recovery/orphan-phase";
import { taskActivity } from "../shared/task-activity";
import { activityReadContext } from "../core/telemetry/task-activity-observation";
import { OPERATOR_WORKER_REMAP_REASON } from "../core/recovery/task-reasons";
import { WORKER_PR_IDENTITY_REFUSAL, WorkerSourceRefusal } from "../core/git/git-refusals";
import { running, selfHealingFixture, type SelfHealingFixture } from "./support/self-healing-fixture";

const idle = running({ status: "idle", active: false, activeTurnId: null, updatedAt: new Date().toISOString() });
const events = (f: SelfHealingFixture, kind: string) => f.store.eventsAll(f.task.id).filter((event) => event.kind === kind);
const quantum = (f: SelfHealingFixture) => f.engine.taskQuantumOwner.orphanPhases;

/** The worker released by the explicit command, exactly as an operator or planner releases it. */
async function releaseWorker(f: SelfHealingFixture) {
  f.setObservation(idle);
  const result = await resolveExplicitly(f.engine, {
    taskId: f.task.id, version: f.store.task(f.task.id).version, action: "run.release", run: "initial",
    reason: "worker thread lost after a host outage", caller: OPERATOR_BOARD_CALLER, accept: ["live_turn", "unreported_result"],
  }, () => "");
  assert.equal(result.explicitResolution?.status, "applied", JSON.stringify(result.explicitResolution));
  const task = f.store.task(f.task.id);
  assert.equal(task.phase, "working");
  assert.equal(task.agentId, null);
  assert.equal(task.runId, null);
}

/** A phase with nothing dispatched: the shape a host outage or a silent advance leaves behind. */
function strand(f: SelfHealingFixture, patch: Partial<Task>): Task {
  const task = f.store.task(f.task.id);
  return f.store.update(task.id, {
    agentActive: false, lastAgentStatus: "idle",
    resolution: { ...task.resolution, stop: null, currentRunId: null, attention: false },
    ...patch,
  });
}

/** A worker that reported its PR ready: the shape awaiting_review starts from. */
function reviewable(f: SelfHealingFixture): Partial<Task> {
  return {
    phase: "awaiting_review", runId: "initial", agentId: "worker",
    prUrl: "https://github.com/example/repo/pull/11", prHead: f.head,
    completion: { eventId: "initial-ready", taskId: f.task.id, runId: "initial", status: "ready_for_review", summary: "Ready", prNumber: 11, head: f.head },
  } as Partial<Task>;
}

test("working after run.release of the worker readmits it through move to=work", async (t) => {
  const f = await selfHealingFixture(t);
  await releaseWorker(f);
  const before = f.store.task(f.task.id);
  assert.equal(taskActivity({ task: before, runs: f.store.runs(before.id), events: [], stop: null, read: activityReadContext(f.store), now: Date.now() }).state,
    "unclassified", "the released worker leaves the task outside the four states");
  // Within the grace nothing moves.
  await f.engine.wake();
  assert.equal(f.store.task(f.task.id).phase, "working");
  assert.equal(events(f, ORPHAN_PHASE_READMITTED).length, 0);
  // The grace has run out: the task's own pass returns it to worker admission.
  quantum(f).graceMs = 0;
  await f.engine.scheduleTaskQuantum(f.task.id);
  const readmitted = events(f, ORPHAN_PHASE_READMITTED);
  assert.equal(readmitted.length, 1, JSON.stringify(f.store.eventsAll(f.task.id).map((event) => event.kind)));
  assert.deepEqual(JSON.parse(readmitted[0]!.detail), { phase: "working", move: "work", attempt: 1 });
  const after = f.store.task(f.task.id);
  assert.equal(after.phase, "changes_requested");
  assert.equal(after.resolution.stop, null);
  assert.ok(after.replacementProfile, "move to=work armed the fresh author on the worker route");
  // The sweep's worker replacement starts that author; nothing is readmitted twice.
  quantum(f).graceMs = 60_000;
  for (let pass = 0; pass < 3 && !f.store.task(f.task.id).agentId && !f.createdRuns.includes("revision"); pass++) {
    await f.engine.recoverExhaustedWorkers();
    await f.engine.wake();
  }
  const started = f.store.task(f.task.id);
  assert.ok(started.agentId || f.createdRuns.includes("revision"),
    `a worker started: ${JSON.stringify({ phase: started.phase, reason: started.reason, runs: f.createdRuns })}`);
  assert.equal(events(f, ORPHAN_PHASE_READMITTED).length, 1);
});

test("changes_requested and awaiting_review with nothing dispatched are orphans for their own role", async (t) => {
  const f = await selfHealingFixture(t);
  await releaseWorker(f);
  const worker = strand(f, { phase: "changes_requested" });
  assert.deepEqual(orphanPhase(f.store, worker, false) && { role: orphanPhase(f.store, worker, false)!.role, move: orphanPhase(f.store, worker, false)!.move },
    { role: "worker", move: "work" });
  const review = strand(f, reviewable(f));
  assert.deepEqual(orphanPhase(f.store, review, false) && { role: orphanPhase(f.store, review, false)!.role, move: orphanPhase(f.store, review, false)!.move },
    { role: "reviewer", move: "review" });
  assert.equal(orphanPhase(f.store, review, true), null, "a paused queue starts nothing");
});

test("changes_requested with nothing dispatched readmits the worker", async (t) => {
  const f = await selfHealingFixture(t);
  await releaseWorker(f);
  strand(f, { phase: "changes_requested" });
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  const readmitted = events(f, ORPHAN_PHASE_READMITTED);
  assert.equal(readmitted.length, 1, JSON.stringify(f.store.eventsAll(f.task.id).slice(-5)));
  assert.equal(JSON.parse(readmitted[0]!.detail).move, "work");
  assert.equal(f.store.task(f.task.id).resolution.stop, null);
});

test("awaiting_review with nothing dispatched readmits the reviewer", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(idle);
  strand(f, reviewable(f));
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 0, JSON.stringify(events(f, ORPHAN_PHASE_STOPPED)));
  const readmitted = events(f, ORPHAN_PHASE_READMITTED);
  assert.equal(readmitted.length, 1);
  assert.equal(JSON.parse(readmitted[0]!.detail).move, "review");
  assert.equal(f.store.task(f.task.id).resolution.stop?.fact?.code === "orphan_phase", false);
  // The task's next pass starts the reviewer by ordinary admission.
  quantum(f).graceMs = 60_000;
  await f.engine.scheduleTaskQuantum(f.task.id);
  const task = f.store.task(f.task.id);
  assert.ok(f.createdRuns.includes("reviewer"),
    `the reviewer was admitted: ${JSON.stringify({ phase: task.phase, reason: task.reason, runs: f.createdRuns })}`);
});

/**
 * bovine-accelerator#6935 (2026-11-23): a revision reported, its completion
 * released the run, and the task sat in changes_requested with no run, stop or
 * applied result. These are the recorded shapes: the revision run row, its
 * `run_completion` event and `run_released_from_recorded_completion`.
 */
function releasedRevision(f: SelfHealingFixture, status: "ready_for_review" | "blocked", summary: string, head: string, bound = true) {
  const task = f.store.update(f.task.id, {
    phase: "changes_requested", agentActive: false, lastAgentStatus: "idle",
    prUrl: "https://github.com/example/repo/pull/11", prHead: f.head,
    completion: { eventId: "initial-ready", taskId: f.task.id, runId: "initial", status: "ready_for_review", summary: "Ready", prNumber: 11, head: f.head },
    resolution: { ...f.store.task(f.task.id).resolution, stop: null, currentRunId: bound ? "revision-1" : null, attention: false, revisionRuns: 1 },
  } as Partial<Task>);
  const createdAt = new Date(Date.now() - 25 * 60_000).toISOString();
  const receivedAt = new Date(Date.now() - 21 * 60_000).toISOString();
  const run = runSchema.parse({
    id: "revision-1", taskId: task.id, role: "revision", status: "finished", agentId: "worker", workspaceId: "task-ws",
    hostId: task.hostId, profile: task.profile, createdAt, head: f.head, base: f.head, generation: 1,
    lastObservedAt: receivedAt, active: false, idleSince: receivedAt, released: true, completionReceivedAt: receivedAt,
    completion: { eventId: "revision-1-result", taskId: task.id, runId: "revision-1", status, summary, prNumber: 11, head },
  });
  f.store.putRun(run);
  f.store.event(task.id, "run_completion", `revision: ${summary}`);
  f.store.event(task.id, "run_released_from_recorded_completion", `revision ${run.id}`);
  for (const row of f.store.db.prepare("SELECT id FROM events WHERE taskId=? AND kind IN ('run_completion','run_released_from_recorded_completion')").all(task.id) as { id: number }[])
    f.store.db.prepare("UPDATE events SET at=? WHERE id=?").run(receivedAt, row.id);
  return run;
}

test("bovine-accelerator#6935: a released revision whose worker is still in its turn shows a wait, then applies", async (t) => {
  const f = await selfHealingFixture(t);
  const head = await f.pushRevision();
  releasedRevision(f, "ready_for_review", "Addressed review findings", head);
  // The live cause: the worker's thread kept an active turn after it reported,
  // so result application's lease declined, and declined silently.
  f.setObservation(running({ updatedAt: new Date().toISOString() }));
  quantum(f).graceMs = 0;
  await f.engine.scheduleTaskQuantum(f.task.id);
  let task = f.store.task(f.task.id);
  assert.equal(task.phase, "changes_requested");
  assert.equal(task.resolution.stop?.reason, "lifecycle", JSON.stringify({ reason: task.reason, stop: task.resolution.stop }));
  assert.match(task.resolution.stop?.detail ?? "", /still owns its turn/);
  assert.equal(orphanPhase(f.store, task, false), null, "a recorded wait is never an orphan");
  assert.equal(events(f, ORPHAN_PHASE_READMITTED).length + events(f, ORPHAN_PHASE_STOPPED).length, 0);
  // The worker's turn ends: the next pass applies the result and starts the reviewer.
  f.setObservation(idle);
  for (let pass = 0; pass < 3 && !f.createdRuns.includes("reviewer"); pass++) await f.engine.scheduleTaskQuantum(f.task.id);
  task = f.store.task(f.task.id);
  assert.ok(f.createdRuns.includes("reviewer"), `the reviewer was admitted: ${JSON.stringify({ phase: task.phase, reason: task.reason, stop: task.resolution.stop, runs: f.createdRuns })}`);
  assert.equal(f.createdRuns.includes("revision"), false, "the worker is never sent another revision");
});

test("a released revision nothing binds goes through ordinary result application, never a move", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(idle);
  const head = await f.pushRevision();
  releasedRevision(f, "ready_for_review", "Addressed review findings", head, false);
  const orphan = orphanPhase(f.store, f.store.task(f.task.id), false);
  assert.equal(orphan?.move, "result");
  assert.equal(orphan?.result?.kind === "revision" && orphan.result.run.id, "revision-1");
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 0, JSON.stringify(events(f, ORPHAN_PHASE_STOPPED)));
  const readmitted = events(f, ORPHAN_PHASE_READMITTED);
  assert.equal(readmitted.length, 1, JSON.stringify(f.store.eventsAll(f.task.id).map((event) => event.kind)));
  assert.deepEqual(JSON.parse(readmitted[0]!.detail), { phase: "changes_requested", move: "result", result: "revision-1" });
  assert.equal(events(f, "orphan_result_rebound").length, 1);
  assert.ok(events(f, "run_result_applied").some((event) => event.detail === "revision-1"), "the revision's own result was applied");
  assert.notEqual(f.store.task(f.task.id).phase, "changes_requested");
  assert.equal(f.createdRuns.includes("revision"), false, "the worker is never sent another revision");
});

test("a released blocked revision nothing applied climbs the ordinary blocker path, never an operator stop", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(idle);
  releasedRevision(f, "blocked", "Cannot push: the branch is protected", f.head, false);
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  const task = f.store.task(f.task.id);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 0, JSON.stringify(events(f, ORPHAN_PHASE_STOPPED)));
  assert.equal(task.resolution.stop?.fact?.code === "orphan_phase", false);
  assert.ok(events(f, "run_result_applied").some((event) => event.detail === "revision-1"), "result application took the blocked report");
  assert.equal(task.phase, "blocked");
  assert.deepEqual(f.createdRuns, [], "nothing is launched over an unanswered blocked report");
});

test("a transient failure while applying a released result is retried, never an operator stop", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(idle);
  const head = await f.pushRevision();
  releasedRevision(f, "ready_for_review", "Addressed review findings", head, false);
  // The failure escapes result application, as an untyped forge read does.
  const advance = f.engine.resolution.advance;
  f.engine.resolution.advance = async () => { throw new Error("gh api: HTTP 502 Bad Gateway"); };
  t.after(() => { f.engine.resolution.advance = advance; });
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  const task = f.store.task(f.task.id);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 0, JSON.stringify(events(f, ORPHAN_PHASE_STOPPED)));
  assert.equal(task.resolution.stop, null);
  assert.equal(task.resolution.currentRunId, "revision-1", "the rebinding stays for the next pass");
});

test("a typed refusal while applying a released result records the typed stop", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(idle);
  const head = await f.pushRevision();
  releasedRevision(f, "ready_for_review", "Addressed review findings", head, false);
  const advance = f.engine.resolution.advance;
  f.engine.resolution.advance = async () => { throw new WorkerSourceRefusal("pr_identity", WORKER_PR_IDENTITY_REFUSAL); };
  t.after(() => { f.engine.resolution.advance = advance; });
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  const task = f.store.task(f.task.id);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 1);
  assert.deepEqual(task.resolution.stop?.fact, { code: "orphan_phase", subject: "changes_requested" });
  assert.match(task.resolution.stop?.detail ?? "", /was refused: PR must be open/);
});

test("a pass cut short by a stopping service records no stop", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(idle);
  const head = await f.pushRevision();
  releasedRevision(f, "ready_for_review", "Addressed review findings", head, false);
  quantum(f).graceMs = 0;
  f.engine.stopped = true;
  t.after(() => { f.engine.stopped = false; });
  await quantum(f).settle(f.task.id, false);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 0);
  assert.equal(f.store.task(f.task.id).resolution.stop, null);
});

test("an owner-armed replacement is the fleet's, never an orphan", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(idle);
  // changes_requested with the excluded initial worker still bound (nucleus#033).
  const task = strand(f, { phase: "changes_requested", failoverReason: `${OPERATOR_WORKER_REMAP_REASON}. Continue the existing task` });
  assert.equal(orphanPhase(f.store, task, false), null);
});

test("readmissions count per episode: a worker started since resets the bound", async (t) => {
  const f = await selfHealingFixture(t);
  await releaseWorker(f);
  for (let attempt = 1; attempt <= ORPHAN_READMISSION_BOUND; attempt++)
    f.store.event(f.task.id, ORPHAN_PHASE_READMITTED, JSON.stringify({ phase: "working", move: "work", attempt }));
  // A fresh author is a task-row worker, not a Run row.
  const later = new Date(Date.now() + 1_000).toISOString();
  f.store.event(f.task.id, "agent_created", "fresh-worker");
  f.store.db.prepare("UPDATE events SET at=? WHERE taskId=? AND kind='agent_created'").run(later, f.task.id);
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 0);
  assert.equal(events(f, ORPHAN_PHASE_READMITTED).length, ORPHAN_READMISSION_BOUND + 1);
});

test("an orphan that cannot be readmitted records a typed stop with its explicit command", async (t) => {
  const f = await selfHealingFixture(t);
  await releaseWorker(f);
  // No retained profile and no worker route: move to=work has no author to start.
  strand(f, { profile: null });
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  const task = f.store.task(f.task.id);
  assert.equal(events(f, ORPHAN_PHASE_READMITTED).length, 0);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 1);
  assert.equal(task.resolution.stop?.reason, "operator_needed");
  assert.deepEqual(task.resolution.stop?.fact, { code: "orphan_phase", subject: "working" });
  assert.deepEqual(task.resolution.stop?.suggestedVerbs, ["move", "restart"]);
  assert.match(task.resolution.stop?.detail ?? "", /working with no live run, stop or hold.*move to=work or run\.start worker fresh/s);
  // The stop owns the task now: it is no longer an orphan.
  assert.equal(orphanPhase(f.store, task, false), null);
});

test("an orphan readmitted past the bound becomes a person's question", async (t) => {
  const f = await selfHealingFixture(t);
  await releaseWorker(f);
  for (let attempt = 1; attempt <= ORPHAN_READMISSION_BOUND; attempt++)
    f.store.event(f.task.id, ORPHAN_PHASE_READMITTED, JSON.stringify({ phase: "working", move: "work", attempt }));
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  const task = f.store.task(f.task.id);
  assert.equal(task.phase, "working", "no fourth readmission");
  assert.equal(task.resolution.stop?.fact?.code, "orphan_phase");
  assert.match(task.resolution.stop?.detail ?? "", new RegExp(`after ${ORPHAN_READMISSION_BOUND} automatic readmissions`));
});

test("a deliberate hold or owner stop is never readmitted", async (t) => {
  const f = await selfHealingFixture(t);
  await releaseWorker(f);
  quantum(f).graceMs = 0;
  const held = strand(f, { held: true, holdOwner: "operator", holdReason: "Owner stop: investigating", holdAt: new Date().toISOString() });
  assert.equal(orphanPhase(f.store, held, false), null);
  await f.engine.wake();
  assert.equal(f.store.task(f.task.id).phase, "working");
  assert.equal(events(f, ORPHAN_PHASE_READMITTED).length, 0);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 0);
});

test("a live run is never an orphan", async (t) => {
  const f = await selfHealingFixture(t);
  await releaseWorker(f);
  const task = strand(f, { phase: "changes_requested" });
  f.store.putRun(runSchema.parse({
    id: "revision-live", taskId: task.id, role: "revision", status: "running", agentId: "worker", workspaceId: "task-ws",
    hostId: task.hostId, profile: task.profile, createdAt: new Date().toISOString(), head: f.head, base: f.head, generation: 1,
    lastObservedAt: new Date().toISOString(), active: true, idleSince: null, completion: null, released: false,
  }));
  assert.equal(orphanPhase(f.store, f.store.task(task.id), false), null);
});
