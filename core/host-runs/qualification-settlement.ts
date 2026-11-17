/**
 * Spec 064 P6/P7: the settlement the endpoint alone writes, and the disposition
 * it keeps.
 *
 * P6 asks for one record per independent gate — the direct-child wait, the parent
 * waits, the deciding census and its join, the separate FINAL census, image
 * attachment, capture, delivery and storage — plus the separate target, workload,
 * evidence, resources and closure outcomes. There is deliberately no inferred
 * `closed` flag: a gate settles only on its own receipt, and no passing gate
 * satisfies another.
 *
 * P7 asks that the disposition keep the first fault, the spent occurrence, every
 * unresolved obligation and those separate outcomes, that losing the service→S
 * parent or a Nucleus roll during a proof spends it as unknown/SPENT/retained even
 * if S later writes a result, and that retention keeps the raw bytes, the
 * sidecars and the charged residuals while anything is unresolved.
 */
import { z } from "zod";
import {
  hostRunQualificationSettlementSchema,
  type HostRunQualificationFault,
  type HostRunQualificationGate,
  type HostRunQualificationLedger,
  type HostRunQualificationObservation,
  type HostRunQualificationOutcomes,
  type HostRunQualificationSettlement,
  type HostRunQualificationWait,
} from "../../shared/schema/host-runs";
import {
  QUALIFICATION_FIRST_EFFECT_TARGET_MS,
  qualificationDigestSchema,
  type QualificationFirstEffectClock,
} from "../../shared/schema/review/proof";
import { readCheckedHostRunFileRead, writeVerifiedOwnedFile } from "./host-run-files";
import { qualificationDigest } from "./qualification-binding";
import { firstEffectClockReading } from "./qualification-clock";
import {
  QUALIFICATION_ACK_LEAF,
  QUALIFICATION_OBSERVATION_LEAF,
  QUALIFICATION_SETTLEMENT_LEAF,
  assertQualificationEvidenceWriter,
} from "./qualification-evidence";
import { QUALIFICATION_STORAGE_TARGET_BYTES } from "./qualification-ledger";

export type QualificationSettlementBody = Omit<HostRunQualificationSettlement, "format" | "version" | "digest">;

/** One gate's evidence, as its own owner supplied it. */
export interface QualificationGateEvidence {
  outcome: "proved" | "disproved" | "unknown";
  detail: string;
  source?: string;
  digest?: string | null;
  observedAt?: string | null;
}

export const unknownGate = (detail: string): QualificationGateEvidence => ({ outcome: "unknown", detail });

/** Why an attempt became spent: the loss it did not survive, or the bound it hit. */
export interface QualificationSpendReason {
  reason: string;
  at: string;
  /** What spending this attempt means, in the one vocabulary P7 allows. */
  disposition: "unknown_SPENT_retained";
}

export interface QualificationSettlementInputs {
  runId: string;
  epoch: number;
  subjectDigest: string;
  clock: QualificationFirstEffectClock | null;
  nowMs: number;
  /** S's observation, as the endpoint read it. */
  observation: HostRunQualificationObservation | null;
  observationUnreadable?: string | null;
  /** The ack the endpoint itself wrote, when it wrote one. */
  ackDigest: string | null;
  ackWithinTarget?: boolean | null;
  ledger?: HostRunQualificationLedger | null;
  /** Every receipt Nucleus itself does not supply; absent means unknown, never satisfied. */
  evidence?: {
    source?: QualificationGateEvidence;
    creatorWaits?: QualificationGateEvidence;
    decidingCensus?: QualificationGateEvidence;
    censusJoin?: QualificationGateEvidence;
    finalCensus?: QualificationGateEvidence;
    imageAttachment?: QualificationGateEvidence;
    workload?: QualificationGateEvidence;
    delivery?: QualificationGateEvidence;
  };
  /** A permanent first fault already observed for this attempt. */
  firstFault?: HostRunQualificationFault | null;
  /** The attempt's loss: the service→S parent, a roll during the proof, or an unsupported owner. */
  spent?: QualificationSpendReason | null;
  /** Any additional unresolved obligation the caller observed. */
  unresolved?: readonly string[];
}

const evidenceGate = (gate: HostRunQualificationGate["gate"], evidence: QualificationGateEvidence): HostRunQualificationGate => ({
  gate, outcome: evidence.outcome, detail: evidence.detail.slice(0, 2000),
  evidence: evidence.source
    ? { source: evidence.source, digest: evidence.digest ?? null, observedAt: evidence.observedAt ?? null }
    : null,
});

const proofWait = (wait: HostRunQualificationWait | null): QualificationGateEvidence =>
  wait && wait.state === "observed"
    ? { outcome: "proved", detail: `The ${wait.role} exit was observed as its actual parent's own child event at ${wait.observedAt}`, source: wait.source, observedAt: wait.observedAt }
    : { outcome: "unknown", detail: "No actual parent's own child exit observation was recorded for the direct command" };

/** The capture gate: the artifact's size identity, its hashes, its flush and the ack's agreement. */
function captureGate(inputs: QualificationSettlementInputs): QualificationGateEvidence {
  const observation = inputs.observation;
  if (!observation) {
    return inputs.observationUnreadable
      ? { outcome: "unknown", detail: `The observation could not be read: ${inputs.observationUnreadable}` }
      : { outcome: "unknown", detail: "S wrote no observation, so nothing establishes the capture" };
  }
  const capture = observation.capture;
  if (capture.latched) return { outcome: "disproved", detail: `The combined artifact latched a fault and covers only a prefix of ${capture.bytes} bytes` };
  if (!capture.sizeIdentityHolds) return { outcome: "disproved", detail: `The artifact is ${capture.bytes} bytes, not the ${capture.expectedBytes}-byte size identity` };
  if (capture.partialFrame) return { outcome: "disproved", detail: "The artifact ends in a partial frame, so its accounting is incomplete" };
  if (capture.flush.state === "unknown") return { outcome: "unknown", detail: `The writer's flush is unknown: ${capture.flush.reason}` };
  for (const stream of ["stdout", "stderr"] as const) {
    if (observation.streamTerminals[stream].eof !== "observed" || observation.streamTerminals[stream].drained !== "observed")
      return { outcome: "unknown", detail: `The ${stream} stream has no observed EOF and drain; a group stop is not a drain` };
  }
  if (inputs.ackDigest === null) return { outcome: "unknown", detail: "The endpoint wrote no acknowledgement for this capture" };
  return {
    outcome: "proved",
    detail: `One combined artifact of ${capture.bytes} bytes with ${capture.frameCount} frames, per-stream payload hashes and both terminals; flush ${capture.flush.reason}`,
    source: "qualification.observation.json", digest: observation.digest, observedAt: capture.path ? observation.writtenAt : null,
  };
}

/** The storage gate: the monitored target and the reserve safety, from the logical ledger only. */
function storageGate(ledger: HostRunQualificationLedger | null | undefined): QualificationGateEvidence {
  if (!ledger) return { outcome: "unknown", detail: "No storage ledger was charged for this attempt; nothing establishes fit" };
  if (ledger.combined.breach === true)
    return { outcome: "disproved", detail: `The combined charge ${ledger.combined.chargedBytes} breached the ${ledger.combined.targetBytes}-byte monitored target` };
  if (ledger.combined.breach === null)
    return { outcome: "unknown", detail: "A required charge is unknown, so the combined footprint is unknown; unknown is never fit" };
  if (ledger.reserve.state === "below_threshold")
    return { outcome: "disproved", detail: `The ${ledger.reserve.thresholdBytes}-byte reserve safety threshold was crossed` };
  if (ledger.reserve.state === "unknown")
    return { outcome: "unknown", detail: "The reserve safety sample is unknown; it is never counted as safe" };
  const uncovered = ledger.entries.filter(entry => entry.missingCoverage.length > 0).map(entry => entry.label);
  if (uncovered.length)
    return { outcome: "unknown", detail: `These charged footprints are not fully covered: ${uncovered.join(", ")}` };
  return {
    outcome: "proved",
    detail: `Logical accounting only: ${ledger.entries.length} entries charged ${ledger.combined.chargedBytes} bytes against ${ledger.combined.targetBytes}, reserve safe at ${ledger.reserve.thresholdBytes}; no all-physical peak is claimed`,
  };
}

/** Build the settlement from what is actually known, gate by gate. */
export function qualificationSettlement(inputs: QualificationSettlementInputs): HostRunQualificationSettlement {
  const observation = inputs.observation;
  const clockReading = inputs.clock ? firstEffectClockReading(inputs.clock, inputs.nowMs) : null;
  const lateReason = clockReading && !clockReading.withinTarget
    ? `The settlement landed at +${clockReading.elapsedMs} ms, past the ${clockReading.targetMs} ms first-effect target; late completion changes closure only`
    : null;

  const clockGate: QualificationGateEvidence = !inputs.clock
    ? unknownGate("No first-effect clock was established, so no cumulative interval exists")
    : !clockReading!.withinTarget
      ? { outcome: "disproved", detail: `The attempt reached +${clockReading!.elapsedMs} ms, past its ${inputs.clock.targetMs} ms target` }
      : { outcome: "proved", detail: `The first-effect clock ${inputs.clock.clockId} origin ${inputs.clock.originTick} was settled at +${clockReading!.elapsedMs} ms inside ${inputs.clock.targetMs} ms` };

  const gates = {
    source: evidenceGate("source", inputs.evidence?.source ?? unknownGate("No exact source/authority recheck receipt was supplied")),
    clock: evidenceGate("clock", clockGate),
    directChildWait: evidenceGate("direct_child_wait", proofWait(observation?.directChildWait ?? null)),
    parentWaits: evidenceGate("parent_waits", inputs.evidence?.creatorWaits ?? unknownGate("The creator-owned wait receipts for A, C, M, the leaves and the publisher were not supplied; S's own E wait proves only S→E")),
    decidingCensus: evidenceGate("deciding_census", inputs.evidence?.decidingCensus ?? unknownGate("No joined, custodian-bound DECIDING census was supplied")),
    censusJoin: evidenceGate("census_join", inputs.evidence?.censusJoin ?? unknownGate("No completed census join was supplied")),
    finalCensus: evidenceGate("final_census", inputs.evidence?.finalCensus ?? unknownGate("No separate FINAL certain-empty census was supplied")),
    imageAttachment: evidenceGate("image_attachment", inputs.evidence?.imageAttachment ?? unknownGate("No positive provider evidence that every mount and attached device is absent was supplied")),
    capture: evidenceGate("capture", captureGate(inputs)),
    storage: evidenceGate("storage", storageGate(inputs.ledger)),
  };
  const delivery = evidenceGate("delivery", inputs.evidence?.delivery ?? unknownGate("No source-bound publisher wait and in-window durable acceptance was supplied"));

  const outcomes: HostRunQualificationOutcomes = {
    target: gates.clock.outcome,
    workload: inputs.evidence?.workload?.outcome ?? "unknown",
    evidence: gates.capture.outcome === "disproved" || delivery.outcome === "disproved" ? "disproved"
      : gates.capture.outcome === "proved" && delivery.outcome === "proved" ? "proved" : "unknown",
    resources: gates.storage.outcome,
    closure: [gates.parentWaits, gates.finalCensus, gates.imageAttachment].some(gate => gate.outcome === "disproved") ? "disproved"
      : [gates.parentWaits, gates.finalCensus, gates.imageAttachment, gates.decidingCensus, gates.censusJoin].every(gate => gate.outcome === "proved") ? "proved" : "unknown",
  };

  const allGates = [...Object.values(gates), delivery];
  const disproved = allGates.some(gate => gate.outcome === "disproved");
  const everyGateProved = allGates.every(gate => gate.outcome === "proved");
  const everyOutcomeProved = Object.values(outcomes).every(outcome => outcome === "proved");
  const verdict: HostRunQualificationSettlement["verdict"] =
    inputs.spent ? "unknown" : disproved || outcomes.target === "disproved" ? "failed" : everyGateProved && everyOutcomeProved ? "proved" : "unknown";

  const firstDisproved = allGates.find(gate => gate.outcome === "disproved");
  const firstFault: HostRunQualificationFault | null = inputs.firstFault
    ?? (firstDisproved ? { kind: firstDisproved.gate, detail: firstDisproved.detail, at: new Date(inputs.nowMs).toISOString() } : null);
  const spent: QualificationSpendReason | null = inputs.spent
    ?? (verdict === "failed"
      ? { reason: firstFault?.detail ?? "the attempt disproved a required gate", at: firstFault?.at ?? new Date(inputs.nowMs).toISOString(), disposition: "unknown_SPENT_retained" }
      : null);

  const unresolved = [
    ...allGates.filter(gate => gate.outcome !== "proved").map(gate => `${gate.gate}: ${gate.detail}`),
    ...Object.entries(outcomes).filter(([, outcome]) => outcome !== "proved").map(([name, outcome]) => `outcome ${name} is ${outcome}`),
    ...(inputs.unresolved ?? []),
  ];
  const retain = verdict !== "proved" || spent !== null;
  const body: QualificationSettlementBody = {
    runId: inputs.runId, epoch: inputs.epoch, subjectDigest: inputs.subjectDigest,
    observationDigest: observation?.digest ?? null,
    ackDigest: inputs.ackDigest,
    settledAt: new Date(inputs.nowMs).toISOString(),
    clock: inputs.clock,
    elapsed: {
      originTick: inputs.clock?.originTick ?? null, settledTick: inputs.nowMs,
      targetMs: inputs.clock?.targetMs ?? QUALIFICATION_FIRST_EFFECT_TARGET_MS,
      withinTarget: clockReading ? clockReading.withinTarget : false, lateReason,
    },
    gates, delivery,
    artifact: observation
      ? { path: observation.capture.path, bytes: observation.capture.bytes, sha256: observation.capture.artifactSha256 }
      : null,
    disposition: {
      firstFault,
      spent: spent ? { spentAt: spent.at, reason: spent.reason, disposition: spent.disposition } : null,
      unresolvedObligations: [...new Set(unresolved)].slice(0, 64),
      outcomes,
      retention: {
        keep: retain,
        rawArtifact: observation
          ? { path: observation.capture.path, bytes: observation.capture.bytes, sha256: observation.capture.artifactSha256 }
          : null,
        sidecars: [
          QUALIFICATION_OBSERVATION_LEAF,
          ...(inputs.ackDigest ? [QUALIFICATION_ACK_LEAF] : []),
          QUALIFICATION_SETTLEMENT_LEAF,
        ],
        chargedResidualBytes: inputs.ledger?.combined.chargedBytes ?? null,
        reason: retain
          ? "Anything unresolved keeps its raw bytes, sidecars and charged residuals; the ordinary expiry marker is no deletion authority"
          : "Every gate proved, so ordinary retention may expire the evidence after its window",
      },
    },
    verdict,
  };
  return hostRunQualificationSettlementSchema.parse({
    format: "host.run.qualification.settlement", version: 1, ...body, digest: qualificationSettlementDigest(body),
  });
}

/** The settlement's canonical digest: the exact value intake consumes. */
export function qualificationSettlementDigest(body: QualificationSettlementBody): string {
  return qualificationDigest(body);
}

/** Write the endpoint's settlement. The publication's own facts are returned, never assumed. */
export function writeQualificationSettlement(stateDir: string, runId: string, body: QualificationSettlementBody) {
  assertQualificationEvidenceWriter(QUALIFICATION_SETTLEMENT_LEAF, "endpoint");
  const settlement: HostRunQualificationSettlement = hostRunQualificationSettlementSchema.parse({
    format: "host.run.qualification.settlement", version: 1, ...body, digest: qualificationSettlementDigest(body),
  });
  if (settlement.runId !== runId) throw new Error(`The qualification settlement names run ${settlement.runId}, not ${runId}`);
  const publication = writeVerifiedOwnedFile(stateDir, ["runs", runId, QUALIFICATION_SETTLEMENT_LEAF], JSON.stringify(settlement), 0o600);
  return { settlement, publication };
}

export type QualificationSettlementRead =
  | { state: "absent" }
  | { state: "present"; settlement: HostRunQualificationSettlement }
  | { state: "unreadable"; reason: string };

export function readQualificationSettlement(stateDir: string, runId: string): QualificationSettlementRead {
  const read = readCheckedHostRunFileRead(stateDir, ["runs", runId, QUALIFICATION_SETTLEMENT_LEAF]);
  if (read.state !== "present") return read;
  try {
    const settlement = hostRunQualificationSettlementSchema.parse(JSON.parse(read.bytes.toString("utf8")));
    if (settlement.runId !== runId) return { state: "unreadable", reason: `the settlement names run ${settlement.runId}` };
    const { format: _format, version: _version, digest, ...body } = settlement;
    if (digest !== qualificationSettlementDigest(body)) return { state: "unreadable", reason: "the settlement's own digest does not cover its bytes" };
    return { state: "present", settlement };
  } catch (error) {
    return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The private store key that records which settlement this run's attempt settled from. */
export const QUALIFICATION_SETTLEMENT_META_PREFIX = "hostRunQualificationSettlement:";
/** Keyed by the executor run that owns the attempt, which is what intake reads. */
export const qualificationSettlementMetaKey = (participantRunId: string) => `${QUALIFICATION_SETTLEMENT_META_PREFIX}${participantRunId}`;

/**
 * The reference intake reads: the exact settlement digest, its artifact digest,
 * the verdict and whether the attempt was spent. It is durable beside the host
 * run row, so a redirected or late proof result can never name a settlement this
 * queue did not write.
 */
export const qualificationSettlementReferenceSchema = z.object({
  runId: z.string().min(1).max(160),
  epoch: z.number().int().positive(),
  participantRunId: z.string().min(1).max(160),
  subjectDigest: qualificationDigestSchema,
  digest: qualificationDigestSchema,
  verdict: z.enum(["proved", "failed", "unknown"]),
  artifactSha256: qualificationDigestSchema,
  spent: z.boolean(),
  firstFault: z.string().trim().min(1).max(4000).optional(),
  unresolvedObligations: z.array(z.string().trim().min(1).max(400)).max(64).default([]),
}).strict();

export type QualificationSettlementReference = {
  runId: string; epoch: number; participantRunId: string; subjectDigest: string; digest: string;
  verdict: "proved" | "failed" | "unknown"; artifactSha256: string; spent: boolean;
  firstFault?: string; unresolvedObligations: string[];
};

export function qualificationSettlementReference(
  settlement: HostRunQualificationSettlement,
  participantRunId: string,
): QualificationSettlementReference {
  if (!settlement.artifact) throw new Error(`Qualification settlement ${settlement.runId} names no artifact, so no reference can be recorded`);
  return {
    runId: settlement.runId, epoch: settlement.epoch, participantRunId,
    subjectDigest: settlement.subjectDigest, digest: settlement.digest, verdict: settlement.verdict,
    artifactSha256: settlement.artifact.sha256, spent: settlement.disposition.spent !== null,
    ...(settlement.disposition.firstFault ? { firstFault: settlement.disposition.firstFault.detail } : {}),
    unresolvedObligations: settlement.disposition.unresolvedObligations,
  };
}

export function recordQualificationSettlementReference(
  store: { setMeta(key: string, value: unknown): void },
  reference: QualificationSettlementReference,
): void {
  store.setMeta(qualificationSettlementMetaKey(reference.participantRunId), qualificationSettlementReferenceSchema.parse(reference));
}

export type QualificationSettlementReferenceRead =
  | { state: "absent" }
  | { state: "present"; reference: QualificationSettlementReference }
  | { state: "unreadable"; reason: string };

export function readQualificationSettlementReference(store: { getMeta<T>(key: string): T | undefined }, participantRunId: string): QualificationSettlementReferenceRead {
  let raw: unknown;
  try { raw = store.getMeta<unknown>(qualificationSettlementMetaKey(participantRunId)); }
  catch (error) { return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) }; }
  if (raw === undefined || raw === null) return { state: "absent" };
  const parsed = qualificationSettlementReferenceSchema.safeParse(raw);
  if (!parsed.success) return { state: "unreadable", reason: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
  if (parsed.data.participantRunId !== participantRunId)
    return { state: "unreadable", reason: `the reference names executor run ${parsed.data.participantRunId}` };
  return { state: "present", reference: parsed.data };
}

export const qualificationStorageTargetBytes = QUALIFICATION_STORAGE_TARGET_BYTES;
