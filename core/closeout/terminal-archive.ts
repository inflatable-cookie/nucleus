import type { Run, Task } from '../../shared/contracts';
import type { Resolution } from '../resolution';
import { doublingDelay } from '../../shared/backoff';
import { isBackpressureDeferral } from '../host/admission';
import { buildOutputCleanupReasonPrefix } from '../hooks/build-output-records';
import { runtimeRetirementFailure } from '../../shared/contracts';

export const WORKSPACE_ARCHIVE_RETRY_BASE_MS = 60_000;
export const WORKSPACE_ARCHIVE_RETRY_MAX_MS = 60 * 60_000;

/** One recorded archive retry, as the task's resolution holds it. */
export type WorkspaceArchiveRetry = Task['resolution']['workspaceArchiveRetries'][number];

/** One workspace a finished task must archive, with the head its source settles at. */
export type TerminalWorkspace = { id: string | null; directory: string | null; head: string | null; reportSource?: boolean };

export function workspaceArchiveRetryDelay(attempts: number) {
  return doublingDelay(WORKSPACE_ARCHIVE_RETRY_BASE_MS, WORKSPACE_ARCHIVE_RETRY_MAX_MS, attempts);
}

/**
 * Whether a recorded archive retry still waits on its backoff. A breaker
 * deferral never reached Paseo, so it is not a failure to back off from: it is
 * due again on the first pass the breaker admits, like a deferred title.
 */
export function archiveRetryWaiting(retry: WorkspaceArchiveRetry | undefined) {
  return Boolean(retry && !isBackpressureDeferral(retry.error) && Date.parse(retry.nextAttemptAt) > Date.now());
}

export function workspaceArchiveFailureReason(retries: Task['resolution']['workspaceArchiveRetries']) {
  const retry = retries[0];
  return retry ? `Workspace archive for ${retry.workspaceId} failed: ${retry.error}` : '';
}

/**
 * How a finished task's source settles for archive. A proof-only task has a detached
 * checkout at its commit and no branch, so it is never a report-only source, however
 * it ended: a pass, a failure or an owner's acceptance of an interrupted run.
 */
export function terminalArchiveSource(task: Task): { reportOnly: boolean; proofOnlyDone: boolean } {
  const proofOnly = Boolean(task.entrypoint === 'proof' && task.proofOnly);
  return {
    reportOnly: !proofOnly && Boolean(task.reportAcceptance && !task.prUrl && !task.prHead && !task.resolution.mergedCommit && !task.resolution.syncedCommit),
    proofOnlyDone: proofOnly && task.phase === 'done',
  };
}

/** The same terminal workspace identities drive automatic cleanup and owner retries. */
export function terminalArchiveWorkspaces(task: Task, runs: Run[]): TerminalWorkspace[] {
  const { reportOnly, proofOnlyDone } = terminalArchiveSource(task);
  if (task.phase !== 'done' || (!reportOnly && !proofOnlyDone && (!task.resolution.mergedCommit || !task.resolution.syncedCommit))) return [];
  return [
    // A report-only workspace starts at its planning base; the archive derives
    // any preserved donor source beyond it from current Git evidence.
    { id: task.reviewEntry?.preserveWorkspace ? null : task.workspaceId, directory: task.directory,
      head: reportOnly ? task.planningBase : proofOnlyDone ? task.proofOnly!.commit : task.prHead, reportSource: reportOnly },
    { id: task.resolution.closeoutWorkspaceId, directory: task.resolution.closeoutDirectory, head: task.resolution.closeoutWorkspaceHead },
    ...runs.filter(run => run.reviewSourceView?.directory).map(run => ({ id: run.workspaceId, directory: run.reviewSourceView!.directory, head: run.head })),
  ].filter((workspace, index, owned) => owned.findIndex(other => other.id === workspace.id) === index);
}

/** The store and resolution writes a recorded archive retry needs. */
export type ArchiveRetryContext = { readonly store: Resolution['store']; readonly update: Resolution['update'] };

/**
 * Record the existing bounded archive retry for one workspace, keeping every
 * other workspace's record. A thrown refusal names its own cause, which
 * replaces a bound build-output reason; a declined attempt has no error of its
 * own, so it keeps the reason its durable build-output record already names.
 * The attempts and the doubling delay are the existing ones: this adds no
 * suppression and no new stored shape.
 */
export function recordArchiveRetry(ctx: ArchiveRetryContext, taskId: string, id: string, reason: string, keepNamedReason: boolean): void {
  const current = ctx.store.task(taskId);
  const previous = current.resolution.workspaceArchiveRetries.find(record => record.workspaceId === id);
  // A breaker deferral is not an attempt: it neither counts nor doubles the delay.
  const deferred = isBackpressureDeferral(reason);
  const attempts = (previous?.attempts ?? 0) + (deferred ? 0 : 1);
  const nextAttemptAt = new Date(Date.now() + (deferred ? 0 : workspaceArchiveRetryDelay(attempts))).toISOString();
  const workspaceArchiveRetries = [...current.resolution.workspaceArchiveRetries.filter(record => record.workspaceId !== id),
    { workspaceId: id, attempts, error: reason.slice(0, 2000), nextAttemptAt }];
  const named = keepNamedReason && current.resolution.cleanupReason.startsWith(buildOutputCleanupReasonPrefix)
    ? current.resolution.cleanupReason : '';
  const cleanupReason = runtimeRetirementFailure(current) || named || workspaceArchiveFailureReason(workspaceArchiveRetries);
  ctx.update(current, { cleanupReason, workspaceArchiveRetries }, {}, 'workspace_cleanup_wait', `${id}: ${reason}; attempt ${attempts}; next retry ${nextAttemptAt}`);
}
