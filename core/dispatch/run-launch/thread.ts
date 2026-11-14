import type { LaunchThreadContext } from '../launch';
import { proofExecutor } from '../../recovery/task-reasons';
import { coordinative } from '../../recovery/task-reasons';
import { observeAssignedThread } from './assigned-thread';
import { applyCoordinatorThread } from './coordinator-thread';
import { reconcileExecutorThread } from './executor-thread';
import { resolveNonDeliveryRoute } from './non-delivery-route';
import { retainReviewerThread } from './reviewer-thread';
import { retainedThreadBinding, type LaunchOptions, type LaunchSourceFacts, type ThreadBinding } from './thread-binding';
import { reviewerThreadDecision } from './thread-decisions';
import type { Run, Task } from '../../../shared/contracts';

/**
 * Select the thread a run is launched on: the retained agent when it is still
 * eligible, or a fresh one from the pool, then hand the selection to reserve.
 * Each role's rule lives in its own module; this stage only orders them and
 * keeps the binding they hand back, so no two rules can disagree about the
 * same launch.
 */
export class RunLaunchThread {
  constructor(readonly resolution: LaunchThreadContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  async selectLaunchThread(t: Task, role: Run['role'], options: LaunchOptions, source: LaunchSourceFacts): Promise<void> {
    const ctx = this.resolution;
    let binding: ThreadBinding = retainedThreadBinding(ctx, t, role, options, source);
    const alternate = await resolveNonDeliveryRoute(ctx, t, role);
    if (alternate.kind === 'handled') return;
    if (alternate.kind === 'alternate') binding = { ...binding, agentId: null, profile: alternate.profile, group: alternate.group };
    binding = await reconcileExecutorThread(ctx, t, role, options, binding);
    const coordinator = applyCoordinatorThread(ctx, t, role, options, binding);
    binding = coordinator.binding;
    const reviewer = await retainReviewerThread(ctx, t, role, options, binding);
    if (reviewer.kind === 'handled') return;
    binding = reviewer.binding;
    let { agentId, profile, group } = binding;
    if (!agentId) {
      // Every fresh critical reviewer re-judges the current worker's rating.
      if (role === 'reviewer' && reviewerThreadDecision({ stage: 'critical_fresh', critical: Boolean(t.critical), explicitProfile: Boolean(options.profile) }) === 'fresh') profile = null;
      if (!profile) {
        const selection = ctx.select(t, role === 'reviewer' ? 'reviewer' : proofExecutor(role) ? 'executor' : 'coordinator');
        if ((role === 'reviewer' ? reviewerThreadDecision({ stage: 'select', hasProfile: false, selected: Boolean(selection) }) : selection ? 'reselect' : 'wait') === 'wait') {
          ctx.waiting(t, `No eligible ${role === 'reviewer' ? 'independent reviewer' : proofExecutor(role) ? 'proof executor' : 'coordinator'} profile; check the profile pool${proofExecutor(role) ? ctx.usageCeilingNote(t, 'worker') : ctx.requiredRouteNote(t, role as 'reviewer' | 'coordinator') || ctx.usageCeilingNote(t, role as 'reviewer' | 'coordinator')}`, 'route_unavailable');
          return;
        }
        profile = selection!.profile; group = selection!.entry.group;
      }
    }
    let workspaceId = coordinative({ role } as Run) ? t.resolution.coordinatorWorkspaceId ?? t.workspaceId! : t.workspaceId!;
    const orphanRuns = (id: string) => ctx.orphanRuns(t.id, id);
    const threadBusy = (id: string) => {
      const orphans = new Set(orphanRuns(id).map(run => run.id));
      return this.store.unreleasedRunsForAgent(id, t.hostId).some(run => !orphans.has(run.id));
    };
    if (agentId) {
      const assigned = await observeAssignedThread(ctx, t, role, agentId, workspaceId, threadBusy);
      if (assigned.kind === 'handled') return;
      workspaceId = assigned.workspaceId;
      if (assigned.kind === 'dropped') agentId = null;
    }
    if (ctx.paused() || this.store.task(t.id).coordinatorGeneration !== t.coordinatorGeneration) return;
    return await ctx.reserveLaunchRun(t, role, options, source, {
      agentId, profile, group, workspaceId, coordinatorRouteSwitch: coordinator.routeSwitch,
      replacingReviewer: reviewer.replacingReviewer, orphanRuns, threadBusy,
    });
  }
}
