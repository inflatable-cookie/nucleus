import { existsSync, lstatSync, realpathSync } from 'node:fs';
import type { Engine } from '../engine';
import type { Resolution } from '../resolution';
import type { Run, Task } from '../../shared/contracts';
import { runtimeRetirementFailure } from '../../shared/contracts';
import { assertReviewSourceBinding } from '../review/review-source';
import { git, originBranchContaining, verifyRecordedOrigin } from '../git/index';
import { workspaceArchiveFailureReason, type TerminalWorkspace } from './terminal-archive';

/** The engine and resolution facts a missing-workspace reconciliation reads. */
export type GoneWorkspaceContext = Pick<Engine, 'adapter' | 'retirement' | 'store'> & {
  readonly update: Resolution['update'];
  /** The positive archive event and scoped retirement captured for this exact primary checkout. */
  readonly primaryArchived: (task: Task) => boolean;
};

/** What the reconciliation of an absent workspace decided. */
export type GoneWorkspaceOutcome =
  /** The workspace is neither named by an intent nor observed absent: prove it the ordinary way. */
  | { kind: 'present' }
  /** The catalog and disk both lost the workspace; its archive is recorded. */
  | { kind: 'archived'; task: Task }
  /**
   * The catalog reported the workspace absent, or still named with its source
   * retained: only local teardown may follow, and the archive carries the
   * uncertainty it observed.
   */
  | { kind: 'uncertain'; observed: boolean };

/**
 * Reconcile a workspace an interrupted attempt or a foreign removal already
 * took away. An interrupted first attempt leaves intent without result, and a
 * workspace removed outside Queue leaves no intent at all: either way this
 * observation runs before the pre-archive hooks, which run in the retained
 * worktree, so a hook failure or a stale refusal on an already-removed checkout
 * cannot strand the gone-workspace success transaction (Project-a #1900).
 * Disposition observes the same way. An unknown answer is never an archive.
 */
export async function reconcileGoneWorkspace(ctx: GoneWorkspaceContext, task: Task,
  workspace: TerminalWorkspace, id: string, runs: Run[]): Promise<GoneWorkspaceOutcome> {
  const intended = ctx.store.task(task.id).resolution.archiveIntentWorkspaceId === id;
  if (!intended && !(ctx.adapter.taskWorkspaceArchived && !existsSync(workspace.directory!))) return { kind: 'present' };
  if (!ctx.adapter.taskWorkspaceArchived) throw Error(`Waiting to reconcile the uncertain workspace archive for ${id}: workspace observation is unavailable`);
  let observed: boolean;
  try { observed = await ctx.adapter.taskWorkspaceArchived(id); }
  catch (error) {
    if (intended) throw Error(`Waiting to reconcile the uncertain workspace archive for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    observed = false; // No intent: an unanswered observation leaves the ordinary archive path.
  }
  if (!observed || existsSync(workspace.directory!)) return intended ? { kind: 'uncertain', observed } : { kind: 'present' };
  const reviewRun = runs.find(run => run.reviewSourceView?.workspaceId === id);
  if (reviewRun) {
    const view = reviewRun.reviewSourceView!;
    if (!intended || ctx.store.task(task.id).resolution.archiveIntentHead !== view.head)
      throw Error('Missing review view has no matching archive intent');
    assertReviewSourceBinding(ctx.store.task(task.id), reviewRun, ctx.adapter.workspaceIdAccepted?.bind(ctx.adapter));
    if (view.state !== 'ready' || !ctx.primaryArchived(task)) throw Error('Missing review view lacks primary archive and retirement proof');
    // With the target gone an alias cannot be independently checked.
    // Keep the uncertain effect when the original path reappears.
    try { lstatSync(view.sourceDirectory); throw Error('Missing review view has a recreated primary source'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (realpathSync(await git(task.repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== view.commonDir
      || await git(task.repoPath, 'config', '--get', 'remote.origin.url') !== view.origin)
      throw Error('Pinned review canonical Git identity changed');
    await verifyRecordedOrigin(task, task.repoPath);
    if (!await originBranchContaining(task.repoPath, view.head, [task.branch, task.baseBranch]))
      throw Error('Missing review view is not published on the canonical origin');
    if (!ctx.primaryArchived(task) || ctx.store.task(task.id).resolution.archiveIntentWorkspaceId !== id
      || ctx.store.task(task.id).resolution.archiveIntentHead !== view.head)
      throw Error('Review archive proof changed during reconciliation');
  }
  const latest = ctx.store.task(task.id);
  const runtimeRetirements = ctx.retirement.markArchived(latest, id);
  const workspaceArchiveRetries = latest.resolution.workspaceArchiveRetries.filter(record => record.workspaceId !== id);
  const archived = ctx.update(latest, {
    archivedWorkspaceIds: [...new Set([...latest.resolution.archivedWorkspaceIds, id])],
    archiveIntentWorkspaceId: null, archiveIntentHead: null, workspaceArchiveRetries,
    cleanupReason: runtimeRetirementFailure({ resolution: { ...latest.resolution, runtimeRetirements } }) || workspaceArchiveFailureReason(workspaceArchiveRetries),
    runtimeRetirements,
  }, {}, 'workspace_archived', `${intended ? 'workspace_archived' : 'workspace_archived; observed absent from the catalog and disk without a Queue archive intent'}; workspace ${id}`);
  await ctx.retirement.archived(task.id, id);
  return { kind: 'archived', task: archived };
}
