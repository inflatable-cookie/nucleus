import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QueueRuntime } from "../service/runtime-owner";
import { Store } from "../core/store/store";
import { callCatalogueMethod } from "../service/transport/dispatch";
import { hostIdFromDataDir } from "../shared/host-operation";
import { submissionSchema, type Run } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";

/*
 * Settings → Hosts (nucleus#1325). The catalogue is the real stored `hostRegistry`
 * shape (`{id, endpoint}`), BB registers through the runtime's own identity path and
 * every removal runs the real `host.remove` catalogue route. IDs are synthetic.
 */

const PASEO = "paseo-primary";
const RETIRED_T3 = "t3code:env-retired";
const RETIRED_T3_ENDPOINT = "ws://127.0.0.1:3773/ws";
const base = "a".repeat(40);

async function openRuntime(t: { after: (fn: () => unknown) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "host-settings-"));
  // The real stored catalogue shape: a T3 host Nucleus saw once and never again.
  const seed = new Store(join(dir, "queue.sqlite"));
  seed.setMeta("hostRegistry", [
    { id: RETIRED_T3, endpoint: RETIRED_T3_ENDPOINT },
  ]);
  seed.close();
  const adapter = {
    client: { isConnected: true },
    isConnected: () => true,
    hostId: PASEO,
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "helper.mjs"),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => adapter,
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
    rmSync(dir, { recursive: true, force: true });
  });
  await runtime.started;
  await runtime.bootstrap;
  // A BB host proves its identity, then its executor connection closes.
  const bbDataDir = join(dir, "bb-data");
  const bbHostId = hostIdFromDataDir(bbDataDir);
  const connectedAt = new Date().toISOString();
  const verify = () =>
    runtime.bbHostVerified({
      hostId: bbHostId,
      dataDir: bbDataDir,
      bbVersion: "0.49.0",
      sdkVersion: "0.6.132",
      hostIds: ["host_synthetic"],
      connectedAt: new Date().toISOString(),
    });
  assert.deepEqual(
    runtime.bbHostVerified({
      hostId: bbHostId,
      dataDir: bbDataDir,
      bbVersion: "0.49.0",
      sdkVersion: "0.6.132",
      hostIds: ["host_synthetic"],
      connectedAt,
    }),
    { ok: true },
  );
  runtime.bbHostHeartbeat({ hostId: bbHostId, at: new Date().toISOString() });
  runtime.bbHostReleased({
    hostId: bbHostId,
    connectedAt,
    reason: "the host executor connection closed",
  });
  const remove = (hostId: string, via: string | null = "paseo") =>
    callCatalogueMethod(
      runtime,
      "host.remove",
      { hostId },
      via ? { via } : {},
    ) as Promise<{
      removed: {
        at: string;
        hostId: string;
        endpoint: string;
        surface: string;
      };
    }>;
  const list = () =>
    callCatalogueMethod(runtime, "host.list", {}) as Promise<
      ReturnType<QueueRuntime["hostList"]>
    >;
  return { dir, runtime, bbHostId, bbDataDir, verify, remove, list };
}

test("host.list shows every catalogue host with the health status, its reason, details and the default mark", async (t) => {
  const { runtime, bbHostId, list } = await openRuntime(t);
  const listed = await list();
  assert.deepEqual(
    listed.hosts.map((host) => host.id).sort(),
    [RETIRED_T3, PASEO, bbHostId].sort(),
    "every catalogue host is listed",
  );
  assert.equal(listed.defaultHostKind, "paseo");
  // Status and reason are the health projection's own answer.
  const health = runtime.health().hosts ?? [];
  for (const host of listed.hosts) {
    const healthHost = health.find((entry) => entry.id === host.id)!;
    assert.equal(
      host.state,
      healthHost.state,
      `${host.id} state matches service.health`,
    );
    assert.equal(
      host.reason,
      healthHost.reason,
      `${host.id} reason matches service.health`,
    );
  }
  const paseo = listed.hosts.find((host) => host.id === PASEO)!;
  assert.equal(paseo.state, "online");
  assert.equal(paseo.kind, "paseo");
  assert.equal(paseo.label, "Paseo");
  assert.equal(
    paseo.isDefault,
    true,
    "the operator default (paseo) resolves to the one Paseo host",
  );
  assert.ok(paseo.connectedAt, "an online host says when it connected");
  assert.deepEqual(paseo.removalBlockers, ["Host is online"]);

  const t3 = listed.hosts.find((host) => host.id === RETIRED_T3)!;
  assert.equal(t3.state, "offline");
  assert.equal(t3.reason, "Host is offline");
  assert.equal(t3.endpoint, RETIRED_T3_ENDPOINT);
  assert.equal(t3.isDefault, false);
  assert.equal(t3.connectedAt, undefined);
  assert.deepEqual(
    t3.versions,
    [],
    "a host that reported nothing shows nothing",
  );
  assert.deepEqual(t3.removalBlockers, []);

  const bb = listed.hosts.find((host) => host.id === bbHostId)!;
  assert.equal(bb.kind, "bb");
  assert.equal(bb.state, "offline");
  assert.match(
    bb.reason,
    /closed/,
    "an offline BB host names why, as health does",
  );
  assert.deepEqual(bb.versions, [
    { label: "BB", value: "0.49.0" },
    { label: "SDK", value: "0.6.132" },
  ]);
  assert.ok(bb.heartbeat?.at, "the last heartbeat is kept");
  assert.ok(bb.lastSeenAt, "an offline host says when it was last seen");

  // Switching the default to BB moves the mark.
  await runtime.configureCapacity(
    {
      ...runtime.capacityAuthorityState().effective,
      operatorDefaultHostKind: "bb",
    },
    undefined,
    { via: "paseo" },
  );
  const moved = await list();
  assert.equal(
    moved.hosts.find((host) => host.id === bbHostId)!.isDefault,
    true,
  );
  assert.equal(moved.hosts.find((host) => host.id === PASEO)!.isDefault, false);
});

test("host.remove refuses an online host and a host with a live task, bound run or unsettled effect, naming the reason", async (t) => {
  const { runtime, dir, remove, list } = await openRuntime(t);
  await assert.rejects(
    remove(PASEO),
    /Host paseo-primary cannot be removed: Host is online/,
  );

  const task = runtime.store.insert(
    submissionSchema.parse({
      submissionId: "host-bound",
      title: "Bound to the retired host",
      repoPath: join(dir, "repo"),
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    RETIRED_T3,
    "handoff",
    base,
  );
  const reference = runtime.store.numberFor(task.id)?.reference ?? task.id;
  await assert.rejects(
    remove(RETIRED_T3),
    new RegExp(`cannot be removed: 1 live task \\(${reference}\\)`),
  );
  assert.ok(
    (await list()).hosts
      .find((host) => host.id === RETIRED_T3)!
      .removalBlockers[0]!.startsWith("1 live task"),
    "the confirm names the same reason",
  );

  runtime.store.update(task.id, { phase: "cancelled" });
  runtime.store.putRun({
    id: "run-bound",
    taskId: task.id,
    hostId: RETIRED_T3,
    role: "revision",
    generation: 1,
    head: base,
    agentId: "worker-1",
    workspaceId: "ws-1",
    status: "running",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
  } as unknown as Run);
  await assert.rejects(
    remove(RETIRED_T3),
    new RegExp(`cannot be removed: 1 bound run \\(${reference} revision\\)`),
  );

  runtime.store.putRun({
    ...runtime.store.run("run-bound")!,
    released: true,
  } as Run);
  runtime.store.queueRunProcessCleanup({
    id: "run-bound",
    taskId: task.id,
    hostId: RETIRED_T3,
  });
  await assert.rejects(
    remove(RETIRED_T3),
    new RegExp(
      `cannot be removed: 1 unsettled effect \\(process cleanup for ${reference}: waiting for a process observation; owner should inspect run run-bound and restore process ownership observation; the sweep retries\\)`,
    ),
  );
  assert.deepEqual(
    runtime.hostRegistry
      .known()
      .map((host) => host.id)
      .includes(RETIRED_T3),
    true,
    "a refusal changes nothing",
  );
  assert.equal(
    runtime.store.getMeta("hostRemovals"),
    undefined,
    "a refusal records nothing",
  );
});

test("host.remove forgets an offline, unreferenced host, keeps events and run records, records the caller, and a returning host registers again", async (t) => {
  const { runtime, dir, bbHostId, verify, remove, list } = await openRuntime(t);
  // History on the host: a finished task, its events and a released run.
  const task = runtime.store.insert(
    submissionSchema.parse({
      submissionId: "host-history",
      title: "Finished on the retired host",
      repoPath: join(dir, "repo"),
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    RETIRED_T3,
    "handoff",
    base,
  );
  runtime.store.putRun({
    id: "run-done",
    taskId: task.id,
    hostId: RETIRED_T3,
    role: "revision",
    generation: 1,
    head: base,
    agentId: "worker-1",
    workspaceId: "ws-1",
    status: "finished",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: false,
    idleSince: null,
    completion: null,
    released: true,
  } as unknown as Run);
  runtime.store.update(task.id, { phase: "cancelled" });
  // Cancelling queued the run's process cleanup; it blocks until the sweep settles it
  // (`run-process-cleanup.ts` writes the same intent back with `pending: false`).
  await assert.rejects(
    remove(RETIRED_T3),
    /1 unsettled effect \(process cleanup for /,
  );
  const intent = runtime.store.getMeta<Record<string, unknown>>(
    "runProcessCleanup:run-done",
  )!;
  runtime.store.setMeta("runProcessCleanup:run-done", {
    ...intent,
    pending: false,
  });
  const events = runtime.store.eventsAll(task.id);
  const run = runtime.store.run("run-done");

  const answer = await remove(RETIRED_T3);
  assert.equal(answer.removed.hostId, RETIRED_T3);
  assert.equal(answer.removed.endpoint, RETIRED_T3_ENDPOINT);
  assert.equal(
    answer.removed.surface,
    "paseo",
    "the Settings surface is recorded",
  );
  assert.ok(Date.parse(answer.removed.at));
  assert.equal(
    runtime.hostRegistry.known().some((host) => host.id === RETIRED_T3),
    false,
  );
  assert.deepEqual(
    runtime.store.eventsAll(task.id),
    events,
    "events keep the old host ID untouched",
  );
  assert.deepEqual(
    runtime.store.run("run-done"),
    run,
    "run records keep the old host ID untouched",
  );
  assert.equal(runtime.store.task(task.id).hostId, RETIRED_T3);
  const listed = await list();
  assert.equal(
    listed.hosts.some((host) => host.id === RETIRED_T3),
    false,
  );
  assert.deepEqual(listed.removals, [answer.removed]);
  await assert.rejects(remove(RETIRED_T3), /is not registered/);

  // A removed host that connects again registers again as normal.
  runtime.hostRegistry.connect(
    RETIRED_T3,
    RETIRED_T3_ENDPOINT,
    runtime.hostRegistry.get(PASEO)!,
  );
  assert.ok(
    runtime.hostRegistry.known().some((host) => host.id === RETIRED_T3),
  );

  // A BB host's recorded identity goes with it, so the same server re-proves and registers again.
  const removedBb = await remove(bbHostId, "web");
  assert.equal(removedBb.removed.surface, "web");
  assert.equal(runtime.store.getMeta("bbHostIdentity"), undefined);
  assert.equal(
    runtime.health().bb,
    undefined,
    "health no longer reports the forgotten BB identity",
  );
  assert.deepEqual(verify(), { ok: true });
  assert.ok(
    runtime.hostRegistry.known().some((host) => host.id === bbHostId),
    "the returning BB host registers again",
  );
  assert.equal(
    runtime.health().hosts?.find((host) => host.id === bbHostId)?.state,
    "online",
  );
});

test("host.remove is operator-only: an agent route is refused with nothing changed", async (t) => {
  const { runtime, remove } = await openRuntime(t);
  // The CLI, a task shell and any direct socket client carry no Settings surface.
  await assert.rejects(
    remove(RETIRED_T3, null),
    /host\.remove is refused: only the operator removes a registered host/,
  );
  await assert.rejects(
    remove(RETIRED_T3, "settings"),
    /host\.remove is refused/,
    "a body-claimed or unknown surface is not the Settings transport",
  );
  // The owner handler refuses a missing surface itself, in case a future seam forgets it.
  assert.throws(
    () => runtime.removeHost({ hostId: RETIRED_T3 }),
    /host\.remove is refused/,
  );
  assert.ok(
    runtime.hostRegistry.known().some((host) => host.id === RETIRED_T3),
  );
  assert.equal(runtime.store.getMeta("hostRemovals"), undefined);
  // The Settings route through the Paseo bridge is recorded with its time and surface.
  const answer = await remove(RETIRED_T3, "paseo");
  assert.deepEqual(runtime.store.getMeta("hostRemovals"), [answer.removed]);
});

test("host dependents read by index seek and keep legacy primary ownership (nucleus#1495)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "host-dependents-seek-"));
  const store = new Store(join(dir, "queue.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { hostDependents } = await import("../core/host/host-dependents");
  const insertTask = store.db.prepare(
    "INSERT INTO tasks(id,submission,input_hash,data) VALUES(?,?,?,?)",
  );
  const insertRun = store.db.prepare(
    "INSERT INTO runs(id,taskId,data) VALUES(?,?,?)",
  );
  insertTask.run("legacy", "s1", "h", JSON.stringify({ phase: "running" }));
  insertTask.run(
    "legacy-empty",
    "s1b",
    "h",
    JSON.stringify({ phase: "running", hostId: "" }),
  );
  insertTask.run(
    "other",
    "s2",
    "h",
    JSON.stringify({ phase: "running", hostId: "t3code:env-x" }),
  );
  insertTask.run(
    "settled",
    "s3",
    "h",
    JSON.stringify({ phase: "done", hostId: "t3code:env-x" }),
  );
  insertRun.run("r1", "legacy", JSON.stringify({ role: "worker" }));
  insertRun.run(
    "r1b",
    "legacy-empty",
    JSON.stringify({ role: "worker", hostId: "" }),
  );
  insertRun.run(
    "r2",
    "other",
    JSON.stringify({ role: "worker", hostId: "t3code:env-x" }),
  );
  insertRun.run(
    "r3",
    "settled",
    JSON.stringify({ role: "worker", released: true, hostId: "t3code:env-x" }),
  );
  const names = (id: string, kind: "paseo" | "t3code", primary: boolean) =>
    hostDependents(store, { id, kind, primary })
      .filter((d) => d.kind === "task" || d.kind === "run")
      .map((d) => d.names.length);
  assert.deepEqual(
    names(PASEO, "paseo", true),
    [2, 2],
    "legacy null and empty host records belong to the primary host",
  );
  assert.deepEqual(
    names("t3code:env-x", "t3code", false),
    [1, 1],
    "a qualified host sees only its own live records",
  );
  const checks: Array<{ label: string; sql: string; index: RegExp }> = [
    {
      label: "primary live tasks",
      sql: "SELECT id FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.phase') NOT IN ('done','cancelled') AND COALESCE(json_extract(data,'$.hostId'),'') IN (?1,'') ORDER BY rowid",
      index: /USING INDEX tasks_live_host/,
    },
    {
      label: "non-primary live tasks",
      sql: "SELECT id FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.phase') NOT IN ('done','cancelled') AND COALESCE(json_extract(data,'$.hostId'),'')=?1 ORDER BY rowid",
      index: /USING INDEX tasks_live_host/,
    },
    {
      label: "primary unreleased runs",
      sql: "SELECT runs.id FROM runs JOIN tasks ON tasks.id=runs.taskId WHERE json_extract(tasks.data,'$.removedAt') IS NULL AND COALESCE(json_extract(runs.data,'$.released'),0)=0 AND COALESCE(json_extract(runs.data,'$.hostId'),'') IN (?1,'') ORDER BY runs.rowid",
      index: /USING INDEX runs_unreleased_host/,
    },
    {
      label: "non-primary unreleased runs",
      sql: "SELECT runs.id FROM runs JOIN tasks ON tasks.id=runs.taskId WHERE json_extract(tasks.data,'$.removedAt') IS NULL AND COALESCE(json_extract(runs.data,'$.released'),0)=0 AND COALESCE(json_extract(runs.data,'$.hostId'),'')=?1 ORDER BY runs.rowid",
      index: /USING INDEX runs_unreleased_host/,
    },
    {
      label: "finished tasks owing thread cleanup",
      sql: "SELECT id FROM tasks WHERE json_extract(data,'$.hostId')=? AND json_extract(data,'$.removedAt') IS NULL",
      index: /USING INDEX tasks_identity_host/,
    },
  ];
  for (const check of checks) {
    const plan = store.db
      .prepare(`EXPLAIN QUERY PLAN ${check.sql}`)
      .all("t3code:env-x")
      .map((row) => String(row.detail))
      .join(" | ");
    assert.match(plan, check.index, `${check.label}: ${plan}`);
  }
});
