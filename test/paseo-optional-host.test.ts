import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PASEO_DAEMON_URL,
  QueueRuntime,
  resolveOptionalPaseoSourcePath,
} from "../service/runtime-owner";
import { UNBOUND_HOST_REFUSAL } from "../core/host";
import { resolveIngressHost } from "../core/host/ingress-host";
import { hostEnvironment } from "../service/host-environment.mjs";
import { paseoDaemonUrl } from "../hosts/paseo/cli/index.mjs";
import {
  GRANT_APPROVE,
  GRANT_OPERATOR_BOARD,
  applyRoutingGrant,
  readRoutingGrants,
  reconcileRoutingGrants,
} from "../core/dispatch/routing-signoff";
import { formatAgentId } from "../shared/agent-identity";
import { hostIdFromDataDir } from "../shared/host-operation";
import { leadSubmit, submissionSchema, type Task } from "../shared/contracts";
import { hostOutageNoticeId } from "../shared/host-outage";
import type { Adapter } from "../core/host/adapter";

function makeTempDir(
  t: { after(fn: () => void): void },
  prefix: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFakeHostAdapter(
  hostId: string,
  options: {
    originTitle?: string;
    onCreateWorkspace?: () => void;
    onCreateAgent?: () => void;
    onOriginAgent?: (id: string) => void;
  } = {},
): Adapter {
  let workspaceSeq = 0;
  let agentSeq = 0;
  return {
    hostId,
    isConnected: () => true,
    capabilities: () => ({
      reportingViaMcp: false,
      supportsCoordinatorRecovery: true,
    }),
    catalog: async () => ({
      providers: [
        {
          key: "codex",
          label: "Codex",
          available: true,
          problem: "",
          models: [
            {
              id: "gpt-5.4",
              label: "GPT 5.4",
              aliases: [],
              thinkingOptions: [],
              defaultThinkingOptionId: null,
              modes: [],
              features: [],
            },
          ],
        },
      ],
    }),
    profiles: async () => [],
    validate: async () => "a".repeat(40),
    findWorkspaces: async () => [],
    createWorkspace: async (task: Task) => {
      options.onCreateWorkspace?.();
      const directory = join(task.repoPath, ".worktree");
      mkdirSync(directory, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", `ns-${task.id}`], {
        cwd: directory,
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: directory,
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
      writeFileSync(join(directory, "README.md"), "test\n");
      execFileSync("git", ["add", "README.md"], { cwd: directory });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: directory });
      return {
        id: `${hostId}-ws-${++workspaceSeq}`,
        directory,
        branch: `ns-${task.id}`,
      };
    },
    verifyWorkspace: async (task: Task) => `ns-${task.id}`,
    createAgent: async () => {
      options.onCreateAgent?.();
      return {
        id: `${hostId}-agent-${++agentSeq}`,
        workspaceId: `${hostId}-ws-${workspaceSeq}`,
      };
    },
    createRun: async () => {
      options.onCreateAgent?.();
      return {
        id: `${hostId}-agent-${++agentSeq}`,
        workspaceId: `${hostId}-ws-${workspaceSeq}`,
      };
    },
    observe: async (id: string) => ({
      id,
      workspaceId: `${hostId}-ws-${workspaceSeq}`,
      status: "running",
      active: true,
      permissions: false,
      error: "",
    }),
    archiveAgent: async () => {},
    verifyPr: async () => {
      throw new Error("not used");
    },
    originAgent: async (id: string) => {
      options.onOriginAgent?.(id);
      return {
        id,
        workspaceId: "origin-ws",
        title: options.originTitle ?? `${hostId} origin`,
        archived: false,
      };
    },
  } as unknown as Adapter;
}

function seedProfileAndTask(
  runtime: QueueRuntime,
  hostId: string,
  repoPath: string,
) {
  runtime.store.setProfiles([
    {
      id: "codex-default",
      name: "Codex Default",
      provider: "codex",
      model: "gpt-5.4",
      notes: "",
    },
  ]);
  runtime.store.setMeta("pool", [
    {
      profileId: "codex-default",
      enabled: true,
      group: "codex",
      roles: ["worker", "reviewer"],
      capability: "worker",
      weight: "default",
      scopes: ["general", "mechanical", "complex"],
    },
  ]);
  runtime.store.setMeta("paused", false);
  const submission = submissionSchema.parse({
    submissionId: `sub-${hostId}`,
    title: `Task on ${hostId}`,
    repoPath,
    planningCommit: "a".repeat(40),
    handoffPath: "brief.md",
    originAgentId: formatAgentId(hostId, "planner-1"),
  });
  return runtime.store.insert(submission, hostId, "brief.md", "a".repeat(40));
}

test("service starts and serves board and capacity reads with no Paseo install or config present", async (t) => {
  const root = makeTempDir(t, "ns-no-paseo-start-");
  const dataDir = join(root, "data");
  const absentPaseoHome = join(root, "absent-paseo");
  mkdirSync(dataDir, { recursive: true });

  const runtime = new QueueRuntime({
    dataDir,
    hostHome: absentPaseoHome,
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
  });

  await runtime.started;
  await runtime.bootstrap;

  assert.equal(runtime.paseoAdapter, null);
  assert.equal(runtime.startError, "");
  assert.equal(runtime.health().ready, true);
  assert.equal(runtime.health().startError, "");
  assert.equal(
    runtime.capacityAuthorityState().effective.operatorDefaultHostKind,
    null,
  );

  // Board snapshot and UI snapshot work with no Paseo config or adapter.
  const snap = runtime.snapshot();
  assert.equal(snap.paused, true);
  const ui = runtime.uiSnapshot();
  assert.equal(ui.paused, true);

  // Unbound host calls refuse with a clear, host-neutral message instead of falling back to Paseo.
  await assert.rejects(
    () => runtime.engine.adapter.observe("agent-1"),
    (err: unknown) =>
      err instanceof Error && err.message === UNBOUND_HOST_REFUSAL,
  );
  assert.equal(runtime.engine.adapter.originAgent, undefined);
  assert.equal(runtime.engine.adapter.pendingQuestions, undefined);
});

test("unbound calls refuse instead of falling back to Paseo even when Paseo is connected", async (t) => {
  const root = makeTempDir(t, "ns-paseo-no-fallback-");
  let paseoObserved = 0;
  const paseoAdapter = {
    client: { isConnected: true },
    isConnected: () => true,
    hostId: "paseo-primary",
    socketPath: join(root, "callback.sock"),
    helperPath: join(root, "helper.mjs"),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
    observe: async () => {
      paseoObserved++;
      return {
        id: "agent-1",
        workspaceId: null,
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      };
    },
    originAgent: async (id: string) => ({
      id,
      workspaceId: "ws",
      title: "Paseo",
      archived: false,
    }),
  } as unknown as Adapter;

  const runtime = new QueueRuntime({
    dataDir: root,
    adapterFactory: () => paseoAdapter,
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
  });

  await runtime.started;
  await runtime.bootstrap;

  // Outside withHost, calls must refuse rather than silently hitting Paseo.
  await assert.rejects(
    () => runtime.engine.adapter.observe("agent-1"),
    (err: unknown) =>
      err instanceof Error && err.message === UNBOUND_HOST_REFUSAL,
  );
  assert.equal(paseoObserved, 0);
  assert.equal(runtime.engine.adapter.originAgent, undefined);

  // Inside withHost("paseo-primary"), Paseo works unchanged.
  const obs = await runtime.engine.withHost("paseo-primary", () =>
    runtime.engine.adapter.observe("agent-1"),
  );
  assert.equal(obs.id, "agent-1");
  assert.equal(paseoObserved, 1);
});

test("T3-only runtime covers startup, ingress selection, dispatch, and host-bound capability check without Paseo", async (t) => {
  const root = makeTempDir(t, "ns-t3-only-");
  const dataDir = join(root, "data");
  const repoPath = join(root, "repo");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  const t3HostId = "t3code:only-env";
  let workspaceCreated = 0;
  let agentCreated = 0;
  const originReads: string[] = [];
  const t3Adapter = makeFakeHostAdapter(t3HostId, {
    onCreateWorkspace: () => workspaceCreated++,
    onCreateAgent: () => agentCreated++,
    onOriginAgent: (id) => originReads.push(id),
  });

  const runtime = new QueueRuntime({
    dataDir,
    hostHome: join(root, "no-paseo"),
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
  });

  await runtime.started;
  runtime.hostRegistry.connect(t3HostId, "ws://127.0.0.1:3773/ws", {
    adapter: t3Adapter,
    admission: runtime.admission,
  });
  await runtime.ensureBootstrap();

  assert.equal(runtime.paseoAdapter, null);
  assert.equal(runtime.startError, "");
  assert.equal(runtime.health().connected, true);
  assert.equal(runtime.health().hostId, t3HostId);

  // Fresh store has no Paseo default: ingress selects T3 without "Operator default host paseo is offline".
  const selection = runtime.engine.selectIngressSelection(undefined, repoPath);
  assert.deepEqual(selection, {
    hostId: t3HostId,
    basis: "sole_online_host",
  });

  // Capability check that previously checked fallback Paseo adapter (completionSubscription -> adapter.originAgent)
  // now checks the resolved T3 host and succeeds.
  const task = seedProfileAndTask(runtime, t3HostId, repoPath);
  const subscriber = formatAgentId(t3HostId, "watcher-1");
  const subscribed = await runtime.engine.completionSubscription({
    taskId: task.id,
    version: task.version,
    agentId: subscriber,
    action: "subscribe",
  });
  assert.ok(
    subscribed.completionSubscriptionOverrides.some(
      (entry) => entry.agentId === subscriber && entry.subscribed === true,
    ),
  );
  assert.deepEqual(originReads, ["watcher-1"]);

  // Dispatch runs on T3 using T3's refreshed catalog.
  runtime.engine.rebuildProfiles();
  await runtime.engine.wake();
  const after = runtime.store.task(task.id);
  assert.equal(after.hostId, t3HostId);
  assert.equal(
    workspaceCreated,
    1,
    `expected workspace creation, got phase=${after.phase} reason=${after.reason}`,
  );
  assert.equal(
    agentCreated,
    1,
    `expected agent creation, got phase=${after.phase} reason=${after.reason}`,
  );
  assert.equal(after.phase, "working");
});

test("BB-only runtime covers startup, ingress selection, dispatch, and host-bound capability check without Paseo", async (t) => {
  const root = makeTempDir(t, "ns-bb-only-");
  const dataDir = join(root, "data");
  const repoPath = join(root, "repo");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  const bbHostId = "bb:only-bb-host";
  let workspaceCreated = 0;
  let agentCreated = 0;
  const originReads: string[] = [];
  const bbAdapter = makeFakeHostAdapter(bbHostId, {
    onCreateWorkspace: () => workspaceCreated++,
    onCreateAgent: () => agentCreated++,
    onOriginAgent: (id) => originReads.push(id),
  });

  const runtime = new QueueRuntime({
    dataDir,
    hostHome: join(root, "no-paseo"),
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
  });

  await runtime.started;
  runtime.hostRegistry.connect(bbHostId, "bb-executor://only-bb", {
    adapter: bbAdapter,
    admission: runtime.admission,
  });
  await runtime.ensureBootstrap();

  assert.equal(runtime.paseoAdapter, null);
  assert.equal(runtime.startError, "");
  assert.equal(runtime.health().connected, true);
  assert.equal(runtime.health().hostId, bbHostId);

  const selection = runtime.engine.selectIngressSelection(undefined, repoPath);
  assert.deepEqual(selection, {
    hostId: bbHostId,
    basis: "sole_online_host",
  });

  const task = seedProfileAndTask(runtime, bbHostId, repoPath);
  const subscriber = formatAgentId(bbHostId, "bb-watcher-1");
  const subscribed = await runtime.engine.completionSubscription({
    taskId: task.id,
    version: task.version,
    agentId: subscriber,
    action: "subscribe",
  });
  assert.ok(
    subscribed.completionSubscriptionOverrides.some(
      (entry) => entry.agentId === subscriber && entry.subscribed === true,
    ),
  );
  assert.deepEqual(originReads, ["bb-watcher-1"]);

  runtime.engine.rebuildProfiles();
  await runtime.engine.wake();
  const after = runtime.store.task(task.id);
  assert.equal(after.hostId, bbHostId);
  assert.equal(
    workspaceCreated,
    1,
    `expected workspace creation, got phase=${after.phase} reason=${after.reason}`,
  );
  assert.equal(
    agentCreated,
    1,
    `expected agent creation, got phase=${after.phase} reason=${after.reason}`,
  );
  assert.equal(after.phase, "working");
});

test("resolveIngressHost follows repository/operator/planner/online order when operator default is unset", () => {
  // With both T3 and BB online and no operator default, planner host wins.
  const planner = resolveIngressHost({
    operatorDefaultHostKind: null,
    plannerHostId: "bb:host-1",
    registered: ["t3code:env-1", "bb:host-1"],
    online: ["t3code:env-1", "bb:host-1"],
  });
  assert.deepEqual(planner.selection, {
    hostId: "bb:host-1",
    basis: "planner_host",
    reason: "Planner host",
  });

  // With no operator default and no planner host, the first online host is chosen.
  const available = resolveIngressHost({
    operatorDefaultHostKind: null,
    registered: ["t3code:env-1", "bb:host-1"],
    online: ["t3code:env-1", "bb:host-1"],
  });
  assert.equal(available.hostId, "t3code:env-1");
  assert.equal(available.selection.basis, "available_host");

  // With a single online host and no operator default or planner host, sole_online_host is chosen.
  const sole = resolveIngressHost({
    operatorDefaultHostKind: null,
    registered: ["t3code:env-1"],
    online: ["t3code:env-1"],
  });
  assert.deepEqual(sole.selection, {
    hostId: "t3code:env-1",
    basis: "sole_online_host",
  });
});

test("hostEnvironment returns empty object when no Paseo home override or Paseo config exists", (t) => {
  const root = makeTempDir(t, "ns-no-paseo-env-");
  const prevPaseoHome = process.env.PASEO_HOME;
  const prevHome = process.env.HOME;
  delete process.env.PASEO_HOME;
  process.env.HOME = root;
  t.after(() => {
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });
  assert.deepEqual(hostEnvironment(), {});
});

test("resolveOptionalPaseoSourcePath ignores legacy generated daemonUrl on compiled installs while preserving real Paseo setups", () => {
  assert.equal(
    resolveOptionalPaseoSourcePath({
      compiledIdentity: true,
      installedSourcePath: "/opt/nucleus/installed",
    }),
    undefined,
  );
  // Pre-1508 startup and writeT3Connection auto-generated ws://127.0.0.1:6767/ws.
  // Without a Paseo plugin registration, custom URL, or password, upgrades must not activate Paseo.
  assert.equal(
    resolveOptionalPaseoSourcePath({
      compiledIdentity: true,
      daemonUrl: DEFAULT_PASEO_DAEMON_URL,
      installedSourcePath: "/opt/nucleus/installed",
    }),
    undefined,
  );
  assert.equal(
    resolveOptionalPaseoSourcePath({
      compiledIdentity: true,
      daemonUrl: "ws://127.0.0.1:7777/ws",
      installedSourcePath: "/opt/nucleus/installed",
    }),
    "/opt/nucleus/installed",
  );
  assert.equal(
    resolveOptionalPaseoSourcePath({
      compiledIdentity: true,
      daemonUrl: DEFAULT_PASEO_DAEMON_URL,
      password: "synthetic-password",
      installedSourcePath: "/opt/nucleus/installed",
    }),
    "/opt/nucleus/installed",
  );
  assert.equal(
    resolveOptionalPaseoSourcePath({
      compiledIdentity: true,
      registeredPath: "/synthetic/paseo/plugins/nucleus",
      installedSourcePath: "/opt/nucleus/installed",
    }),
    "/opt/nucleus/installed",
  );
  assert.equal(
    resolveOptionalPaseoSourcePath({
      compiledIdentity: false,
      registeredPath: "/synthetic/paseo/plugins/nucleus",
    }),
    "/synthetic/paseo/plugins/nucleus",
  );
});

test("startup with an upgraded T3-only settings file containing the legacy generated daemonUrl does not activate Paseo", async (t) => {
  const root = makeTempDir(t, "ns-upgraded-t3-settings-");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      daemonUrl: DEFAULT_PASEO_DAEMON_URL,
      t3code: {
        endpoint: "http://127.0.0.1:3773",
        bearer: "synthetic-bearer",
      },
    }),
    { mode: 0o600 },
  );

  const runtime = new QueueRuntime({
    dataDir,
    hostHome: join(root, "absent-paseo"),
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
  });

  await runtime.started;
  await runtime.bootstrap;

  assert.equal(runtime.paseoAdapter, null);
  assert.equal(runtime.startError, "");
  assert.equal(runtime.health().ready, true);
});

test("ordinary wake archives standing routing grants for archived planners without Paseo and preserves them on inventory failure", async (t) => {
  const root = makeTempDir(t, "ns-planner-grants-no-paseo-");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });

  const t3HostId = "t3code:grant-env";
  const plannerId = formatAgentId(t3HostId, "planner-archived");
  let failInventory = true;
  let inventoryReads = 0;
  const t3Adapter = {
    ...makeFakeHostAdapter(t3HostId),
    listLiveAgents: async () => {
      inventoryReads++;
      if (failInventory) throw new Error("temporary inventory timeout");
      return [];
    },
  } as unknown as Adapter;

  const runtime = new QueueRuntime({
    dataDir,
    hostHome: join(root, "no-paseo"),
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
  });

  await runtime.started;
  runtime.hostRegistry.connect(t3HostId, "ws://127.0.0.1:3773/ws", {
    adapter: t3Adapter,
    admission: runtime.admission,
  });
  await runtime.ensureBootstrap();
  runtime.store.setMeta("paused", false);

  const grantRepo = join(root, "repo");
  mkdirSync(grantRepo, { recursive: true });
  runtime.store.upsertProject({
    key: "grant-proj",
    name: "Grant Project",
    repositories: [{ origin: null, path: grantRepo }],
  });
  runtime.store.setProjectPlanner({
    key: "grant-proj",
    agentId: plannerId,
    setBy: "operator",
  });
  const asked = applyRoutingGrant(runtime.store, runtime.decisions, {
    action: "request",
    caller: plannerId,
    reason: "frontier review block",
  });
  const decision = runtime.decisions.get({ id: asked.grant.decisionId! });
  runtime.decisions.answer({
    id: decision.id,
    version: decision.version,
    answer: GRANT_APPROVE,
    answeredBy: GRANT_OPERATOR_BOARD,
    relayed: false,
    note: "",
  });
  reconcileRoutingGrants(runtime.store, runtime.decisions);
  assert.equal(
    readRoutingGrants(runtime.store).find((g) => g.id === asked.grant.id)
      ?.status,
    "active",
  );

  // Failed inventory leaves the standing grant active.
  await runtime.engine.wake();
  assert.ok(inventoryReads >= 1, "grant cleanup queried the T3 host inventory");
  assert.equal(
    readRoutingGrants(runtime.store).find((g) => g.id === asked.grant.id)
      ?.status,
    "active",
  );

  // Successful empty inventory archives the grant for the archived planner thread.
  failInventory = false;
  await runtime.engine.wake();
  const archived = readRoutingGrants(runtime.store).find(
    (g) => g.id === asked.grant.id,
  );
  assert.equal(archived?.status, "archived");
});

test("explicit Paseo CLI resolves default daemon URL on fresh settings and preserves configured URLs", () => {
  assert.equal(paseoDaemonUrl({}), DEFAULT_PASEO_DAEMON_URL);
  assert.equal(paseoDaemonUrl(undefined), DEFAULT_PASEO_DAEMON_URL);
  assert.equal(
    paseoDaemonUrl({ daemonUrl: "ws://127.0.0.1:7777/ws" }),
    "ws://127.0.0.1:7777/ws",
  );
});

test("ordinary sweep runs origin reconciliation and planner notice delivery without Paseo", async (t) => {
  const root = makeTempDir(t, "ns-sweep-no-paseo-");
  const dataDir = join(root, "data");
  const repoPath = join(root, "repo");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  const t3HostId = "t3code:sweep-env";
  const plannerThread = formatAgentId(t3HostId, "planner-sweep");
  const originChecks: string[] = [];
  const notifications: Array<{ agentId: string; id: string; text: string }> =
    [];
  const t3Adapter = {
    ...makeFakeHostAdapter(t3HostId, {
      onOriginAgent: (id) => originChecks.push(id),
    }),
    observe: async (id: string) => ({
      id,
      workspaceId: "origin-ws",
      status: "idle" as const,
      active: false,
      permissions: false,
      error: "",
    }),
    notify: async (agentId: string, id: string, text: string) => {
      notifications.push({ agentId, id, text });
    },
    listLiveAgents: async () => [
      {
        id: "planner-sweep",
        cwd: repoPath,
        workspaceId: "origin-ws",
        title: "Sweep Planner",
        status: "idle" as const,
        archived: false,
      },
    ],
  } as unknown as Adapter;

  const runtime = new QueueRuntime({
    dataDir,
    hostHome: join(root, "no-paseo"),
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
  });

  await runtime.started;
  runtime.hostRegistry.connect(t3HostId, "ws://127.0.0.1:3773/ws", {
    adapter: t3Adapter,
    admission: runtime.admission,
  });
  await runtime.ensureBootstrap();
  runtime.store.setMeta("paused", false);

  // Create a project with a live T3 planner and a task whose origin needs reconciliation.
  const project = runtime.store.upsertProject({
    key: "sweep-proj",
    name: "Sweep Project",
    repositories: [{ origin: null, path: repoPath }],
  });
  runtime.store.setProjectPlanner({
    key: project.key,
    agentId: plannerThread,
    setBy: "operator",
  });
  const task = runtime.store.insert(
    submissionSchema.parse({
      submissionId: "sub-sweep-origin",
      title: "Sweep origin reconciliation",
      repoPath,
      planningCommit: "a".repeat(40),
      handoffPath: "brief.md",
      originAgentId: plannerThread,
    }),
    t3HostId,
    "brief.md",
    "a".repeat(40),
  );
  // Seed a pending host-outage notice for a live outage on another host.
  const outageSince = "2026-11-21T20:00:00.000Z";
  runtime.store.setMeta("hostOutages", {
    "bb:down-host": {
      since: outageSince,
      notifiedProjects: {},
    },
  });
  runtime.store.putNotice({
    id: hostOutageNoticeId("bb:down-host", project.key, outageSince),
    taskId: `project:${project.key}`,
    kind: "host_outage",
    agentId: plannerThread,
    recipientAgentId: plannerThread,
    workspaceId: null,
    sources: [],
    originEntry: false,
    text: "Host bb:down-host is offline",
    status: "pending",
    error: "",
  });

  await runtime.engine.wake();

  assert.ok(
    originChecks.includes("planner-sweep"),
    "ordinary sweep ran origin reconciliation on the bound T3 host",
  );
  assert.equal(
    runtime.store.task(task.id).originWorkspaceId,
    "origin-ws",
    "origin reconciliation recorded originWorkspaceId",
  );
  assert.ok(
    notifications.some((n) => n.text.includes("Host bb:down-host is offline")),
    `ordinary sweep delivered host-outage notice to the bound T3 planner; notices=${JSON.stringify(runtime.store.notices(`project:${project.key}`))}`,
  );
});

test("BB submission with unset default selects the BB planner host even when Paseo and T3 are online", async (t) => {
  const root = makeTempDir(t, "ns-bb-submit-no-default-");
  const dataDir = join(root, "data");
  const originPath = join(root, "origin.git");
  const repoPath = join(root, "repo");
  const bbDataDir = join(root, "bb-data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bbDataDir, { recursive: true });
  execFileSync("git", [
    "init",
    "-q",
    "--bare",
    "--initial-branch=main",
    originPath,
  ]);
  execFileSync("git", ["clone", "-q", originPath, repoPath]);
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoPath,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  mkdirSync(join(repoPath, ".paseo"), { recursive: true });
  writeFileSync(
    join(repoPath, ".paseo", "queue.json"),
    JSON.stringify({ schema: "paseo.queue.control.v5", closeout: "queue" }),
  );
  execFileSync("git", ["add", "."], { cwd: repoPath });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoPath });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repoPath });

  const bbHostId = hostIdFromDataDir(bbDataDir);
  const t3HostId = "t3code:peer-env";
  const paseoHostId = "paseo-peer";
  const caller = formatAgentId(bbHostId, "thr_bb_planner");

  const runtime = new QueueRuntime({
    dataDir,
    hostHome: join(root, "no-paseo"),
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
  });

  await runtime.started;
  runtime.hostRegistry.connect(paseoHostId, "ws://127.0.0.1:6767/ws", {
    adapter: makeFakeHostAdapter(paseoHostId),
    admission: runtime.admission,
  });
  runtime.hostRegistry.connect(t3HostId, "ws://127.0.0.1:3773/ws", {
    adapter: makeFakeHostAdapter(t3HostId),
    admission: runtime.admission,
  });
  runtime.bbHostVerified({
    hostId: bbHostId,
    dataDir: bbDataDir,
    bbVersion: "0.49.0",
    sdkVersion: "0.6.132",
    hostIds: ["host_synthetic"],
    connectedAt: new Date().toISOString(),
  });
  await runtime.ensureBootstrap();

  // Operator default is unset on a fresh store.
  assert.equal(
    runtime.capacityAuthorityState().effective.operatorDefaultHostKind,
    null,
  );

  const brief = [
    "---",
    "title: BB submission stays on BB planner host",
    "queue:",
    "  complexity: medium",
    "---",
    "",
    "## Outcome",
    "Verify BB submission selects the BB planner host without falling back to Paseo.",
  ].join("\n");

  const submitted = leadSubmit.output.parse(
    await runtime.submitLead(
      leadSubmit.input.parse({
        repository: { origin: repoPath, path: repoPath },
        title: "BB submission stays on BB planner host",
        body: brief,
        agent: caller,
        hostId: bbHostId,
        note: "submit from BB with unset default",
        identitySource: { agent: caller, hostId: bbHostId },
      }),
    ),
  );
  assert.ok("taskId" in submitted);
  const task = runtime.store.task(submitted.taskId);
  assert.equal(task.originHostId, bbHostId);
  assert.equal(task.hostId, bbHostId);
  assert.deepEqual(task.hostSelection, {
    hostId: bbHostId,
    basis: "planner_host",
    reason: "Planner host",
  });
});

test("workspaceCreationProgress propagates through routed adapter onto registered host adapters", async (t) => {
  const root = makeTempDir(t, "ns-ws-progress-");
  const dataDir = join(root, "data");
  const repoPath = join(root, "repo");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  const paseoHostId = "paseo-progress";
  const observedReasons: string[] = [];
  const rawPaseoAdapter = makeFakeHostAdapter(paseoHostId);
  const origCreateWorkspace =
    rawPaseoAdapter.createWorkspace.bind(rawPaseoAdapter);
  rawPaseoAdapter.createWorkspace = async (task, onProgress) => {
    rawPaseoAdapter.workspaceCreationProgress?.(
      task.id,
      "cloning worktree",
      "started",
    );
    return origCreateWorkspace(task, onProgress);
  };

  const runtime = new QueueRuntime({
    dataDir,
    hostHome: join(root, "no-paseo"),
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
  });

  await runtime.started;
  runtime.hostRegistry.connect(paseoHostId, "ws://127.0.0.1:6767/ws", {
    adapter: rawPaseoAdapter,
    admission: runtime.admission,
  });
  await runtime.ensureBootstrap();

  const task = seedProfileAndTask(runtime, paseoHostId, repoPath);
  const origUpdate = runtime.store.update.bind(runtime.store);
  runtime.store.update = ((
    id: string,
    patch: Partial<Task>,
    ...rest: unknown[]
  ) => {
    if (id === task.id && typeof patch.reason === "string") {
      observedReasons.push(patch.reason);
    }
    return origUpdate(id, patch, ...(rest as [string?, string?]));
  }) as typeof runtime.store.update;

  runtime.engine.rebuildProfiles();
  await runtime.engine.wake();

  assert.ok(
    observedReasons.some((reason) => reason.includes("cloning worktree")),
    `expected workspaceCreationProgress to update task reason, got: ${JSON.stringify(observedReasons)}`,
  );
});
