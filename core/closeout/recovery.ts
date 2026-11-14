import type { Task } from '../../shared/contracts';
import type { Engine } from '../engine';
import type { LifecycleAdapter } from './archive-proof';
import type { Resolution } from '../resolution';
import { missingOriginHasPlanner } from '../questions/origin';
import { isStaleIntegrationBaseRefusal } from '../hooks/hooks';
import { consumerBlockAdvance, isConsumerDeclaredBlock } from './closeout-renewal';

export type CloseoutRecoveryContext = Pick<Engine, 'adapter' | 'host' | 'onTaskHost' | 'stopped' | 'store'> & {
  readonly resolution: Pick<Resolution, 'adapter' | 'closeoutAuthority' | 'hasEarlierIntegrationTurn' | 'lease' | 'update'>;
};

/** Automatic re-asks of a consumer-blocked closeout per merge; beyond this a human decides. */
export const CONSUMER_BLOCK_RENEWAL_LIMIT=5;
export class CloseoutRecovery {
  constructor(readonly engine: CloseoutRecoveryContext) {}
  get store() { return this.engine.store; }
  get adapter(){return this.engine.adapter as typeof this.engine.adapter & Partial<LifecycleAdapter>;}
  paused(){return this.engine.stopped || this.store.getMeta('paused')===true;}
  async recover(task:Task) {
    if(task.originError&&!missingOriginHasPlanner(this.store,task) || task.resolution.recoveryActive || this.paused() || !this.adapter.workspaceAvailable || !task.resolution.mergedCommit || !['syncing','closing'].includes(task.phase))return;
    // Normal resolution must fetch and synchronize the verified merge before
    // closeout recovery inspects the manifest at that commit. A fresh GitHub
    // merge SHA may not exist in the local object store yet.
    if(task.phase==='syncing'&&!task.resolution.syncedCommit)return;
    // A hook-owned closeout publishes without a closeout agent or workspace, so a
    // missing coordinator workspace must not trigger closeout workspace recovery.
    if(['hook','queue'].includes(await this.engine.resolution.closeoutAuthority(task)))return;
    const run=task.resolution.currentRunId?this.store.run(task.resolution.currentRunId):null;
    if(run && (run.role!=='closeout' || run.completion))return;
    let currentId=run?.workspaceId??task.resolution.coordinatorWorkspaceId??task.workspaceId;
    if(!run && task.coordinatorAgentId){const state=await this.engine.onTaskHost(task, () => this.engine.host.observe(task.coordinatorAgentId!));currentId=state.workspaceId;}
    if(!currentId || await this.adapter.workspaceAvailable(currentId))return;
    if(run && !run.agentId){
      const matches=await this.engine.resolution.adapter.findRunAgents!(run);
      // This exact SDK preflight error is thrown before createAgent is sent.
      const rejected=this.store.events(task.id).some(e=>e.at>=run.createdAt && e.detail===`Workspace ${run.workspaceId} has no available directory`);
      if(matches.length || !rejected)throw Error('Closeout creation is uncertain; inspect it before replacing the workspace');
    }
    if(!await this.engine.resolution.lease(task) || this.paused())return;
    if(this.engine.resolution.hasEarlierIntegrationTurn(task))return;
    const commit=await this.engine.resolution.adapter.syncMain!(task,()=>!this.paused());
    if(this.paused())return;
    let t=this.engine.resolution.update(this.store.task(task.id),{syncedCommit:commit});
    let workspace=t.resolution.closeoutWorkspaceId?{id:t.resolution.closeoutWorkspaceId,directory:t.resolution.closeoutDirectory!}:null;
    if(!workspace){
      if(t.resolution.closeoutWorkspaceIntent){
        const found=await this.adapter.findCloseoutWorkspaces!(t);
        if(found.length!==1)throw Error('Closeout workspace creation is uncertain; no duplicate will be created');
        workspace=found[0];
      }else{
        t=this.engine.resolution.update(t,{closeoutWorkspaceIntent:true,closeoutWorkspaceHead:commit}, {},'closeout_workspace_intent');
        workspace=await this.adapter.createCloseoutWorkspace!(t);
      }
      t=this.engine.resolution.update(t,{closeoutWorkspaceId:workspace.id,closeoutDirectory:workspace.directory}, {},'closeout_workspace_created');
    }
    await this.adapter.verifyCloseoutWorkspace!(t,workspace.id,workspace.directory);
    if(this.paused())return;
    this.store.transaction(()=>{
      const latest=this.store.task(t.id);
      if(latest.coordinatorGeneration!==task.coordinatorGeneration)throw Error('Coordinator assignment changed during workspace recovery');
      if(run)this.store.putRun({...this.store.run(run.id)!,released:true,status:'superseded'});
      this.engine.resolution.update(latest,{coordinatorWorkspaceId:workspace!.id,currentRunId:null,attention:false},
        {coordinatorAgentId:'',coordinatorGeneration:latest.coordinatorGeneration+1,phase:'closing',reason:'Recovered closeout workspace; assigning coordinator'},'closeout_workspace_recovered');
    });
  }
  /**
   * Re-pin a closeout held on a stale integration base.
   *
   * A closeout occurrence records the commit the merge was verified at, and the hook's
   * integration write must apply at that base. When main advances afterwards - which on a
   * live board is constantly - the write is refused with the stale-base proof and the task
   * parks. The renewal that re-pins the occurrence to the current base exists, but it only
   * runs when the closeout is re-entered, and a parked lane is never re-entered: the six
   * held project-a closeouts sat for hours on a base race the queue had already repaired.
   *
   * This is the same transition an owner's parked restart performs. It is bounded, so a
   * base that keeps moving parks for a human instead of looping.
   */
  async renewStaleCloseoutBase(task: Task) {
    if (task.phase !== 'closing' || !task.resolution.attention) return;
    // The hook row is the truth, not the task's reason: a retry rewrites the row and leaves
    // the reason reading whatever it said before, so gating on the reason checked stale text
    // and never fired.
    const blocked = this.store.hookEvents(task.id).findLast(record => record.event === 'task.closeout' && record.state === 'blocked');
    if (!blocked || !isStaleIntegrationBaseRefusal(blocked.error)) return;
    if (!task.resolution.mergedCommit || !task.resolution.syncedCommit) return;
    if (task.resolution.recoveryActive || this.paused()) return;
    const renewals = this.store.events(task.id).filter(event => event.kind === 'closeout_base_renewed').length;
    if (renewals >= 3) return;
    this.engine.resolution.update(this.store.task(task.id), { currentRunId: null, attention: false }, { phase: 'syncing', reason: 'Refreshing main before retrying closeout' }, 'closeout_base_renewed');
  }
  /** Remote fetches for consumer-blocked closeouts, at most one per repository per interval. */
  consumerBlockFetchMs=5*60_000;
  private readonly consumerBlockFetchedAt=new Map<string,number>();
  /**
   * Re-ask a closeout the consumer's own hook blocked, once the consumer has changed what
   * that hook owns. The block is a finding, so a moved base alone is not enough: the
   * remote must have fast-forwarded through the hook's declared paths or manifest. The
   * transition is the owner's parked restart, and the fresh occurrence re-runs the
   * hook at the refreshed base, so a still-blocked consumer simply parks again at that base.
   */
  async renewConsumerBlockedCloseout(task:Task) {
    task = this.store.task(task.id);
    if (task.phase !== 'closing' || !task.resolution.attention) return;
    if (!task.resolution.mergedCommit || !task.resolution.syncedCommit || task.resolution.recoveryActive || this.paused()) return;
    const blocked = this.store.hookEvents(task.id).findLast(record => record.event === 'task.closeout' && record.state !== 'failed');
    if (!blocked || !isConsumerDeclaredBlock(blocked)) return;
    const sinceMerge: string[] = [];
    for (const event of this.store.events(task.id)) { if (event.kind === 'merge_verified') break; sinceMerge.push(event.kind); }
    if (sinceMerge.filter(kind => kind === 'closeout_block_renewed').length >= CONSUMER_BLOCK_RENEWAL_LIMIT) return;
    const last = this.consumerBlockFetchedAt.get(task.repoPath) ?? 0, fetch = Date.now() - last >= this.consumerBlockFetchMs;
    if (fetch) this.consumerBlockFetchedAt.set(task.repoPath, Date.now());
    const head = await consumerBlockAdvance(task.repoPath, blocked, fetch);
    if (!head) return;
    this.engine.resolution.update(this.store.task(task.id), { currentRunId: null, attention: false },
      { phase: 'syncing', reason: `Consumer changed the blocked closeout's inputs at ${head}; refreshing main before re-asking` }, 'closeout_block_renewed');
  }
}
