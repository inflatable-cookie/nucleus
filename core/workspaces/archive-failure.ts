/**
 * The one classification of a failed archive attempt from a foreign failure
 * message. A teardown or retirement refusal must keep the captured runtime
 * scope so the retirement proof is retried with its own token; a Queue-authored
 * refusal (a hold, a foreign thread, a source-proof failure) must not touch it.
 * Every archive path asks this function, so the classification cannot drift
 * between the terminal archive, the owner retry and unused-workspace cleanup.
 */
export interface ArchiveFailureScope {
  hasScope(taskId: string, workspaceId: string): boolean;
}

export function archiveFailureKeepsScope(scope: ArchiveFailureScope, taskId: string, workspaceId: string, error: unknown): boolean {
  const detail = archiveFailureDetail(error);
  return /teardown/i.test(detail)
    || (scope.hasScope(taskId, workspaceId) && /retire|runtime scope/i.test(detail));
}

/** Whether an uncertain archive's failure names a teardown or retirement attempt at all. */
export function archiveFailureIsTeardown(error: unknown): boolean {
  return /teardown|retire|runtime scope/i.test(archiveFailureDetail(error));
}

function archiveFailureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
