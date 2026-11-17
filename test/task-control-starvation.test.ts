import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { runSchema, submissionSchema, type Run, type TaskControlInput } from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { HostProcessFact } from "../core/host/types";
import { LaneScheduler } from "../core/scheduling/lane-scheduler";
import { LANE_PRIORITY_OPERATION, LANE_PRIORITY_TASK } from "../core/scheduling/lane-priorities";
import { taskControlOperation } from "../core/verbs/task-control-key";

/**
 * nucleus#1306: a lane held by one overrunning observation quantum must not
 * starve an accepted owner control behind it. Work queued on the same exclusive
 * key now runs at its priority (a control before observation quanta), a second
 * observation quantum is covered by the one already queued, and a task quantum
 * never waits for the host process table.
 */

const base = "b".repeat(40), head = "a".repeat(40);

test("a queued control runs before queued observation quanta on the task's own lane", async () => {
  const lanes = new LaneScheduler(() => false, () => false, work => work());
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const running = lanes.scheduleLane("task:fixture", LANE_PRIORITY_TASK, async () => { order.push("quantum"); await held; });
  const observation = lanes.scheduleLane("task:fixture", LANE_PRIORITY_TASK, () => { order.push("observation"); }, { coalesce: "task-quantum" });
  const duplicate = lanes.scheduleLane("task:fixture", LANE_PRIORITY_TASK, () => { order.push("duplicate"); }, { coalesce: "task-quantum" });
  assert.equal(duplicate, observation, "a queued quantum already covers a second request for the same task");
  const control = lanes.scheduleLane("task:fixture", LANE_PRIORITY_OPERATION, () => { order.push("control"); });
  release();
  await Promise.all([running, observation, control]);
  assert.deepEqual(order, ["quantum", "control", "observation"],
    "the control starts as soon as the held lane resumes, before the queued observation");
});

test("a task control accepted while a task quantum holds the lane starts once the lane resumes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-control-starvation-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: "Control starvation",
    repoPath: join(dir, "repo"), planningCommit: base, handoffPath: "handoff.md", originAgentId: "origin" }), "host", "handoff", base);
  const engine = new Engine(store, {} as unknown as Adapter, 0);
  try {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let heldQuantum = false, observationRanAt = 0;
    void engine.scheduleLane(`task:${task.id}`, LANE_PRIORITY_TASK, async () => { heldQuantum = true; await held; });
    // The observation the sweep would queue while that quantum overruns.
    const observation = engine.scheduleLane(`task:${task.id}`, LANE_PRIORITY_TASK, () => { observationRanAt = Date.now(); }, { coalesce: "task-quantum" });
    await tick();
    assert.equal(heldQuantum, true);
    const control: TaskControlInput = { taskId: task.id, action: "complete", version: store.task(task.id).version,
      caller: "operator", reason: "Fixture control accepted while the task lane is held" };
    const { key, payload } = taskControlOperation(control);
    const acceptance = await engine.startOperation({ key, kind: "task_control", payload, taskId: task.id, expectedVersion: control.version });
    assert.ok("accepted" in acceptance, JSON.stringify(acceptance));
    const id = acceptance.operation.id;
    await tick();
    assert.equal(store.operation(id)?.attempts, 0, "accepted, and not started while the lane is held");
    assert.equal(store.operation(id)?.startedAt, null);
    release();
    // Promptly after the lane resumes: the control starts, ahead of the queued quantum.
    await eventually(() => (store.operation(id)?.attempts ?? 0) >= 1, 10_000);
    await observation;
    // Its own outcome is not this test's subject; that it started, first, is.
    const startedAt = Date.parse(store.operation(id)!.startedAt!);
    assert.ok(startedAt > 0);
    assert.ok(startedAt <= observationRanAt, `the control started before the queued observation quantum (${startedAt} <= ${observationRanAt})`);
  } finally {
    await engine.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task quantum never waits for the host process table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-quantum-cleanup-lane-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: "Quantum cleanup lane",
    repoPath: join(dir, "repo"), planningCommit: base, handoffPath: "handoff.md", originAgentId: "origin" }), "host", "handoff", base);
  let answer!: (facts: HostProcessFact[] | null) => void;
  let requested = 0;
  const adapter = { hostProcessListing: () => { requested++; return new Promise<HostProcessFact[] | null>(resolve => { answer = resolve; }); } } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  try {
    // A settled run's owed cleanup is what queues the host sweep; that sweep's
    // process read is the one that never answers here.
    const run: Run = runSchema.parse({ id: "settled-run", taskId: task.id, role: "revision", generation: 1, head, base,
      agentId: "agent", workspaceId: "ws", profile: null, status: "running", createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false });
    store.putRun(run);
    store.putRun({ ...run, released: true, status: "finished", active: false });
    const bounded = await Promise.race([
      engine.quantumSteps(task.id, store.task(task.id), { pausedForPrerequisiteWait: false }).then(() => "returned"),
      tick(2_000).then(() => "still waiting"),
    ]);
    assert.equal(bounded, "returned", "the quantum returns while the process read is still outstanding");
    await eventually(() => requested > 0, 5_000);
    assert.equal(store.events(task.id).filter(event => event.kind === "task_step_failure").length, 0,
      JSON.stringify(store.events(task.id).map(event => event.kind)));
  } finally {
    // Answer the outstanding read so shutdown's own drain observes nothing.
    if (answer!) answer([]);
    await engine.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function tick(ms = 20): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function eventually(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in the bounded wait");
    await tick(10);
  }
}
