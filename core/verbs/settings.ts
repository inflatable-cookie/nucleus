import { parseAgentId, sameCallerIdentity } from '../../shared/agent-identity';
import { REMOVED_TASK_REFUSAL } from './control-refusals';
import type { ReparentInput, Task, TaskControlInput } from "../../shared/contracts";
import { OPERATOR_BOARD_CALLER, defaultHoldKind, holdOwnerOf, holdsOf, parseHoldUntil } from "../../shared/contracts";
import { groupIsUnavailable } from "../../shared/pool";
import type { Engine } from "../engine";
import { repositoryOrigin } from "../planning/lanes";
import { holdPatch, keepPatch, releasePatch, OPERATOR_HOLD_OWNER } from "../merge/merge-hold";
import { coveringGrant, grantSignoff } from "../dispatch/routing-grants";
import { boardSignoff, OPERATOR_BOARD, priorNonGrantSignoff, reconcileRoutingSignoffs, withdrawOpen } from "../dispatch/routing-signoff";
import { plainProfileRequest, validateNamedProfile, workerThinking, workerThinkingConflict } from "../dispatch/routing";
import { now } from "../store/store";
import { plannerIdMatches } from "../recovery/task-reasons";

/**
 * The owner verbs that change a task's settings and nothing else: lanes, routing,
 * worker exclusions, dependencies, notes and holds, completion subscriptions and
 * the task's owner. Same-name `Engine` methods delegate here.
 */
export class SettingsControls {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  async applyTaskControlSetLane(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> {
    const task = this.store.task(input.taskId);
    if (task.removedAt) throw new Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(task, input.version, "Task changed; refresh before retrying");
    const lanes = input.lanes ?? (input.lane === undefined || input.lane === null ? [] : [input.lane]);
    const origin = lanes.length ? await repositoryOrigin(task.repoPath) : null;
    // The awaited origin read may be accompanied by a lifecycle observation of this
    // task. Revalidate the admitted facts and write from the validated record: an
    // observation-only advance applies, and a substantive change (removal, phase,
    // holds, disposition, merge intent, another lane edit) still refuses before the
    // guarded lane write. The write itself stays version-guarded.
    const current = this.store.task(task.id);
    if (current.removedAt) throw new Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(current, input.version, "Task changed during the lane attachment; refresh before retrying");
    const result = this.store.setTaskLanes(current, lanes, origin);
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    return operated(result);
  }
  applyTaskControlSetRouting(input: TaskControlInput, operated: <T>(result: T) => T): Task {
    const apply=()=>{
      const task=this.store.task(input.taskId);
      if(task.removedAt)throw Error(REMOVED_TASK_REFUSAL);
      this.engine.requireOwnerControlCurrent(task,input.version,"Task changed; refresh before retrying");
      if (input.critical !== undefined) {
        if (!this.engine.forcePlanners(task).some(id => plannerIdMatches(id, input.caller ?? '')) && input.caller !== OPERATOR_BOARD_CALLER)
          throw Error('Only the planner or operator may change critical');
        const other = ['scope','complexity','preferredProfileId','requirePreferred','thinkingOptionId','profileRequests'].some(key => (input as Record<string, unknown>)[key] !== undefined);
        if (!other) return operated(this.store.update(task.id, {critical: input.critical}, 'critical_changed', JSON.stringify({critical:input.critical, caller:input.caller, reason:input.reason})));
      }
      if(task.agentIntent||task.agentId)throw Error("Worker dispatch already started; use restart (fresh: true to replace the worker)");
      if(!["queued","needs_attention"].includes(task.phase))throw Error("Routing changes require a queued task or pre-dispatch attention");
      const before={scope:task.scope,complexity:task.complexity??null,preferredProfileId:task.preferredProfileId,requirePreferred:task.requirePreferred,thinkingOptionId:task.thinkingOptionId,profileRequests:task.profileRequests};
      const requests={...task.profileRequests};
      // Spec 050: the `ownerRoute` marker is route-only. `set_routing`
      // stores the plain request so a same-model reviewer never inherits the
      // owner-route independence waiver (which needs a recorded waiver).
      // Spec 052: a set_routing from the operator's board is its own sign-off; a relayed one is asked.
      for(const role of ["worker","reviewer","coordinator"] as const){const request=input.profileRequests?.[role];if(request===null)delete requests[role];else if(request){const board=input.caller===OPERATOR_BOARD&&!input.relayed;const prior=!board?priorNonGrantSignoff(this.store,task.id,role,request.profileId):null;const grant=!board?coveringGrant(this.store,task,request.profileId):null;const carry=prior&&(prior.status==="approved"||(prior.status==="declined"&&grant))?prior:null;requests[role]={...plainProfileRequest(request),...(input.caller?{requestedBy:input.caller}:{}),...(board?{signoff:boardSignoff()}:carry?{signoff:carry}:grant?{signoff:grantSignoff(grant)}:{})};}}
      const after={critical:input.critical??task.critical,scope:input.scope??task.scope,complexity:input.complexity!==undefined?input.complexity:task.complexity??null,preferredProfileId:input.preferredProfileId??task.preferredProfileId,requirePreferred:input.requirePreferred??task.requirePreferred,thinkingOptionId:input.thinkingOptionId??task.thinkingOptionId,profileRequests:requests};
      const pool=this.store.pool();
      const conflict=workerThinkingConflict(input.thinkingOptionId,input.profileRequests?.worker);
      if(conflict)throw Error(conflict);
      // An explicit top-level level replaces a level stored on the worker request.
      if(input.thinkingOptionId!==undefined&&after.profileRequests.worker?.thinkingOptionId&&!input.profileRequests?.worker){const {thinkingOptionId:_drop,...rest}=after.profileRequests.worker;after.profileRequests={...after.profileRequests,worker:rest};}
      // Only a named profile can be falsely called absent before the catalog loads;
      // complexity- or scope-only routing applies on an unrefreshed engine (QA 622c955c).
      if(after.preferredProfileId||Object.values(after.profileRequests).some(request=>Boolean(request?.profileId)))this.engine.requireProfileCatalog();
      if(after.preferredProfileId)validateNamedProfile(after.preferredProfileId,"worker",after.scope,this.engine.profiles,pool,after.profileRequests.worker?.profileId===after.preferredProfileId?after.profileRequests.worker.reason:"",workerThinking(after));
      for(const role of ["worker","reviewer","coordinator"] as const){
        const request=after.profileRequests[role];
        if(!request)continue;
        const thinking=role==="worker"?workerThinking(after):request.thinkingOptionId??"";
        const {profile}=validateNamedProfile(request.profileId,role,after.scope,this.engine.profiles,pool,request.reason,thinking);
        if(thinking&&!profile.supportedThinking.includes(thinking))throw Error(`Profile ${request.profileId} does not support thinking option ${thinking}`);
      }
      const routingConflict=this.engine.independentReviewRoutingRefusal({scope:after.scope,preferredProfileId:after.preferredProfileId,requirePreferred:after.requirePreferred,profileRequests:after.profileRequests,skipPRReview:task.skipPRReview,declaredAuthorModels:task.reviewEntry?.authorDeclaration.models});
      if(routingConflict)throw Error(routingConflict);
      const unavailable=pool.filter(entry=>[after.preferredProfileId,...Object.values(after.profileRequests).map(request=>request?.profileId)].includes(entry.profileId)).flatMap(entry=>{
        const row=this.store.db.prepare("SELECT data FROM availability WHERE group_id=?").get(entry.group);
        const status=row?JSON.parse(String(row.data)):null;
        return status&&groupIsUnavailable(status)?[`${entry.group}: ${status.reason}${status.retryAt?` (retry ${status.retryAt})`:""}`]:[];
      });
      const changed=operated(this.store.update(task.id,after,"routing_changed",JSON.stringify({before,after,reason:input.reason,authority:input.relayed?`relayed: ${input.note}`:"operator (board)",warning:unavailable.length?`Unavailable groups: ${[...new Set(unavailable)].join("; ")}`:undefined})));
      // A replaced or removed request takes its open sign-off question with it.
      for(const role of ["worker","reviewer","coordinator"] as const){const old=task.profileRequests?.[role]?.signoff;if(old?.status==="pending"&&old.decisionId&&input.profileRequests?.[role]!==undefined)withdrawOpen(this.engine.signoffDecisions,old.decisionId,"The role's routing was changed");}
      return changed;
    };
    return this.store.db.isTransaction?apply():this.store.transaction(apply);
  }
  applyTaskControlExcludeWorker(input: TaskControlInput, operated: <T>(result: T) => T): Task {
    const result=this.store.transaction(()=>{
      const task=this.store.task(input.taskId);
      if(task.removedAt)throw Error(REMOVED_TASK_REFUSAL);
      this.engine.requireOwnerControlCurrent(task,input.version,"Task changed; refresh before retrying");
      this.engine.rejectFenced(task,"worker exclusion");
      if(["done","cancelled"].includes(task.phase)||task.resolution.mergeIntent||task.resolution.mergedCommit)
        throw Error("Worker exclusion requires a live, unmerged task");
      const target=input.workerExclusion!;
      const agentId=target.agentId??null,profileId=target.profileId??null;
      if(task.workerExclusions.some(exclusion=>exclusion.agentId===agentId&&exclusion.profileId===profileId))
        throw Error("That worker is already excluded from this task");
      const exclusion={agentId,profileId,reason:input.reason!,createdAt:now()};
      const currentWorkerMatches=Boolean(task.agentId&&agentId===task.agentId||task.profile?.id&&profileId===task.profile.id);
      const failoverReason=currentWorkerMatches
        ? [task.failoverReason,`Planner/operator excluded ${agentId?`worker agent ${agentId}`:`worker profile ${profileId}`}: ${input.reason}`].filter(Boolean).join("; ").slice(0,2000)
        : task.failoverReason;
      const authority=input.relayed?`relayed: ${input.note}`:"operator (board)";
      return this.store.update(task.id,{workerExclusions:[...task.workerExclusions,exclusion],...(currentWorkerMatches?{failoverReason}:{})},
        "worker_excluded",JSON.stringify({agentId,profileId,reason:input.reason,authority}));
    });
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    return operated(result);
  }
  applyTaskControlLocal(input: TaskControlInput, operated: <T>(result: T) => T): Task {
    const result = this.store.transaction(() => {
      const task = this.store.task(input.taskId);
      if (task.removedAt) throw new Error(REMOVED_TASK_REFUSAL);
      this.engine.requireOwnerControlCurrent(task, input.version, "Task changed; refresh before retrying");
      if (input.action === "promote") return this.store.promoteQueuedTask(task);
      if (input.action === "set_dependencies") return this.store.updateDependencies(task, input.dependsOn ?? []);
      if (input.action === "set_prerequisite_wait")
        return this.store.setPrerequisiteWait(task, input.waitsFor ?? [], input.reason!, task.version);
      if (input.action === "note") {
        this.store.event(task.id, "coordination_note", input.message!);
        return task;
      }
      if (
        input.action === "keep_hold" ||
        input.action === "hold" ||
        input.action === "release"
      )
        return this.engine.applyTaskControlHold(input, task);
      throw new Error("This action is only available before dispatch");
    });
    if (input.action !== "release") {
      void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
      void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    }
    return operated(result);
  }
  applyTaskControlHold(input: TaskControlInput, task: Task): Task {
    // Independent dispatch and merge fences. Default kind is dispatch while
    // queued and merge after dispatch. Each kind has its own owner, reason,
    // generation and until; the other fence is left in place.
    const kind = input.kind ?? defaultHoldKind(task);
    const fences = holdsOf(task);
    const other = kind === "dispatch" ? "merge" : "dispatch";
    // Placing or renewing a hold applies only before the merge is requested; a
    // release always applies, so a hold left on a merged or terminal task never
    // strands it (Project-c #089, 2026-10-19: a cancelled task's dispatch hold blocked
    // its retirement with no owner exit).
    if (input.action !== "release" && (task.resolution.mergeIntent || task.resolution.mergedCommit || ["done", "cancelled"].includes(task.phase)))
      throw new Error("Merge hold applies only before the merge is requested");
    if (input.action === "keep_hold") {
      if (!fences[kind]) {
        throw new Error(fences[other]
          ? `Keep applies only to a ${kind} hold; pass kind: "${other}" to renew the ${other} hold, or use hold to place a ${kind} hold`
          : `Keep applies only to a ${kind} hold; use hold to place a ${kind} hold`);
      }
      const kept = this.store.update(task.id, keepPatch(task, kind, input.reason!, input.agentId), "hold_kept", input.reason);
      const fence = holdsOf(kept)[kind];
      this.store.event(task.id, "hold_kept", `generation ${fence?.generation ?? kept.holdGeneration}; ${kind}; ${holdOwnerOf(kept, fence?.owner ?? kept.holdOwner)}: ${input.reason}`);
      return kept;
    }
    if (input.action === "hold") {
      if (fences[kind]) throw new Error(`Task is already under a ${kind} hold; use keep_hold to renew the ${kind} hold with a new reason`);
      const until = input.until ? parseHoldUntil(input.until) : null;
      if (until?.kind === "task" && until.taskId === task.id) throw new Error("A hold cannot wait for its own task");
      const owner = input.agentId ?? OPERATOR_HOLD_OWNER;
      return this.store.update(task.id, holdPatch(task, kind, owner, input.reason!, until), kind === "merge" ? "merge_hold" : "hold",
        kind === "merge" ? `Merge held by ${owner}: ${input.reason}${input.until ? ` (until ${input.until})` : ""}` : input.action);
    }
    if (!fences[kind]) {
      throw new Error(fences[other]
        ? `No ${kind} hold to release; pass kind: "${other}" to release the ${other} hold`
        : `No ${kind} hold to release`);
    }
    return this.store.update(task.id, releasePatch(task, kind), kind === "merge" ? "merge_release" : "release",
      kind === "merge" ? "Merge hold released" : input.action);
  }
  async completionSubscription(input:{taskId:string;version:number;agentId:string;action:"subscribe"|"unsubscribe"}):Promise<Task>{
    return this.engine.control(async()=>{
      const task=this.store.task(input.taskId);
      this.engine.requireOwnerControlCurrent(task,input.version,"Task changed; refresh before retrying");
      if(task.removedAt||["done","cancelled"].includes(task.phase))throw Error("Completion subscriptions are closed for terminal tasks");
      if(!this.adapter.originAgent)throw Error("Live agent identity validation is unavailable");
      let agent;
      try{
        const hostId = parseAgentId(input.agentId)?.hostId ?? await this.engine.identifyOriginHost(input.agentId);
        agent = hostId
          ? await this.engine.withHost(hostId, () => this.engine.host.originAgent(input.agentId))
          : await this.engine.host.originAgent(input.agentId);
      }
      catch(error){throw Error(`Completion recipient ${input.agentId} identity is unreadable (${error instanceof Error?error.message:String(error)}); refusing unknown evidence`)}
      // The awaited identity read may be accompanied by a lifecycle observation of
      // this task. Revalidate the admission, then derive every terminal, recipient
      // and override fact from the validated record: an observation-only advance
      // applies on the current overrides, while a substantive change (terminal
      // transition, another subscription edit, removal) refuses before the write.
      const current=this.store.task(task.id);
      if(current.removedAt||["done","cancelled"].includes(current.phase))throw Error("Completion subscriptions are closed for terminal tasks");
      this.engine.requireOwnerControlCurrent(current,input.version,"Task changed during the recipient observation; refresh before retrying");
      const live=Boolean(agent&&!agent.archived&&agent.workspaceId);
      // Adding a subscription needs a fresh live identity. Removing one is how an
      // archived or missing recipient that Queue already recorded (a creator
      // nomination or its own subscription) leaves a task's future cohort, so it
      // runs on the durable workspace binding that record holds (Spec 040).
      if(!live&&input.action!=="unsubscribe")throw Error("Completion subscription requires a live Paseo agent with a workspace");
      const recorded=current.completionSubscriptionOverrides.find(entry=>sameCallerIdentity(entry.agentId,input.agentId))
        ??current.creatorCompletionRecipients.find(recipient=>sameCallerIdentity(recipient.agentId,input.agentId));
      if(!live&&!recorded)throw Error(`Completion unsubscribe for ${input.agentId} needs a recorded recipient or subscription; no durable workspace evidence exists`);
      if(!live&&agent?.workspaceId&&recorded&&agent.workspaceId!==recorded.workspaceId)
        throw Error(`Completion recipient ${input.agentId} is observed in workspace ${agent.workspaceId}, not its recorded ${recorded.workspaceId}; refusing mismatched evidence`);
      const workspaceId=live?agent!.workspaceId!:recorded!.workspaceId;
      const overrides=current.completionSubscriptionOverrides.filter(entry=>!sameCallerIdentity(entry.agentId,input.agentId));
      overrides.push({agentId:input.agentId,workspaceId,subscribed:input.action==="subscribe"});
      return this.store.update(current.id,{completionSubscriptionOverrides:overrides.sort((a,b)=>a.agentId.localeCompare(b.agentId))},
        input.action==="subscribe"?"completion_subscribed":"completion_unsubscribed",`${input.agentId} in workspace ${workspaceId}`,current.version);
    }, `task:${input.taskId}`);
  }
  reparent(input:ReparentInput){
    return this.engine.control(async () => {
      const result = await this.resolution.origins.reparent(input);
      if (this.engine.profileCatalogKnown()) {
        for (const change of result.changed) reconcileRoutingSignoffs(this.store, this.engine.signoffDecisions, change.taskId, this.engine.profiles);
      }
      return result;
    }, "control:origin");
  }
}
