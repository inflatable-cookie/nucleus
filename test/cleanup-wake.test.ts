import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../core/engine";
import { PrerequisiteReleases } from "../core/scheduling/prerequisites";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * A post-roll wake is the board's reconciliation diagnostic (runtime-owner's
 * bounded "Post-bootstrap reconciliation" step). A workspace archive legitimately
 * runs for minutes, so the wake kicks the cleanup lane and returns; the archive's
 * own durable record carries its progress and its cause.
 */
function fixture() {
  const engine = Object.create(Engine.prototype) as Engine;
  const state = engine as any;
  const archives: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const titles: string[] = [];
  Object.assign(state, {
    stopped: false, prerequisiteReleases: new PrerequisiteReleases(state), wakePreludes: 0, quiesceWaiters: [], lifecycleFollowUps: new Set(), dispatchScheduled: false, activeLanes: new Set(), lanes: new Map(), laneKey: { getStore: () => undefined }, adapter: {}, cleanupQueue: [], cleanupDraining: null, titleQueue: new Set(), titleDraining: null,
    projectionEnqueued: new Map(), projectionDone: new Map(), projectionInFlight: new Set(), projectionWaiters: [],
    // #912: every task is host-scoped, and cleanup runs each effect inside its host.
    withHost: (_id: string, fn: () => unknown) => fn(), taskHostAvailable: () => true,
    store: { getMeta: () => false, task: (id: string) => ({ id, hostId: "host" }) },
    scheduleCleanupRetry: () => {},
    enqueueTitle: () => {},
    syncWorkspaceTitle: async (task: { id: string }) => { titles.push(task.id); },
    lifecycle: { archive: async (task: { id: string }) => { archives.push(task.id); await held; } },
  });
  // The sweep and lane drain are tested elsewhere; this proves the projection cut.
  state.archivePlannerGrants = async () => {};
  state.ensureSweep = async () => {};
  state.quiesce = async () => {};
  return { engine, state, archives, titles, release: () => release() };
}

test("a wake settles while a workspace archive holds the cleanup lane open", async () => {
  const f = fixture();
  f.engine.enqueueCleanup("slow");
  await tick();
  assert.deepEqual(f.archives, ["slow"], "the cleanup lane was kicked");
  const outcome = await Promise.race([
    f.engine.wake().then(() => "settled"),
    new Promise<string>(resolve => setTimeout(() => resolve("held"), 250)),
  ]);
  assert.equal(outcome, "settled", "reconciliation does not wait for the archive");
  assert.equal(f.state.cleanupQueue.length, 0, "the archive is still running, not abandoned");
  assert.equal(f.state.projectionDone.get("cleanup:slow:"), undefined);

  f.release();
  await f.engine.drainCleanup();
  assert.equal(f.state.projectionDone.get("cleanup:slow:"), 1, "the archive still finishes on its own lane");
});

test("a wake still waits for the title projection at its cut", async () => {
  const f = fixture();
  const task = { id: "t1" };
  f.state.titleQueue.add(task.id);
  f.state.projectionEnqueued.set(`title:${task.id}`, 1);
  await f.engine.wake();
  assert.deepEqual(f.titles, ["t1"]);
  assert.equal(f.state.projectionDone.get("title:t1"), 1);
});
