/**
 * Spec 064 P5 (qualification foundation, tranche 3): the one cumulative
 * first-effect clock and the monitored storage ledger.
 *
 * These cases prove the clock's origin is taken before the dispatch funnel
 * persists a reservation and that a retry continues that origin instead of
 * restarting the target, that an effect ordered before the origin refuses, and
 * that the ledger charges the spec's inventory, latches a monitored-target breach
 * with the P3 stop and never claims an all-physical peak.
 *
 * Every fixture is a fresh mktemp under this run's TMPDIR; the real bytes are real
 * files on disk, and the 512 MiB bound is simulated by the ledger's own sample
 * limit rather than by writing half a gigabyte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, Run } from "../shared/contracts";
import { DispatchLaunch, type DispatchLaunchContext } from "../core/dispatch/launch";
import {
  continueFirstEffectClock, establishFirstEffectClock, firstEffectClockReading, firstEffectClockRefusal,
  firstEffectTargetRefusal, QUALIFICATION_CUTOFFS,
} from "../core/host-runs/qualification-clock";
import {
  QUALIFICATION_STORAGE_TARGET_BYTES, QUALIFICATION_RESERVE_THRESHOLD_BYTES, QualificationLedgerMonitor,
  logicalTreeBytes, qualificationLedger, qualificationLedgerEntry, type QualificationFootprint,
} from "../core/host-runs/qualification-ledger";
import {
  missingQualificationReadiness, qualificationReadiness, qualificationReadinessRefusal,
  QUALIFICATION_REQUIRED_INPUTS, QUALIFICATION_REFUSED_BEFORE_EFFECTS,
} from "../core/host-runs/qualification-inputs";
import {
  qualificationFirstEffectClockSchema,
  type QualificationFirstEffectClock,
  type QualificationReadiness,
} from "../shared/schema/review/proof";
import { runSchema } from "../shared/schema/runs";

const now = () => Date.now();

/** A readiness set where every required input is present with its own provenance. */
function suppliedReadiness(): QualificationReadiness {
  return qualificationReadiness(QUALIFICATION_REQUIRED_INPUTS.map(required => ({
    id: required.id,
    state: "present" as const,
    evidence: { owner: "fixture supplier", source: `${required.id}-receipt`, digest: null, observedAt: new Date().toISOString() },
  })));
}

function scratch(t: { after(fn: () => void): void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-qualification-clock-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A dispatch shape whose only real work is the funnel's own bookkeeping: the
 * store is a stub, and the launch records the activation it was handed and
 * persists a run intent the way the reservation does.
 */
function dispatchFixture(t: { after(fn: () => void): void }) {
  const created: Run[] = [];
  const state = {
    task: {
      id: "task-clock", version: 1, phase: "awaiting_review", entrypoint: "normal",
      prHead: "a".repeat(40), prUrl: "https://example.test/pr/1", proofExecutions: [],
      proofExecution: { selector: "effigy check --plan", inputs: [], qualification: true },
      resolution: { currentRunId: null },
    } as unknown as Task,
    activations: [] as Array<{ firstEffectClock?: QualificationFirstEffectClock }>,
    launchedAt: [] as string[],
  };
  const store = {
    task: () => state.task,
    runs: () => created,
    run: (id: string) => created.find(run => run.id === id) ?? null,
  };
  const launch = async (_task: Task, _role: string, options: { proof?: { firstEffectClock?: QualificationFirstEffectClock } }) => {
    // A retry happens after the failed attempt's run was released.
    for (const prior of created) prior.released = true;
    const clock = options.proof?.firstEffectClock;
    assert.ok(clock, "the funnel hands the reservation the attempt clock");
    state.activations.push({ ...(clock ? { firstEffectClock: clock } : {}) });
    const createdAt = new Date().toISOString();
    state.launchedAt.push(createdAt);
    const run = runSchema.parse({
      id: `run-${created.length + 1}`, taskId: state.task.id, role: "executor", generation: 1,
      head: state.task.prHead, base: state.task.prHead, agentId: "executor", workspaceId: "workspace",
      profile: null, status: "running", createdAt, lastObservedAt: null, active: null, idleSince: null,
      completion: null, released: false,
      proofExecution: {
        selector: "effigy check --plan", inputs: [], prNumber: 1, tree: "b".repeat(40), operationId: null,
        briefVersion: null, briefDigest: null, returnPhase: "awaiting_review",
        authorizedBy: { role: "queue_dispatch", caller: null, note: null },
        qualification: {
          subject: {
            taskId: state.task.id, participantRunId: `run-${created.length + 1}`, operationId: null,
            briefVersion: null, briefDigest: null, head: state.task.prHead, tree: "b".repeat(40),
            selector: "effigy check --plan", inputs: [], authorizedBy: { role: "queue_dispatch", caller: null, note: null },
          },
          execution: null,
          ...(clock ? { firstEffectClock: clock } : {}),
        },
      },
    });
    created.push(run);
    state.task = { ...state.task, resolution: { currentRunId: run.id } } as unknown as Task;
  };
  const context = {
    store,
    launch,
    catalogKnown: () => true,
  } as unknown as DispatchLaunchContext;
  t.after(() => { /* the stub owns no resources */ });
  return { dispatch: new DispatchLaunch(context), state, created };
}

test("the clock origin is taken before the reservation persists and a retry never resets it", async t => {
  const f = dispatchFixture(t);
  const first = await f.dispatch.proofExecution(f.state.task, {
    authorizedBy: { role: "queue_dispatch", caller: null, note: null }, operationId: null,
    // A ready set is what a real external supplier would have to resolve; no
    // production caller supplies one, which is why real proof mode refuses.
    readiness: suppliedReadiness(),
  });
  const firstClock = f.state.activations[0]!.firstEffectClock!;
  assert.equal(firstClock.targetMs, 600_000, "the target is the spec's 600 s, not a caller's number");
  assert.match(firstClock.clockId, /^[0-9a-f-]{36}$/);
  const firstRun = f.created[0]!;
  assert.ok(firstClock.originTick <= Date.parse(firstRun.createdAt),
    `the origin ${firstClock.originTick} precedes the reservation persistence at ${firstRun.createdAt}`);
  assert.deepEqual(firstRun.proofExecution?.qualification?.firstEffectClock, firstClock,
    "the reservation records the same origin no later owner may restart");
  assert.equal(first.resolution.currentRunId, firstRun.id);

  // A retry: the failed attempt's run was released and the retry is at the head
  // that dispatch now records. The earliest recorded origin is continued rather
  // than replaced.
  firstRun.released = true;
  f.state.task = {
    ...first, prHead: "c".repeat(40), prUrl: "https://example.test/pr/2",
    resolution: { currentRunId: null },
  } as unknown as Task;
  const retry = await f.dispatch.proofExecution(f.state.task, {
    authorizedBy: { role: "queue_dispatch", caller: null, note: null }, operationId: null,
    readiness: suppliedReadiness(),
  });
  const retryClock = f.state.activations[1]!.firstEffectClock!;
  assert.equal(retryClock.clockId, firstClock.clockId, "the retry keeps the attempt's clock id");
  assert.equal(retryClock.originTick, firstClock.originTick, "the retry keeps the attempt's origin; a retry never resets the target");
  assert.ok(Date.parse(f.created[1]!.createdAt) >= Date.parse(firstRun.createdAt));
  assert.equal(retry.resolution.currentRunId, f.created[1]!.id);
  assert.equal(f.created[1]!.head, "c".repeat(40), "the retry is a new head, and still keeps the attempt's clock");

  // The clock reader is the same rule on its own: earliest origin wins, target fixed.
  const later = establishFirstEffectClock(firstClock.originTick + 5_000);
  const earlier = establishFirstEffectClock(firstClock.originTick - 1_000);
  const continued = continueFirstEffectClock([later, earlier, null, firstClock], now());
  assert.equal(continued.reused, true);
  assert.equal(continued.clock.originTick, earlier.originTick);
  assert.equal(continued.clock.targetMs, 600_000);
  assert.equal(continueFirstEffectClock([], now()).reused, false, "a first attempt mints its own origin");
});

test("a mandatory effect ordered before the origin refuses, and the funnel refuses a future origin", async t => {
  const clock = establishFirstEffectClock(now());
  assert.equal(firstEffectClockRefusal(clock, [{ name: "reservation persistence", tick: clock.originTick }, { name: "submit write", tick: clock.originTick + 1 }]), null);
  const refusal = firstEffectClockRefusal(clock, [
    { name: "scheduler persistence", tick: clock.originTick - 2 },
    { name: "capture open", tick: clock.originTick - 1 },
  ]);
  assert.ok(refusal, "an effect before the origin refuses");
  assert.match(refusal!, /preceded by mandatory effects/);
  assert.match(refusal!, /scheduler persistence at \d+/);
  assert.match(refusal!, /capture open at \d+/);

  // Through the funnel: a recorded origin that has not happened yet means the
  // reservation this call would persist is ordered before it. Nothing is launched.
  const f = dispatchFixture(t);
  const future = now() + 60_000;
  f.created.push(runSchema.parse({
    id: "run-recorded", taskId: f.state.task.id, role: "executor", generation: 1,
    head: f.state.task.prHead, base: f.state.task.prHead, agentId: "executor", workspaceId: "workspace",
    profile: null, status: "running", createdAt: new Date().toISOString(), lastObservedAt: null,
    active: null, idleSince: null, completion: null, released: false,
    proofExecution: {
      selector: "effigy check --plan", inputs: [], prNumber: 1, tree: "b".repeat(40), operationId: null,
      briefVersion: null, briefDigest: null, returnPhase: "awaiting_review",
      authorizedBy: { role: "queue_dispatch", caller: null, note: null },
      qualification: {
        subject: {
          taskId: f.state.task.id, participantRunId: "run-recorded", operationId: null, briefVersion: null,
          briefDigest: null, head: f.state.task.prHead, tree: "b".repeat(40), selector: "effigy check --plan",
          inputs: [], authorizedBy: { role: "queue_dispatch", caller: null, note: null },
        },
        execution: null,
        firstEffectClock: { clockId: "recorded-clock", originTick: future, targetMs: 600_000 },
      },
    },
  }));
  const before = f.created.length;
  await assert.rejects(
    f.dispatch.proofExecution(f.state.task, {
      authorizedBy: { role: "queue_dispatch", caller: null, note: null }, operationId: null,
      readiness: suppliedReadiness(),
    }),
    /reservation persistence/,
  );
  assert.equal(f.created.length, before, "the refused route persisted no reservation");
});

test("the cumulative target is read from one origin and a late settlement changes closure only", () => {
  const clock = establishFirstEffectClock(1_000);
  const inside = firstEffectClockReading(clock, 1_000 + 599_999);
  assert.equal(inside.withinTarget, true);
  assert.equal(inside.targetHit, false);
  assert.equal(inside.remainingMs, 1);
  const late = firstEffectClockReading(clock, 1_000 + 600_001);
  assert.equal(late.withinTarget, false, "the target is permanent once passed");
  assert.equal(late.targetHit, true);
  assert.match(String(firstEffectTargetRefusal(late, "The acknowledged delivery")), /permanently failed and late completion changes closure only/);
  assert.equal(firstEffectTargetRefusal(inside, "anything"), null);
  // The overlapping cutoffs sit inside the same target: they are never added to it.
  for (const cutoff of Object.values(QUALIFICATION_CUTOFFS)) assert.ok(cutoff < 600_000, `${cutoff} is inside the one target`);
  // The clock schema refuses a different target and a non-integer origin.
  assert.equal(qualificationFirstEffectClockSchema.safeParse(clock).success, true);
  assert.equal(qualificationFirstEffectClockSchema.safeParse({ ...clock, targetMs: 900_000 }).success, false);
  assert.equal(qualificationFirstEffectClockSchema.safeParse({ ...clock, originTick: 1.5 }).success, false);
});

test("the ledger charges the spec's inventory from real bytes and reports the physical peak as unknown", t => {
  const root = scratch(t);
  const files = {
    database: join(root, "queue.sqlite"), wal: join(root, "queue.sqlite-wal"), journal: join(root, "journal.log"),
    publication: join(root, "publications"), raw_capture: join(root, "qualification.raw"),
    copy: join(root, "evidence"), retained_failure: join(root, "retained"),
  };
  for (const [scope, path] of Object.entries(files)) {
    if (scope === "publication" || scope === "copy" || scope === "retained_failure") { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "entry.bin"), Buffer.alloc(64, 1)); }
    else writeFileSync(path, Buffer.alloc(32, 1));
  }
  const footprints: QualificationFootprint[] = [
    { scope: "database", label: "Nucleus database", root: files.database, attributionProven: false, missingCoverage: ["per-run attribution is not proven, so the whole shared footprint is charged"] },
    { scope: "wal", label: "Nucleus WAL", root: files.wal, attributionProven: false },
    { scope: "journal", label: "ordered journal", root: files.journal, attributionProven: false },
    { scope: "publication", label: "publications", root: files.publication, attributionProven: true },
    { scope: "raw_capture", label: "combined raw artifact", root: files.raw_capture, attributionProven: true },
    { scope: "copy", label: "evidence copies", root: files.copy, attributionProven: true },
    { scope: "retained_failure", label: "retained failures", root: files.retained_failure, attributionProven: true },
  ];
  const monitor = new QualificationLedgerMonitor();
  const entries = footprints.map(footprint => qualificationLedgerEntry(footprint, {
    nowMs: now(), provider: { kind: "root", id: root }, owner: "fixture",
    writers: footprint.attributionProven ? ["host-run supervisor"] : "unknown",
    reserve: { observedFreeBytes: QUALIFICATION_RESERVE_THRESHOLD_BYTES + 1 },
  }));
  for (const entry of entries) monitor.record(entry);
  const reading = monitor.reading();
  assert.deepEqual(reading.ledger.entries.map(entry => entry.scope),
    ["database", "wal", "journal", "publication", "raw_capture", "copy", "retained_failure"],
    "every charged footprint the spec's inventory names is an entry");
  assert.equal(reading.ledger.entries.find(entry => entry.scope === "publication")!.chargedBytes, 64,
    "the entry charges the real logical bytes it measured");
  assert.equal(reading.ledger.entries.find(entry => entry.scope === "database")!.wholeFootprintCharged, true,
    "an unproven attribution charges the whole shared footprint");
  assert.equal(reading.ledger.combined.chargedBytes, 32 * 4 + 64 * 3, "the combined charge sums the entries");
  assert.equal(reading.ledger.combined.breach, false);
  assert.equal(reading.ledger.combined.targetBytes, QUALIFICATION_STORAGE_TARGET_BYTES);
  assert.equal(reading.ledger.reserve.state, "safe");
  assert.equal(reading.ledger.reserve.thresholdBytes, QUALIFICATION_RESERVE_THRESHOLD_BYTES);
  assert.equal(reading.ledger.physicalPeak, "unknown", "a logical sample claims no all-physical peak");
  assert.ok(reading.ledger.entries.every(entry => entry.physicalPeakClaimed === false));
  assert.ok(reading.ledger.entries.every(entry => entry.method === "logical_tree_walk"));
  assert.ok(reading.ledger.entries.every(entry => entry.sampledAt !== null), "each entry records its own sample tick");
  assert.equal(reading.ledger.entries[0]!.missingCoverage.length, 1, "what the entry could not cover is disclosed");
  assert.equal(reading.breach, null);
  assert.equal(reading.stop, null);
  assert.equal(logicalTreeBytes(join(root, "absent")).state, "absent");
});

test("a simulated 512 MiB breach latches the failure and requests the P3 direct-command stop", t => {
  const root = scratch(t);
  const target = join(root, "raw");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "capture.raw"), Buffer.alloc(4096, 2));
  // The bound is simulated at 1 KiB on the same monitor: the rule, the latch and
  // the stop are the production ones, only the number is smaller than 512 MiB.
  const monitor = new QualificationLedgerMonitor({ targetBytes: 1024 });
  const footprint: QualificationFootprint = { scope: "raw_capture", label: "combined raw artifact", root: target, attributionProven: true };
  const first = monitor.record(qualificationLedgerEntry(footprint, {
    nowMs: now(), provider: { kind: "root", id: root }, owner: "fixture", writers: ["host-run supervisor"],
    reserve: { observedFreeBytes: QUALIFICATION_RESERVE_THRESHOLD_BYTES * 10 },
  }));
  assert.equal(first.ledger.combined.breach, true, "the breach is recorded on the ledger");
  assert.equal(first.breach !== null, true);
  assert.deepEqual(first.stop, {
    mode: "qualification_direct",
    reason: first.stop!.reason,
  }, "the breach requests the P3 direct-command stop");
  assert.equal(first.stop!.mode, "qualification_direct", "never a group, escapee or KILL stop");
  assert.match(first.stop!.reason, /storage ledger latched/);
  const latched = monitor.firstFault();
  assert.ok(latched, "the first fault is permanent");

  // A later sample under the bound cannot withdraw the latch or the stop.
  const small = join(root, "small");
  mkdirSync(small, { recursive: true });
  writeFileSync(join(small, "tiny"), Buffer.alloc(8));
  const after = monitor.record(qualificationLedgerEntry({ ...footprint, root: small }, {
    nowMs: now(), provider: { kind: "root", id: root }, owner: "fixture", writers: ["host-run supervisor"],
    reserve: { observedFreeBytes: QUALIFICATION_RESERVE_THRESHOLD_BYTES * 10 },
  }));
  assert.equal(after.ledger.combined.chargedBytes, 8);
  assert.equal(after.ledger.combined.breach, true, "the breach stays latched");
  assert.deepEqual(monitor.firstFault(), latched, "the first fault is never rewritten");
  assert.equal(after.stop!.mode, "qualification_direct");

  // An entry that claims a physical peak is refused outright.
  assert.throws(() => monitor.record({
    ...qualificationLedgerEntry(footprint, { nowMs: now(), provider: { kind: "root", id: root }, owner: "fixture", writers: ["x"], reserve: { observedFreeBytes: null } }),
    physicalPeakClaimed: true as unknown as false,
  }), /never claims a physical peak/);
});

test("an unknown required charge is never fit, and the reserve threshold is never assumed safe", t => {
  const root = scratch(t);
  const unreadable = qualificationLedgerEntry({ scope: "database", label: "unreadable database", root: join(root, "missing"), attributionProven: false }, {
    nowMs: now(), provider: { kind: "root", id: root }, owner: "fixture", writers: "unknown", reserve: { observedFreeBytes: null },
  });
  assert.equal(unreadable.reserveSafety.state, "unknown", "an unsampled reserve is unknown, never safe");
  assert.ok(unreadable.missingCoverage.length > 0, "an absent shared footprint discloses that its absence is observed, not proven");
  const ledger = qualificationLedger([{ ...unreadable, chargedBytes: null }], now());
  assert.equal(ledger.combined.chargedBytes, null, "an unknown required charge makes the combined total unknown");
  assert.equal(ledger.combined.breach, null, "an unknown total is never read as inside the target");
  assert.equal(qualificationLedger([{ ...unreadable, reserveSafety: { ...unreadable.reserveSafety, state: "below_threshold" } }], now()).reserve.state, "below_threshold");
});

test("the missing-input refusal names every required external input and never synthesizes one", () => {
  const all = qualificationReadinessRefusal(missingQualificationReadiness());
  assert.ok(all, "with nothing supplied the mode refuses");
  assert.ok(all!.startsWith(QUALIFICATION_REFUSED_BEFORE_EFFECTS), all!);
  assert.match(all!, new RegExp(`needs ${QUALIFICATION_REQUIRED_INPUTS.length} external inputs`));
  for (const required of QUALIFICATION_REQUIRED_INPUTS) assert.match(all!, new RegExp(required.id), `the refusal names ${required.id}`);
  assert.match(all!, /never synthesizes the clock, provider evidence, waits, censuses or closure/);
  const absent = qualificationReadinessRefusal(null);
  assert.ok(absent);
  assert.match(absent!, /has no readiness set/);
  assert.match(absent!, /9 inputs are unsupplied/);

  // One supplied input is still not readiness: the other eight are named.
  const almost = qualificationReadiness([{
    id: "effigy_admission", state: "present",
    evidence: { owner: "effigy", source: "admission-receipt", digest: null, observedAt: new Date().toISOString() },
  }]);
  const partial = qualificationReadinessRefusal(almost);
  assert.ok(partial);
  assert.doesNotMatch(partial!, /missing \(effigy_admission/);
  assert.match(partial!, new RegExp(`8 missing \\(`));
  assert.match(partial!, /deciding_census/);

  // A `present` claim without provenance is unverified, never satisfied.
  const unprovenanced = qualificationReadiness([{ id: "effigy_admission", state: "present" }]);
  assert.equal(unprovenanced.inputs.find(input => input.id === "effigy_admission")!.state, "unknown");
  assert.match(String(qualificationReadinessRefusal(unprovenanced)), /1 unverified \(effigy_admission\)/);

  // A full, provenance-carrying set is the only thing that is ready.
  assert.equal(qualificationReadinessRefusal(suppliedReadiness()), null);
  assert.throws(() => qualificationReadiness([{ id: "not_a_required_input" as never, state: "missing" }]), /not a required qualification input/);
});
