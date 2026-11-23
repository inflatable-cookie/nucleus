import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { PARENT_MODEL, PARENT_PROVIDER } from "../hosts/t3code/nesting";
import { T3CompatibilityError } from "../hosts/t3code/contracts";
import { T3TransientReadError } from "../hosts/t3code/reads";
import { T3RpcError } from "../hosts/t3code/rpc";
import { createAdapter, t3AdapterClass } from "../hosts/t3code";
import type { AcpSessionSurface } from "../shared/acp/surface";
import { HostPolicies } from "../core/host/host-policies";
import {
  HostReadRefusalError,
  type Adapter,
  type HostPolicyConstructor,
} from "../core/host";
const Policy = HostPolicies as unknown as HostPolicyConstructor;
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { WIRE_LABEL_KEYS } from "../shared/wire-labels";
import type { HostAgentSpec } from "../shared/host";
import { runSchema, type Profile, type Task } from "../shared/contracts";
import { t3Fake } from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";
import { submission } from "./support/fakes";

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

async function makeFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "t3code-churn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const acp: AcpSessionSurface = {
    bind: (input) => ({
      sessionId: `session:${input.taskId}`,
      taskId: input.taskId,
      bindingPath: `/synthetic/acp/${input.taskId}.json`,
    }),
    async turn() {
      throw new Error("the agent is not driven in this test");
    },
    async message() {
      throw new Error("the agent is not driven in this test");
    },
    release() {},
  };
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp,
    reentryTimeoutMs: 300,
  });
  t.after(() => host.close());
  await host.connect();
  const served = (await host.rpc.call("server.getConfig", {})) as {
    providers: Array<Record<string, unknown>>;
  };
  server.controls.providers = [
    ...served.providers,
    {
      instanceId: PARENT_PROVIDER,
      displayName: "Nucleus",
      driver: "acpRegistry",
      enabled: true,
      status: "ready",
      models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
    },
  ];
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory,
    project: { projectId: "synthetic-project" },
  });
  const spec = (requestId: string, role = "worker"): HostAgentSpec => ({
    workspaceId: workspace.id,
    profile,
    title: `${role}: Synthetic role`,
    taskNumber: 225,
    mcpBindingPath: null,
    attempt: () => ({
      requestId,
      prompt: "Synthetic prompt",
      labels: storedT3Labels(role, { runId: `${role}-run` }),
      environment: {},
    }),
  });
  return { root, directory, server, host, workspace, spec };
}

test("routine live observation, catalog, workspace-project, and live pass reads bypass archive snapshot churn", async (t) => {
  const { directory, server, host, workspace, spec } = await makeFixture(t);
  const live = await host.createAgent(spec("launch-live", "worker"));
  const retired = await host.createAgent(spec("launch-retired", "reviewer"));
  await host.archiveAgent(retired.id);

  // Simulate continuous background activity moving global snapshotSequence on archive reads.
  server.controls.beforeArchiveRead = () => {
    server.controls.snapshotSequence++;
  };

  const archiveBefore = server.requests.filter(
    (r) => r.tag === "orchestration.getArchivedShellSnapshot",
  ).length;
  const liveTask = { id: "synthetic-task", phase: "working" } as Task;

  await host.beginHostPass([liveTask]);
  assert.ok(host.state.read().retiredAgents?.[retired.id]);
  assert.equal((await host.observe(live.id)).id, live.id);
  assert.ok((await host.listLiveAgents()).some((a) => a.id === live.id));
  assert.ok((await host.activeThreads()).some((a) => a.id === live.id));
  const found = await host.findAgents({
    [WIRE_LABEL_KEYS.task]: liveTask.id,
    [WIRE_LABEL_KEYS.run]: "worker-run",
  });
  assert.deepEqual(
    found.map((a) => a.id),
    [live.id],
  );
  assert.equal((await host.originAgent(live.id))?.id, live.id);
  assert.equal(
    (await host.repositoryProject(directory)).projectId,
    "synthetic-project",
  );
  assert.equal(await host.workspaceAvailable(workspace.id), true);
  assert.equal(await host.workspaceArchived(workspace.id), false);
  const adapterWithPolicies = new (t3AdapterClass(Policy))(host);
  const liveOnlyPage =
    await adapterWithPolicies.workspaceHost.archiveThreadPage({
      filter: { includeArchived: false },
      page: { limit: 50 },
    });
  assert.ok(liveOnlyPage.entries.some((entry) => entry.agent.id === live.id));
  assert.equal(await host.reads.activeRunId(live.id), "run:launch-live");
  assert.deepEqual(await host.reads.activeRunIds(live.id), ["run:launch-live"]);
  assert.ok((await host.catalog()).providers.length > 0);
  await host.endHostPass();

  const archiveAfter = server.requests.filter(
    (r) => r.tag === "orchestration.getArchivedShellSnapshot",
  ).length;
  assert.equal(
    archiveAfter - archiveBefore,
    0,
    "live observation, project lookups, retired-thread reconciliation, and catalog read zero archive snapshots",
  );
  assert.equal(host.connected, true);
});

test("retired-thread reads use exact ids, never the archived inventory, and a wire shape fault stays fenced (Spec 069 batch 5)", async (t) => {
  const { server, host, workspace, spec } = await makeFixture(t);
  const created = await host.createAgent(spec("launch-live", "worker"));
  await host.archiveAgent(created.id);
  const archivedReads = () =>
    server.requests.filter(
      (request) => request.tag === "orchestration.getArchivedShellSnapshot",
    ).length;
  const before = archivedReads();
  assert.equal(
    (await host.reads.threadArchiveState(created.id))?.archivedAt !== null,
    true,
    "the archive fact is the thread's own exact read",
  );
  assert.equal(await host.originAgent("absent-thread"), null);
  const inventory = await host.workspaceThreads([workspace.id]);
  assert.equal(inventory.ok, true);
  const page = await new (t3AdapterClass(Policy))(
    host,
  ).workspaceHost.archiveThreadPage({
    filter: { includeArchived: true },
    page: { limit: 50 },
  });
  assert.ok(page.entries.some((entry) => entry.agent.id === created.id));
  assert.equal(archivedReads(), before, "no archived snapshot was read");

  // Connection invariants remain intact, and real wire shape errors stay fenced.
  assert.equal(host.connected, true);
  assert.equal(host.reads.compatibilityFailure, "");
  server.controls.shellMissingField = "activeRunId";
  host.reads.live.close();
  await assert.rejects(
    host.activeThreads(),
    (error: unknown) =>
      error instanceof T3CompatibilityError &&
      /activeRunId/.test(error.message),
  );
});

test("a transient T3 read refusal does not take T3 offline or drop model eligibility while independent work progresses", async (t) => {
  const { host, server, workspace, spec } = await makeFixture(t);
  const healthyT3Agent = await host.createAgent(
    spec("launch-healthy", "worker"),
  );
  const churnedT3Agent = await host.createAgent(
    spec("launch-churned", "reviewer"),
  );
  // A transient read refusal on churnedT3Agent's read while healthyT3Agent succeeds
  // cleanly via the live shell and its projection.
  server.threads.get(churnedT3Agent.id)!.thread.archivedAt =
    "2026-11-20T00:00:00.000Z";
  // Real nightly subscribeShell puts archived threads in getArchivedShellSnapshot only:
  server.controls.beforeArchiveRead = () => {
    server.controls.snapshotSequence++;
  };

  const store = new Store(":memory:");
  const PASEO_HOST = "paseo:primary";
  const processed: string[] = [];
  const t3Adapter = createAdapter(Policy, host);
  const baseObserve = t3Adapter.observe.bind(t3Adapter);
  t3Adapter.observe = async (id: string) => {
    if (id === churnedT3Agent.id) throw new T3TransientReadError(new Error("T3 read kept moving"));
    return baseObserve(id);
  };
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
  engine.hostAvailable = () => true;
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

  const healthyT3Task = insertWorking(
    host.hostId,
    "Healthy T3",
    healthyT3Agent.id,
    workspace.id,
  );
  const churnedT3Task = insertWorking(
    host.hostId,
    "Churned T3",
    churnedT3Agent.id,
    workspace.id,
  );
  const paseoTask = insertWorking(
    PASEO_HOST,
    "Paseo task",
    "paseo-agent-1",
    "paseo-ws",
  );

  engine.scheduleTaskQuantum = async (taskId) => {
    processed.push(`quantum:${taskId}`);
  };

  const result = await engine.auditPass(true);
  assert.equal(result.fault, null);
  assert.equal(engine.hostAvailable(host.hostId), true);
  assert.equal(engine.hostOutages.current(host.hostId), null);
  assert.equal(host.connected, true);

  // No task has host_transport_fault or needs_attention; churned task records bounded wait.
  const churnedNow = store.task(churnedT3Task.id);
  assert.equal(churnedNow.phase, "working");
  assert.equal(churnedNow.resolution.stop?.reason, "external_unavailable");
  assert.match(
    churnedNow.resolution.stop?.detail ?? "",
    /T3 read kept moving/,
  );
  for (const task of [healthyT3Task, churnedT3Task, paseoTask]) {
    assert.equal(
      store.eventsAll(task.id).some((e) => e.kind === "host_transport_fault"),
      false,
      `${task.title} has no host_transport_fault`,
    );
  }
  assert.ok(processed.includes(`paseo-observe:${paseoTask.agentId}`));
  assert.ok(processed.includes(`quantum:${healthyT3Task.id}`));
  assert.ok(processed.includes(`quantum:${paseoTask.id}`));

  // Note: a queued task hitting a transient read refusal via noteStepFailure waits boundedly too.
  const queuedT3 = store.insert(
    submission({ title: "Queued T3", repoPath: "/synthetic/queued-t3" }),
    host.hostId,
    "handoff.md",
    "b".repeat(40),
  );
  engine.noteStepFailure(queuedT3.id, new T3TransientReadError(new Error("T3 read kept moving")));
  const queuedNow = store.task(queuedT3.id);
  assert.equal(queuedNow.phase, "queued");
  assert.equal(queuedNow.resolution.stop?.reason, "external_unavailable");
  assert.equal(engine.hostOutages.current(host.hostId), null);

  // A real transport fault through the routed adapter on a connected host fails only
  // its own call (Spec 069 §2): the host stays up (one call is not the host) and no
  // task on it is written. Only a lost connection opens an outage.
  t3Adapter.observe = async () => {
    throw new T3RpcError("transport", "socket closed");
  };
  await engine.auditPass(true);
  assert.equal(engine.hostHealth.read(host.hostId).state, "up");
  assert.equal(engine.hostOutages.current(host.hostId), null);
  assert.equal(
    store
      .eventsAll(healthyT3Task.id)
      .some((e) => e.kind === "host_transport_fault"),
    false,
  );
});
