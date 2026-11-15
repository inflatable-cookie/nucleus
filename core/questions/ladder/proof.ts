import type { Task } from '../../../shared/contracts';
import { proofOnlyReceiptAwaitingReview } from '../../qa/proof-records';
import type { TaskStopVerb } from '../../../shared/task-stop';

/**
 * The owner-verb hint a proof-only escalation carries: the receipt review when that
 * is the wait, else the proof activation. It is part of the escalation's words, so
 * it lives with them rather than with the reviewer consult that also sends one.
 */

/** Owner-verb suffix on a proof-only escalation: receipt review when that is the wait, else proof. */
export function plannerEscalationOwnerSuffix(t: Task): string {
  if (proofOnlyReceiptAwaitingReview(t))
    return ' Available owner verb: move to=review (starts a receipt reviewer at the same commit; the receipt is the subject).';
  if (t.entrypoint === 'proof')
    return ' Available owner verb: proof (activate the qualification when authorization evidence is complete).';
  return '';
}

/** The verbs a proof-only stop may advertise beside its wait; nothing else narrows them. */
export function plannerEscalationSuggestedVerbs(t: Task): TaskStopVerb[] | undefined {
  if (proofOnlyReceiptAwaitingReview(t)) return ['move'];
  if (t.entrypoint === 'proof') return ['proof'];
  return undefined;
}
