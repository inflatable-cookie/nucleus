import { archiveReplacedReviewer } from '../workspaces/thread-archive';
import { routeStateRefusal } from './control-refusals';
import { REMOVED_TASK_REFUSAL } from './control-refusals';
import { liveRun, liveRunForRole } from '../task-decision-rules';
import { settleSupersededFences } from '../recovery/fence-settlement';
import type { Run, Task, TaskControlInput } from "../../shared/contracts";
import { WORKER_REPLACEMENT_CEILING } from "../../shared/contracts";
import { requestOnly, groupIsUnavailable, honouredWorkerThinking } from "../../shared/pool";
import type { Engine } from "../engine";
import { collectOwnerVerbFacts, retainedWorkerDeliveryRefusal, reviewerSharesAuthorModel, type RouteRole } from "./owner-verbs";
import { independentReviewRoutingConflict, reviewerFiltersWorker, validateNamedProfile, workerReviewerRouteRefusal, type RoutingPreflightInput } from "../dispatch/routing";
import { coveringGrant, grantSignoff } from "../dispatch/routing-grants";
import { OPERATOR_BOARD, boardSignoff, priorNonGrantSignoff, withdrawOpen } from "../dispatch/routing-signoff";
import { digest, now } from "../store/store";
import { OPERATOR_WORKER_REMAP_REASON, PROFILE_CATALOG_LOADING_REFUSAL, isAcceptedReview } from "../recovery/task-reasons";
import { decideWorkerReplacement, retainedWorkerFailureCause } from "../recovery/worker-replacement";
import { proofOnlyReceiptAwaitingReview } from "../qa/proof-execution";

/** Build the route's task patch from facts captured in the transaction. */
export function routePatch(f: {
  current: Task; role: RouteRole; profileId: string; reason: string; replaceLive: boolean; live: boolean;
  currentRun: Run | null; hasUnreleasedRun: boolean; requests: Task['profileRequests'];
  waitingOnRole: boolean;
  includeThinking: boolean; thinking: Task['thinkingOptionId'] | undefined; lifted: Task['workerExclusions'] | null;
  continuation: string; replacementRefusal: { rule: string; detail: string } | null;
}): Record<string, unknown> {
  const {current, role, profileId, reason, replaceLive, live, currentRun, hasUnreleasedRun, requests, includeThinking, thinking, lifted, continuation, replacementRefusal, waitingOnRole} = f;
  const patch: Record<string, unknown> = { profileRequests: requests,
    ...(includeThinking ? { thinkingOptionId: thinking } : {}), ...(lifted ? { workerExclusions: lifted } : {}) };
  const rerouteActivity = reason.startsWith('Rerouted to ') ? reason.split(':', 1)[0] : null;
  const currentRunLive = liveRun(currentRun);
  if (role === 'worker') {
    const ownsWorkerSlot = !currentRunLive || currentRun!.role === 'revision';
    const awaitingSuccessReconciliation = Boolean(current.completion && !['blocked', 'error'].includes(current.completion.status))
      && ['working', 'dispatching'].includes(current.phase);
    const selectsNextRun = replaceLive || !awaitingSuccessReconciliation;
    const armReplacement = selectsNextRun && (current.agentIntent || current.agentId || current.runId) && !replacementRefusal;
    if (armReplacement) {
      patch.replacementProfile = { profileId, reason };
      patch.failoverReason = `${OPERATOR_WORKER_REMAP_REASON}. ${reason}. Continue the existing task: ${continuation}`.slice(0, 2000);
    }
    const recordOnly = replacementRefusal?.rule === 'signoff_pending';
    if (selectsNextRun && !recordOnly && (replaceLive || !live) && ownsWorkerSlot) {
      patch.resolution = { ...current.resolution, currentRunId: null, attention: false, recoveryActive: false,
        recoveryAttempts: 0, recovery: null, stalledTurnStop: null, pendingWorkerInstruction: continuation, prePrResumeInstruction: null };
      if (['working', 'needs_attention', 'changes_requested', 'blocked', 'error'].includes(current.phase)) {
        patch.phase = 'changes_requested';
        patch.reason = rerouteActivity ?? `Owner routed the worker profile; selecting the next worker run on ${profileId}`;
      }
    }
  } else if (role === 'reviewer') {
    const ownsReviewerSlot = !currentRunLive || currentRun!.role === 'reviewer';
    const activeResolution = ['verifying', 'merging', 'syncing', 'closing'].includes(current.phase);
    if ((replaceLive || !live) && ownsReviewerSlot && !activeResolution) {
      const acceptedReview = isAcceptedReview(current.resolution.review) && current.resolution.review!.head === current.prHead;
      if (current.phase === 'reviewing' || waitingOnRole) {
        patch.phase = 'awaiting_review';
        patch.reason = rerouteActivity ?? `Owner routed the reviewer profile; selecting the next reviewer on ${profileId}`;
      }
      patch.resolution = { ...current.resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null,
        integrationTurn: null, attention: false, ...(acceptedReview ? {} : { review: null }) };
    }
  } else {
    const ownsCoordinatorSlot = !currentRunLive || ['recovery', 'closeout'].includes(currentRun!.role);
    if ((replaceLive || (!live && !hasUnreleasedRun)) && ownsCoordinatorSlot) {
      patch.coordinatorAgentId = '';
      patch.coordinatorGeneration = current.coordinatorGeneration + 1;
      patch.reason = rerouteActivity ?? `Owner routed the coordinator profile; the next coordinator run uses ${profileId}`;
      if (replaceLive) patch.resolution = { ...current.resolution, currentRunId: null, attention: false };
    }
  }
  return patch;
}

/**
 * The owner's `route` verb and the profile checks it shares with submission and
 * brief amendment. Same-name `Engine` methods delegate here. `store`, `adapter`
 * and `profiles` read the engine per call: tests replace them.
 */
export class RouteControls {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get profiles() { return this.engine.profiles; }
  get resolution() { return this.engine.resolution; }
  get coordinatorActionRunId() { return this.engine.coordinatorActionRunId; }
  get signoffDecisions() { return this.engine.signoffDecisions; }

  /**
   * Spec 050 `route`: point one role's next run at a named profile, and with
   * `now` replace that role's live run. The route is recorded on the existing
   * `profileRequests` field the selection path already reads; the
   * submission-time requests stay in the event history. Naming a profile a
   * worker exclusion covers lifts that profile's exclusion for this task. A
   * reviewer route is used even when it shares the current author's model: the
   * `owner_control` audit records the waiver, and independence stays a
   * selection preference for automatic routing.
   */
  async routeTask(input: TaskControlInput, operationId?: string): Promise<Task> {
    const role = input.role as RouteRole;
    const profileId = input.profileId!;
    const reason = (input.reason ?? "").trim();
    const replaceNow = input.now === true;
    return this.engine.control(async () => {
      let task = this.store.task(input.taskId);
      if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
      this.engine.requireOwnerControlCurrent(task, input.version, "Task changed; refresh before retrying");
      const refusal = routeStateRefusal(task);
      if (refusal) throw Error(refusal);
      if (!reason) throw Error("route requires a reason");
      // Round 4: a route applies while paused; only dispatch waits for unpause.

      const thinking = input.thinkingOptionId ?? (role === "worker" ? honouredWorkerThinking(task, this.store.pool(), this.store.usageLevel()) : "") ?? "";
      this.engine.requireProfileCatalog();
      // The task's own host decides availability: a profile its catalog cannot
      // run is refused here, before it is ever recorded (nucleus#1139 review).
      const hostProfiles = this.engine.profilesFor(task.hostId);
      const { profile } = validateNamedProfile(profileId, role, task.scope, hostProfiles, this.store.pool(), reason, thinking);
      if (thinking && !profile.supportedThinking.includes(thinking))
        throw Error(`Profile ${profileId} does not support thinking option ${thinking}`);
      this.assertRouteGroupAvailable(profileId, role, task.hostId);
      // Worker selection always drops a profile on the retained reviewer's model
      // (no waiver), so a route it would drop is refused now, not recorded and
      // parked. The `next` route view reads the same rule.
      if (role === "worker" && reviewerFiltersWorker(task.resolution.reviewerProfile, profile))
        throw Error(workerReviewerRouteRefusal(profile, task.resolution.reviewerProfile!));

      // Reviewer independence is a selection preference, not a gate (Spec
      // 050). An owner-routed reviewer sharing an author model is used, and the
      // audit records the waiver; every other role ignores this.
      const independenceWaived = role === "reviewer" && reviewerSharesAuthorModel(task, profile.model);

      // Replacing a live run now only helps once the profile can actually be
      // used; an unsigned request would restart the role on automatic selection.
      // Spec 058 task 577: a route waiting on sign-off never displaces the
      // retained run, but it still records its request — the early throw here
      // lost it (review 825), so the operator was never asked. Until the
      // sign-off is approved the role's run, bindings and phase stay untouched.
      const routeEntry = this.store.pool().find(entry => entry.profileId === profileId);
      const prior = input.caller !== OPERATOR_BOARD ? priorNonGrantSignoff(this.store, task.id, role, profileId) : null;
      const grant = coveringGrant(this.store, task, profileId);
      const carryDeclined = prior?.status === "declined" && Boolean(grant);
      const appliedGrant = carryDeclined ? null : grant;
      const signoffPendingNow = replaceNow && Boolean(routeEntry) && requestOnly(routeEntry!, this.store.usageLevel()) && input.caller !== OPERATOR_BOARD
        && !(task.profileRequests?.[role]?.profileId === profileId && task.profileRequests[role]!.signoff?.status === "approved")
        && !appliedGrant;
      // The displacement a `now` route owes; a sign-off-pending route owes none
      // and is written like a route without `now`.
      const replaceLive = replaceNow && !signoffPendingNow;

      // A `route now` displaces that role's live run, so a worker replacement owes
      // the same unresolved delivery and effect proofs the retained-worker
      // restart proves, read from the same derivation: an uncertain revision
      // delivery is reconciled or waited for, never released and superseded by
      // one control while the other refuses it (review 5696038429 finding 2).
      if (replaceLive && role === "worker") {
        const fence = retainedWorkerDeliveryRefusal(collectOwnerVerbFacts(this.store, task));
        if (fence) throw Error(fence);
      }

      // The retirement ceiling is a loop breaker. A route now cannot pass it;
      // only an operator-relayed fresh worker restart can deliberately do so.
      const armsWorkerReplacement = role === "worker" && replaceLive && Boolean(task.agentIntent || task.agentId || task.runId);
      if (armsWorkerReplacement && task.retiredWorkers.length >= WORKER_REPLACEMENT_CEILING) {
        throw Error(this.engine.replacementCeilingRefusal(task));
      }

      const live = this.routeLiveRun(task, role);
      // A route normally affects the next run only. If the task is parked on a
      // completed run of this role, routing it is also the owner's instruction
      // to start that missing next run (the same transition restart would take).
      const blockingRun = task.completion ? this.store.run(task.completion.runId) : null;
      const waitingOnRole = !live && ['blocked', 'error'].includes(task.phase)
        && (proofOnlyReceiptAwaitingReview(task) && role === 'reviewer'
          || Boolean(task.completion?.prNumber || task.resumePrNumber || task.prUrl || task.prHead)
            && blockingRun?.role === role
            && blockingRun.completion?.eventId === task.completion?.eventId);
      // The result each displaced participant already carried at admission. A
      // result that arrives while the cancellation is awaited is a different
      // occurrence that won the race against this displacement.
      const admittedCompletion = task.completion?.eventId ?? null;
      const admittedRunCompletion = live?.run?.completion?.eventId ?? null;
      let archivePending = false;
      if (replaceLive && live) {
        archivePending = await this.stopRouteRun(task, role, live.run, operationId);
        task = this.store.task(task.id);
        // Spec 050: a completed callback that wins the replacement race is
        // preserved. The stop retains an authentic completion that landed during
        // the cancellation, so this control must not then detach that run from
        // its binding or arm a replacement over the accepted result; the same
        // delivery fence the admission read is re-read from the fresh task and
        // the result is left to the ordinary reconciliation (review 5696768664
        // finding 1).
        if (role === "worker") {
          const landedTaskCompletion = task.completion?.eventId ?? null;
          const landedRunCompletion = live.run ? this.store.run(live.run.id)?.completion?.eventId ?? null : null;
          const landedFence = retainedWorkerDeliveryRefusal(collectOwnerVerbFacts(this.store, task));
          if (landedTaskCompletion !== admittedCompletion || landedRunCompletion !== admittedRunCompletion || landedFence)
            throw Error(`The route now stop raced an authenticated result: ${landedFence
              ?? 'the retained worker reported while its turn was being stopped'}. The accepted result keeps its own authority and the ordinary reconciliation applies it. Route without now to select the next run`);
        }
      }

      const before = task.profileRequests?.[role] ?? null;
      // Spec 052 (2026-10-21): the operator's own board route is its sign-off; any
      // other route above the usage level, or to a frontier profile below Maximum, is asked.
      const signoff = input.caller === OPERATOR_BOARD ? boardSignoff()
        : before?.profileId === profileId && before.signoff?.status === "approved" ? before.signoff
        : carryDeclined ? prior
        : appliedGrant ? grantSignoff(appliedGrant) : undefined;
      const lifted = role === "worker" ? task.workerExclusions.filter(exclusion => exclusion.profileId !== profileId) : task.workerExclusions;
      const exclusionLifted = lifted.length !== task.workerExclusions.length;
      // Spec 050: only `route` writes the `ownerRoute` marker, so the
      // reviewer independence waiver applies solely to an owner route.
      // An unsigned route keeps its thinking level on the request, so until the
      // operator signs it off automatic selection runs at the task's own level.
      const unsignedRoute = Boolean(routeEntry && requestOnly(routeEntry, this.store.usageLevel()) && !signoff);
      const requests = { ...task.profileRequests, [role]: { profileId, reason, required: true, ownerRoute: true, ...(role === "worker" ? { routedAt: now() } : {}),
        ...((role !== "worker" || unsignedRoute) && input.thinkingOptionId !== undefined ? { thinkingOptionId: input.thinkingOptionId } : {}),
        ...(input.caller ? { requestedBy: input.caller } : {}), ...(signoff ? { signoff } : {}),
      } };

      const updated = this.store.transaction(() => {
        const current = this.store.task(task.id);
        this.engine.requireOwnerControlCurrent(current, task.version, "Task changed during route");
        const thinkingPatch = role === 'worker' && !unsignedRoute ? input.thinkingOptionId ?? honouredWorkerThinking(task, this.store.pool(), this.store.usageLevel()) : undefined;
        const currentRun = current.resolution.currentRunId ? this.store.run(current.resolution.currentRunId) : null;
        let continuation = '';
        let replacementRefusal: { rule: string; detail: string } | null = null;
        if (role === 'worker') {
          const awaitingSuccess = Boolean(current.completion && !['blocked', 'error'].includes(current.completion.status))
            && ['working', 'dispatching'].includes(current.phase);
          const selectsNextRun = replaceLive || !awaitingSuccess;
          continuation = this.resolution.workerContinuation(current);
          if (selectsNextRun && (current.agentIntent || current.agentId || current.runId)) {
            const assignedGroup = current.profileGroup ?? this.store.pool().find(entry => entry.profileId === current.profile?.id)?.group ?? null;
            const availabilityRow = assignedGroup ? this.store.db.prepare("SELECT data FROM availability WHERE group_id=?").get(assignedGroup) : null;
            const availability = availabilityRow ? JSON.parse(String((availabilityRow as { data: string }).data)) : null;
            const decision = decideWorkerReplacement({ task: current, requestedProfileId: profileId,
              requestedModel: this.engine.profilesFor(current.hostId).find(candidate => candidate.id === profileId)?.model ?? null,
              currentModel: current.profile?.model ?? null, approved: !unsignedRoute,
              failure: retainedWorkerFailureCause({ task: current, groupUnavailable: availability && groupIsUnavailable(availability)
                ? { group: assignedGroup!, reason: String(availability.reason ?? '') } : null }),
              explicitOperatorRelay: false, freshRestart: false });
            if (!decision.allowed) replacementRefusal = { rule: decision.rule, detail: decision.detail };
          }
        }
        const patch = routePatch({ current, role, profileId, reason, replaceLive, live: Boolean(live), currentRun, waitingOnRole,
          hasUnreleasedRun: role === 'coordinator' && !replaceLive && !live ? this.store.runs(current.id).some(run => !run.released && run.id !== this.coordinatorActionRunId.getStore()) : false,
          requests, includeThinking: role === 'worker' && !unsignedRoute, thinking: thinkingPatch,
          lifted: exclusionLifted ? lifted : null, continuation, replacementRefusal });
        if (replacementRefusal) this.store.event(current.id, 'worker_replacement_refused', `${replacementRefusal.rule}: ${replacementRefusal.detail}`);
        return this.store.update(current.id, archivePending ? { ...patch, phase: current.phase,
          reason: 'Reviewer replacement archive is not confirmed; the launch waits until observation releases the retained reviewer, and it releases once that thread is proven archived, gone or closed',
          resolution: current.resolution,
        } : patch, "route_changed", JSON.stringify({
          role, profileId, thinkingOptionId: input.thinkingOptionId ?? null, reason, now: replaceNow,
          phaseBefore: current.phase, independenceWaived, exclusionLifted, before,
        }));
      });
      if ((replaceLive && live) || this.coordinatorActionRunId.getStore())
        settleSupersededFences(this.store, updated.id, `route now replaced the live ${role} run`, now(), this.coordinatorActionRunId.getStore());
      // The new request replaces the question the old one was waiting on.
      if (before?.signoff?.status === "pending" && before.signoff.decisionId)
        withdrawOpen(this.signoffDecisions, before.signoff.decisionId, "The role was routed again");
      if (signoffPendingNow) {
        // Spec 058 task 577 (review 825): the `now` replacement is refused and
        // the verb fails, but the request stands and the retained run is
        // untouched; the reconciler opens the operator's sign-off decision.
        void this.engine.cleanContext(() => this.engine.wakeTask(updated.id));
        throw Error(`${profileId} needs the operator's board sign-off before a route can replace a live run; the request is recorded and this route left the retained run untouched until the operator approves it on the board`);
      }
      return updated;
    }, `task:${input.taskId}`);
  }

  /**
   * The live run a `route now` acts on: the current reviewer/recovery/revision
   * run, or the initial worker while it holds no completion. Null when the role
   * is idle or between runs.
   */
  routeLiveRun(task: Task, role: RouteRole): { run: Run | null } | null {
    return liveRunForRole(task, this.store.runs(task.id), role);
  }

  /**
   * A durable stop of one live route run through Paseo's active-turn
   * cancellation: identity is observed before and after the intent, the intent
   * and its outcome are recorded, and the run row is superseded so the
   * replacement can start. An already-inactive turn needs no cancellation.
   */
  async stopRouteRun(task: Task, role: RouteRole, run: Run | null, operationId?: string): Promise<boolean> {
    const agentId = run?.agentId ?? task.agentId;
    const workspaceId = run?.workspaceId ?? task.workspaceId;
    if (!agentId || !workspaceId) throw Error(`route now requires the ${role}'s retained agent and workspace`);
    const cancelled = this.adapter.stopAgentTurn;
    if (!cancelled) throw Error("Paseo active-turn cancellation is unavailable; route without now and stop the run first");
    const observed = await this.engine.host.observe(agentId);
    if (observed.id !== agentId || observed.workspaceId !== workspaceId)
      throw Error(`The ${role}'s agent or workspace identity changed; no stop was sent`);
    if (observed.permissions)
      throw Error(`The ${role}'s run is waiting on a permission request; resolve it before routing with now`);
    const busy = observed.active || ["running", "initializing"].includes(observed.status);
    const intent = { role, runId: run?.id ?? task.runId ?? null, agentId, workspaceId,
      turnId: observed.activeTurnId ?? null, effectId: `ns-route-stop-${digest(`${task.id}:${role}:${run?.id ?? task.runId ?? ""}:${agentId}${operationId ? `:${operationId}` : ""}`).slice(0, 32)}` };
    // A replayed operation owns only the turn it recorded: a stop already sent
    // or settled is never resent, and a turn that started after the recorded
    // one is not this operation's to cancel (review #557).
    const prior = operationId ? (this.store.db.prepare("SELECT detail FROM events WHERE taskId=? AND kind LIKE 'route_stop_%' ORDER BY id").all(task.id) as { detail: string }[])
      .flatMap(row => { try { const detail = JSON.parse(row.detail) as { effectId?: string; status?: string; turnId?: string | null }; return detail.effectId === intent.effectId ? [detail] : []; } catch { return []; } }) : [];
    const recordedTurn = prior.find(detail => detail.status === "intent");
    const alreadyStopped = prior.some(detail => detail.status === "sent" || detail.status === "inactive");
    // An unresolved stop is resent only to the same known turn: an unknown turn
    // on either side cannot prove the live turn is the one this operation
    // stopped, and unknown delivery is never permission to retry blindly.
    if (!alreadyStopped && recordedTurn && busy && (!recordedTurn.turnId || !intent.turnId))
      throw Error(`route now cannot prove the live ${role} turn is the one this operation stopped; route again to stop the current turn`);
    if (alreadyStopped || (recordedTurn && recordedTurn.turnId !== intent.turnId)) {
      this.store.event(task.id, "route_stop_settled", JSON.stringify({ ...intent, turnId: recordedTurn?.turnId ?? intent.turnId, status: "replayed",
        ...(intent.turnId && recordedTurn?.turnId !== intent.turnId ? { untouchedTurnId: intent.turnId } : {}) }));
    } else if (busy) {
      if (!recordedTurn) this.store.event(task.id, "route_stop_intent", JSON.stringify({ ...intent, status: "intent" }));
      try {
        await cancelled.call(this.adapter, agentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.event(task.id, "route_stop_uncertain", JSON.stringify({ ...intent, status: "uncertain", message: message.slice(0, 2000) }));
        throw Error(`route now could not stop the live ${role} run: ${message}`);
      }
      this.store.event(task.id, "route_stop_sent", JSON.stringify({ ...intent, status: "sent" }));
    } else {
      if (!recordedTurn) this.store.event(task.id, "route_stop_intent", JSON.stringify({ ...intent, status: "intent" }));
      this.store.event(task.id, "route_stop_settled", JSON.stringify({ ...intent, status: "inactive" }));
    }
    if (run?.role === 'reviewer' && !this.store.run(run.id)?.completion
        && !await archiveReplacedReviewer(this.store, this.adapter, run))
      return true;
    if (run) {
      this.store.transaction(() => {
        const latest = this.store.run(run.id);
        // An authentic completion that arrived during the stop is retained.
        if (!latest || latest.released || latest.completion) return;
        if (latest.role !== "reviewer") this.store.deleteCredential(run.id);
        this.store.putRun({ ...latest, status: "superseded", released: true, active: false,
          ...(latest.role === "reviewer" ? { replacedAt: now() } : {}) });
      });
    }
    return false;
  }

  /**
   * Refuse a route whose subscription group is unavailable, naming the retry
   * time and the eligible alternatives so the owner can choose another route.
   */
  assertRouteGroupAvailable(profileId: string, role: RouteRole, hostId?: string | null): void {
    const entry = this.store.pool().find(candidate => candidate.profileId === profileId);
    if (!entry) return;
    const row = this.store.db.prepare("SELECT data FROM availability WHERE group_id=?").get(entry.group);
    if (!row) return;
    const status = JSON.parse(String(row.data));
    if (!groupIsUnavailable(status)) return;
    const alternatives = this.store.pool()
      .filter(candidate => candidate.profileId !== profileId && candidate.enabled
        && this.engine.profilesFor(hostId).some(profile => profile.id === candidate.profileId && profile.available))
      .map(candidate => candidate.profileId);
    throw Error(`Subscription group ${entry.group} is unavailable: ${status.reason}${status.retryAt ? ` (retry ${status.retryAt})` : ""}`
      + `; eligible ${role} alternatives: ${alternatives.length ? alternatives.join(", ") : "none"}`);
  }

  /**
   * Spec 036 preflight: the named profile's subscription group must be
   * available now. A paused or exhausted group refuses the whole control with
   * the group and reason, instead of accepting the profile and dropping it
   * behind a generic "no eligible replacement" message (papercut bdd9307a).
   */
  requireAvailableGroup(profileId:string):void{
    const entry=this.store.pool().find(p=>p.profileId===profileId);
    if(!entry)return;
    const row=this.store.db.prepare("SELECT data FROM availability WHERE group_id=?").get(entry.group);
    if(!row)return;
    const status=JSON.parse(String(row.data));
    if(groupIsUnavailable(status))throw Error(`Subscription group ${entry.group} is unavailable: ${status.reason}${status.retryAt?` (retry ${status.retryAt})`:''}`);
  }

  /**
   * Admission-time independence preflight. Runtime selection still re-checks
   * after the actual author or catalog can change.
   */
  independentReviewRoutingRefusal(routing:RoutingPreflightInput, hostId?: string | null):string|null{
    // An unloaded catalog cannot prove a named profile absent (review #565); routing
    // that names none is unaffected by catalog membership.
    const named=Boolean(routing.preferredProfileId)||Object.values(routing.profileRequests??{}).some(request=>Boolean(request?.profileId));
    if(named&&!this.engine.profileCatalogKnownFor(hostId))return PROFILE_CATALOG_LOADING_REFUSAL;
    return independentReviewRoutingConflict({...routing,usage:this.store.usageLevel()},this.engine.profilesFor(hostId),this.store.pool());
  }
}
