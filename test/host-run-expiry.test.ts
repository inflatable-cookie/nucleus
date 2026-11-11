/**
 * Spec 035 "A reservation settles when its recorded process is gone": a
 * foreground admission reservation is held by its own admission hook for the
 * whole run, so the hook's absence is the end of that foreground. The ordinary
 * sweep settles such a reservation `lost` — custody unknown, no result invented
 * — instead of leaving it `running` until something else notices.
 *
 * Two shapes reach it. A row whose producer already closed its accounting (the
 * 2026-11-08 rows: a two-minute run retired its charge and then sat `running`
 * for the whole 24-hour run timeout) settles on the sweep's own evidence. A row
 * the producer still reports live, held or retained keeps its hold until its
 * recorded run timeout, the deadline Queue itself owns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../core/store/store";
import {
  HOST_RUN_ABANDONED_RELEASE_REASON,
  HOST_RUN_EXPIRED_RELEASE_REASON,
  HostRunScheduler,
  type HostRunSchedulerOptions,
  type HostRunSubmission,
} from "../core/host-runs/host-run-scheduler";
import type { HostRunInternalRecord } from "../shared/contracts";

const RUN_TIMEOUT_MS = 60_000;
/** The launch instant every row in this file records: the clock starts here. */
const LAUNCHED_AT = "2026-11-01T12:00:00.000Z";
const LAUNCHED_MS = Date.parse(LAUNCHED_AT);
const HOOK = { pid: 4242, processGroupId: 4242, startIdentity: "4242@2026-11-01T11:00:00Z" };
const repository = { origin: "https://github.com/example/expiry", path: "/repo/expiry" };
const capacity = () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });
const singleCpu = () => ({ ...capacity(), cpuCapacity: 1 });

/** A launched admission reservation as the endpoint writes it: runtime-bound, hook identified. */
const admission = (id: string, overrides: Partial<HostRunSubmission> = {}): HostRunSubmission => ({
  id, epoch: 1, caller: "queue:effigy-admission", repository, selector: "qa:stage:rust", runClass: "heavy",
  classSource: "manifest", priority: "interactive", runTimeoutMs: RUN_TIMEOUT_MS,
  submissionSource: "admission", effigyRunId: `run-${id}`,
  effigyRuntimeBinding: {
    kind: "bound", identity: { path: "/fixture/effigy", sha256: "a".repeat(64) }, version: "0.14.1",
    workloadPath: "/fixture/effigy", workloadPid: 900, workloadStartIdentity: "900@2026-11-01T11:00:00Z",
  },
  ...overrides,
});

const launchHandler = (scheduler: HostRunScheduler, launched: string[] = []) => ({
  launch: (run: HostRunInternalRecord) => { scheduler.markLaunched(run.id); launched.push(run.id); },
});

interface Harness {
  store: Store;
  scheduler: HostRunScheduler;
  /** Advance the scheduler's clock; timers are not involved, `tick()` is the driver. */
  time: (ms: number) => void;
}

function harness(t: { after: (fn: () => void) => void }, options: HostRunSchedulerOptions = {}): Harness {
  const store = new Store(":memory:");
  let nowMs = LAUNCHED_MS;
  const schedulerOptions: HostRunSchedulerOptions = { capacity, hookAlive: () => false, ...options, now: () => nowMs };
  const scheduler = new HostRunScheduler(store, schedulerOptions);
  t.after(() => { scheduler.stop(); store.close(); });
  return { store, scheduler, time: (ms: number) => { nowMs += ms; } };
}

function launched(scheduler: HostRunScheduler, submission: HostRunSubmission): HostRunInternalRecord {
  scheduler.submit(submission, launchHandler(scheduler));
  scheduler.bindProcess(submission.id, HOOK);
  const run = scheduler.get(submission.id)!;
  assert.equal(run.state, "running", `${submission.id} launched`);
  return run;
}

const facts = (h: Harness, id: string, event: string) =>
  h.store.hostRunJournal(id).filter(row => row.event === event).map(row => row.data as Record<string, any>);

/** The producer's own terminal answer for one reservation, as its bound runtime reported it. */
const producerRecord = (run: HostRunInternalRecord) => ({
  runId: run.effigyRunId!, selector: run.selector, evidenceSource: "checkout-journal" as const,
  cleanup: "complete" as const, state: "succeeded", exitCode: 0, signal: null,
  startedAt: LAUNCHED_AT, endedAt: new Date(LAUNCHED_MS + 125_000).toISOString(), durationMs: 125_000,
  runtimePath: run.effigyRuntime!.path, runtimeSha256: run.effigyRuntime!.sha256,
  verdict: "passed" as const, observedAt: LAUNCHED_AT,
});

test("a reservation whose producer closed the accounting settles on the next sweep, not its run timeout", t => {
  const h = harness(t);
  const run = launched(h.scheduler, admission("producer-closed"));
  assert.equal(h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord(run) }).kind, "retired");
  const stored = h.store.hostRunAccountingDispositionRaw(run.id);

  // No clock advance at all: the recorded hook is gone and the producer's own
  // record already closed the charge, so nothing is left to wait for.
  h.scheduler.tick();

  const settled = h.scheduler.get(run.id)!;
  assert.equal(settled.state, "settled", "the ordinary sweep settles it on the first pass");
  assert.equal(settled.settledAt, new Date(LAUNCHED_MS).toISOString());
  // The pinned settlement is the contract's own "no terminal record": the
  // producer's verdict about a workload Queue never supervised is not one.
  assert.equal(settled.settlement?.outcome, "lost");
  assert.equal(settled.settlement?.result, null);
  assert.deepEqual(settled.settlement?.containers, []);
  assert.equal(settled.capacityReleasedAt, settled.settledAt, "the settlement records its own release");
  assert.equal(settled.capacityReleaseReason, HOST_RUN_ABANDONED_RELEASE_REASON);
  assert.deepEqual(h.store.hostRunAccountingDispositionRaw(run.id), stored, "the retirement record is not rewritten");
  assert.equal(facts(h, run.id, "accounting_retirement").length, 1, "no second retirement");

  const [gone] = facts(h, run.id, "hook_gone");
  assert.equal(gone.reason, HOST_RUN_ABANDONED_RELEASE_REASON);
  assert.equal(gone.outcome, "lost");
  assert.equal(gone.custody, "unknown");
  assert.deepEqual(gone.hook, { pid: HOOK.pid, startIdentity: HOOK.startIdentity });
  assert.deepEqual(gone.producer, {
    runId: run.effigyRunId, state: "succeeded", exitCode: 0, signal: null, cleanup: "complete",
    startedAt: LAUNCHED_AT, endedAt: new Date(LAUNCHED_MS + 125_000).toISOString(), verdict: "passed",
  }, "the producer's own result is kept as evidence beside the settlement");
  assert.deepEqual(facts(h, run.id, "expiry"), [], "the run timeout was never involved");
  assert.equal(h.store.hostRunCapacityCandidates().some(item => item.id === run.id), false, "it leaves the candidate set");
});

test("a producer-closed reservation left running when the service stopped settles on the next startup", t => {
  const store = new Store(":memory:");
  let nowMs = LAUNCHED_MS;
  const start = () => new HostRunScheduler(store, { capacity, hookAlive: () => false, now: () => nowMs });
  const first = start();
  t.after(() => { first.stop(); store.close(); });
  first.submit(admission("restarted"), launchHandler(first));
  first.bindProcess("restarted", HOOK);
  const run = first.get("restarted")!;
  assert.equal(run.state, "running");
  first.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord(run) });
  first.stop();
  assert.equal(store.hostRun(run.id)!.state, "running", "the old process left it exactly as it found it");

  // The replacement process's first sweep is the restart path: no submission
  // file, no watch and no special case, just the stored row and its identity.
  const replacement = start();
  t.after(() => replacement.stop());
  replacement.tick();

  const settled = replacement.get(run.id)!;
  assert.equal(settled.state, "settled");
  assert.equal(settled.settlement?.outcome, "lost");
  assert.equal(settled.capacityReleaseReason, HOST_RUN_ABANDONED_RELEASE_REASON);
  assert.equal(store.hostRunJournal(run.id).filter(row => row.event === "hook_gone").length, 1, "the restart settles it once");
});

test("a live hook keeps the reservation even with its accounting already retired", t => {
  const h = harness(t, { hookAlive: () => true, hookStartIdentity: () => HOOK.startIdentity });
  const run = launched(h.scheduler, admission("retired-live"));
  h.scheduler.retireAccountingOnProducerCleanup({ runId: run.id, producer: producerRecord(run) });

  h.scheduler.tick();

  assert.equal(h.scheduler.get(run.id)!.state, "running", "a live foreground is never settled by the sweep");
  assert.equal(h.scheduler.get(run.id)!.settlement, null);
});

test("an overdue admission reservation with a dead hook settles as expired, custody unknown", t => {
  const h = harness(t);
  const run = launched(h.scheduler, admission("arun"));
  assert.equal(run.launchedAt, LAUNCHED_AT);

  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();

  const settled = h.scheduler.get(run.id)!;
  assert.equal(settled.state, "settled", "the ordinary sweep settles it");
  assert.equal(settled.settledAt, new Date(LAUNCHED_MS + RUN_TIMEOUT_MS + 1).toISOString());
  // The pinned settlement is the contract's own "no terminal record": launched,
  // no result, no container or descendant claim. Hook absence never proves the
  // workload died, so nothing here asserts an outcome.
  assert.deepEqual(settled.settlement, {
    format: "host.run.settlement", version: 1, runId: run.id, outcome: "lost", launched: true,
    settledAt: settled.settledAt, result: null, containers: [],
  });
  assert.equal(settled.wallMs, null);
  assert.equal(settled.cpuMs, null);
  assert.equal(settled.capacityReleasedAt, settled.settledAt, "the slot is released by the settlement");
  assert.equal(settled.capacityReleaseReason, HOST_RUN_EXPIRED_RELEASE_REASON);
  assert.equal(settled.capacityReleaseKind, "automatic");

  const [expiry] = facts(h, run.id, "expiry");
  assert.equal(expiry.reason, HOST_RUN_EXPIRED_RELEASE_REASON);
  assert.equal(expiry.outcome, "lost");
  assert.equal(expiry.custody, "unknown");
  assert.equal(expiry.launchedAt, LAUNCHED_AT);
  assert.equal(expiry.runTimeoutMs, RUN_TIMEOUT_MS);
  assert.deepEqual(expiry.hook, { pid: HOOK.pid, startIdentity: HOOK.startIdentity });
  assert.equal(facts(h, run.id, "settlement").length, 1, "one settlement fact");
  assert.equal(facts(h, run.id, "capacity_release").length, 1, "one release fact");

  assert.equal(h.scheduler.liveRuns().some(item => item.id === run.id), false, "the live set drops it");
  assert.equal(h.store.hostRunCapacityCandidates().some(item => item.id === run.id), false,
    "capacity candidates no longer include the settled-expired record");
  assert.equal(h.scheduler.summary().reservedCpu, 0, "the charge is gone");
  assert.equal(h.scheduler.list().some(item => item.id === run.id), true, "it stays in history");
});

test("inside its own run timeout the reservation is untouched, even with the hook already gone", t => {
  const h = harness(t);
  const run = launched(h.scheduler, admission("early"));

  h.time(RUN_TIMEOUT_MS - 1);
  h.scheduler.tick();
  h.scheduler.tick();

  const held = h.scheduler.get(run.id)!;
  assert.equal(held.state, "running");
  assert.equal(held.settlement, null);
  assert.equal(held.capacityReleasedAt, null);
  assert.deepEqual(facts(h, run.id, "expiry"), [], "the deadline is the run's own timeout");
  assert.deepEqual(facts(h, run.id, "settlement"), []);
  assert.equal(h.store.hostRunCapacityCandidates().some(item => item.id === run.id), true,
    "it still reserves its capacity");
  assert.equal(h.scheduler.summary().reservedCpu > 0, true);
});

test("a live hook past the timeout keeps the reservation until it is gone", t => {
  let alive = true;
  const h = harness(t, { hookAlive: () => alive, hookStartIdentity: () => HOOK.startIdentity });
  const run = launched(h.scheduler, admission("held"));

  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();
  assert.equal(h.scheduler.get(run.id)!.state, "running", "a live holder is never expired");
  assert.equal(h.scheduler.get(run.id)!.settlement, null);

  alive = false;
  h.scheduler.tick();
  assert.equal(h.scheduler.get(run.id)!.state, "settled", "the clock alone did not settle it; the dead hook did");
  assert.equal(h.scheduler.get(run.id)!.settlement?.outcome, "lost");
});

test("a live pid carrying another start identity is a gone hook", t => {
  const h = harness(t, { hookAlive: () => true, hookStartIdentity: () => "4242@2026-11-01T11:30:00Z" });
  const run = launched(h.scheduler, admission("reused"));

  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();

  assert.equal(h.scheduler.get(run.id)!.state, "settled", "a reused pid number is not this hook");
  assert.equal(h.scheduler.get(run.id)!.settlement?.outcome, "lost");
});

test("an unprovable live identity never reads as absence", t => {
  const unreadable = harness(t, { hookAlive: () => true, hookStartIdentity: () => "4242@unknown" });
  const run = launched(unreadable.scheduler, admission("unreadable"));
  unreadable.time(RUN_TIMEOUT_MS + 1);
  unreadable.scheduler.tick();

  assert.equal(unreadable.scheduler.get(run.id)!.state, "running", "an unreadable live identity holds");
  assert.deepEqual(facts(unreadable, run.id, "expiry"), []);
  assert.equal(unreadable.scheduler.get(run.id)!.capacityReleasedAt, null);
});

test("an admission reservation with no recorded hook identity holds", t => {
  const h = harness(t, { hookAlive: () => true });
  const submission = admission("unbound");
  h.scheduler.submit(submission, launchHandler(h.scheduler));
  const run = h.scheduler.get(submission.id)!;
  assert.equal(run.pid, null, "nothing recorded to prove gone or alive");

  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();

  assert.equal(h.scheduler.get(run.id)!.state, "running");
  assert.deepEqual(facts(h, run.id, "expiry"), []);
});

test("an already-released reservation keeps its original release reason", t => {
  const h = harness(t);
  const run = launched(h.scheduler, admission("released"));
  h.scheduler.reportContainerFact({ factId: "fact-1", observedAt: LAUNCHED_AT, runId: run.id, epoch: 1,
    runtime: "docker", containerId: "c-1", event: "started" });
  h.scheduler.reportContainerFact({ factId: "fact-2", observedAt: LAUNCHED_AT, runId: run.id, epoch: 1,
    runtime: "docker", containerId: "c-1", event: "removed", removed: true });
  const before = h.scheduler.get(run.id)!;
  assert.equal(before.capacityReleaseReason, "runtime reported all containers removed");

  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();

  const settled = h.scheduler.get(run.id)!;
  assert.equal(settled.state, "settled");
  assert.equal(settled.capacityReleasedAt, before.capacityReleasedAt, "the original release instant stands");
  assert.equal(settled.capacityReleaseReason, "runtime reported all containers removed", "and its own reason");
  assert.deepEqual(settled.settlement?.containers, [{ runtime: "docker", id: "c-1", removed: true }],
    "the settlement keeps the container facts the row already held");
  assert.equal(facts(h, run.id, "capacity_release").length, 1, "no second release fact");
  assert.equal(facts(h, run.id, "expiry").length, 1, "the settlement itself is still recorded");
});

test("a row still holding an open container settles but keeps its custody hold", t => {
  const h = harness(t);
  const run = launched(h.scheduler, admission("container"));
  h.scheduler.reportContainerFact({ factId: "fact-open", observedAt: LAUNCHED_AT, runId: run.id, epoch: 1,
    runtime: "docker", containerId: "c-open", event: "started" });

  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();

  const settled = h.scheduler.get(run.id)!;
  assert.equal(settled.state, "settled", "the reservation itself is past its deadline");
  assert.equal(settled.capacityReleasedAt, null, "an open container keeps its own custody hold");
  assert.deepEqual(settled.settlement?.containers, [{ runtime: "docker", id: "c-open", removed: false }]);
  assert.deepEqual(facts(h, run.id, "capacity_release"), []);
  assert.equal(h.store.hostRunCapacityCandidates().some(item => item.id === run.id), true,
    "the container, not the reservation, still reserves capacity");
});

test("a re-sweep settles an expired reservation once", t => {
  const h = harness(t);
  const run = launched(h.scheduler, admission("once"));

  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();
  const first = h.scheduler.get(run.id)!;
  h.time(60_000);
  h.scheduler.tick();
  h.scheduler.tick();

  const again = h.scheduler.get(run.id)!;
  assert.deepEqual(again, first, "a repeated sweep rewrites nothing");
  assert.equal(again.settledAt, first.settledAt);
  assert.equal(facts(h, run.id, "settlement").length, 1);
  assert.equal(facts(h, run.id, "expiry").length, 1);
  assert.equal(facts(h, run.id, "capacity_release").length, 1);
});

test("settling an accounting-retired reservation leaves that record byte for byte", t => {
  const h = harness(t);
  const run = launched(h.scheduler, admission("retired"));
  const absence = {
    runId: run.effigyRunId!, selector: run.selector, state: "not-found" as const, recording: "not-recorded" as const,
    message: "run `retired`: not recorded (foreground or expired); no live holder or retained journal record was found",
    checkout: repository.path, runtimePath: run.effigyRuntime!.path, runtimeSha256: run.effigyRuntime!.sha256,
    hook: { pid: HOOK.pid, startIdentity: HOOK.startIdentity }, observedAt: LAUNCHED_AT,
  };
  assert.equal(h.scheduler.retireAccountingOnForegroundAbsence({ runId: run.id, absence }).kind, "retired");
  const stored = h.store.hostRunAccountingDispositionRaw(run.id);
  assert.notEqual(stored, undefined);
  assert.equal(h.scheduler.summary().reservedCpu, 0, "the retirement already stopped the charge");

  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();

  const settled = h.scheduler.get(run.id)!;
  assert.equal(settled.state, "settled", "the row reaches its ordinary terminal state");
  assert.equal(settled.settlement?.outcome, "lost");
  assert.deepEqual(h.store.hostRunAccountingDispositionRaw(run.id), stored, "the retirement is not rewritten");
  const status = h.scheduler.accountingStatus(run.id)!;
  assert.equal(status.accounting, "retired");
  assert.equal(status.disposition?.format, "queue.host-run.accounting-absence-retirement");
  assert.equal(facts(h, run.id, "accounting_retirement").length, 1, "no second retirement");
  assert.equal(settled.capacityReleasedAt, settled.settledAt, "the settlement records its own release");
});

test("an expired reservation's capacity admits the run queued behind it", t => {
  const h = harness(t, { capacity: singleCpu });
  const launchedIds: string[] = [];
  const heavy = { runClass: "heavy" as const, classSource: "default" as const, priority: "milestone" as const };
  const blocker = h.scheduler.submit(admission("blocker", { ...heavy, runTimeoutMs: RUN_TIMEOUT_MS,
    budgetFallback: { cpu: 1, memoryBytes: 100 } }), launchHandler(h.scheduler));
  h.scheduler.bindProcess(blocker.id, HOOK);
  const waiting = h.scheduler.submit({
    id: "waiting", epoch: 1, caller: "test:waiting", repository, selector: "qa", ...heavy,
    runTimeoutMs: RUN_TIMEOUT_MS, budgetFallback: { cpu: 1, memoryBytes: 100 },
  }, launchHandler(h.scheduler, launchedIds));
  assert.equal(h.scheduler.get(blocker.id)?.state, "running");
  assert.equal(waiting.state, "queued", "the expired reservation's slot is still held");

  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();

  assert.equal(h.scheduler.get(blocker.id)?.state, "settled");
  assert.equal(h.scheduler.get("waiting")?.state, "running", "the ordinary pump admits the queued run");
  assert.deepEqual(launchedIds, ["waiting"]);
});

test("a settled-expired reservation is not observed, expired or released again by a later pass", t => {
  const h = harness(t);
  const run = launched(h.scheduler, admission("quiet"));
  h.time(RUN_TIMEOUT_MS + 1);
  h.scheduler.tick();
  const settledAt = h.scheduler.get(run.id)!.settledAt;
  const journalLength = h.store.hostRunJournal(run.id).length;

  h.time(24 * 60 * 60_000);
  h.scheduler.tick();
  assert.equal(h.scheduler.get(run.id)!.settledAt, settledAt);
  assert.equal(h.store.hostRunJournal(run.id).length, journalLength, "no new fact, ever");
});
