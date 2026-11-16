import { holdsOf, isDispositionActive, isRetainedProfileReason, type Run, type Task } from '../../../shared/contracts';
import { DISPATCH_HELD_REASON } from '../../dispatch/capacity';
import {
  MERGE_HELD_REASON, OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON, OPERATOR_ROLE_REASSIGNMENT_REASON, OPERATOR_STOPPED_REVISION_REMAP_REASON,
  OPERATOR_STOPPED_WORKER_REMAP_REASON, OPERATOR_WORKER_REMAP_REASON,
} from './reasons';

/**
 * Whether a task is parked, and which owner may resume it. A park is a durable
 * state with a visible reason; these predicates read the recorded state, the
 * reason the park wrote and the operator's armed replacement, and nothing else.
 */

/**
 * The operator-approved replacements. Every one of them excludes the retained
 * worker, so only the replacement path may act on the task while one is armed.
 * The list is written once: `operatorReplacementPending` and
 * `ownerArmedRetainedWorker` ask the same question of it.
 */
const OPERATOR_REPLACEMENT_REASONS: readonly string[] = [
  OPERATOR_WORKER_REMAP_REASON, OPERATOR_STOPPED_REVISION_REMAP_REASON, OPERATOR_STOPPED_WORKER_REMAP_REASON,
  OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON, OPERATOR_ROLE_REASSIGNMENT_REASON,
];

/** The task's own failover reason names an operator-approved replacement. */
export const operatorReplacementPending = (t: Task): boolean =>
  OPERATOR_REPLACEMENT_REASONS.some(reason => t.failoverReason.startsWith(reason));

/**
 * A task parked because its retained worker's profile is unavailable: the park
 * itself, or a blocked/errored escalation recorded after that park and after
 * the last worker request. Only a remap (the parked restart) resumes it, so
 * `next` and the handler both send restart there (review #539).
 */
export function retainedProfileRemapPark(t: Task, events: Array<{ id: number; kind: string; detail: string }>): boolean {
  if (isRetainedProfileReason(t.reason)) return true;
  if (!['blocked', 'error'].includes(t.phase) || t.resolution.recovery?.status !== 'escalated') return false;
  const latest = (match: (event: { kind: string; detail: string }) => boolean) => events.reduce((max, event) => match(event) ? Math.max(max, event.id) : max, -1);
  const park = latest(event => event.kind === 'needs_attention' && isRetainedProfileReason(event.detail));
  return park >= 0 && park > latest(event => ['worker_resume_requested', 'revision_requested'].includes(event.kind));
}

/**
 * The retained initial worker's own binding under an owner-armed replacement that
 * has not retired it yet (Spec 050). The owner's fresh restart or `route now`
 * moves the task to `changes_requested` before the recovery pass retires the
 * worker, so exactly that window still accepts that worker's genuine
 * authenticated result — from the completion handler and the authenticated report
 * bridge alike. It requires the task to still bind the same initial run and agent,
 * no recorded result, an operator-armed replacement with its recorded profile, no
 * other current run and no live revision of that worker. A retired, replaced,
 * released, superseded or foreign binding never matches, and an automatic
 * provider faults are handled by their dedicated recovery path.
 */
export function ownerArmedRetainedWorker(t: Task, runs: Run[]): boolean {
  if (t.phase !== 'changes_requested' || !t.agentId || !t.runId || t.completion || t.removedAt) return false;
  if (!t.failoverReason || !t.replacementProfile) return false;
  if (!operatorReplacementPending(t)) return false;
  if (isDispositionActive(t) || t.resolution.currentRunId) return false;
  return !runs.some(run => !run.released && run.role === 'revision' && run.agentId === t.agentId);
}

/**
 * The held wait a merge fence's own kind names: a merge hold keeps the merge
 * wording, while an owner stop reads as the dispatch hold it placed.
 */
export const mergeFenceReason = (task: Parameters<typeof holdsOf>[0]): string =>
  holdsOf(task).merge ? MERGE_HELD_REASON : DISPATCH_HELD_REASON;
