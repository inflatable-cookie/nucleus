import type { Run, Task } from '../../shared/contracts';

/**
 * The one durable `archiveIntentWorkspaceId` names a native archive whose outcome
 * is unknown until it is observed. It survives a lost reply, so these derive what
 * the owner is offered and what the cleanup lane owes. They touch no Git, catalog
 * or store.
 */

/** True when the recorded intent still names a workspace that is not archived. */
export function archiveIntentOutstanding(task: Task): boolean {
  const intentId = task.resolution.archiveIntentWorkspaceId;
  return Boolean(intentId && !task.resolution.archivedWorkspaceIds.includes(intentId) && !archiveSettledByOwner(task, intentId));
}

/** Owner settlement names the existing archive occurrence without claiming it succeeded. */
export function archiveSettledByOwner(task: Task, workspaceId: string): boolean {
  const retry = task.resolution.workspaceArchiveRetries.find(record => record.workspaceId === workspaceId);
  const occurrence = JSON.stringify([workspaceId, retry?.attempts ?? null]);
  return task.resolution.ownerSettlements.some(record => record.effect === `workspace_archive.${workspaceId}` && record.occurrence === occurrence);
}

/** The workspace the task's recorded intent names, when no reviewer run can be read for it. */
export function archiveIntentUnreadable(task: Task, runs: Run[], retryWorkspaceId?: string): string | null {
  const intentId = task.resolution.archiveIntentWorkspaceId;
  if (!intentId) return null;
  if (retryWorkspaceId !== intentId && archiveSettledByOwner(task, intentId)) return null;
  if (task.resolution.archivedWorkspaceIds.includes(intentId)) return null;
  return runs.some(run => run.workspaceId === intentId && run.role === 'reviewer') ? null : intentId;
}
