import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type Run, type Task } from '../../shared/contracts';
import { now } from '../store/store';
import { ABSENT_WORKER_REASON, PRE_AGENT_LAUNCH_FAILURE_REASON, ABSENT_WORKER_REPLACEMENT_REASON, ABSENT_RESOLUTION_REASON, resolutionCreationRoles, coordinative } from './task-reasons';
import { isDispositionActive, isDispositionComplete } from '../../shared/contracts';
import { isPiSettingsLockFailure } from './exhaustion';
import { runFenceRefusal, runSettlementFence, DurableFenceRefusal } from '../intake/run-settlement';
import { ownerReviewContext } from '../review/owner-review-context';
import { taskPrNumber } from '../forge/index';
import type { Resolution } from '../resolution';

/** Recreate proven-absent runs. */
export type AbsentRestartsContext = Pick<Resolution, 'adapter' | 'attention' | 'ensureIncident' | 'graceMs' | 'paused' | 'recordIncidentEvent' | 'resolveIncident' | 'resumeWorkerContinuation' | 'settleVerbFences' | 'store' | 'update'>;

export class AbsentRestarts {
  constructor(readonly resolution: AbsentRestartsContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  get graceMs() { return this.resolution.graceMs; }

  /**
   * Mint one worker in the retained workspace for a proven-absent creation.
   *
   * `authorized` is the operator path: it also accepts the post-replacement escalation the
   * automatic budget writes, because the state is recoverable and only the automatic path's
   * budget should stop it. Automatic and recovery callers keep the initial reason only, so
   * the one-replacement budget stays exactly one and a later automatic absence still
   * escalates. The event differs, so an operator replacement is visible as such and never
   * counts as the automatic retry.
   */
  admitAbsentWorker(t:Task,instruction:string,authorized=false,settleRunIds:string[]=[]): string {
    const retry=t.transientProviderRetry;
    const preAgentFailure=t.reason===PRE_AGENT_LAUNCH_FAILURE_REASON&&retry?.runId===t.runId&&retry.status==='waiting'&&retry.resumes===0&&isPiSettingsLockFailure(retry.error);
    const accepted=authorized?[ABSENT_WORKER_REASON,ABSENT_WORKER_REPLACEMENT_REASON]:[ABSENT_WORKER_REASON];
    if(t.phase!=='needs_attention'||(!accepted.includes(t.reason)&&!preAgentFailure)||!t.agentIntent||t.agentId||!t.runId||!t.workspaceId||!t.directory||!t.profile)
      throw Error('Absent-worker retry requires a retained creation intent with no worker');
    if(t.prerequisiteWait && !t.prerequisiteWait.releasedAt)
      throw new Error('Task is waiting for its retained prerequisites; wait for the owner notice or clear the wait');
    if(t.completion||t.prUrl||t.prHead||t.resolution.currentRunId||t.resolution.mergeIntent||t.resolution.mergedCommit)
      throw Error('Absent-worker retry cannot replace accepted work, PR, resolution, or merge state');
    if(this.store.runs(t.id).some(r=>r.role!=='recovery'&&!r.released&&!settleRunIds.includes(r.id)))throw Error('Absent-worker retry has an unresolved task run');
    const action=instruction.trim();if(!action)throw Error('Worker resume requires an explicit instruction');
    return action;
  }

  resumeAbsentWorker(t:Task,instruction:string,authorized=false){
    const action=this.admitAbsentWorker(t,instruction,authorized);
    return this.resolution.resumeWorkerContinuation(t,authorized,current=>{
      this.store.deleteCredential(current.runId!);
      // Spec 050 `restart`: keep the run identity and mark it, so the launcher
      // reuses it for the retried creation instead of minting a second run.
      return this.store.update(current.id,{agentIntent:false,runId:current.runId,restartRunId:current.runId,transientProviderRetry:undefined,phase:'dispatching',reason:'Confirmed absent worker; creating a worker in the retained workspace',resolution:{...current.resolution,pendingWorkerInstruction:action}},authorized?'absent_worker_operator_replacement':'absent_worker_retry',action);
    });
  }

  absentResolutionRun(t:Task){
    const run=t.resolution.currentRunId?this.store.run(t.resolution.currentRunId):null;
    if(!run||run.released||run.agentId||run.completion||run.status!=='uncertain'||!resolutionCreationRoles.has(run.role))return null;
    return run;
  }

  admitAbsentResolution(t:Task,runId:string,settleRunIds:string[]=[]): Run {
    const current=t;
    const run=this.absentResolutionRun(current);
    if(!run||run.id!==runId)throw Error('Absent resolution-run recovery requires an uncertain reviewer or coordinator creation with no agent');
    if(!current.workspaceId||!current.directory)throw Error('Absent resolution-run recovery requires the retained task workspace');
    if(run.taskId!==current.id||current.workspaceId!==run.workspaceId)throw Error('Absent resolution-run identity or workspace changed');
    if(current.resolution.mergeIntent&&!current.resolution.mergedCommit)throw Error('Absent resolution-run recovery cannot replace an uncertain merge intent');
    if(run.role!=='closeout'&&current.resolution.mergedCommit)throw Error('Absent resolution-run recovery cannot replace a merged PR');
    if(this.store.runs(current.id).some(r=>r.id!==run.id&&r.role!=='recovery'&&!r.released&&!settleRunIds.includes(r.id)))throw Error('Absent resolution-run recovery has another unresolved task run');
    return run;
  }

  /**
   * Spec 050 `restart`: recreate one proven-absent resolution run under the SAME
   * run ID. The caller has already completed the inventory lookup; this reserves
   * fresh, valid creation identities for the existing run and calls the launcher
   * once, so no second run is minted.
   */
  async admitUncertainRunRestart(t:Task,runId:string,settleRunIds:string[]=[]):Promise<void>{
    this.admitAbsentResolution(t,runId,settleRunIds);
    if(this.resolution.paused())throw Error('Nucleus is paused; uncertain run restart is deferred');
    if(!this.adapter.createRun)throw Error('Agent creation is unavailable; uncertain run restart refused');
  }

  async restartUncertainRun(t:Task,runId:string,instruction:string|null,settleFences?:{detail:string;runIds:string[];displacedRunIds?:string[]}):Promise<Task>{
    let run=this.store.run(runId)!;
    await this.admitUncertainRunRestart(t,runId,settleFences?[...settleFences.runIds,...(settleFences.displacedRunIds??[])]:[]);
    const recheck = () => {
      const task=this.store.task(t.id), latest=this.store.run(runId);
      if(task.version!==t.version||task.resolution.currentRunId!==runId||!isDeepStrictEqual(latest,run))
        throw Error('Uncertain run changed during restart; inspect the recorded creation outcome before retrying');
      this.admitAbsentResolution(task,runId,settleFences?[...settleFences.runIds,...(settleFences.displacedRunIds??[])]:[]);
      for(const id of [...(settleFences?.runIds??[]),...(settleFences?.displacedRunIds??[])]){
        const settling=this.store.run(id);
        const why=settling&&!settling.released?runSettlementFence({store:this.store,task},settling):null;
        if(why)throw new DurableFenceRefusal(runFenceRefusal(settling!,why));
      }
      if(this.resolution.paused())throw Error('Nucleus is paused; uncertain run restart is deferred');
    };
    recheck();
    const token=randomBytes(32).toString('hex');
    // Review #534: the recreated agent's credential is durable before the agent
    // exists, so a crash after creation leaves an agent whose callbacks still
    // authenticate once exact lookup binds it (the launcher owns credentials).
    this.store.transaction(()=>{
      this.store.deleteCredential(run!.id);
      this.store.setCredential(run!.id,token);
    });
    let created:{id:string;workspaceId:string|null};
    try{
      const fresh = this.store.task(t.id), savedRun = this.store.run(run.id)!;
      created=await this.adapter.createRun!(fresh,savedRun,token,null,ownerReviewContext(this.store,fresh,savedRun));
    }catch(error){
      this.resolution.ensureIncident(this.store.task(t.id),this.store.run(run.id)!,ABSENT_RESOLUTION_REASON,'exact_lookup');
      throw error;
    }
    if(created.workspaceId!==run.workspaceId)throw Error('Recreated run returned in the wrong workspace');
    const current=this.store.task(t.id);
    return this.store.transaction(()=>{
      recheck();
      const latest=this.store.run(run.id)!;
      if(latest.released||latest.agentId||latest.completion)throw Error('Uncertain run changed during restart; no second run was created');
      // Spec 050 (#3569): the restart settles its armed fences atomically with
      // the recreation; a refusal inside rolls both back.
      if(settleFences)this.resolution.settleVerbFences(t.id,settleFences);
      const settledTask=this.store.task(t.id);
      // The recreated agent authenticates on the token persisted before creation.
      this.store.putRun({...latest,agentId:created.id,status:'running',active:true});
      const updated=this.resolution.update(settledTask,{attention:false,...(latest.role==='reviewer'?{reviewerAgentId:created.id,reviewerProfile:latest.profile}:{})},
        {...(coordinative(latest)&&current.coordinatorGeneration===latest.generation&&!current.coordinatorAgentId?{coordinatorAgentId:created.id}:{}),
          reason:`Restarted ${latest.role} run ${latest.id} under the same run ID`},'absent_creation_restarted',`${latest.id}/${created.id}${instruction?` instruction ${instruction.slice(0,80)}`:''}`);
      this.resolution.resolveIncident(this.store.task(t.id),latest.id,`Restart recreated ${latest.role} run ${latest.id} under the same run ID`);
      return this.store.task(updated.id);
    });
  }

  /**
   * Zero/one/many reconciliation for one uncertain creation. After the bounded
   * grace: bind one exact match (done by the caller), replace a proven-absent
   * creation exactly once, or hand ambiguity and second failures to the coordinator.
   */
  async reconcileAbsentCreation(t: Task, run: Run, found: { id: string; workspaceId: string | null }[]) {
    if (isDispositionActive(t) || isDispositionComplete(t)) return;
    const incident = this.resolution.ensureIncident(t, run, ABSENT_RESOLUTION_REASON, 'exact_lookup');
    if (Date.now() - Date.parse(incident.createdAt) < this.graceMs) return;
    const current = this.store.task(t.id);
    // The replacement budget is durable: one recorded same-role replacement means the next absence escalates.
    if (this.store.events(t.id).some(event => event.kind === 'absent_creation_replaced' && event.detail.includes(` ${run.role} creation`))) {
      this.resolution.attention(current, `A replacement ${run.role} creation also proved absent after an exact lookup; coordinator attention required`);
      return;
    }
    if (found.length > 1) {
      this.resolution.attention(current, `${run.role} creation lookup is ambiguous (${found.length} matching agents); no resource was created`);
      return;
    }
    try {
      await this.replaceAbsentCreation(current, run);
    } catch (error) {
      this.resolution.attention(this.store.task(t.id), `Absent ${run.role} creation could not be replaced safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Atomically revoke one proven-absent callback and issue exactly one same-role replacement. */
  async replaceAbsentCreation(t: Task, run: Run) {
    if (isDispositionActive(t) || isDispositionComplete(t)) return;
    if (t.removedAt) throw new Error('Task was removed from the queue');
    if (!t.workspaceId || !t.directory) throw new Error('Absent run replacement requires the retained task workspace');
    if (t.resolution.mergeIntent && !t.resolution.mergedCommit) throw new Error('Absent run replacement cannot replace an uncertain merge intent');
    if (run.role !== 'closeout' && t.resolution.mergedCommit) throw new Error('Absent run replacement cannot replace a merged PR');
    if (this.adapter.workspaceAvailable && !await this.adapter.workspaceAvailable(t.workspaceId)) throw new Error('Absent run replacement requires the retained task workspace');
    if (run.role === 'closeout') {
      if (!this.adapter.verifyCleanQueueWorktree) throw new Error('Workspace verification is unavailable');
      await this.adapter.verifyCleanQueueWorktree(t);
    } else {
      const pr = await this.adapter.verifyPr(t, taskPrNumber(t));
      if (pr.head !== t.prHead || pr.head !== run.head) throw new Error('PR head changed; inspect it before replacing the absent run');
    }
    const current = this.store.task(t.id);
    if (isDispositionActive(current) || isDispositionComplete(current)) return;
    const live = current.resolution.currentRunId ? this.store.run(current.resolution.currentRunId) : null;
    if (!live || live.id !== run.id || live.agentId || live.completion || live.released) throw new Error('Task changed during absent-run reconciliation');
    this.adapter.purgeReportingFiles?.(t.id, [run.id]);
    this.store.transaction(() => {
      this.store.deleteCredential(run.id);
      this.store.putRun({ ...run, status: 'superseded', released: true });
      const incident = current.resolution.incident!;
      const phase = run.role === 'reviewer' ? 'awaiting_review' : run.role === 'executor' ? (run.proofExecution?.returnPhase ?? 'awaiting_review') : 'closing';
      this.resolution.update(current, {
        currentRunId: null, attention: false,
        incident: { ...incident, action: 'replacement', attempt: incident.attempt + 1, detail: `Proven-absent ${run.role} callback revoked; one replacement issued`, status: 'reconciling', updatedAt: now() },
      }, { phase, reason: `Confirmed absent ${run.role} creation; Nucleus issued one replacement` }, 'absent_creation_replaced');
      this.resolution.recordIncidentEvent(current.id, { ...incident, action: 'replacement', attempt: incident.attempt + 1, status: 'reconciling', updatedAt: now() });
    });
  }
}
