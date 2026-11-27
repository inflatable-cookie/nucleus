import { z } from "zod";
import { MAX_REVIEW_VERDICTS } from "./evidence";

/**
 * The submission controls Nucleus retired, and their one refusal rule.
 *
 * Every retired control still parses so stored rows, frozen submission
 * identities and historical briefs keep loading without a migration; no new
 * submission may carry one. The *shapes* live here, and so does the rule that
 * refuses them, because the same refusal used to be written out again at intake
 * (`core/planning/submission.ts`), in the task funnel
 * (`core/store/store-task-funnel.ts`), in brief frontmatter
 * (`core/planning/handoff.ts`), in brief amendment (`core/verbs/brief.ts`) and in
 * review entry (`./entry.ts`). A caller names its surface; this module says what
 * is refused and why.
 *
 * The register of parse-only fields at this head, and the owner of each:
 * `submission.manualVerification`, `.responsible`, `.reviewVerdicts`,
 * `.reviewPassGate` and `.reviewContinuationIds` are declared as fields in
 * `./submission.ts` from the shapes below; `completion.recoveryAction` and
 * `completion.reviewedInputs` stay in `./completion.ts` for old reports;
 * `externalOwnerRevisionReceipt.reconciliation` stays inert in
 * `./acceptance.ts`; and `reviewEntryInput.workspaceMode` is retained in
 * `./entry.ts` so an old request receives a typed refusal.
 */

/** Retired Spec 037 brief opt-in shape, retained to parse historical rows. */
export const reviewVerdictsOptInSchema = z.union([
  z.boolean(),
  z.array(z.string().trim().min(1).max(120)).min(1).max(MAX_REVIEW_VERDICTS),
]);

export type ReviewVerdictsOptIn = z.infer<typeof reviewVerdictsOptInSchema>;

/** Retired Spec 037 pass-gate shape, retained to parse historical rows. */
export const reviewPassGateSchema = z.array(z.string().trim().min(1).max(120)).min(1).max(MAX_REVIEW_VERDICTS)
  .refine(ids => new Set(ids).size === ids.length, "Pass gate verdict ids must be unique");

export type ReviewPassGate = z.infer<typeof reviewPassGateSchema>;

/**
 * Retired with the automatic-review-loop concept (2026-10-07). No code reads it
 * any more; it stays bounded and unique so historical briefs keep amending.
 */
export const reviewContinuationIdsSchema = z.array(z.string().trim().min(1).max(120)).min(1).max(MAX_REVIEW_VERDICTS)
  .refine(ids => new Set(ids).size === ids.length, "Review continuation ids must be unique");

/** The retired controls each surface may carry, in the order they are reported. */
export interface RetiredSubmissionFields {
  responsible?: boolean;
  manualVerification?: boolean;
  reviewVerdicts?: unknown;
  reviewPassGate?: unknown;
}

/**
 * `submission` is a submission record: intake, the task funnel, review entry.
 * `frontmatter` is a brief's `queue:` block, whose messages name `queue.` fields
 * and their own replacement.
 */
export type RetiredSubmissionSurface = "submission" | "frontmatter";

export interface RetiredSubmissionRefusal {
  field: "responsible" | "manualVerification" | "reviewVerdicts" | "reviewPassGate";
  message: string;
}

const SUBMISSION_LIFECYCLE = "every task runs the responsible lifecycle";

const MESSAGES = {
  submission: {
    responsible: `responsible: false is no longer supported; ${SUBMISSION_LIFECYCLE}`,
    manualVerification: `manualVerification is no longer available; ${SUBMISSION_LIFECYCLE}`,
    reviewVerdicts: "reviewVerdicts and reviewPassGate are no longer available; state the outcome and acceptance in prose in the brief, and use mergeHold for a needed hold",
    reviewPassGate: "",
  },
  frontmatter: {
    responsible: `queue.responsible: false is no longer supported; ${SUBMISSION_LIFECYCLE}`,
    manualVerification: `queue.manualVerification is no longer available; ${SUBMISSION_LIFECYCLE}`,
    reviewVerdicts: "queue.reviewVerdicts is no longer available; state the outcome and acceptance in prose in the brief body, and use queue.mergeHold for a needed hold",
    reviewPassGate: "queue.reviewPassGate is no longer available; state the acceptance conditions in prose in the brief body, and use queue.mergeHold for a needed hold",
  },
} as const;

/** Every retired control this surface refuses, in submission field order. */
export function retiredSubmissionRefusals(
  fields: RetiredSubmissionFields,
  surface: RetiredSubmissionSurface,
): RetiredSubmissionRefusal[] {
  const messages = MESSAGES[surface];
  const refusals: RetiredSubmissionRefusal[] = [];
  if (surface === "submission") {
    if (fields.responsible === false) refusals.push({ field: "responsible", message: messages.responsible });
    if (fields.manualVerification === true) refusals.push({ field: "manualVerification", message: messages.manualVerification });
    if (fields.reviewVerdicts !== undefined || fields.reviewPassGate !== undefined)
      refusals.push({ field: "reviewVerdicts", message: messages.reviewVerdicts });
    return refusals;
  }
  if (fields.responsible === false) refusals.push({ field: "responsible", message: messages.responsible });
  if (fields.manualVerification === true) refusals.push({ field: "manualVerification", message: messages.manualVerification });
  if (fields.reviewVerdicts !== undefined) refusals.push({ field: "reviewVerdicts", message: messages.reviewVerdicts });
  if (fields.reviewPassGate !== undefined) refusals.push({ field: "reviewPassGate", message: messages.reviewPassGate });
  return refusals;
}

/** The first refusal a submission surface answers with, or null when it carries none. */
export function retiredSubmissionRefusal(fields: RetiredSubmissionFields): string | null {
  return retiredSubmissionRefusals(fields, "submission")[0]?.message ?? null;
}
