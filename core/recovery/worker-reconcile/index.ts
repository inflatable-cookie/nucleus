import { missingReportBindingCompletion } from '../../intake/reporting-failure';
import type { Task } from '../../../shared/contracts';
import { pausedStopWaitReason } from '../../../shared/contracts';
import { dispatchBlocked } from '../../dispatch/capacity';
import { wireLabel } from '../../../shared/wire-labels';
import { reportingIdentityMismatch } from '../../intake/reporting-identity';
import { clearLiveEvidence, liveEvidenceEpisode } from '../../machine/live-evidence';
import { latestRunCompletion, now } from '../../store/store';
import type { Adapter } from '../../host/adapter';
import { branchPrLookupDue, reconcileBranchPr } from './branch-pr';
import { continuationOwnsReturn, reconcileBlockedReturn } from './blocked-return';
import type { WorkerReconcileContext } from './context';
import { STOPPED_WORKER_STATUSES, completionReportsPr } from './decisions';
import { observeOnly, reconcileObservation, recordObservation } from './observation-gates';
import { reconcileReportingBinding, reportingBindingRecheckDue } from './reporting-binding';
import { acceptWorkerResult } from './result-acceptance';

/**
 * The initial worker's reconcile pass. This module composes it: observe the
 * worker and settle a live one (`observation-gates.ts`), look for its branch PR
 * (`branch-pr.ts`), repair a split reporting binding (`reporting-binding.ts`),
 * take a blocked return (`blocked-return.ts`), then accept its recorded result
 * (`result-acceptance.ts`). The pure decisions are in `decisions.ts`.
 */
export { branchPrLookupOutcome, blockedReturnDecision, classifyWorkerObservation, completionReportsPr, INTERACTIVE_RUNNING_REASON, INTERACTIVE_WAIT_REASON, STOPPED_WORKER_STATUSES } from './decisions';
export type { WorkerReconcileContext } from './context';

type Observation = Awaited<ReturnType<Adapter['observe']>>;

/** The completion-delivery grace, and whether it was already running when this pass began. */
type IdleGrace = { current: Task; firstIdleObservation: boolean; graceElapsed: boolean };

export class WorkerReconcile {
  constructor(readonly engine: WorkerReconcileContext) {}

  /**
   * Task 676 / #575: a same-thread push-back recorded for this return owns it. A pass that
   * was stalled on a read or the blocked hook when the push-back was written must not
   * overwrite changes_requested with blocked/error and start recovery.
   */
  continuationOwnsReturn(taskId: string): boolean { return continuationOwnsReturn(this.engine, taskId); }

  /**
   * The pass itself: observation, the pre-recovery gates, then the one outcome
   * this stopped worker has. `store`, `adapter` and `resolution` read the engine
   * per call: tests replace the adapter.
   */
  async reconcile(task: Task): Promise<void> {
    const observed = await this.reconcileObservation(task);
    if (!observed) return;
    const { state } = observed;
    if (!STOPPED_WORKER_STATUSES.includes(state.status)) throw new Error("Worker status is unknown; not releasing its workspace");
    const grace = this.beginIdleGrace(observed.current, state);
    if (grace.current.runId && state.id === grace.current.agentId && !grace.current.completion && !grace.current.pausedStop && grace.graceElapsed) {
      const failure = missingReportBindingCompletion(this.engine.adapter.helperPath,
        { taskId: task.id, runId: grace.current.runId }, state);
      if (failure) {
        const failed = this.engine.store.update(task.id, { completion: failure }, 'report_failed', failure.summary);
        await this.acceptWorkerResult(task, failed);
        return;
      }
    }
    const current = await this.preBranchGates(task, state, grace.graceElapsed);
    if (!current) return;
    if (this.reconcileBlockedReturn(task, current, state)) return;
    if (current.completion) {
      await this.acceptWorkerResult(task, current);
      return;
    }
    if (state.status === "closed" && !state.error) {
      // A cleanly closed retained session is resumable in Paseo. Give it the
      // same one-shot authenticated reporting reminder as an idle worker before
      // spending a coordinator run.
      await this.engine.resolution.remindStoppedWorker(current);
      return;
    }
    if (current.pausedStop) {
      // Queue #650: the operator stopped this thread while paused; even an error
      // observation is not a failure yet — the unpause resume owns delivery, and
      // a resume that cannot land arms the ordinary replacement with its reason.
      this.engine.resolution.waiting(current, pausedStopWaitReason("worker"), "paused_stop");
      return;
    }
    if (state.status === "error" || state.status === "closed") {
      this.engine.note(task.id, state.error || `Worker ${state.status} without a completion callback`, 'classify', "needs_attention");
      return;
    }
    if (!grace.firstIdleObservation && current.idleSince && Date.now() - Date.parse(current.idleSince) >= this.engine.idleGraceMs) {
      await this.engine.resolution.remindStoppedWorker(current);
    }
  }

  /**
   * The first idle observation starts the completion-delivery grace. The grace
   * starts here rather than after the pre-recovery gates: the split-binding path
   * returns before the later stamp, so a lane that can never deliver a report
   * would keep `idleSince` unset and hold its own branch-PR reconciliation shut
   * forever. The first observation still consumes the same pass before any
   * reminder, so only the gate moves.
   */
  private beginIdleGrace(initial: Task, state: Observation): IdleGrace {
    const firstIdleObservation = state.status === "idle" && !initial.idleSince;
    const graceElapsed = Boolean(initial.idleSince && Date.now() - Date.parse(initial.idleSince) >= this.engine.idleGraceMs);
    if (!firstIdleObservation) return { current: initial, firstIdleObservation, graceElapsed };
    const reason = (latestRunCompletion(this.engine.store.runs(initial.id)) ?? initial.completion)?.summary ?? "Worker idle; allowing time for completion delivery";
    // Spec 050: a dispatch fence is the task's visible cause until its owner
    // releases it, so the first idle observation starts the completion-delivery
    // grace without replacing the stop that names the hold. A live worker the
    // owner stopped keeps the held stop the verb recorded in its control
    // quantum; overwriting it with the idle note here left `task.reason` and the
    // board card describing a wait that was no longer true while `next`, task
    // detail and the stored stop still named the hold (Queue #403, the
    // live-stop path found reviewing #641). No run, phase or stop record moves:
    // an unheld worker keeps the ordinary grace note and reminders, and a
    // release still retires the held stop with the last fence.
    const current = this.engine.store.update(initial.id, dispatchBlocked(initial) ? { idleSince: now() } : { idleSince: now(), reason });
    return { current, firstIdleObservation, graceElapsed };
  }

  /**
   * The gates that run before any recovery: the branch-PR live lookup, a held
   * unverified read, the split reporting binding, and a recovery escalation that
   * owns the lane. Null ends the pass; otherwise the task to continue with.
   */
  private async preBranchGates(task: Task, state: Observation, graceElapsed: boolean): Promise<Task | null> {
    const { store } = this.engine;
    let current = store.task(task.id);
    // Read-only identity diagnostic (Contract 003): a stopped initial worker
    // whose retained reporting binding names another run can authenticate
    // nothing. The exact branch-PR reconciliation below runs first because it
    // re-issues the binding through the retained revision path; this reports the
    // remaining split before the lane stalls into an unrecoverable phase.
    const mismatch = reportingIdentityMismatch(current, wireLabel(state.labels, "mcpBinding"));
    const hasPrIdentity = Boolean(completionReportsPr(current) || current.prUrl || current.prHead || current.resumePrNumber);
    // A split binding cannot deliver the callback that would record the PR, and the
    // PR is what re-issues the binding, so this reconciliation is the repair rather
    // than a courtesy. Its grace is unsatisfiable while the split stands, so it must
    // not wait behind one. An identified worker and an elapsed grace keep their
    // existing behaviour: a matched binding still gets its full grace before the
    // queue reaches for a PR the worker may be about to report itself.
    const readyForBranchPrLookup = !hasPrIdentity &&
      (state.status === 'error' || state.status === 'closed' || graceElapsed || Boolean(mismatch));
    if (readyForBranchPrLookup && this.branchPrLookupDue(current) && await this.reconcileBranchPr(current)) return null;
    // While the branch-PR live read is unverified, the lane holds for its
    // retry: a reporting-binding mismatch or an ordinary worker fault must
    // not escalate on a projection the pending read may still repair. A
    // late authenticated completion still advances below, and it supersedes
    // the pending read.
    current = store.task(current.id);
    if (current.completion) clearLiveEvidence(store, current.id, 'branch-pr');
    if (!current.completion && liveEvidenceEpisode(store, current.id, 'branch-pr')) return null;
    if (mismatch) {
      await this.reconcileReportingBinding(current, mismatch);
      return null;
    }
    // An escalated live-evidence outcome owns the lane: routine handling
    // must not overwrite its reason or disturb its single notice. A late
    // authenticated completion still advances below.
    current = store.task(current.id);
    if (!current.completion && current.resolution.recovery?.status === 'escalated'
      && current.reason === current.resolution.recovery.summary) return null;
    return current;
  }

  /** Observe the worker and settle every live state. Null ends the pass; otherwise the worker has stopped. */
  reconcileObservation(task: Task): Promise<{ state: Observation; current: Task } | null> { return reconcileObservation(this.engine, task); }
  /** Look for the queue branch's open PR before coordinator recovery. True ends the pass. */
  reconcileBranchPr(current: Task): Promise<boolean> { return reconcileBranchPr(this.engine, current); }
  /** A split reporting binding: re-read it live once per grace window, then escalate only a confirmed split. */
  reconcileReportingBinding(current: Task, mismatch: NonNullable<ReturnType<typeof reportingIdentityMismatch>>): Promise<void> {
    return reconcileReportingBinding(this.engine, current, mismatch);
  }
  /** A blocked or error receipt: same-thread push-back, or consumed once. True ends the pass; synchronous on purpose. */
  reconcileBlockedReturn(task: Task, current: Task, state: Observation): boolean { return reconcileBlockedReturn(this.engine, task, current, state); }
  /** Take the worker's recorded result: hold a report for its planner, verify a PR report, or record a blocked or error return. */
  acceptWorkerResult(task: Task, current: Task): Promise<void> { return acceptWorkerResult(this.engine, task, current); }
  /** Whether the queue-owned branch reconciliation may run again. */
  branchPrLookupDue(task: Task): boolean { return branchPrLookupDue(this.engine, task); }
  /** Whether the reporting-binding confirmation may run again. */
  reportingBindingRecheckDue(task: Task): boolean { return reportingBindingRecheckDue(this.engine, task); }
  recordObservation(task: Task, state: Observation): void { recordObservation(this.engine, task, state); }
  observeOnly(task: Task): Promise<void> { return observeOnly(this.engine, task); }
}
