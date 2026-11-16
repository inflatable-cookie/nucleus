/**
 * The retained worker's own profile becoming disabled or unavailable is one fact
 * the queue records and reads in several mechanisms: revision dispatch parks the
 * task on it, retry admission asks the operator, coordinator escalation hands it
 * over, the attention notice offers the remap, and the recovery park predicate
 * reads the recorded events. The fact used to be a constant in a schema module
 * that five core sites matched with `startsWith` themselves.
 *
 * It is still recorded as task reason text (Task.reason is free text by
 * contract), so this owner holds the one text and the one prefix read. Every
 * caller decides from `isRetainedProfileReason`; none of them repeats the match.
 * A typed reason kind at write time would be a behaviour change, not a
 * structural one, and is recorded as a follow-up instead.
 */
export const RETAINED_WORKER_PROFILE_REASON = "Retained worker profile is disabled or unavailable";

/** Whether a recorded task reason or event detail is the retained-profile park. */
export function isRetainedProfileReason(text: string | null | undefined): boolean {
  return typeof text === "string" && text.startsWith(RETAINED_WORKER_PROFILE_REASON);
}

/** The park's recorded reason text: the retained-profile fact and the issue that raised it. */
export function retainedProfileReason(issue: string): string {
  return `${RETAINED_WORKER_PROFILE_REASON}: ${issue}`;
}
