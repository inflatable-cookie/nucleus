/**
 * How a recorded task event reads: its kind in words, the actor its detail
 * names, and the bounded detail line. The event contract (`eventSchema` in
 * `shared/schema/state.ts`) carries a kind and a detail string and no actor
 * column, so the actor is a reading of the recorded detail, never a fact the
 * row carries; this module is the one place that reading happens, and it says
 * plainly when the detail names nobody. Removing the reading would need an
 * actor field on the stored event, which is a protocol change and not this
 * module's.
 */

/** How much of one event detail the Activity summary quotes before the raw record. */
export const EVENT_DETAIL_SUMMARY_LIMIT = 180;

/**
 * Stage mechanics and setup chatter: the Activity tab keeps these behind its
 * technical disclosure so the human events lead.
 */
export const lowValueActivityKinds: ReadonlySet<string> = new Set([
  "telemetry_stage",
  "pre_merge_candidate_intent",
  "pre_merge_candidate_created",
  "pre_merge_warm_candidate_fallback",
  "pre_merge_warm_candidate_created",
  "pre_merge_warm_candidate_missing",
]);

/** Events keep their original kind and payload; this label is only the human-facing summary. */
export function eventKindLabel(kind: string): string {
  return kind.replaceAll("_", " ").replace(/(^|\s)\w/g, value => value.toUpperCase());
}

/**
 * The actor an event's recorded detail names. Only a detail that names one
 * yields `named`; an event whose writer recorded no name stays `unrecorded`
 * rather than borrowing the kind or an empty label.
 */
export type EventActorFact = { kind: "named"; actor: string } | { kind: "unrecorded" };

/** The detail readings that name an actor, in the order the first writer's wording is tried. */
const actorPatterns = [
  /\b(?:answered|assigned|submitted|recorded) by ([^;,:.]+)/i,
  /^Origin: ([^;]+)/i,
  /^Worker ([^ ]+) registered/i,
];

export function eventActorFact(detail: string): EventActorFact {
  // The first pattern that matches decides, as it always has: a pattern that
  // matched without naming anybody leaves the actor unrecorded rather than
  // falling through to a later reading of the same detail.
  const match = actorPatterns.map(pattern => pattern.exec(detail)).find(found => found !== null) ?? null;
  const named = match?.[1]?.trim();
  return named ? { kind: "named", actor: named } : { kind: "unrecorded" };
}

/** The detail line the Activity summary quotes; the complete record stays behind its disclosure. */
export function eventDetailSummary(detail: string): string {
  return detail.length <= EVENT_DETAIL_SUMMARY_LIMIT ? detail : `${detail.slice(0, EVENT_DETAIL_SUMMARY_LIMIT)}…`;
}
