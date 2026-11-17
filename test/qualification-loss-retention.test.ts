/**
 * Spec 064 P7 (qualification foundation, tranche 3): spent retention and loss.
 *
 * A Nucleus roll during a proof, or the loss of the service→S parent, spends the
 * attempt as unknown/SPENT/retained even if S survives and later writes a result.
 * The settlement keeps the first fault, the spend, the unresolved obligations and
 * the separate target/workload/evidence/resources/closure outcomes, and retention
 * keeps the raw bytes, the sidecars and the charged residuals while anything is
 * unresolved — the ordinary expiry marker is no deletion authority.
 *
 * The fixtures are a real state root under this run's TMPDIR, a real combined
 * artifact, and the real watch and retention owners over a stub scheduler that
 * records the settlements they decide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostRunInternalRecord, HostRunResult, HostRunSettlement } from "../shared/contracts";
import type { QualificationReadiness } from "../shared/schema/review/proof";
import { QUALIFICATION_REQUIRED_INPUTS } from "../shared/schema/review/proof";
import { qualificationReadiness } from "../core/host-runs/qualification-inputs";
import { qualificationSubjectDigest } from "../core/host-runs/qualification-binding";
import { establishFirstEffectClock } from "../core/host-runs/qualification-clock";
import { hostRunSupervisorPlanSchema } from "../core/host-runs/host-run-wire";
import { hostRunSupervisorPaths, writeVerifiedOwnedFile } from "../core/host-runs/host-run-files";
import {
  QUALIFICATION_RAW_LEAF,
} from "../core/host-runs/host-run-files";
import { openHostRunRetainedOutput } from "../core/host-runs/host-run-retained-output";
import {
  qualificationCaptureEvidence,
  qualificationWaitEvidence,
  writeQualificationObservation,
} from "../core/host-runs/qualification-observation";
import { QUALIFICATION_OBSERVATION_LEAF, QUALIFICATION_ACK_LEAF, QUALIFICATION_SETTLEMENT_LEAF } from "../core/host-runs/qualification-evidence";
import { readQualificationAck } from "../core/host-runs/qualification-acceptance";
import {
  readQualificationSettlement,
  readQualificationSettlementReference,
} from "../core/host-runs/qualification-settlement";
import {
  QUALIFICATION_RESERVE_THRESHOLD_BYTES,
  QualificationLedgerMonitor,
  qualificationLedgerEntry,
} from "../core/host-runs/qualification-ledger";
import { HostRunWatch } from "../core/host-runs/host-run-watch";
import { HostRunRetention } from "../core/host-runs/host-run-retention";
import { proofResultRefusal } from "../core/intake/proof-settlement";
import type { Completion } from "../shared/contracts";

const now = () => Date.now();
const runId = "qualification-loss-run";
const participantRunId = "executor-loss-run";
const subjectDigest = qualificationSubjectDigest({
  taskId: "task-loss", participantRunId, operationId: null, briefVersion: null, briefDigest: null,
  head: "a".repeat(40), tree: "b".repeat(40), selector: "effigy check --plan", inputs: [],
  authorizedBy: { role: "queue_dispatch", caller: null, note: null },
});

function scratch(t: { after(fn: () => void): void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-qualification-loss-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function suppliedReadiness(): QualificationReadiness {
  return qualificationReadiness(QUALIFICATION_REQUIRED_INPUTS.map(required => ({
    id: required.id, state: "present" as const,
    evidence: { owner: "fixture supplier", source: `${required.id}-receipt`, digest: null, observedAt: new Date().toISOString() },
  })));
}

/** A stub scheduler: it hands back the run it holds and records what the watch decides. */
function watchFixture(t: { after(fn: () => void): void }, stateDir: string) {
  const meta = new Map<string, unknown>();
  const settled: Array<{ id: string; settlement: HostRunSettlement }> = [];
  const run = {
    id: runId, epoch: 9, state: "running", launchedAt: new Date(now() - 5_000).toISOString(),
    settledAt: null as string | null, settlement: null, pid: 4242, processGroupId: 4242,
    startIdentity: "fixture@1", wallMs: null, cpuMs: null, containers: [], caller: "fixture",
  } as unknown as HostRunInternalRecord;
  const scheduler = {
    store: {
      path: join(stateDir, "..", "queue.sqlite"),
      setMeta: (key: string, value: unknown) => { meta.set(key, value); },
      getMeta: <T>(key: string): T | undefined => meta.get(key) as T | undefined,
    },
    get: (id: string) => id === runId ? run : null,
    settle: (id: string, settlement: HostRunSettlement) => {
      settled.push({ id, settlement });
      run.settledAt = settlement.settledAt;
      return run;
    },
    note: () => { /* journal notes are not this fixture's subject */ },
    recordEndpointEvent: () => { /* ditto */ },
  };
  const watch = new HostRunWatch({
    stopping: false, supervisorPollMs: 1_000, scheduler: scheduler as never, nowMs: now, stateDir,
  });
  t.after(() => { /* the stub owns no processes */ });
  return { watch, scheduler, meta, settled, run };
}

/** A real combined artifact plus the observation S would publish, under one real run root. */
async function qualificationAttempt(t: { after(fn: () => void): void }, stateDir: string) {
  const clock = establishFirstEffectClock(now() - 1_000);
  const plan = hostRunSupervisorPlanSchema.parse({
    format: "host.run.supervisor.plan", version: 1, stateDir, runId, epoch: 9,
    argv: [process.execPath, "-e", "process.exit(0)"], cwd: stateDir, envKeys: [],
    runTimeoutMs: 600_000, graceMs: 10, startedAt: new Date(now() - 2_000).toISOString(),
    stopMode: "qualification_direct",
    firstEffectClock: clock,
    qualification: {
      subject: {
        taskId: "task-loss", participantRunId, operationId: null, briefVersion: null, briefDigest: null,
        head: "a".repeat(40), tree: "b".repeat(40), selector: "effigy check --plan", inputs: [],
        authorizedBy: { role: "queue_dispatch", caller: null, note: null },
      },
      execution: null,
      firstEffectClock: clock,
      readiness: suppliedReadiness(),
    },
  });
  writeVerifiedOwnedFile(stateDir, ["runs", runId, "supervisor.plan.json"], JSON.stringify(plan), 0o600);
  const artifact = openHostRunRetainedOutput(stateDir, runId, 8 * 1024 * 1024, undefined, { qualification: true });
  artifact.write("stdout", Buffer.from("qualification workload output\n"));
  artifact.write("stderr", Buffer.from("qualification workload diagnostic\n"));
  for (const stream of ["stdout", "stderr"] as const) { artifact.markEof(stream); artifact.markDrained(stream); }
  const closed = artifact.close();
  assert.ok(closed.qualification);
  const monitor = new QualificationLedgerMonitor();
  const ledger = monitor.record(qualificationLedgerEntry(
    { scope: "raw_capture", label: "combined raw artifact", root: join(stateDir, "runs", runId), attributionProven: true },
    { nowMs: now(), provider: { kind: "root", id: stateDir }, owner: "host-run supervisor", writers: ["host-run supervisor"], reserve: { observedFreeBytes: QUALIFICATION_RESERVE_THRESHOLD_BYTES * 4 } },
  )).ledger;
  const observation = writeQualificationObservation(stateDir, runId, {
    runId, epoch: 9, subjectDigest, clock, writtenAt: new Date().toISOString(),
    supervisor: { pid: process.pid, startIdentity: "fixture-supervisor" },
    command: { pid: 4343, pgid: 4343, startIdentity: "command@1", exitCode: 0, signal: null, timedOut: false, terminalObservation: "observed" },
    directChildWait: qualificationWaitEvidence({
      parentPid: process.pid, parentStartIdentity: "fixture-supervisor", childPid: 4343,
      childStartIdentity: "command@1", state: "observed", code: 0, signal: null,
      observedAt: new Date().toISOString(), source: "child-exit-event",
    }),
    parentWaits: [],
    streamTerminals: { stdout: { eof: "observed", drained: "observed" }, stderr: { eof: "observed", drained: "observed" } },
    capture: qualificationCaptureEvidence(closed.qualification, closed.faults),
    ledger, faults: [],
  }).record;
  return { plan, clock, artifact: closed.qualification, observation };
}

test("a roll during a proof spends it unknown/SPENT/retained, and a later result cannot make it a pass", async t => {
  const stateDir = scratch(t);
  const f = watchFixture(t, stateDir);
  const attempt = await qualificationAttempt(t, stateDir);

  // The roll: this service did not spawn S, so the service→S parent is lost.
  f.watch.settleQualificationRoll(runId,
    "a Nucleus roll ended the service→S parent during this qualification proof; the attempt is spent unknown/SPENT/retained");
  const written = readQualificationSettlement(stateDir, runId);
  assert.equal(written.state, "present");
  const settlement = written.state === "present" ? written.settlement : null;
  assert.ok(settlement);
  assert.equal(settlement!.verdict, "unknown", "a lost parent cannot yield a proved attempt");
  assert.equal(settlement!.disposition.spent?.disposition, "unknown_SPENT_retained");
  assert.match(settlement!.disposition.spent!.reason, /Nucleus roll ended the service→S parent/);
  assert.deepEqual(settlement!.disposition.outcomes, {
    target: "proved", workload: "unknown", evidence: "unknown", resources: "unknown", closure: "unknown",
  }, "the target, workload, evidence, resources and closure outcomes stay separate");
  // The service ledger charges the whole shared database footprint and discloses
  // that one run's share is not attributable, so resources stay unknown rather
  // than being read as fit.
  assert.match(settlement!.gates.storage.detail, /not fully covered|unknown/);
  assert.ok(settlement!.disposition.unresolvedObligations.some(obligation => /parent_waits/.test(obligation)));
  assert.equal(settlement!.disposition.retention.keep, true);
  assert.equal(settlement!.disposition.firstFault, null, "a loss is a spend, not a disproved gate");

  // The reference intake consumes says spent, so no reader can turn it into a pass.
  const reference = readQualificationSettlementReference(f.scheduler.store as never, participantRunId);
  assert.equal(reference.state, "present");
  assert.equal(reference.state === "present" ? reference.reference.spent : null, true);

  // S survives the roll and publishes its late result: the endpoint acknowledges the
  // observation it reads through the watch, the result is written, and the watch
  // settles the run from it.
  assert.ok(f.watch.readSupervisorPlan(runId), "the watch reads the run's own qualification plan");
  f.watch.acknowledgeQualification(runId);
  const ack = readQualificationAck(stateDir, runId);
  assert.equal(ack.state, "present", "the endpoint acknowledged S's observation");
  assert.equal(ack.state === "present" ? ack.ack.observationDigest : null, attempt.observation.digest);
  const result: HostRunResult = {
    format: "host.run.result", version: 1, runId, epoch: 9, pgid: 4343, startIdentity: "command@1",
    exitCode: 0, signal: null, startedAt: new Date(now() - 5_000).toISOString(), endedAt: new Date().toISOString(),
    wallMs: 5_000, cpuMs: 10, escapedDescendants: [],
  };
  writeVerifiedOwnedFile(stateDir, ["runs", runId, "result.json"], JSON.stringify(result), 0o600);
  f.watch.settleFromResult(f.run, result, null);
  assert.equal(f.settled.length, 1, "the run settled from its late result");
  assert.equal(f.settled[0]!.settlement.outcome, "passed", "contract 010's record still reports the command's own exit");

  // The qualification evidence did not: it keeps the spend, and a passing proof
  // result is refused by intake against that exact settlement.
  const afterLateResult = readQualificationSettlement(stateDir, runId);
  assert.equal(afterLateResult.state, "present");
  const kept = afterLateResult.state === "present" ? afterLateResult.settlement : null;
  assert.deepEqual(kept, settlement, "a late result never overwrites the spent settlement");
  const lateReference = readQualificationSettlementReference(f.scheduler.store as never, participantRunId);
  assert.equal(lateReference.state === "present" ? lateReference.reference.spent : null, true);
  assert.equal(lateReference.state === "present" ? lateReference.reference.verdict : null, "unknown");
  const completion = {
    eventId: "e", taskId: "task-loss", runId: participantRunId, status: "proof_executed",
    proofResult: {
      status: "passed", selector: "effigy check --plan",
      qualification: {
        settlementDigest: lateReference.state === "present" ? lateReference.reference.digest : "",
        artifactSha256: lateReference.state === "present" ? lateReference.reference.artifactSha256 : "",
      },
    },
  } as unknown as Completion;
  const run = {
    id: participantRunId, role: "executor" as const,
    proofExecution: {
      selector: "effigy check --plan", inputs: [], prNumber: null, tree: "b".repeat(40), operationId: null,
      briefVersion: null, briefDigest: null, returnPhase: "awaiting_review" as const,
      authorizedBy: { role: "queue_dispatch" as const, caller: null, note: null },
      qualification: attempt.plan.qualification,
    },
  };
  assert.match(String(proofResultRefusal(completion, run, lateReference)), /spent/);

  // Retention keeps the raw bytes and the sidecars while anything is unresolved.
  const retention = new HostRunRetention({ scheduler: f.scheduler as never, nowMs: now, outputRetentionMs: 1, stateDir });
  f.run.settledAt = new Date(now() - 10_000).toISOString();
  const retained = retention.settleRetainedOutput(f.run);
  assert.equal(retained.outcome, "retained_unresolved");
  assert.match((retained as { reason: string }).reason, /is kept/);
  assert.equal(retention.attemptRetention(f.run, null, now()), "", "retaining unresolved evidence is not a retention failure");
  const paths = hostRunSupervisorPaths(stateDir, runId);
  assert.equal(existsSync(join(stateDir, "runs", runId, QUALIFICATION_RAW_LEAF)), true, "the raw artifact survives the expiry window");
  assert.equal(existsSync(paths.qualificationRawPath), true);
  for (const leaf of [QUALIFICATION_OBSERVATION_LEAF, QUALIFICATION_ACK_LEAF, QUALIFICATION_SETTLEMENT_LEAF])
    assert.equal(readdirSync(join(stateDir, "runs", runId)).includes(leaf), true, `${leaf} is still beside the run`);
});

test("a roll before S published anything still spends the attempt with every obligation unresolved", async t => {
  const stateDir = scratch(t);
  const f = watchFixture(t, stateDir);
  const clock = establishFirstEffectClock(now() - 1_000);
  const plan = hostRunSupervisorPlanSchema.parse({
    format: "host.run.supervisor.plan", version: 1, stateDir, runId, epoch: 9,
    argv: [process.execPath, "-e", "process.exit(0)"], cwd: stateDir, envKeys: [],
    runTimeoutMs: 600_000, graceMs: 10, startedAt: new Date(now() - 2_000).toISOString(),
    stopMode: "qualification_direct", firstEffectClock: clock,
    qualification: {
      subject: {
        taskId: "task-loss", participantRunId, operationId: null, briefVersion: null, briefDigest: null,
        head: "a".repeat(40), tree: "b".repeat(40), selector: "effigy check --plan", inputs: [],
        authorizedBy: { role: "queue_dispatch", caller: null, note: null },
      },
      execution: null, firstEffectClock: clock, readiness: suppliedReadiness(),
    },
  });
  writeVerifiedOwnedFile(stateDir, ["runs", runId, "supervisor.plan.json"], JSON.stringify(plan), 0o600);

  f.watch.settleQualificationRoll(runId, "the service→S parent was lost before S published its observation");
  const written = readQualificationSettlement(stateDir, runId);
  assert.equal(written.state, "present");
  const settlement = written.state === "present" ? written.settlement : null;
  assert.ok(settlement);
  assert.equal(settlement!.observationDigest, null);
  assert.equal(settlement!.ackDigest, null);
  assert.equal(settlement!.artifact, null);
  assert.equal(settlement!.gates.capture.outcome, "unknown");
  assert.equal(settlement!.gates.directChildWait.outcome, "unknown");
  assert.equal(settlement!.verdict, "unknown");
  assert.equal(settlement!.disposition.spent?.disposition, "unknown_SPENT_retained");
  assert.ok(settlement!.disposition.unresolvedObligations.some(obligation => /S published no observation/.test(obligation)));
  assert.equal(settlement!.disposition.retention.keep, true);
  // Nothing was invented: no artifact path, no sidecar claims, no verdict.
  assert.equal(existsSync(join(stateDir, "runs", runId, QUALIFICATION_RAW_LEAF)), false);
  writeFileSync(join(stateDir, "runs", runId, "unrelated.txt"), "kept\n");
  const retention = new HostRunRetention({ scheduler: f.scheduler as never, nowMs: now, outputRetentionMs: 1, stateDir });
  f.run.settledAt = new Date(now() - 10_000).toISOString();
  assert.equal(retention.settleRetainedOutput(f.run).outcome, "unavailable",
    "a qualification plan with no artifact is unavailable evidence, never an expired zero-length stream");
});
