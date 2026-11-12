import { resultApplied, recordResultApplied } from '../intake/applied-result';
import { taskStopVerbsFor, type TaskStopReason } from '../../shared/task-stop';
import { reviewContinuationState, reviewFenceHoldsCoordinators } from '../review/review-continuation';
import { isSshAuthExhausted } from '../../shared/ssh-auth';
import {randomBytes,randomUUID} from 'node:crypto';
import {digest,now,latestRunCompletion,type Store} from '../store/store';
import type {Task,Run,RecoveryActionBinding,Completion,CoordinatorAction,TaskNextVerb,UsageLevel,CapabilityLevel,ProfileCapability} from '../../shared/contracts';
import {RETAINED_WORKER_PROFILE_REASON, CHECKPOINT_BUDGET, incidentBindsCurrentWork, taskControlInputSchema} from '../../shared/contracts';
import {isDispositionActive,isDispositionComplete} from '../../shared/contracts';
import {taskOwner} from '../../shared/contracts';
import {dispatchBlocked, DISPATCH_HELD_REASON} from '../dispatch/capacity';
import {isCloseoutHookHold} from '../hooks/hooks';
import {automaticIncidentPending} from './incident';
import type {Engine} from '../engine';
import type {Resolution} from '../resolution';
import {isRepositoryContention,repositoryContentionNeedsAttention} from '../scheduling/repository-contention';
import {collectOwnerVerbFacts,ownerVerb,ownerVerbViews,restartShape} from '../verbs/owner-verbs';
import {COORDINATOR_LOOP_LIMIT,COORDINATOR_LOOP_SUMMARY,taskWorkIdentity,unproductiveCoordinatorRuns} from './recovery-bound';
import {recoveryDispatchSnapshot, type RecoveryDispatchSnapshot} from './recovery-context';
import type {ResolutionChanges} from './task-stops';
import {frontierAllowed,groupIsUnavailable,withinUsage} from '../../shared/pool';
import {missingOriginHasPlanner} from '../questions/origin';
import {RECOVERY_ESCALATION_FAILURE_PREFIX} from './task-reasons';
export const RECOVERY_STOPPED_WITHOUT_RESULT = 'The recovery coordinator stopped without a result. Inspect its thread; the plugin has not repeated its prompt.';
export const ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX = 'Accepted recovery report was not applied: ';
const RECOVERY_CREATION_FAILURE_PREFIX = 'Coordinator recovery unavailable: ';
type Incident=NonNullable<Task['resolution']['recovery']>;
const needsAttention=(t:Task,store:Store)=>Boolean(t.originError&&!missingOriginHasPlanner(store,t))||['blocked','error','needs_attention'].includes(t.phase)||t.resolution.attention||Boolean(t.resolution.roleReplacements&&t.reason.startsWith('No eligible'));
/** Open-PR identity or leftover proof wait after a verified merge: Resolution closes out; a coordinator cannot. */
const mergedCloseoutNeedsNoCoordinator=(t:Task)=>{
 const text=`${t.reason}\n${t.resolution.stop?.detail??''}`;
 return /PR must be open/.test(text)||t.resolution.stop?.reason==='awaiting_proof';
};
const cause=(t:Task,runs:Run[])=>{
 const c=['blocked','error','needs_attention'].includes(t.phase)?latestRunCompletion(runs,['blocked','error'])??(t.completion&&['blocked','error'].includes(t.completion.status)?t.completion:null):null;
 return c?`Worker ${c.status}: ${c.summary}`:t.reason;
};
const key=(t:Task,runs:Run[])=>t.resolution.stop
 ? digest(`stop:${t.resolution.stop.reason}:${t.resolution.stop.since}`)
 : digest(t.originError?`origin:${taskOwner(t)}:${t.originWorkspaceId}:${t.coordinatorGeneration}`:`${t.phase}:${cause(t,runs)}:${t.resolution.currentRunId ?? t.runId}:${t.coordinatorGeneration}`);
const recoveryTarget=(task:Task,run:Run|null):"worker"|"reviewer"|"coordinator"|"closeout"|"unknown"=>{
 if(run?.role==='reviewer')return 'reviewer';
 if(run?.role==='revision')return 'worker';
 if(run?.role==='closeout')return 'closeout';
 if(['dispatching','working','changes_requested','blocked','error'].includes(task.phase))return 'worker';
 if(['awaiting_review','reviewing'].includes(task.phase))return 'reviewer';
 if(task.phase==='closing')return 'closeout';
 if(['verifying','merging','syncing'].includes(task.phase))return 'coordinator';
 return 'unknown';
};
/** Project-a #1980: with its checkpoint budget spent, a long pre-PR worker reported
 * error as a pseudo-checkpoint ('assessment incomplete; not a provider/external
 * blocker') and recovery resumed it in an endless chunk loop, because a
 * successful resume resets the coordinator budget and each new chunk summary
 * changes the recovery fingerprint. */
const PSEUDO_CHECKPOINT_INCOMPLETE_RE = /assessment incomplete|incomplete|remaining work|unfinished|not complete|more work/i;
const PSEUDO_CHECKPOINT_NO_FAILURE_RE = /not a (provider|external|blocker|failure)|no (provider|external|blocker|failure)|not caused by|no execution failure/i;
/** Explicit execution-failure evidence always wins over the incomplete signals
 * above: a summary that names a failure stays on the normal recovery path
 * even when it also says the work is incomplete. The no-failure disclaimer is
 * scrubbed from the evidence first, so `no execution failure` never vetoes
 * while a genuine `timed out` or `error occurred` in the same summary does. */
const EXECUTION_FAILURE_RE = /\bfail\w*|\berrors?|\btime\s?-?outs?|\btimed\s?-?out|traceback|\bexception\b|panic|\bcrashed\b|\bbroke(n)?\b|exit( code)?\s+[1-9]|\b(cannot|unable to|refused|denied|forbidden|permission denied)\b/i;
/** True for a pre-PR blocked/error report that self-declares 'incomplete' with
 * no execution failure after the checkpoint budget was spent. */
export const isPseudoCheckpointError = (task: Task): boolean => {
  if (task.checkpoints.records.length < CHECKPOINT_BUDGET) return false;
  if (!['blocked', 'error'].includes(task.phase)) return false;
  const completion = task.completion;
  if (!completion || !['blocked', 'error'].includes(completion.status)) return false;
  if (completion.providerUnavailable) return false;
  if (task.completion?.prNumber || task.prUrl || task.prHead || task.resumePrNumber) return false;
  const evidence = `${completion.summary} ${task.reason}`;
  // Scrub the no-failure disclaimer before looking for failure words, so
  // `no execution failure` never vetoes while a genuine `timed out` or
  // `error occurred` elsewhere in the same summary still does.
  const scrubbed = evidence.replace(/not a (provider|external|blocker|failure)|no (provider|external|blocker|failure)|not caused by|no execution failure/gi, ' ');
  if (EXECUTION_FAILURE_RE.test(scrubbed)) return false;
  return PSEUDO_CHECKPOINT_INCOMPLETE_RE.test(evidence) && PSEUDO_CHECKPOINT_NO_FAILURE_RE.test(evidence);
};
/** Pre-PR resumes already granted after the budget-exhausting checkpoint. */
export const postBudgetPrePrResumes = (events: { id: number; kind: string }[]): number => {
  const accepted = events.filter(event => event.kind === 'progress_checkpoint');
  if (accepted.length < CHECKPOINT_BUDGET) return 0;
  const budgetId = accepted[CHECKPOINT_BUDGET - 1]!.id;
  return events.filter(event => event.kind === 'worker_resume_requested' && event.id > budgetId).length;
};
const pseudoCheckpointEscalation = (task: Task): string => {
  const summary = task.completion && ['blocked', 'error'].includes(task.completion.status) ? task.completion.summary : task.reason;
  return `Worker error after its checkpoint budget was spent reads as a pseudo-checkpoint, not an execution failure ('${summary.slice(0, 500)}'); the task already resumed pre-PR once, so Queue escalated to the planner instead of resuming again. Self-assessed context pressure is not an execution failure. Continue the approved work; use a progress checkpoint only where that run permits it and its existing allowance remains. A genuine provider or runtime limit needs the observed error, not a promised fresh session.`;
};
/** A worker return cannot be valid after review; a held lifecycle check is the only cheap recovery left. */
/**
 * The conservative intent guard: what the task was when the coordinator was
 * asked — its phase, exact source head, worker identity, latest results and
 * review, current run, merge state, routes and approved instruction source. A
 * report is stale when this changed, and the stop record itself churns between
 * waits and stops for one condition (consumer-b #639), so it is not the binding.
 *
 * It deliberately carries no review coverage at all: the same retained reviewer
 * saving a further checkpoint at the same head is the unit the episode is already
 * working in, and that must not remove the ordinary move authority the episode
 * was opened with (review 5668519775). The loop's coverage measure stays in
 * `taskWorkIdentity`, and recovery's decision to revisit a still-unfinished
 * checkpoint is a separate lifecycle question it answers from current delivery
 * facts, not through this digest.
 */
export function taskProgressDigest(t:Task):string{
 return digest(JSON.stringify([t.phase,t.prHead,t.agentId,t.runId,t.completion?.eventId??null,
  t.resolution.review?.eventId??null,t.resolution.currentRunId,t.resolution.mergeIntent,t.resolution.mergedCommit,
  t.briefVersions.at(-1)?.digest??null,t.profileRequests??null,t.removedAt??null]));
}
/**
 * Whether an accepted coordinator report still describes the task it was asked
 * about, so Queue may apply it: the progress digest recorded when the episode
 * opened. A changed head, result, review, result, participant or run, a re-pinned brief or
 * an owner route makes it stale; the same reviewer's own checkpoint evolution
 * does not.
 */
export function coordinatorReportMatches(t:Task):boolean{
 const progress=t.resolution.recovery?.progress;
 return Boolean(progress&&progress===taskProgressDigest(t));
}
export type RecoveryContext = Pick<Resolution, 'adapter' | 'attention' | 'automaticHookReplayPending' | 'ensureIncident' | 'escalateRefusedCoordinator' | 'extendCallbackReminder' | 'graceMs' | 'host' | 'idle' | 'lease' | 'onTaskHost' | 'openReviewContinuationEscalation' | 'recordStop' | 'requiredRouteNote' | 'responsibleBlockerLadder' | 'resumeTransientProviderThread' | 'select' | 'slotAdmissionReason' | 'startsNoRuns' | 'stopped' | 'store' | 'suppressAutomaticRetry' | 'update' | 'usageCeilingNote' | 'validationEvidence' | 'waiting'>;

export class Recovery {
 constructor(readonly resolution:RecoveryContext){}
 private coordinatorActionHandler:((task:Task,run:Run,action:RecoveryActionBinding)=>Promise<void>)|null=null;
 setCoordinatorActionHandler(handler:(task:Task,run:Run,action:RecoveryActionBinding)=>Promise<void>){this.coordinatorActionHandler=handler;}
 /** Engine-provided Spec 058 mechanical settlement for an opted-in responsible task. */
 private responsibleFaultHandler:((task:Task)=>Promise<boolean>)|null=null;
 setResponsibleFaultHandler(handler:(task:Task)=>Promise<boolean>){this.responsibleFaultHandler=handler;}
 get store(){return this.resolution.store}
 busy(t:Task){const id=t.resolution.recovery?.runId;return Boolean(id&&!this.store.run(id)?.released)}
 /**
  * The plan `next` derives for the stop this coordinator is asked about. A read
  * failure yields no snapshot rather than refusing the dispatch: the prompt then
  * points the coordinator at the refresh command.
  */
 private launchSnapshot(t:Task,run:Run,cause:string|null,target:string):RecoveryDispatchSnapshot|null{
  try{return recoveryDispatchSnapshot(collectOwnerVerbFacts(this.store,t),{cause,target,recoveryRunId:run.id});}
  catch{return null;}
 }
 private wait(t:Task,reason:string,stop:TaskStopReason){
  this.resolution.waiting(t,reason,stop);
  const current=this.store.task(t.id),recovery=current.resolution.recovery;
  // A transient route/admission wait is a stop on the task, not an empty
  // recovery episode. Leave no episode behind until a coordinator run exists.
  if(recovery?.status==='pending'&&!recovery.runId&&!recovery.action)
   this.resolution.update(current,{recovery:null,recoveryActive:false},{},'recovery_waiting');
 }
 private bindingFrom(run:Run,incident:Incident):RecoveryActionBinding|null{
  if(incident.action)return incident.action;
  const completion=run.completion;
  if(!completion||run.role!=='recovery')return null;
  if(completion.status!=='recovered'&&completion.status!=='escalate'&&completion.status!=='blocked'&&completion.status!=='error')return null;
  return {eventId:completion.eventId,runId:run.id,reportStatus:completion.status,
   coordinatorAction:completion.coordinatorAction??null,summary:completion.summary,status:'pending'};
 }
 private completionFromBinding(t:Task,run:Run,action:RecoveryActionBinding):Completion{
  return run.completion??{eventId:action.eventId,taskId:t.id,runId:action.runId,status:action.reportStatus,summary:action.summary,
   coordinatorAction:action.coordinatorAction??undefined,coordinatorGeneration:run.generation};
 }
 private acceptedActionIdentity(action:RecoveryActionBinding){
  return `accepted ${action.reportStatus}${action.coordinatorAction?` + ${action.coordinatorAction.verb}`:''} report ${action.eventId} on recovery run ${action.runId}`;
 }
 private refuseAcceptedAction(t:Task,run:Run,action:RecoveryActionBinding,reason:string,escalate:boolean):void{
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
 private failedCreationRun(t:Task,run:Run){
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
 save(t:Task,patch:Partial<Incident>){
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
 async pass(taskId?:string){
  if(!this.resolution.adapter.supportsCoordinatorRecovery||this.resolution.stopped())return;
  for(const initial of this.store.maintenanceTasks(true).filter(task=>!taskId||task.id===taskId)){
   let t=this.store.task(initial.id),incident=t.resolution.recovery;
   if(t.entrypoint==='proof'&&t.proofOnly){
    // A stale worker-recovery episode must not own a proof-only task. Stop and
    // supersede its exact coordinator run, then let the task quantum resume the
    // proof route from its already-provisioned detached checkout.
    if(incident?.runId){
     const run=this.store.run(incident.runId);
     if(run&&!run.released&&run.role==='recovery'&&run.agentId){
      const host=this.resolution.host;
      if(this.resolution.adapter.stopAgentTurn)await host.stopAgentTurn(run.agentId);
      const state=await host.observe(run.agentId);
      if(state.active||state.permissions||!['idle','error','closed'].includes(state.status))continue;
      const latest=this.store.task(t.id),latestRun=this.store.run(run.id),latestRecovery=latest.resolution.recovery;
      if(!latestRun||latestRun.released||latestRun.agentId!==run.agentId||latestRecovery?.runId!==run.id)continue;
      this.store.transaction(()=>{
       const current=this.store.task(t.id),bound=this.store.run(run.id)!;
       this.store.putRun({...bound,released:true,status:'superseded'});
       this.resolution.update(current,{recoveryActive:false,recovery:{...current.resolution.recovery!,status:'resolved',summary:'Proof-only task resumed its executor route; worker recovery was superseded'},incident:current.resolution.incident?{...current.resolution.incident,status:'resolved',detail:'Proof-only task resumed its executor route',updatedAt:now()}:null,stop:null},
        {coordinatorAgentId:'',coordinatorGeneration:current.coordinatorGeneration+1,phase:'dispatching',reason:'Proof-only task resumed after worker recovery was superseded'},'proof_only_recovery_superseded',run.id);
      });
     }
    }
    continue;
   }
   if(!incident?.runId)continue;
   if(isDispositionActive(t)||isDispositionComplete(t)||dispatchBlocked(t))continue;
   // Queue #691: a finished task's coordinator gets no further authority. Its silence never escalates
   // the done task, and its report is evidence (Resolution.complete); terminal cleanup releases the run.
   if(['done','cancelled'].includes(t.phase))continue;
   const episodeRunId=incident.runId;
   if(reviewFenceHoldsCoordinators(t,this.store)){
    // A finished accepted recovery still settles its bookkeeping while review
    // authorization holds (Spec 050: no verb is refused by a stale record);
    // nothing else about the task moves until authorization returns.
    await this.settleAuthorizationFencedRun(t);
    continue;
   }
   let run=this.store.run(incident.runId);if(!run||run.released)continue;
   try{
    if(run.generation!==t.coordinatorGeneration){
     const latest=this.store.run(run.id)!;
     const binding=this.bindingFrom(latest,incident);
     if(binding&&(binding.status==='pending'||latest.completion)){
      this.refuseAcceptedAction(t,latest,binding,'coordinator generation changed after the accepted report',needsAttention(this.store.task(t.id),this.store));
      continue;
     }
     this.store.putRun({...latest,released:true,status:'superseded'});this.resolution.update(t,{recoveryActive:false});this.save(t,{status:'resolved'});continue;
    }
    if(!run.agentId){
     if(this.resolution.startsNoRuns())continue;
     const found=await this.resolution.adapter.findRunAgents!(run);
     if(this.resolution.stopped()||this.resolution.startsNoRuns())return;
     t=this.store.task(t.id);
     if(dispatchBlocked(t)||reviewFenceHoldsCoordinators(t,this.store))continue;
     const latestRun=this.store.run(run.id);
     if(!latestRun||latestRun.released||t.resolution.recovery?.runId!==latestRun.id||latestRun.generation!==t.coordinatorGeneration)continue;
     run=latestRun;
     if(!run.agentId&&found.length===0&&this.failedCreationRun(t,run)){
      const absentRunId=run.id,taskId=t.id;
      this.resolution.adapter.purgeReportingFiles?.(taskId,[absentRunId]);
      this.store.transaction(()=>{
       const latestTask=this.store.task(taskId),currentRun=this.store.run(absentRunId);
       if(currentRun&&this.failedCreationRun(latestTask,currentRun))
        this.releaseAbsent(latestTask,absentRunId,'Exact task/run label lookup found no coordinator; failed creation superseded and released');
      });
      continue;
     }
     if(!run.agentId&&(found.length!==1||found[0].workspaceId!==run.workspaceId)){this.escalate(t,'Coordinator recovery creation is uncertain; no duplicate was launched. Inspect the queue run before retrying.');continue;}
     if(!run.agentId){run={...run,agentId:found[0]!.id,status:'running'};this.store.putRun(run);}
     if(t.coordinatorGeneration===run.generation&&!t.coordinatorAgentId)this.store.update(t.id,{coordinatorAgentId:run.agentId!},'coordinator_assigned',run.agentId!);
    }
    const state=await this.resolution.onTaskHost(t, () => this.resolution.host.observe(run!.agentId!));if(this.resolution.stopped())return;
    const idle=!state.active&&!state.permissions&&['idle','error','closed'].includes(state.status);
    if(state.workspaceId!==run.workspaceId)throw Error('Recovery coordinator workspace changed');
    // Re-read before writing observation: complete() can land during observe and
    // a stale putRun would wipe the accepted completion (#2016).
    const observed=this.store.run(run.id);
    if(!observed||observed.released)continue;
    run={...observed,active:!idle,lastObservedAt:now(),idleSince:idle?observed.idleSince??now():null};this.store.putRun(run);
    if(reviewFenceHoldsCoordinators(this.store.task(t.id),this.store)){await this.settleAuthorizationFencedRun(this.store.task(t.id));continue;}
    if(dispatchBlocked(this.store.task(t.id)))continue;
    if(!run.completion&&await this.resolution.resumeTransientProviderThread(t,run,state))continue;
    if(!idle||this.resolution.startsNoRuns())continue;
    t=this.store.task(t.id);incident=t.resolution.recovery;
    if(!incident)continue;
    run=this.store.run(run.id)!;
    const pending=incident.action?.status==='pending'?incident.action:null;
    if(incident.action?.status==='applied'||incident.action?.status==='refused'){
     if(!run.released)this.store.putRun({...run,released:true,status:'finished'});
     continue;
    }
    if(!run.completion&&!pending){
     if(Date.now()-Date.parse(run.idleSince!)>=this.resolution.graceMs){
      this.store.putRun({...run,released:true,status:'finished'});this.resolution.update(t,{recoveryActive:false});
      this.escalate(t,RECOVERY_STOPPED_WITHOUT_RESULT);
     }
     continue;
    }
    if(!await this.resolution.lease(t)||this.resolution.startsNoRuns())continue;
    const finishedRun=run;
    const accepted=this.bindingFrom(run,incident);
    const reported=accepted?this.completionFromBinding(t,finishedRun,accepted):null;
    if(t.responsible&&accepted&&reported&&['blocked','error'].includes(accepted.reportStatus)&&reported.providerUnavailable!==true){
     this.store.transaction(()=>this.settleFinishedRun(this.store.task(t.id),finishedRun,`Recovery reported ${accepted.reportStatus}: ${accepted.summary}; handing it to the responsible-task planner ladder`));
     await this.resolution.responsibleBlockerLadder(this.store.task(t.id),{source:'recovery',runId:finishedRun.id,completion:reported});
     continue;
    }
    if(accepted?.status==='pending'&&accepted.coordinatorAction){
     if(this.coordinatorActionHandler)await this.coordinatorActionHandler(t,run,accepted);
     else this.refuseAcceptedAction(t,run,accepted,'the task reconciler cannot apply coordinator owner verbs in this context',false);
     continue;
    }
    this.store.transaction(()=>{
     const latestRun=this.store.run(finishedRun.id)!;
     t=this.store.task(t.id);
     incident=t.resolution.recovery!;
     const action=this.bindingFrom(latestRun,incident);
     if(!action||action.status==='applied'||action.status==='refused'){
      if(!latestRun.released)this.store.putRun({...latestRun,completion:latestRun.completion??(action?this.completionFromBinding(t,latestRun,action):null),released:true,status:'finished'});
      return;
     }
     // A pending accepted report without a coordinator owner verb is a legacy
     // narrow recovery action (Spec 049 era). The owner verbs own every
     // continuation now, so the stale action is recorded as not applied —
     // audibly, with the escalation kept — and the run releases. The stale
     // retry is never executed.
     this.refuseAcceptedAction(t,latestRun,action,'narrow recovery actions are retired; continue with the owner verbs',needsAttention(t,this.store));
    });
   }catch(error){
    if(this.resolution.startsNoRuns())continue;
    const reason=error instanceof Error?error.message:String(error);
    t=this.store.task(t.id);
    incident=t.resolution.recovery;
    const latest=incident?.runId?this.store.run(incident.runId):null;
    const binding=latest&&incident?this.bindingFrom(latest,incident):null;
    // Observation (or another live check) failed after an authenticated report:
    // keep the pending action and name it. A later pass can still apply it.
    if(binding?.status==='pending')
     this.escalate(t,`${RECOVERY_ESCALATION_FAILURE_PREFIX}${reason}. ${ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX}${this.acceptedActionIdentity(binding)} remains pending`);
    else this.escalate(t,`${RECOVERY_ESCALATION_FAILURE_PREFIX}${reason}`);
   }
  }
 }
 /**
  * The author's own `blocked` report when it is the latest result on the task:
  * it asks the owner for a scope or acceptance decision, which a coordinator
  * cannot make (Tom, 2026-10-15). The latest result wins across roles, so a
  * newer reviewer block keeps the coordinator path. A replaced (retired)
  * worker's revisions are history, and the current worker's initial result is
  * timed by its `completion_received` event.
  */
 private authorBlockedReport(t:Task,runs:Run[]):Completion|null{
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
  if(t.entrypoint==='proof'&&t.proofOnly)return null;
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
     this.escalate(t,summary);
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
    if(!idle){this.save(t,{idleSince:null});return null;}
    if(!incident.idleSince){this.save(t,{idleSince:now()});return null;}
    if(Date.now()-Date.parse(incident.idleSince)>=this.resolution.graceMs)return this.escalate(t,'The coordinator stopped after a reporting reminder, but this issue still needs attention. Inspect its result or provide the missing decision.');
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
   if(unproductiveCoordinatorRuns(this.store,t.id)>=COORDINATOR_LOOP_LIMIT)return this.escalate(t,COORDINATOR_LOOP_SUMMARY);
   incident={id:randomUUID(),key:fingerprint,generation:t.coordinatorGeneration,runId:null,agentId:null,status:'pending',summary:'',idleSince:null,
    incidentId:t.resolution.incident?.status==='resolved'?null:t.resolution.incident?.id??null,progress:taskProgressDigest(t),
    ...(refusedAction ? {action:refusedAction} : {})};
   t=this.resolution.update(t,{recovery:incident},{},'recovery_pending');
  }
  if(t.reason.startsWith(RETAINED_WORKER_PROFILE_REASON))return this.escalate(t,t.reason);
  // Project-a #1980: a pseudo-checkpoint error already resumed once pre-PR
  // escalates to the planner instead of launching another recovery loop.
  if(isPseudoCheckpointError(t)&&postBudgetPrePrResumes(this.store.eventsAll(t.id))>=1)
    return this.escalate(t,pseudoCheckpointEscalation(t));
  if(!t.workspaceId||!this.resolution.adapter.createRun)return this.escalate(t,`No job workspace is available for coordinator recovery. ${cause(t,this.store.runs(t.id))}`);
  try{
   // Existing closeout without a callback: preserve its run and MCP binding.
   const owed=this.store.runs(t.id).find(r=>r.agentId===t.coordinatorAgentId&&!r.released&&r.role!=='recovery');
   if(owed && t.originError)return null;
   if(owed){
    if(!await this.resolution.idle(t.coordinatorAgentId))return null;
    if(this.resolution.startsNoRuns())return null;
    this.save(t,{status:'uncertain',agentId:t.coordinatorAgentId});
    this.resolution.update(t,{recoveryAttempts:t.resolution.recoveryAttempts+1});
    await this.resolution.adapter.notify!(t.coordinatorAgentId,`ns-recovery-${incident.id}`,`Nucleus reporting recovery for ${t.title} (${t.id}). The plugin is waiting on your existing ${owed.role} run ${owed.id}: ${t.reason}. Inspect your last result and complete its existing authenticated callback, using its original exact-head and generation requirements. If the MCP tool is absent, use the run-specific authenticated fallback from your instructions. Do not bypass a rejected callback, change task scope, repeat gated actions, or message the originating planning thread. If evidence or operator input is missing, report blocked with the concrete need through that same callback. This is one bounded reporting reminder. ${this.resolution.adapter.reportingFallback?.(owed)??''}`);
    this.save(t,{status:'nudged',idleSince:null});return null;
   }
   if(dispatchBlocked(t)||reviewFenceHoldsCoordinators(t,this.store)){this.wait(t,DISPATCH_HELD_REASON, 'held');return null;}
   const capacityWait=this.resolution.slotAdmissionReason(t,true);
   if(capacityWait){this.wait(t,capacityWait, 'capacity');return null;}
   if(!await this.resolution.lease(t)||this.resolution.startsNoRuns())return null;
   let agentId=t.coordinatorAgentId||null,workspaceId=t.resolution.coordinatorWorkspaceId??t.workspaceId,profile=this.store.runs(t.id).findLast(r=>r.agentId===agentId&&r.profile)?.profile??null,group:string|null=null;
   if(agentId===t.originAgentId){this.wait(t,'The assigned coordinator is the originating planning thread; waiting for a separate job coordinator', 'operator_needed');return null;}
   if(agentId){
    if([t.agentId,t.resolution.reviewerAgentId].includes(agentId)){this.wait(t,'Recovery coordinator must be separate from the worker and independent reviewer', 'operator_needed');return null;}
    const ownedRuns=this.store.unreleasedRunsForAgent(agentId,t.hostId);
   if(ownedRuns.length){this.wait(t,`Recovery coordinator is busy with unreleased run ${ownedRuns[0]!.id}`, 'route_unavailable');return null;}
   const state=await this.resolution.onTaskHost(t, () => this.resolution.host.observe(agentId!));
   if(state.active||state.permissions){this.wait(t,`Recovery coordinator is busy (${state.status})`, 'route_unavailable');return null;}
    if(state.status!=='idle'){this.wait(t,`The assigned recovery coordinator is not resumable (${state.status}); waiting for an available coordinator`, 'operator_needed');return null;}
    workspaceId=state.workspaceId!;
   }else{
    const selection=this.resolution.select(t,'coordinator');if(!selection){this.wait(t,`No coordinator profile is available for recovery${this.resolution.requiredRouteNote(t,'coordinator')||this.resolution.usageCeilingNote(t,'coordinator')}. ${cause(t,this.store.runs(t.id))}`, 'route_unavailable');return null;}
    profile=selection.profile;group=selection.entry.group;
   }
   if(!workspaceId){this.wait(t,'The recovery coordinator has no available workspace', 'operator_needed');return null;}
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
    if(dispatchBlocked(current)||reviewFenceHoldsCoordinators(current,this.store)){heldForDispatch=true;this.wait(current,DISPATCH_HELD_REASON, 'held');return;}
    waitingForCapacity=this.resolution.slotAdmissionReason(current,true);
    if(waitingForCapacity){this.wait(this.store.task(t.id),waitingForCapacity, 'capacity');return;}
    // Taken before this run is recorded: the plan describes the stop the coordinator was asked about, not its own pending launch.
    context=this.launchSnapshot(current,run,previousRefusal ? `Previous coordinator action was refused: ${previousRefusal}` : cause(current,this.store.runs(t.id)),target);
    this.store.setCredential(run.id,token);this.store.putRun(run);this.store.event(t.id,'telemetry_recovery',JSON.stringify({runId:run.id,targetRole:target,cause:cause(t,this.store.runs(t.id)),work:taskWorkIdentity(current,this.store)}));this.save(t,{runId:run.id,agentId,status:'running',...(current.resolution.recovery?.action ? {action:null} : {})});this.resolution.update(t,{recoveryActive:true,recoveryAttempts:t.resolution.recoveryAttempts+1});
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
   this.store.putRun({...run,agentId,status:'running'});this.save(t,{agentId});return null;
  }catch(error){return this.escalate(this.store.task(t.id),`${RECOVERY_CREATION_FAILURE_PREFIX}${error instanceof Error?error.message:String(error)}`);}
 }
}

/**
 * The owner verb a coordinator's report asks for, as the arguments to apply, or
 * the refusal naming why it no longer applies. Every string here is the owner's
 * own: the plan reads the same views `next` shows, so a coordinator cannot invent
 * a verb the task does not offer, and the caller applies it under its usual lane.
 */
export type CoordinatorActionPlan =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; refusal: string };

/**
 * The plan for one coordinator action: the reported verb's own view, the role it
 * binds, the operator's usage level for a route, and the arguments built from the
 * report's fields. Pure over the task's verb views; the caller applies it.
 */
export function coordinatorActionPlan(input: {
  action: CoordinatorAction;
  /** The task's owner-verb views, as `next` derives them from the same store facts. */
  views: TaskNextVerb[];
  /** The stop the report answers, if the task still records one. */
  stopReason?: string | null;
  /** The reported route profile's cost, when the verb is `route`. */
  routeCost: CapabilityLevel | null;
  /** The reported route profile's capability; a frontier profile is request-only below Maximum. */
  routeCapability?: ProfileCapability | null;
  usage: UsageLevel;
  /** Whether `ownerVerb` holds a handler for the reported verb. */
  verbRegistered: boolean;
}): CoordinatorActionPlan {
  const { action } = input;
  // A view that derived no role (a blocked or errored task with a PR) leaves
  // the role to the caller's explicit choice, which its own note documents;
  // only a role the view did derive is a binding.
  const requested = input.views.find(view => view.verb === action.verb && view.available && view.args
    && (action.verb !== "route" || view.args.role === action.role)
    && (action.verb !== "move" || view.args.to === action.to)
    && (action.verb !== "retry_effect" || !action.effect || view.args.effect === action.effect));
  if (!requested?.args) {
    // Name why, from the same views `next` shows, so the owner or the next
    // coordinator can choose without another diagnostic read.
    const refusals = [...new Set(input.views.filter(view => view.verb === action.verb && !view.available && view.refusal).map(view => view.refusal!))];
    return { ok: false, refusal: `The reported ${action.verb} does not apply to the task now${input.stopReason ? ` (stop ${input.stopReason})` : ""}${refusals.length ? `: ${refusals.join("; ")}` : ""}`.slice(0, 4000) };
  }
  if (action.verb === "restart" && action.role && requested.args.role !== undefined && requested.args.role !== action.role)
    return { ok: false, refusal: `restart ${action.role} does not match the stopped role ${String(requested.args.role)}` };
  // A coordinator stays within the operator's usage level (Spec 052). At
  // `normal` that keeps the 2026-10-01/15 rule: a very_high-cost (Sol-class)
  // route is the owner's last resort, since an availability or environment
  // block is not a capability failure.
  if (action.verb === "route" && input.routeCost && !withinUsage(input.usage, input.routeCost))
    return { ok: false, refusal: `A coordinator cannot route to ${action.profileId}: its ${input.routeCost} cost is above the operator's ${input.usage} usage level. Wait out an availability block or use an equivalent-cost profile, and report an environment block (a missing tool or stack) as cannot` };
  if (action.verb === "route" && !frontierAllowed(input.usage, input.routeCapability))
    return { ok: false, refusal: `A coordinator cannot route to ${action.profileId}: it is rated frontier, which is request-only below Maximum. Use a profile within the ${input.usage} usage level, and report an environment block (a missing tool or stack) as cannot` };
  if (!input.verbRegistered) return { ok: false, refusal: `The ${action.verb} owner verb is not registered` };
  const args: Record<string, unknown> = { ...requested.args, reason: action.reason };
  if (action.verb === "restart") Object.assign(args, {
    ...(action.role ? { role: action.role } : {}), ...(action.instruction ? { instruction: action.instruction } : {}),
    ...(action.fresh !== undefined ? { fresh: action.fresh } : {}),
  });
  if (action.verb === "route") Object.assign(args, {
    role: action.role, profileId: action.profileId,
    ...(action.thinkingOptionId !== undefined ? { thinkingOptionId: action.thinkingOptionId } : {}),
    ...(action.now !== undefined ? { now: action.now } : {}),
  });
  if (action.verb === "move") Object.assign(args, {
    to: action.to, ...(action.instruction ? { instruction: action.instruction } : {}),
    ...(action.fresh !== undefined ? { fresh: action.fresh } : {}),
  });
  if (action.verb === "retry_effect" && action.effect) args.effect = action.effect;
  return { ok: true, args };
}

/**
 * What settling one accepted coordinator report changes on the task: the episode
 * resolves with its action's outcome, a refused report's reason lands on the stop
 * it answers, and a recovered report resolves the incident it owns. An episode or
 * action the accepted report no longer binds settles as the recorded event alone.
 */
export type RecoverySettlementPatch =
  | { kind: "event_only"; event: "coordinator_action_applied" | "coordinator_action_refused" }
  | { kind: "patch"; event: "coordinator_action_applied" | "coordinator_action_refused";
      changes: ResolutionChanges; patch: Partial<Task> };

export function recoverySettlementPatch(facts: {
  status: "applied" | "refused";
  reason?: string;
  binding: RecoveryActionBinding;
  /** The action the report asked for; a `cannot` carries the reason a refusal quotes. */
  action: CoordinatorAction;
  /** The recovery run whose report this is. */
  runId: string;
  /** The task as the settlement transaction reads it. */
  task: Task;
  /** The clock read the settlement records when it resolves an incident. */
  at: string;
}): RecoverySettlementPatch {
  const event = facts.status === "applied" ? "coordinator_action_applied" as const : "coordinator_action_refused" as const;
  const recovery = facts.task.resolution.recovery;
  if (!recovery || recovery.runId !== facts.runId || recovery.action?.eventId !== facts.binding.eventId) return { kind: "event_only", event };
  const stop = facts.task.resolution.stop;
  const matches = Boolean(stop && recovery.key === digest(`stop:${stop.reason}:${stop.since}`));
  const detail = facts.reason ?? (facts.action.verb === "cannot" ? facts.action.reason : "");
  const updatedStop = facts.status === "applied" ? null : matches && stop && detail
    ? { ...stop, detail: `${detail} — ${facts.binding.summary}`.slice(0, 4000) }
    : stop;
  const nextAction = facts.status === "applied"
    ? { ...facts.binding, status: "applied" as const }
    : { ...facts.binding, status: "refused" as const, reason: (facts.reason ?? "Coordinator report no longer matches the current task stop").slice(0, 4000) };
  const incident = facts.task.resolution.incident;
  const settledIncident = facts.status === "applied" && facts.binding.reportStatus === "recovered" && recovery.incidentId
    && incident?.id === recovery.incidentId && incident.status === "reconciling"
    ? { ...incident, status: "resolved" as const,
        detail: `Recovery reported the trigger settled: ${facts.binding.summary}`, updatedAt: facts.at }
    : incident;
  return { kind: "patch", event,
    changes: { recovery: { ...recovery, status: "resolved", summary: facts.binding.summary, action: nextAction },
      incident: settledIncident, recoveryActive: false, stop: updatedStop },
    patch: updatedStop && updatedStop.detail !== facts.task.reason ? { reason: updatedStop.detail } : {} };
}

/**
 * Settles what a recovery run reported, and the faults code can settle without
 * one, through the owner verbs. `Engine` registers both as `Recovery`'s handlers;
 * a `Resolution` built without an engine has neither. Same-name `Engine` methods
 * delegate here. `store` and `resolution` read the engine per call.
 */
const recoveryApplicationsInFlight = new Set<string>();

export type RecoverySettlementContext = Pick<Engine, 'coordinatorActionRunId' | 'host' | 'onTaskHost' | 'performTaskControl' | 'store'>
  & { readonly resolution: Pick<Resolution, 'attention' | 'recovery' | 'update'> };

export class RecoverySettlement {
 constructor(readonly engine:RecoverySettlementContext){}
 get store(){return this.engine.store;}
 get resolution(){return this.engine.resolution;}
  /** Apply one coordinator report as the corresponding Spec 050 owner verb. */
  async applyCoordinatorAction(task: Task, run: Run, binding: RecoveryActionBinding): Promise<void> {
    const action = binding.coordinatorAction;
    if (!action || resultApplied(this.store, task.id, run.id)) return;
    const finish = (status: "applied" | "refused", reason?: string) => {
      try {
        this.store.recordVerbOutcome(task.id, action.verb, status, "coordinator",
          { coordinatorRun: run.id, ...(reason ? { reason: reason.slice(0, 600) } : {}) }, `coordinator:${binding.eventId}`);
      } catch { /* the outcome stands even if its record could not be written */ }
      this.store.transaction(() => {
        const current = this.store.task(task.id);
        if (resultApplied(this.store, task.id, run.id)) return;
        const latestRun = this.store.run(run.id);
        if (latestRun && !latestRun.released)
          this.store.putRun({ ...latestRun, completion: latestRun.completion ?? run.completion, released: true, status: "finished" });
        const settlement = recoverySettlementPatch({ status, reason, binding, action, runId: run.id, task: current, at: new Date().toISOString() });
        if (settlement.kind === "event_only") this.store.event(task.id, settlement.event, binding.eventId);
        else this.resolution.update(current, settlement.changes, settlement.patch, settlement.event, binding.eventId);
        if (action.verb === 'cannot' && status === 'refused')
          this.resolution.recovery.escalate(this.store.task(task.id), `The coordinator cannot settle this stop: ${action.reason} — ${binding.summary}`.slice(0, 4000));
        recordResultApplied(this.store, task.id, run.id);
      });
    };

    const claimKey = JSON.stringify([task.id, run.id, binding.eventId]);
    if (recoveryApplicationsInFlight.has(claimKey)) return;
    const previousClaim = this.store.eventsAll(task.id).some(event => event.kind === 'run_result_applying' && event.detail === claimKey);
    if (previousClaim) {
      const outcome = this.store.db.prepare("SELECT outcome FROM verb_outcomes WHERE taskId=? AND key=?").get(task.id, `coordinator:${binding.eventId}`) as {outcome?: string} | undefined;
      if (outcome?.outcome === 'applied' || outcome?.outcome === 'refused') {
        finish(outcome.outcome);
      } else {
        const latest = this.store.task(task.id);
        const reason = `Coordinator result ${run.id} has an uncertain owner-verb outcome; inspect next and settle the existing action before retrying`;
        if (latest.reason !== reason) this.resolution.attention(latest, reason);
      }
      return;
    }
    const claimed = this.store.transaction(() => {
      const latest = this.store.task(task.id);
      if (resultApplied(this.store, task.id, run.id) || latest.resolution.recovery?.runId !== run.id
        || latest.resolution.recovery.action?.eventId !== binding.eventId
        || latest.resolution.recovery.action.status !== 'pending'
        || this.store.eventsAll(task.id).some(event => event.kind === 'run_result_applying' && event.detail === claimKey)) return false;
      this.store.event(task.id, 'run_result_applying', claimKey);
      return true;
    });
    if (!claimed) return;
    recoveryApplicationsInFlight.add(claimKey);
    try {
    const current = this.store.task(task.id);
    const recovery = current.resolution.recovery;
    const stop = current.resolution.stop;
    // Round 4 (2026-10-19 audit): the report binds to its episode and
    // generation, not to the exact stop record it was opened for. Whether the
    // reported verb still applies is the verb's own call below, from the same
    // views `next` shows — a refreshed or cleared stop is no reason to refuse.
    const bound = recovery?.runId === run.id && run.generation === current.coordinatorGeneration;
    if (!bound) {
      finish("refused", "The coordinator report arrived after a newer coordinator episode or generation took over the task");
      return;
    }
    // The report binds to the task's progress when the coordinator was asked:
    // a stop that churns between a wait and a stop for one condition is not the
    // task moving on (consumer-b #639 refused every report that way, including a
    // correct reviewer route). A result, a head, a phase, a run or a route that
    // changed is; the reported verb is then stale (review #535). Episodes opened
    // before the digest existed keep the exact stop binding.
    // Same-review checkpoint evolution leaves this intent guard unchanged;
    // recovery revisits unfinished delivery separately from report staleness.
    const moved = !coordinatorReportMatches(current);
    if (moved) {
      finish("refused", "The task moved on since the coordinator was asked (its results, head, phase, run or routes changed)");
      return;
    }
    if (action.verb === "cannot") {
      // A coordinator can arrive while the retained worker is still processing
      // its own run. Observe that exact binding before treating its report as a
      // fault: the worker remains the owner of its result.
      const revision = current.resolution.currentRunId ? this.store.run(current.resolution.currentRunId) : null;
      const worker = current.phase === "working" && current.agentId && current.runId && current.workspaceId && !current.completion
        ? { id: current.runId, agentId: current.agentId, workspaceId: current.workspaceId, revision: false }
        : revision?.role === "revision" && !revision.released && !revision.completion && revision.agentId
          && ["running", "uncertain"].includes(revision.status) && revision.agentId === current.agentId
          && revision.workspaceId === current.workspaceId
          ? { id: revision.id, agentId: revision.agentId, workspaceId: revision.workspaceId, revision: true } : null;
      if (worker) {
        const observed = await this.engine.onTaskHost(current, () => this.engine.host.observe(worker.agentId)).catch(() => null);
        const latest = this.store.task(task.id), latestRun = worker.revision ? this.store.run(worker.id) : null;
        if (observed && observed.id === worker.agentId && observed.workspaceId === worker.workspaceId
          && !["closed", "error"].includes(observed.status) && latest.version === current.version
          && (!worker.revision || latestRun && !latestRun.released && !latestRun.completion
            && latestRun.agentId === worker.agentId && latestRun.workspaceId === worker.workspaceId
            && ["running", "uncertain"].includes(latestRun.status)) && coordinatorReportMatches(latest)) {
          finish("applied", `Waiting for worker run ${worker.id} to report`);
          return;
        }
      }
      // The coordinator cannot settle it: the owner decides. Escalating keeps
      // the stop from reopening another coordinator episode (consumer-b #639).
      finish("refused", action.reason);
      return;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const current = this.store.task(task.id);
      if (current.resolution.recovery?.runId !== run.id || run.generation !== current.coordinatorGeneration || !coordinatorReportMatches(current))
        throw new Error("The task moved on since the coordinator was asked (its results, head, phase, run or routes changed)");
      const stop = current.resolution.stop;
      // The shared plan must read the same authenticated reporting-run binding the
      // applied verb does, so a report's own delivering run is never its fence.
      const facts = collectOwnerVerbFacts(this.store, current, null, run.id);
      const verb = ownerVerb(action.verb);
      const plan = coordinatorActionPlan({ action, views: ownerVerbViews(facts), stopReason: stop?.reason,
        routeCost: action.verb === "route" ? this.store.pool().find(entry => entry.profileId === action.profileId)?.cost ?? null : null,
        routeCapability: action.verb === "route" ? this.store.pool().find(entry => entry.profileId === action.profileId)?.capability ?? null : null,
        usage: this.store.usageLevel(), verbRegistered: Boolean(verb) });
      if (!plan.ok) throw new Error(plan.refusal);
      const args = plan.args;
      await this.engine.coordinatorActionRunId.run(run.id,
        () => verb!.apply(input => this.engine.performTaskControl(input), args));
      finish("applied");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only the explicit version refusal is safe to retry. Rebuild the plan
      // and recheck the report binding; never replay an uncertain effect.
      if (attempt === 0 && /^Task changed; refresh before (?:retrying|restarting) \(the task is now version \d+; read next again and reassess before retrying\)$/.test(message)) {
        this.store.event(task.id, "coordinator_action_version_retry", `${binding.eventId}: ${message}`);
        continue;
      }
      finish("refused", message);
      return;
    }
    }
    } finally { recoveryApplicationsInFlight.delete(claimKey); }
  }

  /**
   * Spec 058 slice 2: a responsible task's mechanical faults are settled by code
   * where it can. A reviewer that stopped without a verdict is replaced by the
   * ordinary fresh-reviewer path on the same task and exact head; one mechanical
   * restart per stopped head. A repeat at that head is a fault code cannot settle,
   * so recovery keeps it and opens the one retained recovery thread.
   *
   * A reviewer whose saved checkpoint Queue can still continue itself is left to
   * that continuation: a checkpoint is not a crash.
   */
  async settleResponsibleFault(task: Task): Promise<boolean> {
    const current = this.store.task(task.id);
    if (current.removedAt) return false;
    if (!["reviewing", "awaiting_review", "needs_attention", "blocked", "error"].includes(current.phase)) return false;
    const shape = restartShape(current, this.store.runs(current.id), "reviewer", this.store.eventsAll(current.id));
    if (shape !== "stopped_reviewer" && shape !== "checkpoint_reviewer") return false;
    // Queue continues an awaiting or delivered checkpoint itself; only a closed
    // agent (or a reviewer with no checkpoint) leaves an impossible continuation.
    const continuation = reviewContinuationState(current, this.store);
    if (continuation !== null && continuation !== "closed") return false;
    const run = current.resolution.currentRunId ? this.store.run(current.resolution.currentRunId) : null;
    if (!run || run.role !== "reviewer" || run.completion || run.released || run.active === true) return false;
    // A paused-stop marker owns the thread until its unpause resume settles: a
    // deliberate operator stop is not a crash, and the closed-session check
    // below must not race the resume (Queue #650).
    if (run.pausedStop) return false;
    // Only a positively stopped reviewer is a crash. An idle reviewer waiting on
    // its own operator question or permission is a wait, not a fault, so the
    // recorded stop or incident must name the reviewer stopping without a result.
    const incident = current.resolution.incident;
    const stoppedWithoutResult = Boolean(run.retainedAgentClosedAt)
      || /^The reviewer (?:thread stopped|callback reminder expired)/.test(current.reason)
      || Boolean(incident && incident.role === "reviewer" && incident.status !== "resolved"
        && (incident.cause === "missing_callback" || incident.cause === "stalled_turn"));
    if (!stoppedWithoutResult) return false;
    const identity = digest(`responsible-fault:${current.id}:${run.head}:${shape}`);
    if (this.store.eventsAll(current.id).some(event => event.kind === "responsible_fault_restart" && event.detail === identity)) return false;
    // The event is the durable intent, written before the control and outside the
    // task row, so even a refused restart leaves one recorded decision.
    this.store.event(current.id, "responsible_fault_restart", identity);
    try {
      await this.engine.performTaskControl(taskControlInputSchema.parse({
        taskId: current.id, version: current.version, action: "restart", role: "reviewer", fresh: true, caller: "queue",
        reason: "Responsible task: the reviewer stopped without a result; Nucleus restarts it at the same exact head (Spec 058). "
          + (shape === "checkpoint_reviewer" ? "Its saved checkpoint cannot receive a same-agent continuation because the agent is closed." : "The stopped reviewer run is replaced on the same task."),
      }));
      return true;
    } catch (error) {
      this.store.event(current.id, "responsible_fault_restart_refused", `${identity}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
