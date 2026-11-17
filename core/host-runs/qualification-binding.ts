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
import { PROCESS_START_IDENTITY_ENV } from "../machine/process-identity-search";
import type { QualificationBinding, QualificationExecution, QualificationSubject } from "../../shared/schema/review/proof";

/**
 * The refusal every qualification mode entry shares until the later tranches
 * land their named missing-input refusal (brief amendment, 2026-11-16). It lives
 * with the binding's other identities so the detached supervisor, the dispatch
 * funnel and the plan owner all read one string.
 */
export const QUALIFICATION_FOUNDATION_INCOMPLETE = "qualification foundation incomplete";

/**
 * Spec 064 P1: the process-start marker a qualification attempt's direct command
 * inherits. Ordinary spawns choose a fresh random marker, which no binding could
 * cover; a qualifying spawn derives it from the immutable subject instead, so the
 * marker is one of the effective environment values the binding digests. The
 * environment variable is the same one the process owner overlays at spawn.
 */
export function qualificationProcessIdentity(subject: QualificationSubject): string {
  return `qualification:${qualificationSubjectDigest(subject)}`;
}

/** The environment entry that carries the marker, for the binding's effective values. */
export function qualificationProcessIdentityEnvironment(subject: QualificationSubject): Record<string, string> {
  return { [PROCESS_START_IDENTITY_ENV]: qualificationProcessIdentity(subject) };
}

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
 * Spec 064 P1: whether a launch's environment is still the execution the
 * qualification binding resolved. The launch owner builds the map with the same
 * environment owner the resolver used and adds the subject-derived start marker
 * beside it, so a missing marker, a changed value or a different key set is
 * refused before the plan is written or the supervisor is spawned.
 */
export function qualificationLaunchRefusal(launchEnv: Record<string, string>, binding: QualificationBinding): string | null {
  if (!binding.execution) return "The qualification binding names no execution; the launch is refused";
  const effective = { ...launchEnv, ...qualificationProcessIdentityEnvironment(binding.subject) };
  if (Object.keys(effective).sort().join("\u0000") !== binding.execution.environmentKeys.join("\u0000"))
    return "The effective environment keys no longer match the qualification binding";
  if (qualificationEnvironmentDigest(effective) !== binding.execution.environmentDigest)
    return "The effective environment values no longer match the qualification binding's digest";
  return null;
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
