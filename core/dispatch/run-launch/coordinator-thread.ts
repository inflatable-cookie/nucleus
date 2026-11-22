import { climbedTier, requestedTier } from "../../../shared/demand";
import type { LaunchThreadContext } from '../launch';
import type { Run, Task } from '../../../shared/contracts';
import { supersedingRouteProfile } from '../../../shared/pool';
import { coordinative } from '../../recovery/task-reasons';
import type { LaunchOptions, ThreadBinding } from './thread-binding';

/** The binding a coordinator launches on, with the route switch that must clear the old one. */
export type CoordinatorThread = { binding: ThreadBinding; routeSwitch: string | null };

/**
 * Spec 050: an owner `route` recorded while a coordinator run was live
 * (non-`now`) takes effect on the next coordinator run. The sticky
 * `coordinatorAgentId` binding would otherwise reuse the old agent and its
 * profile, silently ignoring the recorded route. When the marked route names a
 * different profile than the bound agent's last profile, drop the binding so
 * selection reads the route; the reservation clears it in the store so the new
 * agent is recorded. Other coordinator requests keep the sticky binding, and a
 * route naming the bound profile changes nothing. Spec 052 refuses a bound
 * coordinator whose profile is now request-only for the same reason.
 * A coordinator is never the author or the reviewer: that separation is a
 * programming error, not a wait.
 */
export function applyCoordinatorThread(ctx: LaunchThreadContext, t: Task, role: Run['role'],
  options: LaunchOptions, binding: ThreadBinding): CoordinatorThread {
  if (!coordinative({ role } as Run)) return { binding, routeSwitch: null };
  let { agentId, profile, group } = binding;
  let routeSwitch: string | null = null;
  if (!options.profile) {
    const request = t.profileRequests?.coordinator;
    const boundProfile = agentId ? ctx.store.runs(t.id).findLast(run => run.agentId === agentId && run.profile)?.profile ?? null : null;
    // Task 515: the recorded route wins over the sticky binding, whether it
    // is an owner `route` or a superseding profile request.
    const recordedRoute = request?.ownerRoute === true ? request.profileId
      : supersedingRouteProfile(request, boundProfile?.id, ctx.store.pool(), ctx.store.usageLevel(), requestedTier(t.complexity), climbedTier(t));
    if (recordedRoute && agentId && (!boundProfile || boundProfile.id !== recordedRoute)) {
      routeSwitch = recordedRoute;
      agentId = null; profile = null; group = null;
    } else if (agentId && ctx.retainedRouteIssue(t, boundProfile, 'coordinator')) {
      routeSwitch = `request-only:${boundProfile!.id}`;
      agentId = null; profile = null; group = null;
    }
  }
  if (agentId && [t.agentId, t.resolution.reviewerAgentId].includes(agentId)) throw new Error('Coordinator must be separate from author and reviewer');
  return { binding: { ...binding, agentId, profile, group }, routeSwitch };
}
