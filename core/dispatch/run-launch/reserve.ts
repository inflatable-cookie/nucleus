import type { LaunchReserveContext } from '../launch';
import type { LaunchMachinePorts } from './machine';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDispositionActive, workerExclusionFor, type Profile, type Run, type Task } from '../../../shared/contracts';
import { dispatchBlocked, DISPATCH_HELD_REASON } from '../capacity';
import { currentBrief } from '../../planning/brief';
import { checkHistoryFromStore, taskPrNumber } from '../../forge/index';
import { ordinaryReviewDelta, proveReviewRunSource } from '../../review/ordinary-review';
import type { Adapter } from '../../host/adapter';
import { proofSingleFlightRefusal } from '../../qa/proof-execution';
import { revisionContinuationAction } from '../prompts';
import { blockingRecoveryEffectsRefusal } from '../../recovery/recovery-effects';
import type { ProofActivation, ContinuedPrBinding } from '../../resolution';
import { assertReviewEntryWriterYielded, reviewEntryInputForTask, ReviewEntryRefusal, type ReviewEntryAdapter } from '../../review/review-entry';
import { chooseProfile } from '../routing';
import { now } from '../../store/store';
import { proofExecutor } from '../../recovery/task-reasons';

/**
 * Reserve the run a launch will deliver: the intent row, credential, slot
 * charge and post-transaction hand-off to deliver.
 */
export class RunLaunchReserve {
  constructor(readonly resolution: LaunchReserveContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get machine(): LaunchMachinePorts { return this.adapter; }
  async reserveLaunchRun(t: Task, role: Run['role'], options: { profile?: Profile; instruction?: string; proof?: ProofActivation }, source:{firstReviewEntryWorker:boolean;firstWorkerSelection:ReturnType<typeof chooseProfile>|null;prePrWorkerResume:boolean;retainedPrePrHead:string|null;resumingUnpublished:boolean;continuedPr?:ContinuedPrBinding|null}, selection:{agentId:string|null;profile:Profile|null;group:string|null;workspaceId:string;coordinatorRouteSwitch:string|null;replacingReviewer:boolean;orphanRuns:(id:string)=>Run[];threadBusy:(id:string)=>boolean}):Promise<void> {
    const {firstReviewEntryWorker, prePrWorkerResume, retainedPrePrHead}=source;
    let {agentId, profile, group, workspaceId, coordinatorRouteSwitch, replacingReviewer, orphanRuns, threadBusy}=selection;
    // A scoped revision instruction is delivered exactly once: it is attached to the run intent
    // that consumes it and never replayed to a later revision run.
    const pendingInstruction = role === 'revision' && t.resolution.revisionInstruction?.runId === null ? t.resolution.revisionInstruction : null;
    const nonDeliveryReplacement = role === 'revision' && t.resolution.nonDeliveryRoutePending;
    const pendingPrePrInstruction = prePrWorkerResume ? t.resolution.prePrResumeInstruction : null;
    const pendingWorkerInstruction = role === 'revision'
      ? t.resolution.pendingWorkerInstruction ?? pendingPrePrInstruction ?? pendingInstruction?.text ??
        (t.phase === 'changes_requested' && t.resolution.review?.status === 'changes_required' ? t.resolution.review.summary : null) : null;
    const runInstruction = role === 'revision'
      ? options.instruction ?? pendingWorkerInstruction ?? (prePrWorkerResume
        ? 'Continue the original task in the retained workspace under its immutable instructions.'
        : revisionContinuationAction(t))
      : null;
    // Semantic review revisions (ordinary findings on the accepted head) stay distinct from
    // administrative recovery revisions in telemetry and in the revision budget. A durable
    // reviewed-head refusal is semantic too: it consumes one revision round without
    // overwriting the accepted review the hook occurrence already recorded.
    const pendingRevisionCause = role === 'revision' ? t.resolution.pendingRevisionCause : null;
    const revisionCause: Run['revisionCause'] = role === 'revision' ? (pendingRevisionCause ?? (t.resolution.review?.status === 'changes_required' ? 'review' : 'administrative')) : undefined;
    // Task 576: the cap counts review rounds, not author returns. Only the first
    // revision dispatched for one changes_required review consumes a round; later
    // dispatches for the same review (unfinished or non-delivery continuations,
    // owner-approved re-dispatches) and pre-merge refusals continue that round
    // without counting again (resolution review on #823, finding 1).
    const reviewEventId = role === 'revision' && revisionCause === 'review' ? t.resolution.review?.eventId ?? null : null;
    const countsReviewRound = revisionCause === 'review' && (reviewEventId === null || t.resolution.countedReviewEventId !== reviewEventId);
    const stash = role === 'revision' && t.directory ? await this.machine.readStash?.(t.directory).catch(() => null) ?? null : null;
    const token = randomBytes(32).toString('hex');
    if (proofExecutor(role) && !options.proof?.tree) throw new Error('Proof execution requires its source tree proof before reservation');
    const proofTree = proofExecutor(role) ? options.proof!.tree! : null;
    const retryContext = role === 'revision' ? this.resolution.retryContext(t) : undefined;
    const sourceReservationVersion=this.store.task(t.id).version;
    const sourceReservationRuns=JSON.stringify(this.store.runs(t.id));
    const ordinaryReservationRuns=this.resolution.ordinaryReviewRuns(t.id);
    const runId=randomUUID();
    const previousReview = role === 'reviewer' && t.entrypoint !== 'proof'
      ? this.store.runs(t.id).findLast(prior => prior.role === 'reviewer' && prior.released && prior.status === 'finished' && prior.completion) : undefined;
    // A subsequent round reads covering checks and the integration base only: asking whether a
    // review approves merging would refuse the very reviewer that has yet to review this head.
    const coveringEvidence = previousReview && previousReview.head !== t.prHead
      ? await this.machine.coveringEvidence!(t, checkHistoryFromStore(this.store, t.repoPath, Date.now(), t.prHead ?? ""), this.store.checksPolicyFor(t))
      : null;
    if (coveringEvidence && coveringEvidence.head !== t.prHead) throw Error('Covering evidence belongs to a different review head');
    const roundBase = coveringEvidence?.base ?? t.resolution.mergeBase ?? t.planningBase;
    // Queue 524 (papercut 2061d84f): a reviewer reads author evidence posted as
    // PR issue comments with gh. The run carries a bounded pointer (never
    // bodies); a fetch failure degrades to an explicit self-check notice, never
    // silence, so the reviewer still lists the comments itself.
    let authorEvidence = '';
    if (role === 'reviewer' && t.prHead) {
      try {
        const priorCommentId = previousReview?.completion && typeof (previousReview.completion as { reviewCommentId?: unknown }).reviewCommentId === 'number'
          ? (previousReview.completion as { reviewCommentId: number }).reviewCommentId : null;
        authorEvidence = await this.machine.authorCommentEvidence!(t, priorCommentId);
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 200);
        authorEvidence = `Author comment inventory could not be read (${reason}); list the PR issue comments yourself with gh and treat every comment that is not a Nucleus review publication as author evidence for the current head ${t.prHead}.`;
      }
    }
    const round = previousReview && (previousReview.head !== t.prHead || previousReview.completion?.sourceApproved)
      ? { ordinaryDetached: true as const, priorRunId: previousReview.id, priorHead: previousReview.head,
          retainedRounds: agentId === previousReview.agentId ? (previousReview.retainedRounds ?? 0) + 1 : 0,
          ...(previousReview.head === t.prHead && previousReview.completion?.sourceApproved
            ? { proofOnly: true as const, reviewDelta: `Judge only arriving proof evidence for source approved at ${t.prHead}. Earlier findings: ${previousReview.completion.reviewText}` }
            : { reviewDelta: await ordinaryReviewDelta(t, previousReview, t.prHead!, roundBase) + `Covering evidence at ${t.prHead}:\n${JSON.stringify(coveringEvidence)}\n` }) } : {};
    const proofOnlyReview = role === 'reviewer' && t.entrypoint === 'proof';
    const proofOnlyInstruction = proofOnlyReview ? (t.proofExecutions.length
      ? `Judge only the immutable Nucleus proof receipt for merged commit ${t.proofOnly!.commit}. Receipt: ${JSON.stringify(t.proofExecutions.at(-1))}`
      : `The qualification touches ${t.requiresOperatorGo}. Do not run the selector or judge source. Report blocked at ${t.proofOnly!.commit} while Queue obtains the operator's release GO.`) : undefined;
    const run: Run = { ...round, ...(this.machine.runTemporaryDirectory ? { temporaryDirectory: this.machine.runTemporaryDirectory(runId, t) } : {}), ...(proofOnlyReview ? { proofOnly: true as const, reviewDelta: proofOnlyInstruction } : {}), briefVersion: currentBrief(t)?.version ?? null, id: runId, ...(source.resumingUnpublished?{identityConfirmation:true as const}:{}), ...(role === 'reviewer' && authorEvidence ? { authorEvidence } : {}), ...(role === 'reviewer' && t.resolution.proofRetry?.head === t.prHead
      ? { proofRetry: { forRunId: t.resolution.proofRetry.runId, head: t.resolution.proofRetry.head, proofs: t.resolution.proofRetry.proofs } } : {}), taskId: t.id, role, generation: t.coordinatorGeneration, head: role === 'closeout' ? t.resolution.syncedCommit! : prePrWorkerResume ? retainedPrePrHead! : source.continuedPr?.head ?? t.proofOnly?.commit ?? t.prHead ?? t.planningBase, base: prePrWorkerResume ? t.planningBase : role === 'reviewer' ? roundBase : t.resolution.mergeBase ?? t.planningBase, siblings: t.siblingPins,
      ...(proofExecutor(role) ? { proofExecution: { selector: t.proofExecution!.selector, inputs: t.proofExecution!.inputs,
        prNumber: t.proofOnly ? null : taskPrNumber(t), tree: proofTree!, operationId: options.proof?.operationId ?? null,
        briefVersion: currentBrief(t)?.version ?? null, briefDigest: currentBrief(t)?.digest ?? null,
        ...(options.proof?.goEvidence ? { goEvidence: options.proof.goEvidence } : {}),
        returnPhase: t.phase, authorizedBy: options.proof?.authorizedBy ?? { role: 'queue_dispatch' as const, caller: null, note: null } } } : {}),
      instruction: proofOnlyInstruction ?? runInstruction, ...(retryContext ? { retryContext } : {}), revisionCause,
      reviewReason: role === 'reviewer' ? t.resolution.pendingReviewReason : undefined,
      formalReview: role === 'reviewer' ? Boolean(this.resolution.reviewerSetting(t)) : undefined,
      // sendRun only rotates a binding, not a retained agent's MCP catalog.
      // Require the field only for a fresh bridge or its proven retained lineage.
      reviewResponsibilityRequired: role === 'reviewer'
        ? !agentId || this.store.runs(t.id).some(prior => prior.agentId === agentId && prior.reviewResponsibilityRequired === true)
        : undefined,
      agentId, workspaceId, profile, profileGroup: group ?? this.store.runs(t.id).findLast(r=>r.agentId===agentId && r.profileGroup)?.profileGroup ?? (profile ? this.store.pool().find(p=>p.profileId===profile.id)?.group ?? null : null), status: 'intent', createdAt: now(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false };
    // Spec 017 handover: every review-entry reviewer send runs in the task
    // workspace. The task lease knows only Queue runs and task agents, so writer
    // yield is re-proved here, then the exact branch/head/clean-tree proof
    // (async). The reservation transaction re-checks identity.
    const handoverReview = role === 'reviewer' && Boolean(t.reviewEntry);
    if (handoverReview) {
      try { await assertReviewEntryWriterYielded(reviewEntryInputForTask(t), this.adapter as Adapter & ReviewEntryAdapter, t.id); }
      catch (error) {
        if (error instanceof ReviewEntryRefusal && error.transient) { this.resolution.waiting(t, error.message, 'origin_busy'); return; }
        throw error;
      }
      await proveReviewRunSource(this.store.task(t.id), run.head, false);
    }
    if (source.continuedPr?.progressRunId) {
      const wait = await this.resolution.continuedProgressWait(t,source.continuedPr.head);
      if (wait) { this.resolution.waiting(this.store.task(t.id),wait,'lifecycle'); return; }
    }
    // The checks above awaited the adapter. Two wakes can both pass them, so the
    // reservation re-checks inside the transaction that records the run.
    let settled: string[] = [];
    const reserved = this.store.transaction(() => {
      const latest = this.store.task(t.id);
      // Task 560: the durable single-flight reservation, first in the
      // transaction so a concurrent trigger that lost the race refuses with
      // this reason instead of a generic reservation-changed error. The run
      // intent below is recorded before the adapter call, so a rival intent
      // that landed first owns the task: this dispatch refuses here, before
      // anything is sent, whether the rival came from a restart, the advance
      // loop or a concurrent owner control.
      if (proofExecutor(role)) {
        const singleFlight = proofSingleFlightRefusal(latest, this.store.runs(t.id), run.head);
        if (singleFlight) throw Error(singleFlight);
      }
      if (handoverReview && (latest.prHead !== run.head || latest.directory !== t.directory || latest.entrypoint !== 'review'))
        throw Error('The review source changed before the reviewer run was reserved; no reviewer was created');
      if(run.ordinaryDetached&&(latest.version!==sourceReservationVersion||this.resolution.ordinaryReviewRuns(t.id)!==ordinaryReservationRuns||latest.prHead!==run.head||dispatchBlocked(latest)||isDispositionActive(latest))) {
        this.resolution.waiting(latest, 'Ordinary review source reservation changed during canonical admission; rechecking before dispatch', 'lifecycle');
        return false;
      }

      if (latest.resolution.currentRunId !== t.resolution.currentRunId || agentId && threadBusy(agentId)) return false;
      if (coordinatorRouteSwitch && (latest.coordinatorGeneration !== t.coordinatorGeneration
          || latest.coordinatorAgentId !== t.coordinatorAgentId
          || JSON.stringify(latest.profileRequests?.coordinator) !== JSON.stringify(t.profileRequests?.coordinator))) return false;
      if ((role === 'reviewer' || role === 'revision' || proofExecutor(role)) && dispatchBlocked(latest)) { this.resolution.waiting(latest, DISPATCH_HELD_REASON, 'held'); return false; }
      if (proofExecutor(role) && (latest.version !== sourceReservationVersion || JSON.stringify(this.store.runs(t.id)) !== sourceReservationRuns
          || (latest.proofOnly ? latest.proofOnly.commit : latest.prHead) !== run.head || latest.proofExecution?.selector !== run.proofExecution?.selector
          || latest.proofExecution?.inputs?.join(',') !== run.proofExecution?.inputs?.join(',')))
        throw Error('Proof-execution source or brief reservation changed during admission');
      if(role==='revision'){
        const exclusion=workerExclusionFor(latest,agentId,profile?.id);
        if(exclusion){
          const identity=exclusion.agentId?`agent ${exclusion.agentId}`:`profile ${exclusion.profileId}`;
          const reason=`Planner/operator exclusion prevents another turn for ${identity}: ${exclusion.reason}`;
          if(!latest.failoverReason)this.store.update(latest.id,{failoverReason:reason},'excluded_worker_revision_refused',reason);
          return false;
        }
      }
      const latestWait = this.resolution.slotAdmissionReason(latest);
      if (latestWait) { this.resolution.waiting(latest, latestWait, 'capacity'); return false; }
      const decided = source.continuedPr?.decided;
      if (source.continuedPr?.progressRunId && (this.resolution.progressEffectsPending(latest) || this.resolution.paused())) {
        const effectWait=blockingRecoveryEffectsRefusal(this.store,latest,{noticeKinds:'all'});
        this.resolution.waiting(latest,`Retained progress continuation waits: ${effectWait??'operations, hooks or notices are unsettled'}`,'lifecycle');
        return false;
      }
      if (source.continuedPr && (!decided || latest.version !== decided.version || JSON.stringify(this.store.runs(t.id)) !== decided.runs
        || !this.resolution.bindContinuedPrInTx(t.id, source.continuedPr, `revision dispatch ${run.id}`))) return false;
      if (agentId) settled = this.resolution.supersedeOrphans(t.id, orphanRuns(agentId));
      // Replace the deferred coordinator binding and advance its callback fence
      // atomically with the new run. The live predecessor kept its generation
      // until release; the replacement task and run must now agree.
      if (coordinatorRouteSwitch) run.generation = latest.coordinatorGeneration + 1;
      this.store.setCredential(run.id, token); this.store.putRun(run);
      const dispatchReason = role === 'revision' && revisionCause === 'non_delivery'
        ? 'Dispatching non-delivery follow-up; it does not consume a semantic revision round'
        : role === 'revision' && revisionCause === 'unfinished'
          ? 'Dispatching unfinished-work follow-up; it does not consume a semantic revision round'
          : role === 'revision' && revisionCause === 'consult'
            ? 'Dispatching reviewer-consult continuation with its advice; it does not consume a semantic revision round'
            : `Dispatching ${role}`;
      if (role === 'reviewer' && !agentId && profile && !options.profile) t = this.resolution.recordCriticalReviewFallback(this.store.task(t.id), profile);
      this.resolution.update(t, { currentRunId: run.id, stalledTurnStop: null,
        ...(role==='reviewer'&&run.reviewReason?{pendingReviewReason:null}:{}), ...(role==='reviewer'&&run.proofRetry?{proofRetry:null}:{}), ...(role==='revision'?{pendingWorkerInstruction:null,revisionRuns:t.resolution.revisionRuns+(countsReviewRound?1:0), ...(reviewEventId?{countedReviewEventId:reviewEventId}:{}), revisionResumeUnpublished:false, pendingRevisionCause:null,
        ...(pendingPrePrInstruction ? { prePrResumeInstruction: null } : {}), ...(pendingInstruction?{revisionInstruction:{...pendingInstruction,runId:run.id}}:{})}:{}), ...(replacingReviewer?{reviewerAgentId:null,reviewerProfile:null,review:null,roleReplacements:t.resolution.roleReplacements+1}:{}) }, { phase: role === 'reviewer' ? 'reviewing' : role === 'revision' ? 'changes_requested' : proofExecutor(role) ? t.phase : 'closing', reason: dispatchReason, ...(role === 'revision' ? { stashBaseline: stash ? { runId: run.id, entries: stash } : null } : {}), ...(coordinatorRouteSwitch ? { coordinatorAgentId: '', coordinatorGeneration: run.generation } : {}) }, 'run_intent');
      if(replacingReviewer)this.store.event(t.id,'role_replacement',`reviewer: retained profile unavailable; replacement ${profile!.name||profile!.id}`);
      if (group) this.store.chargeAssignment(group,profile!.id);
      return true;
    });
    if (!reserved) return;
    this.resolution.launchingRuns.add(run.id);
    try {
      if (source.continuedPr) t = this.store.task(t.id);
      this.resolution.advanceAttempt.getStore()?.add(run.id);
      if (coordinatorRouteSwitch) {
        t = this.store.task(t.id);
        this.store.event(t.id, 'coordinator_route_applied', coordinatorRouteSwitch.startsWith('sign-off:')
          ? `The bound coordinator profile ${coordinatorRouteSwitch.slice('sign-off:'.length)} awaits the operator's board sign-off; ${profile?.id ?? 'a profile within the usage level'} serves at generation ${run.generation}`
          : `Owner-routed coordinator profile ${coordinatorRouteSwitch} supersedes the recorded coordinator binding at generation ${run.generation}`);
      }
      if (settled.length) this.machine.purgeReportingFiles?.(t.id, settled);
      return await this.resolution.deliverLaunchRun(t, role, {agentId, profile, group, workspaceId, firstReviewEntryWorker, nonDeliveryReplacement, run, token});
    } finally { this.resolution.launchingRuns.delete(run.id); }
  }
}
