import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { enginePorts } from "../core/port-context";
import { SweepMaintenance } from "../core/scheduling/sweep-maintenance";
import type { Adapter } from "../core/host";
import { randomUUID } from "node:crypto";
import { submissionSchema } from "../shared/contracts";
import { wireLabels } from "../shared/wire-labels";
import { CapacityChangeJournal } from "../core/dispatch/capacity-changes";

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
        "stopped",
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

// nucleus#1369: the archived-thread pass is detached, so a backlog that never finishes
// (the first pass over ~12k archived threads on a busy host) never holds the audit drain
// that post-bootstrap reconciliation waits on, and a service start stays settled.
test("a 12k-thread retention backlog with a removal that never returns does not hold the maintenance pass", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  const NOON = Date.parse("2026-11-19T12:00:00.000Z");
  const OLD_STAMP = new Date(NOON - 9 * 86_400_000).toISOString();
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Finished task",
      repoPath: "/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "paseo:fixture",
    "handoff",
    "a".repeat(40),
  );
  const task = store.update(submitted.id, { phase: "done" });
  const labels = wireLabels({ task: task.id, role: "worker" });
  const rows = Array.from({ length: 12_000 }, (_, index) => ({
    id: `worker-${index}`,
    workspaceId: null,
    archivedAt: OLD_STAMP,
    labels,
  }));
  let removals = 0;
  const adapter = {
    archivedThreads: async () => rows,
    threadArchiveState: async () => ({ archivedAt: OLD_STAMP, deleted: false }),
    deleteAgent: () => {
      removals++;
      return new Promise<void>(() => {});
    },
  } as unknown as Adapter;
  const maintenance = new SweepMaintenance({
    adapter,
    hostAvailable: () => true,
    hostIds: () => ["paseo:fixture"],
    migrateProjectOwnersToPlanners: async () => {},
    removeSiblings: async () => {},
    stopped: false,
    store,
    withHost: (_hostId: string, work: () => unknown) => work(),
  } as unknown as ConstructorParameters<typeof SweepMaintenance>[0]);

  await maintenance.run(NOON);

  assert.ok(
    maintenance.threadRetentionRun,
    "the backlog is in flight, not awaited",
  );
  assert.equal(removals, 1, "the first removal is the one the pass is held on");
  await maintenance.run(NOON + HOUR);
  assert.equal(
    removals,
    1,
    "one pass at a time: the next hour starts no second walk",
  );
  assert.equal(store.getMeta("threadRetentionError"), undefined);
});

// Spec 069 batch 5 (Tom, 2026-11-22: "Pruning can read archived threads - it needs to
// know what's there, but that shouldn't be running regularly? Once or twice a day?"):
// the archived walk runs on its own Settings interval, 12 hours by default.
test("the archived-thread walk runs once per retention interval, 12 hours by default", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  let walks = 0;
  const adapter = {
    archivedThreads: async () => {
      walks++;
      return [];
    },
    threadArchiveState: async () => null,
    deleteAgent: async () => {},
  } as unknown as Adapter;
  const maintenance = new SweepMaintenance({
    adapter,
    hostAvailable: () => true,
    hostIds: () => ["paseo:fixture"],
    migrateProjectOwnersToPlanners: async () => {},
    removeSiblings: async () => {},
    stopped: false,
    store,
    withHost: (_hostId: string, work: () => unknown) => work(),
  } as unknown as ConstructorParameters<typeof SweepMaintenance>[0]);
  const NOON = Date.parse("2026-11-22T12:00:00.000Z");
  const tick = async (hours: number) => {
    await maintenance.run(NOON + hours * HOUR);
    await maintenance.threadRetentionRun;
  };
  for (let hour = 0; hour < 12; hour++) await tick(hour);
  assert.equal(walks, 1, "one walk in the first 12 hours of hourly ticks");
  await tick(12);
  assert.equal(walks, 2, "the next walk is due 12 hours after the last");
  new CapacityChangeJournal(store).apply({ threadRetentionIntervalHours: 1 });
  await tick(13);
  assert.equal(walks, 3, "a shorter Settings interval brings the next walk forward");
});
