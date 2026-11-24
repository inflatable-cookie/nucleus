import { z } from "zod";

/**
 * Settings → Storage (nucleus#1526): every work-volume location Nucleus writes is
 * one setting with a portable default derived from `workRoot`. A configured path
 * must be canonical, absolute and strictly inside `workRoot`, on the pinned
 * volume, with no symlinked component; the service refuses without falling back
 * to internal storage. A saved change applies the next time the service starts.
 */
export const workStoragePathsSchema = z
  .object({
    worktreesRoot: z.string().min(1),
    backupRoot: z.string().min(1),
    /** The TypeScript engine only: the Rust engine has no QA records (Spec 070 ruling 12). */
    projectQaRoot: z.string().min(1).optional(),
    scratchRoot: z.string().min(1),
    /** The TypeScript engine only: Barge custodian handshakes. */
    custodianRoot: z.string().min(1).optional(),
    /** The Rust engine only: its log directory (Spec 070 ruling 19). */
    logRoot: z.string().min(1).optional(),
  })
  .strict();

/** The retired `<workRoot>/queue/...` locations an existing install still reads. */
export const workStorageRetiredSchema = z
  .object({
    worktreesRoot: z.string().min(1).nullable(),
    backupRoot: z.string().min(1).nullable(),
    projectQaRoot: z.string().min(1).nullable(),
  })
  .strict();

export const workStorageStateSchema = z
  .object({
    workRoot: z.string().min(1),
    /** The pinned volume identity, or null when this install is not pinned. */
    workVolumeId: z.string().min(1).nullable(),
    worktreesRoot: z.string().min(1),
    backupRoot: z.string().min(1),
    projectQaRoot: z.string().min(1).optional(),
    scratchRoot: z.string().min(1),
    custodianRoot: z.string().min(1).optional(),
    logRoot: z.string().min(1).optional(),
    /** The Rust engine only: where its database lives. */
    databaseRoot: z.string().min(1).optional(),
    /** Null when the engine resolves platform defaults itself and does not report them. */
    defaults: workStoragePathsSchema.nullable(),
    /**
     * The values `settings.json` itself holds, by field; null means no stored
     * value, so the portable default applies (and an environment override maybe).
     * Environment values are never reported here.
     */
    overrides: z
      .object({
        workRoot: z.string().min(1).nullable(),
        // An absent field is not a setting on this engine; its path is shown read-only.
        worktreesRoot: z.string().min(1).nullable().optional(),
        backupRoot: z.string().min(1).nullable().optional(),
        projectQaRoot: z.string().min(1).nullable().optional(),
        scratchRoot: z.string().min(1).nullable().optional(),
        custodianRoot: z.string().min(1).nullable().optional(),
        logRoot: z.string().min(1).nullable().optional(),
      })
      .strict(),
    retired: workStorageRetiredSchema.nullable(),
    /** The Rust engine only: how many verified backups it keeps and for how long. */
    retention: z
      .object({
        keepNewest: z.number().int().nonnegative(),
        maxAgeDays: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .optional(),
    /** The Rust engine only: its verified backups (Spec 070 ruling 17 folds them into Storage). */
    backups: z
      .object({
        verified: z.number().int().nonnegative(),
        newestAt: z.string().nullable(),
        issues: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** Task workspaces from before a class moved stay supported for continuation and cleanup. */
    retainedRoots: z.array(z.string().min(1)),
    /** A saved change takes effect when the service next starts. */
    appliesOnRestart: z.literal(true),
  })
  .strict();

export type WorkStorageState = z.infer<typeof workStorageStateSchema>;

/** One save: an omitted class keeps its value, and null restores the portable default. */
export const workStorageInputSchema = z
  .object({
    workRoot: z.string().min(1).nullable().optional(),
    workVolumeId: z.string().min(1).nullable().optional(),
    worktreesRoot: z.string().min(1).nullable().optional(),
    backupRoot: z.string().min(1).nullable().optional(),
    projectQaRoot: z.string().min(1).nullable().optional(),
    scratchRoot: z.string().min(1).nullable().optional(),
    custodianRoot: z.string().min(1).nullable().optional(),
    logRoot: z.string().min(1).nullable().optional(),
  })
  .strict();

export type WorkStorageInput = z.infer<typeof workStorageInputSchema>;
