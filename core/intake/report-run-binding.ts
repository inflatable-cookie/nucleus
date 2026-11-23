import {
  isDispositionActive,
  isDispositionComplete,
  type Completion,
  type Run,
  type Task,
} from "../../shared/contracts";
import { isReviewerVerdict, type CompletionIdentity } from "../store/store-auth";
import type { Store } from "../store/store";

export const STALE_REVIEWER_VERDICT =
  "Stale run: its reviewer verdict no longer applies at the current head";

/** A displaced reviewer's first verdict can still settle its own exact head. */
export function reviewerVerdictCanReadopt(
  store: Store,
  task: Task,
  run: Run,
  input: CompletionIdentity,
): boolean {
  if (
    run.role !== "reviewer" ||
    (!run.released && (!run.replacedAt || run.status !== "superseded")) ||
    !run.agentId ||
    run.completion ||
    run.taskId !== task.id ||
    input.runId !== run.id ||
    !isReviewerVerdict(input.status) ||
    !["reviewing", "awaiting_review"].includes(task.phase) ||
    !task.prHead ||
    run.head !== task.prHead ||
    (input.head ?? run.head) !== task.prHead ||
    task.resolution.review?.head === task.prHead ||
    task.resolution.mergeIntent ||
    task.resolution.mergedCommit ||
    isDispositionActive(task) ||
    isDispositionComplete(task)
  )
    return false;
  const runs = store.runs(task.id);
  // A later exact-head verdict ends the claim even if a fresh-review move
  // subsequently clears the task's verdict.
  if (
    runs.slice(runs.findIndex((other) => other.id === run.id) + 1).some(
      (other) =>
        other.role === "reviewer" &&
        other.completion?.head === task.prHead &&
        isReviewerVerdict(other.completion.status),
    )
  )
    return false;
  const currentId = task.resolution.currentRunId;
  const current = currentId && currentId !== run.id ? store.run(currentId) : null;
  // A replacement still being created or delivered would rebind itself.
  return !current || (
    current.role === "reviewer" &&
    !current.completion &&
    (current.released || (
      current.status === "running" && Boolean(current.agentId) &&
      !current.reviewDeliveries?.some(
        (delivery) => delivery.status === "reserved" || delivery.status === "uncertain",
      )
    ))
  );
}

export type ReportRunBinding =
  | "current"
  | "correcting_block"
  | "superseded_executor"
  | "finished_task"
  | "merge_retired_recovery"
  | "stale";

/** One classification for authenticated report runs, shared by the bridge and completion intake. */
export function reportRunBinding(
  task: Task,
  run: Run,
  input: Pick<Completion, "status">,
): ReportRunBinding {
  const currentRunId =
    run.role === "recovery"
      ? task.resolution.recovery?.runId
      : task.resolution.currentRunId;
  const correctingBlock =
    run.role !== "recovery" &&
    !run.released &&
    currentRunId === run.id &&
    Boolean(
      run.completion &&
        ["blocked", "error"].includes(run.completion.status) &&
        !["blocked", "error"].includes(input.status),
    );
  if (
    run.taskId === task.id &&
    run.role === "recovery" &&
    run.mergeRetirement &&
    !run.completion
  )
    return "merge_retired_recovery";
  if (
    run.role === "executor" &&
    run.taskId === task.id &&
    (run.released || currentRunId !== run.id)
  )
    return "superseded_executor";
  if (
    run.role !== "executor" &&
    run.taskId === task.id &&
    ["done", "cancelled"].includes(task.phase)
  )
    return "finished_task";
  if (
    run.taskId !== task.id ||
    currentRunId !== run.id ||
    run.released ||
    (run.completion && !correctingBlock) ||
    (["closeout", "recovery"].includes(run.role) &&
      run.generation !== task.coordinatorGeneration)
  )
    return "stale";
  return correctingBlock ? "correcting_block" : "current";
}
