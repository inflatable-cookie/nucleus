import type { HookRecord } from "../../shared/hooks";

/**
 * The one owner of the refusal kinds Queue's own control flow distinguishes on a
 * hook occurrence.
 *
 * A recorded occurrence keeps its human-readable error text for the operator,
 * but no reader decides anything from that text: the decoded kind is persisted
 * beside the text (`HookRecord.refusalKind`) at the single write site that sets
 * an error, and consumers read the field. History recorded before the field
 * existed (a live database is never rewritten) is decoded here, once, so the
 * text form lives in exactly one place.
 */

/** The closed set of refusal kinds Queue distinguishes. */
export type HookRefusalKind = "stale_base";

/**
 * The refusal a required integration write reports when its pinned integration
 * base is no longer the clean synchronized head. The wrapper program writes this
 * prefix; the occurrences describe the same operational fact from different
 * angles ("HEAD moved", "local base differs", "not on the base branch").
 */
export const STALE_INTEGRATION_BASE_PROOF = "Integration write requires a clean synchronized base:";
/**
 * Every recorded sentence that means an occurrence's pinned base went *stale*
 * rather than wrong. verifyCleanSynchronizedBase refuses on these exact three
 * conditions, and the integration-write wrapper restates them under
 * {@link STALE_INTEGRATION_BASE_PROOF}. A dirty checkout or one on the wrong
 * branch is a configuration fault, not staleness, and stays parked for a human.
 * The list is closed: a new staleness condition is a new decoder case here, not
 * another substring at a call site.
 */
const STALE_INTEGRATION_BASE_REFUSALS = [
  STALE_INTEGRATION_BASE_PROOF,
  "Integration HEAD moved from the event base",
  "Local integration base differs from origin",
] as const;

/**
 * Decode one refusal text into its closed kind once. Null is an ordinary
 * semantic refusal: the hook found something wrong with the change, not with
 * the base it was pinned to.
 */
export function hookRefusalKind(error: unknown): HookRefusalKind | null {
  const text = String(error ?? "");
  if (!text) return null;
  return STALE_INTEGRATION_BASE_REFUSALS.some(refusal => text.includes(refusal)) ? "stale_base" : null;
}

/**
 * True when a recorded occurrence refused only because its pinned integration
 * base went stale. The typed field wins; the single decoder covers occurrences
 * recorded before the field existed.
 */
export function isStaleBaseRefusal(record: Pick<HookRecord, "refusalKind" | "error">): boolean {
  return record.refusalKind ? record.refusalKind === "stale_base" : hookRefusalKind(record.error) === "stale_base";
}

/** True when a loose refusal error text or value is the stale-base class. */
export const isStaleIntegrationBaseRefusal = (error: unknown): boolean => hookRefusalKind(error) === "stale_base";
