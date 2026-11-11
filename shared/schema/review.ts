import { z } from "zod";
import { briefDigestSchema, briefInputSchema, draftProvenanceSchema, laneDocumentRefSchema, leadProvenanceSchema, planningSourceSchema, type LaneDocumentRef } from "./briefs";
import { instructionArtifactSchema, repoRelativePathSchema } from "../hooks";
import { dedupeReviewedInputs, reviewedInputListRefusals } from "../service/reviewed-inputs.mjs";
import { capabilityLevelSchema, completionAgentIdsSchema, profileRequestsSchema, profileSchema, scopeSchema, submissionRecordFromLegacy } from "./settings";
import { dependencyIdsSchema, holdKindSchema, laneKeyListSchema } from "../schema/task-primitives";
import { recoveryActionSchema, taskTitleSchema } from "./task-common";
import { REPORT_HEADLINE_STORED_MAX } from "../task-detail-summary";

/** Owner acceptance for the exact Queue lane document that completed a report-only task. */
export const reportAcceptanceSchema = z.object({
  /** The exact lane document an owner accepted, when the completion names one. */
  artifact: laneDocumentRefSchema.optional(),
  acceptedBy: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(4000),
  acceptedAt: z.string().datetime(),
  taskVersion: z.number().int().positive(),
  /** Spec 050 `complete`: an owner-completed no-PR outcome. Absent on report acceptances written before it. */
  kind: z.enum(["report_acceptance", "owner_completed"]).optional(),
}).strict();

export type ReportAcceptance = z.infer<typeof reportAcceptanceSchema>;

/**
 * Spec 037: one structured reviewer judgment. `id` is unique within a review and
 * stable across re-reviews of the same subject, so a published value can be tied
 * back to the verdict the reviewer recorded.
 */
export const reviewVerdictValueSchema = z.enum(["pass", "fail", "insufficient", "not_applicable"]);

export type ReviewVerdictValue = z.infer<typeof reviewVerdictValueSchema>;

export const MAX_REVIEW_VERDICTS = 500;

export const MAX_REVIEW_VERDICT_BYTES = 4 * 1024 * 1024;

export const reviewVerdictSchema = z.object({
  id: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(600),
  verdict: reviewVerdictValueSchema,
  evidence: z.string().trim().min(1).max(4000),
  note: z.string().trim().max(4000).optional(),
}).strict();

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/** Authenticated reviewer declaration of the exact repository inputs used for an approval. */
export const reviewedInputSchema = z.object({
  path: repoRelativePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ReviewedInput = z.infer<typeof reviewedInputSchema>;

/** One bounded `reviewedInputs` entry: exact files, a path summary or a digest summary. */
export type ReviewedInputEntry = ReviewedInput | { directory: string } | { glob: string } | { digest: string; count: number };

export type ReviewedInputList = ReviewedInputEntry[];

/**
 * Papercut 8647384e (2026-11-10): a verdict refused for a malformed entry became
 * a planner escalation twice (nucleus#1070 duplicate path, nucleus#1098 malformed
 * SHA-256). The list rule lives in `shared/service/reviewed-inputs.mjs`, which the
 * report schema and the `nucleus_report` bridge both read: a refusal names the
 * exact entry, field and expected shape, and a harmless duplicate is
 * de-duplicated instead of refused. Only entries that claim different content for
 * the same path still refuse.
 */
export const reviewedInputListSchema = z.array(z.unknown())
  .transform(rows => dedupeReviewedInputs(rows) as ReviewedInputList)
  .superRefine((rows, ctx) => {
    for (const issue of reviewedInputListRefusals(rows))
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });

export const factRelocationInputSchema = z.object({
  fromPath: repoRelativePathSchema.refine(path => path.startsWith("docs/") && path.endsWith(".md"), "Relocation source must be a Markdown file under docs/"),
  toPath: repoRelativePathSchema.refine(path => path.startsWith("docs/") && path.endsWith(".md"), "Relocation destination must be a Markdown file under docs/"),
  // This exact UTF-8 byte block must cover complete line-aligned content. Queue
  // proves unique source identity and exact destination/removal before reserving a reviewer.
  exactBlock: z.string().min(1).max(24000),
}).strict().refine(value => value.fromPath !== value.toPath, "Relocation source and destination must differ");

export type FactRelocationInput = z.infer<typeof factRelocationInputSchema>;

export const mechanicalReviewClassificationSchema = z.object({
  path: repoRelativePathSchema,
  kind: z.enum(["task", "incoming", "owning_document_union", "fact_relocation_source", "fact_relocation_destination"]),
  reviewedMode: z.string().nullable(), reviewedBlob: z.string().nullable(),
  incomingMode: z.string().nullable(), incomingBlob: z.string().nullable(),
  candidateMode: z.string().nullable(), candidateBlob: z.string().nullable(),
}).strict();

export const mechanicalReviewProofSchema = z.object({
  version: z.literal(1),
  originalReviewRunId: z.string().min(1), originalReviewEventId: z.string().min(1),
  originalReviewHead: z.string().regex(/^[a-f0-9]{40}$/), originalPublicationKind: z.enum(["review", "comment"]),
  originalPublicationId: z.number().int().positive(), candidateHead: z.string().regex(/^[a-f0-9]{40}$/),
  incomingBase: z.string().regex(/^[a-f0-9]{40}$/), commonAncestor: z.string().regex(/^[a-f0-9]{40}$/),
  mergeCommit: z.string().regex(/^[a-f0-9]{40}$/), proofScope: z.array(repoRelativePathSchema).min(1).max(8),
  relocations: z.array(z.object({ fromPath: repoRelativePathSchema, toPath: repoRelativePathSchema, blockSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(4),
  reviewedInputs: reviewedInputListSchema,
  taskScopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  classifications: z.array(mechanicalReviewClassificationSchema).max(512),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(proof => new TextEncoder().encode(JSON.stringify(proof)).byteLength <= 256 * 1024,
  "Mechanical review proof must be at most 256 KiB");

export type MechanicalReviewProof = z.infer<typeof mechanicalReviewProofSchema>;

/** A bounded verdict list whose ids are unique within the review. */
export const reviewVerdictListSchema = z.array(reviewVerdictSchema).max(MAX_REVIEW_VERDICTS)
  .refine(verdicts => new Set(verdicts.map(verdict => verdict.id)).size === verdicts.length, "Verdict ids must be unique within a review")
  .refine(verdicts => new TextEncoder().encode(JSON.stringify(verdicts)).byteLength <= MAX_REVIEW_VERDICT_BYTES, `Verdicts must be at most ${MAX_REVIEW_VERDICT_BYTES} bytes`);

/**
 * Retired Spec 037 brief opt-in shape, retained to parse historical rows.
 * New submissions refuse this field; it no longer gates reviewer reports.
 */
export const reviewVerdictsOptInSchema = z.union([
  z.boolean(),
  z.array(z.string().trim().min(1).max(120)).min(1).max(MAX_REVIEW_VERDICTS),
]);

export type ReviewVerdictsOptIn = z.infer<typeof reviewVerdictsOptInSchema>;

/**
 * Retired Spec 037 pass-gate shape, retained to parse historical rows.
 * New submissions refuse this field; it no longer gates review or merge.
 */
export const reviewPassGateSchema = z.array(z.string().trim().min(1).max(120)).min(1).max(MAX_REVIEW_VERDICTS)
  .refine(ids => new Set(ids).size === ids.length, "Pass gate verdict ids must be unique");

export type ReviewPassGate = z.infer<typeof reviewPassGateSchema>;

/**
 * Task 405: the immutable subject of one author-side proof execution. A brief
 * or handoff names exactly the selector an external author cannot run itself,
 * and the exact input hashes whose bytes the selector is allowed to consume.
 * The selector is executed by a Queue-created proof-only run on the same task;
 * it is not a stage, a reviewer and never source authorship.
 */
export const proofExecutionRequestSchema = z.object({
  /** The brief-named command, executed verbatim from the repository root. */
  selector: z.string().trim().min(1).max(2000),
  /** `sha256:<hex>` inputs pinned for this source head by the accepted brief version. */
  inputs: z.array(z.string().trim().regex(/^(?:sha256:)?[a-f0-9]{64}$/, 'Input hashes are sha256 digests')).max(64).default([]),
  /** Only author-side proof is in scope; a reviewer proof stays its own independent run. */
  role: z.literal('author').default('author'),
}).strict();

export type ProofExecutionRequest = z.infer<typeof proofExecutionRequestSchema>;

/** A qualification pinned to code already integrated on the base branch. */
export const proofOnlySchema = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict();

export type ProofOnly = z.infer<typeof proofOnlySchema>;

/** The authenticated result an executor reports for its one declared selector. */
export const proofExecutionResultSchema = z.object({
  status: z.enum(['passed', 'failed']),
  selector: z.string().trim().min(1).max(2000),
  exitCode: z.number().int().nullable().optional(),
  evidence: z.string().trim().max(4000).optional(),
}).strict();

export type ProofExecutionResult = z.infer<typeof proofExecutionResultSchema>;

/**
 * Task 405: one durable author-side proof execution on a task. It is append-only
 * evidence: the queue-created executor's own run, agent, model and workspace,
 * bound to the canonical source identities and the selector/input hashes it ran.
 * `stale` records source drift after a passing execution without erasing it.
 */
export const proofExecutionRecordSchema = z.object({
  runId: z.string().min(1), agentId: z.string().min(1).nullable().default(null), workspaceId: z.string().min(1),
  profile: z.lazy(() => profileSchema).nullable().default(null),
  operationId: z.string().min(1).max(160).nullable().default(null),
  selector: z.string().trim().min(1).max(2000),
  inputs: z.array(z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/)).default([]),
  repository: z.string().nullable().default(null), prNumber: z.number().int().positive().nullable().default(null),
  branch: z.string(), head: z.string().regex(/^[a-f0-9]{40}$/),
  briefVersion: z.number().int().positive().nullable().default(null), briefDigest: z.string().nullable().default(null),
  authorizedBy: z.object({ role: z.enum(['project_owner', 'operator', 'authorized_relay', 'delegated', 'queue_dispatch']), caller: z.string().nullable().default(null), note: z.string().nullable().default(null) }).strict(),
  activatedAt: z.string(), settledAt: z.string().nullable().default(null),
  status: z.enum(['running', 'passed', 'failed', 'unknown', 'stale']),
  /** Historical field; without start evidence older values were inferred. */
  refusedBeforeSelector: z.boolean().optional(),
  selectorStart: z.enum(['started', 'unknown']).optional(),
  selectorStartEvidence: z.string().max(4000).optional(),
  // Task 560: evidence recorded from a superseded run — its late report or its
  // timeline alone. It is history, never a pass: no closeout, review or merge
  // gate may credit it, whatever status it carries.
  historical: z.boolean().default(false),
  exitCode: z.number().int().nullable().optional(), evidence: z.string().max(4000).default(''),
}).strict();

export type ProofExecutionRecord = z.infer<typeof proofExecutionRecordSchema>;

export const proofOnlyResultSchema = z.object({
  status: z.enum(['passed','failed']), commit: z.string().regex(/^[a-f0-9]{40}$/), selector: z.string().min(1).max(2000),
  executionRunId: z.string().min(1), reviewerRunId: z.string().min(1), evidence: z.string().max(4000),
}).strict();

export type ProofOnlyResult = z.infer<typeof proofOnlyResultSchema>;

/** Operator acceptance preserves the failed qualification and identifies its exact receipt. */
export const proofReceiptAcceptanceSchema = z.object({
  acceptedBy: z.string().min(1), acceptedAt: z.string(), reason: z.string().trim().min(1).max(4000),
  authorization: z.object({ role: z.enum(["operator", "authorized_relay"]), note: z.string().nullable() }).optional(),
  runId: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/),
  selector: z.string().min(1).max(2000), inputs: z.array(z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/)),
  originalResult: proofOnlyResultSchema,
}).strict();

export type ProofReceiptAcceptance = z.infer<typeof proofReceiptAcceptanceSchema>;

/**
 * Spec 037: one immutable review record. It keeps the reviewer agent, run, head,
 * published review id and the reviewer's verdicts, so a later review appends its
 * own record and never rewrites an earlier one.
 */
export const reviewRecordSchema = z.object({
  runId: z.string().min(1), agentId: z.string().nullable().default(null),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.enum(["ready_to_merge", "changes_required"]),
  // Spec 033: a formal review and a comment carry separate ids; either may be absent pre-publication.
  reviewId: z.number().int().positive().nullable().default(null),
  reviewCommentId: z.number().int().positive().nullable().default(null),
  at: z.string(), verdicts: z.array(reviewVerdictSchema).default([]),
}).strict();

export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

/**
 * Qualified owner acceptance (orchestration contract, 2026-10-17): one durable
 * owner decision recorded through `move to=merge`. The task project's authorized
 * owner (or an operator ruling relayed with its note) accepts the reviewed PR at
 * the exact current head over the independent reviewer's disclosed findings. The
 * reviewer verdict, its publication and every historical record stay unchanged:
 * this record never rewrites a verdict, never counts as reviewer credit and
 * never classifies a finding as non-blocking. It binds the exact task, PR, head
 * and authentic review identities, and a later PR head invalidates it for merge
 * while its history remains.
 *
 * Operator source acceptance (2026-10-20, Tom's "Approve" on lead 87115b71):
 * `kind: "operator_source"` records the same authority accepting the exact
 * published source head AS IS when no review evidence binds that head — an
 * interrupted or unfinished reviewer, an unpublished verdict, or a head a
 * docs-only resolution moved after the verdict. It binds no review identity and
 * invents none; it records the concrete missing evidence beside the accepted
 * risk. It is history the moment the head changes, never inherited by a new
 * head.
 */
export const ownerAcceptanceRecordSchema = z.object({
  at: z.string(),
  /** What the acceptance binds. Absent parses as `reviewed`, so stored records keep loading unchanged. */
  kind: z.enum(["reviewed", "operator_source"]).default("reviewed"),
  /** The exact PR head accepted; a different current head leaves the record as history. */
  head: z.string().regex(/^[a-f0-9]{40}$/),
  prNumber: z.number().int().positive(),
  /** The authentic review a `reviewed` acceptance binds — a finished released reviewer verdict, never an approval minted for it. Null exactly for `operator_source`. */
  review: z.object({
    runId: z.string().min(1), eventId: z.string().min(1), head: z.string().regex(/^[a-f0-9]{40}$/),
    status: z.enum(["ready_to_merge", "changes_required"]),
    reviewId: z.number().int().positive().nullable(),
    reviewCommentId: z.number().int().positive().nullable(),
  }).strict().nullable(),
  actor: z.object({ agentId: z.string().min(1), role: z.enum(["project_owner", "operator", "authorized_relay", "delegated", "planner"]) }).strict(),
  authority: z.object({ kind: z.enum(["project_owner", "operator", "relayed_note", "delegated", "planner"]), note: z.string().max(4000).nullable() }).strict(),
  reason: z.string().trim().min(1).max(4000),
  /** The disclosed qualification the owner accepts over the reviewer findings, with any deferred work named. */
  qualification: z.string().trim().min(1).max(4000),
  /** `operator_source` only: the concrete review evidence Queue found missing at the accepted head. It records the accepted risk, never a check result. */
  missingEvidence: z.string().trim().min(1).max(4000).nullable().default(null),
}).strict();

export type OwnerAcceptanceRecord = z.infer<typeof ownerAcceptanceRecordSchema>;

export const submissionSchema = z.object({
  hostId: z.string().trim().min(1).max(240).optional(),
  submissionId: z.string().min(1).max(160), title: taskTitleSchema,
  repoPath: z.string().min(1), baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default("main"),
  // Exactly one instruction source: a committed handoff path, or a brief held by Queue (Spec 020).
  planningCommit: z.string().regex(/^[a-f0-9]{40}$/), handoffPath: z.string().default(""),
  brief: briefInputSchema.nullable().default(null),
  draftProvenance: draftProvenanceSchema.nullable().default(null),
  leadProvenance: leadProvenanceSchema.nullable().default(null),
  planningSource: planningSourceSchema.nullable().default(null),
  instruction: instructionArtifactSchema.nullable().default(null),
  originAgentId: z.string().min(1).max(240), coordinatorAgentId: z.string().max(240).default(""),
  scope: scopeSchema.default("general"),
  // Optional task complexity for capability-weighted selection; unset reproduces the previous order exactly.
  complexity: capabilityLevelSchema.nullable().optional(),
  preferredProfileId: z.string().default(""),
  skipPRReview: z.boolean().default(false),
  /** Spec 027: sibling worktrees of a multi-repository project are created by default; false skips them. */
  siblings: z.boolean().default(true),
  notifyOriginOnCloseout: z.boolean().default(false),
  completionNotificationAgentIds: completionAgentIdsSchema.default([]),
  profileRequests: profileRequestsSchema.optional(),
  dependsOn: dependencyIdsSchema.default([]),
  lanes: laneKeyListSchema.default([]),
  // Spec 026: lane documents the prompts carry, pinned at dispatch. Absent keeps legacy identity.
  laneDocuments: laneKeyListSchema.optional(),
  // Retired with the manual verification coordinator (Spec 058 cutover 2). New
  // submissions reject it; the optional field stays readable so stored rows and
  // frozen submission identities keep parsing without a migration.
  manualVerification: z.boolean().default(false),
  // Spec 051: the operator works with the worker in its thread before it submits for review.
  // Absent keeps legacy identity.
  interactive: z.boolean().optional(),
  /** Spec 058: legacy persisted lifecycle marker. New submissions reject explicit false. */
  responsible: z.boolean().optional(),
  /** Critical tasks require a peer-capability independent automatic reviewer. */
  critical: z.boolean().optional(),
  // Spec 020: a brief or handoff may request a merge hold that does not block dispatch.
  mergeHold: z.boolean().optional(),
  // Spec 040: a brief or handoff that requests a merge hold says why; its owner is the submitting agent.
  mergeHoldReason: z.string().trim().min(1).max(4000).optional(),
  requirePreferred: z.boolean().default(false), thinkingOptionId: z.string().default(""),
  // Retired with Spec 037's brief gates (Spec 058 cutover 2): new submissions
  // refuse both keys; the optional fields stay readable so stored rows keep
  // parsing. Recorded verdicts remain ordinary reviewer evidence.
  reviewVerdicts: reviewVerdictsOptInSchema.optional(),
  reviewPassGate: reviewPassGateSchema.optional(),
  // Task 405: the brief-authorized author-side proof selector an external author cannot run.
  // Absent keeps legacy submissions; a task without it has no proof execution route.
  proofExecution: proofExecutionRequestSchema.optional(),
  /** Proof-only qualification of an already-merged base commit (task 551). */
  proofOnly: proofOnlySchema.optional(),
  /** Live surfaces the qualification touches; this requires a release-kind operator GO. */
  requiresOperatorGo: z.string().trim().min(1).max(4000).optional(),
  // Retired with the automatic-review-loop concept (2026-10-07). No code reads
  // this field any more. It stays on the schema — and brief frontmatter parses
  // it inertly — so stored tasks and historical briefs that carried it keep
  // loading and amending without a migration.
  reviewContinuationIds: z.array(z.string().trim().min(1).max(120)).min(1).max(MAX_REVIEW_VERDICTS)
    .refine(ids => new Set(ids).size === ids.length, "Review continuation ids must be unique").optional(),
}).strict();

export type Submission = z.infer<typeof submissionSchema>;

/**
 * Spec 044: a reviewer whose required reading exceeds one turn reports a durable
 * review checkpoint instead of a verdict. It is never a verdict, never counts as
 * a pass, and never aggregates with another reviewer or the author's ledger.
 */
export const REVIEW_CONTINUATION_LIMIT = 6;

/**
 * The checkpoint allowance a reviewer reads as used of allowed. At the last
 * allowed checkpoint the turn must end with a verdict, because Queue refuses
 * another review_in_progress report.
 */
export function reviewAllowanceText(ordinal: number, limit: number): string {
  return ordinal >= limit
    ? `${ordinal} of ${limit}: this turn must end with a verdict`
    : `${ordinal} of ${limit} checkpoints used`;
}

export const MAX_REVIEW_CHECKPOINT_ITEMS = 200;

export const MAX_REVIEW_CHECKPOINT_BYTES = 16000;

export const reviewProgressSchema = z.object({
  covered: z.array(z.string().trim().min(1).max(600)).max(MAX_REVIEW_CHECKPOINT_ITEMS).default([]),
  remaining: z.array(z.string().trim().min(1).max(600)).min(1).max(MAX_REVIEW_CHECKPOINT_ITEMS),
  notes: z.string().trim().max(4000).optional(),
}).strict().refine(value => JSON.stringify(value).length <= MAX_REVIEW_CHECKPOINT_BYTES, `A review checkpoint must be at most ${MAX_REVIEW_CHECKPOINT_BYTES} characters`);

export type ReviewProgress = z.infer<typeof reviewProgressSchema>;

export const coordinatorActionSchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("restart"), role: z.enum(["worker", "reviewer", "coordinator"]).optional(),
    instruction: z.string().trim().min(1).max(12000).optional(), fresh: z.boolean().optional(), reason: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ verb: z.literal("route"), role: z.enum(["worker", "reviewer", "coordinator"]), profileId: z.string().trim().min(1).max(240),
    thinkingOptionId: z.string().optional(), now: z.boolean().optional(), reason: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ verb: z.literal("move"), to: z.enum(["work", "review", "merge", "closeout"]),
    instruction: z.string().trim().min(1).max(12000).optional(), fresh: z.boolean().optional(), reason: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ verb: z.literal("retry_effect"), effect: z.string().trim().min(1).max(240).optional(),
    reason: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ verb: z.literal("cannot"), reason: z.string().trim().min(1).max(4000) }).strict(),
]);

export type CoordinatorAction = z.infer<typeof coordinatorActionSchema>;

/**
 * Spec 058 (task 533): who can produce a proof a reviewer named. The tag picks
 * the route only and never grants approval. `environment` is the reviewer's own
 * run faulting before any assertion (one clean retry, then external); `author`
 * is evidence the author produces at the head; `external` is native hardware,
 * another project's consumer verification or a post-merge proof.
 */
export const proofRouteSchema = z.enum(['author', 'environment', 'external']);

export type ProofRoute = z.infer<typeof proofRouteSchema>;

/** A named awaiting proof: bare text (today's untagged form) or text with its route. */
export const awaitingProofSchema = z.union([
  z.string().trim().min(1).max(2000),
  z.object({ proof: z.string().trim().min(1).max(2000), route: proofRouteSchema }).strict(),
]);

export type AwaitingProof = z.infer<typeof awaitingProofSchema>;

export const completionBaseSchema = z.object({
  eventId: z.string().min(1).max(160), taskId: z.string().min(1), runId: z.string().min(1),
  status: z.enum(["ready_for_review", "report_ready", "progress_checkpoint", "review_in_progress", "ready_to_merge", "changes_required", "verified", "proof_executed", "closed", "blocked", "error", "recovered", "escalate"]), summary: z.string().min(1).max(12000),
  /** Structured report classification; legacy callbacks without it use the compatibility fallback. */
  cause: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('external'), name: z.string().trim().min(1).max(160) }).strict(),
    z.object({ kind: z.enum(['internal', 'unfinished']) }).strict(),
  ]).optional(),
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
  headline: z.string().trim().min(1).max(REPORT_HEADLINE_STORED_MAX).optional(),
  /** Task 405: the executor's own result for the one brief-named selector. */
  proofResult: proofExecutionResultSchema.optional(),
  sourceApproved: z.literal(true).optional(),
  /** Spec 058 (task 533): each named proof carries the route that can produce it. */
  awaitingProofs: z.array(awaitingProofSchema).min(1).max(40).optional(),
  // Spec 044: a reviewer's bounded progress report. Never a verdict.
  checkpoint: reviewProgressSchema.optional(),
  // Spec 044: who owns an unresolved review outcome; never inferred from verdict text.
  reviewResponsibility: z.enum(["author", "reviewer", "environment"]).optional(),
  prNumber: z.number().int().positive().optional(),
  head: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  providerUnavailable: z.boolean().optional(), providerRetryAt: z.string().datetime({offset:true}).optional(),
  reviewCommentId: z.number().int().positive().optional(),
  // Spec 033: a formal GitHub review's id, kept distinct from a PR comment id.
  reviewId: z.number().int().positive().optional(),
  reviewText: z.string().trim().min(1).max(48000).optional(),
  // Spec 037: the reviewer's structured judgments, stored with the review record.
  verdicts: reviewVerdictListSchema.optional(),
  // Exact bytes the original reviewer declared they relied on. The mechanical
  // review carry that consumed this receipt is retired; old records stay readable.
  reviewedInputs: reviewedInputListSchema.optional(),
  closeoutCommit:z.string().regex(/^[a-f0-9]{40}$/).optional(),
  replacementAgentId:z.string().min(1).optional(),
  /** Retired (Spec 050): stored completions keep it, and a new report carrying it is refused by name. */
  recoveryAction: recoveryActionSchema.optional(),
  /** Spec 050: the coordinator's one intent-level action for this stop. */
  coordinatorAction: coordinatorActionSchema.optional(),
  coordinatorGeneration: z.number().int().positive().optional(),
}).strict();

export function refineCoordinatorCompletionAction(
  value: { status: "ready_for_review" | "report_ready" | "progress_checkpoint" | "review_in_progress" | "ready_to_merge" | "changes_required" | "verified" | "proof_executed" | "closed" | "blocked" | "error" | "recovered" | "escalate"; coordinatorAction?: CoordinatorAction; artifact?: LaneDocumentRef; impediment?: string },
  context: z.RefinementCtx,
) {
  if (value.impediment !== undefined && !["blocked", "error"].includes(value.status))
    context.addIssue({ code: "custom", path: ["impediment"], message: "An impediment is only valid for a blocked or error report" });
  if (value.status === 'report_ready' && !value.artifact)
    context.addIssue({ code: 'custom', path: ['artifact'], message: 'report_ready requires its exact lane document artifact' });
  if (value.status !== 'report_ready' && value.artifact)
    context.addIssue({ code: 'custom', path: ['artifact'], message: 'An artifact is only valid for report_ready' });
  if (value.coordinatorAction?.verb === "cannot" && !["blocked", "error"].includes(value.status))
    context.addIssue({ code: "custom", path: ["status"], message: "A coordinator unable report uses blocked or error" });
  if (value.coordinatorAction && value.coordinatorAction.verb !== "cannot" && value.status !== "recovered")
    context.addIssue({ code: "custom", path: ["status"], message: "A coordinator owner verb report uses recovered" });
}

export const completionSchema = completionBaseSchema.superRefine(refineCoordinatorCompletionAction);

export type Completion = z.infer<typeof completionSchema>;

export const mechanicalVerificationSchema = z.object({ at: z.string(), head: z.string(), base: z.string() }).strict();

/** Spec 039: evidence invalidated by an operator-requested fresh review stays auditable. */
export const reviewSupersessionSchema = z.object({
  id: z.string().min(1), at: z.string(), reason: z.string().trim().min(1).max(4000),
  reviewRunId: z.string().min(1), reviewId: z.number().int().positive().nullable(),
  reviewCommentId: z.number().int().positive().nullable(), head: z.string().regex(/^[a-f0-9]{40}$/),
  review: completionSchema, verification: completionSchema.nullable(),
  mechanicalVerification: mechanicalVerificationSchema.nullable(),
}).strict();

export type ReviewSupersession = z.infer<typeof reviewSupersessionSchema>;

const concreteModelSchema = z.string().trim().min(3).max(200).refine(value => {
  const normalized=value.toLowerCase();
  return value.includes('/') && !['unknown','default'].includes(normalized) && !['cursor','grok bot','codex','claude code'].includes(normalized);
}, "Author models must be concrete provider/model identities");

export const authorDeclarationSchema = z.object({
  models:z.array(concreteModelSchema).min(1).max(16).transform(models=>[...new Set(models.map(model=>model.toLowerCase()))].sort()),
  githubAuthor:z.string().trim().min(1).max(100), authoringSystem:z.string().trim().min(1).max(200),
  attestedBy:z.string().trim().min(1).max(240), provenance:z.string().trim().min(1).max(4000),
}).strict();

/**
 * Legacy Spec 039 receipt shape retained so historical task rows remain
 * parseable. Current Queue controls never create or treat these receipts as
 * authority for a changed review-entry head.
 */
const datedActorObservationSchema = z.object({
  at: z.string().datetime(), agentId: z.string(), workspaceId: z.string(), status: z.literal("idle"),
  active: z.literal(false), permissions: z.literal(false),
  model:z.string().nullable().optional(),provider:z.string().nullable().optional(),
  tools: z.array(z.object({ name: z.string(), status: z.string(), at: z.string().datetime(),
    callId:z.string(),kind:z.string(),detailDigest:z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
}).strict();

export const externalOwnerRevisionReceiptSchema = z.object({
  guarantee: z.literal("dated_git_head").optional(),
  ownerScope:z.object({projectKey:z.string(),ownerAgentId:z.string()}).strict().optional(),
  canonicalObservations: z.object({pr:z.object({at:z.string().datetime(),head:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
    branch:z.object({at:z.string().datetime(),head:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
    base:z.object({at:z.string().datetime(),head:z.string().regex(/^[a-f0-9]{40}$/)}).strict()}).strict().optional(),
  observations: z.object({ owner: datedActorObservationSchema, sourceOwner:datedActorObservationSchema.optional(), coordinator: datedActorObservationSchema.nullable(),
    sourceStartedAt: z.string().datetime(), sourceCompletedAt: z.string().datetime() }).strict().optional(),
  at: z.string(),
  // The durable task-control operation that recorded the receipt; null for a
  // direct synchronous call. A settled operation reconciles to this receipt.
  operationId: z.string().nullable(),
  actor: z.object({ agentId: z.string().min(1), role: z.enum(["project_owner", "authorized_relay"]) }).strict(),
  authorization: z.object({ kind: z.enum(["project_owner", "relayed_note"]), note: z.string().max(4000).nullable() }).strict(),
  reason: z.string().trim().min(1).max(4000),
  previousHead: z.string().regex(/^[a-f0-9]{40}$/),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  task: z.object({ id: z.string(), prNumber: z.number().int().positive(), repository: z.string().min(1),
    branch: z.string().min(1), workspaceId: z.string().min(1), directory: z.string().min(1) }).strict(),
  brief: z.object({ digest: briefDigestSchema.nullable(), version: z.number().int().positive().nullable() }).strict(),
  authorDeclaration: authorDeclarationSchema,
  // The fence observed at recording time, preserved unchanged; recording never
  // releases a hold, and a changed fence refuses at the atomic boundary.
  fence: z.object({ kind: holdKindSchema, owner: z.string().min(1), generation: z.number().int().nonnegative(),
    at: z.string().min(1), reason: z.string().min(1) }).strict().nullable(),
  proof: z.object({ localHead: z.string().regex(/^[a-f0-9]{40}$/), pushedHead: z.string().regex(/^[a-f0-9]{40}$/),
    prHead: z.string().regex(/^[a-f0-9]{40}$/), prUrl: z.string().min(1), base: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  // Retired Spec 039 inert-scaffold reconciliation: null on new receipts,
  // kept readable on stored ones.
  reconciliation: z.object({
    recoveryId: z.string().min(1).max(240),
    recoveryKey: z.string().min(1).max(256),
    recoveryGeneration: z.number().int().nonnegative(),
    recoverySnapshot: z.record(z.string(),z.unknown()).optional(),
    incidentSnapshot: z.record(z.string(),z.unknown()).nullable().optional(),
    incidentId: z.string().min(1).max(240).nullable(),
    incidentCause: z.string().min(1).max(240).nullable(),
    incidentDetail: z.string().min(1).max(4000).nullable(),
    integrationBase: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  }).strict().nullable().optional(),
}).strict();

export type ExternalOwnerRevisionReceipt = z.infer<typeof externalOwnerRevisionReceiptSchema>;

// A bounded worker checkpoint is deliberately not task completion, semantic
// blocking, a review revision or an administrative recovery. The durable record
// and the persisted continuation intent are the restart and duplicate-delivery
// authority: the same intent id is re-sent at most once and never mutates the
// retained task, worker, workspace or branch identity.
export const checkpointRecordSchema = z.object({
  ordinal: z.number().int().positive(), summary: z.string().trim().min(1).max(4000),
  head: z.string().regex(/^[a-f0-9]{40}$/), at: z.string(), runId: z.string().min(1),
}).strict();

export type CheckpointRecord = z.infer<typeof checkpointRecordSchema>;

export const checkpointIntentSchema = z.object({
  id: z.string().min(1).max(160), ordinal: z.number().int().positive(), summary: z.string().trim().min(1).max(4000),
  head: z.string().regex(/^[a-f0-9]{40}$/), runId: z.string().min(1), eventId: z.string().min(1).max(160),
  status: z.enum(["pending", "delivered", "uncertain"]), createdAt: z.string(), deliveredAt: z.string().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0), error: z.string().default(""),
}).strict();

export type CheckpointIntent = z.infer<typeof checkpointIntentSchema>;

export const checkpointStateSchema = z.object({
  records: z.array(checkpointRecordSchema).default([]), intent: checkpointIntentSchema.nullable().default(null),
}).strict();

export type CheckpointState = z.infer<typeof checkpointStateSchema>;

/** Durable acknowledgement returned to the worker for a bounded checkpoint. */
export const checkpointReceiptSchema = z.object({
  ordinal: z.number().int().nonnegative(), budget: z.number().int().positive(), continued: z.boolean(), attention: z.string().optional(),
  /** Spec 044 binds the saved reviewer checkpoint content to its accepted callback receipt. */
  checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export type CheckpointReceipt = z.infer<typeof checkpointReceiptSchema>;

export const checkpointResultSchema = z.object({ accepted: z.literal(true), eventId: z.string(), checkpoint: checkpointReceiptSchema }).strict();

export type CheckpointResult = z.infer<typeof checkpointResultSchema>;

/**
 * A reviewer whose required reading exceeds one turn reports a durable review
 * checkpoint instead of a verdict. It is never a verdict, never counts as a
 * pass and never aggregates with another reviewer's evidence. Queue stores each
 * checkpoint on the reviewer run (immutable history) and writes it to an
 * owner-only per-run directory under Queue's data directory, then continues the
 * same authenticated reviewer thread at the same exact head.
 */
export const reviewCheckpointRecordSchema = z.object({
  ordinal: z.number().int().positive(), checkpoint: reviewProgressSchema,
  head: z.string().regex(/^[a-f0-9]{40}$/), at: z.string(), runId: z.string().min(1),
  path: z.string().min(1).max(2048),
  // Added at the authenticated callback boundary. Older checkpoints remain
  // readable, but cannot authorize delivery without this receipt association.
  eventId: z.string().min(1).max(160).optional(), callbackDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  briefVersion: z.number().int().positive().nullable().optional(), briefDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().optional(),
}).strict();

export type ReviewCheckpointRecord = z.infer<typeof reviewCheckpointRecordSchema>;

/**
 * A review_in_progress report Queue refused because the checkpoint allowance was
 * spent. The reading is kept as evidence on the run for the owner and the next
 * reader; it is never an accepted checkpoint, so it grants no continuation.
 */
export const rejectedReviewReadingSchema = z.object({
  eventId: z.string().min(1).max(160), head: z.string().regex(/^[a-f0-9]{40}$/), at: z.string(),
  checkpoint: reviewProgressSchema, reason: z.string(),
}).strict();

export type RejectedReviewReading = z.infer<typeof rejectedReviewReadingSchema>;

/** Durable operator authorization and at-most-once identity for one checkpoint delivery. */
export const reviewDeliveryAuthorizationSchema = z.object({
  authorizationId: z.string().min(1).max(160), operationId: z.string().min(1).max(160), deliveryId: z.string().regex(/^ns-review-[a-f0-9]{64}$/),
  taskId: z.string().min(1), runId: z.string().min(1), head: z.string().regex(/^[a-f0-9]{40}$/),
  checkpointOrdinal: z.number().int().positive(), taskVersion: z.number().int().positive(),
  briefVersion: z.number().int().positive().nullable(), briefDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  reason: z.string().trim().min(1).max(4000), instruction: z.string().trim().min(1).max(4000),
  createdAt: z.string(), status: z.enum(["reserved", "delivered", "uncertain", "refused"]),
  evidence: z.string().max(2000).default(""), observedAt: z.string().nullable().default(null),
}).strict();

export type ReviewDeliveryAuthorization = z.infer<typeof reviewDeliveryAuthorizationSchema>;

export const reviewContinuationIntentSchema = z.object({
  id: z.string().min(1).max(160), ordinal: z.number().int().positive(),
  head: z.string().regex(/^[a-f0-9]{40}$/), runId: z.string().min(1), eventId: z.string().min(1).max(160),
  remaining: z.array(z.string().trim().min(1).max(600)).max(MAX_REVIEW_CHECKPOINT_ITEMS),
  path: z.string().min(1).max(2048),
  status: z.enum(["pending", "delivered", "uncertain"]), createdAt: z.string(),
  deliveredAt: z.string().nullable().default(null), attempts: z.number().int().nonnegative().default(0), error: z.string().default(""),
}).strict();

export const reviewEntryInputSchema = z.object({
  submission:z.preprocess(raw=>submissionRecordFromLegacy(raw),submissionSchema), workspaceId:z.string().trim().min(1).max(240), prNumber:z.number().int().positive(),
  expectedBranch:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  expectedHead:z.string().regex(/^[a-f0-9]{40}$/), expectedBaseCommit:z.string().regex(/^[a-f0-9]{40}$/),
  authority:z.string().trim().min(1).max(4000), authorDeclaration:authorDeclarationSchema,
  // Omission preserves external ownership and legacy operation input hashes.
  workspaceOwnership:z.enum(["external","intake"]).optional(),
  // Omission keeps existing review-entry operation keys byte-compatible.
  // Retained so callers receive a typed unsupported-mode refusal instead of
  // silently interpreting an old shared-canonical request as isolated.
  workspaceMode:z.enum(["isolated","shared_canonical"]).optional(),
}).strict().superRefine((input,ctx)=>{
  if(input.submission.skipPRReview)ctx.addIssue({code:"custom",path:["submission","skipPRReview"],message:"Review entry requires independent PR review"});
  if(input.submission.responsible===false)ctx.addIssue({code:"custom",path:["submission","responsible"],message:"responsible: false is no longer supported; every task runs the responsible lifecycle"});
  if(input.submission.manualVerification===true)ctx.addIssue({code:"custom",path:["submission","manualVerification"],message:"manualVerification is no longer available; every task runs the responsible lifecycle"});
  if(input.submission.reviewVerdicts!==undefined||input.submission.reviewPassGate!==undefined)ctx.addIssue({code:"custom",path:["submission","reviewVerdicts"],message:"reviewVerdicts and reviewPassGate are no longer available; state the outcome and acceptance in prose in the brief, and use mergeHold for a needed hold"});
  if(input.expectedBranch===input.submission.baseBranch)ctx.addIssue({code:"custom",path:["expectedBranch"],message:"Review entry requires a non-base source branch"});
});

export type ReviewEntryInput=z.infer<typeof reviewEntryInputSchema>;

export const reviewEntryRecordSchema=z.object({
  operationId:z.string().regex(/^[a-f0-9]{64}$/), prNumber:z.number().int().positive(), repository:z.string().min(1),
  branch:z.string().min(1), workspaceId:z.string().min(1), verifiedHead:z.string().regex(/^[a-f0-9]{40}$/),
  verifiedBase:z.string().regex(/^[a-f0-9]{40}$/), dispatchBase:z.string().regex(/^[a-f0-9]{40}$/).nullable().default(null),
  planningCommit:z.string().regex(/^[a-f0-9]{40}$/), authority:z.string().min(1), authorDeclaration:authorDeclarationSchema,
  checkedAt:z.string(), preserveWorkspace:z.boolean(), directory:z.string().default(""),
  workspaceMode:z.enum(["isolated","shared_canonical"]).default("isolated"),
  briefDigest:briefDigestSchema.nullable().default(null), briefVersion:z.number().int().positive().nullable().default(null),
}).strict();

export type ReviewEntryRecord=z.infer<typeof reviewEntryRecordSchema>;

export const reviewEntryRefusalCodeSchema=z.enum(["identity_mismatch","planning_invalid","ownership_conflict","workspace_busy","author_identity_unverified","permission_unverified","hook_incompatible","exclusive_writer_unavailable"]);

export const reviewEntryPreviewResultSchema=z.object({
  eligible:z.boolean(), refusals:z.array(z.object({code:reviewEntryRefusalCodeSchema,explanation:z.string().max(2000)}).strict()).max(16),
  // Eligibility is acceptance, not execution: an active source writer is a
  // pending handover intake may accept, and this names the activity a fresh
  // admission proof must first observe yielded. Null means the preview proved
  // readiness to execute now.
  pendingHandover:z.string().trim().max(2000).nullable().default(null),
  resolved:z.object({workspaceId:z.string(),directory:z.string(),repository:z.string(),branch:z.string(),head:z.string(),base:z.string(),prNumber:z.number().int().positive(),prUrl:z.string(),workspaceMode:z.enum(["isolated","shared_canonical"]),planningCommit:z.string(),briefDigest:briefDigestSchema.nullable(),briefVersion:z.number().int().positive().nullable()}).strict().nullable(),
}).strict();

/** Operator-only: rearms one attention-held review-entry operation under its existing key, ID and stored payload. */
export const reviewEntryReconcileInputSchema=z.object({
  operationId:z.string().regex(/^[a-f0-9]{64}$/),
  inputHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Service-owned workspace preparation for the lead review-entry CLI. */
export const reviewEntryWorkspaceInputSchema=z.object({
  hostId:z.string().min(1).optional(),leadId:z.string().min(1),leadVersion:z.number().int().positive(),
  prNumber:z.number().int().positive(),title:z.string().min(1),repoPath:z.string().min(1),
}).strict();
export type ReviewEntryWorkspaceInput=z.infer<typeof reviewEntryWorkspaceInputSchema>;
