import { z } from "zod";
import { normalizeRepositoryOrigin } from "./lanes";
import { operationAcceptedSchema, operationBackpressuredSchema } from "./operations";

/**
 * Spec 056: re-key one repository namespace.
 *
 * A repository's identity is its normalised origin (`owner/name`) with an
 * optional local path hint. Renaming a repository on the forge therefore means
 * moving every *current* record that names the old identity onto the new one in
 * one atomic, idempotent step, while every *historical* fact keeps the identity
 * it was written under. Nothing here renames a checkout, a Git remote, a branch
 * or a forge repository, and nothing merges two repositories' histories.
 *
 * The caller supplies the exact source it expects, the exact target it wants
 * (origin, and optionally a new path), the source settings revision it observed
 * (the version fence), a reason and an idempotency key. Same origin with a
 * different path is a path-only step: every path hint moves and numbering stays.
 * Preview is a read-only projection and is never authority to apply a later,
 * drifted input: apply re-checks every precondition inside its own transaction.
 */

/** The identity shape every Queue record uses for a repository. */
export const repositoryRekeyIdentitySchema = z.object({ origin: z.string().nullable(), path: z.string() }).strict();
export type RepositoryRekeyIdentity = z.infer<typeof repositoryRekeyIdentitySchema>;

/** A target origin is required: a re-key always names the new `owner/name`. */
export const repositoryRekeyTargetSchema = z.object({
  origin: z.string().trim().min(1).max(1024),
  /** An optional new local path hint. Absent keeps every record's current path. */
  path: z.string().trim().max(1024).optional(),
}).strict();
export type RepositoryRekeyTarget = z.infer<typeof repositoryRekeyTargetSchema>;

export const repositoryRekeyInputSchema = z.object({
  /** The exact current identity: a normalised `owner/name` origin or an absolute checkout path. */
  source: z.string().trim().min(1).max(1024),
  target: repositoryRekeyTargetSchema,
  /**
   * The current checkout path when the settings row has none and the source's
   * own records disagree. Omit it when settings carry the path, or when every
   * matched record names the same one — the step derives it then. Guessing
   * among several paths is refused.
   */
  sourcePath: z.string().trim().max(1024).optional(),
  /**
   * The repository settings revision the caller observed (null when the source has
   * no settings row). A change since then refuses rather than applying drift.
   */
  expectedSourceRevision: z.number().int().nonnegative().nullable(),
  reason: z.string().trim().min(1).max(4000),
  /** The operator (or the owner thread speaking for the operator). */
  author: z.string().trim().min(1).max(240),
  /** The agent that relayed the operator's authorization, when one did. */
  relayedBy: z.string().trim().min(1).max(240).nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();
export type RepositoryRekeyInput = z.infer<typeof repositoryRekeyInputSchema>;

/** Preview takes the same input minus the actor: a read names no author and changes nothing. */
export const repositoryRekeyPreviewInputSchema = repositoryRekeyInputSchema.omit({ author: true });
export type RepositoryRekeyPreviewInput = z.infer<typeof repositoryRekeyPreviewInputSchema>;

/** Typed refusal codes; the explanation says what the caller can do about it. */
export const REPOSITORY_REKEY_REFUSAL_CODES = [
  "unknown_source",
  "ambiguous_source",
  "source_equals_target",
  "invalid_target",
  "target_occupied",
  "path_occupied",
  "active_tasks",
  "active_operations",
  "active_runs",
  "active_qa",
  "active_host_runs",
  "pending_side_effects",
  "source_revision_changed",
  "concurrent_change",
  "receipt_conflict",
] as const;
export const repositoryRekeyRefusalCodeSchema = z.enum(REPOSITORY_REKEY_REFUSAL_CODES);
export type RepositoryRekeyRefusalCode = z.infer<typeof repositoryRekeyRefusalCodeSchema>;

export const repositoryRekeyRefusalSchema = z.object({ code: repositoryRekeyRefusalCodeSchema, explanation: z.string().min(1).max(2000) }).strict();
export type RepositoryRekeyRefusal = z.infer<typeof repositoryRekeyRefusalSchema>;

/** Every family the re-key rewrites: current routing and lookup identity only. */
export const REPOSITORY_REKEY_FAMILIES = [
  "repositorySettings",
  "taskNumberCounters",
  "taskNumbers",
  "tasks",
  "outcomes",
  "leads",
  "lanes",
  "decisions",
  "projects",
  "projectTombstones",
  "projectQaRuns",
  "qaScheduleMerges",
] as const;
export type RepositoryRekeyFamily = typeof REPOSITORY_REKEY_FAMILIES[number];
export const repositoryRekeyCountsSchema = z.record(z.string().max(80), z.number().int().nonnegative());
export type RepositoryRekeyCounts = z.infer<typeof repositoryRekeyCountsSchema>;

/** Facts the re-key never rewrites: they keep the identity they were written under. */
export const REPOSITORY_REKEY_HISTORICAL = [
  "operations",
  "hookEvents",
  "hostRunRecords",
  "hostRunJournals",
  "hostRunAccounting",
  "shadowStream",
  "receipts",
  "legacyPapercuts",
  "proofExecutions",
  "outcomeProof",
] as const;

export const repositoryRekeyNumberingSchema = z.object({
  /** Numbered tasks (live and purged) that moved with the repository. */
  tasks: z.number().int().nonnegative(),
  /** The source's next number before the step, null when the source never numbered a task. */
  sourceNext: z.number().int().positive().nullable(),
  /** The target's next number after the step: numbering continues, it never restarts at 1. */
  targetNext: z.number().int().positive().nullable(),
}).strict();
export type RepositoryRekeyNumbering = z.infer<typeof repositoryRekeyNumberingSchema>;

/** One read-only projection of what a fresh apply would do. */
export const repositoryRekeyPreviewSchema = z.object({
  source: repositoryRekeyIdentitySchema,
  target: repositoryRekeyIdentitySchema,
  /** True when an explicit target path moves the path hints too. */
  pathChanged: z.boolean(),
  ready: z.boolean(),
  refusals: z.array(repositoryRekeyRefusalSchema).max(32),
  expectedSourceRevision: z.number().int().nonnegative().nullable(),
  counts: repositoryRekeyCountsSchema,
  numbering: repositoryRekeyNumberingSchema,
  projectKeys: z.array(z.string()).max(500),
  laneKeys: z.array(z.string()).max(500),
  historical: z.array(z.string()).max(64),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  computedAt: z.string(),
}).strict();
export type RepositoryRekeyPreview = z.infer<typeof repositoryRekeyPreviewSchema>;

/**
 * The durable receipt one applied step writes beside its records. It binds the
 * exact source and target identities, the optional path, the actor and relay,
 * the time, the input hash and the affected-family counts. A lost reply reads
 * this receipt; repeating the same key with the same payload returns it, and a
 * changed payload under the same key refuses.
 */
export const repositoryRekeyReceiptSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().min(1).max(200),
  kind: z.literal("repository_rekey"),
  source: repositoryRekeyIdentitySchema,
  target: repositoryRekeyIdentitySchema,
  pathChanged: z.boolean(),
  reason: z.string().min(1).max(4000),
  author: z.string().min(1).max(240),
  relayedBy: z.string().min(1).max(240).nullable().default(null),
  at: z.string(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedSourceRevision: z.number().int().nonnegative().nullable(),
  counts: repositoryRekeyCountsSchema,
  numbering: repositoryRekeyNumberingSchema,
  projectKeys: z.array(z.string()).max(500),
  laneKeys: z.array(z.string()).max(500),
  /** The families deliberately left under their historical identity. */
  historical: z.array(z.string()).max(64),
}).strict();
export type RepositoryRekeyReceipt = z.infer<typeof repositoryRekeyReceiptSchema>;

export const repositoryRekeyReceiptQuerySchema = z.union([
  z.object({ key: z.string().min(1).max(200) }).strict(),
  z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type RepositoryRekeyReceiptQuery = z.infer<typeof repositoryRekeyReceiptQuerySchema>;

export const repositoryRekeyResultSchema = z.object({
  receipt: repositoryRekeyReceiptSchema,
  /** True when this reply replayed a receipt the step already wrote, rather than applying again. */
  replayed: z.boolean(),
}).strict();
export type RepositoryRekeyResult = z.infer<typeof repositoryRekeyResultSchema>;

/**
 * The public reply: the settled receipt inside the compatibility window, or the
 * accepted durable operation when the step outlives it. It never claims an apply
 * that did not commit.
 */
export const repositoryRekeyOutputSchema = z.union([repositoryRekeyResultSchema, operationAcceptedSchema, operationBackpressuredSchema]);
export type RepositoryRekeyOutput = z.infer<typeof repositoryRekeyOutputSchema>;

/**
 * The recommended caller key for one step, so an operator retrying a lost reply
 * reconciles the same operation and receipt. The caller still supplies it, so a
 * deliberate supersession can name a new step.
 */
export function suggestedRepositoryRekeyKey(input: { source: string; target: { origin: string; path?: string } }): string {
  const source = normalizeRepositoryOrigin(input.source) ?? input.source.trim();
  const target = normalizeRepositoryOrigin(input.target.origin) ?? input.target.origin.trim();
  const path = input.target.path?.trim() ?? "";
  const key = path && source === target
    ? `repository-rekey:${source}:path:${path}`
    : `repository-rekey:${source}:${target}`;
  return key.slice(0, 200);
}
