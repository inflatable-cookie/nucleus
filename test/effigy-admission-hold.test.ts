/**
 * Spec 035 "A reservation settles when its recorded process is gone", "A
 * foreground run with no record" and "Producer closure": a launched admission
 * whose recorded hook is gone settles through the one ordinary path — the
 * pinned record's `lost`, custody unknown, no result invented — and the answer
 * its producer gave is kept as that settlement's evidence. A reservation the
 * producer still reports live, held or retained keeps its slot until its own
 * recorded run timeout, and that hold is never silent.
 *
 * The live shape (Project-E `b9d6328c`, 2026-10-24): a foreground `qa:stage` run
 * ends abnormally, the admission hook pid is gone, and `effigy run status
 * --json` answers `ok:false` with `details.state: "not-found"` and
 * `recording: "not-recorded"` — "not recorded (foreground or expired)". That is
 * an absence of evidence: it does not say the key expired, and it says nothing
 * about the workload. Queue used to read those bytes by text, call them
 * `expired`, and return without a word, so the slot was held with no cause on
 * the row. It now records that cause and, with the hook gone, settles the
 * reservation instead of holding it for a day.
 *
 * Every test here drives the real default endpoint and its own watch/reconcile
 * loop against a real observation client: the declared artifact is the node
 * binary running the tests, this process is the live bound workload image, and
 * the run's `run status` answer is a real child process reading a fixture in
 * the reservation's own project. The hook is either a real hook process or a
 * recorded pid with its contract 010 start identity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { HostRunScheduler, HOST_RUN_ABANDONED_RELEASE_REASON, type HostRunSchedulerOptions } from "../core/host-runs/host-run-scheduler";
import { EffigyAdmissionEndpoint, type EffigyAdmissionEndpointOptions } from "../service/callbacks/effigy-admission-endpoint";
import {
  EFFIGY_ADMISSION_HOOK_TIMEOUT_ENV,
  admissionReservationId,
  defaultAdmissionHookCommand,
  QUEUE_ADMISSION_SOCKET_ENV,
} from "../core/qa/effigy-admission";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";
import { hostRunPublicDigest } from "../core/host-runs/host-run-accounting";
import { parseEffigyVersion, type EffigyRuntimeAncestor, type EffigyRuntimeSettings } from "../core/qa/effigy-runtime";

const NODE_PATH = realpathSync(process.execPath);
const NODE_SHA256 = createHash("sha256").update(readFileSync(NODE_PATH)).digest("hex");
/** This build of node stands in for the workload's Effigy: asked by its real path, it answers as one. */
const SELF_EFFIGY = (path: string) => path === NODE_PATH ? parseEffigyVersion("effigy v0.14.1+local.test") : null;
const selfAncestry = (): EffigyRuntimeAncestor[] =>
  [{ pid: process.pid, startIdentity: hostRunProcessStartIdentity(process.pid) }];

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
    await pause(40);
  }
  throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
}

/**
 * The run's own `run status <id> --json` answer. Node is spawned as
 * `node run status <id> --json`, so the script is the reservation project's
 * `run` file and the run id arrives as `process.argv[3]` — exactly the route
 * `EffigyRunControl` takes, with no seam in the client.
 *
 * Each closed answer is the producer's shipped record (`effigy.command.v1`
 * around `effigy.run.v1`: `evidence_source`, `run_id`, `task`, `cleanup`,
 * numeric `signal`), so a test proves the fields Queue actually consumes.
 */
function runStatusFixture(project: string): void {
  writeFileSync(join(project, "run"), `
const closed = (id, extra) => ({
  status: 0,
  body: {
    schema: "effigy.command.v1", schema_version: 1, ok: true, warnings: [],
    result: { schema: "effigy.run.v1", schema_version: 1, run: {
      evidence_source: "checkout-journal", run_id: id, task: "qa:stage:rust", phase: "closed",
      cleanup: "complete", started_at_epoch_ms: 1700000000000,
      finished_at_epoch_ms: 1700000002500, duration_ms: 2500, ...extra,
    } },
  },
});
const notRecorded = id => ({
  schema: "effigy.command.v1", schema_version: 1, ok: false, result: null, warnings: [],
  binary: { name: "effigy", version: "0.14.1" }, command: { kind: "runs", name: "runs" },
  error: {
    kind: "RunnerError",
    message: \`run \\\`\${id}\\\`: not recorded (foreground or expired); no live holder or retained journal record was found\`,
    details: { schema: "effigy.run.v1", schema_version: 1, selector: id, state: "not-found", recording: "not-recorded" },
  },
});
const half = (details, message = "run x: lookup") => ({ schema: "effigy.command.v1", ok: false, result: null,
  error: { kind: "RunnerError", message, details } });
const answers = {
  "not-recorded": () => ({ status: 1, body: notRecorded(process.argv[3]) }),
  "not-recorded-expired-words": () => ({ status: 1, body: {
    schema: "effigy.command.v1", ok: false, result: null,
    error: { kind: "RunnerError", message: "run: expired key not recorded (foreground or expired)", details: { state: "not-found", recording: "not-recorded" } },
  } }),
  expired: () => ({ status: 1, body: {
    schema: "effigy.command.v1", ok: false, result: null,
    error: { kind: "RunnerError", message: "run: journal key aged out of retention", details: { state: "expired", recording: "retention-expired" } },
  } }),
  held: () => ({ status: 75, body: null, stderr: "task lock held: qa:stage:rust" }),
  live: () => ({ status: 0, body: {
    schema: "effigy.command.v1", ok: true, result: { schema: "effigy.run.v1", run: { state: "running", exit_code: null, phase: "starting" } },
  } }),
  "unreadable-journal": () => ({ status: 2, body: null, stderr: "unreadable journal" }),
  "foreign-group": () => ({ status: 1, body: half({ state: "not-found" }) }),
  "not-found-only": () => ({ status: 1, body: half({ state: "not-found" }) }),
  "not-recorded-only": () => ({ status: 1, body: half({ recording: "not-recorded" }) }),
  "custody-unavailable": () => ({ status: 1, body: half({ state: "unknown" }, "run x: outcome unknown, because runtime evidence cannot be verified (foreground custody unavailable)") }),
  "ambiguous-roots": () => ({ status: 1, body: half({ state: "unknown" }, "run x is ambiguous between /a and /b; run the query in its owning checkout") }),
  "live-foreground": () => ({
    status: 0,
    body: {
      schema: "effigy.command.v1", schema_version: 1, ok: true, warnings: [],
      result: { schema: "effigy.run.v1", schema_version: 1, run: {
        evidence_source: "live-foreground", run_id: process.argv[3], task: "qa:stage:rust",
        state: "unknown", exit_code: undefined, cleanup: undefined,
      } },
    },
  }),
  terminal: () => closed(process.argv[3], { state: "failed", exit_code: 7 }),
  passed: () => closed(process.argv[3], { state: "succeeded", exit_code: 0 }),
  "cleanup-incomplete": () => closed(process.argv[3], { state: "failed", exit_code: 7, cleanup: "incomplete" }),
  "cleanup-absent": () => closed(process.argv[3], { state: "failed", exit_code: 7, cleanup: undefined }),
  "cleanup-unknown": () => closed(process.argv[3], { state: "failed", exit_code: 7, cleanup: "pending" }),
  signal: () => closed(process.argv[3], { state: "cancelled", exit_code: 143, signal: 15 }),
  interrupted: () => closed(process.argv[3], { state: "interrupted", exit_code: 1 }),
  "interrupted-bare": () => closed(process.argv[3], { state: "interrupted", exit_code: undefined }),
  "interrupted-malformed": () => closed(process.argv[3], { state: "interrupted", exit_code: "1", signal: "SIGTERM" }),
  "not-started": () => closed(process.argv[3], { state: "not-started", exit_code: undefined }),
  "wrong-selector": () => closed(process.argv[3], { state: "failed", exit_code: 7, task: "qa:stage:go" }),
  "wrong-run-id": () => closed("some-other-run", { state: "failed", exit_code: 7 }),
  "wrong-evidence": () => closed(process.argv[3], { state: "failed", exit_code: 7, evidence_source: "host-run" }),
};
const answer = (answers[process.argv[3]] ?? answers["not-recorded"])();
if (answer.stderr) process.stderr.write(answer.stderr + "\\n");
if (answer.body) process.stdout.write(JSON.stringify(answer.body) + "\\n");
process.exit(answer.status);
`);
}

function isolatedScheduler(t: { after: (fn: () => void) => void }, options: HostRunSchedulerOptions = {}): HostRunScheduler {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return new HostRunScheduler(store, {
    capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] }),
    ...options,
  });
}

async function isolatedEndpoint(
  t: { after: (fn: () => void | Promise<void>) => void },
  scheduler: HostRunScheduler,
  options: EffigyAdmissionEndpointOptions = {},
): Promise<{ project: string; endpoint: EffigyAdmissionEndpoint }> {
  const root = mkdtempSync(join(tmpdir(), "qah-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  runStatusFixture(project);
  const endpoint = new EffigyAdmissionEndpoint(scheduler, {
    stateDir: join(root, "host-run"), watchMs: 20, effigyVersion: SELF_EFFIGY, ...options,
  });
  await endpoint.start();
  t.after(async () => { await endpoint.stop(); });
  return { project, endpoint };
}

/**
 * A reservation this endpoint admitted and launched, bound to the declared
 * bytes. `hook` binds the launcher's recorded pid before the first watch tick,
 * so a test sees exactly the hold it means to see.
 */
async function launchedReservation(
  endpoint: EffigyAdmissionEndpoint,
  scheduler: HostRunScheduler,
  project: string,
  runId: string,
  hook?: { pid: number; startIdentity: string },
): Promise<string> {
  const reserved = await endpoint.reserve(request(runId, project), selfAncestry());
  assert.ok(reserved.reservationId, `reservation accepted (${JSON.stringify(reserved.observation)})`);
  const id = reserved.reservationId!;
  assert.equal(scheduler.get(id)?.effigyRuntime?.sha256, NODE_SHA256, "the reservation was written already bound");
  if (hook) endpoint.bindHook(id, hook.pid, hook.startIdentity);
  await waitUntil(() => scheduler.get(id)?.state === "running", 4_000, () => `reservation launched (${scheduler.get(id)?.state})`);
  return id;
}

/** A pid this process started and reaped: alive to nobody, so "the hook died" is observed. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
  return pid;
}

const startIdentityFor = (pid: number) => `${pid}@1999-01-01T00:00:00Z`;

/** A dead hook that is not the workload's pid or process group. */
async function deadHook(): Promise<{ pid: number; startIdentity: string }> {
  const pid = await deadPid();
  return { pid, startIdentity: startIdentityFor(pid) };
}

/** A live, unrelated process (and its own process group) this test owns. */
function liveChild(t: { after: (fn: () => void) => void }): { pid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  return { pid: child.pid!, stop: async () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } await exited; } };
}

type JournalRow = { event: string; at: string; data: unknown };
type Note = {
  kind?: string;
  reason?: string;
  runtimeSha256?: string;
  runId?: string;
  selector?: string | null;
  evidenceSource?: string;
  cleanup?: string;
  state?: string;
  exitCode?: number | null;
  signal?: number | null;
  outcome?: string;
};

/** The settlement every abandoned reservation reaches: lost, released, identity named. */
function assertSettled(scheduler: HostRunScheduler, id: string, why: string): void {
  const record = scheduler.get(id)!;
  assert.equal(record.state, "settled", `${why}: the reservation settles`);
  assert.equal(record.settlement?.outcome, "lost", `${why}: the pinned settlement claims nothing about the workload`);
  assert.equal(record.settlement?.result, null, `${why}: no result is invented`);
  assert.deepEqual(record.settlement?.containers, [], `${why}: no container inventory is invented`);
  assert.equal(record.capacityReleasedAt, record.settledAt, `${why}: the settlement records its own release`);
  assert.equal(notes(scheduler, id, "settlement").length, 1, `${why}: one settlement fact`);
  const gone = scheduler.store.hostRunJournal(id)
    .filter((row: JournalRow) => row.event === "hook_gone")
    .map((row: JournalRow) => row.data as Record<string, any>);
  assert.equal(gone.length, 1, `${why}: one hook_gone fact`);
  assert.equal(gone[0].custody, "unknown", `${why}: custody stays unknown`);
}

const journalEvents = (scheduler: HostRunScheduler, id: string): string[] =>
  scheduler.store.hostRunJournal(id).map((row: JournalRow) => row.event);

const notes = (scheduler: HostRunScheduler, id: string, event: string): Note[] =>
  scheduler.store.hostRunJournal(id)
    .filter((row: JournalRow) => row.event === event)
    .map((row: JournalRow) => row.data as Note);

/** Nothing in this hold may settle, release, retire accounting or invent a result. */
function assertHeld(scheduler: HostRunScheduler, id: string, why: string): void {
  const record = scheduler.get(id)!;
  assert.equal(record.state, "running", `${why}: the row keeps running`);
  assert.equal(record.settlement, null, `${why}: no settlement is invented`);
  assert.equal(record.capacityReleasedAt, null, `${why}: the slot is still held`);
  assert.equal(scheduler.accountingStatus(id)!.accounting, "charged", `${why}: the accounting is still charged`);
  assert.deepEqual(notes(scheduler, id, "effigy_observation"), [], `${why}: no terminal observation`);
  assert.deepEqual(notes(scheduler, id, "settlement"), [], `${why}: no settlement fact`);
  assert.deepEqual(notes(scheduler, id, "accounting_retirement"), [], `${why}: no accounting retirement`);
}

/**
 * Spec 035 "Retired runs age out, and dead foreground runs retire" (Tom,
 * 2026-10-25: "Auto-free them (Recommended)") and "A reservation settles when
 * its recorded process is gone": the dead hook and the producer's absence
 * answer retire the row's ACCOUNTING, and the gone hook then settles the
 * reservation itself through the ordinary path. No result is invented, and the
 * absence retirement keeps its own record.
 */
function assertRetiredOnAbsence(scheduler: HostRunScheduler, id: string, project: string, hook: { pid: number; startIdentity: string }, why: string): void {
  const record = scheduler.get(id)!;
  assert.equal(record.state, "settled", `${why}: the reservation settles once its recorded process is gone`);
  assert.equal(record.settlement?.outcome, "lost", `${why}: no outcome is claimed for the workload`);
  assert.equal(record.settlement?.result, null, `${why}: no result is invented`);
  assert.equal(record.capacityReleasedAt, record.settledAt, `${why}: the settlement records its own release`);
  const status = scheduler.accountingStatus(id)!;
  assert.equal(status.accounting, "retired", `${why}: the accounting is retired`);
  assert.equal(status.disposition?.format, "queue.host-run.accounting-absence-retirement");
  const retirement = status.disposition as Extract<typeof status.disposition, { format: "queue.host-run.accounting-absence-retirement" }>;
  assert.equal(retirement.basis, "foreground_absent");
  assert.equal(retirement.acceptance, null, `${why}: no operator acceptance is fabricated`);
  assert.equal(retirement.policy.rule, "spec-035/automatic-accounting-on-foreground-absence");
  assert.deepEqual({ ...retirement.absence, message: "", observedAt: "" }, {
    runId: record.effigyRunId, selector: record.selector, state: "not-found", recording: "not-recorded", message: "",
    checkout: project, runtimePath: record.effigyRuntime!.path, runtimeSha256: NODE_SHA256, hook, observedAt: "",
  }, `${why}: the evidence names this run, its checkout, the bound bytes and the dead hook`);
  assert.equal(notes(scheduler, id, "accounting_retirement").length, 1, `${why}: one retirement fact`);
  assert.deepEqual(notes(scheduler, id, "effigy_observation"), [], `${why}: no producer closure is invented`);
  assert.equal(notes(scheduler, id, "settlement").length, 1, `${why}: one settlement fact`);
  assert.equal(scheduler.store.hostRunHoldingWorkspace(project), null, `${why}: the workspace hold is released`);
}

test("a dead hook on a run the producer holds no record of retires its accounting and settles the reservation", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const hook = await deadHook();
  const id = await launchedReservation(endpoint, scheduler, project, "not-recorded", hook);
  assert.equal(scheduler.get(id)?.processGroupId, hook.pid, "the recorded group is the hook pid, an assumption");

  await waitUntil(() => scheduler.get(id)?.state === "settled", 4_000,
    () => `the absence answer settles the reservation (${JSON.stringify(journalEvents(scheduler, id))})`);
  assertRetiredOnAbsence(scheduler, id, project, hook, "structured not-found + not-recorded");
  assert.match(scheduler.accountingStatus(id)!.disposition!.reason, /a stray process may survive/);

  await pause(250);
  assert.equal(notes(scheduler, id, "accounting_retirement").length, 1, "repeated ticks retire nothing again");
  assert.equal(notes(scheduler, id, "settlement").length, 1, "repeated ticks settle nothing again");
});

test("the word expired in the producer's message never outranks its not-recorded state", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const hook = await deadHook();
  const id = await launchedReservation(endpoint, scheduler, project, "not-recorded-expired-words", hook);
  await waitUntil(() => scheduler.get(id)?.state === "settled", 4_000, "the structured fields decide");
  assert.deepEqual(notes(scheduler, id, "effigy_observation_retained"), [], "never read as a retention expiry");
  assertRetiredOnAbsence(scheduler, id, project, hook, "a not-recorded state whose message mentions expiry");
});

test("a still-live run holds with its own recorded reason", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "live", await deadHook());
  await waitUntil(() => notes(scheduler, id, "effigy_observation_retained").length > 0, 4_000,
    () => `the live hold is recorded (${JSON.stringify(journalEvents(scheduler, id))})`);
  const retained = notes(scheduler, id, "effigy_observation_retained");
  assert.equal(retained.length, 1);
  assert.equal(retained[0].kind, "live");
  assert.match(retained[0].reason ?? "", /state "running"/);
  assert.match(retained[0].reason ?? "", /admission hook is gone/);
  assertHeld(scheduler, id, "a live run");
  await pause(250);
  assert.equal(notes(scheduler, id, "effigy_observation_retained").length, 1, "a repeated identical hold adds nothing");
});

test("a held task lock holds with its own recorded reason", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "held", await deadHook());
  await waitUntil(() => notes(scheduler, id, "effigy_observation_retained").length > 0, 4_000, "the held-lock hold is recorded");
  const retained = notes(scheduler, id, "effigy_observation_retained");
  assert.equal(retained.length, 1);
  assert.equal(retained[0].kind, "held-lock");
  assert.match(retained[0].reason ?? "", /task lock held/);
  assertHeld(scheduler, id, "a held task lock");
});

test("a genuine retention expiry holds with its own recorded reason", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "expired", await deadHook());
  await waitUntil(() => notes(scheduler, id, "effigy_observation_retained").length > 0, 4_000, "the expiry hold is recorded");
  const retained = notes(scheduler, id, "effigy_observation_retained");
  assert.equal(retained.length, 1);
  assert.equal(retained[0].kind, "expired");
  assert.match(retained[0].reason ?? "", /retention/);
  assertHeld(scheduler, id, "genuine retention expiry");
});

/**
 * Spec 035 "A reservation settles when its recorded process is gone": the watch
 * settles the row on the tick that proves its hook gone, not at the 24-hour run
 * timeout the reservation itself recorded. The 2026-11-09 rows (56 of them, each
 * a two-minute foreground run) are exactly this shape.
 */
test("a dead hook settles the reservation on the watch's own tick, not at its run timeout", async t => {
  let clockMs = Date.parse("2026-11-01T12:00:00.000Z");
  const scheduler = isolatedScheduler(t, { now: () => clockMs });
  const { project, endpoint } = await isolatedEndpoint(t, scheduler, { now: () => clockMs });
  const id = await launchedReservation(endpoint, scheduler, project, "not-recorded", await deadHook());
  assert.equal(scheduler.get(id)!.runTimeoutMs, 24 * 60 * 60_000, "the reservation records a whole day of its own");

  // No clock advance at all: the recorded process is gone, which is the whole
  // question, and the producer's absence answer retires the accounting.
  await waitUntil(() => scheduler.get(id)?.state === "settled", 4_000,
    () => `the gone hook settles the reservation (${JSON.stringify(journalEvents(scheduler, id))})`);

  const settled = scheduler.get(id)!;
  assert.equal(settled.settledAt, new Date(Date.parse("2026-11-01T12:00:00.000Z")).toISOString(),
    "it settles at the observation, not a day later");
  assert.equal(settled.settlement?.outcome, "lost", "the pinned settlement is the contract's own no-result outcome");
  assert.equal(settled.settlement?.result, null);
  assert.deepEqual(settled.settlement?.containers, []);
  assert.equal(settled.capacityReleaseReason, HOST_RUN_ABANDONED_RELEASE_REASON);
  const gone = notes(scheduler, id, "hook_gone") as Array<Record<string, any>>;
  assert.equal(gone.length, 1);
  assert.equal(gone[0].custody, "unknown");
  assert.equal(gone[0].reason, HOST_RUN_ABANDONED_RELEASE_REASON);
  assert.deepEqual(notes(scheduler, id, "expiry"), [], "the run timeout was never involved");
  await pause(250);
  assert.equal(notes(scheduler, id, "settlement").length, 1, "the watch stops; nothing settles twice");
});

test("an unreadable journal settles the reservation, with its refusal recorded once", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "unreadable-journal", await deadHook());
  await waitUntil(() => scheduler.get(id)?.state === "settled", 4_000, "the unobservable exit settles");
  assert.match(notes(scheduler, id, "effigy_observation_refused")[0].reason ?? "", /unreadable journal/);
  assertSettled(scheduler, id, "an unreadable journal");
  assert.equal(scheduler.accountingStatus(id)!.accounting, "charged",
    "an unreadable answer retires no accounting; only the settlement's own release is written");
});

test("hook liveness that cannot be proven is recorded, never guessed", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const hook = liveChild(t);
  const id = await launchedReservation(endpoint, scheduler, project, "unknown-liveness",
    { pid: hook.pid, startIdentity: `${hook.pid}@unknown` });
  await waitUntil(() => notes(scheduler, id, "effigy_observation_refused").some(note => note.kind === "hook-liveness-unknown"), 4_000,
    "the unknown liveness is recorded");
  assert.match(notes(scheduler, id, "effigy_observation_refused")[0].reason ?? "", /unreadable start identity/);
  assertHeld(scheduler, id, "unknown hook liveness");
});

test("a recorded process group is not workload custody, and is never signalled", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const hook = await deadHook();
  const id = await launchedReservation(endpoint, scheduler, project, "foreign-group", hook);
  // The recorded group is the hook pid, which nothing proved was a group leader
  // or held the workload. A reused or foreign pgid therefore proves nothing, and
  // the settlement neither signals it nor claims it as custody.
  const foreign = liveChild(t);
  scheduler.bindProcess(id, { pid: hook.pid, processGroupId: foreign.pid, startIdentity: hook.startIdentity });
  await waitUntil(() => scheduler.get(id)?.state === "settled", 4_000, "the gone hook settles the reservation");
  assert.equal(scheduler.get(id)?.processGroupId, foreign.pid);
  await pause(250);
  assert.doesNotThrow(() => process.kill(foreign.pid, 0), "Queue never signals a group it cannot prove is the workload's");
  assertSettled(scheduler, id, "a foreign recorded process group");
});

test("the producer's journal closure retires the accounting once and settles the reservation", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "terminal", await deadHook());
  const charged = scheduler.summary().reservedCpu;
  assert.ok(charged > 0, "the launched reservation is charged before the closure");
  await waitUntil(() => scheduler.get(id)?.state === "settled", 6_000,
    () => `the closure settles the reservation (${JSON.stringify(journalEvents(scheduler, id))})`);
  const settledRow = scheduler.get(id)!;
  // The producer's closure is evidence, not this reservation's Contract 010
  // result: the row settles `lost` and no result is invented.
  assert.equal(settledRow.settlement?.outcome, "lost", "the workload's outcome is never claimed");
  assert.equal(settledRow.settlement?.result, null, "no result is written");
  assert.equal(settledRow.escapedDescendantsProvenDeadAt, null, "no proven-dead claim is made");
  assert.deepEqual(settledRow.containers, [], "no container inventory is invented");
  assert.equal(notes(scheduler, id, "settlement").length, 1, "one settlement fact exists");
  assert.equal(scheduler.summary().reservedCpu, 0, "the settled reservation stops charging the slot");
  const [gone] = notes(scheduler, id, "hook_gone") as unknown as Array<Record<string, any>>;
  assert.equal(gone.custody, "unknown");
  assert.equal(gone.producer.runId, "terminal", "the producer's own result is kept beside the settlement");
  assert.equal(gone.producer.state, "failed");
  assert.equal(gone.producer.exitCode, 7);
  assert.equal(gone.producer.verdict, "failed");

  const observed = notes(scheduler, id, "effigy_observation");
  assert.equal(observed.length, 1, "the producer record is retained as this admission's evidence");
  assert.equal(observed[0].runId, "terminal");
  assert.equal(observed[0].selector, "qa:stage:rust");
  assert.equal(observed[0].evidenceSource, "checkout-journal");
  assert.equal(observed[0].cleanup, "complete");
  assert.equal(observed[0].exitCode, 7, "the producer's own exit code stays on the evidence");
  assert.equal(observed[0].signal, null, "no signal is invented for an exit code");
  assert.equal(observed[0].outcome, "failed");
  assert.equal(observed[0].runtimeSha256, NODE_SHA256, "the evidence names the exact bytes that answered");

  const retirements = notes(scheduler, id, "accounting_retirement") as unknown as Array<Record<string, any>>;
  assert.equal(retirements.length, 1, "one durable retirement fact");
  const retirement = retirements[0];
  assert.equal(retirement.disposition, "accounting_retired");
  assert.equal(retirement.basis, "producer_cleanup");
  assert.equal(retirement.acceptance, null, "the automatic path never fabricates an operator acceptance");
  assert.equal(retirement.producer.runId, "terminal");
  assert.equal(retirement.producer.selector, "qa:stage:rust");
  assert.equal(retirement.producer.evidenceSource, "checkout-journal");
  assert.equal(retirement.producer.cleanup, "complete");
  assert.equal(retirement.producer.state, "failed");
  assert.equal(retirement.producer.exitCode, 7);
  assert.equal(retirement.producer.signal, null);
  assert.equal(retirement.producer.verdict, "failed");
  assert.equal(retirement.producer.runtimeSha256, NODE_SHA256);
  assert.equal(retirement.policy.rule, "spec-035/automatic-accounting-on-producer-cleanup");
  assert.equal(retirement.policy.decidedOn, "2026-10-25");
  assert.match(retirement.operationId, /^producer-cleanup:[0-9a-f]{40}$/);
  assert.match(retirement.reason, /accounting and nothing else/);
  assert.match(retirement.reason, /outcome and runtime custody stay unknown/);
  assert.equal(notes(scheduler, id, "effigy_observation_retained").length, 0, "a retired closure records no hold");
  assert.equal(notes(scheduler, id, "effigy_observation_refused").length, 0);

  // Repeated ticks add nothing while this watcher lives.
  await pause(250);
  assert.equal(notes(scheduler, id, "accounting_retirement").length, 1, "repeated ticks add no second retirement");
  assert.equal(notes(scheduler, id, "effigy_observation").length, 1, "repeated ticks add no second observation");

  // A restarted service reattaches the row it left settled, re-reads nothing and
  // finds the retirement already durable: evidence kept, nothing retired twice.
  await endpoint.stop();
  const restarted = await isolatedEndpoint(t, scheduler);
  await pause(300);
  assert.equal(notes(scheduler, id, "accounting_retirement").length, 1, "a restarted watcher adds no second retirement");
  assert.equal(notes(scheduler, id, "effigy_observation").length, 1, "the retained producer evidence is not duplicated");
  assert.equal(notes(scheduler, id, "settlement").length, 1, "a settled row is settled once");
  assert.equal(scheduler.accountingStatus(id)!.accounting, "retired");
  assert.equal(scheduler.summary().reservedCpu, 0);
  await restarted.endpoint.stop();
});

test("a passed workload's own verdict is retained, never laundered into the settlement", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "passed", await deadHook());
  await waitUntil(() => scheduler.get(id)?.state === "settled", 6_000,
    () => `the closure settles the reservation (${JSON.stringify(journalEvents(scheduler, id))})`);
  const retirement = notes(scheduler, id, "accounting_retirement")[0] as unknown as Record<string, any>;
  assert.equal(retirement.producer.state, "succeeded");
  assert.equal(retirement.producer.exitCode, 0);
  assert.equal(retirement.producer.signal, null);
  assert.equal(retirement.producer.verdict, "passed");
  const [gone] = notes(scheduler, id, "hook_gone") as unknown as Array<Record<string, any>>;
  assert.equal(gone.producer.verdict, "passed", "the producer's verdict travels as evidence");
  assert.equal(scheduler.get(id)!.settlement?.outcome, "lost",
    "a passed workload's producer verdict never becomes Queue's own settlement outcome");
});

test("a producer-reported numeric signal is retained as evidence, never defaulted", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "signal", await deadHook());
  await waitUntil(() => scheduler.accountingStatus(id)?.accounting === "retired", 6_000,
    () => `the closure retires the accounting (${JSON.stringify(journalEvents(scheduler, id))})`);
  const observed = notes(scheduler, id, "effigy_observation")[0];
  assert.equal(observed.signal, 15, "the producer's own number stays on the evidence");
  assert.equal(observed.exitCode, 143, "the producer's own exit code stays beside it");
  assert.equal(observed.outcome, "failed", "a signalled workload never passes");
  const retirement = notes(scheduler, id, "accounting_retirement")[0] as unknown as Record<string, any>;
  assert.equal(retirement.producer.signal, 15);
  assert.equal(retirement.producer.state, "cancelled");
  assert.equal(retirement.producer.verdict, "failed");
});

test("a failed retirement write is named on the row, and the reservation still settles once", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const original = scheduler.store.setMeta.bind(scheduler.store);
  const target = scheduler.store as unknown as { setMeta: (key: string, value: unknown) => void };
  target.setMeta = (key, value) => {
    if (key.startsWith("hostRunAccountingDisposition:")) throw new Error("simulated durable write failure");
    original(key, value);
  };
  const id = await launchedReservation(endpoint, scheduler, project, "terminal", await deadHook());
  await waitUntil(() => scheduler.get(id)?.state === "settled", 6_000,
    () => `the failed retirement is recorded and the row settles (${JSON.stringify(journalEvents(scheduler, id))})`);
  const refusal = notes(scheduler, id, "effigy_observation_refused").find(note => note.kind === "accounting-retirement-refused")!;
  assert.match(refusal.reason ?? "", /simulated durable write failure/);
  assert.match(refusal.reason ?? "", /nothing was retired/);
  assert.equal(scheduler.accountingStatus(id)!.accounting, "charged", "a failed write retires nothing");
  assert.deepEqual(notes(scheduler, id, "accounting_retirement"), [], "no retirement fact exists");
  assert.equal(notes(scheduler, id, "effigy_observation").length, 1, "the producer record is still retained");
  // The gone hook is the settlement's question, not the failed accounting write:
  // the reservation reaches its terminal state and its own release once.
  assertSettled(scheduler, id, "a failed retirement write");
  await pause(250);
  assert.equal(notes(scheduler, id, "settlement").length, 1, "nothing settles twice");
});

test("a reservation an operator already retired records the producer's closure and settles without retiring it again", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "terminal", await deadHook());
  const digest = hostRunPublicDigest(scheduler.get(id)!);
  scheduler.disposeAccounting({
    runId: id, operationId: `operator-${id}`, expectedEpoch: 1, expectedRunDigest: digest,
    authority: { caller: "operator (board)" },
    acceptance: { scope: "exact_run", runId: id, epoch: 1, unknownOutcomeRetained: true,
      reason: "retire this reservation's accounting; its outcome and custody stay unknown" },
    reason: "operator retires the unknown reservation's accounting",
  });
  assert.equal(scheduler.accountingStatus(id)!.accounting, "retired");
  await waitUntil(() => scheduler.get(id)?.state === "settled", 6_000,
    () => `the producer closure is recorded and the row settles (${JSON.stringify(journalEvents(scheduler, id))})`);
  await pause(200);
  assert.equal(notes(scheduler, id, "effigy_observation").length, 1, "the producer closure is kept as evidence");
  assert.deepEqual(notes(scheduler, id, "accounting_retirement"), [], "the automatic path adds no second retirement");
  const disposition = scheduler.accountingStatus(id)!.disposition as Record<string, any>;
  assert.equal(disposition.format, "queue.host-run.accounting-disposition", "the operator's own record still stands");
  assertSettled(scheduler, id, "an operator-retired reservation");
});

/** A run whose producer record does not close it holds, with its own visible cause. */
async function assertUnclosedHolds(t: { after: (fn: () => void | Promise<void>) => void }, runId: string, cause: string, reason: RegExp): Promise<void> {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, runId, await deadHook());
  await waitUntil(() => notes(scheduler, id, "effigy_observation_retained").length > 0, 4_000,
    () => `the unclosed record is recorded (${JSON.stringify(journalEvents(scheduler, id))})`);
  const retained = notes(scheduler, id, "effigy_observation_retained");
  assert.equal(retained.length, 1, "one note for the one observed cause");
  assert.equal(retained[0].kind, cause);
  assert.match(retained[0].reason ?? "", reason);
  assertHeld(scheduler, id, runId);
  await pause(250);
  assert.equal(notes(scheduler, id, "effigy_observation_retained").length, 1, "repeated identical ticks add nothing");
}

test("cleanup incomplete holds the reservation with its own cause", async t => {
  await assertUnclosedHolds(t, "cleanup-incomplete", "cleanup-incomplete", /cleanup incomplete/);
});

test("an absent cleanup field holds: a terminal exit is never closure by itself", async t => {
  await assertUnclosedHolds(t, "cleanup-absent", "cleanup-absent", /no cleanup field/);
});

test("an unrecognised cleanup value holds instead of being read as complete", async t => {
  await assertUnclosedHolds(t, "cleanup-unknown", "cleanup-unknown", /only a reported complete cleanup/);
});

test("live-foreground evidence holds: a foreground run keeps no durable closure", async t => {
  await assertUnclosedHolds(t, "live-foreground", "live-foreground", /live foreground custody/);
});

test("a closed run for another selector holds: a run of another task never closes this one", async t => {
  await assertUnclosedHolds(t, "wrong-selector", "selector-mismatch", /other task never closes/);
});

test("a record naming another run id holds: a reused key never closes this reservation", async t => {
  await assertUnclosedHolds(t, "wrong-run-id", "run-id-mismatch", /reused key/);
});

test("a record without checkout-journal evidence holds", async t => {
  await assertUnclosedHolds(t, "wrong-evidence", "not-journal-backed", /did not report a checkout-journal record/);
});

test("a closed run that never started holds: it has no workload verdict", async t => {
  await assertUnclosedHolds(t, "not-started", "verdict-unknown", /not a workload verdict/);
});

test("an interrupted run with cleanup complete retires its accounting as failed (Tom, 2026-10-27)", async t => {
  for (const answer of ["interrupted", "interrupted-bare"]) {
    const scheduler = isolatedScheduler(t);
    const { project, endpoint } = await isolatedEndpoint(t, scheduler);
    const id = await launchedReservation(endpoint, scheduler, project, answer, await deadHook());
    await waitUntil(() => scheduler.get(id)?.state === "settled", 6_000,
      () => `the interrupted closure settles the reservation (${JSON.stringify(journalEvents(scheduler, id))})`);
    assertSettled(scheduler, id, `an ${answer} closure`);
    assert.deepEqual(notes(scheduler, id, "effigy_observation_retained"), [], "nothing is held");
    const retirement = notes(scheduler, id, "accounting_retirement")[0] as unknown as Record<string, any>;
    assert.equal(retirement.producer.state, "interrupted");
    assert.equal(retirement.producer.verdict, "failed", "an interrupted run never passes");
    assert.equal(retirement.producer.exitCode, answer === "interrupted" ? 1 : null, "only the producer's own code is kept");
    assert.equal(retirement.producer.signal, null);
  }
});

test("an interrupted run whose exit or signal evidence is malformed holds instead of retiring accounting", async t => {
  // Review 5664858628: the malformed values are not absent ones, so this record
  // is not the bare `interrupted` closure Tom's ruling retires on.
  await assertUnclosedHolds(t, "interrupted-malformed", "verdict-unknown", /exit code "1" \(string\) and signal "SIGTERM" \(string\).*interrupted-malformed.*cannot carry as the producer's own verdict/);
});

test("a real hook's death on a run the producer holds no record of retires its accounting", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const runId = "real-hook-run";
  // The real default hook command, launched the way Effigy launches it (`sh -c`)
  // in the invocation cwd. Its attested ancestry includes this process, which
  // runs the declared bytes.
  const hook = spawn("/bin/sh", ["-c", defaultAdmissionHookCommand()], {
    cwd: project,
    env: {
      ...process.env,
      EFFIGY_ADMISSION_REQUEST: JSON.stringify(request(runId, project)),
      [QUEUE_ADMISSION_SOCKET_ENV]: endpoint.socketPath,
      [EFFIGY_ADMISSION_HOOK_TIMEOUT_ENV]: "3600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { try { hook.kill("SIGKILL"); } catch { /* already gone */ } });
  let stdout = "";
  let stderr = "";
  hook.stdout?.setEncoding("utf8");
  hook.stderr?.setEncoding("utf8");
  hook.stdout?.on("data", chunk => { stdout += chunk; });
  hook.stderr?.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<void>(resolve => hook.once("exit", () => resolve()));

  const id = admissionReservationId(runId);
  await waitUntil(() => /(^|\n)admit\n/.test(stdout), 20_000,
    () => `the real hook admitted (stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)})`);
  await waitUntil(() => scheduler.get(id)?.state === "running", 4_000, "the admitted reservation launched");
  const hookPid = scheduler.get(id)?.pid;
  assert.ok(hookPid, "the hook bound its own pid");
  assert.notEqual(hookPid, process.pid, "the hook pid is not the workload's pid");

  // Effigy closes the run by ending the hook. A foreground run keeps no journal
  // row, so the only answer left is not-recorded.
  hook.kill("SIGTERM");
  await exited;
  const bound = { pid: scheduler.get(id)!.pid!, startIdentity: scheduler.get(id)!.startIdentity! };
  await waitUntil(() => scheduler.accountingStatus(id)?.accounting === "retired", 6_000,
    () => `the dead hook's run retires on the absence answer (${JSON.stringify(journalEvents(scheduler, id))})`);
  assertRetiredOnAbsence(scheduler, id, project, bound, "a real hook's death on a foreground run with no record");
});

test("a hook that never bound leaves its liveness unproven and visible on the row", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "no-hook-bind");
  await waitUntil(() => notes(scheduler, id, "effigy_observation_refused").some(note => note.kind === "hook-liveness-unknown"), 4_000,
    "the unbound hook is recorded");
  assert.match(notes(scheduler, id, "effigy_observation_refused")[0].reason ?? "", /not bound yet/);
  assertHeld(scheduler, id, "an unbound hook");
});

test("a reused hook pid is a dead hook: the absence answer retires accounting, and the live process is never touched", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const reused = liveChild(t);
  // A live pid carrying a different start identity: the recorded hook is dead
  // and the pid now belongs to another process.
  const id = await launchedReservation(endpoint, scheduler, project, "reused-hook-pid",
    { pid: reused.pid, startIdentity: startIdentityFor(reused.pid) });
  await waitUntil(() => scheduler.accountingStatus(id)?.accounting === "retired", 4_000, "the reused pid is treated as a dead hook");
  assertRetiredOnAbsence(scheduler, id, project, { pid: reused.pid, startIdentity: startIdentityFor(reused.pid) }, "a reused hook pid");
  assert.doesNotThrow(() => process.kill(reused.pid, 0), "the unrelated live process is never signalled");
  await reused.stop();
});

// Only BOTH structured fields, from the bound bytes in the reservation's own
// checkout, with the hook dead, retire the accounting. Every weaker or
// contradicting answer records its own refusal and settles the reservation
// `lost`: none of them is a terminal result Queue can claim.
for (const [runId, why] of [
  ["not-found-only", "state not-found without recording not-recorded"],
  ["not-recorded-only", "recording not-recorded without state not-found"],
  ["custody-unavailable", "the producer's foreground custody inventory is unavailable"],
  ["ambiguous-roots", "the producer's inventory is ambiguous between checkouts"],
] as const) {
  test(`a dead hook settles when ${why}`, async t => {
    const scheduler = isolatedScheduler(t);
    const { project, endpoint } = await isolatedEndpoint(t, scheduler);
    const id = await launchedReservation(endpoint, scheduler, project, runId, await deadHook());
    await waitUntil(() => scheduler.get(id)?.state === "settled", 4_000, "the unobservable answer settles");
    assert.equal(notes(scheduler, id, "effigy_observation_refused")[0].kind, "unknown");
    await pause(150);
    assertSettled(scheduler, id, why);
    assert.equal(scheduler.accountingStatus(id)!.accounting, "charged",
      `${why}: an answer that is not an absence retires no accounting`);
  });
}

test("a dead hook holds while the producer still reports a live foreground holder (its sentinel keeps the gate)", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const id = await launchedReservation(endpoint, scheduler, project, "live-foreground", await deadHook());
  await waitUntil(() => notes(scheduler, id, "effigy_observation_retained").length > 0, 4_000, "the live holder is recorded");
  await pause(150);
  assertHeld(scheduler, id, "a live foreground holder with the hook gone");
});

test("a live hook is never retired on the absence answer", async t => {
  const scheduler = isolatedScheduler(t);
  const { project, endpoint } = await isolatedEndpoint(t, scheduler);
  const live = liveChild(t);
  const { hostRunProcessStartIdentity } = await import("../core/machine/start-identity");
  const id = await launchedReservation(endpoint, scheduler, project, "not-recorded", { pid: live.pid, startIdentity: hostRunProcessStartIdentity(live.pid) });
  await pause(300);
  assertHeld(scheduler, id, "a live hook");
  assert.deepEqual(notes(scheduler, id, "effigy_observation_refused"), [], "a live hook is not even observed");
});
