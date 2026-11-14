import { resultApplied, recordResultApplied } from '../intake/applied-result';
import { digest, latestRunCompletion, now, type Store } from '../store/store';
import type { Completion, RecoveryActionBinding, Run, Task } from '../../shared/contracts';
import type { TaskStopReason } from '../../shared/task-stop';
import type { Resolution } from '../resolution';
import { missingOriginHasPlanner } from '../questions/origin';
import { taskOwner } from '../../shared/contracts';
import { randomUUID } from 'node:crypto';
import { RECOVERY_CREATION_FAILURE_PREFIX } from './task-reasons';
import { taskProgressDigest } from './coordinator-report';
import { recoveryApplicationsInFlight } from './coordinator-settlement';

/**
 * One recovery episode's durable bookkeeping: the action a coordinator report
 * binds to, the refusal that records a report as not applied, the release of a
 * finished coordinator run, and the escalation the episode ends in. The stages
 * that observe, decide and launch a recovery run (`coordinator-pass`,
 * `coordinator-route`) read and write an episode only through this module.
 */
export type RecoveryContext = Pick<Resolution, 'adapter' | 'attention' | 'automaticHookReplayPending' | 'ensureIncident' | 'escalateRefusedCoordinator' | 'extendCallbackReminder' | 'graceMs' | 'host' | 'hostAvailable' | 'workerProviderUnavailable' | 'idle' | 'lease' | 'onTaskHost' | 'openPlannerEscalation' | 'openReviewContinuationEscalation' | 'recordStop' | 'requiredRouteNote' | 'responsibleBlockerLadder' | 'resumeTransientProviderThread' | 'select' | 'slotAdmissionReason' | 'startsNoRuns' | 'stopped' | 'store' | 'suppressAutomaticRetry' | 'update' | 'usageCeilingNote' | 'validationEvidence' | 'waiting'>;

export const needsAttention=(t:Task,store:Store)=>Boolean(t.originError&&!missingOriginHasPlanner(store,t))||['blocked','error','needs_attention'].includes(t.phase)||t.resolution.attention||Boolean(t.resolution.roleReplacements&&t.reason.startsWith('No eligible'));
export const cause=(t:Task,runs:Run[])=>{
 const c=['blocked','error','needs_attention'].includes(t.phase)?latestRunCompletion(runs,['blocked','error'])??(t.completion&&['blocked','error'].includes(t.completion.status)?t.completion:null):null;
 return c?`Worker ${c.status}: ${c.summary}`:t.reason;
};
export const key=(t:Task,runs:Run[])=>t.resolution.stop
 ? digest(`stop:${t.resolution.stop.reason}:${t.resolution.stop.since}`)
 : digest(t.originError?`origin:${taskOwner(t)}:${t.originWorkspaceId}:${t.coordinatorGeneration}`:`${t.phase}:${cause(t,runs)}:${t.resolution.currentRunId ?? t.runId}:${t.coordinatorGeneration}`);

type RecoveryEpisode=NonNullable<Task['resolution']['recovery']>;
/** A report that was authenticated and accepted, and could not be applied. */
export const ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX = 'Accepted recovery report was not applied: ';

export class CoordinatorEpisode {
 constructor(readonly resolution:RecoveryContext){}
 get store(){return this.resolution.store}
 busy(t:Task){const id=t.resolution.recovery?.runId;return Boolean(id&&!this.store.run(id)?.released)}
 wait(t:Task,reason:string,stop:TaskStopReason){
  this.resolution.waiting(t,reason,stop);
  const current=this.store.task(t.id),recovery=current.resolution.recovery;
  // A transient route/admission wait is a stop on the task, not an empty
  // recovery episode. Leave no episode behind until a coordinator run exists.
  if(recovery?.status==='pending'&&!recovery.runId&&!recovery.action)
   this.resolution.update(current,{recovery:null,recoveryActive:false},{},'recovery_waiting');
 }
 bindingFrom(run:Run,incident:RecoveryEpisode):RecoveryActionBinding|null{
  if(incident.action)return incident.action;
  const completion=run.completion;
  if(!completion||run.role!=='recovery')return null;
  if(completion.status!=='recovered'&&completion.status!=='escalate'&&completion.status!=='blocked'&&completion.status!=='error')return null;
  return {eventId:completion.eventId,runId:run.id,reportStatus:completion.status,
   coordinatorAction:completion.coordinatorAction??null,summary:completion.summary,status:'pending'};
 }
 completionFromBinding(t:Task,run:Run,action:RecoveryActionBinding):Completion{
  return run.completion??{eventId:action.eventId,taskId:t.id,runId:action.runId,status:action.reportStatus,summary:action.summary,
   coordinatorAction:action.coordinatorAction??undefined,coordinatorGeneration:run.generation};
 }
 acceptedActionIdentity(action:RecoveryActionBinding){
  return `accepted ${action.reportStatus}${action.coordinatorAction?` + ${action.coordinatorAction.verb}`:''} report ${action.eventId} on recovery run ${action.runId}`;
 }
 refuseAcceptedAction(t:Task,run:Run,action:RecoveryActionBinding,reason:string,escalate:boolean):void{
  if (!this.store.db.isTransaction) return this.store.transaction(() => this.refuseAcceptedAction(t, run, action, reason, escalate));
  if (resultApplied(this.store, t.id, run.id)) return;
  const current=this.store.task(t.id);
  const latest=this.store.run(run.id);
  if(!latest)return;
  // Round 4 telemetry: a report refused here is a coordinator refusal too, keyed
  // to its report so the engine's own settlement never counts it twice.
  try{this.store.recordVerbOutcome(t.id,action.coordinatorAction?.verb??'retired_recovery_action','refused','coordinator',{coordinatorRun:run.id,reason:reason.slice(0,600)},`coordinator:${action.eventId}`);}
  catch{/* the refusal stands even if its record could not be written */}
  const completion=this.completionFromBinding(current,latest,action);
  this.store.putRun({...latest,completion,released:true,status:'finished'});
  this.resolution.update(current,{recoveryActive:false});
  const summary=`${ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX}${reason} (${this.acceptedActionIdentity(action)})`;
  const refused={...action,status:'refused' as const,reason};
  if(escalate){
   this.save(this.store.task(t.id),{action:refused});
   this.escalate(this.store.task(t.id),summary);
  }else {
   const settled=this.store.task(t.id),recovery=settled.resolution.recovery,incident=settled.resolution.incident;
   const resolvedIncident=action.reportStatus==='recovered'&&recovery?.incidentId&&incident?.id===recovery.incidentId&&incident.status==='reconciling'
    ?{...incident,status:'resolved' as const,detail:`Recovery reported the trigger settled: ${action.summary}; ${reason}`,updatedAt:now()}:incident;
   this.resolution.update(settled,{recovery:{...recovery!,status:'resolved',summary,action:refused},incident:resolvedIncident});
  }
  recordResultApplied(this.store,t.id,run.id);
 }
 /**
  * Resolution changes that close a recovery episode whose run no longer holds it:
  * the episode resolves with `detail`, a pending accepted action is recorded as not
  * applied, the incident it owns settles with it, and the stop that described the
  * episode clears. `episodeOwned` says a run this pass released owned the episode,
  * so the changes apply even after the release already cleared `recoveryActive`.
  * A record the release resolved keeps its own summary. Null when no episode is
  * active and none is owned. The caller folds the changes into its own update and
  * owns the transaction.
  */
 settledEpisodeChanges(t:Task,detail:string,episodeOwned=false):Partial<Task['resolution']>|null{
  const current=this.store.task(t.id);
  if(!current.resolution.recoveryActive&&!episodeOwned)return null;
  const episode=current.resolution.recovery??null, incident=current.resolution.incident;
  const action=episode?.action?.status==='pending'?episode.action:null;
  const summary=action?`${ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX}${detail} (${this.acceptedActionIdentity(action)})`:detail;
  const ownsIncident=Boolean(incident&&incident.status!=='resolved'&&(incident.role==='recovery'
   ||episode?.incidentId===incident.id||(episode?.runId!=null&&incident.runId===episode.runId)));
  const closeEpisode=Boolean(episode&&episode.status!=='resolved');
  return {
   recoveryActive:false,
   stop:null,
   ...(closeEpisode?{recovery:{...episode!,status:'resolved' as const,summary,...(action?{action:{...action,status:'refused' as const,reason:detail}}:{})}}:{}),
   ...(ownsIncident?{incident:{...incident!,status:'resolved' as const,detail,updatedAt:now()}}:{}),
  };
 }
 /**
  * Release one finished recovery run and settle its episode bookkeeping — the
  * release path shared by the reconciliation quantum (`Engine.settleFinishedRuns`)
  * and by owner verbs that settle a finished run before their run fence (Spec
  * 050: no verb is refused by a stale record). A pending accepted action is
  * recorded as not applied, audibly, and its stale retry is never executed; an
  * escalated report records its escalation; the callback and history are kept.
  * Only this run is released. Caller owns the transaction.
  */
 settleFinishedRun(t:Task,run:Run,notAppliedReason:string){
  const latest=this.store.run(run.id);
  if(!latest||latest.released||!latest.completion)return;
  const current=this.store.task(t.id);
  const incident=current.resolution.recovery;
  // The owner verb is settling its own reporting coordinator. Its outcome is
  // recorded by the applying call after the verb returns, not as a refusal.
  const applicationKey = JSON.stringify([t.id, latest.id, latest.completion.eventId]);
  if (recoveryApplicationsInFlight.has(applicationKey)) {
   this.store.putRun({...latest,released:true,status:'finished'});
   this.store.event(t.id,'run_released_from_recorded_completion',`recovery ${latest.id}`);
   return;
  }
  if (this.store.eventsAll(t.id).some(event => event.kind === 'run_result_applying' && event.detail === applicationKey)
    && !resultApplied(this.store, t.id, latest.id)) {
   this.resolution.attention(current, `Coordinator result ${latest.id} has an uncertain owner-verb outcome; inspect next and settle the existing action before retrying`);
   return;
  }
  this.store.event(t.id,'run_released_from_recorded_completion',`recovery ${latest.id}`);
  if(latest.completion.status==='escalate'){
   // The escalation is the applied outcome, not a stale action: record it like
   // the reconciliation release path does so the episode does not read running
   // and launch another coordinator for the same issue.
   this.store.putRun({...latest,released:true,status:'finished'});
   let after=current;
   if(after.resolution.recoveryActive)after=this.resolution.update(after,{recoveryActive:false});
   if(after.resolution.recovery?.runId===latest.id&&after.resolution.recovery?.status!=='escalated')this.escalate(after,latest.completion.summary);
   recordResultApplied(this.store,t.id,latest.id);
   return;
  }
  const action=incident&&incident.runId===latest.id?this.bindingFrom(latest,incident):null;
  if(action&&action.status==='pending'){
   // refuseAcceptedAction records the release with the episode closed and the
   // accepted action marked not applied; the stale retry is never executed.
   this.refuseAcceptedAction(current,latest,action,notAppliedReason,false);
   return;
  }
  this.store.putRun({...latest,released:true,status:'finished'});
  if(current.resolution.recoveryActive)this.resolution.update(current,{recoveryActive:false});
  recordResultApplied(this.store,t.id,latest.id);
 }
 /**
  * Closeout release bookkeeping: the task is merging past this recovery, so a
  * pending accepted action is recorded as not applied, audibly, and its stale
  * retry is never executed; the episode closes with the run. An already-decided
  * or escalation-outcome release stays with the caller's plain release. False
  * when the caller should release the run itself. Caller owns the transaction.
  */
 releaseWithNotAppliedAction(t:Task,run:Run,reason:string,appliedCoordinatorRunId?:string):boolean{
  const latest=this.store.run(run.id);
  const current=this.store.task(t.id);
  const incident=current.resolution.recovery;
  if(!latest||latest.released||!latest.completion||latest.completion.status==='escalate')return false;
  const action=incident&&incident.runId===latest.id?this.bindingFrom(latest,incident):null;
  if(!action||action.status!=='pending')return false;
  if(action.coordinatorAction&&latest.id===appliedCoordinatorRunId){
   this.store.putRun({...latest,released:true,status:'finished'});
   this.resolution.update(current,{recovery:{...incident!,status:'resolved',summary:reason,action:{...action,status:'applied'}},recoveryActive:false,stop:null},{},'coordinator_action_applied',action.eventId);
   this.store.event(t.id,'run_released_from_recorded_completion',`recovery ${latest.id}`);
   recordResultApplied(this.store,t.id,latest.id);
   return true;
  }
  this.refuseAcceptedAction(current,latest,action,reason,false);
  recordResultApplied(this.store,t.id,latest.id);
  this.store.event(t.id,'run_released_from_recorded_completion',`recovery ${latest.id}`);
  return true;
 }
 /**
  * Spec 050, papercut e692bde2: a recovery that was authenticated and accepted
  * settles its bookkeeping regardless of review-dispatch authorization. While
  * review authorization holds, `pass` and `route` must not touch the task —
  * except this settlement: a recovery run whose completion is durably recorded,
  * whose exact coordinator identity still matches and whose workspace is
  * observed idle with no active turn and no pending permission releases, a
  * pending old action is marked not applied, and the stale retry is never
  * executed. Everything else stays fenced until authorization returns. True
  * when the run settled.
  */
 async settleAuthorizationFencedRun(t:Task):Promise<boolean>{
  // A paused queue defers its results: settling here could release a run the
  // pause is holding (the reconciliation quantum settles finished runs only
  // after its own pause check, for the same reason). The next pass after the
  // unpause settles it.
  if(this.resolution.startsNoRuns())return false;
  const incident=t.resolution.recovery;
  const run=incident?.runId?this.store.run(incident.runId):null;
  if(!incident||!run||run.released||!run.completion)return false;
  if(run.role!=='recovery'||!run.agentId||run.generation!==t.coordinatorGeneration||
   t.coordinatorAgentId!==run.agentId||incident.generation!==run.generation||incident.agentId!==run.agentId)return false;
  let state;
  try{state=await this.resolution.onTaskHost(run, () => this.resolution.host.observe(run.agentId!));}catch{return false;}
  // The pause can land during the observation: re-check before writing, and
  // again inside the write transaction.
  if(this.resolution.startsNoRuns())return false;
  if(!state||state.id!==run.agentId||state.workspaceId!==run.workspaceId||state.active||state.permissions||!['idle','error','closed'].includes(state.status))return false;
  let settled=false;
  this.store.transaction(()=>{
   if(this.resolution.startsNoRuns())return;
   const latest=this.store.run(run.id);
   const current=this.store.task(t.id);
   const recovery=current.resolution.recovery;
   // The idle observation belongs to this exact binding. An owner control can
   // replace it while observe awaits, even if the episode keeps its run ID.
   if(!latest||latest.released||!latest.completion||latest.role!==run.role||
    latest.agentId!==run.agentId||latest.workspaceId!==run.workspaceId||latest.generation!==run.generation||
    latest.completion.eventId!==run.completion!.eventId||current.coordinatorGeneration!==run.generation||
    current.coordinatorAgentId!==run.agentId||current.resolution.coordinatorWorkspaceId!==t.resolution.coordinatorWorkspaceId||
    !recovery||recovery.id!==incident.id||recovery.key!==incident.key||recovery.runId!==run.id||
    recovery.generation!==run.generation||recovery.agentId!==run.agentId)return;
   this.settleFinishedRun(current,latest,'review authorization still holds; the accepted action was not applied');
   settled=true;
  });
  return settled;
 }
 /** An escalated recovery whose coordinator creation never bound an agent: it holds the lane and no pass settles it. */
 absentRun(t:Task){
  const incident=t.resolution.recovery,run=incident?.runId?this.store.run(incident.runId):null;
  if(!incident||incident.status!=='escalated'||!run||run.role!=='recovery'||run.released||run.agentId||run.completion||!['intent','uncertain'].includes(run.status))return null;
  return run;
 }
 failedCreationRun(t:Task,run:Run){
  const incident=t.resolution.recovery;
  return this.absentRun(t)?.id===run.id&&run.generation===t.coordinatorGeneration&&incident?.generation===run.generation&&incident.summary.startsWith(RECOVERY_CREATION_FAILURE_PREFIX);
 }
 /** Releases a proven-absent recovery run; the escalation stays open for the operator and nothing is launched. */
 releaseAbsent(t:Task,runId:string,proof:string){
  const current=this.store.task(t.id),run=this.absentRun(current);
  if(!run||run.id!==runId)throw Error('Task changed during absent recovery-run verification');
  this.store.deleteCredential(run.id);
  this.store.putRun({...run,status:'superseded',released:true});
  return this.resolution.update(current,{recoveryActive:false,recovery:{...current.resolution.recovery!,runId:null,agentId:null}},{},'absent_recovery_released',proof);
 }
 save(t:Task,patch:Partial<RecoveryEpisode>){
  const current=this.store.task(t.id);
  // An operator control can clear the recovery while a pass awaits; never rebuild a partial one.
  if(!current.resolution.recovery)return current;
  return this.resolution.update(current,{recovery:{...current.resolution.recovery,...patch}}, {},'recovery');
 }
 escalate(t:Task,summary:string){
  const current=this.store.task(t.id);
  const recovery=current.resolution.recovery;
  if(recovery?.status==='escalated'&&recovery.summary===summary&&current.resolution.incident?.status==='escalated')return summary;
  // Escalation attaches to the fault already being observed; a fresh incident is derived only when none exists.
  const existing=current.resolution.incident?.status==='resolved'?null:current.resolution.incident;
  const incident=existing??this.resolution.ensureIncident(current,null,summary);
  // One escalation event per incident: repeated observations update the row, they do not append.
  const alreadyEscalated=recovery?.status==='escalated'&&recovery.incidentId===incident.id;
  const base=recovery??{id:randomUUID(),key:key(current,this.store.runs(current.id)),generation:current.coordinatorGeneration,runId:null,agentId:null,status:'pending' as const,summary:'',idleSince:null,incidentId:null,progress:taskProgressDigest(current)};
  this.resolution.update(current,{recovery:{...base,status:'escalated',summary,incidentId:incident.id},incident:{...incident,status:'escalated',detail:summary,updatedAt:now()}},{});
  if(!alreadyEscalated)this.store.event(t.id,'recovery_escalated',summary);
  return summary;
 }
}
