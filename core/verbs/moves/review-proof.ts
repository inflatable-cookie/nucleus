import type { Task } from "../../../shared/contracts";
import { validateNamedProfile } from "../../dispatch/routing";
import type { Engine } from "../../engine";
import { proofOnlyReceiptAwaitingReview } from "../../qa/proof-records";
import { cancelDisplacedReviewers, observeReviewerDisplacement } from "./review-displacement";
import { commitReviewMove, nameLaunchFence, settleStoppedReviewers } from "./review-settle";
import type { ReviewMoveInput } from "./types";

/**
 * A proof-only qualification with a settled receipt and no verdict reviews
 * the receipt. The receipt is the subject, so this path never verifies a PR
 * and starts no executor. The displacement, the stopped-reviewer settlement and
 * the review settlement are the task review move's own (`review-settle.ts`).
 */
export async function moveProofOnlyReceiptToReview(engine: Engine, input: ReviewMoveInput): Promise<Task> {
  const store = engine.store;
  const task = store.task(input.taskId);
  const commit = task.proofOnly!.commit;
  if (input.prNumber !== undefined) throw Error('A proof-only receipt review has no PR');
  const reviewRunsBefore = store.runs(task.id);
  const displacement = await observeReviewerDisplacement(engine, task.id);
  if (input.reviewer) {
    engine.requireProfileCatalog();
    validateNamedProfile(input.reviewer.profileId, 'reviewer', task.scope, engine.profiles, store.pool(), input.reviewer.reason.trim(), task.thinkingOptionId);
    engine.requireAvailableGroup(input.reviewer.profileId);
  }
  if (displacement.finished.live.length || displacement.liveReviewers.length) engine.assertUnchangedBeforeCancel(task.id, input.version, reviewRunsBefore);
  await cancelDisplacedReviewers(engine, task.id, displacement, 'move review');
  const freshAsked = input.fresh === true;
  const observedRetained = !freshAsked && task.resolution.reviewerAgentId
    ? await engine.host.observe(task.resolution.reviewerAgentId).catch(() => null)
    : null;
  const retainedClosedAtObserve = Boolean(observedRetained
    && observedRetained.id === task.resolution.reviewerAgentId && observedRetained.status === 'closed');
  return engine.control(async () => {
    const settled = await engine.control(() => store.transaction(() => {
      const current = store.task(task.id);
      engine.requireOwnerControlCurrent(current, input.version, 'Task changed; refresh before retrying');
      if (!proofOnlyReceiptAwaitingReview(current)) throw Error('The proof-only receipt is no longer waiting for review');
      engine.releaseDisplacedRunsInTx(task.id, displacement.displaced.map(run => run.id), `move review: ${input.reason}`);
      if (store.runs(current.id).some(run => !run.released && !displacement.stoppedReviewers.has(run.id))) throw Error('A run started during the move; refresh before retrying');
      settleStoppedReviewers(engine, current.id, displacement.stoppedReviewers, input.reason);
      return commitReviewMove(engine, task.id, current, {
        reason: input.reason, movedTo: commit, fallbackHead: () => commit,
        reviewer: input.reviewer, freshAsked, observedRetained, retainedClosedAtObserve, callerAsked: Boolean(input.caller),
        subject: 'proof-only receipt', binding: {}, eventDetail: {},
      });
    }), `task:${task.id}`);
    await nameLaunchFence(engine, task.id, settled.reason, input.reason);
    return store.task(settled.id);
  }, `task:${task.id}`);
}
