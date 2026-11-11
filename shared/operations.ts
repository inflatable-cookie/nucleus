import { z } from "zod";
import { hostSelectionSchema } from './host-selection';

/**
 * Spec 012 durable Queue operations.
 *
 * An operation is the stable, idempotent identity of one accepted command. The
 * caller supplies a key; repeating the same key with the same normalized input
 * returns the same operation, and reusing a key with different input fails.
 * Operation records are additive: they never replace task, run, hook, notice,
 * receipt or setting identity.
 *
 * `draft_promote` stays only so settled rows from before brief drafts retired
 * keep parsing; no payload can start one.
 */
export const OPERATION_KINDS = ["submit", "task_control", "review_entry", "draft_promote", "lead_check", "source_promote", "task_remove", "repository_rekey"] as const;
export const operationKindSchema = z.enum(OPERATION_KINDS);
export type OperationKind = z.infer<typeof operationKindSchema>;

export const OPERATION_STATES = ["pending", "running", "succeeded", "needs_attention", "failed"] as const;
export const operationStateSchema = z.enum(OPERATION_STATES);
export type OperationState = z.infer<typeof operationStateSchema>;

export const OPERATION_SETTLED_STATES: readonly OperationState[] = ["succeeded", "needs_attention", "failed"];
export const operationIsSettled = (state: OperationState) => OPERATION_SETTLED_STATES.includes(state);

/** Default bound on pending+running operations before acceptance reports backpressure. */
export const DEFAULT_OPERATION_LIMIT = 64;
/** Upper bound accepted for an operator-configured operation limit. */
export const MAX_OPERATION_LIMIT = 256;
/**
 * Legacy synchronous RPCs keep their historical shape only while the durable
 * operation settles inside this bounded compatibility window. A slower command
 * returns its accepted operation identity instead of an unknown transport
 * timeout.
 */
export const OPERATION_COMPATIBILITY_WAIT_MS = 15_000;
/** Retry guidance attached to a typed backpressure acceptance result. */
export const OPERATION_BACKPRESSURE_RETRY_MS = 1_000;

/** Bounded typed result of a settled operation: identity plus observed version. */
export const operationResultSchema = z.object({
  taskId: z.string().max(160).nullable().default(null),
  number: z.number().int().positive().nullable().default(null),
  taskVersion: z.number().int().positive().nullable().default(null),
  phase: z.string().max(60).nullable().default(null),
  /** Stable reference to a non-task result when the command has no task identity. */
  reference: z.string().max(240).nullable().default(null),
}).strict();
export type OperationResult = z.infer<typeof operationResultSchema>;

/**
 * Durable external-effect intent for a command that can cross the process
 * boundary. The record persists before the effect and is reconciled rather
 * than retried blindly after an unknown delivery.
 */
export const operationEffectSchema = z.object({
  kind: z.string().min(1).max(120),
  target: z.string().max(320).default(""),
  intentAt: z.string(),
  status: z.enum(["intent", "reconciled", "uncertain"]).default("intent"),
  result: z.string().max(2000).nullable().default(null),
  resultAt: z.string().nullable().default(null),
}).strict();
export type OperationEffect = z.infer<typeof operationEffectSchema>;

/** A receipt written by the executing service, never supplied by a caller. */
export const preSendReceiptSchema = z.object({
  operationId: z.string().regex(/^[a-f0-9]{64}$/), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  taskId: z.string(), expectedVersion: z.number().int().positive(), attempt: z.number().int().positive(),
  boundary: z.enum(["parked-restart-retained-run-v1", "parked-restart-rollback-v1", "pre-send-refusal-v1"]), buildId: z.string().min(1),
  taskEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/), runEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  diagnostic: z.string().max(4000), effect: operationEffectSchema, recordedAt: z.string(),
}).strict();
const preSendHistorySchema = z.object({
  receipt: preSendReceiptSchema, effect: operationEffectSchema.nullable(), diagnostic: z.string().max(4000),
  settledAt: z.string().nullable(), reconciledAt: z.string().nullable(),
}).strict();

export const queueOperationSchema = z.object({
  hostSelection: hostSelectionSchema.optional(),
  /** Selected host, recorded before any host-facing work. Missing means unknown. */
  hostId: z.string().min(1).optional(),
  /** Stable operation ID derived from the caller key, so a lost response reconciles the same record. */
  id: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().min(1).max(200),
  kind: operationKindSchema,
  /** Normalized input digest; a different digest under the same key fails closed. */
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: operationStateSchema,
  taskId: z.string().max(160).nullable().default(null),
  expectedVersion: z.number().int().positive().nullable().default(null),
  repoPath: z.string().max(1024).nullable().default(null),
  submissionId: z.string().max(160).nullable().default(null),
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  settledAt: z.string().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
  diagnostic: z.string().max(4000).default(""),
  result: operationResultSchema.nullable().default(null),
  effect: operationEffectSchema.nullable().default(null),
  preSendBoundaryStartedAt: z.string().nullable().optional(),
  preSendReceipt: preSendReceiptSchema.nullable().optional(),
  preSendReconciledAt: z.string().nullable().optional(),
  preSendHistory: z.array(preSendHistorySchema).optional(),
}).strict();
export type QueueOperation = z.infer<typeof queueOperationSchema>;

/** Acceptance envelope returned by the generic start RPC. */
export const operationAcceptedSchema = z.object({ accepted: z.literal(true), operation: queueOperationSchema }).strict();
export type OperationAccepted = z.infer<typeof operationAcceptedSchema>;

/** Typed saturation result; never a transport timeout and never an unserviceable stored operation. */
export const operationBackpressuredSchema = z.object({
  backpressured: z.literal(true),
  pending: z.number().int().nonnegative(),
  retryAfterMs: z.number().int().positive(),
  reason: z.string().min(1).max(600),
}).strict();
export type OperationBackpressured = z.infer<typeof operationBackpressuredSchema>;

export const operationAcceptanceSchema = z.union([operationAcceptedSchema, operationBackpressuredSchema]);
export type OperationAcceptance = z.infer<typeof operationAcceptanceSchema>;


/** Compact queued/running/attention state for board, detail and control feedback. */
export function operationStateLabel(operation: Pick<QueueOperation, "kind" | "state" | "diagnostic">) {
  const kind = operation.kind === "submit" ? "Submission" : operation.kind === "review_entry" ? "Review entry"
    : operation.kind === "lead_check" ? "Brief check" : operation.kind === "source_promote" ? "Task promotion" : operation.kind === "task_remove" ? "Removal" : operation.kind === "repository_rekey" ? "Repository re-key" : "Operation";
  if (operation.state === "pending") return `${kind} queued`;
  if (operation.state === "running") return `${kind} running`;
  if (operation.state === "needs_attention") return `${kind} needs attention`;
  if (operation.state === "failed") return `${kind} failed`;
  return `${kind} complete`;
}

/** Bounded projection for compact board and detail reads; never carries the stored payload. */
export const operationSummarySchema = z.object({
  id: z.string().max(64), key: z.string().max(200), kind: operationKindSchema, state: operationStateSchema,
  taskId: z.string().max(160).nullable().default(null), expectedVersion: z.number().int().positive().nullable().default(null),
  submissionId: z.string().max(160).nullable().default(null),
  createdAt: z.string(), settledAt: z.string().nullable().default(null),
  diagnostic: z.string().max(600).default(""), result: operationResultSchema.nullable().default(null),
}).strict();
export type OperationSummary = z.infer<typeof operationSummarySchema>;
export function summarizeOperation(operation: QueueOperation): OperationSummary {
  return operationSummarySchema.parse({
    id: operation.id, key: operation.key, kind: operation.kind, state: operation.state,
    taskId: operation.taskId, expectedVersion: operation.expectedVersion, submissionId: operation.submissionId,
    createdAt: operation.createdAt, settledAt: operation.settledAt,
    diagnostic: operation.diagnostic.slice(0, 600), result: operation.result,
  });
}
