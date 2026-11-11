/**
 * The canonical caller identity Queue gives a host run it owns for merge-time
 * project validation, and its exact inverse.
 *
 * Project validation is submitted to the host-run scheduler with its own handler
 * and its own supervisor, so — like milestone Project QA (`qa-caller.ts`) — the
 * generic `runs/<id>/stdout` and `runs/<id>/stderr` are never written for it.
 * One owner decides the string, so the producer and the retained-output
 * classification cannot drift.
 */
export function projectValidationCallerIdentity(taskId: string, head: string): string {
  return `queue:validation:${taskId}:${head}`;
}

/** The task and reviewed head a caller names, only when it is exactly the canonical identity. */
export function parseProjectValidationCaller(caller: string): { taskId: string; head: string } | null {
  const match = /^queue:validation:([^:\s]+):([^:\s]+)$/.exec(caller);
  if (!match) return null;
  return projectValidationCallerIdentity(match[1], match[2]) === caller ? { taskId: match[1], head: match[2] } : null;
}

/**
 * The scheduling evidence Queue writes when it hands this exact run to the
 * scheduler: the run, the epoch it was submitted under and the reviewed head.
 *
 * The live validation pin keeps all three, but a pin moves on with each later
 * validation, so the event is what survives. It therefore has to bind all
 * three in one exact string: an event naming only the run id would let a later
 * claim lend this run a head and epoch it never recorded. The store compares
 * the whole string, so nothing here is parsed, prefix-matched or guessed.
 */
export function projectValidationSchedulerEvidence(runId: string, epoch: number, head: string): string {
  return `queue:validation-scheduled:${runId}:${epoch}:${head}`;
}
