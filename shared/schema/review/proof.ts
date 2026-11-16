import { z } from "zod";
import { profileSchema } from "../settings";

/**
 * Task 405: the one author-side proof execution a brief may authorize. The
 * request is the immutable subject (selector and pinned input hashes), the
 * record is the append-only evidence the queue-created executor ran it, and the
 * acceptance is the operator preserving a failed qualification without erasing
 * it. None of these is a review verdict, a stage or source authorship.
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
