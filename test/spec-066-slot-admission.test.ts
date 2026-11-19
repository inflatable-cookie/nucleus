import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { occupiesSlot } from "../core/dispatch/capacity";
import { Engine } from "../core/engine";
import { RuntimeBoard } from "../core/runtime/board";
import { Store } from "../core/store/store";
import { createTaskDetailCache } from "../core/telemetry/task-detail";
import { createUiSnapshotFactsCache } from "../core/telemetry/ui-snapshot";
import { formatTaskNumber, runSchema, type Task } from "../shared/contracts";
import { TASK_PROGRESSING_REASON } from "../shared/task-detail-summary";
import { fakeAdapter, profile, submission } from "./support/fakes";

function fixture(validate?: (task: Task) => Promise<string>) {
  const dir = mkdtempSync(join(tmpdir(), "ns-066-c3-"));
  const database = join(dir, "queue.sqlite");
  let store = new Store(database);
  const worker = profile("c3-worker");
  const starts: string[] = [];
  const adapter = fakeAdapter({
    hostId: "host",
    validate: validate ?? (async (task: Task) => task.planningBase),
    createWorkspace: async (task: Task) => ({
      id: `ws-${task.id}`,
      directory: mkdtempSync(join(dir, "workspace-")),
    }),
    verifyWorkspace: async (task: Task) => task.branch,
    createAgent: async (task: Task) => {
      assert.ok(
        store.eventsAll(task.id).some((event) => event.kind === "agent_intent"),
      );
      assert.equal(
        store.activeCapacityTasks().filter((task) => occupiesSlot(task)).length,
        1,
      );
      starts.push(task.id);
      return { id: `agent-${task.id}`, workspaceId: task.workspaceId };
    },
    observe: async (id: string) => ({
      id,
      workspaceId: `ws-${id.slice(6)}`,
      status: "running",
      active: true,
      permissions: false,
      error: "",
    }),
    notify: async () => {},
  });
  const startEngine = () => {
    const engine = new Engine(store, adapter, 0, () => true);
    engine.profiles = [worker];
    return engine;
  };
  let engine = startEngine();
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 1);
  store.setMeta("pool", [
    {
      profileId: worker.id,
      enabled: true,
      group: "test",
      weight: 1,
      scopes: ["general"],
    },
  ]);
  const add = (title: string, dependsOn: string[] = []) =>
    store.insert(
      submission({ title, dependsOn }),
      "host",
      "handoff",
      "b".repeat(40),
    );
  const readViews = () => {
    const details = createTaskDetailCache(store, {
      slotAdmissionReason: (task) =>
        engine.resolution.slotAdmissionReason(task),
    });
    const snapshot = createUiSnapshotFactsCache(store, (tasks, runs) =>
      engine.resolution.slotAdmissionReader(tasks, runs),
    );
    const board = new RuntimeBoard({
      store,
      engine,
      cachedTaskDetail: details,
      cachedUiSnapshotFacts: snapshot,
      markStoreAccess: () => {},
    } as unknown as ConstructorParameters<typeof RuntimeBoard>[0]);
    return { details, snapshot, board };
  };
  let views = readViews();
  return {
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    starts,
    add,
    details: (id: string) => views.details(id),
    snapshot: () => views.snapshot(),
    next: (task: Task) => views.board.taskNext({ taskId: task.id }),
    roll: async () => {
      await engine.stop();
      store.close();
      store = new Store(database);
      engine = startEngine();
      views = readViews();
    },
    sweep: async () => {
      assert.equal((await engine.auditPass(true)).fault, null);
      await engine.quiesce();
    },
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const label = (task: Task) => `#${formatTaskNumber(task.number!)}`;

test("C3 sweep drops finished occupants and reuses the first free slot once", async () => {
  const f = fixture();
  try {
    const gone = f.store.update(f.add("Former in-flight request").id, {
      phase: "awaiting_review",
    });
    const first = f.add("Oldest queued");
    const second = f.add("Second queued");
    const oldWait = f.engine.resolution.slotAdmissionReason(first);
    assert.match(oldWait, /waiting behind 1 in-flight/);
    assert.ok(oldWait.includes(label(gone)));
    for (const task of [first, second])
      f.engine.resolution.recordStop(task, "capacity", oldWait);
    const mechanical = f.store.update(f.add("Former slot waiter").id, {
      phase: "verifying",
    });
    f.engine.resolution.waiting(mechanical, oldWait, "capacity");

    // Recreate the retained completion and history from the actual row writers.
    f.store.event(
      gone.id,
      "transport_deferred",
      "Synthetic transport observation",
    );
    const recovery = runSchema.parse({
      id: "old-recovery",
      taskId: mechanical.id,
      role: "recovery",
      generation: 1,
      hostId: "host",
      workspaceId: "old-workspace",
      agentId: "old-recovery-agent",
      head: gone.planningBase,
      base: gone.planningBase,
      createdAt: gone.createdAt,
      status: "running",
      active: true,
      released: false,
      profile: null,
      lastObservedAt: null,
      idleSince: null,
      completion: null,
    });
    f.store.putRun(recovery);
    f.store.putRun({ ...recovery, status: "superseded", released: true });
    f.store.update(
      gone.id,
      { phase: "done", reason: "Closed out after owner move" },
      "closed_out",
    );

    const landed = f.add("Already merged");
    f.engine.resolution.update(
      landed,
      { mergedCommit: "c".repeat(40) },
      {
        phase: "syncing",
        agentId: "old-worker",
        agentActive: true,
        agentIntent: true,
      },
      "merge_verified",
    );

    await f.roll();
    assert.equal(
      f.store.run(recovery.id)?.active,
      true,
      "the stale activity bit is part of the fixture",
    );
    assert.equal(f.store.run(recovery.id)?.released, true);
    assert.deepEqual(
      f.store
        .activeCapacityTasks()
        .filter((task) => occupiesSlot(task))
        .map((task) => task.id),
      [],
    );
    assert.equal(f.next(first).reason, "Waiting for dispatch");
    assert.doesNotMatch(f.next(second).reason, /in-flight/);
    assert.equal(
      f.store.task(first.id).resolution.stop?.detail,
      oldWait,
      "reads leave the original stop in the journal",
    );

    await f.sweep();
    assert.deepEqual(f.starts, [first.id]);
    assert.equal(f.store.task(first.id).phase, "working");
    assert.equal(f.store.task(first.id).resolution.stop, null);
    assert.equal(f.next(first).stop, null);
    assert.equal(f.store.task(mechanical.id).resolution.stop, null);
    const settledNext = f.next(mechanical);
    assert.equal(settledNext.phase, "verifying");
    assert.equal(settledNext.stop, null);
    assert.equal(settledNext.reason, TASK_PROGRESSING_REASON);
    assert.equal(
      f.store
        .eventsAll(mechanical.id)
        .filter((event) => event.kind === "slot_wait_settled").length,
      1,
    );
    assert.match(f.next(second).stop?.detail ?? "", /1\/1 occupied/);
    assert.ok(f.next(second).reason.includes(label(first)));
    assert.equal(f.details(second.id).task.reason, f.next(second).reason);
    assert.equal(
      f.snapshot().summaries.find((task) => task.id === second.id)?.stopRecord
        ?.detail,
      f.next(second).stop?.detail,
    );
    assert.ok(!f.next(second).reason.includes(label(gone)));

    const intents = () =>
      f.store
        .eventsAll(first.id)
        .filter((event) => event.kind === "dispatch_intent").length;
    const notices = f.store.notices(first.id);
    await f.sweep();
    assert.deepEqual(f.starts, [first.id]);
    assert.equal(intents(), 1);
    assert.deepEqual(f.store.notices(first.id), notices);
    const replayedNext = f.next(mechanical);
    assert.equal(replayedNext.stop, null);
    assert.equal(replayedNext.reason, settledNext.reason);
    assert.equal(
      f.store
        .eventsAll(mechanical.id)
        .filter((event) => event.kind === "slot_wait_settled").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("C3 rechecks order after a competing dispatch awaited preflight", async () => {
  let entered = () => {},
    release = () => {};
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (task) => {
    if (task.title === "Competing dispatch") {
      entered();
      await released;
    }
    return task.planningBase;
  });
  try {
    const prerequisite = f.store.update(f.add("Prerequisite").id, {
      phase: "working",
    });
    const oldest = f.add("Oldest queued", [prerequisite.id]);
    const competitor = f.add("Competing dispatch");
    const attempt = f.engine.dispatchTask(competitor.id, false);
    await Promise.race([
      entering,
      attempt.then(() => assert.fail("Dispatch never entered preflight")),
    ]);
    f.store.update(prerequisite.id, { phase: "done" }, "closed_out");
    release();
    await attempt;
    assert.equal(f.store.task(competitor.id).phase, "queued");
    assert.equal(
      f.store
        .eventsAll(competitor.id)
        .filter((event) => event.kind === "dispatch_intent").length,
      0,
    );
    assert.match(
      f.next(competitor).reason,
      /earlier queued reservations|1\/1 occupied/,
    );
    await f.sweep();
    assert.deepEqual(f.starts, [oldest.id]);
    assert.equal(f.store.task(oldest.id).phase, "working");
    assert.match(f.next(competitor).stop?.detail ?? "", /1\/1 occupied/);
    assert.ok(f.next(competitor).reason.includes(label(oldest)));
    await f.sweep();
    assert.deepEqual(f.starts, [oldest.id]);
  } finally {
    release();
    await f.close();
  }
});
