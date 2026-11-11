import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QueueRuntime } from '../../service/runtime-owner';
import { externalMerge, reviewPublicationBody } from '../../core/forge/index';
import { digest } from '../../core/store/store';
import { collectOwnerVerbFacts, ownerTaskNext } from '../../core/verbs/owner-verbs';
import { submissionSchema, taskControlInputSchema, type Profile, type Task } from '../../shared/contracts';
import type { Adapter, AgentObservation } from '../../core/host';
import type { TimelineEntry } from '../../core/recovery/stall';
import { toolTimelinePage } from './tool-timeline';

const profile: Profile = {id:'worker',name:'Worker',provider:'test',model:'test/worker',notes:'',available:true,problem:'',supportedThinking:[]};
const reviewer: Profile = {...profile,id:'reviewer',name:'Reviewer',model:'test/reviewer'};
export const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const ghOrigin='ssh://git@github.com/example/repo.git';

/** Actual Queue dispatch and authenticated worker receipt, with a separate writer and local forge answer. */
export async function fixture(withReview=false,withProof=false) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ns-retained-merge-'))), repo=join(root,'repo'), origin=join(root,'origin.git');
  git(root,'init','--bare',origin); git(root,'init','-b','main',repo);
  git(repo,'config','user.name','Fixture'); git(repo,'config','user.email','fixture@example.test');
  writeFileSync(join(repo,'README.md'),'base\n'); git(repo,'add','.'); git(repo,'commit','-m','base');
  const base=git(repo,'rev-parse','HEAD'); git(repo,'remote','add','origin',origin); git(repo,'push','origin','main');
  git(repo,'config','remote.origin.url',ghOrigin); git(repo,'config',`url.${origin}.insteadOf`,ghOrigin);
  const bin=join(root,'gh'), answer=join(root,'pull.json');
  writeFileSync(bin,'#!/bin/sh\nexec cat "$(dirname "$0")/pull.json"\n'); chmodSync(bin,0o755);
  let token='', reviewerToken='', reviewerRun='', proofToken='', proofRun='', workspace='', workspaceId='', head='', final='', mergeCommit='', worker='';
  // Paseo reports `activeTurnId: null` whenever no turn is live, so the fixture
  // does too: a settlement reads that positive fact, never a missing field.
  let state:Partial<AgentObservation>={status:'idle',active:false,permissions:false,activeTurnId:null};
  let mergeCalls=0, sourceReads=0, forgeReady=false, aliased=false; let onProof:(()=>void)|null=null;
  // The tool entry the fake timeline serves, when a test needs one: no entry is
  // complete empty history.
  let toolItem:TimelineEntry['item']|null=null;
  const adapter={client:{isConnected:true},hostId:'fixture',socketPath:join(root,'cb.sock'),helperPath:join(root,'helper.mjs'),connect:async()=>{},close:async()=>{},
    profiles:async()=>[profile,reviewer],validate:async()=>base,
    createWorkspace:async(t:Task)=>{workspace=join(root,t.branch);workspaceId='workspace';git(repo,'worktree','add','-b',t.branch,workspace,'main');return{id:workspaceId,directory:workspace};},
    findWorkspaces:async()=>aliased?[{id:workspaceId,directory:workspace},{id:'alias',directory:workspace}]:[{id:workspaceId,directory:workspace}],verifyWorkspace:async(t:Task)=>t.branch,
    createAgent:async(t:Task,value:string)=>{token=value;worker='worker-agent';return{id:worker,workspaceId:t.workspaceId};},
    observe:async(id:string)=>({id,workspaceId:id===worker||id==='review-agent'||id==='proof-agent'?workspaceId:'owner-workspace',error:'',...state}),
    agentTimelinePage:async()=>toolTimelinePage(toolItem?[{timestamp:new Date().toISOString(),item:toolItem}]:[]),
    verifyPr:async()=>({url:'https://github.com/example/repo/pull/41',head,repository:'example/repo',headRepository:'example/repo'}),
    verifyReview:async()=>{},
    externalMerge:async(t:Task,accept?:boolean,retained?:boolean)=>{if(!forgeReady)return null;sourceReads++;onProof?.();return externalMerge(t,accept,retained);},
    merge:async()=>{mergeCalls++;}, archiveAgent:async()=>{},notify:async()=>{},findAgents:async()=>[],findRunAgents:async()=>[],
    createRun:async(_task:Task,run:{id:string;workspaceId:string;role:string},value:string)=>{
      if(run.role==='executor'){proofToken=value;proofRun=run.id;return{id:'proof-agent',workspaceId:run.workspaceId};}
      reviewerToken=value;reviewerRun=run.id;return{id:'review-agent',workspaceId:run.workspaceId};
    },
    sendRun:async()=>{},publishReview:async(store:any,t:Task,run:any,status:string,text:string)=>{
      store.setMeta(`reviewPublication:${run.id}`,{hash:digest(reviewPublicationBody(t,run,status,text)),commentId:71});return 71;
    },
  } as unknown as Adapter;
  const runtime=new QueueRuntime({dataDir:join(root,'data'),adapterFactory:()=>adapter,timers:false});
  await runtime.started; await runtime.bootstrap; runtime.engine.profiles=[profile,reviewer];
  runtime.store.setMeta('pool',[{profileId:'worker',enabled:true,group:'worker',weight:1,scopes:['general'],roles:['worker']}]);
  runtime.store.setMeta('paused',false);
  const task=runtime.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Retained source',repoPath:repo,planningCommit:base,
    handoffPath:'handoff.md',originAgentId:'origin',...(withProof?{proofExecution:{selector:'git rev-parse HEAD',inputs:[]}}:{})}),'fixture','fixture',base,{},undefined,'example/repo');
  const project=runtime.store.projectFor(repo,'example/repo')!;
  runtime.store.setProjectPlanner({key:project.key,agentId:'owner',setBy:'test',note:'Fixture planner'});
  await runtime.engine.wake();
  let current=runtime.store.task(task.id); assert.equal(current.phase,'working',current.reason); assert.ok(current.runId && token);
  writeFileSync(join(workspace,'work.txt'),'original\n'); git(workspace,'add','work.txt');git(workspace,'commit','-m','original work');
  head=git(workspace,'rev-parse','HEAD');git(workspace,'push','origin',current.branch);
  runtime.store.setMeta('paused',true);
  await runtime.engine.complete({eventId:randomUUID(),taskId:task.id,runId:current.runId!,status:'ready_for_review',summary:'Ready',prNumber:41,head},token);
  runtime.store.setMeta('paused',false); await runtime.engine.wake();
  current=runtime.store.task(task.id); assert.equal(current.prHead,head,current.reason);
  if(withProof){
    await runtime.taskControl(taskControlInputSchema.parse({taskId:task.id,version:current.version,action:'proof',reason:'Exercise the declared source read',caller:'operator (board)'}));
    assert.ok(proofRun && proofToken,'the public proof activation created its executor');
    const actual=git(workspace,'rev-parse','HEAD');
    await runtime.engine.complete({eventId:randomUUID(),taskId:task.id,runId:proofRun,status:'proof_executed',head,summary:'Read the source head',
      proofResult:{status:'passed',selector:'git rev-parse HEAD',exitCode:0,evidence:`git rev-parse HEAD: ${actual}`}},proofToken);
    await runtime.engine.wake();await runtime.engine.wake();
    current=runtime.store.task(task.id);
    assert.equal(current.proofExecutions[0]?.status,'passed',current.reason);
  }
  if(withReview){
    runtime.store.setMeta('pool',[{profileId:'worker',enabled:true,group:'worker',weight:1,scopes:['general'],roles:['worker']},
      {profileId:'reviewer',enabled:true,group:'reviewer',weight:1,scopes:['general'],roles:['reviewer']}]);
    await runtime.engine.wake();
    assert.ok(reviewerRun && reviewerToken, runtime.store.task(task.id).reason);
    await runtime.engine.complete({eventId:randomUUID(),taskId:task.id,runId:reviewerRun,status:'changes_required',head,
      summary:'The original source needs attention',reviewText:'The original source needs an additional change.',reviewResponsibility:'author'},reviewerToken);
    await runtime.engine.wake();await runtime.engine.wake();
    current=runtime.store.task(task.id);
    assert.equal(current.resolution.review?.runId,reviewerRun,current.reason);
  }
  runtime.store.setMeta('paused',true); await runtime.engine.quiesce();
  const writer=join(root,'writer');git(root,'clone',origin,writer);git(writer,'config','user.name','Writer');git(writer,'config','user.email','writer@example.test');
  git(writer,'checkout',current.branch);writeFileSync(join(writer,'work.txt'),'descendant\n');git(writer,'add','work.txt');git(writer,'commit','-m','follow-up');
  final=git(writer,'rev-parse','HEAD');git(writer,'push','origin',current.branch);
  git(writer,'checkout','main');git(writer,'merge','--no-ff',final,'-m','external merge');mergeCommit=git(writer,'rev-parse','HEAD');git(writer,'push','origin','main');
  // The forge head's object is already locally observable, as in the reported
  // case; this updates the integration checkout's object store, never the retained source.
  git(repo,'fetch','origin',current.branch);
  git(repo,'config','--unset-all',`url.${origin}.insteadOf`);
  const payload={number:41,state:'closed',merged:true,draft:false,html_url:'https://github.com/example/repo/pull/41',merge_commit_sha:mergeCommit,
    head:{sha:final,ref:current.branch,repo:{full_name:'example/repo'}},base:{ref:'main',repo:{full_name:'example/repo'}}};
  const respond=(body:unknown=payload)=>writeFileSync(answer,JSON.stringify(body)); respond();
  const oldPath=process.env.PATH;process.env.PATH=`${root}:${oldPath??''}`;
  forgeReady=true;
  const control=(extra:Record<string,unknown>={})=>taskControlInputSchema.parse({taskId:task.id,version:runtime.store.task(task.id).version,
    action:'move',to:'closeout',reason:'Accept the external merge',caller:'operator (board)',head:final,qualification:'I accept this exact final source as is',...extra});
  const close=async()=>{
    runtime.store.setMeta('paused',true);
    // Quiescence excludes title and cleanup projections. Drain those first,
    // then stop new engine work and wait for admission's queued calls to leave
    // before closing the store that its capacity callback reads.
    await runtime.engine.wake();
    await runtime.engine.stop();
    const classes=['callback','control','observation','title','cleanup','inventory','workspace'] as const;
    const idle=()=>{const state=runtime.admission.snapshot();return classes.every(cls=>state[cls].running===0 && state[cls].waiting===0);};
    const deadline=Date.now()+10_000;
    while(true){
      if(idle()){
        await new Promise<void>(resolve=>setImmediate(resolve));
        if(idle())break;
      }
      if(Date.now()>=deadline)throw new Error('Fixture admission did not drain before teardown');
      await new Promise<void>(resolve=>setTimeout(resolve,10));
    }
    await runtime.drain();process.env.PATH=oldPath;rmSync(root,{recursive:true,force:true});
  };
  return {runtime,adapter,taskId:task.id,workspace,head,final,mergeCommit,payload,respond,control,close,
    setState:(value:Partial<AgentObservation>)=>{state=value;},setProof:(fn:(()=>void)|null)=>{onProof=fn;},setAlias:()=>{aliased=true;},setTool:(item:TimelineEntry['item']={type:'tool_call',callId:'active',name:'exec',status:'running'})=>{toolItem=item;},counts:()=>({mergeCalls,sourceReads})};
}
