import { digest, now } from '../store/store';
import type {Run, Task} from '../../shared/contracts';
import {isDispositionActive,isDispositionComplete} from '../../shared/contracts';
import { isWaitingTaskStop } from '../../shared/task-stop';
import { reviewFenceHoldsCoordinators } from '../review/review-continuation';
import { dispatchBlocked } from '../dispatch/capacity';
import {RECOVERY_ESCALATION_FAILURE_PREFIX} from './task-reasons';
import {ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX, cause, needsAttention, type CoordinatorEpisode, type RecoveryContext} from './coordinator-episode';

/**
 * How long a recovery episode may sit pending with no run before it escalates.
 *
 * Papercut 0489ea25: nucleus#1166's stalled turn recorded `recovery_pending` and
 * then nothing for 2h14m, because the stalled worker still held the workspace
 * lease and no launch, wait or escalation followed. A pending episode that
 * starts no run inside this bound reaches the task's planner ladder instead.
 */
export const RECOVERY_PENDING_BOUND_MS = 3 * 60_000;
/** The pending episode's escalation, naming the stop and the verb that exits it. */
export const recoveryPendingEscalation = (t: Task): string => {
 const stop = t.resolution.stop;
 const verbs = stop?.suggestedVerbs?.length ? stop.suggestedVerbs.join(', ') : 'next';
 const detail = (stop?.detail ?? t.reason).slice(0, 1200);
 return `Recovery was requested for this task but started no run within ${Math.round(RECOVERY_PENDING_BOUND_MS / 60_000)} minutes: ${stop ? `stop ${stop.reason} — ${detail}` : detail}. Nothing else followed, so Nucleus asks the planner ladder which owner action continues it. The exit is ${verbs}; next lists every verb with its refusal.`;
};
/** The recovery coordinator stopped without a result: its thread holds the answer, and nothing repeats its prompt. */
export const RECOVERY_STOPPED_WITHOUT_RESULT = 'The recovery coordinator stopped without a result. Inspect its thread; the plugin has not repeated its prompt.';

export type CoordinatorPassContext = {
  readonly resolution: RecoveryContext;
  readonly episode: CoordinatorEpisode;
  /** Tests shorten the pending-episode bound without waiting minutes. */
  readonly pendingBoundMs: () => number;
};

/**
 * The recovery pass: one sweep over the tasks that hold a coordinator run. It
 * observes that exact run, settles it when it finished, supersedes it when the
 * generation changed, releases a proven-absent creation, hands a responsible
 * task's report to its planner ladder, and escalates a pending episode that
 * starts no run inside its bound. It decides nothing about which tasks need a
 * coordinator: that is `CoordinatorRoute`.
 */
export class CoordinatorPass {
 constructor(private readonly context: CoordinatorPassContext){}
 get resolution(){return this.context.resolution}
 get episode(){return this.context.episode}
 get store(){return this.context.resolution.store}
 /** The engine's handler that applies one accepted coordinator report as an owner verb. */
 coordinatorActionHandler:((task:Task,run:Run,action:import('../../shared/contracts').RecoveryActionBinding)=>Promise<void>)|null=null;
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
   if(!incident?.runId){
     // Papercut 0489ea25: a pending episode with no run is invisible unless it
     // reaches someone. The pending event is its clock; a legitimate capacity,
     // dispatch or route wait clears the episode (`wait`) instead of leaving it.
     // Paused, dispatch-held and accepted-action episodes are not silent: their
     // own wait or owner owns them and moves no escalation here.
     const pendingSince = incident?.status === 'pending' && !incident.action
       ? this.store.eventsAll(t.id).findLast(event => event.kind === 'recovery_pending')?.at ?? null : null;
     // A planner's recorded task, time or decision wait owns the next action.
     // It is not an empty recovery episode waiting for a coordinator launch.
     const ownerWaitActive = Boolean(t.resolution.stop && isWaitingTaskStop(t.resolution.stop.reason));
     if (incident && pendingSince && !this.resolution.startsNoRuns() && !dispatchBlocked(t)
       && !ownerWaitActive && Date.now() - Date.parse(pendingSince) >= this.context.pendingBoundMs()) {
       const summary = recoveryPendingEscalation(t);
       this.episode.escalate(t, summary);
       this.resolution.openPlannerEscalation(this.store.task(t.id), {
         cause: digest(`recovery-pending:${t.id}:${incident.id}`), runId: null, question: summary,
         payload: { cause: 'recovery-pending', taskId: t.id, runId: null, question: summary },
         suggestedVerbs: t.resolution.stop?.suggestedVerbs,
       });
       continue;
     }
     continue;
   }
   if(isDispositionActive(t)||isDispositionComplete(t)||dispatchBlocked(t))continue;
   // Queue #691: a finished task's coordinator gets no further authority. Its silence never escalates
   // the done task, and its report is evidence (Resolution.complete); terminal cleanup releases the run.
   if(['done','cancelled'].includes(t.phase))continue;
   const episodeRunId=incident.runId;
   if(reviewFenceHoldsCoordinators(t,this.store)){
    // A finished accepted recovery still settles its bookkeeping while review
    // authorization holds (Spec 050: no verb is refused by a stale record);
    // nothing else about the task moves until authorization returns.
    await this.episode.settleAuthorizationFencedRun(t);
    continue;
   }
   let run=this.store.run(incident.runId);if(!run||run.released)continue;
   try{
    if(run.generation!==t.coordinatorGeneration){
     const latest=this.store.run(run.id)!;
     const binding=this.episode.bindingFrom(latest,incident);
     if(binding&&(binding.status==='pending'||latest.completion)){
      this.episode.refuseAcceptedAction(t,latest,binding,'coordinator generation changed after the accepted report',needsAttention(this.store.task(t.id),this.store));
      continue;
     }
     this.store.putRun({...latest,released:true,status:'superseded'});this.resolution.update(t,{recoveryActive:false});this.episode.save(t,{status:'resolved'});continue;
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
     if(!run.agentId&&found.length===0&&this.episode.failedCreationRun(t,run)){
      const absentRunId=run.id,taskId=t.id;
      this.resolution.adapter.purgeReportingFiles?.(taskId,[absentRunId]);
      this.store.transaction(()=>{
       const latestTask=this.store.task(taskId),currentRun=this.store.run(absentRunId);
       if(currentRun&&this.episode.failedCreationRun(latestTask,currentRun))
        this.episode.releaseAbsent(latestTask,absentRunId,'Exact task/run label lookup found no coordinator; failed creation superseded and released');
      });
      continue;
     }
     if(!run.agentId&&(found.length!==1||found[0].workspaceId!==run.workspaceId)){this.episode.escalate(t,'Coordinator recovery creation is uncertain; no duplicate was launched. Inspect the queue run before retrying.');continue;}
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
    if(reviewFenceHoldsCoordinators(this.store.task(t.id),this.store)){await this.episode.settleAuthorizationFencedRun(this.store.task(t.id));continue;}
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
      this.episode.escalate(t,RECOVERY_STOPPED_WITHOUT_RESULT);
     }
     continue;
    }
    if(!await this.resolution.lease(t)||this.resolution.startsNoRuns())continue;
    const finishedRun=run;
    const accepted=this.episode.bindingFrom(run,incident);
    const reported=accepted?this.episode.completionFromBinding(t,finishedRun,accepted):null;
    if(t.responsible&&accepted&&reported&&['blocked','error'].includes(accepted.reportStatus)&&reported.providerUnavailable!==true){
     this.store.transaction(()=>this.episode.settleFinishedRun(this.store.task(t.id),finishedRun,`Recovery reported ${accepted.reportStatus}: ${accepted.summary}; handing it to the responsible-task planner ladder`));
     await this.resolution.responsibleBlockerLadder(this.store.task(t.id),{source:'recovery',runId:finishedRun.id,completion:reported});
     continue;
    }
    if(accepted?.status==='pending'&&accepted.coordinatorAction){
     if(this.coordinatorActionHandler)await this.coordinatorActionHandler(t,run,accepted);
     else this.episode.refuseAcceptedAction(t,run,accepted,'the task reconciler cannot apply coordinator owner verbs in this context',false);
     continue;
    }
    this.store.transaction(()=>{
     const latestRun=this.store.run(finishedRun.id)!;
     t=this.store.task(t.id);
     incident=t.resolution.recovery!;
     const action=this.episode.bindingFrom(latestRun,incident);
     if(!action||action.status==='applied'||action.status==='refused'){
      if(!latestRun.released)this.store.putRun({...latestRun,completion:latestRun.completion??(action?this.episode.completionFromBinding(t,latestRun,action):null),released:true,status:'finished'});
      return;
     }
     // A pending accepted report without a coordinator owner verb is a legacy
     // narrow recovery action (Spec 049 era). The owner verbs own every
     // continuation now, so the stale action is recorded as not applied —
     // audibly, with the escalation kept — and the run releases. The stale
     // retry is never executed.
     this.episode.refuseAcceptedAction(t,latestRun,action,'narrow recovery actions are retired; continue with the owner verbs',needsAttention(t,this.store));
    });
   }catch(error){
    if(this.resolution.startsNoRuns())continue;
    const reason=error instanceof Error?error.message:String(error);
    t=this.store.task(t.id);
    incident=t.resolution.recovery;
    const latest=incident?.runId?this.store.run(incident.runId):null;
    const binding=latest&&incident?this.episode.bindingFrom(latest,incident):null;
    // Observation (or another live check) failed after an authenticated report:
    // keep the pending action and name it. A later pass can still apply it.
    if(binding?.status==='pending')
     this.episode.escalate(t,`${RECOVERY_ESCALATION_FAILURE_PREFIX}${reason}. ${ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX}${this.episode.acceptedActionIdentity(binding)} remains pending`);
    else this.episode.escalate(t,`${RECOVERY_ESCALATION_FAILURE_PREFIX}${reason}`);
   }
  }
}
}
