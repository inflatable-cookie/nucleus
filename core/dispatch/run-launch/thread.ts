import type { LaunchThreadContext } from '../launch';
import { authorModelKey, taskAuthorModelKeys } from '../../../shared/authors';
import { workerProfileIsExcluded, type Profile, type Run, type Task } from '../../../shared/contracts';
import { dataHome } from '../../../shared/data-home.mjs';
import { requestOnly, groupIsUnavailable, supersedingRouteProfile } from '../../../shared/pool';
import { wireLabel } from '../../../shared/wire-labels';
import { escalationWaitDetail, plannerEscalations, type LadderEvent } from '../../questions/blocker-ladder';
import type { HostObservation } from '../../../shared/host';
import { matchingInactiveParticipant } from '../../intake/run-settlement';
import {
  mcpBindingPathFromHostRecord, mcpBindingPathFromProcessListing, reportBindingReuseDecision,
} from '../../intake/report-binding';
import type { ProofActivation, ContinuedPrBinding } from '../../resolution';
import { reviewerRuntimeChanged } from '../../review/reviewer-runtime';
import { chooseProfile, modelKey, reviewerIndependence } from '../routing';
import { digest } from '../../store/store';
import { active, assignedThreadWaitReason, coordinative, message, proofExecutor } from '../../recovery/task-reasons';
import { decideWorkerReplacement, isWorkerRouteApproved, retainedWorkerFailureCause } from '../../recovery/worker-replacement';
import { unreleasedLaunchFence } from '../../verbs/owner-facts';

/** Keep the retained thread, drop it for a fresh agent, or reselect its profile. */
export type LaunchThreadDecision = 'keep' | 'fresh' | 'reselect' | 'wait' | 'attention' | 'continue';
export type ExecutorThreadFacts =
  | { stage: 'collision'; collided: boolean }
  | { stage: 'replacement'; allowed: boolean; profileMismatch: boolean }
  | { stage: 'unbound' };
/** Task 405/582: a proof executor never resumes another role; consecutive proofs keep one executor thread unless replacement is allowed. */
export function executorThreadDecision(facts: ExecutorThreadFacts): LaunchThreadDecision {
  switch (facts.stage) {
    case 'collision': return facts.collided ? 'fresh' : 'continue';
    case 'replacement':
      if (facts.allowed) return 'fresh';
      return facts.profileMismatch ? 'reselect' : 'keep';
    case 'unbound': return 'fresh';
  }
}

export type ReviewerThreadFacts =
  | { stage: 'author'; authored: boolean; superseding: boolean; reselected: boolean }
  | { stage: 'issue'; issue: boolean; atLimit: boolean; selected: boolean }
  | { stage: 'round'; eligible: boolean }
  | { stage: 'unbound_profile'; drop: boolean }
  | { stage: 'critical_fresh'; critical: boolean; explicitProfile: boolean }
  | { stage: 'select'; hasProfile: boolean; selected: boolean };
/**
 * Whether the retained reviewer launches again, a fresh agent takes the
 * profile, or selection picks another route. Wait and attention stay the
 * caller's visible stops when no independent profile exists.
 */
export function reviewerThreadDecision(facts: ReviewerThreadFacts): LaunchThreadDecision {
  switch (facts.stage) {
    case 'author':
      if (!facts.authored) return 'continue';
      if (facts.reselected) return 'reselect';
      return 'fresh';
    case 'issue':
      if (!facts.issue) return 'continue';
      if (facts.atLimit) return 'attention';
      return facts.selected ? 'reselect' : 'wait';
    case 'round': return facts.eligible ? 'keep' : 'fresh';
    case 'unbound_profile': return facts.drop ? 'fresh' : 'continue';
    case 'critical_fresh': return facts.critical && !facts.explicitProfile ? 'fresh' : 'continue';
    case 'select':
      if (facts.hasProfile) return 'keep';
      return facts.selected ? 'reselect' : 'wait';
  }
}

/** A settled verdict or an explicitly stopped reader on the same head may continue. */
export function reviewerRoundEligible(prior: { released?: boolean; status?: string; completion?: unknown; retainedRounds?: number | null; head?: string } | null | undefined, prHead: string | null | undefined): boolean {
  return Boolean(prior?.released && ((prior.status === 'finished' && prior.completion && (prior.retainedRounds ?? 0) < 3)
    || (prior.status === 'superseded' && !prior.completion && prior.head === prHead)));
}

/**
 * Select the thread a run is launched on: the retained agent when it is still
 * eligible, or a fresh one from the pool, then hand the selection to reserve.
 */
export class RunLaunchThread {
  constructor(readonly resolution: LaunchThreadContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  async selectLaunchThread(t: Task, role: Run['role'], options: { profile?: Profile; instruction?: string; proof?: ProofActivation }, source:{firstReviewEntryWorker:boolean;firstWorkerSelection:ReturnType<typeof chooseProfile>|null;prePrWorkerResume:boolean;retainedPrePrHead:string|null;resumingUnpublished:boolean;continuedPr?:ContinuedPrBinding|null}):Promise<void> {
    const {firstWorkerSelection}=source;
    const priorExecutor = role === 'executor'
      ? this.store.runs(t.id).findLast(run => run.role === 'executor' && run.released && run.agentId) ?? null : null;
    let agentId = role === 'revision' ? t.agentId : role === 'reviewer' ? (options.profile ? null : t.resolution.reviewerAgentId)
      : role === 'executor' ? priorExecutor?.agentId ?? null : t.coordinatorAgentId || null;
    let profile = options.profile ?? firstWorkerSelection?.profile??(role === 'revision' ? t.profile : role === 'reviewer' ? t.resolution.reviewerProfile
      : role === 'executor' ? priorExecutor?.profile ?? null : this.store.runs(t.id).findLast(r=>r.agentId===agentId && r.profile)?.profile ?? null);
    let group: string | null = firstWorkerSelection?.entry.group??(options.profile ? this.store.pool().find(entry=>entry.profileId===options.profile!.id)?.group ?? null
      : role === 'executor' && priorExecutor?.profile ? this.store.pool().find(entry => entry.profileId === priorExecutor.profile!.id)?.group ?? null : null);
    const nonDeliveryReplacement = role === 'revision' && t.resolution.nonDeliveryRoutePending;
    if (nonDeliveryReplacement) {
      const old = t.profile;
      const pool = this.store.pool();
      const oldEntry = pool.find(entry => entry.profileId === old?.id);
      const profiles = this.resolution.profiles().filter(candidate => candidate.provider !== old?.provider
        && !workerProfileIsExcluded(t, candidate.id)
        && pool.some(entry => entry.profileId === candidate.id && entry.capability === oldEntry?.capability && entry.cost !== 'very_high'
          && !requestOnly(entry, this.store.usageLevel())));
      const routeTask = { ...t, preferredProfileId: '', requirePreferred: false, thinkingOptionId: '',
        profileRequests: { ...t.profileRequests, worker: undefined } };
      const selected = chooseProfile(routeTask, profiles, pool, this.store.counts(),
        new Set(this.store.availability().filter(groupIsUnavailable).map(value => value.group)),
        'worker', this.store.recentCounts(), this.store.usageLevel(), this.store.demandRoleOffsets(), false);
      if (!selected) {
        const reason = `No eligible alternate provider at the retained ${oldEntry?.capability ?? 'known'} capability for a non-delivery replacement`;
        const cause = digest(`non_delivery_provider_unavailable:${t.id}`);
        const existing = plannerEscalations(this.store.eventsAll(t.id) as LadderEvent[]).find(escalation => escalation.cause === cause);
        const current = this.store.task(t.id);
        if (current.phase !== 'needs_attention' || !current.resolution.attention)
          this.resolution.update(current, { currentRunId: null, attention: true }, { phase: 'needs_attention', reason }, 'non_delivery_route_escalated', reason);
        if (!existing) {
          const question = `${reason}. Decide how the retained worker should proceed.`;
          this.resolution.openPlannerEscalation(this.store.task(t.id), { cause, runId: null, question, payload: { cause, runId: null, reason, question } });
        } else {
          this.resolution.waiting(this.store.task(t.id), escalationWaitDetail.planner(existing.id), 'escalated');
        }
        return;
      }
      if (!t.agentId || !t.workspaceId) {
        this.resolution.waiting(t, 'The retained worker binding is unavailable before alternate-provider routing; the replacement remains pending', 'lifecycle');
        return;
      }
      try {
        const state = await this.resolution.host.observe(t.agentId);
        if (state.workspaceId !== t.workspaceId || state.active || state.permissions || !['idle', 'closed', 'error'].includes(state.status)) {
          this.resolution.waiting(t, 'Waiting for the retained worker to release its workspace before the alternate-provider attempt', 'lifecycle');
          return;
        }
      } catch (error) {
        this.resolution.waiting(t, `Retained worker state is unavailable before alternate-provider routing: ${message(error)}`, 'lifecycle');
        return;
      }
      agentId = null; profile = selected.profile; group = selected.entry.group;
    }
    // Task 405: a proof executor is always a fresh agent in the task checkout;
    // it never resumes the author, a reviewer or a coordinator. Task 582
    // reconciles that rule with one executor thread per task: consecutive proof
    // heads continue the task's retained executor thread — an agent recorded
    // only by this task's own executor runs, never another role's binding — and
    // every turn stays a fresh, source-immutable assignment for its exact head.
    // The shared worker replacement decision replaces the retained thread for
    // provider failure, an unrecoverable session, or an approved route to a
    // different model. The decision runs here, where the reset used to null the
    // binding unconditionally, so retention and the Task 405 rule cannot
    // disagree about the same launch.
    if (proofExecutor(role)) {
      if (executorThreadDecision({ stage: 'collision', collided: Boolean(agentId && [t.agentId, t.resolution.reviewerAgentId, t.coordinatorAgentId].includes(agentId)) }) === 'fresh') agentId = null;
      if (agentId && priorExecutor) {
        let state: HostObservation | null = null;
        try { state = await this.resolution.host.observe(agentId); } catch { /* an unreadable observation proves nothing */ }
        const currentModel = priorExecutor.profile?.model ?? null;
        let failure = state ? retainedWorkerFailureCause({
          task: { ...t, completion: priorExecutor.completion ?? t.completion },
          observedStatus: state.status,
          observedError: state.error,
          observedWorkspaceId: state.workspaceId,
        }) : null;
        if (state && !failure && t.workspaceId && state.workspaceId !== t.workspaceId)
          failure = { kind: 'session_unrecoverable', detail: 'the retained executor no longer reports the task workspace' };
        if (state && !failure && currentModel && state.model && modelKey(currentModel) !== modelKey(state.model))
          failure = { kind: 'session_unrecoverable', detail: `the retained executor session is running ${state.model}, not ${currentModel}` };
        const replacement = decideWorkerReplacement({
          task: t,
          requestedProfileId: options.profile?.id ?? null,
          requestedModel: profile?.model ?? null,
          currentModel,
          approved: options.profile ? isWorkerRouteApproved(t, options.profile.id, this.store.pool(), this.store.usageLevel()) : false,
          failure,
          explicitOperatorRelay: false,
        });
        const replacementDecision = executorThreadDecision({
          stage: 'replacement',
          allowed: replacement.allowed,
          profileMismatch: Boolean(priorExecutor.profile && profile?.id !== priorExecutor.profile.id),
        });
        if (replacementDecision === 'fresh') agentId = null;
        else if (replacementDecision === 'reselect') {
          // A same-model selection or a route still waiting on sign-off keeps
          // the existing binding and its pinned profile together.
          profile = priorExecutor.profile;
          group = this.store.pool().find(entry => entry.profileId === profile!.id)?.group ?? null;
        }
      }
      if (!agentId && executorThreadDecision({ stage: 'unbound' }) === 'fresh') {
        // A fresh executor pins only an explicitly selected profile; otherwise
        // the selection below chooses one.
        profile = options.profile ?? null;
        group = profile ? this.store.pool().find(entry => entry.profileId === profile!.id)?.group ?? null : null;
      }
    }
    // Spec 050: an owner `route` recorded while a coordinator run was live
    // (non-`now`) takes effect on the next coordinator run. The sticky
    // `coordinatorAgentId` binding would otherwise reuse the old agent and its
    // profile, silently ignoring the recorded route. When the marked route
    // names a different profile than the bound agent's last profile, drop the
    // binding so selection reads the route; the reservation below clears it
    // in the store so the new agent is recorded. Other coordinator requests
    // keep the sticky binding, and a route naming the bound profile changes
    // nothing.
    let coordinatorRouteSwitch: string | null = null;
    if (coordinative({ role } as Run) && !options.profile) {
      const request = t.profileRequests?.coordinator;
      const boundProfile = agentId ? this.store.runs(t.id).findLast(r => r.agentId === agentId && r.profile)?.profile ?? null : null;
      // Task 515: the recorded route wins over the sticky binding, whether it
      // is an owner `route` or a required request the operator approved (the
      // same general rule as the worker yield above).
      const recordedRoute = request?.ownerRoute === true ? request.profileId
        : supersedingRouteProfile(request, boundProfile?.id, this.store.pool(), this.store.usageLevel());
      if (recordedRoute && agentId && (!boundProfile || boundProfile.id !== recordedRoute)) {
        coordinatorRouteSwitch = recordedRoute;
        agentId = null; profile = null; group = null;
      } else if (agentId && this.resolution.signoffIssue(t, boundProfile, 'coordinator')) {
        // Spec 052: a bound coordinator on a profile that now needs sign-off is
        // not reused; the next coordinator run is selected within the level.
        coordinatorRouteSwitch = `sign-off:${boundProfile!.id}`;
        agentId = null; profile = null; group = null;
      }
    }
    let replacingReviewer=false;
    if (coordinative({ role } as Run) && agentId && [t.agentId, t.resolution.reviewerAgentId].includes(agentId)) throw new Error('Coordinator must be separate from author and reviewer');
    // Task 515: the same general rule as the worker and coordinator yields
    // here too: a required honoured reviewer route supersedes the retained
    // selection, so the next reviewer run is selected instead of reusing a
    // stale binding or profile. signoffIssue keeps covering the bound profile
    // that now needs sign-off and the approved route it already names.
    const supersedingReviewer = !options.profile
      ? supersedingRouteProfile(t.profileRequests?.reviewer, profile?.id, this.store.pool(), this.store.usageLevel())
      : null;
    if(role==='reviewer'&&agentId){
      // Spec 036: a recorded reviewer that authored a run on the task (worker, revision or checkpoint turn,
      // or the current worker itself) can never certify its own changes: drop
      // the binding and launch a fresh agent on the retained profile. The same
      // agent never reviews through a stale binding; the profile stays, so an
      // explicitly reassigned reviewer keeps its operator-chosen route — unless
      // a newer required route supersedes it, which the next run then honours.
      if(this.resolution.authorAgentIds(t).has(agentId)){
        const reselected = supersedingReviewer ? this.resolution.select(t,'reviewer') : null;
        const authorDecision = reviewerThreadDecision({ stage: 'author', authored: true, superseding: Boolean(supersedingReviewer), reselected: Boolean(reselected) });
        if(authorDecision === 'reselect'){profile=reselected!.profile;group=reselected!.entry.group;}
        // A superseded route that is temporarily unselectable leaves no stale
        // profile behind: the next selection below waits visibly instead of
        // launching a fresh agent on it, and a later run honours the route.
        else if(authorDecision === 'fresh' && supersedingReviewer){profile=null;group=null;}
        this.store.event(t.id,'reviewer_fresh_agent',`Recorded reviewer ${agentId} authored task work; launching a fresh independent agent on ${profile?.name ?? profile?.id ?? 'the retained reviewer profile'}`);
        agentId=null;
      }else{
      const issue=this.resolution.retainedProfileIssue(profile)??this.resolution.signoffIssue(t,profile,'reviewer')
        ??(supersedingReviewer?`a required reviewer route names ${supersedingReviewer}, superseding the retained reviewer`:null);
      if(issue){
        if(reviewerThreadDecision({ stage: 'issue', issue: true, atLimit: t.resolution.roleReplacements>=8, selected: false }) === 'attention'){this.resolution.attention(t,'Role replacement limit reached; operator attention required');return;}
        const selection=this.resolution.select(t,'reviewer');
        if(reviewerThreadDecision({ stage: 'issue', issue: true, atLimit: false, selected: Boolean(selection) }) === 'wait'){this.resolution.waiting(t,`Retained reviewer is unavailable (${issue}); no eligible independent reviewer profile${this.resolution.requiredRouteNote(t,'reviewer')||this.resolution.usageCeilingNote(t,'reviewer')}`, 'route_unavailable');return;}
        agentId=null;profile=selection!.profile;group=selection!.entry.group;replacingReviewer=true;
      }
      }
    }
    if (role === 'reviewer' && agentId) {
      const prior = this.store.runs(t.id).findLast(run => run.role === 'reviewer' && run.agentId === agentId);
      // A settled verdict advances to a new head; an explicitly stopped reader
      // may also restart on the same head without inventing a completed verdict.
      let eligible = reviewerRoundEligible(prior, t.prHead);
      try {
        const consultBound = !prior && this.store.eventsAll(t.id).some(event => event.kind === 'reviewer_consult_reviewer' && event.detail.endsWith(`: ${agentId}`));
        const state = await this.resolution.host.observe(agentId);
        if (consultBound && profile) {
          const authors = taskAuthorModelKeys(t, this.store.runs(t.id).filter(run => run.role === 'revision'));
          eligible = reviewerIndependence({ site: 'consult', authors, reviewerModel: authorModelKey(profile.model) }) === 'independent'
            && state.workspaceId === t.workspaceId && state.status === 'idle' && !state.active && !state.permissions;
        } else {
          this.resolution.assertReviewProfileIndependent(t, prior!);
          eligible &&= matchingInactiveParticipant(prior!, state, ['idle']);
        }
        eligible &&= !reviewerRuntimeChanged(profile!, state)
          && !/context_length_exceeded|maximum context length|context window (?:is )?exhausted/i.test(state.error);
      } catch (error) { eligible = false; this.store.event(t.id, 'reviewer_retention_refused', message(error)); }
      if (reviewerThreadDecision({ stage: 'round', eligible }) === 'fresh') { this.store.event(t.id, 'reviewer_fresh_agent', `Retained reviewer ${agentId} is not eligible for another round`); agentId = null; }
    }
    if (role === 'reviewer' && !agentId && profile && reviewerThreadDecision({
      stage: 'unbound_profile',
      drop: Boolean(this.resolution.retainedProfileIssue(profile) || (!options.profile && this.resolution.signoffIssue(t, profile, 'reviewer'))
        || (!options.profile && supersedingReviewer && profile.id !== supersedingReviewer)),
    }) === 'fresh') profile = null;
    if (!agentId) {
      // Every fresh critical reviewer re-judges the current worker's rating.
      if (role === 'reviewer' && reviewerThreadDecision({ stage: 'critical_fresh', critical: Boolean(t.critical), explicitProfile: Boolean(options.profile) }) === 'fresh') profile = null;
      if(!profile){
        const selection = this.resolution.select(t, role === 'reviewer' ? 'reviewer' : proofExecutor(role) ? 'executor' : 'coordinator');
        if ((role === 'reviewer' ? reviewerThreadDecision({ stage: 'select', hasProfile: false, selected: Boolean(selection) }) : selection ? 'reselect' : 'wait') === 'wait') { this.resolution.waiting(t, `No eligible ${role === 'reviewer' ? 'independent reviewer' : proofExecutor(role) ? 'proof executor' : 'coordinator'} profile; check the profile pool${proofExecutor(role) ? this.resolution.usageCeilingNote(t, 'worker') : this.resolution.requiredRouteNote(t, role as 'reviewer' | 'coordinator') || this.resolution.usageCeilingNote(t, role as 'reviewer' | 'coordinator')}`, 'route_unavailable'); return; }
        profile = selection!.profile; group = selection!.entry.group;
      }
    }
    let workspaceId = coordinative({role} as Run) ? t.resolution.coordinatorWorkspaceId ?? t.workspaceId! : t.workspaceId!;
    const orphanRuns = (id: string) => this.resolution.orphanRuns(t.id, id);
    const threadBusy = (id: string) => {
      const orphans = new Set(orphanRuns(id).map(r => r.id));
      return this.store.unreleasedRunsForAgent(id, t.hostId).some(r => !orphans.has(r.id));
    };
    if (agentId) {
      // A run still holding this thread is the launch fence: name it, the rule
      // keeping it and what releases it, so `next` and the owner's verb reply
      // state the same reason instead of a launch that silently starts nothing.
      if (threadBusy(agentId)) { this.resolution.waiting(t, `Assigned thread is serving another request: ${unreleasedLaunchFence(this.store, t, role, agentId) ?? 'its current run has not settled'}`, 'lifecycle'); return; }
      const state = await this.resolution.host.observe(agentId);
      let bindingPath = state.mcpBindingPath ?? mcpBindingPathFromHostRecord(state);
      const bindingKey = wireLabel(state.labels, 'mcpBinding');
      if (!bindingPath && bindingKey) {
        try {
          bindingPath = mcpBindingPathFromProcessListing(
            await this.adapter.hostProcessListing?.() ?? null,
            bindingKey,
          );
        } catch { /* process listing is best-effort; unknown keeps the thread */ }
      }
      let home: string | undefined;
      try { home = dataHome(); } catch { /* unknown home keeps the thread */ }
      if (home && reportBindingReuseDecision({ bindingPath, dataHome: home }) === 'fresh') {
        this.store.event(t.id, 'report_binding_relaunch', `Retained ${role} ${agentId} report binding ${bindingPath} lives outside the current data home; launching a fresh thread on the same profile`);
        agentId = null;
      } else {
      const resumable = state.status === 'idle' || state.status === 'closed' && (
        role === 'reviewer' || role === 'revision'
      ) || role === 'revision' && t.resolution.revisionResumeUnpublished && state.status === 'error';
      // No bypass over a pending permission or question here: nothing Queue can
      // observe identifies the pending item as the superseded run's own question,
      // so the resume waits until the thread goes idle. The recorded
      // superseded-run refusal already told the worker to end its turn without asking.
      // A busy thread is a wait; a terminal, non-resumable one is a fault an owner or coordinator must clear.
      if (active(state) || !resumable) { this.resolution.waiting(t, assignedThreadWaitReason(state), active(state) ? 'lifecycle' : 'operator_needed'); return; }
      if (role === 'reviewer' || role === 'revision') {
        if (state.workspaceId !== t.workspaceId!) throw new Error('Retained thread left the worker workspace');
      }
      else workspaceId = state.workspaceId!;
      if (!workspaceId) throw new Error('Assigned coordinator has no workspace');
      }
    }
    if (this.resolution.paused() || this.store.task(t.id).coordinatorGeneration !== t.coordinatorGeneration) return;
    return await this.resolution.reserveLaunchRun(t, role, options, source, {agentId, profile, group, workspaceId, coordinatorRouteSwitch, replacingReviewer, orphanRuns, threadBusy});
  }
}
