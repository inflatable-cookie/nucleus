import { archiveFailureIsTeardown } from './archive-failure';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { holdsOf, type Task } from '../../shared/contracts';
import { now, type Store } from '../store/store';
import type { Adapter } from '../host/adapter';
import type { RuntimeRetirementService } from '../runtime/runtime-retirement';
import { proveWorkspaceEmpty } from '../verbs/disposition';
import { workspaceDiscardKey, type WorkspaceDiscard } from './orphan-worktree';
import { git } from '../git/index';
import { buildOutputCleanupHooks } from './worktree-cleanup';

type Retirement = NonNullable<Task['resolution']['workspaceRetirement']>;

export function canRetireCancelledWorkspace(task: Task): boolean {
  return !task.removedAt && task.phase === 'cancelled' && task.disposition?.status === 'complete'
    && !task.reviewEntry && Boolean(task.workspaceId && task.directory)
    && !task.disposition.workspaceArchived && !task.resolution.archivedWorkspaceIds.includes(task.workspaceId!)
    && task.resolution.workspaceRetirement?.state !== 'archived';
}

export function recordWorkspaceRetirement(store: Store, taskId: string, record: Retirement): Task {
  const task = store.task(taskId);
  if (isDeepStrictEqual(task.resolution.workspaceRetirement, record)) return task;
  return store.update(taskId, { resolution: { ...task.resolution, workspaceRetirement: record,
    ...(record.state === 'archived' ? { archivedWorkspaceIds: [...new Set([...task.resolution.archivedWorkspaceIds, record.workspaceId])] } : {}) } },
    `workspace_retirement_${record.state}`, JSON.stringify(record));
}

/** An authorized terminal cleanup owns only its effects, never the original disposition. */
export async function progressWorkspaceRetirement(store: Store, adapter: Adapter, retirement: RuntimeRetirementService,
  taskId: string, running: () => boolean,
  idle: (task: Task) => Promise<ReadonlySet<string>>,
  retention: (target: { directory: string; head: string }) => Promise<{ hold: boolean; detail: string }>): Promise<Task> {
  const task = store.task(taskId), record = task.resolution.workspaceRetirement;
  if (!record || record.state === 'archived' || !running()) return task;
  let uncertain = record.intentAt !== null;
  const write = (patch: Partial<Retirement>) => recordWorkspaceRetirement(store, taskId, { ...store.task(taskId).resolution.workspaceRetirement!, ...patch });
  const unshared = () => !store.workspaceUsedByOtherTaskRun(taskId, record.workspaceId) && !store.tasks().some(other => other.id !== taskId &&
    (other.workspaceId === record.workspaceId || other.directory === record.directory ||
      other.resolution.coordinatorWorkspaceId === record.workspaceId || other.resolution.closeoutWorkspaceId === record.workspaceId));
  const allowed = () => {
    const current = store.task(taskId);
    return running() && canRetireCancelledWorkspace(current) && current.workspaceId === record.workspaceId
      && current.directory === record.directory && current.branch === record.branch
      && !holdsOf(current).dispatch
      && !current.resolution.mergeIntent && !current.resolution.mergedCommit
      && !store.runs(taskId).some(run => !run.released) && unshared();
  };
  try {
    if (!allowed()) throw Error('Workspace retirement is held by task identity, ownership, a hold, merge evidence or an unreleased run');
    if (!adapter.archiveTaskWorkspace || !adapter.taskWorkspaceArchived) throw Error('Workspace archive or observation is unavailable');
    // Papercut c7643943 generalized (owner content discard): a structured discard
    // recorded for exactly this task, workspace and directory waives only the
    // cancellation retirement's content and publication proofs. A record naming
    // another directory is a contradiction: the workspace stays preserved.
    const discardRecord = store.getMeta<WorkspaceDiscard>(workspaceDiscardKey(taskId, record.workspaceId)) ?? null;
    if (discardRecord && (discardRecord.workspaceId !== record.workspaceId || discardRecord.directory !== record.directory))
      throw Error('A recorded content discard names another directory for this workspace; the workspace is preserved');
    const discard = discardRecord;
    // Reconcile delivery before deciding whether another guarded call is safe.
    // A retained directory still owes the ordinary proofs and local teardown.
    const catalogAbsent = uncertain && await adapter.taskWorkspaceArchived(record.workspaceId);
    if (!(catalogAbsent && !existsSync(record.directory))) {
      if (uncertain && !catalogAbsent) {
        uncertain = false;
        write({ state: 'authorized', intentAt: null, detail: 'Workspace observed present; rechecking archive proofs before the same idempotent request' });
      }
      const attached = await idle(task);
      const proof = await proveWorkspaceEmpty(store, task, false, Boolean(discard));
      if (!proof.empty || proof.uncertain) throw Error(proof.uncertain || proof.detail);
      const sourceDetail = discard ? `${proof.detail}; unproven contents discarded by ${discard.caller} (${discard.authority})` : proof.detail;
      if (!adapter.verifyCancelledWorkspacePr || !adapter.findAnyOpenBranchPr) throw Error('Closed PR observation is unavailable');
      await adapter.verifyCancelledWorkspacePr(task);
      if ((await adapter.findAnyOpenBranchPr(task)).length) throw Error('Task branch still has an open PR; workspace preserved');
      const head = await git(record.directory, 'rev-parse', 'HEAD');
      if (record.intentAt && record.head && head !== record.head) throw Error('Workspace head changed since archive intent; source preserved');
      const gate = await retention({ directory: record.directory, head });
      if (gate.hold) throw Error(gate.detail);
      await retirement.capture(taskId, record.workspaceId, record.directory);
      await idle(store.task(taskId));
      if (!allowed()) throw Error('Workspace retirement proof changed before archive');
      const cleanup = buildOutputCleanupHooks(store, taskId, record.workspaceId, record.directory, allowed);
      const archived = await adapter.archiveTaskWorkspace(store.task(taskId), record.workspaceId, record.directory,
        head, () => {
          // The adapter invokes this only after its ownership, thread, Git and
          // build-output checks, immediately before native archive or local teardown.
          if (!allowed()) return false;
          write({ state: 'intent', intentAt: now(), head, detail: sourceDetail });
          uncertain = true;
          return true;
        }, Boolean(catalogAbsent), true, attached, true, false, cleanup, undefined, discard);
      if (!archived) {
        // A refusal before any intent is held. Keep prior intent uncertain:
        // native delivery may already have happened before local teardown refused.
        return write({ state: uncertain ? 'uncertain' : 'held', intentAt: uncertain ? store.task(taskId).resolution.workspaceRetirement!.intentAt : null, detail: store.task(taskId).resolution.cleanupReason || 'Workspace archive declined before effect' });
      }
    }
    await retirement.archived(taskId, record.workspaceId);
    const runtime = retirement.record(store.task(taskId), record.workspaceId);
    // The archive is confirmed, however it was observed. Record the applied
    // content discard once, so a delivery that landed without its reply still
    // names what was lost when the retirement settles from observation.
    if (discard && !store.events(taskId).some(event => event.kind === 'workspace_contents_discarded'))
      store.event(taskId, 'workspace_contents_discarded', JSON.stringify({ ...discard, detail: 'Unproven contents discarded: no clean or published source is claimed' }));
    const base = runtime?.state === 'failed' ? `Workspace archived; ${runtime.error}`
      : discard ? 'Workspace archived; no clean or published source is claimed and cancellation history is unchanged'
      : 'Workspace archive observed; source remains published and cancellation history is unchanged';
    const discarded = discard ? `; unproven contents discarded by ${discard.caller} (${discard.authority})` : '';
    return write({ state: 'archived', archivedAt: now(), detail: base + discarded });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (uncertain && archiveFailureIsTeardown(error)) retirement.flagArchiveFailure(taskId, record.workspaceId, detail);
    return write({ state: uncertain ? 'uncertain' : 'held', detail });
  }
}
