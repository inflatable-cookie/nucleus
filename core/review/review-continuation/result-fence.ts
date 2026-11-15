/**
 * Whether an earlier recorded review result fences this reviewer run's
 * checkpoint continuation. The one history exception (the result ended an
 * earlier review round) is stated with the predicate.
 */
import type { Run, Task } from "../../../shared/contracts";
import { digest, type Store } from "../../store/store";

/**
 * Whether the task's recorded review result fences this reviewer run's
 * checkpoint continuation. It does unless lifecycle evidence proves the result
 * ended an earlier round: the result has a valid task, run,
 * event, status and head all match one released reviewer run of this task and
 * that run's recorded completion; that run was created before this run, at a
 * different head; and an accepted (`ready_for_review`) author result arrived
 * after it and before this run. The author result is either a released
 * revision run bound to itself and this task, or the current worker's own
 * initial result (a replacement worker's, which has no Run record): bound to the
 * task's run, authenticated by its receipt, and received in that window. That
 * earlier reviewer result → author result → new review sequence is the only history
 * exception; anything unprovable, contradictory or out of order fences.
 */
export function reviewResultFencesRun(store: Store, task: Task, run: Run): boolean {
  const review = task.resolution.review;
  if (!review) return false;
  if (review.taskId !== task.id || !review.runId || review.runId === run.id || !review.head) return true;
  const source = store.run(review.runId);
  const completion = source?.completion;
  if (!source || !completion || source.taskId !== task.id || source.role !== 'reviewer' || !source.released) return true;
  if (completion.runId !== source.id || completion.taskId !== task.id || completion.eventId !== review.eventId
    || completion.status !== review.status || (completion.head ?? null) !== review.head || source.head !== review.head) return true;
  if (review.head === run.head || source.createdAt >= run.createdAt) return true;
  const revised = store.runs(task.id).some(item => item.role === 'revision' && item.released && item.taskId === task.id
    && item.completion?.status === 'ready_for_review' && item.completion.runId === item.id && item.completion.taskId === task.id
    && item.createdAt > source.createdAt && item.createdAt < run.createdAt);
  return !revised && !initialAuthorResultBetween(store, task, source.createdAt, run.createdAt);
}

/**
 * The current worker's own receipted initial `ready_for_review`, from a worker
 * run created inside (after, before). Timing binds to that exact run: its
 * `agent_intent` event (detail = the run ID, written with `task.runId`) must
 * exist and every one of them must fall inside the window. A worker result is
 * accepted only in a worker phase, so after that intent and before any reviewer
 * run on it. A task-wide `completion_received` event names no run and is not used.
 */
function initialAuthorResultBetween(store: Store, task: Task, after: string, before: string): boolean {
  const completion = task.completion;
  if (!completion || completion.status !== 'ready_for_review' || completion.taskId !== task.id || !task.runId || completion.runId !== task.runId) return false;
  if (store.run(completion.runId)) return false;
  const receipt = store.receiptHash(completion.eventId, task.id, completion.runId);
  if (receipt === null || receipt !== digest(JSON.stringify(completion))) return false;
  const intents = store.db.prepare("SELECT at FROM events WHERE taskId=? AND kind='agent_intent' AND detail=?").all(task.id, completion.runId) as { at: string }[];
  return intents.length > 0 && intents.every(intent => intent.at > after && intent.at < before);
}
