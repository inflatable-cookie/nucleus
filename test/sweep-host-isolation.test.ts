import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import { submission, profile } from "./support/fakes";
import { HostTransportFault } from "../core/host/adapter-routing";
import { runSchema } from "../shared/contracts";

const OFFLINE_HOST = "bb:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEALTHY_HOST = "paseo:primary";
type Loose = Record<string, any>;

/**
 * One audit pass over two hosts, with the store, the sweep, the host pass and the
 * host-wait settlement real. Only the work each pass would start is recorded, so a
 * test reads what the pass decided without a run of its own.
 */
function fixture(t: TestContext, adapter: Loose = {}) {
  const store = new Store(":memory:");
  const processed: string[] = [];
  const settled: string[] = [];
  const engine = new Engine(store, adapter as unknown as Adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 0);
  const add = (hostId: string, title: string) => {
    const inserted = store.insert(
      submission({
        title,
        repoPath: `/synthetic/${title.replace(/\W+/g, "-")}`,
      }),
      hostId,
      "handoff.md",
      "b".repeat(40),
    );
    return store.update(inserted.id, { phase: "working" }, "dispatched");
  };
  const offline = add(OFFLINE_HOST, "BB task");
  const healthy = add(HEALTHY_HOST, "Paseo task");
  engine.hostIds = () => [OFFLINE_HOST, HEALTHY_HOST];
  engine.hostAvailable = () => true;
  engine.lastHookCleanupAt = Date.now();
  engine.migrateProjectOwnersToPlanners = async () => {};
  engine.clearRetiredInvalidations = () => {};
  engine.resumePausedStops = async () => {};
  engine.recoverExhaustedWorkers = async () => {
    for (const task of [offline, healthy])
      if (engine.taskHostAvailable(store.task(task.id)))
        processed.push(`recover:${task.id}`);
  };
  engine.archiveRetiredErroredAgents = async () => {};
  engine.applyDeferredOwnerVerbs = async () => {};
  engine.deliverPendingBriefAmendments = async () => {};
  engine.continueAwaitingReviewers = async () => {};
  engine.lifecycle.enqueuePass = async () => {};
  engine.resolution.origins.pass = async () => {};
  engine.resolution.observationTargets = () => [];
  engine.resolution.observe = async () => {};
  engine.scheduleTaskQuantum = async (taskId) => {
    processed.push(`quantum:${taskId}`);
  };
  engine.dispatchQueued = async () => {
    for (const task of [offline, healthy])
      if (engine.taskHostAvailable(store.task(task.id)))
        processed.push(`dispatch:${task.id}`);
  };
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
  ] as const)
    (engine.resolution as Loose)[method] = async () => {};
  const transportDeferred = (taskId: string, hostId: string) =>
    engine.resolution.transportDeferred(
      store.task(taskId),
      new Error(`Transport not connected: host ${hostId} is unavailable`),
    );
  return {
    store,
    engine,
    offline,
    healthy,
    processed,
    settled,
    add,
    transportDeferred,
  };
}

test("a host transport failure waits only that host while the sweep processes healthy-host work", async (t) => {
  const f = fixture(t);
  f.engine.withHost = ((hostId: string, work: () => unknown) => {
    if (hostId === OFFLINE_HOST)
      throw new HostTransportFault(
        hostId,
        new Error(`Transport not connected: host ${hostId} is unavailable`),
      );
    return work();
  }) as typeof f.engine.withHost;

  const result = await f.engine.auditPass(true);

  assert.equal(result.fault, null);
  assert.equal(f.store.getMeta("engineError"), "");
  assert.equal(
    f.store.task(f.offline.id).resolution.stop?.reason,
    "host_unavailable",
  );
  assert.match(
    f.store.task(f.offline.id).resolution.stop?.detail ?? "",
    /BB host aaaaaaaa/,
  );
  assert.ok(
    f.processed.includes(`recover:${f.healthy.id}`),
    "healthy-host recovery is considered in the same pass",
  );
  assert.ok(
    f.processed.includes(`quantum:${f.healthy.id}`),
    "healthy-host lifecycle work runs in the same pass",
  );
  assert.ok(
    f.processed.includes(`dispatch:${f.healthy.id}`),
    "healthy-host dispatch runs in the same pass",
  );
  assert.equal(
    f.processed.some((entry) => entry.endsWith(f.offline.id)),
    false,
    "offline-host work does not start",
  );
});

test("a host whose pass failed at the transport boundary keeps its own waits while the other host settles its own", async (t) => {
  // The registry claims both hosts are connected; only one client answers a step.
  const f = fixture(t, {
    reconcileReportedSettlements: async () => {
      const host = f.engine.activeHostId;
      if (host === OFFLINE_HOST)
        throw new Error(`Transport not connected: host ${host} is unavailable`);
      f.settled.push(`settlements:${host}`);
    },
    reconcileThreadTitles: () => {
      f.processed.push("titles");
    },
  });
  f.transportDeferred(f.offline.id, OFFLINE_HOST);
  f.transportDeferred(f.healthy.id, HEALTHY_HOST);
  for (const id of [f.offline.id, f.healthy.id])
    assert.equal(
      f.store.task(id).resolution.stop?.reason,
      "host_unavailable",
      "both waits are stored host waits",
    );

  const result = await f.engine.auditPass(true);

  assert.equal(result.fault, null);
  assert.equal(f.store.getMeta("engineError"), "");
  assert.match(
    String(f.store.getMeta("hostPassError")),
    /reconcileReportedSettlements: Transport not connected/,
  );
  assert.deepEqual(
    f.settled,
    [`settlements:${HEALTHY_HOST}`],
    "the answering host's step ran; the other host's did not",
  );
  assert.ok(
    f.processed.includes("titles"),
    "the host's later steps still ran past the transport failure",
  );
  assert.equal(
    f.store.task(f.healthy.id).resolution.stop,
    null,
    "the host that answered settles its own wait",
  );
  assert.equal(f.store.task(f.healthy.id).resolution.hostWait, null);
  assert.equal(
    f.store.task(f.offline.id).resolution.stop?.reason,
    "host_unavailable",
    "the host that did not answer keeps its own wait",
  );
  assert.ok(
    f.store.task(f.offline.id).resolution.hostWait,
    "and keeps its own host wait",
  );
  assert.ok(
    f.processed.includes(`quantum:${f.healthy.id}`),
    "the healthy task is still visited",
  );
  assert.equal(
    f.processed.some((entry) => entry === `quantum:${f.offline.id}`),
    false,
    "the unanswered host's task is not started",
  );
});

test("a transport failure inside the failover pass answers for one host and leaves the pass standing", async (t) => {
  const f = fixture(t);
  f.engine.recoverExhaustedWorkers = async () => {
    throw new HostTransportFault(
      OFFLINE_HOST,
      new Error(`Transport not connected: host ${OFFLINE_HOST} is unavailable`),
    );
  };

  const result = await f.engine.auditPass(true);

  assert.equal(result.fault, null, "the fleet pass is not the failing host");
  assert.equal(f.store.getMeta("engineError"), "");
  assert.match(
    String(f.store.getMeta("hostPassError")),
    /recoverExhaustedWorkers: Transport not connected/,
  );
  assert.ok(
    f.processed.includes(`quantum:${f.healthy.id}`),
    "the other host's tasks are still visited",
  );
  assert.ok(f.processed.includes(`dispatch:${f.healthy.id}`), "and dispatched");
});

test("a host fault in a fleet step leaves other hosts running and clears on return", async (t) => {
  let offline = true;
  const f = fixture(t);
  const t3 = f.add("t3code:primary", "T3 task");
  f.engine.hostIds = () => [OFFLINE_HOST, HEALTHY_HOST, t3.hostId!];
  f.engine.resolveHostAdapter = (host) =>
    ({
      notify: async () => {
        if (host === OFFLINE_HOST && offline)
          throw new Error(
            `Transport not connected: host ${host} is unavailable`,
          );
      },
    }) as unknown as Adapter;
  f.engine.resolution.deliverNotices = async () => {
    await f.engine.withHost(OFFLINE_HOST, () =>
      f.engine.adapter.notify!("recipient", "notice", "body"),
    );
  };

  const first = await f.engine.auditPass(true);
  assert.equal(first.fault, null);
  assert.equal(f.store.getMeta("engineError"), "");
  assert.ok(
    first.visited.has(f.offline.id) &&
      first.visited.has(f.healthy.id) &&
      first.visited.has(t3.id),
  );
  assert.equal(
    f.store.task(f.offline.id).resolution.stop?.reason,
    "host_unavailable",
  );
  assert.match(
    f.store.task(f.offline.id).resolution.stop?.detail ?? "",
    /Transport not connected/,
  );
  assert.ok(f.processed.includes(`quantum:${f.healthy.id}`));
  assert.ok(f.processed.includes(`quantum:${t3.id}`));
  assert.ok(f.processed.includes(`dispatch:${f.healthy.id}`));

  offline = false;
  await f.engine.auditPass(true);
  assert.equal(f.store.task(f.offline.id).resolution.hostWait, null);
  assert.equal(f.store.task(f.offline.id).resolution.stop, null);
  assert.ok(f.processed.includes(`quantum:${f.offline.id}`));
});

test("a non-host fleet failure still records engineError", async (t) => {
  const f = fixture(t);
  f.engine.resolution.deliverNotices = async () => {
    throw new Error("store invariant failed");
  };
  const result = await f.engine.auditPass(true);
  assert.match(result.fault?.message ?? "", /store invariant failed/);
  assert.match(
    String(f.store.getMeta("engineError")),
    /store invariant failed/,
  );
});

test("a host fault preserves an owner stop through outage and return", async (t) => {
  const f = fixture(t);
  f.engine.resolution.recordStop(
    f.store.task(f.offline.id),
    "awaiting_proof",
    "Awaiting proof decision",
  );
  let failing = true;
  f.engine.resumePausedStops = async () => {
    if (failing)
      throw new HostTransportFault(
        OFFLINE_HOST,
        new Error("plugin build mismatch"),
      );
  };
  await f.engine.auditPass(true);
  assert.equal(
    f.store.task(f.offline.id).resolution.stop?.reason,
    "awaiting_proof",
  );
  assert.equal(
    f.store.task(f.offline.id).resolution.stop?.detail,
    "Awaiting proof decision",
  );
  assert.ok(f.store.task(f.offline.id).resolution.hostWait);
  failing = false;
  await f.engine.auditPass(true);
  assert.equal(f.store.task(f.offline.id).resolution.hostWait, null);
  assert.equal(
    f.store.task(f.offline.id).resolution.stop?.reason,
    "awaiting_proof",
  );
  assert.equal(
    f.store.task(f.offline.id).resolution.stop?.detail,
    "Awaiting proof decision",
  );
});

test("an observation fault preserves an owner stop and holds the host until the next pass", async (t) => {
  let online = false;
  const adapter = {
    observe: async (id: string) => {
      if (!online)
        throw new Error("Transport not connected: observation failed");
      return {
        id,
        workspaceId: "workspace",
        status: "running",
        active: true,
        permissions: false,
        error: "",
      };
    },
  };
  const f = fixture(t, adapter);
  const task = f.store.update(f.offline.id, { workspaceId: "workspace" });
  f.engine.resolution.recordStop(
    task,
    "awaiting_proof",
    "Awaiting proof decision",
  );
  const run = runSchema.parse({
    id: "review-run",
    taskId: task.id,
    hostId: OFFLINE_HOST,
    role: "reviewer",
    generation: 1,
    head: "6".repeat(40),
    base: "7".repeat(40),
    agentId: "reviewer",
    workspaceId: "workspace",
    profile: null,
    status: "running",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: null,
    idleSince: null,
    released: false,
    completion: null,
  });
  f.store.putRun(run);
  f.engine.resolution.observe = (inventory, taskId, released) =>
    f.engine.resolution.observation.observe(inventory, taskId, released);
  const first = await f.engine.auditPass(true);
  assert.equal(first.fault, null);
  assert.equal(f.store.task(task.id).resolution.stop?.reason, "awaiting_proof");
  assert.ok(f.store.task(task.id).resolution.hostWait);
  assert.equal(f.processed.includes(`quantum:${task.id}`), false);
  assert.ok(f.processed.includes(`quantum:${f.healthy.id}`));
  online = true;
  await f.engine.auditPass(true);
  assert.equal(f.store.task(task.id).resolution.hostWait, null);
  assert.equal(f.store.task(task.id).resolution.stop?.reason, "awaiting_proof");
});

test("a disconnected host does not skip another host’s retired-agent cleanup", async (t) => {
  const archived: string[] = [];
  const adapter = {
    observe: async (id: string) => ({
      id,
      workspaceId: "workspace",
      status: "error",
      active: false,
      permissions: false,
      error: "failed",
    }),
    archiveAgent: async (id: string) => {
      archived.push(id);
    },
  };
  const f = fixture(t, adapter);
  f.add(OFFLINE_HOST, "BB newest");
  f.store.update(f.healthy.id, {
    workspaceId: "workspace",
    retiredWorkers: [
      {
        agentId: "retired",
        runId: "old",
        profile: profile("worker"),
        reason: "replaced",
      },
    ],
  });
  f.engine.resolveHostAdapter = (host) =>
    host === OFFLINE_HOST ? undefined : (adapter as unknown as Adapter);
  const result = await f.engine.auditPass(true);
  assert.equal(result.fault, null);
  assert.deepEqual(archived, ["retired"]);
  assert.equal(f.store.getMeta("engineError"), "");
});

test("queued dispatch contains one host fault and retains other starts", async (t) => {
  const f = fixture(t);
  const t3 = f.add("t3code:primary", "T3 queued");
  for (const task of [f.offline, f.healthy, t3])
    f.store.update(task.id, { phase: "queued" });
  f.store.setMeta("globalLimit", 5);
  const sent: string[] = [];
  f.engine.dispatchTask = async (id) => {
    if (id === f.offline.id)
      throw new HostTransportFault(
        OFFLINE_HOST,
        new Error("plugin build mismatch"),
      );
    sent.push(id);
  };
  await f.engine.dispatchOwner.dispatchQueued();
  assert.deepEqual(new Set(sent), new Set([f.healthy.id, t3.id]));
  assert.equal(
    f.store.task(f.offline.id).resolution.stop?.reason,
    "host_unavailable",
  );
  assert.match(
    f.store.task(f.offline.id).resolution.stop?.detail ?? "",
    /plugin build mismatch/,
  );
});

test("dispatch host broadcast does not replace another task’s owner stop", async (t) => {
  const f = fixture(t);
  const protectedTask = f.add(OFFLINE_HOST, "BB budget stop");
  f.engine.resolution.recordStop(
    protectedTask,
    "budget",
    "Awaiting budget decision",
  );
  f.store.update(f.offline.id, { phase: "queued" });
  f.store.setMeta("globalLimit", 3);
  f.engine.dispatchTask = async (id) => {
    if (id === f.offline.id)
      throw new HostTransportFault(OFFLINE_HOST, new Error("refused"));
  };
  await f.engine.dispatchOwner.dispatchQueued();
  const current = f.store.task(protectedTask.id);
  assert.equal(current.resolution.stop?.reason, "budget");
  assert.equal(current.resolution.stop?.detail, "Awaiting budget decision");
  assert.ok(current.resolution.hostWait);
});

test("an unavailable first queue head gives the free slot to a healthy host", async (t) => {
  const f = fixture(t);
  for (const task of [f.offline, f.healthy])
    f.store.update(task.id, { phase: "queued" });
  f.store.setMeta("globalLimit", 1);
  const attempted: string[] = [];
  f.engine.dispatchTask = async (id) => {
    attempted.push(id);
    if (id === f.offline.id)
      throw new HostTransportFault(
        OFFLINE_HOST,
        new Error("plugin build mismatch"),
      );
  };
  await f.engine.dispatchOwner.dispatchQueued();
  assert.deepEqual(attempted, [f.offline.id, f.healthy.id]);
});
