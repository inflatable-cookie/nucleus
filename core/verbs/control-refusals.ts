import {
  mergeReviewEvidenceAt,
  isDispositionActive,
  type Task,
  type Run,
} from "../../shared/contracts";
import { taskNeverDispatched } from "../task-decision-rules";
import type { Store } from "../store/store";
import type { VerifiedEnclosingOperation } from "../planning/enclosing-operation";
import { blockingRecoveryEffectsRefusal } from "../recovery/recovery-effects";

export const REMOVED_TASK_REFUSAL = "Task was removed from the queue";
export const DISPOSITION_CONTROL_REFUSAL =
  "A cancel or supersede disposition owns this task";
export const COMPLETE_MERGING_REFUSAL =
  "The task is merging or merged; complete cannot end it";
export const COMPLETE_PR_REFUSAL =
  "The task has a PR; complete applies to a task with no PR to merge";
export const COMPLETE_UNDISPATCHED_REFUSAL =
  "The task never dispatched; complete finishes dispatched work, so cancel or re-queue it instead";
export const MOVE_REVIEW_PR_REFUSAL = "Move to review needs a task PR";

export function completeTerminalRefusal(task: Task): string {
  return `The task is ${task.phase}; complete applies to an unfinished task`;
}
export function routeTerminalRefusal(task: Task): string {
  return `route requires an unfinished, unmerged task; this task is ${task.phase}`;
}
export function moveTerminalRefusal(task: Task, to: string): string {
  return to === "review"
    ? "Move to review needs an unmerged task before merge intent"
    : to === "merge"
      ? `Move to merge needs an unmerged task before merge intent; this task is ${task.phase}`
      : `Move to work needs an unfinished, unmerged task; this task is ${task.phase}`;
}
export function parkedRestartRefusal(role: string, refusal: string): string {
  return `No stopped, stalled, idle, checkpointed, blocked or errored ${role} run needs a restart, and ${refusal[0]!.toLowerCase()}${refusal.slice(1)}`;
}
/** These stored refusals run in the completion handler's order at every boundary. */
export function completeStateRefusal(task: Task, runs: Run[]): string | null {
  if (["done", "cancelled"].includes(task.phase))
    return completeTerminalRefusal(task);
  if (isDispositionActive(task)) return DISPOSITION_CONTROL_REFUSAL;
  if (
    task.resolution.mergeIntent ||
    task.resolution.mergedCommit ||
    task.resolution.syncedCommit ||
    task.resolution.externalMerge
  )
    return COMPLETE_MERGING_REFUSAL;
  if (
    task.completion?.prNumber ||
    task.resumePrNumber ||
    task.prUrl ||
    task.prHead ||
    task.reviewEntry
  )
    return COMPLETE_PR_REFUSAL;
  if (taskNeverDispatched(task, runs)) return COMPLETE_UNDISPATCHED_REFUSAL;
  return null;
}

export function routeStateRefusal(task: Task): string | null {
  if (task.removedAt) return REMOVED_TASK_REFUSAL;
  if (isDispositionActive(task)) return DISPOSITION_CONTROL_REFUSAL;
  return ["done", "cancelled"].includes(task.phase) ||
    task.resolution.mergedCommit
    ? routeTerminalRefusal(task)
    : null;
}

/** Each move target keeps its handler's precedence; closeout accepts merged history. */
export function moveStateRefusal(
  task: Task,
  to: "work" | "review" | "merge" | "closeout",
): string | null {
  if (task.removedAt) return REMOVED_TASK_REFUSAL;
  const terminal =
    to !== "closeout" &&
    (["done", "cancelled"].includes(task.phase) ||
      task.resolution.mergedCommit ||
      task.resolution.mergeIntent);
  if (to === "review" && terminal) return moveTerminalRefusal(task, to);
  if (isDispositionActive(task)) return DISPOSITION_CONTROL_REFUSAL;
  return terminal ? moveTerminalRefusal(task, to) : null;
}

export const EXTERNAL_MERGE_STATE_REFUSAL =
  "Only an unmerged dispatched task can accept an external merge";

export function externalMergeStateRefusal(
  task: Task,
  reviewEntryBoundary: boolean,
): string | null {
  return (!reviewEntryBoundary &&
    ["done", "cancelled", "queued"].includes(task.phase)) ||
    task.resolution.mergeIntent ||
    task.resolution.mergedCommit
    ? EXTERNAL_MERGE_STATE_REFUSAL
    : null;
}

/** Durable execution effects that fence both dispatched closeout routes. */
export function closeoutEffectRefusal(
  store: Store,
  task: Task,
  enclosing?: VerifiedEnclosingOperation,
): string | null {
  return blockingRecoveryEffectsRefusal(store, task, {
    enclosing,
    kinds: [
      "operation",
      "hook",
      "run-delivery",
      "review-delivery",
      "publication",
      "attention-notice",
    ],
  });
}

/** Recorded merges use synchronization. A still-pending merge owns its own outcome. */
export function closeoutMoveStateRefusal(
  task: Task,
  reviewEntryBoundary: boolean,
  hasPr: boolean,
): string | null {
  if (["done", "cancelled"].includes(task.phase))
    return `Move to closeout requires an unfinished task; this task is ${task.phase}`;
  if (
    !hasPr ||
    (!reviewEntryBoundary && ["queued", "dispatching"].includes(task.phase))
  )
    return "Moving to closeout requires a dispatched task with a PR";
  return task.resolution.mergedCommit
    ? null
    : externalMergeStateRefusal(task, reviewEntryBoundary);
}

export function recordedCloseoutRefusal(
  task: Task,
  reviewRequired: boolean,
): string | null {
  const head = task.resolution.mergeHead;
  if (!head) return "The recorded merge has no exact head to verify";
  return reviewRequired && !mergeReviewEvidenceAt(task, head)
    ? "The merged head has no recorded exact-head review or operator source acceptance"
    : null;
}

export function stopStateRefusal(task: Task): string | null {
  if (task.removedAt) return REMOVED_TASK_REFUSAL;
  const turnHint = task.resolution.integrationTurn
    ? "; use turn.release to release its integration turn"
    : "";
  if (isDispositionActive(task)) return `${DISPOSITION_CONTROL_REFUSAL}${turnHint}`;
  return ["done", "cancelled"].includes(task.phase) ||
    task.resolution.mergedCommit
    ? `stop applies to unfinished work; this task is ${task.phase}${turnHint}`
    : null;
}

export const MOVE_WORK_AUTHOR_REFUSAL =
  "Move to work requires the task author; no retained or intended worker exists";
export const MOVE_WORK_REPLACEMENT_REFUSAL =
  "A worker replacement is already being created; let that launch settle before moving to work";
export const MOVE_REVIEW_WORKSPACE_REFUSAL =
  "Move to review requires the retained worker and workspace with no pending replacement";
export const MOVE_MERGE_ACCEPTANCE_REFUSAL =
  "The review at the current head already approves merging; move to merge needs no owner acceptance";
