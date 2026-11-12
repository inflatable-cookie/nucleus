import { participantToolRunIds } from '../recovery/task-reasons';
import { retainedProgressRun, retainedWorkHeads } from '../dispatch/retained-work';
import { blockingRecoveryEffectsRefusal, blockingTaskOperations, recoveryEffects, isBlockingRecoveryEffect } from '../recovery/recovery-effects';
import { taskPrNumber } from '../forge/index';
import { isDeepStrictEqual } from 'node:util';
import { type Task } from '../../shared/contracts';
import { isDispositionActive } from "../../shared/contracts";
import { matchingInactiveParticipant } from '../intake/run-settlement';
import { dispatchBlocked, DISPATCH_HELD_REASON } from '../dispatch/capacity';
import type { Resolution } from '../resolution';

export type ProgressContinuationContext = Pick<Resolution, 'adapter' | 'host' | 'onTaskHost' | 'ownedToolHold' | 'progressEffectsPending' | 'startsNoRuns' | 'store'>;

export class ProgressContinuation {
  constructor(readonly context: ProgressContinuationContext) {}
  progressEffectsPending(t:Task): boolean {
    return recoveryEffects(this.context.store,t,{noticeKinds:'all'}).some(isBlockingRecoveryEffect)
      || blockingTaskOperations(this.context.store,t).length > 0
      || this.context.store.hookEvents(t.id).some(hook => !['result','published'].includes(hook.state) || hook.result?.outcome !== 'ok')
      || this.context.store.notices(t.id).some(notice => ['intent','uncertain'].includes(notice.status));
  }

  async continuedProgressWait(t:Task, head:string): Promise<string | null> {
    const wait=(cause:string)=>`Retained progress continuation waits: ${cause}`;
    if(this.context.startsNoRuns())return wait('Nucleus is paused');
    if(dispatchBlocked(t))return wait(DISPATCH_HELD_REASON);
    if(isDispositionActive(t))return wait('a disposition fence is active');
    if(t.phase!=='changes_requested'||t.resolution.attention)return wait(`task is ${t.phase}, not a pending revision`);
    if(t.resolution.currentRunId||t.resolution.recoveryActive)return wait('a run or recovery is active');
    if(t.resolution.mergeIntent||t.resolution.mergedCommit||t.resolution.externalMerge)return wait('merge intent or a merge is recorded');
    const runs=this.context.store.runs(t.id);
    const unsettled=runs.find(run=>!run.released||['intent','uncertain'].includes(run.status)
      ||run.reviewDeliveries?.some(delivery=>['reserved','uncertain'].includes(delivery.status)));
    if(unsettled)return wait(`run ${unsettled.id} is unreleased or has an unsettled delivery`);
    const initialEffectWait=blockingRecoveryEffectsRefusal(this.context.store,t,{noticeKinds:'all'});
    if(initialEffectWait)return wait(initialEffectWait);
    if(this.context.progressEffectsPending(t))return wait('operations, hooks or notices are unsettled');
    const progress=retainedProgressRun(this.context.store,t),review=t.resolution.review;
    const reviewerRun=review?this.context.store.run(review.runId):null;
    if(!progress||!this.context.adapter.verifyContinuedProgress||!t.agentId||!t.profile||!t.workspaceId||!t.directory)
      throw Error('Retained progress source or task identity is unavailable');
    // No recorded review: the receipt check does not apply. A recorded review of any
    // status needs only what proves it is settled: its released reviewer run whose
    // completion is that review's own event. Its verdict never fences continuation:
    // a newer head is unjudged whatever the older head's review said, and the
    // continuation binds identity, never readiness.
    if(review&&(!reviewerRun?.released||reviewerRun.completion?.eventId!==review.eventId))
      throw Error('Retained progress review receipt is unavailable');
    if(!this.context.adapter.agentTimelinePage||!this.context.adapter.verifyResume||!this.context.adapter.verifyPrIdentity)
      throw Error('Retained progress participant or PR evidence is unavailable');
    const participants=new Set([t.agentId,t.resolution.reviewerAgentId,...t.retiredWorkers.map(worker=>worker.agentId)].filter((id):id is string=>Boolean(id)));
    const observe=async():Promise<string|null>=>{
      for(const id of participants){
        const state=await this.context.onTaskHost(t, () => this.context.host.observe(id));
        if(!matchingInactiveParticipant({agentId:id,workspaceId:t.workspaceId},state))return `participant ${id} is not idle`;
        const participantRunIds=participantToolRunIds(t,this.context.store.runs(t.id),id,t.workspaceId!);
        const issue=await this.context.ownedToolHold(id,{requireCompleteEvidence:true,runId:participantRunIds[0],runIds:participantRunIds,taskId:t.id,workspaceId:t.workspaceId!});
        if(issue)return `participant ${id}: ${issue}`;
      }
      return null;
    };
    const pr=await this.context.adapter.verifyPrIdentity(t,taskPrNumber(t),{allowDraft:true});
    if(pr.head!==head||(t.prUrl&&pr.url!==t.prUrl))throw Error('Retained progress PR identity changed');
    await this.context.adapter.verifyResume(t);
    const prove=()=>this.context.adapter.verifyContinuedProgress!({...t,prUrl:pr.url},taskPrNumber(t),head,
      [...(t.prHead?[t.prHead]:[]),progress.head,...(review?.head?[review.head]:[]),...retainedWorkHeads(this.context.store,t,runs)],{requireClean:false});
    let blocked=await observe();if(blocked)return wait(blocked);
    await prove();
    blocked=await observe();if(blocked)return wait(blocked);
    await prove();
    const confirmed=await this.context.adapter.verifyPrIdentity(t,taskPrNumber(t),{allowDraft:true});
    if(confirmed.head!==head||confirmed.url!==pr.url)throw Error('Retained progress PR changed during source proof');
    const latest=this.context.store.task(t.id), latestEffectWait=blockingRecoveryEffectsRefusal(this.context.store,latest,{noticeKinds:'all'});
    if(this.context.startsNoRuns()||dispatchBlocked(latest)||isDispositionActive(latest)
      ||this.context.progressEffectsPending(latest)||latest.version!==t.version
      ||!isDeepStrictEqual(this.context.store.runs(t.id),runs))return wait(latestEffectWait??'task or runs changed during source proof');
    return null;
  }
}
