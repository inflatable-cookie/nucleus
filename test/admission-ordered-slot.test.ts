import { test } from "node:test";
import assert from "node:assert/strict";
import { Admission, admitAdapter } from "../core/host/admission";
import { HostCallAbandonedError } from "../core/host/errors";
import { ensureHostCallOpen } from "../shared/host-call-timing";
import type { Adapter } from "../core/host/adapter";

/**
 * One owner admits an ordered host call (nucleus#1472).
 *
 * An ordered steer/notify used to admit itself twice: the per-agent chain took
 * one callback slot and then the native send took another. At the supported
 * total limit of one the outer slot self-blocked the send it was waiting for,
 * and the send could outlive the deadline that was supposed to fence it. The
 * chain now admits the native send once and holds that one slot, deadline and
 * host-call fence through it.
 */

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an ordered send holds one callback slot and answers under a total limit of one", async () => {
  const admission = new Admission({
    totalLimit: 1,
    startIntervalMs: 0,
    callDeadlineMs: 500,
    heldSlotWarnMs: 0,
    log: () => {},
  });
  const gate = deferred();
  const sent: string[] = [];
  const raw = {
    steerOrNotify: async (_agent: string, id: string) => {
      sent.push(id);
      await gate.promise;
    },
  };
  const adapter = admitAdapter(raw as unknown as Adapter, admission);

  const sending = adapter.steerOrNotify!("agent", "one", "text");
  await tick();
  assert.deepEqual(
    sent,
    ["one"],
    "the ordered send starts instead of waiting for a slot it holds itself",
  );
  const held = admission.snapshot();
  assert.equal(held.callback.running, 1, "one admitted effect holds the slot");
  assert.deepEqual(
    held.heldSlots.map((slot) => ({ cls: slot.cls, holder: slot.holder })),
    [{ cls: "callback", holder: "steerOrNotify:agent" }],
    "the ordered send is named once, by the chain that admits it",
  );

  gate.resolve();
  await sending;
  const after = admission.snapshot();
  assert.equal(after.callback.completed, 1, "the send is admitted once, not per layer");
  assert.equal(after.callback.running, 0);
  assert.equal(after.abandoned.count, 0, "the send never reaches its deadline");
});

test("the callback class saturates per ordered send, not per admission layer", async () => {
  const admission = new Admission({
    limits: { callback: 2 },
    startIntervalMs: 0,
    callDeadlineMs: 500,
  });
  const gate = deferred();
  const started: string[] = [];
  const raw = {
    steerOrNotify: async (agent: string) => {
      started.push(agent);
      await gate.promise;
    },
  };
  const adapter = admitAdapter(raw as unknown as Adapter, admission);

  const sends = [
    adapter.steerOrNotify!("first", "one", "text"),
    adapter.steerOrNotify!("second", "two", "text"),
  ];
  await tick();
  assert.deepEqual(
    started,
    ["first", "second"],
    "both sends fit the two-wide callback class, since each holds one slot",
  );
  assert.equal(admission.snapshot().callback.running, 2);

  gate.resolve();
  await Promise.all(sends);
  assert.equal(admission.snapshot().callback.completed, 2);
});

test("an ordered send that outlives its admission is never sent, and its slot is freed", async () => {
  const admission = new Admission({ startIntervalMs: 0, callDeadlineMs: 60 });
  const sent: string[] = [];
  const refused: string[] = [];
  const raw = {
    steerOrNotify: async () => {
      // Native preparation that outlives the admission deadline.
      await sleep(120);
      try {
        ensureHostCallOpen();
        sent.push("late");
      } catch {
        refused.push("late");
      }
    },
  };
  const adapter = admitAdapter(raw as unknown as Adapter, admission);

  await assert.rejects(
    adapter.steerOrNotify!("agent", "late", "text"),
    (error: unknown) => error instanceof HostCallAbandonedError,
    "the caller hears the abandonment, not a plain failure",
  );
  await sleep(100);
  assert.deepEqual(sent, [], "the expired admission never sends");
  assert.deepEqual(refused, ["late"], "the fence refuses the send it no longer covers");
  const after = admission.snapshot();
  assert.equal(after.abandoned.count, 1, "the abandoned send is named as unknown");
  assert.equal(after.callback.running, 0, "its one slot is free");
});

test("a delayed observation across an invalidation never joins the stale pre-send read", async () => {
  const admission = new Admission({
    startIntervalMs: 0,
    observationCacheMs: 60_000,
  });
  const gate = deferred();
  const reads: string[] = [];
  let state = {
    id: "agent",
    workspaceId: "ws",
    status: "idle",
    active: false,
    permissions: false,
  };
  const raw = {
    observe: async (id: string) => {
      const captured = { ...state, id };
      reads.push(captured.status);
      // The first read is delayed across the send, as a slow host read is.
      if (reads.length === 1) await gate.promise;
      return captured;
    },
    steerOrNotify: async () => {},
  };
  const adapter = admitAdapter(raw as unknown as Adapter, admission);

  const stale = adapter.observe!("agent");
  await tick();
  // The send settles and invalidates the evidence cached for that agent.
  await adapter.steerOrNotify!("agent", "one", "text");
  state = { ...state, status: "running", active: true };

  const fresh = await adapter.observe!("agent");
  assert.equal(fresh.status, "running", "the post-send read reaches the host");
  assert.deepEqual(reads, ["idle", "running"], "it is its own read, not the stale one");

  gate.resolve();
  const before = await stale;
  assert.equal(before.status, "idle", "the pre-send read still answers its own caller");
  assert.equal(
    admission.snapshot().observationCacheEntries,
    0,
    "the stale read does not populate the new epoch's cache",
  );
  const again = await adapter.observe!("agent");
  assert.equal(again.status, "running", "a later read is fresh too");
  assert.equal(reads.length, 3);
});
