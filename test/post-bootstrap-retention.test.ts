import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import { submissionSchema } from "../shared/contracts";
import { wireLabels } from "../shared/wire-labels";
import {
  RuntimeLifecycle,
  type RuntimeLifecycleOwner,
} from "../service/runtime-lifecycle";

/**
 * nucleus#1369: a service start with a large archived-thread backlog and a host whose
 * removal never returns must still settle its post-bootstrap reconciliation inside its
 * window, with `startError` empty. The real `Engine` runs the audit drain that the
 * reconciliation waits on, the real `RuntimeLifecycle` runs the bootstrap, and the
 * backlog is 12k eligible archived threads of a finished task.
 */
const HOST = "paseo:fixture";
const DAY = 86_400_000;
const BACKLOG = 12_000;

function serviceStart(t: TestContext) {
  const store = new Store(":memory:");
  store.setMeta("paused", false);
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Finished task",
      repoPath: "/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    HOST,
    "handoff",
    "a".repeat(40),
  );
  const task = store.update(submitted.id, { phase: "done" });
  const archivedAt = new Date(Date.now() - 9 * DAY).toISOString();
  const labels = wireLabels({ task: task.id, role: "worker" });
  const rows = Array.from({ length: BACKLOG }, (_, index) => ({
    id: `worker-${index}`,
    workspaceId: null,
    archivedAt,
    labels,
  }));
  const calls = { walks: 0, removals: 0 };
  const adapter = {
    connect: async () => undefined,
    archivedThreads: async () => {
      calls.walks++;
      return rows;
    },
    threadArchiveState: async () => ({ archivedAt, deleted: false }),
    // The first removal never returns: a busy host that stalls one call.
    deleteAgent: () => {
      calls.removals++;
      return new Promise<void>(() => {});
    },
  } as unknown as Adapter;

  const engine = new Engine(store, adapter, 60_000);
  // The catalog refresh and the bulk and operation resumes need a live host profile
  // catalog; the reconciliation under test is the wake and the audit drain it waits on.
  engine.refresh = async () => undefined;
  engine.resumeBulkDispositions = () => undefined;
  engine.resumeOperations = () => undefined;
  engine.resolveHostAdapter = () => adapter;
  engine.hostIds = () => [HOST];
  (
    engine as unknown as Record<string, unknown>
  ).migrateProjectOwnersToPlanners = async () => undefined;
  (engine as unknown as Record<string, unknown>).removeSiblings = async () =>
    undefined;
  t.after(async () => {
    await engine.stop();
    store.close();
  });

  const owner = {
    store,
    engine,
    adapter,
    admission: {},
    hostRegistry: {
      known: () => [],
      get: () => undefined,
      primary: () => undefined,
      onlineIds: () => [],
    },
    plannerTickets: { ensure: async () => undefined },
    t3Host: () => null,
    refreshT3Settings: () => undefined,
    daemonUrl: "ws://127.0.0.1:0/ws",
    connectTimeoutMs: 5_000,
    paseoHostId: HOST,
    hostSession: { id: HOST, token: "synthetic-token" },
    idleShutdownLatched: false,
    connected: () => true,
    readPrStates: async () => ({}),
  } as unknown as RuntimeLifecycleOwner;
  return { lifecycle: new RuntimeLifecycle(owner), engine, calls };
}

test("a service start with a 12k archived backlog and a stalled removal settles its reconciliation with startError empty (#1369)", async (t) => {
  const { lifecycle, calls } = serviceStart(t);

  const started = Date.now();
  const bootstrapped = await lifecycle.ensureBootstrap();
  const elapsed = Date.now() - started;

  assert.equal(
    bootstrapped,
    true,
    `the bootstrap completed: ${lifecycle.startError}`,
  );
  assert.equal(lifecycle.startError, "", "no startError on the service start");
  assert.ok(
    elapsed < 30_000,
    `reconciliation settled inside its window (${elapsed} ms)`,
  );
  assert.equal(calls.walks, 1, "the backlog walk ran");
  assert.equal(
    calls.removals,
    1,
    "the stalled removal is held in the background",
  );
});
