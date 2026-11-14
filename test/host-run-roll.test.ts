/**
 * A real Queue service roll keeps contract 010's endpoint reachable with a
 * make-before-break staged-socket swap (Spec 035, "Endpoint across a roll").
 *
 * Every roll here replaces one real service process with another through the
 * bridge's drain-and-replace path (a different login session makes the old
 * service incompatible), on isolated dirs and HOME. A probe connects to the
 * scheduler socket every few milliseconds; the gap is the time from the last
 * accept by the old endpoint to the first accept by the new one, and must stay
 * under 500 ms with no ECONNREFUSED/ENOENT.
 *
 * These are wall-clock acceptance oracles over real process scheduling: under
 * the parallel suite's fixture contention they measure starvation, not the
 * handoff (2026-10-15 milestone QA), so they run as serial `timingTest`
 * oracles in `npm run test:timing` and skip the parallel suite. The contract
 * budgets (500 ms gap, 5 s reconnect window) are unchanged.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { extname, join } from "node:path";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ServiceBridge } from "../hosts/paseo/plugin/bridge";
import { readServiceInfo } from "../service/transport/identity";
import { RPC_CATALOGUE } from "../shared/rpc-catalogue";
import { HOST_RUN_HANDOFF_GAP_MS, HOST_RUN_RECONNECT_WINDOW_MS, hostRunSocketPath, readHostRunAuthority, readHostRunTokenKeys } from "../service/callbacks/host-run-endpoint";
import { verifyRunToken } from "./host-run-token-fixture";
import { bridgeSupport } from "./support/bridge-fixture";
import { describeFollowerRefusals, describeRefusals, gapIn, type RollWindow } from "./support/roll-oracle";
import { startProbeObserver, type ProbeObserver } from "./support/roll-oracle-observer";
import { timingTest, performanceAssert } from "./support/timing";
import { scratchFixtureParent } from "./support/scratch-fixture";

const { spawnedPids, trackedBridge } = bridgeSupport("hrr");
const ROLLS = 5;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const now = () => performance.now();
const step = (message: string) => console.log(`[roll] ${message}`);

/**
 * The probe runs on its own worker thread (startProbeObserver): fixture
 * orchestration on this executor used to pause it and fail the 100 ms coverage
 * bound on code-owned silence. Flush before reading samples so every
 * observation through the read is present.
 */

/** Use the production standalone entry, changing only its explicit fixture state root. */
function fixtureServiceCommand(root: string) {
  const stateDir = join(root, "s");
  assert.ok(root.startsWith(`${scratchFixtureParent()}/`));
  assert.notEqual(stateDir, join(userInfo().homedir, ".local/state/host-run"));
  const standalone = new URL("../service/standalone.ts", import.meta.url);
  const entry = join(root, "service.mts");
  const source = readFileSync(standalone, "utf8");
  assert.equal(source.split("hostRunEndpoint: true,").length, 2);
  const fixture = source.replace("hostRunEndpoint: true,", `hostRunEndpoint: true, hostRunStateDir: ${JSON.stringify(stateDir)},`)
    .replace(/from "(\.[^"]+)"/g, (_, specifier: string) => `from "${fixtureImportUrl(specifier, standalone)}"`);
  writeFileSync(entry, fixture + "\nawait runStandaloneService();\n");
  return () => ({ command: process.execPath, args: ["--import", "tsx", entry] });
}

/** Resolve fixture imports like the TypeScript runtime: exact files, `.ts` files, and folder barrels. */
function fixtureImportUrl(specifier: string, parent: URL): string {
  const path = fileURLToPath(new URL(specifier, parent));
  const extension = extname(path);
  const candidates = [
    path,
    ...(extension === ".js" ? [path.slice(0, -3) + ".ts"] : []),
    ...(extension ? [] : [`${path}.ts`, join(path, "index.ts")]),
  ];
  const resolved = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  assert.ok(resolved, `fixture import ${specifier} must resolve from ${parent.pathname}`);
  return pathToFileURL(resolved).href;
}

/**
 * An isolated roll fixture plus a replacement command whose prelude delays the
 * standby's module load. The prelude runs before the service's own modules, so it
 * simulates the slow live standby without touching the old service.
 */
function slowRollFixture() {
  const root = realpathSync(mkdtempSync(join(scratchFixtureParent(), "h")));
  const home = join(root, "h");
  mkdirSync(home, { recursive: true });
  const paseoHome = root, dataDir = join(root, "northstar-queue");
  writeFileSync(join(paseoHome, "config.json"), JSON.stringify({ plugins: { nucleus: { path: fileURLToPath(new URL("..", import.meta.url)) } } }), { mode: 0o600 });
  const slowImport = join(root, "slow-load.mjs");
  // HRR_SLOW_LOAD_BUSY spins instead of sleeping: a slow load that is visibly making CPU progress.
  writeFileSync(slowImport, `const ms = Number(process.env.HRR_SLOW_LOAD_MS || 0);\nif (ms > 0 && process.env.HRR_SLOW_LOAD_BUSY === "1") { const end = Date.now() + ms; while (Date.now() < end) {} }\nelse if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);\n`);
  const serviceCommand = fixtureServiceCommand(root);
  const slowServiceCommand = () => ({ command: process.execPath, args: ["--import", slowImport, ...serviceCommand().args] });
  return { root, home, paseoHome, dataDir, stateDir: join(root, "s"), serviceCommand, slowServiceCommand };
}

/** Release every service and env change a slow-roll test made, then remove its root. */
async function cleanupSlowRollFixture(fixture: ReturnType<typeof slowRollFixture>, bridges: ServiceBridge[], saved: { home: string | undefined; slow: string | undefined }) {
  for (const bridge of bridges) bridge.close();
  const info = readServiceInfo(fixture.dataDir);
  // Task 191: stop the service's whole process group, not just its pid.
  if (info) { try { process.kill(-info.pid, "SIGTERM"); } catch { try { process.kill(info.pid, "SIGTERM"); } catch { /* gone */ } } }
  const deadline = Date.now() + 15_000;
  while (info && Date.now() < deadline) { try { process.kill(info.pid, 0); await sleep(100); } catch { break; } }
  if (info) { try { process.kill(info.pid, 0); process.kill(-info.pid, "SIGKILL"); } catch { /* gone */ } }
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.slow === undefined) delete process.env.HRR_SLOW_LOAD_MS; else process.env.HRR_SLOW_LOAD_MS = saved.slow;
  delete process.env.HRR_SLOW_LOAD_BUSY;
  // The queue owns disposal of the recorded scratch root.
}

interface WireLine { [key: string]: any }

function lines(socket: Socket, onLine: (line: WireLine) => void) {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) { const text = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (text) onLine(JSON.parse(text)); }
  });
}

function request(path: string, method: string, epoch: number, body: unknown): Promise<WireLine> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    let socket: Socket | null = null;
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      socket?.destroy();
      reject(new Error(`${method} timed out`));
    }, 10_000);
    const attempt = () => {
      if (finished) return;
      const current = connect(path);
      socket = current;
      let connected = false;
      lines(current, line => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        current.destroy();
        resolve(line);
      });
      current.once("error", error => {
        if (finished) return;
        const code = (error as NodeJS.ErrnoException).code;
        current.destroy();
        if (!connected && ["ECONNREFUSED", "ENOENT"].includes(code ?? "") && Date.now() < deadline) {
          // No request was sent, so retrying a not-yet-listening socket is safe.
          setTimeout(attempt, Math.min(25, deadline - Date.now()));
          return;
        }
        finished = true;
        clearTimeout(timer);
        reject(error);
      });
      current.once("connect", () => {
        connected = true;
        current.write(`${JSON.stringify({ v: 1, id: randomUUID(), method, epoch, body })}\n`);
      });
    };
    attempt();
  });
}

/** An attach client that reconnects from its own offsets, like Effigy's follower. */
function follower(path: string, epoch: number, runId: string) {
  const offsets = { stdout: 0, stderr: 0 };
  const text = { stdout: "", stderr: "" };
  const reconnects: number[] = [];
  const settlements: unknown[] = [];
  const errors: string[] = [];
  const refused: Array<{ code: string; at: number }> = [];
  const startedAt = now();
  let stopped = false;
  let droppedAt = 0;
  let current: Socket | null = null;
  const loop = (async () => {
    while (!stopped && settlements.length === 0) {
      await new Promise<void>(resolve => {
        const socket = connect(path);
        current = socket;
        let attached = false;
        socket.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code) refused.push({ code: error.code, at: now() - startedAt });
          socket.destroy();
        });
        socket.once("close", () => resolve());
        socket.once("connect", () => {
          if (droppedAt) { reconnects.push(now() - droppedAt); droppedAt = 0; }
          attached = true;
          socket.write(`${JSON.stringify({ v: 1, id: randomUUID(), method: "attach", epoch, body: { runId, fromOffset: { ...offsets } } })}\n`);
        });
        lines(socket, line => {
          if (line.ok === false) { errors.push(`${line.error?.code}: ${line.error?.message}`); return; }
          if (line.event === "output") {
            const stream = line.stream as "stdout" | "stderr";
            if (line.offset !== offsets[stream]) { errors.push(`${stream} offset ${line.offset} but expected ${offsets[stream]}`); return; }
            const data = Buffer.from(line.dataB64, "base64");
            offsets[stream] += data.length;
            text[stream] += data.toString("utf8");
          } else if (line.event === "settled") settlements.push(line.settlement);
        });
        socket.once("close", () => { if (attached && !droppedAt && settlements.length === 0) droppedAt = now(); });
      });
      if (settlements.length === 0) await sleep(10);
    }
  })();
  return { offsets, text, reconnects, settlements, errors, refused, stop: async () => { stopped = true; current?.destroy(); await loop; }, done: () => loop };
}

const SCRIPT = `
const fs = require("node:fs");
const dir = process.argv[2];
fs.writeFileSync(dir + "/token", process.env.HOST_RUN_TOKEN || "");
let n = 0;
const tick = () => {
  if (fs.existsSync(dir + "/release")) { process.stdout.write("done\\n"); process.exit(0); }
  process.stdout.write("out " + n + "\\n");
  if (n % 3 === 0) process.stderr.write("err " + n + "\\n");
  n++;
  setTimeout(tick, 100);
};
tick();
`;

timingTest("a Queue service roll keeps the host-run endpoint inside the 5 s window and the run intact", { timeout: 240_000 }, async t => {
  // A short root keeps the scheduler socket under the 104-byte unix path limit.
  const root = realpathSync(mkdtempSync(join(scratchFixtureParent(), "h")));
  const home = join(root, "h");
  const work = join(root, "w");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const paseoHome = root, dataDir = join(root, "northstar-queue");
  writeFileSync(join(paseoHome, "config.json"), JSON.stringify({ plugins: { nucleus: { path: fileURLToPath(new URL("..", import.meta.url)) } } }), { mode: 0o600 });
  writeFileSync(join(work, "run.cjs"), SCRIPT);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const stateDir = join(root, "s");
  const serviceCommand = fixtureServiceCommand(root);
  const bridges: ServiceBridge[] = [];
  const entry = RPC_CATALOGUE.find(candidate => candidate.name === "queue.ui-snapshot")!;
  const bridgeFor = (session: string) => {
    const bridge = trackedBridge({ dataDir, paseoHome, sessionId: session, serviceCommand, readinessBudgetMs: 120_000 });
    bridges.push(bridge);
    return bridge;
  };
  let observer: ProbeObserver | null = null;
  let tail: ReturnType<typeof follower> | null = null;
  const pids: number[] = [];
  t.after(async () => {
    writeFileSync(join(work, "release"), "");
    await observer?.stop();
    await tail?.stop();
    for (const bridge of bridges) bridge.close();
    // Task 191: stop every service this test started — including rolled
    // predecessors the identity file no longer names — as whole process
    // groups, on failure and timeout paths alike.
    const info = readServiceInfo(dataDir);
    const targets = new Set([...pids, ...(info ? [info.pid] : [])]);
    for (const pid of targets) { try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } } }
    const deadline = Date.now() + 15_000;
    while ([...targets].some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }) && Date.now() < deadline) await sleep(100);
    for (const pid of targets) { try { process.kill(pid, 0); process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
    process.env.HOME = savedHome;
    // Leave fixture disposal to the queue-owned scratch lifetime.
  });

  step("boot service 0");
  await bridgeFor("roll-0").forward(entry, {});
  step("service 0 up");
  const socketPath = hostRunSocketPath(stateDir);
  const authority0 = readHostRunAuthority(stateDir)!;
  assert.ok(authority0, "the first service published its authority record");
  const keys0 = readHostRunTokenKeys(stateDir)!;
  const epoch = authority0.epoch;

  // The run: a real detached supervisor, held open until the test releases it.
  const clientRequestId = randomUUID();
  const body = {
    clientRequestId, caller: "effigy@roll-test", repository: "example/host-runs", cwd: work, selector: "roll:probe",
    argv: [process.execPath, join(work, "run.cjs"), work], class: "light", classSource: "manifest", priority: "interactive",
    budgetFallback: { cpu: 1, memoryBytes: 100_000_000 }, capacityDeadlineMs: 1_800_000, runTimeoutMs: 3_600_000,
    env: {},
    // The release file owns this test run's lifetime across service rolls.
    cancelOnDisconnect: false,
  };
  step("submit");
  const submitted = await request(socketPath, "submit", epoch, body);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const runId = submitted.body.runId as string;
  for (let attempt = 0; attempt < 200 && !existsSync(join(work, "token")); attempt++) await sleep(50);
  let before = (await request(socketPath, "status", epoch, { runId })).body;
  for (let attempt = 0; attempt < 100 && !(before.state === "running" && before.pid); attempt++) { await sleep(50); before = (await request(socketPath, "status", epoch, { runId })).body; }
  assert.equal(before.state, "running");
  const token = readFileSync(join(work, "token"), "utf8");
  assert.ok(token, "the launched command received its run token");
  const tokenValid = () => verifyRunToken(token, { keys: readHostRunTokenKeys(stateDir)!, epoch: readHostRunAuthority(stateDir)!.epoch, cwd: work }).valid;
  assert.equal(tokenValid(), true);

  step("run launched");
  tail = follower(socketPath, epoch, runId);
  observer = await startProbeObserver(socketPath);
  await sleep(300);

  const windows: RollWindow[] = [];
  pids.push(authority0.pid);
  for (let roll = 1; roll <= ROLLS; roll++) {
    step(`roll ${roll}`);
    const started = now();
    await bridgeFor(`roll-${roll}`).forward(entry, {});
    const finished = now();
    step(`roll ${roll} forwarded in ${(finished - started).toFixed(0)} ms`);
    await sleep(400);
    await observer.flush();
    windows.push({ roll, from: started, to: finished + 400 });
    const authority = readHostRunAuthority(stateDir)!;
    assert.notEqual(authority.pid, pids[pids.length - 1], "a different service process now holds the endpoint");
    pids.push(authority.pid);
    assert.equal(authority.epoch, epoch, "a roll does not advance the epoch");
    assert.deepEqual(readHostRunTokenKeys(stateDir), keys0, "a roll does not rotate the token keys");
    assert.equal(tokenValid(), true, "the run's token stays valid across the roll");
    step("checked token");
    const status = (await request(socketPath, "status", epoch, { runId })).body;
    assert.equal(status.runId, runId);
    assert.equal(status.epoch, before.epoch);
    assert.equal(status.state, "running");
    assert.equal(status.pid, before.pid, "the run's process was not relaunched");
    assert.equal(status.startIdentity, before.startIdentity);
  }
  await observer.stop();
  // Measure every window over the observer's complete lifetime, so a refusal
  // interval is measured through either window edge, and a window failure
  // carries the lifetime's bounded refusal evidence naming the phase.
  const gaps = windows.map(window => {
    try { return gapIn(observer.samples, window.from, window.to); }
    catch (cause) {
      const evidence = describeRefusals(observer.samples, windows);
      throw new Error(`${(cause as Error).message}${evidence ? ` ${evidence}` : ""}`, { cause });
    }
  });
  const max = Math.max(...gaps);
  console.log(`host-run endpoint gap over ${ROLLS} rolls (ms): ${gaps.map(gap => gap.toFixed(0)).join(", ")}; max ${max.toFixed(0)}`);
  t.diagnostic(`host-run endpoint gaps ms: ${gaps.map(gap => gap.toFixed(0)).join(", ")}; max ${max.toFixed(0)}`);
  performanceAssert(max <= HOST_RUN_HANDOFF_GAP_MS, `the endpoint gap ${max.toFixed(0)} ms exceeds the ${HOST_RUN_HANDOFF_GAP_MS} ms handoff bound`);
  assert.ok(tail.errors.length === 0, `follower errors: ${tail.errors.join("; ")}`);
  assert.ok(!tail.refused.some(refusal => refusal.code === "ECONNREFUSED" || refusal.code === "ENOENT"),
    `follower refused: ${describeFollowerRefusals(tail.refused)}`);
  assert.ok(!observer.samples.some(sample => sample.code === "ECONNREFUSED" || sample.code === "ENOENT"),
    `the live path returned ECONNREFUSED or ENOENT: ${describeRefusals(observer.samples, windows)}`);
  assert.ok(tail.reconnects.length >= ROLLS, "the follower reattached across every roll");
  performanceAssert(Math.max(...tail.reconnects) <= HOST_RUN_RECONNECT_WINDOW_MS, "every reattach landed inside the reconnect window");

  // Settle once, with the original result, after the last roll.
  writeFileSync(join(work, "release"), "");
  await Promise.race([tail.done(), sleep(30_000)]);
  assert.equal(tail.settlements.length, 1, "attach delivered exactly one settlement");
  const settled = (await request(socketPath, "status", epoch, { runId })).body;
  assert.equal(settled.state, "settled");
  assert.equal(settled.runId, runId);
  assert.equal(settled.epoch, before.epoch);
  assert.equal(settled.pid, before.pid);
  assert.deepEqual(settled.settlement, tail.settlements[0]);
  assert.equal(settled.settlement.outcome ?? settled.settlement.exitCode === 0 ? "ok" : "bad", "ok");

  // Output: contiguous from offset 0 with no gap or duplicate across all reattaches.
  const out = tail.text.stdout.split("\n").filter(Boolean);
  assert.equal(out[out.length - 1], "done");
  out.slice(0, -1).forEach((line, index) => assert.equal(line, `out ${index}`, "stdout counted without a gap or duplicate"));
  const err = tail.text.stderr.split("\n").filter(Boolean);
  err.forEach((line, index) => assert.equal(line, `err ${index * 3}`, "stderr counted without a gap or duplicate"));

  // One more roll after settlement leaves the settled run untouched.
  await bridgeFor("roll-after").forward(entry, {});
  const after = (await request(socketPath, "status", epoch, { runId })).body;
  assert.deepEqual(after.settlement, settled.settlement);
  assert.equal(after.settledAt, settled.settledAt);
});

timingTest("a slow standby load is awaited before the drain, keeping the endpoint gap under 1 s", { timeout: 180_000 }, async t => {
  const fixture = slowRollFixture();
  const { paseoHome, dataDir, stateDir, serviceCommand, slowServiceCommand } = fixture;
  const saved = { home: process.env.HOME, slow: process.env.HRR_SLOW_LOAD_MS };
  process.env.HOME = fixture.home;
  const bridges: ServiceBridge[] = [];
  const entry = RPC_CATALOGUE.find(candidate => candidate.name === "queue.ui-snapshot")!;
  let observer: ProbeObserver | null = null;
  t.after(async () => {
    await observer?.stop();
    await cleanupSlowRollFixture(fixture, bridges, saved);
  });

  // Boot the first service with the ordinary command; only the replacement loads slowly.
  const first = trackedBridge({ dataDir, paseoHome, sessionId: "slow-roll-0", serviceCommand, readinessBudgetMs: 120_000 });
  bridges.push(first);
  await first.forward(entry, {});
  const original = readServiceInfo(dataDir)!;

  // The standby's module load (1.5 s per process) is longer than the old service's
  // drain, so without the readiness gate the endpoint gap would include it.
  process.env.HRR_SLOW_LOAD_MS = "1500";
  const socketPath = hostRunSocketPath(stateDir);
  observer = await startProbeObserver(socketPath);
  await sleep(200);

  const slow = trackedBridge({ dataDir, paseoHome, sessionId: "slow-roll-1", serviceCommand: slowServiceCommand, readinessBudgetMs: 120_000 });
  bridges.push(slow);
  const started = now();
  await slow.forward(entry, {});
  const finished = now();
  await sleep(300);

  const readiness = slow.standbyReadiness();
  const replacement = readServiceInfo(dataDir)!;
  await observer.flush();
  const gap = gapIn(observer.samples, started, finished + 300);
  console.log(`slow-standby endpoint gap ${gap.toFixed(0)} ms; standby readiness waited ${readiness?.waitedMs ?? -1} ms`);
  t.diagnostic(`slow-standby endpoint gap ${gap.toFixed(0)} ms`);

  assert.notEqual(replacement.pid, original.pid, "the standby became the new service");
  assert.equal(readiness?.warm, true, "the bridge saw the standby report loaded before the drain");
  assert.ok((readiness?.waitedMs ?? 0) >= 1_000, "the bridge waited for the slow load instead of draining immediately");
  performanceAssert(gap <= HOST_RUN_HANDOFF_GAP_MS, `the endpoint gap ${gap.toFixed(0)} ms must stay under ${HOST_RUN_HANDOFF_GAP_MS} ms even with a slow standby load`);
  assert.ok(!observer.samples.some(sample => sample.code === "ECONNREFUSED" || sample.code === "ENOENT"),
    `the live path returned ECONNREFUSED or ENOENT: ${describeRefusals(observer.samples, [{ roll: 1, from: started, to: finished + 300 }])}`);
});

timingTest("a slow standby load that keeps using CPU is waited for past the wall-clock budget and stall window", { timeout: 180_000 }, async t => {
  const fixture = slowRollFixture();
  const { paseoHome, dataDir, stateDir, serviceCommand, slowServiceCommand } = fixture;
  const saved = { home: process.env.HOME, slow: process.env.HRR_SLOW_LOAD_MS };
  process.env.HOME = fixture.home;
  const bridges: ServiceBridge[] = [];
  const entry = RPC_CATALOGUE.find(candidate => candidate.name === "queue.ui-snapshot")!;
  let observer: ProbeObserver | null = null;
  t.after(async () => {
    await observer?.stop();
    await cleanupSlowRollFixture(fixture, bridges, saved);
  });

  const first = trackedBridge({ dataDir, paseoHome, sessionId: "busy-roll-0", serviceCommand, readinessBudgetMs: 120_000 });
  bridges.push(first);
  await first.forward(entry, {});
  const original = readServiceInfo(dataDir)!;

  // Milestone QA b3a1c6d1 (2026-10-22): a standby still loading under host load
  // passed the old fixed bound and the drain left a 3.3 s gap. Scaled down: the
  // load spins for 4 s, past a 300 ms wall-clock budget and a 1 s stall window,
  // so only CPU progress keeps the bridge waiting.
  process.env.HRR_SLOW_LOAD_MS = "4000";
  process.env.HRR_SLOW_LOAD_BUSY = "1";
  const socketPath = hostRunSocketPath(stateDir);
  observer = await startProbeObserver(socketPath);
  await sleep(200);

  let spawns = 0;
  const counted = () => { spawns++; return slowServiceCommand(); };
  const slow = trackedBridge({ dataDir, paseoHome, sessionId: "busy-roll-1", serviceCommand: counted, readinessBudgetMs: 120_000,
    standbyReadyStallMs: 1_000, standbyReadyBudgetMs: 300, standbyReadyCapMs: 60_000 });
  bridges.push(slow);
  const started = now();
  const rolling = slow.forward(entry, {});
  // The standby wait keeps the spawn claim fresh (Sol #593): an aged claim is
  // rewritten, so another bridge reads a live spawn (bridge-cutover covers that
  // reader) instead of reclaiming it and spawning beside this standby.
  const claimPath = join(dataDir, "queue-service.claim.json");
  await sleep(1_500);
  writeFileSync(claimPath, JSON.stringify({ ...JSON.parse(readFileSync(claimPath, "utf8")), at: new Date(Date.now() - 46_000).toISOString() }));
  await sleep(600);
  assert.ok(Date.now() - Date.parse(JSON.parse(readFileSync(claimPath, "utf8")).at) < 1_000, "the claim is fresh again during the standby wait");
  await rolling;
  const finished = now();
  await sleep(300);

  const readiness = slow.standbyReadiness();
  const replacement = readServiceInfo(dataDir)!;
  await observer.flush();
  const gap = gapIn(observer.samples, started, finished + 300);
  t.diagnostic(`busy-standby endpoint gap ${gap.toFixed(0)} ms; readiness ${readiness?.cause} after ${readiness?.waitedMs ?? -1} ms, cpu ${readiness?.cpuMs ?? "unmeasured"} ms`);

  assert.notEqual(replacement.pid, original.pid, "the standby became the new service");
  assert.equal(spawns, 1, "one standby for the roll");
  assert.ok(readiness?.cpuMs !== null, "the standby's CPU time was measured on this host");
  assert.equal(readiness?.warm, true, "CPU progress kept the bridge waiting until the standby reported loaded");
  assert.ok((readiness?.waitedMs ?? 0) >= 3_000, `the bridge waited past the 300 ms budget and 1 s stall window (${readiness?.waitedMs} ms)`);
  performanceAssert(gap <= HOST_RUN_HANDOFF_GAP_MS, `the endpoint gap ${gap.toFixed(0)} ms must stay under ${HOST_RUN_HANDOFF_GAP_MS} ms`);
  assert.ok(!observer.samples.some(sample => sample.code === "ECONNREFUSED" || sample.code === "ENOENT"),
    `the live path returned ECONNREFUSED or ENOENT: ${describeRefusals(observer.samples, [{ roll: 1, from: started, to: finished + 300 }])}`);
});

timingTest("a second bridge that finds the spawn claimed waits for the owner's replacement and never drains the old service (papercut a6c9a2ac)", { timeout: 240_000 }, async t => {
  const fixture = slowRollFixture();
  const { paseoHome, dataDir, stateDir, serviceCommand, slowServiceCommand } = fixture;
  const saved = { home: process.env.HOME, slow: process.env.HRR_SLOW_LOAD_MS };
  process.env.HOME = fixture.home;
  const bridges: ServiceBridge[] = [];
  const entry = RPC_CATALOGUE.find(candidate => candidate.name === "queue.ui-snapshot")!;
  let observer: ProbeObserver | null = null;
  t.after(async () => {
    await observer?.stop();
    await cleanupSlowRollFixture(fixture, bridges, saved);
  });

  const first = trackedBridge({ dataDir, paseoHome, sessionId: "pair-roll-0", serviceCommand, readinessBudgetMs: 120_000 });
  bridges.push(first);
  await first.forward(entry, {});
  const original = readServiceInfo(dataDir)!;

  // The owner's standby keeps the CPU busy for 4 s, longer than the waiter's plain 300 ms readiness budget.
  process.env.HRR_SLOW_LOAD_MS = "4000";
  process.env.HRR_SLOW_LOAD_BUSY = "1";
  const socketPath = hostRunSocketPath(stateDir);
  observer = await startProbeObserver(socketPath);
  await sleep(200);

  let ownerSpawns = 0, waiterSpawns = 0;
  const owner = trackedBridge({ dataDir, paseoHome, sessionId: "pair-roll-1", serviceCommand: () => { ownerSpawns++; return slowServiceCommand(); }, readinessBudgetMs: 120_000,
    standbyReadyStallMs: 1_000, standbyReadyBudgetMs: 300, standbyReadyCapMs: 60_000 });
  bridges.push(owner);
  const started = now();
  const rolling = owner.forward(entry, {});
  await sleep(1_500);
  // A second window rolls to the same build while the owner's standby is still loading.
  const waiter = trackedBridge({ dataDir, paseoHome, sessionId: "pair-roll-1", serviceCommand: () => { waiterSpawns++; return slowServiceCommand(); }, readinessBudgetMs: 300 });
  bridges.push(waiter);
  const waiting = waiter.forward(entry, {});
  const [ownerServed, waiterServed] = await Promise.all([rolling, waiting]) as Record<string, unknown>[];
  const finished = now();
  await sleep(300);

  const readiness = owner.standbyReadiness();
  const replacement = readServiceInfo(dataDir)!;
  await observer.flush();
  const gap = gapIn(observer.samples, started, finished + 300);
  t.diagnostic(`paired roll endpoint gap ${gap.toFixed(0)} ms; owner readiness ${readiness?.cause} after ${readiness?.waitedMs ?? -1} ms`);

  assert.equal(ownerSpawns, 1, "the claim owner spawned the one standby");
  assert.equal(waiterSpawns, 0, "the waiter spawned nothing");
  assert.equal(readiness?.warm, true, "nothing drained the old service under the owner: its standby reported loaded first");
  assert.equal(readiness?.cause, "ready");
  assert.notEqual(replacement.pid, original.pid, "the owner's standby became the service");
  assert.ok(Array.isArray(ownerServed.tasks) && Array.isArray(waiterServed.tasks), "both bridges are served by the replacement");
  assert.equal(waiter.current().state, "running");
  performanceAssert(gap <= HOST_RUN_HANDOFF_GAP_MS, `the endpoint gap ${gap.toFixed(0)} ms must stay under ${HOST_RUN_HANDOFF_GAP_MS} ms`);
  assert.ok(!observer.samples.some(sample => sample.code === "ECONNREFUSED" || sample.code === "ENOENT"),
    `the live path returned ECONNREFUSED or ENOENT: ${describeRefusals(observer.samples, [{ roll: 1, from: started, to: finished + 300 }])}`);
});

timingTest("a waiter in another login session never adopts the claim owner's replacement; its next attempt rolls its own (review #601)", { timeout: 300_000 }, async t => {
  const fixture = slowRollFixture();
  const { paseoHome, dataDir, serviceCommand, slowServiceCommand } = fixture;
  const saved = { home: process.env.HOME, slow: process.env.HRR_SLOW_LOAD_MS };
  process.env.HOME = fixture.home;
  const bridges: ServiceBridge[] = [];
  const entry = RPC_CATALOGUE.find(candidate => candidate.name === "queue.ui-snapshot")!;
  t.after(async () => { await cleanupSlowRollFixture(fixture, bridges, saved); });

  const first = trackedBridge({ dataDir, paseoHome, sessionId: "trio-0", serviceCommand, readinessBudgetMs: 120_000 });
  bridges.push(first);
  await first.forward(entry, {});
  process.env.HRR_SLOW_LOAD_MS = "3000";
  process.env.HRR_SLOW_LOAD_BUSY = "1";
  const owner = trackedBridge({ dataDir, paseoHome, sessionId: "trio-1", serviceCommand: slowServiceCommand, readinessBudgetMs: 120_000,
    standbyReadyStallMs: 1_000, standbyReadyBudgetMs: 300, standbyReadyCapMs: 60_000 });
  bridges.push(owner);
  const rolling = owner.forward(entry, {});
  await sleep(1_500);
  const waiter = trackedBridge({ dataDir, paseoHome, sessionId: "trio-2", serviceCommand: slowServiceCommand, readinessBudgetMs: 120_000,
    standbyReadyStallMs: 1_000, standbyReadyBudgetMs: 300, standbyReadyCapMs: 60_000 });
  bridges.push(waiter);
  const waited = await waiter.forward(entry, {}).then(() => "served", (error: unknown) => String(error));
  await rolling;
  assert.equal(readServiceInfo(dataDir)!.sessionId, "trio-1", "the owner's replacement serves the owner's session");
  assert.notEqual(waited, "served", "the waiter did not adopt the trio-1 replacement");
  assert.match(waited, /did not become ready while its spawn claim was live/);
  assert.equal(owner.standbyReadiness()?.warm, true, "the waiter never drained under the owner");
  // Its next attempt finds the trio-1 service incompatible with trio-2 and rolls its own.
  await waiter.forward(entry, {});
  assert.equal(readServiceInfo(dataDir)!.sessionId, "trio-2");
  assert.equal(waiter.current().state, "running");
});

timingTest("a standby that never reports loaded is drained past at the stall bound and recorded as not warm", { timeout: 180_000 }, async t => {
  const fixture = slowRollFixture();
  const { paseoHome, dataDir, serviceCommand, slowServiceCommand } = fixture;
  const saved = { home: process.env.HOME, slow: process.env.HRR_SLOW_LOAD_MS };
  process.env.HOME = fixture.home;
  const bridges: ServiceBridge[] = [];
  const entry = RPC_CATALOGUE.find(candidate => candidate.name === "queue.ui-snapshot")!;
  t.after(async () => { await cleanupSlowRollFixture(fixture, bridges, saved); });

  const first = trackedBridge({ dataDir, paseoHome, sessionId: "cold-roll-0", serviceCommand, readinessBudgetMs: 120_000 });
  bridges.push(first);
  await first.forward(entry, {});
  const original = readServiceInfo(dataDir)!;

  // The standby sleeps two seconds without using CPU before it loads; with a
  // 300 ms stall window (and the same unmeasurable-CPU budget) the bridge must
  // drain past it when that bound expires.
  process.env.HRR_SLOW_LOAD_MS = "2000";
  const slow = trackedBridge({ dataDir, paseoHome, sessionId: "cold-roll-1", serviceCommand: slowServiceCommand, readinessBudgetMs: 120_000, standbyReadyStallMs: 300, standbyReadyBudgetMs: 300 });
  bridges.push(slow);
  const served = await slow.forward(entry, {}) as Record<string, unknown>;

  const readiness = slow.standbyReadiness();
  const replacement = readServiceInfo(dataDir)!;
  assert.equal(readiness?.warm, false, "the bridge recorded that the standby was not warm");
  assert.ok(readiness?.cause === "stalled" || readiness?.cause === "unmeasured_budget", `the wait ended on the stall bound (${readiness?.cause})`);
  assert.ok((readiness?.waitedMs ?? 0) >= 250 && (readiness?.waitedMs ?? 0) <= 1_000, `the readiness wait was bounded (${readiness?.waitedMs ?? -1} ms)`);
  assert.notEqual(replacement.pid, original.pid, "the roll still completed with the replacement service");
  assert.equal(slow.current().state, "running", "the replacement answers after the roll");
  assert.ok(Array.isArray(served.tasks), "the replacement serves reads");
});
