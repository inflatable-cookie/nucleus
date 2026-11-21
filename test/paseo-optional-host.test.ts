import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueRuntime } from "../service/runtime-owner";
import { UNBOUND_HOST_REFUSAL } from "../core/host";
import { resolveIngressHost } from "../core/host/ingress-host";
import { hostEnvironment } from "../service/host-environment.mjs";
import { formatAgentId } from "../shared/agent-identity";
import { submissionSchema, type Task } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";

function makeTempDir(t: { after(fn: () => void): void }, prefix: string): string {
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
  assert.equal(runtime.capacityAuthorityState().effective.operatorDefaultHostKind, null);

  // Board snapshot and UI snapshot work with no Paseo config or adapter.
  const snap = runtime.snapshot();
  assert.equal(snap.paused, true);
  const ui = runtime.uiSnapshot();
  assert.equal(ui.paused, true);

  // Unbound host calls refuse with a clear, host-neutral message instead of falling back to Paseo.
  await assert.rejects(
    () => runtime.engine.adapter.observe("agent-1"),
    (err: unknown) => err instanceof Error && err.message === UNBOUND_HOST_REFUSAL,
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
    (err: unknown) => err instanceof Error && err.message === UNBOUND_HOST_REFUSAL,
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
  assert.equal(workspaceCreated, 1, `expected workspace creation, got phase=${after.phase} reason=${after.reason}`);
  assert.equal(agentCreated, 1, `expected agent creation, got phase=${after.phase} reason=${after.reason}`);
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
  assert.equal(workspaceCreated, 1, `expected workspace creation, got phase=${after.phase} reason=${after.reason}`);
  assert.equal(agentCreated, 1, `expected agent creation, got phase=${after.phase} reason=${after.reason}`);
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
