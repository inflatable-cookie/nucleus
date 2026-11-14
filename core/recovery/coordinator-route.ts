import { taskStopVerbsFor } from '../../shared/task-stop';
import { reviewContinuationState, reviewFenceHoldsCoordinators } from '../review/review-continuation';
import { isSshAuthExhausted } from '../../shared/ssh-auth';
import { randomBytes, randomUUID } from 'node:crypto';
import { digest, now } from '../store/store';
import type { Completion, Run, Task } from '../../shared/contracts';
import { RETAINED_WORKER_PROFILE_REASON, incidentBindsCurrentWork } from '../../shared/contracts';
import { isDispositionActive, isDispositionComplete } from '../../shared/contracts';
import { dispatchBlocked, DISPATCH_HELD_REASON } from '../dispatch/capacity';
import { isCloseoutHookHold } from '../hooks/hooks';
import { automaticIncidentPending } from './incident';
import type { AgentObservation } from '../host/adapter';
import { isRepositoryContention, repositoryContentionNeedsAttention } from '../scheduling/repository-contention';
import { collectOwnerVerbFacts } from '../verbs/owner-verbs';
import { COORDINATOR_LOOP_LIMIT, COORDINATOR_LOOP_SUMMARY, taskWorkIdentity, unproductiveCoordinatorRuns } from './recovery-bound';
import { recoveryDispatchSnapshot, type RecoveryDispatchSnapshot } from './recovery-context';
import { groupIsUnavailable, supersedingRouteProfile } from '../../shared/pool';
import { requiredCheckPollMetaKey } from '../forge/checks';
import { RECOVERY_CREATION_FAILURE_PREFIX } from './task-reasons';
import { unreleasedExecutorRun } from '../qa/proof-execution';
import { CoordinatorEpisode, cause, key, needsAttention, type RecoveryContext } from './coordinator-episode';
import { coordinatorReportMatches, taskProgressDigest } from './coordinator-report';
import { isPseudoCheckpointError, postBudgetPrePrResumes, pseudoCheckpointEscalation } from './pseudo-checkpoint';

/** Open-PR identity or leftover proof wait after a verified merge: Resolution closes out; a coordinator cannot. */
const mergedCloseoutNeedsNoCoordinator=(t:Task)=>{
 const text=`${t.reason}\n${t.resolution.stop?.detail??''}`;
 return /PR must be open/.test(text)||t.resolution.stop?.reason==='awaiting_proof';
};
const recoveryTarget=(task:Task,run:Run|null):"worker"|"reviewer"|"coordinator"|"closeout"|"unknown"=>{
 // nucleus#1195: a proof executor run is proof execution, never a recovery
 // rerun of worker or review work, so it never names their role.
 if(run?.role==='executor')return 'unknown';
 if(run?.role==='reviewer')return 'reviewer';
 if(run?.role==='revision')return 'worker';
 if(run?.role==='closeout')return 'closeout';
 if(['dispatching','working','changes_requested','blocked','error'].includes(task.phase))return 'worker';
 if(['awaiting_review','reviewing'].includes(task.phase))return 'reviewer';
 if(task.phase==='closing')return 'closeout';
 if(['verifying','merging','syncing'].includes(task.phase))return 'coordinator';
 return 'unknown';
};

/**
 * The recovery route: whether this task needs a coordinator episode at all, and
 * the one launch that opens it. Every wait, fence and owner decision that keeps a
 * coordinator out lives here, so the pass that observes a running coordinator and
 * the episode that records its result never restate them.
 */
export class CoordinatorRoute {
 constructor(readonly resolution:RecoveryContext, readonly episode:CoordinatorEpisode){}
 get store(){return this.resolution.store}
 busy(t:Task){return this.episode.busy(t)}
 /** Engine-provided Spec 058 mechanical settlement for an opted-in responsible task. */
 private responsibleFaultHandler:((task:Task)=>Promise<boolean>)|null=null;
 setResponsibleFaultHandler(handler:(task:Task)=>Promise<boolean>){this.responsibleFaultHandler=handler;}
 /**
  * The plan `next` derives for the stop this coordinator is asked about. A read
  * failure yields no snapshot rather than refusing the dispatch: the prompt then
  * points the coordinator at the refresh command.
  */
 launchSnapshot(t:Task,run:Run,cause:string|null,target:string):RecoveryDispatchSnapshot|null{
  try{return recoveryDispatchSnapshot(collectOwnerVerbFacts(this.store,t),{cause,target,recoveryRunId:run.id});}
  catch{return null;}
 }
 /**
  * The author's own `blocked` report when it is the latest result on the task:
  * it asks the owner for a scope or acceptance decision, which a coordinator
  * cannot make (Tom, 2026-10-15). The latest result wins across roles, so a
  * newer reviewer block keeps the coordinator path. A replaced (retired)
  * worker's revisions are history, and the current worker's initial result is
  * timed by its `completion_received` event.
  */
 authorBlockedReport(t:Task,runs:Run[]):Completion|null{
  if(t.phase!=='blocked')return null;
  const retired=new Set((t.retiredWorkers??[]).map(worker=>worker.agentId));
  const results:{at:string;author:boolean;completion:Completion}[]=runs
   .filter(r=>r.role!=='recovery'&&r.completion&&!(r.role==='revision'&&r.agentId&&retired.has(r.agentId)))
   .map(r=>({at:r.createdAt,author:r.role==='revision',completion:r.completion!}));
  if(t.completion&&t.completion.runId===t.runId){
   const received=this.store.db.prepare("SELECT at FROM events WHERE taskId=? AND kind='completion_received' ORDER BY id DESC LIMIT 1").get(t.id) as {at:string}|undefined;
   results.push({at:received?.at??'',author:true,completion:t.completion});
  }
  const latest=results.sort((x,y)=>x.at.localeCompare(y.at)).at(-1);
  return latest?.author&&latest.completion.status==='blocked'?latest.completion:null;
 }
 async route(original:Task):Promise<string|null|undefined>{
  if(!this.resolution.adapter.supportsCoordinatorRecovery)return undefined;
  if(this.resolution.startsNoRuns())return null;
  let t=this.store.task(original.id);
  const pendingCheck=t.prHead?this.store.getMeta<{head:string;overdueCheck?:{key:string};recoveryRunId?:string|null;attentionRaisedAt?:number|null}>(requiredCheckPollMetaKey(t.id,t.prHead)):null;
  // One recovery run belongs to an unchanged required check at an exact head.
  // Polls and the later planner attention stay owned by the check wait.
  if(pendingCheck?.head===t.prHead&&pendingCheck.overdueCheck&&(pendingCheck.recoveryRunId||pendingCheck.attentionRaisedAt))return null;
  if(t.entrypoint==='proof'&&t.proofOnly)return null;
  // nucleus#1195: an executor dispatch is proof execution, not a retry of worker
  // or review work. The automatic Spec 058 start and the owner `proof`
  // activation are classified as proof execution, so while a declared proof is
  // dispatched and unreleased the receipt owns the next move: no recovery
  // episode opens, the no-automatic-retry fence is never charged as
  // `recovery_rerun`, and no planner escalation is raised for a proof that is
  // simply running. If that report was lost, `restart role=executor` asks the
  // same executor to resend it.
  if(unreleasedExecutorRun(this.store.runs(t.id),t.resolution.currentRunId))return null;
  // Spec 058 slice 2: an opted-in responsible task settles its mechanical faults
  // by code before any coordinator episode opens. Only a fault code cannot settle
  // reaches the coordinator below.
  if(this.responsibleFaultHandler&&await this.responsibleFaultHandler(t))return null;
  // Queue continues an awaiting reviewer checkpoint itself (Tom, 2026-10-31);
  // every review fence keeps coordinators out.
  // A reviewer past its checkpoint budget has stopped; a coordinator cannot continue it. The same
  // holds when the reviewer's own agent was positively observed closed: no same-run continuation
  // can land. The task escalates through the planner ladder (Spec 058 cutover 5).
  if(reviewContinuationState(t,this.store)==='exhausted'){this.resolution.openReviewContinuationEscalation(this.store.task(t.id),'exhausted');return null;}
  if(reviewContinuationState(t,this.store)==='closed'){this.resolution.openReviewContinuationEscalation(this.store.task(t.id),'closed');return null;}
  if(reviewFenceHoldsCoordinators(t,this.store))return null;
  if(isDispositionActive(t)||isDispositionComplete(t))return null;
  // Spec 058 budgets (nucleus#1153): a budget pause asks its own question through
  // the planner ladder. Its `extend_budget` suggestion is an owner verb, not work
  // a coordinator can settle, so it never opens a coordinator episode.
  if(t.resolution.stop?.reason==='budget')return null;
  if(t.resolution.stop&&!t.resolution.stop.suggestedVerbs.length){
   const stop=t.resolution.stop;
   // A wait on progressing work belongs to the loop that recorded it (dispatch,
   // resolution, the quantum), and exhaustion failover re-evaluates its own wait
   // every sweep. Rechecking those with another predicate cleared live waits.
  if(!needsAttention(t,this.store)||t.failoverReason)return null;
   let waiting=true;
   if(stop.reason==='capacity')waiting=Boolean(this.resolution.slotAdmissionReason(t,true));
   else if(stop.reason==='provider_unavailable'){
    const group=t.profileGroup??this.store.runs(t.id).findLast(run=>run.agentId===t.agentId&&run.profile)?.profileGroup;
    const row=group?this.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get(group):null;
    waiting=Boolean(row&&groupIsUnavailable(JSON.parse(String(row.data))));
   }else if(stop.reason==='route_unavailable'){
    // A coordinator can route the waiting role elsewhere (Tom, 2026-10-19), so
    // the wait holds only while no coordinator is routable either.
    const selection=this.resolution.select(t,'coordinator');
    waiting=!selection;
   }else if(stop.reason==='workspace_unavailable'){
    waiting=!t.workspaceId||Boolean(this.resolution.adapter.workspaceAvailable&&!(await this.resolution.adapter.workspaceAvailable(t.workspaceId)));
   }else if(stop.reason==='prerequisite'){
    const prerequisite=t.prerequisiteWait?this.store.reconcilePrerequisiteWait(t.id):'none';
    t=this.store.task(t.id);
    // Both kinds: a post-dispatch prerequisite wait, and a queued task's pre-dispatch dependsOn.
    waiting=prerequisite!=='none'||Boolean(t.prerequisiteWait&&!t.prerequisiteWait.releasedAt)||Boolean(this.store.dependencyWait(t));
   }
   // Origin activity, PR-head lag and the rest of the ordinary lifecycle waits
   // are rechecked by the task quantum before recovery routing reaches here.
   if(waiting)return null;
   t=this.resolution.update(t,{stop:null},{},'task_wait_cleared',stop.reason);
   // A wait that no longer holds leaves nothing for a coordinator unless the
   // task still needs attention; ordinary progress resumes on its own.
   if(!needsAttention(t,this.store))return null;
  }
  // An open linked decision owns the next move; an unchanged reason must not
  // turn that operator wait into a coordinator recovery attempt.
  if(this.store.listDecisions({status:'open',task:t.id}).length)return null;
  if(t.prerequisiteWait){
   const wait=this.store.reconcilePrerequisiteWait(t.id);
   t=this.store.task(t.id);
   // A wait recorded during a live run or recovery must not strand that work;
   // it pauses new coordinator recovery once the current run has released.
   if(wait!=='none'&&!this.busy(t)&&!this.store.runs(t.id).some(run=>!run.released))return null;
  }
  // A released wait leaves changes requested work for an explicit operator
  // revise/retry; a coordinator must not turn the source completion into one.
  if(t.phase==='changes_requested'&&t.prerequisiteWait?.releasedAt)return null;
  if(this.store.notices(t.id).some(notice=>notice.kind==='prerequisite'&&['pending','intent'].includes(notice.status)))return null;
  // A short integration-checkout conflict is one repository episode, not one
  // recovery and notice per task waiting behind it. Only the elected leader
  // may enter normal recovery after the durable grace expires.
  if(isRepositoryContention(t.reason)&&!repositoryContentionNeedsAttention(this.store,t,t.reason))return null;
  // A repository-hook hold is resolved by retrying the recorded hook event, not
  // by a coordinator recovery run; deliver the plain origin attention notice.
  if(isCloseoutHookHold(t))return undefined;
  // Git already spent its bounded environment retries; a coordinator cannot repair host keys.
  if(isSshAuthExhausted(t.reason))return undefined;
  // An exact automatic replay still owns a held integration-base occurrence
  // inside its bounded window, so coordinator attention waits for it.
  if(this.resolution.automaticHookReplayPending(t))return null;
  if(t.resolution.mergedCommit&&t.resolution.recoveryPhase!=='closeout'&&!this.busy(t))t=this.resolution.update(t,{recoveryPhase:'closeout',recoveryAttempts:0,recovery:null},{},'closeout_recovery_budget');
  // After a verified merge, the open-PR identity check and leftover proof wait
  // are Resolution's closeout path, never a coordinator episode (Queue #673).
  if(t.resolution.mergedCommit&&mergedCloseoutNeedsNoCoordinator(t))return null;
  let incident=t.resolution.recovery;
  if(this.busy(t))return incident?.status==='escalated'?incident.summary:null;
  // Automatic reconciliation owns the fault inside its bounded window; coordinator attention waits for it to finish.
  // Only an incident bound to the current work can hold that wait: one recorded
  // against a released run was superseded by the run that replaced it.
  if(incidentBindsCurrentWork(t,this.store.runs(t.id))&&automaticIncidentPending(t.resolution.incident,this.resolution.graceMs))return null;
  // A live worktree QA, or an incomplete scan of it, is not proven absence. The
  // scan can only change this route's decision while it is holding on a one-shot
  // callback reminder, where absence is what lets a coordinator be launched over
  // running QA: that shape asks freshly, and every other shape makes no scan at
  // all (it fell through to the episode logic whatever the scan said). Repeated
  // reads inside one pass are shared by `validationEvidence`.
  const reminderHeld=t.resolution.incident?.action==='callback_reminder'||/reminder expired/.test(t.reason);
  if(reminderHeld&&this.resolution.validationEvidence(t,{fresh:true}).state!=='absent'){
    const runId=t.resolution.incident?.runId??t.resolution.currentRunId??t.runId;
    if(runId)this.resolution.extendCallbackReminder(this.store.task(t.id),runId);
    return null;
  }
  // Spec 058 (task 542): a worker asks in-turn and keeps going, so a blocked
  // report is not an owner escalation. The stop stays for the operator question
  // sweep and the answered-question resumption.
  const blocked=this.authorBlockedReport(t,this.store.runs(t.id));
  if(blocked)return null;
  let fingerprint=key(t,this.store.runs(t.id));
  // The episode is the same while its stop is, or while the task has not
  // progressed since it opened: a stop churning between a wait and a stop for
  // one condition never opens another episode or undoes an escalation
  // (consumer-b #639, review #542).
  // An episode answers only the work it was opened for: the progress digest
  // records the head, brief, merge state, participants and results at its
  // opening, so a replaced worker, a re-pinned brief or a changed route, head,
  // phase or run was never put to its coordinator
  // and gets its own episode. Legacy episodes recover from the same current
  // facts; nothing is reconstructed from their history.
  const sameEpisode=Boolean(incident)&&coordinatorReportMatches(t)
    &&(incident!.key===fingerprint||Boolean(incident!.progress&&incident!.progress===taskProgressDigest(t)));
  let previousRefusal: string | null = incident?.status==='pending' && incident.action?.status==='refused' ? incident.action.reason ?? incident.summary : null;
  let refusedAction = incident?.status==='pending' && incident.action?.status==='refused' ? incident.action : null;
  if(incident&&sameEpisode&&incident.status==='resolved'&&incident.action?.status==='refused'){
   // A refused choice did not settle the stop. Give the coordinator one more
   // charged launch with the refusal and the refreshed owner-verb snapshot.
   // A second refusal climbs the existing planner escalation ladder.
   const refusal=incident.action.reason ?? incident.summary;
   const runs=this.store.runs(t.id).filter(run=>run.role==='recovery').slice(-2);
   const refused=new Set(this.store.eventsAll(t.id).filter(event=>event.kind==='coordinator_action_refused').map(event=>event.detail));
   const charged=unproductiveCoordinatorRuns(this.store,t.id);
   if((charged>=2&&runs.length===2&&runs.every(run=>run.completion&&refused.has(run.completion.eventId))) || charged>=COORDINATOR_LOOP_LIMIT){
    const summary=`Coordinator actions were refused: ${refusal}`;
    this.store.transaction(()=>{
     this.episode.escalate(t,summary);
     this.resolution.escalateRefusedCoordinator(this.store.task(t.id),summary);
    });
    return summary;
   }
   previousRefusal=refusal;
   refusedAction=incident.action;
   incident=null;
  }
  if(incident&&sameEpisode){
   if(incident.status==='resolved'||incident.status==='uncertain'||incident.status==='escalated')return incident.summary||null;
   if(incident.status==='nudged'){
    const idle=await this.resolution.idle(incident.agentId!).catch(()=>false);
    if(this.resolution.startsNoRuns())return null;
    if(!idle){this.episode.save(t,{idleSince:null});return null;}
    if(!incident.idleSince){this.episode.save(t,{idleSince:now()});return null;}
    if(Date.now()-Date.parse(incident.idleSince)>=this.resolution.graceMs)return this.episode.escalate(t,'The coordinator stopped after a reporting reminder, but this issue still needs attention. Inspect its result or provide the missing decision.');
    return null;
   }
  }else{
   // A new episode is always keyed by the stop it answers, so the coordinator's
   // action can match it; a task reaching here without one records it first.
   // An existing episode keeps the key it was opened with.
   if(!t.resolution.stop){
    t=this.resolution.recordStop(t,'operator_needed',cause(t,this.store.runs(t.id)).slice(0,4000)||'Task needs attention',taskStopVerbsFor('operator_needed'));
    fingerprint=key(t,this.store.runs(t.id));
   }
   // Circuit breaker (Tom, 2026-10-19, after consumer-b #639): coordinator runs
   // that apply nothing must never loop, whatever reopens the episode. After
   // COORDINATOR_LOOP_LIMIT runs with no applied coordinator action and no owner
   // or operator control since, Queue launches no further coordinator for the
   // task and escalates to its owner; the owner's next verb resets the count.
   if(unproductiveCoordinatorRuns(this.store,t.id)>=COORDINATOR_LOOP_LIMIT)return this.episode.escalate(t,COORDINATOR_LOOP_SUMMARY);
   incident={id:randomUUID(),key:fingerprint,generation:t.coordinatorGeneration,runId:null,agentId:null,status:'pending',summary:'',idleSince:null,
    incidentId:t.resolution.incident?.status==='resolved'?null:t.resolution.incident?.id??null,progress:taskProgressDigest(t),
    ...(refusedAction ? {action:refusedAction} : {})};
   t=this.resolution.update(t,{recovery:incident},{},'recovery_pending');
  }
  if(t.reason.startsWith(RETAINED_WORKER_PROFILE_REASON))return this.episode.escalate(t,t.reason);
  // Project-a #1980: a pseudo-checkpoint error already resumed once pre-PR
  // escalates to the planner instead of launching another recovery loop.
  if(isPseudoCheckpointError(t)&&postBudgetPrePrResumes(this.store.eventsAll(t.id))>=1)
    return this.episode.escalate(t,pseudoCheckpointEscalation(t));
  if(!t.workspaceId||!this.resolution.adapter.createRun)return this.episode.escalate(t,`No job workspace is available for coordinator recovery. ${cause(t,this.store.runs(t.id))}`);
  try{
   // Existing closeout without a callback: preserve its run and MCP binding.
   const owed=this.store.runs(t.id).find(r=>r.agentId===t.coordinatorAgentId&&!r.released&&r.role!=='recovery');
   if(owed && t.originError)return null;
   if(owed){
    if(!await this.resolution.idle(t.coordinatorAgentId))return null;
    if(this.resolution.startsNoRuns())return null;
    this.episode.save(t,{status:'uncertain',agentId:t.coordinatorAgentId});
    this.resolution.update(t,{recoveryAttempts:t.resolution.recoveryAttempts+1});
    await this.resolution.adapter.notify!(t.coordinatorAgentId,`ns-recovery-${incident.id}`,`Nucleus reporting recovery for ${t.title} (${t.id}). The plugin is waiting on your existing ${owed.role} run ${owed.id}: ${t.reason}. Inspect your last result and complete its existing authenticated callback, using its original exact-head and generation requirements. If the MCP tool is absent, use the run-specific authenticated fallback from your instructions. Do not bypass a rejected callback, change task scope, repeat gated actions, or message the originating planning thread. If evidence or operator input is missing, report blocked with the concrete need through that same callback. This is one bounded reporting reminder. ${this.resolution.adapter.reportingFallback?.(owed)??''}`);
    this.episode.save(t,{status:'nudged',idleSince:null});return null;
   }
   if(dispatchBlocked(t)||reviewFenceHoldsCoordinators(t,this.store)){this.episode.wait(t,DISPATCH_HELD_REASON, 'held');return null;}
   const capacityWait=this.resolution.slotAdmissionReason(t,true);
   if(capacityWait){this.episode.wait(t,capacityWait, 'capacity');return null;}
   if(!await this.resolution.lease(t)||this.resolution.startsNoRuns())return null;
   let agentId=t.coordinatorAgentId||null,workspaceId=t.resolution.coordinatorWorkspaceId??t.workspaceId,profile=this.store.runs(t.id).findLast(r=>r.agentId===agentId&&r.profile)?.profile??null,group:string|null=null;
   if(agentId===t.originAgentId){this.episode.wait(t,'The assigned coordinator is the originating planning thread; waiting for a separate job coordinator', 'operator_needed');return null;}
   if(agentId){
    if([t.agentId,t.resolution.reviewerAgentId].includes(agentId)){this.episode.wait(t,'Recovery coordinator must be separate from the worker and independent reviewer', 'operator_needed');return null;}
    const ownedRuns=this.store.unreleasedRunsForAgent(agentId,t.hostId);
   if(ownedRuns.length){this.episode.wait(t,`Recovery coordinator is busy with unreleased run ${ownedRuns[0]!.id}`, 'route_unavailable');return null;}
   const removable=typeof this.resolution.adapter.deleteAgent==='function';
   let state:AgentObservation|null=null;
   try {state=await this.resolution.onTaskHost(t, () => this.resolution.host.observe(agentId!));}
   catch(error){
    // A deleted T3 thread has no projection. Only authoritative absence or a
    // tombstone allows replacement; an unreadable inventory remains unknown.
    if(!removable||!this.resolution.adapter.originAgent)throw error;
    const origin=await this.resolution.onTaskHost(t, () => this.resolution.host.originAgent(agentId!));
    if(origin&&!origin.deleted&&!origin.archived)throw error;
   }
   if(state&&(state.active||state.permissions)){this.episode.wait(t,`Recovery coordinator is busy (${state.status})`, 'route_unavailable');return null;}
    // Only a host that can remove a thread keeps its coordinator threads settled
    // between attempts, so only there may a recorded route or a removed/archived
    // thread displace the binding (nucleus#1155). Paseo keeps its existing rule:
    // an assigned coordinator that is not idle waits, and an idle one is resumed.
    const request=t.profileRequests?.coordinator;
    const recordedRoute=removable && (request?.ownerRoute===true ? request.profileId
      : supersedingRouteProfile(request, profile?.id, this.store.pool(), this.store.usageLevel()));
    const superseded=removable&&(Boolean(recordedRoute && (!profile || profile.id!==recordedRoute))
      ||!state||state.status==='gone'||state.status==='closed');
    if(superseded){agentId=null;profile=null;group=null;workspaceId=t.workspaceId;}
    else {
    if(!state||state.status!=='idle'){this.episode.wait(t,`The assigned recovery coordinator is not resumable (${state?.status??'unknown'}); waiting for an available coordinator`, 'operator_needed');return null;}
    workspaceId=state.workspaceId!;
    }
   }
   if(!agentId){
    const selection=this.resolution.select(t,'coordinator');if(!selection){this.episode.wait(t,`No coordinator profile is available for recovery${this.resolution.requiredRouteNote(t,'coordinator')||this.resolution.usageCeilingNote(t,'coordinator')}. ${cause(t,this.store.runs(t.id))}`, 'route_unavailable');return null;}
    profile=selection.profile;group=selection.entry.group;
   }
   if(!workspaceId){this.episode.wait(t,'The recovery coordinator has no available workspace', 'operator_needed');return null;}
   if(this.resolution.startsNoRuns())return null;
   const token=randomBytes(32).toString('hex');
   const target=recoveryTarget(t,t.resolution.currentRunId?this.store.run(t.resolution.currentRunId):null);
   if((target==='worker'||target==='reviewer')&&this.resolution.suppressAutomaticRetry(t,'recovery_rerun',cause(t,this.store.runs(t.id)),t.resolution.currentRunId))return null;
   const run:Run={id:randomUUID(),taskId:t.id,role:'recovery',generation:t.coordinatorGeneration,head:t.prHead??t.planningBase,base:t.planningBase,workspaceId,agentId,profile,profileGroup:group,status:'intent',createdAt:now(),lastObservedAt:null,active:null,idleSince:null,completion:null,released:false};
   let superseded=false,waitingForCapacity='',heldForDispatch=false,context:RecoveryDispatchSnapshot|null=null;
   this.store.transaction(()=>{
    // The awaits above leave room for an operator control (resume, revise, resolve) to clear or
    // replace this recovery. It then owns the lane: launch nothing and escalate nothing.
    if(this.store.task(t.id).resolution.recovery?.id!==incident!.id){superseded=true;return;}
    const current=this.store.task(t.id);
    if(dispatchBlocked(current)||reviewFenceHoldsCoordinators(current,this.store)){heldForDispatch=true;this.episode.wait(current,DISPATCH_HELD_REASON, 'held');return;}
    waitingForCapacity=this.resolution.slotAdmissionReason(current,true);
    if(waitingForCapacity){this.episode.wait(this.store.task(t.id),waitingForCapacity, 'capacity');return;}
    // Taken before this run is recorded: the plan describes the stop the coordinator was asked about, not its own pending launch.
    context=this.launchSnapshot(current,run,previousRefusal ? `Previous coordinator action was refused: ${previousRefusal}` : cause(current,this.store.runs(t.id)),target);
    const checkPoll=current.prHead?this.store.getMeta<{head:string;overdueCheck?:{key:string};firstOverdueAt?:number;incidentId?:string|null;recoveryRunId?:string|null;attentionRaisedAt?:number|null}>(requiredCheckPollMetaKey(current.id,current.prHead)):null;
    if(checkPoll?.head===current.prHead&&checkPoll.overdueCheck&&checkPoll.firstOverdueAt!==undefined&&!checkPoll.recoveryRunId&&!checkPoll.attentionRaisedAt
      &&(!checkPoll.incidentId||checkPoll.incidentId===incident?.incidentId))
      this.store.setMeta(requiredCheckPollMetaKey(current.id,current.prHead!),{...checkPoll,recoveryRunId:run.id});
    const workerGroup=current.profileGroup ?? this.store.pool().find(entry=>entry.profileId===current.profile?.id)?.group;
    const availability=workerGroup ? this.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get(workerGroup) : null;
    const outage=!this.resolution.hostAvailable(current) || this.resolution.workerProviderUnavailable(current) || Boolean(availability && groupIsUnavailable(JSON.parse(String(availability.data))));
    this.store.setCredential(run.id,token);this.store.putRun(run);this.store.event(t.id,'telemetry_recovery',JSON.stringify({runId:run.id,targetRole:target,cause:cause(t,this.store.runs(t.id)),work:taskWorkIdentity(current,this.store),outage}));this.episode.save(t,{runId:run.id,agentId,status:'running',...(current.resolution.recovery?.action ? {action:null} : {})});this.resolution.update(t,{recoveryActive:true,recoveryAttempts:current.resolution.recoveryAttempts+(outage?0:1)});
    if(group)this.store.chargeAssignment(group,profile!.id);
   });
   if(superseded){this.store.event(t.id,'recovery_superseded','An operator control replaced this recovery before its coordinator run was recorded');return null;}
   if(heldForDispatch)return null;
   if(waitingForCapacity)return null;
   if(agentId)await this.resolution.adapter.sendRun!(t,run,token,context);
   else{
    const created=await this.resolution.adapter.createRun!(t,run,token,context);agentId=created.id;this.store.putRun({...run,agentId});
    if(created.workspaceId!==workspaceId)throw Error('Recovery agent created in wrong workspace');
    if(this.store.task(t.id).coordinatorGeneration===run.generation)this.store.update(t.id,{coordinatorAgentId:agentId},'coordinator_assigned',agentId);
   }
   this.store.putRun({...run,agentId,status:'running'});this.episode.save(t,{agentId});return null;
  }catch(error){return this.episode.escalate(this.store.task(t.id),`${RECOVERY_CREATION_FAILURE_PREFIX}${error instanceof Error?error.message:String(error)}`);}
 }
}
