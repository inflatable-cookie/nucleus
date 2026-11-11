import { observeIdle } from './support/fakes';
import { copyNodeRuntime } from "../scripts/copy-node-runtime.mjs";
import { RuntimeRepositories, type RepositoriesContext } from "../core/runtime/repositories";
/**
 * Spec 035, "Automatic accounting on producer cleanup".
 *
 * Task #415 settled a journal-backed admission with a pinned contract 010
 * result — the admission hook's recorded pid as the run's `pgid`, an empty
 * `escapedDescendants` list and an empty `containers` list — and released its
 * capacity from that. Queue supervised no admitted command, so those lists and
 * that process group were never custody evidence: they were a fabricated
 * settlement. Tom's 2026-10-25 ruling replaces it with an accounting decision:
 * when the producer reports that exact run's cleanup complete, the reservation's
 * ACCOUNTING is retired, its outcome and runtime custody stay UNKNOWN and the
 * pinned contract 010 record is not written at all.
 *
 * The first half drives the real scheduler and its durable sidecar; the last two
 * tests use the actual default admission route (a `RuntimeOwner` serving its own
 * admission socket) against an immutable fake producer, and reproduce the
 * settlement #415 wrote to show the new semantics reject it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { HostRunScheduler, type HostRunSubmission } from "../core/host-runs/host-run-scheduler";
import { QueueRuntime } from "../service/runtime-owner";
import { admissionReservationId, defaultAdmissionHookCommand, QUEUE_ADMISSION_SOCKET_ENV, EFFIGY_ADMISSION_HOOK_TIMEOUT_ENV } from "../core/qa/effigy-admission";
import { hostRunAdmissionSocketPath } from "../core/host-runs/host-run-paths";
import { parseEffigyVersion } from "../core/qa/effigy-runtime";
import { HOST_RUN_ACCOUNTING_POLICY, hostRunPublicDigest } from "../core/host-runs/host-run-accounting";
import { publicHostRunRecord } from "../core/host-runs/host-run-identity";
import { hostRunAccountingDispositionMetaKey } from "../core/host-runs/host-run-meta-keys";
import {
  hostRunList, hostRunRecordSchema, hostRunResultSchema, hostRunSettlementSchema,
  type HostRunAccountingProducerRecord, type HostRunInternalRecord,
} from "../shared/contracts";
import { frozenHostRunRecordSchema } from "./support/contract-010-frozen";
import type { Adapter } from "../core/host";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitUntil(probe: () => boolean, ms: number, label: string | (() => string)): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (probe()) return;
    await pause(40);
  }
  throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
}

const RUNTIME_PATH = "/fixture/effigy";
const RUNTIME_SHA256 = "a".repeat(64);
const repository = { origin: "https://github.com/example/retirement", path: "/repo/retirement" };
const capacity = () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });

function harness(t: { after: (fn: () => void) => void }, cpuCapacity = 4) {
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity: () => ({ ...capacity(), cpuCapacity }) });
  t.after(() => { scheduler.stop(); store.close(); });
  return { store, scheduler };
}

const submission = (id: string, overrides: Partial<HostRunSubmission> = {}): HostRunSubmission => ({
  id, epoch: 1, caller: `test:${id}`, repository, selector: "qa:stage:rust", runClass: "heavy", classSource: "manifest",
  priority: "interactive", runTimeoutMs: 24 * 60 * 60_000, submissionSource: "admission", effigyRunId: id,
  effigyRuntimeBinding: {
    kind: "bound", identity: { path: RUNTIME_PATH, sha256: RUNTIME_SHA256 }, version: "0.14.1", workloadPath: RUNTIME_PATH,
    workloadPid: 4242, workloadStartIdentity: "4242@2026-10-25T10:00:00Z",
  },
  ...overrides,
});

/** A launched, runtime-bound admission reservation: the shape this path covers. */
function launchedReservation(h: { scheduler: HostRunScheduler }, id: string, overrides: Partial<HostRunSubmission> = {}): HostRunInternalRecord {
  h.scheduler.submit(submission(id, overrides), { launch: run => { h.scheduler.markLaunched(run.id); } });
  return h.scheduler.get(id)!;
}

/** The producer record the observer reads for that reservation (Spec 035, "Producer closure"). */
function producerRecord(overrides: Partial<HostRunAccountingProducerRecord> = {}): HostRunAccountingProducerRecord {
  return {
    runId: "closed-run",
    selector: "qa:stage:rust",
    evidenceSource: "checkout-journal",
    cleanup: "complete",
    state: "failed",
    exitCode: 7,
    signal: null,
    startedAt: "2026-10-25T10:00:00.000Z",
    endedAt: "2026-10-25T10:00:02.500Z",
    durationMs: 2_500,
    runtimePath: RUNTIME_PATH,
    runtimeSha256: RUNTIME_SHA256,
    verdict: "failed",
    observedAt: "2026-10-25T10:00:03.000Z",
    ...overrides,
  };
}

const journalEvents = (h: { store: Store }, id: string): string[] =>
  h.store.hostRunJournal(id).map(row => row.event);
const facts = (h: { store: Store }, id: string, event: string) =>
  h.store.hostRunJournal(id).filter(row => row.event === event).map(row => row.data as Record<string, any>);

const violation = (fn: () => unknown, pattern: RegExp) => {
  let error: unknown = null;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error instanceof Error, "the call refused");
  assert.match(error.message, pattern);
};

/**
 * The new semantics, as one predicate both the real route and the parent
 * falsification evaluate: the charge is retired, no settlement, result, custody
 * inventory or settlement-based release exists, and the producer record is kept
 * as evidence with no operator acceptance invented.
 */
function retirementViolations(h: { scheduler: HostRunScheduler; store: Store }, id: string): string[] {
  const problems: string[] = [];
  const row = h.scheduler.get(id);
  if (!row) return ["the row is missing"];
  if (row.settlement !== null) problems.push("the row carries a settlement");
  if (row.capacityReleasedAt !== null) problems.push("the row carries a capacity release");
  if (row.escapedDescendantsProvenDeadAt !== null) problems.push("the row claims proven-dead descendants");
  if (row.containers.length) problems.push("the row carries a container inventory");
  const events = journalEvents(h, id);
  if (events.includes("settlement")) problems.push("a settlement fact exists");
  if (events.includes("capacity_release")) problems.push("a capacity release fact exists");
  if (h.scheduler.accountingStatus(id)?.accounting !== "retired") problems.push("the accounting is not retired");
  const retirement = h.scheduler.accountingStatus(id)?.disposition;
  if (retirement?.format !== "queue.host-run.accounting-retirement") problems.push("no automatic retirement is recorded");
  if (retirement && retirement.acceptance !== null) problems.push("an operator acceptance was fabricated");
  return problems;
}

test("automatic retirement is idempotent across repeated observation, a lost reply and a concurrent pass", t => {
  const h = harness(t);
  const run = launchedReservation(h, "closed-run");
  const producer = producerRecord();
  const first = h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer });
  assert.equal(first.kind, "retired");
  assert.equal(first.view.accounting, "retired");
  assert.equal(first.retirement.format, "queue.host-run.accounting-retirement");
  assert.equal(facts(h, run.id, "accounting_retirement").length, 1);

  // The same observation again (a tick), a later tick with a new observation
  // instant, and a concurrent pass all find the durable retirement: nothing is
  // written twice and the charge is not re-applied.
  const again = h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer });
  assert.equal(again.kind, "already_retired");
  const later = h.scheduler.retireAccountingOnProducerCleanup({
    runId: run.id, producer: { ...producer, observedAt: "2026-10-25T10:05:00.000Z" },
  });
  assert.equal(later.kind, "already_retired");
  assert.equal(facts(h, run.id, "accounting_retirement").length, 1, "one durable retirement, ever");
  assert.deepEqual(again.retirement, first.retirement);
  assert.equal(h.scheduler.summary().reservedCpu, 0);
  assert.deepEqual(retirementViolations(h, run.id), []);
  assert.equal(facts(h, run.id, "accounting_retirement")[0].acceptance, null);
  assert.equal(facts(h, run.id, "accounting_retirement")[0].policy.rule, "spec-035/automatic-accounting-on-producer-cleanup");
  assert.deepEqual(facts(h, run.id, "accounting_retirement")[0].policy, HOST_RUN_ACCOUNTING_POLICY);
});

test("a retired reservation stops holding its workspace; an unbindable retirement keeps the hold", t => {
  const h = harness(t);
  const run = launchedReservation(h, "closed-run");
  assert.equal(h.store.hostRunHoldingWorkspace(repository.path)?.id, run.id, "a charged running reservation holds its workspace");

  // A retirement this build cannot bind to the row (unreadable, or another
  // epoch's) leaves the run charged, so it keeps the workspace too.
  const key = hostRunAccountingDispositionMetaKey(run.id);
  h.store.setMeta(key, { unreadable: true });
  assert.equal(h.store.hostRunHoldingWorkspace(repository.path)?.id, run.id);
  h.store.db.prepare("DELETE FROM meta WHERE key=?").run(key);
  const { retirement } = h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() });
  h.store.setMeta(key, { ...retirement, epoch: retirement.epoch + 1 });
  assert.equal(h.store.hostRunHoldingWorkspace(repository.path)?.id, run.id, "another epoch's retirement does not release this row");

  // The exact retirement releases the workspace and nothing else: the row is
  // still running, unsettled and without a capacity release.
  h.store.setMeta(key, retirement);
  assert.equal(h.store.hostRunHoldingWorkspace(repository.path), null);
  assert.equal(h.scheduler.get(run.id)!.state, "running");
  assert.deepEqual(retirementViolations(h, run.id), []);
});

test("retirement refuses evidence it cannot bind to the reservation and writes nothing", t => {
  const h = harness(t);
  const run = launchedReservation(h, "closed-run");
  const before = h.scheduler.summary().reservedCpu;
  assert.ok(before > 0);
  const attempts: Array<[Partial<HostRunAccountingProducerRecord>, RegExp]> = [
    [{ runId: "another-run" }, /not retired on another run's record/],
    [{ selector: "qa:stage:go" }, /not retired on another task's record/],
    [{ runtimePath: "/fixture/other-effigy" }, /not retired on another runtime's answer/],
    [{ runtimeSha256: "b".repeat(64) }, /not retired on another runtime's answer/],
  ];
  for (const [overrides, pattern] of attempts) {
    violation(() => h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord(overrides) }), pattern);
    assert.equal(h.scheduler.accountingStatus(run.id)!.accounting, "charged", "a refused record retires nothing");
  }
  assert.equal(facts(h, run.id, "accounting_retirement").length, 0, "no retirement fact is written");
  assert.equal(h.scheduler.summary().reservedCpu, before, "the slot stays charged");
});

test("a settled or unknown reservation never takes this path", t => {
  const h = harness(t);
  const run = launchedReservation(h, "closed-run");
  h.scheduler.settle(run.id, hostRunSettlementSchema.parse({
    format: "host.run.settlement", version: 1, runId: run.id, outcome: "failed", launched: true,
    settledAt: "2026-10-25T10:00:05.000Z",
    result: hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId: run.id, epoch: run.epoch, pgid: 4242,
      startIdentity: "4242@2026-10-25T10:00:00Z", exitCode: 9, signal: null,
      startedAt: run.launchedAt!, endedAt: "2026-10-25T10:00:05.000Z", wallMs: 1000, cpuMs: 10,
      escapedDescendants: [],
    }),
    containers: [],
  }));
  violation(() => h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() }),
    /already has a settlement/);
  violation(() => h.scheduler.retireAccountingOnProducerCleanup({ runId: "no-such-run", producer: producerRecord() }),
    /unknown_run/);
});

test("an unreadable stored retirement keeps the charge and is never replaced", t => {
  const h = harness(t);
  const run = launchedReservation(h, "closed-run");
  h.store.setMeta(`hostRunAccountingDisposition:${run.id}`, { format: "not-a-retirement" });
  violation(() => h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() }),
    /cannot be read against its epoch/);
  assert.equal(h.scheduler.accountingStatus(run.id)!.accounting, "charged", "a damaged sidecar never frees a slot");
  assert.equal(h.scheduler.accountingStatus(run.id)!.dispositionReadable, false);
  assert.equal(facts(h, run.id, "accounting_retirement").length, 0);
});

test("a failed durable write holds the charge, and the retry retires it exactly once", t => {
  const h = harness(t);
  const run = launchedReservation(h, "closed-run");
  const original = h.store.setMeta.bind(h.store);
  const target = h.store as unknown as { setMeta: (key: string, value: unknown) => void };
  target.setMeta = (key, value) => {
    if (key.startsWith("hostRunAccountingDisposition:")) throw new Error("simulated durable write failure");
    original(key, value);
  };
  violation(() => h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() }),
    /simulated durable write failure/);
  target.setMeta = original;
  assert.equal(h.scheduler.accountingStatus(run.id)!.accounting, "charged", "a failed write retires nothing");
  assert.equal(facts(h, run.id, "accounting_retirement").length, 0, "its journal fact rolled back with it");
  assert.ok(h.scheduler.summary().reservedCpu > 0, "the slot is still charged");

  const retried = h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() });
  assert.equal(retried.kind, "retired");
  assert.equal(facts(h, run.id, "accounting_retirement").length, 1);
  assert.equal(h.scheduler.summary().reservedCpu, 0);
});

test("a retired charge never resumes, even when a genuine settlement lands later", t => {
  const h = harness(t);
  const run = launchedReservation(h, "closed-run");
  h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() });
  assert.equal(h.scheduler.summary().reservedCpu, 0);
  // The Queue-supervised settlement path is untouched: a run Queue really
  // supervised still settles as itself. This reservation's retired accounting
  // does not resume charging on the late evidence, and its earlier UNKNOWN is
  // not laundered into a success.
  const late = h.scheduler.settle(run.id, hostRunSettlementSchema.parse({
    format: "host.run.settlement", version: 1, runId: run.id, outcome: "failed", launched: true,
    settledAt: "2026-10-25T11:00:00.000Z",
    result: hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId: run.id, epoch: run.epoch, pgid: 4242,
      startIdentity: "4242@2026-10-25T10:00:00Z", exitCode: 1, signal: null,
      startedAt: run.launchedAt!, endedAt: "2026-10-25T11:00:00.000Z", wallMs: 1000, cpuMs: 10,
      escapedDescendants: [],
    }),
    containers: [],
  }));
  assert.equal(late.state, "settled");
  assert.equal(h.scheduler.accountingStatus(run.id)!.accounting, "retired", "the retirement outlives later evidence");
  assert.equal(h.scheduler.summary().reservedCpu, 0, "the charge never resumes");
  const repeat = h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() });
  assert.equal(repeat.kind, "already_retired");
  assert.equal(facts(h, run.id, "accounting_retirement").length, 1);
});

test("a retirement leaves the pinned contract 010 record byte for byte as it was", t => {
  const h = harness(t);
  const run = launchedReservation(h, "closed-run");
  const before = hostRunPublicDigest(h.scheduler.get(run.id)!);
  const retirement = h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() });
  const after = h.scheduler.get(run.id)!;
  assert.equal(hostRunPublicDigest(after), before, "the pinned record did not change");
  assert.equal(retirement.retirement.expectedRunDigest, before);
  assert.equal(hostRunRecordSchema.safeParse(JSON.parse(JSON.stringify(retirement.view.record))).success, true,
    "the owner read still answers the pinned record");
  const listed = h.scheduler.list().map(publicHostRunRecord);
  assert.equal(hostRunList.output.safeParse(JSON.parse(JSON.stringify(listed))).success, true);
  for (const record of JSON.parse(JSON.stringify(listed)) as Record<string, unknown>[])
    assert.equal(frozenHostRunRecordSchema.safeParse(record).success, true, "the frozen strict decoder still accepts it");
});

test("retiring the accounting admits the reservation the held slot was queuing", t => {
  const h = harness(t, 1);
  const run = launchedReservation(h, "closed-run");
  h.scheduler.submit(submission("waiting", { effigyRunId: "waiting" }),
    { launch: waiting => { h.scheduler.markLaunched(waiting.id); } });
  assert.equal(h.scheduler.get("waiting")!.state, "queued", "the first reservation holds the whole box");
  h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() });
  assert.equal(h.scheduler.get("waiting")!.state, "running", "the freed accounting admits the queued work");
  assert.equal(h.scheduler.get(run.id)!.state, "running", "the retired reservation keeps its own unknown state");
});

/* ------------------------------------------------------------------ *
 * The actual default admission route, against an immutable fake producer.
 * ------------------------------------------------------------------ */

const TASK = "qa:stage:rust";

const admissionRequest = (runId: string, project: string) => JSON.stringify({
  schema: "effigy.admission-request.v1", run_id: runId, task: TASK, class: "heavy", cwd: project, root: project,
});

const closureRecord = (runId: string) => JSON.stringify({
  schema: "effigy.command.v1", schema_version: 1, ok: true, warnings: [],
  result: {
    schema: "effigy.run.v1", schema_version: 1,
    run: {
      evidence_source: "checkout-journal", run_id: runId, task: TASK, phase: "closed",
      state: "failed", exit_code: 7, cleanup: "complete",
      started_at_epoch_ms: 1_700_000_000_000, finished_at_epoch_ms: 1_700_000_002_500, duration_ms: 2_500,
    },
  },
});

/**
 * The producer the declared artifact really is: an immutable copy of this node
 * binary whose script runs the real admission hook, waits for `admit`, writes
 * its own cleanup closure for `run status` to answer, and ends the hook — the
 * shape Effigy leaves behind when a journal-backed run closes.
 */
function fakeProducer(
  t: { after: (fn: () => void) => void },
  root: string,
  runId: string,
  project: string,
  admission: { socketPath: string; hookCommand: string; artifactPath: string },
): void {
  const script = join(root, "producer.cjs");
  writeFileSync(script, `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const hook = spawn("/bin/sh", ["-c", process.env.FAKE_HOOK_COMMAND], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
let finished = false;
hook.stdout.setEncoding("utf8");
hook.stdout.on("data", chunk => {
  out += chunk;
  if (finished) return;
  if (out.includes("admit")) {
    finished = true;
    writeFileSync("hook-out.txt", out);
    writeFileSync("closure.json", process.env.FAKE_CLOSURE);
    hook.kill("SIGTERM");
    setTimeout(() => process.exit(0), 100);
  } else if (out.includes("deny")) {
    finished = true;
    writeFileSync("hook-out.txt", out);
    hook.kill("SIGKILL");
    process.exit(1);
  }
});
`);
  const child = spawn(admission.artifactPath, [script], {
    cwd: project,
    env: {
      ...process.env,
      EFFIGY_ADMISSION_REQUEST: admissionRequest(runId, project),
      [QUEUE_ADMISSION_SOCKET_ENV]: admission.socketPath,
      [EFFIGY_ADMISSION_HOOK_TIMEOUT_ENV]: "3600000",
      FAKE_HOOK_COMMAND: admission.hookCommand,
      FAKE_CLOSURE: closureRecord(runId),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
}

/** One immutable executable fixture artifact: a copy of this node binary. */
function producerArtifact(root: string): { path: string; sha256: string } {
  const path = join(root, "effigy");
  copyNodeRuntime(path);
  chmodSync(path, 0o755);
  return { path, sha256: sha256(readFileSync(path)) };
}

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

interface LiveQueue { runtime: QueueRuntime; dataDir: string; hostRunStateDir: string }

async function liveQueue(
  t: { after: (fn: () => void | Promise<void>) => void },
  declaration: { path: string; sha256: string },
  dirs: { dataDir: string; hostRunStateDir: string },
): Promise<LiveQueue> {
  mkdirSync(dirs.dataDir, { recursive: true, mode: 0o700 });
  const runtime = new QueueRuntime({
    dataDir: dirs.dataDir, hostRunStateDir: dirs.hostRunStateDir, hostRunEndpoint: true, timers: false,
    adapterFactory: () => fakeAdapter(dirs.dataDir),
    settings: { daemonUrl: "ws://127.0.0.1:6767/ws" },
    effigyEnvironment: { ...process.env },
    // The producer artifact is a copy of node: asked by its real path, it answers as Effigy.
    effigyVersion: path => { try { return realpathSync(path) === realpathSync(declaration.path) ? parseEffigyVersion("effigy v0.14.1+local.test") : null; } catch { return null; } },
  });
  t.after(() => runtime.drain());
  await runtime.hostRunReady;
  return { runtime, ...dirs };
}

test("the real default admission route retires the accounting on the producer's cleanup and settles without custody", async t => {
  const root = mkdtempSync(join(tmpdir(), "q-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  // The observer's own answer: `run status <id> --json`, served by the declared
  // bytes from the reservation's checkout, reading the producer's closure record.
  writeFileSync(join(project, "run"), `process.stdout.write(require("node:fs").readFileSync("closure.json", "utf8"));\n`);
  const dirs = { dataDir: join(root, "data"), hostRunStateDir: join(root, "h") };
  const socketPath = hostRunAdmissionSocketPath(dirs.hostRunStateDir);
  const declaration = producerArtifact(root);
  const { runtime } = await liveQueue(t, declaration, dirs);
  fakeProducer(t, root, "route-run", project,
    { socketPath, hookCommand: defaultAdmissionHookCommand(), artifactPath: declaration.path });

  const id = admissionReservationId("route-run");
  const hookOut = () => {
    try { return readFileSync(join(project, "hook-out.txt"), "utf8").trim(); } catch { return "(no answer yet)"; }
  };
  await waitUntil(() => runtime.hostRuns.accountingStatus(id)?.accounting === "retired", 30_000,
    () => `the producer's closure retires the accounting (${JSON.stringify({
      state: runtime.hostRuns.get(id)?.state ?? null,
      hook: hookOut(),
      wants: runtime.store.hostRunJournal(id).map(row => row.event),
    })})`);
  const retirement = runtime.hostRuns.accountingStatus(id)!.disposition!;
  assert.equal(retirement.format, "queue.host-run.accounting-retirement");
  assert.equal(retirement.acceptance, null, "the automatic path invents no operator acceptance");
  assert.equal(retirement.producer.runId, "route-run");
  assert.equal(retirement.producer.selector, TASK);
  assert.equal(retirement.producer.evidenceSource, "checkout-journal");
  assert.equal(retirement.producer.cleanup, "complete");
  assert.equal(retirement.producer.state, "failed");
  assert.equal(retirement.producer.exitCode, 7);
  assert.equal(retirement.producer.signal, null);
  assert.equal(retirement.producer.runtimeSha256, declaration.sha256);

  const events = runtime.store.hostRunJournal(id).map(entry => entry.event);
  assert.equal(events.filter(event => event === "accounting_retirement").length, 1);
  assert.equal(events.filter(event => event === "effigy_observation").length, 1, "the producer record is kept as evidence");

  // The gone hook is the settlement's own question. The producer's verdict about
  // a workload Queue never supervised stays evidence: the settlement is the
  // pinned record's `lost`, with no result and no custody claim of its own.
  await waitUntil(() => runtime.hostRuns.get(id)?.state === "settled", 10_000,
    () => `the gone hook settles the reservation (${JSON.stringify(runtime.store.hostRunJournal(id).map(entry => entry.event))})`);
  const settledRow = runtime.hostRuns.get(id)!;
  const settledEvents = runtime.store.hostRunJournal(id).map(entry => entry.event);
  assert.equal(settledEvents.filter(event => event === "settlement").length, 1, "one host.run.settlement is written");
  assert.equal(settledEvents.filter(event => event === "hook_gone").length, 1, "one hook_gone fact names why");
  assert.equal(settledRow.settlement?.outcome, "lost");
  assert.equal(settledRow.settlement?.result, null, "no result is invented");
  assert.deepEqual(settledRow.settlement?.containers, []);
  assert.equal(settledRow.capacityReleasedAt, settledRow.settledAt, "the settlement records its own release");
  assert.equal(settledRow.escapedDescendantsProvenDeadAt, null);
  assert.deepEqual(settledRow.containers, []);
  assert.equal(facts({ store: runtime.store }, id, "accounting_retirement").length, 1, "the retirement record is not rewritten");
  assert.equal(runtime.hostRuns.summary().reservedCpu, 0, "the charge is gone");

  // The public route still answers the pinned contract 010 record.
  const listed = runtime.listHostRuns();
  assert.equal(hostRunList.output.safeParse(JSON.parse(JSON.stringify(listed))).success, true);
  for (const record of JSON.parse(JSON.stringify(listed)) as Record<string, unknown>[])
    assert.equal(frozenHostRunRecordSchema.safeParse(record).success, true);
  const view = runtime.hostRunAccountingStatus({ runId: id })!;
  assert.equal(view.accounting, "retired");
  assert.equal(view.runDigest, hostRunPublicDigest(runtime.hostRuns.get(id)!), "the digest names the row as it now stands");

  // A restarted service reattaches nothing and re-reads nothing duplicated.
  await runtime.drain();
  const restarted = await liveQueue(t, declaration, dirs);
  await pause(2_500);
  const afterRestart = restarted.runtime.store.hostRunJournal(id);
  assert.equal(afterRestart.filter(entry => entry.event === "accounting_retirement").length, 1, "no second retirement");
  assert.equal(afterRestart.filter(entry => entry.event === "effigy_observation").length, 1, "the evidence is retained, not duplicated");
  assert.equal(afterRestart.filter(entry => entry.event === "settlement").length, 1, "a settled row is settled once");
  assert.equal(restarted.runtime.hostRuns.accountingStatus(id)!.accounting, "retired");
});

test("the settlement #415 wrote is exactly what this path must not produce", t => {
  const h = harness(t);
  // The falsification is the real path, not source or docs: reproduce the
  // admission settlement task #415's observer wrote for a producer-closed run
  // and show the pinned contract accepted it, so schema validity could never
  // catch the fabrication. Only the new semantics do.
  const fabricated = launchedReservation(h, "closed-run");
  // The admission hook's own recorded pid, exactly what #415 used as `pgid`.
  h.scheduler.bindProcess(fabricated.id, { pid: 4242, processGroupId: 4242, startIdentity: "4242@2026-10-25T10:00:00Z" });
  const identified = h.scheduler.get(fabricated.id)!;
  const settlement = hostRunSettlementSchema.parse({
    format: "host.run.settlement", version: 1, runId: fabricated.id, outcome: "failed", launched: true,
    settledAt: "2026-10-25T10:00:02.500Z",
    result: hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId: fabricated.id, epoch: fabricated.epoch,
      // The admission hook's own recorded pid, presented as the run's group.
      pgid: identified.processGroupId!, startIdentity: identified.startIdentity!,
      exitCode: 7, signal: null,
      startedAt: identified.launchedAt!, endedAt: "2026-10-25T10:00:02.500Z", wallMs: 2_500, cpuMs: null,
      // Empty lists an admission never observed: custody Queue cannot prove.
      escapedDescendants: [],
    }),
    containers: [],
  });
  assert.equal(hostRunSettlementSchema.safeParse(settlement).success, true,
    "the pinned contract 010 schema accepts the fabricated settlement, so the assertion must be semantic");
  h.scheduler.settle(fabricated.id, settlement);
  const fabricatedRow = h.scheduler.get(fabricated.id)!;
  assert.equal(fabricatedRow.settlement !== null, true, "the old path really did settle the admission");
  assert.notEqual(fabricatedRow.capacityReleasedAt, null, "and really did release the slot on it");
  assert.equal(journalEvents(h, fabricated.id).includes("settlement"), true);

  const problems = retirementViolations(h, fabricated.id);
  assert.ok(problems.includes("the row carries a settlement"), "the new semantics reject the fabricated settlement");
  assert.ok(problems.includes("a settlement fact exists"));
  assert.ok(problems.includes("the accounting is not retired"), "an admission settlement never retires accounting");

  // The honest automatic path on an equivalent reservation satisfies the same
  // predicate and carries none of the fabricated fields.
  const honest = launchedReservation(h, "honest-run");
  h.scheduler.retireAccountingOnProducerCleanup({ runId: honest.id, producer: producerRecord({ runId: "honest-run" }) });
  assert.deepEqual(retirementViolations(h, honest.id), []);
  assert.equal(journalEvents(h, honest.id).includes("settlement"), false);
  const retirement = h.scheduler.accountingStatus(honest.id)!.disposition as Record<string, any>;
  assert.deepEqual(Object.keys(retirement).sort(), [
    "acceptance", "basis", "disposedAt", "disposition", "epoch", "expectedRunDigest", "format", "inputHash",
    "observed", "operationId", "policy", "producer", "reason", "runId", "version",
  ], "the retirement names no process group, start identity, container or escaped-descendant claim");
  assert.equal((h.scheduler.accountingStatus(honest.id)!.record as Record<string, unknown>).settlement, null,
    "the pinned record still says the outcome is unknown");
});

// Spec 035 "Retired runs on the board": the producer-cleanup basis carries the
// producer's own attributed verdict in the board's bulk read, never a pinned outcome.
test("the bulk accounting read carries the producer's attributed verdict for a cleanup retirement", t => {
  const h = harness(t);
  const run = launchedReservation(h, "closed-run");
  h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord() });
  // This read uses only hostRuns and markStoreAccess from the context.
  const read = (QueueRuntime.prototype.hostRunAccountingList as unknown as (this: unknown) => ReturnType<HostRunScheduler["accountingList"]>)
    .call({ repositories: new RuntimeRepositories({ markStoreAccess() {}, hostRuns: h.scheduler } as unknown as RepositoriesContext) });
  assert.equal(read.complete, true);
  assert.deepEqual(read.entries.map(entry => ({ ...entry, disposedAt: typeof entry.disposedAt })), [{
    runId: run.id, epoch: run.epoch, accounting: "retired", format: "queue.host-run.accounting-retirement", disposedAt: "string",
    producer: { verdict: "failed", state: "failed", exitCode: 7, signal: null },
  }]);
  assert.equal(h.scheduler.get(run.id)!.settlement, null, "no pinned outcome is written");
});

// Spec 035 "Retired runs age out, and dead foreground runs retire": the
// scheduler re-checks every binding of the absence evidence inside its own
// transaction, so evidence read before an await can never retire a row that
// moved, another run, another checkout or another runtime's answer.
test("foreground-absence retirement binds the evidence to the exact row and is idempotent", t => {
  const h = harness(t);
  const run = launchedReservation(h, "foreground-run");
  const hook = { pid: 5151, startIdentity: "5151@2026-10-25T10:00:00Z" };
  h.scheduler.bindProcess(run.id, { pid: hook.pid, processGroupId: hook.pid, startIdentity: hook.startIdentity });
  const absence = (overrides: Record<string, unknown> = {}) => ({
    runId: run.effigyRunId!, selector: run.selector, state: "not-found" as const, recording: "not-recorded" as const,
    message: "run `foreground-run`: not recorded (foreground or expired); no live holder or retained journal record was found",
    checkout: repository.path, runtimePath: RUNTIME_PATH, runtimeSha256: RUNTIME_SHA256, hook,
    observedAt: "2026-10-25T10:01:00.000Z", ...overrides,
  });
  const before = h.scheduler.summary().reservedCpu;
  const refusals: Array<[Record<string, unknown>, RegExp]> = [
    [{ runId: "another-run" }, /names run another-run/],
    [{ selector: "qa:stage:go" }, /names selector/],
    [{ checkout: "/repo/elsewhere" }, /not read in this reservation's own checkout/],
    [{ runtimeSha256: "b".repeat(64) }, /not read by this reservation's bound runtime bytes/],
    [{ hook: { pid: 5151, startIdentity: "5151@2026-10-25T11:00:00Z" } }, /another admission hook identity/],
  ];
  for (const [overrides, pattern] of refusals) {
    violation(() => h.scheduler.retireAccountingOnForegroundAbsence({ runId: run.id, absence: absence(overrides) as never }), pattern);
    assert.equal(h.scheduler.accountingStatus(run.id)!.accounting, "charged", "a refused binding retires nothing");
  }
  assert.equal(facts(h, run.id, "accounting_retirement").length, 0);
  assert.equal(h.scheduler.summary().reservedCpu, before, "the slot stays charged");

  const first = h.scheduler.retireAccountingOnForegroundAbsence({ runId: run.id, absence: absence() });
  assert.equal(first.kind, "retired");
  assert.equal(first.retirement.format, "queue.host-run.accounting-absence-retirement");
  const again = h.scheduler.retireAccountingOnForegroundAbsence({ runId: run.id, absence: absence({ observedAt: "2026-10-25T10:02:00.000Z" }) });
  assert.equal(again.kind, "already_retired", "a later tick or restart finds the durable retirement");
  assert.equal(facts(h, run.id, "accounting_retirement").length, 1, "one retirement, ever");
  assert.equal(h.scheduler.summary().reservedCpu, 0, "the charge stops");
  const row = h.scheduler.get(run.id)!;
  assert.equal(row.state, "running");
  assert.equal(row.settlement, null);
  assert.equal(row.capacityReleasedAt, null);
  // The producer-cleanup path and an operator disposition do not retire it twice.
  const producerAfter = h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord({ runId: run.effigyRunId!, selector: run.selector }) });
  assert.equal(producerAfter.kind, "already_retired");
  assert.equal(producerAfter.retirement.format, "queue.host-run.accounting-absence-retirement");
});
