import type { Completion } from '../../../shared/contracts';
import { digest } from '../../store/store';

/**
 * One blocker cause, stable across re-reports of the same words. Every cause the
 * ladder opens a consult or escalation for is one of these identities, so a repeat
 * of the same block joins the earlier episode instead of starting another.
 */

/** One blocker cause, stable across re-reports of the same words. */
const normalizeCause = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 2000);

/** Stable identity of one blocker cause on one task: the same cause joins one escalation. */
export const blockerCauseId = (
  taskId: string,
  completion: Pick<
    Completion,
    "status" | "summary" | "sourceApproved" | "awaitingProofs"
  >,
): string =>
  digest(
    [
      "blocker-cause",
      taskId,
      completion.status,
      normalizeCause(completion.summary),
      completion.sourceApproved ? "source-approved" : "",
      (completion.awaitingProofs ?? []).length,
    ].join(":"),
  );

/** Stable identity of one revision-cap escalation: every cap park is its own episode. */
export const revisionCapCauseId = (
  taskId: string,
  revisionRuns: number,
): string =>
  digest(
    ["blocker-cause", taskId, "revision_cap", String(revisionRuns)].join(":"),
  );

/** Stable identity of one reviewer-checkpoint stop; the same cause joins one escalation. */
export const reviewContinuationCauseId = (
  taskId: string,
  state: "exhausted" | "closed",
): string =>
  digest(["blocker-cause", taskId, "review_continuation", state].join(":"));

/** A provider failure is never a ladder blocker: the ordinary replacement settles it. */
export const isProviderFailure = (
  completion: Pick<Completion, "providerUnavailable">,
): boolean => completion.providerUnavailable === true;
