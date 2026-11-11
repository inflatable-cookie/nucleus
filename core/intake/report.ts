import {z} from 'zod';
import {digest} from '../store/store';
import type {Engine} from '../engine';
import {completionBaseSchema,completionSchema,refineCoordinatorCompletionAction} from '../../shared/contracts';
import {reportHeadline} from '../../shared/task-detail-summary';
import {assertReviewResponsibility} from '../review/review-verdicts';
import {liveResumeRunSupersedes,recordSupersededRunRefusal,supersededByPendingResume,supersededPriorRevisionRun,supersededResumeRefusal} from '../recovery/superseded-resume';
import {ownerArmedRetainedWorker} from '../recovery/task-reasons';
// recoveryAction and replacementAgentId are retired (Spec 050); stored records keep them readable.
export const reportSchema=completionBaseSchema.omit({reviewCommentId:true,reviewId:true,coordinatorGeneration:true,recoveryAction:true,replacementAgentId:true}).extend({reviewText:z.string().trim().min(1).max(48000).optional()}).strict().superRefine(refineCoordinatorCompletionAction);
export type ReportInput=z.infer<typeof reportSchema>;
// Serialize duplicate MCP calls. Receipts and publication intent also survive reloads.
export class Reports {
  private pending=new Map<string,Promise<unknown>>();
  constructor(readonly engine:Engine){}
  async report(input:ReportInput,token:string) {
    const previous=this.pending.get(input.runId)??Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>this.perform(input,token));
    this.pending.set(input.runId,operation);
    try{return await operation;}finally{if(this.pending.get(input.runId)===operation)this.pending.delete(input.runId);}
  }
  private async perform(input:ReportInput,token:string) {
    const store=this.engine.store;
    const identityRunId=input.runId;
    try { store.authenticate(input.runId,token); }
    catch(error) {
      const credentialRunId=store.credentialRunForToken(token);
      if(!credentialRunId)throw error;
      store.authenticate(credentialRunId,token);
      throw this.staleRun(input.runId,credentialRunId,input.taskId);
    }
    const hash=digest(JSON.stringify(input));
    const prior=store.db.prepare('SELECT task,run,hash,response,report_hash,report_response FROM receipts WHERE id=?').get(input.eventId);
    if(prior?.report_hash && prior.report_hash!==hash)throw Error('Report event ID conflict');
    if(prior?.report_response){const saved=JSON.parse(String(prior.report_response));if(saved.hash!==hash)throw Error('Report event ID conflict');return saved.response;}
    if(prior?.report_hash && prior.hash && prior.task===input.taskId && prior.run===input.runId)return JSON.parse(String(prior.response));
    const task=store.task(input.taskId),run=store.run(input.runId);
    if(task.removedAt)throw Error('Task was removed');
    // Round 4 (papercut 4b274634): the same forward correction resolution.complete
    // accepts — the current, unreleased, non-recovery run that reported blocked or
    // error now reports its role's success — is not a stale report here either.
    const correctingBlock=Boolean(run && run.role!=='recovery' && !run.released && task.resolution.currentRunId===run.id
      && run.completion && ['blocked','error'].includes(run.completion.status) && !['blocked','error'].includes(input.status));
    // Task 560: a superseded proof executor's late report is historical
    // evidence, recorded by the completion path — never a stale rejection
    // that strands its execution record as running with no completion. The
    // bypass stays inside the run's own task: a report about another task's
    // run is stale here exactly as before.
    const supersededExecutor = run?.role === 'executor' && run.taskId === task.id && (run.released || task.resolution.currentRunId !== run.id);
    // Queue #691: a run of a finished task reports as evidence, released or not; the completion path records it.
    const finishedTaskRun = Boolean(run && run.role !== 'executor' && run.taskId === task.id && ['done', 'cancelled'].includes(task.phase));
    if(!supersededExecutor && !finishedTaskRun && run && (run.taskId!==task.id || (run.role==='recovery'?task.resolution.recovery?.runId:task.resolution.currentRunId)!==run.id || run.released || run.completion&&!correctingBlock || ['closeout','recovery'].includes(run.role)&&run.generation!==task.coordinatorGeneration))throw this.staleRun(input.runId,identityRunId,input.taskId);
    // Spec 050: an owner-armed replacement that has not retired the retained
    // worker yet is that worker's own binding, so its genuine authenticated
    // result is accepted here exactly as the completion handler accepts it. The
    // derivation refuses retired, replaced, released, superseded, foreign and
    // otherwise unbound workers, so no other `changes_requested` report widens.
    if(!run && (task.runId!==input.runId || task.completion
      || (!['working','dispatching','needs_attention'].includes(task.phase) && !ownerArmedRetainedWorker(task,store.runs(task.id)))))
      throw this.staleRun(input.runId,identityRunId,input.taskId);
    const blockedReviewerEvidence = run?.role === 'reviewer' && ['blocked', 'error'].includes(input.status)
      && Boolean(input.reviewText || input.verdicts?.length);
    if (blockedReviewerEvidence && input.head && input.head !== run.head) throw Error('Blocked reviewer evidence must name the requested exact head');
    const {reviewText,...rest}=input;
    // Task 538: every accepted report carries a headline; a caller that omits one —
    // an older helper, or a role whose prompt predates the field — gets the first
    // sentence of its summary, so the card and the detail always have one.
    const derivedHeadline=reportHeadline({headline:rest.headline,summary:rest.summary});
    const result=derivedHeadline?{...rest,headline:derivedHeadline}:rest;
    let completion=completionSchema.parse({...result,...(run && run.role!=='revision'?{head:run.head}:{}),...(run && ['closeout','recovery'].includes(run.role)?{coordinatorGeneration:run.generation}:{})});
    if(input.providerUnavailable && !['blocked','error'].includes(input.status))throw Error('Provider unavailability requires blocked/error');
    assertReviewResponsibility(input, run);
    if(run?.role==='reviewer' && ['ready_to_merge','changes_required'].includes(input.status)){
      if(!reviewText)throw Error('Review verdict requires reviewText containing the full findings');
      completion={...completion,reviewText};
    }else if(blockedReviewerEvidence && reviewText){
      // Findings are retained with the authenticated blocked run, never published
      // as a verdict or used to satisfy an approval/pass gate.
      completion={...completion,reviewText};
    }else if(reviewText)throw Error('Field reviewText is only accepted for reviewer verdicts or blocked reviewer evidence; expected shape: omit it from ready_for_review reports');
    store.setReportIntent(input.eventId,input.taskId,input.runId,hash);
    const response=await this.engine.complete(completion,token);
    store.setReportResponse(input.eventId,hash,response);return response;
  }
  private staleRun(suppliedRunId:string,identityRunId:string,taskId:string) {
    const store=this.engine.store;
    const task=store.tasks().find(candidate=>candidate.id===taskId);
    if(task && (supersededByPendingResume(task,suppliedRunId)||(suppliedRunId===task.runId&&liveResumeRunSupersedes(store.runs(task.id),task.agentId,suppliedRunId)))) {
      recordSupersededRunRefusal(store,task.id,suppliedRunId);
      return Error(supersededResumeRefusal(suppliedRunId));
    }
    const reported=store.run(suppliedRunId);
    if(task && reported && supersededPriorRevisionRun(task,reported,store.runs(task.id))) {
      recordSupersededRunRefusal(store,task.id,suppliedRunId);
      return Error(supersededResumeRefusal(suppliedRunId));
    }
    const identityRun=store.run(identityRunId);
    const tasks=store.tasks();
    const agentId=identityRun?.agentId??tasks.find(task=>task.runId===identityRunId)?.agentId??tasks.flatMap(task=>task.retiredWorkers).find(worker=>worker.runId===identityRunId)?.agentId??null;
    const identityHost=identityRun?.hostId??tasks.find(task=>task.runId===identityRunId)?.hostId;
    if(agentId && identityHost) {
      const byTask=new Map(tasks.map(task=>[task.id,task]));
      const active=new Set<string>();
      for(const candidate of store.unreleasedRunsForAgent(agentId, identityHost)) {
        if(!candidate.hostId)return Error('Stale reporting run');
        if(candidate.hostId!==identityHost)continue;
        if(candidate.completion)continue;
        const task=byTask.get(candidate.taskId);
        if(!task)continue;
        const currentRunId=candidate.role==='recovery'?task.resolution.recovery?.runId:task.resolution.currentRunId;
        if(currentRunId!==candidate.id||(['closeout','recovery'].includes(candidate.role)&&candidate.generation!==task.coordinatorGeneration))continue;
        active.add(candidate.id);
      }
      for(const task of tasks) {
        if(task.hostId!==identityHost||task.agentId!==agentId||!task.runId||task.completion||task.resolution.currentRunId||!['working','dispatching','needs_attention'].includes(task.phase))continue;
        if(!store.run(task.runId))active.add(task.runId);
      }
      if(active.size===1) {
        const activeRunId=[...active][0];
        if(activeRunId!==suppliedRunId)return Error(`Unknown run ${suppliedRunId}; this session is not the active run ${activeRunId}. Do not resend through this callback. Nucleus will relaunch the role on a fresh thread that can report.`);
      }
    }
    return Error('Stale reporting run');
  }
}
