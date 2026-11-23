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
function releasedRevision(f: SelfHealingFixture, status: "ready_for_review" | "blocked", summary: string, head: string) {
  const task = f.store.update(f.task.id, {
    phase: "changes_requested", agentActive: false, lastAgentStatus: "idle",
    prUrl: "https://github.com/example/repo/pull/11", prHead: f.head,
    completion: { eventId: "initial-ready", taskId: f.task.id, runId: "initial", status: "ready_for_review", summary: "Ready", prNumber: 11, head: f.head },
    resolution: { ...f.store.task(f.task.id).resolution, stop: null, currentRunId: "revision-1", attention: false, revisionRuns: 1 },
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

test("a released revision that pushed a new head goes on to its reviewer", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(idle);
  const head = await f.pushRevision();
  releasedRevision(f, "ready_for_review", "Addressed review findings", head);
  const orphan = orphanPhase(f.store, f.store.task(f.task.id), false);
  assert.equal(orphan?.role, "reviewer");
  assert.equal(orphan?.move, "review");
  // The live case's passes applied nothing for 20 minutes; the sweep's finish
  // step is what runs past the grace.
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 0, JSON.stringify(events(f, ORPHAN_PHASE_STOPPED)));
  const readmitted = events(f, ORPHAN_PHASE_READMITTED);
  assert.equal(readmitted.length, 1, JSON.stringify(f.store.eventsAll(f.task.id).map((event) => event.kind)));
  assert.deepEqual(JSON.parse(readmitted[0]!.detail), { phase: "changes_requested", move: "review", attempt: 1, result: "revision-1" });
  assert.equal(f.createdRuns.includes("revision"), false, "the worker is never sent another revision");
  quantum(f).graceMs = 60_000;
  for (let pass = 0; pass < 2 && !f.createdRuns.includes("reviewer"); pass++) await f.engine.scheduleTaskQuantum(f.task.id);
  const task = f.store.task(f.task.id);
  assert.ok(f.createdRuns.includes("reviewer"), `the reviewer was admitted: ${JSON.stringify({ phase: task.phase, reason: task.reason, runs: f.createdRuns })}`);
});

test("a released revision that reported blocked raises its typed stop", async (t) => {
  const f = await selfHealingFixture(t);
  f.setObservation(idle);
  releasedRevision(f, "blocked", "Cannot push: the branch is protected", f.head);
  quantum(f).graceMs = 0;
  await quantum(f).settle(f.task.id, false);
  const task = f.store.task(f.task.id);
  assert.equal(events(f, ORPHAN_PHASE_READMITTED).length, 0);
  assert.equal(events(f, ORPHAN_PHASE_STOPPED).length, 1);
  assert.equal(task.phase, "changes_requested");
  assert.equal(task.resolution.stop?.reason, "operator_needed");
  assert.deepEqual(task.resolution.stop?.fact, { code: "orphan_phase", subject: "changes_requested" });
  assert.match(task.resolution.stop?.detail ?? "", /Worker run revision-1 reported blocked .*Cannot push: the branch is protected.*move to=work/s);
  assert.deepEqual(f.createdRuns, [], "nothing is launched over an unanswered blocked report");
});

for (const status of ["ready_for_review", "blocked"] as const)
  test(`a released ${status} revision never sits in changes_requested after a full pass`, async (t) => {
    const f = await selfHealingFixture(t);
    f.setObservation(idle);
    const head = status === "ready_for_review" ? await f.pushRevision() : f.head;
    releasedRevision(f, status, status === "blocked" ? "Cannot push" : "Addressed review findings", head);
    quantum(f).graceMs = 0;
    await f.engine.scheduleTaskQuantum(f.task.id);
    const task = f.store.task(f.task.id);
    assert.ok(task.phase !== "changes_requested" || task.resolution.stop || events(f, ORPHAN_PHASE_READMITTED).length,
      `the task moved on: ${JSON.stringify({ phase: task.phase, reason: task.reason, stop: task.resolution.stop })}`);
    assert.equal(orphanPhase(f.store, task, false)?.key === `changes_requested|worker|initial|revision-1|1`, false);
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
