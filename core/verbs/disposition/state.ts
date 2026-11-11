import type { Disposition, Task } from "../../../shared/contracts";
import type { Store } from "../../store/store";

export function setDisposition(store: Store, task: Task, disposition: Disposition, kind: string, detail: string): Task {
  return store.update(task.id, { disposition }, kind, detail);
}

export function ownedThreads(task: Task, runs: { id: string; agentId: string | null; released: boolean }[]): { runId: string | null; agentId: string }[] {
  const threads = new Map<string, { runId: string | null; agentId: string }>();
  for (const run of runs) if (!run.released && run.agentId) threads.set(run.agentId, { runId: run.id, agentId: run.agentId });
  if (task.agentId && !threads.has(task.agentId)) threads.set(task.agentId, { runId: task.runId, agentId: task.agentId });
  if (task.coordinatorAgentId && !threads.has(task.coordinatorAgentId)) threads.set(task.coordinatorAgentId, { runId: null, agentId: task.coordinatorAgentId });
  if (task.resolution.reviewerAgentId && !threads.has(task.resolution.reviewerAgentId)) threads.set(task.resolution.reviewerAgentId, { runId: null, agentId: task.resolution.reviewerAgentId });
  for (const retired of task.retiredWorkers) if (!threads.has(retired.agentId)) threads.set(retired.agentId, { runId: retired.runId, agentId: retired.agentId });
  return [...threads.values()];
}

/**
 * Disposition steps in flight, by task. The operator control lane and the engine
 * pass both drive dispositions; without this, a pass re-entered a step whose
 * cancellation hook was still creating its isolated checkout, and two executions
 * of one occurrence deleted and rebuilt the same directory under each other.
 */
export const dispositionsInFlight = new Map<string, Promise<Task>>();

/** True while a disposition step for this task is running in this process. */
export function dispositionInFlight(taskId: string): boolean { return dispositionsInFlight.has(taskId); }
