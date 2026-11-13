import { fakeAdapter } from './support/fakes';
import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {resolutionSchema,reviewEntryInputSchema,submissionSchema,taskSchema,type Profile,type Run,type Task} from "../shared/contracts";
import {CURRENT_SCHEMA,Store,digest,now,operationInputHash} from "../core/store/store";
import {assertReviewEntryUnowned,bindReviewEntry,previewReviewEntry,reconcileReviewEntryOperation,reviewEntryInputForTask,reviewEntryReconciliations,verifyReviewEntry,type ReviewEntryAdapter} from "../core/review/review-entry";
import {briefDigest} from "../core/planning/brief";
import {taskPrNumber} from "../core/forge/index";
import {Engine} from "../core/engine";
import {PaseoAdapter,type Adapter,type AgentObservation} from "../service/paseo-composition";
import type {ResolutionAdapter} from "../core/resolution";
import {queueOperationSchema} from "../shared/operations";
import {base,head,operationId,submission,input,record,runGit,exactProofFixture,queueHeldBriefFixture,approveBrief,heldReviewEntry,hostedOrigin,ownerRevisionFixture,ownedRevisableTask} from './support/review-entry-fixture';


test('review-entry input is strict, normalizes declared models and forbids review bypass',()=>{
  assert.deepEqual(input().authorDeclaration.models,['openai/gpt-5']);
  assert.throws(()=>reviewEntryInputSchema.parse({...input(),authorDeclaration:{...input().authorDeclaration,models:['default']}}),/concrete provider\/model/);
  assert.throws(()=>reviewEntryInputSchema.parse({...input(),submission:{...submission(),skipPRReview:true}}),/independent PR review/);
  assert.throws(()=>reviewEntryInputSchema.parse({...input(),unexpected:true}),/unrecognized/i);
});

test('preview classifies a pending permission request as a busy workspace, not repository permission failure',async()=>{
  const store=new Store(':memory:'),adapter:ReviewEntryAdapter={hostId:'host',inspectReviewEntry:async()=>({directory:'/unused',originWorkspaceId:'origin-workspace',busyReason:'Workspace has an active turn or pending permission request'}),originAgent:async()=>null};
  try{const result=await previewReviewEntry(store,adapter,input());assert.equal(result.eligible,false);assert.equal(result.refusals[0]?.code,'workspace_busy');}
  finally{store.close();}
});

test('review-entry admission waits for an active origin author turn',async()=>{
  const {PaseoAdapter}=await import('../service/paseo-composition');
  const adapter=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
  Object.defineProperty(adapter,'api',{value:{workspaces:{ref:()=>({directory:'/repo',refresh:async()=>{},current:()=>({projectRootPath:'/repo'})})},agents:{list:async()=>({entries:[],pageInfo:{hasMore:false}})}}});
  Object.defineProperty(adapter,'originAgent',{value:async(id:string)=>({id,workspaceId:'origin-workspace',title:'Origin',archived:false})});
  Object.defineProperty(adapter,'observe',{value:async(id:string)=>({id,workspaceId:'origin-workspace',status:'running',active:true,permissions:false,error:''})});
  const inspected=await adapter.inspectReviewEntry(input());
  assert.match(inspected.busyReason,/Origin author thread origin still has an active or uncertain turn/);
});

test('review-entry inspection names the source writer whichever workspace it is active in',async()=>{
  const {PaseoAdapter}=await import('../service/paseo-composition');
  const build=(entries:unknown[],originActive:boolean)=>{
    const adapter=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
    Object.defineProperty(adapter,'api',{value:{workspaces:{ref:()=>({directory:'/repo',refresh:async()=>{},current:()=>({projectRootPath:'/repo'})})},agents:{list:async()=>({entries,pageInfo:{hasMore:false}})}}});
    Object.defineProperty(adapter,'originAgent',{value:async(id:string)=>({id,workspaceId:'origin-workspace',title:'Origin',archived:false})});
    Object.defineProperty(adapter,'observe',{value:async(id:string)=>({id,workspaceId:'origin-workspace',status:originActive?'running':'idle',active:originActive,permissions:false,error:''})});
    return adapter;
  };
  // The origin author is the thread working in the selected source workspace.
  const attached=build([{agent:{id:'origin',workspaceId:'workspace',archivedAt:null,activeTurn:'turn-1',pendingPermissions:[],status:'running',labels:{}}}],true);
  const attachedInspection=await attached.inspectReviewEntry(input());
  assert.match(attachedInspection.busyReason,/Origin author thread origin still has an active or uncertain turn/);
  assert.equal(attachedInspection.busyTransient,true);
  // Another active thread in that workspace is still a transient wait, named as the workspace's.
  const foreign=build([{agent:{id:'helper',workspaceId:'workspace',archivedAt:null,activeTurn:'turn-2',pendingPermissions:[],status:'running',labels:{}}}],false);
  const foreignInspection=await foreign.inspectReviewEntry(input());
  assert.equal(foreignInspection.busyReason,'Workspace has an active turn or permission request');
  assert.equal(foreignInspection.busyTransient,true);
  // A foreign Queue ownership label is not activity: it stays a hard conflict.
  const owned=build([{agent:{id:'helper',workspaceId:'workspace',archivedAt:null,activeTurn:null,pendingPermissions:[],status:'idle',labels:{'nucleus.task':'another-task'}}}],false);
  const ownedInspection=await owned.inspectReviewEntry(input());
  assert.equal(ownedInspection.busyReason,'Workspace already has Queue ownership labels');
  assert.equal(ownedInspection.busyTransient,false);
});

test('review-entry admission ignores an idle origin question but still waits for tool approval',async()=>{
  const {PaseoAdapter}=await import('../service/paseo-composition');
  const inspect=async(kind:string)=>{
    const adapter=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
    const request={id:'request',kind};
    Object.defineProperty(adapter,'api',{value:{workspaces:{ref:()=>({directory:'/repo',refresh:async()=>{},current:()=>({projectRootPath:'/repo'})})},agents:{list:async()=>({entries:[{agent:{id:'origin',workspaceId:'workspace',archivedAt:null,activeTurn:null,pendingPermissions:[request],status:'idle',labels:{}}}],pageInfo:{hasMore:false}})}}});
    Object.defineProperty(adapter,'originAgent',{value:async(id:string)=>({id,workspaceId:'origin-workspace',title:'Origin',archived:false})});
    Object.defineProperty(adapter,'observe',{value:async(id:string)=>({id,workspaceId:'origin-workspace',status:'idle',active:false,permissions:true,pendingPermissionKinds:[kind],error:''})});
    return adapter.inspectReviewEntry(input());
  };
  const question=await inspect('question');
  assert.equal(question.busyReason,'');
  const approval=await inspect('tool');
  assert.match(approval.busyReason,/Origin author thread origin still has an active or uncertain turn/);
});

test('legacy task adoption data is stripped while the task remains readable',()=>{
  const fixture=exactProofFixture();
  try{
    const store=new Store(join(fixture.root,'legacy.sqlite'));
    try{
      const task=store.insert({...fixture.reviewInput.submission,submissionId:'legacy-task',title:'Legacy task'},'host','fixture handoff',fixture.planningCommit);
      const parsed=taskSchema.parse({...task,adoption:{inputHash:'old',state:'working',summary:'old worker',authority:'old',delivery:'delivered'}});
      assert.equal(parsed.id,task.id);
      assert.equal('adoption' in parsed,false);
    }finally{store.close()}
  }finally{rmSync(fixture.root,{recursive:true,force:true})}
});

test('Spec 021 #5 review entry assigns a number atomically with task and operation',async()=>{
  const fixture=exactProofFixture(),store=new Store(join(fixture.root,'queue.sqlite'));
  const operation=queueOperationSchema.parse({id:operationId,key:'review-entry-proof',kind:'review_entry',inputHash:'d'.repeat(64),state:'running',taskId:null,expectedVersion:null,repoPath:fixture.repo,submissionId:'proof-fixture',createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
  try{
    const proof=await verifyReviewEntry(fixture.reviewInput,fixture.adapter);assert.equal(proof.head,fixture.expectedHead);assert.equal(proof.base,fixture.planningCommit);
    const task=await bindReviewEntry(store,fixture.adapter,operation,fixture.reviewInput);
    assert.equal(task.responsible,true,'a review entry without the flag is responsible');
    assert.equal(task.entrypoint,'review');assert.equal(task.reviewEntry?.operationId,operationId);assert.equal(task.agentId,null);assert.equal(store.operation(operationId)?.taskId,task.id);
    assert.equal(task.number,1);assert.equal(store.operation(operationId)?.result?.reference,task.reference);
  }finally{store.close();rmSync(fixture.root,{recursive:true,force:true});}
});

test('Queue-approved brief binds in an isolated workspace; shared canonical mode refuses before inspection or binding',async()=>{
  const fixture=queueHeldBriefFixture(),store=new Store(join(fixture.root,'queue.sqlite'));
  approveBrief(store,fixture);
  const operation=queueOperationSchema.parse({id:operationId,key:'brief-review',kind:'review_entry',inputHash:'f'.repeat(64),state:'running',taskId:null,expectedVersion:null,repoPath:fixture.repo,submissionId:'brief-review',createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
  try{
    const branchBefore=runGit(fixture.repo,'branch','--show-current'),workspaceHead=runGit(fixture.workspace,'rev-parse','HEAD');
    const sharedRefusal=await previewReviewEntry(store,fixture.adapter,fixture.reviewInput);
    assert.equal(sharedRefusal.eligible,false);assert.equal(sharedRefusal.refusals[0]?.code,'exclusive_writer_unavailable');
    await assert.rejects(verifyReviewEntry(fixture.reviewInput,fixture.adapter),/Shared-canonical review intake is unsupported/);
    await assert.rejects(bindReviewEntry(store,fixture.adapter,operation,fixture.reviewInput),/Shared-canonical review intake is unsupported/);
    assert.equal(fixture.inspections,0);assert.equal(fixture.githubCalls,0);assert.equal(store.tasks().length,0);
    assert.equal(store.lead('approved-review-brief').state,'open');assert.equal(runGit(fixture.repo,'branch','--show-current'),branchBefore);
    assert.equal(runGit(fixture.workspace,'rev-parse','HEAD'),workspaceHead);assert.equal(runGit(fixture.workspace,'status','--porcelain'),'');

    const isolated=reviewEntryInputSchema.parse({...fixture.reviewInput,workspaceMode:'isolated'});
    const preview=await previewReviewEntry(store,fixture.adapter,isolated);
    assert.equal(preview.eligible,true);assert.equal(preview.resolved?.workspaceMode,'isolated');assert.equal(preview.resolved?.briefDigest,fixture.approval.digest);assert.equal(preview.resolved?.briefVersion,1);
    const tampered=reviewEntryInputSchema.parse({...isolated,submission:{...isolated.submission,brief:{...isolated.submission.brief!,text:'tampered Queue brief\n',digest:briefDigest('tampered Queue brief\n')}}});
    const tamperedRefusal=await previewReviewEntry(store,fixture.adapter,tampered);
    assert.equal(tamperedRefusal.eligible,false);assert.equal(tamperedRefusal.refusals[0]?.code,'planning_invalid');assert.equal(store.tasks().length,0);
    const task=await bindReviewEntry(store,fixture.adapter,operation,isolated);
    assert.equal(task.responsible,true,'a brief review entry without the flag is responsible');
    assert.equal(task.directory,fixture.workspace);assert.equal(task.reviewEntry?.workspaceMode,'isolated');assert.equal(task.reviewEntry?.preserveWorkspace,true);assert.equal(task.reviewEntry?.briefDigest,fixture.approval.digest);assert.equal(task.reviewEntry?.briefVersion,1);
    assert.equal(task.agentId,null);assert.equal(task.completion,null);assert.equal(task.handoffText,fixture.briefText);
    assert.equal(store.lead('approved-review-brief').state,'promoted');assert.equal(store.lead('approved-review-brief').targets[0]?.reference,task.id);
    assert.equal(existsSync(join(fixture.repo,'docs','handoffs')),false);
    const updater=join(fixture.root,'base-advance');execFileSync('git',['clone','--branch','main',hostedOrigin(fixture.root),updater],{stdio:'ignore'});
    runGit(updater,'config','user.name','Queue Fixture');runGit(updater,'config','user.email','queue@example.test');writeFileSync(join(updater,'README.md'),'base advanced\n');
    runGit(updater,'add','README.md');runGit(updater,'commit','-m','advance main');runGit(updater,'push','origin','main');
    const advanced=runGit(updater,'rev-parse','HEAD');runGit(fixture.repo,'pull','--ff-only','origin','main');rmSync(updater,{recursive:true,force:true});
    const proof=await verifyReviewEntry(reviewEntryInputForTask(task),fixture.adapter,{allowBaseAdvance:true,taskId:task.id});
    assert.equal(proof.base,advanced);assert.equal(runGit(fixture.repo,'branch','--show-current'),'main');
    assert.equal(runGit(fixture.workspace,'branch','--show-current'),'feature/external');assert.equal(runGit(fixture.workspace,'rev-parse','HEAD'),fixture.expectedHead);
  }finally{store.close();rmSync(fixture.root,{recursive:true,force:true});}
});

test('Queue-held brief preview allows a PR predating planning while a handoff still requires head ancestry',async()=>{
  const brief=queueHeldBriefFixture(),briefStore=new Store(join(brief.root,'brief.sqlite'));
  approveBrief(briefStore,brief);
  try{
    writeFileSync(join(brief.repo,'README.md'),'current main advanced\n');
    runGit(brief.repo,'add','README.md');runGit(brief.repo,'commit','-m','advance planning main');
    const currentMain=runGit(brief.repo,'rev-parse','HEAD');runGit(brief.repo,'push','origin','main');
    const briefInput=reviewEntryInputSchema.parse({...brief.reviewInput,workspaceMode:'isolated',expectedBaseCommit:currentMain});
    const preview=await previewReviewEntry(briefStore,brief.adapter,briefInput);
    assert.equal(preview.eligible,true,JSON.stringify(preview.refusals));
    assert.equal(runGit(brief.workspace,'rev-parse','HEAD'),brief.expectedHead);
  }finally{briefStore.close();rmSync(brief.root,{recursive:true,force:true});}

  const handoff=exactProofFixture(),handoffStore=new Store(join(handoff.root,'handoff.sqlite'));
  try{
    writeFileSync(join(handoff.repo,'README.md'),'current main advanced\n');
    runGit(handoff.repo,'add','README.md');runGit(handoff.repo,'commit','-m','advance planning main');
    const currentMain=runGit(handoff.repo,'rev-parse','HEAD');runGit(handoff.repo,'push','origin','main');
    const handoffInput=reviewEntryInputSchema.parse({...handoff.reviewInput,
      submission:{...handoff.reviewInput.submission,planningCommit:currentMain},expectedBaseCommit:currentMain});
    const preview=await previewReviewEntry(handoffStore,handoff.adapter,handoffInput);
    assert.equal(preview.eligible,false);
    assert.match(preview.refusals[0]?.explanation??'',/reviewed head does not descend from the planning commit/);
  }finally{handoffStore.close();rmSync(handoff.root,{recursive:true,force:true});}
});

test('review admission rechecks dependencies after the awaited pre-dispatch hook',async()=>{
  const fixture=exactProofFixture(),store=new Store(join(fixture.root,'queue.sqlite'));
  const parent=store.insert(submissionSchema.parse({...fixture.reviewInput.submission,submissionId:'proof-parent',title:'Proof parent',dependsOn:[]}), 'host','fixture handoff',fixture.planningCommit,{phase:'done'});
  const reviewInput=reviewEntryInputSchema.parse({...fixture.reviewInput,submission:{...fixture.reviewInput.submission,dependsOn:[parent.id]}});
  const operation=queueOperationSchema.parse({id:operationId,key:'dependency-race',kind:'review_entry',inputHash:'e'.repeat(64),state:'running',taskId:null,expectedVersion:null,repoPath:fixture.repo,submissionId:'proof-fixture',createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
  const reviewer:Profile={id:'reviewer',name:'Reviewer',provider:'codex',model:'gpt-6-luna',notes:'',available:true,problem:'',supportedThinking:[]};
  store.setMeta('paused',false);store.setMeta('pool',[{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']}]);
  const engine=new Engine(store,fixture.adapter as Adapter&ReviewEntryAdapter,0);engine.profiles=[reviewer];
  try{
    const task=await bindReviewEntry(store,fixture.adapter,operation,reviewInput);
    (engine.hooks as unknown as {emit:()=>Promise<{hold:boolean}>}).emit=async()=>{store.update(parent.id,{phase:'queued'});return{hold:false};};
    await (engine as unknown as {dispatchReviewEntry(task:Task):Promise<void>}).dispatchReviewEntry(task);
    const current=store.task(task.id);assert.equal(current.phase,'queued');assert.match(store.dependencyWait(current),/Waiting for prerequisites/);assert.equal(current.reviewEntry?.dispatchBase,null);
  }finally{await engine.stop();store.close();rmSync(fixture.root,{recursive:true,force:true});}
});

test('review-entry operation identity is derived from its nested submission and contradictory envelope fields refuse before acceptance',async()=>{
  const store=new Store(':memory:'),adapter={} as Adapter;
  store.setMeta('hostId','host');
  const engine=new Engine(store,adapter,0);
  try{
    const payload={type:'review_entry',input:input()} as const;
    await assert.rejects(engine.startOperation({key:'wrong-repo',kind:'review_entry',payload,repoPath:'/other'}),/repoPath does not match/);
    await assert.rejects(engine.startOperation({key:'wrong-submission',kind:'review_entry',payload,submissionId:'other'}),/submissionId does not match/);
    const accepted=await engine.startOperation({key:'derived-identity',kind:'review_entry',payload});
    assert.ok('accepted' in accepted);if(!('accepted' in accepted))return;
    assert.equal(accepted.operation.repoPath,'/repo');assert.equal(accepted.operation.submissionId,'external-pr');
  }finally{await engine.stop();store.close();}
});

test('review-entry ownership excludes retained workspace, branch and PR identities',()=>{
  const store=new Store(':memory:');
  try{
    const task=store.insert(submission(),'host','handoff',base,{entrypoint:'review',reviewEntry:record(),workspaceId:'workspace',directory:'/worktree',branch:'feature/external',workspaceIntent:true,resumePrNumber:41,prHead:head,prUrl:'https://github.com/example/repo/pull/41'});
    assert.throws(()=>assertReviewEntryUnowned(store,input()),/Workspace already belongs/);
    assert.doesNotThrow(()=>assertReviewEntryUnowned(store,input(),task.id));
    assert.equal(store.getMeta('schema'), CURRENT_SCHEMA);
  }finally{store.close();}
});

test('review entry supplies PR identity without fabricating worker completion',()=>{
  const store=new Store(':memory:');
  try{
    const task=store.insert(submission(),'host','handoff',base,{entrypoint:'review',reviewEntry:record(),workspaceId:'workspace',directory:'/worktree',branch:'feature/external',workspaceIntent:true,resumePrNumber:null,completion:null,prHead:head,prUrl:'https://github.com/example/repo/pull/41'});
    assert.equal(taskPrNumber(task),41);assert.equal(task.agentId,null);assert.equal(task.profile,null);assert.equal(task.completion,null);
  }finally{store.close();}
});

test('a changed workerless review-entry head routes through the task-workspace revision worker',async()=>{
  const fixture=ownerRevisionFixture();
  try{
    const {task,engine,store}=await ownedRevisableTask(fixture,{acceptedReview:true});
    fixture.pushRevision('external head moved');
    const before=store.task(task.id);
    await assert.rejects(engine.performTaskControl({taskId:task.id,version:before.version,action:'move',to:'review',
      reason:'Review the new PR head'}),/use move to=work to start the revision worker in the task workspace/);
    assert.equal(store.task(task.id).prHead,fixture.oldHead,'the refused move leaves the recorded head unchanged');
    assert.equal(store.eventsAll(task.id).some(event=>event.kind==='external_owner_revision'),false);
    assert.equal(fixture.creates.length,0,'the refused review move creates no reader or worker');
    await engine.stop();
  }finally{fixture.close();}
});

test('legacy owner-revision task rows and events remain readable',()=>{
  const store=new Store(':memory:');
  try{
    const task=store.insert(submission(),'host','handoff',base,{entrypoint:'review',reviewEntry:record(),workspaceId:'workspace',directory:'/worktree',branch:'feature/external',workspaceIntent:true,resumePrNumber:null,completion:null,prHead:head,prUrl:'https://github.com/example/repo/pull/41'});
    const receipt={at:now(),operationId:null,actor:{agentId:'owner-thread',role:'project_owner' as const},authorization:{kind:'project_owner' as const,note:null},reason:'legacy revision',
      previousHead:base,head,task:{id:task.id,prNumber:41,repository:'example/repo',branch:'feature/external',workspaceId:'workspace',directory:'/worktree'},
      brief:{digest:null,version:null},authorDeclaration:{models:['openai/gpt-5'],githubAuthor:'external-author',authoringSystem:'external-agent',attestedBy:'operator',provenance:'fixture'},
      fence:null,proof:{localHead:head,pushedHead:head,prHead:head,prUrl:'https://github.com/example/repo/pull/41',base}};
    store.update(task.id,{resolution:resolutionSchema.parse({externalOwnerRevisions:[receipt]})});
    store.event(task.id,'external_owner_revision',JSON.stringify(receipt));
    assert.equal(store.task(task.id).resolution.externalOwnerRevisions?.[0]?.head,head);
    assert.ok(store.eventsAll(task.id).some(event=>event.kind==='external_owner_revision'));
  }finally{store.close();}
});

test('changes requested creates the first worker in the retained workspace and records its real identity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ns-review-entry-')),store=new Store(join(dir,'queue.sqlite'));
  const worker:Profile={id:'worker',name:'Worker',provider:'codex',model:'gpt-6.1-terra',notes:'',available:true,problem:'',supportedThinking:[]};
  const reviewer:Profile={id:'reviewer',name:'Reviewer',provider:'codex',model:'gpt-6-luna',notes:'',available:true,problem:'',supportedThinking:[]};
  store.setMeta('paused',false);store.setMeta('pool',[{profileId:'worker',enabled:true,group:'workers',roles:['worker'],weight:1,scopes:['general']},{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']}]);
  const inserted=store.insert(submission(),'host','handoff',base,{entrypoint:'review',reviewEntry:record(),phase:'changes_requested',reason:'Fix review findings',workspaceId:'workspace',directory:'/worktree',branch:'feature/external',workspaceIntent:true,prHead:head,prUrl:'https://github.com/example/repo/pull/41',resumePrNumber:41,
    resolution:resolutionSchema.parse({review:{eventId:'review-result',taskId:'placeholder',runId:'review-run',status:'changes_required',summary:'Fix one issue',head,reviewCommentId:9},reviewerAgentId:'review-agent',reviewerProfile:reviewer})});
  const task=store.update(inserted.id,{resolution:{...inserted.resolution,review:{...inserted.resolution.review!,taskId:inserted.id}}});
  const states=new Map<string,AgentObservation>([['review-agent',{id:'review-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''}]]);const creates:Run[]=[];
  const adapter:Adapter&ResolutionAdapter=fakeAdapter({profiles:async()=>[worker,reviewer],validate:async()=>base,createWorkspace:async()=>{throw Error('must preserve workspace')},verifyWorkspace:async()=>task.branch,createAgent:async()=>{throw Error('no initial worker')},observe:async id=>states.get(id)??{id,workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''},verifyPr:async()=>({url:task.prUrl!,head}),
    createRun:async(_task,run)=>{creates.push(run);states.set('first-worker',{id:'first-worker',workspaceId:run.workspaceId,status:'running',active:true,permissions:false,error:''});return{id:'first-worker',workspaceId:run.workspaceId}},sendRun:async()=>{},findRunAgents:async()=>[],verifyReview:async()=>{},mergeGate:async()=>({head,base,wait:''}),merge:async()=>{},merged:async()=>({merged:false,commit:null,head,base:'main'}),syncMain:async()=>base,verifyCloseout:async()=>{},notify:async()=>{}});
  const engine=new Engine(store,adapter,0);engine.profiles=[worker,reviewer];
  try{
    await engine.wake();const current=store.task(task.id),run=store.run(current.resolution.currentRunId!);
    assert.equal(creates.length,1,`revision dispatch should proceed in the task workspace: ${current.phase} · ${current.reason}`);assert.equal(run?.role,'revision');assert.equal(run?.workspaceId,'workspace');
    assert.equal(current.agentId,'first-worker');assert.equal(current.profile?.id,'worker');assert.equal(current.workerModel,'gpt-6.1-terra');
    assert.equal(current.completion,null);assert.equal(current.reviewEntry?.verifiedHead,head);
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a review-entry callback from outside the task workspace cannot gain approval',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ns-review-entry-approval-')),store=new Store(join(dir,'queue.sqlite'));
  const reviewer:Profile={id:'reviewer',name:'Reviewer',provider:'codex',model:'gpt-6-luna',notes:'',available:true,problem:'',supportedThinking:[]};
  store.setMeta('paused',false);store.setMeta('pool',[{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']}]);
  const task=store.insert(submission(),'host','handoff',base,{entrypoint:'review',reviewEntry:record(),phase:'awaiting_review',reason:'Awaiting independent review',workspaceId:'workspace',directory:'/worktree',branch:'feature/external',workspaceIntent:true,prHead:head,prUrl:'https://github.com/example/repo/pull/41',resumePrNumber:41});
  const states=new Map<string,AgentObservation>();const tokens=new Map<string,string>();const creates:Run[]=[];
  const adapter:Adapter&ResolutionAdapter=fakeAdapter({profiles:async()=>[reviewer],validate:async()=>base,createWorkspace:async()=>{throw Error('must preserve workspace')},verifyWorkspace:async()=>task.branch,createAgent:async()=>{throw Error('must not create initial worker')},observe:async id=>states.get(id)??{id,workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''},verifyPr:async()=>({url:task.prUrl!,head}),
    createRun:async(_task,run,token)=>{creates.push(run);tokens.set(run.id,token);states.set('review-agent',{id:'review-agent',workspaceId:'workspace',status:'running',active:true,permissions:false,error:''});return{id:'review-agent',workspaceId:'workspace'}},sendRun:async()=>{},findRunAgents:async()=>[],verifyReview:async()=>{},mergeGate:async()=>({head,base,wait:''}),merge:async()=>{},merged:async()=>({merged:false,commit:null,head,base:'main'}),syncMain:async()=>base,verifyCloseout:async()=>{},notify:async()=>{}});
  const engine=new Engine(store,adapter,0);engine.profiles=[reviewer];
  try{
    // A legacy-shaped run must not bypass the public credit boundary.
    const run:Run={id:'review-run',taskId:task.id,role:'reviewer',generation:1,head,base,agentId:'review-agent',workspaceId:'other-workspace',
      profile:reviewer,status:'running',createdAt:new Date().toISOString(),lastObservedAt:null,active:true,idleSince:null,completion:null,released:false};
    store.putRun(run);store.setCredential(run.id,'review-token');
    tokens.set(run.id,'review-token');
    states.set('review-agent',{id:'review-agent',workspaceId:'other-workspace',status:'running',active:true,permissions:false,error:''});
    store.update(task.id,{phase:'reviewing',resolution:{...store.task(task.id).resolution,currentRunId:run.id,reviewerAgentId:'review-agent',reviewerProfile:reviewer}});
    await engine.wake();
    assert.equal(store.task(task.id).agentId,null);assert.equal(store.task(task.id).completion,null);
    await assert.rejects(engine.complete({eventId:'approved',taskId:task.id,runId:run.id,status:'ready_to_merge',summary:'Approved exact head',head,reviewCommentId:7},tokens.get(run.id)!),/not bound to the task workspace/);
    assert.equal(store.run(run.id)!.completion,null);assert.equal(store.task(task.id).resolution.review,null);
    assert.equal(creates.length,0);
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('intake-owned review workspaces use guarded cleanup; external ownership stays preserved',async()=>{
  const {Lifecycle}=await import('../core/closeout/workspace-lifecycle');
  const {PaseoAdapter}=await import('../service/paseo-composition');
  for(const ownership of ['external','intake'] as const){
    const f=exactProofFixture(),store=new Store(':memory:');let archives=0;
    const intake=reviewEntryInputSchema.parse({...f.reviewInput,workspaceOwnership:ownership});
    const operation=queueOperationSchema.parse({id:operationId,key:'cleanup',kind:'review_entry',inputHash:'d'.repeat(64),state:'running',taskId:null,expectedVersion:null,repoPath:f.repo,submissionId:'proof-fixture',createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
    try{
      const t=await bindReviewEntry(store,f.adapter,operation,intake);
      assert.equal(t.reviewEntry?.preserveWorkspace,ownership==='external');
      store.setMeta('paused',false);
      store.update(t.id,{phase:'done',resolution:{...t.resolution,mergedCommit:head,syncedCommit:head}});
      // Spec 017: a preserved external workspace owes one catalog-only archive
      // pass of its own, so it is a lifecycle candidate too; an intake-owned
      // workspace owes the ordinary Queue-owned teardown.
      assert.equal(store.lifecycleTasks().some(x=>x.id===t.id),true);
      const adapter=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
      Object.defineProperty(adapter,'helperPath',{value:join(f.root,'worker-report.mjs')});
      Object.defineProperty(adapter,'api',{value:{workspaces:{ref:()=>({directory:f.workspace,refresh:async()=>{},current:()=>({projectRootPath:f.repo,worktreeSlug:'external-pr-checkout'}),archive:async()=>{archives++;rmSync(f.workspace,{recursive:true,force:true});return{archivedAt:new Date().toISOString()};}})},agents:{list:async()=>({entries:[],pageInfo:{hasMore:false}})}}});
      const engine=new Engine(store,adapter,0),lifecycle=new Lifecycle(engine);
      if(ownership==='intake'){
        writeFileSync(join(f.workspace,'uncommitted.txt'),'retain me');
        await lifecycle.archive(store.task(t.id));assert.equal(archives,0);
        assert.match(store.task(t.id).resolution.cleanupReason,/uncommitted/);
        rmSync(join(f.workspace,'uncommitted.txt'));
      }
      // The guarded first attempt records a retry backoff; expire it so this pass proves the next archive succeeds once the blocker is gone.
      const pendingRetries=store.task(t.id).resolution.workspaceArchiveRetries;
      if(pendingRetries.length)store.update(t.id,{resolution:{...store.task(t.id).resolution,workspaceArchiveRetries:pendingRetries.map(record=>({...record,nextAttemptAt:new Date(0).toISOString()}))}});
      await lifecycle.archive(store.task(t.id));
      assert.equal(archives,ownership==='intake'?1:0);
      assert.deepEqual(store.task(t.id).resolution.archivedWorkspaceIds,ownership==='intake'?['workspace']:[]);
      await lifecycle.archive(store.task(t.id));assert.equal(archives,ownership==='intake'?1:0);
      // The external entry never uses the Queue-owned teardown, and its own
      // catalog archive is held here because this stub exposes no readable
      // placement: a visible cause, never a success claim.
      const catalog=store.task(t.id).resolution.externalWorkspaceArchives;
      if(ownership==='external'){
        assert.equal(catalog.length,1);
        assert.equal(catalog[0]?.state,'held');
        assert.match(catalog[0]?.detail??'',/recorded directory|placement|catalog/);
        assert.equal(existsSync(f.workspace),true);
      } else assert.deepEqual(catalog,[]);
      assert.equal(store.lifecycleTasks().some(x=>x.id===t.id),ownership==='external');
    }finally{store.close();rmSync(f.root,{recursive:true,force:true});}
  }
});

test('schema 50 upgrade preserves existing review-entry ownership and queue pause',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ns-review-entry-upgrade-')),file=join(dir,'queue.sqlite');
  let store=new Store(file);
  try{
    const task=store.insert(submission(),'host','handoff',base,{entrypoint:'review',reviewEntry:record()});
    store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    store.setMeta('paused',true);store.setMeta('schema',50);store.close();store=new Store(file);
    assert.equal(store.getMeta('schema'), CURRENT_SCHEMA);assert.equal(store.getMeta('paused'),true);
    assert.deepEqual(store.task(task.id),task);assert.equal(store.task(task.id).reviewEntry?.preserveWorkspace,true);
    assert.equal(input().workspaceOwnership,undefined);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});


test('papercut-tagged approved lead review entry retains its papercut slot class and returned version', async()=>{
  const fixture=queueHeldBriefFixture(),store=new Store(join(fixture.root,'queue.sqlite'));
  try {
    approveBrief(store,fixture,true);
    const operation=queueOperationSchema.parse({id:operationId,key:'papercut-review-entry',kind:'review_entry',inputHash:'d'.repeat(64),state:'running',taskId:null,expectedVersion:null,repoPath:fixture.repo,submissionId:'brief-review',createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
    const task=await bindReviewEntry(store,fixture.adapter,operation,reviewEntryInputSchema.parse({...fixture.reviewInput,workspaceMode:"isolated"}));
    assert.equal(task.papercutTask,true);
    assert.equal(store.task(task.id).papercutTask,true);
    assert.equal(store.operation(operationId)?.result?.taskVersion,task.version);
    assert.equal(task.planningSource?.id,'approved-review-brief');
  }finally{store.close();rmSync(fixture.root,{recursive:true,force:true});}
});

test('a typed pre-binding refusal whose explanation says uncertain settles as a definite failure',async()=>{
  const fixture=exactProofFixture(),store=new Store(join(fixture.root,'queue.sqlite'));
  const adapter:ReviewEntryAdapter={...fixture.adapter,inspectReviewEntry:async()=>({directory:fixture.workspace,originWorkspaceId:'origin-workspace',busyReason:'Origin author thread origin still has an active or uncertain turn'})};
  const engine=new Engine(store,adapter as Adapter&ReviewEntryAdapter,0);
  try{
    store.setMeta('hostId',fixture.adapter.hostId);
    const accepted=await engine.startOperation({key:'uncertain-refusal',kind:'review_entry',payload:{type:'review_entry',input:fixture.reviewInput}});
    assert.ok('accepted' in accepted);if(!('accepted' in accepted))return;
    const settled=await engine.awaitOperation(accepted.operation.id,5000);
    assert.equal(settled.state,'failed');assert.equal(settled.taskId,null);assert.equal(settled.effect,null);
    assert.match(settled.diagnostic,/uncertain turn/);
    assert.equal(store.tasks().length,0);
  }finally{await engine.stop();store.close();rmSync(fixture.root,{recursive:true,force:true});}
});

test('an attention-held pre-binding review entry rearms under its original ID, keeps its first refusal and binds once through admission',async()=>{
  const fixture=exactProofFixture(),path=join(fixture.root,'queue.sqlite');
  let store=new Store(path);
  try{
    const held=heldReviewEntry(store,fixture,'pr268-shaped');
    const reconciled=await reconcileReviewEntryOperation(store,fixture.adapter,held.id,held.inputHash);
    assert.equal(reconciled.reopened,true);assert.equal(reconciled.operation.id,held.id);assert.equal(reconciled.operation.key,held.key);
    assert.equal(reconciled.operation.state,'pending');assert.equal(reconciled.operation.diagnostic,'');
    assert.equal(operationInputHash(store.operationPayload(held.id)),held.inputHash);
    const history=reviewEntryReconciliations(store,held.id);
    assert.equal(history.length,1);assert.equal(history[0]!.diagnostic,held.diagnostic);assert.equal(history[0]!.attempts,1);
    // Lost-response replay: the same call observes the pending operation and appends nothing.
    const replay=await reconcileReviewEntryOperation(store,fixture.adapter,held.id,held.inputHash);
    assert.equal(replay.reopened,false);assert.equal(replay.operation.state,'pending');assert.equal(reviewEntryReconciliations(store,held.id).length,1);
    // Cold reopen keeps the rearmed record and its history.
    store.close();store=new Store(path);
    assert.equal(store.operation(held.id)?.state,'pending');assert.equal(reviewEntryReconciliations(store,held.id).length,1);
    const engine=new Engine(store,fixture.adapter as Adapter&ReviewEntryAdapter,0);
    try{
      engine.scheduleAcceptedOperation(held.id);
      const settled=await engine.awaitOperation(held.id,5000);
      assert.equal(settled.state,'succeeded');assert.equal(settled.id,held.id);
      const task=store.task(settled.taskId!);
      assert.equal(task.entrypoint,'review');assert.equal(task.agentId,null);assert.equal(task.agentIntent,false);assert.equal(task.reviewEntry?.operationId,held.id);
      assert.equal(store.tasks().length,1);
      assert.equal(reviewEntryReconciliations(store,held.id)[0]!.diagnostic,held.diagnostic);
    }finally{await engine.stop();}
  }finally{store.close();rmSync(fixture.root,{recursive:true,force:true});}
});

test('reconciliation refuses changed input, unknown effects, conflicting operations, live origins, moved heads and racing bindings without rearming',async()=>{
  const fixture=exactProofFixture(),store=new Store(join(fixture.root,'queue.sqlite'));
  const held=heldReviewEntry(store,fixture,'refusal-matrix'),current=()=>store.operation(held.id)!;
  try{
    await assert.rejects(reconcileReviewEntryOperation(store,fixture.adapter,held.id,'0'.repeat(64)),/input hash does not match/);
    store.putOperation({...current(),effect:{kind:'task_control',target:'',intentAt:now(),status:'uncertain',result:null,resultAt:null}});
    await assert.rejects(reconcileReviewEntryOperation(store,fixture.adapter,held.id,held.inputHash),/records a task, result or effect/);
    store.putOperation({...current(),effect:null});
    const sibling=heldReviewEntry(store,fixture,'refusal-sibling');
    await assert.rejects(reconcileReviewEntryOperation(store,fixture.adapter,held.id,held.inputHash),/for this submission is needs_attention/);
    store.putOperation({...store.operation(sibling.id)!,state:'failed'});
    const busy:ReviewEntryAdapter={...fixture.adapter,inspectReviewEntry:async()=>({directory:fixture.workspace,originWorkspaceId:'origin-workspace',busyReason:'Origin author thread origin still has an active or uncertain turn'})};
    await assert.rejects(reconcileReviewEntryOperation(store,busy,held.id,held.inputHash),/not eligible for reconciliation.*active or uncertain turn/);
    const movedHead:ReviewEntryAdapter={...fixture.adapter,reviewEntryGithubCommand:async(_file,args)=>args[1].includes('/pulls/')?JSON.stringify({state:'open',merged_at:null,draft:false,head:{repo:{full_name:'example/repo'},ref:'feature/external',sha:'e'.repeat(40)},base:{repo:{full_name:'example/repo'},ref:'main'},user:{login:'external-author'},html_url:'https://github.com/example/repo/pull/41'}):JSON.stringify({permissions:{push:true}})};
    await assert.rejects(reconcileReviewEntryOperation(store,movedHead,held.id,held.inputHash),/not eligible for reconciliation/);
    assert.equal(current().state,'needs_attention');assert.equal(reviewEntryReconciliations(store,held.id).length,0);
    // A sibling operation that starts during the awaited GitHub proof must be caught by the atomic recheck.
    const racing:ReviewEntryAdapter={...fixture.adapter,reviewEntryGithubCommand:async(file,args,cwd)=>{
      const response=await fixture.adapter.reviewEntryGithubCommand!(file,args,cwd);
      if(args[1].includes('/pulls/')&&!store.operationForKey('refusal-racing'))heldReviewEntry(store,fixture,'refusal-racing',{state:'running',settledAt:null,attempts:0,diagnostic:''});
      return response;
    }};
    await assert.rejects(reconcileReviewEntryOperation(store,racing,held.id,held.inputHash),/for this submission is running/);
    assert.equal(current().state,'needs_attention');assert.equal(reviewEntryReconciliations(store,held.id).length,0);
    assert.equal(store.tasks().length,0);
  }finally{store.close();rmSync(fixture.root,{recursive:true,force:true});}
});

test('reconciliation ignores unrelated settled history but refuses an unfinished review entry on the same workspace, branch or PR',async()=>{
  const fixture=exactProofFixture(),store=new Store(join(fixture.root,'queue.sqlite'));
  try{
    const held=heldReviewEntry(store,fixture,'scope-held');
    store.putOperation(queueOperationSchema.parse({id:'f'.repeat(64),key:'unrelated-submit',kind:'submit',inputHash:'a'.repeat(64),state:'succeeded',taskId:'unrelated-task',expectedVersion:null,repoPath:'/unrelated-repo',submissionId:'unrelated-submission',createdAt:now(),startedAt:now(),settledAt:now(),attempts:1,diagnostic:'',result:{taskId:'unrelated-task',number:null,taskVersion:1,phase:'queued',reference:null},effect:null}));
    store.putOperation(queueOperationSchema.parse({id:'9'.repeat(64),key:'unrelated-attention',kind:'task_control',inputHash:'b'.repeat(64),state:'needs_attention',taskId:null,expectedVersion:null,repoPath:fixture.repo,submissionId:null,createdAt:now(),startedAt:null,settledAt:now(),attempts:1,diagnostic:'unrelated',result:null,effect:null}));
    const reconciled=await reconcileReviewEntryOperation(store,fixture.adapter,held.id,held.inputHash);
    assert.equal(reconciled.reopened,true);assert.equal(reconciled.operation.state,'pending');
    store.putOperation({...store.operation(held.id)!,state:'needs_attention',settledAt:now()});
    const pending=store.acceptOperation({key:'pending-identity',kind:'review_entry',inputHash:operationInputHash({type:'review_entry',input:{...fixture.reviewInput,submission:{...fixture.reviewInput.submission,submissionId:'other-pending'}}}),
      submissionId:'other-pending',repoPath:fixture.repo,payload:{type:'review_entry',input:{...fixture.reviewInput,submission:{...fixture.reviewInput.submission,submissionId:'other-pending'}}}});
    assert.ok('accepted' in pending);
    await assert.rejects(reconcileReviewEntryOperation(store,fixture.adapter,held.id,held.inputHash),/holds this workspace, branch or PR; reconciliation refused/);
    assert.equal(store.operation(held.id)?.state,'needs_attention');
  }finally{store.close();rmSync(fixture.root,{recursive:true,force:true});}
});

test('reconciliation refuses a review-entry operation whose branch or PR is already bound to another task',async()=>{
  const fixture=exactProofFixture(),store=new Store(join(fixture.root,'queue.sqlite'));
  try{
    const held=heldReviewEntry(store,fixture,'branch-conflict');
    const owner=queueOperationSchema.parse({id:'e'.repeat(64),key:'branch-owner',kind:'review_entry',inputHash:'d'.repeat(64),state:'running',taskId:null,expectedVersion:null,repoPath:fixture.repo,submissionId:'other-bound',createdAt:now(),startedAt:now(),settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
    await bindReviewEntry(store,fixture.adapter,owner,{...fixture.reviewInput,workspaceId:'other-workspace',submission:{...fixture.reviewInput.submission,submissionId:'other-bound'}});
    await assert.rejects(reconcileReviewEntryOperation(store,fixture.adapter,held.id,held.inputHash),/Repository branch already belongs to queue task .*reconciliation refused/);
    assert.equal(store.operation(held.id)?.state,'needs_attention');
  }finally{store.close();rmSync(fixture.root,{recursive:true,force:true});}
});
