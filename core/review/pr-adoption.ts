import { assertCanonicalPrSource, authenticatedWorkerBlock, type VerifiedPr } from '../forge/index';
import type { AgentObservation } from '../host/adapter';
import type { Adapter } from '../host/adapter';
import type { HostFacade } from '../host/host-facade';
import type { Store } from '../store/store';


import { retainedProgressRun } from '../dispatch/retained-work';
import { now } from '../store/store';
import { active } from '../recovery/task-reasons';
import type { Task } from '../../shared/contracts';

export interface PrAdoptionContext {
  readonly store: Store;
  readonly adapter: Pick<Adapter, 'verifyPr' | 'findOpenBranchPr' | 'verifyResume'>;
  readonly host: Pick<HostFacade, 'observe'>;
  paused(): boolean;
  recordBlockedPrIdentity(t: Task, prNumber: number, source: string): Promise<Task>;
}

/** Binds an existing PR to a task: identity for a block, recovery or repair otherwise. */
export class PrAdoption {
  constructor(readonly resolution: PrAdoptionContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  paused() { return this.resolution.paused(); }

  /**
   * Queue #392 (Tom, 2026-10-24): a matching open PR is identity, never readiness.
   *
   * A blocked or errored report is the retained worker's own authenticated block —
   * its reason, its findings and the validation it never ran. Finding the task
   * branch PR must not dispose of it, so this discovery can record the PR's
   * identity and nothing else: the phase, reason, completion, incident, recovery,
   * attention and reviews stay exactly as they were, no run is reserved, and no
   * instruction-free identity confirmation is dispatched to turn the block into
   * review readiness. The retained worker's explicit continuation (`restart
   * role=worker`, `move to=work`) then resumes this same PR with the owner's
   * instruction and the block as context, `move to=review` accepts the delivered
   * scope for review, and the block stays as history. A worker that later sends
   * its own applicable ready result still enters independent review.
   *
   * Identity is recorded only as the canonical source, branch and head just
   * verified, and only at the head the report itself named. Anything else — a
   * fork or unknown head repository, a closed or drafted PR, a branch that moved
   * past the report, a dirty or relocated worktree, an unreachable forge, a live
   * worker, a concurrent owner instruction or a concurrent callback — records one
   * visible reason and leaves the task untouched, so the paced lookup can retry
   * and no reader is told the block advanced.
   */
  async recordBlockedPrIdentity(t: Task, prNumber: number, source: string): Promise<Task> {
    const currentBlock = (task: Task) => retainedProgressRun(this.store, task)?.completion
      ?? (this.store.runs(task.id).some(run => run.role === 'revision' && run.agentId === task.agentId && run.completion)
        ? null : authenticatedWorkerBlock(task));
    const block = currentBlock(t);
    if (!block) return t;
    const deferred = (reason: string) => {
      const detail = `${source}: PR #${prNumber} was not recorded and the authenticated ${block.status} report ${block.eventId} stands; ${reason}`;
      if (!this.store.events(t.id).some(event => event.kind === 'blocked_pr_identity_deferred' && event.detail === detail))
        this.store.event(t.id, 'blocked_pr_identity_deferred', detail);
      return this.store.task(t.id);
    };
    const stopped = (state: AgentObservation) => state.workspaceId === t.workspaceId && !active(state) && ['idle', 'error', 'closed'].includes(state.status);
    const refusal = (error: unknown) => error instanceof Error ? error.message : String(error);
    if (t.resolution.mergeIntent || t.resolution.mergedCommit) return deferred('the task holds merge intent');
    if (this.store.runs(t.id).some(run => !run.released)) return deferred('another task run is still unresolved');
    if (!t.agentId || !t.workspaceId) return deferred('the task retains no worker to observe');
    let state: AgentObservation;
    try { state = await this.resolution.host.observe(t.agentId); }
    catch (error) { return deferred(`the retained worker cannot be observed (${refusal(error)})`); }
    if (!stopped(state)) return deferred('the retained worker is not observed stopped in its task workspace');
    let pr: VerifiedPr;
    try {
      pr = await this.adapter.verifyPr(t, prNumber);
      assertCanonicalPrSource(pr, prNumber);
    } catch (error) { return deferred(`the PR identity is not established (${refusal(error)})`); }
    if (this.paused()) return deferred('Nucleus paused during the identity proof');
    if (block.head && block.head !== pr.head) return deferred(`the branch is at ${pr.head}, not the head ${block.head} the report named`);
    let confirmed: AgentObservation;
    try { confirmed = await this.resolution.host.observe(t.agentId); }
    catch (error) { return deferred(`the retained worker cannot be re-observed (${refusal(error)})`); }
    if (!stopped(confirmed)) return deferred('the retained worker became active during the identity proof');
    const observed = this.store.task(t.id);
    // A concurrent owner instruction, callback or lifecycle write owns the task from
    // here: the discovery records nothing and reports nothing of its own.
    if (observed.version !== t.version) return observed;
    return this.store.transaction(() => {
      const latest = this.store.task(t.id);
      if (latest.version !== observed.version || currentBlock(latest)?.eventId !== block.eventId
        || latest.prUrl || latest.prHead || latest.resumePrNumber || latest.resolution.mergeIntent || latest.resolution.mergedCommit)
        throw Error(`${source} raced a concurrent change; no PR identity was recorded and the ${block.status} report stands`);
      return this.store.update(t.id, { prUrl: pr.url, prHead: pr.head, resumePrNumber: prNumber }, 'blocked_pr_identity_recorded',
        `${source}: PR #${prNumber} at ${pr.head} recorded as identity only; the authenticated ${block.status} report ${block.eventId} (${block.head ?? 'no reported head'}) stays the task's unresolved block and grants no readiness`);
    });
  }
  async adoptReplacementPr(t: Task, prNumber: number) {
    const runs=this.store.runs(t.id);
    // An accepted readiness callback is a delivery the queue should have bound, so it
    // vetoes this path. A blocked or errored completion is the retained worker's own
    // authenticated block, and since Queue #392 (Tom, 2026-10-24) it takes the
    // identity-only path below: a PR found on the task's branch is identity, never
    // readiness, so the block is kept and no instruction-free identity confirmation is
    // dispatched to convert it into review readiness. g05.167's shape — a worker that
    // pushed its PR and then reported a blocker — still records the PR's identity, so
    // the retained worker's explicit continuation resumes that same PR.
    const acceptedCompletion=t.completion?.status==='ready_for_review';
    const deadRevisionDiscovery=t.phase==='changes_requested'&&t.resolution.attention&&t.resolution.recovery?.status==='escalated'&&
      !acceptedCompletion&&!t.prUrl&&!t.prHead&&!t.resumePrNumber&&Boolean(t.agentId&&t.workspaceId&&t.directory&&t.profile)&&
      Boolean(t.resolution.currentRunId)&&runs.some(r=>!r.released);
    if(deadRevisionDiscovery){
      if(t.resolution.mergeIntent||t.resolution.mergedCommit)throw Error('Dead-revision PR recovery requires no merge intent');
      const faultRuns=new Set(this.store.events(t.id).filter(e=>e.kind==='incident').flatMap(e=>{
        try { const fault=JSON.parse(e.detail) as {runId?:string;cause?:string};
          return fault.runId&&['missing_callback','uncertain_delivery'].includes(fault.cause??'')?[fault.runId]:[];
        } catch { return []; }
      }));
      const pending=runs.filter(r=>!r.released);
      if(!pending.every(r=>r.role==='revision'&&['running','uncertain'].includes(r.status)&&r.agentId===t.agentId&&r.workspaceId===t.workspaceId&&!r.completion&&
        (r.status==='uncertain'||faultRuns.has(r.id))))
        throw Error('Dead-revision PR recovery requires only stopped missing-callback or uncertain-delivery revision runs');
      if(!pending.some(r=>r.id===t.resolution.currentRunId))throw Error('Dead-revision PR recovery requires the current retained revision run');
      if(!this.adapter.findOpenBranchPr||!this.adapter.verifyResume)throw Error('Dead-revision PR recovery verification is unavailable');
      const observed={version:t.version,agentId:t.agentId,workspaceId:t.workspaceId,directory:t.directory,repoPath:t.repoPath,
        baseBranch:t.baseBranch,branch:t.branch,currentRunId:t.resolution.currentRunId,completionEventId:t.completion?.eventId??null,
        runs:pending.map(r=>({id:r.id,head:r.head,status:r.status}))};
      const stopped=async()=>{
        const state=await this.resolution.host.observe(t.agentId!);
        if(state.workspaceId!==t.workspaceId||active(state)||!['idle','error','closed'].includes(state.status))
          throw Error('Dead-revision PR recovery requires the retained worker stopped in its task workspace');
      };
      await stopped();
      await this.adapter.verifyResume(t);
      const matches=await this.adapter.findOpenBranchPr(t);
      if(matches.length!==1||matches[0].number!==prNumber)throw Error('Dead-revision PR recovery requires exactly one matching open branch PR');
      const pr=await this.adapter.verifyPr(t,prNumber);
      if(pr.head!==matches[0].head||pr.url!==matches[0].url)throw Error('Branch PR changed during dead-revision recovery');
      await stopped();
      await this.adapter.verifyResume(t);
      const confirmed=await this.adapter.verifyPr(t,prNumber);
      if(confirmed.head!==pr.head||confirmed.url!==pr.url)throw Error('Branch PR changed during dead-revision recovery');
      if(this.paused())throw Error('Nucleus paused during dead-revision PR recovery');
      const current=this.store.task(t.id),latest=this.store.runs(t.id);
      if(current.version!==observed.version||current.agentId!==observed.agentId||current.workspaceId!==observed.workspaceId||
        current.directory!==observed.directory||current.repoPath!==observed.repoPath||current.baseBranch!==observed.baseBranch||
        current.branch!==observed.branch||current.resolution.currentRunId!==observed.currentRunId||
        (current.completion?.eventId??null)!==observed.completionEventId||
        current.prUrl||current.prHead||current.resumePrNumber||current.resolution.mergeIntent||current.resolution.mergedCommit||
        latest.filter(r=>!r.released).length!==observed.runs.length||observed.runs.some(r=>{
          const now=latest.find(x=>x.id===r.id);
          return !now||now.released||now.completion||now.head!==r.head||now.status!==r.status||now.agentId!==observed.agentId||now.workspaceId!==observed.workspaceId;
        }))throw Error('Task or revision run changed during dead-revision PR recovery');
      return this.store.transaction(()=>{
        for(const r of observed.runs){
          const retained=latest.find(x=>x.id===r.id)!;
          this.store.deleteCredential(retained.id);
          this.store.putRun({...retained,released:true});
        }
        const incident=current.resolution.incident?{...current.resolution.incident,status:'resolved' as const,
          detail:`Operator reconciled exact branch PR #${prNumber}`,updatedAt:now()}:null;
        return this.store.update(t.id,{phase:'changes_requested',reason:`Exact branch PR #${prNumber} recovered; requesting authenticated readiness confirmation`,
          prUrl:pr.url,prHead:pr.head,resumePrNumber:prNumber,
          resolution:{...current.resolution,currentRunId:null,review:null,attention:false,recoveryActive:false,
            recovery:null,revisionResumeUnpublished:true,incident}},'dead_revision_pr_reconciled',`PR #${prNumber} at ${pr.head}`);
      });
    }
    const initialDiscovery=(!t.completion||t.completion.status!=='ready_for_review')&&!t.prUrl&&!t.prHead&&!t.resumePrNumber&&!t.resolution.currentRunId&&
      Boolean(t.agentId&&t.workspaceId&&t.directory&&t.profile)&&['working','blocked','error','needs_attention'].includes(t.phase);
    if(initialDiscovery){
      if(authenticatedWorkerBlock(t))return this.resolution.recordBlockedPrIdentity(t,prNumber,'Existing branch PR discovery');
      if(t.resolution.mergeIntent||t.resolution.mergedCommit||runs.some(r=>!r.released))throw Error('Initial PR reconciliation requires released runs and no merge intent');
      const state=await this.resolution.host.observe(t.agentId!);
      if(state.workspaceId!==t.workspaceId||active(state)||!['idle','error','closed'].includes(state.status))throw Error('Initial PR reconciliation requires the retained worker to be stopped in its task workspace');
      const pr=await this.adapter.verifyPr(t,prNumber);
      assertCanonicalPrSource(pr,prNumber);
      if(this.paused())throw Error('Nucleus paused during initial PR verification');
      const current=this.store.task(t.id),confirmed=await this.resolution.host.observe(t.agentId!);
      if(current.version!==t.version||(current.completion?.eventId??null)!==(t.completion?.eventId??null)||current.prUrl||current.prHead||current.resumePrNumber||current.resolution.currentRunId||
        this.store.runs(t.id).some(r=>!r.released)||confirmed.workspaceId!==t.workspaceId||active(confirmed)||!['idle','error','closed'].includes(confirmed.status))
        throw Error('Task or worker changed during initial PR verification');
      const incident=current.resolution.incident?{...current.resolution.incident,status:'resolved' as const,detail:`Exact branch PR #${prNumber} reconciled before coordinator recovery`,updatedAt:now()}:null;
      return this.store.update(t.id,{phase:'changes_requested',reason:`Existing PR #${prNumber} discovered; requesting authenticated readiness confirmation`,
        prUrl:pr.url,prHead:pr.head,resumePrNumber:prNumber,
        resolution:{...current.resolution,currentRunId:null,review:null,attention:false,recoveryActive:false,recovery:null,revisionResumeUnpublished:true,incident}},
        'initial_pr_reconciled',`PR #${prNumber} at ${pr.head}`);
    }
    const revision=t.resolution.currentRunId?this.store.run(t.resolution.currentRunId):[...runs].reverse().find(r=>r.role==='revision'&&r.released&&r.completion?.status==='ready_for_review');
    // A rejected initial PR callback leaves durable worker evidence but no accepted PR identity.
    const initialMismatch=t.phase==='needs_attention'&&!t.prUrl&&!t.prHead&&!t.resolution.currentRunId;
    const revisionReconcile=t.phase==='changes_requested'&&t.resumePrNumber===prNumber&&revision?.released&&revision.completion?.status==='ready_for_review';
    if(!initialMismatch&&!revisionReconcile)
      throw new Error('Replacement PR adoption requires an active PR identity repair or completed replacement-PR revision');
    if(t.completion?.status!=='ready_for_review'||!t.completion.prNumber||prNumber===t.completion.prNumber)
      throw new Error('Replacement PR adoption requires a different PR for an accepted ready-for-review callback');
    if(t.resolution.currentRunId&&t.resolution.currentRunId!==revision?.id||t.resolution.mergeIntent||t.resolution.mergedCommit||runs.some(r=>!r.released))
      throw new Error('Replacement PR adoption requires released task runs and no merge intent');
    const callbackEvent=t.completion.eventId, revisionEvent=revision?.completion?.eventId??null, branch=t.branch;
    const pr=await this.adapter.verifyPr(t,prNumber);
    if(this.paused())throw new Error('Nucleus paused during replacement PR verification');
    const current=this.store.task(t.id);
    const currentRevision=current.resolution.currentRunId?this.store.run(current.resolution.currentRunId):revision;
    if(current.phase!==t.phase||current.reason!==t.reason||current.branch!==branch||current.completion?.eventId!==callbackEvent||
      (current.resolution.currentRunId&&current.resolution.currentRunId!==currentRevision?.id)||(currentRevision?.completion?.eventId??null)!==revisionEvent||
      current.resolution.mergeIntent||current.resolution.mergedCommit||this.store.runs(t.id).some(r=>!r.released))
      throw new Error('Task changed during replacement PR verification');
    return this.store.update(t.id,{
      phase:'awaiting_review', reason:`Verified replacement PR #${prNumber}; awaiting independent review`,
      resumePrNumber:prNumber, prHead:pr.head, prUrl:pr.url,
      resolution:{...current.resolution,attention:false,revisionPrRepair:false,review:null,currentRunId:null},
    },revisionReconcile?'replacement_pr_reconciled':'pr_identity_repaired',`PR #${current.completion!.prNumber} → #${prNumber} at ${pr.head}`);
  }
}
