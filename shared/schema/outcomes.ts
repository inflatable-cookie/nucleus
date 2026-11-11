import { z } from "zod";
import { laneKeyListSchema, laneKeySchema } from "../schema/task-primitives";
import { draftApprovalSchema, draftProvenanceSchema, laneDocumentRefSchema, planningSourceSchema } from "./briefs";
import { projectValidationResultSchema } from "./validation";
import { ownerAcceptanceRecordSchema, reportAcceptanceSchema } from "./review";
import { capabilityLevelSchema, profileRequestsSchema, scopeSchema } from "./settings";

/** Host-neutral durable outcome of a terminal task. Retention never deletes it. */
export const outcomeActorSchema = z.object({
  profileId: z.string().min(1),
  model: z.string().min(1),
}).strict();

export const outcomeSchema = z.object({
  taskId: z.string().min(1),
  planningSource: planningSourceSchema.nullable().default(null),
  number: z.number().int().positive().nullable().default(null),
  reference: z.string().nullable().default(null),
  submissionId: z.string().min(1),
  title: z.string(),
  repository: z.object({
    origin: z.string().nullable(),
    path: z.string().min(1),
  }).strict(),
  outcome: z.enum(["done", "cancelled", "superseded"]),
  replacementTaskId: z.string().nullable().default(null),
  reason: z.string(),
  pr: z.object({
    url: z.string().nullable(),
    number: z.number().int().positive().nullable(),
    head: z.string().nullable(),
  }).strict().nullable(),
  mergeCommit: z.string().nullable(),
  syncedCommit: z.string().nullable(),
  review: z.object({
    status: z.string().nullable(),
    summary: z.string().nullable(),
    commentId: z.number().int().positive().nullable(),
    // Spec 033: a formal review is recorded by its own id, never as a comment id.
    reviewId: z.number().int().positive().nullable().default(null),
  }).strict().nullable(),
  validation: z.object({ summary: z.string().min(1), project: projectValidationResultSchema.optional() }).strict().nullable(),
  closeout: z.object({
    authority: z.enum(["queue", "hook", "agent"]),
    commit: z.string().nullable(),
  }).strict().nullable(),
  /** Present only when a project owner completes a proven report-only task. */
  reportAcceptance: reportAcceptanceSchema.nullable().default(null),
  /** Present when the task merged under a qualified owner acceptance recorded beside the reviewer verdict. */
  ownerAcceptance: ownerAcceptanceRecordSchema.nullable().default(null),
  brief: z.object({
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: z.string().min(1),
    text: z.string(),
    // Spec 020: a Queue-held brief records the version it finished under and the digests it replaced.
    source: z.enum(["handoff", "queue"]).default("handoff"),
    version: z.number().int().positive().nullable().default(null),
    earlierDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).default([]),
    draftProvenance: draftProvenanceSchema.optional(),
    approval: draftApprovalSchema.optional(),
  }).strict(),
  workers: z.array(outcomeActorSchema),
  reviewers: z.array(outcomeActorSchema),
  routing: z.object({scope:scopeSchema,complexity:capabilityLevelSchema.nullable().default(null),preferredProfileId:z.string(),requirePreferred:z.boolean(),thinkingOptionId:z.string(),profileRequests:profileRequestsSchema.optional()}).strict().optional(),
  // Spec 027: the sibling repository pins this task finished under.
  siblings: z.array(z.object({ repository: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict()).default([]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  backfilled: z.boolean(),
  lanes: laneKeyListSchema.default([]),
  laneDocuments: z.array(laneDocumentRefSchema).optional(),
}).strict();

export type Outcome = z.infer<typeof outcomeSchema>;

export const outcomeLookupSchema = z.object({
  taskId: z.string().min(1).optional(),
  submissionId: z.string().min(1).optional(),
  reference: z.string().regex(/^[A-Za-z0-9._-]+#0*[1-9][0-9]*$/).optional(),
  repository: z.string().min(1).optional(), number: z.number().int().positive().optional(),
}).strict().refine(input => [Boolean(input.taskId), Boolean(input.submissionId), Boolean(input.reference), Boolean(input.repository && input.number)].filter(Boolean).length === 1 && Boolean(input.repository) === Boolean(input.number), "Provide one outcome identity");

/**
 * Spec 025: read-only search over the permanent outcome records. Every filter
 * is optional and filters combine with AND; `pr` needs its `repository` and a
 * `commit` is a hex prefix of at least seven characters.
 */
export const outcomeSearchInputSchema = z.object({
  repository: z.string().min(1).optional(),
  text: z.string().min(1).regex(/\p{L}|\p{N}/u, "text needs at least one letter or digit").optional(),
  lane: laneKeySchema.optional(),
  outcome: z.enum(["done", "cancelled", "superseded"]).optional(),
  since: z.string().refine(value => Number.isFinite(Date.parse(value)), "since must be an ISO date").optional(),
  until: z.string().refine(value => Number.isFinite(Date.parse(value)), "until must be an ISO date").optional(),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/i, "commit must be a 7-40 character hex prefix").optional(),
  pr: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().min(1).optional(),
}).strict().refine(input => !input.pr || Boolean(input.repository), "pr requires repository");

export type OutcomeSearchInput = z.infer<typeof outcomeSearchInputSchema>;

export const outcomeSearchExcerptSchema = z.object({
  field: z.enum(["title", "brief", "review", "reason"]),
  text: z.string(),
}).strict();

/** Compact search row. Brief text never leaves the store; the full row stays one `queue.outcome` call away. */
export const outcomeSearchRowSchema = z.object({
  taskId: z.string().min(1),
  reference: z.string().nullable(),
  title: z.string(),
  repository: z.string().min(1),
  outcome: z.enum(["done", "cancelled", "superseded"]),
  lanes: z.array(laneKeySchema),
  prNumber: z.number().int().positive().nullable(),
  prUrl: z.string().nullable(),
  mergeCommit: z.string().nullable(),
  finishedAt: z.string().nullable(),
  backfilled: z.boolean(),
  replacementTaskId: z.string().nullable(),
  excerpt: outcomeSearchExcerptSchema.nullable(),
}).strict();

export const outcomeSearchResultSchema = z.object({
  results: z.array(outcomeSearchRowSchema),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
}).strict();

export type OutcomeSearchResult = z.infer<typeof outcomeSearchResultSchema>;
