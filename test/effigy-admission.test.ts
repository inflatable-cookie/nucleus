import { observeIdle } from './support/fakes';
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "../core/store/store";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { hostRunLaunchEnvironment } from "../service/callbacks/host-run-endpoint";
import { hostRunSettlementSchema } from "../shared/contracts";
import { minimalHookEnvironment } from "../core/hooks/hooks";
import {
  ADMISSION_CONFIRM_INTERVAL_MS,
  ADMISSION_HOOK_NODE_MODE_ENV,
  ADMISSION_HOOK_NODE_MODE_VALUE,
  ADMISSION_HOOK_TIMEOUT_MS,
  ADMISSION_LIVENESS_MS,
  admissionReservationId,
  evaluateAdmissionWait,
  formatAdmissionStdout,
  defaultAdmissionHookCommand,
  defaultAdmissionHookPath,
  defaultAdmissionTsxLoader,
  mergeAdmissionLaunchEnv,
  parseEffigyAdmissionRequest,
  queueOwnedAdmissionEnvironment,
  type AdmissionObservation,
  type AdmissionWaitDecision,
  type AdmissionWaitInput,
} from "../core/qa/effigy-admission";
import { EffigyAdmissionEndpoint } from "../service/callbacks/effigy-admission-endpoint";
import { ADMISSION_RPC_SAMPLE_WINDOW } from "../core/qa/effigy-admission-metrics";
import { admissionRpc, runEffigyAdmissionHook, type AdmissionRpc } from "../core/qa/effigy-admission-hook";
import { hostRunAdmissionSocketPath } from "../core/host-runs/host-run-paths";
import { assertSocketPathFits, socketFixtureDirectory, socketFixtureRoot } from "./support/socket-fixture";
import { QueueRuntime } from "../service/runtime-owner";
import type { Adapter } from "../core/host";
import { parseEffigyVersion, type EffigyRuntimeAncestor } from "../core/qa/effigy-runtime";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";


const request = (runId = "agqvltk3r7jktaa6vi23dpcu4a", cwd = "/work/app") => ({
  schema: "effigy.admission-request.v1" as const,
  run_id: runId,
  task: "qa:ci:fast",
  class: "heavy" as const,
  cwd,
  root: cwd,
});

const capacity = () => ({ cpuCapacity: 1, memoryCapacityBytes: 1_000_000, freeMemoryBytes: 1_000_000, loadAverage: [0, 0, 0] });
const launchHandler = (scheduler: HostRunScheduler) => ({
  launch: (run: { id: string }) => { scheduler.markLaunched(run.id); },
});

/**
 * The runtime these tests declare: the node binary running them. A test process
 * is a live workload whose own image is exactly those bytes, so a reserve binds
 * for real — real path, real digest, real start identity — with no test seam.
 */
const SELF_RUNTIME = {
  path: realpathSync(process.execPath),
  sha256: createHash("sha256").update(readFileSync(realpathSync(process.execPath))).digest("hex"),
};
/** This build of node stands in for the workload's Effigy: asked by its real path, it answers as one. */
const SELF_EFFIGY = (path: string) => path === SELF_RUNTIME.path ? parseEffigyVersion("effigy v0.14.1+local.test") : null;
const selfAncestry = (): EffigyRuntimeAncestor[] =>
  [{ pid: process.pid, startIdentity: hostRunProcessStartIdentity(process.pid) }];

function isolatedScheduler(t: { after: (fn: () => void) => void }, cpu = 4) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return new HostRunScheduler(store, { capacity: () => ({ ...capacity(), cpuCapacity: cpu, memoryCapacityBytes: 8_000_000_000 }) });
}

async function isolatedEndpoint(t: { after: (fn: () => void | Promise<void>) => void }, scheduler: HostRunScheduler) {
  // A socket-binding fixture root: short prefix, inside Effigy's scratch, with the
  // derived admission socket stated against the transport's bound.
  const root = socketFixtureRoot("qadm-");
  assertSocketPathFits(hostRunAdmissionSocketPath(join(root, "host-run")));
  // No injected observer: the observation route is the declared runtime alone.
  const endpoint = new EffigyAdmissionEndpoint(scheduler, {
    stateDir: join(root, "host-run"),
    watchMs: 20,
    effigyVersion: SELF_EFFIGY,
  });
  await endpoint.start();
  t.after(async () => { await endpoint.stop(); });
  return { root, endpoint };
}

test("malformed admission requests deny with a concrete reason", () => {
  assert.equal(parseEffigyAdmissionRequest(undefined).ok, false);
  assert.equal(parseEffigyAdmissionRequest("{").ok, false);
  assert.match((parseEffigyAdmissionRequest('{"schema":"nope"}') as { reason: string }).reason, /malformed/);
  assert.equal(parseEffigyAdmissionRequest(JSON.stringify({ ...request(), class: "light" })).ok, false);
  const ok = parseEffigyAdmissionRequest(JSON.stringify(request()));
  assert.equal(ok.ok, true);
});

test("reservation ids correlate exactly to the Effigy run and stay under 160 chars", () => {
  const left = admissionReservationId("run-a");
  const right = admissionReservationId("run-b");
  assert.equal(left, admissionReservationId("run-a"));
  assert.notEqual(left, right);
  assert.equal(left.length, 64);
});

test("wait machine denies first-contact failures promptly and keeps a confirmed queue", () => {
  const now = 1_000_000;
  assert.deepEqual(evaluateAdmissionWait({
    nowMs: now, hasReservation: false, lastConfirmedAtMs: null,
    observation: { kind: "unreachable", message: "ECONNREFUSED" },
  }), { action: "deny", reason: "Queue admission service unreachable: ECONNREFUSED" });
  assert.equal(evaluateAdmissionWait({
    nowMs: now, hasReservation: false, lastConfirmedAtMs: null,
    observation: { kind: "error", message: "stale_epoch" },
  }).action, "deny");
  assert.deepEqual(evaluateAdmissionWait({
    nowMs: now, hasReservation: false, lastConfirmedAtMs: null, observation: { kind: "unknown" },
  }), { action: "deny", reason: "unrecognized reservation" });
  assert.equal(evaluateAdmissionWait({
    nowMs: now, hasReservation: true, lastConfirmedAtMs: now, observation: { kind: "queued", position: 2 },
  }).action, "wait");
  const missed = evaluateAdmissionWait({
    nowMs: now + ADMISSION_LIVENESS_MS + 1, hasReservation: true, lastConfirmedAtMs: now,
    observation: { kind: "unreachable", message: "killed" },
  });
  assert.equal(missed.action, "deny");
  const stillQueued = evaluateAdmissionWait({
    nowMs: now + ADMISSION_LIVENESS_MS + 1, hasReservation: true,
    lastConfirmedAtMs: now + ADMISSION_LIVENESS_MS - 1,
    observation: { kind: "queued", position: 1 },
  });
  assert.equal(stillQueued.action, "wait");
  assert.equal(evaluateAdmissionWait({
    nowMs: now, hasReservation: true, lastConfirmedAtMs: now, observation: { kind: "admitted" },
  }).action, "admit");
  assert.equal(ADMISSION_CONFIRM_INTERVAL_MS, 5_000);
  assert.equal(ADMISSION_LIVENESS_MS, 60_000);
  assert.equal(ADMISSION_HOOK_TIMEOUT_MS, 3_600_000);
});

test("Queue-owned agent env sets the hook; already-reserved host-run env does not", () => {
  const admission = queueOwnedAdmissionEnvironment({ hookCommand: "node hook", socketPath: "/tmp/admission.sock" });
  assert.equal(admission.EFFIGY_ADMISSION_HOOK, "node hook");
  assert.equal(admission.QUEUE_ADMISSION_SOCKET, "/tmp/admission.sock");
  assert.equal(admission.EFFIGY_ADMISSION_HOOK_TIMEOUT_MS, "3600000");
  assert.equal(admission.EFFIGY_ADMITTED, undefined);
  const agent = mergeAdmissionLaunchEnv({ PATH: "/bin" }, admission);
  assert.equal(agent.EFFIGY_ADMISSION_HOOK, "node hook");
  const listed = minimalHookEnvironment("event");
  assert.equal(listed.EFFIGY_ADMISSION_HOOK, undefined);
  const launched = hostRunLaunchEnvironment(listed, {
    runId: "run-1", token: "tok", env: { PATH: "/bin", HOME: "/workspace/u", EFFIGY_ADMISSION_HOOK: "spoofed" },
  });
  assert.equal(launched.EFFIGY_ADMISSION_HOOK, undefined);
  assert.equal(launched.HOST_RUN_ID, "run-1");
  const hookCommand = defaultAdmissionHookCommand();
  assert.match(hookCommand, /--import '/);
  assert.equal(hookCommand.includes("--import tsx "), false);
  // Task 413: Node mode rides in the command, never in the launch environment.
  assert.match(hookCommand, /^ELECTRON_RUN_AS_NODE=1 '/);
  assert.deepEqual(Object.keys(admission).sort(),
    ["EFFIGY_ADMISSION_HOOK", "EFFIGY_ADMISSION_HOOK_TIMEOUT_MS", "QUEUE_ADMISSION_SOCKET"]);
  assert.equal(agent.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(Object.hasOwn(listed, ADMISSION_HOOK_NODE_MODE_ENV), false);
});

test("stdout protocol is exactly admit or deny with a reason", () => {
  assert.equal(formatAdmissionStdout("admit"), "admit");
  assert.equal(formatAdmissionStdout({ deny: "no capacity" }), "deny no capacity");
});

test("isolated endpoint admits, correlates, and does not duplicate the same run", async t => {
  const scheduler = isolatedScheduler(t);
  const { endpoint } = await isolatedEndpoint(t, scheduler);
  const cwd = mkdtempSync(join(tmpdir(), "adm-cwd-"));
  const body = request("run-one", cwd);
  const reserved = await endpoint.reserve(body, selfAncestry());
  assert.ok(reserved.reservationId);
  assert.ok(reserved.observation.kind === "admitted" || reserved.observation.kind === "running");
  assert.equal(scheduler.get(reserved.reservationId)?.effigyRuntime?.sha256, SELF_RUNTIME.sha256,
    "a bindable admission is reserved already bound, with no unbound window");
  const again = await endpoint.reserve(body, selfAncestry());
  assert.equal(again.reservationId, reserved.reservationId);
  assert.equal(again.observation.kind, "running");
  const other = await endpoint.reserve(request("run-two", cwd), selfAncestry());
  assert.ok(other.reservationId);
  assert.notEqual(other.reservationId, reserved.reservationId);
});

test("already-reserved Queue work at the cwd admits nested without a second slot", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "adm-nested-"));
  const scheduler = isolatedScheduler(t, 1);
  scheduler.submit({
    id: "qa-parent", epoch: 1, submissionSource: "queue", caller: "queue:validation:test",
    repository: { origin: null, path: cwd }, selector: "qa:changed", runClass: "heavy", classSource: "manifest",
    priority: "validation", runTimeoutMs: 60_000, budgetFallback: { cpu: 1, memoryBytes: 100 },
  }, launchHandler(scheduler));
  assert.equal(scheduler.get("qa-parent")?.state, "running");
  const { endpoint } = await isolatedEndpoint(t, scheduler);
  const nested = await endpoint.reserve(request("nested-run", cwd), selfAncestry());
  assert.equal(nested.observation.kind, "nested");
  assert.equal(nested.reservationId, null);
  assert.equal(scheduler.list().filter(run => run.submissionSource === "admission").length, 0);
});

test("unknown reservation and malformed output deny without waiting", async t => {
  const scheduler = isolatedScheduler(t);
  const { endpoint } = await isolatedEndpoint(t, scheduler);
  assert.equal(endpoint.status("missing-id").kind, "unknown");
  const stdout: string[] = [];
  const rpc: AdmissionRpc = async () => ({ ok: true, result: { reservationId: null, observation: { kind: "unknown" } } });
  const code = await runEffigyAdmissionHook({
    env: { EFFIGY_ADMISSION_REQUEST: JSON.stringify(request()), QUEUE_ADMISSION_SOCKET: "/unused" },
    stdout: { write: chunk => stdout.push(chunk) },
    stderr: { write: () => {} },
    rpc,
    now: () => 0,
    sleep: async () => { throw new Error("must not wait"); },
  });
  assert.equal(code, 0);
  assert.equal(stdout.join(""), "deny unrecognized reservation\n");
});

test("unreachable service on first contact denies promptly", async () => {
  const stdout: string[] = [];
  const code = await runEffigyAdmissionHook({
    env: { EFFIGY_ADMISSION_REQUEST: JSON.stringify(request()), QUEUE_ADMISSION_SOCKET: join(tmpdir(), "no-such-admission.sock") },
    stdout: { write: chunk => stdout.push(chunk) },
    stderr: { write: () => {} },
    now: () => 0,
    sleep: async () => { throw new Error("must not wait"); },
  });
  assert.equal(code, 0);
  assert.match(stdout.join(""), /^deny Queue admission service unreachable:/);
});

test("scripted wait: confirmed queue survives the liveness window, then admits", async () => {
  const stdout: string[] = [];
  let now = 0;
  const rpc: AdmissionRpc = async () => {
    const observation: AdmissionObservation = now > 50
      ? { kind: "admitted" }
      : { kind: "queued", position: 1 };
    return { ok: true, result: { reservationId: "res-1", observation } };
  };
  const code = await runEffigyAdmissionHook({
    env: {
      EFFIGY_ADMISSION_REQUEST: JSON.stringify(request()),
      QUEUE_ADMISSION_SOCKET: "/unused",
      QUEUE_ADMISSION_CONFIRM_MS: "10",
      QUEUE_ADMISSION_LIVENESS_MS: "50",
    },
    stdout: { write: chunk => stdout.push(chunk) },
    stderr: { write: () => {} },
    rpc,
    now: () => now,
    sleep: async ms => { now += ms; },
    onHold: async () => {},
  });
  assert.equal(code, 0);
  assert.equal(stdout.join(""), "admit\n");
  assert.ok(now > 50, `confirmed wait continued past the 50 ms liveness window (now=${now})`);
});

test("scripted wait: service killed mid-wait denies within the liveness bound", async () => {
  const stdout: string[] = [];
  let now = 0;
  let confirms = 0;
  const rpc: AdmissionRpc = async method => {
    if (method === "reserve") return { ok: true, result: { reservationId: "res-1", observation: { kind: "queued", position: 1 } } };
    if (method === "bind-hook") return { ok: true, result: { reservationId: "res-1", observation: { kind: "queued", position: 1 } } };
    confirms++;
    throw new Error("ECONNREFUSED");
  };
  const code = await runEffigyAdmissionHook({
    env: {
      EFFIGY_ADMISSION_REQUEST: JSON.stringify(request()),
      QUEUE_ADMISSION_SOCKET: "/unused",
      QUEUE_ADMISSION_CONFIRM_MS: "10",
      QUEUE_ADMISSION_LIVENESS_MS: "50",
    },
    stdout: { write: chunk => stdout.push(chunk) },
    stderr: { write: () => {} },
    rpc,
    now: () => now,
    sleep: async ms => { now += ms; },
  });
  assert.equal(code, 0);
  assert.match(stdout.join(""), /^deny queued reservation lost liveness/);
  assert.ok(now <= 80, `denied inside the liveness bound (now=${now})`);
  assert.ok(confirms >= 1);
});

test("hook death while queued cancels; unknown identity keeps capacity; terminal Effigy settles occupancy", async t => {
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const unknownCwd = mkdtempSync(join(tmpdir(), "adm-unknown-"));
  const unknownScheduler = isolatedScheduler(t);
  const unknown = await isolatedEndpoint(t, unknownScheduler);
  const reserved = await unknown.endpoint.reserve(request("death-run", unknownCwd), selfAncestry());
  assert.ok(reserved.reservationId);
  unknown.endpoint.bindHook(reserved.reservationId, 1, "1@unknown");
  await pause(40);
  assert.notEqual(unknownScheduler.get(reserved.reservationId)?.state, "settled");

  const queuedCwd = mkdtempSync(join(tmpdir(), "adm-queued-"));
  const occupierCwd = mkdtempSync(join(tmpdir(), "adm-occ-"));
  const queuedScheduler = isolatedScheduler(t, 1);
  queuedScheduler.submit({
    id: "occupier", epoch: 1, submissionSource: "queue", caller: "queue:validation:test",
    repository: { origin: null, path: occupierCwd }, selector: "qa:changed", runClass: "heavy", classSource: "manifest",
    priority: "validation", runTimeoutMs: 60_000, budgetFallback: { cpu: 1, memoryBytes: 100 },
  }, launchHandler(queuedScheduler));
  assert.equal(queuedScheduler.get("occupier")?.state, "running");
  const queued = await isolatedEndpoint(t, queuedScheduler);
  const gone = await queued.endpoint.reserve(request("gone-run", queuedCwd), selfAncestry());
  assert.equal(gone.observation.kind, "queued");
  assert.ok(gone.reservationId);
  queued.endpoint.bindHook(gone.reservationId, 999999, "999999@1999-01-01T00:00:00Z");
  await pause(50);
  assert.equal(queuedScheduler.get(gone.reservationId)?.state, "settled");

  const doneCwd = mkdtempSync(join(tmpdir(), "adm-done-"));
  const doneScheduler = isolatedScheduler(t);
  const doneRoot = socketFixtureRoot("qadm-");
  assertSocketPathFits(hostRunAdmissionSocketPath(join(doneRoot, "host-run")));
  const doneEndpoint = new EffigyAdmissionEndpoint(doneScheduler, {
    stateDir: join(doneRoot, "host-run"),
    watchMs: 15,
    effigyVersion: SELF_EFFIGY,
  });
  await doneEndpoint.start();
  t.after(async () => { await doneEndpoint.stop(); });
  const done = await doneEndpoint.reserve(request("done-run", doneCwd), selfAncestry());
  const launched = doneScheduler.get(done.reservationId!);
  assert.ok(launched);
  assert.equal(launched.state, "running");
  assert.equal(launched.effigyRuntime?.sha256, SELF_RUNTIME.sha256, "the reservation carries its binding from its own write");
  // The observer runs the bound node bytes as `node run status <id> --json` in the
  // run's cwd, so `run` here is the run journal it reads. Only the producer's
  // checkout-journal record with complete cleanup closes the reservation.
  writeFileSync(join(doneCwd, "run"), `if (process.argv[2] === "status") { process.stdout.write(JSON.stringify({ schema: "effigy.command.v1", ok: true, result: { schema: "effigy.run.v1", run: { evidence_source: "checkout-journal", run_id: "done-run", task: "qa:ci:fast", state: "succeeded", phase: "closed", exit_code: 0, cleanup: "complete" } } })); process.exit(0); }\nprocess.exit(2);\n`);
  doneEndpoint.bindHook(done.reservationId!, 999998, "999998@1999-01-01T00:00:00Z");
  // The observer verifies the bound bytes before and after its status read, so
  // wait for the settlement the retired accounting is followed by.
  await waitUntil(() => doneScheduler.get(done.reservationId!)?.state === "settled", 3_000,
    `bound reservation settles on the producer's closure and gone hook (state=${doneScheduler.get(done.reservationId!)?.state})`);
  const settledDone = doneScheduler.get(done.reservationId!);
  assert.equal(settledDone?.settlement?.outcome, "lost", "the settlement claims nothing about the workload");
  assert.equal(settledDone?.settlement?.result, null, "no result is invented");
  assert.equal(settledDone?.effigyRuntime?.sha256, SELF_RUNTIME.sha256, "the observed combination is on the record");
  assert.equal((doneScheduler.accountingStatus(done.reservationId!)!.disposition as { format: string }).format,
    "queue.host-run.accounting-retirement");
  assert.equal((doneScheduler.accountingStatus(done.reservationId!)!.disposition as { producer: { verdict: string } }).producer.verdict,
    "passed", "the producer's own verdict is kept as the settlement's evidence");
});

test("hook with a live isolated socket admits and holds until cancelled wait", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "adm-live-"));
  writeFileSync(join(cwd, "keep"), "1");
  const scheduler = isolatedScheduler(t, 4);
  const { endpoint } = await isolatedEndpoint(t, scheduler);
  const stdout: string[] = [];
  let holding = false;
  let releaseHold: () => void = () => {};
  const held = new Promise<void>(resolve => { releaseHold = resolve; });
  const codePromise = runEffigyAdmissionHook({
    env: {
      EFFIGY_ADMISSION_REQUEST: JSON.stringify(request("live-run", cwd)),
      QUEUE_ADMISSION_SOCKET: endpoint.socketPath,
    },
    stdout: { write: chunk => stdout.push(chunk) },
    stderr: { write: () => {} },
    onHold: async () => { holding = true; await held; },
    ancestry: selfAncestry(),
  });
  const started = Date.now();
  while (!holding && Date.now() - started < 2_000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stdout.join(""), "admit\n");
  assert.equal(holding, true);
  const reservationId = admissionReservationId("live-run");
  const record = scheduler.get(reservationId);
  assert.ok(record);
  assert.ok(record.state === "running" || record.state === "admitted");
  assert.equal(record.effigyRuntime?.sha256, SELF_RUNTIME.sha256, "the admitted workload's own bytes are bound before it runs");
  releaseHold();
  assert.equal(await codePromise, 0);
});

test("real hook process stays alive while queued, admits after capacity release, and holds until TERM", async t => {
  const occupierCwd = mkdtempSync(join(tmpdir(), "adm-real-occ-"));
  const cwd = mkdtempSync(join(tmpdir(), "adm-real-hook-"));
  const scheduler = isolatedScheduler(t, 1);
  scheduler.submit({
    id: "occupier", epoch: 1, submissionSource: "queue", caller: "queue:validation:test",
    repository: { origin: null, path: occupierCwd }, selector: "qa:changed", runClass: "heavy", classSource: "manifest",
    priority: "validation", runTimeoutMs: 60_000, budgetFallback: { cpu: 1, memoryBytes: 100 },
  }, launchHandler(scheduler));
  assert.equal(scheduler.get("occupier")?.state, "running");
  const { endpoint } = await isolatedEndpoint(t, scheduler);
  const child = spawn(process.execPath, ["--import", defaultAdmissionTsxLoader(), defaultAdmissionHookPath()], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      TMPDIR: cwd,
      LANG: "C",
      EFFIGY_ADMISSION_REQUEST: JSON.stringify(request("real-hook-run", cwd)),
      QUEUE_ADMISSION_SOCKET: endpoint.socketPath,
      QUEUE_ADMISSION_CONFIRM_MS: "50",
      QUEUE_ADMISSION_LIVENESS_MS: "8000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  await waitUntil(() => /waiting for Queue capacity/.test(stderr), 2_000, `queued progress on stderr (${stderr || stdout})`);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(child.exitCode, null, `hook died during queued wait: ${stderr || stdout}`);
  assert.equal(stdout.includes("admit"), false);
  scheduler.settle("occupier", hostRunSettlementSchema.parse({
    format: "host.run.settlement", version: 1, runId: "occupier",
    outcome: "lost", launched: true, settledAt: new Date().toISOString(), result: null, containers: [],
  }));
  await waitUntil(() => stdout === "admit\n", 2_000, `admit after capacity release (stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)})`);
  assert.equal(child.exitCode, null, `hook exited after admit without TERM: ${stderr}`);
  child.kill("SIGTERM");
  const result = await closed;
  assert.equal(result.code, 0, `expected exit 0 after TERM, got code=${result.code} signal=${result.signal} stderr=${stderr}`);
});

/** One-shot `/bin/sh -c` run: exactly how Effigy starts the hook command. */
function runShellCommand(command: string, env: Record<string, string>, cwd: string): Promise<{
  code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
}> {
  return new Promise(resolve => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function hookLaunchEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: root, LANG: "C", ...extra };
}

function shellQuoteForFixture(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * An Electron-like executable: a real launcher only in Node mode. Without it, it
 * does what the desktop binary does when Effigy hands it `--import` — treats the
 * option as unknown and prints that banner instead of an admit/deny.
 */
function electronLikeHelper(root: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, "#!/bin/sh\n"
    + `if [ "\${ELECTRON_RUN_AS_NODE:-}" = "1" ]; then exec ${shellQuoteForFixture(process.execPath)} "$@"; fi\n`
    + `printf 'Paseo Electron Helper: unknown option %s\\n' "\${1:-}"\n`
    + "exit 1\n");
  chmodSync(path, 0o755);
  return path;
}

/** The real hook entry, copied to a path of this test's choosing (quotes, spaces). */
function hookCopyAt(root: string, name: string): string {
  const path = join(root, name);
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../core/qa/effigy-admission-hook.ts", import.meta.url))).href;
  writeFileSync(path, `const { runEffigyAdmissionHookMain } = await import(${JSON.stringify(moduleUrl)});\n`
    + "await runEffigyAdmissionHookMain();\n");
  return path;
}

test("the default hook command runs an Electron-like executable as Node and denies without a request", async () => {
  const root = mkdtempSync(join(tmpdir(), "adm-node-mode-"));
  const execPath = electronLikeHelper(root, "Paseo Electron Helper");
  const hookPath = hookCopyAt(root, "queue-effigy-admission-hook.mjs");
  const command = defaultAdmissionHookCommand(execPath, hookPath);

  const noRequest = await runShellCommand(command, hookLaunchEnv(root), root);
  assert.equal(noRequest.code, 0, `hook exit code (stdout=${noRequest.stdout} stderr=${noRequest.stderr})`);
  assert.equal(noRequest.stdout, "deny missing EFFIGY_ADMISSION_REQUEST\n",
    "the hook protocol answers, not the desktop argument parser");
  assert.equal(/unknown option/.test(`${noRequest.stdout}${noRequest.stderr}`), false,
    `desktop banner leaked into the hook child: ${noRequest.stdout}${noRequest.stderr}`);

  // Admission is still fail-closed past the launcher: a request with no socket
  // denies in the hook's own words instead of starting a workload.
  const noSocket = await runShellCommand(command, hookLaunchEnv(root, {
    EFFIGY_ADMISSION_REQUEST: JSON.stringify(request("node-mode-run", root)),
  }), root);
  assert.equal(noSocket.code, 0, `hook exit code (stdout=${noSocket.stdout} stderr=${noSocket.stderr})`);
  assert.equal(noSocket.stdout, "deny missing QUEUE_ADMISSION_SOCKET\n");
});

test("the same Electron-like executable refuses the command without Node mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "adm-node-mode-falsify-"));
  const execPath = electronLikeHelper(root, "Paseo Electron Helper");
  const hookPath = hookCopyAt(root, "queue-effigy-admission-hook.mjs");
  const command = defaultAdmissionHookCommand(execPath, hookPath);
  const withoutMode = command.replace(`${ADMISSION_HOOK_NODE_MODE_ENV}=${ADMISSION_HOOK_NODE_MODE_VALUE} `, "");
  assert.notEqual(withoutMode, command, "the prefix is the only difference under test");

  const refused = await runShellCommand(withoutMode, hookLaunchEnv(root), root);
  assert.notEqual(refused.code, 0, "the desktop parser refuses --import");
  assert.match(`${refused.stdout}${refused.stderr}`, /unknown option --import/);
  assert.equal(`${refused.stdout}${refused.stderr}`.includes("deny"), false,
    "without Node mode the child never reaches the admission protocol");

  const scoped = await runShellCommand(command, hookLaunchEnv(root), root);
  assert.equal(scoped.stdout, "deny missing EFFIGY_ADMISSION_REQUEST\n",
    "the same fixture and paths answer the protocol with the scoped mode");
});

test("Node mode stays inside the hook child and never reaches the agent shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "adm-node-mode-scope-"));
  const execPath = electronLikeHelper(root, "Paseo Electron Helper");
  const hookPath = hookCopyAt(root, "queue-effigy-admission-hook.mjs");
  const script = [defaultAdmissionHookCommand(execPath, hookPath),
    `printf 'after-hook:%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}"`,
    "env | grep '^ELECTRON_RUN_AS_NODE=' || printf 'env:absent\\n'",
  ].join("\n");
  const result = await runShellCommand(script, hookLaunchEnv(root), root);
  assert.equal(result.stdout.split("\n")[0], "deny missing EFFIGY_ADMISSION_REQUEST",
    `hook answered through the fixture (stdout=${result.stdout} stderr=${result.stderr})`);
  assert.match(result.stdout, /^after-hook:unset$/m, "the agent shell keeps no Node mode");
  assert.match(result.stdout, /^env:absent$/m, "the shell environment gains no Node mode");

  const admission = queueOwnedAdmissionEnvironment({ hookCommand: "hook", socketPath: "/tmp/a.sock" });
  assert.equal(Object.hasOwn(admission, ADMISSION_HOOK_NODE_MODE_ENV), false);
  const base = { PATH: "/bin" };
  const merged = mergeAdmissionLaunchEnv(base, admission);
  assert.equal(Object.hasOwn(merged, ADMISSION_HOOK_NODE_MODE_ENV), false);
  assert.deepEqual(base, { PATH: "/bin" }, "the caller's base environment is not mutated");
});

test("real Node accepts the default command with quoted exec, loader and hook paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "adm-node-mode-quote-"));
  const quotedHook = hookCopyAt(root, "queue hook's copy.mjs");

  const plainNode = await runShellCommand(defaultAdmissionHookCommand(process.execPath, quotedHook),
    hookLaunchEnv(root), root);
  assert.equal(plainNode.code, 0, `plain Node hook exit (stdout=${plainNode.stdout} stderr=${plainNode.stderr})`);
  assert.equal(plainNode.stdout, "deny missing EFFIGY_ADMISSION_REQUEST\n",
    "plain Node ignores the Node-mode variable and runs the same command");

  const quotedExec = electronLikeHelper(root, "Electron Helper's launcher");
  const quotedBoth = await runShellCommand(defaultAdmissionHookCommand(quotedExec, quotedHook),
    hookLaunchEnv(root), root);
  assert.equal(quotedBoth.code, 0, `quoted-path hook exit (stdout=${quotedBoth.stdout} stderr=${quotedBoth.stderr})`);
  assert.equal(quotedBoth.stdout, "deny missing EFFIGY_ADMISSION_REQUEST\n",
    "paths with spaces and single quotes survive the shell quoting");
});

async function waitUntil(probe: () => boolean, ms: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Task 447: a received still-queued reply for the exact issued reservation is
 * itself the proof that the service is answering, so it must be credited before
 * the previous reply's age is judged. This is the corrected evaluator's parent,
 * kept in its pre-change order so the defect is reproduced beside the fix.
 */
function parentEvaluateAdmissionWait(input: AdmissionWaitInput): AdmissionWaitDecision {
  const confirmIntervalMs = input.confirmIntervalMs ?? ADMISSION_CONFIRM_INTERVAL_MS;
  const livenessMs = input.livenessMs ?? ADMISSION_LIVENESS_MS;
  if (input.observation.kind !== "queued")
    throw new Error("the parent rule is reproduced for the still-queued branch only");
  if (input.lastConfirmedAtMs !== null && input.nowMs - input.lastConfirmedAtMs > livenessMs)
    return { action: "deny", reason: "queued reservation lost liveness: no fresh still-queued confirmation" };
  const position = input.observation.position;
  const origin = input.lastConfirmedAtMs ?? input.nowMs;
  return {
    action: "wait",
    nextConfirmAt: Math.max(input.nowMs, origin + confirmIntervalMs),
    progress: position ? `waiting for Queue capacity, position ${position}` : "waiting for Queue capacity",
    confirmedAtMs: null,
  };
}

test("a received still-queued reply is credited before its predecessor's age is judged", () => {
  const now = 5_000_000;
  const stale = now - ADMISSION_LIVENESS_MS - 30_000;
  const stillQueued: AdmissionWaitInput = {
    nowMs: now, hasReservation: true, lastConfirmedAtMs: stale, observation: { kind: "queued", position: 2 },
  };
  assert.equal(parentEvaluateAdmissionWait(stillQueued).action, "deny",
    "the pre-447 order denies a wait the service is still answering");
  assert.deepEqual(evaluateAdmissionWait(stillQueued), {
    action: "wait",
    nextConfirmAt: now + ADMISSION_CONFIRM_INTERVAL_MS,
    progress: "waiting for Queue capacity, position 2",
    confirmedAtMs: now,
  }, "a still-queued reply is the fresh confirmation and starts the next cadence");

  // A missed beat is never a confirmation: the window keeps running from the
  // reply that did answer, and denies only on the existing 60 s boundary.
  const missedAt = (atMs: number) => evaluateAdmissionWait({
    nowMs: atMs, hasReservation: true, lastConfirmedAtMs: now,
    observation: { kind: "unreachable", message: "ETIMEDOUT" },
  });
  const atBoundary = missedAt(now + ADMISSION_LIVENESS_MS);
  assert.equal(atBoundary.action, "wait");
  assert.equal(atBoundary.action === "wait" ? atBoundary.confirmedAtMs : "credited", null,
    "an unreachable reply credits nothing");
  assert.equal(missedAt(now + ADMISSION_LIVENESS_MS + 1).action, "deny");

  // A stale window is never reset by a missed reply either: only a received
  // still-queued answer refreshes it.
  const staleMissed = evaluateAdmissionWait({
    nowMs: now, hasReservation: true, lastConfirmedAtMs: stale,
    observation: { kind: "unreachable", message: "ECONNREFUSED" },
  });
  assert.equal(staleMissed.action, "deny");

  // Unknown, settled, error and malformed replies stay refusals, never credit.
  for (const observation of [
    { kind: "unknown" as const },
    { kind: "settled" as const, reason: "admission hook died before admit" },
    { kind: "error" as const, message: "stale_epoch" },
    { kind: "malformed" as const, message: "bad observation" },
  ]) {
    assert.equal(
      evaluateAdmissionWait({ nowMs: now, hasReservation: true, lastConfirmedAtMs: now - 1_000, observation }).action,
      "deny",
      `${observation.kind} is a refusal, never a confirmation`,
    );
  }
  // Admitted, running and nested observations are unchanged.
  for (const observation of [{ kind: "admitted" as const }, { kind: "running" as const }, { kind: "nested" as const }])
    assert.equal(evaluateAdmissionWait({ nowMs: now, hasReservation: true, lastConfirmedAtMs: stale, observation }).action,
      "admit", `${observation.kind} is still an admit`);
});

test("a still-queued reply after a stale confirmation keeps the wait and refreshes the deadline", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let now = 0;
  let confirmations = 0;
  let firstConfirmAtMs = -1;
  let lastConfirmAtMs = -1;
  const rpc: AdmissionRpc = async method => {
    if (method === "reserve" || method === "bind-hook")
      return { ok: true, result: { reservationId: "res-1", observation: { kind: "queued", position: 1 } } };
    confirmations++;
    lastConfirmAtMs = now;
    if (confirmations === 1) {
      firstConfirmAtMs = now;
      return { ok: true, result: { reservationId: "res-1", observation: { kind: "queued", position: 1 } } };
    }
    throw new Error("admission confirm timed out after 2000 ms");
  };
  const code = await runEffigyAdmissionHook({
    env: {
      EFFIGY_ADMISSION_REQUEST: JSON.stringify(request()),
      QUEUE_ADMISSION_SOCKET: "/unused",
      QUEUE_ADMISSION_CONFIRM_MS: String(ADMISSION_CONFIRM_INTERVAL_MS),
      QUEUE_ADMISSION_LIVENESS_MS: String(ADMISSION_LIVENESS_MS),
    },
    stdout: { write: chunk => stdout.push(chunk) },
    stderr: { write: chunk => stderr.push(chunk) },
    rpc,
    now: () => now,
    // The hook's own clock steps 70 s past its previous confirmation before the
    // first confirm, and then keeps the plain 5 s cadence.
    sleep: async () => { now += now === 0 ? 70_000 : ADMISSION_CONFIRM_INTERVAL_MS; },
  });
  assert.equal(code, 0);
  assert.equal(firstConfirmAtMs, 70_000);
  assert.equal(parentEvaluateAdmissionWait({
    nowMs: firstConfirmAtMs, hasReservation: true, lastConfirmedAtMs: 0,
    observation: { kind: "queued", position: 1 },
  }).action, "deny", "the same reply under the parent rule is the defect being corrected");
  assert.match(stdout.join(""), /^deny queued reservation lost liveness: Queue admission service unreachable\n$/,
    `the deny is the missed-confirmation one, not a stale still-queued verdict (${stdout.join("")})`);
  assert.match(stderr.join(""), /waiting for Queue capacity, position 1/,
    "the still-queued reply kept the wait and reported its own progress");
  // 70 s credit + the existing 60 s window: the deny is computed from the
  // still-queued reply, not from the earlier confirmation.
  assert.equal(lastConfirmAtMs, 70_000 + ADMISSION_LIVENESS_MS + ADMISSION_CONFIRM_INTERVAL_MS);
  assert.equal(confirmations, 1 + (ADMISSION_LIVENESS_MS / ADMISSION_CONFIRM_INTERVAL_MS) + 1);
});

test("a confirm the hook never received credits nothing, and a queued recovery resumes the wait", async t => {
  const occupierCwd = mkdtempSync(join(tmpdir(), "adm-lost-occ-"));
  const cwd = mkdtempSync(join(tmpdir(), "adm-lost-hook-"));
  const scheduler = isolatedScheduler(t, 1);
  scheduler.submit({
    id: "occupier", epoch: 1, submissionSource: "queue", caller: "queue:validation:test",
    repository: { origin: null, path: occupierCwd }, selector: "qa:changed", runClass: "heavy", classSource: "manifest",
    priority: "validation", runTimeoutMs: 60_000, budgetFallback: { cpu: 1, memoryBytes: 100 },
  }, launchHandler(scheduler));
  assert.equal(scheduler.get("occupier")?.state, "running");
  const { endpoint } = await isolatedEndpoint(t, scheduler);
  const runId = "lost-reply-run";
  const reservationId = admissionReservationId(runId);
  // The client's own 2 s bound fires on these confirms. The service still
  // processed each one; the hook simply never received the reply.
  const lostReplies = new Set([1, 3, 5]);
  let confirms = 0;
  let now = 0;
  const stdout: string[] = [];
  const rpc: AdmissionRpc = async (method, params, timeoutMs) => {
    const reply = await admissionRpc(endpoint.socketPath, method, params, timeoutMs) as Awaited<ReturnType<AdmissionRpc>>;
    if (method !== "confirm") return reply;
    confirms++;
    if (lostReplies.has(confirms)) throw new Error(`admission confirm timed out after ${timeoutMs} ms`);
    // Capacity really frees up: the next confirm is the one that admits.
    if (confirms === 6)
      scheduler.settle("occupier", hostRunSettlementSchema.parse({
        format: "host.run.settlement", version: 1, runId: "occupier",
        outcome: "lost", launched: true, settledAt: new Date().toISOString(), result: null, containers: [],
      }));
    return reply;
  };
  const code = await runEffigyAdmissionHook({
    env: {
      EFFIGY_ADMISSION_REQUEST: JSON.stringify(request(runId, cwd)),
      QUEUE_ADMISSION_SOCKET: endpoint.socketPath,
      QUEUE_ADMISSION_CONFIRM_MS: String(ADMISSION_CONFIRM_INTERVAL_MS),
      QUEUE_ADMISSION_LIVENESS_MS: String(ADMISSION_LIVENESS_MS),
    },
    stdout: { write: chunk => stdout.push(chunk) },
    stderr: { write: () => {} },
    rpc,
    now: () => now,
    sleep: async ms => { now += ms; },
    ancestry: selfAncestry(),
    onHold: async () => {},
  });
  assert.equal(code, 0);
  assert.equal(stdout.join(""), "admit\n", `lost replies never deny a queued wait (${stdout.join("")})`);
  assert.equal(confirms, 7);
  // The service processed every confirm, including the three replies the hook
  // never saw: server-processed confirmation is not proof of client receipt.
  const confirmsNoted = scheduler.store.hostRunJournal(reservationId)
    .filter(row => row.event === "admission_confirm").length;
  assert.equal(confirmsNoted, confirms, "every confirm reached the service and was journaled");
  const record = scheduler.get(reservationId);
  assert.ok(record?.state === "running" || record?.state === "admitted");
  assert.equal(record?.settlement, null, "an admitted reservation is not settled by a lost reply");
  assert.equal(scheduler.list().filter(run => run.submissionSource === "admission").length, 1,
    "one reservation, one grant, no double admission");
  // Idempotence: the same run id still keys the one reservation.
  const again = await endpoint.reserve(request(runId, cwd), selfAncestry());
  assert.equal(again.reservationId, reservationId);
  assert.equal(scheduler.list().filter(run => run.submissionSource === "admission").length, 1);
});

test("a confirm reply that names no matching reservation is refused, never credited", async () => {
  const stdout: string[] = [];
  let confirms = 0;
  let now = 0;
  const code = await runEffigyAdmissionHook({
    env: {
      EFFIGY_ADMISSION_REQUEST: JSON.stringify(request()),
      QUEUE_ADMISSION_SOCKET: "/unused",
      QUEUE_ADMISSION_CONFIRM_MS: String(ADMISSION_CONFIRM_INTERVAL_MS),
      QUEUE_ADMISSION_LIVENESS_MS: String(ADMISSION_LIVENESS_MS),
    },
    stdout: { write: chunk => stdout.push(chunk) },
    stderr: { write: () => {} },
    rpc: async method => {
      if (method === "confirm") {
        confirms++;
        // A queued observation for a reservation this hook does not hold: another
        // request's replay, or a forged reply. It proves nothing about this wait.
        return { ok: true, result: { reservationId: "another-reservation", observation: { kind: "queued", position: 1 } } };
      }
      return { ok: true, result: { reservationId: "res-1", observation: { kind: "queued", position: 1 } } };
    },
    now: () => 0,
    sleep: async ms => { now += ms; },
  });
  assert.equal(code, 0);
  assert.equal(confirms, 1);
  assert.equal(stdout.join(""), "deny admission confirm reply did not name the reservation this hook holds\n");
});

test("a queued reservation survives an endpoint restart, and a cancelled one never admits", async t => {
  const occupierCwd = mkdtempSync(join(tmpdir(), "adm-restart-occ-"));
  const cwd = mkdtempSync(join(tmpdir(), "adm-restart-"));
  const scheduler = isolatedScheduler(t, 1);
  scheduler.submit({
    id: "occupier", epoch: 1, submissionSource: "queue", caller: "queue:validation:test",
    repository: { origin: null, path: occupierCwd }, selector: "qa:changed", runClass: "heavy", classSource: "manifest",
    priority: "validation", runTimeoutMs: 60_000, budgetFallback: { cpu: 1, memoryBytes: 100 },
  }, launchHandler(scheduler));
  const { endpoint } = await isolatedEndpoint(t, scheduler);
  const body = request("restart-run", cwd);
  const reserved = await endpoint.reserve(body, selfAncestry());
  assert.equal(reserved.observation.kind, "queued");
  const reservationId = reserved.reservationId;
  assert.ok(reservationId);

  await endpoint.stop();
  await endpoint.start();
  assert.equal(endpoint.confirm(reservationId).kind, "queued", "the durable reservation still confirms after a rebind");
  assert.equal(endpoint.status(reservationId).kind, "queued");
  const again = await endpoint.reserve(body, selfAncestry());
  assert.equal(again.reservationId, reservationId, "a lost reserve reply is idempotent across a restart");
  assert.equal(scheduler.list().filter(run => run.submissionSource === "admission").length, 1);

  const record = scheduler.get(reservationId)!;
  scheduler.cancelQueued(record.id, "released before launch", record.epoch);
  assert.equal(endpoint.confirm(reservationId).kind, "settled", "a cancelled reservation is a refusal, never an admit");
  assert.equal(scheduler.get(reservationId)?.state, "settled");
});

test("admission RPC metrics stay bounded and name no run, reservation or path", async t => {
  const scheduler = isolatedScheduler(t);
  const root = socketFixtureRoot("qadm-");
  assertSocketPathFits(hostRunAdmissionSocketPath(join(root, "host-run")));
  let clock = 1_700_000_000_000;
  const endpoint = new EffigyAdmissionEndpoint(scheduler, {
    stateDir: join(root, "host-run"), watchMs: 20, effigyVersion: SELF_EFFIGY, now: () => clock,
  });
  await endpoint.start();
  t.after(async () => { await endpoint.stop(); });
  const cwd = mkdtempSync(join(tmpdir(), "adm-metrics-cwd-"));
  const runId = "metrics-run";
  const reservationId = admissionReservationId(runId);
  const reserveReply = await admissionRpc(endpoint.socketPath, "reserve",
    { request: request(runId, cwd), ancestry: selfAncestry() });
  assert.equal(reserveReply.ok, true);
  clock += 5_000;
  await admissionRpc(endpoint.socketPath, "confirm", { reservationId });
  clock += 20_000;
  await admissionRpc(endpoint.socketPath, "confirm", { reservationId });
  await admissionRpc(endpoint.socketPath, "status", { reservationId });
  await admissionRpc(endpoint.socketPath, "bind-hook",
    { reservationId, pid: process.pid, startIdentity: hostRunProcessStartIdentity(process.pid) });
  const rejected = await admissionRpc(endpoint.socketPath, "bogus", {});
  assert.equal(rejected.ok, false);

  const metrics = endpoint.rpcMetrics();
  assert.equal(metrics.methods.reserve.requests, 1);
  assert.equal(metrics.methods.reserve.replies, 1);
  assert.equal(metrics.methods.reserve.errors, 0);
  assert.equal(metrics.methods.reserve.processing.samples, 1);
  assert.equal(metrics.methods.confirm.requests, 2);
  assert.equal(metrics.methods.confirm.processing.samples, 2);
  assert.ok(metrics.methods.confirm.processing.maxMs! >= metrics.methods.confirm.processing.p50Ms!);
  assert.equal(metrics.methods.status.requests, 1, "each method is counted as itself");
  assert.equal(metrics.methods["bind-hook"].requests, 1);
  assert.equal(metrics.methods["bind-hook"].errors, 0);
  assert.equal(metrics.rejected, 1, "a line that names no method is not charged to one");
  // Cadence is measured on the service clock between two confirms this service
  // processed, so a late confirm is visible without any history scan.
  assert.equal(metrics.confirmCadence.gaps, 1);
  assert.equal(metrics.confirmCadence.maxGapMs, 20_000);
  assert.equal(metrics.confirmCadence.overCadence, 1);
  assert.equal(metrics.confirmCadence.overLiveness, 0);
  assert.ok(metrics.notes.some(note => note.startsWith("processing:")), "the measurement place is labelled");
  assert.ok(metrics.notes.some(note => note.includes("not measured here")), "and the inference is labelled");
  // No run id, reservation id or path crosses into health.
  const text = JSON.stringify(metrics);
  for (const secret of [runId, reservationId, cwd])
    assert.equal(text.includes(secret), false, `metrics name no ${secret === cwd ? "path" : "identity"}`);

  // Bounded: more confirms never grow the published shape.
  for (let index = 0; index < ADMISSION_RPC_SAMPLE_WINDOW + 10; index++)
    await admissionRpc(endpoint.socketPath, "confirm", { reservationId });
  const bounded = endpoint.rpcMetrics();
  assert.equal(bounded.methods.confirm.processing.samples, ADMISSION_RPC_SAMPLE_WINDOW);
  assert.equal(bounded.confirmCadence.gap.samples, ADMISSION_RPC_SAMPLE_WINDOW);
  assert.equal(bounded.methods.confirm.requests, 2 + ADMISSION_RPC_SAMPLE_WINDOW + 10);
  assert.equal(Buffer.byteLength(JSON.stringify(bounded)) < 8_192, true, "a health read stays a bounded payload");
});

/** The RuntimeOwner's adapter seam: no daemon is contacted by this fixture. */
function fakeAdapter(dir: string): Adapter {
  return {
    client: { isConnected: true },
    hostId: "fixture-host",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "worker-helper.mjs"),
    connect: async () => {},
    close: async () => {},
    profiles: async () => [],
    observe: observeIdle("ws", "worker"),
  } as unknown as Adapter;
}

test("service.health publishes the bounded admission metrics of the serving process", async t => {
  const innerSocket = join("host-run", "run", `inner-${process.pid}-${"f".repeat(8)}.sock`);
  const root = socketFixtureDirectory(innerSocket, 3);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const hostRunStateDir = join(root, "host-run");
  assertSocketPathFits(join(hostRunStateDir, "run", "scheduler.sock"));
  assertSocketPathFits(hostRunAdmissionSocketPath(hostRunStateDir));
  const runtime = new QueueRuntime({
    dataDir, hostRunStateDir, hostRunEndpoint: true, timers: false,
    adapterFactory: () => fakeAdapter(dataDir),
  });
  t.after(() => runtime.drain());
  await runtime.hostRunReady;
  const before = runtime.health().admissionRpc;
  assert.ok(before, "a process serving the admission socket publishes its RPC metrics");
  assert.equal(before!.methods.confirm.requests, 0);
  assert.ok(before!.notes.length > 0);

  // An unanswered method is still one this service answered: this host declares
  // no Effigy runtime, so the reserve refuses without reserving anything.
  const reply = await admissionRpc(hostRunAdmissionSocketPath(hostRunStateDir), "reserve",
    { request: request("health-run", root), ancestry: selfAncestry() });
  assert.equal(reply.ok, true);
  const after = runtime.health().admissionRpc!;
  assert.equal(after.serving, true, "the metric set says whether the socket is bound, not just its counts");
  assert.equal(after.methods.reserve.requests, 1);
  assert.equal(after.methods.reserve.replies, 1);
  assert.equal(after.methods.reserve.processing.samples, 1);
  assert.equal(JSON.stringify(after).includes("health-run"), false, "no run id reaches service health");
});

test("concurrent confirms over the service socket keep one queued reservation and grant nothing", async t => {
  const occupierCwd = mkdtempSync(join(tmpdir(), "adm-concurrent-occ-"));
  const cwd = mkdtempSync(join(tmpdir(), "adm-concurrent-"));
  const scheduler = isolatedScheduler(t, 1);
  scheduler.submit({
    id: "occupier", epoch: 1, submissionSource: "queue", caller: "queue:validation:test",
    repository: { origin: null, path: occupierCwd }, selector: "qa:changed", runClass: "heavy", classSource: "manifest",
    priority: "validation", runTimeoutMs: 60_000, budgetFallback: { cpu: 1, memoryBytes: 100 },
  }, launchHandler(scheduler));
  const { endpoint } = await isolatedEndpoint(t, scheduler);
  const runId = "concurrent-run";
  const reservationId = admissionReservationId(runId);
  const reserved = await admissionRpc(endpoint.socketPath, "reserve",
    { request: request(runId, cwd), ancestry: selfAncestry() });
  assert.equal(reserved.ok, true);
  assert.equal((reserved.result as { observation?: AdmissionObservation } | undefined)?.observation?.kind, "queued");

  // Eight overlapping calls on the one owner-only socket: nothing may grant the
  // reservation, write a second row or answer with another reservation.
  const replies = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const method = index % 3 === 2 ? "status" : "confirm";
    return admissionRpc(endpoint.socketPath, method, { reservationId }) as Promise<{
      ok: boolean; result?: { reservationId?: string; observation?: AdmissionObservation }; error?: { message?: string };
    }>;
  }));
  for (const reply of replies) {
    assert.equal(reply.ok, true, reply.error?.message);
    assert.equal(reply.result?.reservationId, reservationId);
    assert.equal(reply.result?.observation?.kind, "queued", "the reservation stays queued: no grant is faked");
  }
  assert.equal(scheduler.list().filter(run => run.submissionSource === "admission").length, 1);
  assert.equal(scheduler.store.hostRunJournal(reservationId).filter(row => row.event === "settlement").length, 0);
  assert.equal(scheduler.get(reservationId)?.state, "queued");
  // The service is still serving after the overlap, and the metric set counts
  // every call it answered.
  assert.equal(endpoint.serving(), true);
  const metrics = endpoint.rpcMetrics();
  assert.equal(metrics.methods.confirm.requests + metrics.methods.status.requests, replies.length);
  assert.equal(metrics.methods.reserve.requests, 1);
  assert.equal(metrics.methods.reserve.errors, 0);
});
