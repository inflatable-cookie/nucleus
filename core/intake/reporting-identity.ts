import type { Task } from "../../shared/contracts";

export interface ReportingIdentityMismatch {
  /** The run identity the durable task holds. */
  runId: string;
  /** The run identity the retained worker's live reporting binding names. */
  bindingRunId: string;
}

/**
 * Read-only diagnostic (Contract 003). A live initial-worker task whose retained
 * reporting binding names another run cannot authenticate a report against the
 * identity its task holds, so the split is reported before the lane stalls into
 * recovery. It reads only the supplied facts and mutates nothing; a caller that
 * records the finding owns that write.
 */
export function reportingIdentityMismatch(task: Task, bindingRunId: string | null | undefined): ReportingIdentityMismatch | null {
  if (!task.runId || !task.agentId || !bindingRunId || bindingRunId === task.runId) return null;
  if (task.completion || task.resolution.currentRunId || task.prUrl || task.prHead || task.resumePrNumber) return null;
  if (!["working", "dispatching", "needs_attention"].includes(task.phase)) return null;
  return { runId: task.runId, bindingRunId };
}
