/**
 * Canonical caller and scheduler evidence for Queue-owned project validation.
 * These strings cross the client and host-run boundaries, so their format has
 * one process-neutral owner.
 */
export function projectValidationCallerIdentity(taskId: string, head: string): string {
  return `queue:validation:${taskId}:${head}`;
}

/** The task and reviewed head a caller names, only when it is exactly canonical. */
export function parseProjectValidationCaller(caller: string): { taskId: string; head: string } | null {
  const match = /^queue:validation:([^:\s]+):([^:\s]+)$/.exec(caller);
  if (!match) return null;
  return projectValidationCallerIdentity(match[1], match[2]) === caller ? { taskId: match[1], head: match[2] } : null;
}

/**
 * Scheduling evidence Queue writes when handing this exact run to the
 * scheduler: the run, submission epoch and reviewed head in one exact value.
 */
export function projectValidationSchedulerEvidence(runId: string, epoch: number, head: string): string {
  return `queue:validation-scheduled:${runId}:${epoch}:${head}`;
}
