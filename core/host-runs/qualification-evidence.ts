/**
 * Spec 064 P6: which process owns which qualification evidence sidecar.
 *
 * The split is not advisory. S — and only S — writes
 * `qualification.observation.json`; the endpoint — and only the endpoint —
 * writes `qualification.ack.json` and `qualification.settlement.json`. Each
 * writer names itself here before it writes, so a mistake is refused at the
 * owner rather than discovered by reading a file that two processes could have
 * produced.
 */
export const QUALIFICATION_OBSERVATION_LEAF = "qualification.observation.json";
export const QUALIFICATION_ACK_LEAF = "qualification.ack.json";
export const QUALIFICATION_SETTLEMENT_LEAF = "qualification.settlement.json";

export type QualificationEvidenceLeaf =
  | typeof QUALIFICATION_OBSERVATION_LEAF
  | typeof QUALIFICATION_ACK_LEAF
  | typeof QUALIFICATION_SETTLEMENT_LEAF;

export type QualificationEvidenceWriter = "supervisor" | "endpoint";

export const QUALIFICATION_EVIDENCE_OWNERS: Readonly<Record<QualificationEvidenceLeaf, QualificationEvidenceWriter>> = {
  [QUALIFICATION_OBSERVATION_LEAF]: "supervisor",
  [QUALIFICATION_ACK_LEAF]: "endpoint",
  [QUALIFICATION_SETTLEMENT_LEAF]: "endpoint",
};

/** Every qualification evidence sidecar, in the order a reader sees them appear. */
export const QUALIFICATION_EVIDENCE_LEAVES: readonly QualificationEvidenceLeaf[] = [
  QUALIFICATION_OBSERVATION_LEAF, QUALIFICATION_ACK_LEAF, QUALIFICATION_SETTLEMENT_LEAF,
];

/**
 * Refuse a write of one sidecar by a process that does not own it. A writer that
 * is not the owner has not observed what the record claims, so its bytes would be
 * a claim rather than evidence.
 */
export function assertQualificationEvidenceWriter(leaf: QualificationEvidenceLeaf, writer: QualificationEvidenceWriter): void {
  const owner = QUALIFICATION_EVIDENCE_OWNERS[leaf];
  if (owner !== writer)
    throw new Error(`Only the ${owner} writes ${leaf}; ${writer === "supervisor" ? "S" : "the endpoint"} does not observe what it records`);
}
