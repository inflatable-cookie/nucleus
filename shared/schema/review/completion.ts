import { z } from "zod";
import { laneDocumentRefSchema, type LaneDocumentRef } from "../briefs";
import {
  recoveryActionSchema,
  retiredNarrowCoordinatorActions,
} from "../task-common";
import { REPORT_HEADLINE_STORED_MAX } from "../../task-detail-summary";
import { reviewVerdictListSchema, reviewedInputListSchema } from "./evidence";

/**
 * The callback a run reports its outcome with: the one status vocabulary, the
 * structured cause, the report's own fields, the bounded reviewer checkpoint and
 * the coordinator's one intent-level action. The order of the fields is part of
 * the completion's identity: `digest(JSON.stringify(completion))` keys the
 * receipt, so fields stay in their recorded positions.
 */

export const completionStatusSchema = z.enum([
  "ready_for_review",
  "report_ready",
  "progress_checkpoint",
  "review_in_progress",
  "ready_to_merge",
  "changes_required",
  "verified",
  "proof_executed",
  "closed",
  "blocked",
  "error",
  "recovered",
  "escalate",
]);

export type CompletionStatus = z.infer<typeof completionStatusSchema>;

export const coordinatorActionSchema = z.discriminatedUnion("verb", [
  // nucleus#1195: `executor` is the proof-execution re-report continuation, never a route role.
  z
    .object({
      verb: z.literal("restart"),
      role: z
        .enum(["worker", "reviewer", "coordinator", "executor"])
        .optional(),
      instruction: z.string().trim().min(1).max(12000).optional(),
      fresh: z.boolean().optional(),
      reason: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      verb: z.literal("route"),
      role: z.enum(["worker", "reviewer", "coordinator"]),
      profileId: z.string().trim().min(1).max(240),
      thinkingOptionId: z.string().optional(),
      now: z.boolean().optional(),
      reason: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      verb: z.literal("move"),
      to: z.enum(["work", "review", "merge", "closeout"]),
      instruction: z.string().trim().min(1).max(12000).optional(),
      fresh: z.boolean().optional(),
      force: z.boolean().optional(),
      reason: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      verb: z.literal("retry_effect"),
      effect: z.string().trim().min(1).max(240).optional(),
      force: z.boolean().optional(),
      reason: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      verb: z.literal("cannot"),
      reason: z.string().trim().min(1).max(4000),
    })
    .strict(),
  // nucleus#1388: the explicit no-action observation — the coordinator found the
  // participant live and progressing, so there is nothing to apply. `reason` says
  // who is live. It settles the episode as observed and is never a retired shape.
  z
    .object({
      verb: z.literal("none"),
      reason: z.string().trim().min(1).max(4000),
    })
    .strict(),
  // Retired narrow actions, kept parse-only for stored rows the recovery pass must
  // refuse as retired with the owner verb that replaced them. Intake refuses a new
  // report naming one by name (nucleus#1388).
  z
    .object({
      verb: z.enum(retiredNarrowCoordinatorActions),
      reason: z.string().trim().min(1).max(4000),
    })
    .strict(),
]);

export type CoordinatorAction = z.infer<typeof coordinatorActionSchema>;

/**
 * Spec 058 (task 533): who can produce a proof a reviewer named. The tag picks
 * the route only and never grants approval. `environment` is the reviewer's own
 * run faulting before any assertion (one clean retry, then external); `author`
 * is evidence the author produces at the head; `external` is native hardware,
 * another project's consumer verification or a post-merge proof.
 */
export const proofRouteSchema = z.enum(["author", "environment", "external"]);

export type ProofRoute = z.infer<typeof proofRouteSchema>;

/** A named awaiting proof: bare text (today's untagged form) or text with its route. */
export const awaitingProofSchema = z.union([
  z.string().trim().min(1).max(2000),
  z
    .object({
      proof: z.string().trim().min(1).max(2000),
      route: proofRouteSchema,
    })
    .strict(),
]);

export type AwaitingProof = z.infer<typeof awaitingProofSchema>;

export const completionBaseSchema = z
  .object({
    eventId: z.string().min(1).max(160),
    taskId: z.string().min(1),
    runId: z.string().min(1),
    status: completionStatusSchema,
    summary: z.string().min(1).max(12000),
    /** Structured report classification; legacy callbacks without it use the compatibility fallback. */
    cause: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("external"),
            name: z.string().trim().min(1).max(160),
          })
          .strict(),
        z.object({ kind: z.enum(["internal", "unfinished"]) }).strict(),
      ])
      .optional(),
    /**
     * The concrete failure behind a `blocked` or `error` report: the command or
     * provider message. Its presence is the worker's own statement that it hit an
     * impediment; its absence on a blocked/error return with no new commit makes
     * Queue continue the same worker instead of starting recovery.
     */
    impediment: z.string().trim().min(1).max(4000).optional(),
    /** The exact Queue lane document delivered by a report-only worker. */
    artifact: laneDocumentRefSchema.optional(),
    /**
     * Task 538: the report's one-line headline — what happened and what is next, in
     * plain language — shown on the board card and at the head of the task detail.
     * Accepted reports always carry one: Queue derives it from the first sentence of
     * the summary when a caller omits it, and older stored reports fall back to the
     * same sentence when read.
     */
    headline: z
      .string()
      .trim()
      .min(1)
      .max(REPORT_HEADLINE_STORED_MAX)
      .optional(),
    sourceApproved: z.literal(true).optional(),
    /** Spec 058 (task 533): each named proof carries the route that can produce it. */
    awaitingProofs: z.array(awaitingProofSchema).min(1).max(40).optional(),
    // Spec 044: who owns an unresolved review outcome; never inferred from verdict text.
    reviewResponsibility: z
      .enum(["author", "reviewer", "environment"])
      .optional(),
    prNumber: z.number().int().positive().optional(),
    head: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    providerUnavailable: z.boolean().optional(),
    providerRetryAt: z.string().datetime({ offset: true }).optional(),
    reviewCommentId: z.number().int().positive().optional(),
    // Spec 033: a formal GitHub review's id, kept distinct from a PR comment id.
    reviewId: z.number().int().positive().optional(),
    reviewText: z.string().trim().min(1).max(48000).optional(),
    // Spec 037: the reviewer's structured judgments, stored with the review record.
    verdicts: reviewVerdictListSchema.optional(),
    // Exact bytes the original reviewer declared they relied on. The mechanical
    // review carry that consumed this receipt is retired; old records stay readable.
    reviewedInputs: reviewedInputListSchema.optional(),
    closeoutCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    replacementAgentId: z.string().min(1).optional(),
    /** Retired (Spec 050): stored completions keep it, and a new report carrying it is refused by name. */
    recoveryAction: recoveryActionSchema.optional(),
    /** Spec 050: the coordinator's one intent-level action for this stop. */
    coordinatorAction: coordinatorActionSchema.optional(),
    coordinatorGeneration: z.number().int().positive().optional(),
  })
  .strict();

export function refineCoordinatorCompletionAction(
  value: {
    status: CompletionStatus;
    coordinatorAction?: CoordinatorAction;
    artifact?: LaneDocumentRef;
    impediment?: string;
  },
  context: z.RefinementCtx,
) {
  if (
    value.impediment !== undefined &&
    !["blocked", "error"].includes(value.status)
  )
    context.addIssue({
      code: "custom",
      path: ["impediment"],
      message: "An impediment is only valid for a blocked or error report",
    });
  if (value.status === "report_ready" && !value.artifact)
    context.addIssue({
      code: "custom",
      path: ["artifact"],
      message: "report_ready requires its exact lane document artifact",
    });
  if (value.status !== "report_ready" && value.artifact)
    context.addIssue({
      code: "custom",
      path: ["artifact"],
      message: "An artifact is only valid for report_ready",
    });
  if (
    value.coordinatorAction?.verb === "cannot" &&
    !["blocked", "error"].includes(value.status)
  )
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "A coordinator unable report uses blocked or error",
    });
  if (
    value.coordinatorAction &&
    value.coordinatorAction.verb !== "cannot" &&
    value.status !== "recovered"
  )
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "A coordinator owner verb or no-action report uses recovered",
    });
}

export const completionSchema = completionBaseSchema.superRefine(
  refineCoordinatorCompletionAction,
);

export type Completion = z.infer<typeof completionSchema>;
