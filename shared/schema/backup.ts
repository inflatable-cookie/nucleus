import { z } from "zod";

/** Scheduled store snapshots (Spec 028): every 6 hours, plus before every schema migration and on demand (Tom, 2026-10-20). */
export const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The newest snapshot is stale once it is older than one interval plus an hour of grace. */
export const BACKUP_STALE_AFTER_MS = BACKUP_INTERVAL_MS + 60 * 60 * 1000;

/** How often the service checks whether a scheduled snapshot is due; the check only lists the backups directory. */
export const BACKUP_DUE_CHECK_MS = 15 * 60 * 1000;

/**
 * How often the board projection re-reads snapshot health. It is a directory read and
 * a small status file, and a snapshot settling refreshes it at once.
 */
export const BACKUP_HEALTH_REFRESH_MS = 30 * 1000;

/**
 * Spec 028: verified-snapshot health, carried on the board projection so the stale
 * warning needs no `backup.list` poll of its own. `newestSnapshotAt` is the newest
 * verified scheduled snapshot, or null when there is none; `localError` is the last
 * failure recorded for the one backup location, or null.
 */
export const backupHealthSchema = z.object({
  newestSnapshotAt: z.string().nullable(),
  localError: z.string().nullable(),
}).strict();

export type BackupHealth = z.infer<typeof backupHealthSchema>;

/** A failed scheduled snapshot is not retried sooner than this within one service lifetime. */
export const BACKUP_FAILURE_RETRY_MS = 60 * 60 * 1000;

export const backupEntrySchema = z.object({
  name: z.string(), kind: z.enum(['hourly', 'daily', 'weekly']), at: z.string(),
  size: z.number().int().nonnegative(), verified: z.literal(true),
  /** Taken by the operator's Back up now rather than the schedule; absent for scheduled and pre-migration snapshots. */
  manual: z.literal(true).optional(),
}).strict();

/**
 * `dir` is the one live backup directory and `retention` how many of each tier rotation
 * keeps (nucleus#965: the Backups page names both in its help without a second source).
 */
export const backupListSchema = z.object({
  snapshots: z.array(backupEntrySchema), localError: z.string().nullable(),
  dir: z.string().optional(),
  /** Resolved placement for worktrees, QA checkouts, backups and run scratch. */
  workRoot: z.string().optional(),
  retention: z.object({ hourly: z.number().int().nonnegative(), daily: z.number().int().nonnegative(), weekly: z.number().int().nonnegative() }).strict().optional(),
}).strict();

export type BackupList = z.infer<typeof backupListSchema>;
