import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { enginePorts } from "../core/port-context";
import { SweepMaintenance } from "../core/scheduling/sweep-maintenance";
import type { Adapter } from "../core/host";

/**
 * nucleus#1257: the sweep's periodic chores are their own owner. Each pass is
 * judged at its boundary — which chores a pass runs, which it leaves to their own
 * cadence, and that a failed chore is recorded instead of retried in a loop.
 */
type Loose = Record<string, any>;
const HOUR = 3_600_000;
/** A pass time past every chore's first window, so the first pass runs each of them. */
const AT = 26 * HOUR;

function fixture(t: TestContext) {
  const store = new Store(":memory:");
  const engine = new Engine(store, {} as Adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  store.setMeta("paused", false);
  const migrations = { count: 0 };
  (engine as unknown as Loose).migrateProjectOwnersToPlanners = async () => {
    migrations.count++;
  };
  (engine as unknown as Loose).removeSiblings = async () => {};
  const maintenance = new SweepMaintenance(
    enginePorts(
      engine,
      [
        "adapter",
        "hostAvailable",
        "hostIds",
        "migrateProjectOwnersToPlanners",
        "removeSiblings",
        "store",
        "withHost",
      ],
      [],
    ),
  );
  return { store, engine, maintenance, migrations };
}

test("the first pass runs the hourly and daily chores once and clears their failure keys", async (t) => {
  const f = fixture(t);
  f.store.setMeta("laneIdleError", "stale");
  f.store.setMeta("laneDrainError", "stale");
  f.store.setMeta("projectOwnerError", "stale");

  await f.maintenance.run(AT);

  assert.equal(
    f.maintenance.lastHookCleanupAt,
    AT,
    "the hourly hook and data-home retention pass ran",
  );
  assert.equal(f.store.getMeta("lastLaneIdleAt"), AT);
  assert.equal(f.store.getMeta("lastLaneDrainAt"), AT);
  assert.equal(
    f.store.getMeta("retentionError"),
    "",
    "a clean daily retention pass records no failure",
  );
  assert.equal(f.store.getMeta("laneIdleError"), "");
  assert.equal(f.store.getMeta("laneDrainError"), "");
  assert.equal(f.store.getMeta("projectOwnerError"), "");
  assert.equal(f.migrations.count, 1);
});

test("a second pass inside the same hour and day leaves every chore to its own cadence", async (t) => {
  const f = fixture(t);
  await f.maintenance.run(AT);
  let idle = 0;
  f.store.closeIdleLanes = (() => {
    idle++;
    return 0;
  }) as unknown as typeof f.store.closeIdleLanes;

  await f.maintenance.run(AT + HOUR / 2);

  assert.equal(idle, 0, "the hourly idle-lane pass waits for its hour");
  assert.equal(
    f.store.getMeta("lastLaneIdleAt"),
    AT,
    "the hourly stamp is the pass that ran it",
  );
  assert.equal(
    f.migrations.count,
    2,
    "the owner migration is idempotent and runs on every unpaused pass, as before",
  );
});

test("a failed daily retention is recorded, stamps its window, and is not retried on every pass", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.store.purgeOldTasks = (() => {
    attempts++;
    throw new Error("purge blocked");
  }) as unknown as typeof f.store.purgeOldTasks;

  await f.maintenance.run(AT);
  assert.equal(attempts, 1);
  assert.equal(f.store.getMeta("retentionError"), "Error: purge blocked");
  assert.equal(
    f.store.getMeta("lastRetentionAt"),
    AT,
    "a failure still starts the next day's window",
  );

  await f.maintenance.run(AT + HOUR);
  assert.equal(
    attempts,
    1,
    "the next pass waits for the recorded window instead of retrying",
  );
});

test("pausing skips the store chores but never the hourly hook pass", async (t) => {
  const f = fixture(t);
  f.store.setMeta("paused", true);

  await f.maintenance.run(AT);

  assert.equal(f.maintenance.lastHookCleanupAt, AT);
  assert.equal(
    f.store.getMeta("lastRetentionAt"),
    undefined,
    "no purge runs while paused",
  );
  assert.equal(
    f.store.getMeta("lastLaneIdleAt"),
    undefined,
    "no idle-lane pass runs while paused",
  );
  assert.equal(f.migrations.count, 0, "no owner migration runs while paused");
});
