#!/usr/bin/env node
import { runtimeNodeArgs } from "../shared/runtime.mjs";
import { dataHome } from "../shared/data-home.mjs";
// Isolated host-run Client protocol v1 server for client acceptance (Effigy
// #058). It owns a throwaway Queue store and its own contract-010 state
// directory, so an acceptance run never touches the live Queue data directory
// or the live `~/.local/state/host-run` subtree. Run with the tsx loader
// available: node --import tsx bin/host-run-private-server.mjs --state-dir <dir>.
//
// It prints the authority record as one JSON line, then serves until SIGTERM or
// SIGINT, when it stops the endpoint and closes the store.
//
// Restart (Spec 035): with --supervise the process is a thin supervisor that
// runs the server as a child and replaces it the way a Queue service roll does.
// SIGUSR2 to the supervisor starts a warm standby child (modules loaded, store
// prewarmed read-only), then drains the old child; the standby opens the same
// store writable and the state directory only after the old pid has exited,
// binds the endpoint and prints the new authority line. Every authority line,
// first and after each restart, appears on the supervisor's stdout. SIGTERM or
// SIGINT stops the child and exits. Without --supervise the server is the
// single process described above.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

function canonical(path) {
  const resolved = resolve(path);
  try { return realpathSync(resolved); } catch { return resolved; }
}

function parseArgs(argv) {
  const index = argv.indexOf("--state-dir");
  const inline = argv.find(value => value.startsWith("--state-dir="))?.slice("--state-dir=".length);
  return { stateDir: index >= 0 ? argv[index + 1] : inline, supervise: argv.includes("--supervise") };
}

function refuse(reason) {
  console.error(`host-run private server refused: ${reason}`);
  process.exit(2);
}

const { stateDir, supervise } = parseArgs(process.argv.slice(2));
if (!stateDir) refuse("--state-dir <abs path> is required");
if (!resolve(stateDir).startsWith("/")) refuse("--state-dir must be an absolute path");

if (supervise) {
  await runSupervisor();
  // The supervisor never falls through to serve.
}

async function runSupervisor() {
  const script = new URL(import.meta.url).pathname;
  const childArgs = [...runtimeNodeArgs(), script, "--state-dir", stateDir];
  const { awaitStandbyProgress, standbyIsReady, STANDBY_READY_BUDGET_MS, STANDBY_READY_CAP_MS, STANDBY_READY_STALL_MS } = await import("../service/install/standby.ts");
  const { processCpuMs } = await import("../core/machine/process-tree-cpu.ts");
  let child = null;
  let stopping = false;
  let restarting = false;
  let waiter = null;
  const relay = (stream, onLine) => {
    let buffer = "";
    stream.on("data", chunk => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); onLine(line); }
    });
  };
  const start = standbyFor => {
    const env = { ...process.env };
    if (standbyFor) env.QUEUE_STANDBY_FOR_PID = String(standbyFor); else delete env.QUEUE_STANDBY_FOR_PID;
    const next = spawn(process.execPath, childArgs, { env, stdio: ["ignore", "pipe", "inherit"] });
    relay(next.stdout, line => { console.log(line); if (waiter && line.startsWith("{")) { const done = waiter; waiter = null; done(line); } });
    next.on("exit", code => {
      // Only the current child ends the supervisor; a replaced one is expected to exit.
      if (child === next) { if (!stopping) console.error(`host-run private server child exited (${code}); supervisor stopping`); process.exit(stopping ? 0 : 1); }
    });
    return next;
  };
  const exited = proc => new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode !== null) resolve(); else proc.once("exit", resolve); });
  // The same progress-bounded wait the service bridge uses (server/service/standby.ts).
  const awaitStandbyWarm = async (proc, replaced) => (await awaitStandbyProgress({
    ready: () => standbyIsReady(stateDir, proc.pid),
    alive: () => proc.exitCode === null && proc.signalCode === null,
    replacedExited: () => replaced.exitCode !== null || replaced.signalCode !== null,
    cpuMs: () => processCpuMs(proc.pid),
    now: () => performance.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }, { stallMs: STANDBY_READY_STALL_MS, capMs: STANDBY_READY_CAP_MS, budgetMs: STANDBY_READY_BUDGET_MS, pollMs: 25 })).warm;
  child = start();
  await new Promise(resolve => { waiter = resolve; });
  process.on("SIGUSR2", async () => {
    if (stopping || restarting) return;
    restarting = true;
    const old = child;
    // The standby holds its authority line back until the old child is gone.
    const ready = new Promise(resolve => { waiter = resolve; });
    child = start(old.pid);
    // Swap the staged socket onto the live path before draining, so followers
    // reconnecting across the restart never see ENOENT/ECONNREFUSED.
    await awaitStandbyWarm(child, old);
    old.kill("SIGTERM");
    await ready;
    restarting = false;
  });
  const stopAll = async () => {
    if (stopping) return;
    stopping = true;
    child?.kill("SIGTERM");
    if (child) await exited(child);
    process.exit(0);
  };
  process.on("SIGTERM", () => { void stopAll(); });
  process.on("SIGINT", () => { void stopAll(); });
  await new Promise(() => {});
}

const { Store } = await import("../core/store/store.ts");
const { HostRunScheduler } = await import("../core/host-runs/host-run-scheduler.ts");
const { HostRunEndpoint, defaultHostRunStateDir, hostRunSocketPath, readHostRunAuthority } = await import("../service/callbacks/host-run-endpoint.ts");
const { HostRunFront } = await import("../service/executor/host-run-front.ts");
const { markStandbyReady, clearStandbyReady } = await import("../service/install/standby.ts");

const target = canonical(stateDir);
const defaultStateDir = canonical(defaultHostRunStateDir());
// Queue's live data directory holds the live `queue.db` this throwaway store
// would collide with; the isolated server must stay out of it entirely.
const liveQueueDataDir = canonical(dataHome());
if (target === defaultStateDir) refuse(`--state-dir must not be the live host-run state directory (${defaultStateDir})`);
if (target === liveQueueDataDir || target.startsWith(`${liveQueueDataDir}${sep}`)) refuse(`--state-dir must not be under the live Queue data directory (${liveQueueDataDir})`);

// Warm standby: start the host-run front worker (its own thread) so it binds a
// staged socket and swaps it onto the live path before waiting for the old pid,
// so there is no client-visible gap and a blocked wait on this thread no longer
// stops accepting. The writable store open still waits for the old pid, so there
// is never a second owner; the front holds clients paused until then.
const standbyPid = Number(process.env.QUEUE_STANDBY_FOR_PID);
let hostRunFront = null;
if (Number.isInteger(standbyPid) && standbyPid > 0 && standbyPid !== process.pid) {
  process.on("exit", () => clearStandbyReady(target, process.pid));
  const { waitForStandbyHandoff } = await import("../service/install/standby-handoff.ts");
  try {
    hostRunFront = await HostRunFront.start({ stateDir: target, socketPath: hostRunSocketPath(target), takeLivePath: true });
  } catch (error) {
    console.error("host-run private server front handoff failed; falling back to bind after exit:", error instanceof Error ? error.message : String(error));
    try { await hostRunFront?.stop(); } catch { /* the later start still binds */ }
    hostRunFront = null;
  }
  markStandbyReady(target, process.pid);
  try { waitForStandbyHandoff(standbyPid, join(target, "queue.db")); }
  finally { clearStandbyReady(target, process.pid); }
}

const store = new Store(join(target, "queue.db"));
const scheduler = new HostRunScheduler(store, {
  capacity: () => ({ cpuCapacity: 1, memoryCapacityBytes: 512 * 1024 * 1024, freeMemoryBytes: 512 * 1024 * 1024, loadAverage: [0, 0, 0] }),
});
const endpoint = new HostRunEndpoint(scheduler, { stateDir: target, ...(hostRunFront ? { front: hostRunFront } : {}) });
try {
  await endpoint.start();
} catch (error) {
  try { await hostRunFront?.stop(); } catch { /* already gone */ }
  throw error;
}
const authority = readHostRunAuthority(target);
if (!authority) {
  console.error("host-run private server could not read back the authority record it published");
  process.exit(1);
}
console.log(JSON.stringify(authority));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await endpoint.stop(); } catch { /* best effort */ }
  try { scheduler.stop(); } catch { /* timers only */ }
  try { store.close(); } catch { /* best effort */ }
  process.exit(0);
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
process.on("uncaughtException", error => {
  console.error("host-run private server uncaught exception:", error);
  void stop();
});
