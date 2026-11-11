import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../../core/engine';
import { Lifecycle } from '../../core/closeout/workspace-lifecycle';
import { PaseoAdapter } from '../../service/paseo-composition';
import { RuntimeRetirementService } from '../../core/runtime/runtime-retirement';
import { Reports } from '../../core/intake/report';
import { admitPinned, ownerRevisionFixture, ownedRevisableTask, runGit } from './review-entry-fixture';
import { materializeLegacyView } from './legacy-review-view-fixture';
import { toolTimelinePage } from './tool-timeline';

/** A historical intake reader view, with real worktrees and a mocked native archive. */
export async function fixture(historicalPartial=false,historicalOnly=false,preserveSource=false) {
  const f=ownerRevisionFixture();
  const {task,engine:admission,store}=await ownedRevisableTask(f,{blockedReport:true});
  let head=f.oldHead;
  await admitPinned(f,admission,task.id);
  await admission.performTaskControl({taskId:task.id,version:store.task(task.id).version,action:'move',to:'review',
    reason:'Request a fresh review of the unchanged intake head'});
  await admission.wake();
  const created=store.runs(task.id).filter(candidate=>candidate.role==='reviewer').at(-1);
  assert.ok(created,`review-entry admission did not create a reader: phase=${store.task(task.id).phase}; reason=${store.task(task.id).reason}; creates=${f.creates.length}`);
  f.states.set('review-agent',{id:'review-agent',workspaceId:created.workspaceId,status:'idle',active:false,permissions:false,error:'',model:'reviewer-model'});
  if(historicalPartial){
    await new Reports(admission).report({taskId:task.id,runId:created.id,eventId:randomUUID(),status:'review_in_progress',head,
      summary:'Partial reading',checkpoint:{covered:['source'],remaining:['final review']}},f.tokens.get(created.id)!);
    head=f.pushRevision('later published source');
  } else {
    const result=await new Reports(admission).report({taskId:task.id,runId:created.id,eventId:randomUUID(),status:'ready_to_merge',head,
      summary:'Final exact-head review',reviewText:'The source is ready for merge.'},f.tokens.get(created.id)!);
    assert.equal((result as {accepted:boolean}).accepted,true);
    if(historicalOnly)head=f.pushRevision('later published source');
  }
  await admission.stop();
  // Admission creates no pinned view any more; retrofit the stored view this
  // terminal-archive scenario is about onto the settled round.
  store.putRun({...store.run(created.id)!,released:true,status:historicalPartial?'superseded':'finished'});
  const run=materializeLegacyView(f,store,created.id);
  runGit(f.repo,'merge','--ff-only','feature/external');
  runGit(f.repo,'push','origin','main');
  const current=store.task(task.id);
  store.update(task.id,{phase:'done',prHead:head,reviewEntry:{...current.reviewEntry!,preserveWorkspace:preserveSource},
    resolution:{...current.resolution,currentRunId:null,mergedCommit:head,syncedCommit:head}});
  const views=new Map([[task.workspaceId!,{directory:f.workspace,branch:task.branch}],
    [run.workspaceId,{directory:run.reviewSourceView!.directory!,branch:run.reviewSourceView!.branch}]]);
  const archived=new Set<string>(),calls:string[]=[], agents:Array<Record<string,unknown>>=[];
  const delivery={lost:false,unavailable:false,teardownFailure:false};
  const archiver=Object.create(PaseoAdapter.prototype) as PaseoAdapter;
  Object.defineProperty(archiver,'helperPath',{value:join(f.root,'helper.mjs')});
  Object.defineProperty(archiver,'api',{value:{workspaces:{ref:(id:string)=>{
    const view=views.get(id)!;
    return {directory:view.directory,refresh:async()=>{},current:()=>archived.has(id)?undefined:{projectRootPath:f.repo,worktreeSlug:view.branch},
      archive:async()=>{
        const record=store.task(task.id).resolution.runtimeRetirements.find(item=>item.workspaceId===id);
        assert.equal(record?.state,'captured','runtime scope captured before removal');
        calls.push(id);archived.add(id);
        if(delivery.lost)throw Error(delivery.teardownFailure?'worktree.teardown failed after archive delivery':'native reply lost');
        runGit(f.repo,'worktree','remove',view.directory);
        return {archivedAt:new Date().toISOString(),error:null};
      }};
  }},agents:{list:async()=>({entries:agents.map(agent=>({agent})),pageInfo:{hasMore:false}})}}});
  const adapter=f.buildAdapter();
  // A released reader's own history is complete and tool-free, and the adapter's
  // participant proof observes it by identity rather than assuming idleness.
  archiver.observe=(id:string)=>adapter.observe(id);
  archiver.agentTimelinePage=async()=>toolTimelinePage([]);
  adapter.archiveTaskWorkspace=(...args)=>archiver.archiveTaskWorkspace(...args);
  adapter.taskWorkspaceArchived=async id=>{if(delivery.unavailable)throw Error('catalog unavailable');return archived.has(id);};
  const runtime=new RuntimeRetirementService(store,async args=>args[1]==='scope'
    ?{code:0,timedOut:false,spawnError:'',output:JSON.stringify({scope:{kind:'worktree',token:'c'.repeat(32)}})}
    :{code:0,timedOut:false,spawnError:'',output:'retired'});
  const engine=new Engine(store,adapter,0,undefined,runtime);
  return {...f,task,head,run,store,engine,calls,archived,views,agents,delivery,close:async()=>{await engine.stop();f.close();}};
}

export async function seedRetry(f:Awaited<ReturnType<typeof fixture>>) {
  const path=join(f.run.reviewSourceView!.directory!,'temporary-untracked');
  writeFileSync(path,'refuse initial cleanup');
  await new Lifecycle(f.engine).archive(f.store.task(f.task.id),f.run.workspaceId);
  rmSync(path);
  assert.ok(f.store.task(f.task.id).resolution.workspaceArchiveRetries.some(item=>item.workspaceId===f.run.workspaceId));
}
