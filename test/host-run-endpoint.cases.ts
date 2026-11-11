/**
 * Contract 010 "Client protocol v1" server tests (Spec 035 part 3).
 *
 * Every fixture lives in a fresh mktemp; the Unix socket path stays short
 * because macOS caps it at 104 characters. The detached supervisor is replaced
 * by a fake that writes the same durable files, so the endpoint's reattach,
 * settlement and cancel paths are exercised deterministically.
 *
 * This family's fixtures are real sockets, stores and processes, so its cases
 * register through the sharded runner at their measured isolated weights
 * (milestone 5f82e054 at ccea47c2: the single physical file crossed the 120 s
 * unit budget twice and was cancelled before reaching its identity proofs).
 */
import { test, weighted, weightedTiming } from "./support/sharded-test";
import { timingTest } from "./support/timing";
import { HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS } from "./support/budgets";
const timing = weightedTiming(timingTest);
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { HostRunFront } from "../service/executor/host-run-front";
import {
  HostRunEndpoint,
  HOST_RUN_HANDOFF_GAP_MS,
  HOST_RUN_RECONNECT_WINDOW_MS,
  assertHostRunStateDirSafe,
  appendOwnedFile,
  defaultHostRunStateDir,
  hostRunStateDirForDataDir,
  hostRunAuthorityPath,
  hostRunLaunchEnvironment,
  readHostRunLaunchEnv,
  writeHostRunLaunchEnv,
  hostRunProcessStartIdentity,
  hostRunRunDir,
  hostRunSocketAnswers,
  hostRunSocketIsOwnerOnly,
  hostRunSubmitBodySchema,
  hostRunSupervisorPaths,
  hostRunSupervisorPlanSchema,
  hostRunSupervisorStateSchema,
  hostRunTokenKeyPath,
  readCheckedHostRunFile,
  readHostRunAuthority,
  readHostRunTokenKeys,
  hostRunTokenKeysSchema,

  writeAtomicOwnedFile,
  writeVerifiedOwnedFile,
  type HostRunSupervisorPlan,
  type HostRunSupervisorSpawn,
} from "../service/callbacks/host-run-endpoint";
import { frozenHostRunResultSchema } from "./support/contract-010-frozen";
import { mainPrivateHostRunSupervisorStateSchema } from "./support/main-private-records-frozen";
import { HOST_RUN_CPU_COVERAGE_FILE, boundSidecarCoverage } from "../core/host-runs/host-run-cpu-coverage";
import { hostRunResultSchema } from "../shared/contracts";
import { runHostRunSupervisorMain } from "../service/executor/host-run-supervisor";
import { overrideIdentityListing } from "../core/machine/process-group";
import { HOST_RUN_IDENTITY_PROOF_CACHE_MS, hostRunOwnStartIdentity, readHostRunStartIdentity, RecordedIdentityProofs, startIdentityMatches, type StartIdentityRead } from "../core/machine/start-identity";

const capacity = () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });
/**
 * One heavy CPU: an unmeasured run reserves at most half the CPU capacity, never
 * below one, so here a `big` run takes the whole box and a second one queues.
 */
const singleCpu = () => ({ ...capacity(), cpuCapacity: 1 });

// ---------------------------------------------------------------------------
// A fake detached supervisor that writes the same durable files
// ---------------------------------------------------------------------------

interface FakeSupervisor {
  spawn: HostRunSupervisorSpawn;
  plans: Map<string, HostRunSupervisorPlan>;
  spawnCount(): number;
  emit(runId: string, stream: "stdout" | "stderr", text: string): void;
  settle(runId: string, outcome: "passed" | "failed" | "cancelled" | "timed_out"): void;
  stop(): void;
}

function fakeSupervisor(): FakeSupervisor {
  const plans = new Map<string, HostRunSupervisorPlan>();
  const timers = new Map<string, NodeJS.Timeout>();
  const settled = new Set<string>();
  let spawns = 0;
  const writeState = (plan: HostRunSupervisorPlan, patch: Record<string, unknown>) => {
    const now = new Date().toISOString();
    const state = hostRunSupervisorStateSchema.parse({
      format: "host.run.supervisor.state", version: 1, runId: plan.runId, epoch: plan.epoch,
      supervisorPid: process.pid, supervisorStartIdentity: hostRunProcessStartIdentity(process.pid),
      commandPid: 2_100_000_000, commandPgid: 2_100_000_000, commandStartIdentity: "2100000000@fake",
      termination: null, startedAt: plan.startedAt, updatedAt: now, endedAt: null, ...patch,
    });
    writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).statePath, JSON.stringify(state), 0o600);
  };
  const spawn: HostRunSupervisorSpawn = plan => {
    spawns++;
    plans.set(plan.runId, plan);
    appendOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).stdoutPath, "");
    appendOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).stderrPath, "");
    writeState(plan, {});
    const timer = setInterval(() => {
      if (settled.has(plan.runId)) return;
      if (existsSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).cancelPath)) settle(plan.runId, "cancelled");
    }, 10);
    timer.unref?.();
    timers.set(plan.runId, timer);
  };
  const emit = (runId: string, stream: "stdout" | "stderr", text: string) => {
    const plan = plans.get(runId);
    if (!plan) throw new Error(`No fake supervisor for ${runId}`);
    appendOwnedFile(stream === "stdout" ? hostRunSupervisorPaths(plan.stateDir, plan.runId).stdoutPath : hostRunSupervisorPaths(plan.stateDir, plan.runId).stderrPath, text);
  };
  const settle = (runId: string, outcome: "passed" | "failed" | "cancelled" | "timed_out") => {
    const plan = plans.get(runId);
    if (!plan || settled.has(runId)) return;
    settled.add(runId);
    const timer = timers.get(runId);
    if (timer) clearInterval(timer);
    const endedAt = new Date().toISOString();
    const result = hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId, epoch: plan.epoch, pgid: 2_100_000_000, startIdentity: "2100000000@fake",
      exitCode: outcome === "failed" ? 1 : outcome === "passed" ? 0 : null,
      signal: outcome === "passed" || outcome === "failed" ? null : outcome === "timed_out" ? "SIGKILL" : "SIGTERM",
      startedAt: plan.startedAt, endedAt, wallMs: 1, cpuMs: 3, escapedDescendants: [],
    });
    // Result first, then the terminal state: a reader that sees endedAt can always see the result.
    writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, JSON.stringify(result), 0o600);
    writeState(plan, { termination: outcome === "cancelled" ? "cancel" : outcome === "timed_out" ? "timeout" : null, endedAt });
  };
  return { spawn, plans, spawnCount: () => spawns, emit, settle, stop() { for (const timer of timers.values()) clearInterval(timer); timers.clear(); } };
}

// ---------------------------------------------------------------------------
// A small NDJSON client
// ---------------------------------------------------------------------------

function client(socketPath: string) {
  const socket: Socket = connect(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<{ resolve(line: string): void; reject(error: Error): void; timer: NodeJS.Timeout }> = [];
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line); }
      else queued.push(line);
    }
  });
  socket.on("error", error => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  const next = (timeoutMs = HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS): Promise<string> => {
    if (queued.length) return Promise.resolve(queued.shift()!);
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        resolve: resolvePromise,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for a response line"));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  };
  return {
    socket,
    next,
    send(value: unknown) { socket.write(`${JSON.stringify(value)}\n`); },
    sendWithoutReading(value: unknown, timeoutMs = HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS): Promise<void> {
      return new Promise((resolvePromise, reject) => {
        let settled = false;
        const finish = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.off("error", onError);
          if (error) { socket.destroy(); reject(error); }
          else resolvePromise();
        };
        const onError = (error: Error) => finish(error);
        const timer = setTimeout(() => finish(new Error("Timed out waiting for the socket write callback")), timeoutMs);
        socket.once("error", onError);
        socket.write(`${JSON.stringify(value)}\n`, error => finish(error));
      });
    },
    destroy() { socket.destroy(); },
  };
}

interface WireError { code: string; message: string }
interface WireResponse { v: number; id: string; ok: boolean; body?: any; error?: WireError }

async function call(target: ReturnType<typeof client>, method: string, body: unknown, epoch: number, id = randomUUID()): Promise<WireResponse> {
  target.send({ v: 1, id, method, epoch, body });
  return JSON.parse(await target.next()) as WireResponse;
}

function submitBody(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    caller: "effigy@worker-7",
    repository: "example/host-runs",
    cwd: process.cwd(),
    selector: "qa:core",
    argv: ["effigy", "qa:core"],
    class: "heavy",
    classSource: "manifest",
    priority: "interactive",
    budgetFallback: { cpu: 1, memoryBytes: 100_000_000 },
    capacityDeadlineMs: 1_800_000,
    runTimeoutMs: 3_600_000,
    env: { NAME: "value" },
    ...overrides,
  };
}

function readPlan(stateDir: string, runId: string): HostRunSupervisorPlan {
  return hostRunSupervisorPlanSchema.parse(JSON.parse(readFileSync(hostRunSupervisorPaths(stateDir, runId).planPath, "utf8")));
}

interface Harness {
  endpoint: HostRunEndpoint;
  scheduler: HostRunScheduler;
  store: import("../core/store/store").Store;
  stateDir: string;
  fake: FakeSupervisor;
}

async function harness(t: { after(fn: () => void | Promise<void>): void }, options: { reconnectWindowMs?: number; unlaunchedGraceMs?: number; outputRetentionMs?: number; now?: () => number; capacity?: typeof capacity } = {}): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity: options.capacity ?? capacity });
  const fake = fakeSupervisor();
  const endpoint = new HostRunEndpoint(scheduler, {
    stateDir, supervisorSpawn: fake.spawn, env: process.env,
    ...(options.reconnectWindowMs !== undefined ? { reconnectWindowMs: options.reconnectWindowMs } : {}),
    ...(options.unlaunchedGraceMs !== undefined ? { unlaunchedGraceMs: options.unlaunchedGraceMs } : {}),
    ...(options.outputRetentionMs !== undefined ? { outputRetentionMs: options.outputRetentionMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  t.after(async () => { await endpoint.stop(); fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });
  await endpoint.start();
  return { endpoint, scheduler, store, stateDir, fake };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

weighted(4)("the endpoint publishes an owner-only authority file, key file and socket", async t => {
  const f = await harness(t);
  const authority = readHostRunAuthority(f.stateDir);
  assert.ok(authority, "the authority file must be readable under the strict checks");
  assert.equal(authority.epoch, f.scheduler.authority().epoch);
  assert.equal(authority.endpoint, join(f.stateDir, "run", "scheduler.sock"));
  assert.equal(authority.pid, process.pid);
  assert.equal(authority.startIdentity, hostRunProcessStartIdentity(process.pid));
  assert.ok(hostRunSocketIsOwnerOnly(f.stateDir), "the socket is an owner-only socket");

  const keys = readHostRunTokenKeys(f.stateDir);
  assert.ok(keys);
  assert.equal(keys.current.epoch, authority.epoch);
  assert.equal(Buffer.from(keys.current.keyB64, "base64").length, 32);

  // Peer checks fail closed: a relaxed mode, a foreign holder or a symlink is unreachable.
  chmodSync(hostRunAuthorityPath(f.stateDir), 0o644);
  assert.equal(readHostRunAuthority(f.stateDir), null, "a world-readable authority file is refused");
  writeFileSync(hostRunAuthorityPath(f.stateDir), JSON.stringify({ ...authority, holder: "nucleusd" }));
  chmodSync(hostRunAuthorityPath(f.stateDir), 0o600);
  assert.equal(readHostRunAuthority(f.stateDir), null, "a foreign holder is refused");

  unlinkSync(hostRunTokenKeyPath(f.stateDir));
  symlinkSync(hostRunAuthorityPath(f.stateDir), hostRunTokenKeyPath(f.stateDir));
  assert.equal(readHostRunTokenKeys(f.stateDir), null, "a symlinked key file is refused");
});

weighted(3)("an ambiguous submit is resolved through status and never creates a duplicate run", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const body = submitBody();
  await wire.sendWithoutReading({ v: 1, id: "ambiguous", method: "submit", epoch: 1, body });
  wire.destroy();

  await new Promise(resolvePromise => setTimeout(resolvePromise, 80));
  const lookup = client(f.endpoint.socketPath);
  const status = await call(lookup, "status", { caller: body.caller, clientRequestId: body.clientRequestId }, 1);
  assert.equal(status.ok, true);
  const runId = status.body.runId as string;
  assert.ok(runId);
  assert.equal(f.scheduler.list().filter(run => run.caller === body.caller).length, 1, "no duplicate run");

  const again = await call(lookup, "submit", body, 1);
  assert.equal(again.ok, true);
  assert.equal(again.body.runId, runId);
  assert.equal(f.scheduler.list().filter(run => run.caller === body.caller).length, 1);
  const plan = readPlan(f.stateDir, runId);
  const launchEnv = readHostRunLaunchEnv(f.stateDir, runId)!;
  assert.equal(launchEnv.NAME, "value");
  assert.equal(launchEnv.HOST_RUN_ID, runId);
  assert.equal(typeof launchEnv.HOST_RUN_TOKEN, "string");
  assert.equal(launchEnv.PATH, process.env.PATH);
  assert.deepEqual(plan.envKeys, Object.keys(launchEnv).sort());
  assert.ok(!readFileSync(hostRunSupervisorPaths(f.stateDir, runId).planPath, "utf8").includes(launchEnv.HOST_RUN_TOKEN), "the plan never holds env values");
  f.fake.settle(runId, "passed");
  lookup.destroy();
});

weighted(3)("client submit and cancel record only the declared request methods in the journal", async t => {
  // nucleus#074 (2026-10-03): the client path once also wrote host.run.client.submit/cancel.
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const submitted = await call(wire, "submit", submitBody(), 1);
  assert.equal(submitted.ok, true);
  const runId = submitted.body.runId as string;
  const deadline = Date.now() + 5_000;
  while (f.scheduler.get(runId)?.state !== "running" && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.scheduler.get(runId)?.state, "running");
  const cancelled = await call(wire, "cancel", { runId, reason: "test" }, 1);
  assert.equal(cancelled.ok, true);
  const methods = f.store.hostRunJournal(runId).filter(row => row.event === "request").map(row => (row.data as { method: string }).method);
  assert.deepEqual(methods, ["host.run.submit", "host.run.cancel"]);
});

weighted(3)("a repeated clientRequestId with a different body is conflict", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const body = submitBody();
  const first = await call(wire, "submit", body, 1);
  assert.equal(first.ok, true);
  const conflict = await call(wire, "submit", { ...body, selector: "qa:other" }, 1);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error!.code, "conflict");
  f.fake.settle(first.body.runId, "passed");
});

weighted(2)("a request naming a stale epoch is refused", async t => {
  const f = await harness(t);
  f.store.setMeta("hostRunAuthority", { holder: "queue", epoch: 2, endpoint: f.endpoint.socketPath });
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const stale = await call(wire, "submit", submitBody(), 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.error!.code, "stale_epoch");
  assert.equal(f.scheduler.list().length, 0, "a stale submit launches nothing");
});

weighted(2)("a reattach from an offset resumes with no gaps and no duplicates", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  const full = "line-one\nline-two\nline-three\n";
  f.fake.emit(runId, "stdout", full);
  f.fake.emit(runId, "stderr", "warn\n");
  f.fake.settle(runId, "passed");
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);

  const attach = client(f.endpoint.socketPath);
  attach.send({ v: 1, id: "all", method: "attach", epoch: 1, body: { runId } });
  const events = await readAttachUntilSettled(attach);
  assert.deepEqual(events.map(event => event.event), ["state", "output", "output", "settled"]);
  assert.equal(collect(events, "stdout").text, full);
  assert.equal(collect(events, "stderr").text, "warn\n");
  assert.ok(events.filter(event => event.event === "output").every(event => Buffer.from(event.dataB64, "base64").length <= 64 * 1024));
  attach.destroy();

  const offset = Buffer.byteLength("line-one\n", "utf8");
  const reattach = client(f.endpoint.socketPath);
  reattach.send({ v: 1, id: "suffix", method: "attach", epoch: 1, body: { runId, fromOffset: { stdout: offset } } });
  const suffixEvents = await readAttachUntilSettled(reattach);
  assert.equal(collect(suffixEvents, "stdout").text, full.slice(offset));
  reattach.destroy();
  wire.destroy();
});

timing(4)("cancelOnDisconnect: a reconnect inside the window keeps the run; a disconnect outside it cancels", { timeout: 30_000 }, async t => {
  const f = await harness(t, { reconnectWindowMs: 150 });
  const wire = client(f.endpoint.socketPath);
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: true }), 1);
  const runId = submitted.body.runId as string;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 60));

  const first = client(f.endpoint.socketPath);
  first.send({ v: 1, id: "one", method: "attach", epoch: 1, body: { runId } });
  await first.next();
  first.destroy();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 40)); // inside the window
  const reattach = client(f.endpoint.socketPath);
  reattach.send({ v: 1, id: "two", method: "attach", epoch: 1, body: { runId } });
  await reattach.next();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  assert.notEqual(f.scheduler.get(runId)!.state, "settled", "a reattach inside the window keeps the run");

  reattach.destroy();
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(f.scheduler.get(runId)!.settlement!.outcome, "cancelled");
  wire.destroy();
});

timing(4)("a never-launched run whose client left settles cancelled after the grace; a reattach keeps it; a launched run keeps going (papercut 19676b0f)", { timeout: 30_000 }, async t => {
  const f = await harness(t, { unlaunchedGraceMs: 150, capacity: singleCpu });
  const wire = client(f.endpoint.socketPath);
  const big = { cpu: 4, memoryBytes: 1_000_000_000 };
  const running = (await call(wire, "submit", submitBody({ budgetFallback: big, cancelOnDisconnect: false }), 1)).body.runId as string;
  const queued = await call(wire, "submit", submitBody({ budgetFallback: big, cancelOnDisconnect: false }), 1);
  assert.equal(queued.body.state, "queued");
  const queuedId = queued.body.runId as string;
  await waitFor(() => f.scheduler.get(running)!.launchedAt != null, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);

  const first = client(f.endpoint.socketPath);
  first.send({ v: 1, id: "one", method: "attach", epoch: 1, body: { runId: queuedId } });
  await first.next();
  first.destroy();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 40)); // inside the grace
  const reattach = client(f.endpoint.socketPath);
  reattach.send({ v: 1, id: "two", method: "attach", epoch: 1, body: { runId: queuedId } });
  await reattach.next();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  assert.equal(f.scheduler.get(queuedId)!.state, "queued", "a reattach inside the grace keeps the run and its place");

  // The launched run's client leaves too: it keeps going detached.
  const launchedClient = client(f.endpoint.socketPath);
  launchedClient.send({ v: 1, id: "three", method: "attach", epoch: 1, body: { runId: running } });
  await launchedClient.next();
  launchedClient.destroy();
  reattach.destroy();
  await waitFor(() => f.scheduler.get(queuedId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  const settled = f.scheduler.get(queuedId)!;
  assert.equal(settled.settlement!.outcome, "cancelled");
  assert.equal(settled.settlement!.launched, false);
  assert.ok(settled.capacityReleasedAt, "its capacity is released");
  assert.ok(f.store.hostRunJournal(queuedId).some(entry => JSON.stringify(entry.data).includes("client_left_before_launch")), "the cancel names why");
  await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  assert.notEqual(f.scheduler.get(running)!.state, "settled", "a launched run whose client left is never cancelled");
  wire.destroy();
});

timing(4)("a roll keeps an attached never-launched run's grace: the next endpoint cancels it if its client never returns", { timeout: 30_000 }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity: singleCpu });
  const fake = fakeSupervisor();
  const open = async () => {
    const endpoint = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn, env: process.env, unlaunchedGraceMs: 300 });
    await endpoint.start();
    return endpoint;
  };
  let endpoint = await open();
  t.after(async () => { await endpoint.stop(); fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });
  const wire = client(endpoint.socketPath);
  const big = { cpu: 4, memoryBytes: 1_000_000_000 };
  await call(wire, "submit", submitBody({ budgetFallback: big, cancelOnDisconnect: false }), 1);
  const queuedId = (await call(wire, "submit", submitBody({ budgetFallback: big, cancelOnDisconnect: false }), 1)).body.runId as string;
  const attached = client(endpoint.socketPath);
  attached.send({ v: 1, id: "one", method: "attach", epoch: 1, body: { runId: queuedId } });
  await attached.next();
  await endpoint.stop();
  const deadline = JSON.parse(readFileSync(join(stateDir, "runs", queuedId, "disconnect.json"), "utf8"));
  assert.equal(deadline.mode, "unlaunched", "the roll persists the unlaunched grace");
  endpoint = await open();
  await waitFor(() => scheduler.get(queuedId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(scheduler.get(queuedId)!.settlement!.outcome, "cancelled");
  assert.equal(scheduler.get(queuedId)!.settlement!.launched, false);
  wire.destroy(); attached.destroy();
});

weighted(2)("a disconnect deadline that expired while no endpoint ran cancels the run before recovery can launch it (Sol, #577)", async t => {
  let clock = Date.now();
  const f = await harness(t, { now: () => clock, capacity: singleCpu });
  let replacement: HostRunEndpoint | undefined;
  t.after(async () => { await replacement?.stop(); });
  const wire = client(f.endpoint.socketPath);
  const big = { cpu: 4, memoryBytes: 1_000_000_000 };
  const runningId = (await call(wire, "submit", submitBody({ budgetFallback: big, cancelOnDisconnect: false }), 1)).body.runId as string;
  const queuedId = (await call(wire, "submit", submitBody({ budgetFallback: big, cancelOnDisconnect: false }), 1)).body.runId as string;
  assert.equal(f.scheduler.get(queuedId)!.state, "queued");
  const attached = client(f.endpoint.socketPath);
  attached.send({ v: 1, id: "attach", method: "attach", epoch: 1, body: { runId: queuedId } });
  await attached.next();
  await f.endpoint.stop();
  f.scheduler.stop();
  f.fake.stop();
  // Capacity frees while no endpoint runs, and the grace expires.
  f.fake.settle(runningId, "passed");
  f.scheduler.settle(runningId, { format: "host.run.settlement", version: 1, runId: runningId,
    outcome: "passed", launched: true, settledAt: new Date().toISOString(), result: JSON.parse(readFileSync(hostRunSupervisorPaths(f.stateDir, runningId).resultPath, "utf8")), containers: [] });
  clock += 61_000;
  replacement = new HostRunEndpoint(f.scheduler, { stateDir: f.stateDir, supervisorSpawn: f.fake.spawn, now: () => clock });
  await replacement.start();
  const run = f.scheduler.get(queuedId)!;
  assert.equal(run.state, "settled");
  assert.equal(run.settlement!.outcome, "cancelled");
  assert.equal(run.launchedAt, null, "the orphan never launched");
  wire.destroy(); attached.destroy();
});



weighted(7)("token keys survive a same-epoch restart and rotate only on an epoch bump", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  t.after(() => { fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });

  const first = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await first.start();
  const before = readHostRunTokenKeys(stateDir)!;
  await first.stop();

  // A restart at the same epoch reuses the persisted keys, so live tokens stay valid.
  const second = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await second.start();
  assert.deepEqual(readHostRunTokenKeys(stateDir), before, "a same-epoch restart preserves the key file");
  await second.stop();

  // An epoch bump rotates: the old current becomes the previous key.
  store.setMeta("hostRunAuthority", { holder: "queue", epoch: 2, endpoint: null });
  const third = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await third.start();
  const rotated = readHostRunTokenKeys(stateDir)!;
  assert.equal(rotated.current.epoch, 2);
  assert.equal(rotated.previous!.epoch, 1);
  assert.equal(rotated.previous!.keyB64, before.current.keyB64);
  await third.stop();
});

weighted(3)("a second endpoint never takes a live holder's socket, and a lost socket path is rebound", async t => {
  // 2026-10-02: a service test inherited the real HOME, unlinked the live scheduler
  // socket and left Queue serving a deleted path; clients failed with ENOENT.
  const f = await harness(t);
  const socketPath = join(f.stateDir, "run", "scheduler.sock");
  const ino = lstatSync(socketPath).ino;
  const { Store } = await import("../core/store/store");
  const otherStore = new Store(":memory:");
  t.after(() => otherStore.close());
  const intruder = new HostRunEndpoint(new HostRunScheduler(otherStore, { capacity }), { stateDir: f.stateDir, supervisorSpawn: f.fake.spawn });
  await assert.rejects(intruder.start(), /live holder/);
  await intruder.stop();
  assert.equal(lstatSync(socketPath).ino, ino, "the live socket survives the refused start and its stop");
  assert.equal(await hostRunSocketAnswers(socketPath), true);

  unlinkSync(socketPath);
  assert.equal(await hostRunSocketAnswers(socketPath), false);
  assert.equal(await f.endpoint.rebindIfLost(), true, "a missing path is rebound");
  assert.equal(await hostRunSocketAnswers(socketPath), true, "clients reach the endpoint again");
  assert.ok(hostRunSocketIsOwnerOnly(f.stateDir));
  assert.equal(await f.endpoint.rebindIfLost(), false, "an intact socket is left alone");
});

weighted(3)("an unbound endpoint binds only for a dead holder, then rebinds a lost socket in place", async t => {
  // 2026-10-04: a roll that handed the endpoint away and fell back left the process
  // serving queue-service.sock with no host-run endpoint; every heavy run failed
  // closed machine-wide. The serving process must bind when authority names a dead
  // holder and never take a live holder's path.
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "hre-")));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  t.after(() => { fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });
  // Own the directory chain exactly as the endpoint would, without binding.
  mkdirSync(join(stateDir, "run"), { recursive: true, mode: 0o700 });
  const socketPath = join(stateDir, "run", "scheduler.sock");

  // A live foreign holder is named by pid plus start identity; the path itself is free.
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { try { holder.kill("SIGKILL"); } catch { /* already gone */ } });
  assert.ok(holder.pid && holder.pid > 0);
  writeFileSync(hostRunAuthorityPath(stateDir), JSON.stringify({
    format: "host.run.authority", version: 1, holder: "queue", endpoint: socketPath, epoch: 1,
    pid: holder.pid, startIdentity: hostRunProcessStartIdentity(holder.pid),
  }), { mode: 0o600 });

  const endpoint = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  t.after(() => endpoint.stop());
  assert.equal(await endpoint.ensureServing(), false, "a live holder named in authority.json is never taken over");
  assert.match(endpoint.error() ?? "", /live holder/);
  assert.equal(existsSync(socketPath), false, "no socket was bound over a live holder");

  // The named holder exits: the serving process binds and republishes authority.
  holder.kill("SIGTERM");
  await waitForChildExit(holder, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, "test socket holder");
  assert.equal(await endpoint.ensureServing(), true, "a dead holder's endpoint is bound");
  assert.equal(endpoint.serving(), true);
  assert.equal(await hostRunSocketAnswers(socketPath, 500), true);
  assert.ok(hostRunSocketIsOwnerOnly(stateDir));
  const published = readHostRunAuthority(stateDir)!;
  assert.equal(published.pid, process.pid, "authority.json is republished for this process");
  assert.equal(published.startIdentity, hostRunProcessStartIdentity(process.pid));

  // A socket this endpoint bound and then lost is rebound in place.
  unlinkSync(socketPath);
  assert.equal(await endpoint.ensureServing(), true, "a lost socket is rebound");
  assert.equal(await hostRunSocketAnswers(socketPath, 500), true);
  assert.equal(endpoint.serving(), true);
});

weighted(5)("a service restart reattaches an unsettled run and settles it from its durable result", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  t.after(() => { fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });

  const first = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await first.start();
  const wire = client(first.socketPath);
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  assert.equal(scheduler.get(runId)!.state, "running");
  wire.destroy();
  await first.stop(); // the roll: the supervisor outlives this process

  const second = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await second.start();
  const reattach = await call(client(second.socketPath), "status", { runId }, 1);
  assert.equal(reattach.ok, true, "a client reattaches by runId across the roll");
  assert.equal(reattach.body.state, "running");
  assert.equal(scheduler.get(runId)!.state, "running", "an unsettled run is reattached, not relaunched");
  // Contract 010's accepted roll gap: unbind to the next answer inside 5 s. The
  // endpoint journals the names and instants, so the gap is provable, not inferred.
  const events = store.db.prepare("SELECT event,at FROM host_run_journal WHERE event LIKE 'endpoint_%' ORDER BY id").all() as Array<{ event: string; at: string }>;
  const unbound = events.find(event => event.event === "endpoint_unbound");
  const answered = events.find(event => event.event === "endpoint_answered" && Date.parse(event.at) >= Date.parse(unbound!.at));
  assert.ok(unbound && answered, JSON.stringify(events));
  const gapMs = Date.parse(answered.at) - Date.parse(unbound.at);
  assert.ok(gapMs <= HOST_RUN_RECONNECT_WINDOW_MS, `the roll gap ${gapMs} ms exceeds contract 010's ${HOST_RUN_RECONNECT_WINDOW_MS} ms bound`);
  fake.settle(runId, "passed");
  await waitFor(() => scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(scheduler.get(runId)!.settlement!.outcome, "passed");
  assert.equal(scheduler.get(runId)!.settlement!.result!.exitCode, 0);
  await second.stop();

  // A run whose supervisor is gone with no result settles lost, never retried.
  const third = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await third.start();
  const lostSubmission = await call(client(third.socketPath), "submit", submitBody({ cancelOnDisconnect: false, clientRequestId: "lost-run" }), 1);
  const lostId = lostSubmission.body.runId as string;
  const lostPlan = readPlan(stateDir, lostId);
  writeAtomicOwnedFile(hostRunSupervisorPaths(stateDir, lostId).statePath, JSON.stringify(hostRunSupervisorStateSchema.parse({
    format: "host.run.supervisor.state", version: 1, runId: lostId, epoch: 1,
    supervisorPid: 2_147_000_000, supervisorStartIdentity: "2147000000@gone",
    commandPid: 2_147_000_001, commandPgid: 2_147_000_001, commandStartIdentity: "2147000001@gone",
    termination: null, startedAt: lostPlan.startedAt, updatedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  })), 0o600);
  await waitFor(() => scheduler.get(lostId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(scheduler.get(lostId)!.settlement!.outcome, "lost");
  await third.stop();
});

weighted(3)("a staged socket swap keeps the live path answering and journals endpoint_handoff", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-handoff-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  let outgoing: HostRunEndpoint | undefined;
  let incoming: HostRunEndpoint | undefined;
  let probe: { stop(): Promise<void> } | undefined;
  t.after(async () => {
    try { await probe?.stop(); } catch { /* already stopped */ }
    try { await incoming?.stop(); } catch { /* already stopped */ }
    try { await outgoing?.stop(); } catch { /* already stopped */ }
    fake.stop();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  outgoing = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await outgoing.start();
  const socketPath = outgoing.socketPath;
  const submitted = await call(client(socketPath), "submit", submitBody({ class: "heavy", cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  fake.emit(runId, "stdout", "keep\n");

  const refused: string[] = [];
  probe = (() => {
    let running = true;
    const done = (async () => {
      while (running) {
        await new Promise<void>(resolvePromise => {
          const socket = connect(socketPath);
          socket.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code) refused.push(error.code);
            socket.destroy();
            resolvePromise();
          });
          socket.once("connect", () => { socket.destroy(); resolvePromise(); });
        });
        await new Promise(resolvePromise => setTimeout(resolvePromise, 4));
      }
    })();
    return { async stop() { running = false; await done; } };
  })();

  const attached = client(socketPath);
  attached.send({ v: 1, id: randomUUID(), method: "attach", epoch: 1, body: { runId, fromOffset: { stdout: 0, stderr: 0 } } });
  await attached.next(); // state
  await attached.next(); // output

  const started = performance.now();
  // The incoming process's front worker binds its own staged inode and swaps it
  // onto the live path before it opens its store: make-before-break in the
  // owner that accepts, while the outgoing process keeps its own listener.
  const front = await HostRunFront.start({ stateDir, socketPath, takeLivePath: true });
  assert.equal(outgoing.serving(), false, "the outgoing front's inode is no longer the live path");
  assert.equal(await hostRunSocketAnswers(socketPath, 500), true, "the live path answers the incoming front");

  incoming = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn, front });
  await incoming.start();
  await outgoing.stop();
  const incomingStatus = await call(client(socketPath), "status", { runId }, 1);
  assert.equal(incomingStatus.ok, true, JSON.stringify(incomingStatus));
  assert.equal(incomingStatus.body.state, "running");
  const reattach = client(socketPath);
  reattach.send({ v: 1, id: randomUUID(), method: "attach", epoch: 1, body: { runId, fromOffset: { stdout: 0, stderr: 0 } } });
  await reattach.next();
  assert.equal(incoming.heavyFollowerCount(), 1, "an attached heavy run is visible to roll deferral");
  reattach.destroy();
  await probe.stop();
  attached.destroy();
  const elapsed = performance.now() - started;
  assert.ok(!refused.includes("ECONNREFUSED") && !refused.includes("ENOENT"), `live path errors: ${refused.join(",")}`);
  // The contract bound is the probe's: it refused nothing across the swap. This
  // fixture also starts the incoming owner's worker thread inside the measured
  // span (a real roll starts it in the standby, before the drain), so the sanity
  // bound covers that start rather than only the swap.
  assert.ok(elapsed <= HOST_RUN_HANDOFF_GAP_MS + 3_000, `handoff took ${elapsed.toFixed(0)} ms`);

  const events = store.db.prepare("SELECT event,data FROM host_run_journal WHERE event LIKE 'endpoint_%' ORDER BY id").all() as Array<{ event: string; data: string }>;
  const handoffEvent = events.find(event => event.event === "endpoint_handoff");
  assert.ok(handoffEvent, JSON.stringify(events.map(event => event.event)));
  const payload = JSON.parse(handoffEvent.data) as { boundAt?: string; answeredAt?: string; swappedAt?: string };
  assert.ok(payload.boundAt && payload.answeredAt && payload.swappedAt);

  fake.settle(runId, "passed");
  await waitFor(() => scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  await incoming.stop();
});

weighted(2)("a pre-change outgoing that bound the live path unlinks it on close and incoming reasserts on adopt", async t => {
  // Review 5409632769: registered checkout e7d0db8 listens on scheduler.sock
  // directly, so server.close() unlinks the name the incoming inode occupies.
  const stateDir = mkdtempSync(join(tmpdir(), "hre-direct-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  let incoming: HostRunEndpoint | undefined;
  t.after(async () => {
    try { await incoming?.stop(); } catch { /* already stopped */ }
    fake.stop();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  chmodSync(stateDir, 0o700);
  mkdirSync(join(stateDir, "run"), { recursive: true, mode: 0o700 });
  chmodSync(join(stateDir, "run"), 0o700);
  const livePath = join(stateDir, "run", "scheduler.sock");
  const outgoing = createServer();
  await new Promise<void>((resolve, reject) => {
    outgoing.once("error", reject);
    outgoing.listen(livePath, () => {
      try { chmodSync(livePath, 0o600); resolve(); } catch (error) { reject(error); }
    });
  });

  const handoff = await HostRunFront.start({ stateDir, socketPath: livePath, takeLivePath: true });
  assert.equal(await hostRunSocketAnswers(livePath, 500), true, "swap placed the incoming front's inode on the live path");
  await new Promise<void>(resolve => outgoing.close(() => resolve()));
  assert.equal(existsSync(livePath), false, "libuv unlinked the live path the incoming inode occupied");

  incoming = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn, front: handoff });
  await incoming.start();
  assert.equal(existsSync(livePath), true, "adopt reasserted the live path");
  assert.equal(incoming.serving(), true);
  assert.equal(incoming.error(), null);
  assert.equal(await hostRunSocketAnswers(livePath, 500), true);
  const status = await call(client(livePath), "status", {}, 1);
  assert.equal(status.ok, true, JSON.stringify(status));
});

weighted(2)("a submission whose scheduler row is missing is repaired by status, never dropped", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  const body = submitBody();
  const submitted = await call(wire, "submit", body, 1);
  const runId = submitted.body.runId as string;
  f.fake.settle(runId, "passed");
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);

  // Simulate the crash window: the durable key exists, the scheduler row does not.
  f.store.db.prepare("DELETE FROM host_run_records WHERE id=?").run(runId);
  const spawnsBefore = f.fake.spawnCount();
  const repaired = await call(wire, "status", { caller: body.caller, clientRequestId: body.clientRequestId }, 1);
  assert.equal(repaired.ok, true, "status repairs the durable key instead of returning unknown_run");
  assert.equal(repaired.body.runId, runId);
  assert.ok(f.scheduler.get(runId), "the scheduler row was recreated");
  assert.equal(f.scheduler.get(runId)!.state, "settled", "the durable result settles the reconstructed row");
  assert.equal(f.scheduler.get(runId)!.settlement!.outcome, "passed");
  assert.equal(f.fake.spawnCount(), spawnsBefore, "a run with a durable result is never launched twice");
  wire.destroy();
});

weighted(2)("report facts are durable, idempotent, reject in-batch conflicts and never reopen a removed container", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  const submitted = await call(wire, "submit", submitBody(), 1);
  const runId = submitted.body.runId as string;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 60));

  const observedAt = new Date().toISOString();
  const started = { kind: "container", factId: randomUUID(), observedAt, runId, epoch: 1, runtime: "docker", containerId: "c-1", event: "started" };
  const first = await call(wire, "report", { facts: [started] }, 1);
  assert.equal(first.ok, true);
  assert.equal(f.scheduler.get(runId)!.containers.length, 1);
  const duplicate = await call(wire, "report", { facts: [started] }, 1);
  assert.equal(duplicate.ok, true, "a replay of the same fact is idempotent");
  assert.equal(f.scheduler.get(runId)!.containers.length, 1);
  const conflicting = await call(wire, "report", { facts: [{ ...started, containerId: "c-2" }] }, 1);
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error!.code, "conflict");

  // The same factId twice in one batch with different bodies is conflict; the batch writes nothing.
  const batchConflict = await call(wire, "report", { facts: [
    { kind: "nested", factId: randomUUID(), observedAt, parentRunId: runId, selector: "qa:one" },
  ] }, 1);
  assert.equal(batchConflict.ok, true);
  const batchId = randomUUID();
  const inBatch = await call(wire, "report", { facts: [
    { kind: "nested", factId: batchId, observedAt, parentRunId: runId, selector: "qa:a" },
    { kind: "nested", factId: batchId, observedAt, parentRunId: runId, selector: "qa:b" },
  ] }, 1);
  assert.equal(inBatch.ok, false);
  assert.equal(inBatch.error!.code, "conflict");
  assert.equal(f.scheduler.store.db.prepare("SELECT COUNT(*) AS c FROM host_run_journal WHERE json_extract(data,'$.factId')=?").get(batchId)!.c, 0, "a conflicting batch writes nothing");

  const removed = { ...started, factId: randomUUID(), event: "removed", removed: true };
  assert.equal((await call(wire, "report", { facts: [removed] }, 1)).ok, true);
  assert.equal(f.scheduler.get(runId)!.containers[0].removed, true);
  const replay = { ...started, factId: randomUUID() };
  assert.equal((await call(wire, "report", { facts: [replay] }, 1)).ok, true);
  assert.equal(f.scheduler.get(runId)!.containers[0].removed, true);
  f.fake.settle(runId, "passed");
  wire.destroy();
});

weighted(4)("a durable nested fact's journal event is reconstructed after a restart", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  t.after(() => { fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });

  const first = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await first.start();
  const wire = client(first.socketPath);
  const submitted = await call(wire, "submit", submitBody(), 1);
  const runId = submitted.body.runId as string;
  const factId = randomUUID();
  const fact = { kind: "nested", factId, observedAt: new Date().toISOString(), parentRunId: runId, selector: "qa:nested" };
  assert.equal((await call(wire, "report", { facts: [fact] }, 1)).ok, true);
  const count = () => scheduler.store.db.prepare("SELECT COUNT(*) AS c FROM host_run_journal WHERE event='nested' AND json_extract(data,'$.factId')=?").get(factId)!.c;
  assert.equal(count(), 1);

  // Crash between the durable fact file and its journal event: the restart repairs it.
  scheduler.store.db.prepare("DELETE FROM host_run_journal WHERE event='nested' AND json_extract(data,'$.factId')=?").run(factId);
  assert.equal(count(), 0);
  wire.destroy();
  await first.stop();

  const second = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await second.start();
  assert.equal(count(), 1, "the restart recreates the missing journal event");
  const replay = await call(client(second.socketPath), "report", { facts: [fact] }, 1);
  assert.equal(replay.ok, true, "a replay is still acknowledged without a duplicate event");
  assert.equal(count(), 1);
  fake.settle(runId, "passed");
  await second.stop();
});

weighted(3)("output_expired reports availableFrom once the retention hour has passed", async t => {
  let nowMs = Date.now();
  const f = await harness(t, { outputRetentionMs: 1_000, now: () => nowMs });
  const wire = client(f.endpoint.socketPath);
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  f.fake.emit(runId, "stdout", "retained-then-expired\n");
  f.fake.settle(runId, "passed");
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  nowMs += 5_000;

  const attach = client(f.endpoint.socketPath);
  attach.send({ v: 1, id: "expired", method: "attach", epoch: 1, body: { runId, fromOffset: { stdout: 0 } } });
  const events = await readAttachUntilSettled(attach);
  const expired = events.find(event => event.event === "output_expired");
  assert.ok(expired, "the attachment reports expired output");
  assert.equal(expired.stream, "stdout");
  assert.equal(expired.availableFrom, Buffer.byteLength("retained-then-expired\n", "utf8"));
  assert.equal(events.at(-1)!.event, "settled");
  assert.equal(existsSync(hostRunSupervisorPaths(f.stateDir, runId).stdoutPath), false, "expired stdout is removed from disk");
  assert.equal(existsSync(hostRunSupervisorPaths(f.stateDir, runId).stderrPath), false, "expired stderr is removed from disk");
  // The durable marker keeps the same availableFrom for a later attach.
  const again = client(f.endpoint.socketPath);
  again.send({ v: 1, id: "expired-again", method: "attach", epoch: 1, body: { runId, fromOffset: { stdout: 0 } } });
  const againEvents = await readAttachUntilSettled(again);
  const againExpired = againEvents.find(event => event.event === "output_expired");
  assert.ok(againExpired, "a later attach still reports expired output");
  assert.equal(againExpired.availableFrom, expired.availableFrom);
  again.destroy();
  attach.destroy();
  wire.destroy();
});

weighted(2)("status {} answers the host summary", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  const submitted = await call(wire, "submit", submitBody(), 1);
  await waitFor(() => f.scheduler.get(submitted.body.runId)?.state === "running", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  const summary = await call(wire, "status", {}, 1);
  assert.equal(summary.ok, true);
  assert.equal(summary.body.running, 1);
  assert.equal(summary.body.queued, 0);
  assert.equal(summary.body.budget.cpuCapacity, 4);
  f.fake.settle(submitted.body.runId, "passed");
  wire.destroy();
});

test("defaultHostRunStateDir is the contract path", () => {
  assert.equal(defaultHostRunStateDir({ HOME: "/workspace/example" }), "/workspace/example/.local/state/host-run");
  assert.equal(hostRunRunDir("/state", "abc"), "/state/runs/abc");
});

test("host-run state follows non-live data dirs, recognizes the live dir by realpath and refuses the live state root", t => {
  const root = mkdtempSync(join(tmpdir(), "hre-state-dir-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const paseoHome = join(root, "alternate-paseo-home");
  const liveDataDir = join(home, ".nucleus");
  const dataDir = join(root, "isolated-data");
  const privateDataDir = join(paseoHome, "private-nucleus");
  mkdirSync(home, { recursive: true });
  mkdirSync(liveDataDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(privateDataDir, { recursive: true });
  const env = { HOME: home, PASEO_HOME: paseoHome };

  // A private instance with the real HOME keeps its own state: it never binds the live socket.
  assert.equal(hostRunStateDirForDataDir(privateDataDir, env), join(privateDataDir, "host-run"));

  assert.equal(hostRunStateDirForDataDir(dataDir, env), join(dataDir, "host-run"));
  const liveAlias = join(root, "live-alias");
  symlinkSync(liveDataDir, liveAlias, "dir");
  const liveStateDir = join(home, ".local", "state", "host-run");
  assert.equal(hostRunStateDirForDataDir(liveAlias, env), liveStateDir, "a symlink to the live data dir keeps Contract 010's shared state path");
  assert.throws(() => assertHostRunStateDirSafe(dataDir, liveStateDir, env), /non-live Nucleus data directory.*live host-run state directory/);
  const liveStateAlias = join(root, "live-state-alias");
  symlinkSync(liveStateDir, liveStateAlias, "dir");
  assert.throws(() => assertHostRunStateDirSafe(dataDir, liveStateAlias, env), /non-live Nucleus data directory.*live host-run state directory/,
    "a dangling symlink to the live root is refused before it can create that root");
  assert.doesNotThrow(() => assertHostRunStateDirSafe(dataDir, liveStateDir, env, liveStateDir), "only a test opt-in naming the same live path bypasses the guard");
});

weighted(2)("a submit body with a missing mandatory field is invalid", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const body = hostRunSubmitBodySchema.parse(submitBody());
  const invalid = await call(wire, "submit", { ...body, argv: [] }, 1);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error!.code, "invalid");
});

function supervisorPlan(stateDir: string, runId: string, argv: string[], overrides: Partial<HostRunSupervisorPlan> & { env?: Record<string, string> } = {}): HostRunSupervisorPlan {
  const paths = hostRunSupervisorPaths(stateDir, runId);
  const { env = { ...process.env } as Record<string, string>, ...planOverrides } = overrides;
  writeHostRunLaunchEnv(stateDir, runId, env);
  return hostRunSupervisorPlanSchema.parse({
    format: "host.run.supervisor.plan", version: 1, stateDir, runId, epoch: 1,
    argv, cwd: process.cwd(), envKeys: Object.keys(env).sort(),
    runTimeoutMs: 30_000, graceMs: 100,
    startedAt: new Date().toISOString(), ...planOverrides,
  });
}

weighted(3)("the real supervisor runs a command and writes a durable host.run.result", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const plan = supervisorPlan(stateDir, "real-pass", [process.execPath, "-e", "process.stdout.write('hello-supervisor');process.exit(0)"]);
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).planPath, JSON.stringify(plan), 0o600);
  await runHostRunSupervisorMain([plan.stateDir, plan.runId]);
  const result = hostRunResultSchema.parse(JSON.parse(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, "utf8")));
  assert.equal(result.runId, "real-pass");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).stdoutPath, "utf8"), "hello-supervisor");
});

test("the real supervisor records the command tree's CPU time, so the scheduler can budget from history", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  // Busy past several group reads (PROCESS_TREE_GROUP_READ_MS, task 434): the
  // sampled total is a lower bound, and a command that exits inside the first
  // read interval records only that read.
  const busy = "const end=Date.now()+2500;let x=0;while(Date.now()<end){x+=Math.sqrt(x+1)}process.stdout.write(String(x>0))";
  const plan = supervisorPlan(stateDir, "real-cpu", [process.execPath, "-e", busy]);
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).planPath, JSON.stringify(plan), 0o600);
  await runHostRunSupervisorMain([plan.stateDir, plan.runId]);
  const result = hostRunResultSchema.parse(JSON.parse(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, "utf8")));
  assert.equal(result.exitCode, 0);
  assert.ok(typeof result.cpuMs === "number" && result.cpuMs > 200, `a busy command records its CPU time (got ${result.cpuMs})`);
  const raw = JSON.parse(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, "utf8"));
  assert.equal(frozenHostRunResultSchema.safeParse(raw).success, true, "the result file is the frozen Contract 010 shape");
  assert.equal("cpuCoverage" in raw, false);
  const stateRaw = JSON.parse(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).statePath, "utf8"));
  assert.equal(mainPrivateHostRunSupervisorStateSchema.safeParse(stateRaw).success, true, "the state parses with main's strict schema");
  assert.equal("cpuCoverage" in stateRaw, false);
  const sidecar = JSON.parse(readFileSync(join(dirname(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath), HOST_RUN_CPU_COVERAGE_FILE), "utf8"));
  assert.equal(boundSidecarCoverage(sidecar, { runId: plan.runId, epoch: plan.epoch, cpuMs: result.cpuMs }), "sampled", "the reason is in the run's private sidecar");
});

test("the real supervisor redacts the launch token across output chunks", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const secret = "host-run-secret-for-output";
  const source = "const token=process.env.HOST_RUN_TOKEN;process.stdout.write('before'+token.slice(0,9));setTimeout(()=>{process.stdout.write(token.slice(9)+'after');process.stderr.write(token);process.exit(0)},10)";
  const plan = supervisorPlan(stateDir, "redact-token", [process.execPath, "-e", source], { env: { ...process.env, HOST_RUN_TOKEN: secret } });
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).planPath, JSON.stringify(plan), 0o600);
  await runHostRunSupervisorMain([plan.stateDir, plan.runId]);
  assert.equal(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).stdoutPath, "utf8"), "before[REDACTED]after");
  assert.equal(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).stderrPath, "utf8"), "[REDACTED]");
});

test("the real supervisor honours a durable cancel request and records it", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const plan = supervisorPlan(stateDir, "real-cancel", [process.execPath, "-e", "setTimeout(()=>{}, 10000)"], { runTimeoutMs: 10_000 });
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).planPath, JSON.stringify(plan), 0o600);
  const running = runHostRunSupervisorMain([plan.stateDir, plan.runId]);
  await waitFor(() => existsSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).statePath), HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).cancelPath, JSON.stringify({
    format: "host.run.cancel", version: 1, runId: "real-cancel", reason: "test", requestedAt: new Date().toISOString(),
  }), 0o600);
  await running;
  const result = hostRunResultSchema.parse(JSON.parse(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, "utf8")));
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.exitCode, null);
  const state = JSON.parse(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).statePath, "utf8")) as { termination?: string };
  assert.equal(state.termination, "cancel");
});

weighted(4)("the endpoint launches the detached supervisor and settles from its result", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const endpoint = new HostRunEndpoint(scheduler, { stateDir }); // the production detached supervisor
  t.after(async () => { await endpoint.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });
  await endpoint.start();
  const wire = client(endpoint.socketPath);
  t.after(() => wire.destroy());
  const submitted = await call(wire, "submit", submitBody({
    cancelOnDisconnect: false, selector: "node", argv: [process.execPath, "-e", "process.stdout.write('detached-ok');process.exit(0)"],
  }), 1);
  const runId = submitted.body.runId as string;
  await waitFor(() => scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(scheduler.get(runId)!.settlement!.outcome, "passed");
  assert.equal(scheduler.get(runId)!.settlement!.result!.exitCode, 0);
  await waitFor(() => readFileSync(hostRunSupervisorPaths(stateDir, runId).stdoutPath, "utf8") === "detached-ok", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
});

timing(3)("a service roll preserves an attached client's cancelOnDisconnect window", { timeout: 30_000 }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  t.after(() => { fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });

  const first = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn, reconnectWindowMs: 250 });
  await first.start();
  const wire = client(first.socketPath);
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: true }), 1);
  const runId = submitted.body.runId as string;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 40));
  const attached = client(first.socketPath);
  attached.send({ v: 1, id: "attached", method: "attach", epoch: 1, body: { runId } });
  await attached.next();

  // The roll closes the socket: no reattach happens, so the window must survive.
  await first.stop();
  wire.destroy();
  const second = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn, reconnectWindowMs: 250 });
  await second.start();
  await waitFor(() => scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(scheduler.get(runId)!.settlement!.outcome, "cancelled");
  await second.stop();
  attached.destroy();
});

test("owned-subtree reads reject a symlinked ancestor that points outside", async t => {
  const f = await harness(t);
  const outside = mkdtempSync(join(tmpdir(), "hre-out-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeAtomicOwnedFile(join(outside, "result.json"), JSON.stringify({ forged: true }), 0o600);
  symlinkSync(outside, join(f.stateDir, "runs", "evil"));
  assert.equal(readCheckedHostRunFile(f.stateDir, ["runs", "evil", "result.json"]), null,
    "a component that resolves outside the owned subtree is refused");
});

weighted(2)("the real supervisor waits for the process group to empty before settling", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  // The leader spawns a same-group child with closed stdio, then exits. The
  // root cause of run a645572d: settling on pipe closure would release capacity
  // while that child still runs.
  const script = `const {spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{},500)'],{stdio:'ignore'});process.exit(0);`;
  const plan = supervisorPlan(stateDir, "real-group", [process.execPath, "-e", script], { runTimeoutMs: 10_000 });
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).planPath, JSON.stringify(plan), 0o600);
  await runHostRunSupervisorMain([plan.stateDir, plan.runId]);
  const result = hostRunResultSchema.parse(JSON.parse(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, "utf8")));
  assert.equal(result.exitCode, 0);
  assert.ok(result.wallMs >= 400, `the result waited for the group to empty (wallMs ${result.wallMs})`);
  assert.ok(Date.now() - Date.parse(result.endedAt) < 2_000, "the group is proven empty before the result is written");
});

weighted(2)("the real supervisor inventories an escaped setsid descendant and waits for it", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  // The leader starts a detached child in its own session, then exits. The child
  // leaves the run's process group, so the supervisor must record it as a fact
  // and keep the run reserved until it is gone. The leader stays alive long
  // enough for the in-run inventory (ppid walk) to see the child before
  // launchd reparents it; the child outlives that window so settlement waits.
  const script = `const {spawn}=require('child_process');
spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:'ignore'}).unref();
setTimeout(()=>process.exit(0),3000);`;
  const plan = supervisorPlan(stateDir, "real-escape", [process.execPath, "-e", script], { runTimeoutMs: 10_000 });
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).planPath, JSON.stringify(plan), 0o600);
  await runHostRunSupervisorMain([plan.stateDir, plan.runId]);
  const result = hostRunResultSchema.parse(JSON.parse(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, "utf8")));
  assert.equal(result.exitCode, 0);
  assert.ok(result.escapedDescendants.length >= 1, "the escaped descendant is recorded");
  assert.ok(result.escapedDescendants.every(descendant => descendant.pid > 0 && descendant.startIdentity.length > 0));
  assert.ok(result.wallMs >= 500, `the result waited for the escaped descendant (wallMs ${result.wallMs})`);
});

weighted(5)("a persistent unknown identity scan does not write a clean result over a live escaped child", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const pidPath = join(stateDir, "child.pid");
  overrideIdentityListing({ state: "unknown" });
  t.after(() => {
    overrideIdentityListing(null);
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
  });
  // The previous 8 s bound wrote host.run.result with no escaped descendants
  // while Darwin listings stayed unknown. A live setsid child must keep that
  // result unwritten until a readable scan proves absence or records the child.
  const script = `const {spawn}=require('child_process');const {writeFileSync}=require('fs');
const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{detached:true,stdio:'ignore'});
child.unref();
writeFileSync(process.env.CHILD_PID,String(child.pid));
setTimeout(()=>process.exit(0),400);`;
  const plan = supervisorPlan(stateDir, "unknown-escape", [process.execPath, "-e", script], {
    runTimeoutMs: 30_000, env: { ...process.env, CHILD_PID: pidPath },
  });
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).planPath, JSON.stringify(plan), 0o600);
  const running = runHostRunSupervisorMain([plan.stateDir, plan.runId]);
  await waitFor(() => existsSync(pidPath) && Number(readFileSync(pidPath, "utf8")) > 0);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 9_000));
  assert.equal(existsSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath), false, "an unreadable listing does not settle a live escaped child as absent");
  overrideIdentityListing(null);
  await running;
  const result = hostRunResultSchema.parse(JSON.parse(readFileSync(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, "utf8")));
  assert.ok(result.escapedDescendants.length >= 1, "the escaped descendant is recorded once listings are readable");
});

weighted(2)("a durable result with a live escaped descendant does not settle the run", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  const plan = readPlan(f.stateDir, runId);
  const endedAt = new Date().toISOString();
  const result = hostRunResultSchema.parse({
    format: "host.run.result", version: 1, runId, epoch: 1, pgid: 2_100_000_000, startIdentity: "2100000000@fake",
    exitCode: 0, signal: null, startedAt: plan.startedAt, endedAt, wallMs: 1, cpuMs: 3,
    escapedDescendants: [{ pid: process.pid, startIdentity: hostRunProcessStartIdentity(process.pid) }],
  });
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, JSON.stringify(result), 0o600);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
  assert.notEqual(f.scheduler.get(runId)!.state, "settled", "a live escaped descendant keeps the run reserved");
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, JSON.stringify({ ...result, escapedDescendants: [] }), 0o600);
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(f.scheduler.get(runId)!.settlement!.outcome, "passed");
});

weighted(3)("a report retry after a crash gap between journal and fact log is refused when the body changed", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  t.after(() => { fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });

  const first = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await first.start();
  const wire = client(first.socketPath);
  const submitted = await call(wire, "submit", submitBody(), 1);
  const runId = submitted.body.runId as string;
  const factId = randomUUID();
  const observedAt = new Date().toISOString();
  const fact = { kind: "nested", factId, observedAt, parentRunId: runId, selector: "qa:original" };
  // The durable journal write happened; the fact log append did not (crash gap).
  scheduler.note(runId, "nested", { ...fact });
  wire.destroy();
  await first.stop();

  const second = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await second.start();
  const retry = client(second.socketPath);
  t.after(() => retry.destroy());
  const changed = await call(retry, "report", { facts: [{ ...fact, selector: "qa:changed" }] }, 1);
  assert.equal(changed.ok, false, "a changed body for a journaled factId is refused");
  assert.equal(changed.error!.code, "conflict");
  const same = await call(retry, "report", { facts: [fact] }, 1);
  assert.equal(same.ok, true, "the same body repairs the fact log and is acknowledged");
  assert.equal(same.body.facts[0].selector, "qa:original");
  assert.equal(scheduler.store.db.prepare("SELECT COUNT(*) AS c FROM host_run_journal WHERE event='nested' AND json_extract(data,'$.factId')=?").get(factId)!.c, 1);
  fake.settle(runId, "passed");
  await second.stop();
});

timing(3)("a service roll preserves cancelOnDisconnect for a run with multiple attachments", { timeout: 30_000 }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  t.after(() => { fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });

  const first = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn, reconnectWindowMs: 250 });
  await first.start();
  const wire = client(first.socketPath);
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: true }), 1);
  const runId = submitted.body.runId as string;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 40));
  const one = client(first.socketPath);
  one.send({ v: 1, id: "one", method: "attach", epoch: 1, body: { runId } });
  await one.next();
  const two = client(first.socketPath);
  two.send({ v: 1, id: "two", method: "attach", epoch: 1, body: { runId } });
  await two.next();

  // The roll closes both attachments at once: one durable deadline is persisted for the run.
  await first.stop();
  wire.destroy();
  assert.equal(existsSync(hostRunSupervisorPaths(stateDir, runId).disconnectPath), true);
  const second = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn, reconnectWindowMs: 250 });
  await second.start();
  await waitFor(() => scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(scheduler.get(runId)!.settlement!.outcome, "cancelled");
  await second.stop();
  one.destroy();
  two.destroy();
});



// ---------------------------------------------------------------------------
// Verified traversal (contract 010 Files, runtimes without openat)
// ---------------------------------------------------------------------------

function traversalFixture(t: { after(fn: () => void | Promise<void>): void }) {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeAtomicOwnedFile(join(stateDir, "runs", "x", "anchor"), "x", 0o600);
  writeAtomicOwnedFile(join(stateDir, "runs", "x", "target.json"), "original", 0o600);
  return { stateDir, target: ["runs", "x", "target.json"] };
}

test("verified traversal refuses a target swapped between lstat and open", async t => {
  const { stateDir, target } = traversalFixture(t);
  const value = readCheckedHostRunFile(stateDir, target, {
    afterChainCheck: () => {
      renameSync(join(stateDir, ...target), join(stateDir, "runs", "x", "old.json"));
      writeAtomicOwnedFile(join(stateDir, ...target), "replacement", 0o600);
    },
  });
  assert.equal(value, null, "the target's recorded (dev, ino) no longer matches the opened handle");
});

test("verified traversal refuses an ancestor swapped after the final open", async t => {
  const { stateDir, target } = traversalFixture(t);
  const value = readCheckedHostRunFile(stateDir, target, {
    afterOpen: () => {
      renameSync(join(stateDir, "runs", "x"), join(stateDir, "runs", "x-old"));
      mkdirSync(join(stateDir, "runs", "x"), { recursive: true, mode: 0o700 });
      chmodSync(join(stateDir, "runs", "x"), 0o700);
      writeAtomicOwnedFile(join(stateDir, ...target), "replacement", 0o600);
    },
  });
  assert.equal(value, null, "the post-open re-lstat catches the swapped ancestor");
});

test("verified traversal refuses a symlinked component for reads and writes", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const outside = mkdtempSync(join(tmpdir(), "hre-out-"));
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeAtomicOwnedFile(join(stateDir, "runs", "anchor"), "x", 0o600);
  writeAtomicOwnedFile(join(outside, "target.json"), "outside", 0o600);
  symlinkSync(outside, join(stateDir, "runs", "link"));
  assert.equal(readCheckedHostRunFile(stateDir, ["runs", "link", "target.json"]), null);
  assert.throws(() => writeVerifiedOwnedFile(stateDir, ["runs", "link", "written.json"], "x", 0o600));
  assert.equal(existsSync(join(outside, "written.json")), false, "nothing is written through the symlink");
});

test("verified traversal refuses a wrong file mode and a wrong directory mode", async t => {
  const { stateDir, target } = traversalFixture(t);
  assert.ok(readCheckedHostRunFile(stateDir, target));
  chmodSync(join(stateDir, ...target), 0o644);
  assert.equal(readCheckedHostRunFile(stateDir, target), null, "a world-readable file is refused");
  chmodSync(join(stateDir, ...target), 0o600);
  chmodSync(join(stateDir, "runs", "x"), 0o755);
  assert.equal(readCheckedHostRunFile(stateDir, target), null, "a traverseable directory is refused");
  chmodSync(join(stateDir, "runs", "x"), 0o700);
  assert.ok(readCheckedHostRunFile(stateDir, target));
});

test("the socket chain check refuses a relaxed socket mode", async t => {
  const f = await harness(t);
  assert.equal(hostRunSocketIsOwnerOnly(f.stateDir), true);
  chmodSync(join(f.stateDir, "run", "scheduler.sock"), 0o644);
  assert.equal(hostRunSocketIsOwnerOnly(f.stateDir), false);
});

// ---------------------------------------------------------------------------
// Startup path verification, global factId and expired output (review 5379856098)
// ---------------------------------------------------------------------------

test("startup refuses a symlinked run directory before chmod, unlink or bind", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const outside = mkdtempSync(join(tmpdir(), "hre-out-"));
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  chmodSync(outside, 0o755);
  writeFileSync(join(outside, "scheduler.sock"), "target-socket");
  symlinkSync(outside, join(stateDir, "run"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const endpoint = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: () => {} });
  t.after(() => { store.close(); });
  await assert.rejects(() => endpoint.start(), /not an owned directory/);
  assert.equal(statSync(outside).mode & 0o777, 0o755, "the symlink target keeps its mode");
  assert.equal(readFileSync(join(outside, "scheduler.sock"), "utf8"), "target-socket", "the symlink target keeps its socket");
  assert.equal(existsSync(hostRunAuthorityPath(stateDir)), false, "no authority is published");
});

test("startup refuses a symlinked socket path before unlinking it", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const outside = mkdtempSync(join(tmpdir(), "hre-out-"));
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  mkdirSync(join(stateDir, "run"), { mode: 0o700 });
  writeFileSync(join(outside, "scheduler.sock"), "target-socket");
  symlinkSync(join(outside, "scheduler.sock"), join(stateDir, "run", "scheduler.sock"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const endpoint = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: () => {} });
  t.after(() => { store.close(); });
  await assert.rejects(() => endpoint.start(), /not an owned socket/);
  assert.equal(readFileSync(join(outside, "scheduler.sock"), "utf8"), "target-socket", "the socket target is not unlinked");
  assert.equal(existsSync(hostRunAuthorityPath(stateDir)), false, "no authority is published");
});

test("factId dedup is global across fact kinds", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  const submitted = await call(wire, "submit", submitBody(), 1);
  const runId = submitted.body.runId as string;
  const observedAt = new Date().toISOString();
  const factId = randomUUID();
  const nested = { kind: "nested", factId, observedAt, parentRunId: runId, selector: "qa:one" };
  assert.equal((await call(wire, "report", { facts: [nested] }, 1)).ok, true);
  const container = { kind: "container", factId, observedAt, runId, epoch: 1, runtime: "docker", containerId: "c-1", event: "started" };
  const conflict = await call(wire, "report", { facts: [container] }, 1);
  assert.equal(conflict.ok, false, "a nested factId reused by a container fact is refused");
  assert.equal(conflict.error!.code, "conflict");
  assert.equal(f.scheduler.store.db.prepare("SELECT COUNT(*) AS c FROM host_run_journal WHERE json_extract(data,'$.factId')=?").get(factId)!.c, 1, "the reused factId is not journaled twice");

  const containerFactId = randomUUID();
  const started = { ...container, factId: containerFactId, containerId: "c-2" };
  assert.equal((await call(wire, "report", { facts: [started] }, 1)).ok, true);
  const reused = { kind: "nested", factId: containerFactId, observedAt, parentRunId: runId, selector: "qa:two" };
  const reverse = await call(wire, "report", { facts: [reused] }, 1);
  assert.equal(reverse.ok, false, "a container factId reused by a nested fact is refused");
  assert.equal(reverse.error!.code, "conflict");
  f.fake.settle(runId, "passed");
  wire.destroy();
});

weighted(2)("a container factId is refused across kinds after a journal-to-facts crash gap", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const fake = fakeSupervisor();
  t.after(() => { fake.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });

  const first = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await first.start();
  const wire = client(first.socketPath);
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 60));
  const observedAt = new Date().toISOString();
  const factId = randomUUID();
  const container = { kind: "container", factId, observedAt, runId, epoch: 1, runtime: "docker", containerId: "c-1", event: "started" };
  assert.equal((await call(wire, "report", { facts: [container] }, 1)).ok, true);
  wire.destroy();
  await first.stop();
  // The journal write survived; the fact log append did not.
  rmSync(join(stateDir, "facts.jsonl"), { force: true });

  const second = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn });
  await second.start();
  const retry = client(second.socketPath);
  t.after(() => retry.destroy());
  const reused = { kind: "nested", factId, observedAt, parentRunId: runId, selector: "qa:other" };
  const conflict = await call(retry, "report", { facts: [reused] }, 1);
  assert.equal(conflict.ok, false, "a reused factId of another kind is refused through the crash gap");
  assert.equal(conflict.error!.code, "conflict");
  const same = await call(retry, "report", { facts: [container] }, 1);
  assert.equal(same.ok, true, "the same container body repairs the fact log and is acknowledged");
  assert.deepEqual(same.body.facts[0], container);
  fake.settle(runId, "passed");
  await second.stop();
});

test("canonical start identity follows contract 010's vectors", () => {
  const macLine = "Thu Oct  1 13:01:39 2026";
  const files: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n",
    "/proc/4242/stat": "4242 ((a) b)) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 ...",
  };
  const readFileText = (path: string) => files[path];

  // Vector 1: the caller's TZ and locale do not change the forced C/UTC reading.
  const savedTz = process.env.TZ, savedLocale = process.env.LC_ALL;
  process.env.TZ = "America/Los_Angeles"; process.env.LC_ALL = "de_DE";
  try {
    assert.equal(hostRunProcessStartIdentity(4242, { platform: "darwin", psStartLine: () => macLine }), "4242@2026-10-01T13:01:39Z");
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
    if (savedLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = savedLocale;
  }

  // Vector 2: Linux reads the boot id and field 22, parsed after the last `)`.
  assert.equal(hostRunProcessStartIdentity(4242, { platform: "linux", readFileText }), "4242@0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0:987654");

  // Vector 3: unreadable /proc is `<pid>@unknown`, and unknown never matches itself.
  assert.equal(hostRunProcessStartIdentity(4242, { platform: "linux", readFileText: () => { throw new Error("ENOENT"); } }), "4242@unknown");
  assert.equal(startIdentityMatches("4242@unknown", "4242@unknown"), false);

  // Vector 4: the whole-second macOS legacy form matches; any other fraction refuses.
  assert.equal(startIdentityMatches("4242@2026-10-01T13:01:39.000Z", "4242@2026-10-01T13:01:39Z"), true);
  assert.equal(startIdentityMatches("4242@2026-10-01T13:01:39.500Z", "4242@2026-10-01T13:01:39Z"), false);
  assert.equal(startIdentityMatches("4242@unknown", "4242@2026-10-01T13:01:39Z"), false);
  assert.equal(startIdentityMatches("4242@2026-10-01T13:01:39Z", "4242@2026-10-01T13:01:39Z"), true);
});

test("identity proofs expire for a reused pid, fail closed when unavailable, and stay fresh for settlements", async () => {
  const identities = new Map<number, StartIdentityRead>();
  const alive = new Set<number>();
  let clock = 0;
  let reads = 0;
  const proofs = new RecordedIdentityProofs({
    read: async pid => {
      reads++;
      return identities.get(pid) ?? { kind: "gone" };
    },
    alive: pid => alive.has(pid),
    now: () => clock,
    cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS,
  });

  // First proof reads the OS and caches the positive pair.
  identities.set(100, { kind: "identity", identity: "100@2026-10-20T10:00:00Z" });
  alive.add(100);
  assert.equal(await proofs.check(100, "100@2026-10-20T10:00:00Z"), true);
  const readsAfterProof = reads;

  // Within the cache bound and still alive, no further OS read is made.
  assert.equal(await proofs.check(100, "100@2026-10-20T10:00:00Z"), true);
  assert.equal(reads, readsAfterProof, "a bound-proofed pair is not re-read");

  // The pid number is reused by a different process without any poll
  // observing a death: past the cache bound the stale proof expires and the
  // fresh read sees a different start identity.
  clock += HOST_RUN_IDENTITY_PROOF_CACHE_MS + 1;
  identities.set(100, { kind: "identity", identity: "100@2026-10-20T10:00:07Z" });
  assert.equal(await proofs.check(100, "100@2026-10-20T10:00:00Z"), false, "a reused pid number does not inherit the proof");
  assert.equal(await proofs.check(100, "100@2026-10-20T10:00:07Z"), true, "the new process proves against its own identity");

  // An unavailable read is unknown: never matched, never cached as either
  // verdict, and a later recovery proves normally.
  identities.set(200, { kind: "unavailable" });
  alive.add(200);
  assert.equal(await proofs.check(200, "200@2026-10-20T10:00:00Z"), "unknown");
  identities.set(200, { kind: "identity", identity: "200@2026-10-20T10:00:00Z" });
  assert.equal(await proofs.check(200, "200@2026-10-20T10:00:00Z"), true, "recovery after an unavailable read proves");

  // A proven pair whose pid dies is definitively unmatched and uncached.
  clock += HOST_RUN_IDENTITY_PROOF_CACHE_MS + 1;
  alive.delete(200);
  identities.set(200, { kind: "gone" });
  assert.equal(await proofs.check(200, "200@2026-10-20T10:00:00Z"), false);

  // `fresh` bypasses even a current cache entry: identity-dependent loss and
  // settlement decisions never rest on the age-bound cache.
  identities.set(300, { kind: "identity", identity: "300@2026-10-20T10:00:00Z" });
  alive.add(300);
  assert.equal(await proofs.check(300, "300@2026-10-20T10:00:00Z"), true);
  const readsBeforeFresh = reads;
  assert.equal(await proofs.check(300, "300@2026-10-20T10:00:00Z", true), true);
  assert.equal(reads, readsBeforeFresh + 1, "a fresh proof re-reads the OS inside the cache bound");

  // A mismatch or an unknown recorded identity never caches a positive proof.
  identities.set(400, { kind: "identity", identity: "400@2026-10-20T10:00:09Z" });
  alive.add(400);
  assert.equal(await proofs.check(400, "400@2026-10-20T10:00:00Z"), false);
  assert.equal(await proofs.check(400, "400@unknown"), false);
});

test("a stale identity-read completion after a cache reset is discarded", async () => {
  let release: ((read: StartIdentityRead) => void) | null = null;
  const proofs = new RecordedIdentityProofs({
    read: () => new Promise<StartIdentityRead>(resolve => { release = resolve; }),
    alive: () => true,
    now: () => 0,
    cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS,
  });
  const pending = proofs.check(500, "500@2026-10-20T10:00:00Z");
  proofs.reset();
  release!({ kind: "identity", identity: "500@2026-10-20T10:00:00Z" });
  assert.equal(await pending, "unknown", "a completion racing a reset does not repopulate the cache");
  // And the cache is genuinely empty: the next check reads again.
  let reads = 0;
  const second = new RecordedIdentityProofs({
    read: async () => { reads++; return { kind: "gone" }; },
    alive: () => true,
    now: () => 0,
    cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS,
  });
  await second.check(500, "500@2026-10-20T10:00:00Z");
  assert.equal(reads, 1);
});

test("concurrent identity checks for one pair share a single OS read", async () => {
  let release: ((read: StartIdentityRead) => void) | null = null;
  let reads = 0;
  const proofs = new RecordedIdentityProofs({
    read: () => {
      reads++;
      return new Promise<StartIdentityRead>(resolve => { release = resolve; });
    },
    alive: () => true,
    now: () => 0,
    cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS,
  });
  const first = proofs.check(600, "600@2026-10-20T10:00:00Z");
  const second = proofs.check(600, "600@2026-10-20T10:00:00Z");
  assert.equal(reads, 1, "in-flight checks share one read instead of stacking");
  release!({ kind: "identity", identity: "600@2026-10-20T10:00:00Z" });
  assert.equal(await first, true);
  assert.equal(await second, true);
});

test("readHostRunStartIdentity distinguishes a gone pid from an unavailable read", async () => {
  // Linux /proc: a missing proc entry is gone; another read failure is unavailable.
  const files: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n",
    "/proc/4242/stat": "4242 ((a) b)) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 ...",
  };
  const statMissing = (path: string) => {
    if (path === "/proc/4242/stat") { const error = new Error("no entry") as Error & { code?: string }; error.code = "ENOENT"; throw error; }
    return files[path]!;
  };
  assert.deepEqual(await readHostRunStartIdentity(4242, { platform: "linux", readFileText: statMissing }), { kind: "gone" });
  assert.deepEqual(await readHostRunStartIdentity(4242, { platform: "linux", readFileText: () => { throw new Error("EACCES"); } }), { kind: "unavailable" });
  // A readable proc entry yields the canonical identity.
  assert.deepEqual(
    await readHostRunStartIdentity(4242, { platform: "linux", readFileText: path => files[path]! }),
    { kind: "identity", identity: "4242@0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0:987654" },
  );
});

test("hostRunOwnStartIdentity caches only a positive identity and recovers from unknown", () => {
  // Seams bypass the memo, so the failure-then-recovery sequence is deterministic.
  let lines: Array<string | null> = [null, "Thu Oct  1 13:01:39 2026"];
  const recovered = hostRunOwnStartIdentity({ platform: "darwin", psStartLine: () => lines.shift() ?? null });
  assert.equal(recovered, `${process.pid}@unknown`, "an unreadable basis is returned as unknown and not cached");
  assert.equal(hostRunOwnStartIdentity({ platform: "darwin", psStartLine: () => "Thu Oct  1 13:01:39 2026" }), `${process.pid}@2026-10-01T13:01:39Z`, "a later positive read is the real identity");
  // The production memo holds only known-positive identities: the live process
  // always reads a real start time, never `@unknown`.
  assert.match(hostRunOwnStartIdentity(), new RegExp(`^${process.pid}@\\d{4}-`));
});

weighted(4)("the isolated host-run server starts, answers status, refuses the live dir and exits on SIGTERM", async t => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const stateDir = mkdtempSync(join(tmpdir(), "hre-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("../bin/host-run-private-server.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", entry, "--state-dir", stateDir], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } });
  const authority = JSON.parse(await firstLine(child.stdout!)) as { format: string; endpoint: string; epoch: number; pid: number; startIdentity: string };
  assert.equal(authority.format, "host.run.authority");
  assert.equal(authority.endpoint, join(realpathSync(stateDir), "run", "scheduler.sock"));
  assert.equal(authority.epoch, 1);
  assert.equal(authority.pid, child.pid);
  assert.ok(authority.startIdentity.startsWith(`${child.pid}@`), "the authority carries a canonical start identity");

  const wire = client(authority.endpoint);
  const summary = await call(wire, "status", {}, authority.epoch);
  assert.equal(summary.ok, true);
  assert.equal(summary.body.queued, 0);
  wire.destroy();

  // The live host-run state directory is refused before anything is created.
  const refused = spawnSync(process.execPath, ["--import", "tsx", entry, "--state-dir", defaultHostRunStateDir()], { encoding: "utf8", cwd: repoRoot });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refused/);

  child.kill("SIGTERM");
  const code = await waitForChildExit(child, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, "isolated host-run server");
  assert.equal(code, 0, "SIGTERM stops the private server cleanly");
  assert.equal(existsSync(join(stateDir, "run", "scheduler.sock")), false, "the socket is removed on stop");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readAttachUntilSettled(wire: ReturnType<typeof client>, timeoutMs = HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS) {
  const events: Array<Record<string, any>> = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = await wire.next(Math.max(1, deadline - Date.now()));
    const event = JSON.parse(line) as Record<string, any>;
    events.push(event);
    if (event.event === "settled") return events;
  }
  throw new Error("attach never delivered a settlement");
}

function collect(events: Array<Record<string, any>>, stream: "stdout" | "stderr") {
  const chunks = events.filter(event => event.event === "output" && event.stream === stream)
    .sort((left, right) => left.offset - right.offset);
  let offset = chunks.length ? chunks[0].offset : 0;
  let text = "";
  for (const chunk of chunks) {
    const data = Buffer.from(chunk.dataB64, "base64");
    assert.equal(chunk.offset, offset, "offsets are contiguous");
    offset += data.length;
    text += data.toString("utf8");
  }
  return { text, offset };
}

async function waitFor(predicate: () => boolean, timeoutMs = HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for a host-run fixture event after ${timeoutMs} ms`);
}

/** The first newline-terminated line from a spawned process's stdout. */
function firstLine(stream: NodeJS.ReadableStream, timeoutMs = HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      stream.off("data", onData);
      resolvePromise(buffer.slice(0, index));
    };
    stream.on("data", onData);
    const timer = setTimeout(() => { stream.off("data", onData); reject(new Error("no output line")); }, timeoutMs);
    timer.unref?.();
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number, label: string): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolvePromise, reject) => {
    const finish = (error: Error | null, code: number | null) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolvePromise(code);
    };
    const onExit = (code: number | null) => finish(null, code);
    const onError = (error: Error) => finish(error, null);
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label} to exit after ${timeoutMs} ms`), null), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}



// ---------------------------------------------------------------------------
// Env retention (Spec 035): names only in every durable record
// ---------------------------------------------------------------------------

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
const filesContaining = (paths: string[], needle: string) => paths.filter(path => readFileSync(path).includes(Buffer.from(needle)));

weighted(3)("env values never reach a durable record, the database, WAL or an export", async t => {
  const root = mkdtempSync(join(tmpdir(), "q-"));
  const stateDir = join(root, "state");
  const dbPath = join(root, "queue.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { Store } = await import("../core/store/store");
  const store = new Store(dbPath);
  const scheduler = new HostRunScheduler(store, { capacity: singleCpu });
  const fake = fakeSupervisor();
  t.after(() => fake.stop());
  const secret = `secret-${randomUUID()}`, neutral = `neutral-${randomUUID()}`;
  const env = { RELEASE_GITHUB_TOKEN: secret, PLAIN_NAME: neutral };
  const open = async () => {
    const endpoint = new HostRunEndpoint(scheduler, { stateDir, supervisorSpawn: fake.spawn, env: process.env });
    await endpoint.start();
    return endpoint;
  };
  let endpoint = await open();
  let wire = client(endpoint.socketPath);
  const big = { cpu: 4, memoryBytes: 1_000_000_000 };
  const first = await call(wire, "submit", submitBody({ budgetFallback: big, env: { ...env, FIRST_ONLY: "x" } }), 1);
  const second = await call(wire, "submit", submitBody({ budgetFallback: big, env }), 1);
  assert.equal(second.body.state, "queued");
  const queuedId = second.body.runId as string;
  const outsideLaunchEnv = () => filesUnder(stateDir).filter(path => !path.includes(`${join(stateDir, "launch-env")}`));
  assert.deepEqual(filesContaining(outsideLaunchEnv(), secret), [], "a queued run's submission holds no value");
  assert.deepEqual(readdirSync(join(stateDir, "launch-env")).includes(`${queuedId}.json`), true, "the queued run's values wait in the ephemeral file");
  assert.equal(statSync(join(stateDir, "launch-env", `${queuedId}.json`)).mode & 0o777, 0o600);

  // A roll keeps the queued run launchable.
  wire.destroy();
  await endpoint.stop();
  endpoint = await open();
  t.after(() => endpoint.stop());
  fake.settle(first.body.runId, "passed");
  for (let i = 0; i < 100 && fake.spawnCount() < 2; i++) await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  assert.equal(fake.spawnCount(), 2, "the queued run launched after the roll");
  assert.equal(readHostRunLaunchEnv(stateDir, queuedId)?.RELEASE_GITHUB_TOKEN, secret);
  assert.ok(!readFileSync(hostRunSupervisorPaths(stateDir, queuedId).planPath, "utf8").includes(secret));
  fake.settle(queuedId, "passed");
  for (let i = 0; i < 100 && scheduler.get(queuedId)?.state !== "settled"; i++) await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  assert.equal(scheduler.get(queuedId)?.state, "settled");
  assert.equal(existsSync(join(stateDir, "launch-env", `${queuedId}.json`)), false, "settling removes the ephemeral env");
  wire = client(endpoint.socketPath);
  const retry = await call(wire, "submit", submitBody({ budgetFallback: big, env, clientRequestId: JSON.parse(readFileSync(hostRunRunDir(stateDir, queuedId) + "/submission.json", "utf8")).stored.clientRequestId }), 1);
  wire.destroy();
  assert.equal(retry.ok, true);
  await endpoint.stop();
  store.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  const everything = [...filesUnder(stateDir), ...[dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync)];
  assert.deepEqual(filesContaining(everything, secret), []);
  assert.deepEqual(filesContaining(everything, neutral), []);
  assert.ok(filesContaining(filesUnder(stateDir), "RELEASE_GITHUB_TOKEN").length > 0, "key names stay recorded");
  store.close();
});

weighted(2)("a run whose ephemeral env is missing at launch settles with a clear reason and never spawns", async t => {
  const f = await harness(t, { capacity: singleCpu });
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const big = { cpu: 4, memoryBytes: 1_000_000_000 };
  const first = await call(wire, "submit", submitBody({ budgetFallback: big }), 1);
  const second = await call(wire, "submit", submitBody({ budgetFallback: big, env: { A: "b" } }), 1);
  const queuedId = second.body.runId as string;
  rmSync(join(f.stateDir, "launch-env", `${queuedId}.json`));
  f.fake.settle(first.body.runId, "passed");
  for (let i = 0; i < 100 && f.scheduler.get(queuedId)?.state !== "settled"; i++) await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  assert.equal(f.scheduler.get(queuedId)?.state, "settled");
  assert.equal(f.fake.spawnCount(), 1);
  assert.match(JSON.stringify(f.store.hostRunJournal(queuedId)), /ephemeral launch env for this run is missing/);
});

// Measured isolated weights (ceil seconds): stdout 2/2/3, stderr 3/3/2.
const attachHoldWeights = {
  stdout: { missing: 2, unsafe: 2, unreadable: 3 },
  stderr: { missing: 3, unsafe: 3, unreadable: 2 },
} as const;
for (const stream of ["stdout", "stderr"] as const) {
  for (const damage of ["missing", "unsafe", "unreadable"] as const) {
    weighted(attachHoldWeights[stream][damage])(`attach holds ${damage} retained ${stream} without changing passed settlement`, async t => {
      const f = await harness(t);
      const wire = client(f.endpoint.socketPath); t.after(() => wire.destroy());
      const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
      const runId = submitted.body.runId as string;
      f.fake.emit(runId, stream, "durable-green"); f.fake.settle(runId, "passed");
      await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
      const before = f.scheduler.get(runId)!.settlement;
      const paths = hostRunSupervisorPaths(f.stateDir, runId);
      const path = stream === "stdout" ? paths.stdoutPath : paths.stderrPath;
      if (damage === "unreadable") chmodSync(path, 0o000);
      else { unlinkSync(path); if (damage === "unsafe") symlinkSync("/dev/null", path); }
      const events: any[] = [];
      const socket = connect(f.endpoint.socketPath); t.after(() => socket.destroy());
      socket.setEncoding("utf8"); let received = ""; socket.on("data", data => { received += String(data); });
      const ended = new Promise<void>(resolve => socket.on("end", () => { events.push(...received.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); resolve(); }));
      socket.write(JSON.stringify({ v: 1, id: "gap", method: "attach", epoch: 1, body: { runId } }) + "\n");
      await ended;
      assert.equal(events.some(e => e.event === "settled"), false);
      assert.equal(events.some(e => e.event === "output_expired"), false, "unknown byte extent is never an expiry offset");
      assert.deepEqual(f.scheduler.get(runId)!.settlement, before);
      assert.equal(f.fake.spawnCount(), 1);
    });
  }
}

weighted(2)("genuine empty retained streams still deliver passed settlement", async t => {
  const f = await harness(t); const wire = client(f.endpoint.socketPath); t.after(() => wire.destroy());
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string; f.fake.settle(runId, "passed");
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  wire.send({ v: 1, id: "empty", method: "attach", epoch: 1, body: { runId } });
  const events = await readAttachUntilSettled(wire);
  assert.equal(events.at(-1)!.settlement.outcome, "passed"); assert.equal(collect(events, "stdout").text, "");
});


// Measured isolated weights (ceil seconds): missing-after-chunk 2, short-after-chunk 2.
const attachRefuseWeights = { "missing-after-chunk": 2, "short-after-chunk": 2 } as const;
for (const failure of ["missing-after-chunk", "short-after-chunk"] as const) {
  weighted(attachRefuseWeights[failure])(`attach refuses ${failure} before settlement`, async t => {
    const f = await harness(t); const wire = client(f.endpoint.socketPath); t.after(() => wire.destroy());
    const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
    const runId = submitted.body.runId as string;
    f.fake.emit(runId, "stdout", "x".repeat(130_000)); f.fake.settle(runId, "passed");
    await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
    const access = (f.endpoint as any).attach as { readOutput(runId: string, stream: "stdout" | "stderr", offset: number, length: number): Buffer | null };
    const read = access.readOutput.bind(access); let chunks = 0;
    access.readOutput = (...args) => {
      const data = read(...args);
      if (++chunks === 2) return failure === "missing-after-chunk" ? null : data!.subarray(0, 1);
      return data;
    };
    const events: any[] = []; const socket = connect(f.endpoint.socketPath); t.after(() => socket.destroy());
    socket.setEncoding("utf8"); let received = ""; socket.on("data", data => { received += String(data); });
    const ended = new Promise<void>(resolve => socket.on("end", () => { events.push(...received.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); resolve(); }));
    socket.write(JSON.stringify({ v: 1, id: "partial", method: "attach", epoch: 1, body: { runId } }) + "\n");
    await ended;
    assert.equal(events.filter(e => e.event === "output").length, 1);
    assert.equal(events.some(e => e.event === "settled"), false);
    assert.equal(f.scheduler.get(runId)!.settlement!.outcome, "passed"); assert.equal(f.fake.spawnCount(), 1);
  });
}


weighted(3)("unknown expired stream size never writes a zero retention marker or a body error", async t => {
  let nowMs = Date.now(); const f = await harness(t, { outputRetentionMs: 1_000, now: () => nowMs });
  const wire = client(f.endpoint.socketPath); t.after(() => wire.destroy());
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  f.fake.emit(runId, "stdout", "durable-green"); f.fake.settle(runId, "passed");
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  unlinkSync(hostRunSupervisorPaths(f.stateDir, runId).stdoutPath); nowMs += 5_000;
  const socket = connect(f.endpoint.socketPath); t.after(() => socket.destroy()); let received = "";
  socket.setEncoding("utf8"); socket.on("data", data => { received += String(data); });
  const ended = new Promise<void>(resolve => socket.on("end", resolve));
  socket.write(JSON.stringify({ v: 1, id: "unknown-expiry", method: "attach", epoch: 1, body: { runId } }) + "\n");
  await ended;
  const events = received.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(events.some(e => e.event === "settled" || e.event === "output_expired" || e.ok === false), false);
  assert.equal(existsSync(join(f.stateDir, "runs", runId, "output.retention.json")), false);
  assert.equal(f.scheduler.get(runId)!.settlement!.outcome, "passed");
});

// ---------------------------------------------------------------------------
// Unavailable process identity never proves absence (task 376)
// ---------------------------------------------------------------------------

/** A fake `ps` on PATH so the production Darwin reader proves its boundary. */
async function withFakePs<T>(t: { after(fn: () => void | Promise<void>): void }, script: string | null, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "hre-fakeps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH ?? "";
  if (script !== null) writeFileSync(join(dir, "ps"), script, { mode: 0o755 });
  // A null script leaves the directory without a `ps`: the spawn itself fails.
  process.env.PATH = script === null ? dir : `${dir}${delimiter}${oldPath}`;
  try { return await fn(); }
  finally { process.env.PATH = oldPath; }
}

test("darwin identity reads stay unavailable through every unobservable shape", async t => {
  // These spawn real children through PATH on purpose: every shape's verdict is
  // "unavailable", so a host that delays the child only delays the same answer.
  const permission = "#!/bin/sh\nprintf 'ps: synthetic permission denied\\n' >&2\nexit 1\n";
  const empty = "#!/bin/sh\nexit 0\n";
  const malformed = "#!/bin/sh\nprintf 'not a start line\\n'\n";
  for (const [name, script] of [["permission-denied nonzero", permission], ["empty successful", empty], ["malformed", malformed]] as const) {
    await withFakePs(t, script, async () => {
      assert.deepEqual(await readHostRunStartIdentity(4242, { platform: "darwin" }), { kind: "unavailable" }, name);
    });
  }
  // No `ps` on PATH at all: the spawn itself fails, which is also unavailable.
  await withFakePs(t, null, async () => {
    assert.deepEqual(await readHostRunStartIdentity(4242, { platform: "darwin" }), { kind: "unavailable" }, "spawn error");
  });
});

weighted(5)("darwin identity reads time out instead of proving absence", async t => {
  // `exec` replaces the shell, so the production timeout's SIGKILL lands on the
  // one process holding stdout and the read settles at the production timeout.
  // (A plain `sleep 30` child inherits the pipe and held the read open for the
  // sleep's whole lifetime — fixture lifetime, not production behavior.)
  await withFakePs(t, "#!/bin/sh\nexec sleep 30\n", async () => {
    const started = Date.now();
    assert.deepEqual(await readHostRunStartIdentity(4242, { platform: "darwin" }), { kind: "unavailable" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4_000, "the read waited for the ps timeout instead of answering early");
    assert.ok(elapsed < 15_000, "the killed read settles at the production timeout, not the fixture child's lifetime");
  });
});

test("darwin canonical identity still parses through the production reader", async () => {
  // The canonical proof is the reader's classification of the `ps` line: read
  // the C-locale UTC line, parse it, accept or refuse. Whether the host
  // schedules a spawned `ps` inside the production 5 s liveness timeout is host
  // scheduling, not identity behavior — a loaded host answers `unavailable`,
  // which is production's correct timeout answer (milestone 5f82e054 at
  // ccea47c2: exactly that, after 5007 ms). The line here reaches the same
  // production classification path through the reader's read seam, with the
  // production default (a real spawned `ps`) untouched. The real spawn boundary
  // stays covered by the unavailable-shapes test above (real children whose
  // verdict is robust to scheduling), the timeout test (a real child killed by
  // the real timeout), and the live-process read in the hostRunOwnStartIdentity
  // cache test below.
  assert.deepEqual(await readHostRunStartIdentity(4242, {
    platform: "darwin",
    psStartLineRead: async () => ({ kind: "line", line: "Thu Oct  1 13:01:39 2026" }),
  }), {
    kind: "identity", identity: "4242@2026-10-01T13:01:39Z",
  });
});

test("linux identity reads separate a missing pid entry from missing metadata", async () => {
  const stat = "4242 ((a) b)) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 ...";
  const bootId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n";
  const files: Record<string, string> = { "/proc/sys/kernel/random/boot_id": bootId, "/proc/4242/stat": stat };
  const read = (path: string) => files[path]!;
  assert.deepEqual(await readHostRunStartIdentity(4242, { platform: "linux", readFileText: read }), {
    kind: "identity", identity: "4242@0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0:987654",
  });
  const missingStat = (path: string) => {
    if (path === "/proc/4242/stat") { const error = new Error("no entry") as Error & { code?: string }; error.code = "ENOENT"; throw error; }
    return files[path]!;
  };
  assert.deepEqual(await readHostRunStartIdentity(4242, { platform: "linux", readFileText: missingStat }), { kind: "gone" });
  // Missing boot metadata with an available PID entry is unavailable, never gone.
  const missingBoot = (path: string) => {
    if (path === "/proc/sys/kernel/random/boot_id") { const error = new Error("no boot id") as Error & { code?: string }; error.code = "ENOENT"; throw error; }
    return files[path]!;
  };
  assert.deepEqual(await readHostRunStartIdentity(4242, { platform: "linux", readFileText: missingBoot }), { kind: "unavailable" });
  // A permission failure on the PID entry itself is unavailable, never gone.
  assert.deepEqual(
    await readHostRunStartIdentity(4242, { platform: "linux", readFileText: () => { const error = new Error("denied") as Error & { code?: string }; error.code = "EACCES"; throw error; } }),
    { kind: "unavailable" },
  );
  // Partial, empty and malformed data never prove absence either.
  for (const [name, broken] of [["empty boot id", ""], ["malformed stat", "4242 broken"], ["empty stat", ""]] as const) {
    const brokenRead = (path: string) => (path === "/proc/sys/kernel/random/boot_id" ? (name === "empty boot id" ? broken : bootId) : broken);
    assert.deepEqual(await readHostRunStartIdentity(4242, { platform: "linux", readFileText: brokenRead }), { kind: "unavailable" }, name);
  }
});

test("identity proofs fail closed on unavailable and recover on the next read", async () => {
  let reads = 0;
  let observation: StartIdentityRead = { kind: "unavailable" };
  let live = true;
  const proofs = new RecordedIdentityProofs({
    read: async () => { reads++; return observation; },
    alive: () => live,
    now: () => 0,
    cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS,
  });
  assert.equal(await proofs.check(700, "700@2026-10-20T10:00:00Z"), "unknown");
  assert.equal(await proofs.check(700, "700@2026-10-20T10:00:00Z"), "unknown", "an unavailable observation is never cached as a verdict");
  assert.equal(reads, 2, "every unknown check re-reads the OS");
  // Only kernel ESRCH behind an unreadable read proves the absence it hid.
  live = false;
  assert.equal(await proofs.check(700, "700@2026-10-20T10:00:00Z"), false);
  // Recovery still proves normally once the identity is observable again.
  live = true;
  observation = { kind: "identity", identity: "700@2026-10-20T10:00:00Z" };
  assert.equal(await proofs.check(700, "700@2026-10-20T10:00:00Z"), true);
});

weighted(2)("startup adoption watches an unreadable escapee instead of settling", async t => {
  const f = await harness(t);
  const watched: string[] = [];
  const settled: string[] = [];
  (f.endpoint as any).watch.watchRun = (runId: string) => { watched.push(runId); };
  (f.endpoint as any).watch.settleFromResult = (run: { id: string }) => { settled.push(run.id); };
  const writeResult = (runId: string, pid: number, startIdentity: string) => {
    const now = new Date().toISOString();
    writeAtomicOwnedFile(join(f.stateDir, "runs", runId, "result.json"), JSON.stringify(hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId, epoch: 1, pgid: 2_100_000_001, startIdentity: "2100000001@fake",
      exitCode: 0, signal: null, startedAt: now, endedAt: now, wallMs: 1, cpuMs: 3,
      escapedDescendants: [{ pid, startIdentity }],
    })), 0o600);
  };
  const launch = (runId: string) => (f.endpoint as any).launch({ id: runId }, {});
  // An escapee pid with no observable identity (here: no /proc entry at all)
  // keeps the run watched: unknown is not dead.
  writeResult("adopt-unknown", 2_100_000_001, "2100000001@2026-10-20T10:00:00Z");
  launch("adopt-unknown");
  assert.deepEqual(watched, ["adopt-unknown"]);
  assert.deepEqual(settled, []);
  // A live escapee carrying its recorded identity also stays watched.
  const ownIdentity = hostRunProcessStartIdentity(process.pid);
  writeResult("adopt-live", process.pid, ownIdentity);
  launch("adopt-live");
  assert.deepEqual(watched, ["adopt-unknown", "adopt-live"]);
  assert.deepEqual(settled, []);
  // A successfully read different identity disproves the recorded one.
  writeResult("adopt-mismatch", process.pid, "1@1970-01-01T00:00:00Z");
  launch("adopt-mismatch");
  assert.deepEqual(watched, ["adopt-unknown", "adopt-live"]);
  assert.deepEqual(settled, ["adopt-mismatch"]);
});

weighted(2)("a genuinely dead escapee settles exactly once with no duplicate launch", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  const plan = readPlan(f.stateDir, runId);
  const now = new Date().toISOString();
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, JSON.stringify(hostRunResultSchema.parse({
    format: "host.run.result", version: 1, runId, epoch: 1, pgid: 2_100_000_001, startIdentity: "2100000001@fake",
    exitCode: 0, signal: null, startedAt: plan.startedAt, endedAt: now, wallMs: 1, cpuMs: 3,
    escapedDescendants: [{ pid: 2_100_000_002, startIdentity: "2100000002@2026-10-20T10:00:00Z" }],
  })), 0o600);
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(f.scheduler.get(runId)!.settlement!.outcome, "passed");
  assert.equal(f.fake.spawnCount(), 1, "settling never relaunches the supervisor");
  const settledAt = f.scheduler.get(runId)!.settlement!.settledAt;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
  assert.equal(f.scheduler.get(runId)!.settlement!.settledAt, settledAt, "one settlement only");
  assert.equal(f.fake.spawnCount(), 1);
});

weighted(2)("an unreadable supervisor identity keeps the run watched until ESRCH proves it gone", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  const observed = (f.endpoint as any).watch.identityProofs;
  assert.ok(observed, "the watch owns the proof cache the watch consults");
  (f.endpoint as any).watch.identityProofs = new RecordedIdentityProofs({
    read: async () => ({ kind: "unavailable" }) as StartIdentityRead,
    alive: () => true,
    now: () => Date.now(),
    cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS,
  });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  assert.notEqual(f.scheduler.get(runId)!.state, "settled", "unknown supervisor identity never settles lost");
  (f.endpoint as any).watch.identityProofs = new RecordedIdentityProofs({
    read: async () => ({ kind: "unavailable" }) as StartIdentityRead,
    alive: () => false,
    now: () => Date.now(),
    cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS,
  });
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(f.scheduler.get(runId)!.settlement!.outcome, "lost");
  assert.equal(f.fake.spawnCount(), 1, "declaring loss never relaunches the supervisor");
});

weighted(2)("a cached escapee death is re-proved fresh before settlement", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  const plan = readPlan(f.stateDir, runId);
  const now = new Date().toISOString();
  const liveIdentity = hostRunProcessStartIdentity(process.pid);
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, JSON.stringify(hostRunResultSchema.parse({
    format: "host.run.result", version: 1, runId, epoch: 1, pgid: 2_100_000_001, startIdentity: "2100000001@fake",
    exitCode: 0, signal: null, startedAt: plan.startedAt, endedAt: now, wallMs: 1, cpuMs: 3,
    escapedDescendants: [{ pid: process.pid, startIdentity: liveIdentity }],
  })), 0o600);
  // The first OS read claims the live escapee is gone; the fresh re-proof
  // sees its true identity, so the run must stay reserved.
  const observations: StartIdentityRead[] = [{ kind: "gone" }, { kind: "identity", identity: liveIdentity }];
  let reads = 0;
  (f.endpoint as any).watch.identityProofs = new RecordedIdentityProofs({
    read: async () => { reads++; return observations.shift() ?? { kind: "identity", identity: liveIdentity }; },
    alive: () => true,
    now: () => Date.now(),
    cacheMs: 60_000,
  });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 600));
  assert.notEqual(f.scheduler.get(runId)!.state, "settled", "a cached death never settles without a fresh proof");
  assert.equal(reads, 2, "the settlement path re-proved fresh instead of resting on the cache");
  await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
  assert.notEqual(f.scheduler.get(runId)!.state, "settled", "the live escapee keeps its capacity reserved");
  assert.equal(f.fake.spawnCount(), 1);
});

weighted(2)("a result landing during the supervisor proof settles from the result, never lost", async t => {
  const f = await harness(t);
  const wire = client(f.endpoint.socketPath);
  t.after(() => wire.destroy());
  const submitted = await call(wire, "submit", submitBody({ cancelOnDisconnect: false }), 1);
  const runId = submitted.body.runId as string;
  const plan = readPlan(f.stateDir, runId);
  let release: ((read: StartIdentityRead) => void) | null = null;
  (f.endpoint as any).watch.identityProofs = new RecordedIdentityProofs({
    read: () => new Promise<StartIdentityRead>(resolvePromise => { release = resolvePromise; }),
    alive: () => true,
    now: () => Date.now(),
    cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS,
  });
  const pending = (f.endpoint as any).watch.pollRunOnce(runId) as Promise<void>;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  assert.notEqual(release, null, "the watch is awaiting the supervisor identity proof");
  const now = new Date().toISOString();
  writeAtomicOwnedFile(hostRunSupervisorPaths(plan.stateDir, plan.runId).resultPath, JSON.stringify(hostRunResultSchema.parse({
    format: "host.run.result", version: 1, runId, epoch: 1, pgid: 2_100_000_001, startIdentity: "2100000001@fake",
    exitCode: 0, signal: null, startedAt: plan.startedAt, endedAt: now, wallMs: 1, cpuMs: 3,
    escapedDescendants: [],
  })), 0o600);
  release!({ kind: "gone" });
  await pending;
  assert.notEqual(f.scheduler.get(runId)?.settlement?.outcome, "lost", "no loss over the stale pre-result snapshot");
  await waitFor(() => f.scheduler.get(runId)!.state === "settled", HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(f.scheduler.get(runId)!.settlement!.outcome, "passed");
  assert.equal(f.fake.spawnCount(), 1);
});
