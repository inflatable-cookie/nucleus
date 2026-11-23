import type { Task } from "../../shared/contracts";

/**
 * Force's caller refusal, shared by previews, applying controls and offline
 * admission. It names the reason this caller lacks authority, not a generic list.
 */
export function forceCallerRefusal(
  caller: string | undefined,
  critical?: boolean,
): string {
  if (!caller)
    return "Force requires an authenticated caller; this control carried none";
  if (critical)
    return "Force is refused for this caller: a critical task allows only its live project planner, the Nucleus planner or the operator to force it";
  return "Force is refused for this caller: it is not the task's live project planner, the Nucleus planner, the operator, or this task's authenticated worker, reviewer or recovery run";
}
export const FORCE_REASON_REFUSAL = "Force requires a reason";
export const FORCE_ACTION_REFUSAL = "Force applies only to move";
export const FORCE_MOVE_REFUSAL = "This task cannot be moved; read next";
export const FORCE_MERGED_REFUSAL =
  "The PR is already recorded as merged; use move to closeout with force and a reason";
export const FORCE_PAUSED_REFUSAL =
  "Nucleus is paused; unpause before requesting a merge";
export const FORCE_MERGE_UNAVAILABLE_REFUSAL =
  "GitHub guarded merge is unavailable; read next and retry when it is available";
export const FORCE_HOLD_REFUSAL =
  "Task self-force cannot clear a planner/operator hold or disposition; ask for the ruling";
export const FORCE_MERGE_OBSERVATION_REFUSAL =
  "GitHub merge observation is unavailable; read next and retry when it is available";
export const NO_PENDING_EFFECT_REFUSAL =
  "No failed or uncertain side effect is recorded on this task";
export const RETAINED_PREREQUISITE_REFUSAL =
  "Task is waiting for its retained prerequisites; wait for the owner notice or clear the wait";
export const NO_RESOLUTION_RUN_REFUSAL = "No resolution run to resume";

export function restartTerminalRefusal(
  task: Task,
  parkedRefusal?: string,
): string {
  const why =
    parkedRefusal && task.resolution.recovery?.status === "escalated"
      ? `, and ${parkedRefusal[0]!.toLowerCase()}${parkedRefusal.slice(1)}`
      : "";
  const hint =
    task.resolution.mergedCommit && !["done", "cancelled"].includes(task.phase)
      ? "; use closeout.now to close the merged task"
      : "";
  return `restart requires an unfinished, unmerged task; this task is ${task.phase}${why}${hint}`;
}
