import type { Completion, Task } from '../../../shared/contracts';
import { NO_ACTION_ESCALATION_SUMMARY } from './reasons';

/**
 * The verdicts a task row carries at an exact head: a ready review, an owner
 * source acceptance, and the merge and recovery decisions that follow from them.
 * Every reader of a verdict asks here, so "ready at this head" has one answer.
 */

/** A ready review approves only a named exact PR head. Owner acceptances are separate. */
export function readyReviewAtHead(t: Pick<Task, 'prHead' | 'resolution'>, head = t.prHead): boolean {
  return Boolean(head && t.resolution.review?.status === 'ready_to_merge' && t.resolution.review.head === head);
}

/** True when this head has an applied ready_to_merge verdict or an owner source acceptance. */
export function appliedMergeVerdict(t: Task, head: string | null | undefined): boolean {
  if (!head) return false;
  if (readyReviewAtHead(t, head)) return true;
  return (t.resolution.ownerAcceptances ?? []).some(entry => entry.head === head && (entry.kind === 'operator_source' || entry.kind === 'reviewed'));
}

/** Record that this merge had no applied verdict, without clearing a prior true. */
export function mergedWithNonePatch(t: Task, head: string | null | undefined): { mergedWithNone?: true } {
  return t.resolution.mergedWithNone || appliedMergeVerdict(t, head) ? {} : { mergedWithNone: true };
}

/** The same accepted-review test `rereview` uses: a recorded `ready_to_merge` or `changes_required`. */
export const isAcceptedReview = (review: Completion | null | undefined): review is Completion =>
  Boolean(review && ['ready_to_merge', 'changes_required'].includes(review.status));

/** An escalation ends with its task: a merge or an ending leaves nothing for its answer to do. */
export const escalationOutlived = (task: Task): boolean =>
  ['done', 'cancelled'].includes(task.phase) || Boolean(task.resolution.mergedCommit || task.resolution.mergeIntent);

/**
 * A recovery's no-action finding at an accepted reviewed head: nothing is left
 * to retry, so answering the escalation lets the verification gate run (Spec
 * 016 rule 6). Shared by the answer and `next`, so both agree.
 */
export function noActionEscalationAtAcceptedHead(t: Task): boolean {
  return t.phase === 'verifying' && !t.resolution.attention && !t.resolution.currentRunId &&
    t.completion?.status === 'ready_for_review' && Boolean(t.prHead) &&
    readyReviewAtHead(t) &&
    t.resolution.recovery?.status === 'escalated' &&
    t.resolution.recovery.summary === NO_ACTION_ESCALATION_SUMMARY &&
    t.resolution.incident?.status === 'escalated' &&
    t.resolution.recovery.incidentId === t.resolution.incident.id;
}
