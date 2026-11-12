import { stages, ACCEPTED_PR_RECONCILIATION_REASON } from '../recovery/task-reasons';
import { blockingRecoveryEffects, recoveryEffectsRefusal } from '../recovery/recovery-effects';
import { blockedEffectAttentionRecorded } from '../recovery/effect-gates';
import { proofWaitApplies } from '../qa/proof-execution';
import { type Task } from '../../shared/contracts';
import { isDispositionActive } from "../../shared/contracts";
import { reviewAuthorizationRequired, reviewContinuationWait } from '../review/review-continuation';
import { staleChangesRequestedPhase } from '../intake/current-binding';
import { isProviderFailure } from '../questions/blocker-ladder';
import type { Resolution } from '../resolution';

export type SchedulingLifecycleContext = Pick<Resolution, 'acceptedPrWorkspaceMayApply' | 'adapter' | 'advanceAttempt' | 'advanceChangesRequested' | 'advanceClosing' | 'advanceCompletedRun' | 'advanceMerging' | 'advancePhase' | 'advanceSkippedReview' | 'advanceSyncing' | 'attentionReplayApplies' | 'blockerLadderApplies' | 'blockerLadderStep' | 'hooks' | 'hostAvailable' | 'launch' | 'operatorReturn' | 'pauseForPrerequisiteWait' | 'paused' | 'reapplyPendingReview' | 'reconcileAcceptedPrWorkspace' | 'recordStoredResult' | 'recovery' | 'reobservePendingChecks' | 'replayHeldAttention' | 'restoreRecordedMergePhase' | 'settleAdvanceFailure' | 'settleSourceApprovalProof' | 'settleUnchangedCheckGate' | 'sourceApprovalWaitApplies' | 'startsNoRuns' | 'stopped' | 'store' | 'supersedeEarlierRecovery' | 'unchangedCheckGateApplies' | 'update' | 'verification' | 'waiting'>;

export class SchedulingLifecycle {
  constructor(readonly context: SchedulingLifecycleContext) {}
  owns(t: Task) {
    // A parked initial report still needs classification, with or without a PR
    // or a run-creation adapter. The branch audit establishes identity only. A live
    // recovery thread owns the stop it was asked about: classifying now would move
    // the task out from under its report, so classification waits for that episode.
    if (['blocked', 'error'].includes(t.phase) && !t.resolution.currentRunId && !t.resolution.recoveryActive
      && t.completion && ['blocked', 'error'].includes(t.completion.status)
      && !isProviderFailure(t.completion)) return true;
    if (!['done', 'cancelled'].includes(t.phase) && proofWaitApplies(t)) return true;
    if (!this.context.adapter.createRun) return false;
    if (stages.includes(t.phase)) return true;
    // Operator or coordinator retry that asked for accepted-PR workspace reconciliation is
    // resolution's to finish whether or not the workspace is available; without this, an
    // available workspace never reached advance() and the retry dead-ended (#083, 2026-09-27).
    // Coordinator retry of the same parked accepted-PR state used to throw NO_RESOLUTION_ACTION
    // (project-a #1672, 2026-09-29).
    if (t.phase === 'needs_attention' && t.reason === ACCEPTED_PR_RECONCILIATION_REASON && !t.resolution.currentRunId) return true;
    if (t.phase !== 'needs_attention' || !t.resolution.currentRunId) return false;
    const run = this.context.store.run(t.resolution.currentRunId);
    // An authenticated result can arrive while recovery is escalating the old
    // missing-callback incident. Once its run is released, result processing
    // owns the task again even though the task projection still says attention.
    return Boolean(run?.released && run.completion);
  }

  pauseForPrerequisiteWait(t: Task): boolean {
    if (!t.prerequisiteWait || t.prerequisiteWait.releasedAt) return false;
    return this.context.store.reconcilePrerequisiteWait(t.id) !== 'none';
  }

  async advance(original: Task) {
    if (this.context.stopped()) return;
    if (!this.context.hostAvailable(original)) return;
    let t = this.context.supersedeEarlierRecovery(this.context.store.task(original.id));
    if (isDispositionActive(t)) return;
    if (await this.context.reapplyPendingReview(t) === 'applied') return;
    // That check yields, for as long as its lease observation takes. Read what the
    // rest of this pass acts on after it, not before.
    t = this.context.store.task(t.id);
    if (reviewAuthorizationRequired(t, this.context.store)) { const wait = reviewContinuationWait(t, this.context.store); this.context.waiting(t, wait.reason, wait.stop); return; }
    if (this.context.sourceApprovalWaitApplies(t)) {
      const afterProof = await this.context.settleSourceApprovalProof(t);
      if (!afterProof) return;
      t = afterProof;
    }
    t = this.context.restoreRecordedMergePhase(t);
    if (this.context.acceptedPrWorkspaceMayApply(t)) {
      const afterAccepted = await this.context.reconcileAcceptedPrWorkspace(t);
      if (!afterAccepted) return;
      t = afterAccepted;
    }
    t = this.context.recordStoredResult(t);
    const requiredChecksStillPending = await this.context.reobservePendingChecks(this.context.store.task(t.id));
    if (requiredChecksStillPending) return;
    if (this.context.unchangedCheckGateApplies(t)) t = await this.context.settleUnchangedCheckGate(t);
    if (this.context.blockerLadderApplies(t)) {
      const afterLadder = await this.context.blockerLadderStep(t);
      if (!afterLadder) return;
      t = afterLadder;
    }
    t = this.context.store.task(t.id);
    if (this.context.attentionReplayApplies(t)) {
      const afterReplay = await this.context.replayHeldAttention(t);
      if (!afterReplay) return;
      t = afterReplay;
    }
    // A failure belongs to the run owner this attempt observed or the run it
    // reserved itself. Another attempt that reserved a newer run since then
    // superseded it, even once that run completed: the failure is history,
    // never the newer work's fault.
    const observedRunId = t.resolution.currentRunId, reserved = new Set<string>();
    const priorRuns = new Set(this.context.store.runs(t.id).map(run => run.id));
    const supersededBy = (current: Task) => {
      const runId = current.resolution.currentRunId;
      if (runId && runId !== observedRunId && !reserved.has(runId)) return runId;
      return this.context.store.runs(current.id).find(run => !priorRuns.has(run.id) && !reserved.has(run.id))?.id ?? null;
    };
    try { await this.context.advanceAttempt.run(reserved, async () => {
      await this.context.advancePhase(t);
    }); } catch (error) { if (!this.context.paused()) this.context.settleAdvanceFailure(t, error, observedRunId, supersededBy); }
  }

  sourceApprovalWaitApplies(t: Task): boolean {
    const sourceApproval = t.resolution.review;
    return Boolean(!t.resolution.mergedCommit && !t.resolution.currentRunId && t.phase !== 'changes_requested' && sourceApproval?.sourceApproved && sourceApproval.awaitingProofs?.length && !(t.resolution.ownerAcceptances ?? []).some(entry => entry.kind === 'operator_source' && entry.head === sourceApproval.head));
  }

  recordStoredResult(t: Task): Task {
    const completed=t.resolution.currentRunId?this.context.store.run(t.resolution.currentRunId):null;
    // A stored result is not new evidence on each wake. Only a missing-callback
    // stop may be satisfied by finding that result; publication faults keep
    // their incident/stop and any coordinator's cannot outcome until an owner acts.
    const missingCallback = completed && (t.reason===`The ${completed.role} thread stopped without a callback; inspect the thread`
      || t.reason===`The ${completed.role} callback reminder expired`
      || t.resolution.incident?.runId===completed.id && (t.resolution.incident.cause==='missing_callback' || t.resolution.incident.action==='callback_reminder'));
    // A stalled run can also deliver its authenticated result after escalation.
    // Only settle its own stall, after release and coordinator release; other
    // incidents (especially publication faults) still require their owner.
    const completedStall = completed && t.resolution.attention && t.resolution.incident?.runId===completed.id
      && t.resolution.incident.cause==='stalled_turn' && t.resolution.incident.status==='escalated'
      && completed.completion?.runId===completed.id;
    if((t.phase==='needs_attention'&&missingCallback || completedStall)&&completed?.released&&completed.completion&&!this.context.recovery.busy(t)){
      t=this.context.operatorReturn(t,{attention:false},{reason:`${completed.role} result accepted; resuming result processing`},'released_result_recovered','Released authenticated result superseded the unresolved attention episode');
    }
    if(t.resolution.attention && completed?.completion && missingCallback)t=this.context.update(t,{attention:false},{reason:'Late completion received; resuming result processing'},'late_completion_recovered');
    // A successful required-hook retry can leave attention set until the settled
    // closeout records prove there is nothing left to hold. The hook records are the
    // fact: a stale reason from an earlier failed attempt (a refused stale checkout,
    // say) must not keep a published closeout parked. Unsettled closeouts keep
    // attention for explicit operator retry.
    if (t.resolution.attention && t.phase === 'closing' && this.context.hooks?.closeoutEmissionSettled(t.id))
      t = this.context.update(t, { attention: false }, { reason: 'Repository closeout hooks settled after retry' }, 'hook_retry_recovered');
    return t;
  }

  blockerLadderApplies(t: Task): boolean {
    return (t.phase === 'blocked' || t.phase === 'error') && !t.resolution.currentRunId && !proofWaitApplies(t) && !t.removedAt;
  }

  async advancePhase(t: Task): Promise<void> {
    // A released run without a recorded result is settled history: its claim
    // ended without a verdict, so it is not the task's live work and a wait
    // derived from it names a continuation that can never happen (nucleus#1106).
    // Clear the binding so this pass proceeds to the phase's ordinary next step,
    // which dispatches the run or shows why it cannot.
    const bound = t.resolution.currentRunId ? this.context.store.run(t.resolution.currentRunId) : null;
    if (bound && bound.released && !bound.completion)
      t = this.context.update(t, { currentRunId: null,
        ...(bound.role === 'reviewer' ? { reviewerAgentId: null, reviewerProfile: null } : {}) },
        {}, 'released_run_binding_cleared',
        `${bound.role} run ${bound.id} was released without a result; it no longer holds the task`);
    const run = t.resolution.currentRunId ? this.context.store.run(t.resolution.currentRunId) : null;
    if (run) {
      await this.context.advanceCompletedRun(t, run);
      return;
    }
    // Pause still applies a current run's result above. The next phase is a
    // new run (reviewer, revision, skip-review merge, closeout launch) and waits.
    // Queue/hook closeout has no run to apply; settle it here, launch still no-ops.
    if (this.context.startsNoRuns()) {
      if (t.phase === 'closing') await this.context.advanceClosing(t);
      return;
    }
    // An accepted changes_required verdict already decided the phase: a review
    // phase left over the finished reviewer that delivered it is stale state,
    // and the author's revision is the outstanding work (papercut 4cfb2d35).
    // This reconciles the phase only: no publication, verification or credit.
    const stalePhase = staleChangesRequestedPhase(t, this.context.store.runs(t.id));
    if (stalePhase) {
      this.context.update(t, { currentRunId: null, pendingWorkerInstruction: stalePhase.reason },
        { phase: 'changes_requested', reason: stalePhase.reason }, 'stale_review_phase_reconciled');
      return;
    }
    // A wait recorded while a run was live takes effect here, after that run's
    // result is applied and before the next reviewer, revision, skip-review or
    // dispatch. The same-pass release still waits for a later pass.
    if (this.context.pauseForPrerequisiteWait(t)) return;
    if (t.phase === 'awaiting_review' && t.skipPRReview) {
      this.context.advanceSkippedReview(t);
    }
    else if (t.phase === 'awaiting_review' || t.phase === 'reviewing') {
      const effects = blockingRecoveryEffects(this.context.store, t, { noticeKinds: 'all' });
      const refusal = recoveryEffectsRefusal(effects);
      if (refusal && ['Ordinary review', 'Review-entry'].some(label =>
        t.reason === `${label} waits for ${refusal}; settle it with retry_effect before continuing`)) return;
      // Nucleus#1159: once this blocked phase is the recorded attention, only
      // later evidence or the owner's observation-first retry changes it;
      // relaunching would rewrite the wait and hide the attention again.
      if (refusal && blockedEffectAttentionRecorded(t)) return;
      await this.context.launch(t, 'reviewer');
    }
    else if (t.phase === 'changes_requested') {
      await this.context.advanceChangesRequested(t);
    }
    else if (t.phase === 'verifying') await this.context.verification(t);
    else if (t.phase === 'closing') {
      await this.context.advanceClosing(t);
    }
    else if (t.phase === 'merging') {
      await this.context.advanceMerging(t);
    } else if (t.phase === 'syncing') {
      await this.context.advanceSyncing(t);
    }
  }
}
