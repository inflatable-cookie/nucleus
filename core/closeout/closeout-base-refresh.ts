import type { HookRecord } from "../../shared/hooks";
import { isStaleBaseRefusal } from "../hooks/hooks";

/**
 * The one owner of the automatic re-pin of a stale closeout integration base.
 *
 * A closeout occurrence pins the commit its merge was verified at, and its
 * integration write must apply there. On a live board main moves constantly, so
 * the write is refused with the stale-base proof and the task parks. Re-pinning
 * is the same transition an owner's parked restart performs: resync the base and
 * let the authority run again. It is bounded per merge, so a base that keeps
 * moving parks for a human instead of looping.
 *
 * Both entry points - the closeout authority's own hold and the recovery sweep
 * that re-enters a parked closeout - read this rule. There is one event kind and
 * one limit; the budget counts from the merge the closeout belongs to.
 */

/** The one task-history kind that records an automatic re-pin of the closeout base. */
export const CLOSEOUT_BASE_RENEWED_KIND = "closeout_base_renewed";

/** Automatic re-pins of a closeout base allowed per merge; beyond this a human decides. */
export const CLOSEOUT_BASE_RENEWAL_LIMIT = 3;

/** The one transition an automatic re-pin performs, whatever entry point asked. */
export const CLOSEOUT_BASE_RENEWAL_TRANSITION = {
  phase: "syncing", reason: "Refreshing main before retrying closeout",
} as const;

/**
 * How many automatic re-pins this closeout has already spent. Events arrive
 * newest first, so the count stops at the merge that opened this closeout.
 */
export function closeoutBaseRenewalsSinceMerge(events: readonly { kind: string }[]): number {
  let renewals = 0;
  for (const event of events) {
    if (event.kind === "merge_verified") break;
    if (event.kind === CLOSEOUT_BASE_RENEWED_KIND) renewals += 1;
  }
  return renewals;
}

/**
 * Whether this held closeout may be re-pinned automatically. Only the
 * stale-integration-base class qualifies: a hook's own semantic refusal is a
 * finding and stays parked for a human, exactly as before.
 */
export function closeoutBaseRenewalAllowed(
  events: readonly { kind: string }[],
  record: Pick<HookRecord, "refusalKind" | "error"> | null | undefined,
): boolean {
  if (!record || !isStaleBaseRefusal(record)) return false;
  return closeoutBaseRenewalsSinceMerge(events) < CLOSEOUT_BASE_RENEWAL_LIMIT;
}
