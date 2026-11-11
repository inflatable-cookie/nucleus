import type { Task } from "./contracts";

export const BOARD_DISPATCH_HOLD_REASON = "Dispatch held by the operator";
/** Recorded launch intent counts as started: reconciliation must settle it. */
export function boardDispatchHoldApplies(task: Task): boolean {
  return (
    task.phase === "queued" &&
    !task.workspaceIntent &&
    !task.workspaceId &&
    !task.directory &&
    !task.agentIntent &&
    !task.agentId &&
    !task.runId &&
    !task.completion &&
    !task.retiredWorkers.length &&
    !task.resolution.currentRunId
  );
}
