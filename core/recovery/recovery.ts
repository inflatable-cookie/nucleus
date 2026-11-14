import type { RecoveryActionBinding, Run, Task } from '../../shared/contracts';
import { CoordinatorEpisode, type RecoveryContext } from './coordinator-episode';
import { CoordinatorPass, RECOVERY_PENDING_BOUND_MS } from './coordinator-pass';
import { CoordinatorRoute } from './coordinator-route';

/**
 * The recovery coordinator surface a task holds: one episode, and the two stages
 * that serve it. `CoordinatorRoute` decides whether this task needs a coordinator
 * and launches it; `CoordinatorPass` observes that run until it reports; the
 * episode in `coordinator-episode.ts` owns its durable bookkeeping; the pure rules
 * over a report live in `coordinator-report.ts`, and the owner-verb application in
 * `coordinator-settlement.ts`. This class only wires them together for its
 * callers, so `Resolution.recovery` keeps one shape.
 */
export class Recovery {
 constructor(readonly resolution:RecoveryContext){
  this.episode=new CoordinatorEpisode(resolution);
  this.passStage=new CoordinatorPass({resolution,episode:this.episode,pendingBoundMs:()=>this.pendingBoundMs});
  this.routeStage=new CoordinatorRoute(resolution,this.episode);
 }
 /** Tests shorten this to drive the pending-episode bound without waiting minutes. */
 pendingBoundMs = RECOVERY_PENDING_BOUND_MS;
 private readonly episode:CoordinatorEpisode;
 private readonly passStage:CoordinatorPass;
 private readonly routeStage:CoordinatorRoute;
 /** The engine's handler that applies one accepted coordinator report as an owner verb. */
 setCoordinatorActionHandler(handler:(task:Task,run:Run,action:RecoveryActionBinding)=>Promise<void>){this.passStage.coordinatorActionHandler=handler;}
 /** Engine-provided Spec 058 mechanical settlement for an opted-in responsible task. */
 setResponsibleFaultHandler(handler:(task:Task)=>Promise<boolean>){this.routeStage.setResponsibleFaultHandler(handler);}
 busy(t:Task){return this.episode.busy(t)}
 escalate(t:Task,summary:string){return this.episode.escalate(t,summary);}
 settledEpisodeChanges(...args:Parameters<CoordinatorEpisode['settledEpisodeChanges']>):Partial<Task['resolution']>|null{return this.episode.settledEpisodeChanges(...args);}
 settleFinishedRun(...args:Parameters<CoordinatorEpisode['settleFinishedRun']>):void{return this.episode.settleFinishedRun(...args);}
 releaseWithNotAppliedAction(...args:Parameters<CoordinatorEpisode['releaseWithNotAppliedAction']>):boolean{return this.episode.releaseWithNotAppliedAction(...args);}
 absentRun(t:Task){return this.episode.absentRun(t);}
 releaseAbsent(...args:Parameters<CoordinatorEpisode['releaseAbsent']>){return this.episode.releaseAbsent(...args);}
 settleAuthorizationFencedRun(t:Task){return this.episode.settleAuthorizationFencedRun(t);}
 pass(taskId?:string){return this.passStage.pass(taskId);}
 route(t:Task){return this.routeStage.route(t);}
}
export type { RecoveryContext };
