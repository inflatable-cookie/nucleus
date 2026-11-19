import type { Task } from "../../shared/contracts";
import { holdsOf, taskHoldKind } from "../../shared/holds";
import { taskAttention, type TaskAttention } from "../../shared/task-attention";
import { isTerminalPhase } from "../../shared/task-state";
import { taskDetailView, taskHasUnreleasedRun } from "../../shared/task-view";
import {
  taskWaitStateContext,
  taskWithCurrentWait,
} from "../recovery/wait-context";
import type { Store } from "../store/store";

/**
 * The task's row attention from the one shared projection (`shared/task-attention.ts`).
 * Terminal phases settle immediately without querying runs or dependencies.
 */
export function taskRowAttention(store: Store, task: Task): TaskAttention {
  if (isTerminalPhase(task.phase)) return { state: "finished" };
  const runs = store.runs(task.id);
  const context = taskWaitStateContext(store, task, null);
  const display = taskDetailView(
    taskWithCurrentWait(store, task, context),
    context,
    runs,
  );
  return taskAttention({
    phase: task.phase,
    held: task.held,
    holds: holdsOf(task),
    holdKind: taskHoldKind(task),
    attention: task.resolution.attention,
    originFault: Boolean(task.originError || task.originLookupError),
    prerequisiteWait:
      display.waitState?.state === "waiting_prerequisite" &&
      display.waitState.owner !== "operator",
    prerequisiteOperator:
      display.waitState?.state === "waiting_prerequisite" &&
      display.waitState.owner === "operator",
    reason: display.reason,
    liveRun:
      runs.some((run) => !run.released && !run.completion) ||
      taskHasUnreleasedRun(task),
  });
}
