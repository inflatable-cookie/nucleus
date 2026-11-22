import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { submissionSchema, type Profile, type Task } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";
import { reportHostCallFailure } from "../core/host/adapter-routing";
import { HostRegistry, type KnownHost } from "../core/host/host-registry";
import { Admission } from "../core/host/admission";
import { createHost, T3RpcError } from "../hosts/t3code";
import { T3HostConnection } from "../service/t3code-host";
import { HostOperationTimeoutError } from "../service/host-executor";
import { t3Fake } from "./support/t3code-fake";
import {
  fakeAdapter,
  profile as makeProfile,
  submission,
} from "./support/fakes";
import { holdPatch } from "../core/merge/merge-hold";

/**
 * Spec 069 §2 (Tom, 2026-11-22): host health comes from the host's connection,
 * never from how a call, a pass or a task record went. On 22 November a stale host
 * wait on one visited task, re-asserted by every submission's dispatch pass, kept
 * a connected T3 host "unavailable" for 47 minutes and rewrote every task's stop
 * each time; after each roll every T3 task was parked while the new service
 * connected.
 *
 * The engine, store, routing proxy and outage record are the real ones; the
 * heartbeat case drives the real T3 connection over the fake Nightly transport.
 */
const HOST = "t3code:synthetic-environment";
const base = "b".repeat(40);
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
type Loose = Record<string, any>;

function fixture(
  t: TestContext,
  adapterMethods: Loose = {},
  options: { working?: number } = {},
) {
  const store = new Store(":memory:");
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 0);
  const insert = (title: string) =>
    store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title,
        repoPath: "/synthetic/repo",
        planningCommit: base,
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      HOST,
      "handoff.md",
      base,
    );
  const queued = insert("Queued work");
  const working = Array.from({ length: options.working ?? 1 }, (_, index) => {
    const task = insert(`Working task ${index}`);
    return store.update(
      task.id,
      {
        phase: "working",
        workspaceIntent: true,
        agentIntent: true,
        workspaceId: `synthetic-workspace-${index}`,
        agentId: `synthetic-worker-${index}`,
        runId: "initial",
        directory: "/synthetic/repo",
        branch: `ns-synthetic-${index}`,
        baseBranch: "main",
        profile,
        workerModel: profile.model,
        workerModels: [profile.model],
      },
      "dispatched",
    );
  });
  const adapter = { hostId: HOST, ...adapterMethods } as unknown as Adapter;
  const engine = new Engine(store, adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  const connection = { live: true };
  engine.hostIds = () => [HOST];
  engine.hostAvailable = (id) => id === HOST && connection.live;
  // The audit pass's own steps; the host health and task visits are what is judged.
  const visited: string[] = [];
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
  engine.resolution.observationTargets = () => [];
  engine.resolution.observe = async () => {};
  engine.scheduleTaskQuantum = async (taskId) => {
    visited.push(taskId);
  };
  engine.dispatchQueued = async () => {};
  for (const method of [
    "deliverNotices",
    "deliverQueuedMessages",
    "resumeAskQuestions",
    "raiseOperatorQuestions",
    "delegateNativeQuestions",
    "resumeResponsibleAnsweredQuestions",
    "deliverHoldNotices",
    "deliverDecisionNotices",
    "deliverDrainNotices",
    "deliverHostOutageNotices",
    "deliverRowHiddenNotices",
  ] as const)
    (engine.resolution as Loose)[method] = async () => {};
  return {
    store,
    engine,
    queued,
    working,
    connection,
    visited,
    pass: () => engine.auditPass(true),
  };
}

/** Every task record a pass could write: versions, events and the outage record. */
function writes(store: Store, tasks: readonly Task[]) {
  return {
    versions: tasks.reduce((sum, task) => sum + store.task(task.id).version, 0),
    events: tasks.reduce(
      (sum, task) => sum + store.eventsAll(task.id).length,
      0,
    ),
    outages: JSON.stringify(store.getMeta("hostOutages") ?? null),
  };
}

const stopReasons = (store: Store, ...tasks: Task[]) =>
  tasks.map((task) => store.task(task.id).resolution.stop?.reason ?? null);

const timeout = () =>
  new HostOperationTimeoutError("thread.inventory", 25, new Promise(() => {}));

test("a call failure recorded with no error, or one that is not about the host, changes nothing", (t) => {
  const f = fixture(t);
  assert.equal(f.engine.hostHealth.read(HOST).state, "up");
  reportHostCallFailure(f.engine.adapter, HOST, undefined);
  reportHostCallFailure(
    f.engine.adapter,
    HOST,
    new Error("Planning base unavailable"),
  );
  assert.equal(
    f.engine.hostHealth.read(HOST).state,
    "up",
    "the host is still up",
  );
  assert.equal(f.engine.hostOutages.current(HOST), null, "no outage is opened");
  assert.deepEqual(
    stopReasons(f.store, f.queued, f.working[0]!),
    [null, null],
    "no task gets a host wait",
  );
});

test("one call that fails at the transport changes no state: diagnostics only, never an outage", (t) => {
  const f = fixture(t);
  const before = writes(f.store, [f.queued, ...f.working]);
  reportHostCallFailure(
    f.engine.adapter,
    HOST,
    new T3RpcError("transport", "orchestration.subscribeThread"),
  );
  const health = f.engine.hostHealth.read(HOST);
  assert.equal(
    health.state,
    "up",
    "one call is not the host (Spec 067 batch 5)",
  );
  assert.match(
    health.detail ?? "",
    /T3Code transport/,
    "the call is kept for diagnostics",
  );
  assert.equal(
    f.engine.hostOutages.current(HOST),
    null,
    "a failed call opens no outage",
  );
  assert.equal(
    f.engine.hostWait(f.store.task(f.working[0]!.id)),
    null,
    "running work keeps going",
  );
  assert.equal(
    f.engine.hostLaunchWait(HOST),
    null,
    "and new launches still go",
  );
  assert.deepEqual(
    writes(f.store, [f.queued, ...f.working]),
    before,
    "nothing is written for any task",
  );
});

test("our own queue's abandonment or pending cap is not a host fault", (t) => {
  const f = fixture(t);
  const abandoned = Object.assign(new Error("admission slot abandoned"), {
    name: "HostCallAbandonedError",
  });
  const capped = Object.assign(
    new Error("No host executor is connected for host"),
    { name: "HostExecutorUnavailableError" },
  );
  for (let pass = 0; pass < 3; pass++)
    f.engine.hostHealth.passFailed(HOST, pass % 2 ? capped : abandoned);
  const health = f.engine.hostHealth.read(HOST);
  assert.equal(health.state, "up");
  assert.equal(health.detail, null);
  // Neutral: it neither advances nor resets a run of real failed passes.
  f.engine.hostHealth.passFailed(HOST, timeout());
  f.engine.hostHealth.passFailed(HOST, timeout());
  f.engine.hostHealth.passFailed(HOST, abandoned);
  assert.equal(f.engine.hostHealth.read(HOST).state, "up", "still two in a row");
  f.engine.hostHealth.passFailed(HOST, timeout());
  assert.equal(
    f.engine.hostHealth.read(HOST).state,
    "degraded",
    "the third real failed pass counts across the neutral one",
  );
});

test("a host pass whose call timed out fails only its own step: still up, no stop, no outage", async (t) => {
  let hung = true;
  const f = fixture(t, {
    observationInventory: async () => {
      if (hung) throw timeout();
      return new Map();
    },
  });
  f.engine.resolution.observationTargets = () => ["synthetic-worker-0"];
  const tasks = [f.queued, ...f.working];
  const before = writes(f.store, tasks);

  await f.pass();
  const health = f.engine.hostHealth.read(HOST);
  assert.equal(health.state, "up", "one failed pass is not yet degraded");
  assert.match(health.detail ?? "", /no answer within 25 ms/);
  assert.equal(f.engine.hostOutages.current(HOST), null, "no outage is opened");
  assert.deepEqual(
    stopReasons(f.store, ...tasks),
    [null, null],
    "no task gets a stop",
  );
  assert.deepEqual(writes(f.store, tasks), before, "no task record is written");
  assert.match(
    String(f.store.getMeta("hostPassError")),
    /observationInventory: .*no answer within/,
    "the step records its own failure",
  );
  assert.deepEqual(
    f.visited,
    [f.working[0]!.id],
    "the running task is still visited by its own owner",
  );
  assert.equal(f.engine.hostLaunchWait(HOST), null, "new launches still go");

  hung = false;
  await f.pass();
  assert.equal(f.engine.hostHealth.read(HOST).state, "up");
  assert.equal(
    f.engine.hostHealth.read(HOST).detail,
    null,
    "the clean pass clears the diagnostic",
  );
});

test("intermittent timeouts with clean passes between keep the host up; three failed passes in a row make it degraded", async (t) => {
  let hung = false;
  const f = fixture(t, {
    observationInventory: async () => {
      if (hung) throw timeout();
      return new Map();
    },
  });
  f.engine.resolution.observationTargets = () => ["synthetic-worker-0"];
  // Single-call timeouts on dispatch and observation, and failed passes broken by clean ones.
  for (let round = 0; round < 4; round++) {
    reportHostCallFailure(f.engine.adapter, HOST, timeout());
    hung = round % 2 === 0;
    await f.pass();
    assert.equal(
      f.engine.hostHealth.read(HOST).state,
      "up",
      `round ${round}: still up`,
    );
    assert.equal(
      f.engine.hostLaunchWait(HOST),
      null,
      `round ${round}: launches go`,
    );
  }
  hung = true;
  await f.pass();
  await f.pass();
  assert.equal(
    f.engine.hostHealth.read(HOST).state,
    "up",
    "two failed passes in a row are not yet degraded",
  );
  await f.pass();
  assert.equal(
    f.engine.hostHealth.read(HOST).state,
    "degraded",
    "the third makes it degraded",
  );
  assert.equal(
    f.engine.hostOutages.current(HOST),
    null,
    "degraded is never an outage",
  );
  hung = false;
  await f.pass();
  assert.equal(
    f.engine.hostHealth.read(HOST).state,
    "up",
    "the first clean pass resets it",
  );
});

test("200 tasks on one host: a pass with one failing call writes O(1) records, not one per task", async (t) => {
  let failing = false;
  const f = fixture(
    t,
    {
      observationInventory: async () => {
        if (failing)
          throw new Error(
            `Transport not connected: host ${HOST} is unavailable`,
          );
        return new Map();
      },
    },
    { working: 200 },
  );
  f.engine.resolution.observationTargets = () => ["synthetic-worker-0"];
  const tasks = [f.queued, ...f.working];
  await f.pass();
  const before = writes(f.store, tasks);

  failing = true;
  await f.pass();
  assert.equal(f.engine.hostHealth.read(HOST).state, "up");
  assert.deepEqual(
    writes(f.store, tasks),
    before,
    "the failing call wrote nothing to any of the 200 tasks",
  );
  assert.equal(
    f.store
      .tasks()
      .filter((task) => task.resolution.stop?.reason === "host_unavailable")
      .length,
    0,
  );
});

test("a lost connection takes the host down once: the outage opens once, the tasks wait, and the return clears both", async (t) => {
  const f = fixture(t);
  const working = f.working[0]!;
  f.connection.live = false;
  await f.pass();
  assert.equal(f.engine.hostHealth.read(HOST).state, "down");
  const outage = f.engine.hostOutages.current(HOST);
  assert.ok(outage, "the outage is opened on the transition");
  const waiting = f.store.task(working.id);
  assert.equal(waiting.resolution.stop?.reason, "host_unavailable");
  assert.equal(
    waiting.resolution.hostWait?.since,
    outage.since,
    "the wait is dated from the outage",
  );
  assert.deepEqual(f.visited, [], "nothing is sent to a host that is down");

  const version = f.store.task(working.id).version;
  await f.pass();
  assert.deepEqual(
    f.engine.hostOutages.current(HOST),
    outage,
    "a second pass reuses the same outage",
  );
  assert.equal(
    f.store.task(working.id).version,
    version,
    "and rewrites no task",
  );

  f.connection.live = true;
  await f.pass();
  assert.equal(
    f.engine.hostHealth.read(HOST).state,
    "up",
    "up again on the first healthy reading",
  );
  assert.equal(f.engine.hostOutages.current(HOST), null, "the outage closes");
  assert.equal(
    f.store.task(working.id).resolution.stop,
    null,
    "the wait clears",
  );
  assert.equal(f.store.task(working.id).resolution.hostWait, null);
  assert.deepEqual(f.visited, [working.id], "the task is visited again");
});

test("a fresh service reads a host it has not seen yet as unknown, and parks nothing", async (t) => {
  const f = fixture(t);
  f.engine.hostHealth.startupGraceMs = 60_000;
  // The target-host path runs for the unbound queued task too.
  f.store.setMeta("operatorDefaultHostKind", "t3code");
  f.connection.live = false;
  const tasks = [f.queued, ...f.working];
  const before = writes(f.store, tasks);

  await f.pass();
  await f.engine.dispatchTask(f.queued.id, false);
  assert.equal(f.engine.hostHealth.read(HOST).state, "unknown");
  assert.equal(
    f.engine.hostOutages.current(HOST),
    null,
    "no outage while the host is unread",
  );
  assert.deepEqual(
    stopReasons(f.store, ...tasks),
    [null, null],
    "no task gets host_unavailable",
  );
  assert.deepEqual(
    writes(f.store, tasks),
    before,
    "nothing is written for any task",
  );
  assert.deepEqual(
    f.visited,
    [],
    "and nothing is sent to the host it has not read",
  );

  f.connection.live = true;
  await f.pass();
  assert.equal(
    f.engine.hostHealth.read(HOST).state,
    "up",
    "the first connected reading is up",
  );
  assert.deepEqual(f.visited, [f.working[0]!.id]);
});

test("a host that never connects reads as down once the startup grace ends", (t) => {
  const f = fixture(t);
  f.engine.hostHealth.startupGraceMs = 60_000;
  f.connection.live = false;
  assert.equal(f.engine.hostHealth.read(HOST).state, "unknown");
  assert.equal(
    f.engine.hostHealth.read(HOST, Date.now() + 61_000).state,
    "down",
  );
  assert.ok(
    f.engine.hostOutages.current(HOST),
    "the outage opens on the transition",
  );
});

test("an outage inherited from before the restart closes on the first connected reading", (t) => {
  const f = fixture(t);
  f.engine.hostHealth.startupGraceMs = 60_000;
  f.engine.hostOutages.observe(
    HOST,
    false,
    new Date(Date.now() - 600_000).toISOString(),
  );
  assert.equal(f.engine.hostHealth.read(HOST).state, "up");
  assert.equal(f.engine.hostOutages.current(HOST), null);
});

async function until(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(label);
}

test("heartbeats that fail across the window take a real T3 connection down, and the reconnect brings it up", async (t) => {
  const directory = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "ns-host-health-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = await t3Fake(t, directory);
  let known: readonly KnownHost[] = [];
  const hosts = new HostRegistry<{ adapter: Adapter; admission: Admission }>({
    read: () => known,
    write: (value) => {
      known = value;
    },
    transaction: (work) => work(),
  });
  const connection = new T3HostConnection(
    { endpoint: server.endpoint, bearer: "synthetic-bearer" },
    directory,
    hosts,
    () => new Admission(),
    {
      create: (config) =>
        createHost({
          ...config,
          heartbeatIntervalMs: 50,
          heartbeatTimeoutMs: 100,
        }),
      adapter: () => ({}) as Adapter,
    },
  );
  t.after(() => connection.close());
  await connection.ensureConnected();
  const hostId = hosts.onlineIds()[0]!;
  assert.ok(hostId, "the connection holds its registry claim");

  const store = new Store(":memory:");
  const engine = new Engine(store, { hostId } as unknown as Adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  engine.hostIds = () => hosts.known().map((entry) => entry.id);
  // The runtime's claim reading: a disconnected socket retires the claim.
  engine.hostAvailable = (id) => {
    connection.retireDisconnected();
    return Boolean(hosts.get(id));
  };
  const task = store.update(
    store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Running",
        repoPath: "/synthetic/repo",
        planningCommit: base,
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      hostId,
      "handoff.md",
      base,
    ).id,
    {
      phase: "working",
      workspaceId: "synthetic-workspace",
      agentId: "synthetic-worker",
      runId: "initial",
    },
    "dispatched",
  );

  assert.equal(engine.hostHealth.read(hostId).state, "up");
  // One missed pong is inside the window; two close the socket.
  server.controls.heartbeat = false;
  await until(
    () => engine.hostHealth.read(hostId).state === "down",
    "the host reads down after the heartbeat window",
  );
  assert.equal(connection.status().lastDisconnectReason, "heartbeat_failure");
  const outage = engine.hostOutages.current(hostId);
  assert.ok(outage, "the outage opens once");
  assert.match(
    engine.hostWait(store.task(task.id)) ?? "",
    /^Waiting on T3Code host/,
  );
  assert.equal(store.task(task.id).resolution.stop?.reason, "host_unavailable");

  server.controls.heartbeat = true;
  await connection.ensureConnected();
  assert.equal(engine.hostHealth.read(hostId).state, "up");
  assert.equal(engine.hostOutages.current(hostId), null, "the outage closes");
  assert.equal(engine.hostWait(store.task(task.id)), null);
  assert.equal(store.task(task.id).resolution.stop, null, "the wait clears");
});

/** A real first-dispatch path on one host: catalog, pool, workspace and a gated launch. */
function launchFixture(t: TestContext) {
  const store = new Store(":memory:");
  const worker = makeProfile("worker");
  const adapter = fakeAdapter({
    validate: async () => "a".repeat(40),
    createWorkspace: async (task: Task) => ({
      id: `ws-${task.id}`,
      directory: `/synthetic/workspaces/${task.id}`,
    }),
  });
  const engine = new Engine(store, adapter, 0);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 5);
  store.setMeta("pool", [
    {
      profileId: worker.id,
      enabled: true,
      group: "workers",
      weight: "default",
      scopes: ["general"],
    },
  ]);
  store.setProfiles([
    {
      id: worker.id,
      name: worker.name,
      provider: worker.provider,
      model: worker.model,
      notes: "",
    },
  ]);
  engine.profiles = [worker];
  engine.profileCatalogKnown = () => true;
  engine.profilesFor = () => [worker];
  engine.hostIds = () => [HOST];
  engine.hostAvailable = (id) => id === HOST;
  engine.resolveHostAdapter = () => adapter;
  const launches: string[] = [];
  const gates = new Map<string, Promise<void>>();
  engine.launchAgent = async (task) => {
    launches.push(task.id);
    await gates.get(task.id);
    store.update(task.id, {
      phase: "working",
      agentId: `agent-${task.id}`,
      agentActive: true,
    });
  };
  const add = (title: string) =>
    store.insert(
      submission({
        title,
        repoPath: `/synthetic/${title.replace(/\W+/g, "-")}`,
      }),
      HOST,
      "handoff",
      "a".repeat(40),
      {
        hostSelection: {
          hostId: HOST,
          basis: "worker_profile",
          reason: "Previously selected worker host",
        },
      },
    );
  const degrade = () => {
    for (let pass = 0; pass < 3; pass++)
      engine.hostHealth.passFailed(HOST, timeout());
  };
  return { store, engine, launches, gates, add, degrade };
}

test("a degraded host takes one first dispatch at a time; running work and later launches carry on", async (t) => {
  const f = launchFixture(t);
  const first = f.add("First");
  const second = f.add("Second");
  f.degrade();
  assert.equal(f.engine.hostHealth.read(HOST).state, "degraded");
  let release!: () => void;
  f.gates.set(
    first.id,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  const inFlight = f.engine.dispatchTask(first.id, false);
  for (
    let attempt = 0;
    attempt < 200 && !f.launches.includes(first.id);
    attempt++
  )
    await delay(5);
  assert.deepEqual(
    f.launches,
    [first.id],
    "the degraded host admits one launch",
  );

  await f.engine.dispatchTask(second.id, false);
  assert.deepEqual(
    f.launches,
    [first.id],
    "and no second while the first is in flight",
  );
  const waiting = f.store.task(second.id);
  assert.equal(waiting.phase, "queued");
  assert.equal(waiting.resolution.stop ?? null, null, "the wait is not a stop");
  assert.equal(waiting.version, second.version, "nothing is stored (Spec 069 §1)");
  const read = f.engine.queuedExternalWait(waiting);
  assert.match(read, /one launch at a time/, "the board reads the wait");
  assert.doesNotMatch(read, /no answer within/, "without the call's error");
  assert.match(
    f.engine.hostHealth.read(HOST).detail ?? "",
    /no answer within/,
    "it is read from the health reading instead",
  );

  release();
  await inFlight;
  await f.engine.dispatchTask(second.id, false);
  assert.deepEqual(
    f.launches,
    [first.id, second.id],
    "the next launch goes once the first settles",
  );
});

test("on a degraded host a held, prerequisite or capacity wait keeps its own reason and stop", async (t) => {
  const f = launchFixture(t);
  const blocker = f.add("Unfinished prerequisite");
  f.store.update(blocker.id, { phase: "working", agentId: "agent-blocker" });
  const dependent = f.add("Dependent");
  f.store.update(dependent.id, { dependsOn: [blocker.id] });
  const capacity = f.add("Capacity");
  const held = f.add("Held");
  // Each carries its own recorded answer, which the launch wait must never replace.
  f.store.update(
    held.id,
    holdPatch(
      f.store.task(held.id),
      "dispatch",
      "operator",
      "Wait for staging",
    ),
  );
  f.engine.resolution.recordStop(
    f.store.task(held.id),
    "held",
    "Held by the operator: Wait for staging",
  );
  f.engine.resolution.waiting(
    f.store.task(dependent.id),
    "Waiting for its prerequisite",
    "lifecycle",
  );
  f.engine.resolution.waiting(
    f.store.task(capacity.id),
    "Waiting for a free slot",
    "lifecycle",
  );
  const gateState = (id: string) => {
    const task = f.store.task(id);
    return {
      phase: task.phase,
      reason: task.reason,
      stop: task.resolution.stop?.reason ?? null,
    };
  };
  const observe = async (id: string, dispatchHeld = false) => {
    await f.engine.dispatchTask(id, dispatchHeld);
    return gateState(id);
  };
  // Each gate's own answer on a healthy host.
  const dependentWait = await observe(dependent.id);
  f.store.setMeta("globalLimit", 0);
  const capacityWait = await observe(capacity.id);
  f.store.setMeta("globalLimit", 5);
  const heldWait = await observe(held.id, true);
  for (const wait of [dependentWait, capacityWait, heldWait])
    assert.equal(wait.phase, "queued");

  // Degraded, with another launch in flight, so the launch rule would wait.
  f.degrade();
  f.engine.hostHealth.launchStarted(HOST, "synthetic-launch-in-flight");
  assert.match(
    f.engine.hostLaunchWait(HOST, dependent.id) ?? "",
    /one launch at a time/,
  );
  assert.deepEqual(
    await observe(dependent.id),
    dependentWait,
    "the prerequisite wait stands",
  );
  f.store.setMeta("globalLimit", 0);
  assert.deepEqual(
    await observe(capacity.id),
    capacityWait,
    "the capacity wait stands",
  );
  f.store.setMeta("globalLimit", 5);
  assert.deepEqual(await observe(held.id, true), heldWait, "the hold stands");
  assert.deepEqual(f.launches, [], "none of them launched");
});

test("a first dispatch that throws still releases its in-flight launch on a degraded host", async (t) => {
  const f = launchFixture(t);
  const first = f.add("Throws");
  const second = f.add("Next");
  f.degrade();
  f.engine.launchAgent = async (task) => {
    f.launches.push(task.id);
    if (task.id === first.id) throw new Error("synthetic launch failure");
    f.store.update(task.id, {
      phase: "working",
      agentId: `agent-${task.id}`,
      agentActive: true,
    });
  };
  // The engine's noteStepFailure is replaced so the error escapes dispatchTask.
  const note = f.engine.noteStepFailure.bind(f.engine);
  f.engine.noteStepFailure = (taskId, error) => {
    if (taskId === first.id) throw error;
    return note(taskId, error);
  };
  await assert.rejects(f.engine.dispatchTask(first.id, false), /synthetic launch failure/);
  assert.equal(f.engine.hostLaunchWait(HOST, second.id), null, "the launch is released");
  await f.engine.dispatchTask(second.id, false);
  assert.deepEqual(f.launches, [first.id, second.id]);
});

test("the runtime tick's health reading makes an unseen host down and raises its notice, with no sweep", (t) => {
  const f = fixture(t);
  f.connection.live = false;
  f.engine.hostHealth.startupGraceMs = 0;
  f.store.upsertProject({
    key: "synthetic",
    name: "Synthetic",
    repositories: [{ origin: "synthetic/repo", path: "/synthetic/repo" }],
  });
  f.engine.observeHostHealth();
  assert.equal(f.engine.hostHealth.read(HOST).state, "down");
  const outage = f.engine.hostOutages.current(HOST);
  assert.ok(outage, "the outage opens on the tick");
  assert.equal(f.visited.length, 0, "nothing is sent");
  // Past the notice bound, the same tick raises the project's one notice.
  f.store.setMeta("hostOutages", {
    [HOST]: { ...outage, since: new Date(Date.now() - 180 * 60_000).toISOString() },
  });
  f.engine.observeHostHealth();
  assert.equal(
    f.store.notices().filter((notice) => notice.kind === "host_outage").length,
    1,
  );
});

test("a dispatch pass skips a host whose own call failed, for that pass only", async (t) => {
  const f = launchFixture(t);
  const OTHER = "paseo:synthetic-other";
  let failing = true;
  const healthy = fakeAdapter({
    validate: async () => "a".repeat(40),
    createWorkspace: async (task: Task) => ({
      id: `ws-${task.id}`,
      directory: `/synthetic/workspaces/${task.id}`,
    }),
  });
  const refusing = fakeAdapter({
    ...healthy,
    validate: async () => {
      if (failing)
        throw new Error(`Transport not connected: host ${HOST} is unavailable`);
      return "a".repeat(40);
    },
  });
  f.engine.hostIds = () => [HOST, OTHER];
  f.engine.hostAvailable = () => true;
  f.engine.resolveHostAdapter = (id) => (id === HOST ? refusing : healthy);
  f.store.setMeta("globalLimit", 1);
  const head = f.add("Head on the failing host");
  const behind = f.store.insert(
    submission({ title: "Behind on another host", repoPath: "/synthetic/behind" }),
    OTHER,
    "handoff",
    "a".repeat(40),
    { hostSelection: { hostId: OTHER, basis: "worker_profile", reason: "Previously selected worker host" } },
  );
  await f.engine.dispatchQueued();
  assert.deepEqual(f.launches, [behind.id], "the free slot goes to the other host");
  assert.equal(f.engine.hostHealth.read(HOST).state, "up", "the failed call changed no state");
  assert.equal(f.store.task(head.id).resolution.stop ?? null, null);
  // The skip ended with its pass: the next pass tries the head again.
  failing = false;
  f.store.update(behind.id, { phase: "done", agentActive: false });
  await f.engine.dispatchQueued();
  assert.deepEqual(f.launches, [behind.id, head.id]);
});
