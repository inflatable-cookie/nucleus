import type { Completion, Run, Task } from '../../shared/contracts';
import { coordinatorActionShapeRefusal } from '../recovery/task-reasons';
import { proofResultRefusal } from './proof-settlement';

/**
 * The shape rules an accepted report must satisfy, read once from the authenticated
 * role/status the store holds and from typed report fields. Worker intake and run
 * intake both apply them, so the two entry points cannot drift: a rule added here
 * refuses at both.
 */
export function completionRoute(status: Completion['status'], run: Run | null): 'checkpoint' | 'review_progress' | 'reviewer' | 'run' | 'worker' {
  if (status === 'progress_checkpoint') return 'checkpoint';
  if (status === 'review_in_progress') return 'review_progress';
  if (run?.role === 'reviewer') return 'reviewer';
  return run ? 'run' : 'worker';
}

/** First role/status refusal after report-only policy has been checked. */
export function completionRefusal(input: Completion, run: Run, task: Task, revisionReportOnly: boolean): string | null {
  const role = run.role;
  const allowed = role === 'recovery' ? ['recovered','escalate','blocked','error'] : role === 'reviewer' ? ['ready_to_merge', 'changes_required', 'blocked', 'error'] : role === 'revision' ? ['ready_for_review', ...(revisionReportOnly ? ['report_ready'] : []), 'blocked', 'error'] : role === 'executor' ? ['proof_executed', 'blocked', 'error'] : ['closed', 'blocked', 'error'];
  if (input.closeoutCommit && (role !== 'closeout' || input.status !== 'closed')) return 'Published closeout commit requires a closed coordinator result';
  if (input.providerUnavailable && !['blocked','error'].includes(input.status)) return 'Provider unavailability requires blocked/error status';
  if (!allowed.includes(input.status)) return 'Result is not valid for this run role';
  if (role === 'recovery' && (input.recoveryAction || input.replacementAgentId)) return 'recoveryAction is retired; report coordinatorAction {verb: restart|route|move|retry_effect|cannot, reason} instead';
  if (role === 'recovery' && input.status === 'recovered' && !input.coordinatorAction) return `Recovery requires a coordinatorAction. ${coordinatorActionShapeRefusal('the report carries none')}`;
  if (role !== 'recovery' && (input.recoveryAction || input.coordinatorAction || input.replacementAgentId)) return 'Recovery action requires coordinator recovery run';
  const proofRefusal = proofResultRefusal(input, run);
  if (proofRefusal) return proofRefusal;
  if (!['blocked', 'error', 'recovered', 'escalate'].includes(input.status) && !revisionReportOnly) {
    if (role === 'revision') {
      if (!input.prNumber) return 'Revision readiness requires a PR';
      const expectedPr = task.resolution.revisionPrRepair ? null : task.resumePrNumber ?? task.completion?.prNumber;
      if (expectedPr && input.prNumber !== expectedPr) return 'Revision must use the task PR';
    } else if (input.head !== run.head) return 'Result must name the requested exact head';
    if (role === 'reviewer' && !input.reviewCommentId && !input.reviewText) return 'Review requires full reviewText or a durable PR comment ID';
  }
  return null;
}

/**
 * Spec 037: a source approval is an exact-head environment blocked review that names
 * the proofs it still needs, and nothing else. A report that carries either field
 * without that exact shape refuses before any proof is routed.
 */
export function sourceApprovalRefusal(input: Completion, run: Pick<Run, 'role' | 'head'> | null | undefined): string | null {
  if (!input.sourceApproved && !input.awaitingProofs) return null;
  if (run?.role !== 'reviewer' || input.status !== 'blocked' || input.reviewResponsibility !== 'environment'
    || !input.sourceApproved || !input.awaitingProofs?.length || input.head !== run.head || !input.reviewText)
    return 'Source approval requires an exact-head environment blocked review with findings and named awaiting proofs; if only release gates remain, report ready_to_merge';
  return null;
}
