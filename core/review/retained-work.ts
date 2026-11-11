import type { Run, Task } from '../../shared/contracts';
import { digest, type Store } from '../store/store';

/** Authenticated review history constrains the retained source after replacement. */
export function retainedReviewHeads(store: Store, task: Task, runs: Run[]): string[] {
  const heads: string[] = [];
  // Applied review history remains a source constraint after replacement clears
  // the current review. A missing or conflicting receipt cannot erase it.
  const applied = new Set(store.eventsAll(task.id).filter(event => ['review_result_applied', 'review_reapplied'].includes(event.kind)).map(event => event.detail));
  for (const run of runs.filter(item => item.role === 'reviewer' && item.taskId === task.id && item.workspaceId === task.workspaceId)) {
    const completion = run.completion;
    if (!completion?.head && !applied.has(run.id)) continue;
    const receipt = completion && store.db.prepare('SELECT hash FROM receipts WHERE id=? AND task=? AND run=?').get(completion.eventId,task.id,run.id) as {hash:string}|undefined;
    // Review publication may add or reconcile its forge ID after the receipt.
    // The accepted payload itself remains bound by its exact receipt hash.
    const {reviewId: _reviewId, reviewCommentId: _reviewCommentId, ...withoutPublication} = completion ?? {};
    const variants = completion ? [completion, withoutPublication,
      {...withoutPublication,...(completion.reviewId !== undefined ? {reviewId:completion.reviewId} : {})},
      {...withoutPublication,...(completion.reviewCommentId !== undefined ? {reviewCommentId:completion.reviewCommentId} : {})}] : [];
    if (!completion?.head || completion.taskId !== task.id || completion.runId !== run.id || completion.head !== run.head
      || !receipt || !variants.some(value => receipt.hash === digest(JSON.stringify(value)))) {
      if (applied.has(run.id)) throw Error('Retained review source lacks its authenticated receipt');
      continue;
    }
    heads.push(completion.head);
  }
  return heads;
}
