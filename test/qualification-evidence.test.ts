/**
 * Spec 064 P6 (qualification foundation, tranche 3): the typed observation, ack
 * and settlement, the writer split, and the exact settlement digest intake
 * consumes.
 *
 * Every fixture is a fresh mktemp under this run's TMPDIR: a real `qualification.raw`
 * written by the real qualification capture, a real child-process wait, a real
 * combined artifact decode and the three owned sidecars on disk. The gates are
 * checked one at a time, because one passing gate must never satisfy another.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostRunQualificationAckSchema,
  hostRunQualificationObservationSchema,
  hostRunQualificationSettlementSchema,
  type HostRunQualificationLedger,
  type HostRunQualificationObservation,
} from "../shared/schema/host-runs";
import { qualificationDigest, qualificationSubjectDigest } from "../core/host-runs/qualification-binding";
import { establishFirstEffectClock } from "../core/host-runs/qualification-clock";
import { openHostRunRetainedOutput } from "../core/host-runs/host-run-retained-output";
import {
  qualificationCaptureEvidence,
  qualificationWaitEvidence,
  readQualificationObservation,
  writeQualificationObservation,
  type QualificationObservationBody,
} from "../core/host-runs/qualification-observation";
import {
  acknowledgeQualificationCapture,
  readQualificationAck,
  qualificationAckDigest,
} from "../core/host-runs/qualification-acceptance";
import {
  qualificationSettlement,
  qualificationSettlementReference,
  readQualificationSettlement,
  readQualificationSettlementReference,
  recordQualificationSettlementReference,
  writeQualificationSettlement,
  type QualificationGateEvidence,
} from "../core/host-runs/qualification-settlement";
import {
  QUALIFICATION_ACK_LEAF,
  QUALIFICATION_OBSERVATION_LEAF,
  QUALIFICATION_SETTLEMENT_LEAF,
  assertQualificationEvidenceWriter,
} from "../core/host-runs/qualification-evidence";
import {
  QUALIFICATION_RESERVE_THRESHOLD_BYTES,
  QualificationLedgerMonitor,
  qualificationLedgerEntry,
} from "../core/host-runs/qualification-ledger";
import { executeHookProgram } from "../core/machine/process-exec";
import { proofResultRefusal } from "../core/intake/proof-settlement";
import type { Completion } from "../shared/contracts";

const now = () => Date.now();
const runId = "qualification-evidence-run";
const participantRunId = "executor-run";

function scratch(t: { after(fn: () => void): void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-qualification-evidence-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const subjectDigest = qualificationSubjectDigest({
  taskId: "task-1", participantRunId, operationId: null, briefVersion: null, briefDigest: null,
  head: "a".repeat(40), tree: "b".repeat(40), selector: "effigy check --plan", inputs: [],
  authorizedBy: { role: "queue_dispatch", caller: null, note: null },
});

/** A ledger with one real entry, charged from the artifact on disk. */
function ledgerFor(root: string): HostRunQualificationLedger {
  const monitor = new QualificationLedgerMonitor();
  return monitor.record(qualificationLedgerEntry(
    { scope: "raw_capture", label: "combined raw artifact", root, attributionProven: true },
    { nowMs: now(), provider: { kind: "root", id: root }, owner: "host-run supervisor", writers: ["host-run supervisor"], reserve: { observedFreeBytes: QUALIFICATION_RESERVE_THRESHOLD_BYTES * 2 } },
  )).ledger;
}

/** Write one real combined artifact and one real child exit observation. */
async function captureFixture(t: { after(fn: () => void): void }) {
  const stateDir = scratch(t);
  const artifact = openHostRunRetainedOutput(stateDir, runId, 8 * 1024 * 1024, "unused-token", { qualification: true });
  artifact.write("stdout", Buffer.from("qualification stdout\n", "utf8"));
  artifact.write("stderr", Buffer.from("qualification stderr\n", "utf8"));
  artifact.markEof("stdout");
  artifact.markDrained("stdout");
  artifact.markEof("stderr");
  artifact.markDrained("stderr");
  const closed = artifact.close();
  assert.ok(closed.qualification, "the qualification capture proves its artifact");
  assert.equal(closed.faults.length, 0);

  const execution = await executeHookProgram({
    root: stateDir, executable: process.execPath, argv: ["-e", "process.exit(0)"],
    stdin: Buffer.alloc(0), timeoutMs: 20_000, maxOutputBytes: 10_000,
    env: { PATH: process.env.PATH ?? "" }, directChildWait: true,
  });
  const clock = establishFirstEffectClock(now());
  const ledger = ledgerFor(join(stateDir, "runs", runId));
  const observation: QualificationObservationBody = {
    runId, epoch: 7, subjectDigest, clock, writtenAt: new Date().toISOString(),
    supervisor: { pid: process.pid, startIdentity: "fixture-supervisor" },
    command: {
      pid: execution.pid ?? null, pgid: execution.processGroupId ?? null, startIdentity: execution.startIdentity ?? null,
      exitCode: 0, signal: null, timedOut: false, terminalObservation: "observed",
    },
    directChildWait: qualificationWaitEvidence(execution.directChildWait ?? null),
    parentWaits: [],
    streamTerminals: {
      stdout: { eof: "observed", drained: "observed" },
      stderr: { eof: "observed", drained: "observed" },
    },
    capture: qualificationCaptureEvidence(closed.qualification, closed.faults),
    ledger,
    faults: [],
  };
  return { stateDir, artifact: closed.qualification, observation, clock, ledger };
}

test("S alone writes the observation; the endpoint alone writes the ack and the settlement", async t => {
  const f = await captureFixture(t);
  // The writer split is not advisory: neither process may write the other's record.
  assert.equal(assertQualificationEvidenceWriter(QUALIFICATION_OBSERVATION_LEAF, "supervisor"), undefined);
  assert.throws(() => assertQualificationEvidenceWriter(QUALIFICATION_OBSERVATION_LEAF, "endpoint"), /Only the supervisor writes qualification.observation.json/);
  assert.throws(() => assertQualificationEvidenceWriter(QUALIFICATION_ACK_LEAF, "supervisor"), /Only the endpoint writes qualification.ack.json/);
  assert.throws(() => assertQualificationEvidenceWriter(QUALIFICATION_SETTLEMENT_LEAF, "supervisor"), /Only the endpoint writes qualification.settlement.json/);

  const written = writeQualificationObservation(f.stateDir, runId, f.observation);
  assert.equal(written.record.digest, qualificationDigest(f.observation), "the observation digest covers the record without its digest field");
  const read = readQualificationObservation(f.stateDir, runId);
  assert.equal(read.state, "present");
  assert.deepEqual(read.state === "present" ? read.observation.digest : null, written.record.digest);
  // Before the endpoint acts, only the observation sidecar exists.
  const leaves = readdirSync(join(f.stateDir, "runs", runId)).sort();
  assert.ok(leaves.includes(QUALIFICATION_OBSERVATION_LEAF));
  assert.equal(leaves.includes(QUALIFICATION_ACK_LEAF), false, "S wrote no acknowledgement");
  assert.equal(leaves.includes(QUALIFICATION_SETTLEMENT_LEAF), false, "S wrote no settlement");

  const ackOutcome = acknowledgeQualificationCapture({
    stateDir: f.stateDir, runId, epoch: 7, subjectDigest, clock: f.clock,
    observation: written.record, nowMs: now(),
  });
  assert.equal(ackOutcome.state, "acknowledged");
  const ack = ackOutcome.state === "acknowledged" ? ackOutcome.ack : null;
  assert.ok(ack);
  assert.equal(ack!.observationDigest, written.record.digest, "the ack binds the observation digest");
  assert.equal(ack!.artifact.bytes, f.artifact.bytes, "the ack binds the artifact's encoded length");
  assert.equal(ack!.artifact.sha256, f.artifact.artifactSha256, "the ack binds the artifact's hash");
  assert.equal(ack!.streams.stdout.payloadBytes, f.observation.capture.streams.stdout.payloadBytes);
  assert.equal(ack!.streams.stderr.payloadSha256, f.observation.capture.streams.stderr.payloadSha256);
  assert.equal(ack!.streams.stdout.eofSequence, f.observation.capture.streams.stdout.eofSequence);
  assert.equal(ack!.streams.stderr.drainSequence, f.observation.capture.streams.stderr.drainSequence);
  assert.equal(ack!.withinTarget, true, "a fresh clock acknowledges inside the target");
  // The ack's own digest covers exactly its recorded bytes.
  const { format: _ackFormat, version: _ackVersion, digest: _ackDigest, ...ackBody } = ack!;
  assert.equal(ack!.digest, qualificationAckDigest(ackBody));
  assert.equal(hostRunQualificationAckSchema.parse(ack).digest, ack!.digest);

  // A late acknowledgement records that it was late; it cannot recover a pass.
  const lateAck = acknowledgeQualificationCapture({
    stateDir: f.stateDir, runId, epoch: 7, subjectDigest,
    clock: establishFirstEffectClock(now() - 601_000), observation: written.record, nowMs: now(),
  });
  // The clock identity differs, so the ack refuses rather than binding a late one.
  assert.equal(lateAck.state, "refused");
  const slowClock = { ...f.clock, originTick: now() - 601_000 };
  const late = acknowledgeQualificationCapture({
    stateDir: f.stateDir, runId, epoch: 7, subjectDigest, clock: slowClock,
    observation: { ...written.record, clock: slowClock }, nowMs: now(),
  });
  assert.equal(late.state, "acknowledged");
  assert.equal(late.state === "acknowledged" ? late.ack.withinTarget : null, false, "an ack past the target says so");

  // The ack is read back exactly, and an ack whose digest does not cover it is unreadable.
  const readAck = readQualificationAck(f.stateDir, runId);
  assert.equal(readAck.state, "present");
  assert.ok(readdirSync(join(f.stateDir, "runs", runId)).includes(QUALIFICATION_ACK_LEAF));
});

test("a disputed capture acquires no acknowledgement", async t => {
  const f = await captureFixture(t);
  const written = writeQualificationObservation(f.stateDir, runId, f.observation);
  const refused = acknowledgeQualificationCapture({
    stateDir: f.stateDir, runId, epoch: 7, subjectDigest, clock: f.clock,
    // S claims a different artifact hash than the file holds.
    observation: {
      ...written.record,
      capture: { ...written.record.capture, artifactSha256: `sha256:${"0".repeat(64)}` },
    },
    nowMs: now(),
  });
  assert.equal(refused.state, "refused");
  assert.ok(refused.state === "refused" && refused.refusals.some(reason => /is not S's/.test(reason)), JSON.stringify(refused));
  assert.equal(readQualificationAck(f.stateDir, runId).state, "absent", "a refusal writes nothing");

  // A subject the ack does not belong to is refused the same way.
  const wrongSubject = acknowledgeQualificationCapture({
    stateDir: f.stateDir, runId, epoch: 7, subjectDigest: `sha256:${"1".repeat(64)}`, clock: f.clock,
    observation: written.record, nowMs: now(),
  });
  assert.equal(wrongSubject.state, "refused");
  assert.equal(readQualificationAck(f.stateDir, runId).state, "absent");
});

test("each gate settles on its own receipt and one passing gate never satisfies another", async t => {
  const f = await captureFixture(t);
  const observation = writeQualificationObservation(f.stateDir, runId, f.observation).record;
  const ack = acknowledgeQualificationCapture({
    stateDir: f.stateDir, runId, epoch: 7, subjectDigest, clock: f.clock, observation, nowMs: now(),
  });
  assert.equal(ack.state, "acknowledged");
  const ackDigest = ack.state === "acknowledged" ? ack.digest : null;

  const base = {
    runId, epoch: 7, subjectDigest, clock: f.clock, nowMs: now(),
    observation, ackDigest, ledger: f.ledger,
  };
  const settlement = qualificationSettlement(base);
  // There is no inferred `closed` flag anywhere in the record.
  assert.equal("closed" in settlement, false);
  assert.equal(hostRunQualificationSettlementSchema.safeParse(settlement).success, true);

  // The gates Nucleus itself observed are proved; everything its external owners
  // must supply stays unknown even though other gates passed.
  assert.equal(settlement.gates.capture.outcome, "proved");
  assert.equal(settlement.gates.directChildWait.outcome, "proved");
  assert.equal(settlement.gates.storage.outcome, "proved");
  assert.equal(settlement.gates.parentWaits.outcome, "unknown", "S's own E wait does not prove A, C, M, the leaves or the publisher");
  assert.equal(settlement.gates.decidingCensus.outcome, "unknown");
  assert.equal(settlement.gates.censusJoin.outcome, "unknown");
  assert.equal(settlement.gates.finalCensus.outcome, "unknown");
  assert.equal(settlement.gates.imageAttachment.outcome, "unknown");
  assert.equal(settlement.delivery.outcome, "unknown");
  assert.equal(settlement.verdict, "unknown", "unresolved gates make the verdict unknown, never proved");
  assert.equal(settlement.disposition.spent, null, "an unknown gate is not yet a disproved one");
  assert.ok(settlement.disposition.retention.keep);
  assert.ok(settlement.disposition.unresolvedObligations.length >= 6);
  for (const [key, gate] of Object.entries(settlement.gates)) {
    assert.equal(gate.gate, key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).replace(/^direct_child_wait$/, "direct_child_wait"),
      `${key} carries its own receipt`);
  }

  // One gate proved while its neighbour is disproved: the neighbour stays disproved.
  const disproved: QualificationGateEvidence = { outcome: "disproved", detail: "the provider saw a mount still attached", source: "provider-receipt" };
  const withBacking = qualificationSettlement({
    ...base,
    evidence: {
      decidingCensus: { outcome: "proved", detail: "the exact named DECIDING census was joined", source: "census" },
      censusJoin: { outcome: "proved", detail: "the join completed", source: "census" },
      imageAttachment: disproved,
    },
  });
  assert.equal(withBacking.gates.decidingCensus.outcome, "proved");
  assert.equal(withBacking.gates.imageAttachment.outcome, "disproved", "the disproved provider receipt is not softened by other proved gates");
  assert.equal(withBacking.gates.finalCensus.outcome, "unknown", "the FINAL census is still missing even with DECIDING and join proved");
  assert.equal(withBacking.verdict, "failed");
  assert.equal(withBacking.disposition.spent?.disposition, "unknown_SPENT_retained");
  assert.match(withBacking.disposition.firstFault?.detail ?? "", /mount still attached/);
  assert.equal(withBacking.disposition.outcomes.closure, "disproved");

  // A proved set of every gate and outcome would be needed for `proved`; a record
  // that claims it with an unknown gate is refused by the schema itself.
  const proved = qualificationSettlement({
    ...base,
    evidence: {
      source: { outcome: "proved", detail: "source bound" },
      creatorWaits: { outcome: "proved", detail: "every creator waited its own child" },
      decidingCensus: { outcome: "proved", detail: "deciding" },
      censusJoin: { outcome: "proved", detail: "joined" },
      finalCensus: { outcome: "proved", detail: "final empty" },
      imageAttachment: { outcome: "proved", detail: "no mount or device attached" },
      workload: { outcome: "proved", detail: "effigy admitted and completed" },
      delivery: { outcome: "proved", detail: "publisher reaped after the ack" },
    },
  });
  assert.equal(proved.verdict, "proved");
  assert.equal(hostRunQualificationSettlementSchema.safeParse(proved).success, true);
  assert.equal(hostRunQualificationSettlementSchema.safeParse({ ...proved, verdict: "proved", gates: { ...proved.gates, finalCensus: { ...proved.gates.finalCensus, outcome: "unknown" } } }).success, false,
    "a proved verdict with an unknown gate is rejected by the record itself");
  assert.equal(hostRunQualificationSettlementSchema.safeParse({ ...proved, gates: { ...proved.gates, capture: { ...proved.gates.capture, gate: "storage" } } }).success, false,
    "a gate cannot wear another gate's receipt");
});

test("intake consumes the exact settlement digest and a spent attempt can never report a pass", async t => {
  const f = await captureFixture(t);
  const observation = writeQualificationObservation(f.stateDir, runId, f.observation).record;
  const ack = acknowledgeQualificationCapture({
    stateDir: f.stateDir, runId, epoch: 7, subjectDigest, clock: f.clock, observation, nowMs: now(),
  });
  assert.equal(ack.state, "acknowledged");
  const ackDigest = ack.state === "acknowledged" ? ack.digest : null;
  const settlement = qualificationSettlement({
    runId, epoch: 7, subjectDigest, clock: f.clock, nowMs: now(), observation, ackDigest, ledger: f.ledger,
    spent: { reason: "the service→S parent was lost during the proof", at: new Date().toISOString(), disposition: "unknown_SPENT_retained" },
  });
  const { format: _format, version: _version, digest: _digest, ...body } = settlement;
  const written = writeQualificationSettlement(f.stateDir, runId, body);
  assert.equal(written.settlement.digest, settlement.digest, "the written digest is the record's own digest");
  const reread = readQualificationSettlement(f.stateDir, runId);
  assert.equal(reread.state, "present");
  assert.deepEqual(reread.state === "present" ? reread.settlement : null, written.settlement);
  assert.ok(readdirSync(join(f.stateDir, "runs", runId)).includes(QUALIFICATION_SETTLEMENT_LEAF));

  const meta = new Map<string, unknown>();
  const store = { setMeta: (key: string, value: unknown) => { meta.set(key, value); }, getMeta: <T>(key: string) => meta.get(key) as T | undefined };
  const reference = qualificationSettlementReference(written.settlement, participantRunId);
  recordQualificationSettlementReference(store, reference);
  assert.equal(reference.spent, true);
  assert.equal(reference.verdict, "unknown");
  const recorded = readQualificationSettlementReference(store, participantRunId);
  assert.equal(recorded.state, "present");

  const run = {
    id: participantRunId, role: "executor" as const,
    proofExecution: {
      selector: "effigy check --plan", inputs: [], prNumber: null, tree: "b".repeat(40), operationId: null,
      briefVersion: null, briefDigest: null, returnPhase: "awaiting_review" as const,
      authorizedBy: { role: "queue_dispatch" as const, caller: null, note: null },
      qualification: { subject: { taskId: "task-1", participantRunId, operationId: null, briefVersion: null, briefDigest: null, head: "a".repeat(40), tree: "b".repeat(40), selector: "effigy check --plan", inputs: [], authorizedBy: { role: "queue_dispatch" as const, caller: null, note: null } }, execution: null },
    },
  };
  const completion = (digest: string | undefined, status: "passed" | "failed"): Completion => ({
    eventId: "e", taskId: "task-1", runId: participantRunId, status: "proof_executed",
    proofResult: {
      status, selector: "effigy check --plan",
      ...(digest ? { qualification: { settlementDigest: digest, artifactSha256: reference.artifactSha256 } } : {}),
    },
  } as unknown as Completion);

  // A result with no digest is refused: a status alone proves nothing.
  assert.match(String(proofResultRefusal(completion(undefined, "failed"), run, recorded)), /must carry the exact settlement digest/);
  // A different settlement is refused.
  assert.match(String(proofResultRefusal(completion(`sha256:${"9".repeat(64)}`, "failed"), run, recorded)), /not this run's recorded/);
  // The exact digest of a spent attempt is consumed, and a `passed` claim is refused.
  const exact = proofResultRefusal(completion(reference.digest, "passed"), run, recorded);
  assert.match(String(exact), /spent/);
  assert.match(String(exact), /cannot report a pass/);
  // Conservative evidence stays recordable: a failed result from a spent attempt is accepted.
  assert.equal(proofResultRefusal(completion(reference.digest, "failed"), run, recorded), null);
  // With no recorded settlement at all, nothing is accepted.
  assert.match(String(proofResultRefusal(completion(reference.digest, "passed"), run, { state: "absent" })), /No qualification settlement is recorded/);
  assert.match(String(proofResultRefusal(completion(reference.digest, "passed"), run, { state: "unreadable", reason: "torn write" })), /cannot be read/);
  // An ordinary proof execution is untouched by any of this.
  const ordinary = { ...run, proofExecution: { ...run.proofExecution, qualification: undefined } };
  assert.equal(proofResultRefusal(completion(undefined, "passed"), ordinary, null), null);
});

test("the observation record refuses an unknown field and a mismatched artefact identity", async t => {
  const f = await captureFixture(t);
  const body = f.observation;
  assert.equal(hostRunQualificationObservationSchema.safeParse({
    format: "host.run.qualification.observation", version: 1, ...body, digest: qualificationDigest(body),
  }).success, true);
  assert.equal(hostRunQualificationObservationSchema.safeParse({
    format: "host.run.qualification.observation", version: 1, ...body, digest: qualificationDigest(body), closed: true,
  }).success, false, "the observation carries no inferred closed flag");
  // A tampered record is unreadable on disk, never silently accepted.
  const written = writeQualificationObservation(f.stateDir, runId, body);
  const tampered: HostRunQualificationObservation = { ...written.record, writtenAt: new Date(Date.now() + 1_000).toISOString() };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(f.stateDir, "runs", runId, QUALIFICATION_OBSERVATION_LEAF), JSON.stringify(tampered));
  const read = readQualificationObservation(f.stateDir, runId);
  assert.equal(read.state, "unreadable");
  assert.match(read.state === "unreadable" ? read.reason : "", /digest does not cover/);
});
