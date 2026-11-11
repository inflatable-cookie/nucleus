import { test } from "node:test";
import assert from "node:assert/strict";
import { queueControl, stateSchema, boardAckSchema } from "../shared/contracts";
import {
  boundDrainProjection,
  settlementHeld,
  startsNoRuns,
} from "../core/closeout/queue-drain";

test("queue.control accepts pause or dispatch hold and refuses a draining field", () => {
  assert.deepEqual(queueControl.input.parse({ paused: true }), {
    paused: true,
  });
  assert.deepEqual(queueControl.input.parse({ dispatchHeld: false }), {
    dispatchHeld: false,
  });
  assert.throws(() => queueControl.input.parse({}), /paused or dispatchHeld/);
  assert.throws(
    () => queueControl.input.parse({ draining: true }),
    /Unrecognized key|unrecognized/i,
  );
});

test("board snapshot and ack carry drained and boundRuns, not a draining control", () => {
  const ack = boardAckSchema.parse({
    unchanged: true,
    revision: 1,
    connected: true,
    paused: true,
    quiet: true,
    activeWorkers: 0,
    unsettled: 0,
    error: "",
    stoppedThreads: 0,
    resumedThreads: 0,
  });
  assert.equal(ack.drained, false);
  assert.deepEqual(ack.boundRuns, []);
  assert.equal("draining" in ack, false);
  const state = stateSchema.parse({
    connected: true,
    hostId: "host",
    paused: true,
    error: "",
    quiet: true,
    activeWorkers: 0,
    unsettled: 0,
    globalLimit: 32,
    projectLimit: 5,
    tasks: [],
    profiles: [],
    pool: [],
    availability: [],
    assignments: {},
    recentAssignments: {},
  });
  assert.equal(state.drained, false);
  assert.deepEqual(state.boundRuns, []);
  assert.equal("draining" in state, false);
});

test("settlementHeld is stop only; startsNoRuns is pause or stop", () => {
  const paused = {
    getMeta: (key: string) => (key === "paused" ? true : undefined),
  };
  const running = {
    getMeta: (key: string) => (key === "paused" ? false : undefined),
  };
  assert.equal(settlementHeld(paused), false);
  assert.equal(settlementHeld(paused, true), true);
  assert.equal(startsNoRuns(paused), true);
  assert.equal(startsNoRuns(running), false);
  assert.equal(startsNoRuns(running, true), true);
});

test("boundDrainProjection is drained when every run is released and no operation is in flight", () => {
  const empty = {
    getMeta: () => undefined,
    pendingRuns: () => [],
    operations: () => [],
    task: () => ({ reference: null, number: null }),
  };
  assert.deepEqual(boundDrainProjection(empty), {
    drained: true,
    boundRuns: [],
  });
  const bound = {
    ...empty,
    pendingRuns: () => [
      { id: "run-1", taskId: "task-1", role: "reviewer", released: false },
    ],
    task: () => ({ reference: "nucleus#1", number: 1 }),
  };
  assert.deepEqual(boundDrainProjection(bound), {
    drained: false,
    boundRuns: [
      {
        taskId: "task-1",
        runId: "run-1",
        role: "reviewer",
        reference: "nucleus#1",
      },
    ],
  });
  const inFlight = {
    ...empty,
    operations: () => [{ id: "op" }],
  };
  assert.equal(boundDrainProjection(inFlight).drained, false);
});
