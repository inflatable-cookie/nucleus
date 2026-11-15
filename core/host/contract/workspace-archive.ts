/**
 * The external-workspace archive surface (Spec 017): one catalog-only archive of
 * a preserved external workspace, every catalog registration for one folder,
 * and the task-workspace archive a closeout asks for. Nothing here may claim a
 * folder was archived on a host call alone.
 */
import type { BuildOutputCleanupHooks, WorkspaceDiscard } from '../types';
import type { Run, Task } from '../../../shared/contracts';

/**
 * Spec 017: the catalog placement a preserved external workspace's archive
 * proof reads before it asks Paseo to archive the sidebar entry.
 */
export interface ExternalWorkspacePlacement { kind: string; isPaseoOwnedWorktree: boolean; mainRepoRoot: string | null; }
/**
 * Spec 017 worktree amendment (Tom, 2026-10-25): the exact clean, published
 * source a worktree placement must prove before Paseo's archive may remove its
 * folder. Queue never resets, cleans, stashes, rewrites or pushes to obtain it.
 */
export interface ExternalWorktreeSource {
  head: string; branch: string; directory: string; commonDir: string; remote: string;
  /** The advertised canonical-remote branch that contains `head`, or `merge:<branch>`. */
  publication: string;
  /** The disposable ignored runtime roots the existing cleanup policy already owns. */
  ignored: string[];
}
/** One catalog registration listed at exactly the preserved folder. */
export interface ExternalWorkspaceCatalogEntry {
  workspaceId: string; directory: string;
  /** The placement the listing reported, or null with the refusal cause. */
  placement: ExternalWorkspacePlacement | null; reason?: string;
}
/**
 * Every catalog registration for one exact folder. `ok: false` means the
 * inventory could not be established completely; nothing may be called.
 */
export type ExternalWorkspaceCatalog =
  | { ok: true; entries: ExternalWorkspaceCatalogEntry[] }
  | { ok: false; reason: string };
/** The recorded identity of the task that owns the preserved folder. */
export interface ExternalWorkspaceSourceExpectation {
  branch: string; baseBranch: string; repository: string | null; repoPath: string;
}
export interface ExternalWorkspaceArchiveInput {
  taskId: string;
  workspaceId: string;
  directory: string;
  /** Every thread identity this task may own in that workspace. */
  ownedAgentIds: ReadonlySet<string>;
  /** Stable native idempotency identity for this one catalog operation. */
  requestId: string;
  /** The task's recorded workspace identity the source proof binds. */
  expected: ExternalWorkspaceSourceExpectation;
  /** Every other catalog registration for this exact folder, which shares its backing. */
  samePathWorkspaceIds: readonly string[];
  /** The durable removal of this shared folder by an earlier authorized archive. */
  folderRemoval: { workspaceId: string; head: string } | null;
  /**
   * Called once, immediately before the native request. It re-reads the task
   * and persists the durable intent, including the exact source proof this
   * entry's removal permission rests on; `false` declines with nothing sent.
   */
  allowed(observed: ExternalWorkspacePlacement, participants: string[], source: ExternalWorktreeSource | null): boolean;
}
/**
 * The answer of one catalog-only archive attempt. `refused`, `declined` and
 * `failed` sent no request that Queue accepts; `uncertain` means the native
 * outcome is unknown and only an observation may settle it.
 */
export type ExternalWorkspaceArchiveOutcome =
  | { status: 'archived'; observed: ExternalWorkspacePlacement; participants: string[]; native: { archivedAt: string | null; error: string | null }; folderPresent: boolean }
  | { status: 'declined'; reason: string }
  | { status: 'refused'; reason: string; observed?: ExternalWorkspacePlacement; participants?: string[] }
  | { status: 'uncertain'; reason: string; observed?: ExternalWorkspacePlacement; participants?: string[]; native?: { archivedAt: string | null; error: string | null } }
  | { status: 'failed'; reason: string; observed?: ExternalWorkspacePlacement; participants?: string[]; native?: { archivedAt: string | null; error: string | null } };

/**
 * The external-workspace archive surface: one catalog-only archive, the complete
 * catalog at one folder, and the task-workspace archive proof a closeout asks for.
 */
export interface HostWorkspaceArchive {
  /**
   * Spec 017: archive one merged review-entry task's Paseo sidebar entry while
   * preserving its external folder. The implementation must refuse before the
   * native call unless the source-traced placement proof shows Paseo can only
   * change its catalog, and must never claim the folder was archived.
   */
  archiveExternalWorkspace?(input: ExternalWorkspaceArchiveInput): Promise<ExternalWorkspaceArchiveOutcome>;
  /**
   * Spec 017 worktree amendment: every catalog registration listed at exactly
   * this preserved folder, so one entry's archive never assumes it is the only
   * one whose backing it might remove. A complete walk or an explicit refusal.
   */
  externalWorkspaceCatalog?(directory: string): Promise<ExternalWorkspaceCatalog>;
  archiveTaskWorkspace?(task:Task,id:string,directory:string,expectedHead:string,allowed:()=>boolean,uncertain:boolean,requirePublished?:boolean,attachedAgentIds?:ReadonlySet<string>,requireDirectory?:boolean,allowIdleForeignThreads?:boolean,buildOutputCleanup?:BuildOutputCleanupHooks,reviewRun?:Run,discard?:WorkspaceDiscard|null,primaryArchived?:()=>boolean):Promise<boolean|string[]>;
  taskWorkspaceArchived?(id:string):Promise<boolean>;
}
