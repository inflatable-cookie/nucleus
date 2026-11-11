import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { applyRunUsageEvent, EMPTY_RUN_USAGE, effectiveTokens, taskUsage, type RunUsageStreamEvent } from "../core/telemetry/run-usage";
import { RunUsageTracker } from "../core/telemetry/run-usage-tracker";
import { telemetrySnapshot } from "../core/telemetry/telemetry";
import { runSchema, submissionSchema, taskSchema } from "../shared/contracts";

const start = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(start + offsetMs).toISOString();
const flush = () => new Promise(resolve => setImmediate(resolve));

function run(id: string, role: "executor" | "reviewer" | "revision", changes: Record<string, unknown> = {}) {
  return runSchema.parse({ id, taskId: "task", role, generation: 1, head: "a".repeat(40), base: "a".repeat(40), agentId: `agent-${id}`, workspaceId: "workspace",
    profile: null, status: "running", createdAt: iso(1_000), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false, ...changes });
}

test("effective tokens weight cached input at ten percent and count only reported counts", () => {
  assert.equal(effectiveTokens({ inputTokens: 100, cachedInputTokens: 1_000, outputTokens: 50 }), 250);
  assert.equal(effectiveTokens({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), 0);
});

test("turn usage accumulates per turn, measures wall time and never double-counts a replayed turn", () => {
  let usage = EMPTY_RUN_USAGE;
  usage = applyRunUsageEvent(usage, { type: "turn_started", turnId: "t1" }, iso(2_000));
  usage = applyRunUsageEvent(usage, { type: "turn_completed", turnId: "t1", usage: { inputTokens: 100, cachedInputTokens: 1_000, outputTokens: 50, contextWindowUsedTokens: 25_800 } }, iso(5_000));
  usage = applyRunUsageEvent(usage, { type: "turn_completed", turnId: "t1", usage: { inputTokens: 100, cachedInputTokens: 1_000, outputTokens: 50 } }, iso(5_100));
  usage = applyRunUsageEvent(usage, { type: "turn_started", turnId: "t2" }, iso(6_000));
  usage = applyRunUsageEvent(usage, { type: "turn_completed", turnId: "t2", usage: { inputTokens: 2, cachedInputTokens: 16_532, outputTokens: 3 } }, iso(8_000));
  assert.equal(usage.turns, 2);
  assert.equal(usage.reportedTurns, 2);
  assert.equal(usage.inputTokens, 102);
  assert.equal(usage.cachedInputTokens, 17_532);
  assert.equal(usage.outputTokens, 53);
  assert.equal(usage.wallMs, 5_000);
  assert.equal(usage.peakContextTokens, 25_800);
  assert.equal(usage.partial, false);
});

test("a provider that reports no tokens adds turns and wall time, never a token count", () => {
  let usage = applyRunUsageEvent(EMPTY_RUN_USAGE, { type: "turn_started", turnId: "t1" }, iso(0));
  usage = applyRunUsageEvent(usage, { type: "turn_completed", turnId: "t1" }, iso(4_000));
  assert.equal(usage.turns, 1);
  assert.equal(usage.reportedTurns, 0);
  assert.equal(usage.wallMs, 4_000);
  assert.equal(effectiveTokens(usage), 0);
  const task = taskUsage([run("worker", "executor", { usage })]);
  assert.equal(task.evidence, "exact");
  assert.equal(task.total.reportedTurns, 0);
  assert.equal(task.total.turns, 1);
  assert.equal(task.byRole.worker.wallMs, 4_000);
});

test("a terminal turn Queue never saw start counts as a turn but marks wall time partial", () => {
  const usage = applyRunUsageEvent(EMPTY_RUN_USAGE, { type: "turn_completed", turnId: "early", usage: { inputTokens: 10, outputTokens: 5 } }, iso(9_000));
  assert.equal(usage.turns, 1);
  assert.equal(usage.wallMs, 0);
  assert.equal(usage.partial, true);
  assert.equal(effectiveTokens(usage), 15);
});

test("a gap marks the run partial and usage keeps accumulating", () => {
  let usage = applyRunUsageEvent(EMPTY_RUN_USAGE, { type: "gap" }, iso(0));
  usage = applyRunUsageEvent(usage, { type: "turn_started", turnId: "t1" }, iso(1_000));
  usage = applyRunUsageEvent(usage, { type: "turn_completed", turnId: "t1", usage: { inputTokens: 7, outputTokens: 1 } }, iso(2_000));
  assert.equal(usage.partial, true);
  assert.equal(usage.inputTokens, 7);
  assert.equal(usage.wallMs, 1_000);
});

test("a run replaced mid-task adds its own turns, so the task sums both runs by role", () => {
  // Each turn starts and completes inside the stream, as Queue observes it.
  const turn = (turnId: string, usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }) =>
    applyRunUsageEvent(applyRunUsageEvent(EMPTY_RUN_USAGE, { type: "turn_started", turnId }, iso(0)), { type: "turn_completed", turnId, usage }, iso(1_000));
  const first = turn("a1", { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 });
  const replacement = turn("b1", { inputTokens: 40, cachedInputTokens: 500, outputTokens: 10 });
  const review = turn("r1", { inputTokens: 5, cachedInputTokens: 0, outputTokens: 5 });
  const task = taskUsage([
    run("first", "executor", { usage: first, released: true, status: "superseded" }),
    run("replacement", "executor", { usage: replacement }),
    run("review", "reviewer", { usage: review }),
  ]);
  assert.equal(task.evidence, "exact");
  assert.equal(task.byRole.worker.turns, 2);
  assert.equal(task.byRole.worker.effectiveTokens, 120 + 40 + 10 + 50);
  assert.equal(task.byRole.reviewer.effectiveTokens, 10);
  assert.equal(task.total.turns, 3);
  assert.equal(task.total.effectiveTokens, task.byRole.worker.effectiveTokens + task.byRole.reviewer.effectiveTokens);
});

test("a dispatched run with no usage makes the task partial, and no usage at all reads as none", () => {
  const measured = applyRunUsageEvent(EMPTY_RUN_USAGE, { type: "turn_completed", turnId: "t1", usage: { inputTokens: 1 } }, iso(0));
  assert.equal(taskUsage([run("a", "executor", { usage: measured }), run("b", "reviewer")]).evidence, "partial");
  assert.equal(taskUsage([run("a", "executor"), run("b", "reviewer")]).evidence, "none");
  assert.equal(taskUsage([]).evidence, "none");
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-run-usage-")), path = join(dir, "queue.sqlite");
  let store = new Store(path);
  const addTask = (id: string) => store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath: "/repo", scope: "general", planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", "a".repeat(40));
  return {
    get store() { return store; },
    addTask,
    reopen() { store.close(); store = new Store(path); return store; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("usage survives a Queue restart on the run row", () => {
  const f = fixture();
  try {
    const taskId = f.addTask("task").id;
    f.store.putRun(run("worker", "executor", { taskId }));
    assert.equal(f.store.updateRunUsage("worker", usage => applyRunUsageEvent(usage, { type: "turn_completed", turnId: "t1", usage: { inputTokens: 3, outputTokens: 4 } }, iso(0))), true);
    assert.equal(f.store.updateRunUsage("worker", usage => usage), false);
    assert.equal(f.reopen().run("worker")?.usage?.outputTokens, 4);
  } finally {
    f.close();
  }
});

test("the tracker opens one stream per unreleased agent, records its turns and closes when the run settles", async () => {
  const f = fixture();
  try {
    const taskId = f.addTask("task").id;
    f.store.putRun(run("worker", "executor", { taskId }));
    const handlers = new Map<string, (event: RunUsageStreamEvent) => void>();
    const streams: Array<(() => void) & { ready: Promise<void>; subscriptionId: string | null; closed?: boolean }> = [];
    let now = start;
    const tracker = new RunUsageTracker(f.store, {
      subscribeRunUsage: async (agentId, handler) => {
        handlers.set(agentId, handler);
        const stream = Object.assign(() => { stream.closed = true; }, { ready: Promise.resolve(), subscriptionId: agentId, closed: false });
        streams.push(stream);
        return stream;
      },
    }, () => new Date(now));
    tracker.sync();
    await flush();
    assert.equal(streams.length, 1);
    const emit = handlers.get("agent-worker")!;
    emit({ agentId: "agent-worker", event: { type: "turn_started", turnId: "t1" } });
    now = start + 3_000;
    emit({ agentId: "agent-worker", event: { type: "turn_completed", turnId: "t1", usage: { inputTokens: 100, cachedInputTokens: 1_000, outputTokens: 50 } } });
    const recorded = f.store.run("worker")!.usage!;
    assert.equal(recorded.turns, 1);
    assert.equal(recorded.wallMs, 3_000);
    assert.equal(recorded.partial, false);
    // The daemon released the stream: the run is marked a gap and the stream reopens on the same pass.
    streams[0].subscriptionId = null;
    tracker.sync();
    await flush();
    assert.equal(streams[0].closed, true);
    assert.equal(streams.length, 2);
    assert.equal(f.store.run("worker")!.usage!.partial, true);
    // Once the run settles, its stream closes and nothing reopens.
    f.store.putRun({ ...f.store.run("worker")!, released: true, status: "finished" });
    tracker.sync();
    await flush();
    assert.equal(streams[1].closed, true);
    assert.equal(streams.length, 2);
    tracker.close();
  } finally {
    f.close();
  }
});

test("usage by complexity reports percentiles over finished tasks and counts unmeasured tasks as partial", () => {
  const f = fixture();
  try {
    const finish = (id: string, complexity: string) => {
      const taskId = f.addTask(id).id;
      const task = taskSchema.parse({ ...f.store.task(taskId), phase: "done", complexity, finishedAt: iso(60_000) });
      f.store.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(task), taskId);
      return taskId;
    };
    const small = finish("small", "medium"), large = finish("large", "medium");
    finish("bare", "medium");
    f.store.putRun(run("small-worker", "executor", { taskId: small }));
    f.store.putRun(run("large-worker", "executor", { taskId: large }));
    const observe = (runId: string, turnId: string, usage: { inputTokens: number; outputTokens: number }) => {
      f.store.updateRunUsage(runId, value => applyRunUsageEvent(value, { type: "turn_started", turnId }, iso(0)));
      f.store.updateRunUsage(runId, value => applyRunUsageEvent(value, { type: "turn_completed", turnId, usage }, iso(1_000)));
    };
    observe("small-worker", "s", { inputTokens: 100, outputTokens: 50 });
    observe("large-worker", "l", { inputTokens: 900, outputTokens: 100 });
    const snapshot = telemetrySnapshot(f.store, {}, new Date(start + 120_000));
    const medium = snapshot.usageByComplexity.find(row => row.complexity === "medium")!;
    assert.equal(medium.finishedCount, 3);
    assert.equal(medium.effectiveTokens.count, 2);
    assert.equal(medium.effectiveTokens.p50, 150);
    assert.equal(medium.effectiveTokens.p95, 1_000);
    assert.equal(medium.effectiveTokens.partialCount, 1);
  } finally {
    f.close();
  }
});
