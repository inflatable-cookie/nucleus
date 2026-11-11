import { fakeAdapter } from './support/fakes';
import { stepEngine } from './support/engine-step';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Engine} from '../core/engine';
import {Store,digest} from '../core/store/store';
import {assertPullRequestIdentity,reviewPublicationBody} from '../core/forge/index';
import {collectOwnerVerbFacts,ownerTaskNext} from '../core/verbs/owner-verbs';
import {recoveryDispatchSnapshot} from '../core/recovery/recovery-context';
import {recoveryContextBlock} from '../core/dispatch/prompts';
import {git} from '../core/git/index';
import {submissionSchema,taskControlInputSchema,dispositionSchema,type Completion,type Profile,type Run,type PoolEntry} from '../shared/contracts';
import type {Adapter,AgentObservation} from '../core/host';
import {retainedProgressRun,type ResolutionAdapter} from '../core/resolution';
import type {TimelinePage} from '../core/recovery/stall';
import {toolTimelinePage} from './support/tool-timeline';
const head='a'.repeat(40),base='b'.repeat(40);
const profile=(id:string):Profile=>({id,name:id,model:id,provider:'fixture',available:true,problem:'',notes:'',supportedThinking:[]});
const briefV1='Brief v1: implement the author loop';
function fixture(options:{brief?:boolean;gateWait?:string}={}) {
 const dir=mkdtempSync(join(tmpdir(),'ns-author-loop-'));mkdirSync(join(dir,'source'));const store=new Store(join(dir,'db'));
 const profiles=['author','higher','top','reviewer','coordinator'].map(profile);
 const pool:PoolEntry[]=profiles.map(p=>({profileId:p.id,enabled:true,group:p.id,roles:p.id==='reviewer'?['reviewer']:p.id==='coordinator'?['coordinator']:['worker'],scopes:['general'],weight:1,
  // Spec 053: ratings, not role switches, give the reviewer and coordinator their profiles.
  capability:p.id==='author'?'low':p.id==='higher'?'medium':p.id==='reviewer'?'medium':p.id==='coordinator'?'low':'very_high',
  ...(p.id==='reviewer'?{cost:'low' as const}:p.id==='coordinator'?{cost:'very_low' as const}:{})}));
 store.setMeta('pool',pool);store.setMeta('paused',false);
 // Keep progress receipts and the author task-row binding for retained-work recovery cases.
 const submitted=store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Author loop',repoPath:join(dir,'source','repo'),siblings:false,planningCommit:base,...(options.brief?{brief:{text:briefV1}}:{handoffPath:'brief.md'}),originAgentId:'origin',responsible:false}),'host',options.brief?briefV1:'brief',base);
 const task=store.update(submitted.id,{profileRequests:{reviewer:{profileId:'reviewer',reason:'Keep the replacement worker independent',required:true}},phase:'awaiting_review',workspaceIntent:true,agentIntent:true,workspaceId:'workspace',directory:join(dir,'worktree'),agentId:'worker',runId:'initial',profile:profiles[0],workerModel:'author',workerModels:['author'],prHead:head,prUrl:'https://github.com/example/repo/pull/1',completion:{taskId:submitted.id,runId:'initial',eventId:'initial',status:'ready_for_review',summary:'Ready',prNumber:1,head}});
 const states=new Map<string,AgentObservation>(),tokens=new Map<string,string>();const creates:Run[]=[],sends:Run[]=[],writers:string[]=[];
 const idle=(id:string)=>states.set(id,{id,workspaceId:'workspace',status:'idle',active:false,permissions:false,error:'',model:states.get(id)?.model ?? (id==='worker'?'author':undefined)});idle('worker');
 let remoteHead=head,tool=false,unknownTools=false;
 // The provider page reader each case owns; `null` means the page is unreadable.
 let pages:(limit:number)=>TimelinePage|null=limit=>unknownTools?null:tool?toolTimelinePage([{timestamp:new Date().toISOString(),item:{type:'tool_call',callId:'live',name:'Bash',status:'running'}}]):toolTimelinePage([]);
 const adapter:Adapter & ResolutionAdapter=fakeAdapter({profiles:async()=>profiles,validate:async()=>base,verifyWorkspace:async()=>task.branch,
  createWorkspace:async()=>{throw Error('Unexpected workspace')},findAgents:async t=>writers.map(id=>({id,workspaceId:t.workspaceId})),
  createAgent:async(t,token)=>{writers.push(`new-${writers.length}`);const id=writers.at(-1)!;idle(id);states.set(id,{...states.get(id)!,active:true,status:'running',model:t.profile?.model});tokens.set(t.runId!,token);return{id,workspaceId:t.workspaceId}},
  observe:async id=>{const state=states.get(id);if(!state)throw Error('Agent missing');return state},
  agentTimelinePage:async(_id:string,limit=0)=>pages(limit),agentTimeline:async(_id:string,limit=40)=>{const page=pages(limit);return page?page.entries:null},
  verifyPr:async()=>({head:remoteHead,url:task.prUrl??'https://github.com/example/repo/pull/1',repository:'example/repo',headRepository:'example/repo'}),verifyPrIdentity:async()=>({head:remoteHead,url:task.prUrl??'https://github.com/example/repo/pull/1',repository:'example/repo',headRepository:'example/repo'}),verifyResume:async()=>{},verifyReplacementSource:async()=>{},verifyCleanQueueWorktree:async()=>{},
  verifyContinuedProgress:async(_task,_number,expected)=>{if(expected!==remoteHead)throw Error('Progress source changed')},
  createRun:async(t,r,token)=>{creates.push(r);tokens.set(r.id,token);const id=`agent-${r.id}`;idle(id);states.set(id,{...states.get(id)!,active:true,status:'running',model:r.profile?.model});return{id,workspaceId:r.workspaceId}},
  sendRun:async(t,r,token)=>{sends.push(r);tokens.set(r.id,token);states.set(r.agentId!,{...states.get(r.agentId!)!,active:true,status:'running'})},findRunAgents:async()=>[],
  publishReview:async(store,t,r,status,text)=>{
   const hash=digest(reviewPublicationBody(t,r,status,text,store.run(r.id)?.completion?.verdicts ?? []));
   store.setMeta(`reviewPublication:${r.id}`,{hash});
   const id=creates.filter(run=>run.role==='reviewer').length;
   store.setMeta(`reviewPublication:${r.id}`,{hash,commentId:id});return id;
  },
  verifyReview:async()=>{},notify:async()=>{},mergeGate:async()=>({head:remoteHead,base,wait:options.gateWait??''}),merged:async()=>({merged:false,commit:null,head,base:'main'}),merge:async()=>{},syncMain:async()=>base,verifyCloseout:async()=>{},
 });
 const engine=new Engine(store,adapter,0);engine.profiles=profiles;engine.resolution.worktreeValidationProbe=()=>({state:'absent'});
 const current=()=>store.task(task.id),run=()=>store.run(current().resolution.currentRunId!)!;
 async function report(status:Completion['status']) {const r=run();idle(r.agentId!);const input:Completion={taskId:task.id,runId:r.id,eventId:randomUUID(),status,summary:status,head:r.head,
  ...(r.role==='reviewer'?{reviewText:'Substantive findings: '+status,...(status==='changes_required'?{reviewResponsibility:'author' as const}:status==='blocked'?{reviewResponsibility:'environment' as const}:{})}:{prNumber:1})};
  const token=tokens.get(r.id)!;assert.equal(engine.resolution.complete(input,token).accepted,true);await engine.wake();return{input,token};}
 async function reviews(count:number){for(let i=0;i<count;i++){await engine.wake();assert.equal(run().role,'reviewer');await report('changes_required');if(i<count-1){await engine.wake();assert.equal(run().role,'revision');await report('ready_for_review');}}}
 return {dir,store,engine,adapter,current,run,report,reviews,idle,states,profiles,pool,creates,sends,writers,tokens,task,setHead:(value:string)=>remoteHead=value,setTool:(value:boolean)=>tool=value,setUnknownTools:()=>unknownTools=true,
  setPages:(reader:(limit:number)=>TimelinePage|null)=>{pages=reader},
  hold:async(kind:'merge'|'dispatch',reason='Manual acceptance gate')=>engine.performTaskControl(taskControlInputSchema.parse({taskId:task.id,version:store.task(task.id).version,action:'hold',kind,reason})),
  amend:async(text:string,reason='Owner narrowed the scope')=>engine.performTaskControl(taskControlInputSchema.parse({taskId:task.id,version:store.task(task.id).version,action:'amend_brief',brief:text,reason})),
  close:async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true})}};
}

for (const shape of ['omitted','structured','blocked','move','missing','review-receipt','review-receipt-race','receipt','conflict','source','effect','participant','report-race','route-race','hold-race','disposition-race','unknown-delivery'] as const) test(`replacement task-row progress ${shape}`,async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{prUrl:'https://github.com/example/repo/pull/1',prHead:'a'.repeat(40)},'test_pr_added','Known PR for retained progress');
  await f.reviews(1);const review=f.current().resolution.review!;await f.engine.wake();const old=f.run();f.idle(old.agentId!);
  await f.engine.complete({taskId:f.task.id,runId:old.id,eventId:randomUUID(),status:'blocked',summary:'Old author stopped',prNumber:1},f.tokens.get(old.id)!);
  await f.engine.wake();const stopped=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:stopped.id,version:stopped.version,action:'route',role:'worker',profileId:'higher',reason:'Planner routed the worker to a stronger model'}));
  await f.engine.wake();const worker=f.current();assert.notEqual(worker.agentId,'worker');assert.equal(worker.resumePrNumber,1);
  f.idle(worker.agentId!);
  const {Reports}=await import('../core/intake/report');const reports=new Reports(f.engine);
  const report={taskId:worker.id,runId:worker.runId!,eventId:randomUUID(),status:shape==='blocked'?'blocked' as const:'error' as const,summary:'Unfinished',
   ...(shape==='structured'?{head:'c'.repeat(40),prNumber:1}:shape==='conflict'?{prNumber:2}:{})};
  assert.equal((await reports.report(report,f.tokens.get(worker.runId!)!)).accepted,true);
  assert.equal((await reports.report(report,f.tokens.get(worker.runId!)!)).accepted,true);
  await f.engine.wake();f.setHead('c'.repeat(40));
  if(shape==='receipt')f.store.db.prepare('DELETE FROM receipts WHERE id=?').run(report.eventId);
  if(shape==='source')f.adapter.verifyContinuedProgress=async()=>{throw Error('Unpublished source')};
  let attempts=0;
  if(shape==='unknown-delivery')f.adapter.sendRun=async()=>{attempts++;throw Error('Delivery response lost')};
  if(shape==='participant')f.adapter.verifyContinuedProgress=async()=>{f.states.set(worker.agentId!,{...f.states.get(worker.agentId!)!,active:true,status:'running'})};
  if(shape==='review-receipt-race')f.adapter.verifyContinuedProgress=async()=>{f.store.db.prepare('DELETE FROM receipts WHERE id=?').run(review.eventId)};
  if(shape==='report-race')f.adapter.verifyContinuedProgress=async()=>{f.store.db.prepare('DELETE FROM receipts WHERE id=?').run(report.eventId)};
  if(shape==='route-race')f.adapter.verifyContinuedProgress=async()=>{const t=f.current();f.store.update(t.id,{profileRequests:{...t.profileRequests,worker:{profileId:'top',reason:'New route',required:true,ownerRoute:true}}})};
  if(shape==='disposition-race')f.adapter.verifyContinuedProgress=async()=>{f.store.update(worker.id,{disposition:dispositionSchema.parse({kind:'cancel',status:'intent',requestedAt:new Date().toISOString(),requestedBy:'operator',reason:'Stop',workDisposition:'preserve'})})};
  if(shape==='hold-race')f.adapter.verifyContinuedProgress=async()=>{await f.hold('dispatch')};
  if(shape==='effect')f.adapter.verifyContinuedProgress=async()=>{f.store.putNotice({id:'unknown',taskId:worker.id,agentId:'origin',recipientAgentId:'origin',text:'unknown delivery',status:'uncertain',error:'',kind:'attention',workspaceId:null,sources:[],originEntry:true})};
  const blocked=f.current();await f.engine.performTaskControl(taskControlInputSchema.parse(shape==='move'?{taskId:blocked.id,version:blocked.version,action:'move',to:'work',reason:'Continue unfinished work'}:{taskId:blocked.id,version:blocked.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  if(shape==='missing')f.store.update(worker.id,{completion:null});
  if(shape==='review-receipt')f.store.db.prepare('DELETE FROM receipts WHERE id=?').run(review.eventId);
  await f.engine.wake();
  if(shape==='unknown-delivery'){
   assert.equal(attempts,1);const runId=f.current().resolution.currentRunId;assert.ok(runId);assert.equal(f.store.run(runId)?.status,'uncertain');
   await f.engine.wake();assert.equal(attempts,1);
   await f.engine.stop();const restarted=new Engine(f.store,f.adapter,0);restarted.profiles=f.profiles;restarted.resolution.worktreeValidationProbe=()=>({state:'absent'});
   try{await restarted.wake();assert.equal(attempts,1);assert.equal(f.current().resolution.currentRunId,runId)}finally{await restarted.stop()}
  }else if(shape==='omitted'||shape==='structured'||shape==='blocked'||shape==='move'){
   assert.equal(f.current().prHead,'c'.repeat(40),f.current().reason);assert.equal(f.run().agentId,worker.agentId);
  }else assert.notEqual(f.current().prHead,'c'.repeat(40),shape);
  assert.equal(f.store.run(old.id)?.completion?.status,'blocked');
 }finally{await f.close()}
});

for (const rewritten of [false,true]) test(`replacement task-row progress with ${rewritten?'rewritten':'descendant'} source`,async()=>{
 let resumed:Engine|null=null;const f=fixture(), savedPath=process.env.PATH, envNames=['NS_PROGRESS_REMOTE','NS_PROGRESS_HEAD_FILE','NS_PROGRESS_BRANCH'] as const;
 const saved=envNames.map(name=>process.env[name]);
 try {
  const root=join(f.dir,'source','repo'), remote=join(f.dir,'remote.git'), workerDir=join(f.dir,'worktree'), bin=join(f.dir,'bin');
  await git(f.dir,'init','--bare',remote);await git(f.dir,'init',root);await git(root,'checkout','-b','main');
  writeFileSync(join(root,'brief.md'),'brief');await git(root,'add','brief.md');await git(root,'commit','-m','planning');
  await git(root,'remote','add','origin',remote);await git(root,'push','-u','origin','main');
  const planning=await git(root,'rev-parse','HEAD'),branch=f.task.branch;
  await git(root,'worktree','add','-b',branch,workerDir,'main');
  writeFileSync(join(workerDir,'work.txt'),'reviewed work');await git(workerDir,'add','work.txt');await git(workerDir,'commit','-m','reviewed work');await git(workerDir,'push','-u','origin',branch);
  const reviewed=await git(workerDir,'rev-parse','HEAD');await git(root,'remote','set-url','origin','https://github.com/example/repo.git');
  const headFile=join(f.dir,'forge-head');writeFileSync(headFile,reviewed);mkdirSync(bin);
  const gitWrapper=join(bin,'git'), gh=join(bin,'gh');
  writeFileSync(gitWrapper,'#!/bin/sh\nif [ "$1" = ls-remote ] && [ "$2" = origin ]; then exec /usr/bin/git ls-remote "$NS_PROGRESS_REMOTE" "$3"; fi\nexec /usr/bin/git "$@"\n');chmodSync(gitWrapper,0o755);
  writeFileSync(gh,`#!/bin/sh\nh=$(cat "$NS_PROGRESS_HEAD_FILE")\nif [ "$1" = pr ]; then\n echo "{\\"number\\":1,\\"url\\":\\"https://github.com/example/repo/pull/1\\",\\"state\\":\\"OPEN\\",\\"isDraft\\":false,\\"headRefName\\":\\"$NS_PROGRESS_BRANCH\\",\\"baseRefName\\":\\"main\\",\\"headRefOid\\":\\"$h\\",\\"headRepository\\":{\\"name\\":\\"repo\\"},\\"headRepositoryOwner\\":{\\"login\\":\\"example\\"},\\"isCrossRepository\\":false}"\nelse\n echo "{\\"state\\":\\"open\\",\\"draft\\":false,\\"html_url\\":\\"https://github.com/example/repo/pull/1\\",\\"head\\":{\\"ref\\":\\"$NS_PROGRESS_BRANCH\\",\\"sha\\":\\"$h\\",\\"repo\\":{\\"full_name\\":\\"example/repo\\"}},\\"base\\":{\\"ref\\":\\"main\\"}}"\nfi\n`);chmodSync(gh,0o755);
  process.env.PATH=`${bin}:${savedPath ?? ''}`;process.env.NS_PROGRESS_REMOTE=remote;process.env.NS_PROGRESS_HEAD_FILE=headFile;process.env.NS_PROGRESS_BRANCH=branch;
  const source=await import('../core/git/index'),forge=await import('../core/forge/index');
  f.adapter.verifyPr=source.verifyPr;f.adapter.verifyPrIdentity=forge.verifyPrIdentity;f.adapter.verifyResume=source.verifyResume;
  f.adapter.verifyCleanQueueWorktree=source.verifyCleanQueueWorktree;f.adapter.verifyContinuedProgress=forge.verifyContinuedProgress;
  const initial=f.current();f.store.update(initial.id,{directory:workerDir,planningCommit:planning,planningBase:planning,prUrl:'https://github.com/example/repo/pull/1',prHead:reviewed,
    completion:{...initial.completion!,head:reviewed}});
  await f.reviews(1);await f.engine.wake();const old=f.run();f.idle(old.agentId!);
  f.engine.resolution.complete({taskId:f.task.id,runId:old.id,eventId:randomUUID(),status:'blocked',summary:'Old author stopped',prNumber:1},f.tokens.get(old.id)!);
  await stepEngine(f.engine);const stopped=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:stopped.id,version:stopped.version,action:'route',role:'worker',profileId:'higher',reason:'Planner routed the worker to a stronger model'}));
  await f.engine.wake();const worker=f.current();assert.equal(worker.resumePrNumber,1, JSON.stringify({phase:worker.phase,reason:worker.reason, agentId:worker.agentId}));f.idle(worker.agentId!);
  if(rewritten)await git(worker.directory!,'reset','--hard',planning);
  writeFileSync(join(worker.directory!,'work.txt'),'unfinished progress');await git(worker.directory!,'add','work.txt');await git(worker.directory!,'commit','-m','progress');await git(worker.directory!,'push',...(rewritten?['--force']:[]),remote,branch);
  const advanced=await git(worker.directory!,'rev-parse','HEAD');writeFileSync(headFile,advanced);
  const {Reports}=await import('../core/intake/report');const report={taskId:worker.id,runId:worker.runId!,eventId:randomUUID(),status:'error' as const,summary:'Stopped with progress pushed'};
  assert.equal((await new Reports(f.engine).report(report,f.tokens.get(worker.runId!)!)).accepted,true);await f.engine.wake();f.idle(worker.agentId!);
  const blocked=f.current();const control=taskControlInputSchema.parse({taskId:blocked.id,version:blocked.version,action:'restart',role:'worker',reason:'Continue work'});
  const payload={type:'task_control',control};const operation=await f.engine.startOperation({key:'task-row-restart',kind:'task_control',payload,deferSchedule:true});
  assert.ok('accepted' in operation);if(!('accepted' in operation))throw Error('Restart was not accepted');
  assert.equal(f.store.operation(operation.operation.id)?.state,'pending');await f.engine.stop();
  resumed=new Engine(f.store,f.adapter,0);resumed.profiles=f.profiles;resumed.resolution.worktreeValidationProbe=()=>({state:'absent'});
  resumed.resumeOperations();const finishedOperation=await resumed.awaitOperation(operation.operation.id,30000);assert.equal(finishedOperation.state,'succeeded',JSON.stringify(finishedOperation));
  await Promise.all([resumed.wake(),resumed.wake()]);
  if(rewritten){assert.notEqual(f.current().prHead,advanced);assert.match(f.current().reason,/does not contain recorded work/);}
  else {assert.equal(f.current().prHead,advanced,f.current().reason);assert.equal(f.run().agentId,worker.agentId);}
  const sends=f.sends.length;const replay=await resumed.startOperation({key:'task-row-restart',kind:'task_control',payload});
  assert.ok('accepted' in replay);if(!('accepted' in replay))throw Error('Restart replay was not accepted');
  assert.equal(replay.operation.id,operation.operation.id);await resumed.wake();assert.equal(f.sends.length,sends);await resumed.stop();

  assert.equal(f.store.run(old.id)?.completion?.status,'blocked');
 } finally {
  if(resumed)await resumed.stop();
  if(savedPath===undefined)delete process.env.PATH;else process.env.PATH=savedPath;
  envNames.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index]});
  await f.close();
 }
});


for (const status of ['blocked','error'] as const) for (const structured of [false,true]) test(`revision ${status} progress ${structured?'with':'without'} structured source`,async()=>{
 const f=fixture();try{
  await f.reviews(1);await f.engine.wake();const revision=f.run();assert.equal(revision.role,'revision');f.idle(revision.agentId!);
  const advanced='c'.repeat(40);f.setHead(advanced);
  const {Reports}=await import('../core/intake/report');const reports=new Reports(f.engine);
  const result={taskId:f.task.id,runId:revision.id,eventId:randomUUID(),status,summary:'Work remains',...(structured?{head:advanced,prNumber:1}:{})};
  assert.equal((await reports.report(result,f.tokens.get(revision.id)!)).accepted,true);await f.engine.wake();
  const before=f.current();await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished revision'}));
  await f.engine.wake();assert.equal(f.current().prHead,advanced,f.current().reason);assert.equal(f.run().agentId,revision.agentId);
  assert.equal(f.store.run(revision.id)?.completion?.eventId,result.eventId);
 }finally{await f.close()}
});

/** project-c#279: return the author from awaiting_review (no review recorded) and block at a newer published head. */
async function blockedAtNewerHeadWithoutReview(f:ReturnType<typeof fixture>,advanced='c'.repeat(40)) {
  assert.equal(f.current().resolution.review,null);
  assert.equal(f.current().resolution.reviews.length,0);
  const awaiting=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:awaiting.id,version:awaiting.version,action:'move',to:'work',reason:'Return the author before review'}));
  await f.engine.wake();
  const revision=f.run();assert.equal(revision.role,'revision',f.current().reason);f.idle(revision.agentId!);
  f.setHead(advanced);
  const {Reports}=await import('../core/intake/report');
  const result={taskId:f.task.id,runId:revision.id,eventId:randomUUID(),status:'blocked' as const,summary:'Stopped after pushing a newer head',prNumber:1,head:advanced};
  assert.equal((await new Reports(f.engine).report(result,f.tokens.get(revision.id)!)).accepted,true);await f.engine.wake();
  assert.equal(f.current().resolution.review,null);
  assert.equal(f.current().resolution.reviews.length,0);
  return {revision,advanced,author:revision.agentId!};
}

// Parent falsification: current tests against HEAD~1 core/resolution.ts (`if(!review||...)` at the
// receipt check). `effigy test unit -- test/retained-author-progress.test.ts --test-name-pattern='no review continues'`
// → 2 fail, 0 pass. Both leave prHead at the recorded head (`a`×40), expected the published head
// (`c`×40), assertion message "Retained progress review receipt is unavailable".
for (const verb of ['move','restart'] as const) test(`blocked author with a newer head and no review continues on ${verb}`,async()=>{
 const f=fixture();try{
  const {revision,advanced,author}=await blockedAtNewerHeadWithoutReview(f);
  const before=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse(verb==='move'
    ?{taskId:before.id,version:before.version,action:'move',to:'work',reason:'Continue unfinished work'}
    :{taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  await f.engine.wake();
  assert.equal(f.current().prHead,advanced,f.current().reason);
  assert.equal(f.run().role,'revision');
  assert.equal(f.run().agentId,author);
  assert.equal(f.store.run(revision.id)?.completion?.status,'blocked');
  assert.doesNotMatch(f.current().reason,/review receipt is unavailable/);
  const incident=f.current().resolution.incident;
  assert.ok(!incident || incident.status==='resolved' || !incident.detail.includes('review receipt is unavailable'),JSON.stringify(incident));
  const bound=f.store.events(f.task.id).filter(event=>event.kind==='continued_pr_bound');
  assert.ok(bound.length>=1,f.current().reason);
  assert.match(bound[0]!.detail,/identity only/);
 }finally{await f.close()}
});

/**
 * project-c#280: a settled review of any status at the older head, then a blocked author at a newer
 * pushed head. The review is recorded and its reviewer run released with the matching event, so
 * only its status used to fence the continuation.
 */
async function blockedAtNewerHeadAfterReview(f:ReturnType<typeof fixture>,status:'blocked'|'ready_to_merge',advanced='c'.repeat(40)) {
  await f.engine.wake();
  const reviewer=f.run();assert.equal(reviewer.role,'reviewer','the retained reviewer reads the ready head');f.idle(reviewer.agentId!);
  await f.report(status);
  const review=f.current().resolution.review!;
  assert.equal(review.status,status);
  assert.equal(review.head,head);
  assert.equal(f.current().prHead,head,'nothing has bound a newer head yet');
  const reviewRun=f.store.run(review.runId)!;
  assert.equal(reviewRun.released,true,'the recorded review is settled');
  assert.equal(reviewRun.completion?.eventId,review.eventId,'its released run carries its own result');
  // The owner returns the author to work at the reviewed head; the author pushes on and stops.
  const first=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:first.id,version:first.version,action:'move',to:'work',reason:'Return the author to work'}));
  await f.engine.wake();
  const revision=f.run();assert.equal(revision.role,'revision',f.current().reason);f.idle(revision.agentId!);
  f.setHead(advanced);
  const {Reports}=await import('../core/intake/report');
  const result={taskId:f.task.id,runId:revision.id,eventId:randomUUID(),status:'blocked' as const,summary:'Stopped after pushing a newer head',prNumber:1,head:advanced};
  assert.equal((await new Reports(f.engine).report(result,f.tokens.get(revision.id)!)).accepted,true);
  await f.engine.wake();
  assert.equal(f.current().resolution.review?.status,status,'the recorded review is unchanged');
  assert.equal(f.current().resolution.review?.head,head,'it still judges the older head');
  assert.equal(f.current().prHead,head,'nothing is bound before the owner continues');
  return {revision,advanced,author:revision.agentId!};
}

// Parent falsification: these four against HEAD~1 core/resolution.ts (the `review.status!=='changes_required'`
// test at the receipt check). `effigy test unit -- test/retained-author-progress.test.ts --test-name-pattern='does not fence'`
// → 4 fail, 0 pass. Each leaves prHead at the recorded head (`a`×40), expected the published head
// (`c`×40), with reason "Retained progress review receipt is unavailable". Three further new tests below
// (the merge-refusal, the settle-then-continue and the descent refusal) fail on that code for the same reason;
// the receipt-mismatch guard passes on both, because it asserts unchanged behaviour.
for (const status of ['blocked','ready_to_merge'] as const) for (const verb of ['move','restart'] as const) test(`a ${status} review at the older head does not fence the newer head on ${verb}`,async()=>{
 const f=fixture({...(status==='ready_to_merge'?{gateWait:'Waiting for a required check'}:{})});try{
  const {advanced,author}=await blockedAtNewerHeadAfterReview(f,status);
  const before=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse(verb==='move'
    ?{taskId:before.id,version:before.version,action:'move',to:'work',reason:'Continue unfinished work'}
    :{taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  await f.engine.wake();
  assert.equal(f.current().prHead,advanced,f.current().reason);
  assert.equal(f.run()?.role,'revision');
  assert.equal(f.run().agentId,author);
  assert.equal(f.current().resolution.review?.status,status,'the recorded review is history at its own head');
  assert.equal(f.current().resolution.review?.head,head);
  assert.doesNotMatch(f.current().reason,/review receipt is unavailable/);
  const incident=f.current().resolution.incident;
  assert.ok(!incident || incident.status==='resolved' || !incident.detail.includes('review receipt is unavailable'),JSON.stringify(incident));
  const bound=f.store.events(f.task.id).filter(event=>event.kind==='continued_pr_bound');
  assert.ok(bound.length>=1,f.current().reason);
  assert.match(bound.at(-1)!.detail,/identity only/);
 }finally{await f.close()}
});

test('a ready_to_merge review no longer approves the continued head and a fresh review is required',async()=>{
 const f=fixture({gateWait:'Waiting for a required check'});try{
  const {advanced}=await blockedAtNewerHeadAfterReview(f,'ready_to_merge');
  const before=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  await f.engine.wake();
  assert.equal(f.current().prHead,advanced,f.current().reason);
  assert.equal(f.current().resolution.review?.status,'ready_to_merge');
  assert.equal(f.current().resolution.review?.head,head,'the approval stays history at the head it judged');
  // It is not an approval of the continued head: merge demands a review there.
  await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.current().version,action:'move',to:'merge',reason:'Merge the continued head'})),/accepted review at the current PR head/);
  assert.equal(f.current().prHead,advanced);
  const next=ownerTaskNext(collectOwnerVerbFacts(f.store,f.current()));
  const merge=next.verbs.find(verb=>verb.verb==='move'&&verb.args?.to==='merge');
  // Merge is offered only through the qualified operator source acceptance, which names
  // the approval stranded at the older head as its missing evidence: no review credit.
  assert.ok(merge?.fill?.includes('qualification'),JSON.stringify(merge));
  assert.match(String(merge?.note),/not the current PR head/);
  // The continued head earns its own review: the author's readiness there is the
  // outstanding work, and the older approval is untouched beside it.
  const revision=f.run();assert.equal(revision.role,'revision');f.idle(revision.agentId!);
  const ready={taskId:f.task.id,runId:revision.id,eventId:randomUUID(),status:'ready_for_review' as const,summary:'Ready',prNumber:1,head:advanced};
  assert.equal(f.engine.resolution.complete(ready,f.tokens.get(revision.id)!).accepted,true);
  await f.engine.wake();
  assert.equal(f.current().phase,'awaiting_review',f.current().reason);
  // The older approval is not carried to the continued head: it is not a verdict there.
  assert.equal(f.current().resolution.review,null,'no recorded approval stands at the continued head');
  assert.equal(f.current().prHead,advanced);
 }finally{await f.close()}
});

test('a blocked review whose reviewer run did not release still does not pass',async()=>{
 const f=fixture();try{
  const {advanced}=await blockedAtNewerHeadAfterReview(f,'blocked');
  const review=f.current().resolution.review!;
  f.store.update(f.task.id,{resolution:{...f.current().resolution,review:{...review,eventId:'mismatched-review-event'}}});
  const before=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  await f.engine.wake();
  assert.notEqual(f.current().prHead,advanced,f.current().reason);
  assert.match(f.current().reason,/review receipt is unavailable/);
 }finally{await f.close()}
});

test('a blocked review whose reviewer run is still unsettled waits instead of continuing',async()=>{
 const f=fixture();try{
  const {advanced,author}=await blockedAtNewerHeadAfterReview(f,'blocked');
  const review=f.current().resolution.review!;
  const reporter=f.store.run(review.runId)!;
  f.store.putRun({...reporter,released:false,status:'uncertain'});
  const before=f.current();
  // The verb may refuse the live run or accept it and let the dispatch wait: either way nothing binds.
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished work'})).catch(()=>undefined);
  await f.engine.wake();
  assert.notEqual(f.current().prHead,advanced,'nothing is bound while the reviewer run is unsettled');
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='continued_pr_bound').length,0);
  // Once that run is settled, the same continuation reaches the author.
  f.store.putRun({...reporter,released:true,status:'finished'});
  const settled=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:settled.id,version:settled.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  await f.engine.wake();
  assert.equal(f.current().prHead,advanced,f.current().reason);
  assert.equal(f.run()?.agentId,author);
 }finally{await f.close()}
});

test('a newer head that does not descend from the blocked review head still refuses',async()=>{
 const f=fixture();try{
  const {advanced}=await blockedAtNewerHeadAfterReview(f,'blocked');
  f.adapter.verifyContinuedProgress=async()=>{throw Error(`Continued progress does not contain recorded work ${head}`)};
  const before=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  await f.engine.wake();
  assert.notEqual(f.current().prHead,advanced,f.current().reason);
  assert.match(f.current().reason,/does not contain recorded work/);
 }finally{await f.close()}
});

test('a recorded changes_required review still needs its released reviewer run',async()=>{
 const f=fixture();try{
  await f.reviews(1);await f.engine.wake();const revision=f.run();assert.equal(revision.role,'revision');f.idle(revision.agentId!);
  const advanced='c'.repeat(40);f.setHead(advanced);
  const {Reports}=await import('../core/intake/report');
  const result={taskId:f.task.id,runId:revision.id,eventId:randomUUID(),status:'blocked' as const,summary:'Work remains',prNumber:1,head:advanced};
  assert.equal((await new Reports(f.engine).report(result,f.tokens.get(revision.id)!)).accepted,true);await f.engine.wake();
  const review=f.current().resolution.review!;assert.equal(review.status,'changes_required');
  f.store.update(f.task.id,{resolution:{...f.current().resolution,review:{...review,eventId:'mismatched-review-event'}}});
  const before=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  await f.engine.wake();
  assert.notEqual(f.current().prHead,advanced,f.current().reason);
  assert.match(f.current().reason,/review receipt is unavailable/);
 }finally{await f.close()}
});

test('a newer head that does not descend from known heads still refuses without a review',async()=>{
 const f=fixture();try{
  const {advanced}=await blockedAtNewerHeadWithoutReview(f);
  f.adapter.verifyContinuedProgress=async()=>{throw Error(`Continued progress does not contain recorded work ${head}`)};
  const before=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  await f.engine.wake();
  assert.notEqual(f.current().prHead,advanced,f.current().reason);
  assert.match(f.current().reason,/does not contain recorded work/);
 }finally{await f.close()}
});

test('a continued head with no review still needs exact-head review before merge',async()=>{
 const f=fixture();try{
  const {advanced}=await blockedAtNewerHeadWithoutReview(f);
  const before=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:before.id,version:before.version,action:'restart',role:'worker',reason:'Continue unfinished work'}));
  await f.engine.wake();
  assert.equal(f.current().prHead,advanced,f.current().reason);
  const revision=f.run();f.idle(revision.agentId!);
  const ready={taskId:f.task.id,runId:revision.id,eventId:randomUUID(),status:'ready_for_review' as const,summary:'Ready',prNumber:1,head:advanced};
  assert.equal(f.engine.resolution.complete(ready,f.tokens.get(revision.id)!).accepted,true);
  await f.engine.wake();
  if(f.run()?.role==='reviewer')f.idle(f.run().agentId!);
  await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.current().version,action:'move',to:'merge',reason:'Merge the continued head'})),/accepted review at the current PR head/);
  assert.equal(f.current().prHead,advanced);
  assert.equal(f.current().resolution.review,null);
 }finally{await f.close()}
});

test('foreign task report cannot authorize revision progress',async()=>{
 const f=fixture();try{
  await f.reviews(1);await f.engine.wake();const revision=f.run();f.idle(revision.agentId!);
  const {Reports}=await import('../core/intake/report');const reports=new Reports(f.engine);
  const result={taskId:randomUUID(),runId:revision.id,eventId:randomUUID(),status:'blocked' as const,summary:'Foreign'};
  await assert.rejects(reports.report(result,f.tokens.get(revision.id)!));
  assert.equal(f.store.run(revision.id)?.completion,null);
 }finally{await f.close()}
});

// effigy#512: the initial worker lives on the task row, so its authenticated
// blocked report is retained progress even when the same agent has a revision
// run. Only a revision that reported, or one still live, changes that.
const receiptFor = (f: ReturnType<typeof fixture>, stored: Completion) => {
  f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(stored.eventId, f.current().id, stored.runId, digest(JSON.stringify(stored)), JSON.stringify({ accepted: true }));
};
const recordTaskRowReport = (f: ReturnType<typeof fixture>, completion: Completion) => {
  f.store.update(f.task.id, { completion });
  receiptFor(f, f.current().completion!);
};
const retainedRevision = (f: ReturnType<typeof fixture>, over: Partial<Run>): Run => ({ id: 'revision-1', taskId: f.current().id, role: 'revision', generation: 1, head, base,
  agentId: 'worker', workspaceId: 'workspace', profile: null, status: 'superseded', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: true, ...over });
const blockedOnTaskRow = (f: ReturnType<typeof fixture>): Completion => ({ taskId: f.task.id, runId: 'initial', eventId: 'initial-blocked', status: 'blocked', summary: 'Stopped on the initial turn', head: 'c'.repeat(40) }) as Completion;

test('an initial task-row blocked report stays retained progress when the same agent has a revision that never reported',async()=>{
 const f=fixture();try{
  recordTaskRowReport(f,blockedOnTaskRow(f));
  f.store.putRun(retainedRevision(f,{}));
  assert.equal(retainedProgressRun(f.store,f.current())?.id,'initial','the task-row report is the author\'s latest result');
  assert.equal(retainedProgressRun(f.store,f.current())?.head,'c'.repeat(40));
 }finally{await f.close()}
});

test('a live revision owns the retained author, so the task-row report is not retained progress',async()=>{
 const f=fixture();try{
  recordTaskRowReport(f,blockedOnTaskRow(f));
  f.store.putRun(retainedRevision(f,{released:false,status:'running'}));
  assert.equal(retainedProgressRun(f.store,f.current()),null);
 }finally{await f.close()}
});

test('a revision that reported is the retained progress, ahead of the task-row report',async()=>{
 const f=fixture();try{
  recordTaskRowReport(f,blockedOnTaskRow(f));
  f.store.putRun(retainedRevision(f,{head:'d'.repeat(40),status:'finished',completion:{taskId:f.task.id,runId:'revision-1',eventId:'revision-error',status:'error',summary:'Revision stopped',head:'d'.repeat(40)} as Completion}));
  receiptFor(f,f.store.run('revision-1')!.completion!);
  assert.equal(retainedProgressRun(f.store,f.current())?.id,'revision-1');
  assert.equal(retainedProgressRun(f.store,f.current())?.head,'d'.repeat(40));
 }finally{await f.close()}
});

test('unbound blocked revision can be returned to its worker and bind its first PR',async()=>{
 const f=fixture();try{
  const initial={...blockedOnTaskRow(f),status:'error' as const,summary:'Initial error'};
  f.store.update(f.task.id,{phase:'needs_attention',prUrl:null,prHead:null,resumePrNumber:null,completion:initial,
   resolution:{...f.current().resolution,attention:true,prePrResumeInstruction:'Old instruction'}});
  receiptFor(f,initial);
  const blocked={taskId:f.task.id,runId:'revision-1',eventId:'revision-block',status:'blocked' as const,summary:'Revision blocked',prNumber:4918,head};
  f.store.putRun(retainedRevision(f,{status:'finished',completion:blocked}));receiptFor(f,blocked);
  f.adapter.verifyPr=async()=>({head,url:'https://github.com/example/repo/pull/4918',repository:'example/repo',headRepository:'example/repo'});
  f.adapter.verifyPrIdentity=f.adapter.verifyPr;
  const before=f.current();
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:before.id,version:before.version,action:'move',to:'work',reason:'Continue',instruction:'Finish the work'}));
  await f.engine.wake();
  assert.equal(f.run()?.role,'revision',f.current().reason);
  assert.equal(f.run().instruction,'Finish the work');
  assert.doesNotMatch(f.current().reason,/Task has no PR/);
  const r=f.run();f.idle(r.agentId!);
  const report={taskId:f.task.id,runId:r.id,eventId:randomUUID(),status:'ready_for_review' as const,summary:'Ready',prNumber:4918,head};
  assert.equal(f.engine.resolution.complete(report,f.tokens.get(r.id)!).accepted,true);
  await f.engine.wake();
  assert.equal(f.current().resumePrNumber,4918);
  assert.equal(f.current().prHead,head);
 }finally{await f.close()}
});

for (const status of ['blocked','error'] as const) test(`${status} revision records PR identity without granting readiness`,async()=>{
 const f=fixture();try{
  await f.reviews(1);await f.engine.wake();const r=f.run();f.idle(r.agentId!);
  f.store.update(f.task.id,{prUrl:null,prHead:null,resumePrNumber:null,completion:{...blockedOnTaskRow(f),status:'error'}});
  f.adapter.verifyPr=async()=>({head,url:'https://github.com/example/repo/pull/4918',repository:'example/repo',headRepository:'example/repo'});
  const report={taskId:f.task.id,runId:r.id,eventId:randomUUID(),status,summary:'Still blocked',prNumber:4918,head};
  assert.equal(f.engine.resolution.complete(report,f.tokens.get(r.id)!).accepted,true);await f.engine.wake();
  assert.equal(f.current().resumePrNumber,4918);assert.equal(f.current().prHead,head);
  assert.equal(f.store.run(r.id)?.completion?.status,status);assert.notEqual(f.current().phase,'awaiting_review');
 }finally{await f.close()}
});


test('forced review binds the canonical PR and dispatches its exact head',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{phase:'needs_attention',prUrl:null,prHead:null,resumePrNumber:null,completion:blockedOnTaskRow(f),resolution:{...f.current().resolution,attention:true}});
  const pr={state:'open',draft:false,html_url:'https://github.com/example/repo/pull/4918',head:{ref:f.task.branch,sha:head},base:{ref:f.task.baseBranch}};
  let branch=pr.head.ref;
  f.adapter.verifyPrIdentity=async t=>({...assertPullRequestIdentity(t,{...pr,head:{...pr.head,ref:branch}}),repository:'example/repo',headRepository:'example/repo'});
  f.adapter.verifyPr=f.adapter.verifyPrIdentity;
  const move=()=>f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.current().version,caller:'operator (board)',action:'move',to:'review',force:true,reason:'Review the work',prNumber:4918}));
  branch='other-branch';await assert.rejects(move(),/match the task branch and base/);
  assert.equal(f.current().resumePrNumber,null);
  branch=f.task.branch;await move();await f.engine.wake();
  assert.equal(f.current().resumePrNumber,4918);assert.equal(f.current().prHead,head);
  assert.equal(f.run().role,'reviewer',f.current().reason);assert.equal(f.run().head,head);
 }finally{await f.close()}
});

test('latest revision report appears in next stop and coordinator snapshot',async()=>{
 const f=fixture();try{
  const initial=blockedOnTaskRow(f);const now=new Date().toISOString();
  f.store.update(f.task.id,{phase:'needs_attention',reason:'Task has no PR',completion:initial,resolution:{...f.current().resolution,attention:true,incident:{id:'incident',role:'worker',runId:'initial',fingerprint:'',attempt:0,cause:'worker_blocked',detail:initial.summary,action:'',status:'escalated',createdAt:now,updatedAt:now}}});
  const report={taskId:f.task.id,runId:'revision-1',eventId:'revision-block',status:'blocked' as const,summary:'Revision needs a dependency',prNumber:4918,head};
  f.store.putRun(retainedRevision(f,{status:'finished',completion:report}));
  const facts=collectOwnerVerbFacts(f.store,f.current()), next=ownerTaskNext(facts);
  const snapshot=recoveryDispatchSnapshot(facts,{cause:'worker blocked',target:'worker',recoveryRunId:'recovery'});
  assert.equal(next.outcome.authorResult?.runId,'revision-1');assert.equal(next.outcome.authorResult?.summary,report.summary);
  assert.equal(next.stop?.detail,report.summary);assert.equal(snapshot.authorResult?.summary,report.summary);
  assert.equal(snapshot.stop?.detail,report.summary);assert.match(recoveryContextBlock(snapshot,'helper','ticket'),/Revision needs a dependency/);
 }finally{await f.close()}
});
