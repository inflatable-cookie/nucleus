import type { LaunchThreadContext } from '../launch';
import type { Profile, Run, Task } from '../../../shared/contracts';
import { workerProfileIsExcluded } from '../../../shared/contracts';
import { groupIsUnavailable, requestOnly } from '../../../shared/pool';
import { escalationWaitDetail, plannerEscalations, type LadderEvent } from '../../questions/blocker-ladder';
import { message } from '../../recovery/task-reasons';
import { chooseProfile } from '../routing';
import { digest } from '../../store/store';

/** The alternate-provider attempt for a retained worker that never delivered. */
export type NonDeliveryRoute =
  /** The role is not a non-delivery replacement; the ordinary binding stands. */
  | { kind: 'not_applicable' }
  /** The route already recorded its escalation or wait; the launch stops there. */
  | { kind: 'handled' }
  /** A different provider at the retained capability takes the task on a fresh agent. */
  | { kind: 'alternate'; profile: Profile; group: string | null };

/**
 * Revision replacement for a worker whose delivery failed (non-delivery route):
 * choose a different provider at the retained capability, on a fresh agent, once
 * the retained worker has released its workspace. No eligible alternate records
 * one planner escalation and lets an existing one keep waiting; an unreadable
 * worker state never starts the attempt.
 */
export async function resolveNonDeliveryRoute(ctx: LaunchThreadContext, t: Task, role: Run['role']): Promise<NonDeliveryRoute> {
  if (role !== 'revision' || !t.resolution.nonDeliveryRoutePending) return { kind: 'not_applicable' };
  const old = t.profile;
  const pool = ctx.store.pool();
  const oldEntry = pool.find(entry => entry.profileId === old?.id);
  const profiles = ctx.profiles().filter(candidate => candidate.provider !== old?.provider
    && !workerProfileIsExcluded(t, candidate.id)
    && pool.some(entry => entry.profileId === candidate.id && entry.capability === oldEntry?.capability && entry.cost !== 'very_high'
      && !requestOnly(entry, ctx.store.usageLevel())));
  const routeTask = { ...t, preferredProfileId: '', requirePreferred: false, thinkingOptionId: '',
    profileRequests: { ...t.profileRequests, worker: undefined } };
  const selected = chooseProfile(routeTask, profiles, pool, ctx.store.counts(),
    new Set(ctx.store.availability().filter(groupIsUnavailable).map(value => value.group)),
    'worker', ctx.store.recentCounts(), ctx.store.usageLevel(), ctx.store.demandRoleOffsets(), false);
  if (!selected) {
    const reason = `No eligible alternate provider at the retained ${oldEntry?.capability ?? 'known'} capability for a non-delivery replacement`;
    const cause = digest(`non_delivery_provider_unavailable:${t.id}`);
    const existing = plannerEscalations(ctx.store.eventsAll(t.id) as LadderEvent[]).find(escalation => escalation.cause === cause);
    const current = ctx.store.task(t.id);
    if (current.phase !== 'needs_attention' || !current.resolution.attention)
      ctx.update(current, { currentRunId: null, attention: true }, { phase: 'needs_attention', reason }, 'non_delivery_route_escalated', reason);
    if (!existing) {
      const question = `${reason}. Decide how the retained worker should proceed.`;
      ctx.openPlannerEscalation(ctx.store.task(t.id), { cause, runId: null, question, payload: { cause, runId: null, reason, question } });
    } else {
      ctx.waiting(ctx.store.task(t.id), escalationWaitDetail.planner(existing.id), 'escalated');
    }
    return { kind: 'handled' };
  }
  if (!t.agentId || !t.workspaceId) {
    ctx.waiting(t, 'The retained worker binding is unavailable before alternate-provider routing; the replacement remains pending', 'lifecycle');
    return { kind: 'handled' };
  }
  try {
    const state = await ctx.host.observe(t.agentId);
    if (state.workspaceId !== t.workspaceId || state.active || state.permissions || !['idle', 'closed', 'error'].includes(state.status)) {
      ctx.waiting(t, 'Waiting for the retained worker to release its workspace before the alternate-provider attempt', 'lifecycle');
      return { kind: 'handled' };
    }
  } catch (error) {
    ctx.waiting(t, `Retained worker state is unavailable before alternate-provider routing: ${message(error)}`, 'lifecycle');
    return { kind: 'handled' };
  }
  return { kind: 'alternate', profile: selected.profile, group: selected.entry.group };
}
