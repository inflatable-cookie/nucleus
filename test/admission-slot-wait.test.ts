import { test } from "node:test";
import assert from "node:assert/strict";
import { Admission } from "../core/host/admission";
import { hostAdmissionViews } from "../service/runtime-health";
import { hostAdmissionSchema } from "../shared/telemetry";

/**
 * Per-host call queues are visible (perf investigation, 2026-11-23).
 *
 * T3 reads answered in milliseconds inside the service yet callers saw seconds:
 * the wait was for an admission slot, not for the host. Health showed only the
 * legacy primary's queue, and its latency samples cannot show a slot wait. Each
 * class now keeps its recent slot waits, and health names every host's queue.
 */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a call that waits for its class slot records the wait apart from host latency", async () => {
  let clock = 1_000;
  const admission = new Admission({
    limits: { inventory: 1 },
    startIntervalMs: 0,
    now: () => clock,
    log: () => {},
  });
  const first = deferred();
  const holding = admission.run("inventory", () => first.promise);
  const queued = admission.run("inventory", async () => "answered");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admission.snapshot().inventory.waiting, 1);

  clock += 1_500;
  first.resolve();
  await holding;
  assert.equal(await queued, "answered");

  const snapshot = admission.snapshot();
  assert.equal(snapshot.slotWait.inventory.samples, 2);
  assert.equal(snapshot.slotWait.inventory.maxMs, 1_500);
  assert.equal(
    snapshot.latency.inventory.maxMs,
    1_500,
    "the first call held the slot for the whole window",
  );
  assert.equal(snapshot.slotWait.observation.samples, 0);
  assert.deepEqual(snapshot.total, {
    limit: 6,
    running: 0,
    waiting: 0,
    startIntervalMs: 0,
  });
  assert.doesNotThrow(() => hostAdmissionSchema.parse(snapshot));
});

test("a stored snapshot from before slot waits still parses", () => {
  const current = new Admission({ log: () => {} }).snapshot();
  const { slotWait: _slotWait, total: _total, ...older } = current;
  const parsed = hostAdmissionSchema.parse(older);
  assert.equal(parsed.slotWait.inventory.samples, 0);
  assert.equal(parsed.total.waiting, 0);
});

test("health names each host's own admission queue and skips other resources", () => {
  const t3 = new Admission({ log: () => {} });
  const bb = new Admission({ log: () => {} });
  const views = hostAdmissionViews([
    ["t3code:b", t3],
    ["bb:a", bb],
    ["other", { snapshot: () => ({}) }],
  ]);
  assert.deepEqual(
    views.map((view) => view.hostId),
    ["bb:a", "t3code:b"],
  );
  assert.equal(views[1]!.admission.inventory.limit, 1);
});
