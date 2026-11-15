/**
 * The thread each live task's planning questions reach (task 1109). A task
 * planner that no live task names is no longer a planner, which is what revokes
 * its ticket; reparenting moves the task, and so the scope.
 *
 * Every authenticated task-planner ticket asks this question, and the answer is
 * a membership test: one early-exit read of the live tasks, with no intermediate
 * set to build.
 */
import { parseAgentId } from "../../../shared/agent-identity";
import { isOperatorOrigin, taskOwner, taskPlanner, type Task } from "../../../shared/contracts";
import type { Store } from "../../store/store";

/** The planning thread one live task names, with the host its identity is proven on. */
interface PlannedThread { nativeAgentId: string; hostId?: string }

function plannedThreadOf(task: Task): PlannedThread | null {
  const planner = taskPlanner(task);
  if (isOperatorOrigin(planner)) return null;
  const qualified = parseAgentId(planner);
  return { nativeAgentId: qualified?.nativeAgentId ?? planner,
    hostId: qualified?.hostId ?? (taskOwner(task) === planner ? task.originHostId : undefined) };
}

/** Whether a ticket's thread still plans a live task, on the host its ticket was issued for. */
export function plannedThreadCovers(store: Store, thread: { nativeAgentId: string; hostId: string }): boolean {
  for (const task of store.liveTasks()) {
    const planned = plannedThreadOf(task);
    if (!planned || planned.nativeAgentId !== thread.nativeAgentId) continue;
    if (!planned.hostId || planned.hostId === thread.hostId) return true;
  }
  return false;
}
