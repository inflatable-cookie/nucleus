import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { T3CompatibilityError } from "../hosts/t3code/contracts";
import { createAdapter } from "../hosts/t3code";
import { HostPolicies } from "../core/host/host-policies";
import type { Adapter, HostPolicyConstructor } from "../core/host";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { runSchema, type Profile, type Task } from "../shared/contracts";
import { WIRE_LABEL_KEYS } from "../shared/wire-labels";
import { STAMP, t3Fake, threadProjection } from "./support/t3code-fake";
import {
  storedHostState,
  taskFact,
  type StoredThread,
} from "./support/t3code-state";
import { submission } from "./support/fakes";

const Policy = HostPolicies as unknown as HostPolicyConstructor;

const profile: Profile = {
  id: "synthetic-profile",
  name: "Synthetic",
  provider: "synthetic-provider",
  model: "synthetic-model",
  available: true,
  problem: "",
  notes: "",
  supportedThinking: [],
};

async function emptyStartupFixture(
  t: TestContext,
  input: {
    threads?: readonly StoredThread[];
    hostId?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "t3code-empty-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.threads.clear();
  const statePath = join(root, "state.json");
  if (input.threads?.length) {
    writeFileSync(
      statePath,
      JSON.stringify(
        storedHostState({
          directory,
          hostId: input.hostId,
          threads: input.threads,
        }),
      ),
      { mode: 0o600 },
    );
  }
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath,
    timeoutMs: 1_000,
  });
  t.after(() => host.close());
  await host.connect();
  assert.equal(host.connected, true);
  assert.equal(host.threadShapePending, true);
  assert.equal(server.snapshots.length, 0);

  const snapshotsFor = (id: string, from = 0) =>
    server.snapshots.slice(from).filter((snapshot) => snapshot.threadId === id)
      .length;
  const archiveRequests = () =>
    server.requests.filter(
      (request) => request.tag === "orchestration.getArchivedShellSnapshot",
    ).length;

  return { root, directory, server, host, snapshotsFor, archiveRequests };
}

test("empty startup probes the first eligible live row once inside a host pass and skips archived, deleted and terminal rows", async (t) => {
  const archivedId = "nucleus-thread-synthetic-archived";
  const deletedId = "nucleus-thread-synthetic-deleted";
  const terminalId = "nucleus-thread-synthetic-terminal";
  const liveId = "nucleus-thread-synthetic-live";
  const { directory, server, host, snapshotsFor, archiveRequests } =
    await emptyStartupFixture(t, {
      threads: [
        { id: archivedId, taskId: "task-archived", runId: "run-archived" },
        { id: terminalId, taskId: "task-done", runId: "run-done" },
        { id: liveId, taskId: "task-live", runId: "run-live" },
      ],
    });

  server.controls.shellTombstones = true;
  const archivedProjection = threadProjection(archivedId, directory);
  archivedProjection.thread.archivedAt = STAMP;
  server.threads.set(archivedId, archivedProjection);

  const deletedProjection = threadProjection(deletedId, directory);
  deletedProjection.thread.deletedAt = STAMP;
  server.threads.set(deletedId, deletedProjection);

  const terminalProjection = threadProjection(terminalId, directory);
  server.threads.set(terminalId, terminalProjection);

  const liveProjection = threadProjection(liveId, directory);
  server.threads.set(liveId, liveProjection);

  const tasks = [
    taskFact("task-archived", "working"),
    taskFact("task-done", "done"),
    taskFact("task-live", "working"),
  ] as Task[];

  const archiveBefore = archiveRequests();
  await host.beginHostPass(tasks);

  assert.equal(host.threadShapePending, false);
  assert.equal(host.connected, true);
  assert.equal(host.compatibilityFailure, "");
  assert.equal(snapshotsFor(archivedId), 0, "archived row is not probed");
  assert.equal(snapshotsFor(deletedId), 0, "deleted row is not probed");
  assert.equal(snapshotsFor(terminalId), 0, "terminal task row is not probed");
  assert.equal(
    snapshotsFor(liveId),
    1,
    "first eligible live row is probed once",
  );
  assert.equal(
    archiveRequests() - archiveBefore,
    0,
    "pending probe does not re-enter archived inventory",
  );

  // Subsequent shell and task observation entry points in the same pass reuse
  // the pass's single-flight snapshot instead of probing or snapshotting again.
  const active = await host.activeThreads();
  assert.deepEqual(
    active.map((thread) => thread.id),
    [terminalId, liveId],
  );
  const listed = await host.listLiveAgents();
  assert.ok(listed.some((agent) => agent.id === liveId));
  const found = await host.findAgents({
    [WIRE_LABEL_KEYS.task]: "task-live",
  });
  assert.deepEqual(
    found.map((agent) => agent.id),
    [liveId],
  );
  assert.equal((await host.observe(liveId)).id, liveId);
  const inventory = await host.observationInventory([liveId]);
  assert.equal(inventory?.get(liveId)?.id, liveId);
  assert.equal((await host.originAgent(liveId))?.id, liveId);
  assert.equal(await host.reads.activeRunId(liveId), null);
  assert.deepEqual(await host.reads.activeRunIds(liveId), []);
  await host.endHostPass();

  assert.equal(
    snapshotsFor(liveId),
    1,
    "all shell and observation calls share the one probe snapshot",
  );
  assert.equal(server.snapshots.length, 1);
  assert.equal(
    archiveRequests() - archiveBefore,
    0,
    "live observation stays out of archived inventory",
  );
});

test("empty startup with only archived, deleted or terminal rows leaves shape pending until a live row arrives", async (t) => {
  const archivedId = "nucleus-thread-synthetic-only-archived";
  const terminalId = "nucleus-thread-synthetic-only-terminal";
  const liveId = "nucleus-thread-synthetic-arrived-live";
  const { directory, server, host, snapshotsFor } = await emptyStartupFixture(
    t,
    {
      threads: [
        { id: terminalId, taskId: "task-done", runId: "run-done" },
        { id: liveId, taskId: "task-live", runId: "run-live" },
      ],
    },
  );

  const archivedProjection = threadProjection(archivedId, directory);
  archivedProjection.thread.archivedAt = STAMP;
  server.threads.set(archivedId, archivedProjection);
  server.threads.set(terminalId, threadProjection(terminalId, directory));

  await host.beginHostPass([
    taskFact("task-done", "done") as Task,
    taskFact("task-live", "working") as Task,
  ]);
  const retired = host.state.read().retiredAgents?.[terminalId];
  assert.ok(retired, "terminal thread moved to retiredAgents");
  assert.deepEqual(await host.activeThreads(), [
    {
      id: terminalId,
      workspaceId: retired.workspaceId,
      labels: retired.labels,
      status: "idle",
      archived: false,
      activeTurn: false,
      pendingPermissionKinds: [],
    },
  ]);
  await host.listLiveAgents();
  await host.reads.shell();
  await host.endHostPass();

  assert.equal(server.snapshots.length, 0);
  assert.equal(host.threadShapePending, true);
  assert.equal(host.connected, true);

  server.threads.set(liveId, threadProjection(liveId, directory));
  await host.beginHostPass([
    taskFact("task-done", "done") as Task,
    taskFact("task-live", "working") as Task,
  ]);
  assert.equal((await host.observe(liveId)).id, liveId);
  await host.endHostPass();

  assert.equal(host.threadShapePending, false);
  assert.equal(snapshotsFor(liveId), 1);
  assert.equal(server.snapshots.length, 1);
});

test("malformed first projection on shell or task observation inside a pass fails strictly and takes T3 offline without stalling other hosts", async (t) => {
  // 1. Tracked thread hits malformed projection inside beginHostPass.
  const trackedId = "nucleus-thread-synthetic-tracked";
  {
    const { directory, server, host } = await emptyStartupFixture(t, {
      threads: [{ id: trackedId, taskId: "task-bad", runId: "run-bad" }],
    });
    server.threads.set(trackedId, threadProjection(trackedId, directory));
    server.controls.threadCoverage = { hasMoreHistory: "true" };

    await assert.rejects(
      host.beginHostPass([taskFact("task-bad", "working") as Task]),
      (error: unknown) =>
        error instanceof T3CompatibilityError &&
        /subscribeThread\.hasMoreHistory/.test(error.message),
    );
    assert.equal(host.connected, false);
    assert.match(host.compatibilityFailure, /subscribeThread\.hasMoreHistory/);
    assert.equal(server.snapshots.length, 1);
  }

  // 2. Empty host state at beginHostPass, then normal shell/observation entry points
  // encounter a malformed first projection.
  for (const probeEntry of [
    "activeThreads",
    "listLiveAgents",
    "observe",
    "originAgent",
    "inventory",
  ] as const) {
    const { directory, server, host } = await emptyStartupFixture(t);
    const liveId = `nucleus-thread-synthetic-${probeEntry}`;
    server.threads.set(liveId, threadProjection(liveId, directory));
    server.controls.threadCoverage = { hasMoreHistory: "true" };

    await host.beginHostPass([taskFact("task-live", "working") as Task]);
    await assert.rejects(
      probeEntry === "activeThreads"
        ? host.activeThreads()
        : probeEntry === "listLiveAgents"
          ? host.listLiveAgents()
          : probeEntry === "observe"
            ? host.observe(liveId)
            : probeEntry === "originAgent"
              ? host.originAgent(liveId)
              : host.reads.shell(),
      (error: unknown) =>
        error instanceof T3CompatibilityError &&
        /subscribeThread\.hasMoreHistory/.test(error.message),
      `${probeEntry} surfaces compatibility failure`,
    );
    assert.equal(host.connected, false);
    assert.match(host.compatibilityFailure, /subscribeThread\.hasMoreHistory/);
    assert.equal(server.snapshots.length, 1);
    host.endHostPass();
  }

  // 3. Multi-host Engine sweep: malformed T3 first projection takes T3 offline
  // while independent work on Paseo still progresses.
  const { directory, server, host } = await emptyStartupFixture(t);
  const badId = "nucleus-thread-synthetic-engine-bad";
  server.threads.set(badId, threadProjection(badId, directory));
  server.controls.threadCoverage = { hasMoreHistory: "true" };

  const store = new Store(":memory:");
  const PASEO_HOST = "paseo:primary";
  const processed: string[] = [];
  const t3Adapter = createAdapter(Policy, host);
  const paseoAdapter = {
    hostId: PASEO_HOST,
    connected: true,
    capabilities: () => ({
      reportingViaMcp: false,
      nativeWorktrees: true,
      nativeSubagents: false,
    }),
    observe: async (id: string) => {
      processed.push(`paseo-observe:${id}`);
      return {
        id,
        workspaceId: "paseo-ws",
        status: "running",
        active: true,
        permissions: false,
        error: "",
      };
    },
    archivedThreads: async () => [],
    activeThreads: async () => [],
    listLiveAgents: async () => [],
    catalog: async () => ({ providers: [] }),
  } as unknown as Adapter;

  const adapters: Record<string, Adapter> = {
    [host.hostId]: t3Adapter,
    [PASEO_HOST]: paseoAdapter,
  };
  const engine = new Engine(store, t3Adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 0);
  engine.hostIds = () => [host.hostId, PASEO_HOST];
  engine.hostAvailable = (id: string) =>
    id === host.hostId ? host.connected : true;
  engine.resolveHostAdapter = (id: string) => adapters[id];
  engine.lastHookCleanupAt = Date.now();
  engine.migrateProjectOwnersToPlanners = async () => {};
  engine.clearRetiredInvalidations = () => {};
  engine.resumePausedStops = async () => {};
  engine.recoverExhaustedWorkers = async () => {};
  engine.archiveRetiredErroredAgents = async () => {};
  engine.applyDeferredOwnerVerbs = async () => {};
  engine.deliverPendingBriefAmendments = async () => {};
  engine.continueAwaitingReviewers = async () => {};
  engine.lifecycle.enqueuePass = async () => {};
  engine.resolution.origins.pass = async () => {};
  engine.dispatchQueued = async () => {};

  const insertWorking = (
    hostId: string,
    title: string,
    agentId: string,
    wsId: string,
  ) => {
    const inserted = store.insert(
      submission({
        title,
        repoPath: `/synthetic/${title.replace(/\W+/g, "-")}`,
      }),
      hostId,
      "handoff.md",
      "b".repeat(40),
    );
    const task = store.update(
      inserted.id,
      { phase: "working", agentId, workspaceId: wsId, runId: `run-${agentId}` },
      "dispatched",
    );
    store.putRun(
      runSchema.parse({
        id: `run-${agentId}`,
        taskId: task.id,
        role: "executor",
        generation: 1,
        head: "a".repeat(40),
        base: "b".repeat(40),
        profile,
        agentId,
        hostId,
        workspaceId: wsId,
        status: "running",
        createdAt: new Date().toISOString(),
        lastObservedAt: null,
        active: true,
        idleSince: null,
        completion: null,
        released: false,
      }),
    );
    return task;
  };

  const t3Task = insertWorking(host.hostId, "T3 Task", badId, "t3-ws");
  const paseoTask = insertWorking(
    PASEO_HOST,
    "Paseo Task",
    "paseo-agent-1",
    "paseo-ws",
  );
  host.state.update((state) => {
    state.workspaces["t3-ws"] = {
      id: "t3-ws",
      directory,
      projectId: "synthetic-project",
      title: "T3 Task",
    };
    state.agents[badId] = {
      id: badId,
      workspaceId: "t3-ws",
      labels: {
        [WIRE_LABEL_KEYS.task]: t3Task.id,
        [WIRE_LABEL_KEYS.run]: `run-${badId}`,
      },
    };
  });

  engine.scheduleTaskQuantum = async (taskId) => {
    processed.push(`quantum:${taskId}`);
  };

  const result = await engine.auditPass(true);
  assert.equal(result.fault, null);
  assert.equal(host.connected, false);
  assert.match(host.compatibilityFailure, /subscribeThread\.hasMoreHistory/);
  assert.match(
    store.getMeta<string>("hostPassError") ?? "",
    /beginHostPass.*subscribeThread\.hasMoreHistory/,
  );
  assert.equal(server.snapshots.length, 1);
  assert.ok(processed.includes(`paseo-observe:${paseoTask.agentId}`));
  assert.ok(processed.includes(`quantum:${paseoTask.id}`));
  assert.equal(processed.includes(`quantum:${t3Task.id}`), false);
});

test("concurrent shell and observation callers coalesce onto one bounded probe in and out of a host pass", async (t) => {
  // 1. Inside a host pass, concurrent callers share one probe and one observation snapshot.
  {
    const liveId = "nucleus-thread-synthetic-concurrent-pass";
    const { directory, server, host, snapshotsFor } = await emptyStartupFixture(
      t,
      {
        threads: [{ id: liveId, taskId: "task-live", runId: "run-live" }],
      },
    );
    server.threads.set(liveId, threadProjection(liveId, directory));
    server.controls.slowSnapshotMs = 40;

    // Open pass with empty state check first? No: start pass without tracked agent,
    // or call concurrent readers directly inside the pass.
    host.reads.beginPass([taskFact("task-live", "working") as Task]);
    const [active, live, found, observed, inventory, origin, fullInventory] =
      await Promise.all([
        host.activeThreads(),
        host.listLiveAgents(),
        host.findAgents({ [WIRE_LABEL_KEYS.task]: "task-live" }),
        host.observe(liveId),
        host.observationInventory([liveId]),
        host.originAgent(liveId),
        host.reads.shell(),
      ]);
    server.controls.slowSnapshotMs = 0;
    host.endHostPass();

    assert.deepEqual(
      active.map((thread) => thread.id),
      [liveId],
    );
    assert.deepEqual(
      live.map((agent) => agent.id),
      [liveId],
    );
    assert.deepEqual(
      found.map((agent) => agent.id),
      [liveId],
    );
    assert.equal(observed.id, liveId);
    assert.equal(inventory?.get(liveId)?.id, liveId);
    assert.equal(origin?.id, liveId);
    assert.equal(fullInventory.threads[0]?.id, liveId);
    assert.equal(host.threadShapePending, false);
    assert.equal(
      snapshotsFor(liveId),
      1,
      "all concurrent callers share one subscribeThread probe",
    );
  }

  // 2. Outside a host pass, concurrent shell/inventory callers still send one probe.
  {
    const liveId = "nucleus-thread-synthetic-concurrent-outside";
    const { directory, server, host, snapshotsFor } =
      await emptyStartupFixture(t);
    server.threads.set(liveId, threadProjection(liveId, directory));
    server.controls.slowSnapshotMs = 40;

    const [active, live, fullInventory] = await Promise.all([
      host.activeThreads(),
      host.listLiveAgents(),
      host.reads.shell(),
    ]);
    server.controls.slowSnapshotMs = 0;

    assert.equal(active[0]?.id, liveId);
    assert.equal(live[0]?.id, liveId);
    assert.equal(fullInventory.threads[0]?.id, liveId);
    assert.equal(host.threadShapePending, false);
    assert.equal(snapshotsFor(liveId), 1);
  }

  // 3. Concurrent callers hitting a malformed first projection all reject with one probe.
  {
    const liveId = "nucleus-thread-synthetic-concurrent-bad";
    const { directory, server, host } = await emptyStartupFixture(t);
    server.threads.set(liveId, threadProjection(liveId, directory));
    server.controls.slowSnapshotMs = 40;
    server.controls.threadCoverage = { hasMoreHistory: "true" };

    await host.beginHostPass([taskFact("task-live", "working") as Task]);
    const settled = await Promise.allSettled([
      host.activeThreads(),
      host.listLiveAgents(),
      host.observe(liveId),
      host.reads.shell(),
    ]);
    server.controls.slowSnapshotMs = 0;
    host.endHostPass();

    for (const outcome of settled) {
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") {
        assert.ok(outcome.reason instanceof T3CompatibilityError);
        assert.match(outcome.reason.message, /subscribeThread\.hasMoreHistory/);
      }
    }
    assert.equal(host.connected, false);
    assert.match(host.compatibilityFailure, /subscribeThread\.hasMoreHistory/);
    assert.equal(server.snapshots.length, 1);
  }

  // 4. Transient probe projection fault keeps shape pending for the next read
  // without failing unrelated shell callers.
  {
    const liveId = "nucleus-thread-synthetic-transient-probe";
    const { directory, server, host, snapshotsFor } =
      await emptyStartupFixture(t);
    server.threads.set(liveId, threadProjection(liveId, directory));
    server.controls.threadProjectionErrors = 1;

    await host.beginHostPass([taskFact("task-live", "working") as Task]);
    const active = await host.activeThreads();
    await host.endHostPass();

    assert.deepEqual(
      active.map((thread) => thread.id),
      [liveId],
    );
    assert.equal(host.connected, true);
    assert.equal(host.threadShapePending, true);
    assert.equal(host.compatibilityFailure, "");

    await host.beginHostPass([taskFact("task-live", "working") as Task]);
    await host.activeThreads();
    await host.endHostPass();
    assert.equal(host.threadShapePending, false);
    assert.equal(snapshotsFor(liveId), 1);
  }
});
