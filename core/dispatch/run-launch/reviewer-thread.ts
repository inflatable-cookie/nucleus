import type { LaunchThreadContext } from '../launch';
import type { Run, Task } from '../../../shared/contracts';
import { authorModelKey, taskAuthorModelKeys } from '../../../shared/authors';
import { supersedingRouteProfile } from '../../../shared/pool';
import { matchingInactiveParticipant } from '../../intake/run-settlement';
import { message } from '../../recovery/task-reasons';
import { reviewerRuntimeChanged } from '../../review/reviewer-runtime';
import { reviewerIndependence } from '../routing';
import { type LaunchOptions, type ThreadBinding } from './thread-binding';
import { reviewerRoundEligible, reviewerThreadDecision, type ReviewerSwapCondition } from './thread-decisions';

/** The reviewer thread a launch continues, or the stop it already recorded. */
export type ReviewerThreadResult =
  | { kind: 'binding'; binding: ThreadBinding; replacingReviewer: boolean }
  | { kind: 'handled' };

/**
 * Spec 036 / Task 515 / Spec 052: which reviewer thread reviews this head. The
 * recorded reviewer that authored task work, a retained profile that can no
 * longer certify, a required route that supersedes the binding, or a round that
 * cannot continue all drop the thread for a fresh independent agent; an
 * unavailable or exhausted route is a visible wait or the replacement ceiling
 * instead of a launch that certifies its own work.
 */
export async function retainReviewerThread(ctx: LaunchThreadContext, t: Task, role: Run['role'],
  options: LaunchOptions, binding: ThreadBinding): Promise<ReviewerThreadResult> {
  if (role !== 'reviewer') return { kind: 'binding', binding, replacingReviewer: false };
  let { agentId, profile, group } = binding;
  let replacingReviewer = false;
  // Task 515: the same general rule as the worker and coordinator yields
  // here too: a required honoured reviewer route supersedes the retained
  // selection, so the next reviewer run is selected instead of reusing a
  // stale binding or profile. signoffIssue keeps covering the bound profile
  // that now needs sign-off and the approved route it already names.
  const supersedingReviewer = !options.profile
    ? supersedingRouteProfile(t.profileRequests?.reviewer, profile?.id, ctx.store.pool(), ctx.store.usageLevel())
    : null;
  if (agentId) {
    // Spec 036: a recorded reviewer that authored a run on the task (worker, revision or checkpoint turn,
    // or the current worker itself) can never certify its own changes: drop
    // the binding and launch a fresh agent on the retained profile. The same
    // agent never reviews through a stale binding; the profile stays, so an
    // explicitly reassigned reviewer keeps its operator-chosen route — unless
    // a newer required route supersedes it, which the next run then honours.
    if (ctx.authorAgentIds(t).has(agentId)) {
      const reselected = supersedingReviewer ? ctx.select(t, 'reviewer') : null;
      const authorDecision = reviewerThreadDecision({ stage: 'author', authored: true, superseding: Boolean(supersedingReviewer), reselected: Boolean(reselected) });
      if (authorDecision === 'reselect') { profile = reselected!.profile; group = reselected!.entry.group; }
      // A superseded route that is temporarily unselectable leaves no stale
      // profile behind: the next selection below waits visibly instead of
      // launching a fresh agent on it, and a later run honours the route.
      else if (authorDecision === 'fresh' && supersedingReviewer) { profile = null; group = null; }
      ctx.store.event(t.id, 'reviewer_fresh_agent', JSON.stringify({ fromAgentId: agentId, condition: 'participant',
        detail: `the recorded reviewer authored task work, so it cannot review its own changes; launching a fresh independent agent on ${profile?.name ?? profile?.id ?? 'the retained reviewer profile'}`,
        head: t.prHead ?? null, at: new Date().toISOString() }));
      agentId = null;
    } else {
      const issue = ctx.retainedProfileIssue(profile) ?? ctx.signoffIssue(t, profile, 'reviewer')
        ?? (supersedingReviewer ? `a required reviewer route names ${supersedingReviewer}, superseding the retained reviewer` : null);
      if (issue) {
        if (reviewerThreadDecision({ stage: 'issue', issue: true, atLimit: t.resolution.roleReplacements >= 8, selected: false }) === 'attention') {
          ctx.attention(t, 'Role replacement limit reached; operator attention required');
          return { kind: 'handled' };
        }
        const selection = ctx.select(t, 'reviewer');
        if (reviewerThreadDecision({ stage: 'issue', issue: true, atLimit: false, selected: Boolean(selection) }) === 'wait') {
          ctx.waiting(t, `Retained reviewer is unavailable (${issue}); no eligible independent reviewer profile${ctx.requiredRouteNote(t, 'reviewer') || ctx.usageCeilingNote(t, 'reviewer')}`, 'route_unavailable');
          return { kind: 'handled' };
        }
        agentId = null; profile = selection!.profile; group = selection!.entry.group; replacingReviewer = true;
      }
    }
  }
  if (agentId) {
    const prior = ctx.store.runs(t.id).findLast(run => run.role === 'reviewer' && run.agentId === agentId);
    // A settled verdict advances to a new head; an explicitly stopped reader
    // may also restart on the same head without inventing a completed verdict.
    let round = reviewerRoundEligible(prior, t.prHead);
    let participant = true;
    let runtime = true;
    let context = true;
    const swapDetail: Partial<Record<ReviewerSwapCondition, string>> = {};
    if (!round) swapDetail.round = `its prior reviewer round at ${prior?.head ?? 'no head'} is not settled for another round at ${t.prHead ?? 'no head'}`;
    try {
      const consultBound = !prior && ctx.store.eventsAll(t.id).some(event => event.kind === 'reviewer_consult_reviewer' && event.detail.endsWith(`: ${agentId}`));
      const state = await ctx.host.observe(agentId);
      if (consultBound && profile) {
        // A consult-bound reviewer is judged by independence and its inactive
        // participant state, not by a prior review round it never ran.
        round = true;
        const authors = taskAuthorModelKeys(t, ctx.store.runs(t.id).filter(run => run.role === 'revision'));
        const independent = reviewerIndependence({ site: 'consult', authors, reviewerModel: authorModelKey(profile.model) }) === 'independent';
        const inactive = state.workspaceId === t.workspaceId && state.status === 'idle' && !state.active && !state.permissions;
        participant = independent && inactive;
        if (!independent) swapDetail.participant = 'its model is not independent of the task authors';
        else if (!inactive) swapDetail.participant = `it is not an inactive participant in ${t.workspaceId ?? 'the task workspace'} (observed ${state.status}${state.active ? ', active' : ''}${state.permissions ? ', permission pending' : ''})`;
      } else {
        ctx.assertReviewProfileIndependent(t, prior!);
        participant = matchingInactiveParticipant(prior!, state, ['idle']);
        if (!participant) swapDetail.participant = `it is not an inactive participant in its recorded workspace (observed ${state.status}${state.active ? ', active' : ''}${state.activeTurnId ? `, turn ${state.activeTurnId}` : ''}${state.permissions === false ? '' : ', permission pending'})`;
      }
      runtime = !reviewerRuntimeChanged(profile!, state);
      if (!runtime) swapDetail.runtime = `the observed runtime (${state.provider ?? 'unknown provider'}/${state.model ?? 'unknown model'}) differs from the pinned profile ${profile?.provider ?? 'unknown'}/${profile?.model ?? 'unknown'}`;
      context = !/context_length_exceeded|maximum context length|context window (?:is )?exhausted/i.test(state.error ?? '');
      if (!context) swapDetail.context = `its provider reported context exhaustion: ${state.error}`;
    } catch (error) {
      participant = false;
      delete swapDetail.participant;
      swapDetail.error = message(error);
      ctx.store.event(t.id, 'reviewer_retention_refused', message(error));
    }
    const eligible = round && participant && runtime && context && !swapDetail.error;
    if (reviewerThreadDecision({ stage: 'round', eligible }) === 'fresh') {
      const swap = !round && swapDetail.round ? { condition: 'round' as const, detail: swapDetail.round }
        : swapDetail.participant ? { condition: 'participant' as const, detail: swapDetail.participant }
          : !runtime && swapDetail.runtime ? { condition: 'runtime' as const, detail: swapDetail.runtime }
            : !context && swapDetail.context ? { condition: 'context' as const, detail: swapDetail.context }
              : swapDetail.error ? { condition: 'error' as const, detail: swapDetail.error }
                : { condition: 'round' as const, detail: 'the retained reviewer is not eligible for another round' };
      // Papercut 8fffbf59: the swap names the condition that failed, in its
      // event and in `next`, so the project can judge the new reviewer.
      ctx.store.event(t.id, 'reviewer_fresh_agent', JSON.stringify({ fromAgentId: agentId, condition: swap.condition, detail: swap.detail, head: t.prHead ?? null, at: new Date().toISOString() }));
      agentId = null;
    }
  }
  if (!agentId && profile && reviewerThreadDecision({
    stage: 'unbound_profile',
    drop: Boolean(ctx.retainedProfileIssue(profile) || (!options.profile && ctx.signoffIssue(t, profile, 'reviewer'))
      || (!options.profile && supersedingReviewer && profile.id !== supersedingReviewer)),
  }) === 'fresh') profile = null;
  return { kind: 'binding', binding: { ...binding, agentId, profile, group }, replacingReviewer };
}
