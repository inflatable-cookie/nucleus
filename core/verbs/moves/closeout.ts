import type { Task } from "../../../shared/contracts";
import type { Engine } from "../../engine";
import type { VerifiedEnclosingOperation } from "../../planning/enclosing-operation";
import { moveStateRefusal, REMOVED_TASK_REFUSAL } from "../control-refusals";

/** The owner `move to=closeout` request, after the verb has parsed it. */
export type CloseoutMoveInput = {
  taskId: string;
  version: number;
  reason: string;
  caller?: string;
  qualification?: string;
  head?: string;
  relayed?: boolean;
  relayNote?: string;
  enclosing?: () => VerifiedEnclosingOperation | undefined;
};

/**
 * Spec 050 `move to=closeout`: record the observed external merge and enter
 * ordinary closeout. It never mints a review: the merge is observed at the
 * forge, the runs settle, and the normal external-merge closeout follows.
 *
 * Task 408: a queued review-entry task that never dispatched is the one shape
 * whose own PR can merge before any reviewer existed. It has no runs to settle
 * and no review evidence at the merged head, so the same verb reconciles it
 * only with an explicit exact-final-head owner source acceptance; without that
 * acceptance the task stays held exactly as it is.
 */
export async function moveToCloseout(engine: Engine, input: CloseoutMoveInput): Promise<Task> {
  const store = engine.store;
  const task = store.task(input.taskId);
  if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
  engine.requireOwnerControlCurrent(task, input.version, 'Task changed; refresh before retrying');
  const stateRefusal = moveStateRefusal(task, "closeout");
  if (stateRefusal) throw Error(stateRefusal);
  // Task 408: the never-dispatched review-entry boundary. It is read fresh from
  // the same store fact the dependency correction uses, and only through the
  // authenticated durable invocation executing this move: a direct engine call
  // carries no verified invocation identity and keeps the parent refusal without
  // allowing a forged exemption (task 404).
  const enclosing = input.enclosing?.();
  const boundary = enclosing ? store.reviewEntryUnrunBeforeFirstRun(task, enclosing) : false;
  const merge = {
    task, reason: input.reason, caller: input.caller, qualification: input.qualification,
    head: input.head, relayed: input.relayed, relayNote: input.relayNote, enclosing: input.enclosing ?? (() => undefined),
  };
  if (boundary) return engine.reconcileReviewEntryExternalMerge(merge);
  if (input.qualification) return engine.reconcileRetainedExternalMerge({ ...merge, qualification: input.qualification });
  if (input.head) throw Error('A head is only named by a move to merge with an owner acceptance; closeout proves the PR merged at the forge');
  // Round 4: a move applies while paused; only dispatch waits for unpause.
  // Spec 050 atomic verbs: nothing settles before the merge is proven —
  // acceptExternalMerge refuses an unmerged PR or an active thread before it
  // writes anything, and the fence settlement rides the accepted merge inside
  // its transaction.
  await engine.resolution.acceptExternalMerge(store.task(task.id), input.reason, `move closeout: ${input.reason}`, engine.coordinatorActionRunId.getStore(), undefined, undefined, input.enclosing);
  return store.task(task.id);
}
