import { test } from "node:test";
import assert from "node:assert/strict";
import { RetirementLane } from "../core/runtime/retirement-lane";
import type { Engine } from "../core/engine";

const TASK = "synthetic-retirement";

function fixture(hostId: string | null = "t3code:synthetic") {
  const ran: string[] = [];
  const scheduled: Array<{ key: string; work: () => Promise<void> }> = [];
  const lane = new RetirementLane({
    get stopped() { return false; },
    store: { task: () => ({ id: TASK, hostId }) },
    scheduleLane: (key: string, _priority: number, work: () => Promise<void>) => {
      scheduled.push({ key, work });
      return Promise.resolve();
    },
    withHost: (_host: string, work: () => unknown) => work(),
    taskHostAvailable: () => true,
    retirement: { retryDue: async (id: string) => { ran.push(id); } },
  } as unknown as Engine);
  return { lane, ran, scheduled };
}

test("duplicate retirement sweeps coalesce onto one lane, and a later sweep schedules again", async () => {
  const f = fixture();
  f.lane.schedule(TASK);
  f.lane.schedule(TASK);
  assert.equal(f.scheduled.length, 1, "a second sweep joins the queued lane");
  assert.equal(f.scheduled[0]!.key, `runtime-retirement:${TASK}`);
  await f.scheduled[0]!.work();
  assert.deepEqual(f.ran, [TASK]);
  f.lane.schedule(TASK);
  assert.equal(f.scheduled.length, 2, "the task is schedulable again once its lane finished");
});

test("a retirement proof is never attempted for a task with no host", async () => {
  const f = fixture(null);
  f.lane.schedule(TASK);
  await f.scheduled[0]!.work();
  assert.deepEqual(f.ran, [], "a task with no host has no host to prove its retirement on");
});
