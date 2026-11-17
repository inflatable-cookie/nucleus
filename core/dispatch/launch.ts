import type { Profile, Run, Task } from '../../shared/contracts';
import { isDispositionActive, workerExclusionRefusal } from '../../shared/contracts';
import { budgetPauseDetail, taskBudget } from '../../shared/task-budget';
import { proofExecutor } from '../recovery/task-reasons';
import { dispatchBlocked, DISPATCH_HELD_REASON } from './capacity';
import { proofSingleFlightRefusal, qualificationModeRefusal, ProofSingleFlightError } from '../qa/proof-admission';
import { continueFirstEffectClock, firstEffectClockRefusal, type FirstEffectClockChoice } from '../host-runs/qualification-clock';
import { refuseProof } from '../qa/proof-refusal';
import { reviewAuthorizationRequired, reviewContinuationWait } from '../review/review-continuation';
import type { ProofActivation, Resolution } from '../resolution';
import { RunLaunchSource } from './run-launch/source';
import { RunLaunchThread } from './run-launch/thread';
import { RunLaunchReserve } from './run-launch/reserve';
import { RunLaunchDeliver } from './run-launch/deliver';

export type LaunchSourceContext = Pick<Resolution, 'adapter' | 'bindReportedHeadForReview' | 'continuedPrBinding' | 'continuedProgressWait' | 'ordinaryRoundCustody' | 'paused' | 'profiles' | 'retainedWorkerProfileIssue' | 'selectLaunchThread' | 'store' | 'update' | 'usageCeilingNote' | 'waiting' | 'workerContinuation'>;
export type LaunchThreadContext = Pick<Resolution, 'adapter' | 'assertReviewProfileIndependent' | 'attention' | 'authorAgentIds' | 'host' | 'openPlannerEscalation' | 'orphanRuns' | 'paused' | 'profiles' | 'requiredRouteNote' | 'reserveLaunchRun' | 'resolveWithdrawnPending' | 'retainedProfileIssue' | 'select' | 'signoffIssue' | 'store' | 'update' | 'usageCeilingNote' | 'waiting'>;
export type LaunchReserveContext = Pick<Resolution, 'adapter' | 'advanceAttempt' | 'bindContinuedPrInTx' | 'continuedProgressWait' | 'deliverLaunchRun' | 'launchingRuns' | 'ordinaryReviewRuns' | 'paused' | 'progressEffectsPending' | 'recordCriticalReviewFallback' | 'retryContext' | 'reviewerSetting' | 'slotAdmissionReason' | 'store' | 'supersedeOrphans' | 'update' | 'waiting'>;
export type LaunchDeliverContext = Pick<Resolution, 'adapter' | 'assertReviewProfileIndependent' | 'ensureIncident' | 'ordinaryReviewRuns' | 'ordinaryRoundCustody' | 'paused' | 'store' | 'update' | 'waiting'>;
export type DispatchLaunchContext = Pick<Resolution, 'catalogKnown' | 'claimIntegrationTurn' | 'launch' | 'lease' | 'leaseDeclineText' | 'paused' | 'responsibleJointQuestion' | 'slotAdmissionReason' | 'startsNoRuns' | 'store' | 'waiting'>
  & { pauseForPrerequisiteWait(task: Task): boolean } & LaunchSourceContext & LaunchThreadContext & LaunchReserveContext & LaunchDeliverContext;

/** Dispatch sequencing with live adapter and shell delegates supplied at composition. */
export class DispatchLaunch {
  /**
   * Spec 064 P5: the clock this attempt continues. Every recorded run intent's
   * clock is read first, so a retry keeps the earliest origin and can never
   * restart, shorten or lengthen the cumulative target.
   */
  private firstEffectClockFor(taskId: string): FirstEffectClockChoice {
    const recorded = this.context.store.runs(taskId)
      .map(run => run.proofExecution?.qualification?.firstEffectClock ?? null);
    return continueFirstEffectClock(recorded, Date.now());
  }

  readonly source = new RunLaunchSource(this.context);
  readonly thread = new RunLaunchThread(this.context);
  readonly reserve = new RunLaunchReserve(this.context);
  readonly deliver = new RunLaunchDeliver(this.context);
  constructor(readonly context: DispatchLaunchContext) {}
  async launch(t: Task, role: Run['role'], options: { profile?: Profile; instruction?: string; proof?: ProofActivation } = {}) {
    // The manual verification coordinator is retired (Spec 058 cutover 2): no
    // path may create a verification run again. Stored rows keep parsing.
    if (role === 'verification') throw new Error('The manual verification coordinator is retired; no verification run is launched');
    // An unloaded catalog is unknown availability: wait for the first refresh
    // instead of parking the retained profile as unavailable (consumer #660).
    if (!this.context.catalogKnown()) { this.context.waiting(t, 'Waiting for the daemon profile catalog to load after service start', 'lifecycle'); return; }
    // Spec 058 budgets: a task over either limit starts no new run. The pause is
    // a stop the operator answers; the run in flight, if any, already finished.
    {
      const current = this.context.store.task(t.id);
      const events = this.context.store.eventsAll(t.id);
      const budget = taskBudget(current, this.context.store.runs(t.id), Date.now(), events,
        this.context.store.canonicalRepository(current.repoPath, current.repository));
      if (budget.exhausted) { this.context.waiting(t, budgetPauseDetail(budget), 'budget'); return; }
    }
    if (reviewAuthorizationRequired(this.context.store.task(t.id), this.context.store)) { const wait = reviewContinuationWait(this.context.store.task(t.id), this.context.store); this.context.waiting(t, wait.reason, wait.stop); return; }
    if (isDispositionActive(t)) throw new Error("Disposition fence is active; no replacement runs are launched");
    if ((role === 'reviewer' || role === 'revision' || proofExecutor(role)) && dispatchBlocked(t)) { this.context.waiting(t, DISPATCH_HELD_REASON, 'held'); return; }
    if ((role === 'reviewer' || role === 'revision' || proofExecutor(role)) && this.context.pauseForPrerequisiteWait(t)) return;
    // A stale pending Nucleus question found at dispatch is resolved, not
    // waited on (papercut ee9fc161): a withdrawn question never stalls the
    // launch behind the participant lease. The helper records a short
    // resolving wait when it sends a dismiss or cancel; the next pass
    // launches once the host clears the stale request.
    if ((role === 'revision' || role === 'reviewer') && await this.context.resolveWithdrawnPending(t)) return;
    if ((role === 'closeout') && !this.context.claimIntegrationTurn(t)) return;
    t = this.context.store.task(t.id);
    if (!await this.context.lease(t, (agentId, state) => {
      // Every role's lease decline is a visible wait (nucleus#1100): name the
      // participant that still owns work, its owner and the verbs that exit the
      // wait, so a launch that starts nothing never reads as success. The
      // participant lease no longer polls runs whose completion is recorded;
      // their remaining fences record their own waits.
      if (!this.context.paused()) this.context.waiting(t, this.context.leaseDeclineText(t, agentId, state), 'lifecycle');
    }) || this.context.startsNoRuns()) return;
    const admissionWait = this.context.slotAdmissionReason(t);
    if (admissionWait) { this.context.waiting(t, admissionWait, 'capacity'); return; }
    if(role==='revision'){ if(await this.context.responsibleJointQuestion(t)) return; }
    if(role==='revision'){
      // One refusal text for a durable worker exclusion: shared/task-view.ts owns
      // it, the reservation reads the same rule inside its transaction.
      const exclusion=workerExclusionRefusal(t,t.agentId,t.profile?.id);
      if(exclusion){
        if(!t.failoverReason)this.context.store.update(t.id,{failoverReason:exclusion},'excluded_worker_revision_refused',exclusion);
        return;
      }
    }
    return await this.source.prepareLaunchSource(t, role, options);
  }
  /**
   * Task 405: one owner-activated author-side proof execution. It reuses the
   * ordinary dispatch funnel (forge identity, source proof, profile selection,
   * slot admission, lease, agent creation) and refuses when no executor was
   * actually reserved, so a capacity or profile wait never silently strands an
   * activation that already recorded the allowance.
   */
  async proofExecution(t: Task, activation: ProofActivation, profile?: Profile): Promise<Task> {
    const current = this.context.store.task(t.id);
    // Spec 064 P5: the attempt's cumulative clock is established here — before the
    // dispatch funnel and therefore before the reservation this funnel persists —
    // and a retry continues the earliest origin it can read, never a new one. The
    // clock is a tick and a minted id: establishing it causes no effect.
    const qualification = current.proofExecution?.qualification === true;
    const choice = qualification ? this.firstEffectClockFor(t.id) : null;
    const clock = choice?.clock ?? null;
    // A mandatory effect ordered before the origin is not this attempt's evidence;
    // the reservation this call would persist is the first one, so the route
    // refuses before it if the recorded origin is not already behind us.
    if (clock) {
      const clockRefusal = firstEffectClockRefusal(clock, [{ name: "reservation persistence", tick: Date.now() }]);
      if (clockRefusal) refuseProof('not_authorized', clockRefusal);
    }
    // Spec 064 P5/P6: real qualification proof mode refuses before any effect
    // unless every external input is present and qualified. No supplier exists
    // today, so this names each missing input instead of saying "unavailable".
    // Every dispatch path reaches this owner, so an opted-in declaration can never
    // be read as a running proof.
    const qualificationRefusal = qualificationModeRefusal(current, activation.readiness ?? null);
    if (qualificationRefusal) refuseProof('not_authorized', qualificationRefusal);
    // Task 560: single-flight before the funnel. The reservation transaction
    // below re-checks authoritatively; this fast refusal keeps a second
    // trigger from ever reaching the adapter call.
    const head = current.proofOnly?.commit ?? current.prHead;
    if (head) {
      const refusal = proofSingleFlightRefusal(current, this.context.store.runs(t.id), head);
      if (refusal) throw new ProofSingleFlightError(refusal);
    }
    await this.context.launch(t, 'executor', {
      proof: { ...activation, ...(clock ? { firstEffectClock: clock } : {}) },
      ...(profile ? { profile } : {}),
    });
    const after = this.context.store.task(t.id);
    const run = after.resolution.currentRunId ? this.context.store.run(after.resolution.currentRunId) : null;
    if (!run || run.role !== 'executor') throw new Error(`Proof execution was not dispatched: ${after.reason}`);
    return after;
  }
}
