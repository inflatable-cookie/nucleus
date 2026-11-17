/**
 * Spec 064 P5/P6, "refuse before effects": the one owner of what real
 * qualification proof mode needs from its external suppliers before it may cause
 * any effect.
 *
 * Every entry is somebody else's contract — Effigy's prepare custody and genuine
 * admission, the common elapsed clock across participants, each creator's own
 * wait/reap, the joined DECIDING census and the separate FINAL census, the image
 * attachment provider evidence, the capture-plus-delivery conjunction, and the
 * accounting/fit/readiness measurement. Nucleus supplies none of them, so it may
 * not synthesize one, infer one from an exit status, or start a proof on the
 * strength of authentication alone. Today every entry is missing, which is
 * exactly why the mode refuses: the refusal names each missing input instead of
 * saying "unavailable".
 */
import {
  QUALIFICATION_REQUIRED_INPUTS,
  type QualificationInput,
  type QualificationInputId,
  type QualificationReadiness,
} from "../../shared/schema/review/proof";
import { QUALIFICATION_FOUNDATION_INCOMPLETE } from "./qualification-binding";

export { QUALIFICATION_REQUIRED_INPUTS };

/** One input as a caller reports it, before the readiness owner normalizes it. */
export interface QualificationInputClaim {
  id: QualificationInputId;
  state: "present" | "missing" | "unknown";
  evidence?: QualificationInput["evidence"];
}

/** The sentence every refusal of a real proof starts with. */
export const QUALIFICATION_REFUSED_BEFORE_EFFECTS = "qualification proof mode is refused before any effect";

/**
 * The readiness set for a submit that has no external supplier wired: every
 * required input is missing, in its declared order, with no evidence attached.
 * Nothing here is invented on the reviewer's or the operator's behalf.
 */
export function missingQualificationReadiness(): QualificationReadiness {
  return { inputs: QUALIFICATION_REQUIRED_INPUTS.map(required => ({ id: required.id, state: "missing" as const, evidence: null })) };
}

/**
 * Normalize a supplier's claims onto the declared inventory. A required input
 * the caller did not mention is `missing`; a `present` claim without evidence
 * becomes `unknown`, because satisfaction without provenance is not
 * satisfaction; an unknown id refuses.
 */
export function qualificationReadiness(claims: readonly QualificationInputClaim[]): QualificationReadiness {
  const byId = new Map<QualificationInputId, QualificationInputClaim>();
  for (const claim of claims) {
    if (!QUALIFICATION_REQUIRED_INPUTS.some(required => required.id === claim.id))
      throw new Error(`The readiness set names ${String(claim.id)}, which is not a required qualification input`);
    if (byId.has(claim.id)) throw new Error(`The readiness set names ${claim.id} twice`);
    byId.set(claim.id, claim);
  }
  return {
    inputs: QUALIFICATION_REQUIRED_INPUTS.map(required => {
      const claim = byId.get(required.id);
      if (!claim) return { id: required.id, state: "missing" as const, evidence: null };
      if (claim.state === "present" && !claim.evidence) return { id: required.id, state: "unknown" as const, evidence: null };
      return { id: required.id, state: claim.state, evidence: claim.state === "present" ? claim.evidence ?? null : null };
    }),
  };
}

/** The requirement sentence one input id carries. */
export function qualificationInputRequirement(id: QualificationInputId): string {
  return QUALIFICATION_REQUIRED_INPUTS.find(required => required.id === id)!.requirement;
}

/**
 * The named missing-input refusal. It lists every input that is not `present`
 * with provenance — missing and unknown alike — so the operator sees which
 * supplier owes what rather than one opaque "mode unavailable".
 */
export function qualificationReadinessRefusal(readiness: QualificationReadiness | null | undefined, what = "real qualification proof mode"): string | null {
  if (!readiness) {
    return `${QUALIFICATION_REFUSED_BEFORE_EFFECTS}: ${what} has no readiness set, and no required external input may be assumed; `
      + `${QUALIFICATION_REQUIRED_INPUTS.length} inputs are unsupplied (${QUALIFICATION_REQUIRED_INPUTS.map(required => required.id).join(", ")})`;
  }
  const unsatisfied = readiness.inputs.filter(input => input.state !== "present");
  if (!unsatisfied.length) return null;
  const namedMissing = unsatisfied.filter(input => input.state === "missing");
  const namedUnknown = unsatisfied.filter(input => input.state === "unknown");
  const parts = [
    `${namedMissing.length} missing (${namedMissing.map(input => input.id).join(", ") || "none"})`,
    `${namedUnknown.length} unverified (${namedUnknown.map(input => input.id).join(", ") || "none"})`,
  ];
  return `${QUALIFICATION_REFUSED_BEFORE_EFFECTS}: ${what} needs ${readiness.inputs.length} external inputs and ${unsatisfied.length} are not established: `
    + `${parts.join("; ")}. The mode never synthesizes the clock, provider evidence, waits, censuses or closure`;
}

/** Whether every required input is present with its provenance. */
export function qualificationReady(readiness: QualificationReadiness | null | undefined): boolean {
  return Boolean(readiness) && readiness!.inputs.every(input => input.state === "present" && input.evidence !== null);
}

/** The staged-refusal string stays exported so an old reader still sees one prefix. */
export { QUALIFICATION_FOUNDATION_INCOMPLETE };
