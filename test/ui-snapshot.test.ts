import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { incidentSchema, reviewCheckpointRecordSchema, runSchema, submissionSchema, summarizeTask, taskSchema, liveTaskSchema, uiStateSchema, visibleTaskSummaries, type Task } from "../shared/contracts";
import { Store } from "../core/store/store";
import { createUiSnapshotFactsCache, overdueHostRun } from "../core/telemetry/ui-snapshot";

test("UI snapshot keeps board fields and omits full task payloads", () => {
  const submission = submissionSchema.parse({
    submissionId: "g01.001", title: "Compact board card", repoPath: "/repo",
    planningCommit: "a".repeat(40), handoffPath: "docs/handoff.md", originAgentId: "origin",
    dependsOn: ["dependency"],
  });
  const task = taskSchema.parse({
    ...submission, id: "task", hostId: "host", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 4,
    phase: "reviewing", reason: "r".repeat(900), held: false, handoffText: "h".repeat(1_000_000), planningBase: "a".repeat(40),
    workspaceId: null, directory: null, branch: "ns-task", agentId: null, runId: null,
    profile: { id: "profile", name: "Reviewer", provider: "provider", model: "model", notes: "large notes".repeat(1000), available: true, problem: "", supportedThinking: [] },
    workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null,
    completion: { eventId: "event", taskId: "task", runId: "run", status: "ready_for_review", summary: "s".repeat(8000), prNumber: 12, head: "b".repeat(40) },
    agentActive: null, lastObservedAt: null, prUrl: "https://example.test/pull/12", prHead: "b".repeat(40), coordinatorGeneration: 1,
    resolution: { attention: true, mergedCommit: null },
  });
  const summary = summarizeTask(task);
  const defaultHostSummary = visibleTaskSummaries([task], [], [], new Map(), new Map(), "host")[0]!;
  const remoteHostSummary = visibleTaskSummaries([{ ...task, hostId: "remote-host" }], [], [], new Map(), new Map(), "host")[0]!;
  assert.equal("hostId" in defaultHostSummary, false, "the board default host is supplied once at the state level");
  assert.equal(remoteHostSummary.hostId, "remote-host", "remote task hosts stay explicit on their rows");
  const withQuestionThreads = summarizeTask({ ...task, agentId: "worker" }, false, false, {}, [
    { taskId: task.id, role: "reviewer", agentId: "reviewer", released: false } as never,
    { taskId: task.id, role: "reviewer", agentId: "old-reviewer", released: true } as never,
  ]);
  assert.deepEqual(withQuestionThreads.questionAgentIds, ["worker", "reviewer"]);
  const ordinaryQueuedHold = summarizeTask({ ...task, phase: "queued", held: true, mergeHold: false });
  const queuedMergeHold = summarizeTask({ ...task, phase: "queued", held: true, mergeHold: true });
  const dispatchedHold = summarizeTask({ ...task, phase: "working", held: true, mergeHold: false });
  assert.equal(ordinaryQueuedHold.holdKind, "dispatch");
  assert.equal(queuedMergeHold.holdKind, "merge");
  assert.equal(dispatchedHold.holdKind, "merge");
  assert.equal("holdKind" in summary, false, "unheld tasks omit the optional board field");
  assert.equal(summary.resolution.attention, true, "attention remains explicit when a card needs it");
  const parked: Task = { ...task, id: 'parked', phase: 'verifying', agentActive: false, agentIntent: false,
    completion: { ...task.completion!, taskId: 'parked' },
    resolution: { ...task.resolution, attention: false, currentRunId: null, recoveryActive: false, recovery: null, mergeIntent: false } };
  assert.equal(summarizeTask(parked).parked, true);
  assert.equal("attention" in summarizeTask(parked).resolution, false, "ordinary cards omit the false attention flag");
  assert.equal(summarizeTask(parked, false, true).parked, false, 'an unreleased resolution run prevents parking');
  const { handoffText: _handoffText, brief: _brief, briefVersions: _briefVersions, laneContext: _laneContext, ...snapshotTask } = task;
  assert.equal(summary.reason.length, 160, "board reason is a short card summary; full reason stays in task detail");
  assert.ok(Array.isArray(summary.budget), "the board keeps a compact budget card summary");
  assert.equal(summary.budget?.length, 6);
  assert.equal(summary.budget?.[2], "none", "the compact budget preserves missing usage evidence");
  assert.deepEqual(summary.profile, { name: "Reviewer" });
  assert.equal(summary.completionPrNumber, 12);
  assert.equal("handoffText" in summary, false);
  assert.equal(liveTaskSchema.safeParse(snapshotTask).success, true);
  assert.equal(liveTaskSchema.safeParse({ ...snapshotTask, phase: "done" }).success, false);
  assert.ok(JSON.stringify(summary).length < 2_000);
  assert.doesNotThrow(() => uiStateSchema.parse({
    prStates: {}, connected: true, hostId: "host", paused: false, error: "", quiet: false,
    activeWorkers: 1, unsettled: 0, globalLimit: 32, projectLimit: 5, tasks: [summary],
    profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
  }));
});

test("UI snapshot facts skip terminal history and invalidate on durable writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-ui-snapshot-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const add = (id: string) => store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath: "/repo", planningCommit: "a".repeat(40),
    handoffPath: `${id}.md`, originAgentId: "origin",
  }), "host", "large immutable handoff".repeat(10_000), "a".repeat(40));
  try {
    const open = add("open");
    const historical = add("historical");
    const routingFault = add("routing-fault");
    const unsettledTerminal = add("unsettled-terminal");
    store.update(historical.id, { phase: "done" });
    store.update(routingFault.id, { phase: "done", originError: "delivery failed" });
    store.update(unsettledTerminal.id, { phase: "done", resolution: { ...unsettledTerminal.resolution, mergeIntent: true } });

    const read = createUiSnapshotFactsCache(store);
    const first = read(), second = read();
    assert.strictEqual(second, first, "unchanged polls reuse the compact projection");
    assert.deepEqual(first.summaries.map(task => task.id).sort(), [open.id, routingFault.id].sort());
    assert.equal(first.tasks.some(task => task.id === historical.id), false, "settled terminal history is not materialized");
    assert.equal(first.tasks.some(task => task.id === unsettledTerminal.id), true, "unsettled terminal side effects remain counted");

    store.update(open.id, { reason: "changed" });
    const third = read();
    assert.notStrictEqual(third, first, "a durable task write invalidates the projection");
    assert.equal(third.summaries.find(task => task.id === open.id)?.reason, "changed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UI snapshot projects task heavy runs by workspace and proof identity and drops settled runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-ui-heavy-runs-"));
  const store = new Store(join(dir, "queue.sqlite"));
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: "heavy", title: "Heavy", repoPath: "/repo", planningCommit: "a".repeat(40), handoffPath: "task.md", originAgentId: "origin" }), "host", "handoff", "a".repeat(40));
    store.update(task.id, { directory: "/repo/worktrees/task" });
    const proofTask = store.insert(submissionSchema.parse({ submissionId: "proof", title: "Proof", repoPath: "/repo", planningCommit: "a".repeat(40), handoffPath: "proof.md", originAgentId: "origin" }), "host", "handoff", "a".repeat(40));
    store.update(proofTask.id, { proofExecutions: [{ runId: "proof-run", agentId: null, workspaceId: "proof-workspace", profile: null, operationId: null, selector: "test:proof", inputs: [], repository: null, prNumber: 1, branch: "proof", head: "a".repeat(40), briefVersion: null, briefDigest: null, authorizedBy: { role: "operator", caller: null, note: null }, activatedAt: "2026-11-01T10:00:00.000Z", settledAt: null, status: "running", historical: false, evidence: "" }] });
    const base = { epoch: 1, caller: "test", repository: { origin: "repo", path: "/repo/worktrees/task/tests" }, runClass: "heavy", classSource: "manifest", priority: "normal", runTimeoutMs: 1000, submittedAt: "2026-11-01T10:00:00.000Z", capacityDeadlineAt: "2026-11-01T10:30:00.000Z", budgetFallback: { cpu: 1, memoryBytes: 1 }, budget: { cpu: 1, memoryBytes: 1 }, admittedAt: null, launchedAt: null, settledAt: null, capacitySample: null, pid: null, processGroupId: null, startIdentity: null, settlement: null, wallMs: null, cpuMs: null, containers: [], escapedDescendantsProvenDeadAt: null, capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null };
    const live = [
      { ...base, id: "task-run", selector: "test:focused", state: "running", position: null },
      { ...base, id: "queued-run", selector: "qa:ci", state: "queued", position: 3, repository: { origin: "repo", path: "/integration" } },
      { ...base, id: "proof-host-run", effigyRunId: "proof-run", selector: "test:proof", state: "running", position: null, repository: { origin: "repo", path: "/outside" } },
    ];
    const read = createUiSnapshotFactsCache(store, undefined, () => live as never);
    const facts = read();
    assert.equal(facts.summaries.find(item => item.id === task.id)?.heavyRun?.selector, "test:focused");
    assert.equal(facts.summaries.find(item => item.id === proofTask.id)?.heavyRun?.selector, "test:proof");
    // A milestone QA run has no task: it is a QA card, not a task's heavy run, and the board carries no strip.
    assert.deepEqual(facts.qaRuns, []);
    assert.equal("heavyRuns" in facts, false);
    live.splice(0, 1);
    assert.equal(read().summaries.find(item => item.id === task.id)?.heavyRun, undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the board leaves out a launched heavy run past its own run timeout", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z");
  const run = { state: "running" as const, runTimeoutMs: 86_400_000 };
  // 464 Effigy admission records launched days ago never settled (2026-11-01).
  assert.equal(overdueHostRun({ ...run, launchedAt: "2026-10-24T17:10:52.872Z" }, now), true);
  assert.equal(overdueHostRun({ ...run, launchedAt: "2026-11-01T11:00:00.000Z" }, now), false);
  assert.equal(overdueHostRun({ ...run, launchedAt: null }, now), false);
  assert.equal(overdueHostRun({ state: "queued", runTimeoutMs: 1, launchedAt: "2026-10-24T17:10:52.872Z" }, now), false);
});

test("task summaries carry the task.next stop category for stopped tasks only", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-stop-kind-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const head = "a".repeat(40), at = "2026-10-01T00:00:00.000Z";
  const add = (id: string) => store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath: "/repo", planningCommit: head,
    handoffPath: `${id}.md`, originAgentId: "origin",
  }), "host", "handoff", head);
  try {
    const held = store.update(add("held").id, { phase: "queued", held: true });
    const incidentBase = add("incident");
    const incident = store.update(incidentBase.id, { phase: "working", resolution: { ...incidentBase.resolution, incident: incidentSchema.parse({ id: "inc-1", role: "worker", createdAt: at, updatedAt: at }) } });
    const recoveryBase = add("recovery");
    const recovery = store.update(recoveryBase.id, { phase: "working", resolution: {
      ...recoveryBase.resolution,
      recovery: { id: "rec-1", key: "rec", generation: 1, runId: null, agentId: null, status: "running", summary: "Coordinator on it", idleSince: null, incidentId: null },
    } });
    const parked = store.update(add("parked").id, { phase: "needs_attention", reason: "Operator attention requested" });
    const queued = add("queued");
    const working = store.update(add("working").id, { phase: "working" });
    const checkpointedTask = add("checkpointed");
    store.putRun(runSchema.parse({
      id: "review-run", taskId: checkpointedTask.id, role: "reviewer", generation: 1, head, base: head,
      agentId: "reviewer", workspaceId: "workspace", profile: null, status: "running",
      createdAt: at, lastObservedAt: null, active: null, idleSince: null, completion: null, released: false,
      reviewCheckpoints: [reviewCheckpointRecordSchema.parse({
        ordinal: 1, checkpoint: { remaining: ["finish the review"] }, head, at,
        runId: "review-run", path: ".paseo/checkpoints/review-run/1.json",
      })],
    }));
    const checkpointed = store.update(checkpointedTask.id, { phase: "reviewing", resolution: { ...checkpointedTask.resolution, currentRunId: "review-run" } });
    const runs = store.runsForTasks([checkpointed.id]);
    const stopOf = (record: typeof checkpointed, taskRuns: typeof runs = []) => summarizeTask(store.task(record.id), false, false, {}, taskRuns).stop;
    assert.equal(stopOf(held), "hold");
    assert.equal(stopOf(incident), "incident");
    assert.equal(stopOf(recovery), "recovery");
    assert.equal(stopOf(parked), "attention");
    assert.equal(stopOf(queued), "wait");
    assert.equal(stopOf(working), undefined, "a progressing task carries no stop");
    assert.equal(stopOf(checkpointed, runs), "run", "a checkpointed reviewer run stops the task");
    assert.equal(stopOf(checkpointed), undefined, "without its runs the checkpointed stop is not derivable from the task alone");
    // The compact board projection derives the same categories from the facts it already loads.
    const facts = createUiSnapshotFactsCache(store)();
    const byId = new Map(facts.summaries.map(summary => [summary.id, summary]));
    assert.equal(byId.get(checkpointed.id)?.stop, "run");
    assert.equal(byId.get(working.id)?.stop, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
