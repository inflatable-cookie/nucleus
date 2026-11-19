import { z } from "zod";

/**
 * Spec 044: a bounded checkpoint. A worker's checkpoint hands a bounded pre-PR
 * intent to the queue; a reviewer's checkpoint is bounded reading progress and is
 * never a verdict. Both are durably recorded, delivered at most once under their
 * own identity, and continue the same retained thread.
 */

export const REVIEW_CONTINUATION_LIMIT = 6;

/**
 * The checkpoint allowance a reviewer reads as used of allowed. At the final
 * continuation, a further progress report records unread items for the owner.
 */
export function reviewAllowanceText(ordinal: number, limit: number): string {
  return ordinal >= limit
    ? `${ordinal} of ${limit}: final continuation`
    : `${ordinal} of ${limit} checkpoints used`;
}

export const MAX_REVIEW_CHECKPOINT_ITEMS = 200;

export const MAX_REVIEW_CHECKPOINT_BYTES = 16000;

export const reviewProgressSchema = z.object({
  covered: z.array(z.string().trim().min(1).max(600)).max(MAX_REVIEW_CHECKPOINT_ITEMS).default([]),
  remaining: z.array(z.string().trim().min(1).max(600)).min(1).max(MAX_REVIEW_CHECKPOINT_ITEMS),
  notes: z.string().trim().max(4000).optional(),
  exhausted: z.literal(true).optional(),
}).strict().refine(value => JSON.stringify(value).length <= MAX_REVIEW_CHECKPOINT_BYTES, `A review checkpoint must be at most ${MAX_REVIEW_CHECKPOINT_BYTES} characters`);

export type ReviewProgress = z.infer<typeof reviewProgressSchema>;

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
 * A review_in_progress report Queue retained when the allowance was spent or
 * the reviewer reported it could not finish. The owner and the next
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
