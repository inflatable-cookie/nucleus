import type { Resolution } from '../resolution';
import type { Profile, Task } from "../../shared/contracts";
import { WORKER_REPLACEMENT_CEILING, workerExclusionFor, workerProfileIsExcluded } from "../../shared/contracts";
import { isTransportFailure } from "../../shared/transport";
import { demandRank, groupIsUnavailable, honouredWorkerThinking, unavailableGroupNames } from "../../shared/pool";
import { runDemand } from "../../shared/demand";
import { occupiesSlot } from "./capacity";
import type { Engine } from "../engine";
import { isQuotaExhaustion, isRateLimitError, providerRetryAt, rateLimitCooldownData } from "../recovery/exhaustion";
import type { Adapter, AgentObservation } from "../host/adapter";
import { chooseProfile, eligibilityReasons, reviewerFiltersWorker } from "./routing";
import { startsNoRuns } from "../closeout/queue-drain";
import { now, type Store } from "../store/store";
import { OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON, OPERATOR_ROLE_REASSIGNMENT_REASON, OPERATOR_STOPPED_REVISION_REMAP_REASON, OPERATOR_STOPPED_WORKER_REMAP_REASON, OPERATOR_WORKER_REMAP_REASON, PROFILE_CATALOG_PENDING_REASON } from "../recovery/task-reasons";
import { decideWorkerReplacement, isWorkerRouteApproved, replacementCeilingRefusal, retainedWorkerFailureCause, supersededReplacementRefusal, type WorkerReplacementDecision } from "../recovery/worker-replacement";

/** Only explicit model/configuration failures blame a profile; transport and provider errors do not. */
function profileFailure(error: string): boolean {
  return /\b(?:model (?:refused|refusal|not found|does not exist|unsupported)|invalid (?:model|profile|configuration)|unsupported (?:model|configuration))\b/i.test(error);
}

/** What the failover sweep does with one observed worker once its arm and any rate-limit pacing are recorded. */
type WorkerFailoverDecision =
  | { kind: "skip" }
  | { kind: "workspace_changed" }
  | { kind: "wait_old_worker" }
  | { kind: "suppress" }
  | { kind: "ceiling" }
  | { kind: "catalog_pending" }
  | { kind: "refuse_instruction"; cause: string }
  | { kind: "refuse_unavailable" }
  | { kind: "refuse_route"; cause: string }
  | { kind: "refuse_same_model" }
  | { kind: "refuse_superseded"; refusal: WorkerReplacementDecision }
  | { kind: "refuse_rule"; decision: Extract<WorkerReplacementDecision, { allowed: false }> }
  | { kind: "replace"; selected: NonNullable<ReturnType<typeof chooseProfile>>; replacingStoppedRevision: boolean; replacingStoppedWorker: boolean };
/** Facts are gathered in stages so the sweep does not move reads or the
 * suppression effect ahead of a gate that formerly returned first. */
type WorkerFailoverFacts =
  | { stage: 'observation'; armed: boolean; sameWorkspace: boolean; stopped: boolean }
  | { stage: 'suppression'; suppressed: boolean }
  | { stage: 'ceiling'; reached: boolean; relayed: boolean }
  | { stage: 'catalog'; known: boolean }
  | { stage: 'unselected'; instruction: boolean; alternate: boolean; cause: string }
  | { stage: 'selected'; failure: boolean; requestedId: string | null; selectedId: string; operatorArmed: boolean; relayed: boolean }
  | { stage: 'replacement'; decision: WorkerReplacementDecision; selected: NonNullable<ReturnType<typeof chooseProfile>>; replacingStoppedRevision: boolean; replacingStoppedWorker: boolean };

type WorkerFailoverStep = WorkerFailoverDecision | { kind: 'continue' };

/** Pure rule over the facts available at the current failover gate. */
function decideWorkerFailover(facts: WorkerFailoverFacts): WorkerFailoverStep {
  switch (facts.stage) {
    case 'observation':
      if (!facts.armed) return { kind: 'skip' };
      if (!facts.sameWorkspace) return { kind: 'workspace_changed' };
      if (!facts.stopped) return { kind: 'wait_old_worker' };
      break;
    case 'suppression': if (facts.suppressed) return { kind: 'suppress' }; break;
    case 'ceiling': if (facts.reached && !facts.relayed) return { kind: 'ceiling' }; break;
    case 'catalog': if (!facts.known) return { kind: 'catalog_pending' }; break;
    case 'unselected':
      if (facts.instruction) return { kind: 'refuse_instruction', cause: facts.cause };
      if (facts.alternate) return { kind: 'refuse_unavailable' };
      return { kind: 'refuse_route', cause: facts.cause };
    case 'selected':
      if (!facts.failure && !facts.requestedId && !facts.operatorArmed && !facts.relayed) return { kind: 'refuse_same_model' };
      if (!facts.failure && facts.requestedId && facts.selectedId !== facts.requestedId)
        return { kind: 'refuse_superseded', refusal: supersededReplacementRefusal(facts.requestedId, facts.selectedId, 'automatic selection fell back to another profile') };
      break;
    case 'replacement':
      return facts.decision.allowed
        ? { kind: 'replace', selected: facts.selected, replacingStoppedRevision: facts.replacingStoppedRevision, replacingStoppedWorker: facts.replacingStoppedWorker }
        : { kind: 'refuse_rule', decision: facts.decision };
  }
  return { kind: 'continue' };
}

type WorkerFailoverReaders = {
  store: Store;
  profiles: Profile[];
  catalogKnown: () => boolean;
  suppressed: () => boolean;
  unavailableGroups: () => Set<string>;
  retainedProfileIssue: () => string | null;
  providerUnavailable: () => boolean;
};
/**
 * The failover sweep's decision for one armed worker: wait, skip, refuse with
 * a rule, or replace with the selected profile. The caller applies the effect.
 */
function planWorkerFailover(task: Task, state: AgentObservation, erroredWithoutTurn: boolean, facts: WorkerFailoverReaders): WorkerFailoverDecision {
  const store = facts.store;
  const observation = decideWorkerFailover({ stage: 'observation', armed: Boolean(task.failoverReason), sameWorkspace: state.workspaceId === task.workspaceId,
    stopped: !state.active && !state.activeTurnId && !state.permissions && ["idle","closed","error"].includes(state.status) });
  if (observation.kind !== 'continue') return observation;
  // The ceiling bounds automatic replacement loops. Only the replacement
  // explicitly armed by an operator-relayed fresh restart passes it.
  const ceilingReached = task.retiredWorkers.length >= WORKER_REPLACEMENT_CEILING;
  const relayedRestart = task.replacementProfile?.operatorRelayed === true
    && task.failoverReason.startsWith(OPERATOR_WORKER_REMAP_REASON);
  const ownerArmedReplacement = [OPERATOR_WORKER_REMAP_REASON, OPERATOR_STOPPED_REVISION_REMAP_REASON,
    OPERATOR_STOPPED_WORKER_REMAP_REASON, OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON,
    OPERATOR_ROLE_REASSIGNMENT_REASON].some(reason => task.failoverReason.startsWith(reason));
  const suppression = decideWorkerFailover({ stage: 'suppression', suppressed: !ownerArmedReplacement && facts.suppressed() });
  if (suppression.kind !== 'continue') return suppression;
  const ceiling = decideWorkerFailover({ stage: 'ceiling', reached: ceilingReached, relayed: relayedRestart });
  if (ceiling.kind !== 'continue') return ceiling;
  const catalog = decideWorkerFailover({ stage: 'catalog', known: facts.catalogKnown() });
  if (catalog.kind !== 'continue') return catalog;
  const unavailable = facts.unavailableGroups();
  const replacingStoppedRevision=task.failoverReason.startsWith(OPERATOR_STOPPED_REVISION_REMAP_REASON);
  const replacingStoppedWorker=task.failoverReason.startsWith(OPERATOR_STOPPED_WORKER_REMAP_REASON);
  const replacingRetainedWorker=task.failoverReason.startsWith(OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON);
  const replacingReassignedWorker=task.failoverReason.startsWith(OPERATOR_ROLE_REASSIGNMENT_REASON);
  const requested=task.replacementProfile;
  // An errored process is not evidence against its profile. Profile failures
  // are represented by the durable exclusions that an owner can inspect/lift.
  const profiles = facts.profiles.filter(p=>!workerProfileIsExcluded(task,p.id)
    && (!(replacingStoppedRevision||replacingStoppedWorker||replacingRetainedWorker||replacingReassignedWorker)
      || p.id!==task.profile?.id || requested?.profileId===p.id || erroredWithoutTurn)
    && !reviewerFiltersWorker(task.resolution.reviewerProfile, p));
  // The replaced worker request keeps the worker's effective thinking level (review #547).
  // A pin on the worker's own requested profile keeps that request (its owner reason and thinking level).
  const ownRequest=requested&&task.profileRequests?.worker?.profileId===requested.profileId?task.profileRequests.worker:undefined;
  const replacementTask=requested?{...task,thinkingOptionId:honouredWorkerThinking(task,store.pool(),store.usageLevel()),preferredProfileId:requested.profileId,requirePreferred:true,profileRequests:{...task.profileRequests,worker:ownRequest?{...ownRequest,required:true}:{profileId:requested.profileId,reason:requested.reason,required:true}}}:task;
  const pool=store.pool();
  const assignedGroup=task.profileGroup ?? pool.find(entry=>entry.profileId===task.profile?.id)?.group;
  const catalogOutage=facts.providerUnavailable();
  const outage=Boolean(assignedGroup && unavailable.has(assignedGroup)) || catalogOutage;
  const demand=runDemand(task.complexity,'worker',store.usageLevel(),store.demandRoleOffsets());
  // An outage alone must not promote work to a stronger fallback. An explicit
  // request is already subject to the normal route/sign-off rules.
  const explicitlyRequested=requested?.profileId ?? task.profileRequests?.worker?.profileId;
  const selectionPool=outage
    ? pool.filter(entry=>entry.profileId===explicitlyRequested || demandRank(entry.capability ?? 'medium')<=demandRank(demand)) : pool;
  const selected = chooseProfile(replacementTask,profiles,selectionPool,store.counts(),unavailable,'worker',store.recentCounts(),store.usageLevel(), store.demandRoleOffsets());
  if (!selected) {
    // Spec 036 durable continuation (also papercut bdd9307a): an
    // operator-accepted instruction is never dropped silently. When the
    // replacement cannot be created after acceptance — a group paused
    // under the preflight, a profile disabled since — the instruction is
    // recorded refused with the specific reason and the task parks in
    // needs_attention. Automatic exhaustion failover keeps retrying; an
    // operator decision parks visibly instead.
    if ((replacingRetainedWorker||replacingReassignedWorker) && !outage) {
      const availability=store.db.prepare("SELECT data FROM availability").all().map(row=>{const entry=JSON.parse(String(row.data));return{group:String(entry.group),unavailable:groupIsUnavailable(entry),reason:String(entry.reason??''),retryAt:(entry.retryAt??null) as string|null};});
      const excludedProfiles=task.workerExclusions.filter(exclusion=>exclusion.profileId).map(exclusion=>exclusion.profileId);
      const cause=`${eligibilityReasons(replacementTask,profiles,store.pool(),availability,store.usageLevel(),facts.profiles)}${excludedProfiles.length?`; excluded profiles: ${[...new Set(excludedProfiles)].join(', ')}`:''}`;
      return decideWorkerFailover({ stage: 'unselected', instruction: true, alternate: false, cause }) as WorkerFailoverDecision;
    }
    // Type the stop from the eligibility result. Blocked only by an
    // unavailable group, failover owns the wait and retries each sweep;
    // otherwise only a routing change helps, so the owner verbs apply.
    const restoredProfiles=catalogOutage ? profiles.map(profile => profile.provider === task.profile?.provider
      ? {...profile, available: true} : profile) : profiles;
    if(chooseProfile(replacementTask,restoredProfiles,selectionPool,store.counts(),new Set(),'worker',store.recentCounts(),store.usageLevel(), store.demandRoleOffsets())){
      return decideWorkerFailover({ stage: 'unselected', instruction: false, alternate: true, cause: '' }) as WorkerFailoverDecision;
    }
    const availability=store.db.prepare("SELECT data FROM availability").all().map(row=>JSON.parse(String(row.data)));
    const cause=eligibilityReasons(replacementTask,profiles,store.pool(),availability,store.usageLevel(),facts.profiles);
    return decideWorkerFailover({ stage: 'unselected', instruction: false, alternate: false, cause }) as WorkerFailoverDecision;
  }
  // Spec 058 task 577: one worker thread. The sweep retires the retained
  // worker only for a failure (provider failure, quota exhaustion, a
  // closed agent, an unrecoverable session or an ineligible retained
  // profile) or for an approved route to a different model. Any other
  // armed replacement is refused with its rule, the arm is cleared, and
  // the retained worker continues.
  {
    const requestedId = task.replacementProfile?.profileId ?? null;
    // An operator-armed failover reason identifies a requested route;
    // selection still requires a different model, failure or explicit
    // operator relay before retiring the retained worker.
    const operatorArmed = [OPERATOR_WORKER_REMAP_REASON, OPERATOR_STOPPED_REVISION_REMAP_REASON,
      OPERATOR_STOPPED_WORKER_REMAP_REASON, OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON,
      OPERATOR_ROLE_REASSIGNMENT_REASON].some(reason => task.failoverReason.startsWith(reason));
    const profileIssue = facts.retainedProfileIssue();
    const sweepGroup = task.profileGroup ?? store.pool().find(entry => entry.profileId === task.profile?.id)?.group ?? null;
    const sweepAvailabilityRow = sweepGroup
      ? store.db.prepare("SELECT data FROM availability WHERE group_id=?").get(sweepGroup)
      : null;
    const sweepAvailability = sweepAvailabilityRow ? JSON.parse(String((sweepAvailabilityRow as { data: string }).data)) : null;
    const failure = retainedWorkerFailureCause({
      task,
      observedStatus: state.status,
      observedError: state.error,
      observedActive: state.active || Boolean(state.activeTurnId),
      observedPermissions: state.permissions,
      observedWorkspaceId: state.workspaceId,
      groupUnavailable: sweepAvailability && groupIsUnavailable(sweepAvailability)
        ? { group: sweepGroup!, reason: String(sweepAvailability.reason ?? "") } : null,
    }) ?? (profileIssue ? { kind: "session_unrecoverable" as const, detail: `retained worker profile ineligible: ${profileIssue.slice(0, 400)}` } : null);
    // An operator relay the arming restart recorded, or a
    // planner/operator exclusion of the retained worker itself, is an
    // explicit replacement cause.
    const sweepRelay = task.replacementProfile?.operatorRelayed === true
      || workerExclusionFor(task, task.agentId, task.profile?.id) !== null;
    const guard = decideWorkerFailover({ stage: 'selected', failure: Boolean(failure), requestedId, selectedId: selected.profile.id, operatorArmed, relayed: sweepRelay });
    if (guard.kind !== 'continue') return guard;
    const approved = operatorArmed
      || (requestedId ? isWorkerRouteApproved(task, requestedId, store.pool(), store.usageLevel()) : false);
    const decision = decideWorkerReplacement({
      task,
      requestedProfileId: requestedId ?? selected.profile.id,
      requestedModel: selected.profile.model,
      currentModel: task.profile?.model ?? null,
      approved,
      failure,
      explicitOperatorRelay: sweepRelay,
      freshRestart: false,
    });
    return decideWorkerFailover({ stage: 'replacement', decision, selected, replacingStoppedRevision, replacingStoppedWorker }) as WorkerFailoverDecision;
  }
}

/**
 * Worker failover: the sweep that replaces an exhausted or failed worker, its
 * gated decision, and the availability read every profile selection shares. The
 * retained-worker observation cadence lives in `core/recovery/retired-observation.ts`
 * and the archive of retired errored agents in `core/workspaces/thread-archive.ts`;
 * this module owns only the replacement itself. Same-name `Engine` methods
 * delegate here. `store`, `adapter` and `resolution` read the engine per call:
 * tests replace the adapter.
 */
export type WorkerFailoverContext = Pick<Engine, 'activeHostId' | 'adapter' | 'host' | 'launchAgent' | 'note' | 'profileCatalogKnown' | 'profiles' | 'workerProviderUnavailable' | 'stopped' | 'store' | 'taskHostAvailable' | 'withHost'>
  & { readonly resolution: Pick<Resolution, 'recordStop' | 'resumeTransientProviderThread' | 'resumeTransientWorker' | 'retainedWorkerProfileIssue' | 'suppressAutomaticRetry' | 'transportDeferred' | 'waiting'> };

export class WorkerFailover {
  constructor(readonly engine: WorkerFailoverContext) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  async recoverExhaustedWorkers(scopedHost?: string): Promise<void> {
    if (!scopedHost) {
      const hosts = new Set(this.store.activeCapacityTasks().flatMap(task => task.hostId ? [task.hostId] : []));
      for (const host of hosts) await this.engine.withHost(host, () => this.recoverExhaustedWorkers(host));
      return;
    }
    for (const original of this.store.activeCapacityTasks()) {
      if (startsNoRuns(this.store, this.engine.stopped)) return;
      if (original.hostId !== scopedHost) continue;
      if (!this.engine.taskHostAvailable(original)) continue;
      // An owner `move to=work` for a gone author is a replacement with no old
      // agent: nothing runs, so there is nothing to observe or retire.
      const absentAuthor = !original.agentId && !original.agentIntent && Boolean(original.failoverReason && original.workspaceId && original.profile);
      // Pause applies a stored blocked/error+providerUnavailable result, so
      // phase is already blocked on unpause. Visit that shape so the
      // availability row and replacement wait still record. Unpaused, a
      // complete that lands between sweeps gets the same next-sweep visit.
      const failoverPhase = ["working","needs_attention","changes_requested"].includes(original.phase)
        || (["blocked","error"].includes(original.phase) && original.completion?.providerUnavailable === true);
      if ((!absentAuthor && (!original.agentId || !original.runId)) || !original.profile || !failoverPhase) continue;
      const revision = original.resolution.currentRunId ? this.store.run(original.resolution.currentRunId) : null;
      if (revision && (revision.role !== "revision" || revision.agentId !== original.agentId || revision.released)) continue;
      // An unresolved paused-stop marker owns the retained thread until its
      // unpause resume settles: no transient resume races it and no replacement
      // is armed from a stale observation (Queue #650).
      const pausedStopHeld = Boolean(original.pausedStop || revision?.pausedStop);
      try {
        const state = absentAuthor
          ? { id: "", workspaceId: original.workspaceId, status: "closed", active: false, permissions: false, error: "" } as Awaited<ReturnType<Adapter["observe"]>>
          : await this.engine.host.observe(original.agentId!);
        const report = revision ? revision.completion : original.completion;
        if (report && !["blocked","error"].includes(report.status) && (original.phase !== "changes_requested" || revision)) {
          if(original.failoverReason)this.store.update(original.id,{failoverReason:"",replacementProfile:null},"worker_recovered","Worker completed successfully before replacement");
          continue;
        }
        // Resolution owns worker revisions; the initial worker has no Run row
        // and keeps its bounded continuation state on the task itself.
        const erroredWithoutTurn = state.status === "error" && !state.active && !state.activeTurnId && !state.permissions;
        // The event identifies this observation so an owner route can lift the
        // exclusion without the same failed run immediately recreating it.
        const retry = revision?.transientProviderRetry ?? original.transientProviderRetry;
        const deliveryUnsettled = retry && ['intent', 'sent', 'uncertain'].includes(retry.status);
        const seenProfileFailure = this.store.eventsAll(original.id).some(event => {
          if (event.kind !== 'worker_excluded') return false;
          try { const detail = JSON.parse(event.detail); return detail.authority === 'profile failure' && detail.runId === (revision?.id ?? original.runId); }
          catch { return false; }
        });
        if (!pausedStopHeld && erroredWithoutTurn && !deliveryUnsettled && !original.failoverReason &&
            profileFailure(state.error) && !seenProfileFailure && !workerProfileIsExcluded(original, original.profile.id)) {
          const reason = `Profile failure: ${state.error}`.slice(0, 2000);
          const profileId = original.profile.id;
          this.store.update(original.id, {
            workerExclusions: [...original.workerExclusions, { agentId: null, profileId, reason, createdAt: now() }],
            failoverReason: reason,
          }, 'worker_excluded', JSON.stringify({ agentId: null, profileId, reason, authority: 'profile failure', runId: revision?.id ?? original.runId }));
        }
        const armed = this.store.task(original.id);
        if (!pausedStopHeld && revision && state.status === 'error' && !armed.failoverReason &&
            await this.resolution.resumeTransientProviderThread(original, revision, state)) continue;
        // An errored retained worker gets the same-thread transient continuation
        // opportunity before the no-active-turn observation arms failover. The
        // error status alone does not prove that the existing thread cannot resume.
        if (!pausedStopHeld && !revision && !armed.failoverReason && await this.resolution.resumeTransientWorker(armed, state)) continue;
        const assignedGroup = original.profileGroup ?? this.store.pool().find(p=>p.profileId===original.profile!.id)?.group;
        const availabilityRow = assignedGroup
          ? this.store.db.prepare("SELECT data FROM availability WHERE group_id=?").get(assignedGroup)
          : null;
        const assignedAvailability = availabilityRow ? JSON.parse(String(availabilityRow.data)) : null;
        const assignedGroupUnavailable = Boolean(assignedAvailability && groupIsUnavailable(assignedAvailability));
        if (!pausedStopHeld && !original.failoverReason && (!report || ["blocked","error"].includes(report.status)) && (isQuotaExhaustion(state.error) || assignedGroupUnavailable)) {
          if (startsNoRuns(this.store, this.engine.stopped)) return;
          const group = assignedGroup;
          if (!group) { this.engine.note(original.id,"Exhausted provider has no recorded subscription group; inspect routing", 'operator_needed', "needs_attention");continue; }
          const reason = isQuotaExhaustion(state.error) ? state.error : String(assignedAvailability.reason || `Subscription group ${group} is unavailable`);
          this.store.transaction(()=>{
            if(!assignedGroupUnavailable)this.store.setAvailability(group,JSON.stringify({group,unavailable:true,reason:reason.slice(0,2000),retryAt:providerRetryAt(state.error,report?.providerRetryAt)}));
            this.store.update(original.id,{failoverReason:reason.slice(0,2000)},assignedGroupUnavailable?"provider_unavailable":"provider_exhausted",`${group}: ${reason.slice(0,2000)}`);
          });
        }
        let task = this.store.task(original.id);
        if (erroredWithoutTurn && !task.failoverReason && !pausedStopHeld) {
          const detail = `agent_errored: ${String(state.error || "no error detail").slice(0, 400)}`;
          this.store.update(task.id, { failoverReason: detail }, "worker_agent_errored", detail);
          task = this.store.task(task.id);
        }
        // Task 646: a rate-limited group paces new launches. Record the short
        // cool-down in capacity state so this and later selections prefer
        // other eligible profiles while the group recovers. A later 429
        // without Retry-After never shortens a provider deadline recorded
        // earlier.
        if (isRateLimitError(state.error)) {
          const pacedGroup = task.profileGroup ?? this.store.pool().find(entry => task.profile && entry.profileId === task.profile.id)?.group ?? null;
          if (pacedGroup) {
            const row = this.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get(pacedGroup) as { data: string } | undefined;
            this.store.setAvailability(pacedGroup, rateLimitCooldownData(row?.data, state.error, pacedGroup));
          }
        }
        const failover = planWorkerFailover(task, state, erroredWithoutTurn, {
          store: this.store,
          profiles: this.engine.profiles,
          catalogKnown: () => this.engine.profileCatalogKnown(),
          suppressed: () => this.resolution.suppressAutomaticRetry(task, 'provider_failover',
            task.completion?.summary ?? task.failoverReason, task.runId),
          unavailableGroups: () => unavailableGroupNames(this.store.availability()),
          retainedProfileIssue: () => this.resolution.retainedWorkerProfileIssue(task),
          providerUnavailable: () => this.engine.workerProviderUnavailable(task),
        });
        if (failover.kind === "skip") continue;
        if (failover.kind === "workspace_changed") throw new Error("Exhausted worker workspace changed");
        if (failover.kind === "wait_old_worker") { this.engine.note(task.id,"Provider exhausted; waiting for the old worker to stop", 'provider_unavailable');continue; }
        if (failover.kind === "suppress") {
          this.store.update(task.id, { failoverReason: '', phase: 'needs_attention' }, 'automatic_retry_suppressed_settled',
            'Provider failover relaunch suppressed by the owner; retained completion and evidence remain current');
          continue;
        }
        if (failover.kind === "ceiling") {
          this.engine.note(task.id, `${replacementCeilingRefusal(task)}. Nothing was retired and no worker was created`, 'operator_needed', "needs_attention");continue;
        }
        if (failover.kind === "catalog_pending") { this.resolution.waiting(this.store.task(task.id), PROFILE_CATALOG_PENDING_REASON, 'lifecycle'); continue; }
        if (failover.kind === "refuse_instruction") {
          const cause = failover.cause;
          this.store.transaction(()=>{
            this.store.update(task.id,{phase:'needs_attention',reason:`Replacement worker instruction refused: ${cause}`,failoverReason:'',replacementProfile:null},'instruction_refused',`${task.failoverReason} :: ${cause}`);
          });
          continue;
        }
        if (failover.kind === "refuse_unavailable") {
          this.engine.note(task.id,"Provider exhausted; no eligible replacement until an unavailable subscription group resets", 'provider_unavailable', "needs_attention");continue;
        }
        if (failover.kind === "refuse_route") {
          const cause = failover.cause;
          this.resolution.recordStop(this.store.task(task.id),'route_unavailable',`No eligible ${task.workerExclusions.length?'unexcluded ':''}replacement worker: ${cause}`,['restart','route'],'needs_attention');continue;
        }
        if (failover.kind === "refuse_same_model") {
          this.store.event(task.id, "worker_replacement_refused",
            "same_model_no_failure: automatic selection without an approved worker route or a failure never replaces the retained worker; the arm is cleared and the worker continues");
          this.store.update(task.id, { failoverReason: "", replacementProfile: null }, "worker_replacement_refused",
            "automatic selection without an approved worker route or a failure never replaces the retained worker");
          continue;
        }
        if (failover.kind === "refuse_superseded") {
          const refusal = failover.refusal;
          if (!refusal.allowed) {
            this.store.event(task.id, "worker_replacement_refused", `${refusal.rule}: ${refusal.detail}`);
            this.store.update(task.id, { failoverReason: "", replacementProfile: null }, "worker_replacement_refused", refusal.detail);
          }
          continue;
        }
        if (failover.kind === "refuse_rule") {
          const decision = failover.decision;
          this.store.event(task.id, "worker_replacement_refused", `${decision.rule}: ${decision.detail}`);
          this.store.update(task.id, { failoverReason: "", replacementProfile: null }, "worker_replacement_refused", decision.detail);
          continue;
        }
        const { selected, replacingStoppedRevision, replacingStoppedWorker } = failover;
        for (const old of task.retiredWorkers) {
          const s=await this.engine.host.observe(old.agentId);
          if(s.workspaceId!==task.workspaceId||s.active||s.permissions||!["idle","closed","error"].includes(s.status))throw new Error("An earlier worker still owns the workspace");
        }
        if (!this.adapter.verifyResume) throw new Error("Adapter cannot verify continuation worktrees");
        await this.adapter.verifyResume(task);
        if (startsNoRuns(this.store, this.engine.stopped)) return;
        this.store.transaction(()=>{
          if(revision)this.store.putRun({...this.store.run(revision.id)!,released:true,status:"superseded"});
          const retirementReason=[task.failoverReason,...(task.resolution.prePrResumeInstruction?[`Authorized pre-PR continuation instruction: ${task.resolution.prePrResumeInstruction}`]:[])].filter(Boolean).join("; ").slice(0,14000);
          this.store.update(task.id,{phase:"dispatching",retiredWorkers:[...task.retiredWorkers,...(task.agentId?[{agentId:task.agentId,runId:task.runId!,profile:task.profile!,reason:retirementReason}]:[])],...(task.agentId?{}:{continuesWorkspace:true}),
            profile:selected.profile,profileGroup:selected.entry.group,agentId:null,runId:null,transientProviderRetry:undefined,agentIntent:false,completion:null,prHead:null,agentActive:null,lastObservedAt:null,lastAgentStatus:null,idleSince:null,failoverReason:"",replacementProfile:null,workerModel:null,workerModels:[...new Set([...task.workerModels,state.model || task.workerModel || task.profile!.model])],
            resumePrNumber:task.resumePrNumber??task.completion?.prNumber??null,
            resolution:{...task.resolution,currentRunId:null,attention:false,
              ...(task.resolution.prePrResumeInstruction?{prePrResumeInstruction:null}:{}),...(task.failoverReason.startsWith(OPERATOR_WORKER_REMAP_REASON)||replacingStoppedRevision||replacingStoppedWorker?{recoveryActive:false,recoveryAttempts:0,recovery:null}:{})},
            reason: "Replacing stopped worker in the existing workspace"},"worker_replacement",selected.profile.name);
          this.store.chargeAssignment(selected.entry.group,selected.profile.id);
        });
        await this.engine.launchAgent(this.store.task(task.id));
      } catch(error) {
        // A daemon drop is not a task fault: parking here put every working task in
        // needs_attention when Paseo restarted (2026-09-29, eleven tasks at 13:56:59).
        if (isTransportFailure(error)) { this.resolution.transportDeferred(this.store.task(original.id), error); continue; }
        if(!this.store.getMeta("paused"))this.engine.note(original.id,error instanceof Error?error.message:String(error), 'classify', "needs_attention");
      }
    }
  }
}
export { decideWorkerFailover, type WorkerFailoverDecision, type WorkerFailoverFacts };
