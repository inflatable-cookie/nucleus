import { isRetainedProfileReason, type Run, type Task } from '../../shared/contracts';
import { digest } from '../store/store';
import { PR_HEAD_CHANGED_REASON, readyReviewAtHead, revisionPhases } from './task-reasons';
import { NO_RESOLUTION_RUN_REFUSAL } from '../verbs/verb-refusal-text';
import { isCloseoutHookHold, isHookHoldReason } from '../hooks/hooks';
import { WORKER_PR_IDENTITY_REFUSAL } from '../git/index';
import { revisionContinuationAction, revisionReviewFindings } from '../dispatch/prompts';

/**
 * The retry decisions: where one parked task's next attempt goes, decided from
 * the task's own recorded facts. No store reads and no writes here - the
 * orchestration that applies a decision lives in `retry-orchestration`, and the
 * recorded evidence it needs is selected in `retry-evidence`.
 */

/** Ordered retry admissions; callers supply only facts needed at each boundary. */
export function retryAdmission(t: Task, f: { stage: 'instruction' | 'reviewer-delivery'; revise: boolean; operator: boolean;
  instruction?: string; reviewerInstruction?: string; remap: boolean }): string | null {
  if (f.stage === 'instruction') {
    if (!f.revise && f.instruction !== undefined && !(f.operator && f.remap))
      return 'An instruction on a parked restart applies only to a retained-worker remap; use move to=work with the instruction otherwise';
    if (f.reviewerInstruction !== undefined && (!f.operator || f.revise))
      return 'A reviewer instruction is only valid for an owner restart role=reviewer';
  } else if (f.reviewerInstruction !== undefined) {
    const acceptedPrReconciliation = t.phase === 'needs_attention' && t.completion?.status === 'ready_for_review' &&
      Boolean(t.workspaceId && t.directory && t.agentId && t.runId && t.profile) &&
      !t.resolution.currentRunId && !t.resolution.mergeIntent && !t.resolution.mergedCommit &&
      t.reason !== PR_HEAD_CHANGED_REASON && !isRetainedProfileReason(t.reason) && !f.remap &&
      !readyReviewAtHead(t);
    const deliverable = ['blocked', 'error'].includes(t.phase) ? !f.remap : acceptedPrReconciliation;
    if (!deliverable) return 'A reviewer instruction requires a retry that returns the task to a fresh review; this retry has no fresh reviewer to receive it';
  }
  return null;
}

/** Special retry branches, evaluated separately so each store read stays lazy. */
export function retrySpecialRoute(t: Task, stage: 'merge' | 'revision' | 'hook' | 'profile',
  operator: boolean, revise: boolean, run: Run | null): 'pass' | 'merge' | 'revision' | 'hook' | 'profile' | { refuse: string } {
  if (stage === 'merge' && t.phase === 'needs_attention' && t.resolution.mergeIntent && !t.resolution.mergedCommit)
    return operator ? 'merge' : { refuse: 'An uncertain merge requires an operator decision before reconciliation resumes' };
  if (stage === 'revision' && t.phase === 'needs_attention' && t.reason === PR_HEAD_CHANGED_REASON &&
      run?.role === 'revision' && run.released && run.completion?.status === 'ready_for_review' &&
      run.agentId === t.agentId && run.workspaceId === t.workspaceId && !t.resolution.mergeIntent && !t.resolution.mergedCommit) return 'revision';
  const hookHeld = stage === 'hook' && isHookHoldReason(t.reason) &&
    run?.role === 'revision' && run.released && Boolean(run.completion && ['blocked', 'error'].includes(run.completion.status));
  if (hookHeld && operator && !revise && ['changes_requested', 'needs_attention'].includes(t.phase) &&
      readyReviewAtHead(t) && !t.resolution.mergeIntent && !t.resolution.mergedCommit) return 'hook';
  if (stage === 'profile' && t.phase === 'needs_attention' && isRetainedProfileReason(t.reason))
    return operator ? 'profile' : { refuse: 'Retained worker profile eligibility requires explicit operator retry' };
  return 'pass';
}

/** Select the parked retry route after admission and retained-run reconciliation. */
export function retryRoute(t: Task, runs: Run[], revise: boolean):
  'revision' | 'worker' | 'accepted-pr' | 'blocked' | 'closeout' | 'retry' | 'no-action' {
  if (revise) return 'revision';
  if (t.phase === 'needs_attention' && t.workspaceId && t.agentId && t.runId && t.profile && !t.completion && !t.resolution.currentRunId) return 'worker';
  if (t.phase === 'needs_attention' && t.completion?.status === 'ready_for_review' && t.workspaceId && t.directory && t.agentId && t.runId && t.profile && !t.resolution.currentRunId) return 'accepted-pr';
  if (['blocked', 'error'].includes(t.phase)) return 'blocked';
  if (!t.resolution.attention) return 'no-action';
  if (t.phase === 'closing' && (runs.at(-1)?.completion || isCloseoutHookHold(t))) return 'closeout';
  return 'retry';
}

/** Plan a revision without writing it; time is supplied only for a scoped instruction. */
export function revisionRoute(t: Task, runs: Run[], options: {
  instruction?: string; scopedInstruction?: string; operator: boolean; prePr: boolean;
  resumeUnpublished: boolean; reviewOwner: boolean; createdAt?: string;
}): { kind: 'refuse'; message: string } | { kind: 'need-time' } |
  { kind: 'revision'; changes: Record<string, unknown>; patch: { phase: 'changes_requested'; reason: string }; event: 'revision_requested'; via: 'operator' | 'update' } {
  const { instruction, scopedInstruction, operator, prePr, resumeUnpublished, reviewOwner, createdAt } = options;
  if (reviewOwner) return { kind: 'refuse', message: 'A reviewer continuation owns this task; wait for its verdict or resolve the reviewer thread instead of returning the task to the worker' };
  const last = runs.at(-1);
  const workerBlocked = Boolean(t.completion && ['blocked', 'error'].includes(t.completion.status) && t.completion.runId === t.runId && !runs.some(run => run.id === t.runId));
  const blockedRetryAvailable = ['blocked', 'error'].includes(t.phase) && (workerBlocked || Boolean(last?.completion));
  const retryHint = blockedRetryAvailable ? 'use restart to resume the blocked or errored task with its retained PR after resolving the blocker' : null;
  const missingPr = retryHint ? `Returning to the worker requires an unmerged task PR; ${retryHint}` : 'Returning to the worker requires an unmerged task PR';
  if (!t.agentId || t.resolution.mergeIntent || t.resolution.mergedCommit) return { kind: 'refuse', message: missingPr };
  if (!revisionPhases.includes(t.phase)) return { kind: 'refuse', message: `Returning to the worker is not valid from phase ${t.phase}` };
  if (!t.completion?.prNumber && !t.resumePrNumber) {
    if (!prePr) return { kind: 'refuse', message: missingPr };
    if (t.prUrl || t.prHead || !t.workspaceId || !t.profile) return { kind: 'refuse', message: 'Pre-PR worker continuation requires the retained worker and no task PR' };
  }
  const repair = t.reason === WORKER_PR_IDENTITY_REFUSAL;
  const repairInstruction = repair ? `restore this worktree to queue-owned branch ${t.branch}, close mismatched PR #${t.completion!.prNumber}, and open exactly one replacement PR from ${t.branch}` : null;
  const reviewFindings = revisionReviewFindings(t);
  const action = repair && !operator ? repairInstruction! : instruction?.trim() || scopedInstruction?.trim() || repairInstruction ||
    (t.resolution.review?.status === 'changes_required' && reviewFindings ? reviewFindings : revisionContinuationAction(t));
  const reason = `Worker action requested: ${action}`;
  if (scopedInstruction !== undefined && !scopedInstruction.trim()) return { kind: 'refuse', message: 'Revision instruction must not be empty' };
  const text = scopedInstruction?.trim();
  if (!prePr && text && createdAt === undefined) return { kind: 'need-time' };
  const scoped = !prePr && text ? { revisionInstruction: { id: digest(`${t.id}:${t.version}:${text}`).slice(0, 40), text, createdAt: createdAt!, runId: null } }
    : scopedInstruction === undefined && t.resolution.revisionInstruction?.runId === null ? { revisionInstruction: null } : {};
  return { kind: 'revision', changes: { currentRunId: null, revisionPrRepair: repair, revisionResumeUnpublished: resumeUnpublished,
    pendingWorkerInstruction: action, pendingRevisionCause: null, ...(prePr ? { prePrResumeInstruction: action } : {}),
    ...scoped, attention: false, integrationTurn: null }, patch: { phase: 'changes_requested', reason }, event: 'revision_requested', via: operator ? 'operator' : 'update' };
}

/**
 * Route a blocked result using recorded run and exact-head review facts. A
 * route that needs exact-head review evidence says so with its own kind, so the
 * caller reads that evidence once instead of comparing a refusal sentence.
 */
export function blockedRetryRoute(t: Task, runs: Run[], reviewerInstruction: string | undefined,
  acceptedReview: boolean, advancedHead: string | null):
  { kind: 'refuse'; message: string } | { kind: 'needs-review-evidence' } |
  { kind: 'route'; phase: Task['phase']; reconciledReviewHead: string | null } {
  const last = runs.at(-1);
  const workerBlocked = Boolean(t.completion && ['blocked', 'error'].includes(t.completion.status) && t.completion.runId === t.runId && !runs.some(run => run.id === t.runId));
  if (!workerBlocked && !last?.completion) return { kind: 'refuse', message: NO_RESOLUTION_RUN_REFUSAL };
  let phase: Task['phase'] = workerBlocked ? 'changes_requested' : last!.role === 'closeout' ? 'syncing' : last!.role === 'reviewer' ? 'awaiting_review' : 'changes_requested';
  let reconciledReviewHead: string | null = null;
  if (reviewerInstruction !== undefined && phase !== 'awaiting_review') {
    const settledExecutor = last?.role === 'executor' && Boolean(t.resolution.reviewerAgentId &&
      (t.proofExecutions ?? []).some(proof => proof.runId === last.id && proof.head === last.head && proof.head === t.prHead && proof.settledAt));
    if (settledExecutor || acceptedReview) phase = 'awaiting_review';
    else if (advancedHead) { phase = 'awaiting_review'; reconciledReviewHead = advancedHead; }
    else return { kind: 'needs-review-evidence' };
  }
  return { kind: 'route', phase, reconciledReviewHead };
}

/**
 * Whether the retained worker's own turn ended in a blocked or error result.
 * The report can sit on the task row (the initial worker has no Run row) or on
 * the worker's current revision run; both end the same turn. A 429, a provider
 * refusal and a reported blocker are all blocked/error results, so the resume
 * never asks which of them stopped the turn.
 */
export function prePrWorkerTurnEnded(t: Task, runs: Run[]): boolean {
  const settled = runs.filter(run => run.role !== 'recovery');
  const taskBlocked = Boolean(t.completion && ['blocked', 'error'].includes(t.completion.status));
  const ownRun = settled.at(-1);
  const ownRunBlocked = Boolean(ownRun?.role === 'revision' && ownRun.completion && ['blocked', 'error'].includes(ownRun.completion.status)
    && (!t.agentId || ownRun.agentId === t.agentId || ownRun.workspaceId === t.workspaceId));
  return taskBlocked || ownRunBlocked;
}

/** Route a pre-PR worker resume from already-read task and run facts. */
export function resumeRoute(t: Task, runs: Run[], instruction: string, operator: boolean,
  stoppedRevision: Run | null, validationAlive: boolean | undefined):
  { kind: 'check-validation' } | { kind: 'stopped'; run: Run } | { kind: 'refuse'; message: string } | { kind: 'resume'; action: string } {
  const parkedPrePrResume=operator&&t.phase==='changes_requested'&&Boolean(t.prerequisiteWait?.releasedAt)&&
    Boolean(t.resolution.prePrResumeInstruction)&&Boolean(t.completion&&t.completion.taskId===t.id&&
      t.completion.runId===t.runId&&['blocked','error'].includes(t.completion.status));
  const reportedBlock=(['blocked','error'].includes(t.phase)||parkedPrePrResume)&&prePrWorkerTurnEnded(t,runs);
  const stoppedBeforeCallback=t.phase==='needs_attention'&&!t.completion&&!t.resolution.currentRunId;
  if(!reportedBlock&&!stoppedBeforeCallback){
    if(stoppedRevision && validationAlive === undefined)return {kind:'check-validation'};
    if(stoppedRevision&&validationAlive)return {kind:'stopped',run:stoppedRevision};
    return {kind:'refuse',message:'Pre-PR worker resume requires a blocked result or stopped pre-callback worker'};
  }
  if(t.completion?.prNumber||t.prUrl||t.prHead||!t.agentId||!t.workspaceId||!t.profile){
    const settled=runs.filter(r=>r.role!=='recovery');
    const last=settled.at(-1);
    const workerBlocked=Boolean(t.completion&&['blocked','error'].includes(t.completion.status)&&t.completion.runId===t.runId&&!settled.some(run=>run.id===t.runId));
    if(['blocked','error'].includes(t.phase)&&(workerBlocked||Boolean(last?.completion)))
      return {kind:'refuse',message:'Pre-PR worker resume requires a retained worker and no task PR; use restart to resume the blocked or errored task with its retained PR after resolving the blocker'};
    return {kind:'refuse',message:'Pre-PR worker resume requires a retained worker and no task PR'};
  }
  if(runs.some(r=>!r.released))return {kind:'refuse',message:'Resolve the retained thread or uncertain delivery first; no prompt will be resent blindly'};
  const action=instruction.trim();
  if(!action)return {kind:'refuse',message:'Worker resume requires an explicit instruction'};
  return {kind:'resume',action};
}
