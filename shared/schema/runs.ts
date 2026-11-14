import { z } from "zod";
import { briefDigestSchema, laneDocumentRefSchema } from "./briefs";
import { hostSelectionSchema } from "../host-selection";
import { taskPhaseSchema } from "../schema/task-primitives";
import { pausedStopSchema, siblingPinSchema } from "./workspace";
import { completionSchema, mechanicalReviewProofSchema, rejectedReviewReadingSchema, reviewCheckpointRecordSchema, reviewContinuationIntentSchema, reviewDeliveryAuthorizationSchema } from "./review";
import { profileSchema } from "./settings";

/** Durable bounded retry state for provider errors that can recover in the same thread. */
export const transientProviderRetrySchema = z.object({
  runId: z.string(),
  resumes: z.number().int().min(0).max(4),
  status: z.enum(["waiting", "intent", "sent", "uncertain", "exhausted"]),
  error: z.string().max(2000),
  retryAt: z.string().nullable(),
  messageId: z.string().nullable(),
  resumedAt: z.string().nullable(),
  observedUpdatedAt: z.string().nullable(),
  sawProgress: z.boolean(),
}).strict();

export type TransientProviderRetry = z.infer<typeof transientProviderRetrySchema>;

/**
 * History only: no run gets a new view. Stored rows still parse, and a done task's
 * unarchived view still goes through the terminal archive and blocks retention.
 */
export const reviewSourceViewSchema = z.object({
  // workspaceId is Paseo's caller-selected wks_ ID; a legacy row carries the raw creation UUID, which Paseo always refused.
  creationId: z.string().uuid(), workspaceId: z.string().regex(/^wks_[a-f0-9]{16}$/).or(z.string().uuid()), runId: z.string().uuid(),
  sourceWorkspaceId: z.string(), sourceDirectory: z.string(),
  receiptOperationId: z.string().nullable(), receiptAt: z.string(),
  /**
   * Legacy views may retain external-owner-receipt provenance; new review-entry
   * views bind to the immutable accepted intake record instead. Old rows default
   * to the receipt kind, and `intakeOperationId` stays null for them.
   */
  provenance: z.enum(['external_owner_receipt','review_entry_intake']).optional(),
  intakeOperationId: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  head: z.string().regex(/^[a-f0-9]{40}$/), tree: z.string().regex(/^[a-f0-9]{40}$/),
  commonDir: z.string(), origin: z.string(), branch: z.string(),
  directory: z.string().nullable(), state: z.enum(['intent','ready','uncertain']), agentCreationIntent: z.boolean(),
  briefDigest: briefDigestSchema.nullable(), briefVersion: z.number().nullable(),
}).strict();

export type ReviewSourceView = z.infer<typeof reviewSourceViewSchema>;

/**
 * Spec 058 slice 1: usage Queue observed on one run's agent stream. Raw counts and
 * observed wall time only; effective tokens are derived in telemetry. `partial` marks a
 * gap Queue could not observe (a lost or restored stream, a turn that began before Queue
 * subscribed, or a run opened after a restart), so totals never read as complete.
 */
export const runUsageSchema = z.object({
  turns: z.number().int().nonnegative().default(0),
  reportedTurns: z.number().int().nonnegative().default(0),
  inputTokens: z.number().nonnegative().default(0),
  cachedInputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  wallMs: z.number().nonnegative().default(0),
  peakContextTokens: z.number().nonnegative().nullable().default(null),
  lastTurnId: z.string().nullable().default(null),
  openTurnId: z.string().nullable().default(null),
  openTurnAt: z.string().nullable().default(null),
  partial: z.boolean().default(false),
}).strict();

export type RunUsage = z.infer<typeof runUsageSchema>;

export const runSchema = z.object({
  hostSelection: hostSelectionSchema.optional(),
  /** Host selected when this run was created; absent on legacy runs. */
  hostId: z.string().min(1).optional(),
  /** Queue-owned temporary root recorded before a fresh agent is launched. */
  temporaryDirectory: z.string().max(2000).optional(),
  reviewSourceView: reviewSourceViewSchema.optional(),
  ordinaryDetached: z.literal(true).optional(),
  priorRunId: z.string().optional(),
  priorHead: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  retainedRounds: z.number().int().min(0).max(3).optional(),
  reviewDelta: z.string().optional(),
  /** Queue 524: bounded pointer to author evidence posted as PR issue comments (never bodies); rendered in the reviewer prompt. */
  authorEvidence: z.string().optional(),
  proofOnly: z.literal(true).optional(),
  /**
   * Spec 058 (task 533): this reviewer turn is the one clean-environment retry
   * of checks that faulted before any assertion in the previous turn.
   */
  proofRetry: z.object({
    forRunId: z.string().min(1).max(160), head: z.string().regex(/^[a-f0-9]{40}$/),
    proofs: z.array(z.string().trim().min(1).max(2000)).min(1).max(40),
  }).strict().optional(),
  // `verification` is retired (nucleus#765): stored rows parse, and nothing launches one.
  id: z.string(), taskId: z.string(), role: z.enum(["reviewer", "revision", "verification", "closeout", "recovery", "executor"]),
  /** Task 405: the immutable subject bound to this proof-only run. */
  proofExecution: z.object({
    selector: z.string().trim().min(1).max(2000),
    inputs: z.array(z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/)).default([]),
    prNumber: z.number().int().positive().nullable().default(null), tree: z.string().regex(/^[a-f0-9]{40}$/),
    operationId: z.string().min(1).max(160).nullable().default(null),
    briefVersion: z.number().int().positive().nullable().default(null), briefDigest: z.string().nullable().default(null),
    goEvidence: z.object({
      questionId: z.string().min(1), decisionId: z.string().nullable(), question: z.string().min(1), answer: z.string().min(1),
      answeredBy: z.string().min(1), quote: z.string().nullable(), askedAt: z.string(), answeredAt: z.string(),
    }).strict().optional(),
    returnPhase: taskPhaseSchema,
    authorizedBy: z.object({ role: z.enum(['project_owner', 'operator', 'authorized_relay', 'delegated', 'queue_dispatch']), caller: z.string().nullable().default(null), note: z.string().nullable().default(null) }).strict(),
  }).strict().optional(),
  generation: z.number(), head: z.string(), base: z.string(), agentId: z.string().nullable(), workspaceId: z.string(),
  instruction: z.string().max(12000).nullable().optional(),
  /**
   * The authorized identity-confirmation intent `adoptReplacementPr` armed on the
   * task for this exact recovered PR. The reservation consumes the task flag, so
   * the delivered prompt renders this read-only intent from the run rather than
   * from the task's now-cleared state. Absent on every ordinary run.
   */
  identityConfirmation: z.literal(true).optional(),
  // A retry may carry the latest accepted blocked result as diagnostic context.
  // It is separate from the continuation instruction, which is the only action source.
  retryContext: z.object({
    source: z.enum(["worker", "revision"]), runId: z.string(), status: z.enum(["blocked", "error"]),
    head: z.string().nullable(), summary: z.string().max(12000),
  }).strict().optional(),
  // Spec 039: one operator reason bound to exactly one fresh reviewer run.
  reviewReason: z.string().trim().min(1).max(4000).nullable().optional(),
  // The Queue-held brief version this run was given; absent for handoff-mode tasks.
  briefVersion: z.number().int().positive().nullable().optional(),
  // The lane document versions this run was given; absent when the task links none.
  laneDocuments: z.array(laneDocumentRefSchema).optional(),
  // The sibling worktree pins this run was given, as recorded on the task.
  siblings: z.array(siblingPinSchema).optional(),
  revisionCause: z.enum(["review", "pre_merge", "administrative", "continuation", "non_delivery", "unfinished", "consult"]).optional(),
  // Spec 033: this reviewer publishes a formal GitHub review under the repository's reviewer identity.
  formalReview: z.boolean().optional(),
  // Present only on the one explicit ordinary-task mechanical proof review.
  mechanicalReviewProof: mechanicalReviewProofSchema.optional(),
  profileGroup: z.string().nullable().optional(), exhaustionReason: z.string().optional(),
  transientProviderRetry: transientProviderRetrySchema.optional(),
  // Spec 044: immutable reviewer progress history and its delivery authorizations.
  reviewCheckpoints: z.array(reviewCheckpointRecordSchema).optional(),
  reviewDeliveries: z.array(reviewDeliveryAuthorizationSchema).optional(),
  /** When Queue rejected a checkpoint past the per-task budget; the reviewer has stopped and the owner decides. */
  reviewBudgetExhaustedAt: z.string().optional(),
  /** Readings refused past the checkpoint allowance, kept as evidence in arrival order. */
  reviewRejectedReadings: z.array(rejectedReviewReadingSchema).optional(),
  /**
   * When Queue positively observed this run's own agent closed in its workspace,
   * with no active turn or pending permission. The retained-agent checkpoint
   * continuation is impossible from then on, so `next` offers the fresh-review
   * recovery instead. The lease, checkpoints, credential and callback stay as
   * they are: only the owner's existing verb settles the run.
   */
  retainedAgentClosedAt: z.string().optional(),
  /** When an owner control replaced this reviewer with another; its verdict at the exact head may still finish the review. */
  replacedAt: z.string().optional(),
  // Retired legacy continuation: nothing writes these; old records still parse. An unsettled one fails closed on reviewer delivery.
  reviewContinuation: reviewContinuationIntentSchema.nullable().optional(),
  reviewContinuations: z.number().int().nonnegative().optional(),
  // New review intents require explicit responsibility for a non-approval outcome.
  reviewResponsibilityRequired: z.boolean().optional(),
  /** Queue #650: this run's active turn was stopped while Queue was paused (unresolved until it resumes). */
  pausedStop: pausedStopSchema.optional(),
  profile: profileSchema.nullable(), status: z.enum(["intent", "running", "stopped", "finished", "superseded", "uncertain"]),
  createdAt: z.string(), lastObservedAt: z.string().nullable(), active: z.boolean().nullable(), idleSince: z.string().nullable(),
  completion: completionSchema.nullable(), released: z.boolean(),
  /** Spec 058 slice 1: usage observed on this run's agent; absent until Queue observes a turn. */
  usage: runUsageSchema.optional(),
});

export type Run = z.infer<typeof runSchema>;

export const noticeSchema = z.object({
  id: z.string(), taskId: z.string(), agentId: z.string(), text: z.string(),
  status: z.enum(["pending", "intent", "delivered", "uncertain", "superseded"]), error: z.string(),
  // `owner_change` has no writer or delivery; it stays so historical rows parse.
  kind: z.enum(["attention", "completion", "hold", "hold_release", "host_outage", "lane_drain", "next_aim", "owner_change", "prerequisite", "qa"]).default("attention"),
  recipientAgentId: z.string().default(""), workspaceId: z.string().nullable().default(null),
  sources: z.array(z.enum(["origin", "creator", "self"])).default([]), originEntry: z.boolean().default(true),
});

export type Notice = z.infer<typeof noticeSchema>;
