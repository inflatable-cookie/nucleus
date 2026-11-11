import type { Task } from '../../shared/contracts';

/** Refusal wording shared by previews, applying controls and offline admission. */
export const FORCE_CALLER_REFUSAL = "Force requires the task project planner, Nucleus planner, operator, or this task authenticated worker, reviewer or recovery run; critical tasks prohibit self-force";
export const FORCE_REASON_REFUSAL = "Force requires a reason";
export const FORCE_ACTION_REFUSAL = "Force applies only to move or retry_effect";
export const FORCE_MOVE_REFUSAL = "This task cannot be moved; read next";
export const FORCE_MERGED_REFUSAL = "The PR is already recorded as merged; use move to closeout with force and a reason";
export const FORCE_PAUSED_REFUSAL = "Nucleus is paused; unpause before requesting a merge";
export const FORCE_MERGE_UNAVAILABLE_REFUSAL = "GitHub guarded merge is unavailable; read next and retry when it is available";
export const FORCE_HOLD_REFUSAL = "Task self-force cannot clear a planner/operator hold or disposition; ask for the ruling";
export const FORCE_MERGE_OBSERVATION_REFUSAL = "GitHub merge observation is unavailable; read next and retry when it is available";
export const FORCE_EFFECT_REQUIRED_REFUSAL = "Name the effect to settle; read next for the recorded effects";
export const FORCE_PUBLICATION_REFUSAL = "Force cannot discard an accepted review verdict; use retry_effect without force to observe and publish the original verdict";
export const NO_PENDING_EFFECT_REFUSAL = "No failed or uncertain side effect is recorded on this task";
export const RETAINED_PREREQUISITE_REFUSAL = "Task is waiting for its retained prerequisites; wait for the owner notice or clear the wait";
export const NO_RESOLUTION_RUN_REFUSAL = "No resolution run to resume";

export function missingForcedEffectRefusal(effect: string): string {
  return `No recorded blocking effect ${effect}; read next for current effects`;
}

export function restartTerminalRefusal(task: Task, parkedRefusal?: string): string {
  const why = parkedRefusal && task.resolution.recovery?.status === 'escalated'
    ? `, and ${parkedRefusal[0]!.toLowerCase()}${parkedRefusal.slice(1)}` : '';
  return `restart requires an unfinished, unmerged task; this task is ${task.phase}${why}`;
}
