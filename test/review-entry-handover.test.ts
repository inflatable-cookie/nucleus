import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {briefDigest,currentBrief} from "../core/planning/brief";
import {reviewEntryInputSchema} from "../shared/contracts";
import {previewReviewEntry, type ReviewEntryAdapter} from "../core/review/review-entry";
import {PaseoAdapter,type Adapter} from "../service/paseo-composition";
import {QueueRuntime} from "../service/runtime-owner";
import {Engine} from "../core/engine";
import {RuntimeRetirementService} from '../core/runtime/runtime-retirement';
import {Reports} from '../core/intake/report';
import {digest} from '../core/store/store';
import {reviewPublicationBody} from '../core/forge/index';
import {classifyReviewPublication} from '../core/review/review-publication';
import {ownerRevisionFixture,runGit} from './support/review-entry-fixture';
import {verifyReviewSourceView} from '../core/review/review-source';
import type {ResolutionAdapter} from '../core/resolution';
import {ProvenPreSendRefusalError} from '../core/resolution';
import {Lifecycle,terminalArchiveWorkspaces} from '../core/closeout/workspace-lifecycle';
import {toolTimelinePage} from './support/tool-timeline';

/**
 * Spec 017 handover intake (papercut 5e627254).
 *
 * An external author submits the existing PR during the turn that finished it,
 * so the origin thread — or the selected source workspace — is positively active
 * at exactly the moment intake runs. Acceptance is durable and separate from
 * execution: the task, its source claim and its exact identity bind once, the
 * wait is visible, and the ordinary lifecycle re-proves the same exact source
 * after the writer yields and only then launches one independent reviewer.
 *
 * These tests drive the public operation and lifecycle surfaces. The writer
 * inspection is the REAL installed `PaseoAdapter.inspectReviewEntry` over a
 * mocked daemon, not a mocked busy string, and progression after the yield is
 * driven only by the bounded sweep window the service timer uses — never by a
 * resubmission, an owner verb or a direct admission call.
 */
const ORIGIN_WAIT='Origin author thread origin still has an active or uncertain turn';
const WORKSPACE_WAIT='Workspace has an active turn or permission request';
type Fixture=ReturnType<typeof ownerRevisionFixture>;
type Placement='attached'|'elsewhere';

function ready(f:Fixture){
  f.store.setMeta('paused',false);
  f.store.setMeta('hostId','host');
  f.store.setMeta('pool',[{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']}]);
}
/**
 * The real review-entry inspection over a mocked daemon. The single `writer`
 * record is the origin author's turn: it is what `observe` reports and what a
 * workspace thread list shows, so `attached` and `elsewhere` exercise the
 * installed classification rather than a fixture's prose.
 */
function writer(f:Fixture,placement:Placement){
  const state={active:true,permissions:false,unknown:false,turn:'author-turn' as string|null};
  const originWorkspaceId='origin-workspace';
  const entry=()=>({agent:{id:'origin',workspaceId:placement==='attached'?f.reviewInput.workspaceId:originWorkspaceId,
    archivedAt:null,activeTurn:state.active?state.turn:null,pendingPermissions:state.permissions?[{id:'permission-1'}]:[],
    status:state.active||state.permissions?'running':'idle',labels:{}}});
  const paseo=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
  Object.defineProperty(paseo,'api',{value:{
    workspaces:{ref:()=>({directory:f.workspace,refresh:async()=>{},current:()=>({projectRootPath:f.repo})})},
    agents:{list:async()=>({entries:[entry()],pageInfo:{hasMore:false}})},
  }});
  const originAgent=async(id:string)=>({id,workspaceId:originWorkspaceId,title:'Origin',archived:false});
  Object.defineProperty(paseo,'originAgent',{value:originAgent});
  Object.defineProperty(paseo,'observe',{value:async(id:string)=>({id,workspaceId:originWorkspaceId,
    status:state.unknown?'unknown':state.active||state.permissions?'running':'idle',active:state.active,permissions:state.permissions,error:''})});
  return {state,originAgent,
    overrides:{inspectReviewEntry:paseo.inspectReviewEntry.bind(paseo),originAgent} as Partial<Adapter&ReviewEntryAdapter>};
}
function mount(f:Fixture,overrides:Partial<Adapter&ResolutionAdapter&ReviewEntryAdapter>={}):Engine{
  ready(f);return f.buildEngine(overrides).engine;
}
/** One bounded sweep window: exactly the work the service timer runs, plus its scheduled lanes. */
async function pass(engine:Engine){
  await engine.sweepOnce();await engine.quiesce();
  await new Promise(resolve=>setTimeout(resolve,0));
}
/** Poll the same bounded window while the test compresses time, never the lifecycle. */
async function sweepUntil(engine:Engine,f:Fixture,taskId:string,done:()=>boolean,label:string){
  const deadline=Date.now()+20_000;
  for(;;){
    if(done())return;
    const current=f.store.task(taskId);
    assert.ok(Date.now()<deadline,`the ordinary lifecycle did not converge (${label}): ${current.phase} · ${current.reason}`);
    await pass(engine);
  }
}
async function accept(engine:Engine,f:Fixture,key:string,input=f.reviewInput){
  const accepted=await engine.startOperation({key,kind:'review_entry',payload:{type:'review_entry',input}});
  assert.ok('accepted' in accepted,`acceptance refused: ${JSON.stringify(accepted)}`);
  if(!('accepted' in accepted))throw Error('unreachable');
  return {operation:accepted.operation,settled:await engine.awaitOperation(accepted.operation.id,10000)};
}
/** The supported Queue-held-brief form: one checked Queue source instead of a committed handoff. */
function briefInput(f:Fixture,store=f.store){
  const text='Queue-held handover scope: review the existing external checkout at the approved head.\n';
  const stamp=new Date().toISOString();
  const approval={version:1,digest:briefDigest(text),approver:'operator (board)',approvedAt:stamp,note:'Checked scope',relayed:false};
  store.addLead({id:'approved-review-brief',title:'Approved review scope',body:text,
    repositories:[{origin:'https://github.com/example/repo',path:f.repo}],lanes:[],tags:[],papercut:null,closure:null,author:'operator',
    state:'open',version:1,digest:approval.digest,check:{ok:true,message:'Checked against pushed planning',checkedAt:stamp,planningCommit:f.planningCommit},
    approval,originAgentId:'origin',baseBranch:'main',dropReason:null,targets:[],source:null,createdAt:stamp,updatedAt:stamp,closedAt:null},'operator');
  return {approval,text,input:reviewEntryInputSchema.parse({...f.reviewInput,submission:{...f.reviewInput.submission,handoffPath:'',
    brief:{text,mediaType:'text/markdown',digest:approval.digest},planningSource:{kind:'lead',id:'approved-review-brief'},
    leadProvenance:{version:1,approval,earlierDigests:[]}}})};
}

test('a real active origin elsewhere is accepted durably and the ordinary lifecycle launches one reviewer on yield alone',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  try{
    const {operation,settled}=await accept(engine,f,'elsewhere-handover');
    assert.equal(settled.state,'succeeded');
    const task=f.store.task(settled.taskId!);
    // Durable acceptance: one task, one operation binding, exact immutable identity.
    assert.equal(f.store.tasks().length,1);
    assert.equal(f.store.operation(operation.id)?.taskId,task.id);
    assert.equal(task.entrypoint,'review');assert.equal(task.phase,'queued');
    assert.equal(task.agentId,null);assert.equal(task.agentIntent,false);
    assert.equal(task.reviewEntry?.workspaceId,f.reviewInput.workspaceId);
    assert.equal(task.reviewEntry?.branch,f.reviewInput.expectedBranch);
    assert.equal(task.reviewEntry?.verifiedHead,f.oldHead);
    assert.equal(task.reviewEntry?.verifiedBase,f.planningCommit);
    assert.equal(task.reviewEntry?.preserveWorkspace,true);
    assert.equal(task.prHead,f.oldHead);assert.equal(task.directory,f.workspace);
    assert.equal(task.originWorkspaceId,'origin-workspace');
    assert.equal(f.store.runs(task.id).length,0,'acceptance creates no reviewer or worker');
    assert.equal(f.creates.length,0);
    assert.match(task.reason,/handover accepted/);assert.match(task.reason,new RegExp(ORIGIN_WAIT));
    // While the writer is active the ordinary lifecycle keeps the wait and executes nothing.
    await pass(engine);await pass(engine);
    const waiting=f.store.task(task.id);
    assert.equal(waiting.phase,'queued');
    assert.equal(waiting.reason,ORIGIN_WAIT);
    assert.equal(waiting.resolution.stop?.reason,'origin_busy');
    assert.deepEqual(waiting.resolution.stop?.suggestedVerbs,[]);
    assert.equal(waiting.resolution.attention,false);
    assert.equal(f.creates.length,0);assert.equal(f.store.runs(task.id).length,0);
    // Yield alone: no resubmission, no owner verb, no second key.
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the first reviewer after the writer yielded');
    const admitted=f.store.task(task.id);
    assert.equal(f.store.tasks().length,1,'still exactly one task');
    assert.equal(f.creates.length,1,`exactly one independent reviewer binds: ${admitted.reason}`);
    const reviewer=f.store.run(f.creates[0]!.id)!;
    assert.equal(reviewer.role,'reviewer');
    assert.equal(reviewer.head,f.oldHead);
    assert.equal(reviewer.reviewSourceView,undefined,'new handover rounds do not create a pinned review view');
    assert.equal(reviewer.workspaceId,task.workspaceId,'the reviewer runs in the task workspace');
    assert.equal(reviewer.workspaceId,f.reviewInput.workspaceId);
    assert.equal(runGit(task.directory!,'rev-parse','HEAD'),f.oldHead);
    assert.equal(runGit(task.directory!,'status','--porcelain'),'','the task checkout is clean at send');
    assert.equal(f.store.runs(task.id).filter(run=>run.role==='revision').length,0,'no implementation worker ever exists');
    assert.equal(admitted.agentId,null);
    assert.equal(admitted.reviewEntry?.dispatchBase,f.planningCommit);
  }finally{await engine.stop();f.close();}
});

test('an origin author active inside the selected source workspace is the same handover wait and never an owner verb',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'attached');const engine=mount(f,w.overrides);
  try{
    const {settled}=await accept(engine,f,'workspace-handover');
    assert.equal(settled.state,'succeeded');
    const task=f.store.task(settled.taskId!);
    assert.equal(f.creates.length,0);
    assert.match(task.reason,new RegExp(ORIGIN_WAIT),'the real inspection names the author, not a generic busy workspace');
    await pass(engine);
    const waiting=f.store.task(task.id);
    assert.equal(waiting.phase,'queued');
    assert.equal(waiting.reason,ORIGIN_WAIT);
    assert.equal(waiting.resolution.stop?.reason,'origin_busy','a source-writer wait never asks for restart/route/move');
    assert.deepEqual(waiting.resolution.stop?.suggestedVerbs,[]);
    assert.equal(f.creates.length,0);
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'one reviewer after the attached writer yields');
    assert.equal(f.creates.length,1,`one reviewer: ${f.store.task(task.id).reason}`);
    assert.equal(f.store.task(task.id).agentId,null);
    assert.equal(f.store.run(f.creates[0]!.id)!.head,f.oldHead);
  }finally{await engine.stop();f.close();}
});

test('a writer that resumes during the admission proofs never admits the task',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  try{
    const {settled}=await accept(engine,f,'admission-custody');
    const task=f.store.task(settled.taskId!);
    w.state.active=false; // the author yields...
    let resumed=0;
    f.state.onPull=()=>{resumed++;w.state.active=true;}; // ...and resumes during admission's awaited forge read
    await pass(engine);
    assert.ok(resumed>0,'the admission pass really read the forge after its first writer observation');
    const waiting=f.store.task(task.id);
    assert.equal(f.creates.length,0);assert.equal(f.store.runs(task.id).length,0);
    assert.equal(waiting.phase,'queued','the resumed writer keeps the task short of admission');
    assert.equal(waiting.resolution.stop?.reason,'origin_busy');
    assert.equal(waiting.reviewEntry?.dispatchBase,null);
    // The writer yields for real: the same task admits and one reviewer binds.
    f.state.onPull=null;w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'admission after the writer yields again');
    assert.equal(f.creates.length,1);
    assert.equal(f.store.task(task.id).reviewEntry?.dispatchBase,f.planningCommit);
  }finally{await engine.stop();f.close();}
});

test('a writer that resumes during the reviewer launch never creates the first reviewer',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');
  const hook={onVerifyPr:null as null|(()=>void)};
  const engine=mount(f,{...w.overrides,
    verifyPr:async()=>{hook.onVerifyPr?.();return{url:'https://github.com/example/repo/pull/41',head:f.workspaceHead()};}});
  try{
    const {settled}=await accept(engine,f,'launch-custody');
    const task=f.store.task(settled.taskId!);
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.store.task(task.id).phase==='awaiting_review','admission with an idle writer');
    assert.equal(f.creates.length,0);
    hook.onVerifyPr=()=>{w.state.active=true;}; // the author resumes during the launch's forge read
    await pass(engine);
    const waiting=f.store.task(task.id);
    assert.equal(f.creates.length,0,'no reviewer is created under an active writer');
    assert.equal(f.store.runs(task.id).length,0,'no run intent is recorded either');
    assert.equal(waiting.phase,'awaiting_review');
    assert.equal(waiting.resolution.stop?.reason,'origin_busy');
    assert.equal(waiting.resolution.currentRunId,null);
    // Yield alone: the same task still starts exactly one reviewer at the exact head.
    hook.onVerifyPr=null;w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the first reviewer after the launch-time writer yields');
    assert.equal(f.creates.length,1);
    assert.equal(f.store.run(f.creates[0]!.id)!.head,f.oldHead);
    assert.equal(f.store.task(task.id).agentId,null);
  }finally{await engine.stop();f.close();}
});

test('an uncommitted source change during the reviewer launch is never reviewed',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');
  const scratch=join(f.workspace,'uncommitted-review-scratch.txt');
  const hook={onVerifyPr:null as null|(()=>void)};
  const engine=mount(f,{...w.overrides,
    verifyPr:async()=>{hook.onVerifyPr?.();return{url:'https://github.com/example/repo/pull/41',head:f.workspaceHead()};}});
  try{
    const {settled}=await accept(engine,f,'dirty-launch');
    const task=f.store.task(settled.taskId!);
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.store.task(task.id).phase==='awaiting_review','admission with a clean writer workspace');
    hook.onVerifyPr=()=>{writeFileSync(scratch,'uncommitted external work\n');};
    await pass(engine);
    const held=f.store.task(task.id);
    rmSync(scratch,{force:true});
    assert.equal(f.creates.length,0,'no reviewer executes on an uncommitted workspace');
    assert.equal(f.store.runs(task.id).length,0);
    assert.equal(held.phase,'awaiting_review','the task holds its phase and records attention');
    assert.equal(held.resolution.attention,true);
    assert.match(held.reason,/Ordinary reviewer checkout is dirty: expected an empty porcelain status; observed \?\? uncommitted-review-scratch\.txt/);
    assert.equal(held.reviewEntry?.verifiedHead,f.oldHead,'the intake pin is unchanged');
    assert.equal(held.prHead,f.oldHead);
  }finally{await engine.stop();f.close();}
});

test('preview reports accepted-handover eligibility apart from readiness to execute and stores nothing',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');
  const adapter={...f.buildAdapter(),...w.overrides} as Adapter&ReviewEntryAdapter;
  try{
    const result=await previewReviewEntry(f.store,adapter,f.reviewInput);
    assert.equal(result.eligible,true);
    assert.equal(result.pendingHandover,ORIGIN_WAIT,'the wait is named, not claimed as an idle proof');
    assert.equal(result.resolved?.head,f.oldHead);
    assert.equal(result.resolved?.workspaceId,f.reviewInput.workspaceId);
    assert.equal(f.store.tasks().length,0,'preview is read only');
    assert.equal(f.store.operations().length,0,'preview accepts no operation');
    // An activity the adapter could not positively read as transient is unknown: intake fails closed.
    w.state.active=false;
    const idle=await previewReviewEntry(f.store,adapter,f.reviewInput);
    assert.equal(idle.eligible,true);assert.equal(idle.pendingHandover,null);
    const unreadable={...f.buildAdapter(),inspectReviewEntry:async()=>({directory:f.workspace,originWorkspaceId:'origin-workspace',busyReason:ORIGIN_WAIT}),originAgent:w.originAgent};
    const refused=await previewReviewEntry(f.store,unreadable,f.reviewInput);
    assert.equal(refused.eligible,false);
    assert.equal(refused.refusals[0]?.code,'workspace_busy');
    assert.equal(refused.pendingHandover,null);
  }finally{f.close();}
});

test('unknown writer activity is a definite pre-binding refusal with no task, no reviewer and no fabricated wait',async()=>{
  const f=ownerRevisionFixture();
  const engine=mount(f,{inspectReviewEntry:async()=>({directory:f.workspace,originWorkspaceId:'origin-workspace',busyReason:ORIGIN_WAIT})});
  try{
    const {settled}=await accept(engine,f,'unknown-activity');
    assert.equal(settled.state,'failed');
    assert.equal(settled.taskId,null);
    assert.match(settled.diagnostic,new RegExp(ORIGIN_WAIT));
    assert.equal(f.store.tasks().length,0);
    assert.equal(f.creates.length,0);
  }finally{await engine.stop();f.close();}
});

test('a foreign Queue ownership conflict still parks intake instead of waiting',async()=>{
  const f=ownerRevisionFixture();
  const engine=mount(f,{inspectReviewEntry:async()=>({directory:f.workspace,originWorkspaceId:'origin-workspace',busyReason:'Workspace already has Queue ownership labels',busyTransient:false})});
  try{
    const {settled}=await accept(engine,f,'foreign-ownership');
    assert.equal(settled.state,'failed');
    assert.equal(settled.taskId,null);
    assert.equal(f.store.tasks().length,0);
    assert.equal(f.creates.length,0);
  }finally{await engine.stop();f.close();}
});

test('a dirty source workspace refuses acceptance, and the same stable key accepts once the author commits',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  try{
    const dirty=join(f.workspace,'uncommitted.txt');writeFileSync(dirty,'external work in progress\n');
    const refused=await accept(engine,f,'dirty-handover');
    assert.equal(refused.settled.state,'failed');
    assert.match(refused.settled.diagnostic,/must be clean/);
    assert.equal(f.store.tasks().length,0);
    // The author finishes and commits; the same key and input reopen and accept the handover.
    rmSync(dirty,{force:true});
    const accepted=await accept(engine,f,'dirty-handover');
    assert.equal(accepted.settled.state,'succeeded');
    assert.equal(f.store.tasks().length,1);
    assert.equal(f.creates.length,0);
  }finally{await engine.stop();f.close();}
});

test('a source head that moves while the handover waits never reviews the stale pin or silently pins the new one',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  try{
    const {settled}=await accept(engine,f,'moved-while-waiting');
    const task=f.store.task(settled.taskId!);
    const moved=f.pushRevision('external author pushed while the handover waited');
    assert.notEqual(moved,f.oldHead);
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.store.task(task.id).phase==='needs_attention','the moved source is disposed');
    const held=f.store.task(task.id);
    assert.match(held.reason,/does not match expected head/);
    assert.equal(f.creates.length,0,'no reviewer executes on a changed source');
    assert.equal(f.store.runs(task.id).length,0);
    assert.equal(held.reviewEntry?.verifiedHead,f.oldHead,'the intake pin is unchanged');
    assert.equal(held.prHead,f.oldHead,'the new head is never silently credited');
  }finally{await engine.stop();f.close();}
});

test('a restart during the wait preserves one handover and resumes automatically on yield',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');
  let engine=mount(f,w.overrides);
  try{
    // Two racing identical submissions: one durable operation, one task, no duplicate claim.
    const [first,second]=await Promise.all([
      engine.startOperation({key:'restart-handover',kind:'review_entry',payload:{type:'review_entry',input:f.reviewInput}}),
      engine.startOperation({key:'restart-handover',kind:'review_entry',payload:{type:'review_entry',input:f.reviewInput}}),
    ]);
    assert.ok('accepted' in first||'accepted' in second);
    const operationId='accepted' in first?first.operation.id:'accepted' in second?second.operation.id:'';
    assert.notEqual(operationId,'');
    const settled=await engine.awaitOperation(operationId,10000);
    assert.equal(settled.state,'succeeded');
    const taskId=settled.taskId!;
    const intake=f.store.task(taskId);
    assert.equal(f.store.tasks().length,1);
    assert.equal(f.store.operation(operationId)?.taskId,taskId);
    assert.equal(f.creates.length,0);
    await engine.stop();
    // A normal service restart: the same database reopened by a fresh engine.
    f.reopen();
    engine=mount(f,w.overrides);
    const resumed=f.store.task(taskId);
    assert.equal(f.store.tasks().length,1,'restart creates no second task');
    assert.equal(f.store.operation(operationId)?.taskId,taskId,'no second operation or source claim');
    assert.equal(resumed.reviewEntry?.verifiedHead,intake.reviewEntry?.verifiedHead);
    assert.equal(resumed.reviewEntry?.workspaceId,intake.reviewEntry?.workspaceId);
    assert.equal(resumed.phase,'queued');
    await pass(engine);
    assert.equal(f.creates.length,0,'restart sends no reviewer while the writer is active');
    w.state.active=false;
    await sweepUntil(engine,f,taskId,()=>f.creates.length>0,'the reviewer after the restart and yield');
    assert.equal(f.store.tasks().length,1);
    assert.equal(f.creates.length,1,`one reviewer after the restart and yield: ${f.store.task(taskId).reason}`);
    assert.equal(f.store.runs(taskId).filter(run=>run.role==='reviewer').length,1);
    assert.equal(f.store.task(taskId).agentId,null);
    // A lost or repeated reply reconciles the same acceptance: no second task, claim or reviewer.
    const replay=await engine.startOperation({key:'restart-handover',kind:'review_entry',payload:{type:'review_entry',input:f.reviewInput}});
    assert.ok('accepted' in replay,'a repeated key for an already-accepted handover reconciles the same operation');
    if('accepted' in replay)assert.equal(replay.operation.id,operationId);
    assert.equal(f.store.tasks().length,1);
    assert.equal(f.creates.length,1);
    assert.equal(f.store.operations().filter(entry=>entry.kind==='review_entry').length,1);
  }finally{await engine.stop();f.close();}
});

test('reviewer creation uses the task workspace after the origin writer yields',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');
  const hook={onCreateRun:null as null|(()=>void)};
  const engine=mount(f,{...w.overrides,
    createRun:async(_task:unknown,run:import('../shared/contracts').Run)=>{hook.onCreateRun?.();const id=`review-agent-${run.id}`;
      f.states.set(id,{id,workspaceId:run.workspaceId,status:'running',active:true,permissions:false,error:'',model:'reviewer-model'});
      f.creates.push(run);return{id,workspaceId:run.workspaceId};}});
  try{
    const {settled}=await accept(engine,f,'create-custody');
    const task=f.store.task(settled.taskId!);
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.store.task(task.id).phase==='awaiting_review','admission with an idle writer');
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the reviewer after creation');
    const run=f.store.run(f.creates[0]!.id)!;
    assert.equal(f.store.task(task.id).phase,'reviewing');
    assert.equal(run.released,false);
    assert.equal(run.reviewSourceView,undefined);
    assert.equal(run.workspaceId,task.workspaceId);
    assert.equal(runGit(task.directory!,'rev-parse','HEAD'),run.head);
    assert.equal(runGit(task.directory!,'status','--porcelain'),'');
    assert.equal(f.store.runs(task.id).filter(candidate=>candidate.role==='reviewer').length,1,'exactly one reader');
  }finally{await engine.stop();f.close();}
});

test('an origin writer who resumes before reviewer creation blocks the initial send in the task workspace',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');let sends=0,blocked='';
  const engine=mount(f,{...w.overrides,createRun:async(_task,run,_token,_context,_owner,guard)=>{
    assert.ok(guard,'review-entry reviewer creation carries a live handover guard');
    w.state.active=true;
    try{
      if(!await guard!.allowed()||!guard!.stillAllowed())throw new ProvenPreSendRefusalError('review-entry source changed before send');
      sends++;f.creates.push(run);return{id:`review-agent-${run.id}`,workspaceId:run.workspaceId};
    }catch(error){
      blocked=error instanceof Error?error.message:String(error);
      throw error instanceof ProvenPreSendRefusalError?error:new ProvenPreSendRefusalError(blocked);
    }
  }});
  try{
    w.state.active=false;
    const {settled}=await accept(engine,f,'writer-resumed-before-send');
    const task=f.store.task(settled.taskId!);
    await sweepUntil(engine,f,task.id,()=>f.store.task(task.id).phase==='needs_attention','pre-send writer-yield refusal');
    assert.equal(sends,0,'the reviewer is never sent while the origin author is active');
    assert.match(blocked,/Origin author thread origin still has an active or uncertain turn/);
    const run=f.store.runs(task.id).find(candidate=>candidate.role==='reviewer')!;
    assert.equal(run.workspaceId,task.workspaceId);
    assert.equal(run.reviewSourceView,undefined);
    assert.equal(run.released,true,'the refusal is recorded as a definite pre-send outcome');
    assert.equal(f.store.task(task.id).phase,'needs_attention');
  }finally{await engine.stop();f.close();}
});

test('native reviewer creation binds its workspace and prompt to the task workspace',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  try{
    const {settled}=await accept(engine,f,'native-prompt-placement');
    const task=f.store.task(settled.taskId!);w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'pinned reviewer');
    const run=f.store.run(f.creates[0]!.id)!;
    const native=new PaseoAdapter('ws://127.0.0.1:1',join(f.root,'prompt.sock'),join(f.root,'prompt-helper.mjs'));
    let workspaceId='',prompt='',nativeCreations=0;
    Object.defineProperty(native,'api',{value:{workspaces:{ref:(id:string)=>{
      workspaceId=id;
      return {agents:{create:async(input:{prompt:string})=>{nativeCreations++;prompt=input.prompt;return{id:'native-reader',workspaceId:id};}}};
    }}}});
    const created=await native.createRun(f.store.task(task.id),run,'fixture-token');
    assert.equal(created.workspaceId,task.workspaceId);assert.equal(workspaceId,task.workspaceId);
    assert.ok(prompt.includes(`Reviewer workspace: ${task.workspaceId}\n`));
    assert.ok(prompt.includes(`Reviewer directory: ${task.directory}\n`));
    assert.ok(prompt.includes(`Reviewer branch: ${task.branch}\n`));
    assert.ok(prompt.includes(`Expected head: ${run.head}\n`));
    assert.equal(run.reviewSourceView,undefined);
    await assert.rejects(native.createRun(f.store.task(task.id),run,'fixture-token',null,null,
      {allowed:async()=>false,stillAllowed:()=>true}));
    assert.equal(nativeCreations,1,'a pre-send writer refusal creates no second thread or workspace');
  }finally{await engine.stop();f.close();}
});

test('an intake-owned isolated review workspace gets the same launch-time writer recheck',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');
  const hook={onVerifyPr:null as null|(()=>void)};
  const engine=mount(f,{...w.overrides,
    verifyPr:async()=>{hook.onVerifyPr?.();return{url:'https://github.com/example/repo/pull/41',head:f.workspaceHead()};}});
  try{
    const intake={...f.reviewInput,workspaceOwnership:'intake' as const};
    const {settled}=await accept(engine,f,'intake-ownership',intake);
    assert.equal(settled.state,'succeeded');
    const task=f.store.task(settled.taskId!);
    assert.equal(task.reviewEntry?.preserveWorkspace,false,'the workspace is intake-owned, not preserved');
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.store.task(task.id).phase==='awaiting_review','admission with an idle writer');
    hook.onVerifyPr=()=>{w.state.active=true;};
    await pass(engine);
    const waiting=f.store.task(task.id);
    assert.equal(f.creates.length,0,'no reviewer is created under an active writer, intake-owned or not');
    assert.equal(f.store.runs(task.id).length,0);
    assert.equal(waiting.resolution.stop?.reason,'origin_busy');
    hook.onVerifyPr=null;w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the reviewer after the intake-owned writer yields');
    assert.equal(f.creates.length,1);
    assert.equal(f.store.run(f.creates[0]!.id)!.head,f.oldHead);
  }finally{await engine.stop();f.close();}
});

test('the service timer alone carries a Queue-held brief handover across a restart to one reviewer',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'attached');
  const dataDir=join(f.root,'service-brief');
  let runtime=serviceRuntime(f,w,dataDir);
  try{
    await runtime.started;
    await seedReviewerProfile(runtime,f);
    runtime.store.setMeta('paused',false);
    runtime.store.setMeta('pool',[{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']}]);
    const brief=briefInput(f,runtime.store);
    const accepted=await runtime.engine.startOperation({key:'service-brief-handover',kind:'review_entry',payload:{type:'review_entry',input:brief.input}});
    assert.ok('accepted' in accepted,`acceptance refused: ${JSON.stringify(accepted)}`);
    if(!('accepted' in accepted))return;
    const operationId=accepted.operation.id;
    const settled=await runtime.engine.awaitOperation(operationId,10000);
    assert.equal(settled.state,'succeeded');
    const taskId=settled.taskId!;
    const claim=runtime.store.task(taskId);
    assert.equal(claim.brief?.text,brief.text);
    assert.equal(currentBrief(claim)?.digest,brief.approval.digest);
    assert.equal(currentBrief(claim)?.version,1);
    assert.equal(claim.reviewEntry?.briefDigest,brief.approval.digest);
    assert.equal(claim.planningSource?.id,'approved-review-brief');
    assert.equal(f.creates.length,0);
    assert.equal(claim.reason.includes('Origin author thread origin still has an active or uncertain turn'),true);
    await runtime.stop();
    runtime=serviceRuntime(f,w,dataDir);
    await runtime.started;
    const resumed=runtime.store.task(taskId);
    assert.equal(runtime.store.tasks().length,1,'restart binds no second task or brief claim');
    assert.equal(runtime.store.operation(operationId)?.taskId,taskId,'no second operation or source claim');
    assert.equal(resumed.brief?.text,brief.text);
    assert.equal(currentBrief(resumed)?.digest,brief.approval.digest,'the checked brief digest is unchanged across restart');
    assert.equal(currentBrief(resumed)?.version,1);
    assert.equal(resumed.reviewEntry?.workspaceId,claim.reviewEntry?.workspaceId);
    assert.equal(resumed.reviewEntry?.verifiedHead,claim.reviewEntry?.verifiedHead);
    assert.equal(f.creates.length,0,'restart starts nothing while the writer is still active');
    // Nothing below calls the engine: the restarted service's own timer advances it.
    w.state.active=false;
    const created=await waitForReviewer(f);
    assert.ok(created,`the service timer started the brief handover reviewer: ${runtime.store.task(taskId).phase} · ${runtime.store.task(taskId).reason}`);
    const run=runtime.store.run(created!.id)!;
    assert.equal(run.role,'reviewer');assert.equal(run.head,f.oldHead);
    assert.equal(run.reviewSourceView,undefined);
    assert.equal(run.workspaceId,resumed.workspaceId);
    assert.equal(runtime.store.tasks().length,1);
    const replay=await runtime.engine.startOperation({key:'service-brief-handover',kind:'review_entry',payload:{type:'review_entry',input:brief.input}});
    assert.ok('accepted' in replay);
    if('accepted' in replay)assert.equal(replay.operation.id,operationId);
    assert.equal(runtime.store.tasks().length,1);
  }finally{await runtime.stop();f.close();}
});

test('a Queue-held brief handover keeps its exact checked claim across restart and still starts one reviewer',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');
  let engine=mount(f,w.overrides);
  try{
    const brief=briefInput(f);
    const {settled}=await accept(engine,f,'brief-handover',brief.input);
    assert.equal(settled.state,'succeeded');
    const task=f.store.task(settled.taskId!);
    assert.equal(task.brief?.text,brief.text);
    assert.equal(currentBrief(task)?.digest,brief.approval.digest);
    assert.equal(currentBrief(task)?.version,1);
    assert.equal(task.planningSource?.id,'approved-review-brief');
    assert.equal(task.reviewEntry?.briefDigest,brief.approval.digest);
    assert.equal(task.reviewEntry?.briefVersion,1);
    assert.equal(f.creates.length,0);
    assert.match(task.reason,/handover accepted/);
    await engine.stop();
    f.reopen();
    engine=mount(f,w.overrides);
    const resumed=f.store.task(task.id);
    assert.equal(f.store.tasks().length,1,'restart binds no second task or brief claim');
    assert.equal(resumed.brief?.text,brief.text);
    assert.equal(currentBrief(resumed)?.digest,brief.approval.digest,'the checked brief digest is unchanged across restart');
    assert.equal(currentBrief(resumed)?.version,1);
    assert.equal(resumed.planningSource?.id,'approved-review-brief');
    assert.equal(resumed.reviewEntry?.workspaceId,f.reviewInput.workspaceId);
    assert.equal(resumed.reviewEntry?.verifiedHead,f.oldHead);
    await pass(engine);
    assert.equal(f.creates.length,0,'restart sends no reviewer while the writer is active');
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the brief handover reviewer after the writer yields');
    assert.equal(f.creates.length,1);
    assert.equal(f.store.run(f.creates[0]!.id)!.head,f.oldHead);
    assert.equal(f.store.task(task.id).agentId,null);
  }finally{await engine.stop();f.close();}
});

/**
 * The real service runtime over the fixture adapter: its own sweep timer is the
 * only thing that can advance the task. The test never calls the engine after the
 * handover is accepted, so anything it observes was driven by the service
 * cadence itself.
 */
function serviceRuntime(f:Fixture,w:ReturnType<typeof writer>,dataDir:string){
  const adapter={...f.buildAdapter(),...w.overrides,client:{isConnected:true},
    catalog:async()=>({providers:[{key:'test',label:'test',available:true,problem:'',models:[{id:'reviewer-model',label:'reviewer-model',aliases:[],thinkingOptions:[],defaultThinkingOptionId:null,modes:[],features:[]}]}]})} as Adapter&ReviewEntryAdapter;
  const runtime = new QueueRuntime({dataDir,adapterFactory:()=>adapter,timers:true,sweepIntervalMs:20});
  runtime.store.setProfiles([{id:'reviewer',name:'Reviewer',provider:'test',model:'reviewer-model',notes:''}]);
  return runtime;
}
// Profiles route from the Queue store (#870): seed the reviewer, then refresh the routed list the bootstrap built without it.
async function seedReviewerProfile(runtime:QueueRuntime,f:Fixture){
  const {available,problem,supportedThinking,...profile}=f.reviewer;
  runtime.store.setProfiles([profile]);
  await runtime.refresh();
}
async function waitForReviewer(f:Fixture,deadlineMs=25_000){
  const deadline=Date.now()+deadlineMs;
  while(!f.creates.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  return f.creates[0]??null;
}
for(const placement of ['elsewhere','attached'] as const){
  test(`the service timer alone admits an ${placement} origin handover and starts the reviewer on yield`,async()=>{
    const f=ownerRevisionFixture();const w=writer(f,placement);
    const runtime=serviceRuntime(f,w,join(f.root,'service'));
    try{
      await runtime.started;
      await seedReviewerProfile(runtime,f);
      runtime.store.setMeta('paused',false);
      runtime.store.setMeta('pool',[{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']}]);
      const accepted=await runtime.engine.startOperation({key:`service-timer-${placement}`,kind:'review_entry',payload:{type:'review_entry',input:f.reviewInput}});
      assert.ok('accepted' in accepted,`acceptance refused: ${JSON.stringify(accepted)}`);
      if(!('accepted' in accepted))return;
      const settled=await runtime.engine.awaitOperation(accepted.operation.id,10000);
      assert.equal(settled.state,'succeeded');
      const taskId=settled.taskId!;
      assert.equal(runtime.store.task(taskId).phase,'queued');
      assert.equal(f.creates.length,0);
      assert.equal(runtime.store.task(taskId).reason.includes('Origin author thread origin still has an active or uncertain turn'),true);
      // Nothing below calls the engine: the runtime's own sweep cadence advances it.
      w.state.active=false;
      const created=await waitForReviewer(f);
      assert.ok(created,`the service timer admitted the task and started the reviewer: ${runtime.store.task(taskId).phase} · ${runtime.store.task(taskId).reason}`);
      const run=runtime.store.run(created!.id)!;
      assert.equal(run.role,'reviewer');assert.equal(run.head,f.oldHead);
      assert.equal(runtime.store.tasks().length,1);
      assert.equal(runtime.store.task(taskId).agentId,null);
    }finally{await runtime.stop();f.close();}
  });
}

test('a service restart keeps the handover and its own timer starts the reviewer on yield',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'attached');
  const dataDir=join(f.root,'service');
  let runtime=serviceRuntime(f,w,dataDir);
  try{
    await runtime.started;
    await seedReviewerProfile(runtime,f);
    runtime.store.setMeta('paused',false);
    runtime.store.setMeta('pool',[{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']}]);
    const accepted=await runtime.engine.startOperation({key:'service-restart-handover',kind:'review_entry',payload:{type:'review_entry',input:f.reviewInput}});
    assert.ok('accepted' in accepted);
    if(!('accepted' in accepted))return;
    const operationId=accepted.operation.id;
    const settled=await runtime.engine.awaitOperation(operationId,10000);
    assert.equal(settled.state,'succeeded');
    const taskId=settled.taskId!;
    const claim=runtime.store.task(taskId).reviewEntry!;
    assert.equal(f.creates.length,0);
    await runtime.stop();
    // A normal service restart over the same durable store; later ticks are the new timer's.
    runtime=serviceRuntime(f,w,dataDir);
    await runtime.started;
    assert.equal(runtime.store.tasks().length,1,'restart creates no second task');
    assert.equal(runtime.store.operation(operationId)?.taskId,taskId,'no second operation or source claim');
    assert.equal(runtime.store.task(taskId).reviewEntry?.verifiedHead,claim.verifiedHead);
    assert.equal(runtime.store.task(taskId).reviewEntry?.workspaceId,claim.workspaceId);
    assert.equal(f.creates.length,0,'restart starts nothing while the writer is still active');
    w.state.active=false;
    const created=await waitForReviewer(f);
    assert.ok(created,`the restarted service timer started the reviewer: ${runtime.store.task(taskId).phase} · ${runtime.store.task(taskId).reason}`);
    assert.equal(f.store.tasks().length,0,'the fixture store was never written');
    assert.equal(runtime.store.tasks().length,1);
    assert.equal(runtime.store.runs(taskId).filter(run=>run.role==='reviewer').length,1);
    assert.equal(runtime.store.run(created!.id)!.head,f.oldHead);
    assert.equal(runtime.store.task(taskId).agentId,null);
    // A repeated key after the restart still reconciles the one acceptance.
    const replay=await runtime.engine.startOperation({key:'service-restart-handover',kind:'review_entry',payload:{type:'review_entry',input:f.reviewInput}});
    assert.ok('accepted' in replay);
    if('accepted' in replay)assert.equal(replay.operation.id,operationId);
    assert.equal(runtime.store.tasks().length,1);
  }finally{await runtime.stop();f.close();}
});

test('an authenticated reviewer report is accepted only for the clean task workspace at the canonical head',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  try{
    const {settled}=await accept(engine,f,'report-accept');
    const task=f.store.task(settled.taskId!);
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the reviewer in the task workspace');
    const run=f.store.run(f.creates[0]!.id)!;
    const token=f.tokens.get(run.id)!;
    const report={taskId:task.id,runId:run.id,status:'ready_to_merge' as const,head:f.oldHead,summary:'Approved the exact head',reviewText:'The exact task-workspace head is ready.',reviewCommentId:7};
    // The reviewer is idle in the task workspace; the source is checked at callback acceptance.
    f.states.set(run.agentId!,{id:run.agentId!,workspaceId:run.workspaceId,status:'idle',active:false,permissions:false,error:'',model:'reviewer-model'});
    // A dirty task checkout refuses the report before any credit is recorded.
    const mutation=join(task.directory!,'mutation-after-read.txt');
    writeFileSync(mutation,'unreviewed\n');
    await assert.rejects(engine.complete({...report,eventId:'handover-view-refused'},token),/tracked or untracked changes/);
    assert.equal(f.store.task(task.id).resolution.review,null,'a refused report records no verdict');
    assert.equal(f.store.run(run.id)!.completion,null);
    // With the task checkout restored, the same authenticated run's verdict is accepted.
    rmSync(mutation,{force:true});
    await engine.complete({...report,eventId:'handover-view-accepted'},token);
    const completion=f.store.run(run.id)!.completion;
    assert.equal(completion?.status,'ready_to_merge');
    assert.equal(completion?.head,f.oldHead);
    await engine.wake();await engine.wake();
    const applied=f.store.task(task.id);
    assert.equal(f.store.run(run.id)?.completion?.head,f.oldHead,'the accepted callback records its exact reviewed head');
    assert.equal(f.store.run(run.id)?.completion?.status,'ready_to_merge');
    assert.equal(applied.reviewEntry?.workspaceId,f.reviewInput.workspaceId,'the task still names its original source');
    assert.equal(applied.prHead,f.oldHead);
    const duplicate={...report,eventId:'handover-view-accepted'};
    // Release revokes even the credential of an accepted report (#1005).
    assert.equal(f.store.run(run.id)!.released,true);
    await assert.rejects(engine.complete(duplicate,token),/Unauthorized/);
    await assert.rejects(engine.complete({...duplicate,summary:'conflict'},token),/Unauthorized/);
    await assert.rejects(engine.complete(duplicate,'wrong-token'),/Unauthorized/);
  }finally{await engine.stop();f.close();}
});

test('a report after the declared canonical PR author changed is refused before any credit',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  try{
    const {settled}=await accept(engine,f,'author-change');
    const task=f.store.task(settled.taskId!);
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the reviewer in its view');
    const run=f.store.run(f.creates[0]!.id)!;const token=f.tokens.get(run.id)!;
    f.states.set(run.agentId!,{id:run.agentId!,workspaceId:run.workspaceId,status:'idle',active:false,permissions:false,error:'',model:'reviewer-model'});
    f.state.prAuthor='someone-else';
    const report={taskId:task.id,runId:run.id,status:'ready_to_merge' as const,head:f.oldHead,summary:'Approved the pinned exact head',reviewCommentId:7};
    await assert.rejects(engine.complete({...report,eventId:'author-changed'},token),/declared GitHub author is no longer/);
    assert.equal(f.store.run(run.id)!.completion,null,'a changed canonical author records no verdict');
    assert.equal(f.store.task(task.id).resolution.review,null);
    f.state.prAuthor='external-author';
    await engine.complete({...report,eventId:'author-restored'},token);
    assert.equal(f.store.run(run.id)!.completion?.status,'ready_to_merge');
  }finally{await engine.stop();f.close();}
});

test('a later review round reuses the reviewer thread in the task workspace after a fresh writer-yield check',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  try{
    const {settled}=await accept(engine,f,'retained-view');
    const task=f.store.task(settled.taskId!);
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the first reviewer in the task workspace');
    const first=f.store.run(f.creates[0]!.id)!;
    f.store.putRun({...f.store.run(first.id)!,released:true,status:'superseded',active:false});
    f.states.set(first.agentId!,{id:first.agentId!,workspaceId:task.workspaceId!,status:'idle',active:false,permissions:false,error:'',model:'reviewer-model',provider:f.reviewer.provider});
    f.store.update(task.id,{phase:'awaiting_review',resolution:{...f.store.task(task.id).resolution,currentRunId:null}});
    w.state.active=true;
    await pass(engine);
    assert.equal(f.store.runs(task.id).filter(run=>run.role==='reviewer').length,1,'an active origin writer blocks the next reviewer send');
    assert.equal(f.store.task(task.id).resolution.stop?.reason,'origin_busy');
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.store.runs(task.id).filter(run=>run.role==='reviewer').length>1,'the retained reviewer continuation');
    const second=f.store.runs(task.id).findLast(run=>run.role==='reviewer')!;
    assert.equal(second.reviewSourceView,undefined);
    assert.equal(second.workspaceId,task.workspaceId);
    assert.equal(second.agentId,first.agentId,`the same reviewer thread is retained; events=${JSON.stringify(f.store.events(task.id).map(event=>[event.kind,event.detail]))}`);
    assert.equal(f.creates.length,1,'no extra reviewer agent or workspace is created');
  }finally{await engine.stop();f.close();}
});

test('canonical author drift during the final gate refuses merge intent and merge request',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');let merges=0,drifted=false;
  const engine=mount(f,{...w.overrides,
    mergeGate:async()=>{
      const task=f.store.tasks()[0];
      if(task?.phase==='verifying'||task?.phase==='merging'){
        drifted=true;f.state.prAuthor='different-author';
      }
      return {head:f.oldHead,base:f.planningCommit,wait:''};
    },
    merge:async()=>{merges++;},
  });
  try{
    const {settled}=await accept(engine,f,'post-mechanical-author-drift');
    const task=f.store.task(settled.taskId!);w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'reviewer');
    const run=f.store.run(f.creates[0]!.id)!;
    f.states.set(run.agentId!,{id:run.agentId!,workspaceId:run.workspaceId,status:'idle',active:false,permissions:false,error:'',model:'reviewer-model'});
    await engine.complete({taskId:task.id,runId:run.id,eventId:'approved-before-mechanical',status:'ready_to_merge',head:f.oldHead,
      summary:'Approved source',reviewText:'The exact task-workspace head is ready.',reviewCommentId:7},f.tokens.get(run.id)!);
    await sweepUntil(engine,f,task.id,()=>f.store.task(task.id).phase==='needs_attention','post-verification canonical refusal');
    const held=f.store.task(task.id);
    assert.equal(drifted,true,'the author changed during the final gate; phase='+held.phase+' reason='+held.reason+' mechanical='+JSON.stringify(held.resolution.mechanicalVerification));
    assert.match(held.reason,/canonical|pinned-view review/i);
    assert.equal(held.resolution.mergeIntent,false);assert.equal(merges,0);
    assert.equal(f.store.eventsAll(task.id).some(event=>event.kind==='merge_intent'),false);
  }finally{await engine.stop();f.close();}
});

test('changes requested revise the task workspace and the next review reuses the reviewer thread',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  const worker={id:'worker',name:'Worker',provider:'test',model:'worker-model',notes:'',available:true,problem:'',supportedThinking:[]} as const;
  engine.profiles=[f.reviewer,worker as unknown as typeof f.reviewer];
  f.store.setMeta('pool',[{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']},
    {profileId:'worker',enabled:true,group:'workers',roles:['worker'],weight:1,scopes:['general']}]);
  try{
    const {settled}=await accept(engine,f,'revision-cycle');
    const task=f.store.task(settled.taskId!);
    w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the first reviewer in its view');
    const first=f.store.run(f.creates[0]!.id)!;
    f.states.set(first.agentId!,{id:first.agentId!,workspaceId:first.workspaceId,status:'idle',active:false,permissions:false,error:'',model:'reviewer-model',provider:f.reviewer.provider});
    await engine.complete({taskId:task.id,runId:first.id,eventId:'first-findings',status:'changes_required',head:f.oldHead,
      summary:'Correct one concern in the original source',reviewText:'The reviewed head needs one correction.',reviewResponsibility:'author' as const,reviewCommentId:7},f.tokens.get(first.id)!);
    await engine.wake();await engine.wake();
    const revision=f.store.runs(task.id).find(run=>run.role==='revision');
    assert.ok(revision,`changes requested launch the ordinary revision worker: ${f.store.task(task.id).reason}`);
    assert.equal(revision!.workspaceId,f.store.task(task.id).workspaceId,'the revision keeps working in the original source workspace');
    const newHead=f.pushRevision('author revision after review findings');
    f.states.set(revision!.agentId!,{id:revision!.agentId!,workspaceId:revision!.workspaceId,status:'idle',active:false,permissions:false,error:'',model:'worker-model'});
    await engine.complete({taskId:task.id,runId:revision!.id,eventId:'revision-ready',status:'ready_for_review',head:newHead,prNumber:41,summary:'Corrected the finding'},f.tokens.get(revision!.id)!);
    await engine.wake();await engine.wake();await engine.wake();
    const second=f.store.runs(task.id).filter(run=>run.role==='reviewer').find(run=>run.id!==first.id);
    assert.ok(second,`a subsequent exact-head reviewer binds: ${f.store.task(task.id).reason}`);
    assert.equal(second!.head,newHead);
    assert.equal(second!.reviewSourceView,undefined);
    assert.equal(second!.ordinaryDetached,true,'the retained reviewer gets exact-head and open-PR send proofs on the new head');
    assert.equal(second!.workspaceId,f.store.task(task.id).workspaceId,'the next review stays in the task workspace');
    assert.equal(second!.agentId,first.agentId,'the retained reviewer thread handles the next round');
    assert.equal(f.store.task(task.id).prHead,newHead);
    assert.equal(f.store.task(task.id).reviewEntry?.workspaceId,f.reviewInput.workspaceId,'the task still names its original source');
  }finally{await engine.stop();f.close();}
});

test('an existing pinned intake view is released when its run settles and remains a closeout target',async()=>{
  const f=ownerRevisionFixture();const w=writer(f,'elsewhere');const engine=mount(f,w.overrides);
  try{
    const {settled}=await accept(engine,f,'legacy-view-closeout');
    const task=f.store.task(settled.taskId!);w.state.active=false;
    await sweepUntil(engine,f,task.id,()=>f.creates.length>0,'the ordinary task-workspace reviewer');
    const run=f.store.run(f.creates[0]!.id)!;
    const legacyView={creationId:'33333333-3333-4333-8333-333333333333',workspaceId:'wks_fedcba9876543210',
      runId:run.id,sourceWorkspaceId:task.workspaceId!,sourceDirectory:task.directory!,
      provenance:'review_entry_intake' as const,intakeOperationId:task.reviewEntry!.operationId,receiptOperationId:null,
      receiptAt:task.reviewEntry!.checkedAt,head:run.head,tree:runGit(f.repo,'rev-parse',`${run.head}^{tree}`),
      commonDir:runGit(f.repo,'rev-parse','--path-format=absolute','--git-common-dir'),
      origin:runGit(f.repo,'remote','get-url','origin'),branch:`ns-review-${run.id}`,directory:'/legacy/pinned-view',
      state:'ready' as const,agentCreationIntent:false,briefDigest:task.reviewEntry!.briefDigest,briefVersion:task.reviewEntry!.briefVersion};
    const legacy={...run,workspaceId:legacyView.workspaceId,reviewSourceView:legacyView,released:true,status:'finished' as const,
      completion:{eventId:'legacy-verdict',taskId:task.id,runId:run.id,status:'ready_to_merge' as const,summary:'Approved the exact head',
        head:run.head,reviewText:'The accepted head is ready.',reviewCommentId:71}};
    f.store.putRun(legacy);
    assert.equal(f.store.run(run.id)?.reviewSourceView?.workspaceId,legacyView.workspaceId);
    const done=f.store.update(task.id,{phase:'done',resolution:{...f.store.task(task.id).resolution,mergedCommit:run.head,syncedCommit:run.head}});
    const targets=terminalArchiveWorkspaces(done,f.store.runs(task.id));
    assert.ok(targets.some(target=>target.id===legacyView.workspaceId&&target.directory===legacyView.directory),
      `a retained historical pinned view is included in terminal workspace release: task=${done.phase} run=${JSON.stringify(f.store.run(run.id)?.reviewSourceView)} targets=${JSON.stringify(targets)}`);
    assert.equal(targets.some(target=>target.id===task.workspaceId),false,'the adopted task workspace remains preserved');
  }finally{await engine.stop();f.close();}
});
