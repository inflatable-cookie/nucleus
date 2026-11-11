import { RETAINED_PREREQUISITE_REFUSAL, NO_RESOLUTION_RUN_REFUSAL } from '../verbs/verb-refusal-text';
import { readyReviewAtHead } from './task-reasons';
import { pidAlive } from '../machine/process-identity';
import { RETAINED_WORKER_PROFILE_REASON, type Completion, type Run, type Task } from '../../shared/contracts';
import { digest, now } from '../store/store';
import { RetainedRunRefusal, ACCEPTED_PR_RECONCILIATION_REASON, NO_RESOLUTION_ACTION, OPERATOR_WORKER_REMAP_REASON, retainedProfileRemapPark, revisionPhases, isAcceptedReview } from './task-reasons';
import { reviewAuthorizationRequired, REVIEW_AUTHORIZATION_REQUIRED } from '../review/review-continuation';
import { isCloseoutHookHold } from '../hooks/hooks';
import { taskHasPr } from '../forge/index';
import { revisionContinuationAction, revisionReviewFindings } from '../dispatch/prompts';
import type { Resolution } from '../resolution';

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
      t.reason !== 'PR head changed after the completion callback' && !t.reason.startsWith(RETAINED_WORKER_PROFILE_REASON) && !f.remap &&
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
  if (stage === 'revision' && t.phase === 'needs_attention' && t.reason === 'PR head changed after the completion callback' &&
      run?.role === 'revision' && run.released && run.completion?.status === 'ready_for_review' &&
      run.agentId === t.agentId && run.workspaceId === t.workspaceId && !t.resolution.mergeIntent && !t.resolution.mergedCommit) return 'revision';
  const hookHeld = stage === 'hook' && t.reason.startsWith('Repository hook ') && t.reason.includes(' holds this transition:') &&
    run?.role === 'revision' && run.released && Boolean(run.completion && ['blocked', 'error'].includes(run.completion.status));
  if (hookHeld && operator && !revise && ['changes_requested', 'needs_attention'].includes(t.phase) &&
      readyReviewAtHead(t) && !t.resolution.mergeIntent && !t.resolution.mergedCommit) return 'hook';
  if (stage === 'profile' && t.phase === 'needs_attention' && t.reason.startsWith(RETAINED_WORKER_PROFILE_REASON))
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
  const repair = t.reason === 'PR must be open, ready, and match the task\'s branch and base';
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

/** Route a blocked result using recorded run and exact-head review facts. */
export function blockedRetryRoute(t: Task, runs: Run[], reviewerInstruction: string | undefined,
  acceptedReview: boolean, advancedHead: string | null):
  { kind: 'refuse'; message: string } | { kind: 'route'; phase: Task['phase']; reconciledReviewHead: string | null } {
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
    else return { kind: 'refuse', message: 'A reviewer instruction requires a blocked or errored reviewer result that returns the task to review' };
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

/** Where a restart sends a parked task. */
export type RetryRoutesContext = Pick<Resolution, 'adapter' | 'operatorReturn' | 'retainedWorkerProfileIssue' | 'retry' | 'reviewContinuationOwner' | 'settleVerbFences' | 'store' | 'update' | 'validationAlive'>;

export class RetryRoutes {
  constructor(readonly resolution: RetryRoutesContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

  /**
   * The continuation a replacement worker resumes: a fresh owner instruction,
   * else the latest pending one, the last worker request, the review or the
   * last result (consumer-b #181: a stale pending one never wins over a fresh one).
   */
  workerContinuation(t: Task, instruction?: string): string {
    const pendingWorkerEvent = this.store.events(t.id).find(event => ['worker_resume_requested', 'revision_requested'].includes(event.kind));
    const priorEvent = pendingWorkerEvent && !/^(?:Operator-directed resume returned|Recovery-directed resume returned)/.test(pendingWorkerEvent.detail)
      ? pendingWorkerEvent.detail.replace(/^Worker action requested:\s*/, '') : null;
    return instruction?.trim() || t.resolution.pendingWorkerInstruction || t.resolution.prePrResumeInstruction || priorEvent
      || t.resolution.review?.summary || t.completion?.summary || 'Continue the existing task under the approved instruction';
  }

  private retainedWorkerRemap(t: Task) {
    const taskEvents=this.store.events(t.id);
    // Store.events is newest-first, so the first matching event is the current continuation.
    const pendingWorkerEvent=taskEvents.find(event=>['worker_resume_requested','revision_requested'].includes(event.kind));
    const retainedProfileIncident=retainedProfileRemapPark(t,taskEvents);
    const retainedWorkerIssue=this.resolution.retainedWorkerProfileIssue(t);
    return retainedProfileIncident&&retainedWorkerIssue&&t.agentId&&t.workspaceId&&t.profile&&!t.resolution.currentRunId?{pendingWorkerEvent,retainedWorkerIssue}:null;
  }

  /**
   * Spec 044 / project-a #1863: an accepted review whose head still equals the task PR head,
   * with no later run completion at a different head. Used to return a blocked revision or
   * recovery to review when the operator supplies a reviewer instruction.
   */
  acceptedReviewAtUnchangedHead(t: Task): Completion | null {
    const runs = this.store.runs(t.id);
    const reviewRun = runs.filter(run => run.role === 'reviewer' && isAcceptedReview(run.completion))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const review = isAcceptedReview(t.resolution.review) ? t.resolution.review : reviewRun?.completion ?? null;
    if (!review?.head || review.head !== t.prHead) return null;
    const reviewCreatedAt = (reviewRun && reviewRun.id === review.runId ? reviewRun : runs.find(run => run.id === review.runId))?.createdAt;
    for (const run of runs) {
      if (run.id === review.runId) continue;
      if (reviewCreatedAt && Date.parse(run.createdAt) < Date.parse(reviewCreatedAt)) continue;
      const laterHead = run.completion?.head;
      if (laterHead && laterHead !== review.head) return null;
    }
    return review;
  }

  /**
   * Project-a #1900: with an operator reviewer instruction, a head the retained worker advanced
   * after the accepted review still returns the task to fresh review. The candidate is the latest
   * head reported by a later revision run of the retained worker (same agent and workspace), and
   * every other later run completion must report a head the retained worker also reported, so a
   * recovery restating the same pushed head is not an independent change. The engine verifies
   * GitHub's open PR head equals the candidate before routing, so any other head change refuses.
   */
  retainedWorkerAdvancedReviewHead(t: Task): { review: Completion; head: string } | null {
    const runs = this.store.runs(t.id);
    const reviewRun = runs.filter(run => run.role === 'reviewer' && isAcceptedReview(run.completion))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const review = isAcceptedReview(t.resolution.review) ? t.resolution.review : reviewRun?.completion ?? null;
    if (!review?.head) return null;
    const reviewCreatedAt = (reviewRun && reviewRun.id === review.runId ? reviewRun : runs.find(run => run.id === review.runId))?.createdAt;
    const changed = runs.filter(run => {
      if (run.id === review.runId) return false;
      if (reviewCreatedAt && Date.parse(run.createdAt) < Date.parse(reviewCreatedAt)) return false;
      return Boolean(run.completion?.head && run.completion.head !== review.head);
    });
    const advanced = changed.filter(run => run.role === 'revision' && run.agentId === t.agentId && run.workspaceId === t.workspaceId);
    if (!advanced.length) return null;
    const retainedHeads = new Set(advanced.map(run => run.completion!.head));
    if (changed.some(run => !retainedHeads.has(run.completion!.head))) return null;
    const latest = advanced.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1)!;
    return { review, head: latest.completion!.head! };
  }

  retry(t: Task, revise = false, instruction?: string, operator = false, resumeUnpublished = false, prePr = false, scopedInstruction?: string, reviewerInstruction?: string) {
    return this.prepareRetry(t, revise, instruction, operator, resumeUnpublished, prePr, scopedInstruction, reviewerInstruction)();
  }

  prepareRetry(t: Task, revise = false, instruction?: string, operator = false, resumeUnpublished = false, prePr = false, scopedInstruction?: string, reviewerInstruction?: string, settleRunIds: string[] = []): () => Task {
    if (reviewAuthorizationRequired(this.store.task(t.id), this.store) && !operator)
      throw new Error(REVIEW_AUTHORIZATION_REQUIRED);
    const admission = retryAdmission(t, { stage: 'instruction', revise, operator, instruction, reviewerInstruction,
      remap: Boolean(!revise && instruction !== undefined && operator && this.retainedWorkerRemap(t)) });
    if (admission) throw new Error(admission);
    const allRuns = this.store.runs(t.id).map(run => settleRunIds.includes(run.id) ? { ...run, released: true } : run),runs=allRuns.filter(r=>r.role!=='recovery');
    if (allRuns.some(r => !r.released)) {
      const stopped = this.stoppedRevisionWithoutCallback(t, allRuns);
      if (!stopped || !this.resolution.validationAlive(t)) throw new RetainedRunRefusal('Resolve the retained thread or uncertain delivery first; no prompt will be resent blindly');
      // A restart of a stopped identity confirmation keeps the read-only intent
      // that run was reserved for; it never becomes an implementation revision.
      const resumeIntent = resumeUnpublished || Boolean(stopped.identityConfirmation);
      this.prepareRetry({ ...t, resolution: { ...t.resolution, currentRunId: null, attention: false } }, revise, instruction, operator, resumeIntent, prePr, scopedInstruction, reviewerInstruction, [...settleRunIds, stopped.id]);
      return () => this.resolution.retry(this.releaseStoppedRevision(t, stopped), revise, instruction, operator, resumeIntent, prePr, scopedInstruction, reviewerInstruction);
    }
    if (reviewerInstruction !== undefined) {
      const refusal = retryAdmission(t, { stage: 'reviewer-delivery', revise, operator, instruction, reviewerInstruction,
        remap: Boolean(this.retainedWorkerRemap(t)) });
      if (refusal) throw new Error(refusal);
    }
    const mergeRoute = retrySpecialRoute(t, 'merge', operator, revise, null);
    if (typeof mergeRoute === 'object') throw new Error(mergeRoute.refuse);
    if (mergeRoute === 'merge') {
      return () => this.resolution.update(t, { attention: false }, { phase: 'merging', reason: 'Operator requested another read-only merge outcome check' }, 'uncertain_merge_operator_retry');
    }
    const acceptedRevision=t.resolution.currentRunId?this.store.run(t.resolution.currentRunId):null;
    const staleRevisionHead=retrySpecialRoute(t, 'revision', operator, revise, acceptedRevision) === 'revision';
    if(staleRevisionHead){
      return () => this.resolution.update(t,{attention:false,integrationTurn:null,pendingWorkerInstruction:acceptedRevision!.instruction ?? acceptedRevision!.completion!.summary},{phase:'changes_requested',reason:'Reconciling accepted revision completion at the current PR head'},'revision_completion_retry');
    }
    const heldRun=t.resolution.currentRunId?this.store.run(t.resolution.currentRunId):null;
    const acceptedHookRetry=retrySpecialRoute(t, 'hook', operator, revise, heldRun) === 'hook';
    if(acceptedHookRetry){
      return () => this.resolution.update(t,{currentRunId:null,attention:false,mechanicalVerification:null,integrationTurn:null},
        {phase:'verifying',reason:'Operator requested pre-merge re-evaluation at the accepted reviewed head'},'pre_merge_retry_requested');
    }
    const remap=operator?this.retainedWorkerRemap(t):null;
    if(remap){
      const {retainedWorkerIssue}=remap;
      // An operator's fresh instruction wins over the last pending one, which can be stale
      // (consumer-b #181, 2026-09-28: a spent device-flow instruction became the continuation).
      const pending=this.workerContinuation(t, instruction);
      const failoverReason=`${OPERATOR_WORKER_REMAP_REASON} (${retainedWorkerIssue}). Continue the existing task: ${pending}`.slice(0,2000);
      return () => this.resolution.update(t,{currentRunId:null,attention:false,integrationTurn:null,recoveryActive:false,recoveryAttempts:0,recovery:null,pendingWorkerInstruction:pending},{phase:'changes_requested',failoverReason,replacementProfile:t.replacementProfile??null,reason:'Operator-approved worker remap; selecting an eligible replacement'},'worker_remap_requested');
    }
    const profileRoute = retrySpecialRoute(t, 'profile', operator, revise, null);
    if(typeof profileRoute === 'object') throw new Error(profileRoute.refuse);
    if(profileRoute === 'profile'){
      const prior=this.store.runs(t.id).filter(run=>run.role==='revision').at(-1);
      return () => this.resolution.update(t,{currentRunId:null,attention:false,integrationTurn:null,pendingWorkerInstruction:t.resolution.pendingWorkerInstruction??prior?.instruction??t.resolution.review?.summary??'Continue the existing task under the approved instruction'},{phase:'changes_requested',reason:'Operator requested retained worker profile eligibility recheck'},'retained_worker_retry');
    }
    const route = retryRoute(t, runs, revise);
    if (route === 'revision') {
      const options = { instruction, scopedInstruction, operator, prePr, resumeUnpublished,
        reviewOwner: Boolean(this.resolution.reviewContinuationOwner(t)) };
      let decision = revisionRoute(t, runs, options);
      if (decision.kind === 'need-time') decision = revisionRoute(t, runs, { ...options, createdAt: now() });
      if (decision.kind === 'refuse') throw new Error(decision.message);
      if (decision.kind !== 'revision') throw new Error('Revision time did not settle');
      return () => decision.via === 'operator'
        ? this.resolution.operatorReturn(t, decision.changes, decision.patch, decision.event, 'Operator-directed revision returned the retained worker to work', decision.patch.reason)
        : this.resolution.update(t, decision.changes, decision.patch, decision.event);
    }
    if(route==='worker'){
      // Spec 058 task 577: a stopped pre-callback worker resumes on its
      // retained thread; Queue never replaces it without a failure or an
      // approved model change. The continuation is the recorded pending
      // instruction or the task's own continuation.
      const action=instruction?.trim()||t.resolution.pendingWorkerInstruction||t.resolution.prePrResumeInstruction||this.workerContinuation(t);
      const changes={currentRunId:null,review:null,attention:false,integrationTurn:null,stalledTurnStop:null,prePrResumeInstruction:action,pendingWorkerInstruction:action};
      return () => operator
        ? this.resolution.operatorReturn(t,changes,{phase:'changes_requested',reason:action},'worker_resume_requested','Operator-directed resume returned the retained worker to work',`Worker action requested: ${action}`)
        : this.resolution.update(t,{...changes,recoveryAttempts:0,recoveryActive:false},{phase:'changes_requested',reason:action},'worker_resume_requested');
    }
    // project-a #1672: coordinator retry of revision-budget exhaustion with a ready_for_review
    // completion at the accepted PR used to skip this path (operator-only) and throw
    // NO_RESOLUTION_ACTION. An owner's parked restart takes this same reconciliation
    // to awaiting_review.
    if(route==='accepted-pr'){
      const reviewed=readyReviewAtHead(t);
      // The reconciliation that ends in awaiting_review must carry the reviewer instruction too;
      // otherwise the fresh reviewer is dispatched with an empty reviewReason (project-a #1897).
      const pendingReview=!reviewed&&reviewerInstruction!==undefined?{pendingReviewReason:reviewerInstruction}:{};
      return () => reviewed
        ? this.resolution.update(t,{attention:false,mechanicalVerification:null,integrationTurn:null},
          {phase:'verifying',reason:`${operator?'Operator':'Coordinator'} requested pre-merge re-evaluation at the accepted reviewed head`},'pre_merge_retry_requested')
        : this.resolution.update(t,{attention:false,...pendingReview},{reason:ACCEPTED_PR_RECONCILIATION_REASON},'task_workspace_recovery_requested');
    }
    if (route === 'blocked') {
      // Read exact-head evidence only for the reviewer-instruction route that needs it.
      const initial = blockedRetryRoute(t, runs, reviewerInstruction, false, null);
      let decision = initial;
      if (initial.kind === 'refuse' && initial.message === 'A reviewer instruction requires a blocked or errored reviewer result that returns the task to review') {
        const accepted = Boolean(this.acceptedReviewAtUnchangedHead(t));
        const advanced = accepted ? null : this.retainedWorkerAdvancedReviewHead(t);
        decision = blockedRetryRoute(t, runs, reviewerInstruction, accepted, advanced?.head ?? null);
      }
      if (decision.kind === 'refuse') throw new Error(decision.message);
      const { phase, reconciledReviewHead } = decision;
      // An operator retry answers the escalation, so it ends that recovery episode: the next,
      // unrelated fault gets its own coordinator budget. Carrying it over escalated a later
      // reviewer crash with no coordinator at all (project-a #1655, 2026-09-28).
      const episodeEnd = operator ? { recoveryActive: false, recoveryAttempts: 0, recovery: null } : {};
      const pendingReview = reviewerInstruction!==undefined ? { pendingReviewReason: reviewerInstruction } : {};
      const explicitContinuation = t.resolution.pendingWorkerInstruction ?? t.resolution.prePrResumeInstruction ??
        (t.resolution.revisionInstruction?.runId === null ? t.resolution.revisionInstruction.text : null);
      const retryContinuation = phase === 'changes_requested'
        ? explicitContinuation ?? 'Continue the existing task under its current approved instruction source and within its approved scope.'
        : null;
      return () => {
        if(reconciledReviewHead)this.store.event(t.id,'review_head_reconciled',
          `Reviewer instruction returned the task to review at the retained worker's pushed head ${reconciledReviewHead} (accepted review ${t.resolution.review?.head??'unknown'}); recorded without reset or history rewrite`);
        return this.resolution.update(t, { currentRunId: null, attention: false, integrationTurn: null, ...episodeEnd, ...pendingReview,
          // A blocked result is routing/diagnostic evidence. It must not replace a pending
          // explicit continuation or become the next run's authorized action by itself.
          ...(retryContinuation ? { pendingWorkerInstruction: retryContinuation } : {}),
          },
        { phase, reason: 'Retry requested after resolving the blocker', ...(reconciledReviewHead?{prHead:reconciledReviewHead}:{}) }, 'resolution_retry');
      };
    }
    if (route === 'no-action') throw new Error(NO_RESOLUTION_ACTION);
    if (route === 'closeout') return () => this.resolution.update(t, { currentRunId: null, attention: false }, { phase: 'syncing', reason: 'Refreshing main before retrying closeout' }, 'resolution_retry');
    // A held project validation is a failure to run, not a verdict. The gate reuses a settled
    // result for the same candidate so automatic passes never loop; an operator retry clears a
    // hold so the validation actually runs again.
    // A running record whose process is gone (or was never recorded) is lost with a restart; an
    // operator retry clears it too. A live process keeps it: its result is still coming.
    const heldOrLost = t.resolution.projectValidation?.state === 'hold' ||
      (t.resolution.projectValidation?.state === 'running' && !(t.resolution.projectValidation.pid && pidAlive(t.resolution.projectValidation.pid)));
    const rerunHeldValidation = operator && heldOrLost;
    return () => this.resolution.update(t, { attention: false, ...(rerunHeldValidation ? { projectValidation: null } : {}),
      ...(t.resolution.mergeIntent && !t.resolution.mergedCommit ? {} : { integrationTurn: null }) }, { reason: 'Resolution check retry requested' }, 'resolution_retry');
  }

  resumeWorkerContinuation(t: Task, operator: boolean, continueWorker: (task: Task) => Task): Task {
    const apply = () => {
      let current = this.store.task(t.id);
      if (current.prerequisiteWait && !current.prerequisiteWait.releasedAt)
        throw new Error(RETAINED_PREREQUISITE_REFUSAL);
      const continued = continueWorker(current);
      current = this.store.task(t.id);
      if (current.prerequisiteWait?.releasedAt)
        return this.store.update(current.id, { prerequisiteWait: null }, 'prerequisite_wait_resumed',
          `${operator ? 'Operator' : 'Recovery'} explicitly resumed the task after the prerequisite notice`);
      return continued;
    };
    return this.store.db.isTransaction ? apply() : this.store.transaction(apply);
  }

  resumeWorker(t: Task, instruction: string, operator = false) {
    return this.prepareResumeWorker(t, instruction, operator)();
  }

  prepareResumeWorker(t: Task, instruction: string, operator = false, settleRunIds: string[] = []): () => Task {
    if(this.resolution.reviewContinuationOwner(t))
      throw new Error('A reviewer continuation owns this task; wait for its verdict or resolve the reviewer thread instead of returning the task to the worker');
    if(t.prerequisiteWait && !t.prerequisiteWait.releasedAt)
      throw new Error(RETAINED_PREREQUISITE_REFUSAL);
    const runs=this.store.runs(t.id).map(run => settleRunIds.includes(run.id) ? { ...run, released: true } : run);
    const stoppedRevision=this.stoppedRevisionWithoutCallback(t,runs);
    let decision=resumeRoute(t,runs,instruction,operator,stoppedRevision,undefined);
    if(decision.kind==='check-validation')
      decision=resumeRoute(t,runs,instruction,operator,stoppedRevision,Boolean(this.resolution.validationAlive(t)));
    if(decision.kind==='refuse')throw new Error(decision.message);
    if(decision.kind==='stopped'){
      const hasPr=taskHasPr(t);
      const resumeIntent=Boolean(decision.run.identityConfirmation);
      this.prepareRetry({ ...t, resolution: { ...t.resolution, currentRunId: null, attention: false } }, true, instruction, operator, resumeIntent, !hasPr, undefined, undefined, [...settleRunIds, decision.run.id]);
      return () => this.resumeWorkerContinuation(this.releaseStoppedRevision(t,decision.run),operator,current=>this.resolution.retry(current,true,instruction,operator,resumeIntent,!hasPr));
    }
    if(decision.kind!=='resume') throw new Error('Worker resume validation did not settle');
    const action=decision.action;
    const changes={currentRunId:null,review:null,attention:false,integrationTurn:null,stalledTurnStop:null,prePrResumeInstruction:action,pendingWorkerInstruction:action};
    return () => this.resumeWorkerContinuation(t,operator,current=>operator
      ? this.resolution.operatorReturn(current,changes,{phase:'changes_requested',reason:action},'worker_resume_requested','Operator-directed resume returned the retained worker to work',`Worker action requested: ${action}`)
      : this.resolution.update(current,{...changes,recoveryAttempts:0,recoveryActive:false},{phase:'changes_requested',reason:action},'worker_resume_requested'));
  }

  /** The unreleased current revision, or null when another lease still holds. */
  private stoppedRevisionWithoutCallback(t: Task, runs: Run[]): Run | null {
    const run = runs.find(run => run.id === t.resolution.currentRunId) ?? null;
    if (!run || run.role !== 'revision' || run.completion || run.released) return null;
    if (run.agentId !== t.agentId || run.workspaceId !== t.workspaceId) return null;
    if (runs.some(other => other.id !== run.id && other.role !== 'recovery' && !other.released)) return null;
    return run;
  }

  private releaseStoppedRevision(t: Task, run: Run): Task {
    const apply = () => {
      this.adapter.purgeReportingFiles?.(t.id, [run.id]);
      this.store.deleteCredential(run.id);
      this.store.putRun({ ...run, status: 'superseded', released: true });
      return this.resolution.update(t, { currentRunId: null, attention: false }, {}, 'stopped_revision_released_for_live_validation');
    };
    return this.store.db.isTransaction ? apply() : this.store.transaction(apply);
  }

  /**
   * Spec 050 `restart`: release one retained stopped revision run and hand the
   * same retained worker a continuation, without requiring the escalated
   * missing-callback recovery record the narrow control needed first. The
   * caller has already observed the retained worker stopped.
   */
  admitStoppedRevision(t: Task, instruction: string, prePr: boolean, settleRunIds: string[] = []): Run {
    const runs = this.store.runs(t.id).map(run => settleRunIds.includes(run.id) ? { ...run, released: true } : run);
    const stopped = this.stoppedRevisionWithoutCallback(t, runs)
      ?? runs.findLast(run => run.role === 'revision' && !run.completion && !run.released
        && run.agentId === t.agentId && run.workspaceId === t.workspaceId) ?? null;
    if (!stopped) throw new Error('No retained stopped revision run to restart');
    // The read-only identity confirmation re-arms as the same intent; an ordinary
    // stopped revision keeps implementation authority.
    const resumeIntent = Boolean(stopped.identityConfirmation);
    this.prepareRetry({ ...t, resolution: { ...t.resolution, currentRunId: null, attention: false, recoveryActive: false, recovery: null, stalledTurnStop: null } },
      true, instruction, true, resumeIntent, prePr, undefined, undefined, [...settleRunIds, stopped.id]);
    return stopped;
  }

  restartStoppedRevision(t: Task, instruction: string, prePr: boolean, settleFences?: { detail: string; runIds: string[]; displacedRunIds?: string[] }): Task {
    return this.store.transaction(() => {
      // Spec 050 (#3569): the restart settles its armed fences atomically with
      // the restart; a refusal inside rolls both back.
      if (settleFences) this.resolution.settleVerbFences(t.id, settleFences);
      const stopped = this.admitStoppedRevision(this.store.task(t.id), instruction, prePr);
      const resumeIntent = Boolean(stopped.identityConfirmation);
      this.adapter.purgeReportingFiles?.(t.id, [stopped.id]);
      this.store.deleteCredential(stopped.id);
      this.store.putRun({ ...stopped, status: 'superseded', released: true, active: false });
      const current = this.store.task(t.id);
      this.resolution.update(current, { currentRunId: null, attention: false, recoveryActive: false, recovery: null,
        stalledTurnStop: null }, {}, 'stopped_revision_restarted');
      return this.resolution.retry(this.store.task(t.id), true, instruction, true, resumeIntent, prePr);
    });
  }
}
