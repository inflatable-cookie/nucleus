/**
 * Spec 035 "Retired rows are observed on a bounded slow cadence" (task 430).
 *
 * An admission reservation stops charging its slot when an operator retires its
 * accounting, but its outcome and custody stay unknown, so the endpoint kept
 * observing it every watch tick: one `run status` spawn plus a digest of the
 * whole declared artifact, forever, per retired row. On a host with two retired
 * rows and a 184 MB candidate that was about 740 MB/s of hashing for evidence
 * that will never change, and the service sat at a whole core (reported by
 * Queue Supervisor `b86c7623`; the numbers are its evidence, not this file's).
 *
 * The rules this file proves, through the real default endpoint, watch loop and
 * run-control client — no injected observer and no injected digest:
 *
 * - a charged row keeps the ordinary watch;
 * - an operator-retired row keeps its late-evidence route on the bounded slow
 *   cadence, and no artifact is hashed again while its identity is unchanged;
 * - a restarted service reattaches a retired row on that cadence, not on the
 *   ordinary one, and records the producer's late evidence exactly once;
 * - an unreadable or epoch-mismatched retirement stays charged and keeps the
 *   ordinary watch, so a damaged record never looks like "nothing to observe";
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { writeOwnedJson } from "../core/machine/owned-file.mjs";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { ADMISSION_RETIRED_WATCH_MS, ADMISSION_WATCH_MS, EffigyAdmissionEndpoint } from "../service/callbacks/effigy-admission-endpoint";
import { hostRunAccountingDispositionMetaKey } from "../core/host-runs/host-run-meta-keys";
import { hostRunPublicDigest } from "../core/host-runs/host-run-accounting";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";
import { effigyArtifactDigests } from "../core/qa/effigy-runtime";
import { parseEffigyVersion, type EffigyRuntimeAncestor, type EffigyRuntimeSettings } from "../core/qa/effigy-runtime";

const NODE_PATH = realpathSync(process.execPath);
const NODE_SHA256 = createHash("sha256").update(readFileSync(NODE_PATH)).digest("hex");
/** This build of node stands in for the workload's Effigy: asked by its real path, it answers as one. */
const SELF_EFFIGY = (path: string) => path === NODE_PATH ? parseEffigyVersion("effigy v0.14.1+local.test") : null;
const selfAncestry = (): EffigyRuntimeAncestor[] =>
  [{ pid: process.pid, startIdentity: hostRunProcessStartIdentity(process.pid) }];

const ORDINARY_WATCH_MS = 40;
const RETIRED_WATCH_MS = 500;

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

/**
 * The run's own `run status <id> --json` answer, appended to a count file for
 * every call. The client spawns `node run status <id> --json` in the
 * reservation's project, so each line is one real observation spawn through the
 * default route — the cost this task bounds.
 */
function runStatusFixture(project: string, countFile: string, stateFile: string): void {
  writeFileSync(join(project, "run"), `
require("node:fs").appendFileSync(${JSON.stringify(countFile)}, "1\\n");
process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(stateFile)}, "utf8") + "\\n");
`);
}

/** The producer's own closure record (`effigy.command.v1` around `effigy.run.v1`). */
function closureState(runId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "effigy.command.v1", schema_version: 1, ok: true, warnings: [],
    result: { schema: "effigy.run.v1", schema_version: 1, run: {
      evidence_source: "checkout-journal", run_id: runId, task: "qa:stage:rust", phase: "closed",
      state: "failed", exit_code: 7, cleanup: "complete",
      started_at_epoch_ms: 1_700_000_000_000, finished_at_epoch_ms: 1_700_000_002_500, duration_ms: 2_500,
      ...overrides,
    } },
  });
}

/** The producer's own \"no live holder and no journal record\" answer (`#414`). */
function absenceState(runId: string): string {
  return JSON.stringify({
    schema: "effigy.command.v1", schema_version: 1, ok: false, result: null, warnings: [],
    binary: { name: "effigy", version: "0.14.1" },
    command: { kind: "runs", name: "runs" },
    error: {
      kind: "RunnerError",
      message: `run \`${runId}\`: not recorded (foreground or expired); no live holder or retained journal record was found`,
      details: { schema: "effigy.run.v1", schema_version: 1, selector: runId, state: "not-found", recording: "not-recorded" },
    },
  });
}

/** How many observations the endpoint really made for one row. */
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

/** One observable row's own disposable project, state and observation counter. */
interface RowFixture {
  project: string;
  stateFile: string;
  countFile: string;
}

async function rowFixture(root: string, runId: string): Promise<RowFixture> {
  const project = join(root, runId);
  mkdirSync(project, { recursive: true });
  const countFile = join(root, `${runId}.observations`);
  const stateFile = join(root, `${runId}.state.json`);
  writeOwnedJson(stateFile, { state: "running" });
  runStatusFixture(project, countFile, stateFile);
  return { project, stateFile, countFile };
}

interface EndpointOptions {
  watchMs?: number;
  retiredWatchMs?: number;
  watchTimer?: NonNullable<ConstructorParameters<typeof EffigyAdmissionEndpoint>[1]>["watchTimer"];
}

async function isolatedEndpoint(
  t: { after: (fn: () => void | Promise<void>) => void },
  scheduler: HostRunScheduler,
  root: string,
  options: EndpointOptions = {},
): Promise<EffigyAdmissionEndpoint> {
  const endpoint = new EffigyAdmissionEndpoint(scheduler, {
    stateDir: join(root, "host-run"),
    watchMs: options.watchMs ?? ORDINARY_WATCH_MS,
    retiredWatchMs: options.retiredWatchMs ?? RETIRED_WATCH_MS,
    watchTimer: options.watchTimer,
    effigyVersion: SELF_EFFIGY,
  });
  await endpoint.start();
  t.after(async () => { await endpoint.stop(); });
  return endpoint;
}

/** Advance one due watch at a time, waiting for its real observation to rearm. */
class WatchClock {
  now = 0;
  ticks = new Map<number, number>();
  timers = new Map<NodeJS.Timeout, { at: number; delay: number; callback: () => void }>();
  set = (callback: () => void, delay: number): NodeJS.Timeout => {
    const timer = {} as NodeJS.Timeout;
    this.timers.set(timer, { at: this.now + delay, delay, callback });
    return timer;
  };
  clear = (timer: NodeJS.Timeout): void => { this.timers.delete(timer); };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      this.ticks.set(next[1].delay, (this.ticks.get(next[1].delay) ?? 0) + 1);
      next[1].callback();
      await waitUntil(() => this.timers.size >= 2, 5_000, "watch rearmed");
    }
    this.now = end;
  }
}

/** A pid this process started and reaped: alive to nobody, so "the hook died" is observed. */
async function deadHook(): Promise<{ pid: number; startIdentity: string }> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
  return { pid, startIdentity: `${pid}@1999-01-01T00:00:00Z` };
}

/** A launched admission bound to the declared bytes, with its launcher already gone. */
async function launchedReservation(
  endpoint: EffigyAdmissionEndpoint,
  scheduler: HostRunScheduler,
  fixture: RowFixture,
  runId: string,
): Promise<string> {
  const reserved = await endpoint.reserve(request(runId, fixture.project), selfAncestry());
  assert.ok(reserved.reservationId, `reservation accepted (${JSON.stringify(reserved.observation)})`);
  const id = reserved.reservationId!;
  assert.equal(scheduler.get(id)?.effigyRuntime?.sha256, NODE_SHA256, "the reservation was written already bound");
  const hook = await deadHook();
  endpoint.bindHook(id, hook.pid, hook.startIdentity);
  await waitUntil(() => scheduler.get(id)?.state === "running", 4_000, () => `reservation launched (${scheduler.get(id)?.state})`);
  return id;
}

/** What the operator's board does: retire the row's ACCOUNTING, nothing else. */
function retireAccounting(scheduler: HostRunScheduler, id: string): void {
  scheduler.disposeAccounting({
    runId: id, operationId: `operator-${id}`, expectedEpoch: 1, expectedRunDigest: hostRunPublicDigest(scheduler.get(id)!),
    authority: { caller: "operator (board)" },
    acceptance: { scope: "exact_run", runId: id, epoch: 1, unknownOutcomeRetained: true,
      reason: "retire this reservation's accounting; its outcome and custody stay unknown" },
    reason: "operator retires the unknown reservation's accounting",
  });
  assert.equal(scheduler.accountingStatus(id)?.accounting, "retired");
}

const journalEvents = (scheduler: HostRunScheduler, id: string): string[] =>
  scheduler.store.hostRunJournal(id).map(row => row.event);

test("the retired cadence is bounded in minutes, not seconds", () => {
  assert.equal(ADMISSION_WATCH_MS, 1_000, "the ordinary watch is still the one-second tick");
  assert.equal(ADMISSION_RETIRED_WATCH_MS, 5 * 60_000, "a retired row is observed every five minutes");
  assert.ok(ADMISSION_RETIRED_WATCH_MS >= 60_000, "the retired cadence is measured in minutes");
});

test("an operator-retired row slows to the bounded cadence while a charged row keeps its watch", async t => {
  const root = mkdtempSync(join(tmpdir(), "qro-slow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scheduler = isolatedScheduler(t);
  const endpoint = await isolatedEndpoint(t, scheduler, root);
  const charged = await rowFixture(root, "charged-row");
  const retired = await rowFixture(root, "retired-row");
  const chargedId = await launchedReservation(endpoint, scheduler, charged, "charged-row");
  const retiredId = await launchedReservation(endpoint, scheduler, retired, "retired-row");

  await endpoint.stop();
  retireAccounting(scheduler, retiredId);
  const clock = new WatchClock();
  const controlled = await isolatedEndpoint(t, scheduler, root, { watchTimer: clock });
  effigyArtifactDigests.resetCosts();
  await clock.advance(1_000);
  assert.equal(clock.ticks.get(ORDINARY_WATCH_MS), 25, "the charged row ticks every 40 ms");
  assert.equal(clock.ticks.get(RETIRED_WATCH_MS), 2, "the retired row ticks every 500 ms");
  const costs = effigyArtifactDigests.costs();
  assert.equal(costs.hashed, 0, "no verification hashed the unchanged artifact again");
  assert.equal(costs.bytesRead, 0, "and no byte of it was read");

  // The retirement is the operator's record, and nothing else was written: no
  // settlement, no second retirement, no re-charge, no custody claim.
  const status = scheduler.accountingStatus(retiredId)!;
  assert.equal(status.disposition?.format, "queue.host-run.accounting-disposition");
  assert.equal(status.record.state, "running", "the pinned row is untouched");
  assert.equal(status.record.settlement, null);
  assert.equal(status.record.capacityReleasedAt, null);
  assert.deepEqual(journalEvents(scheduler, retiredId).filter(event => event === "accounting_retirement"), [],
    "the automatic path adds no second retirement for an operator-retired row");
  assert.equal(journalEvents(scheduler, retiredId).filter(event => event === "accounting_disposition").length, 1);

  assert.equal(scheduler.get(chargedId)!.state, "running", "the charged row is the same row throughout");
  await controlled.stop();
});

test("a restarted service reattaches an operator-retired row on the slow cadence and keeps its late evidence", async t => {
  const root = mkdtempSync(join(tmpdir(), "qro-again-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scheduler = isolatedScheduler(t);
  const row = await rowFixture(root, "late-evidence");
  const first = await isolatedEndpoint(t, scheduler, root);
  const id = await launchedReservation(first, scheduler, row, "late-evidence");
  await waitUntil(() => observations(row.countFile) >= 2, 5_000,
    () => `the charged row is observed (${observations(row.countFile)})`);
  retireAccounting(scheduler, id);
  await first.stop();

  // A fresh endpoint on the same state directory reattaches the row, and its
  // cadence comes from the durable row: no observation inside the ordinary tick.
  const reattached = await isolatedEndpoint(t, scheduler, root);
  const attachedBefore = observations(row.countFile);
  await pause(150);
  assert.equal(observations(row.countFile), attachedBefore,
    "a reattached endpoint does not start a retired row at the ordinary cadence");
  effigyArtifactDigests.resetCosts();
  await waitUntil(() => observations(row.countFile) > attachedBefore, 4_000,
    () => `the reattached endpoint still observes the retired row (${observations(row.countFile)})`);
  assert.equal(effigyArtifactDigests.costs().hashed, 0, "the slow observation reuses the unchanged artifact's digest");

  // The producer's own closure now arrives: it is late evidence, recorded once,
  // while the operator's accounting record stays exactly what it was.
  // Publish a whole producer frame: an in-place write can race the real observer.
  writeOwnedJson(row.stateFile, JSON.parse(closureState("late-evidence", { exit_code: 3 })));
  await waitUntil(() => scheduler.store.hostRunJournal(id).some(entry => entry.event === "effigy_observation"),
    6_000, () => `the late producer closure is kept (${JSON.stringify(scheduler.store.hostRunJournal(id).map(({ event, data }) => ({ event, data })))})`);
  const observed = scheduler.store.hostRunJournal(id).filter(entry => entry.event === "effigy_observation");
  assert.equal(observed.length, 1, "one note for the one producer answer");
  assert.equal((observed[0].data as { exitCode: number }).exitCode, 3, "the producer's own verdict is the evidence");
  assert.equal((observed[0].data as { runtimeSha256: string }).runtimeSha256, NODE_SHA256);
  const retirement = scheduler.accountingStatus(id)!;
  assert.equal(retirement.accounting, "retired");
  assert.equal(retirement.disposition?.format, "queue.host-run.accounting-disposition",
    "the operator's own record still stands; the late evidence does not overwrite it");
  assert.deepEqual(journalEvents(scheduler, id).filter(event => event === "accounting_retirement"), []);
  // The producer's late closure is the row's final evidence, so the gone hook
  // settles the reservation through the ordinary path: lost, released, no result.
  await waitUntil(() => scheduler.get(id)!.state === "settled", 6_000,
    () => `the late evidence settles the reservation (${JSON.stringify(journalEvents(scheduler, id))})`);
  assert.equal(scheduler.get(id)!.settlement?.outcome, "lost", "the pinned settlement is the contract's own no-result outcome");
  assert.equal(scheduler.get(id)!.settlement?.result, null, "no result is invented");
  assert.equal(scheduler.get(id)!.capacityReleasedAt, scheduler.get(id)!.settledAt);

  // Once the producer's record is the row's final evidence, the watch stops: a
  // repeated tick adds nothing and reads nothing.
  const settledEvidence = observations(row.countFile);
  await pause(1_200);
  assert.equal(observations(row.countFile), settledEvidence, "the retired row's watch stops after its late evidence");
  assert.equal(scheduler.store.hostRunJournal(id).filter(entry => entry.event === "effigy_observation").length, 1);
  assert.equal(scheduler.store.hostRunJournal(id).filter(entry => entry.event === "settlement").length, 1);
  assert.equal(scheduler.accountingStatus(id)!.accounting, "retired");
  await reattached.stop();
});

test("a row retired on either automatic basis stops its watch instead of observing again", async t => {
  const root = mkdtempSync(join(tmpdir(), "qro-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scheduler = isolatedScheduler(t);
  const endpoint = await isolatedEndpoint(t, scheduler, root);

  const cleanup = await rowFixture(root, "producer-cleanup");
  writeOwnedJson(cleanup.stateFile, JSON.parse(closureState("producer-cleanup")));
  const cleanupId = await launchedReservation(endpoint, scheduler, cleanup, "producer-cleanup");
  await waitUntil(() => scheduler.accountingStatus(cleanupId)?.accounting === "retired", 5_000,
    () => `the producer closure retires the accounting (${JSON.stringify(journalEvents(scheduler, cleanupId))})`);
  assert.equal(scheduler.accountingStatus(cleanupId)!.disposition?.format, "queue.host-run.accounting-retirement");
  const cleanupSpent = observations(cleanup.countFile);
  await pause(600);
  assert.equal(observations(cleanup.countFile), cleanupSpent,
    "a producer-cleanup retirement has its final evidence, so the watch stops");

  const absent = await rowFixture(root, "foreground-absent");
  writeOwnedJson(absent.stateFile, JSON.parse(absenceState("foreground-absent")));
  const absentId = await launchedReservation(endpoint, scheduler, absent, "foreground-absent");
  await waitUntil(() => scheduler.accountingStatus(absentId)?.accounting === "retired", 5_000,
    () => `the absence answer retires the accounting (${JSON.stringify(journalEvents(scheduler, absentId))})`);
  assert.equal(scheduler.accountingStatus(absentId)!.disposition?.format, "queue.host-run.accounting-absence-retirement");
  const absentSpent = observations(absent.countFile);
  await pause(600);
  assert.equal(observations(absent.countFile), absentSpent,
    "a foreground-absence retirement has its final evidence, so the watch stops");
  // Both bases settle the reservation itself: the charge is already retired and
  // the recorded process is gone, so nothing is left to hold.
  await waitUntil(() => scheduler.get(cleanupId)!.state === "settled" && scheduler.get(absentId)!.state === "settled",
    6_000, () => `both retired rows settle (${scheduler.get(cleanupId)!.state}, ${scheduler.get(absentId)!.state})`);
  assert.equal(scheduler.get(cleanupId)!.settlement?.outcome, "lost");
  assert.equal(scheduler.get(absentId)!.settlement?.outcome, "lost");
  assert.equal(scheduler.get(cleanupId)!.capacityReleasedAt, scheduler.get(cleanupId)!.settledAt);
  assert.equal(scheduler.get(absentId)!.capacityReleasedAt, scheduler.get(absentId)!.settledAt);
});

test("an unreadable or epoch-mismatched retirement stays charged and keeps the ordinary watch", async t => {
  const root = mkdtempSync(join(tmpdir(), "qro-damaged-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scheduler = isolatedScheduler(t);
  const endpoint = await isolatedEndpoint(t, scheduler, root);
  const mismatched = await rowFixture(root, "mismatched-epoch");
  const unreadable = await rowFixture(root, "unreadable-retirement");
  const mismatchedId = await launchedReservation(endpoint, scheduler, mismatched, "mismatched-epoch");
  const unreadableId = await launchedReservation(endpoint, scheduler, unreadable, "unreadable-retirement");

  // A stored operator retirement that names another epoch: the row moved, so
  // accounting stays charged and the watch stays ordinary.
  retireAccounting(scheduler, mismatchedId);
  const stored = scheduler.store.hostRunAccountingDispositionRaw(mismatchedId) as Record<string, unknown>;
  scheduler.store.setMeta(hostRunAccountingDispositionMetaKey(mismatchedId), { ...stored, epoch: 99 });
  const moved = scheduler.accountingStatus(mismatchedId)!;
  assert.equal(moved.accounting, "charged", "an epoch-mismatched retirement is not read as retired");
  assert.equal(moved.dispositionReadable, false);

  // A half-written record this build cannot parse: the same conservative shape.
  scheduler.store.setMeta(hostRunAccountingDispositionMetaKey(unreadableId),
    { format: "queue.host-run.accounting-disposition", version: 1 });
  const damaged = scheduler.accountingStatus(unreadableId)!;
  assert.equal(damaged.accounting, "charged", "an unreadable retirement is not read as retired");
  assert.equal(damaged.dispositionReadable, false);

  const mismatchedBefore = observations(mismatched.countFile);
  const unreadableBefore = observations(unreadable.countFile);
  await waitUntil(() => observations(mismatched.countFile) > mismatchedBefore
    && observations(unreadable.countFile) > unreadableBefore, 5_000,
  () => `both charged rows receive another ordinary observation (${observations(mismatched.countFile) - mismatchedBefore}/${observations(unreadable.countFile) - unreadableBefore})`);
  const mismatchedDelta = observations(mismatched.countFile) - mismatchedBefore;
  const unreadableDelta = observations(unreadable.countFile) - unreadableBefore;
  assert.ok(mismatchedDelta > 0, "an epoch-mismatched retirement keeps the ordinary watch");
  assert.ok(unreadableDelta > 0, "an unreadable retirement keeps the ordinary watch");
  assert.equal(scheduler.get(mismatchedId)!.state, "running");
  assert.equal(scheduler.get(unreadableId)!.state, "running");
  assert.equal(scheduler.get(mismatchedId)!.settlement, null);
  assert.equal(scheduler.get(unreadableId)!.settlement, null);
});
