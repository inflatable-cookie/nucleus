import type { Run, Task } from "../../shared/contracts";
import { isDispositionComplete } from "../../shared/disposition";
import { holdFencesView, taskHoldKind } from "../../shared/holds";
import { taskAttention, type TaskAttention } from "../../shared/task-attention";
import type { TaskStopReason } from "../../shared/task-stop";
import { isTerminalPhase } from "../../shared/task-state";
import { taskDetailView } from "../../shared/task-view";
import {
  taskWaitStateContext,
  taskWithCurrentWait,
} from "../recovery/wait-context";
import type { Store } from "../store/store";

const PASSIVE_WAIT_STOPS: ReadonlySet<TaskStopReason> = new Set([
  "lifecycle",
  "capacity",
  "host_unavailable",
  "external_unavailable",
  "origin_busy",
  "paused_stop",
  "pr_head_lag",
  "validation",
]);

/**
 * Whether a resolution role run has confirmed or observed live execution.
 *
 * A run reservation (`intent`) or uncertain delivery (`uncertain`) still owns
 * delivery and holds capacity (`runHoldsSlot`, `taskHasUnreleasedRun`), while
 * row visibility and the T3 inbox count only count a bound running role or a
 * positively observed active turn (nucleus#1453).
 */
export function runHasLiveExecution(run: Run): boolean {
  if (run.released || run.completion || run.pausedStop) return false;
  if (!run.agentId) return false;
  if (run.status === "running") return run.active !== false;
  if (run.status === "intent" || run.status === "uncertain")
    return run.active === true;
  return false;
}

/**
 * Whether the task's initial worker has confirmed or observed live execution.
 *
 * Unbound `agentIntent` reservations hold capacity (`taskHasUnreleasedRun`),
 * but have no running role on the host yet (nucleus#1453).
 */
export function workerHasLiveExecution(task: Task): boolean {
  if (isDispositionComplete(task) && isTerminalPhase(task.phase)) return false;
  if (task.pausedStop) return false;
  if (task.agentActive === true) return true;
  return Boolean(
    task.agentId &&
      task.agentIntent &&
      task.agentActive !== false &&
      task.completion === null,
  );
}

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
  const stop = display.resolution.stop;
  const passiveWait =
    Boolean(stop && PASSIVE_WAIT_STOPS.has(stop.reason)) &&
    task.resolution.incident?.status !== "escalated" &&
    task.resolution.recovery?.status !== "escalated";
  return taskAttention({
    phase: task.phase,
    held: task.held,
    // The fences as the board reads them: resolved owner, and the planner's nudge
    // answer for a planner's own hold (nucleus#1419).
    holds: holdFencesView(task),
    holdKind: taskHoldKind(task),
    attention: task.resolution.attention,
    originFault: Boolean(task.originError || task.originLookupError),
    prerequisiteWait:
      display.waitState?.state === "waiting_prerequisite" &&
      display.waitState.owner !== "operator",
    prerequisiteOperator:
      display.waitState?.state === "waiting_prerequisite" &&
      display.waitState.owner === "operator",
    passiveWait,
    reason: display.reason,
    liveRun: runs.some(runHasLiveExecution) || workerHasLiveExecution(task),
  });
}
