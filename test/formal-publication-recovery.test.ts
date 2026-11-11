import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store/store';
import {Resolution, type ResolutionAdapter} from '../core/resolution';
import {submissionSchema,taskControlInputSchema,type Run} from '../shared/contracts';
import type {Adapter} from '../core/host';

const head='a'.repeat(40);
for(const shape of ['success','blocked','needs_attention','hold','paused','live-run','wrong-run','changed-callback','race','busy','post-race'] as const) {
  test(`publication-only control: ${shape}`,async t=>{
    const dir=mkdtempSync(join(tmpdir(),'ns-publication-recovery-')),store=new Store(join(dir,'queue.sqlite'));
    t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
    store.setMeta('paused',false);
    store.putRepository({path:'/repo',origin:null},null,'',null,{login:'reviewer'});
    const submitted=store.insert(submissionSchema.parse({submissionId:`pub-${shape}`,title:'Task',repoPath:'/repo',planningCommit:head,handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff',head);
    const run:Run={id:'accepted-review',taskId:submitted.id,role:'reviewer',generation:1,agentId:'reviewer-agent',workspaceId:'workspace',profile:null,head,base:head,status:'finished',active:false,released:true,createdAt:new Date().toISOString(),lastObservedAt:null,idleSince:null,completion:{eventId:'original-event',taskId:submitted.id,runId:'accepted-review',head,status:'ready_to_merge',summary:'Approved',reviewText:'Own complete findings'}} as Run;
    store.putRun(run);
    let task=store.update(submitted.id,{phase:'reviewing',agentId:'worker',workspaceId:'workspace',prHead:head,resolution:{...submitted.resolution,currentRunId:run.id,attention:true}});
    if(shape==='blocked'||shape==='needs_attention')task=store.update(task.id,{phase:shape,resolution:{...task.resolution,currentRunId:null}});
    if(shape==='hold') task=store.update(task.id,{holds:{dispatch:{owner:'operator',reason:'Stop',at:new Date().toISOString(),generation:1,until:null}}} as never);
    if(shape==='paused')store.setMeta('paused',true);
    if(shape==='live-run')store.putRun({...run,id:'live',released:false,status:'running'});
    let publishes=0,observations=0;
    const adapter={observe:async(id:string)=>{
      observations++;
      if(shape==='race')store.update(task.id,{reason:'Changed during observation'});
      return {id,workspaceId:'workspace',status:shape==='busy'?'running':'idle',active:shape==='busy',permissions:false,error:''};
    },reconcileReviewPublication:async(_store:Store,_task:unknown,_run:unknown,_reviewer:unknown,_reason:unknown,allowed:()=>boolean)=>{
      publishes++;assert.equal(allowed(),true);
      if(shape==='changed-callback')store.putRun({...run,completion:{...run.completion!,summary:'Different accepted identity'}});
      if(shape==='post-race')store.update(task.id,{prHead:'b'.repeat(40)});
      return 777;
    }} as unknown as Adapter & ResolutionAdapter;
    const resolution=new Resolution(store,adapter,()=>[],()=>false,0);
    const before=JSON.stringify(run.completion);
    const invoke=()=>resolution.reconcileReviewPublication(task,shape==='wrong-run'?'absent':run.id,'Owner authorizes publication only');
    if(['success','blocked','needs_attention'].includes(shape)){
      const result=await invoke();assert.equal(result.resolution.attention,false);assert.equal(result.phase,'reviewing');
      const actual=store.run(run.id)!.completion!;
      assert.equal(actual.reviewId,777);const {reviewId,...original}=actual;assert.equal(JSON.stringify(original),before);
      assert.equal(result.resolution.currentRunId,run.id,'ordinary result application still owns completion/merge');
    }else{await assert.rejects(invoke());assert.equal(store.run(run.id)!.completion?.reviewId,undefined);}
    assert.equal(publishes,['success','blocked','needs_attention','changed-callback','post-race'].includes(shape)?1:0);
    assert.equal(store.runs(task.id).length,shape==='live-run'?2:1,'never creates a reviewer or author run');
    assert.ok(observations===0||observations>=1);
  });
}

