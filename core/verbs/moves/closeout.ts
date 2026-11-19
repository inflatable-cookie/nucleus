import type { Task } from "../../../shared/contracts";
import type { Engine } from "../../engine";
import type { VerifiedEnclosingOperation } from "../../planning/enclosing-operation";
import {
  closeoutEffectRefusal,
  closeoutMoveStateRefusal,
  moveStateRefusal,
  recordedCloseoutRefusal,
  REMOVED_TASK_REFUSAL,
} from "../control-refusals";
import { settleSupersededFencesInTx } from "../../recovery/fence-settlement";
import { prIdentity } from "../owner-facts";
import { now } from "../../store/store";
import { DurableFenceRefusal } from "../../intake/run-settlement";

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
  if (['done', 'cancelled'].includes(task.phase)) return task;
  const stateRefusal = moveStateRefusal(task, "closeout");
  if (stateRefusal) throw Error(stateRefusal);
  // Task 408: the never-dispatched review-entry boundary. It is read fresh from
  // the same store fact the dependency correction uses, and only through the
  // authenticated durable invocation executing this move: a direct engine call
  // carries no verified invocation identity and keeps the parent refusal without
  // allowing a forged exemption (task 404).
  const enclosing = input.enclosing?.();
  const boundary = enclosing ? store.reviewEntryUnrunBeforeFirstRun(task, enclosing) : false;
  // An unverified caller gets the existing review-entry refusal at its
  // authorization boundary. The preview cannot grant that exemption.
  const reviewEntry = boundary || store.reviewEntryUnrunBeforeFirstRun(task);
  const closeoutRefusal = closeoutMoveStateRefusal(task, reviewEntry, prIdentity(task));
  if (closeoutRefusal) throw Error(closeoutRefusal);
  if (task.resolution.mergedCommit) return resumeRecordedMerge(engine, task, input);
  const merge = {
    task, reason: input.reason, caller: input.caller, qualification: input.qualification,
    head: input.head, relayed: input.relayed, relayNote: input.relayNote, enclosing: input.enclosing ?? (() => undefined),
  };
  if (boundary) return engine.reconcileReviewEntryExternalMerge(merge);
  if (input.qualification)
    return engine.reconcileRetainedExternalMerge({
      ...merge,
      qualification: input.qualification,
    });
  if (input.head)
    throw Error(
      "A head is only named by a move to merge with an owner acceptance; closeout proves the PR merged at the forge",
    );
  const effects = closeoutEffectRefusal(store, task, enclosing);
  if (effects) throw new DurableFenceRefusal(effects);
  // Round 4: a move applies while paused; only dispatch waits for unpause.
  // Spec 050 atomic verbs: nothing settles before the merge is proven —
  // acceptExternalMerge refuses an unmerged PR or an active thread before it
  // writes anything, and the fence settlement rides the accepted merge inside
  // its transaction.
  await engine.resolution.acceptExternalMerge(store.task(task.id), input.reason, `move closeout: ${input.reason}`, engine.coordinatorActionRunId.getStore(), undefined, undefined, input.enclosing);
  return store.task(task.id);
}

/** Re-observe an already recorded merge, then re-enter the normal sync gate. */
async function resumeRecordedMerge(engine: Engine, task: Task, input: CloseoutMoveInput): Promise<Task> {
  if (input.head || input.qualification) throw Error('The recorded merge already has its source disposition; omit head and qualification');
  const refusal = recordedCloseoutRefusal(task, engine.resolution.reviewRequired(task));
  if (refusal) throw Error(refusal);
  if (!engine.resolution.adapter.externalMerge) throw Error('External merge verification is unavailable');
  const store = engine.store, runs = store.runs(task.id), runIdentity = JSON.stringify(runs);
  const finished = await engine.collectVerbFinishedRuns(task.id, () => false, { displace: true, settlesEpisode: true });
  if (finished.fenced.length) throw Error(engine.displaceRefusal(finished.fenced[0]!));
  if (finished.live.length) throw Error('A participant still has a live turn; stop it before closeout');
  const enclosing = input.enclosing?.();
  const quiet = () => engine.resolution.executionLease(task, enclosing, false, true);
  if (!await quiet()) throw Error('Task participants or effects are not settled; no closeout was started');
  const observed = await engine.resolution.externalMerge.observeRecordedMerge(task);
  const head = task.resolution.mergeHead;
  if (!observed || !head || observed.head !== head || observed.commit !== task.resolution.mergedCommit)
    throw Error('The forge merge does not match the recorded head and commit');
  if (!await quiet()) throw Error('Task participants or effects changed while observing the merge');
  return store.transaction(() => {
    const current = store.task(task.id);
    engine.requireOwnerControlCurrent(current, task.version, 'Task changed during merge observation; refresh before retrying');
    if (JSON.stringify(store.runs(task.id)) !== runIdentity) throw Error('Task or run changed during merge observation');
    engine.releaseDisplacedRunsInTx(task.id, finished.settleable.map(run => run.id), `move closeout: ${input.reason}`);
    settleSupersededFencesInTx(store, task.id, `move closeout: ${input.reason}`, now(), engine.coordinatorActionRunId.getStore());
    return engine.resolution.closeout.continueRecordedMerge(store.task(task.id), {
      kind: 'owner', reason: input.reason, refresh: Boolean(task.resolution.syncedCommit),
    });
  });
}
