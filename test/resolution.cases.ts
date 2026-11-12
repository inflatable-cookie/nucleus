import { fakeAdapter, profile } from './support/fakes';
import { RECOVERY_ESCALATION_FAILURE_PREFIX } from '../core/recovery/task-reasons';
import { ForgeOutageError } from '../core/forge/forge-health';
import { test } from './support/sharded-test';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { briefDigest } from '../core/planning/brief';
import { Engine, controlHasExternalEffect } from '../core/engine';
import { holdOwnerOf, taskOwner, QUEUE_REPOSITORY_ORIGIN, RETAINED_WORKER_PROFILE_REASON, REVISION_BUDGET, runSchema, submissionSchema, taskControlInputSchema, taskDetailView, summarizeTask, visibleTaskSummaries, type Profile, type Run, type Task, type Completion } from '../shared/contracts';
import { PaseoAdapter, type Adapter, type AgentObservation } from '../service/paseo-composition';
import type { ResolutionAdapter } from '../core/resolution';
import { MERGE_CONFLICT_REASON, requiredCheckPollMetaKey, reviewPublicationBody, taskPrNumber } from '../core/forge/index';
import { ABSENT_RESOLUTION_REASON, ABSENT_WORKER_REASON, ACCEPTED_PR_RECONCILIATION_REASON, EXTERNAL_MERGE_CHECK_REASON_PREFIX, EXTERNAL_MERGE_CHECK_RECOVERED_REASON, NO_ORIGIN_THREAD_WAIT, originRecipient, proofWaitApplies } from '../core/resolution';
import { RECOVERY_STOPPED_WITHOUT_RESULT, ACCEPTED_RECOVERY_NOT_APPLIED_PREFIX } from '../core/recovery/recovery';
import { runPrompt } from '../core/dispatch/prompts';
import { dispatchBlocked } from '../core/dispatch/capacity';
import { pipelineBoard, pipelineColumn } from '../shared/pipeline-board';
import { REPOSITORY_CONTENTION_GRACE_MS } from '../core/scheduling/repository-contention';
import { Decisions } from '../core/planning/decisions';
import { chooseProfile } from '../core/dispatch/routing';
import { reconcileRoutingSignoffs, signoffApprove } from '../core/dispatch/routing-signoff';
import { taskWaitStateContext } from '../core/recovery/wait-context';
import { ownerRevisionFixture } from './support/review-entry-fixture';
import { stepEngine } from './support/engine-step';
import { isTransientExternalFailure, taskStopClassification, taskStopRecord } from '../shared/task-stop';
import { LoginSessionFaultError } from '../shared/session-fault';
import { consecutiveNonDeliveries } from '../core/recovery/non-delivery';
import { GitReadTimeoutError, gitReadTimeoutFailure } from '../core/git/index';
import { DEFAULT_UNCERTAIN_MERGE_RETRY_MS } from '../shared/contracts';

test('local Git status timeout classification requires the child timeout witness',()=>{
 const timeout=gitReadTimeoutFailure(['status','--porcelain'],600000,{killed:true,signal:'SIGTERM'});
 assert.ok(timeout instanceof GitReadTimeoutError);
 assert.match(timeout.message,/git status --porcelain timed out/);
 assert.equal(gitReadTimeoutFailure(['status','--porcelain'],600000,{message:'git status timed out'}),null);
 assert.equal(gitReadTimeoutFailure(['status','--porcelain'],600000,{code:128,killed:false}),null);
 assert.equal(gitReadTimeoutFailure(['status','--porcelain'],600000,{killed:true,code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}),null);
});

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);

function fixture(notifyOriginOnCloseout=false, mergeHold=false, uncertainMergeRetryMs?:number, realSource=false) {
  const source=realSource?ownerRevisionFixture():null;
  const head=source?.oldHead??'a'.repeat(40), base=source?.planningCommit??'b'.repeat(40);
  const repoPath=source?.repo??'/repo';
  const dir=source?.root??mkdtempSync(join(tmpdir(),'ns-resolution-')), store=source?.store??new Store(join(dir,'queue.sqlite'));
  const worker=profile('author'), reviewer=profile('reviewer'), coordinator=profile('coordinator');
  store.setMeta('paused',false);
  store.setMeta('hostId','host'); // Queue #912: the one registered host
  // These fixtures exercise the coordinator closeout on a repository with no manifest;
  // the project override pins agent closeout (Spec 022's Queue closeout is the default).
  store.putRepository({origin:null,path:repoPath},'agent','fixture keeps agent closeout');
  // Spec 053: ratings, not role switches, give each role its profile. The worker
  // is the cheapest medium profile, the reviewer the next once the author is
  // excluded, and only the coordinator's lower demand reaches the low profile.
  store.setMeta('pool',[{profileId:worker.id,enabled:true,group:'author',roles:['worker'],weight:1,scopes:['general'],capability:'medium',cost:'low'},{profileId:reviewer.id,enabled:true,group:'review',roles:['reviewer'],weight:1,scopes:['general'],capability:'medium',cost:'medium'},{profileId:coordinator.id,enabled:true,group:'coordinate',roles:['coordinator'],weight:1,scopes:['general'],capability:'low',cost:'very_low'}]);
  const submitted=store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Task',repoPath,planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin',notifyOriginOnCloseout,mergeHold}),'host','handoff',base);
  const task=store.update(submitted.id,{phase:'awaiting_review',originWorkspaceId:notifyOriginOnCloseout?'origin-workspace':null,workspaceIntent:true,agentIntent:true,workspaceId:'workspace',directory:source?.workspace??'/worktree',...(source?{branch:'feature/external'}:{}),agentId:'worker',runId:'initial',profile:worker,workerModel:worker.model,prHead:head,prUrl:'https://github.com/example/repo/pull/1',agentActive:false,lastAgentStatus:'idle',lastObservedAt:new Date().toISOString(),completion:{taskId:submitted.id,runId:'initial',eventId:'initial-result',status:'ready_for_review',summary:'Ready',prNumber:1}});
  const states=new Map<string,AgentObservation>();
  const idle=(id: string, workspaceId='workspace')=>states.set(id,{id,workspaceId,status:'idle',active:false,permissions:false,error:'',provider:'test',model:states.get(id)?.model??store.runs(task.id).findLast(run=>run.agentId===id)?.profile?.model??(id==='worker'?'author':'reviewer')});
  idle('worker');idle('origin','origin-workspace');
  const tokens=new Map<string,string>(), creates:Run[]=[], sends:Run[]=[], continuations:{run:Run;messageId:string;text:string}[]=[], notices:string[]=[], prompts:string[]=[], reruns:string[][]=[];
  let merges=0,syncs=0,reviewChecks=0,currentHead=head,localHead=head,remoteHead=head;
  const adapter: Adapter & ResolutionAdapter & { hostId: string } = fakeAdapter({
    // Queue #912: origin and owner hosts resolve from the adapter; this fixture has its one host.
    hostId: 'host',
    profiles:async()=>[worker,reviewer,coordinator],validate:async()=>base,verifyWorkspace:async()=>task.branch,
    createWorkspace:async()=>{throw new Error('Review must not create workspaces')},createAgent:async()=>{throw new Error('No initial dispatch')},
    observe:async id=>{const s=states.get(id);if(!s)throw new Error('Agent missing');return s},
    agentTimelinePage:async()=>({entries:[],hasOlder:false,hasNewer:false,gap:false,staleCursor:false,reset:false,epoch:'fixture',projection:'projected',startCursor:null,endCursor:null}),
    // Round 4: verbs cancel a displaced run's live turn; the fixture agent goes idle.
    stopAgentTurn:async(id:string)=>{const s=states.get(id);if(s)states.set(id,{...s,status:'idle',active:false,permissions:false,activeTurnId:undefined} as never)},
    verifyPr:async()=>({head:currentHead,url:task.prUrl!,repository:'example/repo',headRepository:'example/repo'}),verifyPrIdentity:async()=>({head:currentHead,url:task.prUrl!,repository:'example/repo',headRepository:'example/repo'}),verifyCleanQueueWorktree:async()=>{},
    coveringEvidence:async()=>({head:currentHead,base,wait:''}),authorCommentEvidence:async()=>'',
    verifyInspectedRevisionHead:async(_task,_prNumber,expected)=>{
      if(!/^[a-f0-9]{40}$/.test(expected))throw new Error('Inspected stopped-revision recovery requires the exact 40-character inspected PR head');
      if(localHead!==expected||remoteHead!==expected||currentHead!==expected)
        throw new Error(`Inspected PR head ${expected} does not match the observed worktree ${localHead}, remote ${remoteHead} and PR ${currentHead} heads`);
    },
    createRun:async(t,r,token)=>{creates.push(r);tokens.set(r.id,token);const id=`agent-${r.id}`;states.set(id,{id,workspaceId:r.workspaceId,status:'running',active:true,permissions:false,error:''});return{id,workspaceId:r.workspaceId}},
    sendRun:async(t,r,token)=>{sends.push(r);prompts.push(runPrompt(t,r,'/helper','/ticket',true));tokens.set(r.id,token);states.set(r.agentId!,{...states.get(r.agentId!)!,active:true,status:'running'})},findRunAgents:async()=>[],
    continueRun:async(r,messageId,text)=>{continuations.push({run:r,messageId,text});states.set(r.agentId!,{...states.get(r.agentId!)!,active:true,status:'running',error:'',updatedAt:new Date(Date.now()+continuations.length).toISOString()})},
    verifyReview:async(t,r,c)=>{reviewChecks++;if(c.head!==currentHead)throw new Error('Stale PR head')},
    mergeGate:async()=>({head:currentHead,base,wait:''}),merge:async()=>{merges++},
    rerunFailedWorkflowRuns:async(_t,runIds)=>{reruns.push(runIds);return runIds},
    merged:async()=>({merged:merges>0,commit:merged,head:currentHead,base:'main'}),syncMain:async()=>{syncs++;return merged},verifyCloseout:async()=>{},notify:async(id,key,text)=>{notices.push(key)},
  });
  const engine=new Engine(store,adapter,0,()=>true,undefined,uncertainMergeRetryMs);engine.profiles=[worker,reviewer,coordinator];
  const current=()=>store.task(task.id);
  const run=()=>store.run(current().resolution.currentRunId!)!;
  /** The result lands and the engine drains; `reportStep` stops after one sweep (#346). */
  async function report(status:Completion['status'], prNumber=1, drain=true) {
    const r=run();idle(r.agentId!,r.workspaceId);
    const input:Completion={eventId:randomUUID(),taskId:task.id,runId:r.id,status,summary:status,head:r.role==='revision'&&source?currentHead:r.head,...(r.role==='reviewer'?{reviewCommentId:1,...(status==='changes_required'?{reviewResponsibility:'author' as const}:['blocked','error'].includes(status)?{reviewResponsibility:'environment' as const}:{})}:{}),...(r.role==='closeout'?{coordinatorGeneration:r.generation}:{}),...(r.role==='revision'?{prNumber}: {})};
    engine.resolution.complete(input,tokens.get(r.id)!);await (drain?engine.wake():stepEngine(engine));return input;
  }
  const step=()=>stepEngine(engine);
  const reportStep=(status:Completion['status'], prNumber=1)=>report(status,prNumber,false);
  return {store,engine,adapter,task,current,run,report,step,reportStep,states,idle,tokens,creates,sends,continuations,notices,prompts,reruns,dir,counts:()=>({merges,syncs,reviewChecks}),setHead:(h:string)=>{currentHead=source?source.pushRevision(h):h;if(source){localHead=currentHead;remoteHead=currentHead}return currentHead},setLocalHead:(h:string)=>{localHead=h},setRemoteHead:(h:string)=>{remoteHead=h},close:async()=>{await engine.stop();if(source)source.close();else{store.close();rmSync(dir,{recursive:true,force:true})}}};
}

function expireWorkspaceArchiveBackoff(f:ReturnType<typeof fixture>) {
 const current=f.current();
 if(!current.resolution.workspaceArchiveRetries.length)throw Error('Expected a workspace archive retry record');
 f.store.update(current.id,{resolution:{...current.resolution,workspaceArchiveRetries:current.resolution.workspaceArchiveRetries.map(record=>({...record,nextAttemptAt:new Date(0).toISOString()}))}});
}

function createCurrentBaseMerge(root:string){
 const directory=join(root,'proof-worktree'),remote=join(root,'proof-origin.git'),owner='docs/knowledge/owner.md',input='docs/acceptance/contract.md';
 mkdirSync(directory,{recursive:true});execFileSync('git',['init','--bare',remote]);execFileSync('git',['init','-b','main',directory]);
 const git=(...args:string[])=>execFileSync('git',args,{cwd:directory,encoding:'utf8'}).trim();
 const write=(path:string,text:string)=>{const target=join(directory,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text)};
 const commit=(message:string)=>{git('add','-A');git('commit','-m',message);return git('rev-parse','HEAD')};
 git('config','user.name','Queue Proof Test');git('config','user.email','queue-proof-test@example.test');git('remote','add','origin',remote);
 const commonOwner='# Owner\n\nPolicy remains unchanged.\n';
 write(owner,commonOwner);write(input,'Acceptance bytes remain unchanged.\n');
 const common=commit('common base');git('push','origin','main');git('checkout','-b','queue-task');
 write(owner,`${commonOwner}- Task approved fact.\n`);const reviewed=commit('reviewed content');git('push','-u','origin','queue-task');
 const incomingContent=`${commonOwner}- Incoming main fact.\n`;
 return {directory,owner,input,common,reviewed,commonOwner,incomingContent,advanceBase(){
  git('checkout','main');write('docs/knowledge/base-race.md','A later base generation.\n');const next=commit('later current base');git('push','origin','main');git('checkout','queue-task');git('fetch','origin','main');return next;
 },restoreBase(incoming:string){
  execFileSync('git',['--git-dir',remote,'update-ref','refs/heads/main',incoming],{cwd:directory});git('update-ref','refs/remotes/origin/main',incoming);
 },finish(){
  git('checkout','main');write(owner,incomingContent);write('docs/knowledge/incoming-only.md','Incoming only fact.\n');
  const incoming=commit('current main');git('push','origin','main');git('checkout','queue-task');
  try{git('merge','--no-commit','--no-ff','main')}catch{}
  const scratch=join(directory,'.proof-merge');mkdirSync(scratch);
  const paths=[join(scratch,'ours'),join(scratch,'base'),join(scratch,'theirs')];
  [reviewed,common,incoming].map(revision=>execFileSync('git',['show',`${revision}:${owner}`],{cwd:directory,encoding:'buffer'}) as Buffer)
    .forEach((value,index)=>writeFileSync(paths[index]!,value));
  let union:Buffer;
  try{union=execFileSync('git',['merge-file','--stdout','--union',...paths],{cwd:directory,encoding:'buffer'}) as Buffer}
  catch(error){if(typeof error==='object'&&error&&'status'in error&&error.status===1&&'stdout'in error)union=error.stdout as Buffer;else throw error}
  writeFileSync(join(directory,owner),union);rmSync(scratch,{recursive:true,force:true});
  git('add','-u');git('commit','-m','merge current main');const candidate=git('rev-parse','HEAD');
  git('push','origin','queue-task');git('fetch','origin','main');
  return {incoming,candidate};
 }};
}

function recordBlockedSourceApproval(f:ReturnType<typeof fixture>){
 const reviewer=f.engine.profiles.find(p=>p.id==='reviewer')!;
 const completion:Completion={eventId:'blocked-review-event',taskId:f.task.id,runId:'blocked-review-run',status:'blocked',summary:'Source approved; awaiting post-merge proof',head,
  sourceApproved:true,awaitingProofs:[{proof:'post-merge-proof',route:'external'}],reviewResponsibility:'environment'};
 const run:Run={id:'blocked-review-run',taskId:f.task.id,role:'reviewer',generation:1,head,base,agentId:'old-reviewer',workspaceId:'workspace',profile:reviewer,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:new Date().toISOString(),completion,released:true};
 f.idle('old-reviewer');
 f.store.putRun(run);
 const current=f.current();
 f.store.update(current.id,{phase:'blocked',resolution:{...current.resolution,currentRunId:null,reviewerAgentId:'old-reviewer',reviewerProfile:reviewer,review:completion}});
 return {completion,run};
}

function recordAcceptedReview(f:ReturnType<typeof fixture>,phase:Task['phase']='merging'){
 const reviewer=f.engine.profiles.find(p=>p.id==='reviewer')!;
 const completion:Completion={eventId:'accepted-review-event',taskId:f.task.id,runId:'old-review-run',status:'ready_to_merge',summary:'Original exact-head approval',head,reviewCommentId:1};
 const run:Run={id:'old-review-run',taskId:f.task.id,role:'reviewer',generation:1,head,base,agentId:'old-reviewer',workspaceId:'workspace',profile:reviewer,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:new Date().toISOString(),completion,released:true};
 f.idle('old-reviewer');
 f.store.putRun(run);
 const current=f.current();
 f.store.update(current.id,{phase,resolution:{...current.resolution,currentRunId:null,reviewerAgentId:'old-reviewer',reviewerProfile:reviewer,review:completion,
   mechanicalVerification:{at:new Date().toISOString(),head,base},integrationTurn:{sequence:1,acceptedAt:new Date().toISOString()}}});
 return {completion,run,reviewer};
}

test('verification waits and retries after a local Git status timeout without incident or launch',async()=>{
 const f=fixture();try{
  recordAcceptedReview(f,'verifying');
  f.store.update(f.task.id,{resolution:{...f.current().resolution,review:{...f.current().resolution.review!,reviewCommentId:43}}});
  let reads=0;
  f.adapter.mergeGate=async()=>{if(++reads===1)throw new GitReadTimeoutError(['status','--porcelain'],600000,{killed:true,signal:'SIGTERM'});return{head,base,wait:''}};
  await f.engine.resolution.advance(f.current());
  let current=f.current();
  assert.equal(current.phase,'verifying');assert.equal(current.resolution.attention,false);
  assert.equal(current.resolution.stop?.reason,'external_unavailable');
  assert.match(current.reason,/git status --porcelain timed out/);
  assert.equal(current.resolution.incident,null);assert.equal(f.creates.length,0);
  assert.equal(f.store.runs(current.id).some(run=>run.role==='recovery'),false);
  await f.engine.resolution.advance(current);
  current=f.current();
  assert.equal(current.phase,'merging');assert.equal(reads,2);
  assert.equal(current.resolution.mechanicalVerification?.head,head);
  assert.equal(f.creates.length,0);
 }finally{await f.close()}
});

test('merge gate waits and retries after a local Git status timeout without sending merge early',async()=>{
 const f=fixture();try{
  recordAcceptedReview(f,'merging');
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeBase:base}});
  let reads=0;
  f.adapter.mergeGate=async()=>{if(++reads===1)throw new GitReadTimeoutError(['status','--porcelain'],600000,{killed:true,signal:'SIGTERM'});return{head,base,wait:''}};
  await f.engine.resolution.advance(f.current());
  let current=f.current();
  assert.equal(current.phase,'merging');assert.equal(current.resolution.attention,false);
  assert.equal(current.resolution.stop?.reason,'external_unavailable');
  assert.match(current.reason,/git status --porcelain timed out/);
  assert.equal(current.resolution.incident,null);assert.equal(f.counts().merges,0);
  assert.equal(f.creates.length,0);
  await f.engine.resolution.advance(current);
  current=f.current();
  assert.equal(reads,2);assert.equal(f.counts().merges,1);
  assert.equal(current.resolution.mergeIntent,true);
  assert.equal(current.resolution.incident,null);assert.equal(f.creates.length,0);
 }finally{await f.close()}
});

/** The review shape `verification` needs at an exact head, recorded beside a real-source fixture task. */
function recordRealSourceAcceptedReview(f:ReturnType<typeof fixture>,acceptedHead:string){
 const reviewer=f.engine.profiles.find(p=>p.id==='reviewer')!;
 const completion:Completion={eventId:'accepted-review-event',taskId:f.task.id,runId:'old-review-run',status:'ready_to_merge',summary:'Exact-head approval',head:acceptedHead,reviewCommentId:1};
 const run:Run={id:'old-review-run',taskId:f.task.id,role:'reviewer',generation:1,head:acceptedHead,base,agentId:'old-reviewer',workspaceId:'workspace',profile:reviewer,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:new Date().toISOString(),completion,released:true};
 f.idle('old-reviewer');f.store.putRun(run);
 f.store.update(f.task.id,{prHead:acceptedHead,phase:'verifying',resolution:{...f.current().resolution,currentRunId:null,reviewerAgentId:'old-reviewer',reviewerProfile:reviewer,review:completion,
   mechanicalVerification:{at:new Date().toISOString(),head:acceptedHead,base},integrationTurn:{sequence:1,acceptedAt:new Date().toISOString()}}});
 return completion;
}
/** One sibling unfinished task of the same repository holding a recorded head. */
function insertCarryingTask(f:ReturnType<typeof fixture>,title:string,recordedHead:string){
 const wip=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title,repoPath:join(f.dir,'repo'),planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff',base);
 return f.store.update(wip.id,{phase:'working',prHead:recordedHead});
}
test('the merge gate refuses a PR carrying another unfinished task\'s recorded head, naming that task',async()=>{
 const f=fixture(false,false,undefined,true);try{
  // Task A's branch rides on the other task's WIP head: planning → head → carried.
  const wipHead=f.current().prHead!;
  const carried=f.setHead('second commit riding the carried WIP head');
  recordRealSourceAcceptedReview(f,carried);
  const wip=insertCarryingTask(f,'WIP carrier',wipHead);
  await f.engine.resolution.advance(f.current());
  const current=f.current();
  assert.equal(current.phase,'changes_requested');
  assert.equal(current.resolution.pendingRevisionCause,'pre_merge');
  assert.match(current.reason,/carries commits from unfinished task/);
  assert.ok(current.reason.includes(wip.title),current.reason);
  assert.match(current.reason,/Rebase onto main without them/);
  assert.ok(f.store.events(current.id).some(event=>event.kind==='pre_merge_refused'&&event.detail.startsWith('cross-task carry')),current.reason);
  assert.equal(f.counts().merges,0);
 }finally{await f.close()}
});
test('the merge gate refuses a partial cross-task carry and ignores a finished task\'s recorded head',async()=>{
 const f=fixture(false,false,undefined,true);try{
  const wipHead=f.current().prHead!;
  const carried=f.setHead('reviewed head beyond the shared WIP commit');
  recordRealSourceAcceptedReview(f,carried);
  // A sibling branch diverged from the same WIP commit shares that commit with A's branch.
  const carryWorkspace=join(f.dir,'carry');
  execFileSync('git',['worktree','add','-q','-b','feature/carry',carryWorkspace,wipHead],{cwd:join(f.dir,'repo')});
  writeFileSync(join(carryWorkspace,'carry.txt'),'divergent carry\n');
  const gitRun=(...args:string[])=>execFileSync('git',args,{cwd:carryWorkspace,encoding:'utf8'}).trim();
  gitRun('add','carry.txt');gitRun('commit','-m','divergent carry');
  const diverged=gitRun('rev-parse','HEAD');
  const wip=insertCarryingTask(f,'Diverged sibling',diverged);
  await f.engine.resolution.advance(f.current());
  assert.equal(f.current().phase,'changes_requested');
  assert.ok(f.current().reason.includes(wip.title),f.current().reason);
  assert.equal(f.counts().merges,0);
  // A finished task's recorded head is no longer unfinished work, so the merge proceeds.
  f.store.update(wip.id,{phase:'done'});
  f.store.update(f.task.id,{phase:'verifying',resolution:{...f.current().resolution,pendingRevisionCause:null,pendingWorkerInstruction:null,currentRunId:null,integrationTurn:{sequence:1,acceptedAt:new Date().toISOString()}}});
  await f.engine.resolution.advance(f.current());
  assert.equal(f.counts().merges,1);
 }finally{await f.close()}
});

test('operator rereview supersedes accepted evidence and reruns review at the exact head with the retained reviewer (PR 797)',async()=>{
 const f=fixture(false,true);try{
  const {completion,run}=recordAcceptedReview(f,'merging');
  const taskBefore=f.current();
  const result=await f.engine.performTaskControl({taskId:f.task.id,version:taskBefore.version,action:'move',to:'review',reason:'Approval skipped required private-server cases; run them at this head, zero skipped'});
  assert.equal(result.phase,'awaiting_review');
  assert.equal(result.prHead,head);
  assert.equal(result.held,true);assert.equal(result.mergeHold,true,'the merge hold is preserved');
  assert.equal(result.resolution.mergeIntent,false);
  assert.equal(result.resolution.review,null);assert.equal(result.resolution.mechanicalVerification,null);
  assert.equal(result.resolution.integrationTurn,null);
  const supersession=result.resolution.reviewSupersessions[0]!;
  assert.equal(supersession.reviewRunId,run.id);assert.equal(supersession.reviewCommentId,completion.reviewCommentId??null);
  assert.equal(supersession.head,head);assert.match(supersession.reason,/private-server cases/);
  assert.deepEqual(supersession.review,completion);assert.equal(supersession.verification,null);assert.ok(supersession.mechanicalVerification);
  const event=f.store.events(f.task.id).find(row=>['move_review_requested','owner_control'].includes(row.kind))!;
  assert.deepEqual({...JSON.parse(event.detail),incidentId:undefined,recoveryId:undefined},{verb:'move',to:'review',head,phaseBefore:'merging',reason:supersession.reason,retainedReviewer:'old-reviewer',incidentId:undefined,recoveryId:undefined});
  assert.deepEqual(f.store.run(run.id)?.completion,completion,'the old reviewer run remains unchanged');
  await f.engine.wake();
  const fresh=f.run();
  assert.equal(fresh.role,'reviewer');assert.equal(fresh.head,head);
  assert.equal(fresh.agentId,'old-reviewer','the retained reviewer continues the fresh round unless fresh is asked for (PR 797)');
  assert.equal(fresh.reviewReason,supersession.reason);
  assert.match(runPrompt(f.current(),fresh,'/helper','/ticket',true),/Operator-requested fresh review reason: Approval skipped required private-server cases/);
 }finally{await f.close()}
});

test('operator rereview refuses missing participants and merge intent, and settles an observed idle run',async()=>{
 const f=fixture();try{
  recordAcceptedReview(f,'verifying');
  const before=f.current();
  const active:Run={id:'active-closeout',taskId:f.task.id,role:'closeout',generation:1,head,base,agentId:'coordinator-live',workspaceId:'workspace',profile:f.engine.profiles.find(p=>p.id==='coordinator')!,status:'running',createdAt:new Date().toISOString(),lastObservedAt:null,active:true,idleSince:null,completion:null,released:false};
  f.store.putRun(active);
  // A failed lookup proves no inactivity. The same verb succeeds once the
  // participant is positively observed idle in its bound workspace.
  await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:before.version,action:'move',to:'review',reason:'Run the missing proof'}),/cannot be observed/);
  assert.deepEqual(f.current(),before);
  // Queue #912: a run records the host its task was dispatched on.
  assert.deepEqual(f.store.run(active.id),{...active,hostId:'host',hostSelection:f.store.task(f.task.id).hostSelection});
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='owner_stop_intent').length,0);
  f.idle(active.agentId!);
  const reviewed=await f.engine.performTaskControl({taskId:f.task.id,version:before.version,action:'move',to:'review',reason:'Run the missing proof'});
  assert.equal(reviewed.resolution.reviewSupersessions.length,1);
  assert.equal(f.store.run(active.id)!.released,true);
  assert.equal(f.store.run(active.id)!.status,'superseded');
  // Merge intent is a durable side effect in flight: the rereview still refuses it.
  f.store.update(f.task.id,{phase:'merging',resolution:{...f.current().resolution,mergeIntent:true}});
  const merging=f.current();
  await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:merging.version,action:'move',to:'review',reason:'Run the missing proof'}),/before merge intent/);
  assert.equal(f.current().resolution.reviewSupersessions.length,1,'the refused rereview recorded nothing');
 }finally{await f.close()}
});

test('operator rereview preflights a requested reviewer profile and binds it to the fresh run',async()=>{
 const f=fixture();try{
  recordAcceptedReview(f,'changes_requested');
  const sameModel={...profile('same-model-reviewer'),model:'author'};
  f.engine.profiles=[...f.engine.profiles,sameModel];
  f.store.setMeta('pool',[...f.store.pool(),{profileId:sameModel.id,enabled:true,group:'same-model',roles:['reviewer'],weight:1,scopes:['general']}]);
  const before=f.current();
  await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:before.version,action:'move',to:'review',reason:'Repeat the missing proof',reviewer:{profileId:sameModel.id,reason:'Please review'}}),/shares the current author's model/);
  assert.equal(f.current().version,before.version,'failed reviewer preflight leaves the task unchanged');
  const accepted=await f.engine.performTaskControl({taskId:f.task.id,version:before.version,action:'move',to:'review',reason:'Repeat the missing proof',reviewer:{profileId:'reviewer',reason:'Independent exact-head review'}});
  assert.deepEqual(accepted.profileRequests?.reviewer,{profileId:'reviewer',reason:'Independent exact-head review',required:true});
  await f.engine.wake();
  assert.equal(f.run().profile?.id,'reviewer');
  assert.equal(f.run().agentId,'old-reviewer','a requested profile rebinds the round; the retained reviewer still continues (PR 797)');
  assert.match(runPrompt(f.current(),f.run(),'/helper','/ticket',true),/Operator-requested fresh review reason: Repeat the missing proof/);
 }finally{await f.close()}
});

test('rereview control schema requires its reason and only accepts an optional reviewer request',()=>{
 const baseControl={taskId:'task',version:1,action:'move',to:'review'} as const;
 assert.equal(taskControlInputSchema.safeParse(baseControl).success,false);
 assert.ok(taskControlInputSchema.safeParse({...baseControl,reason:'Review the exact head'}).success);
 assert.ok(taskControlInputSchema.safeParse({...baseControl,reason:'Review the exact head',reviewer:{profileId:'reviewer',reason:'Use the independent profile'}}).success);
});

test('an operator merge hold lets review finish but stops the merge until release',async()=>{
 const f=fixture();try{
  // Live, 2026-09-28 (project-a #1672): pre-merge gates outside Queue (a Desktop check and a Market
  // receipt) needed a way to stop an otherwise clean merge without pausing Queue or bypassing review.
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',reason:'Test hold'});
  assert.equal(f.current().held,true);assert.ok(f.store.events(f.task.id).some(e=>e.kind==='merge_hold'));
  await f.engine.wake();assert.equal(f.run().role,'reviewer','review still runs while held');
  await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,0,'no merge while held');
  assert.equal(f.current().resolution.mergeIntent,false);
  assert.match(f.current().reason,/Merge held by operator/);
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'release'});
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='merge_release'));
  await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,1,'release lets the normal merge proceed');
  await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',reason:'Test hold'}),/only before the merge/,'no hold once merge was requested');
 }finally{await f.close()}
});
test('a submission merge hold lets review finish, then release lets the normal merge proceed',async()=>{
 const f=fixture(false,true);try{
  assert.equal(f.current().held,true,'the submission starts with the merge gate held');
  await f.engine.wake();assert.equal(f.run().role,'reviewer');
  await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,0,'review passes but a requested submission hold blocks merge');
  assert.equal(f.current().resolution.mergeIntent,false);
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'release'});
  await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,1,'release resumes the normal merge path');
 }finally{await f.close()}
});
test('review → mechanical verification → merge → main sync → coordinator closeout; no verification agent',async()=>{
 const f=fixture();try{
  let deliveredReview:unknown;
  await f.engine.wake();assert.equal(f.run().role,'reviewer');assert.equal(f.creates[0].workspaceId,'workspace');
  await f.reportStep('ready_to_merge');await f.step();
  assert.equal(f.current().phase,'merging');assert.ok(f.current().resolution.mechanicalVerification);assert.equal(f.current().resolution.currentRunId,null);assert.equal(f.creates.length,1);
  await f.step();assert.equal(f.counts().merges,1);
  await f.engine.wake();assert.equal(f.current().phase,'closing');
  await f.engine.wake();assert.equal(f.run().role,'closeout');assert.equal(f.run().workspaceId,'workspace');
  (f.engine.resolution as unknown as {hooks:{emit:(event:string,task:unknown,context:{delivery:{review:unknown}})=>Promise<{hold:boolean;attention:boolean;records:never[]}>}}).hooks={emit:async(_event,_task,context)=>{deliveredReview=context.delivery.review;return{hold:false,attention:false,records:[]}}};
  await f.report('closed');assert.equal(f.current().phase,'done');assert.equal(f.counts().syncs,1);assert.equal(f.creates.length,2);assert.equal(f.notices.length,0);
  assert.equal(deliveredReview,'ready_to_merge','agent closeout observers receive the accepted review summary after mechanical verification');
  await f.engine.wake();assert.equal(f.notices.length,0);assert.equal(f.counts().merges,1);
 }finally{await f.close()}
});
test('the report bridge accepts the same forward correction of an unreleased blocked run (round 4, papercut 4b274634)',async()=>{
 const {Reports}=await import('../core/intake/report');const f=fixture();try{
  await f.engine.wake();const run=f.run(),token=f.tokens.get(run.id)!,reports=new Reports(f.engine);
  await reports.report({eventId:randomUUID(),taskId:f.task.id,runId:run.id,status:'blocked',reviewResponsibility:'environment',summary:'Transient callback problem',head:run.head},token);
  assert.equal(f.store.run(run.id)?.completion?.status,'blocked');
  await reports.report({eventId:randomUUID(),taskId:f.task.id,runId:run.id,status:'ready_to_merge',summary:'Exact head accepted',reviewText:'No findings; exact head accepted.',head:run.head},token);
  assert.equal(f.store.run(run.id)?.completion?.status,'ready_to_merge');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='run_completion_corrected'));
  // A second blocked report is not a forward correction and stays stale.
  await assert.rejects(reports.report({eventId:randomUUID(),taskId:f.task.id,runId:run.id,status:'blocked',reviewResponsibility:'environment',summary:'Again',head:run.head},token),/Stale reporting run/);
 }finally{await f.close()}
});
test('mechanical verification completes from stored review and merge-gate evidence without a task runner',async()=>{
 const f=fixture();try{
  await f.engine.wake();await f.reportStep('ready_to_merge');await f.step();
  assert.equal(f.current().phase,'merging');
  assert.equal(f.current().resolution.review?.reviewCommentId,1);
  await f.step();
  assert.equal(f.counts().merges,1);assert.equal(f.counts().reviewChecks,1);assert.equal(f.creates.length,1);
  assert.ok(f.current().resolution.mechanicalVerification);
 }finally{await f.close()}
});
test('a retained reviewer can correct blocked to ready_to_merge before releasing its run',async()=>{
 const f=fixture();try{
  await f.engine.wake();const run=f.run(),token=f.tokens.get(run.id)!;
  f.engine.resolution.complete({eventId:'interim-block',taskId:f.task.id,runId:run.id,status:'blocked',reviewResponsibility:'environment',summary:'Transient callback problem',head:run.head},token);
  assert.equal(f.store.run(run.id)?.completion?.status,'blocked');
  f.engine.resolution.complete({eventId:'final-review',taskId:f.task.id,runId:run.id,status:'ready_to_merge',summary:'Exact head accepted',head:run.head,reviewCommentId:97},token);
  assert.equal(f.store.run(run.id)?.completion?.status,'ready_to_merge');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='run_completion_corrected'));
  f.idle(run.agentId!,run.workspaceId);await f.step();
  assert.equal(f.current().phase,'verifying');assert.equal(f.current().resolution.review?.reviewCommentId,97);
 }finally{await f.close()}
});
test('applied ordinary review retains its reader across the next exact-head round',async()=>{
 const f=fixture(false,false,undefined,true);try{
  const archived=new Set<string>(),calls:string[]=[];
  f.adapter.originAgent=async id=>({id,workspaceId:'workspace',title:'reviewer',archived:archived.has(id)});
  f.adapter.archiveAgent=async id=>{calls.push(id);archived.add(id)};
  await f.engine.wake();const first=f.run();
  await f.report('changes_required');
  assert.deepEqual(calls,[]);
  assert.equal(f.current().resolution.reviewerAgentId,first.agentId);
  assert.equal(f.current().resolution.reviewerProfile?.id,'reviewer');
  assert.equal(f.current().agentId,'worker');
  await f.engine.wake();assert.equal(f.run().role,'revision');
  f.setHead('d'.repeat(40));await f.report('ready_for_review');
  await f.engine.wake();assert.equal(f.run().role,'reviewer');
  assert.equal(f.run().agentId,first.agentId);
 }finally{await f.close()}
});
test('a released authenticated revision result resumes from an escalated attention projection',async()=>{
 const f=fixture();try{
  const revisionHead='d'.repeat(40),runId='late-revision';
  const completion:Completion={eventId:'late-revision-result',taskId:f.task.id,runId,status:'ready_for_review',summary:'Revised exact head',prNumber:1,head:revisionHead};
  f.setHead(revisionHead);f.idle('late-worker');
  f.store.putRun({id:runId,taskId:f.task.id,role:'revision',generation:1,head,base,agentId:'late-worker',workspaceId:'workspace',profile:profile('late-worker'),status:'finished',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:new Date().toISOString(),completion,released:true});
  f.store.update(f.task.id,{
   phase:'needs_attention',reason:'The revision callback reminder expired',
   resolution:{...f.current().resolution,currentRunId:runId,attention:true,
    incident:{id:'incident',role:'worker',runId,fingerprint:'incident',attempt:0,cause:'uncertain_delivery',detail:'No callback',action:'',status:'escalated',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},
    recovery:{id:'recovery',key:'recovery',generation:1,runId:null,agentId:null,status:'escalated',summary:'No callback',idleSince:null,incidentId:'incident'},recoveryActive:false},
  });
  await f.engine.wake();
  assert.equal(f.current().phase,'reviewing');
  assert.equal(f.current().completion?.head,revisionHead);
  assert.equal(f.current().prHead,revisionHead);
  assert.equal(f.run().role,'reviewer');
  assert.equal(f.current().resolution.incident?.status,'resolved');
  assert.equal(f.current().resolution.recovery,null);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='released_result_recovered'));
 }finally{await f.close()}
});
test('an escalated stalled reviewer result resumes publication and returns to author once',async()=>{
 const f=fixture();try{
  await f.engine.wake();const run=f.run(),token=f.tokens.get(run.id)!;
  const at=new Date().toISOString();
  f.store.update(f.task.id,{resolution:{...f.current().resolution,attention:true,
   incident:{id:'stall',role:'reviewer',runId:run.id,fingerprint:'stall',attempt:0,cause:'stalled_turn',detail:'stalled',action:'',status:'escalated',createdAt:at,updatedAt:at},
   recovery:{id:'recovery',key:'recovery',generation:1,runId:null,agentId:null,status:'escalated',summary:'unavailable',idleSince:null,incidentId:'stall'},recoveryActive:false}});
  let publications=0,verifications=0;f.adapter.publishReview=async()=>{publications++;return 1};
  f.adapter.verifyReview=async()=>{verifications++;if(verifications===1)f.store.setMeta('paused',true)};
  const result:Completion={eventId:'late-review',taskId:f.task.id,runId:run.id,status:'changes_required',reviewResponsibility:'author',summary:'Fix the defect',head:run.head,reviewText:'Fix the defect'};
  assert.throws(()=>f.engine.resolution.complete(result,'wrong-token'));
  f.engine.resolution.complete(result,token);f.idle(run.agentId!,run.workspaceId);
  await f.engine.stop();
  const restarted=new Engine(f.store,f.adapter,0,()=>true);restarted.profiles=f.engine.profiles;
  try { await stepEngine(restarted);await stepEngine(restarted); } finally { await restarted.stop(); }
  assert.equal(publications,1);
  assert.equal(f.store.run(run.id)?.completion?.reviewCommentId,1);
  // Pause still applies the stored result; it starts no revision.
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='review_result_applied'&&event.detail===run.id).length,1);
  assert.equal(f.current().phase,'changes_requested');
  assert.equal(f.current().resolution.review?.eventId,result.eventId);
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='revision').length,0);
  f.store.setMeta('paused',false);
  const afterPublication=new Engine(f.store,f.adapter,0,()=>true);afterPublication.profiles=f.engine.profiles;
  try { await stepEngine(afterPublication); } finally { await afterPublication.stop(); }
  assert.equal(publications,1);assert.equal(verifications,1);
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='review_result_applied'&&event.detail===run.id).length,1);
  const resumed=new Engine(f.store,f.adapter,0,()=>true);resumed.profiles=f.engine.profiles;
  try { await resumed.wake(); } finally { await resumed.stop(); }
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='review_result_applied'&&event.detail===run.id).length,1);
  assert.equal(f.run().role,'revision');
  assert.equal(f.current().resolution.revisionRuns,1);
 }finally{await f.close()}
});
test('stalled reviewer recovery refuses stale and conflicting publication evidence',async()=>{
 for(const failure of ['stale','conflict'] as const){
  const f=fixture();try{
   await f.engine.wake();const run=f.run(),at=new Date().toISOString();
   f.store.update(f.task.id,{resolution:{...f.current().resolution,attention:true,
    incident:{id:'stall',role:'reviewer',runId:run.id,fingerprint:'stall',attempt:0,cause:'stalled_turn',detail:'stalled',action:'',status:'escalated',createdAt:at,updatedAt:at},
    recovery:{id:'recovery',key:'recovery',generation:1,runId:null,agentId:null,status:'escalated',summary:'unavailable',idleSince:null,incidentId:'stall'},recoveryActive:false}});
   if(failure==='stale')f.setHead('d'.repeat(40));
   else f.adapter.verifyReview=async()=>{throw Error('Conflicting publication')};
   f.engine.resolution.complete({eventId:`late-${failure}`,taskId:f.task.id,runId:run.id,status:'changes_required',reviewResponsibility:'author',summary:'Fix',head:run.head,reviewCommentId:1},f.tokens.get(run.id)!);
   f.idle(run.agentId!,run.workspaceId);await f.engine.wake();
   assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='review_result_applied'&&event.detail===run.id).length,0);
   assert.notEqual(f.current().phase,'changes_requested');
   assert.equal(f.current().resolution.revisionRuns,0);
  }finally{await f.close()}
 }
});
test('review verification persists a uniquely reconciled durable comment ID',async()=>{
 const f=fixture();try{
  f.adapter.verifyReview=async()=>98;
  await f.engine.wake();const reviewRun=f.run();
  await f.report('changes_required');
  assert.equal(f.current().phase,'changes_requested');
  assert.equal(f.current().resolution.review?.reviewCommentId,98);
  assert.equal(f.store.run(reviewRun.id)?.completion?.reviewCommentId,98);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='review_reconciled'&&event.detail==='PR comment 98'));
 }finally{await f.close()}
});
test('missing verification evidence blocks promptly without merge, a run, or validation work',async()=>{
 const f=fixture();try{
  // Mechanical: missing review evidence fails fast and creates no verification run.
  await f.engine.wake();await f.reportStep('ready_to_merge');
  f.store.update(f.task.id,{resolution:{...f.current().resolution,review:null}});
  await f.step();assert.equal(f.current().phase,'verifying');
  await f.engine.wake();assert.equal(f.current().resolution.attention,true);assert.equal(f.counts().merges,0);assert.equal(f.creates.length,1);
 }finally{await f.close()}
});
test('changes return to the same worker and re-review resumes the same reviewer',async()=>{
 const f=fixture(false,false,undefined,true);try{
  await f.engine.wake();const reviewer=f.run().agentId;
  await f.report('changes_required');await f.engine.wake();assert.equal(f.run().role,'revision');assert.equal(f.run().agentId,'worker');
  f.setHead('d'.repeat(40));await f.report('ready_for_review');await f.engine.wake();assert.equal(f.run().role,'reviewer');assert.equal(f.run().agentId,reviewer);assert.equal(f.creates.length,1);
 }finally{await f.close()}
});
test('re-review replaces a closed reviewer while preserving the ordinary source workspace',async()=>{
 const f=fixture(false,false,undefined,true);try{
  await f.engine.wake();const reviewer=f.run().agentId!;
  await f.report('changes_required');await f.engine.wake();assert.equal(f.run().role,'revision');
  f.states.set(reviewer,{id:reviewer,workspaceId:'workspace',status:'closed',active:false,permissions:false,error:''});
  f.setHead('d'.repeat(40));await f.report('ready_for_review');await f.engine.wake();
  assert.equal(f.run().role,'reviewer');assert.notEqual(f.run().agentId,reviewer);
  assert.equal(f.sends.filter(r=>r.role==='reviewer').length,0);assert.equal(f.creates.length,2);
 }finally{await f.close()}
});
test('re-review replaces a retained reviewer whose profile or subscription became unavailable',async()=>{
 const cases=['disabled','catalog','subscription'] as const;
 for(const unavailable of cases){
  const f=fixture(false,false,undefined,true);try{
   await f.engine.wake();const old=f.run();
   await f.report('changes_required');await f.engine.wake();assert.equal(f.run().role,'revision');
   const backup=profile(`review-backup-${unavailable}`);f.engine.profiles.push(backup);
   f.store.setMeta('pool',[...f.store.pool(),{profileId:backup.id,enabled:true,roles:['reviewer'],group:`review-backup-${unavailable}`,weight:1,scopes:['general']}]);
   if(unavailable==='disabled')f.store.setMeta('pool',f.store.pool().map(p=>p.profileId==='reviewer'?{...p,enabled:false}:p));
   if(unavailable==='catalog')f.engine.profiles[1]={...f.engine.profiles[1],available:false,problem:'provider disabled'};
   if(unavailable==='subscription')f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('review',JSON.stringify({group:'review',unavailable:true,reason:'credit exhausted',retryAt:null}));
   f.setHead('d'.repeat(40));await f.report('ready_for_review');await f.engine.wake();
   assert.equal(f.run().role,'reviewer');assert.equal(f.run().profile?.id,backup.id);assert.notEqual(f.run().agentId,old.agentId);
   assert.equal(f.run().workspaceId,old.workspaceId);assert.equal(f.current().resolution.roleReplacements,1);
   assert.equal(f.sends.filter(r=>r.role==='reviewer').length,0);assert.equal(f.creates.length,2);
  }finally{await f.close()}
 }
});
test('re-review waits rather than resuming an unavailable reviewer when no replacement is eligible',async()=>{
 const f=fixture();try{
  await f.engine.wake();const old=f.run();
  await f.report('changes_required');await f.engine.wake();
  f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('review',JSON.stringify({group:'review',unavailable:true,reason:'credit exhausted',retryAt:null}));
  // Spec 053: every profile can review, so the coordinator profile is out too.
  f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('coordinate',JSON.stringify({group:'coordinate',unavailable:true,reason:'credit exhausted',retryAt:null}));
  f.setHead('d'.repeat(40));await f.report('ready_for_review');await f.engine.wake();
  assert.equal(f.current().phase,'awaiting_review');assert.match(f.current().reason,/Retained reviewer is unavailable/);
  assert.equal(f.current().resolution.currentRunId,null);assert.equal(f.current().resolution.reviewerAgentId,old.agentId);
  assert.equal(f.sends.filter(r=>r.role==='reviewer').length,0);assert.equal(f.creates.length,1);
 }finally{await f.close()}
});
test('a stopped callback-free reviewer is replaced when its stored subscription pause is still active',async()=>{
 const f=fixture();try{
  await f.engine.wake();const old=f.run(),backup=profile('review-backup');
  f.engine.profiles.push(backup);
  f.store.setMeta('pool',[...f.store.pool(),{profileId:backup.id,enabled:true,roles:['reviewer'],group:'review-backup',weight:1,scopes:['general']}]);
  f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('review',JSON.stringify({group:'review',unavailable:true,reason:'disabled by operator',retryAt:null}));
  f.idle(old.agentId!,old.workspaceId);
  await f.engine.resolution.observe();
  assert.equal(f.store.run(old.id)?.status,'superseded');assert.equal(f.store.run(old.id)?.released,true);
  assert.equal(f.current().phase,'awaiting_review');assert.equal(f.current().resolution.reviewerAgentId,null);
  await f.engine.wake();
  assert.equal(f.run().role,'reviewer');assert.equal(f.run().profile?.id,backup.id);assert.equal(f.run().workspaceId,old.workspaceId);
  assert.equal(f.run().head,old.head);assert.equal(f.current().resolution.roleReplacements,1);
 }finally{await f.close()}
});
test('retry promotes an accepted revision callback stranded behind stale task completion',async()=>{
 const f=fixture(false,false,undefined,true);try{
  await f.engine.wake();const reviewer=f.run().agentId;
  await f.report('changes_required');await f.engine.wake();const revision=f.run();
  const revisedHead=f.setHead('d'.repeat(40));f.idle(revision.agentId!,revision.workspaceId);
  const completion:Completion={eventId:'accepted-revision',taskId:f.task.id,runId:revision.id,status:'ready_for_review',summary:'Round two complete',head:revisedHead,prNumber:1};
  f.engine.resolution.complete(completion,f.tokens.get(revision.id)!);await f.engine.resolution.observe();
  f.store.update(f.task.id,{phase:'needs_attention',reason:'PR head changed after the completion callback',resolution:{...f.current().resolution,attention:false}});

  const retry=f.engine.resolution.retry(f.current());
  assert.equal(retry.phase,'changes_requested');assert.equal(retry.resolution.currentRunId,revision.id);
  await f.engine.wake();assert.equal(f.current().phase,'reviewing');assert.equal(f.current().completion?.runId,revision.id);assert.equal(f.current().prHead,revisedHead);
  await f.engine.wake();assert.equal(f.run().role,'reviewer');assert.equal(f.run().agentId,reviewer);assert.equal(f.run().head,revisedHead);
  assert.equal(f.sends.filter(r=>r.role==='revision').length,1);
 }finally{await f.close()}
});
test('operator retry re-enters pre-merge from a hook-held revision without discarding accepted review',async()=>{
 const f=fixture();try{
  const blocked:Completion={eventId:'hook-blocked',taskId:f.task.id,runId:'revision-blocked',status:'blocked',summary:'Hook runtime rejected its pinned manifest',head};
  f.store.putRun({id:'revision-blocked',taskId:f.task.id,role:'revision',generation:1,head,base,agentId:'worker',workspaceId:'workspace',profile:f.current().profile,profileGroup:null,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:null,completion:blocked,released:true});
  f.store.update(f.task.id,{phase:'changes_requested',reason:'Repository hook lifecycle-state task.blocked holds this transition: unsupported schema',resolution:{...f.current().resolution,currentRunId:'revision-blocked',review:{eventId:'review',taskId:f.task.id,runId:'reviewer',status:'ready_to_merge',summary:'Accepted exact head',head,reviewCommentId:42}}});
  const retry=f.engine.resolution.retry(f.current(),false,undefined,true);
  assert.equal(retry.phase,'verifying');assert.equal(retry.resolution.currentRunId,null);assert.equal(retry.resolution.review?.status,'ready_to_merge');
  assert.equal(retry.prHead,head);assert.match(retry.reason,/pre-merge re-evaluation/);
 }finally{await f.close()}
});
test('a revision reaches a worker whose own unfinished revision left the worktree dirty',async()=>{
 const f=fixture();try{
  await f.engine.wake();
  // The previous revision died mid-way; its WIP made the ready-for-review proof refuse every revision launch.
  f.adapter.verifyPr=async()=>{throw Error('Worker must leave a clean worktree before review')};
  let identity=0,resume=0,allowDraft=false;
  f.adapter.verifyPrIdentity=async(_task,_number,options)=>{identity++;allowDraft=options?.allowDraft===true;return{head,url:f.task.prUrl!}};
  f.adapter.verifyResume=async()=>{resume++};
  await f.report('changes_required');
  assert.equal(f.run().role,'revision');assert.equal(f.run().agentId,'worker');
  assert.equal(identity,1);assert.equal(allowDraft,true);assert.equal(resume,1);
  assert.doesNotMatch(f.current().reason,/clean worktree/);
  const reviewersBeforeDirtyRevisionReport=f.store.runs(f.task.id).filter(run=>run.role==='reviewer').length;
  // A reviewer still needs the exact clean head.
  await f.report('ready_for_review');
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'responsible_pr_report_refused'),
    'the dirty checkout refusal remains recorded while the revision thread runs');
  assert.equal(f.store.runs(f.task.id).filter(run => run.role === 'reviewer').length, reviewersBeforeDirtyRevisionReport,
    'the dirty revision report does not start another reviewer');
 }finally{await f.close()}
});
test('revision resumes a released closed worker without creating a duplicate lane',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{phase:'changes_requested',reason:'Rebase the existing PR'});
  f.states.set('worker',{id:'worker',workspaceId:'workspace',status:'closed',active:false,permissions:false,error:''});
  await f.engine.wake();
  assert.equal(f.run().role,'revision');assert.equal(f.run().agentId,'worker');assert.equal(f.run().workspaceId,'workspace');
  assert.equal(f.sends.length,1);assert.equal(f.creates.length,0);assert.equal(f.current().completion?.prNumber,1);
 }finally{await f.close()}
});
test('revision wait reason names the observed retained-thread blocker without dispatching',async()=>{
 // nucleus#1100: the decline names the participant that still owns work, and
 // the verbs that exit the wait, around the observed blocker it always named.
 const cases:[string,AgentObservation,RegExp[]][]=[
  ['pending question',{id:'worker',workspaceId:'workspace',status:'idle',active:false,permissions:true,error:'',pendingRequest:{id:'question-42',kind:'question',firstLine:'Which API contract should I follow?'}},[/Assigned thread has pending question question-42: Which API contract should I follow\?/,/retained worker \(agent worker\) still owns its turn/,/restart or route with now/]],
  ['active turn',{id:'worker',workspaceId:'workspace',status:'running',active:true,permissions:false,error:'',activeTurnId:'turn-42'},[/Assigned thread has active turn turn-42/,/retained worker \(agent worker\) still owns its turn/,/restart or route with now/]],
  ['non-resumable status',{id:'worker',workspaceId:'workspace',status:'error',active:false,permissions:false,error:''},[/^Assigned thread is not resumable \(error\)$/]],
 ];
 for(const [label,observation,expected] of cases){
  const f=fixture();try{
   f.states.set('worker',observation);
   f.store.update(f.task.id,{phase:'changes_requested',reason:'Apply review fixes'});
   await f.engine.resolution.launch(f.current(),'revision');
   assert.equal(f.current().phase,'changes_requested',label);
   for(const pattern of expected)assert.match(f.current().reason,pattern,label);
   assert.equal(f.store.runs(f.task.id).some(run=>run.role==='revision'),false,label);
   assert.equal(f.sends.some(run=>run.role==='revision'),false,label);
  }finally{await f.close()}
 }
});
test('two concurrent revision launches record exactly one run on the retained thread',async()=>{
 const f=fixture();try{
  await f.engine.wake();await f.report('changes_required');
  // g05.186: two wakes both passed the busy-thread check while observe was in flight.
  const observe=f.adapter.observe;let release!:()=>void;const gate=new Promise<void>(r=>{release=r});let waiting=0;
  f.adapter.observe=async id=>{if(id==='worker'){waiting++;await gate;}return observe(id)};
  const task=f.current();
  const both=Promise.all([f.engine.resolution.launch(task,'revision'),f.engine.resolution.launch(task,'revision')]);
  while(waiting<2)await new Promise(r=>setImmediate(r));
  release();await both;
  const revisions=f.store.runs(f.task.id).filter(r=>r.role==='revision');
  assert.equal(revisions.length,1,'the second reservation sees the first and records nothing');
  assert.equal(f.current().resolution.currentRunId,revisions[0].id);
 }finally{await f.close()}
});

test('responsible non-delivery gets one retained pushback, one same-capability provider, then stops auto-routing',async()=>{
 const f=fixture();try{
  const alternate:Profile={id:'alternate',name:'Alternate',provider:'other-provider',model:'other-model',notes:'',available:true,problem:'',supportedThinking:[]};
  const frontier:Profile={id:'0-frontier',name:'Frontier',provider:'frontier-provider',model:'frontier-model',notes:'',available:true,problem:'',supportedThinking:[]};
  f.engine.profiles=[...f.engine.profiles,alternate,frontier];
  const pool=f.store.pool();f.store.setMeta('pool',[...pool,
   {profileId:alternate.id,enabled:true,group:'alternate',roles:['worker'],weight:1,scopes:['general'],capability:'medium',cost:'low'},
   {profileId:frontier.id,enabled:true,group:'frontier',roles:['worker'],weight:1,scopes:['general'],capability:'medium',cost:'very_high'}]);
  f.store.setMeta('usageLevel',{level:'maximum',until:null,setAt:new Date().toISOString()});
  f.adapter.verifyResume=async()=>{};
  const record=(id:string,workerProfile:Profile,attempt:number)=>{
   const completion:Completion={eventId:`blocked-${attempt}`,taskId:f.task.id,runId:id,status:'blocked',summary:'No external blocker and no change',head};
   const run:Run={id,taskId:f.task.id,role:'revision',generation:1,head,base,agentId:workerProfile.id==='alternate'?'alternate-agent':'worker',workspaceId:'workspace',profile:workerProfile,status:'finished',createdAt:new Date(Date.now()+attempt).toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:new Date().toISOString(),completion,released:true,revisionCause:'non_delivery'};
   f.store.putRun(run);f.store.event(f.task.id,'non_delivery',JSON.stringify({runId:id,attempt,role:'revision',status:'blocked',provider:workerProfile.provider,model:workerProfile.model,baselineHead:head,observedHead:head}));
   const current=f.current();f.store.update(current.id,{phase:'blocked',reason:completion.summary,responsible:true,agentId:run.agentId,profile:workerProfile,runId:id,resolution:{...current.resolution,currentRunId:id}});
  };
  const authorProfile=f.engine.profiles.find(item=>item.id==='author')!;
  record('first-non-delivery',authorProfile,1);await f.engine.resolution.advance(f.current());
  assert.equal(f.current().phase,'changes_requested');assert.equal(f.current().resolution.pendingRevisionCause,'non_delivery');
  assert.equal(f.current().resolution.nonDeliveryRoutePending,false);
  await f.engine.resolution.launch(f.current(),'revision');
  const retained=f.store.run(f.current().resolution.currentRunId!)!;
  assert.equal(retained.agentId,'worker');assert.equal(retained.profile?.id,'author');
  assert.match(retained.instruction??'',/You reported no external blocker and produced no change/);
  f.idle('worker');f.store.putRun({...retained,status:'finished',released:true,completion:{eventId:'settled-first-pushback',taskId:f.task.id,runId:retained.id,status:'blocked',summary:'Second attempt returned',head}});
  record('second-non-delivery',authorProfile,2);assert.equal(consecutiveNonDeliveries(f.store.eventsAll(f.task.id)).length,2);await f.engine.resolution.advance(f.current());
  assert.equal(f.current().phase,'changes_requested',JSON.stringify({currentRunId:f.current().resolution.currentRunId,reason:f.current().reason,events:f.store.eventsAll(f.task.id).map(event=>[event.kind,event.detail])}));assert.equal(f.current().resolution.nonDeliveryRoutePending,true);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,reviewerAgentId:'retained-reviewer',reviewerProfile:profile('reviewer')}});
  await f.engine.resolution.launch(f.current(),'revision');
  const routed=f.store.run(f.current().resolution.currentRunId!)!;
  assert.equal(routed.profile?.id,'alternate');assert.equal(f.current().profile?.id,'alternate');
  assert.equal(f.current().resolution.reviewerAgentId,'retained-reviewer');
  assert.equal(f.current().retiredWorkers.at(-1)?.agentId,'worker');
  f.store.update(f.task.id,{resolution:{...f.current().resolution,reviewerAgentId:null,reviewerProfile:null}});
  record('third-non-delivery',alternate,3);await f.engine.resolution.advance(f.current());
  assert.equal(f.current().phase,'blocked');assert.equal(f.current().resolution.nonDeliveryRoutePending,false);
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='non_delivery_provider_routed').length,1);
 }finally{await f.close()}
});

test('a pending non-delivery replacement with no eligible provider escalates once to the planner',async()=>{
 const f=fixture();try{
  const current=f.current();
  f.store.update(current.id,{phase:'changes_requested',reason:'Non-delivery replacement pending',resolution:{...current.resolution,
   currentRunId:null,pendingRevisionCause:'non_delivery',pendingWorkerInstruction:'Continue after non-delivery',nonDeliveryRoutePending:true}});
  await f.engine.resolution.launch(f.current(),'revision');
  const escalations=()=>f.store.eventsAll(f.task.id).filter(event=>event.kind==='planner_escalation');
  assert.equal(escalations().length,1);
  assert.equal(f.current().phase,'needs_attention');
  assert.match(f.current().reason,/Waiting with the planner: blocker escalation/);
  await f.engine.resolution.launch(f.current(),'revision');
  assert.equal(escalations().length,1,'reconciliation does not create a second escalation');
 }finally{await f.close()}
});

test('an owner worker restart supersedes a pending non-delivery replacement and resumes the retained worker',async()=>{
 const f=fixture();try{
  const current=f.current();
  f.store.update(current.id,{phase:'blocked',reason:'Pending non-delivery replacement',agentId:'worker',prUrl:'https://github.com/example/repo/pull/1',prHead:head,resumePrNumber:1,completion:{eventId:'blocked-owner-restart',taskId:current.id,runId:'initial',status:'blocked',summary:'External wait resolved by owner',head,prNumber:1},
   resolution:{...current.resolution,currentRunId:null,pendingRevisionCause:'non_delivery',pendingWorkerInstruction:'Do not replace me',nonDeliveryRoutePending:true}});
  const result=await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:current.id,version:f.current().version,action:'restart',role:'worker',reason:'Resume the retained worker'}));
  assert.equal(result.resolution.nonDeliveryRoutePending,false);
  assert.equal(result.resolution.pendingRevisionCause,null);
  assert.ok(f.store.eventsAll(current.id).some(event=>event.kind==='non_delivery_replacement_superseded'&&event.detail.includes('Resume the retained worker')));
  await f.engine.resolution.launch(f.current(),'revision');
  const resumed=f.store.run(f.current().resolution.currentRunId!)!;
  assert.equal(resumed.role,'revision');assert.equal(resumed.agentId,'worker');
  assert.equal(resumed.profile?.id,'author');
  assert.equal(resumed.instruction,'Do not replace me','the retained continuation survives the supersession');
 }finally{await f.close()}
});
/** A pre-PR continuation whose first `verifyResume` waits on `gate` and then runs `first`. */
function gatedPrePrContinuation(f:ReturnType<typeof fixture>,first:()=>string){
 const current=f.current();
 f.store.update(current.id,{phase:'changes_requested',reason:'Owner requested a pre-PR continuation',prHead:null,prUrl:null,resumePrNumber:null,completion:{eventId:'blocked-result',taskId:current.id,runId:'initial',status:'blocked',summary:'Owner resolved the blocker',head:base},resolution:{...current.resolution,prePrResumeInstruction:'Continue approved scope',pendingWorkerInstruction:'Continue approved scope',currentRunId:null,attention:false}});
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r}),inside=new Promise<void>(r=>{entered=r});let checks=0;
 f.adapter.verifyResume=async()=>{checks++;if(checks===1){entered();await gate;return first();}return base};
 return {release,inside,checks:()=>checks};
}
for(const [label,first] of [
 ['a resolved verification that sees the newer run',()=>base],
 ['a delayed rejected preflight',()=>{throw new Error('Retained worktree verification failed: dirty index')}],
] as const)test(`a superseded pre-PR attempt (${label}) cannot fault the newer running continuation`,async()=>{
 const f=fixture();const g=gatedPrePrContinuation(f,first);
 try{
  enableRecovery(f);
  const old=f.engine.resolution.advance(f.current());await g.inside;
  await f.engine.resolution.advance(f.current());
  const run=f.store.run(f.current().resolution.currentRunId!)!;
  assert.equal(run.status,'running');assert.equal(f.sends.length,1);
  g.release();await old;
  const after=f.current();
  assert.equal(after.resolution.currentRunId,run.id);
  assert.equal(after.resolution.attention,false,'the superseded attempt raises no attention on the newer run');
  assert.equal(after.resolution.incident,null);assert.equal(after.resolution.stop,null);
  assert.equal(after.reason,'revision thread running');assert.equal(after.phase,'changes_requested');
  // The failure stays inspectable as the old attempt's history, never as the newer run's fault.
  const history=f.store.events(after.id).filter(e=>e.kind==='superseded_attempt_failure').map(e=>JSON.parse(e.detail));
  assert.equal(history.length,1);
  assert.deepEqual({observed:history[0].observedRunId,by:history[0].supersededBy,current:history[0].currentRunId},{observed:null,by:run.id,current:run.id});
  assert.match(history[0].error,label.startsWith('a delayed')?/dirty index/:/Task changed during pre-PR continuation verification/);
  assert.equal(f.store.events(after.id).some(e=>e.kind==='needs_attention'||e.kind==='incident'),false);
  const next=ownerTaskNext(collectOwnerVerbFacts(f.store,after));
  assert.equal(next.attention,false);assert.equal(next.reason,'revision thread running');
  assert.equal(next.activeRun?.runId,run.id);assert.equal(next.activeRun?.status,'running');
  assert.ok(!['attention','incident','recovery'].includes(next.stop?.kind??''),`stop ${next.stop?.kind}`);
  assert.equal(taskDetailView(after).resolution.attention,false);
  // Repeated reconciliation neither re-delivers nor spends a coordinator on the obsolete error.
  await f.engine.wake();await f.engine.resolution.advance(f.current());
  assert.equal(f.sends.length,1);assert.equal(f.store.runs(f.task.id).filter(r=>r.role==='revision').length,1);
  assert.equal(f.store.runs(f.task.id).some(r=>r.role==='recovery'),false);
  assert.equal(f.current().resolution.attention,false);assert.equal(f.current().resolution.currentRunId,run.id);
 }finally{g.release();await f.close()}
});
test('a superseded pre-PR attempt stays history after its successor already completed',async()=>{
 const f=fixture();const g=gatedPrePrContinuation(f,()=>base);
 try{
  const old=f.engine.resolution.advance(f.current());await g.inside;
  await f.engine.resolution.advance(f.current());const run=f.run();f.setHead(base);
  // A dispatch hold keeps the next reviewer pending, so the completed successor leaves no current run.
  const t=f.current();await f.engine.performTaskControl({taskId:t.id,version:t.version,action:'hold',kind:'dispatch',reason:'Keep the next review pending'});
  await f.reportStep('ready_for_review');
  const before=f.current();
  assert.equal(before.resolution.currentRunId,null);assert.equal(before.phase,'awaiting_review');assert.equal(before.resolution.attention,false);
  g.release();await old;
  const after=f.current();
  assert.equal(after.resolution.attention,false);assert.equal(after.reason,before.reason);assert.equal(after.phase,'awaiting_review');
  assert.deepEqual(after.resolution.incident,before.resolution.incident);
  const history=f.store.events(after.id).filter(e=>e.kind==='superseded_attempt_failure').map(e=>JSON.parse(e.detail));
  assert.equal(history.length,1);
  assert.deepEqual({observed:history[0].observedRunId,by:history[0].supersededBy,current:history[0].currentRunId},{observed:null,by:run.id,current:null});
  assert.match(history[0].error,/Task changed during pre-PR continuation verification/);
 }finally{g.release();await f.close()}
});
test('a superseded login-session preflight leaves the running successor its own reason and stop',async()=>{
 const f=fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r}),inside=new Promise<void>(r=>{entered=r});let checks=0;
 const t=f.current();f.store.update(t.id,{phase:'changes_requested',reason:'Revision requested',resolution:{...t.resolution,pendingWorkerInstruction:'Address the findings'}});
 f.adapter.verifyResume=async()=>base;
 f.adapter.verifyPrIdentity=async()=>{if(++checks===1){entered();await gate;throw new LoginSessionFaultError(new Error('OSStatus -26276'))}return {head,url:f.task.prUrl!}};
 try{
  const old=f.engine.resolution.advance(f.current());await inside;
  await f.engine.resolution.advance(f.current());const run=f.run();
  assert.equal(run.status,'running');assert.equal(f.sends.length,1);assert.equal(f.current().reason,'revision thread running');
  release();await old;
  const after=f.current();
  assert.equal(after.reason,'revision thread running');assert.equal(after.resolution.stop,null);assert.equal(after.resolution.attention,false);
  assert.equal(f.store.events(after.id).some(e=>e.kind==='environment_deferred'),false);
  const history=f.store.events(after.id).filter(e=>e.kind==='superseded_attempt_failure').map(e=>JSON.parse(e.detail));
  assert.equal(history.length,1);assert.equal(history[0].supersededBy,run.id);assert.match(history[0].error,/OSStatus -26276/);
 }finally{release();await f.close()}
});
test('the current attempt\'s login-session preflight still defers the task as an environment fault',async()=>{
 const f=fixture();
 try{
  const t=f.current();f.store.update(t.id,{phase:'changes_requested',reason:'Revision requested',resolution:{...t.resolution,pendingWorkerInstruction:'Address the findings'}});
  f.adapter.verifyResume=async()=>base;
  f.adapter.verifyPrIdentity=async()=>{throw new LoginSessionFaultError(new Error('OSStatus -26276'))};
  await f.engine.resolution.advance(f.current());
  const after=f.current();
  assert.match(after.reason,/^Host login session is gone/);assert.equal(after.resolution.stop?.reason,'external_unavailable');
  assert.equal(f.sends.length,0);
  assert.equal(f.store.events(after.id).some(e=>e.kind==='superseded_attempt_failure'),false);
 }finally{await f.close()}
});
test('the current pre-PR attempt still parks on its own verification or identity failure',async()=>{
 for(const [label,act,cause] of [
  ['rejected verification',(_f:ReturnType<typeof fixture>)=>{throw new Error('Retained worktree verification failed: dirty index')},/dirty index/],
  ['metadata-only change',(f:ReturnType<typeof fixture>)=>{f.store.update(f.task.id,{title:'Retitled during verification'});throw new Error('Retained worktree verification failed: dirty index')},/dirty index/],
  ['changed identity',(f:ReturnType<typeof fixture>)=>{f.store.update(f.task.id,{branch:'ns-other'});return base},/Task changed during pre-PR continuation verification/],
 ] as const){
  const f=fixture();let g!:ReturnType<typeof gatedPrePrContinuation>;g=gatedPrePrContinuation(f,()=>act(f));
  try{
   const attempt=f.engine.resolution.advance(f.current());await g.inside;
   const version=f.current().version;g.release();await attempt;
   const after=f.current();
   assert.ok(after.version>version,label);
   assert.equal(after.resolution.attention,true,label);assert.match(after.reason,cause,label);
   assert.equal(after.resolution.currentRunId,null,label);assert.equal(f.sends.length,0,label);
   assert.ok(after.resolution.incident,label);
   assert.equal(f.store.events(after.id).some(e=>e.kind==='superseded_attempt_failure'),false,label);
  }finally{g.release();await f.close()}
 }
});
test('a delivery failure after the attempt reserved its own run stays uncertain on that run',async()=>{
 const f=fixture();const g=gatedPrePrContinuation(f,()=>base);
 try{
  f.adapter.sendRun=async(_t,r)=>{f.sends.push(r);throw new Error('Daemon dropped the send response')};
  const attempt=f.engine.resolution.advance(f.current());await g.inside;g.release();await attempt;
  const after=f.current(),run=f.store.run(after.resolution.currentRunId!)!;
  assert.equal(run.status,'uncertain');assert.equal(f.sends.length,1);
  assert.equal(after.resolution.attention,true);assert.match(after.reason,/Daemon dropped the send response/);
  assert.equal(after.resolution.incident?.runId,run.id);
  assert.equal(f.store.events(after.id).some(e=>e.kind==='superseded_attempt_failure'),false);
  // Something now running does not clear or retry the uncertain send.
  f.states.set('worker',{...f.states.get('worker')!,status:'running',active:true});
  await f.engine.resolution.advance(f.current());
  assert.equal(f.sends.length,1);assert.equal(f.store.run(run.id)?.status,'uncertain');assert.equal(f.current().resolution.attention,true);
 }finally{g.release();await f.close()}
});
test('transient send-boundary faults wait while the uncertain run is reconciled, never resent',async()=>{
 for(const fault of ['spawnSync git ETIMEDOUT','Transport not connected (status: disconnected)']){
  const f=fixture();const g=gatedPrePrContinuation(f,()=>base);
  try{
   f.adapter.sendRun=async(_t,r)=>{f.sends.push(r);throw Error(fault)};
   const attempt=f.engine.resolution.advance(f.current());await g.inside;g.release();await attempt;
   const after=f.current(),run=f.store.run(after.resolution.currentRunId!)!;
   assert.equal(run.status,'uncertain',fault);
   assert.equal(after.resolution.attention,false,fault);
   assert.equal(after.resolution.stop?.reason,'external_unavailable',fault);
   assert.notEqual(after.resolution.recovery?.status,'escalated',fault);
   assert.equal(f.sends.length,1,fault);
   await f.engine.resolution.advance(f.current());
   assert.equal(f.sends.length,1,fault);
   assert.equal(f.store.run(run.id)?.status,'uncertain',fault);
   assert.equal(f.current().resolution.attention,false,fault);
  }finally{g.release();await f.close()}
 }
});
test('an orphan duplicate run whose sibling completed no longer holds the thread',async()=>{
 const f=fixture();try{
  await f.engine.wake();await f.report('changes_required');await f.engine.wake();
  const sibling=f.run();
  // Plant the orphan the live race left: same thread, created alongside, never completed.
  const orphan={...sibling,id:'orphan-run',createdAt:new Date(Date.parse(sibling.createdAt)-4).toISOString(),completion:null,released:false,status:'running' as const};
  f.store.putRun(orphan);f.store.setCredential('orphan-run','t');
  await f.report('ready_for_review');await f.engine.wake();
  // The watcher settles it on the first pass that sees the thread idle, before any stopped-thread reminder.
  assert.equal(f.store.run('orphan-run')?.released,true);
  assert.doesNotMatch(f.current().reason,/stopped/);
  await f.report('changes_required');await f.engine.wake();assert.equal(f.store.run('orphan-run')?.status,'superseded');
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='duplicate_run_superseded'));
  assert.equal(f.run().role,'revision');assert.notEqual(f.run().id,sibling.id);
  assert.doesNotMatch(f.current().reason,/serving another request/);
 }finally{await f.close()}
});
test('revision launcher refuses a retained agent named by a durable exclusion',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{phase:'changes_requested',reason:'Apply review findings',workerExclusions:[{agentId:'worker',profileId:null,reason:'Planner exclusion',createdAt:new Date().toISOString()}]});
  await f.engine.resolution.launch(f.current(),'revision');
  assert.equal(f.sends.filter(run=>run.role==='revision'&&run.agentId==='worker').length,0);
  assert.match(f.current().failoverReason,/agent worker/);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='excluded_worker_revision_refused'));
 }finally{await f.close()}
});
test('versioned worker exclusion is shown to recovery coordinators and replaces an excluded retained worker before revision',async()=>{
 const f=fixture();try{
  const replacement=profile('replacement-worker');f.engine.profiles.push(replacement);
  f.store.setMeta('pool',[...f.store.pool().map(entry=>entry.profileId==='coordinator'?{...entry,capability:'very_low' as const}:entry),{profileId:replacement.id,enabled:true,group:'replacement',roles:['worker'],weight:1,scopes:['general'],capability:'medium',cost:'low'}]);
  f.adapter.verifyResume=async()=>{};
  f.adapter.createAgent=async task=>{
    assert.equal(task.profile?.id,replacement.id,'replacement selection honors the profile exclusion');
    f.states.set('replacement-agent',{id:'replacement-agent',workspaceId:task.workspaceId,status:'running',active:true,permissions:false,error:''});
    return{id:'replacement-agent',workspaceId:task.workspaceId};
  };
  f.store.update(f.task.id,{phase:'changes_requested',reason:'Apply exact-head review findings',resolution:{...f.current().resolution,review:{taskId:f.task.id,runId:'review',eventId:'review',status:'changes_required',summary:'Fix the three findings',head}}});
  const control={taskId:f.task.id,version:f.current().version,action:'exclude_worker' as const,workerExclusion:{profileId:'author'},reason:'Three hangs; no further turns'};
  assert.equal(taskControlInputSchema.safeParse({...control,workerExclusion:undefined}).success,false);
  assert.equal(taskControlInputSchema.safeParse({...control,workerExclusion:{agentId:'worker',profileId:'author'}}).success,false);
  const before=f.current();
  const excluded=await f.engine.performTaskControl(taskControlInputSchema.parse(control));
  assert.equal(excluded.version,before.version+1);
  assert.deepEqual(excluded.workerExclusions,[{agentId:null,profileId:'author',reason:'Three hangs; no further turns',createdAt:excluded.workerExclusions[0]?.createdAt}]);
  assert.match(excluded.failoverReason,/profile author/);

  const recoveryRun:Run={id:'recovery-prompt',taskId:f.task.id,role:'recovery',generation:1,head,base,agentId:'coordinator',workspaceId:'workspace',profile:f.engine.profiles.find(p=>p.id==='coordinator')!,status:'running',createdAt:new Date().toISOString(),lastObservedAt:null,active:true,idleSince:null,completion:null,released:false};
  const recoveryPrompt=runPrompt(excluded,recoveryRun,'/helper','/ticket',true);
  assert.match(recoveryPrompt,/Durable planner\/operator worker exclusions/);
  assert.match(recoveryPrompt,/profile author: Three hangs; no further turns/);
  assert.match(recoveryPrompt,/Nucleus will not give an excluded worker another turn/);

  await f.engine.wake();
  assert.equal(f.current().phase,'working');
  assert.equal(f.current().agentId,'replacement-agent');
  assert.equal(f.current().profile?.id,replacement.id);
  assert.equal(f.current().retiredWorkers.at(-1)?.agentId,'worker');
  assert.match(f.current().retiredWorkers.at(-1)?.reason??'',/Three hangs; no further turns/);
  assert.equal(f.sends.filter(run=>run.role==='revision'&&run.agentId==='worker').length,0,'the excluded retained worker gets no revision turn');
 }finally{await f.close()}
});
async function plantStoppedPrePrRevision(f:ReturnType<typeof fixture>,instruction='Continue the preserved pre-PR work'){
 f.adapter.verifyResume=async()=>{};
 const blocked:Completion={taskId:f.task.id,runId:'initial',eventId:'initial-blocked',status:'blocked',summary:'Waiting for operator evidence'};
 f.store.update(f.task.id,{phase:'blocked',reason:blocked.summary,completion:blocked,prHead:null,prUrl:null,resumePrNumber:null});
 f.engine.resolution.resumeWorker(f.current(),instruction);await f.engine.wake();
 const stopped=f.run();f.idle(stopped.agentId!,stopped.workspaceId);
 f.store.update(f.task.id,{reason:'The revision thread stopped without a callback; inspect the thread',resolution:{...f.current().resolution,attention:true,recovery:{id:'recovery',key:'incident',generation:1,runId:null,agentId:'coordinator',status:'escalated',summary:'Operator action required',idleSince:null,incidentId:null}}});
 return {blocked,stopped};
}
test('resumeWorker accepts a stopped revision while worktree validation is live',async()=>{
 const f=fixture();try{
  const {stopped}=await plantStoppedPrePrRevision(f);
  f.engine.resolution.worktreeValidationProbe=()=>({state:'alive',command:'effigy qa:changed',pid:69306});
  const resumed=f.engine.resolution.resumeWorker(f.current(),'Continue after QA');
  assert.equal(f.store.run(stopped.id)?.released,true);assert.equal(f.store.run(stopped.id)?.status,'superseded');
  assert.equal(resumed.phase,'changes_requested');assert.match(resumed.reason,/Continue after QA/);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='stopped_revision_released_for_live_validation'));
  await f.engine.wake();
  const next=f.run();
  assert.equal(next.role,'revision');assert.notEqual(next.id,stopped.id);assert.equal(next.agentId,'worker');
 }finally{await f.close()}
});
test('resumeWorker still refuses a stopped revision when validation is not live',async()=>{
 const f=fixture();try{
  const {stopped}=await plantStoppedPrePrRevision(f);
  f.engine.resolution.worktreeValidationProbe=()=>({state:'absent'});
  assert.throws(()=>f.engine.resolution.resumeWorker(f.current(),'Try again'),/blocked result or stopped pre-callback worker/);
  assert.equal(f.store.run(stopped.id)?.released,false);
 }finally{await f.close()}
});
test('resumeWorker still refuses a stopped revision when the worktree QA scan is unverified',async()=>{
 const f=fixture();try{
  const {stopped}=await plantStoppedPrePrRevision(f);
  f.engine.resolution.worktreeValidationProbe=()=>({state:'unverified',reason:'process listing failed'});
  assert.throws(()=>f.engine.resolution.resumeWorker(f.current(),'Try again'),/blocked result or stopped pre-callback worker/);
  assert.equal(f.store.run(stopped.id)?.released,false);
 }finally{await f.close()}
});
function plantSupersededPrePrWorker(f:ReturnType<typeof fixture>,instruction='Continue the approved handoff'){
 f.adapter.verifyResume=async()=>{};
 f.store.update(f.task.id,{phase:'needs_attention',reason:'Worker stopped on model capacity',completion:null,prHead:null,prUrl:null,resumePrNumber:null,resolution:{...f.current().resolution,currentRunId:null}});
 f.engine.resolution.resumeWorker(f.current(),instruction);
 return f.current();
}
test('a superseded worker report names the pending resume and ends the turn',async()=>{
 const {Reports}=await import('../core/intake/report');const f=fixture();try{
  plantSupersededPrePrWorker(f);
  assert.equal(f.current().phase,'changes_requested');
  f.store.setCredential('initial','worker-token');
  const late={eventId:randomUUID(),taskId:f.task.id,runId:'initial',status:'blocked' as const,summary:'Late result after the resume queued',head:base};
  await assert.rejects(new Reports(f.engine).report(late,'worker-token'),/superseded by a pending resume\/continuation.*End your turn/s);
  const refused=f.store.events(f.task.id).find(entry=>entry.kind==='superseded_run_refused');
  assert.ok(refused,'the superseded refusal is recorded for the resume dispatch to verify');assert.match(refused.detail,/run initial:/);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,prePrResumeInstruction:null}});
  await assert.rejects(new Reports(f.engine).report({...late,eventId:randomUUID()},'worker-token'),/Stale reporting run/);
 }finally{await f.close()}
});
test('a prior revision run superseded by a pre-PR resume names the resume over MCP',async()=>{
 const {Reports}=await import('../core/intake/report');const f=fixture();try{
  f.adapter.verifyResume=async()=>{};
  const blocked:Completion={taskId:f.task.id,runId:'initial',eventId:'prior-blocked',status:'blocked',summary:'Waiting for operator evidence'};
  f.store.update(f.task.id,{phase:'blocked',reason:blocked.summary,completion:blocked,prHead:null,prUrl:null,resumePrNumber:null});
  const at=new Date().toISOString();
  const prior:Run={id:'prior-revision',taskId:f.task.id,role:'revision',generation:f.current().coordinatorGeneration,head:base,base,agentId:'worker',workspaceId:'workspace',profile:profile('author'),status:'superseded',createdAt:at,lastObservedAt:at,active:false,idleSince:at,completion:null,released:true};
  f.store.putRun(prior);f.store.setCredential('prior-revision','prior-token');
  f.engine.resolution.resumeWorker(f.current(),'Continue the preserved pre-PR work');
  assert.ok(f.current().resolution.prePrResumeInstruction,'the pre-PR resume owns the thread');
  const late={eventId:randomUUID(),taskId:f.task.id,runId:'prior-revision',status:'blocked' as const,summary:'Late result from the superseded revision run',head:base};
  await assert.rejects(new Reports(f.engine).report(late,'prior-token'),/superseded by a pending resume\/continuation.*End your turn/s);
  await f.engine.wake();
  const resume=f.run();assert.equal(resume.role,'revision');assert.equal(resume.agentId,'worker');
  await assert.rejects(new Reports(f.engine).report({...late,eventId:randomUUID()},'prior-token'),/Unauthorized callback/);
  assert.equal(f.store.run(prior.id)?.released,true);
  assert.equal(f.current().resolution.currentRunId,resume.id,'the revoked prior run cannot change the resume');
 }finally{await f.close()}
});
test('a late run superseded by a dispatched same-thread resume names the resume',async()=>{
 const f=fixture();try{
  plantSupersededPrePrWorker(f);
  await f.engine.wake();await f.engine.wake();
  const resume=f.run();assert.equal(resume.role,'revision');assert.equal(resume.agentId,'worker');
  const old:Run={id:'old-revision',taskId:f.task.id,role:'revision',generation:f.current().coordinatorGeneration,head:base,base,agentId:'worker',workspaceId:'workspace',profile:profile('author'),status:'running',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:new Date().toISOString(),completion:null,released:false};
  f.store.putRun(old);f.store.setCredential('old-revision','old-token');
  const input:Completion={eventId:randomUUID(),taskId:f.task.id,runId:'old-revision',status:'blocked',summary:'Late result from the superseded run',head:base};
  assert.throws(()=>f.engine.resolution.complete(input,'old-token'),/superseded by a pending resume\/continuation.*End your turn/s);
 }finally{await f.close()}
});
test('a pending pre-PR resume waits while the retained thread holds a pending permission',async()=>{
 const {Reports}=await import('../core/intake/report');const f=fixture();try{
  plantSupersededPrePrWorker(f);
  f.store.setCredential('initial','worker-token');
  const late={eventId:randomUUID(),taskId:f.task.id,runId:'initial',status:'blocked' as const,summary:'Late result after the resume queued',head:base};
  await assert.rejects(new Reports(f.engine).report(late,'worker-token'),/superseded by a pending resume/);
  // Nothing Queue can observe identifies the pending item as the superseded run's
  // own question, so even a refusal plus fresh thread activity keeps waiting here.
  const refusedAt=f.store.events(f.task.id).find(entry=>entry.kind==='superseded_run_refused')!.at;
  f.states.set('worker',{id:'worker',workspaceId:'workspace',status:'idle',active:false,permissions:true,error:'',updatedAt:new Date(Date.parse(refusedAt)+1000).toISOString()});
  await f.engine.wake();
  assert.equal(f.current().resolution.currentRunId,null,'no resume dispatches over an unidentified pending item');
  assert.equal(f.current().phase,'changes_requested');
 }finally{await f.close()}
});
test('a pending pre-PR resume still waits for a genuinely active retained thread',async()=>{
 const f=fixture();try{
  plantSupersededPrePrWorker(f);
  f.states.set('worker',{id:'worker',workspaceId:'workspace',status:'running',active:true,permissions:false,error:''});
  await f.engine.wake();
  assert.equal(f.current().resolution.currentRunId,null,'no resume dispatches onto a genuinely active thread');
  assert.equal(f.current().phase,'changes_requested');
 }finally{await f.close()}
});
test('retained revision stops when its worker profile or subscription is unavailable',async()=>{
 const cases=['disabled','catalog','subscription'] as const;
 for(const blocked of cases){
  const f=fixture();try{
   f.store.update(f.task.id,{phase:'changes_requested',reason:'Apply review findings'});
   if(blocked==='disabled')f.store.setMeta('pool',f.store.pool().map(p=>p.profileId==='author'?{...p,enabled:false}:p));
   if(blocked==='catalog')f.engine.profiles[0]={...f.engine.profiles[0],available:false,problem:'provider disabled'};
   if(blocked==='subscription')f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('author',JSON.stringify({group:'author',unavailable:true,reason:'weekly limit',retryAt:null}));
   await f.engine.wake();
   assert.equal(f.current().phase,'needs_attention');assert.equal(f.current().resolution.attention,true);
   assert.match(f.current().reason,new RegExp(`^${RETAINED_WORKER_PROFILE_REASON}`));
   assert.match(f.current().reason,/remap with restart/);
   assert.equal(f.current().agentId,'worker');assert.equal(f.current().prUrl,'https://github.com/example/repo/pull/1');
   assert.equal(f.current().resolution.currentRunId,null);assert.equal(f.sends.length,0);assert.equal(f.creates.length,0);
   await f.engine.resolution.deliverNotices();
   const attentionNotice=f.store.notices(f.task.id).find(notice=>notice.kind==='attention');
   assert.ok(attentionNotice);assert.match(attentionNotice!.text,/restart remaps the retained worker/);
   assert.throws(()=>f.engine.resolution.retry(f.current()),/explicit operator retry/);
  }finally{await f.close()}
 }
});
test('unavailable retained revision cannot replay the initial completion or re-review an unchanged head',async()=>{
 const f=fixture();try{
  await f.engine.wake();const reviewer=f.run().agentId;
  f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('author',JSON.stringify({group:'author',unavailable:true,reason:'credit exhausted',retryAt:null}));
  await f.report('changes_required');
  await f.engine.wake();
  const stopped=f.current();
  assert.equal(stopped.phase,'needs_attention');assert.equal(stopped.resolution.review?.status,'changes_required');
  assert.match(stopped.reason,new RegExp(`^${RETAINED_WORKER_PROFILE_REASON}`));
  await f.engine.wake();
  assert.equal(f.current().phase,'needs_attention');assert.equal(f.current().reason,stopped.reason);
  assert.equal(f.current().resolution.review?.eventId,stopped.resolution.review?.eventId);
  assert.equal(f.current().resolution.currentRunId,null);assert.equal(f.current().resolution.reviewerAgentId,reviewer);
  assert.equal(f.creates.filter(r=>r.role==='reviewer').length,1);assert.equal(f.sends.filter(r=>r.role==='reviewer').length,0);
 }finally{await f.close()}
});
test('operator retry rechecks retained worker eligibility before revision resumes',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{phase:'changes_requested',reason:'Apply review findings'});
  f.store.setMeta('pool',f.store.pool().map(p=>p.profileId==='author'?{...p,enabled:false}:p));await f.engine.wake();
  f.store.setMeta('pool',f.store.pool().map(p=>p.profileId==='author'?{...p,enabled:true}:p));
  f.engine.resolution.retry(f.current(),false,undefined,true);await f.engine.wake();
  assert.equal(f.run().role,'revision');assert.equal(f.run().agentId,'worker');assert.equal(f.sends.length,1);assert.equal(f.creates.length,0);
 }finally{await f.close()}
});
test('an owner restart of a profile-unavailable park remaps the retained worker and keeps its continuation (review #539)',async()=>{
 const f=fixture();try{
  const backup=profile('backup');f.engine.profiles.push(backup);
  f.store.setMeta('pool',[...f.store.pool(),{profileId:backup.id,enabled:true,group:'backup',roles:['worker'],weight:1,scopes:['general']}]);
  f.store.event(f.task.id,'revision_requested','Apply review findings on the figures');
  f.store.update(f.task.id,{phase:'changes_requested',reason:'Apply review findings'});
  f.store.setMeta('pool',f.store.pool().map(p=>p.profileId==='author'?{...p,enabled:false}:p));
  await f.engine.wake();
  assert.match(f.current().reason,new RegExp(`^${RETAINED_WORKER_PROFILE_REASON}`));
  const {ownerTaskNext,collectOwnerVerbFacts}=await import('../core/verbs/owner-verbs');
  const verb=ownerTaskNext(collectOwnerVerbFacts(f.store,f.current())).verbs.find(item=>item.verb==='restart')!;
  assert.equal(verb.available,true,JSON.stringify(verb));
  assert.equal((verb.args as Record<string,unknown>).role,undefined,'the parked remap, not a worker restart');
  const restarted=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'restart',reason:'Remap to an eligible profile'});
  assert.equal(restarted.phase,'changes_requested');
  assert.match(restarted.failoverReason,/Operator-approved retained worker remap/);
  assert.match(restarted.failoverReason,/Apply review findings on the figures/);
  await f.engine.wake();
  assert.doesNotMatch(f.current().reason,new RegExp(`^${RETAINED_WORKER_PROFILE_REASON}`),'the remap does not park again on the same profile');
 }finally{await f.close()}
});
test('operator retry remaps an unavailable retained worker and preserves the latest continuation',async()=>{
 const f=fixture();try{
  const continuation='Continue from current main and prepare the existing release candidate';
  const backup=profile('backup');f.engine.profiles.push(backup);
  f.store.setMeta('pool',[...f.store.pool().map(p=>p.profileId==='author'?{...p,enabled:false}:p),{profileId:backup.id,enabled:true,group:'backup',roles:['worker'],weight:1,scopes:['general']}]);
  f.store.event(f.task.id,'worker_resume_requested','Earlier continuation from the previous review round');
  f.store.event(f.task.id,'revision_requested',continuation);
  f.store.event(f.task.id,'needs_attention',`${RETAINED_WORKER_PROFILE_REASON}: subscription group author is unavailable`);
  f.store.update(f.task.id,{phase:'blocked',reason:'Recovery exhausted after retained profile attention',prUrl:null,prHead:null,
   completion:{taskId:f.task.id,runId:'initial',eventId:'blocked-result',status:'blocked',summary:'Earlier task blocker'},
   resolution:{...f.current().resolution,currentRunId:null,attention:true,recovery:{id:'recovery',key:'incident',generation:1,runId:null,agentId:null,status:'escalated',summary:'Operator action required',idleSince:null,incidentId:null}}});
  f.adapter.verifyResume=async()=>{};
  f.adapter.createAgent=async task=>{f.states.set('replacement-worker',{id:'replacement-worker',workspaceId:task.workspaceId,status:'running',active:true,permissions:false,error:''});return{id:'replacement-worker',workspaceId:task.workspaceId}};
  // Round 4: the owner chooses the replacement with route role=worker, which remaps at once.
  const routed=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'route',role:'worker',profileId:backup.id,reason:'Operator approved the eligible backup profile'});
  const requested=routed;
  assert.equal(requested.phase,'changes_requested');assert.match(requested.failoverReason,/Operator-approved retained worker remap/);
  assert.match(requested.failoverReason,new RegExp(continuation),'the replacement resumes the task continuation, not the route reason');
  assert.equal(requested.resolution.pendingWorkerInstruction,continuation);
  assert.equal(requested.replacementProfile?.profileId,backup.id);
  assert.equal(requested.resolution.recovery,null);assert.equal(requested.resolution.recoveryAttempts,0);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='route_changed'));
  await f.engine.wake();
  assert.equal(f.current().phase,'working',f.current().reason);assert.equal(f.current().agentId,'replacement-worker');assert.equal(f.current().workspaceId,'workspace');assert.equal(f.current().profile?.id,backup.id);
  assert.equal(f.current().retiredWorkers.at(-1)?.agentId,'worker');assert.match(f.current().retiredWorkers.at(-1)?.reason??'',new RegExp(continuation));
  f.store.update(f.task.id,{resolution:{...f.current().resolution,recoveryAttempts:3,recovery:{id:'stale',key:'stale',generation:1,runId:null,agentId:null,status:'escalated',summary:'Old incident',idleSince:null,incidentId:null}}});
  await f.engine.wake();assert.equal(f.current().resolution.recovery,null);assert.equal(f.current().resolution.recoveryAttempts,0);
 }finally{await f.close()}
});
test('a named worker replacement keeps the worker request thinking level (review #547)',async()=>{
 const f=fixture();try{
  const backup={...profile('backup'),supportedThinking:['low','high'],thinkingOptionId:'high'};f.engine.profiles.push(backup);
  f.store.setMeta('pool',[...f.store.pool(),{profileId:backup.id,enabled:true,group:'backup',roles:['worker'],weight:1,scopes:['general']}]);
  f.engine.profiles=f.engine.profiles.map(p=>({...p,supportedThinking:['low','high']}));
  const current=f.current();
  f.adapter.verifyResume=async()=>{};
  f.adapter.createAgent=async task=>{f.states.set('replacement-worker',{id:'replacement-worker',workspaceId:task.workspaceId,status:'running',active:true,permissions:false,error:''});return{id:'replacement-worker',workspaceId:task.workspaceId}};
  f.store.update(f.task.id,{phase:'changes_requested',thinkingOptionId:'',failoverReason:'Operator-approved retained worker remap. Continue the existing task: Fix it',
   replacementProfile:{profileId:backup.id,reason:'Owner chose the backup'},
   profileRequests:{...current.profileRequests,worker:{profileId:current.profile?.id??'author',reason:'Owner level',required:false,thinkingOptionId:'low'}},
   resolution:{...current.resolution,currentRunId:null,attention:false,pendingWorkerInstruction:'Fix it'}});
  await f.engine.wake();
  assert.equal(f.current().profile?.id,backup.id,f.current().reason);
  assert.equal(f.current().profile?.thinkingOptionId,'low','the replacement launches at the requested level, not its profile default');
 }finally{await f.close()}
});
test('a retained-worker remap takes a fresh operator instruction over a stale pending one, and nowhere else',async()=>{
 const f=fixture();try{
  // Live, 2026-09-28 (consumer-b #181): the remap's continuation was a spent device-flow instruction,
  // and retry_resolution could not carry a fresh one.
  const backup=profile('backup');f.engine.profiles.push(backup);
  f.store.setMeta('pool',[...f.store.pool().map(p=>p.profileId==='author'?{...p,enabled:false}:p),{profileId:backup.id,enabled:true,group:'backup',roles:['worker'],weight:1,scopes:['general']}]);
  f.store.event(f.task.id,'worker_resume_requested','Stale: use device-flow code FEB4-ASC1 and leave the rehearsal app running');
  f.store.event(f.task.id,'needs_attention',`${RETAINED_WORKER_PROFILE_REASON}: pool profile author is disabled`);
  f.store.update(f.task.id,{phase:'blocked',reason:'Recovery exhausted after retained profile attention',
   resolution:{...f.current().resolution,currentRunId:null,attention:true,recovery:{id:'recovery',key:'incident',generation:1,runId:null,agentId:null,status:'escalated',summary:'Operator action required',idleSince:null,incidentId:null}}});
  const requested=f.engine.resolution.retry(f.current(),false,'The work is complete at the PR head; verify and report ready_for_review only',true);
  assert.match(requested.failoverReason,/verify and report ready_for_review only/);
  assert.doesNotMatch(requested.failoverReason,/FEB4-ASC1/,'the stale pending instruction is not the continuation');
 }finally{await f.close()}
 const g=fixture();try{
  g.store.update(g.task.id,{phase:'blocked',reason:'Some other blocker'});
  assert.throws(()=>g.engine.resolution.retry(g.current(),false,'do something',true),/applies only to a retained-worker remap/,'never dropped silently');
 }finally{await g.close()}
});
test('an operator stopped-revision replacement never resumes the excluded retained worker',async()=>{
 const f=fixture();try{
  // Live, 2026-09-27 (nucleus#033): replace_stopped_revision left the task in changes_requested with the
  // remap reason, the ordinary revision launcher resumed the retained worker on its still-enabled profile,
  // and the replacement then waited for the very worker it was meant to replace.
  const backup=profile('backup');f.engine.profiles.push(backup);
  f.store.setMeta('pool',[...f.store.pool(),{profileId:backup.id,enabled:true,group:'backup',roles:['worker'],weight:1,scopes:['general']}]);
  f.store.update(f.task.id,{phase:'changes_requested',reason:'Operator-approved stopped revision replacement; selecting an eligible replacement',
   failoverReason:'Operator-approved stopped revision replacement. Continue the existing task: fix the hanging test first',
   resolution:{...f.current().resolution,currentRunId:null,attention:false,recoveryActive:false,recoveryAttempts:0,recovery:null}});
  f.adapter.verifyResume=async()=>{};
  f.adapter.createAgent=async task=>{f.states.set('replacement-worker',{id:'replacement-worker',workspaceId:task.workspaceId,status:'running',active:true,permissions:false,error:''});return{id:'replacement-worker',workspaceId:task.workspaceId}};
  // Live order: the resolution step reached the task before the replacement pass did.
  await f.engine.resolution.advance(f.current());
  await f.engine.wake();await f.engine.wake();
  assert.equal(f.sends.filter(r=>r.role==='revision'&&r.agentId==='worker').length,0,'the excluded retained worker is never prompted');
  assert.equal(f.current().agentId,'replacement-worker',f.current().reason);
  assert.notEqual(f.current().profile?.id,'author','the replacement excludes the stopped profile');
 }finally{await f.close()}
});
test('an operator retry that answers an escalation resets the coordinator budget for the next fault',async()=>{
 const f=fixture();try{
  // Live, 2026-09-28 (project-a #1655): three content-scope escalations spent the budget, each answered by
  // an operator retry; an unrelated reviewer crash then escalated immediately with no coordinator.
  f.store.putRun({id:'blocked-run',taskId:f.task.id,role:'revision',generation:1,head,base,agentId:'worker',workspaceId:'workspace',profile:f.current().profile,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,
   completion:{eventId:'b',taskId:f.task.id,runId:'blocked-run',status:'blocked',summary:'Needs a ruling'},released:true});
  f.store.update(f.task.id,{phase:'blocked',reason:'Needs a ruling',resolution:{...f.current().resolution,currentRunId:null,attention:true,recoveryAttempts:3,
   recovery:{id:'recovery',key:'k',generation:1,runId:null,agentId:null,status:'escalated',summary:'Escalated for a ruling',idleSince:null,incidentId:null}}});
  const retried=f.engine.resolution.retry(f.current(),false,undefined,true);
  assert.equal(retried.resolution.recoveryAttempts,0,'the answered episode no longer counts against the next fault');
  assert.equal(retried.resolution.recovery,null);
  const auto=fixture();try{
   auto.store.putRun({id:'blocked-run',taskId:auto.task.id,role:'revision',generation:1,head,base,agentId:'worker',workspaceId:'workspace',profile:auto.current().profile,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,
    completion:{eventId:'b',taskId:auto.task.id,runId:'blocked-run',status:'blocked',summary:'x'},released:true});
   auto.store.update(auto.task.id,{phase:'blocked',reason:'x',resolution:{...auto.current().resolution,currentRunId:null,recoveryAttempts:2}});
   assert.equal(auto.engine.resolution.retry(auto.current()).resolution.recoveryAttempts,2,'a coordinator retry keeps counting within its episode');
  }finally{await auto.close()}
 }finally{await f.close()}
});
test('a replaced worker\'s blocked report returns to the worker and revise keeps the retained PR',async()=>{
 const f=fixture();try{
  // Live, 2026-09-29 (project-a #1682): after replace_retained_worker the task keeps its PR only as
  // resumePrNumber; the new worker's blocked report carried no PR, retry routed it to review and
  // revise refused for want of an unmerged task PR.
  f.store.putRun({id:'old-review',taskId:f.task.id,role:'reviewer',generation:1,head,base,agentId:'reviewer',workspaceId:'workspace',profile:f.current().profile,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,
   completion:{eventId:'rv',taskId:f.task.id,runId:'old-review',status:'changes_required',summary:'x'} as never,released:true});
  const runId=f.current().runId!;
  f.store.update(f.task.id,{phase:'blocked',reason:'worker blocked',prUrl:null,prHead:null,resumePrNumber:11,
   completion:{taskId:f.task.id,runId,eventId:'blocked',status:'blocked',summary:'needs source-plan scope',head},
   resolution:{...f.current().resolution,currentRunId:null}});
  const blocked=f.current();
  assert.equal(f.engine.resolution.retry(blocked).phase,'changes_requested','the worker\'s own block returns to the worker, not review');
  const revised=f.engine.resolution.retry(blocked,true,'Continue with the authorized scope');
  assert.equal(revised.phase,'changes_requested');assert.equal(revised.resumePrNumber,11,'the retained PR identity is kept');
  f.store.update(f.task.id,{resumePrNumber:null});
  assert.throws(()=>f.engine.resolution.retry(f.current(),true,'x'),/unmerged task PR|retained worker and no task PR/);
 }finally{await f.close()}
});
test('blocked task with a retained PR names restart in revise and resume_worker refusals',async()=>{
 const f=fixture();try{
  // Project-A #1655, 2026-09-27: blocked after a revision run reported blocked with prUrl null
  // while prHead and resumePrNumber were set. revise and resume_worker refused without naming
  // retry_resolution, which resumes the retained worker on the same workspace and PR.
  f.store.putRun({id:'old-revision',taskId:f.task.id,role:'revision',generation:1,head,base,agentId:'worker',workspaceId:'workspace',profile:f.current().profile,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,
   completion:{eventId:'rev-blocked',taskId:f.task.id,runId:'old-revision',status:'blocked',summary:'needs ruling'} as never,released:true});
  const runId=f.current().runId!;
  f.store.update(f.task.id,{phase:'blocked',reason:'worker blocked',prUrl:null,prHead:head,resumePrNumber:2289,
   completion:{taskId:f.task.id,runId,eventId:'blocked',status:'blocked',summary:'needs ruling',head},
   resolution:{...f.current().resolution,currentRunId:null}});
  const blocked=f.current();
  assert.equal(f.engine.resolution.retry(blocked).phase,'changes_requested','retry_resolution resumes the retained PR');
  assert.throws(()=>f.engine.resolution.resumeWorker(blocked,'Continue after ruling'),/use restart to resume/,'retained-PR resume refusal names restart');
  const revised=f.engine.resolution.retry(blocked,true,'Continue after ruling');
  assert.equal(revised.phase,'changes_requested','revise treats resumePrNumber plus prHead as the task PR identity');
  f.store.update(f.task.id,{phase:'blocked',reason:'worker blocked',prUrl:null,prHead:head,resumePrNumber:null,
   completion:{taskId:f.task.id,runId,eventId:'blocked',status:'blocked',summary:'needs ruling',head},
   resolution:{...f.current().resolution,currentRunId:null}});
  assert.throws(()=>f.engine.resolution.retry(f.current(),true,'x'),/use restart to resume/,'revise refusal without a PR identity names restart');
 }finally{await f.close()}
});
function pinAmendedBriefV6(f:ReturnType<typeof fixture>,latestText:string){
 const pinnedAt=new Date().toISOString();
 const briefVersions=Array.from({length:6},(_,index)=>{
  const version=index+1,text=version===6?latestText:`Earlier approved brief version ${version}`;
  return {version,text,digest:briefDigest(text),mediaType:'text/markdown' as const,reason:version===6?'Owner amended the complete brief to version 6':'Submitted',pinnedAt};
 });
 const current=briefVersions.at(-1)!;
 return f.store.update(f.task.id,{handoffPath:'',brief:{text:current.text,mediaType:current.mediaType,digest:current.digest},handoffText:current.text,briefVersions});
}
test('retry after a later blocked revision uses current brief and separate latest diagnostic context',async()=>{
 const f=fixture();try{
  const originalSummary='Blocked: missing Longhorn tools';
  const latestSummary='Blocked: publication still uses hardcoded placeholder stubs';
  const latestHead='d'.repeat(40),briefText='Version 6 approved scope: replace the hardcoded publication stubs within the existing task outputs.';
  const pinned=pinAmendedBriefV6(f,briefText);
  const original={eventId:'original-block',taskId:f.task.id,runId:'initial',status:'blocked' as const,summary:originalSummary,head,prNumber:177};
  const oldRevision:Run={id:'later-blocked-revision',taskId:f.task.id,role:'revision',generation:1,head:latestHead,base,agentId:'worker',workspaceId:'workspace',profile:pinned.profile,profileGroup:null,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:new Date().toISOString(),completion:{eventId:'revision-block',taskId:f.task.id,runId:'later-blocked-revision',status:'blocked',summary:latestSummary,head:latestHead},released:true};
  f.store.putRun(oldRevision);
  f.store.update(f.task.id,{phase:'blocked',reason:latestSummary,completion:original,prUrl:'https://github.com/example/repo/pull/177',prHead:latestHead,resumePrNumber:null,resolution:{...pinned.resolution,currentRunId:null,pendingWorkerInstruction:null}});
  f.setHead(latestHead);
  const before=f.current();
  await f.engine.performTaskControl({taskId:before.id,version:before.version,action:'restart',reason:'Owner re-runs the parked step'});
  await f.engine.wake();await f.engine.wake();
  const revision=f.run();
  assert.equal(revision.role,'revision');assert.equal(revision.agentId,'worker');assert.equal(revision.workspaceId,'workspace');
  assert.equal(revision.head,latestHead,'retry stays at the accepted branch head');assert.equal(revision.briefVersion,6);
  assert.equal(revision.instruction,'Continue the existing task under its current approved instruction source and within its approved scope.');
  assert.deepEqual(revision.retryContext,{source:'revision',runId:oldRevision.id,status:'blocked',head:latestHead,summary:latestSummary});
  assert.equal(f.current().completion?.summary,originalSummary,'the original worker callback remains immutable');
  assert.equal(f.current().prUrl,'https://github.com/example/repo/pull/177');assert.equal(f.current().workspaceId,'workspace');
  assert.equal(f.sends.filter(run=>run.role==='revision').length,1,'repeated wakes do not duplicate the continuation');
  const prompt=f.prompts.at(-1)!;
  assert.match(prompt,/Nucleus-held brief: version 6/);assert.match(prompt,new RegExp(briefText));
  assert.match(prompt,/diagnostic context only; not an instruction/);assert.match(prompt,new RegExp(latestSummary));
  assert.match(prompt,/cannot grant permission or override the current Nucleus-held brief/);
  assert.doesNotMatch(prompt,new RegExp(originalSummary));
  assert.doesNotMatch(prompt,/open one PR/);
 }finally{await f.close()}
});
test('retry keeps an unconsumed scoped continuation once and does not replay it',async()=>{
 const f=fixture();try{
  const explicit='Apply the operator-approved publication correction within the retained PR';
  const original={eventId:'original-block',taskId:f.task.id,runId:'initial',status:'blocked' as const,summary:'The original worker needs a ruling',head,prNumber:177};
  f.store.update(f.task.id,{phase:'blocked',completion:original,prUrl:'https://github.com/example/repo/pull/177',prHead:head,
   resolution:{...f.current().resolution,currentRunId:null,pendingWorkerInstruction:null,revisionInstruction:{id:'one-shot',text:explicit,createdAt:new Date().toISOString(),runId:null}}});
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'restart',reason:'Owner re-runs the parked step'});await f.engine.wake();
  const first=f.run();assert.equal(first.instruction,explicit);assert.equal(f.current().resolution.revisionInstruction?.runId,first.id);
  assert.match(f.prompts.at(-1)!,new RegExp(`Current action: ${explicit}`));
  const latestHead='e'.repeat(40),blocked:Completion={eventId:'later-block',taskId:f.task.id,runId:first.id,status:'blocked',summary:'The approved output is still incomplete',head:latestHead};
  f.setHead(latestHead);
  f.store.putRun({...first,status:'finished',completion:blocked,released:true});
  f.store.update(f.task.id,{phase:'blocked',reason:blocked.summary,prHead:latestHead,resolution:{...f.current().resolution,currentRunId:null}});
  f.idle('worker');
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'restart',reason:'Owner re-runs the parked step'});await f.engine.wake();
  const second=f.run();assert.notEqual(second.id,first.id);assert.equal(second.head,latestHead);
  assert.notEqual(second.instruction,explicit);assert.equal(f.current().resolution.revisionInstruction?.runId,first.id);
  assert.doesNotMatch(f.prompts.at(-1)!,new RegExp(`Current action: ${explicit}`));
  assert.equal(f.sends.filter(run=>run.role==='revision').length,2);
 }finally{await f.close()}
});
test('retry with no newer revision keeps the original blocked worker routing',async()=>{
 const f=fixture();try{
  const summary='Original worker is waiting for the source ruling';
  f.store.update(f.task.id,{phase:'blocked',completion:{eventId:'initial-block',taskId:f.task.id,runId:'initial',status:'blocked',summary,head,prNumber:177},prUrl:'https://github.com/example/repo/pull/177',prHead:head});
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'restart',reason:'Owner re-runs the parked step'});await f.engine.wake();
  const revision=f.run();assert.equal(revision.role,'revision');assert.equal(revision.agentId,'worker');
  assert.equal(revision.retryContext?.source,'worker');assert.equal(revision.retryContext?.summary,summary);
 }finally{await f.close()}
});
test('rule 1: a fault that cannot conceal its evidence escalates from Queue state',async()=>{
 const f=fixture();try{
  const recipients=enableRecovery(f);let branchLookups=0;
  f.adapter.findOpenBranchPr=async()=>{branchLookups++;return[]};
  f.store.update(f.task.id,{phase:'changes_requested',reason:'Apply review findings'});
  f.store.setMeta('pool',f.store.pool().map(p=>p.profileId==='author'?{...p,enabled:false}:p));await f.engine.wake();
  assert.equal(f.current().phase,'needs_attention');assert.equal(f.current().resolution.recovery?.status,'escalated');
  assert.equal(branchLookups,0,'an unrelated retained-profile fault does not add an outbound live lookup');
  assert.equal(f.store.runs(f.task.id).filter(r=>r.role==='recovery').length,0);assert.equal(f.creates.length,0);assert.deepEqual(recipients,['origin']);
 }finally{await f.close()}
});
test('manual revision can repair a mismatched PR branch before normal verification resumes',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{phase:'needs_attention',reason:"PR must be open, ready, and match the task's branch and base",resolution:{...f.current().resolution,attention:true}});
  f.adapter.verifyPr=async()=>{throw Error('PR identity is still mismatched')};
  f.engine.resolution.retry(f.current(),true);await f.engine.wake();
  assert.equal(f.run().role,'revision');assert.equal(f.run().agentId,'worker');assert.equal(f.current().resolution.revisionPrRepair,true);
  f.adapter.verifyPr=async()=>({head,url:f.current().prUrl!});await f.report('ready_for_review',2);
  assert.equal(f.current().completion?.prNumber,2);
  assert.equal(f.current().resolution.revisionPrRepair,false);assert.equal(f.current().phase,'reviewing');
 }finally{await f.close()}
});
test('a refused authenticated ready report returns its exact checkout cause to the same worker',async()=>{
 const f=fixture();try{
  const beforeRuns=f.store.runs(f.task.id).length;
  const refusal=new Error('Worker must leave a clean worktree before review: untracked .DS_Store');
  assert.equal(f.engine.resolution.responsiblePrReportRefused(f.current(),'initial',1,refusal),true);
  const current=f.current();
  assert.equal(current.phase,'changes_requested');assert.equal(current.agentId,'worker');
  assert.match(current.reason,/refused ready_for_review because: Worker must leave a clean worktree before review: untracked \.DS_Store/);
  assert.match(current.resolution.pendingWorkerInstruction!,/same PR #1/);
  assert.equal(f.store.runs(f.task.id).length,beforeRuns,'a checkout refusal starts no coordinator or recovery run');
  assert.equal(f.store.eventsAll(f.task.id).at(-1)?.kind,'responsible_pr_report_refused');
 }finally{await f.close()}
});
test('verified exact-head replacement PR resumes review even when repair state was missed',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{phase:'needs_attention',reason:"Coordinator recovery could not safely continue: No resolution action needs retry",prUrl:null,prHead:null,resolution:{...f.current().resolution,attention:true,revisionPrRepair:false}});
  f.adapter.verifyPr=async(t,number)=>{assert.equal(number,2);return{head,url:'https://github.com/example/repo/pull/2'}};
  const repaired=await f.engine.resolution.adoptReplacementPr(f.current(),2);
  assert.equal(repaired.phase,'awaiting_review');assert.equal(repaired.resumePrNumber,2);assert.equal(repaired.completion?.prNumber,1);
  assert.equal(repaired.prHead,head);assert.equal(taskPrNumber(repaired),2);
  await f.engine.wake();assert.equal(f.run().role,'reviewer');
 }finally{await f.close()}
});
test('exact initial branch PR is bound only for an authenticated retained-worker readiness confirmation',async()=>{
 const f=fixture();try{
  let prompt='';const send=f.adapter.sendRun!;f.adapter.sendRun=async(t,r,token)=>{prompt=runPrompt(t,r,'/helper','/ticket',true);return send(t,r,token)};
  f.store.update(f.task.id,{phase:'blocked',reason:'Transport failed before callback',completion:null,prUrl:null,prHead:null});
  f.adapter.verifyPr=async(_task,number)=>{assert.equal(number,51);return{head,url:'https://github.com/example/repo/pull/51',repository:'example/repo',headRepository:'example/repo'}};
  f.adapter.verifyResume=async()=>{};
  const bound=await f.engine.resolution.adoptReplacementPr(f.current(),51);
  assert.equal(bound.phase,'changes_requested');assert.equal(bound.resumePrNumber,51);assert.equal(bound.prHead,head);
  assert.equal(bound.completion,null);assert.match(bound.reason,/authenticated readiness confirmation/);
  // This is the initial-discovery branch, not the dead-revision one, and the record
  // proves the exact recovered head was bound by the authenticated identity proof.
  assert.equal(f.store.events(f.task.id).some(e=>e.kind==='initial_pr_reconciled'),true);
  await f.engine.wake();const revision=f.run();
  assert.equal(revision.role,'revision');assert.equal(revision.agentId,'worker');assert.equal(revision.head,head);
  assert.equal(revision.identityConfirmation,true,'the production reservation bound the read-only intent to the run');
  assert.equal(f.current().resolution.revisionResumeUnpublished,false,'the task flag is consumed at reservation');
  assert.match(prompt,/identity-confirmation continuation only/);assert.match(prompt,/PR #51/);assert.match(prompt,/Do not edit files/);
  assert.match(prompt,new RegExp(`its HEAD is ${head}`),'the confirmation names the exact recovered head');
  assert.doesNotMatch(prompt,/Resume implementation in this same workspace and PR/,'the initial lost-readiness path never renders an implementation prompt');
  await f.report('ready_for_review',51);
  assert.equal(f.current().phase,'reviewing');assert.equal(f.current().completion?.prNumber,51);
  assert.equal(f.current().prUrl,'https://github.com/example/repo/pull/51');
 }finally{await f.close()}
});
test('owner restart of a stopped identity-confirmation run keeps the read-only action and renders its bound instruction',async()=>{
 const cases=[
  {label:'no instruction',instruction:undefined},
  {label:'compatible instruction',instruction:'Confirm identity only; do not edit or push.'},
  {label:'conflicting instruction',instruction:'Implement the approved changes now.'},
 ] as const;
 for(const subject of cases){
  const f=fixture();try{
   f.store.update(f.task.id,{phase:'blocked',reason:'Transport failed before callback',completion:null,prUrl:null,prHead:null});
   f.adapter.verifyPr=async(_task,number)=>{assert.equal(number,51);return{head,url:'https://github.com/example/repo/pull/51',repository:'example/repo',headRepository:'example/repo'}};
   f.adapter.verifyPrIdentity=f.adapter.verifyPr;
   f.adapter.verifyResume=async()=>{};
   await f.engine.resolution.adoptReplacementPr(f.current(),51);
   await f.engine.wake();
   const stopped=f.run();
   assert.equal(stopped.identityConfirmation,true);
   // The read-only run stopped without a callback; the retained worker is idle and
   // the owner restarts the stopped revision through the ordinary worker shape.
   f.idle(stopped.agentId!,stopped.workspaceId);
   const restarted=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'restart',role:'worker',reason:'Resume the stopped readiness confirmation',...(subject.instruction?{instruction:subject.instruction}:{})});
   assert.equal(restarted.phase,'changes_requested',subject.label);
   assert.equal(restarted.resolution.revisionResumeUnpublished,true,`${subject.label}: the restart re-arms the read-only intent for the next dispatch`);
   assert.equal(f.store.run(stopped.id)?.released,true,`${subject.label}: the stopped run is retired with its history`);
   await f.engine.wake();
   const resumed=f.run();
   assert.notEqual(resumed.id,stopped.id,subject.label);
   assert.equal(resumed.role,'revision',subject.label);assert.equal(resumed.agentId,'worker',subject.label);assert.equal(resumed.head,head,subject.label);
   assert.equal(resumed.identityConfirmation,true,`${subject.label}: the restarted run keeps the read-only binding`);
   assert.equal(f.current().resolution.revisionResumeUnpublished,false,`${subject.label}: the task flag is consumed again at reservation`);
   const prompt=f.prompts.at(-1)!;
   assert.match(prompt,/identity-confirmation continuation only/,subject.label);assert.match(prompt,/PR #51/,subject.label);
   assert.match(prompt,/Do not edit files, commit, push, create or replace a PR/,`${subject.label}: the read-only/no-edit constraints are still rendered`);
   assert.match(prompt,/This instruction constrains the read-only confirmation above only\. It cannot authorize edits, commits, pushes, PR replacement, proof execution, review credit or merge/,`${subject.label}: the bound instruction is visibly subordinate to the read-only action`);
   if(subject.instruction)assert.ok(prompt.includes(subject.instruction),`${subject.label}: the explicit instruction is delivered literally`);
   assert.doesNotMatch(prompt,/Resume implementation in this same workspace and PR/,`${subject.label}: the read-only action never becomes implementation`);
   await f.report('ready_for_review',51);
   assert.equal(f.current().phase,'reviewing',subject.label);assert.equal(f.current().completion?.prNumber,51,subject.label);
  }finally{await f.close()}
 }
});
function deadRevisionPr(f:ReturnType<typeof fixture>){
 const first:Run={id:'dead-missing-callback',taskId:f.task.id,role:'revision',generation:1,head,base,agentId:'worker',workspaceId:'workspace',profile:f.current().profile,
  status:'running',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,completion:null,released:false};
 const second:Run={...first,id:'dead-uncertain-delivery',status:'uncertain'};
 f.store.putRun(first);f.store.putRun(second);
 f.store.event(f.task.id,'incident',JSON.stringify({id:'missing',role:'worker',runId:first.id,cause:'missing_callback',status:'escalated'}));
 f.store.update(f.task.id,{phase:'changes_requested',reason:'Prompt delivery is uncertain; inspect the retained thread before retrying',
  completion:null,prUrl:null,prHead:null,resumePrNumber:null,
  resolution:{...f.current().resolution,currentRunId:second.id,attention:true,
   recovery:{id:'recovery',key:'incident',generation:1,runId:null,agentId:'coordinator',status:'escalated',summary:'Operator action required',idleSince:null,incidentId:null}}});
 f.adapter.findOpenBranchPr=async()=>[{number:51,url:'https://github.com/example/repo/pull/51',head}];
 f.adapter.verifyPr=async()=>({url:'https://github.com/example/repo/pull/51',head});
 f.adapter.verifyPrIdentity=f.adapter.verifyPr;
 f.adapter.verifyResume=async()=>{};
 return {first,second};
}
test('operator binds a live branch PR after retiring only dead revision leases',async()=>{
 const f=fixture();try{
  const {first,second}=deadRevisionPr(f);const sends=f.sends.length;
  const bound=await f.engine.resolution.adoptReplacementPr(f.current(),51);
  assert.equal(bound.prHead,head);assert.equal(bound.resumePrNumber,51);assert.equal(bound.completion,null);
  assert.equal(bound.resolution.currentRunId,null);assert.equal(bound.resolution.attention,false);
  for(const original of [first,second]){
   const retained=f.store.run(original.id)!;
   assert.equal(retained.released,true);assert.equal(retained.head,original.head);assert.equal(retained.status,original.status);
  }
  await f.engine.wake();assert.equal(f.run().role,'revision');assert.equal(f.run().agentId,'worker');
  assert.equal(f.run().head,head);assert.equal(f.sends.length,sends+1);
  const prompt=f.prompts.at(-1)!;
  assert.match(prompt,/identity-confirmation continuation only/);assert.match(prompt,/PR #51/);
  assert.match(prompt,/Do not edit files, commit, push, create or replace a PR/);
  assert.match(prompt,/Return ready_for_review with prNumber 51/);
  assert.doesNotMatch(prompt,/Resume implementation in this same workspace and PR/,'the recovered read-only intent is never an implementation prompt');
  assert.equal(f.run().identityConfirmation,true,'the reserved run carries the consumed intent');
  assert.equal(f.current().resolution.revisionResumeUnpublished,false,'the task flag is consumed at reservation');
  await f.report('ready_for_review',51);assert.equal(f.current().phase,'reviewing');
 }finally{await f.close()}
});
test('a stale blocked completion does not veto dead-revision PR recovery',async()=>{
 const f=fixture();try{
  const {first,second}=deadRevisionPr(f);
  // The retained worker blocked pre-edit awaiting a ruling, the ruling landed and it
  // continued: the completion is stale evidence, not an accepted delivery.
  f.store.update(f.task.id,{completion:{taskId:f.task.id,runId:'initial',eventId:'blocked-before-edits',status:'blocked',summary:'Stopped before edits; a ruling is required'}});
  assert.equal(f.current().completion?.status,'blocked');
  const bound=await f.engine.resolution.adoptReplacementPr(f.current(),51);
  assert.equal(bound.prHead,head);assert.equal(bound.resumePrNumber,51);
  assert.equal(bound.resolution.currentRunId,null);assert.equal(bound.resolution.attention,false);
  for(const original of [first,second]) assert.equal(f.store.run(original.id)!.released,true);
  await f.engine.wake();assert.equal(f.run().role,'revision');assert.equal(f.run().agentId,'worker');
  await f.report('ready_for_review',51);assert.equal(f.current().phase,'reviewing');
 }finally{await f.close()}
});
test('automatic reconciliation settles a superseded dead revision run, holds the uncertain one, and leaves their branch PR unbound (#339)',async()=>{
 const f=fixture();try{
  const {first,second}=deadRevisionPr(f);
  await f.engine.wake();await f.engine.wake();
  // The first attempt is superseded by binding and observably idle, so the
  // shared settlement releases it with its history kept. The current attempt
  // carries an uncertain delivery and stays held; the branch PR stays unbound
  // for the explicit operator adoption below.
  const settled=f.store.run(first.id)!;
  assert.equal(settled.released,true);assert.equal(settled.status,'superseded');
  assert.equal(settled.completion,null);assert.equal(settled.head,first.head);
  assert.equal(f.store.run(second.id)?.released,false);
  assert.equal(f.current().prUrl,null);assert.equal(f.current().prHead,null);
  assert.equal(f.sends.length,0);
  // The ordinary downstream path still works: the operator adoption binds the
  // branch PR off the held current run.
  const bound=await f.engine.resolution.adoptReplacementPr(f.current(),51);
  assert.equal(bound.prHead,head);assert.equal(bound.resumePrNumber,51);
 }finally{await f.close()}
});
test('dead-revision PR recovery refuses live runs and ambiguous or drifted identity without mutation',async()=>{
 const cases:[string,(f:ReturnType<typeof fixture>,runs:{first:Run;second:Run})=>void,RegExp][]=[
  ['live run',(f,r)=>{f.store.putRun({...r.first,id:'live-revision'});},/only stopped missing-callback/],
  ['zero PRs',f=>{f.adapter.findOpenBranchPr=async()=>[];},/exactly one matching/],
  ['multiple PRs',f=>{f.adapter.findOpenBranchPr=async()=>[{number:51,url:'https://github.com/example/repo/pull/51',head},{number:52,url:'https://github.com/example/repo/pull/52',head}];},/exactly one matching/],
  ['drifted head',f=>{f.adapter.verifyPr=async()=>({url:'https://github.com/example/repo/pull/51',head:'d'.repeat(40)});},/changed during dead-revision/],
  ['worker moved',f=>{f.idle('worker','other-workspace');},/stopped in its task workspace/],
  ['repository changed',f=>{f.adapter.verifyResume=async()=>{throw Error('Continuation worktree belongs to another repository')};},/another repository/],
  ['branch changed',f=>{let proofs=0;f.adapter.verifyResume=async()=>{if(++proofs===2)f.store.update(f.task.id,{branch:'other-branch'});};},/changed during dead-revision/],
  ['base changed',f=>{let proofs=0;f.adapter.verifyResume=async()=>{if(++proofs===2)f.store.update(f.task.id,{baseBranch:'other-base'});};},/changed during dead-revision/],
  ['merge intent',f=>{f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeIntent:true}});},/no merge intent/],
  ['accepted completion',f=>{f.store.update(f.task.id,{completion:{taskId:f.task.id,runId:'initial',eventId:'accepted',status:'ready_for_review',summary:'ready',prNumber:51}});},/Replacement PR adoption requires/],
 ];
 for(const [label,change,reason] of cases){
  const f=fixture();try{
   const runs=deadRevisionPr(f);change(f,runs);const before=f.current(),sends=f.sends.length;
   await assert.rejects(f.engine.resolution.adoptReplacementPr(f.current(),51),reason,label);
   assert.equal(f.store.run(runs.first.id)?.released,false,label);
   assert.equal(f.store.run(runs.second.id)?.released,false,label);
   assert.equal(f.current().prUrl,before.prUrl,label);assert.equal(f.sends.length,sends,label);
  }finally{await f.close()}
 }
});
test('two unresolved faults keep the first reason and settle the task version',async()=>{
 const f=fixture();try{
  f.engine.resolution.attention(f.current(),'First unresolved worker fault');
  f.store.update(f.task.id,{resolution:{...f.current().resolution,
   recovery:{id:'recovery',key:'incident',generation:1,runId:null,agentId:'coordinator',status:'escalated',summary:'Operator action required',idleSince:null,incidentId:null}}});
  const version=f.current().version;
  for(let i=0;i<4;i++){
   f.engine.resolution.attention(f.current(),'Second unresolved worker fault');
   f.engine.resolution.attention(f.current(),'First unresolved worker fault');
  }
  assert.equal(f.current().reason,'First unresolved worker fault');assert.equal(f.current().version,version);
  assert.equal(f.store.events(f.task.id).filter(e=>e.kind==='concurrent_fault'&&e.detail==='Second unresolved worker fault').length,1);
 }finally{await f.close()}
});
test('completed revision reconciles the adopted replacement PR without rewriting the original callback',async()=>{
 const f=fixture();try{
  const replacement='d'.repeat(40);f.setHead(replacement);
  f.store.update(f.task.id,{phase:'changes_requested',reason:"PR must be open, ready, and match the task's branch and base",resumePrNumber:2});
  await f.engine.wake();const revision=f.run();f.idle(revision.agentId!,revision.workspaceId);
  f.engine.resolution.complete({eventId:'wrong-old-pr',taskId:f.task.id,runId:revision.id,status:'ready_for_review',summary:'Fixed findings',prNumber:2},f.tokens.get(revision.id)!);
  await f.engine.resolution.observe();
  f.store.update(f.task.id,{phase:'changes_requested',reason:"PR must be open, ready, and match the task's branch and base"});
  f.adapter.verifyPr=async(t,number)=>{assert.equal(number,2);return{head:replacement,url:'https://github.com/example/repo/pull/2'}};
  const reconciled=await f.engine.resolution.adoptReplacementPr(f.current(),2);
  assert.equal(reconciled.phase,'awaiting_review');assert.equal(reconciled.prHead,replacement);assert.equal(reconciled.completion?.prNumber,1);assert.equal(taskPrNumber(reconciled),2);
 }finally{await f.close()}
});
test('paused results settle in place and no new run is dispatched',async()=>{
 const f=fixture();try{
  await f.engine.wake();const reviewer=f.run();f.store.setMeta('paused',true);await f.report('changes_required');
  assert.equal(f.store.run(reviewer.id)!.released,true,'pause releases the finished reviewer');
  assert.equal(f.creates.filter(run=>run.id!==reviewer.id).length,0,'pause starts no revision');
  assert.equal(f.sends.filter(run=>run.id!==reviewer.id).length,0);
  f.store.setMeta('paused',false);await f.step();
 }finally{await f.close()}
});
test('stale review head blocks all merge effects',async()=>{
 const f=fixture();try{
  await f.engine.wake();f.setHead('d'.repeat(40));await f.report('ready_to_merge');assert.equal(f.current().resolution.attention,true);assert.equal(f.counts().merges,0);
 }finally{await f.close()}
});
test('uncertain merge is reconciled from GitHub without a second merge call',async()=>{
 const f=fixture();try{
  const real=f.adapter.merge;f.adapter.merge=async t=>{await real(t);throw new Error('Response lost')};
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();
  await f.engine.wake();assert.equal(f.current().phase,'closing');assert.equal(f.counts().merges,1);
 }finally{await f.close()}
});
test('a recorded merge intent outranks a stale pre-merge phase and is observed, not reissued (project-a#3618)',async()=>{
 for(const stale of ['verifying','reviewing','awaiting_review'] as const){
  const f=fixture();try{
   const real=f.adapter.merge;f.adapter.merge=async t=>{await real(t);throw new Error('Response lost')};
   await f.engine.wake();await f.reportStep('ready_to_merge');await f.step();
   assert.equal(f.counts().merges,1);assert.equal(f.current().resolution.mergeIntent,true,stale);
   // A legacy reconcile reset the phase while the merge had already landed.
   f.store.update(f.task.id,{phase:stale,reason:'Accepted readiness returned to pre-merge verification',
     resolution:{...f.current().resolution,attention:true,mergeResponseOutcome:'accepted'}});
   await f.engine.wake();await f.engine.wake();await f.engine.wake();
   assert.ok(['syncing','closing','done'].includes(f.current().phase),`${stale}: ${f.current().phase} ${f.current().reason}`);
   assert.equal(f.counts().merges,1,`${stale}: the merge is never reissued`);
   assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='merge_intent_phase_restored').length,1,stale);
  }finally{await f.close()}
 }
});
test('uncertain merge gets one guarded re-issue after the configured continuous proof window',async()=>{
 const f=fixture(false,false,60_000);try{
  const merge=f.adapter.merge!,mergedCheck=f.adapter.merged!;let requests=0,retryAccepted=false;
  f.adapter.merge=async(t,allowed)=>{requests++;await merge(t,allowed);if(requests===1)throw new Error('Response lost');retryAccepted=true};
  f.adapter.merged=async t=>retryAccepted?mergedCheck(t):{merged:false,commit:null,head,base:'main',proof:{proven:true,detail:'open, unmerged, exact head/base, no auto-merge or queue entry, mergeable CLEAN'}};
  await f.engine.wake();await f.reportStep('ready_to_merge');await f.step();await f.step();await f.step();
  assert.equal(f.counts().merges,1);assert.ok(f.current().resolution.mergeProofSince);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeProofSince:new Date(Date.now()-59_000).toISOString()}});
  await f.engine.wake();assert.equal(f.counts().merges,1,'proof shorter than the configured bound does not retry');
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeProofSince:new Date(Date.now()-61_000).toISOString()}});
  await f.engine.wake();assert.equal(f.counts().merges,2);assert.equal(requests,2);
  assert.equal(f.current().resolution.mergeRetryOutcome,'accepted');
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='merge_retry_intent').length,1);
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='uncertain_merge_proof_started').length,1);
  await f.step();assert.equal(f.current().phase,'syncing');assert.equal(f.counts().merges,2);
 }finally{await f.close()}
});
test('uncertain merge uses the two-minute default: no re-issue before it, one re-issue after it',async()=>{
 assert.equal(DEFAULT_UNCERTAIN_MERGE_RETRY_MS,120_000);
 const f=fixture();try{
  const merge=f.adapter.merge!,mergedCheck=f.adapter.merged!;let requests=0,retryAccepted=false;
  f.adapter.merge=async(t,allowed)=>{requests++;await merge(t,allowed);if(requests===1)throw new Error('Response lost');retryAccepted=true};
  f.adapter.merged=async t=>retryAccepted?mergedCheck(t):{merged:false,commit:null,head,base:'main',proof:{proven:true,detail:'open, unmerged, exact head/base, no auto-merge or queue entry, mergeable CLEAN'}};
  await f.engine.wake();await f.reportStep('ready_to_merge');await f.step();await f.step();await f.step();
  assert.equal(f.counts().merges,1);assert.ok(f.current().resolution.mergeProofSince);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeProofSince:new Date(Date.now()-119_000).toISOString()}});
  await f.engine.wake();assert.equal(f.counts().merges,1,'119 s of continuous proof does not re-issue under the default');
  assert.equal(requests,1);assert.equal(f.current().resolution.mergeRetryAt,null);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeProofSince:new Date(Date.now()-121_000).toISOString()}});
  await f.engine.wake();assert.equal(f.counts().merges,2,'121 s of continuous proof re-issues once under the default');
  assert.equal(requests,2);assert.equal(f.current().resolution.mergeRetryOutcome,'accepted');
 }finally{await f.close()}
});
test('a head change or auto-merge request resets the continuous non-merge proof window',async()=>{
 for (const change of ['head','auto-merge'] as const) {
  const f=fixture(false,false,60_000);try{
   const merge=f.adapter.merge!;let observedHead=head,autoMerge=false;
   f.adapter.merge=async(t,allowed)=>{await merge(t,allowed);throw new Error('Response lost')};
   f.adapter.merged=async()=>({merged:false,commit:null,head:observedHead,base:'main',proof:{
    proven:observedHead===head&&!autoMerge,
    detail:JSON.stringify({headMatches:observedHead===head,autoMergeAbsent:!autoMerge}),
   }});
   await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();
   const firstProof=f.current().resolution.mergeProofSince;assert.ok(firstProof);
   f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeProofSince:new Date(Date.now()-59_000).toISOString()}});
   if(change==='head')observedHead='d'.repeat(40);else autoMerge=true;
   await f.engine.wake();assert.equal(f.current().resolution.mergeProofSince,null);
   if(change==='head')observedHead=head;else autoMerge=false;
   await f.engine.wake();assert.ok(f.current().resolution.mergeProofSince);
   assert.equal(f.counts().merges,1,'a reset proof must mature again before the re-issue');
  }finally{await f.close()}
 }
});
test('uncertain merge waits through a shared GitHub outage then observes the merged exact head',async()=>{
 const f=fixture(false,false,60_000);try{
  const merge=f.adapter.merge!;let requests=0,available=false;
  f.adapter.merge=async(t,allowed)=>{requests++;await merge(t,allowed);throw new Error('Response lost')};
  f.adapter.merged=async()=>{if(!available)throw new ForgeOutageError(new Error('offline'));return {merged:true,commit:merged,head,base:'main'}};
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeRequestedAt:new Date(Date.now()-31*60_000).toISOString()}});
  await f.engine.wake();assert.equal(f.current().resolution.attention,false);assert.match(f.current().reason,/GitHub is unavailable/);
  assert.equal(f.current().resolution.incident,null);assert.equal(requests,1);
  assert.ok(Date.now()-Date.parse(f.current().resolution.mergeRequestedAt!) < 60_000);
  available=true;await f.engine.wake();assert.equal(f.current().resolution.mergedCommit,merged);assert.equal(requests,1);
 }finally{await f.close()}
});
test('an uncertain guarded re-issue escalates and retains the repository integration turn',async()=>{
 const f=fixture(false,false,60_000);try{
  const merge=f.adapter.merge!;let requests=0;
  f.adapter.merge=async(t,allowed)=>{requests++;await merge(t,allowed);throw new Error('Response lost')};
  f.adapter.merged=async()=>({merged:false,commit:null,head,base:'main',proof:{proven:true,detail:'exact open unmerged PR; no auto-merge or queue entry'}});
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeProofSince:new Date(Date.now()-61_000).toISOString()}});
  await f.engine.wake();assert.equal(requests,2);assert.equal(f.current().resolution.mergeRetryOutcome,'uncertain');
  await f.engine.wake();
  assert.equal(f.current().phase,'needs_attention');assert.equal(f.current().resolution.attention,true);
  assert.ok(f.current().resolution.integrationTurn);assert.equal(f.engine.resolution.integrationActive(f.current()),true);
  assert.match(f.current().reason,/single guarded re-issue/);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='uncertain_merge_escalated'));
  assert.equal(requests,2,'the uncertain re-issue is never repeated');
 }finally{await f.close()}
});
test('an uncertain re-issue waits only during outage then escalates on healthy or non-outage evidence',async()=>{
 for(const observation of ['open','failed'] as const){
  const f=fixture(false,false,60_000);try{
   const merge=f.adapter.merge!;let requests=0,outage=false;
   f.adapter.merge=async(t,allowed)=>{requests++;await merge(t,allowed);if(requests===2)outage=true;throw new Error('Response lost')};
   f.adapter.merged=async()=>{if(outage)throw new ForgeOutageError(new Error('offline'));if(requests===2&&observation==='failed')throw Error('lookup refused');return {merged:false,commit:null,head,base:'main',proof:{proven:true,detail:'open'}}};
   await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();
   f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeProofSince:new Date(Date.now()-61_000).toISOString()}});
   await f.engine.wake();await f.engine.wake();
   assert.equal(requests,2);assert.equal(f.current().resolution.attention,false);assert.match(f.current().reason,/GitHub is unavailable/);
   outage=false;await f.engine.wake();
   assert.equal(f.current().phase,'needs_attention');assert.equal(requests,2);
  }finally{await f.close()}
 }
});
test('failure to establish the configured proof window within 30 minutes escalates without a retry',async()=>{
 const f=fixture(false,false,60_000);try{
  const merge=f.adapter.merge!;let requests=0;
  f.adapter.merge=async(t,allowed)=>{requests++;await merge(t,allowed);throw new Error('Response lost')};
  f.adapter.merged=async()=>({merged:false,commit:null,head,base:'main',proof:{proven:false,detail:'mergeQueue unavailable'}});
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeRequestedAt:new Date(Date.now()-31*60_000).toISOString()}});
  await f.engine.wake();
  assert.equal(requests,1);assert.equal(f.current().phase,'needs_attention');
  assert.ok(f.current().resolution.integrationTurn);
  assert.match(f.current().reason,/within 30 minutes/);
 }finally{await f.close()}
});
test('sync failure preserves merged identity and never merges again',async()=>{
 const f=fixture();try{
  f.adapter.syncMain=async()=>{throw new Error('Dirty main')};
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.current().phase,'syncing');assert.equal(f.current().resolution.mergedCommit,merged);assert.equal(f.current().resolution.attention,true);assert.equal(f.counts().merges,1);
 }finally{await f.close()}
});
test('closeout recovery waits for normal merge synchronization before reading the merged tree',async()=>{
 const f=fixture();try{
  const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');let authorityChecks=0,workspaceChecks=0;
  f.store.update(f.task.id,{phase:'syncing',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:null}});
  f.adapter.workspaceAvailable=async()=>{workspaceChecks++;return false};
  f.engine.resolution.closeoutAuthority=async()=>{authorityChecks++;throw new Error('merged commit is not fetched')};
  await new Lifecycle(f.engine).pass();
  assert.equal(authorityChecks,0);assert.equal(workspaceChecks,0);assert.equal(f.current().phase,'syncing');assert.equal(f.current().resolution.attention,false);
 }finally{await f.close()}
});
test('a proven-absent reviewer creation is replaced once, then escalates without another launch',async()=>{
 const f=fixture();try{
  let calls=0;f.adapter.createRun=async()=>{calls++;throw new Error('Transport lost')};
  await f.engine.wake();assert.equal(calls,1);assert.equal(f.store.runs(f.task.id).filter(r=>r.role==='reviewer').length,1);
  await f.engine.wake();
  // One automatic replacement ran after the exact lookup proved the creation absent.
  assert.equal(calls,2);assert.equal(f.store.runs(f.task.id).filter(r=>r.role==='reviewer'&&r.released).length,1);
  await f.engine.wake();
  // The second absence escalates to the coordinator instead of looping.
  assert.equal(calls,2);assert.equal(f.current().resolution.attention,true);assert.match(f.current().reason,/also proved absent/);
  assert.equal(f.current().resolution.recovery?.runId ?? null,null);
 }finally{await f.close()}
});

test('blocked closeout can resynchronize main and retry on the retained coordinator',async()=>{
 const f=fixture();try{
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();
  const coordinator=f.run().agentId;await f.report('blocked');assert.equal(f.current().phase,'blocked');
  f.engine.resolution.retry(f.current());assert.equal(f.current().phase,'syncing');await f.engine.wake();await f.engine.wake();assert.equal(f.run().agentId,coordinator);await f.report('closed');assert.equal(f.current().phase,'done');assert.equal(f.counts().merges,1);
 }finally{await f.close()}
});
test('stale review recovery returns to the worker without reusing old approval',async()=>{
 const f=fixture();try{
  await f.engine.wake();f.setHead('d'.repeat(40));await f.report('ready_to_merge');f.engine.resolution.retry(f.current(),true);
  // A fresh worker report is required; no stale approval reaches merge.
  assert.equal(f.current().phase,'changes_requested');assert.equal(f.counts().merges,0);
  await f.engine.wake();assert.equal(f.run().agentId,'worker');
 }finally{await f.close()}
});

test('explicit pre-PR resume reuses the idle worker and requires a fresh run callback',async()=>{
 const f=fixture();try{
  f.adapter.verifyResume=async()=>{};
  const blocked={taskId:f.task.id,runId:'initial',eventId:'initial-blocked',status:'blocked' as const,summary:'Missing dependencies'};
  f.store.update(f.task.id,{phase:'blocked',reason:blocked.summary,completion:blocked,prHead:null,prUrl:null});
  f.adapter.verifyPr=async()=>{throw Error('Pre-PR resume must not inspect a PR')};
  f.engine.resolution.resumeWorker(f.current(),'Run bun install only; do not invoke capture');
  assert.equal(f.current().phase,'changes_requested');
  assert.equal(f.current().reason,'Run bun install only; do not invoke capture');
  await f.engine.wake();const first=f.run();assert.equal(first.role,'revision');assert.equal(first.agentId,'worker');assert.equal(first.head,base);assert.equal(f.sends.length,1);
  f.idle('worker');f.engine.resolution.complete({eventId:'setup-done',taskId:f.task.id,runId:first.id,status:'blocked',summary:'Dependencies ready'},f.tokens.get(first.id)!);
  await f.engine.wake();assert.equal(f.current().phase,'blocked');
  f.engine.resolution.resumeWorker(f.current(),'Invoke capture exactly once');await f.engine.wake();
  assert.equal(f.run().agentId,'worker');assert.notEqual(f.run().id,first.id);assert.equal(f.sends.length,2);
 }finally{await f.close()}
});
test('pre-PR revision ready result establishes the task first accepted PR',async()=>{
 const f=fixture();try{
  f.adapter.verifyResume=async()=>{};
  const blocked={taskId:f.task.id,runId:'initial',eventId:'initial-blocked',status:'blocked' as const,summary:'Waiting for operator evidence'};
  f.store.update(f.task.id,{phase:'blocked',reason:blocked.summary,completion:blocked,prHead:null,prUrl:null});
  let verifiedPr:number|undefined;f.adapter.verifyPr=async(_task,number)=>{verifiedPr=number;return{head,url:`https://github.com/example/repo/pull/${number}`}};
  f.engine.resolution.resumeWorker(f.current(),'Continue under the operator ruling');await f.engine.wake();
  await f.report('ready_for_review',45);const ready=f.current();
  assert.equal(verifiedPr,45);assert.equal(ready.phase,'reviewing');assert.equal(ready.completion?.status,'ready_for_review');assert.equal(ready.completion?.prNumber,45);
  assert.equal(ready.prUrl,'https://github.com/example/repo/pull/45');assert.equal(ready.prHead,head);assert.equal(ready.agentId,'worker');assert.equal(ready.workspaceId,'workspace');
 }finally{await f.close()}
});

test('slot waits preserve the PR revision and pre-PR resume instructions until launch',async()=>{
 const f=fixture();try{
  const review={eventId:'review-required',taskId:f.task.id,runId:'review-run',status:'changes_required' as const,summary:'Fix the escaped route links',head};
  f.store.update(f.task.id,{phase:'changes_requested',reason:review.summary,resolution:{...f.current().resolution,review}});
  const occupied=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Occupy slot',repoPath:'/repo',planningCommit:base,handoffPath:'occupied.md',originAgentId:'origin'}),'host','occupied',base);
  f.store.update(occupied.id,{phase:'working',workspaceIntent:true,workspaceId:'occupied-workspace',directory:'/occupied',agentIntent:true,agentId:'occupied-worker',runId:'occupied-run',profile:f.current().profile,agentActive:true});
  f.store.setMeta('globalLimit',1);
  const revised=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'work',reason:'Return to the retained author'});
  await f.engine.resolution.launch(revised,'revision');
  assert.match(f.current().reason,/Waiting for a project slot/);
  assert.equal(f.current().resolution.pendingWorkerInstruction,'Fix the escaped route links');
  f.store.update(occupied.id,{phase:'done',agentActive:false});
  await f.engine.resolution.launch(f.current(),'revision');
  const revision=f.run();
  assert.equal(revision.instruction,'Fix the escaped route links');
  assert.match(f.prompts.at(-1)!,/Current action: Fix the escaped route links/);
  assert.doesNotMatch(f.prompts.at(-1)!,/Waiting for a project slot/);

  const pre=fixture();try{
   pre.adapter.verifyResume=async()=>base;
   const blocked={eventId:'pre-pr-blocked',taskId:pre.task.id,runId:'initial',status:'blocked' as const,summary:'Waiting for the source contract'};
   const before=pre.store.update(pre.task.id,{phase:'blocked',completion:blocked,prHead:null,prUrl:null,resumePrNumber:null});
   const other=pre.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Occupy pre-PR slot',repoPath:'/repo',planningCommit:base,handoffPath:'occupied-pre.md',originAgentId:'origin'}),'host','occupied',base);
   pre.store.update(other.id,{phase:'working',workspaceIntent:true,workspaceId:'occupied-pre-workspace',directory:'/occupied-pre',agentIntent:true,agentId:'occupied-pre-worker',runId:'occupied-pre-run',profile:pre.current().profile,agentActive:true});
   pre.store.setMeta('globalLimit',1);
   const resumed=pre.engine.resolution.resumeWorker(before,'Run setup only; do not invoke capture');
   await pre.engine.resolution.launch(resumed,'revision');
   assert.match(pre.current().reason,/Waiting for a project slot/);
   pre.store.update(other.id,{phase:'done',agentActive:false});
   await pre.engine.resolution.launch(pre.current(),'revision');
   assert.equal(pre.run().instruction,'Run setup only; do not invoke capture');
   assert.match(pre.prompts.at(-1)!,/Authorized action: Run setup only; do not invoke capture/);
   assert.doesNotMatch(pre.prompts.at(-1)!,/Waiting for a project slot/);
  }finally{await pre.close()}
 }finally{await f.close()}
});

test('daemon transport deferral during a retained prerequisite wait preserves phase and reason',async()=>{
 const f=fixture();try{
  const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Upstream',repoPath:'/repo',planningCommit:base,handoffPath:'upstream.md',originAgentId:'origin'}),'host','upstream',base);
  f.store.update(prerequisite.id,{phase:'working'});
  const current=f.store.update(f.task.id,{phase:'changes_requested',reason:'Keep the accepted review action visible'});
  const waiting=f.store.setPrerequisiteWait(current,[prerequisite.id],'Wait for upstream evidence',current.version);
  const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');
  const lifecycle=new Lifecycle(f.engine),recover=lifecycle.recover.bind(lifecycle);
  lifecycle.recover=async task=>{if(task.id===waiting.id)throw new Error('Daemon client closed');await recover(task)};
  await lifecycle.enqueuePass();
  const after=f.current();
  assert.equal(after.phase,'changes_requested');
  assert.equal(after.reason,'Keep the accepted review action visible');
  assert.equal(after.resolution.attention,false);
  assert.ok(after.prerequisiteWait&&!after.prerequisiteWait.releasedAt);
  assert.ok(f.store.events(after.id).some(event=>event.kind==='transport_deferred'&&/Daemon client closed/.test(event.detail)));
 }finally{await f.close()}
});

test('pre-PR resume rejects absent authority and unresolved delivery',async()=>{
 const f=fixture();try{
  assert.throws(()=>f.engine.resolution.resumeWorker(f.current(),'Try again'),/blocked result or stopped pre-callback worker/);
  const blocked={taskId:f.task.id,runId:'initial',eventId:'initial-blocked',status:'blocked' as const,summary:'Blocked'};
  f.store.update(f.task.id,{phase:'blocked',completion:blocked,prHead:null,prUrl:null});
  assert.throws(()=>f.engine.resolution.resumeWorker(f.current(),'   '),/explicit instruction/);
  f.store.putRun({id:'unresolved',taskId:f.task.id,role:'revision',generation:1,head:base,base,agentId:'worker',workspaceId:'workspace',profile:f.current().profile,profileGroup:null,status:'uncertain',createdAt:new Date().toISOString(),lastObservedAt:null,active:null,idleSince:null,completion:null,released:false});
  assert.throws(()=>f.engine.resolution.resumeWorker(f.current(),'Prepare only'),/uncertain delivery/);
 }finally{await f.close()}
});

test('explicit skip merges without reviewer or verification and still runs coordinator closeout',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{skipPRReview:true});
  await f.step();assert.equal(f.current().phase,'merging');assert.equal(f.creates.length,0);
  await f.step();assert.equal(f.counts().merges,1);assert.equal(f.counts().reviewChecks,0);
  await f.engine.wake();assert.equal(f.current().phase,'closing');
  await f.engine.wake();assert.equal(f.run().role,'closeout');assert.equal(f.creates.length,1);
  await f.report('closed');assert.equal(f.current().phase,'done');
 }finally{await f.close()}
});
test('skip review honors pause, running worker lease and failing merge gates',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{skipPRReview:true});f.store.setMeta('paused',true);
  await f.engine.wake();assert.equal(f.current().phase,'awaiting_review');
  f.store.setMeta('paused',false);await f.step();
  f.states.set('worker',{...f.states.get('worker')!,active:true,status:'running'});await f.engine.wake();assert.equal(f.counts().merges,0);
  f.idle('worker');f.adapter.mergeGate=async()=>({head,base,wait:'Required checks pending'});await f.engine.wake();assert.equal(f.counts().merges,0);assert.match(f.current().reason,/Required checks/);
  assert.equal(f.current().resolution.attention,false);
  // A failed required check at the reviewed head is a semantic refusal: the same PR returns
  // to the retained worker under the revision budget with the check's name and job URL.
  f.adapter.mergeGate=async()=>({head,base,wait:'PR checks failed: routes (job URL: https://github.com/example/repo/actions/runs/9)',checksFailed:true});await f.engine.wake();
  assert.equal(f.counts().merges,0);assert.equal(f.current().resolution.attention,false);
  assert.equal(f.current().phase,'changes_requested');assert.match(f.store.events(f.task.id).find(event=>event.kind==='pre_merge_refused')?.detail ?? '',/routes \(job URL: https:\/\/github.com\/example\/repo\/actions\/runs\/9\)/);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='pre_merge_refused'));
  await f.engine.wake();assert.equal(f.run().role,'revision');assert.equal(f.run().agentId,'worker');
  await f.reportStep('ready_for_review');await f.step();assert.equal(f.current().phase,'merging');
  f.adapter.mergeGate=async()=>({head:'d'.repeat(40),base,wait:''});await f.engine.wake();assert.equal(f.counts().merges,0);assert.equal(f.current().resolution.attention,true);
 }finally{await f.close()}
});
test('move to review supersedes accepted credit, settles a parked episode and dispatches a fresh reviewer, then preserves that reader',async()=>{
 const f=fixture();try{
  await f.engine.wake();const firstReviewer=f.run();await f.reportStep('ready_to_merge');
  assert.equal(f.current().resolution.review?.status,'ready_to_merge');
  // Parked as an episode Queue's own controls could not clear.
  f.engine.resolution.ensureIncident(f.current(),null,'Stuck after review');
  f.store.update(f.task.id,{phase:'needs_attention',reason:'Stuck after review',resolution:{...f.current().resolution,attention:true,
    incident:{...f.current().resolution.incident!,status:'escalated'}}});
  const moved=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'review',reason:'Fresh review of the current head'});
  assert.equal(moved.phase,'awaiting_review');assert.equal(moved.resolution.review,null);assert.equal(moved.resolution.attention,false);
  assert.equal(moved.resolution.incident!.status,'resolved');assert.match(moved.resolution.incident!.detail,/original: Stuck after review/);
  assert.equal(moved.resolution.reviewSupersessions.length,1);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='owner_control'&&JSON.parse(event.detail).verb==='move'));
  await f.engine.wake();
  const reviewer=f.run();assert.equal(reviewer.role,'reviewer');assert.notEqual(reviewer.id,firstReviewer.id,'a fresh reviewer run');
  // Tom, 2026-10-27: a second move to review preserves the reader that is still
  // reading this exact head instead of replacing it (a fresh reader is chosen
  // deliberately with restart role=reviewer fresh or route role=reviewer now).
  f.states.set(reviewer.agentId!,{...f.states.get(reviewer.agentId!)!,status:'running',active:true} as never);
  const again=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'review',reason:'again'});
  assert.equal(again.phase,'reviewing');
  assert.equal(again.resolution.currentRunId,reviewer.id,'the reading reviewer is preserved');
  assert.equal(f.store.run(reviewer.id)!.released,false);
  assert.ok(!f.store.events(f.task.id).some(event=>event.kind==='owner_stop_sent'),'a reading reviewer turn is not cancelled');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='owner_control'&&JSON.parse(event.detail).preserved===reviewer.id),
   'the move records the preserved reader');
 }finally{await f.close()}
});

test('failed checks at the cap continue the open round without parking',async()=>{
 const f=fixture();try{
  recordAcceptedReview(f,'merging');
  f.store.update(f.task.id,{resolution:{...f.current().resolution,revisionRuns:REVISION_BUDGET}});
  let gateReads=0;f.adapter.mergeGate=async()=>{gateReads++;return{head,base,wait:'PR checks failed: lint (job URL: https://github.com/example/repo/actions/runs/9)',checksFailed:true}};
  await f.engine.resolution.advance(f.current());
  assert.equal(f.counts().merges,0);
  assert.equal(f.current().phase,'changes_requested',f.current().reason);
  assert.equal(f.current().resolution.pendingRevisionCause,'pre_merge');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='pre_merge_refused'));
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='revision_budget_exhausted').length,0,'a pre-merge refusal never parks at the revision cap');
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.equal(f.run().revisionCause,'pre_merge');
  assert.equal(f.current().resolution.revisionRuns,REVISION_BUDGET,'a pre-merge refusal consumes no review round');
 }finally{await f.close()}
});
test('an overdue runnerless queued check waits for cancellation before its one same-head rerun',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{skipPRReview:true});
  const job='https://github.com/example/repo/actions/runs/9/job/1';
  const queued={head,base,wait:`Required check 'build' has been pending past its deadline (31m elapsed, bound 30m); job URL: ${job}`,overdue:true as const,pendingCheck:true as const};
  const infra={head,base,wait:`Required checks cancelled before running (hosted-runner acquisition): build (job URL: ${job})`,infrastructure:true as const,infraRunIds:['9']};
  let status:'queued'|'cancelled'='queued';
  f.adapter.mergeGate=async()=>status==='queued'?queued:infra;
  await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,0);
  assert.equal(f.current().phase,'merging');
  assert.equal(f.current().resolution.attention,true,'an overdue check raises attention while polling continues');
  assert.match(f.current().reason,/has been pending past its deadline/);
  assert.ok(f.current().resolution.integrationTurn,'a pending runner wait keeps its FIFO sequence while yielding');
  assert.deepEqual(f.reruns,[],'a still-queued Actions run cannot consume rerun intent');
  assert.ok(!f.store.getMeta(`checkInfraRetry:${f.task.id}:${head}`),'no durable rerun intent exists while the workflow is still queued');

  status='cancelled';
  f.store.setMeta(requiredCheckPollMetaKey(f.task.id,head),{head,nextAt:0});
  await f.engine.wake();
  assert.deepEqual(f.reruns,[['9']],'the cancellation is re-observed and dispatched once under durable intent');
  assert.equal(f.store.getMeta<{at:string;runs:string[];status:string}>(`checkInfraRetry:${f.task.id}:${head}`)?.status,'reran');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='check_infrastructure_rerun'));
  assert.ok(!f.store.events(f.task.id).some(event=>event.kind==='pre_merge_refused'),'infrastructure never records a semantic refusal');
  assert.ok(!f.store.events(f.task.id).some(event=>event.kind==='revision_requested'),'infrastructure never revises the worker');
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='revision').length,0,'no revision run is launched');
 }finally{await f.close()}
});
test('an overdue queued required check gets one recovery look, then waits and escalates once',async()=>{
 const f=fixture();const realNow=Date.now;let fakeNow=Date.parse('2026-11-12T14:00:00.000Z');Date.now=()=>fakeNow;try{
  f.adapter.supportsCoordinatorRecovery=true;
  recordAcceptedReview(f,'merging');
  const key='Stable process-spawning nextest\u0000https://github.com/example/repo/actions/runs/9/job/1';
  const job='https://github.com/example/repo/actions/runs/9/job/1';
  const queued={head,base,wait:`Required check 'Stable process-spawning nextest' (queued, no runner yet) has been pending past its deadline (16m elapsed, bound 15m); runner label: macos-latest; job URL: ${job}`,overdue:true as const,pendingCheck:true as const,
   overdueCheck:{key,name:'Stable process-spawning nextest',state:'QUEUED',elapsedMs:16*60_000,jobUrl:job,runnerLabels:['macos-latest']}};
  f.adapter.mergeGate=async()=>queued;
  await f.engine.wake();
  let poll=f.store.getMeta<any>(requiredCheckPollMetaKey(f.task.id,head));
  assert.ok(poll?.recoveryRunId,'the first overrun launches the one recovery look');
  const recovery=f.store.run(poll.recoveryRunId)!;
  assert.equal(recovery.role,'recovery');
  assert.match(f.current().reason,/queued, no runner yet/);
  assert.match(f.current().reason,/macos-latest/);

  // Simulate the recovery reporting no actionable change. The forge still says QUEUED.
  f.store.putRun({...recovery,released:true,status:'finished'});
  f.store.update(f.task.id,{resolution:{...f.current().resolution,recoveryActive:false}});
  poll={...poll,nextAt:0};f.store.setMeta(requiredCheckPollMetaKey(f.task.id,head),poll);
  fakeNow+=20*60_000;
  await f.engine.wake();
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,1,'an unchanged queued check never starts a second recovery');
  assert.equal(f.current().resolution.attention,false,'the one recovery returns the task to a visible wait');
  assert.match(f.current().reason,/Stable process-spawning nextest/);
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='incident').map(event=>JSON.parse(event.detail).id).filter((id,index,ids)=>ids.indexOf(id)===index).length,1,'repeat polls retain one incident identity');

  fakeNow+=45*60_000;poll={...f.store.getMeta<any>(requiredCheckPollMetaKey(f.task.id,head)),nextAt:0};f.store.setMeta(requiredCheckPollMetaKey(f.task.id,head),poll);
  await f.engine.wake();
  assert.equal(f.current().resolution.attention,true,'a queued job still waiting after an hour reaches planner attention');
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,1,'the longer wait does not reopen recovery');
  assert.match(f.current().reason,/macos-latest/);
  const incidentIds=f.store.events(f.task.id).filter(event=>event.kind==='incident').map(event=>JSON.parse(event.detail).id);
  assert.equal(new Set(incidentIds).size,1,'the one-hour attention reuses the original check incident');

  // A started job remains on the normal poll path and does not generate a new recovery.
  f.adapter.mergeGate=async()=>({...queued,wait:`Required check 'Stable process-spawning nextest' (in_progress for 61m) has been pending past its deadline (61m elapsed, bound 15m); job URL: ${job}`,
   overdueCheck:{...queued.overdueCheck,state:'IN_PROGRESS',elapsedMs:61*60_000,runnerLabels:[]}});
  poll={...f.store.getMeta<any>(requiredCheckPollMetaKey(f.task.id,head)),nextAt:0};f.store.setMeta(requiredCheckPollMetaKey(f.task.id,head),poll);
  await f.engine.wake();
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,1);
  f.adapter.mergeGate=async()=>({head,base,wait:''});
  poll={...f.store.getMeta<any>(requiredCheckPollMetaKey(f.task.id,head)),nextAt:0};f.store.setMeta(requiredCheckPollMetaKey(f.task.id,head),poll);
  await f.engine.wake();
  assert.equal(f.counts().merges,1,'a passing check clears the wait and the existing merge path continues by itself');
 }finally{Date.now=realNow;await f.close()}
});
test('a recovery move to merge keeps a same-head running check as a wait through an hour',async()=>{
 const f=fixture();const realNow=Date.now;let fakeNow=Date.parse('2026-11-12T14:00:00.000Z');Date.now=()=>fakeNow;try{
  f.adapter.supportsCoordinatorRecovery=true;
  recordAcceptedReview(f,'verifying');
  const job='https://github.com/example/repo/actions/runs/9/job/1';
  const queued={head,base,wait:`Required check 'Stable process-spawning nextest' has been pending past its deadline (16m elapsed, bound 15m); job URL: ${job}`,overdue:true as const,pendingCheck:true as const,
   overdueCheck:{key:`Stable process-spawning nextest\u0000${job}`,name:'Stable process-spawning nextest',state:'QUEUED',elapsedMs:16*60_000,jobUrl:job,runnerLabels:['macos-latest']}};
  f.adapter.mergeGate=async()=>queued;
  await f.engine.wake();
  const poll=f.store.getMeta<any>(requiredCheckPollMetaKey(f.task.id,head));
  assert.ok(poll?.recoveryRunId,'the initial overrun gets its one recovery');
  const recovery=f.store.run(poll.recoveryRunId)!;
  f.idle(recovery.agentId!,recovery.workspaceId);
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:recovery.id,status:'recovered',summary:'The exact-head review remains valid; let the merge gate continue',
    coordinatorAction:{verb:'move',to:'merge',reason:'The accepted review is valid and the remaining work is the normal merge gate'},coordinatorGeneration:recovery.generation},f.tokens.get(recovery.id)!);
  await f.engine.resolution.recovery.pass();
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='coordinator_action_applied'), 'the recovery move is accepted');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='owner_control'&&JSON.parse(event.detail).to==='merge'), 'the accepted owner action moves to the merge gate');
  assert.ok(['verifying','merging'].includes(f.current().phase),'the merge action re-enters the exact-head gate path');
  assert.equal(f.store.run(recovery.id)?.released,true);

  f.adapter.mergeGate=async()=>({head,base,wait:'PR checks are pending',pendingCheck:true});
  for(let minute=1;minute<=60;minute+=5){
   fakeNow+=5*60_000;
   const state=f.store.getMeta<any>(requiredCheckPollMetaKey(f.task.id,head));
   f.store.setMeta(requiredCheckPollMetaKey(f.task.id,head),{...state,nextAt:0});
   await f.engine.wake();
   const current=f.current();
   assert.notEqual(current.resolution.stop?.reason,'operator_needed',`minute ${minute}: a pending result remains a wait`);
   assert.equal(current.resolution.attention,false,`minute ${minute}: queued or running checks do not become attention`);
   assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,1,`minute ${minute}: the recovery is not re-entered`);
   const retained=f.store.getMeta<any>(requiredCheckPollMetaKey(f.task.id,head));
   assert.equal(retained.recoveryRunId,recovery.id,'generic wording keeps the same-head one-recovery record');
   if(minute===1){
    await f.engine.resolution.recovery.route(current);
    assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,1,'recovery routing recognizes the pending-check wait after wording changes');
   }
  }

  f.adapter.mergeGate=async()=>({head,base,wait:''});
  const state=f.store.getMeta<any>(requiredCheckPollMetaKey(f.task.id,head));
  f.store.setMeta(requiredCheckPollMetaKey(f.task.id,head),{...state,nextAt:0});
  await f.engine.wake();
  assert.equal(f.counts().merges,1,'a green check resumes the existing merge path');
 }finally{Date.now=realNow;await f.close()}
});
test('a failed same-head rerun dispatch escalates once instead of revising the worker',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{skipPRReview:true});
  const job='https://github.com/example/repo/actions/runs/9/job/1';
  f.adapter.mergeGate=async()=>({head,base,wait:`Required checks cancelled before running (hosted-runner acquisition): build (job URL: ${job})`,infrastructure:true as const,infraRunIds:['9']});
  f.adapter.rerunFailedWorkflowRuns=async()=>{throw new Error('GitHub rerun refused');};
  for (let i=0;i<6 && !f.store.events(f.task.id).some(event=>event.kind==='check_infrastructure_rerun_failed');i++) await f.engine.wake();
  assert.equal(f.current().resolution.attention,true);
  assert.match(f.current().reason,/same-head rerun could not be dispatched/);
  assert.ok(!f.store.events(f.task.id).some(event=>event.kind==='revision_requested'),'a dispatch failure never revises the worker');
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='revision').length,0,'no revision run is launched');
 }finally{await f.close()}
});
test('review skip is opt-in, survives reload and cannot change through duplicate submission',async()=>{
 const f=fixture();try{
  const input=submissionSchema.parse({submissionId:'skip-test',title:'Content',repoPath:'/repo',planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'});
  assert.equal(input.skipPRReview,false);const task=f.store.insert(input,'host','handoff',base);
  assert.equal(f.store.existing({...input,skipPRReview:false})?.id,task.id);
  assert.throws(()=>f.store.existing({...input,skipPRReview:true}),/different content/);
  const skipped=f.store.insert({...input,submissionId:'skip-enabled',skipPRReview:true},'host','handoff',base);
  assert.equal(f.store.task(skipped.id).skipPRReview,true);
  const legacy:any=f.store.task(task.id);delete legacy.skipPRReview;f.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(legacy),task.id);
  assert.equal(f.store.task(task.id).skipPRReview,false);
 }finally{await f.close()}
});

test('quota error during revision replaces worker, preserves PR and re-reviews the new head',async()=>{
 const f=fixture(false,false,undefined,true);try{
  await f.engine.wake();const reviewer=f.run().agentId;await f.report('changes_required');await f.engine.wake();const revision=f.run();
  f.store.setMeta('pool',[...f.store.pool(),{profileId:'replacement',enabled:true,group:'replacement',weight:1,roles:['worker'],scopes:['general']}]);
  f.engine.profiles.push(profile('replacement'));f.adapter.verifyResume=async()=>{};
  f.idle('worker');f.states.set('worker',{...f.states.get('worker')!,error:'usage_limit_reached',model:'author'});
  let replacementToken='';f.adapter.createAgent=async(t,token,prompt)=>{replacementToken=token;assert.match(prompt,/Reuse PR #1/);f.idle('replacement-worker');f.states.set('replacement-worker',{...f.states.get('replacement-worker')!,model:'replacement'});return{id:'replacement-worker',workspaceId:t.workspaceId}};
  await f.engine.wake();assert.equal(f.current().agentId,'replacement-worker');assert.equal(f.current().resumePrNumber,1);assert.equal(f.store.run(revision.id)?.status,'superseded');
  await assert.rejects(f.engine.complete({eventId:'wrong-pr',taskId:f.task.id,runId:f.current().runId!,status:'ready_for_review',summary:'wrong',prNumber:2},replacementToken),/existing PR/);
  const revisedHead=f.setHead('e'.repeat(40));await f.engine.complete({eventId:'new-pr-head',taskId:f.task.id,runId:f.current().runId!,status:'ready_for_review',summary:'updated',prNumber:1},replacementToken);await f.engine.wake();await f.engine.wake();assert.equal(f.current().prHead,revisedHead);assert.equal(f.run().role,'reviewer');assert.equal(f.run().agentId,reviewer);
 }finally{await f.close()}
});

test('reviewer quota failure replaces only the reviewer, keeps workspace and rejects old callbacks',async()=>{
 const f=fixture();try{
  await f.engine.wake();const old=f.run();const backup=profile('review-backup');f.engine.profiles.push(backup);f.store.setMeta('pool',[...f.store.pool(),{profileId:backup.id,enabled:true,roles:['reviewer'],group:'review-backup',weight:1,scopes:['general']}]);
  f.idle(old.agentId!);f.states.set(old.agentId!,{...f.states.get(old.agentId!)!,error:'quota_exceeded'});await f.engine.wake();
  assert.equal(f.store.run(old.id)?.status,'superseded');assert.equal(f.run().profile?.id,backup.id);assert.equal(f.run().workspaceId,old.workspaceId);assert.equal(f.current().agentId,'worker');assert.equal(f.current().resolution.roleReplacements,1);
  assert.throws(()=>f.engine.resolution.complete({eventId:'stale-review',taskId:f.task.id,runId:old.id,status:'ready_to_merge',summary:'late',head,reviewCommentId:1},f.tokens.get(old.id)!),/Unauthorized callback/);
  assert.equal(f.store.run(old.id)?.completion,null,'a revoked reviewer records no verdict');
  await f.reportStep('ready_to_merge');assert.equal(f.current().phase,'verifying');
 }finally{await f.close()}
});
test('a transient reviewer provider error resumes the same run and exact head before its callback completes',async()=>{
 const f=fixture();try{
  await f.engine.wake();const first=f.run(),headBefore=first.head,tokenBefore=f.tokens.get(first.id)!;
  f.states.set(first.agentId!,{id:first.agentId!,workspaceId:first.workspaceId,status:'error',active:false,permissions:false,error:'opencode-go API error (429): rate_limit_error; retry after a brief wait',updatedAt:new Date().toISOString()});
  await f.engine.wake();
  const waiting=f.store.run(first.id)!;
  assert.equal(waiting.transientProviderRetry?.status,'waiting');assert.equal(waiting.transientProviderRetry?.resumes,0);
  f.store.putRun({...waiting,transientProviderRetry:{...waiting.transientProviderRetry!,retryAt:'2000-01-01T00:00:00.000Z'}});
  await f.engine.wake();
  const resumed=f.run();
  assert.equal(resumed.id,first.id);assert.equal(resumed.head,headBefore);assert.equal(resumed.transientProviderRetry?.status,'sent');
  assert.equal(resumed.transientProviderRetry?.resumes,1);assert.equal(f.continuations.length,1);
  assert.equal(f.continuations[0].run.id,first.id);assert.equal(f.continuations[0].run.head,headBefore);
  assert.match(f.continuations[0].text,/Continue where you left off; report via your existing authenticated callback/);
  assert.equal(f.tokens.get(first.id),tokenBefore,'continuation retains the original callback credential');
  await f.reportStep('ready_to_merge');
  assert.equal(f.current().phase,'verifying');assert.equal(f.store.run(first.id)?.completion?.status,'ready_to_merge');
 }finally{await f.close()}
});
test('a reviewer thread that resumes before its scheduled continuation clears its own provider wait',async()=>{
 const f=fixture();try{
  await f.engine.wake();const first=f.run();
  f.states.set(first.agentId!,{id:first.agentId!,workspaceId:first.workspaceId,status:'error',active:false,permissions:false,error:'opencode-go API error (429): rate_limit_error; retry after a brief wait',updatedAt:new Date().toISOString()});
  await f.engine.wake();
  assert.equal(f.current().resolution.stop?.reason,'provider_unavailable','the transient error records a provider wait');
  // The thread recovers on its own before the scheduled continuation.
  f.states.set(first.agentId!,{id:first.agentId!,workspaceId:first.workspaceId,status:'running',active:true,permissions:false,error:'',updatedAt:new Date().toISOString()});
  for(let pass=0;pass<3;pass++)await f.engine.wake();
  assert.equal(f.store.run(first.id)?.transientProviderRetry,undefined);
  assert.notEqual(f.current().resolution.stop?.reason,'provider_unavailable','a live thread is not waiting on its provider');
 }finally{await f.close()}
});
test('a live run without its own transient retry leaves another run\'s provider wait alone',async()=>{
 const f=fixture();try{
  await f.engine.wake();const reviewer=f.run();
  f.states.set(reviewer.agentId!,{id:reviewer.agentId!,workspaceId:reviewer.workspaceId,status:'error',active:false,permissions:false,error:'opencode-go API error (429): rate_limit_error; retry after a brief wait',updatedAt:new Date().toISOString()});
  await f.engine.wake();
  const stop=f.current().resolution.stop;
  assert.equal(stop?.reason,'provider_unavailable');
  // A healthy coordinator is observed live: with no retry of its own, and with
  // an earlier retry that already resumed and progressed.
  const progressed={...f.store.run(reviewer.id)!.transientProviderRetry!,runId:'live-coordinator',status:'sent' as const,sawProgress:true,resumes:1};
  for(const transientProviderRetry of [undefined,progressed]){
   const coordinator={...reviewer,id:'live-coordinator',role:'recovery' as const,agentId:'coordinator-agent',transientProviderRetry,completion:null,released:false};
   await f.engine.resolution.resumeTransientProviderThread(f.current(),coordinator as never,{id:'coordinator-agent',workspaceId:reviewer.workspaceId,status:'running',active:true,permissions:false,error:''} as never);
   assert.deepEqual(f.current().resolution.stop,stop,`the reviewer is still waiting on its provider (${transientProviderRetry?'progressed':'no'} coordinator retry)`);
  }
 }finally{await f.close()}
});
test('four transient provider resumes stay on the same reviewer run, then raise attention with evidence',async()=>{
 const f=fixture();try{
  await f.engine.wake();const first=f.run(),agent=first.agentId!,runId=first.id,headBefore=first.head;
  const error='HTTP 429 rate_limit_error; retry after a brief wait';
  const reportError=(offset:number)=>f.states.set(agent,{id:agent,workspaceId:first.workspaceId,status:'error',active:false,permissions:false,error,updatedAt:new Date(Date.now()+offset*1000).toISOString()});
  const due=()=>{const latest=f.store.run(runId)!;f.store.putRun({...latest,transientProviderRetry:{...latest.transientProviderRetry!,retryAt:'2000-01-01T00:00:00.000Z'}})};
  reportError(1);await f.engine.wake();
  for(let attempt=1;attempt<=4;attempt++){
   due();await f.engine.wake();
   assert.equal(f.run().id,runId);assert.equal(f.run().head,headBefore);
   assert.equal(f.continuations.length,attempt);assert.equal(f.store.run(runId)?.transientProviderRetry?.resumes,attempt);
   reportError(attempt+1);await f.engine.wake();
  }
  assert.equal(f.current().resolution.attention,true);assert.match(f.current().reason,/persisted after 4 same-thread resumes/);assert.match(f.current().reason,/rate_limit_error/);
  assert.equal(f.current().resolution.roleReplacements,0);assert.equal(f.current().resolution.currentRunId,runId);
  assert.equal(f.store.run(runId)?.status,'running');assert.equal(f.run().head,headBefore);
 }finally{await f.close()}
});
test('coordinator exhaustion is stored while paused, then replaced with a fenced generation',async()=>{
 const f=fixture();try{
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();const old=f.run();assert.equal(old.role,'closeout');
  const backup=profile('coord-backup');f.engine.profiles.push(backup);f.store.setMeta('pool',[...f.store.pool(),{profileId:backup.id,enabled:true,roles:['coordinator'],group:'coord-backup',weight:1,scopes:['general'],capability:'low',cost:'very_low'}]);
  f.store.setMeta('paused',true);f.idle(old.agentId!);f.states.set(old.agentId!,{...f.states.get(old.agentId!)!,error:'usage limit reached'});
  const result:Completion={eventId:'coord-exhausted',taskId:f.task.id,runId:old.id,status:'blocked',summary:'Subscription exhausted',providerUnavailable:true,coordinatorGeneration:old.generation};
  f.engine.resolution.complete(result,f.tokens.get(old.id)!);await f.engine.wake();assert.equal(f.current().coordinatorGeneration,old.generation);assert.equal(f.store.db.prepare('SELECT * FROM availability').all().length,0);
  f.store.setMeta('paused',false);await f.engine.wake();assert.equal(f.current().coordinatorGeneration,old.generation+1);assert.equal(f.run().profile?.id,backup.id);assert.notEqual(f.run().agentId,old.agentId);
  // #1005: replacement releases the exhausted run and revokes its credential.
  assert.equal(f.store.run(old.id)?.released,true);
  const replacement=f.run();
  assert.throws(()=>f.engine.resolution.complete(result,f.tokens.get(old.id)!),/Unauthorized callback/);
  assert.deepEqual(f.run(),replacement,'a revoked callback cannot change the replacement');
 }finally{await f.close()}
});
test('closeout provider replacement refreshes main without repeating merge',async()=>{
 const f=fixture();try{
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();const old=f.run();assert.equal(old.role,'closeout');assert.ok(old.profile);
  const backup=profile('closeout-backup');f.engine.profiles.push(backup);f.store.setMeta('pool',[...f.store.pool(),{profileId:backup.id,enabled:true,roles:['coordinator'],group:'backup',weight:1,scopes:['general'],capability:'low',cost:'very_low'}]);
  f.idle(old.agentId!);f.states.set(old.agentId!,{...f.states.get(old.agentId!)!,error:'usage_limit_reached'});await f.engine.wake();await f.engine.wake();assert.equal(f.run().role,'closeout');assert.equal(f.run().profile?.id,backup.id);assert.equal(f.counts().merges,1);assert.equal(f.counts().syncs,2);await f.report('closed');assert.equal(f.current().phase,'done');
 }finally{await f.close()}
});

test('a live-shaped merged task with a blocked review closes out without an open PR or recovery coordinator',async()=>{
 const f=fixture();try{
  recordBlockedSourceApproval(f);
  const openPr='PR must be open, ready, and match the task branch and base';
  f.adapter.verifyPrIdentity=async()=>{throw Error(openPr)};
  f.adapter.verifyPr=async()=>{throw Error(openPr)};
  f.adapter.externalMerge=async()=>({head,commit:merged});
  f.adapter.merged=async()=>({merged:true,commit:merged,head,base:'main'});
  assert.equal(proofWaitApplies(f.current()),true);
  assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()),true);
  assert.equal(f.current().phase,'syncing');
  assert.equal(f.current().resolution.mergedCommit,merged);
  assert.equal(f.current().resolution.mergedWithNone,true);
  assert.equal(proofWaitApplies(f.current()),false);
  enableRecovery(f);
  await f.engine.wake();
  await f.engine.wake();
  assert.equal(f.store.runs(f.task.id).some(run=>run.role==='recovery'),false,JSON.stringify(f.store.runs(f.task.id).map(run=>run.role)));
  assert.equal(f.run().role,'closeout');
  await f.report('closed');
  assert.equal(f.current().phase,'done');
  assert.equal(f.current().resolution.mergedWithNone,true);
  assert.equal(f.current().resolution.review?.status,'blocked');
 }finally{await f.close()}
});
test('an external merge observed during a running recovery settles the episode and closes out',async()=>{
 const f=fixture();try{
  recordBlockedSourceApproval(f);
  const openPr='PR must be open, ready, and match the task branch and base';
  f.adapter.verifyPrIdentity=async()=>{throw Error(openPr)};
  f.adapter.verifyPr=async()=>{throw Error(openPr)};
  f.adapter.externalMerge=async()=>({head,commit:merged});
  f.adapter.merged=async()=>({merged:true,commit:merged,head,base:'main'});
  // A coordinator recovery run is live, and its incident still reconciling, when the merge is observed.
  const recovery:Run={id:'live-recovery',taskId:f.task.id,role:'recovery',generation:f.current().coordinatorGeneration,head,base,agentId:'live-recovery-agent',workspaceId:'workspace',profile:null,status:'running',createdAt:new Date().toISOString(),lastObservedAt:null,active:true,idleSince:null,completion:null,released:false};
  f.store.putRun(recovery);
  const at=new Date().toISOString();
  f.store.update(f.task.id,{resolution:{...f.current().resolution,recoveryActive:true,
   recovery:{id:'episode',key:'k',generation:f.current().coordinatorGeneration,runId:recovery.id,agentId:recovery.agentId,status:'running',summary:'',idleSince:null,incidentId:'live-incident'},
   incident:{id:'live-incident',role:'recovery',runId:recovery.id,fingerprint:'live-incident',attempt:1,cause:'coordinator_missing',detail:'Coordinator stalled',action:'',status:'reconciling',createdAt:at,updatedAt:at}}});
  assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()),true);
  const observed=f.current();
  assert.equal(f.store.run(recovery.id)!.released,true,'the merge supersedes the live recovery run');
  assert.equal(observed.phase,'syncing');
  assert.equal(observed.resolution.recoveryActive,false,'the episode it passed through is settled');
  assert.equal(observed.resolution.recovery?.status,'resolved');
  assert.equal(observed.resolution.incident?.status,'resolved');
  assert.equal(observed.resolution.stop,null);
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='recovery_episode_settled').length,1);
  enableRecovery(f);
  await f.engine.wake();await f.engine.wake();
  assert.equal(f.store.runs(f.task.id).some(run=>run.role==='recovery'&&!run.released),false,'no recovery coordinator is launched for the merged task');
  assert.equal(f.run().role,'closeout');
  await f.report('closed');
  assert.equal(f.current().phase,'done');
 }finally{await f.close()}
});
test('an unmerged PR with a blocked review still refuses closeout and keeps the proof wait',async()=>{
 const f=fixture();try{
  recordBlockedSourceApproval(f);
  f.adapter.externalMerge=async()=>null;
  f.adapter.merged=async()=>({merged:false,commit:null,head,base:'main'});
  assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()),false);
  await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'closeout',reason:'Close a still-open PR'}),/not merged|not confirmed merged/i);
  assert.equal(f.current().resolution.mergedCommit,null);
  assert.equal(proofWaitApplies(f.current()),true);
 }finally{await f.close()}
});
test('ordinary accepted merge still closes out without mergedWithNone',async()=>{
 const f=fixture();try{
  await f.engine.wake();await f.report('ready_to_merge');
  await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.current().resolution.mergedCommit,merged);
  assert.equal(f.current().resolution.mergedWithNone,false);
  assert.equal(f.run().role,'closeout');
  await f.report('closed');
  assert.equal(f.current().phase,'done');
  assert.equal(f.current().resolution.mergedWithNone,false);
 }finally{await f.close()}
});
test('an external merge at an unreviewed head stops for its planner with the recorded merge fact',async()=>{
 const f=fixture();try{
  await f.engine.wake();const reviewer=f.run();f.idle(reviewer.agentId!);
  f.adapter.externalMerge=async()=>({head,commit:merged});
  assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()),true);
  const current=f.current();
  assert.equal(current.phase,'blocked');
  assert.equal(current.resolution.mergedCommit,null,'the unreviewed merge records no merge outcome');
  assert.equal(current.resolution.externalMerge,false);
  assert.equal(current.resolution.mergeHead,null);
  assert.equal(f.counts().merges,0);assert.equal(f.counts().syncs,0);
  assert.equal(f.store.run(reviewer.id)?.released,true);
  assert.equal(f.store.run(reviewer.id)?.status,'superseded');
  assert.equal(current.resolution.stop?.reason,'escalated');
  const fact=f.store.events(current.id).find(event=>event.kind==='external_merge_unreviewed');
  assert.ok(fact,'the merge is recorded as an observed fact');
  assert.match(fact.detail,/merged outside Queue at head/);
  assert.ok(fact.detail.includes(head));assert.ok(fact.detail.includes(merged));
  const escalation=f.store.events(current.id).find(event=>event.kind==='planner_escalation');
  assert.ok(escalation);assert.match(escalation.detail,/cause [0-9a-f]{64}/);
  await new Promise(resolve=>setImmediate(resolve));
  const parked=f.current();
  assert.match(parked.reason,/Waiting with the planner( or task owner [^:]+)?: blocker escalation/);
  // `next` offers the existing routes at the merged head.
  const next=ownerTaskNext(collectOwnerVerbFacts(f.store,parked));
  const shape=JSON.stringify(next.verbs.map(verb=>[verb.verb,verb.available,verb.available?verb.args?.to:null,verb.refusal??null]));
  assert.ok(next.verbs.some(verb=>verb.verb==='move'&&verb.available&&verb.args?.to==='review'),`move to=review is offered: ${shape}`);
  assert.ok(next.verbs.some(verb=>verb.verb==='move'&&verb.available&&verb.args?.to==='closeout'),`move to=closeout is offered: ${shape}`);
  // A repeat observation attaches to the open escalation instead of asking again.
  assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()),true);
  assert.equal(f.store.events(parked.id).filter(event=>event.kind==='planner_escalation').length,1);
 }finally{await f.close()}
});
test('an external merge at a reviewed head closes out as today',async()=>{
 const f=fixture();try{
  recordAcceptedReview(f,'verifying');
  f.adapter.externalMerge=async()=>({head,commit:merged});
  assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()),true);
  assert.equal(f.current().phase,'syncing');
  assert.equal(f.current().resolution.mergedCommit,merged);
  assert.equal(f.current().resolution.externalMerge,true);
  enableRecovery(f);
  await f.engine.wake();await f.engine.wake();
  assert.equal(f.run().role,'closeout');
  await f.report('closed');
  assert.equal(f.current().phase,'done');
 }finally{await f.close()}
});
test('a submission that skipped PR review keeps its previous external-merge behavior',async()=>{
 const f=fixture();try{
  f.store.update(f.task.id,{skipPRReview:true});
  f.adapter.externalMerge=async()=>({head,commit:merged});
  assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()),true);
  assert.equal(f.current().phase,'syncing');
  assert.equal(f.current().resolution.mergedCommit,merged);
  assert.equal(f.current().resolution.externalMerge,true);
 }finally{await f.close()}
});
test('an operator source acceptance at the merged head closes the stopped task out',async()=>{
 const f=fixture();try{
  await f.engine.wake();const reviewer=f.run();f.idle(reviewer.agentId!);
  f.adapter.externalMerge=async()=>({head,commit:merged});
  assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()),true);
  assert.equal(f.current().phase,'blocked');
  // The park's escalation routing settles its own writes before the owner move.
  await new Promise(resolve=>setTimeout(resolve,20));
  const before=f.current().version;
  const moved=await f.engine.performTaskControl({taskId:f.task.id,version:before,action:'move',to:'closeout',reason:'The PR merged outside Queue; the operator accepts the merged source head as is'});
  assert.equal(moved.phase,'syncing');
  assert.equal(moved.resolution.mergedCommit,merged);
  assert.equal(moved.resolution.externalMerge,true);
  enableRecovery(f);
  await f.engine.wake();await f.engine.wake();
  assert.equal(f.run().role,'closeout');
  await f.report('closed');
  assert.equal(f.current().phase,'done');
 }finally{await f.close()}
});
test('automatic external merge refuses a different recorded head',async()=>{
 const f=fixture();try{
  await f.engine.wake();const reviewer=f.run();f.idle(reviewer.agentId!);
  f.adapter.externalMerge=async()=>({head:'d'.repeat(40),commit:merged});
  await f.step();
  assert.equal(f.current().resolution.mergedCommit,null);
  assert.equal(f.store.run(reviewer.id)?.released,false);
  assert.equal(f.counts().merges,0);
 }finally{await f.close()}
});
test('the automatic external-merge probe reads the forge once per window, and an explicit owner verification is never held by it',async t=>{
 const f=fixture();try{
  let probes=0;
  f.adapter.externalMerge=async()=>{probes++;return null};
  f.idle('worker');
  const resolution=f.engine.resolution,probe=()=>resolution.recoverExternalMerge(f.store.task(f.task.id));
  assert.equal(await probe(),false);
  assert.equal(probes,1,'the first automatic pass reads the forge');
  assert.equal(await probe(),false);assert.equal(await probe(),false);
  assert.equal(probes,1,'an unchanged task answers from its recorded observation inside the window');
  assert.equal(f.current().resolution.externalMerge,false,'a skipped read is never merge credit');
  assert.equal(f.current().resolution.mergedCommit,null,'a skipped read records no merge');
  // A changed lifecycle identity is read immediately: the recorded head moved.
  f.store.update(f.task.id,{prHead:'e'.repeat(40)});
  await probe();
  assert.equal(probes,2,'a changed head forces a fresh read');
  // The window itself reopens, and its absence is the parent shape: no window
  // means a forge read on every pass, which is what the audit measured.
  resolution.externalMergeProbeMs=0;
  for(let i=0;i<3;i++)await probe();
  assert.equal(probes,5,'without a window every pass reads the forge (parent shape)');
  resolution.externalMergeProbeMs=120000;
  // The owner's own closeout verification is a separate, explicit read: a pass
  // inside the window never delays it.
  f.adapter.externalMerge=async(_t,accept)=>{probes++;return accept?{head:'d'.repeat(40),commit:merged}:null};
  const before=f.current().version;
  await f.engine.performTaskControl({taskId:f.task.id,version:before,action:'move',to:'closeout',reason:'The PR merged outside Queue after the owner checked it'});
  assert.equal(probes,6,'the explicit owner path reads the forge immediately');
  assert.equal(f.current().resolution.mergedCommit,merged);
  assert.equal(f.current().resolution.externalMerge,true);
  t.diagnostic(JSON.stringify({workload:'automatic external-merge probes of one unchanged task',
    unchangedPasses:3,unchangedPassesForgeReads:1,windowlessPasses:3,windowlessForgeReads:3}));
 }finally{await f.close()}
});
test('external merge recovery honors pause, live workspace lease and identity failure',async()=>{
 const f=fixture();try{
  let probes=0;f.adapter.externalMerge=async()=>{probes++;throw Error('External merge head differs')};f.store.setMeta('paused',true);await f.engine.wake();assert.equal(probes,0);
  f.store.setMeta('paused',false);f.states.set('worker',{...f.states.get('worker')!,active:true,status:'running'});await f.engine.wake();assert.equal(probes,0);
  f.idle('worker');await f.engine.wake();assert.equal(probes,1);assert.equal(f.current().resolution.mergedCommit,null);assert.equal(f.current().resolution.attention,true);assert.equal(f.counts().syncs,0);
  f.adapter.externalMerge=async()=>null;await f.engine.wake();assert.equal(f.current().resolution.attention,false);
 }finally{await f.close()}
});

test('a cleared external-merge check resumes the accepted-PR reconciliation instead of stranding',async()=>{
 const f=fixture();try{
  // Project-A #1837, 2026-10-05: the reconciliation reason parks in needs_attention; a transient
  // check error then parked it again, and clearing only the flag left no tick to advance it.
  Object.assign(f.adapter,{workspaceAvailable:async(id:string)=>id==='workspace'});
  f.store.update(f.task.id,{phase:'needs_attention',reason:ACCEPTED_PR_RECONCILIATION_REASON,
   resolution:{...f.current().resolution,attention:false,currentRunId:null}});
  f.adapter.externalMerge=async()=>{throw Error('External merge head differs from recorded task work')};
  await f.engine.wake();
  assert.equal(f.current().phase,'needs_attention');
  assert.equal(f.current().resolution.attention,true);
  assert.match(f.current().reason,/^External merge check:/);
  assert.deepEqual(f.current().resolution.externalMergePreAttention,{phase:'needs_attention',reason:ACCEPTED_PR_RECONCILIATION_REASON});
  f.adapter.externalMerge=async()=>null;
  await f.engine.wake();
  assert.equal(f.current().resolution.attention,false);
  assert.equal(f.current().resolution.externalMergePreAttention,null);
  assert.ok(['awaiting_review','reviewing'].includes(f.current().phase),`${f.current().phase}: ${f.current().reason}`);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='external_merge_check_recovered'));
  assert.equal(f.current().workspaceId,'workspace');
 }finally{await f.close()}
});

test('ordinary audit routes a long saved external-merge reason before observing the accepted reviewer run',async()=>{
 const f=fixture();try{
  await f.engine.wake();const originalRun=f.run();assert.equal(originalRun.role,'reviewer');
  const callback:Completion={eventId:'long-saved-reason-review',taskId:f.task.id,runId:originalRun.id,status:'ready_to_merge',summary:'Exact-head review accepted',head:originalRun.head,reviewCommentId:24};
  f.engine.resolution.complete(callback,f.tokens.get(originalRun.id)!);
  const savedReason=`Accepted review context: ${'complete saved context '.repeat(260)}`;
  assert.ok(savedReason.length>4000);
  f.store.update(f.task.id,{reason:savedReason});
  f.engine.resolution.attention(f.current(),`${EXTERNAL_MERGE_CHECK_REASON_PREFIX} fixture head unavailable`);
  assert.deepEqual(f.current().resolution.externalMergePreAttention,{phase:'reviewing',reason:savedReason});

  const audit:string[]=[];f.adapter.originAgent=async id=>{audit.push(`origin:${id}`);return{id,workspaceId:'origin-workspace',title:'Chatterbox',archived:false};};
  f.adapter.externalMerge=async()=>null;
  const observe=f.adapter.observe.bind(f.adapter);
  f.adapter.observe=async id=>{audit.push(`observe:${id}`);return observe(id);};
  f.idle(originalRun.agentId!,originalRun.workspaceId);
  // One pass: a full drain would go on to launch the closeout run, which is not a replacement.
  await f.step();

  const originAt=audit.indexOf('origin:origin'),threadAt=audit.indexOf(`observe:${originalRun.agentId}`);
  assert.ok(originAt>=0,'ordinary origin routing read the saved record');
  assert.ok(threadAt>originAt,`origin routing must precede original-thread observation: ${audit.join(', ')}`);
  const released=f.store.run(originalRun.id)!;
  assert.equal(released.released,true);assert.equal(released.status,'finished');
  assert.deepEqual(released.completion,callback,'authenticated callback receipt remains verbatim');
  assert.equal(f.current().resolution.review?.eventId,callback.eventId,'the accepted result advanced through normal review handling');
  assert.equal(f.current().resolution.attention,false);assert.equal(f.current().resolution.externalMergePreAttention,null);
  assert.equal(f.store.run(originalRun.id)?.agentId,originalRun.agentId,'no replacement thread was created');
  assert.equal(f.creates.length,1,'no replacement resolution run was dispatched');
 }finally{await f.close()}
});

test('the lifecycle sweep restores a recorded pre-attention phase on a stranded task',async()=>{
 const f=fixture();try{
  // A restart between the check failure and its recovery leaves the flag cleared on a
  // recorded pre-attention state; the sweep must resume the ordinary path, not idle.
  f.store.update(f.task.id,{phase:'needs_attention',reason:EXTERNAL_MERGE_CHECK_RECOVERED_REASON,
   resolution:{...f.current().resolution,attention:false,currentRunId:null,externalMergePreAttention:{phase:'awaiting_review',reason:'Ready'}}});
  await f.engine.wake();
  assert.ok(['awaiting_review','reviewing'].includes(f.current().phase),`${f.current().phase}: ${f.current().reason}`);
  assert.equal(f.current().resolution.externalMergePreAttention,null);
 }finally{await f.close()}
});

test('the sweep leaves a legitimately parked needs_attention task alone',async()=>{
 const f=fixture();try{
  const reason='Revision budget exhausted after 6 review rounds; coordinator judgment required';
  f.store.update(f.task.id,{phase:'needs_attention',reason,
   resolution:{...f.current().resolution,externalMergePreAttention:{phase:'awaiting_review',reason:'Ready'}}});
  await f.engine.wake();
  assert.equal(f.current().phase,'needs_attention');
  assert.equal(f.current().reason,reason);
  // The record beside a non-check reason is stale and must not restore an old phase.
  assert.equal(f.current().resolution.externalMergePreAttention,null);
 }finally{await f.close()}
});

test('an operator accepts an external merge at a planner head built on the recorded work',async()=>{
 const f=fixture();try{
  // Live, 2026-09-30 (longhorn #033): the planner recorded known gaps in a commit on top of the
  // worker's head and merged externally; the head check correctly refused and nothing could accept it.
  const planner='d'.repeat(40);
  f.adapter.externalMerge=async(_t,accept)=>{if(!accept)throw Error('External merge head differs from recorded task work');return{head:planner,commit:merged}};
  f.idle('worker');await f.engine.wake();
  assert.equal(f.current().resolution.attention,true);assert.equal(f.current().resolution.mergedCommit,null);
  assert.throws(()=>taskControlInputSchema.parse({taskId:f.task.id,version:1,action:'move',to:'closeout'}),/move requires a target step .* and a reason/);
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'closeout',reason:'Planner recorded the remaining map findings as known gaps (longhorn #033)'});
  const accepted=f.current();
  assert.equal(accepted.prHead,planner);assert.equal(accepted.resolution.mergedCommit,merged);assert.equal(accepted.resolution.externalMerge,true);
  assert.ok(['syncing','merging'].includes(accepted.phase),accepted.phase);
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='external_merge_head_accepted'&&e.detail.includes('known gaps')&&e.detail.includes(planner)));
  assert.equal(f.counts().merges,0,'Queue never merges it again');
  await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'closeout',reason:'again'}),/unmerged dispatched task/);
 }finally{await f.close()}
});

test('explicit external acceptance settles only stopped leases without inventing a reviewer callback',async()=>{
 const f=fixture();try{
  await f.engine.wake();const old=f.run();f.idle(old.agentId!);
  f.adapter.externalMerge=async()=>({head:'d'.repeat(40),commit:merged});
  const creates=f.creates.length,sends=f.sends.length;
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'closeout',reason:'Tom merged the inspected intake; stop review loops'});
  const settled=f.store.run(old.id)!;
  assert.equal(settled.released,true);assert.equal(settled.status,'superseded');assert.equal(settled.completion,null);
  assert.equal(f.current().resolution.mergedCommit,merged);assert.equal(f.current().resolution.currentRunId,null);
  assert.equal(f.creates.length,creates);assert.equal(f.sends.length,sends);
 }finally{await f.close()}
});

test('external acceptance refuses active, permission, foreign-workspace and unknown-delivery leases',async()=>{
 for(const bad of ['active','permission','workspace','uncertain']){
  const f=fixture();try{
   await f.engine.wake();const old=f.run();f.idle(old.agentId!);
   if(bad==='uncertain')f.store.putRun({...old,status:'uncertain'});
   else {const state=f.states.get(old.agentId!)!;f.states.set(old.agentId!,{...state,...(bad==='active'?{active:true}:bad==='permission'?{permissions:true}:{workspaceId:'other'})});}
   let probes=0;f.adapter.externalMerge=async()=>{probes++;return{head:'d'.repeat(40),commit:merged}};
   await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'closeout',reason:'mechanical only'}),/active thread|Unknown run delivery|execution participants or effects/);
   assert.equal(probes,0);assert.equal(f.store.run(old.id)!.released,false);assert.equal(f.current().resolution.mergedCommit,null);
  }finally{await f.close()}
 }
});

test('external acceptance rechecks stopped state and immutable callback identity after awaited Git proof',async()=>{
 for(const change of ['active','callback','task']){
  const f=fixture();try{
   await f.engine.wake();const old=f.run();f.idle(old.agentId!);
   f.adapter.externalMerge=async()=>{
    if(change==='active')f.states.set(old.agentId!,{...f.states.get(old.agentId!)!,active:true});
    else if(change==='callback')f.store.putRun({...f.store.run(old.id)!,completion:{eventId:'real-late-result',taskId:f.task.id,runId:old.id,status:'blocked',head:old.head,summary:'genuine result'}});
    else f.store.update(f.task.id,{reason:'owner change during proof'});
    return{head:'d'.repeat(40),commit:merged};
   };
   await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'closeout',reason:'mechanical only'}),/active thread|Task or run changed/);
   assert.equal(f.store.run(old.id)!.released,false);assert.equal(f.current().resolution.mergedCommit,null);
   if(change==='callback')assert.equal(f.store.run(old.id)!.completion!.eventId,'real-late-result');
  }finally{await f.close()}
 }
});

test('MCP review text is stored while paused, published once the thread is idle, and then verified',async()=>{
 const {Reports}=await import('../core/intake/report');const f=fixture();try{
  await f.engine.wake();const r=f.run();f.store.setMeta('paused',true);
  let published=0;f.adapter.publishReview=async(store,t,run,status,text)=>{published++;assert.equal(text,'Full review findings');assert.equal(run.id,r.id);return 42;};
  const reports=new Reports(f.engine),input={eventId:'mcp-review',taskId:f.task.id,runId:r.id,status:'ready_to_merge' as const,summary:'Reviewed',reviewText:'Full review findings'};
  await reports.report(input,f.tokens.get(r.id)!);await f.engine.wake();assert.equal(published,0);assert.equal(f.run().completion?.reviewText,input.reviewText);
  assert.deepEqual(await new Reports(f.engine).report(input,f.tokens.get(r.id)!),{accepted:true,eventId:input.eventId});
  await assert.rejects(reports.report({...input,summary:'Different'},f.tokens.get(r.id)!),/conflict/);
  f.idle(r.agentId!);await f.engine.wake();assert.equal(published,1,'pause publishes once the in-flight thread is idle');assert.equal(f.current().resolution.review?.reviewCommentId,42);assert.equal(f.counts().reviewChecks,1);
  assert.equal(f.store.getMeta('paused'),true);
  f.store.setMeta('paused',false);await f.engine.wake();assert.equal(published,1);
 }finally{await f.close();}
});

test('successful closeout archives owned workspaces once; pause and shared work defer cleanup',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  const archived:string[]=[];
  Object.assign(f.adapter,{archiveTaskWorkspace:async(t:any,id:string,directory:string,head:string,allowed:()=>boolean)=>{if(!allowed())return false;archived.push(id);return true;}});
  const lifecycle=new Lifecycle(f.engine);
  f.store.update(f.task.id,{phase:'blocked',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged}});await lifecycle.pass();assert.deepEqual(archived,[]);
  f.store.update(f.task.id,{phase:'done'});f.store.setMeta('paused',true);await lifecycle.pass();assert.deepEqual(archived,[]);
  f.store.setMeta('paused',false);
  const other=f.store.insert(submissionSchema.parse({submissionId:'other',title:'Other task',repoPath:'/other',planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff',base);
  f.store.update(other.id,{workspaceId:f.task.workspaceId});await lifecycle.pass();assert.deepEqual(archived,[]);assert.match(f.current().resolution.cleanupReason,/another task/);
  f.store.update(other.id,{phase:'done'});await lifecycle.pass();assert.deepEqual(archived,[],'a transient ownership conflict respects archive backoff');
  expireWorkspaceArchiveBackoff(f);await lifecycle.pass();assert.deepEqual(archived,[],'a done task still owns its shared workspace binding');
  f.store.update(other.id,{workspaceId:null});
  expireWorkspaceArchiveBackoff(f);await lifecycle.pass();assert.deepEqual(archived,['workspace']);assert.equal(f.current().phase,'done');assert.equal(f.current().resolution.cleanupReason,'');
  await lifecycle.pass();assert.deepEqual(archived,['workspace']);
 }finally{await f.close();}
});
test('workspace archive failures back off independently and stay visible on the board',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  let fail=true;const calls:string[]=[];
  Object.assign(f.engine.retirement,{capture:async()=>null,markArchived:(task:Task)=>task.resolution.runtimeRetirements,archived:async()=>{},hasScope:()=>false});
  Object.assign(f.adapter,{taskWorkspaceArchived:async()=>false,
   archiveTaskWorkspace:async(_t:Task,id:string,_d:string,_h:string,allowed:()=>boolean)=>{
    calls.push(id);if(!allowed())return false;
    if(id==='workspace'&&fail)throw Error('Paseo workspace.archive failed: Timeout waiting for message');
    return true;
   }});
  const lifecycle=new Lifecycle(f.engine);
  f.store.update(f.task.id,{phase:'done',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged,
   closeoutWorkspaceId:'closeout',closeoutDirectory:'/closeout',closeoutWorkspaceHead:merged}});
  await lifecycle.pass();
  assert.deepEqual(calls,['workspace','closeout'],'a failed task workspace does not block its separate closeout workspace');
  let retry=f.current().resolution.workspaceArchiveRetries[0]!;
  assert.equal(retry.workspaceId,'workspace');assert.equal(retry.attempts,1);
  assert.match(retry.error,/Paseo workspace\.archive failed: Timeout waiting for message/);
  assert.ok(Date.parse(retry.nextAttemptAt)>Date.now());
  const summary=visibleTaskSummaries([f.current()])[0]!;
  assert.equal(summary.resolution.archiveRetry?.workspaceId,'workspace');
  assert.match(summary.resolution.archiveRetry?.error??'',/Timeout waiting for message/);
  await lifecycle.pass();assert.deepEqual(calls,['workspace','closeout'],'the deadline suppresses another Paseo call');

  let current=f.current();
  f.store.update(current.id,{resolution:{...current.resolution,workspaceArchiveRetries:current.resolution.workspaceArchiveRetries.map(record=>({...record,nextAttemptAt:new Date(0).toISOString()}))}});
  await lifecycle.pass();
  retry=f.current().resolution.workspaceArchiveRetries[0]!;
  assert.equal(retry.attempts,2);assert.ok(Date.parse(retry.nextAttemptAt)>Date.now()+110_000,'the second failure doubles the delay');

  fail=false;current=f.current();
  f.store.update(current.id,{resolution:{...current.resolution,workspaceArchiveRetries:current.resolution.workspaceArchiveRetries.map(record=>({...record,nextAttemptAt:new Date(0).toISOString()}))}});
  await lifecycle.pass();
  assert.deepEqual(f.current().resolution.archivedWorkspaceIds,['closeout','workspace']);
  assert.deepEqual(f.current().resolution.workspaceArchiveRetries,[]);assert.equal(f.current().resolution.cleanupReason,'');
  assert.deepEqual(visibleTaskSummaries([f.current()]),[],'a fully archived done task leaves the board');
 }finally{await f.close();}
});
test('missing post-merge workspace recovers closeout without another merge; unknown creation stays fenced',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  let created=0;Object.assign(f.adapter,{workspaceAvailable:async(id:string)=>id==='recovery',createCloseoutWorkspace:async()=>{created++;return{id:'recovery',directory:'/recovery'};},findCloseoutWorkspaces:async()=>[],verifyCloseoutWorkspace:async()=>{}});
  const lifecycle=new Lifecycle(f.engine);
  f.store.update(f.task.id,{phase:'closing',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged}});
  await lifecycle.pass();assert.equal(created,1);assert.equal(f.current().resolution.coordinatorWorkspaceId,'recovery');assert.equal(f.current().coordinatorGeneration,2);assert.equal(f.counts().merges,0);
  await lifecycle.pass();assert.equal(created,1);
  // A second task with a recorded workspace intent cannot blindly create again.
  f.store.update(f.task.id,{coordinatorAgentId:'',resolution:{...f.current().resolution,coordinatorWorkspaceId:null,closeoutWorkspaceId:null,closeoutDirectory:null}});
  await lifecycle.pass();assert.equal(created,1);assert.match(f.current().reason,/workspace creation is uncertain/);
 }finally{await f.close();}
});
test('accepted PR recovers a removed task workspace without repeating worker delivery',async()=>{
 const f=fixture();try{
  let recovered=0;
  Object.assign(f.adapter,{workspaceAvailable:async(id:string)=>id==='recovered',findWorkspaces:async()=>[],recoverTaskWorkspace:async()=>{recovered++;return{id:'recovered',directory:'/recovered'};}});
  f.store.update(f.task.id,{phase:'needs_attention',reason:'Git working directory is unavailable: /worktree',prHead:null,prUrl:null,resolution:{...f.current().resolution,attention:true}});
  f.engine.resolution.retry(f.current(),false,undefined,true);
  await f.engine.wake();
  assert.equal(recovered,1);assert.equal(f.current().workspaceId,'recovered');assert.equal(f.current().directory,'/recovered');
  assert.equal(f.current().agentId,null);assert.equal(f.current().completion?.status,'ready_for_review');assert.equal(f.current().retiredWorkers.at(-1)?.agentId,'worker');
  assert.equal(f.current().phase,'reviewing');assert.equal(f.run().workspaceId,'recovered');assert.equal(f.creates.length,1);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='task_workspace_recovered'));
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='task_workspace_recovery_requested'));
 }finally{await f.close()}
});
test('operator retry after an exhausted review budget reaches a fresh review when the workspace is available',async()=>{
 const f=fixture();try{
  // Live, 2026-09-27 (#083): retry_resolution recorded the reconciliation reason, but advance() only ran for
  // attention tasks whose workspace was unavailable, so an available workspace never reached review.
  Object.assign(f.adapter,{workspaceAvailable:async(id:string)=>id==='workspace'});
  f.store.update(f.task.id,{phase:'needs_attention',reason:'Revision budget exhausted after 3 review rounds; coordinator judgment required',
   resolution:{...f.current().resolution,currentRunId:null,attention:true,review:{eventId:'review',taskId:f.task.id,runId:'review-run',status:'changes_required',summary:'One remaining P2',head,reviewCommentId:42}}});
  f.engine.resolution.retry(f.current(),false,undefined,true);
  assert.equal(f.current().reason,'Operator requested accepted-PR workspace reconciliation');
  await f.engine.wake();await f.engine.wake();
  assert.ok(['awaiting_review','reviewing'].includes(f.current().phase),`${f.current().phase}: ${f.current().reason}`);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='task_workspace_confirmed'));
 }finally{await f.close()}
});
test('coordinator retry after an exhausted review budget returns the accepted PR to review',async()=>{
 const f=fixture();try{
  // Live, 2026-09-29 (project-a #1672): needs_attention from revision-budget exhaustion, ready_for_review
  // at prHead, changes_required only for an external receipt that was then supplied. Coordinator
  // recovered/retry threw NO_RESOLUTION_ACTION because this path required operator=true.
  Object.assign(f.adapter,{workspaceAvailable:async(id:string)=>id==='workspace'});
  f.store.update(f.task.id,{phase:'needs_attention',reason:'Revision budget exhausted after 3 review rounds; coordinator judgment required',
   resolution:{...f.current().resolution,currentRunId:null,attention:false,review:{eventId:'review',taskId:f.task.id,runId:'review-run',status:'changes_required',summary:'Supply the external receipt',head,reviewCommentId:42}}});
  const retried=f.engine.resolution.retry(f.current());
  assert.equal(retried.reason,'Operator requested accepted-PR workspace reconciliation');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='task_workspace_recovery_requested'));
  await f.engine.wake();await f.engine.wake();
  assert.ok(['awaiting_review','reviewing'].includes(f.current().phase),`${f.current().phase}: ${f.current().reason}`);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='task_workspace_confirmed'));
 }finally{await f.close()}
});
test('a parked restart rechecks an accepted verifying task after its control effect settles',async()=>{
 const f=fixture();try{
  recordAcceptedReview(f,'verifying');
  f.store.update(f.task.id,{reason:'A repaired check needs retry',resolution:{...f.current().resolution,attention:true}});
  let gates=0;
  f.adapter.mergeGate=async()=>{gates++;return {head,base,wait:'Waiting at the pre-merge gate'}};
  const perform=f.engine.performTaskControl.bind(f.engine);
  f.engine.performTaskControl=async(...args)=>{const result=await perform(...args);await f.engine.quiesce();assert.equal(gates,0,'the operation effect fences the first wake');return result};
  const task=f.current();
  const accepted=await f.engine.startOperation({key:randomUUID(),kind:'task_control',taskId:task.id,expectedVersion:task.version,
   payload:{type:'task_control',control:{taskId:task.id,version:task.version,action:'restart',reason:'Retry the repaired check'}}});
  if('backpressured' in accepted)throw Error('Unexpected backpressure');
  const operation=await f.engine.awaitOperation(accepted.operation.id,10000);
  assert.equal(operation.state,'succeeded',operation.diagnostic);
  await f.engine.quiesce();
  assert.ok(f.store.eventsAll(task.id).some(event=>event.kind==='resolution_retry'));
  assert.ok(gates>0,'the settled retry reaches the merge gate without another wake');
 }finally{await f.close()}
});
test('operator retry preserves an accepted exact-head review and resumes pre-merge gates',async()=>{
 const f=fixture();try{
  Object.assign(f.adapter,{workspaceAvailable:async(id:string)=>id==='workspace'});
  f.store.update(f.task.id,{
   phase:'needs_attention',reason:'Operator requested accepted-PR workspace reconciliation',
   resolution:{...f.current().resolution,attention:false,review:{eventId:'review',taskId:f.task.id,runId:'review-run',status:'ready_to_merge',summary:'Pass',head,reviewCommentId:42}},
  });
  f.engine.resolution.retry(f.current(),false,undefined,true);
  assert.equal(f.current().phase,'verifying');
  assert.equal(f.current().workspaceId,'workspace');assert.equal(f.current().agentId,'worker');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='pre_merge_retry_requested'));
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='reviewer').length,0);
 }finally{await f.close()}
});
test('a no-action recovery escalation at an accepted head needs one operator answer, not another worker run',async()=>{
 const f=fixture();try{
  let gates=0;
  f.adapter.mergeGate=async()=>{gates++;return{head,base,wait:'Waiting at the pre-merge gate'}};
  const review:Completion={eventId:'accepted-review',taskId:f.task.id,runId:'reviewer',status:'ready_to_merge',summary:'Accepted exact head',head,reviewCommentId:43};
  f.store.putRun({id:'reviewer',taskId:f.task.id,role:'reviewer',generation:1,head,base,agentId:'reviewer',workspaceId:'workspace',profile:profile('reviewer'),status:'finished',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:new Date().toISOString(),completion:review,released:true});
  f.store.update(f.task.id,{phase:'verifying',reason:'Accepted exact head',resolution:{...f.current().resolution,review,currentRunId:null,attention:false}});
  f.engine.resolution.recovery.escalate(f.current(),`${RECOVERY_ESCALATION_FAILURE_PREFIX}No resolution action needs retry`);
  const runs=f.store.runs(f.task.id).length;
  // The unmodified guard refused this answer because the phase was verifying.
  // Round 4: one owner restart answers it; there is no parked step to re-run first.
  assert.equal(gates,0);
  assert.equal(f.current().resolution.recovery?.status,'escalated');
  const answered=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'restart',reason:'No resolution action remains; continue the accepted review'});
  assert.equal(answered.phase,'verifying');
  await f.engine.wake();
  assert.ok(gates>0);
  assert.equal(f.current().prHead,head);
  assert.equal(f.current().resolution.review?.head,head);
  assert.equal(f.store.runs(f.task.id).length,runs);
  assert.equal(f.creates.length,0);
  assert.equal(f.sends.length,0);
  assert.equal(f.current().resolution.recovery?.status,'resolved');
  assert.equal(f.current().resolution.incident?.status,'resolved');
  assert.match(f.current().resolution.incident?.detail??'',/No resolution action remains/);
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='recovery_escalated'));
 }finally{await f.close()}
});
test('the no-action finding does not answer live recovery, merge, delivery, a changed head, or another finding',async()=>{
 for(const blocker of ['recovery','merge','run','head','finding','revision'] as const){
  const f=fixture();try{
   const review:Completion={eventId:'accepted-review',taskId:f.task.id,runId:'reviewer',status:'ready_to_merge',summary:'Accepted exact head',head,reviewCommentId:43};
   f.store.update(f.task.id,{phase:'verifying',resolution:{...f.current().resolution,review,currentRunId:null,attention:false}});
   f.engine.resolution.recovery.escalate(f.current(),`${RECOVERY_ESCALATION_FAILURE_PREFIX}${blocker==='finding'?'Merge outcome is uncertain':'No resolution action needs retry'}`);
   if(blocker==='recovery')f.store.update(f.task.id,{resolution:{...f.current().resolution,recoveryActive:true}});
   if(blocker==='merge')f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeIntent:true,mergeHead:head}});
   if(blocker==='run')f.store.putRun({id:'unreleased-reviewer',taskId:f.task.id,role:'reviewer',generation:1,head,base,agentId:'reviewer',workspaceId:'workspace',profile:profile('reviewer'),status:'running',createdAt:new Date().toISOString(),lastObservedAt:null,active:true,idleSince:null,completion:null,released:false});
   if(blocker==='head')f.store.update(f.task.id,{prHead:'d'.repeat(40)});
   if(blocker==='revision')f.store.update(f.task.id,{phase:'changes_requested'});
   const before=f.current();
   // Round 4: the owner's restart never answers the finding while it is blocked.
   // Where nothing else applies it refuses and writes nothing; a live run or
   // revision is work the restart acts on instead.
   const refused=await f.engine.performTaskControl({taskId:f.task.id,version:before.version,action:'restart',reason:'Answer'}).then(()=>false,()=>true);
   assert.ok(!f.store.events(f.task.id).some(event=>event.kind==='escalation_resolved'),blocker);
   if(!['run','revision'].includes(blocker)){
    assert.equal(refused,true,blocker);
    assert.equal(f.current().version,before.version,blocker);
    assert.equal(f.current().resolution.recovery?.status,'escalated',blocker);
   }
   assert.equal(f.creates.length,0);
  }finally{await f.close()}
 }
});
test('closeout recovery preserves an available explicitly assigned coordinator',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  let created=0;Object.assign(f.adapter,{workspaceAvailable:async(id:string)=>id==='elsewhere',createCloseoutWorkspace:async()=>{created++;throw Error('Must not replace assigned coordinator');}});
  f.idle('external','elsewhere');f.store.update(f.task.id,{phase:'closing',coordinatorAgentId:'external',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged}});
  await new Lifecycle(f.engine).pass();assert.equal(created,0);assert.equal(f.current().coordinatorAgentId,'external');
 }finally{await f.close();}
});

test('only a proven missing-directory preflight permits replacing an uncreated closeout agent',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  await f.engine.wake();const run=f.run();f.states.delete(run.agentId!);
  f.store.putRun({...run,role:'closeout',agentId:null,status:'uncertain',released:false});
  f.store.update(f.task.id,{phase:'closing',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged}});
  let created=0;Object.assign(f.adapter,{workspaceAvailable:async()=>false,createCloseoutWorkspace:async()=>{created++;return{id:'recovery',directory:'/recovery'};},findCloseoutWorkspaces:async()=>[],verifyCloseoutWorkspace:async()=>{}});
  const lifecycle=new Lifecycle(f.engine);await lifecycle.pass();assert.equal(created,0);assert.match(f.current().reason,/Closeout creation is uncertain/);
  f.store.event(f.task.id,'needs_attention',`Workspace ${run.workspaceId} has no available directory`);
  await lifecycle.pass();assert.equal(created,1);assert.equal(f.store.run(run.id)?.status,'superseded');assert.equal(f.store.run(run.id)?.released,true);assert.equal(f.counts().merges,0);
 }finally{await f.close();}
});
function queueWorktree(taskId:string){
  const root=mkdtempSync(join(tmpdir(),'ns-done-archive-')),repo=join(root,'repo'),worktree=join(root,'worktree');
  const run=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  execFileSync('git',['init','--initial-branch=main',repo]);
  run(repo,'config','user.email','test@example.invalid');run(repo,'config','user.name','Test');
  writeFileSync(join(repo,'file'),'x');run(repo,'add','.');run(repo,'commit','-m','base');
  run(repo,'worktree','add','-b',`ns-${taskId}`,worktree);
  return {root,repo,worktree,head:run(worktree,'rev-parse','HEAD'),close:()=>rmSync(root,{recursive:true,force:true})};
}
function mockWorkspaceArchiver(task:{repoPath:string;branch:string},directory:string,agent:unknown,archived:{n:number},helperPath:string){
  const adapter=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
  Object.defineProperty(adapter,'helperPath',{value:helperPath});
  Object.defineProperty(adapter,'api',{value:{workspaces:{ref:()=>({directory,refresh:async()=>{},current:()=>({projectRootPath:task.repoPath,worktreeSlug:task.branch}),archive:async()=>{archived.n++;rmSync(directory,{recursive:true,force:true});return{archivedAt:new Date().toISOString()};}})},agents:{list:async()=>({entries:agent?[{agent}]:[],pageInfo:{hasMore:false}})}}});
  return adapter;
}

test('Paseo workspace archive failures preserve their transport cause',async()=>{
 const f=fixture();const git=queueWorktree(f.task.id);try{
  const task={...f.task,repoPath:git.repo,directory:git.worktree,branch:`ns-${f.task.id}`,workspaceId:'workspace',prHead:git.head,phase:'done' as const};
  const adapter=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
  Object.defineProperty(adapter,'helperPath',{value:join(f.dir,'worker-report.mjs')});
  Object.defineProperty(adapter,'api',{value:{workspaces:{ref:()=>({directory:git.worktree,refresh:async()=>{},
   current:()=>({projectRootPath:git.repo,worktreeSlug:task.branch}),archive:async()=>{throw Error('Timeout waiting for message');}})},
   agents:{list:async()=>({entries:[],pageInfo:{hasMore:false}})}}});
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false,false,new Set(),true,true),
   /Paseo workspace\.archive failed: Timeout waiting for message/);
 }finally{git.close();await f.close();}
});

test('workspace archiver rejects unrelated threads and live turns before any deletion',async()=>{
 const {PaseoAdapter}=await import('../service/paseo-composition');const f=fixture();const git=queueWorktree(f.task.id);try{
  const task={...f.task,repoPath:git.repo,directory:git.worktree};
  let archived=0;let agent:any={id:'attached',workspaceId:'workspace',labels:{'nucleus.task':'other'},status:'idle'};
  const adapter=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
  Object.defineProperty(adapter,'helperPath',{value:join(f.dir,'worker-report.mjs')});
  Object.defineProperty(adapter,'api',{value:{workspaces:{ref:()=>({directory:git.worktree,refresh:async()=>{},current:()=>({projectRootPath:git.repo,worktreeSlug:`ns-${f.task.id}`}),archive:async()=>{archived++;return{archivedAt:new Date().toISOString()};}})},agents:{list:async()=>({entries:[{agent}],pageInfo:{hasMore:false}})}}});
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false),/unrelated thread/);
  agent={...agent,status:'running',activeTurn:{}};
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false,false,new Set([agent.id])),/become idle/);
  agent={...agent,labels:{'nucleus.task':f.task.id},status:'running',activeTurn:{}};
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false),/become idle/);assert.equal(archived,0);
 }finally{git.close();await f.close();}
});

test('a done-task archive includes idle foreign threads and still waits or preserves when they are live or dirty',async()=>{
 const f=fixture();const git=queueWorktree(f.task.id);try{
  const task={...f.task,repoPath:git.repo,directory:git.worktree,branch:`ns-${f.task.id}`};
  const foreign={id:'foreign-calibrator',workspaceId:'workspace',labels:{'nucleus.task':'other'},status:'idle'};
  const archived={n:0};
  const adapter=mockWorkspaceArchiver(task,git.worktree,foreign,archived,join(f.dir,'worker-report.mjs'));
  for(const status of ['error','closed'] as const){
    archived.n=0;foreign.status=status;
    assert.equal(await adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>false,false,false,new Set(),false,true),false);
    assert.equal(archived.n,0);
  }
  foreign.status='idle';
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false),/unrelated thread/);
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false,false,new Set(),false,false),/unrelated thread/);
  foreign.status='running';(foreign as {activeTurn?:object}).activeTurn={};
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false,false,new Set(),false,true),/become idle/);
  delete (foreign as {activeTurn?:object}).activeTurn;foreign.status='idle';
  (foreign as {pendingPermissions?:object[]}).pendingPermissions=[{id:'perm'}];
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false,false,new Set(),false,true),/become idle/);
  delete (foreign as {pendingPermissions?:object[]}).pendingPermissions;
  const archivedAfterIdle=archived.n;
  writeFileSync(join(git.worktree,'dirty.txt'),'keep');
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false,false,new Set(),false,true),/uncommitted/);
  assert.equal(archived.n,archivedAfterIdle);
  rmSync(join(git.worktree,'dirty.txt'));
  assert.deepEqual(await adapter.archiveTaskWorkspace(task,'workspace',git.worktree,git.head,()=>true,false,false,new Set(),false,true),[foreign.id]);
  assert.equal(archived.n,1);
 }finally{git.close();await f.close();}
});

test('a done task still preserves a dirty worktree when an idle foreign thread is present',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();const git=queueWorktree(f.task.id);try{
  writeFileSync(join(git.worktree,'dirty.txt'),'keep');
  f.store.update(f.task.id,{repoPath:git.repo,directory:git.worktree,prHead:git.head,phase:'done',
    resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged}});
  const foreign={id:'foreign-calibrator',workspaceId:'workspace',labels:{'nucleus.task':'other'},status:'idle'};
  const archived={n:0};
  const adapter=mockWorkspaceArchiver({repoPath:git.repo,branch:`ns-${f.task.id}`},git.worktree,foreign,archived,join(f.dir,'worker-report.mjs'));
  f.adapter.archiveTaskWorkspace=adapter.archiveTaskWorkspace.bind(adapter);
  await new Lifecycle(f.engine).pass();
  assert.equal(archived.n,0);
  assert.match(f.current().resolution.cleanupReason,/uncommitted/);
 }finally{git.close();await f.close();}
});

test('a done task with an idle foreign thread archives and records the thread id; a running one waits then archives',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  const foreign='foreign-calibrator';
  let live=true;const archived:string[]=[];const allowIdle:boolean[]=[];
  Object.assign(f.adapter,{archiveTaskWorkspace:async(_t:unknown,_id:string,_d:string,_h:string,allowed:()=>boolean,_u:boolean,_p?:boolean,_a?:ReadonlySet<string>,_r?:boolean,allow?:boolean)=>{
    allowIdle.push(Boolean(allow));
    if(live)throw Error('Waiting for workspace threads to become idle');
    if(!allowed())return false;archived.push(_id);return [foreign];
  }});
  f.store.update(f.task.id,{phase:'done',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged}});
  const lifecycle=new Lifecycle(f.engine);
  await lifecycle.pass();
  assert.deepEqual(archived,[]);
  assert.match(f.current().resolution.cleanupReason,/become idle/);
  assert.deepEqual(allowIdle,[true]);
  live=false;await lifecycle.pass();assert.deepEqual(archived,[],'an idle foreign thread waits for its retry deadline');
  expireWorkspaceArchiveBackoff(f);await lifecycle.pass();
  assert.deepEqual(archived,['workspace']);
  assert.equal(f.current().resolution.cleanupReason,'');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='workspace_archived'&&event.detail.includes(foreign)));
  await lifecycle.pass();assert.deepEqual(archived,['workspace']);
 }finally{await f.close();}
});
test('a recorded archive intent reconciles a live workspace by archiving once',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  const calls:{uncertain:boolean}[]=[];
  Object.assign(f.adapter,{taskWorkspaceArchived:async()=>false,
   archiveTaskWorkspace:async(_t:any,id:string,_d:string,_h:string,allowed:()=>boolean,uncertain:boolean)=>{calls.push({uncertain});if(!allowed())return false;assert.equal(id,'workspace');return true;}});
  const lifecycle=new Lifecycle(f.engine);
  f.store.update(f.task.id,{phase:'done',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged,archiveIntentWorkspaceId:'workspace',cleanupReason:'Workspace archive outcome is uncertain; inspect before retrying'}});
  await lifecycle.pass();
  assert.equal(calls.length,1);assert.equal(calls[0].uncertain,false);
  assert.deepEqual(f.current().resolution.archivedWorkspaceIds,['workspace']);
  assert.equal(f.current().resolution.archiveIntentWorkspaceId,null);assert.equal(f.current().resolution.cleanupReason,'');
  await lifecycle.pass();assert.equal(calls.length,1);
 }finally{await f.close();}
});
test('a recorded archive intent reconciles a gone workspace without another archive call',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  let archives=0;
  Object.assign(f.adapter,{taskWorkspaceArchived:async()=>true,archiveTaskWorkspace:async()=>{archives++;return true;}});
  const lifecycle=new Lifecycle(f.engine);
  f.store.update(f.task.id,{phase:'done',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged,archiveIntentWorkspaceId:'workspace',cleanupReason:'Workspace archive outcome is uncertain; inspect before retrying'}});
  await lifecycle.pass();
  assert.equal(archives,0);
  assert.deepEqual(f.current().resolution.archivedWorkspaceIds,['workspace']);
  assert.equal(f.current().resolution.archiveIntentWorkspaceId,null);assert.equal(f.current().resolution.cleanupReason,'');
 }finally{await f.close();}
});
test('a recorded archive intent without a workspace observer waits instead of archiving blindly',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  let archives=0;
  assert.equal(f.adapter.taskWorkspaceArchived,undefined);
  Object.assign(f.adapter,{archiveTaskWorkspace:async()=>{archives++;return true;}});
  const lifecycle=new Lifecycle(f.engine);
  f.store.update(f.task.id,{phase:'done',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged,archiveIntentWorkspaceId:'workspace',cleanupReason:'Workspace archive outcome is uncertain; inspect before retrying'}});
  await lifecycle.pass();
  assert.equal(archives,0);
  assert.match(f.current().resolution.cleanupReason,/Waiting to reconcile the uncertain workspace archive for workspace: workspace observation is unavailable/);
  assert.equal(f.current().resolution.archiveIntentWorkspaceId,'workspace');
  assert.deepEqual(f.current().resolution.archivedWorkspaceIds,[]);
 }finally{await f.close();}
});
test('a recorded archive intent reconciles a gone workspace even when the retention hook fails on the removed worktree',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  let archives=0;
  Object.assign(f.adapter,{taskWorkspaceArchived:async()=>true,archiveTaskWorkspace:async()=>{archives++;return true;}});
  Object.assign(f.engine.hooks,{retentionGate:async()=>{throw Error('retention hook failed: worktree directory is gone');}});
  const lifecycle=new Lifecycle(f.engine);
  f.store.update(f.task.id,{phase:'done',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged,archiveIntentWorkspaceId:'workspace',cleanupReason:'Workspace archive outcome is uncertain; inspect before retrying'}});
  await lifecycle.pass();
  assert.equal(archives,0);
  assert.deepEqual(f.current().resolution.archivedWorkspaceIds,['workspace']);
  assert.equal(f.current().resolution.archiveIntentWorkspaceId,null);assert.equal(f.current().resolution.cleanupReason,'');
 }finally{await f.close();}
});
test('a failed archive observation waits with a transport reason and retries later',async()=>{
 const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');const f=fixture();try{
  let observe:()=>Promise<boolean>=async()=>{throw Error('Paseo transport dropped');};
  let archives=0;
  Object.assign(f.adapter,{taskWorkspaceArchived:async()=>observe(),
   archiveTaskWorkspace:async(_t:any,_id:string,_d:string,_h:string,allowed:()=>boolean)=>{archives++;if(!allowed())return false;return true;}});
  const lifecycle=new Lifecycle(f.engine);
  f.store.update(f.task.id,{phase:'done',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged,archiveIntentWorkspaceId:'workspace',cleanupReason:'Workspace archive outcome is uncertain; inspect before retrying'}});
  await lifecycle.pass();
  assert.equal(archives,0);
  assert.match(f.current().resolution.cleanupReason,/Waiting to reconcile the uncertain workspace archive for workspace: Paseo transport dropped/);
  assert.equal(f.current().resolution.archiveIntentWorkspaceId,'workspace');
  assert.deepEqual(f.current().resolution.archivedWorkspaceIds,[]);
  observe=async()=>false;
  await lifecycle.pass();assert.equal(archives,0,'a successful observation alone does not bypass retry backoff');
  expireWorkspaceArchiveBackoff(f);await lifecycle.pass();
  assert.equal(archives,1);
  assert.deepEqual(f.current().resolution.archivedWorkspaceIds,['workspace']);
  assert.equal(f.current().resolution.archiveIntentWorkspaceId,null);assert.equal(f.current().resolution.cleanupReason,'');
 }finally{await f.close();}
});

test('missing-directory preservation applies to disposition archive, not task removal',async()=>{
 const {PaseoAdapter}=await import('../service/paseo-composition');const f=fixture();const git=queueWorktree(f.task.id);try{
  const task={...f.task,repoPath:git.repo};
  const missing=join(f.dir,'missing-worktree');
  const adapter=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
  Object.defineProperty(adapter,'helperPath',{value:join(f.dir,'worker-report.mjs')});
  Object.defineProperty(adapter,'api',{value:{workspaces:{ref:()=>({directory:missing,refresh:async()=>{},current:()=>({projectRootPath:task.repoPath,worktreeSlug:f.task.branch})})}}});
  assert.deepEqual(await adapter.archiveTaskWorkspace(task,'workspace',missing,'',()=>true,false,true),[]);
  await assert.rejects(adapter.archiveTaskWorkspace(task,'workspace',missing,'',()=>true,false,true,new Set(),true),/missing directory/);
 }finally{git.close();await f.close();}
});

test('late accepted reports clear reminder attention and continue processing',async()=>{
 const f=fixture();try{
  f.adapter.agentTimelinePage=undefined;
  await f.engine.wake();const r=f.run();f.idle(r.agentId!);
  f.store.putRun({ ...f.store.run(r.id)!, idleSince: new Date(Date.now() - 200_000).toISOString() });
  await f.engine.wake();
  // The zero grace sends one reminder and expires it on the next pass: coordinator attention, not silence.
  await f.engine.wake();
  assert.equal(f.current().resolution.attention,true);
  await f.reportStep('ready_to_merge');assert.equal(f.current().resolution.attention,false);assert.equal(f.current().phase,'verifying');
 }finally{await f.close();}
});
test('persisted late-report warnings recover on the next pass without clearing other safety errors',async()=>{
 const f=fixture();try{
  await f.engine.wake();const r=f.run();f.idle(r.agentId!);
  f.engine.resolution.complete({eventId:'late',taskId:f.task.id,runId:r.id,status:'ready_to_merge',summary:'Reviewed',head,reviewCommentId:1},f.tokens.get(r.id)!);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,attention:true},reason:`The reviewer thread stopped without a callback; inspect the thread`});
  await f.step();assert.equal(f.current().phase,'verifying');assert.equal(f.current().resolution.attention,false);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,attention:true},reason:'Review identity mismatch'});await f.engine.wake();assert.equal(f.current().resolution.attention,true);
 }finally{await f.close();}
});

test('an incoming completion preserves unrelated safety attention',async()=>{
 const f=fixture();try{
  await f.engine.wake();f.store.update(f.task.id,{resolution:{...f.current().resolution,attention:true},reason:'Workspace identity mismatch'});
  await f.report('ready_to_merge');assert.equal(f.current().resolution.attention,true);assert.equal(f.current().reason,'Workspace identity mismatch');assert.equal(f.current().phase,'reviewing');
 }finally{await f.close();}
});

test('a coordinator route for an unavailable required reviewer applies although the stop churns between a wait and a stop (consumer-b #639)',async()=>{
 const f=fixture();try{
  enableRecovery(f);
  const reviewer=f.store.pool().find(entry=>entry.roles.includes('reviewer'))!;
  const backup=profile('backup-reviewer');f.engine.profiles.push(backup);
  f.store.setMeta('pool',[...f.store.pool(),{profileId:backup.id,enabled:true,group:'backup',roles:['reviewer'],weight:1,scopes:['general']}]);
  const run=f.store.runs(f.task.id).find(item=>!item.released);if(run)f.store.putRun({...run,released:true,status:'superseded'});
  f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run(reviewer.group,JSON.stringify({group:reviewer.group,unavailable:true,reason:'balance exhausted',retryAt:null}));
  f.store.update(f.task.id,{phase:'awaiting_review',profileRequests:{...f.current().profileRequests,reviewer:{profileId:reviewer.profileId,reason:'Owner chose this reviewer',required:true}},
   resolution:{...f.current().resolution,currentRunId:null,attention:true}});
  const waitText=()=>`No eligible independent reviewer profile; check the profile pool${f.engine.resolution.requiredRouteNote(f.current(),'reviewer')}`;
  f.engine.resolution.waiting(f.current(),waitText(),'route_unavailable');
  await f.engine.wake();
  const coordinator=f.store.runs(f.task.id).find(item=>item.role==='recovery'&&!item.released)!;
  assert.ok(coordinator,'a coordinator is asked: it can route the reviewer elsewhere');
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:coordinator.id,status:'recovered',summary:'Route the reviewer to an available profile',
   coordinatorAction:{verb:'route',role:'reviewer',profileId:backup.id,reason:'The required reviewer group is unavailable'},coordinatorGeneration:coordinator.generation},f.tokens.get(coordinator.id)!);
  // The reviewer selection re-records its wait before the report applies: the stop churns, the task has not moved.
  f.engine.resolution.waiting(f.current(),waitText(),'route_unavailable');
  f.idle(coordinator.agentId!,coordinator.workspaceId);
  await f.engine.resolution.recovery.pass();
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='coordinator_action_applied'),JSON.stringify(f.current().resolution.recovery?.action));
  assert.equal(f.current().profileRequests?.reviewer?.profileId,backup.id,'the reviewer is routed elsewhere');
 }finally{await f.close()}
});

test('a coordinator cannot report over a still-bound worker does not escalate', async () => {
 const f=fixture(); try {
  enableRecovery(f);
  f.store.update(f.task.id,{phase:'working',completion:null,prHead:null,prUrl:null,
   resolution:{...f.current().resolution,attention:true},reason:'Waiting for worker callback'});
  await f.engine.wake();
  const recovery=f.store.run(f.current().resolution.recovery!.runId!)!;
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:recovery.id,status:'blocked',summary:'Worker is still live',
   coordinatorAction:{verb:'cannot',reason:'Worker is still live'},coordinatorGeneration:recovery.generation},f.tokens.get(recovery.id)!);
  f.idle(recovery.agentId!,recovery.workspaceId);
  await f.engine.resolution.recovery.pass();
  assert.notEqual(f.current().resolution.recovery?.status,'escalated');
  assert.equal(f.current().runId,'initial');
  assert.equal(f.current().completion,null);
 } finally { await f.close() }
});

test('a coordinator waits for the current revision worker rather than escalating', async () => {
 const f=fixture(); try {
  enableRecovery(f);
  const revision:Run={id:'live-revision',taskId:f.task.id,role:'revision',generation:1,head,base,agentId:'worker',workspaceId:'workspace',profile:f.current().profile,
   status:'running',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,completion:null,released:false};
  f.store.putRun(revision);
  f.store.update(f.task.id,{phase:'changes_requested',reason:'Waiting for revision callback',
   resolution:{...f.current().resolution,currentRunId:revision.id,attention:true}});
  await f.engine.resolution.recovery.route(f.current());
  assert.equal(f.current().resolution.currentRunId,revision.id);
  f.states.set('worker',{...f.states.get('worker')!,status:'running',active:true});
  const recovery=f.store.run(f.current().resolution.recovery!.runId!)!;
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:recovery.id,status:'blocked',summary:'Revision is still live',
   coordinatorAction:{verb:'cannot',reason:'Revision is still live'},coordinatorGeneration:recovery.generation},f.tokens.get(recovery.id)!);
  f.idle(recovery.agentId!,recovery.workspaceId);
  await f.engine.resolution.recovery.pass();
  assert.notEqual(f.current().resolution.recovery?.status,'escalated');
  assert.equal(f.current().resolution.currentRunId,revision.id);
  assert.equal(f.store.run(revision.id)?.released,false);
 } finally { await f.close() }
});

test('a coordinator that cannot settle a stop escalates it to the owner, and stop churn asks no second coordinator (consumer-b #639, review #542)',async()=>{
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:r.id,status:'recovered',summary:'Nothing I can do here',coordinatorAction:{verb:'cannot',reason:'Needs an owner ruling'},coordinatorGeneration:r.generation},f.tokens.get(r.id)!);
  f.idle(r.agentId!,r.workspaceId);
  for(let pass=0;pass<4;pass++){
   await f.engine.wake();
   // The stop churns between a wait and a stop for the same condition (review #542).
   f.engine.resolution.waiting(f.current(),`No eligible independent reviewer profile; churn ${pass}`,'route_unavailable');
  }
  assert.equal(f.current().resolution.recovery?.status,'escalated');
  assert.match(f.current().resolution.recovery?.summary??'',/cannot settle this stop: Needs an owner ruling/);
  assert.equal(f.store.runs(f.task.id).filter(item=>item.role==='recovery').length,1,'no second coordinator for an escalated stop');
 }finally{await f.close()}
});

test('three coordinator runs that applied nothing stop coordinator recovery and escalate to the owner; only an explicit coordinator restart re-arms it (Tom, 2026-10-27)',async()=>{
 const {COORDINATOR_LOOP_LIMIT,COORDINATOR_LOOP_SUMMARY}=await import('../core/recovery/recovery-bound');
 const f=fixture();try{
  enableRecovery(f);
  for(let index=0;index<COORDINATOR_LOOP_LIMIT;index++)f.store.putRun({id:`looped-${index}`,taskId:f.task.id,role:'recovery',generation:f.current().coordinatorGeneration,head,base,agentId:`coordinator-${index}`,workspaceId:'workspace',profile:null,status:'finished',
   createdAt:new Date(Date.now()+index).toISOString(),lastObservedAt:null,active:false,idleSince:null,released:true,completion:null} as never);
  attention(f,'A fault the coordinators kept failing to settle');
  await f.engine.wake();
  const looped=f.store.runs(f.task.id).filter(run=>run.role==='recovery');
  assert.equal(looped.length,COORDINATOR_LOOP_LIMIT,'no further coordinator run');
  assert.equal(f.current().resolution.recovery?.status,'escalated');
  assert.equal(f.current().resolution.recovery?.summary,COORDINATOR_LOOP_SUMMARY);
  await f.engine.wake();
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='recovery_escalated').length,1,'one escalation, not one per pass');
  // A routine owner verb at unchanged work is not progress: the bound stays.
  await new Promise(resolve=>setTimeout(resolve,5));
  f.store.event(f.task.id,'owner_control',JSON.stringify({verb:'restart',caller:'owner-thread',ownerThread:true,identities:{restart:{role:'reviewer',fresh:false}}}));
  f.store.update(f.task.id,{resolution:{...f.current().resolution,recovery:null}});
  await f.engine.wake();
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,COORDINATOR_LOOP_LIMIT,'an ordinary restart does not buy another coordinator');
  // One explicit coordinator restart is the deliberate, visible re-arm.
  f.store.event(f.task.id,'owner_control',JSON.stringify({verb:'restart',caller:'owner-thread',ownerThread:true,identities:{restart:{role:'coordinator',fresh:false}}}));
  f.store.update(f.task.id,{resolution:{...f.current().resolution,recovery:null}});
  await f.engine.wake();
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,COORDINATOR_LOOP_LIMIT+1,'a coordinator runs again after the explicit coordinator restart');
 }finally{await f.close()}
});
function enableRecovery(f:ReturnType<typeof fixture>){Object.assign(f.adapter,{supportsCoordinatorRecovery:true});const recipients:string[]=[];f.adapter.notify=async(id)=>{recipients.push(id)};return recipients;}
function attention(f:ReturnType<typeof fixture>,reason='Local integration check failed'){return f.store.update(f.task.id,{resolution:{...f.current().resolution,attention:true},reason});}
function prePrRecovery(f:ReturnType<typeof fixture>){
 enableRecovery(f);
 f.store.update(f.task.id,{phase:'blocked',reason:'Waiting for a project slot… Global concurrent task-slot limit reached (5/5 occupied)',resolution:{...f.current().resolution,currentRunId:null,attention:true}});
}
function resumes(f:ReturnType<typeof fixture>){return f.store.events(f.task.id).filter(event=>event.kind==='worker_resume_requested');}
test('blocked reviewer and closeout results on responsible tasks reach the planner ladder',async()=>{
 for(const role of ['reviewer','closeout'] as const){
  const f=fixture();try{
   if(role==='closeout')f.store.update(f.task.id,{phase:'closing'});
   await f.engine.resolution.launch(f.current(),role);
   const result=await f.report('blocked');
   assert.equal(result.status,'blocked');
   assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='planner_escalation').length,1,`${role} blocker reaches planner`);
   // Queue #912: the ladder now takes the planner path here; the wait names its open escalation.
   assert.match(f.current().reason,/^Waiting with the planner(?: or task owner \S+)?: blocker escalation/,'the ladder wait names its open escalation');
  }finally{await f.close()}
 }
});
test('a blocked responsible recovery report reaches the planner ladder',async()=>{
 const f=fixture();try{
  // #1003: a ready review or merge step skips the ladder (next case), so this task is past that step.
  f.store.update(f.task.id,{phase:'verifying'});
  enableRecovery(f);attention(f);await f.engine.wake();
  const run=f.store.runs(f.task.id).findLast(item=>item.role==='recovery')!;
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:run.id,status:'blocked',summary:'The recovery probe found a changed helper hash',coordinatorGeneration:run.generation},f.tokens.get(run.id)!);
  f.idle(run.agentId!,run.workspaceId);
  await f.engine.resolution.recovery.pass(f.task.id);
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='planner_escalation').length,1);
  assert.match(f.current().reason,/changed helper hash/);
 }finally{await f.close()}
});
test('a blocked recovery report about a ready review step resumes that step instead of asking the planner',async()=>{
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();
  const run=f.store.runs(f.task.id).findLast(item=>item.role==='recovery')!;
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:run.id,status:'blocked',summary:'The recovery probe found a changed helper hash',coordinatorGeneration:run.generation},f.tokens.get(run.id)!);
  f.idle(run.agentId!,run.workspaceId);
  await f.engine.resolution.recovery.pass(f.task.id);
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='planner_escalation').length,0);
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='planner_escalation_avoided').length,1);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='run_completion'&&/changed helper hash/.test(event.detail)),'the report stays on the record');
 }finally{await f.close()}
});
test('a settled recovery closes the incident it owns in the same settlement',async()=>{
 const f=fixture();try{
  const incident=f.engine.resolution.ensureIncident(f.current(),null,'External merge check: workspace identity is unknown');
  const recoveryRun=runSchema.parse({id:'recovery-settles-incident',taskId:f.task.id,role:'recovery',generation:f.current().coordinatorGeneration,
   head,base,agentId:'coordinator',workspaceId:'workspace',profile:profile('coordinator'),status:'finished',createdAt:new Date().toISOString(),
   lastObservedAt:null,active:false,idleSince:null,completion:{eventId:'settled-report',taskId:f.task.id,runId:'recovery-settles-incident',
    status:'recovered',summary:'The external merge check trigger has settled'},released:false});
  f.store.putRun(recoveryRun);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,recoveryActive:true,
   recovery:{id:'episode',key:'episode-key',generation:recoveryRun.generation,runId:recoveryRun.id,agentId:'coordinator',status:'running',
    summary:'',idleSince:null,incidentId:incident.id},incident}});
  f.store.transaction(()=>f.engine.resolution.recovery.settleFinishedRun(f.current(),recoveryRun,'Recovery report had no owner action'));
  const settled=f.current();
  assert.equal(settled.resolution.recovery?.status,'resolved');
  assert.equal(settled.resolution.incident?.status,'resolved');
  assert.match(settled.resolution.incident?.detail??'',/trigger settled/);
  assert.equal(f.store.run(recoveryRun.id)?.released,true);
 }finally{await f.close()}
});
test('next offers retry_effect for a reconciling incident with no active recovery and the retry settles it',async()=>{
 const f=fixture();try{
  const incident=f.engine.resolution.ensureIncident(f.current(),null,'External merge check: workspace identity is unknown');
  const next=ownerTaskNext(collectOwnerVerbFacts(f.store,f.current()));
  const retry=next.verbs.find(view=>view.verb==='retry_effect'&&view.available&&view.args?.effect===`incident.${incident.id}`);
  assert.ok(retry,'the orphaned incident is exposed as a retryable effect');
  const result=await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.current().version,
   action:'retry_effect',effect:`incident.${incident.id}`,reason:'Re-prove that no recovery run remains'}));
  assert.equal(result.resolution.incident?.status,'resolved');
  assert.match(result.resolution.incident?.detail??'',/re-proved no active recovery/);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='incident_reproved_settled'));
 }finally{await f.close()}
});
async function recoveryReport(f:ReturnType<typeof fixture>,status:'recovered'|'escalate',recoveryAction?:Completion['recoveryAction']){
 const r=f.store.run(f.current().resolution.recovery!.runId!)!;f.idle(r.agentId!,r.workspaceId);
 const input:Completion={eventId:randomUUID(),taskId:f.task.id,runId:r.id,status,summary:status==='escalate'?'Need operator approval for a one-shot capture':'Confirmed the integration blocker is cleared',coordinatorGeneration:r.generation,recoveryAction};
 f.engine.resolution.complete(input,f.tokens.get(r.id)!);await f.engine.wake();return{r,input};
}
test('linked open decisions own the wait and suppress recovery until the decision closes',async()=>{
 const f=fixture();try{
  enableRecovery(f);attention(f,'Waiting for a project slot… Project concurrent task-slot limit reached');
  const decisions=new Decisions(f.store),decision=decisions.add({question:'Which source should be used?',askedBy:'origin',tasks:[f.task.id]});
  const decisionId=f.store.listDecisions({status:'open',task:f.task.id})[0]!.id;
  const context=taskWaitStateContext(f.store,f.current(),decisionId,task=>f.engine.resolution.slotAdmissionReason(task));
  assert.equal(taskDetailView(f.current(),context).waitState?.state,'needs_operator_input');
  assert.equal(taskDetailView(f.current(),context).waitState?.decisionId,decision.id);
  assert.equal(await f.engine.resolution.recovery.route(f.current()),null);
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,0);
  assert.equal(f.creates.length,0);
  decisions.answer({id:decision.id,version:1,answer:'Use source A',answeredBy:'operator',relayed:false,note:''});
  await f.engine.resolution.recovery.route(f.current());
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,1,'answering the decision returns the task to normal recovery handling');
 }finally{await f.close()}
});
test('a queued task waiting on dependsOn keeps its prerequisite stop and never enters recovery',async()=>{
 const f=fixture(true);try{
  enableRecovery(f);
  const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Upstream',repoPath:'/repo',planningCommit:base,handoffPath:'up.md',originAgentId:'origin'}),'host','source',base);
  f.store.update(prerequisite.id,{phase:'working',workspaceId:'up-workspace',agentId:'up-worker',agentActive:true});
  const queued=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Downstream',repoPath:'/repo',planningCommit:base,handoffPath:'down.md',originAgentId:'origin',dependsOn:[prerequisite.id]}),'host','source',base);
  const detail=f.store.dependencyWait(f.store.task(queued.id));
  assert.ok(detail,'the queued task is waiting on its dependency');
  f.store.update(queued.id,{reason:detail,resolution:{...f.store.task(queued.id).resolution,stop:{reason:'prerequisite',detail,since:new Date().toISOString(),suggestedVerbs:[]}}});
  // Several passes while the prerequisite is still working: the stop stays, no incident, no escalation.
  for(let i=0;i<3;i++)assert.equal(await f.engine.resolution.recovery.route(f.store.task(queued.id)),null);
  const held=f.store.task(queued.id);
  assert.equal(held.resolution.stop?.reason,'prerequisite');assert.equal(held.resolution.incident,null);assert.equal(held.resolution.recovery,null);
  assert.equal(f.store.eventsAll(queued.id).filter(event=>event.kind==='task_wait_cleared').length,0);
 }finally{await f.close()}
});

test('retained prerequisite waits pause recovery, release once, notify the owner and do not revise',async()=>{
 const f=fixture(true);try{
  const recipients=enableRecovery(f);
  const addPrerequisite=(title:string)=>f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title,repoPath:'/repo',planningCommit:base,handoffPath:title+'.md',originAgentId:'origin'}),'host','source',base);
  const first=addPrerequisite('Source one'),second=addPrerequisite('Source two');
  f.store.update(first.id,{phase:'working',workspaceId:'source-one-workspace',agentId:'source-one-worker',agentActive:true});
  f.store.update(second.id,{phase:'working',workspaceId:'source-two-workspace',agentId:'source-two-worker',agentActive:true});
  f.store.update(f.task.id,{phase:'changes_requested'});
  attention(f,'Waiting for a project slot… Project concurrent task-slot limit reached');
  const before=f.current();
  const waiting=await f.engine.performTaskControl({taskId:before.id,version:before.version,action:'set_prerequisite_wait',waitsFor:[first.id,second.id],reason:'Wait for the upstream source capture'});
  assert.equal(waiting.phase,before.phase);assert.equal(waiting.reason,before.reason);assert.equal(waiting.prUrl,before.prUrl);
  assert.equal(waiting.agentId,before.agentId);assert.equal(waiting.workspaceId,before.workspaceId);assert.equal(waiting.held,before.held);
  assert.deepEqual(waiting.prerequisiteWait?.waitsFor,[first.id,second.id].sort());
  const context=taskWaitStateContext(f.store,waiting,null,task=>f.engine.resolution.slotAdmissionReason(task));
  const waitState=taskDetailView(waiting,context).waitState;
  assert.equal(waitState?.state,'waiting_prerequisite');assert.equal(waitState?.reason,'Wait for the upstream source capture');
  assert.equal(waitState?.owner,[first.id,second.id].sort().join(', '));
  assert.equal(await f.engine.resolution.recovery.route(waiting),null);
  assert.equal(f.creates.length,0,'an unchanged prerequisite wait never starts coordinator recovery');
  f.store.update(first.id,{phase:'done'});
  assert.equal(f.store.reconcilePrerequisiteWait(waiting.id),'waiting','all listed prerequisites must finish before release');
  assert.equal(f.store.notices(waiting.id).filter(notice=>notice.kind==='prerequisite').length,0);
  f.store.update(second.id,{phase:'done'});
  await f.engine.wake();
  await f.engine.wake();
  const released=f.current();
  assert.ok(released.prerequisiteWait?.releasedAt);
  assert.equal(released.phase,before.phase);assert.equal(released.reason,before.reason);assert.equal(released.prUrl,before.prUrl);
  assert.equal(f.store.runs(released.id).filter(run=>run.role==='revision'||run.role==='recovery').length,0);
  assert.equal(f.creates.length,0,'normal sweeps do not automatically revise a released wait');
  assert.equal(await f.engine.resolution.recovery.route(released),null,'a coordinator cannot turn prerequisite completion into a revision');
  const notices=f.store.notices(released.id).filter(notice=>notice.kind==='prerequisite');
  assert.equal(notices.length,1);assert.equal(notices[0]!.status,'delivered');
  assert.deepEqual(recipients,['origin'],'the owner receives exactly one notice');
 }finally{await f.close()}
});
test('releasing a prerequisite wait clears its own stop and leaves any other stop',async()=>{
 for(const reason of ['prerequisite','operator_needed'] as const){
  const f=fixture();try{
   const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Source capture',repoPath:'/repo',planningCommit:base,handoffPath:'source.md',originAgentId:'origin'}),'host','source',base);
   const waiting=f.store.setPrerequisiteWait(f.current(),[prerequisite.id],'Wait for the upstream source capture',f.current().version);
   const stop=taskStopRecord(reason,reason==='prerequisite'?'Waiting for prerequisite Source capture':'Owner decision needed');
   f.store.update(waiting.id,{resolution:{...f.current().resolution,stop}});
   f.store.update(prerequisite.id,{phase:'done'});
   assert.equal(f.store.reconcilePrerequisiteWait(waiting.id),'released');
   assert.deepEqual(f.current().resolution.stop,reason==='prerequisite'?null:stop,reason);
  }finally{await f.close()}
 }
});
test('resume_worker clears a released prerequisite wait before dispatching the continuation',async()=>{
 const f=fixture();try{
  const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Source capture',repoPath:'/repo',planningCommit:base,handoffPath:'source.md',originAgentId:'origin'}),'host','source',base);
  f.store.update(prerequisite.id,{phase:'done'});
  const blockedCompletion:Completion={eventId:'blocked-before-resume',taskId:f.task.id,runId:'initial',status:'blocked',summary:'Waiting for the source capture'};
  const blocked=f.store.update(f.task.id,{phase:'blocked',reason:blockedCompletion.summary,completion:blockedCompletion,prHead:null,prUrl:null,resumePrNumber:null});
  const waiting=f.store.setPrerequisiteWait(blocked,[prerequisite.id],'Wait for the upstream source capture',blocked.version);
  assert.equal(f.store.reconcilePrerequisiteWait(waiting.id),'released');
  const released=f.current();assert.ok(released.prerequisiteWait?.releasedAt);
  f.adapter.verifyResume=async()=>head;

  const resumed=await f.engine.performTaskControl({taskId:released.id,version:released.version,action:'restart',role:'worker',reason:'Resume the retained worker',instruction:'Continue the approved pre-PR work'});
  assert.equal(resumed.phase,'changes_requested');
  assert.equal(resumed.prerequisiteWait,null);
  assert.ok(f.store.events(resumed.id).some(event=>event.kind==='prerequisite_wait_resumed'));
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.equal(f.sends.filter(run=>run.role==='revision').length,1);
 }finally{await f.close()}
});
test('move to work refuses an open prerequisite wait and clears a released one so the revision launches',async()=>{
 const f=fixture();try{
  const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Upstream fix',repoPath:'/repo',planningCommit:base,handoffPath:'upstream.md',originAgentId:'origin'}),'host','upstream',base);
  const review={eventId:'review-required',taskId:f.task.id,runId:'review-run',status:'changes_required' as const,summary:'Fix the escaped route links',head};
  f.store.update(f.task.id,{phase:'changes_requested',reason:review.summary,resolution:{...f.current().resolution,review}});
  f.store.setPrerequisiteWait(f.current(),[prerequisite.id],'Wait for the upstream fix',f.current().version);
  const workView=ownerTaskNext(collectOwnerVerbFacts(f.store,f.current())).verbs.find(verb=>verb.verb==='move'&&(verb.available?verb.args?.to==='work':verb.refusal?.startsWith('move work:')));
  assert.equal(workView?.available,false);assert.match(workView!.refusal!,/waiting for its retained prerequisites/,'next refuses what the move refuses');
  await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'work',reason:'Return to the author'}),/waiting for its retained prerequisites/);
  f.store.update(prerequisite.id,{phase:'done'});assert.equal(f.store.reconcilePrerequisiteWait(f.task.id),'released');
  const moved=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'work',reason:'Return to the author'});
  assert.equal(moved.prerequisiteWait,null);
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='prerequisite_wait_resumed'));
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.equal(f.run().instruction,'Fix the escaped route links');
 }finally{await f.close()}
});
test('owner resume re-arms a parked pre-PR continuation after its prerequisite finishes',async()=>{
 const f=fixture();try{
  const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Numbering repair',repoPath:'/repo',planningCommit:base,handoffPath:'repair.md',originAgentId:'origin'}),'host','repair',base);
  const completion:Completion={eventId:'parked-block',taskId:f.task.id,runId:'initial',status:'blocked',summary:'Numbering repair required'};
  f.store.update(f.task.id,{phase:'changes_requested',completion,prHead:null,prUrl:null,resumePrNumber:null,resolution:{...f.current().resolution,prePrResumeInstruction:'Continue the original approved scope',pendingWorkerInstruction:'Continue the original approved scope'}});
  let current=f.current();f.store.setPrerequisiteWait(current,[prerequisite.id],'Wait for repair',current.version);
  assert.throws(()=>f.engine.resolution.resumeWorker(f.current(),'Continue after repair',true),/waiting for its retained prerequisites/);
  f.store.update(prerequisite.id,{phase:'done'});assert.equal(f.store.reconcilePrerequisiteWait(f.task.id),'released');
  current=f.current();
  assert.throws(()=>f.engine.resolution.resumeWorker(current,'Continue after repair'),/blocked result or stopped pre-callback worker/,'automatic recovery cannot re-arm it');
  assert.throws(()=>f.engine.resolution.resumeWorker({...current,prerequisiteWait:null},'Continue',true),/blocked result or stopped pre-callback worker/);
  assert.throws(()=>f.engine.resolution.resumeWorker({...current,completion:{...completion,runId:'foreign'}},'Continue',true),/blocked result or stopped pre-callback worker/);
  assert.throws(()=>f.engine.resolution.resumeWorker({...current,resolution:{...current.resolution,prePrResumeInstruction:null}},'Continue',true),/blocked result or stopped pre-callback worker/);
  f.adapter.verifyResume=async()=>head;
  const resumed=await f.engine.performTaskControl({taskId:current.id,version:current.version,action:'restart',role:'worker',reason:'Resume the retained worker',instruction:'Continue the approved scope after the verified numbering repair; retain completed evidence'});
  assert.equal(resumed.prerequisiteWait,null);assert.deepEqual(resumed.completion,completion);
  await f.engine.wake();const run=f.run();assert.equal(run.role,'revision');assert.equal(run.agentId,'worker');assert.equal(run.workspaceId,'workspace');
  assert.notEqual(run.id,'initial');assert.equal(f.creates.length,0);assert.equal(f.sends.length,1);assert.match(run.instruction!,/verified numbering repair/);
  await f.report('ready_for_review');assert.equal(f.current().completion?.runId,run.id,'only genuine new readiness replaces the blocked initial result');
 }finally{await f.close()}
});
test('set_prerequisite_wait records during a live run, stays visible, and can clear',async()=>{
 const f=fixture();try{
  const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Source',repoPath:'/repo',planningCommit:base,handoffPath:'source.md',originAgentId:'origin'}),'host','source',base);
  const control=(version:number,waitsFor:string[])=>({taskId:f.task.id,version,action:'set_prerequisite_wait' as const,waitsFor,reason:'Wait for source evidence'});
  const live:Run={id:'live-review',taskId:f.task.id,role:'reviewer',generation:1,head,base,agentId:'reviewer',workspaceId:'workspace',profile:profile('reviewer'),status:'running',createdAt:new Date().toISOString(),lastObservedAt:null,active:true,idleSince:null,completion:null,released:false};
  f.store.putRun(live);
  const duringRun=await f.engine.performTaskControl(control(f.current().version,[prerequisite.id]));
  assert.deepEqual(duringRun.prerequisiteWait?.waitsFor,[prerequisite.id]);
  assert.equal(duringRun.phase,f.task.phase);
  assert.equal(f.store.run(live.id)?.released,false,'the live run is not interrupted');
  f.store.putRun({...live,status:'finished',active:false,released:true});
  f.store.update(f.task.id,{agentActive:true,prerequisiteWait:null});
  const duringAgent=await f.engine.performTaskControl(control(f.current().version,[prerequisite.id]));
  assert.ok(duringAgent.prerequisiteWait);
  f.store.update(f.task.id,{agentActive:false});
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeIntent:true}});
  await assert.rejects(f.engine.performTaskControl(control(f.current().version,[prerequisite.id])),/merge intent/);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergeIntent:false}});
  await assert.rejects(f.engine.performTaskControl(control(f.current().version,['missing-prerequisite'])),/does not exist/);
  const cleared=await f.engine.performTaskControl(control(f.current().version,[]));
  assert.equal(cleared.prerequisiteWait,null);
  await assert.rejects(f.engine.performTaskControl({...control(cleared.version,[]),taskId:'unknown'}),/Task not found/);
 }finally{await f.close()}
});
test('set_prerequisite_wait during a readiness revision blocks the next reviewer dispatch',async()=>{
 const f=fixture();try{
  const prerequisite=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Source capture',repoPath:'/repo',planningCommit:base,handoffPath:'source.md',originAgentId:'origin'}),'host','source',base);
  f.store.update(prerequisite.id,{phase:'working'});
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'work',reason:'Return to the retained author'});
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  const before=f.current();
  const waiting=await f.engine.performTaskControl({taskId:before.id,version:before.version,action:'set_prerequisite_wait',waitsFor:[prerequisite.id],reason:'Wait for the upstream source capture'});
  assert.ok(waiting.prerequisiteWait);
  assert.equal(waiting.phase,before.phase);
  assert.equal(f.run().role,'revision');
  const context=taskWaitStateContext(f.store,waiting,null,task=>f.engine.resolution.slotAdmissionReason(task));
  assert.equal(taskDetailView(waiting,context).waitState?.state,'waiting_prerequisite');
  assert.equal(f.engine.resolution.slotAdmissionReason(waiting),'');
  await f.report('ready_for_review');
  const released=f.current();
  assert.equal(released.phase,'awaiting_review');
  assert.ok(released.prerequisiteWait&&!released.prerequisiteWait.releasedAt);
  assert.equal(f.store.runs(released.id).filter(run=>run.role==='reviewer').length,0,'the wait takes effect before the next reviewer dispatch');
  await f.engine.wake();
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='reviewer').length,0);
  assert.equal(f.current().phase,'awaiting_review');
 }finally{await f.close()}
});
test('an observe race cannot wipe an accepted recovery completion or describe it as a missing result',async()=>{
 const f=fixture();try{
  prePrRecovery(f);await f.engine.wake();const recovery=f.store.run(f.current().resolution.recovery!.runId!)!;
  const instruction='Continue after the capacity stall';
  const observe=f.adapter.observe.bind(f.adapter);
  let injected=false;
  f.adapter.observe=async id=>{
   const state=await observe(id);
   if(id===recovery.agentId&&!injected){
    injected=true;
    f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:recovery.id,status:'blocked',summary:instruction,coordinatorAction:{verb:'cannot',reason:instruction},coordinatorGeneration:recovery.generation},f.tokens.get(recovery.id)!);
   }
   return state;
  };
  f.idle(recovery.agentId!,recovery.workspaceId);
  f.store.putRun({...f.store.run(recovery.id)!,idleSince:new Date(Date.now()-1000).toISOString()});
  await f.engine.resolution.recovery.pass();
  const finished=f.store.run(recovery.id)!;
  // The pre-pass observation kept the run's completion; the typed report is
  // settled instead of being read as no result.
  assert.equal(finished.completion?.status,'blocked');
  assert.equal(finished.released,true);
  assert.equal(f.current().resolution.recovery?.action?.status,'refused');
  assert.ok(!f.store.events(f.task.id).some(event=>event.kind==='recovery_escalated'&&event.detail.includes('stopped without a result')));
 }finally{await f.close()}
});
test('stale-generation and wrong-role recovery rejections stay closed and bind nothing',async()=>{
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;
  f.idle(r.agentId!,r.workspaceId);
  const token=f.tokens.get(r.id)!;
  assert.throws(()=>f.engine.resolution.complete({eventId:'stale-gen',taskId:f.task.id,runId:r.id,status:'recovered',summary:'Stale',recoveryAction:'retry',coordinatorGeneration:r.generation+1},token),/Superseded coordinator assignment/);
  assert.throws(()=>f.engine.resolution.complete({eventId:'unknown-run',taskId:f.task.id,runId:'no-such-run',status:'recovered',summary:'Lost',recoveryAction:'retry'},token),/Unknown run/);
  assert.throws(()=>f.engine.resolution.complete({eventId:'wrong-role',taskId:f.task.id,runId:r.id,status:'ready_for_review',summary:'Wrong role'},token),/Result is not valid for this run role/);
  assert.equal(f.store.run(r.id)?.completion,null);
  assert.equal(f.current().resolution.recovery?.action,undefined);
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='recovery_action_bound').length,0);
 }finally{await f.close()}
});
test('a retired recoveryAction report is refused at intake and binds nothing, so the coordinator can resend',async()=>{
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const recovery=f.store.run(f.current().resolution.recovery!.runId!)!;
  f.idle(recovery.agentId!,recovery.workspaceId);
  const token=f.tokens.get(recovery.id)!;
  // Lean audit 2026-10-15: refusing later cost an escalation per report; refusing now lets the same run correct it.
  assert.throws(()=>f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:recovery.id,status:'recovered',summary:'Return the worker to the open PR',recoveryAction:'resume_worker',coordinatorGeneration:recovery.generation},token),/recoveryAction is retired; report coordinatorAction/);
  assert.equal(f.store.run(recovery.id)?.completion,null,'nothing is stored');
  assert.throws(()=>f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:recovery.id,status:'recovered',summary:'No action',coordinatorGeneration:recovery.generation},token),/Recovery requires a coordinatorAction/);
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:recovery.id,status:'blocked',summary:'Needs the planner',coordinatorAction:{verb:'cannot',reason:'Needs the planner'},coordinatorGeneration:recovery.generation},token);
  assert.equal(f.store.run(recovery.id)?.completion?.status,'blocked','the corrected report is accepted on the same run');
  assert.equal(resumes(f).length,0);
 }finally{await f.close()}
});
test('an operator control that clears recovery mid-route stands the coordinator down without a malformed escalation',async()=>{
 const f=fixture();try{
  enableRecovery(f);
  f.store.update(f.task.id,{phase:'needs_attention',reason:'The socket connection was closed unexpectedly',completion:null,prHead:null,prUrl:null,resolution:{...f.current().resolution,currentRunId:null,attention:true}});
  // g05.195 at 03:17:11: resume_worker landed while route awaited, clearing the recovery it was building.
  const lease=f.engine.resolution.lease.bind(f.engine.resolution);
  f.engine.resolution.lease=async(t:any)=>{const ok=await lease(t);const cur=f.current();f.store.update(f.task.id,{resolution:{...cur.resolution,recovery:null}});return ok;};
  const creates=f.creates.length;
  const routed=await f.engine.resolution.recovery.route(f.current());
  assert.equal(routed,null);
  assert.equal(f.current().resolution.recovery,null,'no partial recovery is rebuilt');
  assert.equal(f.creates.length,creates,'no coordinator run is launched');
  assert.equal(f.store.runs(f.task.id).filter(r=>r.role==='recovery').length,0);
  assert.ok(!f.store.events(f.task.id).some(e=>e.kind==='recovery_escalated'),'nothing escalates');
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='recovery_superseded'));
 }finally{await f.close()}
});
test('coordinator resume replaces a freshly verified absent initial worker without a new workspace',async()=>{
 const f=fixture();try{
  enableRecovery(f);const oldRun='timed-out-run';let purged:string[]=[];
  f.adapter.purgeReportingFiles=(_task,runs)=>{purged=runs};
  f.store.update(f.task.id,{phase:'needs_attention',reason:ABSENT_WORKER_REASON,agentId:null,agentIntent:true,runId:oldRun,completion:null,prHead:null,prUrl:null,resolution:{...f.current().resolution,currentRunId:null,attention:true}});
  f.store.setCredential(oldRun,'old-token');await f.engine.wake();
  const recovery=f.store.run(f.current().resolution.recovery!.runId!)!;f.idle(recovery.agentId!,recovery.workspaceId);
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:recovery.id,status:'recovered',summary:'Exact run search is empty; continue the original handoff',coordinatorAction:{verb:'restart',reason:'Exact run search is empty; continue the original handoff'},coordinatorGeneration:recovery.generation},f.tokens.get(recovery.id)!);
  await f.engine.resolution.recovery.pass();const ready=f.current();
  assert.equal(ready.phase,'dispatching');assert.equal(ready.workspaceId,'workspace');assert.equal(ready.profile?.id,'author');
  assert.equal(ready.agentIntent,false);assert.equal(ready.agentId,null);assert.equal(ready.runId,oldRun);assert.equal(ready.restartRunId,oldRun);assert.deepEqual(purged,[oldRun]);
  assert.throws(()=>f.store.authenticate(oldRun,'old-token'),/Unauthorized/);
 }finally{await f.close()}
});
test('coordinator escalation is delivered once and includes the operator decision',async()=>{
 const f=fixture();try{
  const recipients=enableRecovery(f);attention(f);await f.engine.wake();await recoveryReport(f,'escalate');await f.engine.wake();
  assert.deepEqual(recipients,['origin']);assert.match(f.store.notices(f.task.id).find(notice=>notice.status==='delivered')!.text,/operator approval/);assert.equal(f.current().resolution.recovery?.status,'escalated');
 }finally{await f.close()}
});
test('paused recovery stores callbacks and defers both actions and origin messages',async()=>{
 const f=fixture();try{
  const recipients=enableRecovery(f);attention(f);f.store.setMeta('paused',true);await f.engine.wake();assert.equal(f.creates.length,0);
  f.store.setMeta('paused',false);await f.engine.wake();f.store.setMeta('paused',true);await recoveryReport(f,'escalate');assert.deepEqual(recipients,[]);assert.equal(f.current().resolution.recovery?.status,'running');
  // The origin is idle here, so resume delivers at once (#247 changed this test by mistake).
  f.store.setMeta('paused',false);await f.engine.wake();assert.deepEqual(recipients,['origin']);
 }finally{await f.close()}
});
test('a stopped closeout run is reminded once; expiry nudges without replacing its run or reporting binding',async()=>{
 const f=fixture();try{
  await f.engine.wake();
  // The real bridge requires full reviewText on a verdict; carry it so publication retention works.
  const reviewer=f.run();f.idle(reviewer.agentId!,reviewer.workspaceId);
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:reviewer.id,status:'ready_to_merge',summary:'ready_to_merge',head:reviewer.head,reviewCommentId:1,reviewText:'Approved at the exact head.'},f.tokens.get(reviewer.id)!);
  await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();const r=f.run(),recipients=enableRecovery(f);
  assert.equal(r.role,'closeout');
  f.idle(r.agentId!);await f.engine.wake();
  // One bounded callback reminder for the existing run; the run and its reporting binding stay untouched.
  assert.equal(f.current().resolution.currentRunId,r.id);assert.equal(f.sends.length,0);
  assert.equal(f.creates.filter(run=>run.role==='recovery').length,0);
  await f.reportStep('closed');assert.equal(f.current().phase,'done');
  // The late result reconciled the reminder incident before expiry; no recovery engagement was needed.
  assert.deepEqual(recipients,[r.agentId]);
  assert.equal(f.creates.filter(run=>run.role==='recovery').length,0);
 }finally{await f.close()}
});
test('uncertain recovery creation never creates duplicates and escalates once',async()=>{
 const f=fixture();try{
  const recipients=enableRecovery(f);let calls=0;f.adapter.createRun=async()=>{calls++;throw Error('Transport lost')};attention(f);await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(calls,1);assert.deepEqual(recipients,['origin']);assert.equal(f.current().resolution.recovery?.status,'escalated');
 }finally{await f.close()}
});
test('missing or busy coordinator routes wait without interrupting origin',async()=>{
 const f=fixture();try{
  const recipients=enableRecovery(f);f.store.setMeta('pool',[]);attention(f);await f.engine.wake();assert.deepEqual(recipients,[]);
  assert.equal(f.current().resolution.stop?.reason,'route_unavailable');assert.equal(f.current().resolution.recovery,null);
 }finally{await f.close()}
 const f2=fixture();try{
  const recipients=enableRecovery(f2);f2.store.update(f2.task.id,{coordinatorAgentId:'busy'});f2.states.set('busy',{id:'busy',workspaceId:'workspace',status:'running',active:true,permissions:false,error:''});attention(f2);await f2.engine.wake();assert.equal(f2.creates.length,0);assert.deepEqual(recipients,[]);
  assert.equal(f2.current().resolution.stop?.reason,'route_unavailable');assert.equal(f2.current().resolution.recovery,null);
 }finally{await f2.close()}
});
test('a retired narrow recovery action is refused at intake and launches no second recovery loop',async()=>{
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();
  f.adapter.verifyPr=async()=>{throw Error('Local integration check failed')};
  await assert.rejects(recoveryReport(f,'recovered','retry'),/recoveryAction is retired/);await f.engine.wake();
  assert.equal(f.creates.filter(r=>r.role==='recovery').length,1,'no second coordinator for the same stop');
  assert.ok(f.current().resolution.stop,'the unchanged stop stays visible for an owner verb');
 }finally{await f.close()}
});
test('a fallback coordinator report without a generation binds the authenticated run and keeps stale rejections',async()=>{
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;f.idle(r.agentId!,r.workspaceId);
  const token=f.tokens.get(r.id)!;
  // An explicitly stale generation is refused as superseded, never silently bound.
  assert.throws(()=>f.engine.resolution.complete({eventId:'stale-explicit',taskId:f.task.id,runId:r.id,status:'recovered',summary:'Stale',recoveryAction:'retry',coordinatorGeneration:r.generation+1},token),/Superseded coordinator assignment/);
  // An unknown run and a status outside the run's role are refused without touching the coordinator generation check.
  assert.throws(()=>f.engine.resolution.complete({eventId:'unknown',taskId:f.task.id,runId:'no-such-run',status:'recovered',summary:'Lost',recoveryAction:'retry'},token),/Unknown run/);
  assert.throws(()=>f.engine.resolution.complete({eventId:'wrong-role-status',taskId:f.task.id,runId:r.id,status:'ready_for_review',summary:'Wrong role'},token),/Result is not valid for this run role/);
  // The authenticated fallback omits coordinatorGeneration: the missing generation binds to the
  // authenticated run instead of reading as superseded, and the stored completion records the binding.
  f.engine.resolution.complete({eventId:'fallback-recovery',taskId:f.task.id,runId:r.id,status:'recovered',summary:'Confirmed the integration blocker is cleared',coordinatorAction:{verb:'restart',reason:'Confirmed the integration blocker is cleared'}},token);
  assert.equal(f.store.run(r.id)?.completion?.coordinatorGeneration,r.generation);
  assert.equal(f.store.run(r.id)?.completion?.status,'recovered');assert.equal(f.store.run(r.id)?.released,false);
  await f.engine.wake();assert.equal(f.store.run(r.id)?.completion?.status,'recovered','the bound fallback report survives the next engine pass');
  // #1005: settling the coordinator releases its run and revokes the credential.
  assert.equal(f.store.run(r.id)?.released,true);
  f.store.update(f.task.id,{coordinatorGeneration:r.generation+1});
  const settled=f.store.run(r.id);
  assert.throws(()=>f.engine.resolution.complete({eventId:'superseded-missing',taskId:f.task.id,runId:r.id,status:'escalate',summary:'Late'},token),/Unauthorized callback/);
  assert.throws(()=>f.engine.resolution.complete({eventId:'superseded-explicit',taskId:f.task.id,runId:r.id,status:'escalate',summary:'Late',coordinatorGeneration:r.generation},token),/Unauthorized callback/);
  assert.deepEqual(f.store.run(r.id),settled,'revoked callbacks leave the accepted report intact');
 }finally{await f.close()}
});
test('recovery ignores an accepted result if the operator has changed the issue',async()=>{
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;f.idle(r.agentId!);
  f.engine.resolution.complete({taskId:f.task.id,runId:r.id,eventId:'changed',status:'recovered',summary:'Retry',coordinatorAction:{verb:'restart',reason:'Retry'},coordinatorGeneration:r.generation},f.tokens.get(r.id)!);
  f.store.update(f.task.id,{phase:'working',reason:'Operator resumed work',resolution:{...f.current().resolution,attention:false}});await f.engine.resolution.recovery.pass();
  assert.equal(f.current().phase,'working');assert.equal(f.current().reason,'Operator resumed work');assert.equal(f.current().resolution.recovery?.status,'resolved');
  assert.equal(f.store.run(r.id)?.completion?.status,'recovered','the accepted report stays on the recovery run');
  assert.equal(f.current().resolution.recovery?.action?.status,'refused');
  assert.ok(!f.store.events(f.task.id).some(event=>event.kind==='recovery_escalated'&&event.detail===RECOVERY_STOPPED_WITHOUT_RESULT));
 }finally{await f.close()}
});
test('paused recovery continues observing thread idleness for drain detection',async()=>{
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;f.store.setMeta('paused',true);f.idle(r.agentId!);await f.engine.wake();
  assert.equal(f.store.run(r.id)?.active,false);assert.ok(f.store.run(r.id)?.lastObservedAt);assert.equal(f.store.run(r.id)?.released,false);assert.equal(f.current().resolution.recovery?.status,'running');
 }finally{await f.close()}
});
test('blocked-job recovery respects dispatch capacity and reserves a slot while running',async()=>{
 const f=fixture();try{
  enableRecovery(f);f.store.update(f.task.id,{phase:'blocked',reason:'Needs diagnosis'});f.store.setMeta('globalLimit',0);await f.engine.wake();assert.equal(f.creates.length,0);
  f.store.setMeta('globalLimit',1);await f.engine.wake();assert.equal(f.creates.length,1);assert.equal(f.current().resolution.recoveryActive,true);
  await recoveryReport(f,'escalate');assert.equal(f.current().resolution.recoveryActive,false);
 }finally{await f.close()}
});
test('capacity-only recovery waits before exhausted-budget escalation or origin notice',async()=>{
 const f=fixture();try{
  const recipients=enableRecovery(f);
  f.store.setMeta('globalLimit',0);
  f.store.update(f.task.id,{phase:'blocked',reason:'Needs diagnosis',resolution:{...f.current().resolution,recoveryAttempts:3}});
  await f.engine.wake();
  assert.equal(f.creates.length,0,'no coordinator run is created while capacity is unavailable');
  assert.deepEqual(recipients,[],'capacity waiting does not create an operator notice');
  assert.equal(f.current().resolution.recoveryAttempts,3,'waiting does not consume another recovery attempt');
  assert.notEqual(f.current().resolution.recovery?.status,'escalated','capacity alone does not exhaust or escalate the recovery');
  assert.match(f.current().reason,/Waiting for a project slot/);
 }finally{await f.close()}
});
test('a capacity-only needs_attention wait does not start coordinator recovery',async()=>{
 const f=fixture();try{
  enableRecovery(f);
  f.store.setMeta('globalLimit',0);
  const waiting='Waiting for a project slot… Global concurrent task-slot limit reached';
  f.store.update(f.task.id,{phase:'needs_attention',reason:waiting,resolution:{...f.current().resolution,attention:true,recoveryAttempts:3}});
  assert.equal(await f.engine.resolution.recovery.route(f.current()),null);
  assert.equal(f.creates.filter(run=>run.role==='recovery').length,0);
  assert.equal(f.store.runs(f.task.id).filter(run=>run.role==='recovery').length,0);
  assert.equal(f.current().resolution.recoveryAttempts,3);
  assert.notEqual(f.current().resolution.recovery?.status,'escalated');
  assert.equal(f.current().reason,`${waiting} (0/0 occupied)`);
 }finally{await f.close()}
});
test('authorized pre-PR continuation waits for a slot, verifies retained head, then launches once',async()=>{
 const f=fixture();try{
  const retainedHead='d'.repeat(40),instruction='Continue the approved source-capture work and preserve the pushed commit';
  let resumeVerifications=0;
  f.adapter.verifyResume=async()=>{resumeVerifications++;return retainedHead};
  f.store.setMeta('globalLimit',1);f.store.setMeta('projectLimit',1);
  const task=f.store.update(f.task.id,{phase:'blocked',reason:'Worker reported an environment blocker',prHead:null,prUrl:null,
   completion:{eventId:'blocked-result',taskId:f.task.id,runId:'initial',status:'blocked',summary:'Environment preparation is complete',head:retainedHead},agentActive:false,
   resolution:{...f.current().resolution,recoveryAttempts:2,recovery:{id:'old-recovery',key:'old-fault',generation:1,runId:null,agentId:null,status:'escalated',summary:'Prior diagnostic',idleSince:null,incidentId:null}}});
  const occupied=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Occupant',repoPath:'/repo',planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff',base);
  f.store.update(occupied.id,{phase:'working',workspaceIntent:true,workspaceId:'occupied-workspace',agentId:'occupied-worker',agentActive:true});
  const accepted=await f.engine.performTaskControl({taskId:task.id,version:task.version,action:'restart',role:'worker',reason:'Resume the retained worker',instruction});
  assert.equal(accepted.phase,'changes_requested');
  assert.equal(accepted.resolution.recoveryAttempts,0,'accepting the continuation closes its prior recovery budget');
  assert.equal(accepted.resolution.recovery,null);
  await f.engine.wake();
  assert.equal(f.sends.filter(run=>run.role==='revision').length,0,'full project capacity keeps the continuation parked');
  assert.equal(resumeVerifications,0,'the retained branch is checked when its slot is available');
  assert.match(f.current().reason,/Waiting for a project slot/);

  f.store.update(occupied.id,{phase:'blocked',agentIntent:false,agentActive:false});
  await f.engine.wake();await f.engine.wake();
  const revision=f.store.run(f.current().resolution.currentRunId!)!;
  assert.equal(revision.role,'revision');
  assert.equal(revision.head,retainedHead,'the run names the retained worker head, not the dispatch base');
  assert.equal(revision.base,base,'the dispatch planning base remains separate');
  assert.equal(resumeVerifications,1,'the retained worktree is verified once at launch');
  assert.match(f.prompts.at(-1)!,new RegExp(instruction));
  assert.equal(f.sends.filter(run=>run.role==='revision').length,1,'repeated wakes cannot launch a duplicate continuation');
  assert.equal(f.current().resolution.recoveryAttempts,0,'slot waiting and launch do not spend recovery budget');
 }finally{await f.close()}
});
test('recovery prompt labels dispatch base and last accepted worker head separately',async()=>{
 const f=fixture();try{
  const retainedHead='e'.repeat(40),task=f.store.update(f.task.id,{phase:'blocked',completion:{eventId:'blocked-result',taskId:f.task.id,runId:'initial',status:'blocked',summary:'Stopped after a pushed continuation',head:retainedHead},prHead:null,prUrl:null});
  const run:Run={id:'recovery-run',taskId:task.id,role:'recovery',generation:task.coordinatorGeneration,head:base,base,workspaceId:task.workspaceId!,agentId:'coordinator',profile:null,status:'intent',createdAt:new Date().toISOString(),lastObservedAt:null,active:null,idleSince:null,completion:null,released:false};
  const prompt=runPrompt(task,run,'/helper','/ticket',true);
  assert.match(prompt,new RegExp(`Dispatch planning base: ${base}`));
  assert.match(prompt,new RegExp(`Last accepted worker head: ${retainedHead}`));
  assert.match(prompt,/one coordinator run is allowed for this stop/);
  assert.match(prompt,/A transient origin, capacity, provider, route or PR-head wait clears on its own/);
 }finally{await f.close()}
});
function originFixture(f:ReturnType<typeof fixture>){
 const agents=new Map<string,{id:string;workspaceId:string;title:string;archived:boolean}>();
 agents.set('origin',{id:'origin',workspaceId:'planning',title:'Old planning thread',archived:false});
 Object.assign(f.adapter,{originAgent:async(id:string)=>agents.get(id)??null});
 return agents;
}
test('origin workspace is remembered and a deleted origin is recorded as missing, never auto-reassigned',async()=>{
 const f=fixture();try{
  const agents=originFixture(f);await f.engine.resolution.origins.pass();assert.equal(f.current().originWorkspaceId,'planning');
  agents.delete('origin');agents.set('replacement',{id:'replacement',workspaceId:'planning',title:'Chatterbox',archived:false});
  await f.engine.resolution.origins.pass();assert.equal(f.current().notificationAgentId,'origin','the recorded owner stands; nothing is reassigned');
  assert.equal(f.current().originAgentId,'origin');assert.match(f.current().originError,/Origin thread is missing; reparent the task to its successor in workspace planning/);
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='origin_missing'));
 }finally{await f.close()}
});
test('a synthetic origin is recorded but its task and origin notices route through the project planner',async()=>{
 const f=fixture();try{
  f.store.upsertProject({key:'app',name:'App',repositories:[{origin:null,path:'/repo'}]});
  f.store.setProjectPlanner({key:'app',agentId:'project-planner',setBy:'test'});f.idle('project-planner');
  const inserted=f.store.insert(submissionSchema.parse({submissionId:'synthetic-origin',title:'Synthetic origin',repoPath:'/repo',planningCommit:base,handoffPath:'h.md',originAgentId:'sweep'}),'host','handoff',base);
  f.adapter.originAgent=async id=>id==='project-planner'?{id,workspaceId:'planner-workspace',title:'Planner',archived:false}:null;
  await f.engine.resolution.origins.pass();
  const task=f.store.task(inserted.id);
  assert.match(task.originError,/Origin thread is missing/,'the absent origin remains visible in task detail');
  assert.equal(originRecipient(f.store,task),'project-planner');
  f.store.putNotice({id:'synthetic-origin-notice',taskId:task.id,agentId:'sweep',recipientAgentId:'sweep',workspaceId:null,sources:[],originEntry:true,kind:'prerequisite',status:'pending',error:'',text:'Origin notice'});
  await f.engine.resolution.deliverNotices();
  const delivered=f.store.notices(task.id).find(notice=>notice.id==='synthetic-origin-notice')!;
  assert.equal(delivered.status,'delivered');assert.equal(delivered.agentId,'project-planner');
  await f.engine.wake();
  assert.notEqual(f.store.task(task.id).resolution.stop?.detail,task.originError,'a configured planner means missing origin does not stop work');
 }finally{await f.close()}
});
test('a finished task that owes its origin nothing drops a stale missing-origin error and its stop, so archive and retention can proceed (Consumer-B #680)',async()=>{
 const f=fixture();try{
  const agents=originFixture(f);await f.engine.resolution.origins.pass();agents.delete('origin');
  await f.engine.resolution.origins.pass();const missing=f.current().originError;assert.match(missing,/Origin thread is missing; reparent the task/);
  f.store.update(f.task.id,{notifyOriginOnCloseout:false});f.store.update(f.task.id,{phase:'done',finishedAt:new Date().toISOString(),reason:'Closed'});
  f.engine.resolution.recordStop(f.current(),'operator_needed',missing,['restart','route','move']);
  assert.equal(f.current().resolution.stop?.detail,missing);
  await f.engine.resolution.origins.pass();
  assert.equal(f.current().originError,'');assert.equal(f.current().resolution.stop,null,'the stop the origin error produced goes with it');
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='origin_not_owed'));
  const version=f.current().version;await f.engine.resolution.origins.pass();assert.equal(f.current().version,version,'a settled finished task is not rewritten');
 }finally{await f.close()}
});
test('origin checks preserve live threads, defer during pause and record transport errors without writes',async()=>{
 const f=fixture();try{
  const agents=originFixture(f);await f.engine.resolution.origins.pass();assert.equal(taskOwner(f.current()),'origin','a live origin is kept');
  f.adapter.originAgent=async()=>{throw Error('Disconnected')};await f.engine.resolution.origins.pass();assert.equal(f.current().originError,'');assert.equal(f.current().originLookupError,'Disconnected');
  f.adapter.originAgent=async id=>agents.get(id)??null;agents.delete('origin');f.store.setMeta('paused',true);await f.engine.resolution.origins.pass();assert.equal(f.current().originError,'','no missing-origin record while paused');
  f.store.setMeta('paused',false);await f.engine.resolution.origins.pass();assert.match(f.current().originError,/Origin thread is missing/);assert.equal(f.current().originLookupError,'');
 }finally{await f.close()}
});
test('pending notices follow a reparent but delivered notices are never replayed',async()=>{
 const f=fixture();try{
  const agents=originFixture(f);await f.engine.resolution.origins.pass();attention(f);f.states.set('origin',{...f.states.get('origin')!,active:true,status:'running'});await f.engine.resolution.deliverNotices();assert.equal(f.store.notices(f.task.id)[0].status,'pending');
  agents.set('replacement',{id:'replacement',workspaceId:'planning',title:'Successor',archived:false});f.idle('replacement','planning');
  await f.engine.resolution.origins.reparent({toAgentId:'replacement',caller:'operator (board)',reason:'Origin replaced',taskIds:[f.task.id]} as never);
  const recipients:string[]=[];f.adapter.notify=async id=>{recipients.push(id)};
  await f.engine.resolution.deliverNotices();await f.engine.resolution.deliverNotices();assert.deepEqual(recipients,['replacement']);assert.equal(f.store.notices(f.task.id)[0].agentId,'replacement');
 }finally{await f.close()}
});
/** A task whose recorded origin is an operator identity (originAgentId is fixed at insert). */
function operatorTask(f:ReturnType<typeof fixture>,operator:string,repoPath='/repo'){
 const inserted=f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title:'Operator task',repoPath,planningCommit:base,handoffPath:'h.md',originAgentId:operator}),'host','handoff',base);
 return f.store.update(inserted.id,{phase:'awaiting_review'});
}
test('Consumer #687: an operator origin is not a thread: no lookup or inheritance, and its false missing-origin error clears',async()=>{
 for(const operator of ['operator','operator (board)']){const f=fixture();try{
  const looked:string[]=[];
  Object.assign(f.adapter,{originAgent:async(id:string)=>{looked.push(id);return null}});
  // Another operator-origin task in another project recorded a workspace; it must seed nothing.
  const other=operatorTask(f,operator,'/other');f.store.update(other.id,{originWorkspaceId:'longhorn-workspace'});
  const task=operatorTask(f,operator);
  f.store.update(task.id,{originError:'Origin thread is missing; reparent the task to its successor in workspace longhorn-workspace'});
  assert.equal(f.store.originWorkspaces().has(operator),false,`${operator} never maps to a workspace`);
  await f.engine.resolution.origins.pass();
  const t=f.store.task(task.id);
  assert.equal(t.originWorkspaceId,null,`${operator}: no inherited workspace`);
  assert.equal(t.notificationAgentId,null,`${operator}: nothing assigned`);
  assert.equal(t.originError,'');
  assert.ok(f.store.events(task.id).some(e=>e.kind==='origin_not_a_thread'));
  assert.ok(!looked.includes(operator),'no synthetic agent lookup');
 }finally{await f.close()}}
});
test('Consumer #687: origin notices for an operator origin go to the project planner, wait visibly without one, and never replay an uncertain send',async()=>{
 for(const operator of ['operator','operator (board)']){const f=fixture();try{
  const task=operatorTask(f,operator);f.store.update(task.id,{originWorkspaceId:'longhorn-workspace',resolution:{...f.store.task(task.id).resolution,attention:true},reason:'Local integration check failed'});
  const sent:string[]=[];f.adapter.notify=async id=>{sent.push(id)};
  // No planner: the notice is created but never sent to a fictitious agent.
  await f.engine.resolution.deliverNotices();await f.engine.resolution.deliverNotices();
  let notice=f.store.notices(task.id).find(n=>n.kind==='attention')!;
  assert.ok(notice,'an attention notice is owed');
  assert.equal(notice.status,'pending');assert.equal(notice.error,NO_ORIGIN_THREAD_WAIT);assert.ok(!sent.includes(operator));assert.deepEqual(sent.filter(id=>id!=='origin'),[]);
  // A planner arrives: the same owed notice is addressed to it and delivered once.
  f.store.upsertProject({key:'app',name:'App',repositories:[{origin:null,path:'/repo'}]});
  f.store.setProjectPlanner({key:'app',agentId:'project-planner',setBy:'test'});f.idle('project-planner');
  await f.engine.resolution.deliverNotices();await f.engine.resolution.deliverNotices();
  notice=f.store.notices(task.id).find(n=>n.id===notice.id)!;
  assert.equal(notice.status,'delivered');assert.equal(notice.agentId,'project-planner');assert.deepEqual(sent.filter(id=>id==='project-planner'),['project-planner'],'delivered once, to the planner');
  // A planner change after a delivery intent: the unknown delivery is never resent.
  f.store.putNotice({...notice,id:'intent-'+notice.id,status:'intent',agentId:'project-planner'});
  f.store.setProjectPlanner({key:'app',agentId:'new-planner',setBy:'test'});f.idle('new-planner');
  await f.engine.resolution.deliverNotices();
  const intent=f.store.notices(task.id).find(n=>n.id==='intent-'+notice.id)!;
  assert.equal(intent.status,'uncertain','an unknown delivery is never resent');assert.ok(!sent.includes('new-planner'));
 }finally{await f.close()}}
});
test('Consumer #687: an explicit successor and a real origin thread are unaffected by the operator rule, and the fallback is the planner chain',async()=>{
 const f=fixture();try{
  assert.equal(originRecipient(f.store,f.current()),'origin','a real origin thread');
  f.store.upsertProject({key:'app',name:'App',repositories:[{origin:null,path:'/repo'}]});
  f.store.setProjectPlanner({key:'app',agentId:'project-planner',setBy:'test'});
  assert.equal(originRecipient(f.store,f.current()),'origin','a real origin is never replaced by the planner');
  const task=operatorTask(f,'operator');
  f.store.update(task.id,{notificationAgentId:'successor'});
  assert.equal(originRecipient(f.store,f.store.task(task.id)),'successor','an explicit notification thread wins over the planner');
  f.store.update(task.id,{notificationAgentId:null});
  assert.equal(originRecipient(f.store,f.store.task(task.id)),'project-planner');
  // No project planner: the Queue planner (the project that holds this repository's origin) answers.
  f.store.setProjectPlanner({key:'app',agentId:null,setBy:'test'});
  const queueKey=`repo-${digest(QUEUE_REPOSITORY_ORIGIN).slice(0,20)}`;
  f.store.upsertProject({key:queueKey,name:'Queue',repositories:[{origin:QUEUE_REPOSITORY_ORIGIN,path:'/queue'}]});
  f.store.setProjectPlanner({key:queueKey,agentId:'queue-planner',setBy:'test'});
  assert.equal(originRecipient(f.store,f.store.task(task.id)),'queue-planner','the Queue planner is the second fallback');
  f.store.setProjectPlanner({key:queueKey,agentId:null,setBy:'test'});
  assert.equal(originRecipient(f.store,f.store.task(task.id)),null,'no planner anywhere waits visibly');
  // An operator identity is no thread either.
  f.store.setProjectPlanner({key:'app',agentId:'operator',setBy:'test'});
  assert.equal(originRecipient(f.store,f.store.task(task.id)),null,'an operator-identity planner is no thread');
 }finally{await f.close()}
});
test('closeout records the verified publication SHA without re-merging implementation',async()=>{
 const f=fixture();try{
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();await f.engine.wake();
  const published='f'.repeat(40);f.adapter.verifyCloseout=async(t,result)=>{assert.equal(result?.status,'closed');return published};await f.report('closed');
  assert.equal(f.current().phase,'done');assert.equal(f.current().resolution.syncedCommit,published);assert.equal(f.current().resolution.mergedCommit,merged);assert.equal(f.counts().merges,1);
 }finally{await f.close()}
});
test('post-merge recovery has a fresh bounded budget after implementation recovery was exhausted',async()=>{
 const f=fixture();try{
  enableRecovery(f);f.store.update(f.task.id,{phase:'blocked',reason:'Canonical closeout documents missing',resolution:{...f.current().resolution,mergedCommit:merged,syncedCommit:merged,recoveryAttempts:3}});
  await f.engine.wake();assert.equal(f.current().resolution.recoveryPhase,'closeout');assert.equal(f.current().resolution.recoveryAttempts,1);assert.equal(f.current().resolution.recovery?.status,'running');
 }finally{await f.close()}
});
test('explicit coordinator escalation waits for a running Chatterbox turn to end, then arrives once',async()=>{
 // Tom 2026-10-04: escalations no longer cut into a live Chatterbox turn; they queue until it ends.
 const f=fixture(true);try{
  const recipients=enableRecovery(f);f.states.set('origin',{...f.states.get('origin')!,status:'running',active:true});attention(f);await f.engine.wake();await recoveryReport(f,'escalate');await f.engine.wake();
  assert.deepEqual(recipients,[],'a running Chatterbox is not interrupted');
  const waiting=f.store.notices(f.task.id).find(notice=>notice.status==='pending')!;assert.ok(waiting);assert.equal(waiting.status,'pending');assert.match(waiting.error,/become idle \(escalation; running\)/);
  f.idle('origin','origin-workspace');await f.engine.resolution.deliverNotices();
  assert.deepEqual(recipients,['origin']);assert.equal(f.store.notices(f.task.id).find(notice=>notice.id===waiting.id)?.status,'delivered');
  f.states.set('origin',{...f.states.get('origin')!,status:'running',active:true});
  f.store.update(f.task.id,{phase:'done',reason:'Closeout complete',resolution:{...f.current().resolution,attention:false}});await f.engine.resolution.deliverNotices();
  const pending=f.store.notices(f.task.id).find(n=>n.status==='pending')!;assert.match(pending.error,/completion recipient/);assert.deepEqual(recipients,['origin']);
  f.idle('origin','origin-workspace');await f.engine.resolution.deliverNotices();assert.equal(f.store.notices(f.task.id).find(n=>n.id===pending.id)?.status,'delivered');assert.equal(recipients.length,2);
 }finally{await f.close()}
});
test('paused explicit escalation is stored until resume, then waits for the running turn to end',async()=>{
 const f=fixture();try{
  const recipients=enableRecovery(f);attention(f);await f.engine.wake();f.store.setMeta('paused',true);f.states.set('origin',{...f.states.get('origin')!,status:'running',active:true});await recoveryReport(f,'escalate');assert.deepEqual(recipients,[]);
  f.store.setMeta('paused',false);await f.engine.wake();assert.deepEqual(recipients,[],'still waiting for the running turn after resume');
  f.idle('origin','origin-workspace');await f.engine.resolution.deliverNotices();assert.deepEqual(recipients,['origin']);
 }finally{await f.close()}
});
function plantAbsent(f:ReturnType<typeof fixture>,role:'reviewer'|'closeout'){
  const run:Run={id:`absent-${role}`,taskId:f.task.id,role,generation:f.current().coordinatorGeneration,head,base:role==='closeout'?merged:base,agentId:null,workspaceId:'workspace',profile:role==='reviewer'?profile('reviewer'):profile('coordinator'),profileGroup:role==='reviewer'?'review':'coordinate',status:'uncertain',createdAt:new Date().toISOString(),lastObservedAt:null,active:null,idleSince:null,completion:null,released:false};
  f.store.putRun(run);f.store.setCredential(run.id,'old-token');
  const review:Completion={eventId:'review-event',taskId:f.task.id,runId:'prior-review',status:'ready_to_merge',summary:'Ready',head,reviewCommentId:1};
  const integrationTurn={sequence:1,acceptedAt:new Date().toISOString()};
  const phase=role==='reviewer'?'reviewing':'closing';
  f.store.update(f.task.id,{phase,reason:ABSENT_RESOLUTION_REASON,resolution:{...f.current().resolution,currentRunId:run.id,attention:true,...(role!=='reviewer'?{review,integrationTurn}:{}),...(role==='closeout'?{mergedCommit:merged,syncedCommit:merged,mergeIntent:true,mergeHead:head}:{})}});
  return run;
}
test('absent executor creation returns an unreviewed PR to review',async()=>{
 const f=fixture();try{
  const original=plantAbsent(f,'reviewer');
  const run:Run={...original,role:'executor',proofExecution:{selector:'effigy check',inputs:[],prNumber:1,tree:head,operationId:null,briefVersion:null,briefDigest:null,returnPhase:'awaiting_review',authorizedBy:{role:'project_owner',caller:null,note:null}}};f.store.putRun(run);
  f.engine.resolution.ensureIncident(f.current(),run,ABSENT_RESOLUTION_REASON,'exact_lookup');
  await (f.engine.resolution as any).replaceAbsentCreation(f.current(),run);
  await f.engine.wake();
  assert.notEqual(f.current().phase,'done');assert.equal(f.run()?.role,'reviewer',f.current().reason);
  assert.equal(f.current().resolution.mergedCommit,null);assert.equal(f.current().resolution.review,null);
 }finally{await f.close()}
});
test('exhausted executor returns to its prior rung without replacing the coordinator',async()=>{
 const f=fixture();try{
  const original=plantAbsent(f,'reviewer');
  const run:Run={...original,role:'executor',agentId:'executor-agent',status:'running',proofExecution:{selector:'effigy check',inputs:[],prNumber:1,tree:head,operationId:null,briefVersion:null,briefDigest:null,returnPhase:'blocked',authorizedBy:{role:'project_owner',caller:null,note:null}}};
  f.store.putRun(run);f.idle(run.agentId!);f.states.set(run.agentId!,{...f.states.get(run.agentId!)!,error:'usage limit reached'});
  const generation=f.current().coordinatorGeneration;
  f.store.update(f.task.id,{phase:'blocked',resolution:{...f.current().resolution,attention:false}});
  await f.engine.resolution.observe();
  assert.equal(f.current().phase,'blocked');assert.equal(f.current().resolution.currentRunId,null);
  assert.equal(f.current().coordinatorGeneration,generation);assert.equal(f.store.run(run.id)?.status,'superseded');
  assert.equal(f.current().resolution.mergedCommit,null);assert.equal(f.current().resolution.review,null);
  await f.engine.wake();assert.equal(f.store.runs(f.task.id).some(item=>item.role==='closeout'),false);
 }finally{await f.close()}
});
test('a stored verification run parses, but no path launches or advances one',async()=>{
 const f=fixture();try{
  const before=f.creates.length,phase=f.current().phase;
  await assert.rejects(f.engine.resolution.launch(f.current(),'verification'),/no verification run is launched/);
  assert.equal(f.creates.length,before);
  const run=runSchema.parse({id:'stored-verification',taskId:f.task.id,role:'verification',generation:1,head,base,agentId:'stored',workspaceId:'workspace',profile:profile('coordinator'),status:'running',createdAt:new Date().toISOString(),lastObservedAt:null,active:false,idleSince:null,released:true,
   completion:{eventId:'stored-event',taskId:f.task.id,runId:'stored-verification',status:'verified',summary:'Verified',head}});
  f.store.putRun(run);
  const resolution=f.engine.resolution as unknown as {advanceCompletedRun(t:Task,run:Run):Promise<void>};
  await assert.rejects(resolution.advanceCompletedRun(f.current(),run),/cannot advance the task/);
  assert.equal(f.current().phase,phase,'a stored verification run is never read as a closeout');
 }finally{await f.close()}
});

test('scoped revise persists one durable instruction and binds it to exactly one revision run',async()=>{
 const f=fixture();try{
  const text='Apply the accepted replacement plan and preserve the existing PR';
  const requested=f.engine.resolution.retry(f.current(),true,undefined,true,false,false,text);
  assert.equal(requested.phase,'changes_requested');
  assert.equal(requested.resolution.revisionInstruction?.text,text);
  assert.equal(requested.resolution.revisionInstruction?.runId,null);
  await f.engine.wake();
  const revision=f.run();
  assert.equal(revision.role,'revision');assert.equal(revision.instruction,text);
  assert.equal(f.current().resolution.revisionInstruction?.runId,revision.id);
  assert.equal(f.sends.filter(r=>r.role==='revision').length,1);assert.equal(f.creates.length,0);
  assert.equal(f.current().completion?.prNumber,1);
 }finally{await f.close()}
});
test('scoped revision instruction survives a backend restart without losing or repeating the launch',async()=>{
 const f=fixture();try{
  const text='Continue the retained PR under the accepted ruling';
  f.engine.resolution.retry(f.current(),true,undefined,true,false,false,text);
  const reopened=new Store(join(f.dir,'queue.sqlite'));
  const reloaded=new Engine(reopened,f.adapter,0);reloaded.profiles=[...f.engine.profiles];
  await reloaded.wake();
  const revision=reopened.runs(f.task.id).find(r=>r.role==='revision')!;
  assert.equal(revision.instruction,text);
  assert.equal(reopened.task(f.task.id).resolution.revisionInstruction?.runId,revision.id);
  assert.equal(reopened.runs(f.task.id).filter(r=>r.role==='revision').length,1);
  const reloadedAgain=new Engine(reopened,f.adapter,0);reloadedAgain.profiles=[...f.engine.profiles];
  await reloadedAgain.wake();
  assert.equal(reopened.runs(f.task.id).filter(r=>r.role==='revision').length,1);
  assert.equal(f.sends.filter(r=>r.role==='revision').length,1);
  reopened.close();
 }finally{await f.close()}
});
test('a consumed scoped instruction is not replayed to a later revision run',async()=>{
 const f=fixture();try{
  f.engine.resolution.retry(f.current(),true,undefined,true,false,false,'First ruling');
  await f.engine.wake();
  const first=f.run();assert.equal(first.role,'revision');assert.equal(first.instruction,'First ruling');
  f.idle(first.agentId!,first.workspaceId);f.setHead('d'.repeat(40));await f.report('ready_for_review');
  await f.engine.wake();assert.equal(f.run().role,'reviewer');
  await f.report('changes_required');await f.engine.wake();
  const second=f.run();assert.equal(second.role,'revision');assert.notEqual(second.id,first.id);
  assert.equal(second.instruction,'changes_required','the later review summary becomes the next action without replaying the consumed ruling');
  assert.equal(f.current().resolution.revisionInstruction?.text,'First ruling');
  assert.equal(f.current().resolution.revisionInstruction?.runId,first.id);
 }finally{await f.close()}
});
test('instruction-free revise stays valid and clears only a pending scoped instruction',async()=>{
 const f=fixture();try{
  f.engine.resolution.retry(f.current(),true,undefined,true,false,false,'Superseded ruling');
  assert.equal(f.current().resolution.revisionInstruction?.text,'Superseded ruling');
  const plain=f.engine.resolution.retry(f.current(),true,undefined,true);
  assert.equal(plain.phase,'changes_requested');assert.equal(plain.resolution.revisionInstruction,null);
  await f.engine.wake();
  // A review-less revise names no review defect (Tom, 2026-10-23: the continuation carries its
  // own action and the latest blocked result as diagnostic context, never an invented finding).
  assert.equal(f.run().role,'revision');assert.equal(f.run().instruction,'Continue the existing task within its approved scope');
  assert.equal(f.current().resolution.review,null,'no review is recorded for this continuation');
  assert.equal(f.sends.filter(r=>r.role==='revision').length,1);
 }finally{await f.close()}
});
test('scoped revise fails closed on empty instructions, unsupported phases, merged PRs and absent PR identity',async()=>{
 const f=fixture();try{
  assert.throws(()=>f.engine.resolution.retry(f.current(),true,undefined,true,false,false,'   '),/must not be empty/);
  f.store.update(f.task.id,{phase:'working'});
  assert.throws(()=>f.engine.resolution.retry(f.current(),true,undefined,true,false,false,'Rebase the PR'),/not valid from phase working/);
  f.store.update(f.task.id,{phase:'awaiting_review',resolution:{...f.current().resolution,mergedCommit:merged}});
  assert.throws(()=>f.engine.resolution.retry(f.current(),true,undefined,true,false,false,'Rebase the PR'),/unmerged task PR/);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,mergedCommit:null}});
  f.store.update(f.task.id,{completion:{...f.current().completion!,prNumber:undefined}});
  assert.throws(()=>f.engine.resolution.retry(f.current(),true,undefined,true,false,false,'Rebase the PR'),/requires an unmerged task PR/);
  assert.equal(f.current().resolution.revisionInstruction,null);assert.equal(f.sends.length,0);
 }finally{await f.close()}
});
test('scoped revise preserves review evidence, PR identity and the retained worker',async()=>{
 const f=fixture();try{
  const review:Completion={eventId:'review',taskId:f.task.id,runId:'reviewer',status:'changes_required',summary:'Fix the links',reviewCommentId:9,head};
  f.store.update(f.task.id,{resolution:{...f.current().resolution,review}});
  const prUrl=f.current().prUrl,prHead=f.current().prHead;
  f.engine.resolution.retry(f.current(),true,undefined,true,false,false,'Apply the operator ruling without discarding review evidence');
  await f.engine.wake();
  const revision=f.run();
  assert.equal(revision.agentId,'worker');assert.equal(revision.workspaceId,'workspace');assert.equal(revision.head,prHead);
  assert.equal(f.current().prUrl,prUrl);assert.equal(f.current().prHead,prHead);
  assert.equal(f.current().resolution.review?.summary,'Fix the links');assert.equal(f.current().resolution.review?.reviewCommentId,9);
  assert.equal(f.current().completion?.prNumber,1);
 }finally{await f.close()}
});
async function plantStoppedPrRevision(f:ReturnType<typeof fixture>,reason='The revision thread stopped without a callback; inspect the thread'){
 await f.engine.wake();await f.report('changes_required');await f.engine.wake();
 const stopped=f.run();
 f.states.set(stopped.agentId!,{id:stopped.agentId!,workspaceId:stopped.workspaceId,status:'error',active:false,permissions:false,error:'transient invalid_upstream_stream'});
 f.store.update(f.task.id,{reason,resolution:{...f.current().resolution,attention:true,recovery:{id:'recovery',key:'incident',generation:1,runId:null,agentId:'coordinator',status:'escalated',summary:'Operator action required',idleSince:null,incidentId:null}}});
 f.adapter.verifyResume=async()=>{};
 return stopped;
}
const inspectedHead='d'.repeat(40),wrongHead='f'.repeat(40);
function pushInspectedHead(f:ReturnType<typeof fixture>,headValue=inspectedHead){
 f.setHead(headValue);f.setLocalHead(headValue);f.setRemoteHead(headValue);
}

test('parked revisions wait for a fresh slot even with retained workspace intent',async()=>{
 for(const retainedWorkspace of [true,false]){
  const f=fixture();try{
   f.store.setMeta('globalLimit',1);f.store.setMeta('projectLimit',1);
   f.store.update(f.task.id,{phase:'changes_requested',workspaceIntent:retainedWorkspace});
   const other=f.store.insert(submissionSchema.parse({submissionId:'occupied',title:'Other',repoPath:'/repo',planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff',base);
   f.store.update(other.id,{phase:'working',workspaceIntent:true,agentIntent:true,agentId:'agent-other',agentActive:true});
   f.store.setMeta('paused',true);await f.engine.resolution.advance(f.current());assert.equal(f.sends.length,0);
   f.store.setMeta('paused',false);await f.engine.resolution.advance(f.current());
   assert.equal(f.sends.length,0);
   assert.match(f.current().reason,/Waiting for a project slot…/);
   assert.equal(f.current().workspaceIntent,retainedWorkspace);
  }finally{await f.close();}
 }
});

test('a zero project override blocks queued, review, revision, and recovery admissions while another project gets fair share', async () => {
  const f = fixture(); try {
    f.store.setMeta('globalLimit', 1); f.store.setMeta('projectLimit', 1);
    f.store.update(f.task.id, { phase: 'done' });
    const addQueued = (repoPath: string) => f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Queued request', repoPath,
      planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
    const queued = addQueued('/alpha');
    const review = addQueued('/alpha'); f.store.update(review.id, { phase: 'awaiting_review' });
    const revision = addQueued('/alpha'); f.store.update(revision.id, { phase: 'changes_requested' });
    const recovery = addQueued('/alpha');
    f.store.update(recovery.id, { phase: 'needs_attention', reason: 'No callback', resolution: { ...recovery.resolution, attention: true, recoveryAttempts: 1,
      recovery: { id: 'recovery', key: 'recovery', generation: 1, runId: null, agentId: null, status: 'escalated', summary: 'No callback', idleSince: null, incidentId: null } } });
    const beta = addQueued('/beta');
    const alphaProject = f.store.projectFor('/alpha')!;
    f.store.setProjectDispatchLimitOverride(alphaProject.key, 0);
    assert.match(f.engine.resolution.slotAdmissionReason(queued), /Waiting for a project slot… Project/, 'queued dispatch is held');
    assert.match(f.engine.resolution.slotAdmissionReason(review), /Waiting for a project slot… Project/, 'parked review admission is held');
    assert.match(f.engine.resolution.slotAdmissionReason(revision), /Waiting for a project slot… Project/, 'parked revision admission is held');
    assert.match(f.engine.resolution.slotAdmissionReason(recovery, true), /Waiting for a project slot… Project/, 'recovery admission is held');
    assert.equal(f.engine.resolution.slotAdmissionReason(beta, true), '', 'zero-limit queued, parked, and recovery requests consume no fair-share slot, so the other project can dispatch');
  } finally { await f.close(); }
});

test('external merge transport failure defers without creating a recovery incident', async () => {
  const f = fixture(); try {
    f.adapter.externalMerge = async () => { throw Error('Transport not connected (status: disconnected)'); };
    const before = f.current();
    assert.equal(await f.engine.resolution.recoverExternalMerge(before), true);
    assert.equal(f.current().phase, before.phase);
    assert.equal(f.current().resolution.attention, false);
    assert.equal(f.current().resolution.incident, null);
    f.adapter.externalMerge = async () => null;
    await f.engine.wake();
    assert.equal(f.current().phase, 'reviewing');
    assert.equal(f.run().role, 'reviewer');
  } finally { await f.close(); }
});

test('transport failures retain an exhausted-review decision and deduplicate outage evidence', async () => {
  const f = fixture(); try {
    const reason = 'Revision budget exhausted after 6 review rounds; coordinator judgment required';
    f.store.update(f.task.id, { phase: 'needs_attention', reason });
    f.adapter.externalMerge = async () => { throw Error('Transport not connected (status: disconnected)'); };
    await f.engine.resolution.recoverExternalMerge(f.current());
    await f.engine.resolution.recoverExternalMerge(f.current());
    assert.equal(f.current().reason, reason);
    assert.equal(f.current().phase, 'needs_attention');
    assert.equal(f.current().resolution.incident, null);
    assert.equal(f.store.events(f.task.id).filter(event => event.kind === 'transport_deferred').length, 1);
    assert.equal(f.creates.length, 0);
  } finally { await f.close(); }
});

test('a merged task parked on the open-PR identity stop does not launch a recovery coordinator', async () => {
 const f=fixture();try{
  recordBlockedSourceApproval(f);
  const reason='PR must be open, ready, and match the task branch and base';
  f.adapter.supportsCoordinatorRecovery=true;
  const task=f.store.update(f.task.id,{phase:'needs_attention',reason,resolution:{...f.current().resolution,attention:true,mergedCommit:merged,externalMerge:true,mergeHead:head}});
  f.engine.resolution.recordStop(task,'operator_needed',reason);
  assert.equal(await f.engine.resolution.recovery.route(f.current()),null);
  assert.equal(f.creates.length,0);
  assert.equal(f.current().resolution.recoveryAttempts,0);
  assert.equal(f.current().resolution.mergedCommit,merged);
 }finally{await f.close()}
});
test('exhausted SSH authentication reaches human attention without coordinator recovery', async () => {
 const f=fixture();try{
  f.adapter.supportsCoordinatorRecovery=true;
  const reason='SSH authentication retry budget exhausted after 3 attempts; operator SSH/key inspection required: Permission denied (publickey).';
  const task=f.store.update(f.task.id,{phase:'needs_attention',reason,resolution:{...f.current().resolution,attention:true}});
  assert.equal(await f.engine.resolution.recovery.route(task),undefined);
  assert.equal(f.creates.length,0);
  assert.equal(f.current().resolution.recoveryAttempts,0);
  assert.equal(f.current().reason,reason);
 }finally{await f.close()}
});
test('a proof-wait notice survives its own pass', async () => {
 const f=fixture();try{
  recordBlockedSourceApproval(f);
  f.engine.resolution.recordStop(f.current(),'awaiting_proof',`Source approved at ${head}; awaiting proof: post-merge-proof`);
  // Production runs with coordinator recovery supported; the default fixture omits it and hides this path.
  f.adapter.supportsCoordinatorRecovery=true;
  f.idle('origin','origin-workspace');
  await f.engine.resolution.deliverNotices();
  const notices=f.store.notices(f.task.id).filter(n=>n.kind==='attention');
  assert.equal(notices.length,1,JSON.stringify(f.store.notices(f.task.id)));
  assert.notEqual(notices[0]!.status,'superseded',JSON.stringify(notices[0]));
  await f.engine.resolution.deliverNotices();
  assert.equal(f.store.notices(f.task.id).find(n=>n.id===notices[0]!.id)!.status,'delivered',JSON.stringify(f.store.notices(f.task.id)));
 }finally{await f.close()}
});
function plantAbsentRecovery(f:ReturnType<typeof fixture>){
  const run:Run={id:'absent-recovery',taskId:f.task.id,role:'recovery',generation:f.current().coordinatorGeneration,head,base,agentId:null,workspaceId:'workspace',profile:profile('coordinator'),profileGroup:'coordinate',status:'intent',createdAt:new Date().toISOString(),lastObservedAt:null,active:null,idleSince:null,completion:null,released:false};
  f.store.putRun(run);f.store.setCredential(run.id,'old-token');
  const summary='Coordinator recovery unavailable: Codex app-server exited with code 1 and signal null';
  f.store.update(f.task.id,{phase:'needs_attention',reason:summary,resolution:{...f.current().resolution,attention:true,recoveryActive:true,recoveryAttempts:1,
    recovery:{id:'incident-recovery',key:'key',generation:run.generation,runId:run.id,agentId:null,status:'escalated',summary,idleSince:null,incidentId:null}}});
  return run;
}
test('restart coordinator looks up and releases an agentless escalated recovery', async () => {
 for (const status of ['intent', 'uncertain'] as const) {
  const f=fixture(); try {
   enableRecovery(f);
   const run=plantAbsentRecovery(f); f.store.putRun({...run,status});
   f.adapter.findRunAgents=async()=>[{id:'late',workspaceId:'workspace'}];
   const restart=()=>f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'restart',role:'coordinator',reason:'Resume recovery'});
   await assert.rejects(restart(),/no longer proven absent/);
   assert.equal(f.store.run(run.id)?.released,false);
   f.adapter.findRunAgents=async()=>[];
   await restart();
   assert.equal(f.store.run(run.id)?.released,true);
   assert.equal(f.store.run(run.id)?.status,'superseded');
   assert.throws(()=>f.store.authenticate(run.id,'old-token'),/Unauthorized/);
   assert.equal(f.current().resolution.recovery,null);
   await f.engine.wake();
   assert.ok(f.store.runs(f.task.id).some(item=>item.role==='recovery' && item.id!==run.id), 'recovery is relaunched');
  } finally { await f.close() }
 }
});
test('recovery pass releases a failed agentless coordinator creation after an exact empty lookup',async()=>{
 const f=fixture();try{
  enableRecovery(f);
  const run=plantAbsentRecovery(f);let purged:string[]=[];
  f.adapter.purgeReportingFiles=(_task,runs)=>{purged=runs};
  await f.engine.resolution.recovery.pass();
  const released=f.current();
  assert.equal(f.store.run(run.id)?.status,'superseded');assert.equal(f.store.run(run.id)?.released,true);
  assert.deepEqual(purged,[run.id]);assert.throws(()=>f.store.authenticate(run.id,'old-token'),/Unauthorized/);
  assert.equal(released.resolution.recovery?.status,'escalated');assert.equal(released.resolution.recovery?.runId,null);
  assert.equal(released.resolution.recoveryActive,false);assert.equal(released.resolution.attention,true);
  assert.equal(f.creates.filter(item=>item.role==='recovery').length,0);
  const proof=f.store.events(f.task.id).find(event=>event.kind==='absent_recovery_released');
  assert.equal(proof?.detail,'Exact task/run label lookup found no coordinator; failed creation superseded and released');
 }finally{await f.close()}
});
test('recovery pass binds one exact coordinator match and keeps ambiguous creation escalated',async()=>{
 const f=fixture();try{
  enableRecovery(f);
  const run=plantAbsentRecovery(f);
  f.adapter.findRunAgents=async()=>[{id:'late-coordinator',workspaceId:'workspace'}];
  f.states.set('late-coordinator',{id:'late-coordinator',workspaceId:'workspace',status:'running',active:true,permissions:false,error:''});
  await f.engine.resolution.recovery.pass();
  assert.equal(f.store.run(run.id)?.agentId,'late-coordinator');assert.equal(f.store.run(run.id)?.released,false);
  assert.equal(f.current().coordinatorAgentId,'late-coordinator');
  assert.equal(f.current().resolution.recovery?.runId,run.id);
 }finally{await f.close()}
 const ambiguous=fixture();try{
  enableRecovery(ambiguous);
  const run=plantAbsentRecovery(ambiguous);
  ambiguous.adapter.findRunAgents=async()=>[
   {id:'coordinator-a',workspaceId:'workspace'},
   {id:'coordinator-b',workspaceId:'workspace'},
  ];
  await ambiguous.engine.resolution.recovery.pass();
  assert.equal(ambiguous.store.run(run.id)?.agentId,null);assert.equal(ambiguous.store.run(run.id)?.released,false);
  assert.equal(ambiguous.current().resolution.recovery?.status,'escalated');
  assert.match(ambiguous.current().resolution.recovery?.summary??'',/creation is uncertain/);
 }finally{await ambiguous.close()}
});
test('recovery pass keeps an unrecorded agentless intent fenced when lookup is empty',async()=>{
 const f=fixture();try{
  enableRecovery(f);
  const run=plantAbsentRecovery(f);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,recovery:{...f.current().resolution.recovery!,summary:'Coordinator recovery creation is uncertain; inspect its intent'}}});
  await f.engine.resolution.recovery.pass();
  assert.equal(f.store.run(run.id)?.released,false);
  assert.equal(f.store.run(run.id)?.agentId,null);
  assert.match(f.current().resolution.recovery?.summary??'',/creation is uncertain/);
  assert.equal(f.store.events(f.task.id).some(event=>event.kind==='absent_recovery_released'),false);
 }finally{await f.close()}
});
test('an operator retry clears a held project validation so it runs again; an automatic retry keeps it', async () => {
 for (const operator of [true, false]) {
  const f = fixture(); try {
   const held = { argv: ['effigy', 'ci:fresh'], digest: 'd'.repeat(64), exitCode: null, durationMs: 10_000, outputTail: 'Validation output exceeded its limit: …', base, head, state: 'hold' as const, queueBuild: '', settingsRevision: 0, pid: null, admission: null, capacityWait: null, capacityUnavailable: false };
   f.store.update(f.task.id, { phase: 'verifying', reason: 'Validation output exceeded its limit', resolution: { ...f.current().resolution, attention: true, projectValidation: held } });
   const retried = f.engine.resolution.retry(f.current(), false, undefined, operator);
   assert.equal(retried.resolution.attention, false);
   // project-k#023 and #025 (2026-09-27): the retry replayed the stored hold without running the validation.
   assert.deepEqual(retried.resolution.projectValidation, operator ? null : held);
  } finally { await f.close(); }
 }
});
test('an operator retry clears a running validation whose process is gone, and keeps one that is still alive', async () => {
 // project-k#025 (2026-09-27): a plugin reload killed the ci:fresh child and left the record at running forever.
 const dead = 2_147_000_000; // no such process
 for (const [pid, cleared] of [[dead, true], [null, true], [process.pid, false]] as const) {
  const f = fixture(); try {
   const running = { argv: ['effigy', 'ci:fresh'], digest: 'd'.repeat(64), exitCode: null, durationMs: 0, outputTail: '', base, head, state: 'running' as const, queueBuild: '', settingsRevision: 0, pid, admission: null, capacityWait: null, capacityUnavailable: false };
   f.store.update(f.task.id, { phase: 'verifying', reason: 'Project validation process delivery is uncertain; operator reconciliation required', resolution: { ...f.current().resolution, attention: true, projectValidation: running } });
   const retried = f.engine.resolution.retry(f.current(), false, undefined, true);
   assert.deepEqual(retried.resolution.projectValidation, cleared ? null : running, `pid ${pid}`);
  } finally { await f.close(); }
 }
});

test('an opted-in repository publishes a formal review and carries its reviewer identity into review and merge', async () => {
 const f=fixture();try{
  // Spec 033: the per-repository reviewer setting binds publication, verification and the merge precheck.
  f.store.putRepository({origin:null,path:'/repo'},'agent','fixture keeps agent closeout',null,{login:'northstar-reviewer'});
  let publishReviewer:unknown,verifyReviewer:unknown,mergeReviewer:unknown,gateCalls=0;
  f.adapter.publishReview=async(_store,_t,_run,_status,_text,_allowed,reviewer)=>{publishReviewer=reviewer;return 55;};
  f.adapter.verifyReview=async(_t,_r,_c,reviewer)=>{verifyReviewer=reviewer;return 55;};
  f.adapter.mergeGate=async(_t,_history,reviewer)=>{gateCalls++;mergeReviewer=reviewer;return{head,base,wait:''}};
  await f.engine.wake();const reviewRun=f.run();
  assert.equal(reviewRun.formalReview,true,'the reviewer run records the formal mode for its prompt');
  f.idle(reviewRun.agentId!,reviewRun.workspaceId);
  const input:Completion={eventId:'formal-review',taskId:f.task.id,runId:reviewRun.id,status:'ready_to_merge',summary:'Accepted exact head',head,reviewText:'Full findings'};
  f.engine.resolution.complete(input,f.tokens.get(reviewRun.id)!);await f.engine.wake();
  assert.deepEqual(publishReviewer,{login:'northstar-reviewer'});
  assert.deepEqual(verifyReviewer,{login:'northstar-reviewer'});
  assert.equal(f.current().resolution.review?.reviewId,55,'the formal review id is recorded as a review id');
  assert.equal(f.current().resolution.review?.reviewCommentId,undefined,'a formal review never masquerades as a comment id');
  assert.ok(f.store.events(f.task.id).some(event=>event.kind==='review_published'&&event.detail==='PR review 55'));
  await f.engine.wake();await f.engine.wake();
  assert.ok(gateCalls>=1);assert.deepEqual(mergeReviewer,{login:'northstar-reviewer'});
  assert.equal(f.counts().merges,1);
  await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.run().role,'closeout');
  await f.report('closed');
  assert.equal(f.current().phase,'done');
  const outcome=f.store.outcome(f.task.id)!;
  assert.equal(outcome.review?.reviewId,55,'the outcome keeps the formal review id');
  assert.equal(outcome.review?.commentId,null,'the outcome does not label a formal review as a comment');
 }finally{await f.close()}
});

test('an opted-in repository cannot merge a task that skipped PR review', async () => {
 const f=fixture();try{
  // Spec 033: the reviewer setting is an exact-head approval gate, not a comment-path preference.
  f.store.putRepository({origin:null,path:'/repo'},'agent','fixture keeps agent closeout',null,{login:'northstar-reviewer'});
  f.store.update(f.task.id,{skipPRReview:true,phase:'awaiting_review',reason:'Review skipped by submission'});
  await f.engine.wake();
  assert.equal(f.current().phase,'merging','the skip lane advances to the merge prerequisites');
  await f.engine.wake();
  assert.equal(f.counts().merges,0,'an opted-in skip-review task never merges without the reviewer approval');
  assert.equal(f.current().resolution.attention,true);
  assert.match(f.current().reason,/independent review is required/);
 }finally{await f.close()}
});

// Spec 040: merge hold owners and release prompts.
const holdNotices=(f:ReturnType<typeof fixture>)=>f.store.notices(f.task.id).filter(n=>n.kind==='hold');
const holdReleaseNotices=(f:ReturnType<typeof fixture>)=>f.store.notices(f.task.id).filter(n=>n.kind==='hold_release');
const addTargetTask=(f:ReturnType<typeof fixture>,title:string)=>f.store.insert(submissionSchema.parse({submissionId:randomUUID(),title,repoPath:'/repo',planningCommit:base,handoffPath:'handoff.md',originAgentId:'origin'}),'host','handoff',base);
const minutesAgo=(minutes:number)=>new Date(Date.now()-minutes*60_000).toISOString();
async function heldAtReviewedHead(agentId?:string){
 const f=fixture();
 await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',reason:'External receipt pending',...(agentId?{agentId}:{})});
 await f.engine.wake();
 await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();
 return f;
}
test('Spec 040 rows 1 and 2: hold and keep_hold refuse a missing reason, and a brief hold needs its reason',()=>{
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'hold'}).success,false);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'hold',reason:'  '}).success,false);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'keep_hold'}).success,false);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'hold',reason:'Receipt pending',agentId:'agent'}).success,true);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'release',agentId:'agent'}).success,false);
});
test('Spec 040 rows 3 to 6: the owner is prompted once, reminded on schedule, and keep_hold restarts the clock',async()=>{
 const f=await heldAtReviewedHead('origin');try{
  const first=f.current();
  assert.equal(holdOwnerOf(first,first.holdOwner),'origin');assert.equal(first.holdReason,'External receipt pending');assert.equal(first.holdGeneration,1);
  assert.equal(first.phase,'verifying');assert.equal(first.holdBlocking?.head,head);assert.ok(first.holdBlocking?.since);
  assert.equal(holdNotices(f).length,1,'one notice when the hold becomes the last blocker');
  assert.equal(holdNotices(f)[0]!.agentId,'origin');assert.match(holdNotices(f)[0]!.text,new RegExp(`Reviewed head: ${head}`));assert.match(holdNotices(f)[0]!.text,/External receipt pending/);
  assert.equal(holdNotices(f)[0]!.status,'delivered');assert.equal(f.notices.filter(key=>key===holdNotices(f)[0]!.id).length,1);
  await f.engine.wake();await f.engine.wake();
  assert.equal(holdNotices(f).length,1,'row 4: no second notice before the reminder time');
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='hold_ready_notified'));
  f.store.update(f.task.id,{holdBlocking:{...f.current().holdBlocking!,lastNoticeAt:minutesAgo(121)}});
  await f.engine.wake();
  assert.equal(holdNotices(f).length,2,'row 5: one reminder once the reminder time passes');
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='hold_reminded'));
  await f.engine.wake();assert.equal(holdNotices(f).length,2);
  const kept=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'keep_hold',reason:'Receipt arrives tomorrow',agentId:'origin'}) as Task;
  assert.equal(kept.holdGeneration,2);assert.equal(kept.holdReason,'Receipt arrives tomorrow');assert.ok(Date.now()-Date.parse(kept.holdBlocking!.since)<60_000,'the clock restarts');
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='hold_kept'));
  await f.engine.wake();assert.equal(holdNotices(f).length,2,'row 6: no prompt until the reminder time passes again');
  f.store.update(f.task.id,{holdBlocking:{...f.current().holdBlocking!,lastNoticeAt:minutesAgo(121)}});
  await f.engine.wake();
  assert.equal(holdNotices(f).length,3,'the next prompt follows the reminder time');
  assert.notEqual(holdNotices(f)[2]!.id,holdNotices(f)[1]!.id);
 }finally{await f.close()}
});
test('Spec 040 row 7 and 8: escalation reaches Pipeline; Keep needs a reason; Release merges and clears it',async()=>{
 const f=await heldAtReviewedHead('origin');try{
  assert.equal(summarizeTask(f.current()).holdEscalated,undefined);
  f.store.update(f.task.id,{holdBlocking:{...f.current().holdBlocking!,since:minutesAgo(241),lastNoticeAt:minutesAgo(1)}});
  await f.engine.wake();
  const escalated=f.current();
  assert.ok(escalated.holdBlocking?.escalatedAt);assert.ok(f.store.events(f.task.id).some(e=>e.kind==='hold_escalated'));
  const summary=summarizeTask(escalated);
  assert.equal(summary.holdEscalated,true);assert.equal(summary.hold?.reason,'External receipt pending');assert.equal(summary.hold?.owner,'origin');
  const card=pipelineBoard({projects:[],lanes:[],selection:[],papercuts:[],leads:[],tasks:[summary],decisions:[],pendingSubmissions:[]} as never).cards.Decisions[0]!;
  assert.equal(card.kind,'raised');assert.equal(pipelineColumn(card),'Decisions');
  assert.throws(()=>taskControlInputSchema.parse({taskId:f.task.id,version:escalated.version,action:'keep_hold'}),/requires its reason/);
  const kept=await f.engine.performTaskControl({taskId:f.task.id,version:escalated.version,action:'keep_hold',reason:'Operator keeps it for the receipt'}) as Task;
  assert.equal(holdOwnerOf(kept,kept.holdOwner),'origin','an operator keep leaves the owner');assert.equal(summarizeTask(kept).holdEscalated,undefined,'keep clears the escalation');
  f.store.update(f.task.id,{holdBlocking:{...f.current().holdBlocking!,since:minutesAgo(241),lastNoticeAt:minutesAgo(1),escalatedAt:minutesAgo(1)}});
  assert.equal(summarizeTask(f.current()).holdEscalated,true);
  const released=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'release'}) as Task;
  assert.equal(released.held,false);assert.equal(released.holdBlocking,null);assert.equal(summarizeTask(released).holdEscalated,undefined);
  await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.counts().merges,1,'Release continues to merge');
  assert.ok(holdNotices(f).every(n=>n.status!=='pending'),'no prompt stays pending after release');
 }finally{await f.close()}
});
test('Spec 040 row 8: a pending prompt is superseded when the hold is released before delivery',async()=>{
 const f=await heldAtReviewedHead('origin');try{
  f.store.update(f.task.id,{holdBlocking:{...f.current().holdBlocking!,lastNoticeAt:minutesAgo(121)}});
  f.engine.resolution.claimIntegrationTurn(f.current());
  assert.equal(holdNotices(f).filter(n=>n.status==='pending').length,1,'the reminder is queued but not yet delivered');
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'release'});
  await f.engine.resolution.deliverHoldNotices();
  assert.ok(holdNotices(f).every(n=>n.status!=='pending'));
 }finally{await f.close()}
});
test('Spec 040 row 9: a new reviewed head restarts the clock and prompts again',async()=>{
 const f=await heldAtReviewedHead('origin');try{
  const newHead='d'.repeat(40);
  f.store.update(f.task.id,{holdBlocking:{...f.current().holdBlocking!,since:minutesAgo(200)}});
  const current=f.current();
  f.store.update(f.task.id,{prHead:newHead,resolution:{...current.resolution,review:{...current.resolution.review!,head:newHead}}});
  await f.engine.wake();
  const next=f.current();
  assert.equal(next.holdBlocking?.head,newHead);assert.ok(Date.now()-Date.parse(next.holdBlocking!.since)<60_000);
  assert.equal(holdNotices(f).length,2,'a prompt names the new head');assert.match(holdNotices(f)[1]!.text,new RegExp(`Reviewed head: ${newHead}`));
 }finally{await f.close()}
});
test('Spec 040: an operator board hold is shown but never prompted or escalated, for either operator identity (review #602)',async()=>{
 for(const owner of [undefined,'operator (board)']){
 const f=await heldAtReviewedHead(owner);try{
  assert.equal(f.current().holdOwner,owner??'operator');assert.ok(f.current().holdBlocking);
  f.store.update(f.task.id,{holdBlocking:{...f.current().holdBlocking!,since:minutesAgo(900),lastNoticeAt:null}});
  await f.engine.wake();
  assert.equal(holdNotices(f).length,0);assert.equal(summarizeTask(f.current()).holdEscalated,undefined);assert.equal(f.current().holdBlocking?.escalatedAt??null,null);
 }finally{await f.close()}
 }
});
test('Spec 040 row 11: a queued task under an ordinary hold blocks dispatch and is never prompted',async()=>{
 const f=fixture();try{
  const queued=f.store.update(f.task.id,{phase:'queued'});
  const held=await f.engine.performTaskControl({taskId:queued.id,version:queued.version,action:'hold',reason:'Waiting for design'}) as Task;
  assert.equal(held.holdOwner,'operator');assert.equal(held.holdReason,'Waiting for design');assert.equal(dispatchBlocked(held),true);
  await f.engine.wake();assert.equal(holdNotices(f).length,0);assert.equal(f.current().holdBlocking,null);
 }finally{await f.close()}
});
// Spec 046: self-lifting merge holds.
test('Spec 046: the hold until is a task ID or an offset timestamp, and only on hold', () => {
 const id=randomUUID();
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'hold',reason:'r',until:id}).success,true);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'hold',reason:'r',until:'2026-10-05T00:00:00Z'}).success,true);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'hold',reason:'r',until:'2026-10-05T00:00:00+10:00'}).success,true);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'hold',reason:'r',until:'2026-10-05'}).success,false);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'hold',reason:'r',until:'soon'}).success,false);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'release',until:'2026-10-05T00:00:00Z'}).success,false);
 assert.equal(taskControlInputSchema.safeParse({taskId:'t',version:1,action:'keep_hold',reason:'r',until:'2026-10-05T00:00:00Z'}).success,false);
});
test('Spec 046: a hold until a task lifts itself at done, with one owner notice', async () => {
 const f=fixture();try{
  const target=addTargetTask(f,'Live target');
  f.store.update(target.id,{phase:'working'});
  const held=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',reason:'Until the target lands',agentId:'origin',until:target.id}) as Task;
  assert.deepEqual(held.holdUntil,{kind:'task',taskId:target.id});
  await f.engine.wake();
  assert.equal(f.current().held,true,'a live target keeps the hold');
  assert.equal(holdReleaseNotices(f).length,0);
  await f.engine.wake();
  assert.equal(holdReleaseNotices(f).length,0,'no release before the condition is met');
  f.store.update(target.id,{phase:'done'});
  await f.engine.wake();
  const released=f.current();
  assert.equal(released.held,false,'a done target lifts the hold');
  assert.equal(released.holdUntil,null);
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='hold_auto_released'));
  assert.equal(holdReleaseNotices(f).length,1,'one owner notice');
  assert.equal(holdReleaseNotices(f)[0]!.agentId,'origin');
  assert.equal(holdReleaseNotices(f)[0]!.status,'delivered');
  assert.match(holdReleaseNotices(f)[0]!.text,/until the target lands/i);
  await f.engine.wake();
  assert.equal(holdReleaseNotices(f).length,1,'the release notice is not repeated');
 }finally{await f.close()}
});
test('Spec 046: a hold until a time lifts itself once the time has passed', async () => {
 const f=fixture();try{
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',reason:'Until the receipt window',agentId:'origin',until:new Date(Date.now()+3_600_000).toISOString()});
  await f.engine.wake();
  assert.equal(f.current().held,true,'a future time keeps the hold');
  const kept=await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'keep_hold',reason:'Receipt still pending',agentId:'origin'}) as Task;
  assert.equal(kept.holdUntil?.kind,'time','keep_hold leaves the end condition in force');
  f.store.update(f.task.id,{holdUntil:{kind:'time',at:new Date(Date.now()-60_000).toISOString()}});
  await f.engine.wake();
  assert.equal(f.current().held,false,'a passed time lifts the hold');
  assert.equal(holdReleaseNotices(f).length,1);
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='hold_auto_released'));
 }finally{await f.close()}
});
test('Spec 046: a cancelled or removed target keeps the hold and prompts the owner instead', async () => {
 const f=fixture();try{
  const cancelled=addTargetTask(f,'Cancelled target');
  f.store.update(cancelled.id,{phase:'cancelled'});
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',reason:'Until the cancelled target lands',agentId:'origin',until:cancelled.id});
  await f.engine.wake();
  assert.equal(f.current().held,true,'a cancelled target never lifts the hold');
  assert.deepEqual(f.current().holdUntil,{kind:'task',taskId:cancelled.id});
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='hold_until_blocked'));
  assert.ok(holdNotices(f).some(n=>/can never be met/.test(n.text)),'the owner is prompted');
  assert.equal(holdReleaseNotices(f).length,0);
  const eventsBefore=f.store.events(f.task.id).filter(e=>e.kind==='hold_until_blocked').length;
  await f.engine.wake();await f.engine.wake();
  assert.equal(f.store.events(f.task.id).filter(e=>e.kind==='hold_until_blocked').length,eventsBefore,'the blocked prompt is not repeated for one generation');
  const removed=addTargetTask(f,'Removed target');
  f.store.update(removed.id,{phase:'working'});
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'release'});
  assert.equal(f.current().held,false);
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',reason:'Until the removed target lands',agentId:'origin',until:removed.id});
  f.store.update(removed.id,{removedAt:new Date().toISOString()});
  await f.engine.wake();
  assert.equal(f.current().held,true,'a removed target never lifts the hold');
  assert.equal(holdReleaseNotices(f).length,0);
 }finally{await f.close()}
});
test('Spec 046: a hold cannot wait for its own task', async () => {
 const f=fixture();try{
  await assert.rejects(f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',reason:'Self wait',agentId:'origin',until:f.task.id}),/cannot wait for its own task/);
  assert.equal(f.current().held,false);
 }finally{await f.close()}
});
test('Spec 046: a last-blocker hold still tells the owner when the release lets the task merge', async () => {
 const f=fixture();try{
  const target=addTargetTask(f,'Merge target');f.store.update(target.id,{phase:'working'});
  await f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',reason:'Until the merge target lands',agentId:'origin',until:target.id});
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.current().phase,'verifying');assert.equal(f.current().held,true);
  f.store.update(target.id,{phase:'done'});
  await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.current().held,false);
  assert.equal(f.counts().merges,1,'the lifted hold lets the merge continue');
  assert.equal(holdReleaseNotices(f).length,1,'the owner is told even though the task merged');
  assert.equal(holdReleaseNotices(f)[0]!.status,'delivered');
 }finally{await f.close()}
});







test('unchanged conflict revision preserves authenticated approval and parks unresolved conflict without another review', async () => {
 const f=fixture();try{
  await f.engine.wake();
  f.adapter.mergeGate=async()=>({head,base,wait:MERGE_CONFLICT_REASON,needsRebase:true});
  await f.report('ready_to_merge');
  const accepted=f.current().resolution.review!;
  await f.engine.wake();assert.equal(f.current().phase,'changes_requested');
  await f.engine.wake();const revision=f.run();assert.equal(revision.role,'revision');
  await f.report('ready_for_review');
  assert.deepEqual(f.current().resolution.review,accepted);
  assert.equal(f.current().phase,'verifying');
  await f.engine.wake();
  assert.equal(f.current().resolution.stop?.reason,'escalated');
  assert.equal(f.current().resolution.attention,false,'the planner blocker route owns the park');
  assert.match(f.current().reason,/Waiting with the planner/);
  const escalation=f.store.eventsAll(f.task.id).find(event=>event.kind==='planner_escalation_payload');
  assert.ok(escalation?.detail.includes(MERGE_CONFLICT_REASON),'the planner receives the unresolved conflict');
  const runCount=f.store.runs(f.task.id).length;
  await f.engine.wake();
  assert.equal(f.store.runs(f.task.id).length,runCount,'the parked conflict buys no further run');
  assert.deepEqual(f.store.run(accepted.runId)?.completion,accepted);
  assert.equal(f.store.runs(f.task.id).filter(r=>r.role==='reviewer').length,1);
  assert.equal(f.counts().merges,0);
 }finally{await f.close()}
});

test('unchanged conflict revision reuses approval only after clean current merge gates', async () => {
 const f=fixture();try{
  await f.engine.wake();
  f.adapter.mergeGate=async()=>({head,base,wait:MERGE_CONFLICT_REASON,needsRebase:true});
  await f.report('ready_to_merge');
  await f.engine.wake();await f.engine.wake();
  f.adapter.mergeGate=async()=>({head,base,wait:''});
  await f.reportStep('ready_for_review');await f.step();
  assert.equal(f.current().phase,'merging');
  assert.equal(f.store.runs(f.task.id).filter(r=>r.role==='reviewer').length,1);
  assert.ok(f.current().resolution.mechanicalVerification);
 }finally{await f.close()}
});

// Lean audit 2026-10-15: coordinators run only for stops they can act on.
test('stop classification: holds, lifecycle waits and read-only forge failures never suggest a coordinator verb', () => {
  const cases: Array<[string, string]> = [
    ['Merge held by operator; release to continue', 'held'],
    ['Merge held by owner: personal read of the pickup wording', 'held'],
    ['Dispatch held; release to continue', 'held'],
    ['Waiting for repository integration turn', 'lifecycle'],
    ['External merge check: Command failed: gh api repos/consumer-b/project-a-accelerator/pulls/4280 / gh: HTTP 503', 'external_unavailable'],
    ['Command failed: gh pr view 4197 --repo o/r --json number,url / HTTP 500: 500 Internal Server Error', 'external_unavailable'],
    ['Integration checkout changed while fetching', 'external_unavailable'],
  ];
  for (const [detail, reason] of cases) {
    const classified = taskStopClassification(detail);
    assert.equal(classified.reason, reason, detail);
    assert.deepEqual(classified.suggestedVerbs, [], detail);
  }
  // A mutating call's outcome is unknown, not absent: it stays a real stop.
  assert.equal(isTransientExternalFailure('Command failed: gh api repos/o/r/pulls/9/merge -X PUT -f sha=abc / gh: HTTP 502'), false);
  assert.equal(taskStopClassification('Command failed: gh api repos/o/r/pulls/9/merge -X PUT -f sha=abc / gh: HTTP 502').reason, 'operator_needed');
  assert.equal(isTransientExternalFailure('Command failed: gh api repos/o/r/pulls/9 / gh: HTTP 404'), false, 'a 4xx is not transient');
});
test('a GitHub 5xx on a read-only probe waits instead of parking, and launches no coordinator', async () => {
 const f=fixture();try{
  enableRecovery(f);
  f.engine.resolution.attention(f.current(),`${EXTERNAL_MERGE_CHECK_REASON_PREFIX} Command failed: gh api repos/o/r/pulls/9 / gh: HTTP 503`);
  const t=f.current();
  assert.equal(t.resolution.attention,false,'no attention park');
  assert.equal(t.resolution.incident??null,null,'no incident');
  assert.equal(t.resolution.stop?.reason,'external_unavailable');
  assert.equal(await f.engine.resolution.recovery.route(t),null);
  assert.equal(f.creates.filter(run=>run.role==='recovery').length,0,'no coordinator run');
 }finally{await f.close()}
});
test('an integration-turn wait and a merge hold launch no coordinator', async () => {
 for (const reason of ['Waiting for repository integration turn', 'Merge held by operator; release to continue']) {
  const f=fixture();try{
   enableRecovery(f);
   if (reason.startsWith('Waiting')) f.engine.resolution.waiting(f.current(), reason, 'lifecycle');
   else attention(f, reason);
   f.engine.resolution.recordStop(f.current(), taskStopClassification(reason).reason, reason, taskStopClassification(reason).suggestedVerbs);
   assert.equal(await f.engine.resolution.recovery.route(f.current()),null,reason);
   assert.equal(f.creates.filter(run=>run.role==='recovery').length,0,`no coordinator for: ${reason}`);
  }finally{await f.close()}
 }
});
test('a coordinator retry_effect reaches the owner-verb registry, and a refusal names why', async () => {
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;f.idle(r.agentId!,r.workspaceId);
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:r.id,status:'recovered',summary:'Retry the recorded effect',coordinatorAction:{verb:'retry_effect',reason:'The effect failed transiently'},coordinatorGeneration:r.generation},f.tokens.get(r.id)!);
  await f.engine.resolution.recovery.pass();
  const action=f.current().resolution.recovery?.action;
  assert.equal(action?.status,'refused');
  assert.match(action?.reason??'',/The reported retry_effect does not apply to the task now \(stop operator_needed\): No failed or uncertain side effect is recorded on this task/);
 }finally{await f.close()}
});
test('an escalation that quotes a transient probe failure, and an unclassified wait, stay actionable stops', async () => {
 // PR #478 review: the uncertain-merge escalation quotes its failed lookup; it must still park and reach a coordinator.
 const escalation='Uncertain merge requires operator attention: No complete non-merge proof within 30 minutes; latest observation failed: Error: Command failed: gh api repos/o/r/pulls/9 / gh: HTTP 503';
 assert.equal(isTransientExternalFailure(escalation),false);
 assert.equal(taskStopClassification(escalation).reason,'operator_needed');
 const f=fixture();try{
  enableRecovery(f);
  f.engine.resolution.attention(f.current(),escalation);
  assert.equal(f.current().resolution.attention,true,'the escalation parks');
  assert.equal(f.current().resolution.stop?.reason,'operator_needed');
 }finally{await f.close()}
 // A permanent fault reported through waiting() keeps operator_needed, so a coordinator can act on it.
 const g=fixture();try{
  enableRecovery(g);
  // An unclassified text still classifies as operator_needed when a restored reason is replayed.
  g.engine.resolution.waiting(g.current(),'Historical reviewer profile runtime identity changed','classify');
  assert.equal(g.current().resolution.stop?.reason,'operator_needed');
  assert.deepEqual(g.current().resolution.stop?.suggestedVerbs,['restart','route','move']);
 }finally{await g.close()}
});

// Typed stops (lean audit 2026-10-15): Queue's own waits name their reason, so rewording a message cannot change it.
test('a typed wait keeps its stop reason whatever its wording, and a stall keeps its cause', () => {
  const f=fixture();try{
   f.engine.resolution.waiting(f.current(),'Anything at all, worded freely, mentioning idle and stopped threads','capacity');
   assert.equal(f.current().resolution.stop?.reason,'capacity');
   assert.deepEqual(f.current().resolution.stop?.suggestedVerbs,[]);
   f.engine.resolution.waiting(f.current(),'Some fault Queue names explicitly','operator_needed');
   assert.deepEqual(f.current().resolution.stop?.suggestedVerbs,['restart','route','move']);
  }finally{void f.close()}
  const g=fixture();try{
   g.engine.resolution.attention(g.current(),'The worker run r1 looks stalled; it stopped reporting and is inactive','stalled_turn');
   assert.equal(g.current().resolution.incident?.cause,'stalled_turn','the explicit cause wins over words like stopped or inactive');
  }finally{void g.close()}
});
test('a coordinator bound to the planning thread is a fault an owner clears, not a routing wait', async () => {
 // PR #485 review: the route_unavailable recheck only looks for a selectable profile and never repairs a bad binding.
 const f=fixture();try{
  enableRecovery(f);attention(f);
  f.store.update(f.task.id,{coordinatorAgentId:f.current().originAgentId});
  assert.equal(await f.engine.resolution.recovery.route(f.current()),null);
  assert.equal(f.current().resolution.stop?.reason,'operator_needed');
  assert.deepEqual(f.current().resolution.stop?.suggestedVerbs,['restart','route','move']);
 }finally{await f.close()}
});


test('a publication fault and coordinator cannot stay settled across wakes and engine restart', async () => {
 const f=fixture();let restarted:Engine|undefined;
 try{
  enableRecovery(f);
  let publications=0;
  f.adapter.publishReview=async(store,task,run,status,text)=>{
   publications++;
   // Match the real forge adapter's durable pre-send intent. Its uncertain
   // result must park automatic publication retries until explicit reconciliation.
   store.setMeta(`reviewPublication:${run.id}`,{hash:digest(reviewPublicationBody(task,run,status,text))});
   throw Error('Review publication is uncertain; the marked review does not match the persisted findings body hash. Inspect the PR.');
  };
  await f.engine.wake();const reviewer=f.run();
  f.engine.resolution.complete({eventId:'unpublished-findings',taskId:f.task.id,runId:reviewer.id,status:'changes_required',reviewResponsibility:'author',summary:'Fix the citation grammar',reviewText:'Original findings',head:reviewer.head},f.tokens.get(reviewer.id)!);
  f.idle(reviewer.agentId!,reviewer.workspaceId);
  await f.engine.wake();
  assert.equal(publications,1);
  assert.ok(f.store.getMeta(`reviewPublication:${reviewer.id}`),'the uncertain publication intent is retained before the retry selector runs');
  const recovery=f.store.run(f.current().resolution.recovery!.runId!)!;
  f.engine.resolution.complete({eventId:'cannot-publish',taskId:f.task.id,runId:recovery.id,status:'blocked',summary:'Owner must choose revision; preserve original mismatch',coordinatorGeneration:recovery.generation,coordinatorAction:{verb:'cannot',reason:'Exact marked body differs'}},f.tokens.get(recovery.id)!);
  f.idle(recovery.agentId!,recovery.workspaceId);
  await f.engine.wake();
  const settled=f.current(), count=f.creates.length;
  assert.equal(settled.resolution.recovery?.action?.status,'refused');
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='planner_escalation').length,1,'the blocked recovery result reaches the planner ladder');
  for(let i=0;i<3;i++)await f.engine.wake();
  assert.equal(publications,1,'already-recorded findings are not another late completion');
  assert.equal(f.creates.length,count,'one stop receives one coordinator episode');
  await f.engine.stop();
  restarted=new Engine(f.store,f.adapter,0,()=>true);restarted.profiles=f.engine.profiles;
  await restarted.wake();await restarted.wake();
  assert.equal(publications,1);
  assert.equal(f.creates.length,count);
  assert.equal(f.current().resolution.recovery?.id,settled.resolution.recovery?.id);
  assert.equal(f.current().resolution.recoveryAttempts,settled.resolution.recoveryAttempts);
  assert.match(f.current().resolution.recovery!.summary,/Owner must choose revision/);
  // An explicit owner action chooses revision under a retained dispatch hold.
  await restarted.performTaskControl({taskId:f.task.id,version:f.current().version,action:'hold',kind:'dispatch',reason:'Owner prepares author return'});
  const held=f.current().holds;
  await restarted.moveToWork({taskId:f.task.id,version:f.current().version,reason:'Owner chooses source correction',instruction:'Fix citations and integrate main'});
  await restarted.wake();
  assert.deepEqual(f.current().holds,held);assert.equal(f.sends.length,0);
  await restarted.performTaskControl({taskId:f.task.id,version:f.current().version,action:'release',kind:'dispatch'});
  await restarted.wake();
  assert.equal(f.sends.filter(run=>run.role==='revision').length,1,'separate holder release starts one author revision');
  assert.equal(f.store.run(reviewer.id)!.completion!.reviewId,undefined,'owner return never credits unpublished findings');
 }finally{await restarted?.stop();await f.close()}
});

test('an unpublished accepted verdict is published and applied from the released reviewer run', async () => {
 const f=fixture();try{
  enableRecovery(f);
  let publications=0;
  f.adapter.publishReview=async()=>{publications++;if(publications===1)throw Error('Transient publication failure');return 77;};
  await f.engine.wake();const reviewer=f.run();
  f.engine.resolution.complete({eventId:'unpublished-accepted',taskId:f.task.id,runId:reviewer.id,status:'ready_to_merge',summary:'Exact head accepted',reviewText:'No findings on the exact head.',head:reviewer.head},f.tokens.get(reviewer.id)!);
  f.idle(reviewer.agentId!,reviewer.workspaceId);
  await f.engine.wake();
  assert.equal(f.store.run(reviewer.id)?.released,true,'the accepted callback is retained on a released run');
  assert.equal(f.store.events(f.task.id).some(event=>event.kind==='review_published'),false);
  assert.equal(f.store.getMeta(`reviewPublication:${reviewer.id}`),undefined,'no publication intent or result was recorded');
  assert.equal(f.current().resolution.incident?.runId,reviewer.id,'the publication failure is attached to the retained reviewer');
  assert.equal(f.current().resolution.attention,true,'the publication failure remains visible while it is retried');
  f.adapter.publishReview=async()=>{publications++;return 77;};
  await f.engine.wake();
  assert.equal(publications,2,'the next lifecycle pass retries publication');
  assert.equal(f.current().resolution.review?.runId,reviewer.id);
  assert.equal(f.current().phase,'closing','normal merge progression continues after applying the verdict');
  assert.equal(f.current().resolution.attention,false,'the transient publication incident is settled with the verdict');
  assert.equal(f.store.runs(f.task.id).find(run=>run.role==='recovery')?.status,'superseded','the recovery started for the failed application is fenced');
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='review_result_applied'&&event.detail===reviewer.id).length,1);
  await f.engine.wake();
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='review_result_applied'&&event.detail===reviewer.id).length,1,'later passes do not apply twice');
 }finally{await f.close()}
});

test('a genuinely late authenticated reviewer callback clears its missing-result stop once',async()=>{
 const f=fixture();try{
  await f.engine.wake();const run=f.run();
  f.engine.resolution.attention(f.current(),'The reviewer thread stopped without a callback; inspect the thread','missing_callback');
  const receipt={eventId:'genuine-late',taskId:f.task.id,runId:run.id,status:'changes_required' as const,reviewResponsibility:'author' as const,summary:'Fix source',head:run.head,reviewCommentId:14};
  f.engine.resolution.complete(receipt,f.tokens.get(run.id)!);
  f.idle(run.agentId!,run.workspaceId);await f.step();
  assert.equal(f.current().resolution.attention,false);
  assert.equal(f.current().resolution.review?.eventId,receipt.eventId);
  assert.equal(f.current().resolution.review?.status,'changes_required');
 }finally{await f.close()}
});

// Round 4 (2026-10-19 audit): a coordinator report binds to its episode and
// generation, not to the exact stop record it was opened for.
test('a coordinator report still applies after its stop is re-recorded for the same reason (round 4)', async () => {
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;f.idle(r.agentId!,r.workspaceId);
  const { collectOwnerVerbFacts, ownerTaskNext } = await import('../core/verbs/owner-verbs');
  const offered=ownerTaskNext(collectOwnerVerbFacts(f.store,f.current())).verbs.find(view=>view.available&&(view.verb==='move'||view.verb==='restart'));
  assert.ok(offered,'the stopped task offers a move or restart');
  const action=offered!.verb==='move'?{verb:'move' as const,to:offered!.args!.to as 'work',reason:'Coordinator chose it'}:{verb:'restart' as const,reason:'Coordinator chose it'};
  // The stop is re-recorded for the same reason before the coordinator reports:
  // its detail changes, its since is kept (taskStopRecord), so the digest holds.
  const stop=f.current().resolution.stop!;
  f.store.update(f.task.id,{resolution:{...f.current().resolution,stop:{...stop,detail:`${stop.detail} (re-observed)`}}});
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:r.id,status:'recovered',summary:'Apply the offered verb',coordinatorAction:action,coordinatorGeneration:r.generation},f.tokens.get(r.id)!);
  await f.engine.resolution.recovery.pass();
  // The applied verb settles the episode itself, so read the outcome from the event log.
  const kinds=f.store.events(f.task.id).map(event=>event.kind);
  assert.ok(kinds.includes('coordinator_action_applied'),`a refreshed stop no longer refuses the report: ${JSON.stringify(f.store.eventsAll(f.task.id).slice(-15))}`);
  assert.ok(!kinds.includes('coordinator_action_refused'));
  // Telemetry records the coordinator's action once, and never as an owner control.
  assert.deepEqual(f.store.verbOutcomes('1970-01-01T00:00:00.000Z').map(row=>[row.action,row.outcome,row.source,row.detail.coordinatorRun]),[[action.verb,'applied','coordinator',r.id]]);
 }finally{await f.close()}
});

test('a new stop with the same reason after progress does not revive a stale coordinator action (review #535)', async () => {
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;f.idle(r.agentId!,r.workspaceId);
  const opened=f.current().resolution.stop!;
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:r.id,status:'recovered',summary:'Send it back',coordinatorAction:{verb:'move',to:'work',reason:'Back to the author'},coordinatorGeneration:r.generation},f.tokens.get(r.id)!);
  // Progress (a late review result) clears the stop, then a new fault records a fresh stop with the same reason.
  f.store.update(f.task.id,{resolution:{...f.current().resolution,stop:null,review:{eventId:'late-review',taskId:f.task.id,runId:'late-reviewer',status:'ready_to_merge',summary:'Late approval',head}}});
  f.store.update(f.task.id,{resolution:{...f.current().resolution,stop:{...opened,detail:'A new fault',since:new Date(Date.parse(opened.since)+60000).toISOString()}}});
  const phaseBefore=f.current().phase;
  await f.engine.resolution.recovery.pass();
  const kinds=f.store.events(f.task.id).map(event=>event.kind);
  assert.ok(kinds.includes('coordinator_action_refused'));
  assert.ok(!kinds.includes('coordinator_action_applied'),'the stale move is not revived by a same-reason stop');
  assert.deepEqual(f.store.verbOutcomes('1970-01-01T00:00:00.000Z').map(row=>[row.action,row.outcome,row.source]),[['move','refused','coordinator']]);
  assert.equal(f.current().phase,phaseBefore);
 }finally{await f.close()}
});

test('a coordinator report from a superseded generation is still refused (round 4)', async () => {
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;f.idle(r.agentId!,r.workspaceId);
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:r.id,status:'recovered',summary:'Restart',coordinatorAction:{verb:'restart',reason:'Restart it'},coordinatorGeneration:r.generation},f.tokens.get(r.id)!);
  f.store.update(f.task.id,{coordinatorGeneration:r.generation+1});
  await f.engine.resolution.recovery.pass();
  const recorded=f.current().resolution.recovery?.action;
  assert.equal(recorded?.status,'refused');
  assert.match(recorded?.reason??'',/newer coordinator episode or generation|coordinator generation changed/);
  // Telemetry counts the refusal once, whichever path settled it (review #537).
  assert.deepEqual(f.store.verbOutcomes('1970-01-01T00:00:00.000Z').map(row=>[row.action,row.outcome,row.source]),[['restart','refused','coordinator']]);
 }finally{await f.close()}
});

test('a stale coordinator action after the task moved on is refused, not applied over the new state (review #535)', async () => {
 const f=fixture();try{
  enableRecovery(f);attention(f);await f.engine.wake();const r=f.store.run(f.current().resolution.recovery!.runId!)!;f.idle(r.agentId!,r.workspaceId);
  // The coordinator reports, then the task moves on before the report applies: a late result lands and its stop clears.
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:r.id,status:'recovered',summary:'Send it back',coordinatorAction:{verb:'move',to:'work',reason:'Back to the author'},coordinatorGeneration:r.generation},f.tokens.get(r.id)!);
  const before=f.current();
  f.store.update(f.task.id,{resolution:{...before.resolution,stop:null,review:{eventId:'late-review',taskId:f.task.id,runId:'late-reviewer',status:'ready_to_merge',summary:'Late approval',head}}});
  const phaseBefore=f.current().phase;
  await f.engine.resolution.recovery.pass();
  const kinds=f.store.events(f.task.id).map(event=>event.kind);
  assert.ok(kinds.includes('coordinator_action_refused'),'the stale action is refused');
  assert.ok(!kinds.includes('coordinator_action_applied'));
  assert.equal(f.current().phase,phaseBefore,'the task state the coordinator did not see is left alone');
  assert.match(f.current().resolution.recovery?.action?.reason??'',/moved on since the coordinator was asked/);
 }finally{await f.close()}
});

/** Spec 052 sign-off on retained bindings (Sol, #580; Tom 2026-10-21: keep the worker's own thread). */
function signoffPool(f:ReturnType<typeof fixture>, frontier:string){
 const cheapReviewer=profile('cheap-reviewer'),cheapCoordinator=profile('cheap-coordinator');
 f.engine.profiles=[...f.engine.profiles,cheapReviewer,cheapCoordinator];
 f.store.setMeta('pool',[...f.store.pool().map(p=>({...p,cost:p.profileId===frontier?'very_high' as const:p.cost,capability:p.profileId===frontier?'frontier' as const:p.capability})),
  {profileId:cheapReviewer.id,enabled:true,group:'cheap-review',roles:['reviewer'],weight:1,scopes:['general'],cost:'low',capability:'medium'},
  {profileId:cheapCoordinator.id,enabled:true,group:'cheap-coordinate',roles:['coordinator'],weight:1,scopes:['general'],cost:'very_low',capability:'low'}]);
}
test('sign-off: a worker already bound to its task keeps its own thread on an unsigned frontier profile',async()=>{
 const f=fixture();try{
  signoffPool(f,'author');
  f.adapter.verifyResume=async()=>head;
  const t=f.store.update(f.task.id,{phase:'changes_requested',profileRequests:{worker:{profileId:'author',reason:'Legacy live request',required:true}}});
  await f.engine.resolution.launch(t,'revision');
  assert.equal(f.sends.length,1);
  assert.equal(f.sends[0].profile?.id,'author','continuing its own thread is not a new selection');
 }finally{await f.close()}
});
test('sign-off: a fresh reviewer on an unsigned retained frontier profile is selected within the level instead',async()=>{
 const f=fixture();try{
  signoffPool(f,'reviewer');
  f.idle('retained-reviewer');
  const t=f.store.update(f.task.id,{profileRequests:{reviewer:{profileId:'reviewer',reason:'Legacy live request',required:true}},resolution:{...f.current().resolution,reviewerAgentId:'retained-reviewer',reviewerProfile:f.engine.profiles.find(p=>p.id==='reviewer')!}});
  await f.engine.resolution.launch(t,'reviewer');
  assert.equal(f.creates.at(-1)?.profile?.id,'cheap-reviewer',`${f.current().phase}: ${f.current().reason}`);
  const signed=f.store.update(f.task.id,{phase:'awaiting_review',profileRequests:{reviewer:{profileId:'reviewer',reason:'Legacy live request',required:true,
   signoff:{status:'approved',decisionId:'d',by:'operator (board)',at:new Date().toISOString(),note:''}}},resolution:{...f.current().resolution,currentRunId:null,reviewerAgentId:null,reviewerProfile:f.engine.profiles.find(p=>p.id==='reviewer')!}});
  for(const run of f.store.runs(f.task.id))f.store.putRun({...run,status:'finished',released:true});
  await f.engine.resolution.launch(signed,'reviewer');
  assert.equal(f.creates.at(-1)?.profile?.id,'reviewer','a signed-off request keeps the frontier reviewer');
 }finally{await f.close()}
});
test('sign-off: a bound coordinator on an unsigned frontier profile is not reused; the next run is selected within the level',async()=>{
 const f=fixture();try{
  signoffPool(f,'coordinator');
  const p=f.engine.profiles.find(item=>item.id==='coordinator')!;
  f.idle('retained-coordinator');
  f.store.putRun({id:'old-coordinate',taskId:f.task.id,role:'closeout',generation:1,head,base:'c'.repeat(40),agentId:'retained-coordinator',workspaceId:'workspace',profile:p,status:'finished',createdAt:new Date().toISOString(),lastObservedAt:new Date().toISOString(),active:false,idleSince:new Date().toISOString(),completion:null,released:true} as Run);
  const t=f.store.update(f.task.id,{phase:'closing',coordinatorAgentId:'retained-coordinator',resolution:{...f.store.task(f.task.id).resolution,syncedCommit:'c'.repeat(40)}});
  await f.engine.resolution.launch(t,'closeout');
  // Spec 053 (Tom, 2026-11-04): every profile rated at or above the demand rotates, so the cheapest is no longer forced; the frontier binding is what must not be reused.
  assert.notEqual(f.creates.at(-1)?.profile?.id,'coordinator',`${f.current().phase}: ${f.current().reason}`);
  assert.ok(f.store.events(f.task.id).some(e=>e.kind==='coordinator_route_applied'&&/awaits the operator's board sign-off/.test(e.detail)));
 }finally{await f.close()}
});
test('sign-off: replacement selection never carries an unsigned worker request\'s thinking level (Sol, #580)',async()=>{
 const f=fixture();try{
  const frontier={...profile('frontier'),supportedThinking:['xhigh']};
  f.engine.profiles.push(frontier);
  f.store.setMeta('pool',[...f.store.pool().map(p=>({...p,cost:'low' as const})),{profileId:'frontier',enabled:true,group:'frontier',roles:['worker'],scopes:['general'],weight:1,cost:'very_high',capability:'frontier'}]);
  f.adapter.verifyResume=async()=>head;
  f.store.update(f.task.id,{phase:'changes_requested'});
  const routed=await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.current().version,action:'route',role:'worker',profileId:'frontier',thinkingOptionId:'xhigh',reason:'Stronger author',caller:'owner-thread'}));
  assert.equal(chooseProfile(routed,f.engine.profiles,f.store.pool(),{},new Set(),'worker')?.profile.id,'author');
  await (f.engine as unknown as {recoverExhaustedWorkers:()=>Promise<void>}).recoverExhaustedWorkers();
  assert.doesNotMatch(f.current().reason,/thinking option xhigh unsupported/,'the unsigned level does not narrow the replacement');
 }finally{await f.close()}
});
test('sign-off: once the operator approves, the requested reviewer takes over from the automatic fallback (Sol, #580)',async()=>{
 const f=fixture();try{
  const cheap=profile('cheap-reviewer');f.engine.profiles.push(cheap);
  f.store.setMeta('pool',[...f.store.pool().map(p=>({...p,cost:p.profileId==='reviewer'?'very_high' as const:'low' as const,capability:p.profileId==='reviewer'?'frontier' as const:p.capability})),{profileId:cheap.id,enabled:true,group:'cheap-review',roles:['reviewer'],scopes:['general'],weight:1,cost:'low'}]);
  const t=f.store.update(f.task.id,{profileRequests:{reviewer:{profileId:'reviewer',reason:'Strong independent review',required:true}}});
  const decisions=new Decisions(f.store);
  reconcileRoutingSignoffs(f.store,decisions,t.id,f.engine.profiles);
  const decisionId=f.current().profileRequests!.reviewer!.signoff!.decisionId!;
  await f.engine.resolution.launch(f.current(),'reviewer');
  const first=f.creates.at(-1)!;
  assert.equal(first.profile?.id,'cheap-reviewer','unsigned: the fallback reviews');
  f.store.putRun({...f.store.run(first.id)!,status:'finished',released:true});f.idle(first.agentId!);
  f.store.update(t.id,{phase:'awaiting_review',resolution:{...f.current().resolution,currentRunId:null}});
  const d=decisions.get({id:decisionId});decisions.answer({id:d.id,version:d.version,answer:signoffApprove('reviewer'),answeredBy:'operator (board)',relayed:false,note:''});
  reconcileRoutingSignoffs(f.store,decisions,t.id,f.engine.profiles);
  await f.engine.resolution.launch(f.current(),'reviewer');
  assert.equal(f.creates.at(-1)?.profile?.id,'reviewer','signed off: the requested reviewer takes over');
 }finally{await f.close()}
});
test('sign-off: an unsigned coordinator request does not narrow automatic coordinator scope (Sol, #580)',async()=>{
 const f=fixture();try{
  const specialist=profile('specialist');f.engine.profiles.push(specialist);
  f.store.setMeta('pool',[...f.store.pool(),{profileId:specialist.id,enabled:true,group:'specialist',roles:['coordinator'],weight:1,scopes:['complex'],cost:'high',capability:'frontier'}]);
  f.store.update(f.task.id,{scope:'complex',phase:'verifying'});
  const unsigned=f.store.update(f.task.id,{profileRequests:{coordinator:{profileId:specialist.id,reason:'Domain expertise',required:true}}});
  // Spec 053 (Tom, 2026-11-04): the automatic set serves; a fresh pool breaks the tie by id, so the cheapest is not forced.
  assert.ok(['author','coordinator','reviewer'].includes(f.engine.resolution.select(unsigned,'coordinator')?.profile.id??''),'the general coordinator set still serves; the frontier specialist is not picked');
 }finally{await f.close()}
});
test('sign-off: a worker "Use" answer carries into a pending replacement aimed at the requested profile (Sol, #580)',async()=>{
 const f=fixture();try{
  const requested=profile('frontier'),chosen=profile('chosen');f.engine.profiles.push(requested,chosen);
  f.store.setMeta('pool',[...f.store.pool().map(p=>({...p,cost:'low' as const})),...['frontier','chosen'].map(id=>({profileId:id,enabled:true,group:id,roles:['worker'],weight:1,scopes:['general'],cost:'very_high' as const,capability:'frontier'}))]);
  f.adapter.verifyResume=async()=>head;
  f.store.update(f.task.id,{phase:'changes_requested'});
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.current().version,action:'route',role:'worker',profileId:requested.id,reason:'Stronger author',caller:'owner-thread'}));
  const decisions=new Decisions(f.store);reconcileRoutingSignoffs(f.store,decisions,f.task.id,f.engine.profiles);
  const id=f.current().profileRequests!.worker!.signoff!.decisionId!;
  const d=decisions.get({id});decisions.answer({id,version:d.version,answer:'Use chosen',answeredBy:'operator (board)',relayed:false,note:''});
  reconcileRoutingSignoffs(f.store,decisions,f.task.id,f.engine.profiles);
  // Spec 058 task 577: the unsigned route armed nothing, so the board's answer
  // takes effect through the next worker launch, which arms the approved pick
  // through worker_route_honoured; the sweep then retires once for it.
  await f.engine.resolution.launch(f.current(),'revision');
  assert.equal(f.current().replacementProfile?.profileId,'chosen','the approved pick is armed');
  (f.engine as unknown as {launchAgent:()=>Promise<void>}).launchAgent=async()=>{};
  await (f.engine as unknown as {recoverExhaustedWorkers:()=>Promise<void>}).recoverExhaustedWorkers();
  assert.equal(f.current().profile!.id,'chosen','the replacement takes the operator\'s pick');
 }finally{await f.close()}
});
async function reportAuthorBlocked(f:ReturnType<typeof fixture>,run:Run,status:'blocked'|'error',summary:string,impediment?:string){
 f.idle(run.agentId!,run.workspaceId);
 f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:run.id,status,summary,head:run.head,...(impediment?{impediment}:{})},f.tokens.get(run.id)!);
 await f.engine.wake();
}
/** A reviewer verdict the reapplied path can publish, like a production forge adapter. */
async function reportReviewFinding(f:ReturnType<typeof fixture>,summary:string){
 const r=f.run();
 f.adapter.publishReview=async()=>77;
 f.idle(r.agentId!,r.workspaceId);
 f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:r.id,status:'changes_required',summary,head:r.head,
  reviewCommentId:1,reviewResponsibility:'author' as const,reviewText:summary},f.tokens.get(r.id)!);
 await f.engine.wake();
}
function realGitRepo(){
 const repo=mkdtempSync(join(tmpdir(),'ns-unfinished-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','Queue test');git('config','user.email','queue-test@example.test');
 writeFileSync(join(repo,'README.md'),'base\n');git('add','README.md');git('commit','-m','base');
 return {repo,git,baseHead:git('rev-parse','HEAD')};
}
test('an unfinished revision return with new commits continues the same round without consuming the budget',async()=>{
 const f=fixture();const source=realGitRepo();
 try{
  f.store.update(f.task.id,{responsible:true,directory:source.repo});
  await f.engine.wake();await reportReviewFinding(f,'Fix the defect');await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.equal(f.current().resolution.revisionRuns,1);
  assert.equal(f.run().revisionCause,'review');
  f.store.putRun({...f.run(),head:source.baseHead});
  // First unfinished return with progress: the project-c#240 shape.
  writeFileSync(join(source.repo,'wrapper.ts'),'partial\n');source.git('add','wrapper.ts');source.git('commit','-m','partial wrapper');
  const head1=source.git('rev-parse','HEAD');
  await reportAuthorBlocked(f,f.run(),'error','Error: implementation remains unfinished; the wrapper is in but the full inventory is still unwritten');
  assert.equal(f.current().phase,'changes_requested');
  assert.equal(f.run().revisionCause,'unfinished');
  const recorded=f.store.eventsAll(f.task.id).filter(event=>event.kind==='unfinished_continuation');
  assert.equal(recorded.length,1);
  assert.equal((JSON.parse(recorded[0]!.detail) as {observedHead:string}).observedHead,head1);
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='non_delivery').length,0);
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.equal(f.run().revisionCause,'unfinished');
  assert.equal(f.current().resolution.revisionRuns,1,'an unfinished continuation consumes no review round');
  // Repeated progress keeps continuing on the same terms.
  f.store.putRun({...f.run(),head:head1});
  writeFileSync(join(source.repo,'inventory.ts'),'more\n');source.git('add','inventory.ts');source.git('commit','-m','partial inventory');
  const head2=source.git('rev-parse','HEAD');
  await reportAuthorBlocked(f,f.run(),'error','Error: still unfinished; the inventory is partial');
  assert.equal(f.current().phase,'changes_requested');
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.equal(f.run().revisionCause,'unfinished');
  assert.equal(f.current().resolution.revisionRuns,1);
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='unfinished_continuation').length,2);
  // No progress on the next return: the #575 no-change path owns it.
  f.store.putRun({...f.run(),head:head2});
  await reportAuthorBlocked(f,f.run(),'blocked','No external blocker and no change','npm ci exited 1: registry unreachable');
  assert.equal(f.current().phase,'changes_requested');
  assert.equal(f.run().revisionCause,'non_delivery');
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.equal(f.run().revisionCause,'non_delivery');
  assert.equal(f.current().resolution.revisionRuns,1);
  // Still no progress: the second consecutive non-delivery arms the provider switch.
  f.store.putRun({...f.run(),head:head2});
  await reportAuthorBlocked(f,f.run(),'blocked','No external blocker and no change','npm ci exited 1: registry unreachable');
  assert.equal(f.current().resolution.nonDeliveryRoutePending,true);
  assert.ok(f.store.eventsAll(f.task.id).some(event=>event.kind==='non_delivery_provider_routed'));
  assert.equal(f.current().resolution.revisionRuns,1);
 }finally{await f.close();rmSync(source.repo,{recursive:true,force:true})}
});
test('an author return inside an owner-approved round past the count does not park; a new changes_required does',async()=>{
 const f=fixture();try{
  await f.engine.wake();await reportReviewFinding(f,'Fix the defect');await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.equal(f.current().resolution.revisionRuns,1);
  assert.equal(f.run().revisionCause,'review');
  // Five earlier review rounds were already counted; the cap parked once on this review.
  const parkedOn = f.current().resolution.review!.eventId;
  f.store.update(f.task.id,{resolution:{...f.current().resolution,revisionRuns:REVISION_BUDGET,capParkedReviewEventId:parkedOn}});
  f.store.event(f.task.id,'revision_budget_exhausted',`Revision budget exhausted after ${REVISION_BUDGET} review rounds; project owner disposition required`);
  // The revision errors on an external cause: ordinary recovery, not another park.
  await reportAuthorBlocked(f,f.run(),'error','Error: awaiting operator decision on the merge scope');
  assert.equal(f.current().phase,'error');
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='revision_budget_exhausted').length,1);
  // The owner approves the round and the worker resumes inside it.
  f.engine.resolution.retry(f.current(),true,undefined,true);
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  assert.equal(f.run().revisionCause,'review');
  assert.equal(f.current().resolution.revisionRuns,REVISION_BUDGET,'a re-dispatch for the same review is the same round, not a new one');
  // The approved round stays open past the cap: next.outcome is not a fresh owner gate.
  // The revision was dispatched after the cap event; the +1ms pins that order
  // down to clock granularity without outrunning the later park below.
  const capAt=f.store.eventsAll(f.task.id).find(event=>event.kind==='revision_budget_exhausted')!.at;
  f.store.putRun({...f.run(),createdAt:new Date(Date.parse(capAt)+1).toISOString()});
  const open=ownerTaskNext(collectOwnerVerbFacts(f.store,f.current())).outcome;
  assert.equal(open.revision.exhausted,false);
  assert.doesNotMatch(open.decision,/owner's disposition/);
  // Another errored author return inside the open round still does not park.
  await reportAuthorBlocked(f,f.run(),'error','Error: awaiting operator decision on the merge scope');
  assert.equal(f.current().phase,'error');
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='revision_budget_exhausted').length,1);
  // A new changes_required review past the cap parks again.
  f.engine.resolution.retry(f.current(),true,undefined,true);
  await f.engine.wake();
  assert.equal(f.run().role,'revision');
  // The author returns ready at the same head; the reviewer finds a further defect there.
  await f.report('ready_for_review');
  await f.engine.wake();
  assert.equal(f.run().role,'reviewer');
  await reportReviewFinding(f,'A further defect');
  const parked=f.current();
  assert.equal(parked.phase,'needs_attention');
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='revision_budget_exhausted').length,2);
  // Spec 058 slice 17: a responsible task's second cap park escalates to the
  // project planner as a delegated decision instead of the owner disposition.
  assert.match(parked.resolution.stop!.detail,/Waiting with the planner/);
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='planner_escalation').length,2,'each cap park is its own escalation episode');
  const closed=ownerTaskNext(collectOwnerVerbFacts(f.store,parked)).outcome;
  assert.equal(closed.revision.exhausted,true);
  assert.match(closed.decision,/blocker ladder \(Spec 058\) escalates that to the project planner/);
  // The second cap park re-arms the author-control gate from the latest park:
  // another author-control attempt without owner authority refuses again, even
  // though the round between the two parks ran ungated.
  await assert.rejects(
   f.engine.performTaskControl({taskId:f.task.id,version:f.current().version,action:'move',to:'work',reason:'Another author round',caller:'coordinator'}),
   /Exhausted author revision disposition/,
  );
 }finally{await f.close()}
});

test('reported busy reviewer settles and starts the author without a sweep',async(t)=>{
 const f=fixture(false,false,undefined,true);try{
  await f.engine.wake();
  const run=f.run(), token=f.tokens.get(run.id)!;
  const result:Completion={eventId:'direct-review-result',taskId:f.task.id,runId:run.id,status:'changes_required',reviewResponsibility:'author',summary:'Fix the defect',head:run.head,reviewCommentId:1};
  const started=Date.now();
  f.engine.resolution.complete(result,token);
  await f.engine.wakeTask(f.task.id);
  assert.equal(f.store.run(run.id)?.released,false,'an active turn keeps the lease');
  f.idle(run.agentId!,run.workspaceId);
  const deadline=Date.now()+12000;
  while(Date.now()<deadline && f.current().resolution.currentRunId===run.id) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.store.run(run.id)?.released,true);
  assert.equal(f.store.task(f.task.id).resolution.buildOutputCleanups.find(item=>item.runId===run.id)?.state,'complete');
  assert.equal(f.run().role,'revision');
  const events=f.store.eventsAll(f.task.id);
  const report=events.find(event=>event.kind==='run_completion' && event.detail.startsWith('reviewer:'))!;
  const dispatch=events.filter(event=>event.kind==='run_intent').at(-1)!;
  const elapsed=Date.parse(dispatch.at)-Date.parse(report.at);
  t.diagnostic(`report-to-next-dispatch: ${elapsed} ms (task events, production backoff)`);
  assert.ok(elapsed<12000,`report-to-dispatch ${elapsed} ms`);
  assert.ok(Date.now()-started<12000);
 }finally{await f.close()}
});

test('busy reported run has a bounded number of direct observations',async(t)=>{
 const f=fixture(false,false,undefined,true);try{
  await f.engine.wake();const run=f.run(),token=f.tokens.get(run.id)!;
  let observations=0;const observe=f.adapter.observe.bind(f.adapter);
  f.adapter.observe=async id=>{if(id===run.agentId){observations++;await new Promise(resolve=>setTimeout(resolve,15))}return observe(id)};
  const calls:Record<string,number>={};
  const methods=f.adapter as unknown as Record<string,unknown>;
  for(const [name,method] of Object.entries(methods)) if(typeof method==='function') methods[name]=(...args:unknown[])=>{calls[name]=(calls[name]??0)+1;return method.apply(f.adapter,args)};
  f.engine.completionFollowUpDelays=[10,20,30];
  f.engine.resolution.complete({eventId:'busy-review-result',taskId:f.task.id,runId:run.id,status:'changes_required',reviewResponsibility:'author',summary:'Fix',head:run.head,reviewCommentId:1},token);
  await f.engine.wakeTask(f.task.id);
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(f.store.run(run.id)?.released,false);
  assert.equal(observations,4,'one callback observation plus three bounded follow-ups');
  const atBound=JSON.stringify(calls);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(observations,4,'an unchanged busy run does not restart the budget');
  assert.equal(JSON.stringify(calls),atBound,'no adapter method churns after the bound');
  t.diagnostic(`callback and three follow-ups under slow observations: ${JSON.stringify(calls)}`);
 }finally{await f.close()}
});


for (const start of ['working', 'reviewing', 'verifying'] as const) test(`board dispatch hold lets ${start} carry through to done`, async () => {
  const f = fixture(); try {
    if (start === 'working') f.store.update(f.task.id, { phase: 'working' });
    if (start !== 'working') await f.engine.wake();
    if (start === 'verifying') await f.report('ready_to_merge');
    f.store.setMeta('dispatchHeld', true);
    await f.engine.wake();
    if (f.run()?.role === 'reviewer') await f.report('ready_to_merge');
    if (f.run()?.role === 'closeout') await f.report('closed');
    await f.engine.wake();
    assert.equal(f.current().phase, 'done');
    assert.equal(f.counts().merges, 1);
    assert.equal(f.store.getMeta('dispatchHeld'), true);
  } finally { await f.close(); }
});

test('merged sync waits for an index lock and keeps its turn until retry succeeds', async () => {
 const { GitTransientError } = await import('../core/forge/forge-health');
 const f=fixture(); try {
  let calls=0;
  f.adapter.syncMain=async()=>{if(++calls===1)throw new GitTransientError('lock', Error("Unable to create '/repo/.git/index.lock': File exists"));return merged};
  await f.engine.wake();await f.report('ready_to_merge');await f.engine.wake();await f.engine.wake();await f.engine.wake();
  assert.equal(f.current().phase,'syncing');
  assert.equal(f.current().resolution.mergedCommit,merged);
  assert.ok(f.current().resolution.integrationTurn);
  assert.equal(f.current().resolution.attention,false);
  assert.match(f.current().reason,/Retrying at/);
  const episode=f.store.getMeta<any>(`gitTransient:${f.task.id}`);
  f.store.setMeta(`gitTransient:${f.task.id}`,{...episode,retryAt:0});
  await f.engine.wake();
  assert.equal(f.current().resolution.syncedCommit,merged);
  assert.equal(f.counts().merges,1);
 } finally {await f.close()}
});

test('a review HTTP 500 waits and reconciles its recorded publication without a second post', async () => {
 const { GitTransientError } = await import('../core/forge/forge-health');
 const f=fixture();try{
  enableRecovery(f);let posts=0, reads=0;
  f.adapter.publishReview=async(store,task,run,status,text)=>{
   const key=`reviewPublication:${run.id}`;
   if(store.getMeta(key)){reads++;return 77;}
   store.setMeta(key,{hash:digest(reviewPublicationBody(task,run,status,text))});posts++;
   throw new GitTransientError('network', Error('HTTP 500'), true);
  };
  await f.engine.wake();const reviewer=f.run();
  f.engine.resolution.complete({eventId:'http-500-review',taskId:f.task.id,runId:reviewer.id,status:'ready_to_merge',summary:'Accepted',reviewText:'Findings',head:reviewer.head},f.tokens.get(reviewer.id)!);
  f.idle(reviewer.agentId!,reviewer.workspaceId);await f.engine.wake();
  assert.equal(posts,1);assert.equal(f.current().resolution.attention,false);assert.match(f.current().reason,/Retrying at/);
  const episode=f.store.getMeta<any>(`gitTransient:${f.task.id}`);assert.ok(episode);
  f.store.setMeta(`gitTransient:${f.task.id}`,{...episode,retryAt:0});
  await f.engine.wake();
  assert.equal(posts,1);assert.equal(reads,1);assert.equal(f.current().resolution.review?.runId,reviewer.id);
 }finally{await f.close()}
});

for (const shape of ['absent', 'late', 'expired'] as const) test(`publication outage lifecycle: ${shape}`, async () => {
 const {publishFormalReview} = await import('../core/forge/index');
 const f=fixture();try{
  enableRecovery(f);
  const repo=join(f.dir,'forge-repo');mkdirSync(repo);
  execFileSync('git',['init','--initial-branch=main'],{cwd:repo,stdio:'ignore'});
  execFileSync('git',['remote','add','origin','https://github.com/example/repo.git'],{cwd:repo});
  f.store.putRepository({origin:null,path:f.task.repoPath},'agent','fixture',null,{login:'reviewer'});
  let posts=0,lists=0,body='';
  const valid=()=>({id:77,user:{login:'reviewer'},commit_id:head,state:'APPROVED',body});
  f.adapter.publishReview=(store,task,run,status,text)=>publishFormalReview(store,{...task,repoPath:repo},run,status,text,{login:'reviewer'},()=>true,{
   verifyPr:async()=>({url:task.prUrl!,head}),readToken:async()=> 'fixture',runGh:async(_t,endpoint,args)=>{
    if(args.includes('POST')){posts++;body=args.find(arg=>arg.startsWith('body='))!.slice(5);if(posts===1||shape==='expired')throw Error('HTTP 503: unavailable');return valid();}
    if(endpoint.endsWith('/77'))return valid();
    lists++;return shape==='late'?[[valid()]]:[[]];
   }});
  await f.engine.wake();const reviewer=f.run();
  f.engine.resolution.complete({eventId:'outage-review',taskId:f.task.id,runId:reviewer.id,status:'ready_to_merge',summary:'Accepted',reviewText:'Findings',head:reviewer.head},f.tokens.get(reviewer.id)!);
  f.idle(reviewer.agentId!,reviewer.workspaceId);await f.engine.wake();
  const key=`gitTransient:${f.task.id}`,episode=f.store.getMeta<any>(key);assert.ok(episode);
  f.store.setMeta(key,{...episode,retryAt:0,...(shape==='expired'?{startedAt:Date.now()-900001}:{})});
  await f.engine.wake();
  if(shape==='expired')assert.match(f.current().reason,/over 15 minutes/);
  else {assert.equal(f.current().resolution.review?.runId,reviewer.id);assert.equal(f.current().resolution.attention,false);}
  assert.equal(posts,shape==='late'?1:2);assert.ok(lists>=1);
  if(shape!=='expired'){
   assert.equal(f.store.runs(f.task.id).some(run=>run.role==='recovery'),false);
   assert.equal(f.store.eventsAll(f.task.id).filter(item=>item.kind==='planner_escalation').length,0);
  }
 }finally{await f.close()}
});

test('a recovered external merge probe clears its retry episode without a phase change', async () => {
 const { GitTransientError, ForgeOutageError } = await import('../core/forge/forge-health');
 const f=fixture();try{
  let failing=true,probes=0;
  f.adapter.externalMerge=async()=>{probes++;if(failing)throw new ForgeOutageError(new GitTransientError('network',Error('HTTP 503')));return null};
  const probe=()=>f.engine.resolution.recoverExternalMerge(f.current());
  const phase=f.current().phase;
  await probe();
  const key=`gitTransient:${f.task.id}`, first=f.store.getMeta<any>(key);
  assert.ok(first);
  failing=false;await f.engine.resolution.adapter.externalMerge!(f.current());
  assert.deepEqual(f.store.getMeta(key),first,'an early success cannot consume a future retry');
  // Even after the retry is due, another successful read is not evidence that
  // the failed probe recovered.
  const due={...first,retryAt:0,startedAt:Date.now()-901_000};
  f.store.setMeta(key,due);
  await f.engine.resolution.adapter.verifyPr!(f.current(),1);
  assert.deepEqual(f.store.getMeta(key),due);
  failing=false;
  await probe();
  assert.equal(probes,3,'a failed read does not suppress the scheduled retry');
  assert.equal(f.current().phase,phase);
  // #986: clearing an episode deletes its row instead of keeping a null value.
  assert.equal(f.store.getMeta(key),undefined,'a successful read closes the old episode');
  assert.equal(f.store.db.prepare('SELECT 1 FROM meta WHERE key=?').get(key),undefined);
  f.engine.resolution.externalMergeProbeMs=0;failing=true;
  await probe();
  assert.equal(f.current().phase,phase);
  assert.match(f.current().reason,/Retrying at/);
  assert.doesNotMatch(f.current().reason,/over 15 minutes/);
  assert.equal(f.store.getMeta<any>(key)?.attempts,1);
 }finally{await f.close()}
});

/** Task 740: a reported, released reviewer verdict, with every verification held until the test lets that pass go on. */
async function heldVerdict(f:ReturnType<typeof fixture>,status:'changes_required'|'ready_to_merge'='changes_required'){
 await f.engine.wake();const reviewer=f.run();
 let posts=0;f.adapter.publishReview=async()=>({id:77,published:++posts===1});
 const passes:(()=>void)[]=[];let arrived=()=>{};
 f.adapter.verifyReview=()=>new Promise<void>(resolve=>{passes.push(resolve);arrived();});
 f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:reviewer.id,status,...(status==='changes_required'?{reviewResponsibility:'author' as const}:{}),summary:'The verdict',head:reviewer.head,reviewText:'The findings',
  verdicts:[{id:'one',subject:'The subject',verdict:'pass',evidence:'The evidence'}]},f.tokens.get(reviewer.id)!);
 f.idle(reviewer.agentId!,reviewer.workspaceId);
 await f.engine.resolution.observe(null,f.task.id);
 assert.equal(f.store.run(reviewer.id)?.released,true);
 const reached=async(count:number)=>{while(passes.length<count)await new Promise<void>(resolve=>{arrived=resolve;});};
 return {reviewer,passes,reached};
}
function verdictWrites(f:ReturnType<typeof fixture>,runId:string){
 const events=f.store.eventsAll(f.task.id);
 return {version:f.current().version,events:events.length,applied:events.filter(event=>event.kind==='review_result_applied'&&event.detail===runId).length,published:events.filter(event=>event.kind==='review_published').length};
}
for(const status of ['changes_required','ready_to_merge'] as const)test(`two overlapping passes apply one ${status} verdict once`,async()=>{
 const f=fixture();try{
  const {reviewer,passes,reached}=await heldVerdict(f,status);
  const first=f.engine.resolution.advance(f.current()),second=f.engine.resolution.advance(f.current());
  await reached(2);
  passes[0]!();await first;
  const applied=verdictWrites(f,reviewer.id),task=f.current();
  assert.equal(applied.applied,1);assert.equal(applied.published,1,'one publication, one event');
  assert.equal(task.phase,status==='changes_required'?'changes_requested':'verifying');
  passes[1]!();await second;
  assert.deepEqual(verdictWrites(f,reviewer.id),applied,'the losing pass writes nothing');
  assert.deepEqual(f.current().resolution,task.resolution,'the review record and integration turn stand as the first pass left them');
  assert.equal(f.current().resolution.reviews.length,1);
 }finally{await f.close()}
});
test('a run reserved between two applies keeps currentRunId',async()=>{
 const f=fixture();try{
  const {reviewer,passes,reached}=await heldVerdict(f);
  const first=f.engine.resolution.advance(f.current()),second=f.engine.resolution.advance(f.current());
  await reached(2);
  passes[0]!();await first;
  assert.equal(f.current().phase,'changes_requested');
  await f.engine.resolution.advance(f.current());
  const revision=f.run();
  assert.equal(revision.role,'revision','the next run is reserved while the second pass is still in flight');
  const reserved=verdictWrites(f,reviewer.id);
  passes[1]!();await second;
  assert.equal(f.current().resolution.currentRunId,revision.id,'the reserved run stays current');
  assert.deepEqual(verdictWrites(f,reviewer.id),reserved);
  assert.equal(f.store.run(revision.id)?.released,false);
 }finally{await f.close()}
});
test('a restart between two passes applies a verdict once',async()=>{
 const f=fixture();let reopened:Store|null=null;try{
  const {reviewer,passes,reached}=await heldVerdict(f);
  // The outgoing process still holds its pass while the next one applies on its own connection.
  const outgoing=f.engine.resolution.advance(f.current());
  await reached(1);
  reopened=new Store(join(f.dir,'queue.sqlite'));
  const restarted=new Engine(reopened,f.adapter,0,()=>true);restarted.profiles=f.engine.profiles;
  const staleTask=reopened.task(f.task.id),staleRun=reopened.run(reviewer.id)!;
  const incoming=restarted.resolution.advance(staleTask);
  await reached(2);
  passes[1]!();await incoming;
  const applied=verdictWrites(f,reviewer.id);
  assert.equal(applied.applied,1);
  passes[0]!();await outgoing;
  assert.deepEqual(verdictWrites(f,reviewer.id),applied,'the outgoing pass finds the durable record');
  // Nothing in memory carries over: a pass holding what it read before the restart changes nothing either.
  const later=new Engine(reopened,f.adapter,0,()=>true);later.profiles=f.engine.profiles;
  await (later.resolution as unknown as {advanceReviewerResult:(t:Task,run:Run,c:Completion)=>Promise<void>}).advanceReviewerResult(staleTask,staleRun,staleRun.completion!);
  assert.deepEqual(verdictWrites(f,reviewer.id),applied);
  await restarted.stop();await later.stop();
 }finally{reopened?.close();await f.close()}
});
test('a completion follow-up timer firing during a task quantum applies the verdict once',async()=>{
 const f=fixture();try{
  f.engine.completionFollowUpDelays=[50];
  await f.engine.wake();const reviewer=f.run();
  let posts=0;f.adapter.publishReview=async()=>({id:77,published:++posts===1});
  f.engine.resolution.complete({eventId:randomUUID(),taskId:f.task.id,runId:reviewer.id,status:'changes_required',reviewResponsibility:'author',summary:'The verdict',head:reviewer.head,reviewText:'The findings'},f.tokens.get(reviewer.id)!);
  // The thread is still ending its turn, so this quantum arms the follow-up and leaves the run.
  await f.engine.wakeTask(f.task.id);
  assert.equal(f.store.run(reviewer.id)?.released,false);
  // The turn ends and the verdict's slow verification outlasts the timer.
  let verifications=0,both=()=>{};const together=new Promise<void>(resolve=>{both=resolve;});
  f.adapter.verifyReview=async()=>{if(++verifications===2)both();await Promise.race([together,new Promise(resolve=>setTimeout(resolve,400))]);};
  f.idle(reviewer.agentId!,reviewer.workspaceId);
  await f.engine.wakeTask(f.task.id);
  await new Promise(resolve=>setTimeout(resolve,100));await f.engine.quiesce();
  assert.equal(verdictWrites(f,reviewer.id).applied,1);
  assert.equal(verdictWrites(f,reviewer.id).published,1);
 }finally{await f.close()}
});
test('two concurrent launchers make one createAgent: one engine joins its creation, a second engine yields at the durable gate',async()=>{
 const f=fixture();const second=new Engine(f.store,f.adapter,0,()=>true);second.profiles=f.engine.profiles;try{
  const worker=f.engine.profiles[0]!;
  // Hold both engines' launchers at workspace verification, before the run identity
  // is claimed, so each has passed its pre-creation checks when the other claims.
  let release!:()=>void,reached!:()=>void,verifies=0;
  const held=new Promise<void>(resolve=>{release=resolve}),bothReached=new Promise<void>(resolve=>{reached=resolve});
  f.adapter.verifyWorkspace=async t=>{if(++verifies===2)reached();await held;return t.branch};
  const creates:string[]=[];
  f.adapter.createAgent=async t=>{creates.push(t.runId!);const id=`agent-${t.runId}`;f.states.set(id,{id,workspaceId:t.workspaceId!,status:'running',active:true,permissions:false,error:''});return{id,workspaceId:t.workspaceId}};
  const prepared=f.store.update(f.task.id,{phase:'dispatching',agentIntent:false,agentId:null,runId:null,restartRunId:null,retiredWorkers:[],continuesWorkspace:false,profile:worker,profileGroup:'author'});
  const launch=(engine:Engine)=>(engine as unknown as {launchAgent(t:Task):Promise<void>}).launchAgent(prepared);
  const launches=[launch(f.engine),launch(f.engine),launch(second)];
  await bothReached;
  assert.equal(verifies,2,'the same engine joins its in-flight creation; the second engine runs its own launcher');
  release();
  await Promise.all(launches);
  const current=f.current();
  assert.equal(creates.length,1);
  assert.equal(current.runId,creates[0]);
  assert.equal(current.agentId,`agent-${creates[0]}`);
  assert.equal(current.phase,'working');
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='agent_intent').length,1);
  assert.equal(f.store.events(f.task.id).filter(event=>event.kind==='agent_created').length,1);
  assert.equal(Number((f.store.db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE run=?').get(current.runId) as {n:number}).n),1);
 }finally{await second.stop();await f.close()}
});

test('overlapping revision applications cannot clear the next run', async () => {
 for (const secondRefused of [false,true]) {
 const f=fixture();try {
  const runId='overlapping-revision', at=new Date().toISOString();
  const completion:Completion={eventId:'revision-overlap',taskId:f.task.id,runId,status:'ready_for_review',summary:'Ready',prNumber:1,head};
  const run:Run={id:runId,taskId:f.task.id,role:'revision',generation:1,head,base,agentId:'worker',workspaceId:'workspace',profile:f.current().profile,profileGroup:null,status:'finished',createdAt:at,lastObservedAt:at,active:false,idleSince:null,completion,released:true};
  f.store.putRun(run);
  const before=f.store.update(f.task.id,{phase:'changes_requested',resolution:{...f.current().resolution,currentRunId:runId}});
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve});
  let calls=0; f.adapter.verifyPr=async()=>{ const call=++calls; if(call===1)await gate; if(call===1||secondRefused)throw Error('Worker must leave a clean worktree before review'); return {head,url:f.task.prUrl!}; };
  const first=f.engine.resolution.resultApplication.advanceRevisionResult(before,run,completion);
  await f.engine.resolution.resultApplication.advanceRevisionResult(before,run,completion);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,currentRunId:'new-review'}});
  release(); await first;
  assert.equal(f.current().resolution.currentRunId,'new-review');
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='run_result_applied'&&event.detail===runId).length,1);
 }finally{await f.close()}
 }
});

test('overlapping closeout results preserve a later run', async () => {
 const f=fixture();try {
  const runId='overlapping-closeout', at=new Date().toISOString();
  const completion:Completion={eventId:'closeout-overlap',taskId:f.task.id,runId,status:'closed',summary:'Closed',head};
  const run:Run={id:runId,taskId:f.task.id,role:'closeout',generation:f.current().coordinatorGeneration,head,base,agentId:'coordinator',workspaceId:'workspace',profile:f.current().profile,profileGroup:null,status:'finished',createdAt:at,lastObservedAt:at,active:false,idleSince:null,completion,released:true};
  f.store.putRun(run);
  const before=f.store.update(f.task.id,{phase:'closing',resolution:{...f.current().resolution,currentRunId:runId}});
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve});
  let calls=0; f.adapter.verifyCloseout=async()=>{const call=++calls;if(call===1){await gate;throw Error('late verification failure')}return undefined};
  const first=f.engine.resolution.closeout.advanceCloseoutResult(before,run,completion);
  await f.engine.resolution.closeout.advanceCloseoutResult(before,run,completion);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,currentRunId:'new-run'}});
  release();await first;
  assert.equal(f.current().resolution.currentRunId,'new-run');
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='run_result_applied'&&event.detail===runId).length,1);
 }finally{await f.close()}
});

test('overlapping blocked results do not clear the successor run', async () => {
 const f=fixture();try {
  const runId='blocked-overlap', at=new Date().toISOString();
  const completion:Completion={eventId:'blocked-overlap-result',taskId:f.task.id,runId,status:'blocked',summary:'External dependency',cause:{kind:'external',name:'dependency'}};
  const run:Run={id:runId,taskId:f.task.id,role:'revision',generation:1,head,base,agentId:'worker',workspaceId:'workspace',profile:f.current().profile,profileGroup:null,status:'finished',createdAt:at,lastObservedAt:at,active:false,idleSince:null,completion,released:true};
  f.store.putRun(run);
  const before=f.store.update(f.task.id,{phase:'changes_requested',resolution:{...f.current().resolution,currentRunId:runId}});
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve});
  let calls=0; f.engine.hooks.emit=async()=>{if(++calls===1)await gate;return {hold:false,attention:false,records:[]}};
  const first=f.engine.resolution.resultApplication.advanceCompletedRun(before,run);
  await f.engine.resolution.resultApplication.advanceCompletedRun(before,run);
  f.store.update(f.task.id,{resolution:{...f.current().resolution,currentRunId:'new-run'}});
  release();await first;
  assert.equal(f.current().resolution.currentRunId,'new-run');
  assert.equal(f.store.eventsAll(f.task.id).filter(event=>event.kind==='run_result_applied'&&event.detail===runId).length,1);
 }finally{await f.close()}
});
