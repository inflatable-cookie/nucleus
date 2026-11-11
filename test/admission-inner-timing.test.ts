import test from "node:test";
import assert from "node:assert/strict";
import { Admission, AdmissionDeferred, admitAdapter } from "../core/host/admission";
import { paseoCall, timedDaemonRequests, withPaseoCallTiming } from "../hosts/paseo/adapter/paseo-call-timing";
import type { Adapter } from "../core/host";

// Tom, 2026-10-23: "Paseo calls only". An archive keeps its admission gate,
// slot, key and refusals, but only the Paseo requests inside it are timed.

const deferred = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(cleanupLimit?: number) {
  const clock = { now: 0 };
  const admission = new Admission({ now: () => clock.now, startIntervalMs: 0, observationCacheMs: 0,
    ...(cleanupLimit === undefined ? {} : { limits: { cleanup: cleanupLimit } }) });
  const raw: Record<string, unknown> = {};
  let admitted: Adapter | undefined; // admitAdapter wraps the methods present when it runs
  /** A Paseo request taking `ms` of the fake clock. */
  const request = (ms: number, value: unknown = ms) => paseoCall(async () => { clock.now += ms; return value; });
  const cleanup = () => admission.snapshot().latency.cleanup;
  return { clock, admission, raw, request, cleanup, backpressure: () => admission.snapshot().backpressure,
    get adapter() { return admitted ??= admitAdapter(raw as unknown as Adapter, admission); } };
}

const archive = (adapter: Adapter, id: string) =>
  (adapter.archiveTaskWorkspace as (...args: unknown[]) => Promise<unknown>)({ id: `task-${id}` }, id, `/dir/${id}`);

test("the default cleanup gate admits four archives and keeps a fifth waiting", async () => {
  const f = fixture();
  const hold = deferred();
  const started: string[] = [];
  f.raw.archiveTaskWorkspace = async (_task: unknown, id: string) => { started.push(id); await hold.promise; return []; };
  const calls = ['a', 'b', 'c', 'd', 'e'].map(id => archive(f.adapter, id));
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c', 'd']);
  hold.resolve();
  await Promise.all(calls);
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
});

test("long Git and filesystem work inside an archive is not Paseo latency", async () => {
  const f = fixture();
  f.raw.archiveTaskWorkspace = async () => {
    await f.request(100);
    f.clock.now += 60_000; // local Git, build output and worktree removal
    await f.request(200);
    return [];
  };
  for (const id of ["a", "b", "c"]) await archive(f.adapter, id);
  assert.equal(f.backpressure().degraded, false);
  assert.equal(f.backpressure().warning, "");
  assert.deepEqual({ samples: f.cleanup().samples, max: f.cleanup().maxMs }, { samples: 6, max: 200 });
  assert.equal(f.admission.snapshot().cleanup.completed, 3, "completion still counts whole archives");
});

test("three slow Paseo requests inside workspace archives never trip the breaker", async () => {
  const f = fixture();
  let started = 0;
  f.raw.archiveTaskWorkspace = async () => { started++; await f.request(10_000); return []; };
  for (const id of ["a", "b", "c"]) await archive(f.adapter, id);
  // A workspace archive legitimately runs for minutes, so its duration is not
  // evidence that Paseo stopped answering (measured median 238 s on 2026-11-05).
  assert.equal(f.backpressure().degraded, false);
  assert.equal(f.admission.workspaceAdmission(0).admitted, true, "nothing is deferred for it");
  assert.deepEqual({ samples: f.cleanup().samples, max: f.cleanup().maxMs }, { samples: 3, max: 10_000 }, "latency is still recorded");
  assert.match(f.backpressure().warning, /observed at 10000 ms \(threshold 10000 ms; a workspace archive is breaker-exempt\)/);
  await archive(f.adapter, "d");
  assert.equal(started, 4, "a fourth archive is admitted");
});

test("slow observation, title and archive-thread calls still trip the breaker", async () => {
  const f = fixture();
  f.raw.observe = async (id: string) => { await f.request(10_000); return { id, active: false, permissions: false, status: "running", workspaceId: "w" }; };
  for (const id of ["x", "y"]) await f.adapter.observe!(id);
  assert.equal(f.backpressure().degraded, false, "two slow calls are a warning, not a trip");
  await f.adapter.observe!("z");
  assert.equal(f.backpressure().degraded, true);
  assert.match(f.backpressure().reason, /3 slow critical Paseo calls in 60s: observation 10000 ms, observation 10000 ms, observation 10000 ms/);
  assert.equal(f.admission.workspaceAdmission(0).admitted, false, "a genuinely slow Paseo still defers new workspaces");
  // An archive thread answers in under a second; its slowness is still Paseo's.
  const threads = fixture();
  threads.raw.archiveAgent = async () => { await threads.request(10_000); };
  for (const id of ["a", "b", "c"]) await threads.adapter.archiveAgent!(id);
  assert.equal(threads.backpressure().degraded, true);
  assert.match(threads.backpressure().reason, /cleanup 10000 ms/);
});

test("a stuck workspace archive still shows in admission state and holds only its own slot", async () => {
  const f = fixture(2);
  const hold = deferred();
  const started: string[] = [];
  f.raw.archiveTaskWorkspace = async (_task: unknown, id: string) => {
    started.push(id);
    if (id === "stuck") { await paseoCall(() => hold.promise); return []; }
    await f.request(5);
    return [];
  };
  const stuck = archive(f.adapter, "stuck");
  await tick();
  // The other cleanup slot keeps working: one stuck archive does not stop the lane.
  await archive(f.adapter, "b");
  await archive(f.adapter, "c");
  assert.deepEqual(started, ["stuck", "b", "c"]);
  f.clock.now += 20_000;
  const snapshot = f.admission.snapshot();
  assert.equal(snapshot.cleanup.running, 1, "the stuck archive still holds exactly its slot");
  assert.equal(snapshot.cleanup.completed, 2);
  assert.match(f.backpressure().warning, /Paseo cleanup call pending for 200\d\d ms \(threshold 10000 ms; a workspace archive is breaker-exempt\)/);
  assert.equal(f.backpressure().degraded, false, "a long archive is a warning, not a degraded Paseo");
  hold.resolve();
  await stuck;
  assert.equal(f.admission.snapshot().cleanup.running, 0);
});

test("a pending workspace archive does not hold the breaker's recovery", async () => {
  const f = fixture();
  const hold = deferred();
  f.raw.archiveTaskWorkspace = async () => { await paseoCall(() => hold.promise); return []; };
  const stuck = archive(f.adapter, "a");
  await tick();
  // The trip happens while the archive is already running, as the live daemon's
  // did: three slow inventory reads inside the window.
  for (let i = 0; i < 3; i++) await f.admission.run("inventory", async () => { f.clock.now += 11_000; });
  assert.equal(f.backpressure().degraded, true);
  f.clock.now += 40_000; // past the quiet period
  f.raw.observe = async (id: string) => { await f.request(10); return { id, active: false, permissions: false, status: "running", workspaceId: "w" }; };
  for (const id of ["x", "y", "z"]) await f.adapter.observe!(id);
  assert.equal(f.backpressure().degraded, false, "an overdue archive request is not an overdue probe");
  hold.resolve();
  await stuck;
});

test("an archive waiting for the cleanup slot is refused when the breaker trips meanwhile", async () => {
  const f = fixture(1);
  const hold = deferred();
  const started: string[] = [];
  f.raw.archiveTaskWorkspace = async (_task: unknown, id: string) => { started.push(id); if (id === "a") await hold.promise; return []; };
  f.raw.observe = async (id: string) => { await f.request(10_000); return { id, active: false, permissions: false, status: "running", workspaceId: "w" }; };
  const first = archive(f.adapter, "a");
  const second = archive(f.adapter, "b");
  await tick();
  assert.deepEqual(started, ["a"], "the second archive waits for the single cleanup slot");
  for (const id of ["x", "y", "z"]) await f.adapter.observe!(id);
  assert.equal(f.backpressure().degraded, true);
  hold.resolve();
  await first;
  await assert.rejects(second, (error: unknown) => error instanceof AdmissionDeferred && error.code === "backpressure");
  assert.deepEqual(started, ["a"]);
});

test("only an outstanding Paseo request inside an archive is a pending call", async () => {
  const f = fixture();
  const local = deferred(), sdk = deferred(), done = deferred();
  f.raw.archiveTaskWorkspace = async () => {
    await local.promise;
    await paseoCall(() => sdk.promise);
    await done.promise;
    return [];
  };
  const running = archive(f.adapter, "a");
  await tick();
  f.clock.now += 20_000;
  assert.equal(f.backpressure().warning, "", "long local work holds the slot without a pending Paseo call");
  assert.equal(f.admission.snapshot().cleanup.running, 1);
  local.resolve();
  await tick();
  f.clock.now += 11_000;
  assert.match(f.backpressure().warning, /Paseo cleanup call pending for 11000 ms/);
  sdk.resolve();
  await tick();
  assert.match(f.backpressure().warning, /Paseo cleanup call observed at 11000 ms/);
  f.clock.now += 30_000;
  done.resolve();
  await running;
  assert.equal(f.cleanup().samples, 1);
  assert.equal(f.backpressure().degraded, false);
});

test("a failed or timed-out Paseo request is recorded once, settles its pending call, and timeout is never success", async () => {
  const f = fixture();
  const late = deferred<string>();
  f.raw.archiveTaskWorkspace = async (_task: unknown, id: string) => {
    if (id === "fail") await paseoCall(async () => { f.clock.now += 12_000; throw Error("refused by Paseo"); });
    // A caller-side timeout abandons the read; the request itself is still outstanding.
    await Promise.race([paseoCall(() => late.promise), new Promise((_, reject) => setImmediate(() => reject(Error("read timed out"))))]);
    return [];
  };
  await assert.rejects(archive(f.adapter, "fail"), /refused by Paseo/);
  assert.deepEqual({ samples: f.cleanup().samples, max: f.cleanup().maxMs }, { samples: 1, max: 12_000 });
  assert.match(f.backpressure().warning, /observed at 12000 ms/);
  await assert.rejects(archive(f.adapter, "timeout"), /read timed out/);
  f.clock.now += 15_000;
  assert.match(f.backpressure().warning, /Paseo cleanup call pending for 15000 ms/, "an abandoned request still counts as outstanding");
  late.resolve("late");
  await tick();
  assert.equal(f.cleanup().samples, 2);
  assert.equal(f.backpressure().degraded, false, "two slow samples do not trip");
  assert.doesNotMatch(f.backpressure().warning, /pending/);
});

test("a transport failure inside an archive trips once and is recorded as one sample", async () => {
  const f = fixture();
  f.raw.archiveTaskWorkspace = async () => { await paseoCall(async () => { f.clock.now += 5; throw Error("Transport not connected"); }); };
  await assert.rejects(archive(f.adapter, "a"), /Transport not connected/);
  assert.equal(f.backpressure().degraded, true);
  assert.equal(f.backpressure().reason, "Paseo cleanup transport is unavailable");
  assert.equal(f.cleanup().samples, 1);
});

test("timing contexts are isolated across concurrent archive and other admitted work, and nested helpers sample once", async () => {
  const f = fixture();
  const gate = deferred();
  f.raw.archiveTaskWorkspace = async () => {
    await paseoCall(() => paseoCall(async () => { f.clock.now += 50; })); // a helper wrapping a request
    await gate.promise;
    await f.request(70);
    return [];
  };
  f.raw.observe = async (id: string) => {
    await f.request(30); // a whole-call class: its inner request is not sampled again
    return { id, active: false, permissions: false, status: "running", workspaceId: "w" };
  };
  const running = archive(f.adapter, "a");
  await tick();
  // Unrelated work started while the archive's context is live inherits nothing.
  await f.adapter.observe("agent");
  await f.request(40); // no admitted run at all: passes straight through
  gate.resolve();
  await running;
  const snapshot = f.admission.snapshot();
  assert.deepEqual({ samples: f.cleanup().samples, max: f.cleanup().maxMs }, { samples: 2, max: 70 });
  assert.equal(snapshot.latency.observation.samples, 1);
});

test("a request an archive leaves behind after it settles is not that archive's sample", async () => {
  const f = fixture();
  const later = deferred();
  let stray: Promise<unknown> | undefined;
  f.raw.archiveTaskWorkspace = async () => {
    stray = later.promise.then(() => f.request(10_000));
    await f.request(10);
    return [];
  };
  await archive(f.adapter, "a");
  later.resolve();
  await stray;
  assert.equal(f.cleanup().samples, 1);
  assert.equal(f.backpressure().warning, "");
});

test("outside an inner-timed run a Paseo request passes arguments, results and errors through unchanged", async () => {
  const error = Error("as thrown");
  assert.equal(await paseoCall(async () => 42), 42);
  await assert.rejects(paseoCall(async () => { throw error; }), (seen: unknown) => seen === error);
  let recorded = 0;
  const record = <T>(request: () => Promise<T>) => { recorded++; return request(); };
  assert.equal(await withPaseoCallTiming(record, () => paseoCall(async () => "inside")), "inside");
  assert.equal(await withPaseoCallTiming(record, () => withPaseoCallTiming(undefined, () => paseoCall(async () => "cleared"))), "cleared");
  assert.equal(recorded, 1);
});

test("a non-archive admitted class still times its whole call", async () => {
  const f = fixture();
  f.raw.setTaskWorkspaceTitle = async () => { f.clock.now += 10_000; };
  for (let i = 0; i < 3; i++) await (f.adapter.setTaskWorkspaceTitle as (task: unknown) => Promise<void>)({ id: `t${i}` });
  assert.equal(f.admission.snapshot().latency.title.samples, 3);
  assert.equal(f.backpressure().degraded, true);
});

test("workspace admission reports how long a creation waits for its slot", async () => {
  const f = fixture();
  const hold = deferred();
  const first = f.admission.run("workspace", () => hold.promise);
  await tick();
  const progress: string[] = [];
  let waitMs = -1;
  const second = f.admission.run("workspace", async () => undefined, undefined, {
    onWaiting: () => progress.push("waiting"),
    onAdmitted: elapsed => { progress.push("admitted"); waitMs = elapsed; },
  });
  await tick();
  f.clock.now += 42;
  hold.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(progress, ["waiting", "admitted"]);
  assert.equal(waitMs, 42);
});

test("workspace creation gets priority over queued background observations", async () => {
  const admission = new Admission({ totalLimit: 1, startIntervalMs: 0 });
  const hold = deferred();
  const started: string[] = [];
  const first = admission.run("observation", async () => { started.push("first-observation"); await hold.promise; });
  await tick();
  const observation = admission.run("observation", async () => { started.push("queued-observation"); });
  const workspace = admission.run("workspace", async () => { started.push("workspace"); });
  hold.resolve();
  await Promise.all([first, observation, workspace]);
  assert.deepEqual(started, ["first-observation", "workspace", "queued-observation"]);
});

test("the timed daemon client times only its single-request methods, inside an inner-timed run, and is otherwise the client itself", async () => {
  const f = fixture();
  class Client {
    #requests = 0;
    sent: string[] = [];
    get requests() { return this.#requests; }
    async fetchAgent(input: { agentId: string }) { this.#requests++; f.clock.now += 5; return { agent: { id: input.agentId } }; }
    async fetchAgents(options: { subscribe?: unknown }) { this.#requests++; f.clock.now += 7; return { entries: [], subscribed: Boolean(options.subscribe) }; }
    async archiveWorkspace(id: string) { this.#requests++; f.clock.now += 12_000; throw Error(`archive ${id} refused`); }
    // A composite helper: its own internal request is not a separate timed call.
    async composite() { f.clock.now += 20_000; return this.fetchAgent({ agentId: "inner" }); }
    listen() { return "sync"; }
  }
  const raw = new Client(), client = timedDaemonRequests(raw);
  assert.equal(client.listen, client.listen, "members keep a stable identity");
  assert.equal(client.listen(), "sync", "a synchronous member passes through");
  assert.deepEqual(await client.fetchAgent({ agentId: "outside" }), { agent: { id: "outside" } });
  assert.equal(f.cleanup().samples, 0, "nothing is timed outside an inner-timed run");
  f.raw.archiveTaskWorkspace = async () => {
    await client.fetchAgent({ agentId: "a" });
    assert.deepEqual(await client.fetchAgents({ subscribe: {} }), { entries: [], subscribed: true });
    await client.composite();
    await assert.rejects(client.archiveWorkspace("w"), /archive w refused/);
    return [];
  };
  await archive(f.adapter, "a");
  assert.equal(raw.requests, 5, "private state is reached through the client itself");
  assert.deepEqual({ samples: f.cleanup().samples, max: f.cleanup().maxMs }, { samples: 2, max: 12_000 },
    "the direct request and the failed archive are sampled once each; the subscription and composite helper are not");
  client.sent.push("written");
  assert.deepEqual(raw.sent, ["written"]);
});
