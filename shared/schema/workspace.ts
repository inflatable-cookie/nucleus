import { z } from "zod";

/**
 * One runtime scope captured from a task workspace before it is archived
 * (Effigy contract 005). The token is persisted with the archive intent so a
 * crash between archive and proof still retries `effigy container retire
 * --scope <token> --yes`. `state` is the durable cleanup evidence:
 * `captured` (token read, archive not yet confirmed), `none` (checkout never
 * scoped), `pending` (archive confirmed, proof owed), `failed` (teardown or
 * proof failed, retry owed after `nextAttemptAt`) and `retired` (exit 0).
 */
export const runtimeRetirementSchema = z.object({
  workspaceId: z.string().min(1).max(240),
  directory: z.string().min(1).max(1024),
  scope: z.object({ kind: z.enum(["worktree", "ephemeral-clone"]), token: z.string().min(1).max(128) }).strict().nullable().default(null),
  state: z.enum(["captured", "none", "pending", "failed", "retired"]),
  capturedAt: z.string(), provedAt: z.string().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
  error: z.string().default(""), outputTail: z.string().default(""),
  nextAttemptAt: z.string().nullable().default(null),
}).strict();

export type RuntimeRetirement = z.infer<typeof runtimeRetirementSchema>;

export const buildOutputCleanupSchema = z.object({
  workspaceId: z.string().min(1).max(240), directory: z.string().min(1).max(1024),
  state: z.enum(["intent", "complete", "skipped", "uncertain"]), detail: z.string().default(""), at: z.string(),
  // Queue #342: a run-bound record names the finished run whose regenerable output it settles.
  // Terminal workspace records have no run and keep one record per workspace.
  runId: z.string().min(1).max(240).optional(), agentId: z.string().min(1).max(240).optional(),
}).strict();

export type BuildOutputCleanup = z.infer<typeof buildOutputCleanupSchema>;

/**
 * Spec 017: one merged review-entry task's external workspace catalog archive.
 *
 * Tom (2026-10-25): at closeout of a merged task whose bound external workspace
 * holds only that task's own idle threads, Paseo's sidebar entry is archived and
 * the folder is left untouched. This record is the durable, at-most-once
 * identity of exactly that catalog effect. It is deliberately separate from
 * `archivedWorkspaceIds` (Queue-owned workspace teardown), from
 * `runtimeRetirements` (the checkout's Effigy scope proof) and from
 * `workspaceRetirement` (owner-authorized removal of a preserved workspace):
 * `state: "archived"` claims the catalog entry only, never the folder, its
 * files, its Git worktree registration or its branch.
 */
export const externalWorkspaceArchiveSchema = z.object({
  workspaceId: z.string().min(1).max(240), directory: z.string().min(1).max(1024),
  /** Stable native idempotency identity for this one catalog operation. */
  requestId: z.string().min(1).max(240),
  state: z.enum(["intent", "archived", "held", "uncertain", "failed"]),
  /** The catalog placement proved immediately before the native request. */
  observed: z.object({ kind: z.string().min(1).max(40), isPaseoOwnedWorktree: z.boolean(), mainRepoRoot: z.string().max(1024).nullable() }).strict().nullable().default(null),
  /** The task's own thread identities the entry held when the attempt observed it. */
  participants: z.array(z.string().min(1).max(240)).default([]),
  /** Paseo's own answer for this request, as the wire reported it. */
  native: z.object({ archivedAt: z.string().nullable(), error: z.string().max(2000).nullable() }).strict().nullable().default(null),
  /** Observed only: `false` is a hard failure, never a preserved-folder claim. */
  folderPresent: z.boolean().nullable().default(null),
  detail: z.string().max(2000).default(""),
  attempts: z.number().int().nonnegative().default(0),
  /**
   * Spec 017 worktree amendment: the exact clean, published source proof this
   * entry's request relied on, taken immediately before the native call. Null
   * for a catalog-only placement, which never authorizes removal.
   */
  source: z.object({
    head: z.string().min(1).max(80), branch: z.string().min(1).max(240),
    directory: z.string().min(1).max(1024), commonDir: z.string().min(1).max(1024),
    remote: z.string().min(1).max(1024),
    /** The advertised remote branch that contains `head`, or `merge:<branch>`. */
    publication: z.string().min(1).max(240),
    /** The disposable ignored runtime roots the existing cleanup policy allows. */
    ignored: z.array(z.string().min(1).max(1024)).default([]),
  }).strict().nullable().default(null),
  /** True only when a freshly proved worktree source granted folder-removal authority. */
  folderRemovalAuthorized: z.boolean().default(false),
  /** The entry whose authorized archive removed the shared folder, when one did. */
  folderRemovedBy: z.string().min(1).max(240).nullable().default(null),
  /** The complete catalog registrations Queue observed at this exact folder. */
  samePathRegistrations: z.array(z.string().min(1).max(240)).default([]),
  intentAt: z.string().nullable().default(null), settledAt: z.string().nullable().default(null),
  nextAttemptAt: z.string().nullable().default(null),
}).strict();

export type ExternalWorkspaceArchive = z.infer<typeof externalWorkspaceArchiveSchema>;

export const externalArchiveOccurrence = (workspaceId: string, record?: ExternalWorkspaceArchive | null) =>
  JSON.stringify([workspaceId, record?.attempts ?? null, record?.intentAt ?? null]);

export const ownerSettlementMatches = (task: { resolution: { ownerSettlements?: Array<{ effect: string; occurrence: string }> } }, effect: string, occurrence: string) =>
  (task.resolution.ownerSettlements ?? []).some(record => record.effect === effect && record.occurrence === occurrence);

/** True while this catalog archive still owes an attempt or a visible decision. */
export const externalWorkspaceArchivePending = (record: Pick<ExternalWorkspaceArchive, "state">) =>
  record.state === "intent" || record.state === "held" || record.state === "uncertain";

/** A settled entry: archived, or a hard failure that is never replayed. */
export const externalWorkspaceArchiveSettled = (record: Pick<ExternalWorkspaceArchive, "state">) =>
  record.state === "archived" || record.state === "failed";

/**
 * Spec 017: whether every catalog registration Queue observed at a merged
 * review-entry task's exact preserved folder is settled. One entry's archive is
 * never another registration's success, so a task still owes the pass while any
 * registration it observed is unsettled or has no record at all.
 */
export function externalWorkspaceArchivesSettled(task: {
  workspaceId: string | null;
  resolution: { externalWorkspaceArchives?: ExternalWorkspaceArchive[]; ownerSettlements?: Array<{ effect: string; occurrence: string }> };
}): boolean {
  if (!task.workspaceId) return true;
  const archives = task.resolution.externalWorkspaceArchives ?? [];
  if (!archives.some(record => record.workspaceId === task.workspaceId)
      && !ownerSettlementMatches(task, `external_workspace_archive.${task.workspaceId}`, externalArchiveOccurrence(task.workspaceId))) return false;
  const observed = new Set<string>([task.workspaceId, ...archives.flatMap(record => record.samePathRegistrations)]);
  return [...observed].every(workspaceId =>
    archives.some(record => record.workspaceId === workspaceId && externalWorkspaceArchiveSettled(record))
      || ownerSettlementMatches(task, `external_workspace_archive.${workspaceId}`, externalArchiveOccurrence(workspaceId, archives.find(record => record.workspaceId === workspaceId))));
}

/** Per-workspace retry state for terminal task archive failures. */
export const workspaceArchiveRetrySchema = z.object({
  workspaceId: z.string().min(1).max(240), attempts: z.number().int().positive(),
  error: z.string().max(2000), nextAttemptAt: z.string(),
}).strict();

export type WorkspaceArchiveRetry = z.infer<typeof workspaceArchiveRetrySchema>;

/** One operator-authorized stop for the exact turn on a retained task run. */
export const stalledTurnStopSchema = z.object({
  runId: z.string().min(1).max(240), role: z.enum(["worker", "revision", "reviewer"]),
  agentId: z.string().min(1).max(240), workspaceId: z.string().min(1).max(240),
  turnId: z.string().min(1).max(240), effectId: z.string().min(1).max(240),
  status: z.enum(["intent", "sent", "uncertain", "stopped", "completed"]),
  attempts: z.number().int().min(1).max(2), requestedAt: z.string(),
  observedInactiveAt: z.string().nullable().default(null), detail: z.string().max(2000).default(""),
  /** Spec 050 `restart`: the continuation recorded with the stop. Once inactivity is observed the run is released and this instruction goes to the next run instead of parking. */
  restartInstruction: z.string().trim().min(1).max(12000).nullable().optional(),
  restartFresh: z.boolean().optional(),
}).strict();

export type StalledTurnStop = z.infer<typeof stalledTurnStopSchema>;

/**
 * The task's cleanup flag: the first workspace whose teardown or scoped runtime
 * retirement failed. Empty after each archive and captured scope is settled.
 */
export const runtimeRetirementOccurrence = (record: RuntimeRetirement) => JSON.stringify([record.workspaceId, record.capturedAt, record.attempts]);

export function runtimeRetirementFailure(task: { resolution: { runtimeRetirements?: RuntimeRetirement[]; ownerSettlements?: Array<{ effect: string; occurrence: string }> } }): string {
  const failed = (task.resolution.runtimeRetirements ?? []).find(record => record.state === "failed"
    && !ownerSettlementMatches(task, `runtime_retirement.${record.workspaceId}`, runtimeRetirementOccurrence(record)));
  return failed?.error || (failed ? `runtime retirement failed: workspace ${failed.workspaceId}` : "");
}

export const sharedWorkspaceStateSchema=z.object({
  branch:z.enum(["source","base"]).default("source"),
  intent:z.enum(["source","base"]).nullable().default(null),
}).strict();

/** Spec 027: one pinned sibling worktree: the sibling repository identity, its Queue-owned path and the recorded commit. */
export const siblingPinSchema = z.object({
  repository: z.string().min(1).max(1024),
  path: z.string().min(1).max(1024),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

export type SiblingPin = z.infer<typeof siblingPinSchema>;

/** Spec 027: a sibling worktree that moved under a task: expected and observed commits plus dirtiness. */
export const siblingFindingSchema = z.object({
  repository: z.string().min(1).max(1024),
  path: z.string().min(1).max(1024),
  expected: z.string().regex(/^[a-f0-9]{40}$/),
  actual: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  dirty: z.boolean(),
  at: z.string(),
}).strict();

export type SiblingFinding = z.infer<typeof siblingFindingSchema>;

/** Spec 028: a worktree-root sibling checkout Queue did not fast-forward. */
export const checkoutSiblingFindingSchema = z.object({
  path: z.string().min(1).max(1024),
  name: z.string().min(1).max(256),
  state: z.enum(["dirty", "branched", "diverged", "fetch_failed", "fast_forward_failed", "store_failed"]),
  detail: z.string().min(1).max(2000),
  head: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  origin: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  branch: z.string().max(256).nullable(),
  at: z.string(),
}).strict();

export type CheckoutSiblingFinding = z.infer<typeof checkoutSiblingFindingSchema>;

/** Links-only provisioning of a new task checkout (Tom, 2026-10-23): one placed or refused sibling link. */
export const worktreeLinkSchema = z.object({
  name: z.string().min(1).max(256),
  target: z.string().min(1).max(1024),
  outcome: z.enum(["created", "reused", "conflict", "failed"]),
  reason: z.string().max(2000).optional(),
}).strict();

export type WorktreeLink = z.infer<typeof worktreeLinkSchema>;

export const worktreeLinkFindingSchema = z.object({
  kind: z.enum(["manifest_invalid", "ledger_invalid", "argument_unsupported", "source_unresolved", "name_conflict"]),
  name: z.string().max(256).nullable(),
  detail: z.string().min(1).max(2000),
}).strict();

export type WorktreeLinkFinding = z.infer<typeof worktreeLinkFindingSchema>;

const preparedWorktreeLinksSchema = z.object({
  state: z.literal("prepared"), workspaceId: z.string().min(1), directory: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  links: z.array(worktreeLinkSchema).max(200), findings: z.array(worktreeLinkFindingSchema).max(200), at: z.string(),
}).strict();

/**
 * Eligible from the new dispatch intent that will create a checkout (carrying
 * any earlier checkout's final record); pending once that attempt binds a
 * workspace, by creation or recovery; final once the first worker launch placed links.
 */
export const worktreeLinksSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("eligible"), previous: preparedWorktreeLinksSchema.optional() }).strict(),
  // A recorded intent without eligibility (a legacy one) that a validation retry cleared: it never becomes eligible.
  z.object({ state: z.literal("ineligible"), previous: preparedWorktreeLinksSchema.optional() }).strict(),
  z.object({ state: z.literal("pending"), workspaceId: z.string().min(1), directory: z.string().min(1) }).strict(),
  preparedWorktreeLinksSchema,
]);

export type WorktreeLinks = z.infer<typeof worktreeLinksSchema>;

/**
 * Queue #650: the marker an accepted operator stop of live threads records on
 * each Queue-owned run whose active turn was cancelled while Queue was paused.
 * It proves the stop was deliberate: nothing treats the stopped thread as a
 * failure, a non-delivery, a stall or a reason to start a coordinator, and no
 * budget, retry or replacement counter moves. It clears once the run resumes
 * in its own agent thread on unpause.
 */
export const pausedStopSchema = z.object({
  /** When the operator's stop action cancelled the turn. Oldest stop resumes first. */
  at: z.string().datetime({ offset: true }),
  /** Who stopped it: the operator surface or calling thread the control recorded. */
  operator: z.string().trim().min(1).max(200),
  /** The stopped run; null for the task's own initial worker thread (no Run row). */
  runId: z.string().nullable(),
  agentId: z.string().min(1).max(240),
  workspaceId: z.string().min(1).max(240),
  role: z.enum(["worker", "revision", "reviewer", "verification", "closeout", "recovery", "executor"]),
}).strict();

export type PausedStop = z.infer<typeof pausedStopSchema>;

/** The visible wait a deliberately stopped thread holds while Queue is paused (and until it resumes). */
export const pausedStopWaitReason = (role: string) =>
  `The ${role} thread was stopped while Nucleus was paused; Nucleus resumes it in its own thread when the queue starts`;
