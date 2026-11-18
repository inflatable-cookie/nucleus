import type { Store } from '../../store/store';
import type { Task } from '../../../shared/contracts';

/**
 * A worker creation intent that never bound an agent, on a task with no PR and no
 * accepted result. This is the shape a hung creation leaves behind. Nothing
 * replays it blindly: an owner route or restart may replace it only after an
 * exact lookup proves no agent exists.
 */
export const staleWorkerIntent = (task: Task): boolean =>
  Boolean(task.agentIntent && !task.agentId && task.runId && task.workspaceId && task.directory && task.profile
    && !task.completion && !task.prUrl && !task.prHead && !task.resolution.currentRunId);

/**
 * Release a proven-absent worker creation intent inside the caller's transaction:
 * the intent clears, its credential is revoked and the run identity is dropped,
 * so the next launch mints a new run from the current route. Nothing is archived
 * or stopped, because no thread exists.
 */
export function releaseStaleWorkerIntent(store: Store, task: Task, detail: string): void {
  const runId = task.runId;
  if (runId) store.deleteCredential(runId);
  store.update(task.id, {
    agentIntent: false, runId: null, restartRunId: null,
    briefRuns: task.briefRuns.filter(item => item.runId !== runId),
    laneDocumentRuns: (task.laneDocumentRuns ?? []).filter(item => item.runId !== runId),
  }, 'absent_worker_released', `${runId ?? 'no run'}: ${detail}`);
}
