/**
 * Spec 035 "A live hook's identity is re-read on a bounded cadence" (task 450).
 *
 * `reconcileOnce` proved the admission hook's death by pid plus contract 010
 * start identity on every watch tick, so every watched reservation spawned a
 * `ps -o lstart=` per second on macOS (Supervisor `b885f087`'s live profile of
 * #449: admission hook identity ps calls were about 1.2 s of a 4.2 s busy
 * 30-second window). This file proves the correction through the real endpoint,
 * its watch loop and its reconciliation: the cheap kernel liveness test still
 * runs every tick, and a hook already proved live at that exact pid, epoch and
 * recorded identity is not read again until the documented bound expires.
 *
 * What must not weaken, and is asserted here with an injected clock and injected
 * process readers so the number of reads is exact:
 *
 * - a reused pid is recognised when the bound expires, and the row is never
 *   retired, observed or settled before that — the deferral is bounded, not
 *   unconditional;
 * - a process that disappears is dead on the very next tick, from the kernel's
 *   own answer, without waiting for the bound and without an identity read;
 * - an unreadable identity (and a permission-denied liveness test) is `unknown`,
 *   never absence, and an unknown is never remembered as alive;
 * - a binding that moved is re-read immediately;
 * - stopping and restarting the endpoint keeps no proof at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { ADMISSION_HOOK_IDENTITY_REVALIDATE_MS, ADMISSION_WATCH_MS, EffigyAdmissionEndpoint } from "../service/callbacks/effigy-admission-endpoint";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";
import { hostRunPublicDigest } from "../core/host-runs/host-run-accounting";
import { parseEffigyVersion, type EffigyRuntimeAncestor, type EffigyRuntimeSettings } from "../core/qa/effigy-runtime";

const NODE_PATH = realpathSync(process.execPath);
const NODE_SHA256 = createHash("sha256").update(readFileSync(NODE_PATH)).digest("hex");
/** This build of node stands in for the workload's Effigy: asked by its real path, it answers as one. */
const SELF_EFFIGY = (path: string) => path === NODE_PATH ? parseEffigyVersion("effigy v0.14.1+local.test") : null;
const selfAncestry = (): EffigyRuntimeAncestor[] =>
  [{ pid: process.pid, startIdentity: hostRunProcessStartIdentity(process.pid) }];

const WATCH_MS = 20;
const HOOK_IDENTITY = (pid: number) => `${pid}@2026-01-01T00:00:00Z`;

const request = (runId: string, cwd: string) => ({
  schema: "effigy.admission-request.v1" as const,
  run_id: runId,
  task: "qa:stage:rust",
  class: "heavy" as const,
  cwd,
  root: cwd,
});

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitUntil(probe: () => boolean, ms: number, label: string | (() => string)): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (probe()) return;
    await pause(20);
  }
  throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
}

/** The producer's own "no live holder and no journal record" answer, counted per spawn. */
function runStatusFixture(project: string, countFile: string): void {
  writeFileSync(join(project, "run"), `
require("node:fs").appendFileSync(${JSON.stringify(countFile)}, "1\\n");
process.stdout.write(JSON.stringify({
  schema: "effigy.command.v1", schema_version: 1, ok: false, result: null, warnings: [],
  binary: { name: "effigy", version: "0.14.1" }, command: { kind: "runs", name: "runs" },
  error: {
    kind: "RunnerError",
    message: "run: not recorded (foreground or expired); no live holder or retained journal record was found",
    details: { schema: "effigy.run.v1", schema_version: 1, selector: process.argv[3], state: "not-found", recording: "not-recorded" },
  },
}) + "\\n");
process.exit(1);
`);
}

function observations(countFile: string): number {
  if (!existsSync(countFile)) return 0;
  return readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;
}

function isolatedScheduler(t: { after: (fn: () => void) => void }): HostRunScheduler {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return new HostRunScheduler(store, {
    capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] }),
  });
}

type JournalRow = { event: string; at: string; data: unknown };
type Note = { kind?: string; reason?: string };

const notes = (scheduler: HostRunScheduler, id: string, event: string): Note[] =>
  scheduler.store.hostRunJournal(id).filter((row: JournalRow) => row.event === event).map((row: JournalRow) => row.data as Note);

/** The row a hold must keep: running, unsettled, charged, with its own visible reason. */
function assertChargedAndHeld(scheduler: HostRunScheduler, id: string, why: string): void {
  const record = scheduler.get(id)!;
  assert.equal(record.state, "running", `${why}: the row keeps running`);
  assert.equal(record.settlement, null, `${why}: no settlement is invented`);
  assert.equal(record.capacityReleasedAt, null, `${why}: the slot is still held`);
  assert.equal(scheduler.accountingStatus(id)!.accounting, "charged", `${why}: the accounting is still charged`);
  assert.deepEqual(notes(scheduler, id, "effigy_observation"), [], `${why}: no terminal observation`);
  assert.deepEqual(notes(scheduler, id, "accounting_retirement"), [], `${why}: no accounting retirement`);
}

interface Fixture {
  root: string;
  project: string;
  countFile: string;
  clock: { now: number };
  reads: { alive: number; identity: number };
  alive: Set<number>;
  identities: Map<number, string>;
}

function fixture(t: { after: (fn: () => void | Promise<void>) => void }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "qhook-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const countFile = join(root, "observations");
  runStatusFixture(project, countFile);
  return { root, project, countFile, clock: { now: 1_000_000 }, reads: { alive: 0, identity: 0 }, alive: new Set(), identities: new Map() };
}

/**
 * The real endpoint and watch loop over injected clocks and process readers, so
 * the test owns both time (the cadence) and the host's answers, and counts every
 * read the endpoint makes.
 */
async function endpoint(
  t: { after: (fn: () => void | Promise<void>) => void },
  scheduler: HostRunScheduler,
  f: Fixture,
  options: { hookIdentityRevalidateMs?: number; injectReaders?: boolean } = {},
): Promise<EffigyAdmissionEndpoint> {
  const reads = f.reads;
  const instance = new EffigyAdmissionEndpoint(scheduler, {
    stateDir: join(f.root, "host-run"),
    watchMs: WATCH_MS,
    effigyVersion: SELF_EFFIGY,
    now: () => f.clock.now,
    ...(options.injectReaders === false ? {} : {
      hookAlive: (pid: number) => { reads.alive++; return f.alive.has(pid); },
      hookStartIdentity: (pid: number) => { reads.identity++; return f.identities.get(pid) ?? `${pid}@unknown`; },
    }),
    ...(options.hookIdentityRevalidateMs === undefined ? {} : { hookIdentityRevalidateMs: options.hookIdentityRevalidateMs }),
  });
  await instance.start();
  t.after(async () => { await instance.stop(); });
  return instance;
}

async function launchedReservation(
  endpoint: EffigyAdmissionEndpoint,
  scheduler: HostRunScheduler,
  project: string,
  runId: string,
  hook: { pid: number; startIdentity: string },
): Promise<string> {
  const reserved = await endpoint.reserve(request(runId, project), selfAncestry());
  assert.ok(reserved.reservationId, `reservation accepted (${JSON.stringify(reserved.observation)})`);
  const id = reserved.reservationId!;
  endpoint.bindHook(id, hook.pid, hook.startIdentity);
  await waitUntil(() => scheduler.get(id)?.state === "running", 4_000, () => `reservation launched (${scheduler.get(id)?.state})`);
  return id;
}

function liveHookPid(): number {
  // A pid the injected liveness reader answers for; no real process has to
  // exist, and no real process is ever signalled.
  return NEXT_HOOK_PID++;
}
let NEXT_HOOK_PID = 900_000;

test("the hook identity bound is inside the bracketed 15-30 seconds and leaves the watch tick alone", () => {
  assert.equal(WATCH_MS < ADMISSION_HOOK_IDENTITY_REVALIDATE_MS, true);
  assert.ok(ADMISSION_HOOK_IDENTITY_REVALIDATE_MS >= 15_000, "at least 15 seconds");
  assert.ok(ADMISSION_HOOK_IDENTITY_REVALIDATE_MS <= 30_000, "at most 30 seconds");
  assert.equal(ADMISSION_WATCH_MS, 1_000, "the ordinary watch is still the one-second tick");
});

test("a live hook's identity is read once per bound while its liveness test runs every tick", async t => {
  const scheduler = isolatedScheduler(t);
  const f = fixture(t);
  const endpointInstance = await endpoint(t, scheduler, f);
  const pid = liveHookPid();
  f.alive.add(pid);
  f.identities.set(pid, HOOK_IDENTITY(pid));
  const id = await launchedReservation(endpointInstance, scheduler, f.project, "live-hook", { pid, startIdentity: HOOK_IDENTITY(pid) });

  // Six watch ticks with the clock frozen inside the bound: one identity read,
  // and a liveness test on every one of them.
  await waitUntil(() => f.reads.alive >= 6, 5_000, () => `six ticks (${f.reads.alive})`);
  assert.equal(f.reads.identity, 1, "the proved identity answered the whole window");
  assert.ok(f.reads.alive >= 6, `the cheap liveness test still runs every tick (${f.reads.alive})`);
  assert.equal(observations(f.countFile), 0, "a live hook is never observed at all");
  assertChargedAndHeld(scheduler, id, "a live hook");

  // The bound is a boundary, not a rounding: one millisecond short of it makes
  // no read; past it, the identity is read again.
  f.clock.now += ADMISSION_HOOK_IDENTITY_REVALIDATE_MS - 1;
  await waitUntil(() => f.reads.alive >= 9, 5_000, () => `three more ticks (${f.reads.alive})`);
  assert.equal(f.reads.identity, 1, "inside the bound, still no identity read");
  f.clock.now += 2;
  await waitUntil(() => f.reads.identity === 2, 5_000, () => `the identity is re-read at the bound (${f.reads.identity})`);
  assertChargedAndHeld(scheduler, id, "a live hook past the bound");
  assert.equal(observations(f.countFile), 0, "the revalidated live hook is still not observed");
});

test("the parent shape re-reads the identity on every tick, which is the spawn cost this removes", async t => {
  const scheduler = isolatedScheduler(t);
  const f = fixture(t);
  // The parent shape in the same fixture: no reuse at all.
  const endpointInstance = await endpoint(t, scheduler, f, { hookIdentityRevalidateMs: 0 });
  const pid = liveHookPid();
  f.alive.add(pid);
  f.identities.set(pid, HOOK_IDENTITY(pid));
  const id = await launchedReservation(endpointInstance, scheduler, f.project, "parent-shape", { pid, startIdentity: HOOK_IDENTITY(pid) });
  await waitUntil(() => f.reads.alive >= 8, 5_000, () => `eight ticks (${f.reads.alive})`);
  assert.ok(f.reads.identity >= 8, `the parent reads an identity per tick (${f.reads.identity} reads, ${f.reads.alive} ticks)`);
  assert.ok(f.reads.identity >= f.reads.alive, "one identity read per liveness test, as before");
  assertChargedAndHeld(scheduler, id, "the parent-shaped watch");
});

test("a reused pid is recognised when the bound expires, and never before", async t => {
  const scheduler = isolatedScheduler(t);
  const f = fixture(t);
  const endpointInstance = await endpoint(t, scheduler, f);
  const pid = liveHookPid();
  f.alive.add(pid);
  f.identities.set(pid, HOOK_IDENTITY(pid));
  const id = await launchedReservation(endpointInstance, scheduler, f.project, "reused-pid", { pid, startIdentity: HOOK_IDENTITY(pid) });
  await waitUntil(() => f.reads.identity === 1, 5_000, () => `the recorded identity was proved (${f.reads.identity})`);

  // The pid now belongs to another process: a different live start identity. The
  // proof may answer for at most the bound, so nothing is retired inside it.
  f.identities.set(pid, `${pid}@2027-02-02T00:00:00Z`);
  f.clock.now += ADMISSION_HOOK_IDENTITY_REVALIDATE_MS - 1_000;
  await waitUntil(() => f.reads.alive >= 6, 5_000, () => `more ticks (${f.reads.alive})`);
  assert.equal(f.reads.identity, 1, "inside the bound the reuse is not yet read");
  assertChargedAndHeld(scheduler, id, "a pid reused inside the bound");

  // At the bound the fresh read sees the other identity: a dead hook, the
  // producer's own absence answer, and the recorded accounting retirement.
  f.clock.now += 2_000;
  await waitUntil(() => scheduler.accountingStatus(id)?.accounting === "retired", 6_000,
    () => `the reused pid is recognised (${JSON.stringify(scheduler.store.hostRunJournal(id).map((row: JournalRow) => row.event))})`);
  const status = scheduler.accountingStatus(id)!;
  assert.equal(status.disposition?.format, "queue.host-run.accounting-absence-retirement");
  // The absence retirement and the gone hook then settle the reservation through
  // the ordinary path: lost, released, no result invented.
  const record = scheduler.get(id)!;
  assert.equal(record.state, "settled", "the reused pid settles the reservation");
  assert.equal(record.settlement?.outcome, "lost");
  assert.equal(record.settlement?.result, null, "no settlement result is invented");
  assert.equal(record.capacityReleasedAt, record.settledAt, "the settlement records its own release");
  assert.deepEqual(notes(scheduler, id, "effigy_observation"), [], "no producer closure is invented");
});

test("a hook that disappears is dead on the next tick, from liveness alone", async t => {
  const scheduler = isolatedScheduler(t);
  const f = fixture(t);
  const endpointInstance = await endpoint(t, scheduler, f);
  const pid = liveHookPid();
  f.alive.add(pid);
  f.identities.set(pid, HOOK_IDENTITY(pid));
  const id = await launchedReservation(endpointInstance, scheduler, f.project, "vanished", { pid, startIdentity: HOOK_IDENTITY(pid) });
  await waitUntil(() => f.reads.identity === 1, 5_000, () => `the recorded identity was proved (${f.reads.identity})`);

  // Kernel ESRCH: absence is current evidence and needs no identity read at all,
  // so the disappearance is recognised inside the bound.
  f.alive.delete(pid);
  f.clock.now += 100;
  await waitUntil(() => scheduler.accountingStatus(id)?.accounting === "retired", 6_000,
    () => `the disappearance retires the accounting (${JSON.stringify(scheduler.store.hostRunJournal(id).map((row: JournalRow) => row.event))})`);
  assert.equal(f.reads.identity, 1, "the disappearance is proved by liveness, not by another identity read");
  const settledRow = scheduler.get(id)!;
  assert.equal(settledRow.state, "settled", "the gone hook settles the reservation");
  assert.equal(settledRow.settlement?.outcome, "lost", "the settlement claims nothing about the workload");
  assert.equal(settledRow.settlement?.result, null, "no result is invented");
  assert.equal(settledRow.capacityReleasedAt, settledRow.settledAt, "the settlement records its own release");
});

test("an unreadable identity is unknown and is never remembered as alive", async t => {
  const scheduler = isolatedScheduler(t);
  const f = fixture(t);
  const endpointInstance = await endpoint(t, scheduler, f);
  const pid = liveHookPid();
  f.alive.add(pid);
  f.identities.set(pid, `${pid}@unknown`);
  const id = await launchedReservation(endpointInstance, scheduler, f.project, "unknown-live-identity", { pid, startIdentity: HOOK_IDENTITY(pid) });
  await waitUntil(() => notes(scheduler, id, "effigy_observation_refused").some(note => note.kind === "hook-liveness-unknown" && /identity could not be re-read/.test(note.reason ?? "")), 4_000,
    () => `the unknown identity is noted (${JSON.stringify(notes(scheduler, id, "effigy_observation_refused"))})`);
  const firstReads = f.reads.identity;
  await waitUntil(() => f.reads.identity >= firstReads + 2, 5_000, () => `the unknown is read again (${f.reads.identity})`);
  assert.ok(f.reads.identity > firstReads + 1, "an unknown identity is never cached: every tick asks again");
  assertChargedAndHeld(scheduler, id, "an unreadable live identity");
  assert.equal(observations(f.countFile), 0, "an unknown identity is never read as absence");
});

test("a recorded identity that is unknown, or permission-denied liveness, is never a retirement", async t => {
  const scheduler = isolatedScheduler(t);
  const f = fixture(t);
  const endpointInstance = await endpoint(t, scheduler, f);
  const recordedUnknown = liveHookPid();
  f.alive.add(recordedUnknown);
  const unbound = await launchedReservation(endpointInstance, scheduler, f.project, "recorded-unknown",
    { pid: recordedUnknown, startIdentity: `${recordedUnknown}@unknown` });
  await waitUntil(() => notes(scheduler, unbound, "effigy_observation_refused").some(note => note.kind === "hook-liveness-unknown"), 4_000,
    "the recorded unknown identity is noted");
  assert.equal(f.reads.identity, 0, "a recorded unknown identity is never read at all");
  // A permission-denied liveness probe answers alive (EPERM is ambiguous), and
  // its identity read cannot be made: still unknown, never absence.
  const denied = liveHookPid();
  f.alive.add(denied);
  const permissionDenied = await launchedReservation(endpointInstance, scheduler, f.project, "permission-denied",
    { pid: denied, startIdentity: HOOK_IDENTITY(denied) });
  await waitUntil(() => notes(scheduler, permissionDenied, "effigy_observation_refused").some(note => note.kind === "hook-liveness-unknown"), 4_000,
    "the unreadable identity behind an alive liveness is noted");
  assert.ok(f.reads.identity >= 1, "the unreadable live identity is read, and refused, every tick");
  assert.equal(observations(f.countFile), 0);
  assertChargedAndHeld(scheduler, unbound, "a recorded unknown identity");
  assertChargedAndHeld(scheduler, permissionDenied, "permission-denied liveness with an unreadable identity");
});

test("a binding that moved is re-read at once, whatever proof the previous one had", async t => {
  const scheduler = isolatedScheduler(t);
  const f = fixture(t);
  const endpointInstance = await endpoint(t, scheduler, f);
  const first = liveHookPid();
  f.alive.add(first);
  f.identities.set(first, HOOK_IDENTITY(first));
  const id = await launchedReservation(endpointInstance, scheduler, f.project, "rebound", { pid: first, startIdentity: HOOK_IDENTITY(first) });
  await waitUntil(() => f.reads.identity === 1, 5_000, () => `the first identity was proved (${f.reads.identity})`);

  const second = liveHookPid();
  f.alive.add(second);
  f.identities.set(second, HOOK_IDENTITY(second));
  endpointInstance.bindHook(id, second, HOOK_IDENTITY(second));
  await waitUntil(() => f.reads.identity === 2, 5_000, () => `the new binding is read (${f.reads.identity})`);
  assertChargedAndHeld(scheduler, id, "a rebound live hook");
  assert.equal(observations(f.countFile), 0);
});

test("stopping and restarting the endpoint keeps no identity proof at all", async t => {
  const scheduler = isolatedScheduler(t);
  const f = fixture(t);
  const endpointInstance = await endpoint(t, scheduler, f);
  const pid = liveHookPid();
  f.alive.add(pid);
  f.identities.set(pid, HOOK_IDENTITY(pid));
  const id = await launchedReservation(endpointInstance, scheduler, f.project, "restarted", { pid, startIdentity: HOOK_IDENTITY(pid) });
  await waitUntil(() => f.reads.identity === 1, 5_000, () => `the identity was proved (${f.reads.identity})`);

  await endpointInstance.stop();
  await endpointInstance.start();
  // Memory only: the reattached watch proves the identity again before it can
  // answer "alive", so a stop never leaves a proof for a later service.
  await waitUntil(() => f.reads.identity === 2, 5_000, () => `the reattached watch reads the identity again (${f.reads.identity})`);
  assertChargedAndHeld(scheduler, id, "a reattached live hook");
});

test("the default readers still prove a real live hook and never observe it", async t => {
  const scheduler = isolatedScheduler(t);
  const f = fixture(t);
  // No injected readers: the shipped pid liveness and start-identity reads.
  const endpointInstance = await endpoint(t, scheduler, f, { injectReaders: false });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  const pid = child.pid!;
  const id = await launchedReservation(endpointInstance, scheduler, f.project, "real-live-hook",
    { pid, startIdentity: hostRunProcessStartIdentity(pid) });
  await pause(WATCH_MS * 8);
  assert.equal(observations(f.countFile), 0, "a real live hook is never observed");
  assertChargedAndHeld(scheduler, id, "a real live hook");
  // And the row's own recorded retirement path is untouched: the operator's
  // accounting disposition still settles it while the hook is alive.
  scheduler.disposeAccounting({
    runId: id, operationId: "operator-while-alive", expectedEpoch: 1, expectedRunDigest: hostRunPublicDigest(scheduler.get(id)!),
    authority: { caller: "operator (board)" },
    acceptance: { scope: "exact_run", runId: id, epoch: 1, unknownOutcomeRetained: true,
      reason: "retire this reservation's accounting; its outcome and custody stay unknown" },
    reason: "operator retires the unknown reservation's accounting",
  });
  assert.equal(scheduler.accountingStatus(id)?.accounting, "retired");
  assert.equal(scheduler.get(id)!.state, "running");
});
