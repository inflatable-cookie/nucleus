import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  REVISION_BUDGET, completionSchema, runSchema, submissionSchema, taskDetailView, taskNextSchema,
  taskStopRecord, type Task,
} from "../shared/contracts";
import { TASK_PROGRESSING_REASON } from "../shared/task-stop";
import { inFlightSlotWaitReason } from "../shared/wait-state";
import type { AgentObservation } from "../core/host/adapter";
import { observedParticipantProcess, participantProcessLiveness, rememberParticipantProcessTable } from "../core/machine/participant-process-observation";
import { Store } from "../core/store/store";
import { createTaskDetailCache } from "../core/telemetry/task-detail";
import { createUiSnapshotFactsCache } from "../core/telemetry/ui-snapshot";
import {
  observeRunningTool, recordActivityTool, runActivityObservation, workerActivityObservation,
} from "../core/telemetry/task-activity-observation";
import { collectOwnerVerbFacts } from "../core/verbs/owner-facts";
import { ownerTaskNext } from "../core/verbs/owner-verbs";

const head = "a".repeat(40);
const at = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nucleus-activity-"));
  const store = new Store(join(root, "queue.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.setMeta("paused", false);
  const task = store.insert(submissionSchema.parse({
    submissionId: "activity", title: "Task activity", repoPath: root,
    planningCommit: head, handoffPath: "handoff.md", originAgentId: "operator",
  }), "host", "handoff", head);
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, store.task(task.id))));
  const read = () => {
    const activity = next().activity;
    assert.ok(activity);
    return activity;
  };
  return { store, task, next, read };
}

const workerState = (overrides?: Partial<AgentObservation>): AgentObservation => ({
  id: "worker", workspaceId: "workspace", status: "running", active: true,
  activeTurnId: "turn", turnStartedAt: at(22), updatedAt: at(1),
  permissions: false, error: "", ...overrides,
});

function worker(store: Store, task: Task, state = workerState()) {
  const started = store.update(task.id, {
    phase: "working", runId: "worker-run", agentId: state.id, workspaceId: state.workspaceId,
  });
  return store.update(task.id, {
    agentActive: true, lastObservedAt: at(), lastActivityAt: state.updatedAt,
    participantActivity: workerActivityObservation(started, state, at()),
  });
}

test("a recent worker, its running tool and pending permission use one reading on next, board and detail", t => {
  const { store, task, read, next } = fixture(t);
  const state = workerState();
  const started = worker(store, task, state);
  assert.equal(read().state, "active");
  assert.equal(read().lastActivityAt, state.updatedAt);
  assert.equal(read().since, state.turnStartedAt);
  const startedAt = at(20);
  const lastOutputAt = at(2);
  const tool = observeRunningTool([{
    timestamp: lastOutputAt, turnId: "turn", item: {
      type: "tool_call", callId: "command", status: "running", createdAt: startedAt,
      detail: { type: "shell", command: "effigy test", lastOutputAt },
    },
  }], "turn");
  recordActivityTool(store, task.id, "worker-run", state.id, "turn", tool);
  const running = read();
  assert.equal(running.state, "active");
  assert.equal(running.detail, "Running `effigy test` · 20 min");
  assert.deepEqual(running.tool, { name: "effigy test", startedAt, lastOutputAt });
  const board = createUiSnapshotFactsCache(store)();
  assert.deepEqual(board.summaries.find(row => row.id === task.id)?.activity, running);
  assert.deepEqual(createTaskDetailCache(store)(task.id).task.activity, running);
  assert.equal(next().activeRun?.runId, "worker-run");
  const pending = workerState({ pendingRequest: { id: "private-request", kind: "shell", firstLine: null }, permissions: true });
  const askedAt = at();
  store.update(task.id, {
    participantActivity: workerActivityObservation(store.task(task.id), pending, askedAt),
  });
  const waiting = read();
  assert.equal(waiting.state, "needs_person");
  assert.equal(waiting.detail, "Waiting for permission");
  assert.deepEqual(waiting.permission, { kind: "shell", since: askedAt });
  assert.equal(store.task(task.id).version, started.version, "the activity reading does not move the task version");
});

test("slot waits, uncertain creation, escalation and completion read from stored records", t => {
  const { store, task, read } = fixture(t);
  const slot = taskStopRecord("capacity", inFlightSlotWaitReason(2, ["private-id"]), null, at());
  store.update(task.id, { phase: "awaiting_review", resolution: { ...task.resolution, stop: slot } });
  assert.equal(read().state, "nucleus");
  assert.equal(read().detail, "Waiting for a review slot · 2 ahead");
  const run = runSchema.parse({
    id: "review-run", taskId: task.id, role: "reviewer", generation: 1,
    head, base: head, agentId: null, workspaceId: "workspace", profile: null,
    status: "uncertain", createdAt: at(1), lastObservedAt: null, active: null,
    idleSince: null, completion: null, released: false,
  });
  store.putRun(run);
  assert.equal(read().state, "recovering");
  assert.equal(read().attempt, 1);
  const escalation = taskStopRecord("escalated", "Scope needs a planner ruling", null, at());
  store.update(task.id, { phase: "needs_attention", resolution: { ...task.resolution, stop: escalation } });
  assert.equal(read().state, "needs_person");
  store.update(task.id, { phase: "done" });
  assert.equal(read().state, "finished");
});

test("a spent budget or parked revision allowance with no run reads as a typed stop for a person, never progressing", t => {
  const { store, task, read, next } = fixture(t);
  store.update(task.id, { phase: "working", reason: TASK_PROGRESSING_REASON });
  assert.equal(read().state, "unclassified");
  assert.match(read().detail, /no live run or wait/);
  store.putRun(runSchema.parse({
    id: "spent-run", taskId: task.id, role: "reviewer", generation: 1, head, base: head,
    agentId: "reviewer", workspaceId: "workspace", profile: null, status: "finished",
    createdAt: at(100_000), lastObservedAt: null, idleSince: null, active: false, completion: null, released: true,
  }));
  // Spec 068 Decision 1: a first spend is the sweep's to extend, not a person's.
  assert.notEqual(next().stop?.reason, "budget");
  assert.notEqual(read().detail, "Task budget reached");
  // Spec 068 §5 (papercut 677c378d): a later spend is the task's stop before the
  // sweep records it, worded as such and carrying its explicit command.
  store.update(task.id, { resolution: { ...store.task(task.id).resolution, budgetExtensions: 1 } });
  assert.equal(next().stop?.reason, "budget");
  assert.match(next().reason, /^Budget reached/);
  assert.notEqual(next().reason, TASK_PROGRESSING_REASON);
  assert.deepEqual(read().state, "needs_person");
  assert.equal(read().detail, "Task budget reached");
  store.update(task.id, {
    phase: "changes_requested", budgetSince: at(1),
    resolution: { ...task.resolution, revisionRuns: REVISION_BUDGET },
  }, "revision_budget_exhausted");
  assert.equal(next().stop?.reason, "operator_needed");
  assert.match(next().stop?.detail ?? "", /^Revision cap reached: 6 of 6 review rounds/);
  assert.equal(read().state, "needs_person");
  assert.equal(read().detail, "Revision cap reached");
});

test("a process recorded before boot and its unapplied verdict are visible despite a running display", t => {
  const { store, task, read } = fixture(t);
  const state = workerState();
  const started = worker(store, task, state);
  const process = { pid: 42, startIdentity: "42@2026-10-01T00:00:00Z", seenAt: Date.parse(at(60 * 24 * 365)) };
  assert.ok(started.participantActivity);
  store.update(task.id, { participantActivity: { ...started.participantActivity, process } });
  const projected = taskDetailView(store.task(task.id), {}, [], [], null, Date.now(), {
    processLiveness: (record, now) => participantProcessLiveness(record, now, now - 60_000, null),
  });
  assert.equal(projected.activity?.state, "unclassified");
  assert.equal(projected.activity?.detail, "Worker process is gone");

  const run = runSchema.parse({
    id: "review-run", taskId: task.id, role: "reviewer", generation: 1, head, base: head,
    agentId: "reviewer", workspaceId: "workspace", profile: null, status: "running", createdAt: at(2),
    lastObservedAt: at(), active: true, idleSince: null, completion: null, released: false,
  });
  const participantActivity = runActivityObservation(run, workerState({ id: "reviewer" }), at());
  store.putRun({ ...run, participantActivity: { ...participantActivity, process } });
  store.update(task.id, { phase: "reviewing", prHead: head, resolution: { ...task.resolution, currentRunId: run.id } });
  const activity = () => taskDetailView(store.task(task.id), {}, store.runs(task.id), store.eventsAll(task.id), null, Date.now(), {
    processLiveness: (record, now) => participantProcessLiveness(record, now, now - 60_000, null),
  }).activity;
  assert.equal(activity()?.detail, "Reviewer process is gone");
  const completion = completionSchema.parse({
    eventId: "verdict", taskId: task.id, runId: run.id, head, status: "ready_to_merge", summary: "Passed",
  });
  store.putRun({ ...store.runs(task.id)[0], completion });
  assert.equal(activity()?.detail, "Review verdict is waiting on a gone thread");
  store.event(task.id, "review_result_applied", run.id);
  assert.doesNotMatch(activity()?.detail ?? "", /verdict/);
  assert.equal(participantProcessLiveness(process, Date.now(), process.seenAt - 10_000, null), "unknown");
  assert.equal(read().role, null);
});

test("an observed provider is matched by its recorded PID and start identity", () => {
  const observedAt = Date.now();
  const provider = { pid: 50, pgid: 50, uid: 501, command: "provider", startIdentity: "50@boot-a:42", cwd: null };
  rememberParticipantProcessTable([provider, {
    ...provider, pid: 51, ppid: 50, startIdentity: "51@boot-a:50",
    command: "node /fixture/mcp-report.mjs /fixture/mcp-worker-run.json",
  }], observedAt);
  const process = observedParticipantProcess("worker-run", observedAt);
  assert.deepEqual(process, { pid: 50, startIdentity: provider.startIdentity, seenAt: observedAt });
  assert.equal(participantProcessLiveness(process, observedAt, observedAt - 42_000), "alive");
  rememberParticipantProcessTable([{ ...provider, startIdentity: "50@boot-a:9000" }], observedAt + 1);
  assert.equal(participantProcessLiveness(process, observedAt + 1, observedAt - 42_000), "gone");
  rememberParticipantProcessTable([], observedAt + 2, new Set([50]));
  assert.equal(participantProcessLiveness(process, observedAt + 2, observedAt - 42_000), "unknown");
  rememberParticipantProcessTable(null, observedAt + 3);
  assert.equal(participantProcessLiveness(process, observedAt + 3, observedAt - 42_000), "unknown");
});

test("the task card and Overview render the same activity detail", async t => {
  const { store, task, next } = fixture(t);
  const { createElement: h } = await import("react");
  const { mount, useNativeStubs } = await import("./support/render");
  useNativeStubs();
  const { TaskCard } = await import("../client/board/cards");
  const { TaskSummaryBlock } = await import("../client/task/summary");
  worker(store, task);
  const tool = observeRunningTool([{
    timestamp: at(20), turnId: "turn",
    item: { type: "tool_call", callId: "test-tool", status: "running", detail: { type: "shell", command: "effigy test" } },
  }], "turn");
  recordActivityTool(store, task.id, "worker-run", "worker", "turn", tool);
  const reading = next();
  assert.ok(reading.activity);
  const row = createUiSnapshotFactsCache(store)().summaries.find(candidate => candidate.id === task.id);
  assert.ok(row);
  const detail = createTaskDetailCache(store)(task.id);
  const c = {
    surface0: "#0d1117", surface1: "#161b22", surface2: "#30363d", border: "#30363d",
    foreground: "#f0f6fc", foregroundMuted: "#8b949e", accent: "#1f6feb",
    accentForeground: "#ffffff", statusSuccess: "#3fb950", statusWarning: "#f0883e", statusDanger: "#f85149",
  };
  const card = mount(h(TaskCard, { task: row, selected: false, onPress: () => {}, c, board: true }));
  const panel = mount(h(TaskSummaryBlock, { task: detail.task, next: reading, runs: detail.runs, c }));
  t.after(() => { card.update(h("View")); panel.update(h("View")); });
  assert.ok(card.text().includes(reading.activity.detail));
  assert.ok(panel.text().includes(reading.activity.detail));
});
