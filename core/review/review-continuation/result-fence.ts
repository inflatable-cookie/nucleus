import type { Run, Task } from "../../../shared/contracts";
import { digest, type Store } from "../../store/store";
import { resultApplied } from "../../intake/applied-result";

/**
 * A recorded result fences its reader and any unproven binding. A released
 * reviewer's applied impediment belongs to that earlier run, even if the
 * replacement reviews the same head. An earlier verdict at another head is
 * history only after an accepted author return between the two readers.
 */
export function reviewResultFence(
  store: Store,
  task: Task,
  run: Run,
): "clear" | "prior_impediment" | "fenced" {
  const review = task.resolution.review;
  if (!review) return "clear";
  if (
    review.taskId !== task.id ||
    !review.runId ||
    review.runId === run.id ||
    !review.head
  )
    return "fenced";
  const source = store.run(review.runId);
  const completion = source?.completion;
  if (
    !source ||
    !completion ||
    source.taskId !== task.id ||
    source.role !== "reviewer" ||
    !source.released
  )
    return "fenced";
  if (
    completion.runId !== source.id ||
    completion.taskId !== task.id ||
    completion.eventId !== review.eventId ||
    completion.status !== review.status ||
    (completion.head ?? null) !== review.head ||
    source.head !== review.head ||
    source.createdAt >= run.createdAt
  )
    return "fenced";
  if (review.head === run.head) {
    const priorImpediment =
      (review.status === "blocked" || review.status === "error") &&
      task.resolution.currentRunId === run.id &&
      run.taskId === task.id &&
      run.role === "reviewer" &&
      run.head === task.prHead &&
      resultApplied(store, task.id, source.id);
    return priorImpediment ? "prior_impediment" : "fenced";
  }
  const revised = store
    .runs(task.id)
    .some(
      (item) =>
        item.role === "revision" &&
        item.released &&
        item.taskId === task.id &&
        item.completion?.status === "ready_for_review" &&
        item.completion.runId === item.id &&
        item.completion.taskId === task.id &&
        item.createdAt > source.createdAt &&
        item.createdAt < run.createdAt,
    );
  return revised ||
    initialAuthorResultBetween(store, task, source.createdAt, run.createdAt)
    ? "clear"
    : "fenced";
}

export function reviewResultFencesRun(
  store: Store,
  task: Task,
  run: Run,
): boolean {
  return reviewResultFence(store, task, run) === "fenced";
}

/**
 * The current worker's own receipted initial `ready_for_review`, from a worker
 * run created inside (after, before). Timing binds to that exact run: its
 * `agent_intent` event (detail = the run ID, written with `task.runId`) must
 * exist and every one of them must fall inside the window. A worker result is
 * accepted only in a worker phase, so after that intent and before any reviewer
 * run on it. A task-wide `completion_received` event names no run and is not used.
 */
function initialAuthorResultBetween(
  store: Store,
  task: Task,
  after: string,
  before: string,
): boolean {
  const completion = task.completion;
  if (
    !completion ||
    completion.status !== "ready_for_review" ||
    completion.taskId !== task.id ||
    !task.runId ||
    completion.runId !== task.runId
  )
    return false;
  if (store.run(completion.runId)) return false;
  const receipt = store.receiptHash(
    completion.eventId,
    task.id,
    completion.runId,
  );
  if (receipt === null || receipt !== digest(JSON.stringify(completion)))
    return false;
  const intents = store.db
    .prepare(
      "SELECT at FROM events WHERE taskId=? AND kind='agent_intent' AND detail=?",
    )
    .all(task.id, completion.runId) as { at: string }[];
  return (
    intents.length > 0 &&
    intents.every((intent) => intent.at > after && intent.at < before)
  );
}
