/**
 * Spec 064 P1: the one owner of a qualification record's canonical identity.
 *
 * It lives in `core` rather than beside the schemas because it hashes: the
 * plugin client loads `shared/schema/review/proof.ts`, and no shared module the
 * client loads may import a Node module. Every producer and every re-reader
 * computes the same digest from the same owner, so a subject or an effective
 * environment cannot be reinterpreted to match.
 */
import { createHash } from "node:crypto";
import type { QualificationExecution, QualificationSubject } from "../../shared/schema/review/proof";

/**
 * Canonical JSON for one qualification record: object keys sorted at every
 * depth, no whitespace, arrays in their recorded order. Two readers that hold
 * the same values always compute the same digest, and one that holds different
 * values never does.
 */
export function qualificationCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => qualificationCanonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${qualificationCanonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The canonical digest of one qualification record. */
export function qualificationDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(qualificationCanonicalJson(value)).digest("hex")}`;
}

/** The subject's canonical digest: the attempt's identity against every re-read. */
export function qualificationSubjectDigest(subject: QualificationSubject): string {
  return qualificationDigest(subject);
}

/** The execution's canonical digest, or null while no command is bound. */
export function qualificationExecutionDigest(execution: QualificationExecution | null | undefined): string | null {
  return execution ? qualificationDigest(execution) : null;
}

/**
 * Spec 064 P1: the canonical digest of one run's **effective environment
 * values**, not their names. A secret per-launch variable is recorded as a key
 * only and never enters this digest.
 */
export function qualificationEnvironmentDigest(values: Record<string, string>): string {
  const pairs = Object.keys(values).sort().map(key => [key, values[key]!] as const);
  return qualificationDigest(pairs);
}
