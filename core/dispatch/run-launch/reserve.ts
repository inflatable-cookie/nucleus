import type { LaunchReserveContext } from '../launch';
import type { LaunchMachinePorts } from './machine';
import type { Profile, Run, Task } from '../../../shared/contracts';
import { assertReviewEntryWriterYielded, reviewEntryInputForTask, ReviewEntryRefusal, type ReviewEntryAdapter } from '../../review/review-entry';
import { ordinaryReviewSource } from '../../review/ordinary-review';
import type { Adapter } from '../../host/adapter';
import type { ProofActivation } from '../../resolution';
import { RunReservationAdmission } from './reservation-admission';
import { RunReservationSource, type ReservationSelection, type ReservationSourceInput } from './reservation-source';
import { runIntent } from './run-intent';
import { bbWorktreeLinksWait } from '../../workspaces/worktree-links';

/**
 * Reserve the run a launch will deliver: read the source facts, build the run
 * intent, prove the review-entry handover, then admit the intent, its
 * credential, the task update and the slot charge in one transaction before
 * handing off to delivery. The owners are built per reservation from the live
 * adapter, so a replaced adapter and a shared instance both read this launch's
 * machine.
 */
export class RunLaunchReserve {
  constructor(readonly resolution: LaunchReserveContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get machine(): LaunchMachinePorts { return this.adapter; }
  async reserveLaunchRun(t: Task, role: Run['role'], options: { profile?: Profile; instruction?: string; proof?: ProofActivation },
    source: ReservationSourceInput, selection: ReservationSelection): Promise<void> {
    if (role === 'reviewer') {
      const wait = await bbWorktreeLinksWait(t);
      if (wait) { this.resolution.waiting(this.store.task(t.id), wait, 'lifecycle'); return; }
    }
    const reservationSource = new RunReservationSource(this.resolution);
    const facts = await reservationSource.read({ task: t, role, options, source, selection });
    const run = runIntent({ task: t, role, resolution: this.resolution, source: facts });
    // Spec 017 handover: every review-entry reviewer send runs in the task
    // workspace. The task lease knows only Queue runs and task agents, so writer
    // yield is re-proved here, then the exact branch/head/clean-tree proof
    // (async). The reservation transaction re-checks identity.
    if (facts.handoverReview) {
      try { await assertReviewEntryWriterYielded(reviewEntryInputForTask(t), this.adapter as Adapter & ReviewEntryAdapter, t.id); }
      catch (error) {
        if (error instanceof ReviewEntryRefusal && error.transient) { this.resolution.waiting(t, error.message, 'origin_busy'); return; }
        throw error;
      }
      await ordinaryReviewSource(this.store.task(t.id), run.head, false);
    }
    if (source.continuedPr?.progressRunId) {
      const wait = await this.resolution.continuedProgressWait(t, source.continuedPr.head);
      if (wait) { this.resolution.waiting(this.store.task(t.id), wait, 'lifecycle'); return; }
    }
    // The checks above awaited the adapter. Two wakes can both pass them, so the
    // admission re-checks inside the transaction that records the run.
    const settlement = new RunReservationAdmission(this.resolution).admit({ task: t, role, run, options, source: facts, selection, handoverReview: facts.handoverReview });
    if (!settlement.reserved) return;
    t = settlement.task;
    this.resolution.launchingRuns.add(run.id);
    try {
      if (source.continuedPr) t = this.store.task(t.id);
      this.resolution.advanceAttempt.getStore()?.add(run.id);
      if (selection.coordinatorRouteSwitch) {
        t = this.store.task(t.id);
        this.store.event(t.id, 'coordinator_route_applied', selection.coordinatorRouteSwitch.startsWith('sign-off:')
          ? `The bound coordinator profile ${selection.coordinatorRouteSwitch.slice('sign-off:'.length)} awaits the operator's board sign-off; ${selection.profile?.id ?? 'a profile within the usage level'} serves at generation ${run.generation}`
          : `Owner-routed coordinator profile ${selection.coordinatorRouteSwitch} supersedes the recorded coordinator binding at generation ${run.generation}`);
      }
      if (settlement.settled.length) this.machine.purgeReportingFiles?.(t.id, settlement.settled);
      return await this.resolution.deliverLaunchRun(t, role, {
        agentId: selection.agentId, profile: selection.profile, group: selection.group, workspaceId: selection.workspaceId,
        firstReviewEntryWorker: source.firstReviewEntryWorker, nonDeliveryReplacement: facts.nonDeliveryReplacement, run, token: facts.token,
      });
    } finally { this.resolution.launchingRuns.delete(run.id); }
  }
}
