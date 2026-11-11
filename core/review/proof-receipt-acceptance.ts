import { isDeepStrictEqual } from 'node:util';
import type { Task } from '../../shared/contracts';

/** The latest receipt must be the very receipt the failed qualification judged. */
export function receiptAcceptanceRefusal(task: Task): string | null {
  if (task.entrypoint !== 'proof' || task.phase !== 'done' || !task.proofOnly || !task.proofExecution || task.proofOnlyResult?.status !== 'failed')
    return 'Receipt acceptance requires a completed failed proof-only qualification';
  const receipt = task.proofExecutions.at(-1);
  if (!receipt) return 'No executor receipt is recorded';
  if (receipt.historical || receipt.runId !== task.proofOnlyResult.executionRunId) return 'The receipt is historical or superseded';
  if (!receipt.settledAt || receipt.status !== 'passed' || receipt.exitCode !== 0) return 'The executor result is failed, unknown or unsettled';
  if (receipt.head !== task.proofOnly.commit || task.proofOnlyResult.commit !== task.proofOnly.commit) return 'Receipt commit does not match the qualification';
  if (receipt.selector !== task.proofExecution.selector || task.proofOnlyResult.selector !== task.proofExecution.selector) return 'Receipt selector does not match the qualification';
  if (!isDeepStrictEqual(receipt.inputs, task.proofExecution.inputs)) return 'Receipt inputs do not match the qualification';
  return null;
}
