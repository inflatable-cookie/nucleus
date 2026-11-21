import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueRuntime } from "../service/runtime-owner";
import { git } from "../core/git/index";
import { submissionSchema, type Profile } from "../shared/contracts";
import { operationInputHash } from "../core/store/store";
import { formatAgentId } from "../shared/agent-identity";
import { fakeAdapter } from "./support/fakes";
import { paseoCatalog } from "./support/pool-shapes";
import type { Adapter } from "../core/host";

/**
 * Readiness belongs to the verified host that owns the work (nucleus#1449).
 *
 * On 2026-11-20 Tom quit Paseo: the service stayed ready, T3 was online with live
 * workers, and the board still warned "Daemon connection did not settle inside
 * 10000 ms" because `RuntimeLifecycle.ensureBootstrap` retried the legacy primary
 * connection and surfaced its timeout through the global `startError`. These
 * tests hold both cases the ruling names: an already running T3 host that loses
 * Paseo, and a cold start with stored Paseo configuration and only T3 online.
 */

const paseoHost = "paseo:primary";
const t3Host = "t3code:trial";

/** The worker profile both fixture catalogs really report. */
const workerProfile: Profile = {
  id: "worker",
  name: "Worker",
  provider: "codex",
  model: "gpt-6-luna",
  notes: "",
  available: true,
  problem: "",
  supportedThinking: ["low"],
};

const catalog = paseoCatalog();

interface Recording {
  workspaces: string[];
  agents: string[];
  /** Catalog reads this host answered. */
  catalogs: number;
}

const recording = (): Recording => ({
  workspaces: [],
  agents: [],
  catalogs: 0,
});

const waitUntil = async (
  ready: () => boolean,
  label: string,
  timeoutMs = 15_000,
) => {
  const start = Date.now();
  while (!ready() && Date.now() - start < timeoutMs)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ready(), label);
};

interface Hosts {
  paseo: Recording;
  t3: Recording;
  /** The Paseo adapter's connection, as the operator's quit leaves it. */
  online: { value: boolean };
  /**
   * The offline primary's own connect call is still unanswered: readiness and
   * common recovery completed without it.
   */
  offlineConnectPending: { value: boolean };
}

/**
 * Two fixture hosts over one data directory: the primary Paseo adapter, and a T3
 * adapter the fixture registers exactly as a verified T3 connection registers
 * itself. The fake Paseo adapter hangs and refuses its catalog while offline,
 * which is the shape the operator saw (the bounded connect times out).
 */
function adapterFor(
  hostId: string,
  socketPath: string,
  helperPath: string,
  repo: string,
  seen: Recording,
  connect: () => Promise<void>,
  connected: () => boolean,
): Adapter {
  return fakeAdapter({
    hostId,
    socketPath,
    helperPath,
    isConnected: connected,
    connect,
    close: async () => {},
    catalog: async () => {
      if (!connected()) throw new Error(`Host ${hostId} is offline`);
      seen.catalogs++;
      return catalog;
    },
    validate: async (task: { planningCommit: string }) => task.planningCommit,
    verifyWorkspace: async (_task: unknown, directory: string) => directory,
    createWorkspace: async (task: { id: string }) => {
      seen.workspaces.push(task.id);
      return { id: `${hostId}-ws-${task.id}`, directory: repo };
    },
    createAgent: async (task: { id: string; workspaceId?: string | null }) => {
      seen.agents.push(task.id);
      return {
        id: `${hostId}-agent-${task.id}`,
        workspaceId: task.workspaceId ?? null,
      };
    },
    observe: async (id: string) => ({
      id,
      workspaceId: `${hostId}-ws`,
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    }),
    originAgent: async (id: string) => ({
      id,
      workspaceId: `${hostId}-ws`,
      title: "Fixture thread",
      archived: false,
    }),
    notify: async () => {},
    archiveAgent: async () => {},
    findOpenBranchPr: async () => [],
  }) as Adapter;
}
interface Fixture {
  root: string;
  dataDir: string;
  repo: string;
  /** The fixture repository's real planning commit. */
  head: string;
  hosts: Hosts;
  adapters: { paseo: Adapter; t3: Adapter };
  runtime: QueueRuntime;
  close: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "t3-sole-online-")));
  const repo = join(root, "repo");
  await git(
    root,
    "init",
    "--bare",
    "--initial-branch=main",
    join(root, "origin.git"),
  );
  await git(root, "clone", join(root, "origin.git"), repo);
  await git(repo, "config", "user.name", "Queue test");
  await git(repo, "config", "user.email", "queue@example.invalid");
  mkdirSync(join(repo, ".paseo"), { recursive: true });
  writeFileSync(
    join(repo, ".paseo/queue.json"),
    JSON.stringify({
      schema: "paseo.queue.control.v5",
      closeout: "queue",
      hooks: [],
    }),
  );
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "fixture");
  await git(repo, "push", "origin", "main");
  const head = (await git(repo, "rev-parse", "HEAD")).trim();

  const socketPath = join(root, "callback.sock");
  const helperPath = join(root, "worker-report.mjs");
  const hosts: Hosts = {
    paseo: recording(),
    t3: recording(),
    online: { value: true },
    offlineConnectPending: { value: false },
  };
  // Offline is the daemon that never answers: the bounded connect is what fails.
  const paseo = adapterFor(
    paseoHost,
    socketPath,
    helperPath,
    repo,
    hosts.paseo,
    () => {
      if (hosts.online.value) return Promise.resolve();
      hosts.offlineConnectPending.value = true;
      return new Promise<void>(() => {});
    },
    () => hosts.online.value,
  );
  const t3 = adapterFor(
    t3Host,
    socketPath,
    helperPath,
    repo,
    hosts.t3,
    async () => {},
    () => true,
  );
  const dataDir = join(root, "data");
  const runtime = new QueueRuntime({
    dataDir,
    adapterFactory: () => paseo,
    timers: false,
    connectTimeoutMs: 200,
  });
  return {
    root,
    dataDir,
    repo,
    head,
    hosts,
    adapters: { paseo, t3 },
    runtime,
    close: async () => {
      if (runtime.phase !== "stopped") await runtime.drain();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The stored planning state a repository needs before a T3 task can dispatch. */
async function planRepository(f: Fixture, runtime: QueueRuntime) {
  runtime.store.putRepository(
    { origin: f.repo, path: f.repo },
    null,
    "",
    null,
    null,
    null,
    undefined,
    undefined,
    "t3code",
  );
  runtime.store.upsertProject({
    key: "trial",
    name: "Trial",
    repositories: [{ origin: f.repo, path: f.repo }],
  });
  runtime.store.setProjectPlanner({
    key: "trial",
    agentId: formatAgentId(paseoHost, "planner"),
    setBy: "operator (board)",
  });
  runtime.store.setProfiles([
    {
      id: workerProfile.id,
      name: workerProfile.name,
      provider: workerProfile.provider,
      model: workerProfile.model,
      notes: "",
    },
  ]);
  runtime.store.setMeta("pool", [
    {
      profileId: workerProfile.id,
      enabled: true,
      group: "test",
      weight: "default",
      roles: ["worker" as const],
      scopes: ["general" as const],
    },
  ]);
  runtime.store.setMeta("paused", false);
  await runtime.engine.refresh();
}

/** Register the T3 adapter the way a verified T3 connection registers itself. */
function registerT3(runtime: QueueRuntime, adapter: Adapter) {
  runtime.hostRegistry.connect(t3Host, "t3code-endpoint", {
    adapter,
    admission: runtime.admission,
  });
}

function insertTask(
  runtime: QueueRuntime,
  f: Pick<Fixture, "repo" | "head">,
  hostId: string,
  title: string,
  /** A task whose host identity is already decided, not a first-worker preference. */
  bound = false,
) {
  return runtime.store.insert(
    submissionSchema.parse({
      submissionId: `${title}-${Math.random().toString(16).slice(2)}`,
      title,
      repoPath: f.repo,
      planningCommit: f.head,
      handoffPath: `${title}.md`,
      originAgentId: formatAgentId(paseoHost, "planner"),
    }),
    hostId,
    "Handoff",
    f.head,
    bound
      ? {
          hostSelection: {
            hostId,
            basis: "explicit" as const,
            reason: "fixture binding",
          },
          profile: workerProfile,
        }
      : {},
  );
}

test("an already running T3 host losing Paseo keeps the board quiet and T3 work moving", async () => {
  const f = await fixture();
  try {
    await f.runtime.started;
    await f.runtime.bootstrap;
    assert.equal(f.runtime.startError, "", "the warm start is clean");
    registerT3(f.runtime, f.adapters.t3);
    await planRepository(f, f.runtime);

    // Existing T3 work: a worker dispatched before Paseo goes away.
    const existing = insertTask(f.runtime, f, t3Host, "Existing T3 work");
    await f.runtime.engine.dispatchTask(existing.id, false);
    await waitUntil(
      () => Boolean(f.runtime.store.task(existing.id).agentId),
      "the existing T3 task dispatched on the T3 host",
    );
    assert.equal(f.hosts.paseo.workspaces.length, 0, "Paseo created nothing");
    assert.equal(f.hosts.t3.agents.length, 1, "the existing worker is on T3");

    // Pending durable work and a queued T3 task present when Paseo disconnects:
    // common recovery and reconciliation must run once on the remaining online host.
    const warmControl = {
      taskId: existing.id,
      version: f.runtime.store.task(existing.id).version,
      action: "hold" as const,
      reason: "Warm disconnect fixture",
    };
    const warmAccepted = f.runtime.store.acceptOperation({
      key: "warm-disconnect-hold",
      kind: "task_control",
      inputHash: operationInputHash(warmControl),
      taskId: existing.id,
      expectedVersion: warmControl.version,
      payload: { type: "task_control", control: warmControl },
      hostId: t3Host,
    });
    assert.ok("accepted" in warmAccepted, JSON.stringify(warmAccepted));
    const reconciled = insertTask(
      f.runtime,
      f,
      t3Host,
      "Reconciled on warm disconnect",
    );

    // Tom quits Paseo. The service keeps running with T3 online.
    f.hosts.online.value = false;
    assert.equal(
      await f.runtime.ensureBootstrap(),
      true,
      "T3 alone satisfies readiness",
    );

    assert.equal(
      f.runtime.startError,
      "",
      "an offline primary is that host's fault, never a board-wide start error",
    );
    const board = f.runtime.uiSnapshot();
    assert.equal(
      board.error,
      "",
      "no global failure banner on a healthy board",
    );
    const health = f.runtime.health();
    assert.equal(
      health.connected,
      true,
      "the fleet is still connected through T3",
    );
    assert.equal(
      health.hostId,
      paseoHost,
      "the legacy host identity is unchanged",
    );
    assert.deepEqual(
      health.hosts?.find((host) => host.id === t3Host)?.state,
      "online",
    );
    // Common durable recovery and reconciliation ran on warm Paseo disconnect without
    // waiting for the offline primary.
    await waitUntil(
      () => f.runtime.store.task(existing.id).held,
      "the accepted durable operation resumed on warm Paseo disconnect",
    );
    assert.equal(
      f.runtime.store
        .operations({})
        .filter((record) => record.key === "warm-disconnect-hold").length,
      1,
      "the durable operation ran once",
    );
    await waitUntil(
      () => Boolean(f.runtime.store.task(reconciled.id).agentId),
      "reconciliation dispatched the queued T3 task on warm Paseo disconnect",
    );
    assert.equal(
      f.hosts.t3.agents.length,
      2,
      "reconciliation created the queued T3 worker once",
    );

    // The primary's own bounded attempt records its cause on that host.
    await waitUntil(
      () =>
        /Daemon connection did not settle inside 200 ms/.test(
          f.runtime.health().hosts?.find((host) => host.id === paseoHost)
            ?.reason ?? "",
        ),
      "the offline primary records its own cause",
    );
    const offlinePaseo = f.runtime
      .health()
      .hosts?.find((host) => host.id === paseoHost);
    assert.equal(offlinePaseo?.state, "offline");
    assert.match(
      offlinePaseo?.reason ?? "",
      /Daemon connection did not settle inside 200 ms/,
      "the offline host is explicit, with its own cause",
    );
    assert.equal(f.runtime.bootstrapped, true, "the bootstrap stays completed");
    assert.equal(
      f.hosts.offlineConnectPending.value,
      true,
      "the offline primary's own connect never answered, and nothing waited on it",
    );

    // A later tick while Paseo stays offline does not duplicate recovery or dispatch.
    assert.equal(await f.runtime.ensureBootstrap(), true);
    assert.equal(
      f.runtime.store
        .operations({})
        .filter((record) => record.key === "warm-disconnect-hold").length,
      1,
      "a subsequent tick does not duplicate the durable operation",
    );
    assert.equal(
      f.hosts.t3.agents.length,
      2,
      "a subsequent tick does not duplicate workers",
    );

    // Existing T3 work is untouched and its host is still available.
    assert.equal(
      f.runtime.store.task(existing.id).agentId,
      `${t3Host}-agent-${existing.id}`,
      "the existing worker keeps its T3 thread",
    );
    assert.equal(
      f.runtime.engine.withHost(t3Host, () =>
        f.runtime.engine.taskHostAvailable(f.runtime.store.task(existing.id)),
      ),
      true,
      "the existing worker's host still owns its task",
    );

    // A catalog pass while the primary is offline reads the online host's own
    // catalog and never calls the offline adapter.
    f.hosts.paseo.catalogs = 0;
    f.hosts.t3.catalogs = 0;
    await f.runtime.refresh();
    assert.equal(f.hosts.paseo.catalogs, 0, "the offline adapter is not asked");
    assert.equal(f.hosts.t3.catalogs, 1, "T3's own catalog is read");

    // An eligible new dispatch still runs on the online T3 host.
    assert.equal(
      f.runtime.engine.profileCatalogKnownFor(t3Host),
      true,
      "T3's own catalog is known while Paseo is offline",
    );
    const fresh = insertTask(f.runtime, f, t3Host, "New T3 dispatch");
    await f.runtime.engine.dispatchTask(fresh.id, false);
    await waitUntil(
      () => Boolean(f.runtime.store.task(fresh.id).agentId),
      "the new T3 task dispatched while Paseo was offline",
    );
    assert.equal(
      f.hosts.t3.agents.length,
      3,
      "the new worker was created on T3",
    );

    // A task actually bound to the offline Paseo host waits there, and nothing
    // pretends a workspace effect happened.
    const paseoTask = insertTask(
      f.runtime,
      f,
      paseoHost,
      "Bound to Paseo",
      true,
    );
    await f.runtime.engine.dispatchTask(paseoTask.id, false);
    const waiting = f.runtime.store.task(paseoTask.id);
    assert.equal(waiting.resolution.stop?.reason, "host_unavailable");
    assert.equal(waiting.resolution.hostWait?.hostId, paseoHost);
    assert.equal(
      waiting.workspaceIntent,
      false,
      "no workspace effect is attempted",
    );
    assert.equal(f.hosts.paseo.workspaces.length, 0);

    // An independently real service fault is still on the board: the host fault
    // above suppressed nothing, and a catalog pass does not clear another owner's
    // error.
    f.runtime.store.setMeta("engineError", "fixture engine fault");
    await f.runtime.refresh();
    assert.equal(f.runtime.startError, "");
    assert.equal(
      f.runtime.uiSnapshot().error,
      "fixture engine fault",
      "a genuine engine fault stays on the board",
    );
    f.runtime.store.deleteMeta("engineError");
    await f.runtime.refresh();
    assert.equal(f.runtime.uiSnapshot().error, "");
  } finally {
    await f.close();
  }
});

test("a cold start with stored Paseo configuration and only T3 online resumes durable recovery", async () => {
  const f = await fixture();
  let cold: QueueRuntime | null = null;
  try {
    await f.runtime.started;
    await f.runtime.bootstrap;
    registerT3(f.runtime, f.adapters.t3);
    await planRepository(f, f.runtime);

    const existing = insertTask(
      f.runtime,
      f,
      t3Host,
      "Started before the cold start",
    );
    await f.runtime.engine.dispatchTask(existing.id, false);
    await waitUntil(
      () => Boolean(f.runtime.store.task(existing.id).agentId),
      "the pre-restart T3 task dispatched",
    );
    // A durable operation accepted before the restart, whose recovery is common
    // work that owes nothing to the primary host.
    const control = {
      taskId: existing.id,
      version: f.runtime.store.task(existing.id).version,
      action: "hold" as const,
      reason: "Cold start fixture",
    };
    const accepted = f.runtime.store.acceptOperation({
      key: "cold-start-hold",
      kind: "task_control",
      inputHash: operationInputHash(control),
      taskId: existing.id,
      expectedVersion: control.version,
      payload: { type: "task_control", control },
      hostId: t3Host,
    });
    assert.ok("accepted" in accepted, JSON.stringify(accepted));

    // Paseo is gone before the next start; only T3 answers.
    f.hosts.online.value = false;
    const firstAgents = f.hosts.t3.agents.length;
    const existingAgentId = f.runtime.store.task(existing.id).agentId;
    await f.runtime.drain();

    cold = new QueueRuntime({
      dataDir: f.dataDir,
      adapterFactory: () => f.adapters.paseo,
      timers: false,
      connectTimeoutMs: 200,
    });
    // The verified T3 connection registers before the daemon's own bootstrap, so
    // the stored Paseo primary is configured and offline while T3 is the host
    // that owns the work.
    registerT3(cold, f.adapters.t3);
    await cold.started;
    await cold.bootstrap;

    assert.equal(
      cold.startError,
      "",
      "a cold start with only T3 online is not a start failure",
    );
    assert.equal(
      cold.bootstrapped,
      true,
      "readiness completed on the online host",
    );
    assert.equal(
      f.hosts.offlineConnectPending.value,
      true,
      "the stored primary's connect was still unanswered: the cold start did not wait on it",
    );
    assert.equal(cold.uiSnapshot().error, "", "the board carries no banner");
    const health = cold.health();
    assert.equal(health.connected, true);
    assert.deepEqual(
      health.hosts?.find((host) => host.id === t3Host)?.state,
      "online",
    );
    // The stored primary's own bounded attempt records its cause on that host.
    await waitUntil(
      () =>
        /Daemon connection did not settle inside 200 ms/.test(
          cold!.health().hosts?.find((host) => host.id === paseoHost)?.reason ??
            "",
        ),
      "the stored Paseo primary records its own cause",
    );
    const offlinePaseo = cold
      .health()
      .hosts?.find((host) => host.id === paseoHost);
    assert.equal(offlinePaseo?.state, "offline");
    assert.match(
      offlinePaseo?.reason ?? "",
      /Daemon connection did not settle inside 200 ms/,
      "the stored Paseo primary is explicitly offline with its cause",
    );

    // Common durable recovery ran: the accepted hold landed exactly once.
    assert.equal(
      cold.store.task(existing.id).held,
      true,
      "the accepted durable operation resumed without the primary host",
    );
    assert.equal(
      cold.store
        .operations({})
        .filter((record) => record.key === "cold-start-hold").length,
      1,
      "the operation ran once, not twice",
    );
    // Existing T3 work survives, and a new dispatch is eligible on the online host.
    assert.equal(
      cold.store.task(existing.id).agentId,
      existingAgentId,
      "the existing T3 worker keeps its thread across the cold start",
    );
    const fresh = insertTask(
      cold,
      f,
      t3Host,
      "Dispatched after the cold start",
    );
    await cold.engine.dispatchTask(fresh.id, false);
    await waitUntil(
      () => Boolean(cold!.store.task(fresh.id).agentId),
      "the new T3 task dispatched after the cold start",
    );
    assert.equal(f.hosts.t3.agents.length, firstAgents + 1);
    // The stored Paseo-bound task waits on its own host.
    const paseoTask = insertTask(cold, f, paseoHost, "Stored Paseo work", true);
    await cold.engine.dispatchTask(paseoTask.id, false);
    assert.equal(
      cold.store.task(paseoTask.id).resolution.stop?.reason,
      "host_unavailable",
    );
    assert.equal(f.hosts.paseo.workspaces.length, 0);
  } finally {
    if (cold) await cold.drain();
    await f.close();
  }
});
