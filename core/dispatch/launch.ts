import type { Profile, Run, Task } from '../../shared/contracts';
import { isDispositionActive, workerExclusionFor } from '../../shared/contracts';
import { budgetPauseDetail, taskBudget } from '../../shared/task-budget';
import { proofExecutor } from '../recovery/task-reasons';
import { dispatchBlocked, DISPATCH_HELD_REASON } from './capacity';
import { proofSingleFlightRefusal } from '../qa/proof-execution';
import { reviewAuthorizationRequired, reviewContinuationWait } from '../review/review-continuation';
import type { ProofActivation, Resolution } from '../resolution';
import { RunLaunchSource } from './run-launch/source';
import { RunLaunchThread } from './run-launch/thread';
import { RunLaunchReserve } from './run-launch/reserve';
import { RunLaunchDeliver } from './run-launch/deliver';

export type LaunchSourceContext = Pick<Resolution, 'adapter' | 'bindReportedHeadForReview' | 'continuedPrBinding' | 'continuedProgressWait' | 'ordinaryRoundCustody' | 'paused' | 'profiles' | 'retainedWorkerProfileIssue' | 'selectLaunchThread' | 'store' | 'update' | 'usageCeilingNote' | 'waiting' | 'workerContinuation'>;
export type LaunchThreadContext = Pick<Resolution, 'adapter' | 'assertReviewProfileIndependent' | 'attention' | 'authorAgentIds' | 'host' | 'openPlannerEscalation' | 'orphanRuns' | 'paused' | 'profiles' | 'requiredRouteNote' | 'reserveLaunchRun' | 'retainedProfileIssue' | 'select' | 'signoffIssue' | 'store' | 'update' | 'usageCeilingNote' | 'waiting'>;
export type LaunchReserveContext = Pick<Resolution, 'adapter' | 'advanceAttempt' | 'bindContinuedPrInTx' | 'continuedProgressWait' | 'deliverLaunchRun' | 'launchingRuns' | 'ordinaryReviewRuns' | 'paused' | 'progressEffectsPending' | 'recordCriticalReviewFallback' | 'retryContext' | 'reviewerSetting' | 'slotAdmissionReason' | 'store' | 'supersedeOrphans' | 'update' | 'waiting'>;
export type LaunchDeliverContext = Pick<Resolution, 'adapter' | 'assertReviewProfileIndependent' | 'ensureIncident' | 'ordinaryReviewRuns' | 'ordinaryRoundCustody' | 'paused' | 'store' | 'update' | 'waiting'>;
export type DispatchLaunchContext = Pick<Resolution, 'catalogKnown' | 'claimIntegrationTurn' | 'launch' | 'lease' | 'leaseDeclineText' | 'paused' | 'responsibleJointQuestion' | 'slotAdmissionReason' | 'startsNoRuns' | 'store' | 'waiting'>
  & { pauseForPrerequisiteWait(task: Task): boolean } & LaunchSourceContext & LaunchThreadContext & LaunchReserveContext & LaunchDeliverContext;

/** Dispatch sequencing with live adapter and shell delegates supplied at composition. */
export class DispatchLaunch {
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
      const budget = taskBudget(current, this.context.store.runs(t.id), Date.now(), events);
      if (budget.exhausted) { this.context.waiting(t, budgetPauseDetail(budget), 'budget'); return; }
    }
    if (reviewAuthorizationRequired(this.context.store.task(t.id), this.context.store)) { const wait = reviewContinuationWait(this.context.store.task(t.id), this.context.store); this.context.waiting(t, wait.reason, wait.stop); return; }
    if (isDispositionActive(t)) throw new Error("Disposition fence is active; no replacement runs are launched");
    if ((role === 'reviewer' || role === 'revision' || proofExecutor(role)) && dispatchBlocked(t)) { this.context.waiting(t, DISPATCH_HELD_REASON, 'held'); return; }
    if ((role === 'reviewer' || role === 'revision' || proofExecutor(role)) && this.context.pauseForPrerequisiteWait(t)) return;
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
      const exclusion=workerExclusionFor(t,t.agentId,t.profile?.id);
      if(exclusion){
        const identity=exclusion.agentId?`agent ${exclusion.agentId}`:`profile ${exclusion.profileId}`;
        const reason=`Planner/operator exclusion prevents another turn for ${identity}: ${exclusion.reason}`;
        if(!t.failoverReason)this.context.store.update(t.id,{failoverReason:reason},'excluded_worker_revision_refused',reason);
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
    // Task 560: single-flight before the funnel. The reservation transaction
    // below re-checks authoritatively; this fast refusal keeps a second
    // trigger from ever reaching the adapter call.
    const current = this.context.store.task(t.id);
    const head = current.proofOnly?.commit ?? current.prHead;
    if (head) {
      const refusal = proofSingleFlightRefusal(current, this.context.store.runs(t.id), head);
      if (refusal) throw new Error(refusal);
    }
    await this.context.launch(t, 'executor', { proof: activation, ...(profile ? { profile } : {}) });
    const after = this.context.store.task(t.id);
    const run = after.resolution.currentRunId ? this.context.store.run(after.resolution.currentRunId) : null;
    if (!run || run.role !== 'executor') throw new Error(`Proof execution was not dispatched: ${after.reason}`);
    return after;
  }
}
