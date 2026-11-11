import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {queueOperationSchema} from '../shared/operations';
import {holdPatch} from '../core/merge/merge-hold';
import {now,operationInputHash} from '../core/store/store';
import {normalizeRepositoryOrigin} from '../shared/lanes';
import {bindReviewEntry, type ReviewEntryAdapter} from '../core/review/review-entry';
import {taskControlOperation} from '../core/verbs/task-control-key';
import {collectOwnerVerbFacts, ownerTaskNext} from '../core/verbs/owner-verbs';
import {OPERATOR_BOARD_CALLER, submissionSchema, taskControlInputSchema, type Task, type TaskControlInput, type TaskNextVerb} from '../shared/contracts';
import {externalMerge as forgeExternalMerge} from '../core/forge/index';
import type {QueueRuntime} from '../service/runtime-owner';
import {hostedOrigin,ownerRevisionFixture,runGit} from './support/review-entry-fixture';
import {longToolHistory,toolTimelineTail} from './support/tool-timeline';

type Fixture=ReturnType<typeof ownerRevisionFixture>;
interface Service {f:Fixture;runtime:QueueRuntime;task:Task;merged:{head:string;mergeCommit:string}|null}

/**
 * The real public runtime owner (`RuntimeOwner.taskControl`, the `queue.task`
 * handler) over an isolated store and the fixture's mocked remote identity.
 * This is the task-408 shape: a queued review-entry task, its intake operation
 * settled, both holds placed, the project owner recorded and nothing ever run.
 * `merge` performs the external merge the way the owner did it: a published
 * descendant of the recorded source head, merged outside Queue, with the bound
 * workspace left clean on that merged head.
 */
async function openService(options:{paused?:boolean;merge?:boolean;key?:string}={}):Promise<Service>{
  const f=ownerRevisionFixture();
  const runtime=f.buildRuntime();
  // Queue #912: the recorded host registers on the daemon connect; wait for it before routing through the host.
  await runtime.started;await runtime.bootstrap;
  const store=runtime.store;
  store.setMeta('paused',false);
  store.setMeta('pool',[{profileId:'reviewer',enabled:true,group:'reviewers',roles:['reviewer'],weight:1,scopes:['general']}]);
  const intake=queueOperationSchema.parse({id:'c'.repeat(64),key:options.key??'external-merge-intake',kind:'review_entry',inputHash:'d'.repeat(64),
    state:'running',taskId:null,expectedVersion:null,repoPath:f.repo,submissionId:'owner-revision',createdAt:now(),startedAt:now(),
    settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
  const task=await bindReviewEntry(store,runtime.adapter as unknown as ReviewEntryAdapter,intake,f.reviewInput);
  store.putOperation({...store.operation(intake.id)!,state:'succeeded',settledAt:now()});
  const project=store.projectFor(task.repoPath,normalizeRepositoryOrigin(task.repository??''))!;
  store.setProjectPlanner({key:project.key,agentId:f.owner,setBy:'test',note:'Current project planner'});
  store.update(task.id,holdPatch(store.task(task.id),'dispatch','effigy-root','Root-owned gen1 dispatch fence'));
  store.update(task.id,holdPatch(store.task(task.id),'merge',f.owner,'Owner merge hold before the first review run'));
  const merged=options.merge===false?null:f.mergeExternally();
  if(options.paused!==false)store.setMeta('paused',true);
  return {f,runtime,task:store.task(task.id),merged};
}


/**
 * The public route driven against the REAL forge merge proof (`forge.externalMerge`,
 * the same function `PaseoAdapter` binds in production) over the fixture's local
 * Git, with `gh api` answered by a disposable script inside the fixture root. The
 * canonical repository/branch/base/head/merge-SHA checks therefore run for the
 * identity tests instead of being simulated by a mock.
 */
const realForge=(f:Fixture)=>{
  const dir=mkdtempSync(join(f.root,'forge-gh-')),pull=join(dir,'pull.json'),bin=join(dir,'gh');
  writeFileSync(pull,'{}');
  writeFileSync(bin,'#!/bin/sh\nexec cat "$(dirname "$0")/pull.json"\n');
  chmodSync(bin,0o755);
  return {
    answer(payload:unknown){writeFileSync(pull,JSON.stringify(payload));},
    async run<T>(_runtime:QueueRuntime,body:()=>Promise<T>):Promise<T>{
      const previousImpl=f.state.externalMergeImpl,previousPath=process.env.PATH,remote='ssh://git@github.com/example/repo.git';
      f.state.externalMergeImpl=(task:Task,acceptHead:boolean|undefined)=>forgeExternalMerge(task,acceptHead);
      process.env.PATH=`${dir}:${previousPath??''}`;
      // `git remote get-url` expands insteadOf, so the fixture's local transport
      // rewrite hides the canonical GitHub origin from the forge's own lookup.
      // This proof reads the remote only; no fetch or push happens here.
      runGit(f.repo,'config','--unset-all',`url.${hostedOrigin(f.root)}.insteadOf`);
      try{return await body();}
      finally{
        f.state.externalMergeImpl=previousImpl;process.env.PATH=previousPath;
        runGit(f.repo,'config',`url.${hostedOrigin(f.root)}.insteadOf`,remote);
      }
    },
    close(){rmSync(dir,{recursive:true,force:true});},
  };
};

/** The forge's own PR answer for this fixture: canonical identity at a head. */
const pullAnswer=(f:Fixture)=>(head:string,overrides:{merged?:boolean;mergeCommit?:string;repository?:string;headRef?:string;baseRef?:string;headSha?:string}={})=>({
  state:'closed',merged_at:'2026-10-24T10:00:00Z',merged:overrides.merged??true,
  merge_commit_sha:overrides.mergeCommit??'d'.repeat(40),draft:false,
  head:{repo:{full_name:overrides.repository??'example/repo'},ref:overrides.headRef??'feature/external',sha:overrides.headSha??head},
  base:{repo:{full_name:overrides.repository??'example/repo'},ref:overrides.baseRef??'main'},
  user:{login:'external-author'},html_url:'https://github.com/example/repo/pull/41',
});
/**
 * Close one disposable service without letting a lifecycle step start against a
 * closed store: the fixture's own pause stops new dispatch and lifecycle work,
 * then the runtime drains its lanes and the store closes.
 */
const closeService=async(service:Service)=>{
  try{service.runtime.store.setMeta('paused',true);}catch{/* already closed */}
  // Pause stops new dispatch; quiesce waits for the accepted lane and lifecycle
  // follow-ups so no quantum can touch the store after it closes.
  await service.runtime.engine.quiesce();
  await service.runtime.drain();
  service.f.close();
};

const unfinished=(service:Service,taskId:string)=>
  service.runtime.store.operations({taskId,states:['pending','running','needs_attention']});
const events=(service:Service,taskId:string,kind:string)=>service.runtime.store.eventsAll(taskId).filter(event=>event.kind===kind);
const hexId=(seed:string)=>createHash('sha256').update(seed).digest('hex');
const ACCEPTANCE='I accept the merged head of PR 41 as this external source, after reading the recorded deviations and the missing review evidence';

const closeout=(service:Service,extra:Partial<TaskControlInput>={}):TaskControlInput=>{
  const task=service.runtime.store.task(service.task.id);
  return taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'move',to:'closeout',
    reason:'The PR merged outside Queue on the published external source',caller:'operator (board)',...extra});
};
const views=(service:Service,verb:string):TaskNextVerb[]=>
  ownerTaskNext(collectOwnerVerbFacts(service.runtime.store,service.runtime.store.task(service.task.id))).verbs.filter(entry=>entry.verb===verb);
const moveView=(service:Service,to:string):TaskNextVerb=>{
  const found=views(service,'move').find(view=>view.available&&(view.args as {to?:string}|undefined)?.to===to)
    ??views(service,'move').find(view=>!view.available&&String(view.refusal).startsWith(`move ${to}`));
  assert.ok(found,`a move ${to} view is offered`);
  return found!;
};

/**
 * The durable invariants an accepted closeout must keep, read from the stored
 * row: the observed merge is recorded beside the unchanged recorded source head,
 * exactly one exact-final-head acceptance binds that merged head, no review ran,
 * both holds stand and nothing was created. The phase is read after
 * `RuntimeOwner.taskControl` returns, so it may already be any post-merge step:
 * a paused fixture stops at `syncing`, while an unpaused one can reach `closing`
 * through the ordinary lifecycle after the wake. No step may rewrite any of
 * these facts, which is what the provenance assertions check.
 */
const assertAcceptedCloseout=(service:Service,before:Task,recordedHead=before.prHead)=>{
  const merged=service.merged!,after=service.runtime.store.task(before.id);
  assert.ok(['syncing','merging','closing'].includes(after.phase),`unexpected post-acceptance phase ${after.phase}: ${after.reason}`);
  assert.equal(after.prHead,recordedHead,'the recorded source head is preserved');
  assert.equal(after.resolution.externalMerge,true);
  assert.equal(after.resolution.mergeHead,merged.head);
  assert.equal(after.resolution.mergedCommit,merged.mergeCommit);
  const acceptances=after.resolution.ownerAcceptances!;
  assert.equal(acceptances.length,1,'one acceptance is recorded');
  assert.equal(acceptances[0]!.kind,'operator_source');
  assert.equal(acceptances[0]!.head,merged.head,'the acceptance binds the observed merged head');
  assert.equal(after.resolution.review,null,'the merge is never review credit');
  assert.deepEqual(service.runtime.store.runs(before.id),[],'no run is created');
  assert.equal(after.held,true);assert.equal(after.mergeHold,true,'both holds stand');
  return after;
};

/** A refusal that changes nothing: same version, no merge, no acceptance, no run. */
const assertUntouched=(service:Service,before:Task)=>{
  const after=service.runtime.store.task(before.id);
  assert.equal(after.version,before.version,'a refused closeout writes nothing');
  assert.equal(after.phase,'queued');
  assert.equal(after.prHead,before.prHead);
  assert.equal(after.resolution.externalMerge,false);
  assert.equal(after.resolution.mergedCommit,null);
  assert.equal(after.resolution.mergeHead,null);
  assert.deepEqual(after.resolution.ownerAcceptances??[],[]);
  assert.deepEqual(service.runtime.store.runs(before.id),[]);
  assert.equal(events(service,before.id,'owner_acceptance').length,0);
  assert.equal(events(service,before.id,'external_merge_observed').length,0);
  assert.deepEqual(after.holds,before.holds,'both holds stand with their owners and reasons');
  assert.equal(after.held,true);assert.equal(after.mergeHold,true);
};

test('an explicit owner closeout reconciles a never-dispatched review-entry task whose PR merged outside Queue',async()=>{
  const service=await openService();
  const {f,runtime,task,merged}=service,store=runtime.store;
  try{
    const before=store.task(task.id);
    assert.equal(before.phase,'queued');assert.equal(before.entrypoint,'review');
    assert.equal(before.reviewEntry?.dispatchBase,null,'no reader was ever admitted');
    assert.deepEqual(store.runs(before.id),[]);
    assert.equal(before.held,true);assert.equal(before.mergeHold,true);assert.equal(store.getMeta('paused'),true);
    assert.ok(merged);
    assert.notEqual(merged.head,f.oldHead,'the merged head is a published descendant of the recorded head');

    const control=closeout(service,{qualification:ACCEPTANCE});
    const {key}=taskControlOperation(control);
    const moved=await runtime.taskControl(control) as Task;

    // The SAME durable operation `queue.task` accepted succeeded and carries the result.
    const operation=store.operationForKey(key)!;
    assert.equal(operation.kind,'task_control');
    assert.equal(operation.taskId,before.id);assert.equal(operation.expectedVersion,before.version);
    assert.equal(operation.state,'succeeded',operation.diagnostic);
    assert.deepEqual(unfinished(service,before.id),[],'the invocation settled; nothing stays in flight');

    const after=assertAcceptedCloseout(service,before);
    assert.equal(moved.resolution.mergedCommit,merged.mergeCommit,'the returned row carries the accepted merge');
    // The observed merge is recorded separately from the recorded source head.
    assert.equal(after.resolution.externalMerge,true);
    assert.equal(after.resolution.mergeHead,merged.head);
    assert.equal(after.resolution.mergedCommit,merged.mergeCommit);
    assert.equal(after.prHead,before.prHead,'the recorded source head is preserved, never silently overwritten');
    // The exact-final-head operator source acceptance is recorded beside it.
    const acceptances=after.resolution.ownerAcceptances!;
    assert.equal(acceptances.length,1);
    const acceptance=acceptances[0]!;
    assert.equal(acceptance.kind,'operator_source');
    assert.equal(acceptance.head,merged.head,'the acceptance binds the OBSERVED merged head');
    assert.notEqual(acceptance.head,before.prHead);
    assert.equal(acceptance.prNumber,after.reviewEntry!.prNumber);
    assert.equal(acceptance.review,null,'no review identity is invented');
    assert.match(acceptance.missingEvidence!,/no review evidence binds it/);
    assert.equal(acceptance.actor.agentId,'operator (board)');
    assert.equal(acceptance.authority.kind,'operator');
    assert.equal(acceptance.qualification,ACCEPTANCE);
    // The merge is an observed fact, never review, verification, proof or author credit.
    assert.equal(after.resolution.review,null);
    assert.deepEqual(after.resolution.reviews,[]);
    assert.deepEqual(after.resolution.reviewSupersessions,[]);
    assert.equal(after.resolution.mechanicalVerification,null);
    assert.equal(after.resolution.reviewerAgentId??null,null);
    assert.equal(after.resolution.reviewerProfile??null,null);
    // Identity, provenance, brief, declaration, dependencies, holds and pause stay exact.
    assert.equal(after.id,before.id);assert.equal(after.number,before.number);assert.equal(after.title,before.title);
    assert.equal(after.prUrl,before.prUrl);assert.equal(after.resumePrNumber,before.resumePrNumber);
    assert.equal(after.workspaceId,before.workspaceId);assert.equal(after.directory,before.directory);assert.equal(after.branch,before.branch);
    assert.deepEqual(after.reviewEntry,before.reviewEntry,'the immutable intake block is untouched');
    assert.deepEqual(after.dependsOn,before.dependsOn);
    assert.deepEqual(after.reviewEntry!.authorDeclaration,before.reviewEntry!.authorDeclaration);
    assert.deepEqual(after.holds,before.holds,'both holds keep their owners and reasons');
    assert.equal(after.held,true);assert.equal(after.mergeHold,true);
    assert.equal(store.getMeta('paused'),true,'Queue pause is untouched');
    assert.equal(after.agentId,null);assert.equal(after.runId,null);assert.equal(after.completion,null);
    assert.equal(after.resolution.deferredVerb??null,null,'a bookkeeping closeout is never deferred');
    // One truthful pair of records, and nothing ran, was created or recreated.
    assert.equal(events(service,before.id,'owner_acceptance').length,1);
    assert.equal(events(service,before.id,'external_merge_observed').length,1);
    assert.equal(events(service,before.id,'external_merge_head_accepted').length,1);
    assert.equal(events(service,before.id,'owner_control').length,1);
    assert.equal(events(service,before.id,'external_merge_head_accepted')[0]!.detail,
      `${before.prHead} -> ${merged.head} at ${merged.mergeCommit}: The PR merged outside Queue on the published external source`);
    assert.deepEqual(store.runs(before.id),[]);
    assert.equal(f.creates.length,0);
    assert.equal(store.uiTasks().filter(item=>item.submissionId==='owner-revision').length,1);

    // A lost reply observes the ORIGINAL operation: one merge, one acceptance.
    const replay=await runtime.taskControl(control) as Task;
    assert.equal(replay.resolution.mergedCommit,merged.mergeCommit);
    assert.equal(store.operationForKey(key)!.id,operation.id,'the repeated request is the original durable operation');
    assert.equal(store.task(before.id).resolution.ownerAcceptances!.length,1,'a replay records no second acceptance');
    assert.equal(events(service,before.id,'owner_acceptance').length,1);
    assert.equal(events(service,before.id,'external_merge_observed').length,1);
    assert.deepEqual(store.runs(before.id),[]);
    assert.equal(f.creates.length,0);
    // A fresh closeout at the new version has nothing left to reconcile.
    await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/outside that boundary|Only an unmerged dispatched task/);
    assert.equal(store.task(before.id).resolution.ownerAcceptances!.length,1);
  }finally{await closeService(service);}
});

test('the parent behaviour reproduces the queued refusal through the public route because of its own running operation',async()=>{
  const service=await openService({paused:false});
  const {f,runtime,task}=service,store=runtime.store;
  const patchable=store as unknown as Record<string,unknown>;
  const original=patchable.reviewEntryUnrunBeforeFirstRun;
  try{
    const before=store.task(task.id);
    const control=closeout(service);
    const {key}=taskControlOperation(control);
    // The pre-408 boundary: the closeout reader ignores the authenticated
    // invocation, so the move's own durable operation reads as a competing
    // writer and the queued task keeps the dispatched-task refusal.
    let unseen:string[]=[];
    patchable.reviewEntryUnrunBeforeFirstRun=(current:Task)=>{
      unseen=store.operations({taskId:current.id,states:['pending','running','needs_attention']}).map(item=>item.id);
      return (patchable.reviewEntryUnrun as (task:Task)=>boolean)(current);
    };
    await assert.rejects(runtime.taskControl(control),/Only an unmerged dispatched task can accept an external merge/,
      'the durable route, not only a parent engine call, reproduced the queued refusal');
    const operation=store.operationForKey(key)!;
    assert.equal(operation.state,'failed');
    assert.match(operation.diagnostic,/Only an unmerged dispatched task can accept an external merge/);
    assert.deepEqual(unseen.filter(id=>id===operation.id),[operation.id],
      'exactly the move\u2019s own running operation caused the parent refusal');
    assertUntouched(service,before);
  }finally{
    patchable.reviewEntryUnrunBeforeFirstRun=original;
    await closeService(service);
  }
});

test('the observed merge never becomes acceptance: without the exact-final-head source acceptance the task stays held',async()=>{
  const service=await openService({paused:false});
  const {f,runtime,task}=service,store=runtime.store;
  try{
    const before=store.task(task.id);
    const view=moveView(service,'closeout');
    assert.equal(view.available,true,JSON.stringify(view));
    assert.deepEqual(view.fill,['reason','qualification'],'the exit names the acceptance it needs');
    assert.equal(view.qualifyingFill,undefined,'the never-dispatched closeout stays required, never optional');
    assert.match(view.note!,/never acceptance/);
    assert.match(view.note!,/qualification/);

    // No acceptance: refused with the precise exit, and nothing is written.
    await assert.rejects(runtime.taskControl(closeout(service)),/no reviewer, review, verification or proof at the head its PR merged at[\s\S]*operator source acceptance/);
    assertUntouched(service,before);

    // The dispatched route accepts a named head, but this boundary still
    // observes the merged head itself and refuses a caller-supplied one.
    await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE,head:service.merged!.head})),/merged head is observed at the forge/);
    assertUntouched(service,before);

    // The merge alone observed at the forge is still not acceptance: the same
    // call without the acceptance keeps its refusal even though the PR is merged.
    const forge=(runtime.adapter as unknown as {externalMerge?:(task:Task,accept:boolean)=>Promise<{head:string;commit:string}|null>});
    assert.equal((await forge.externalMerge?.(before,true))?.head,service.merged!.head);
    assertUntouched(service,before);

    // The merge has not happened: an unmerged PR is refused as unmerged.
    service.f.state.merged=false;
    await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/The task PR is not merged/);
    assertUntouched(service,before);
    service.f.state.merged=true;

    // An observed merge that names no exact commit is refused, not guessed.
    service.f.state.mergeCommit='';
    await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/did not name an exact merged head and commit/);
    assertUntouched(service,before);
    service.f.state.mergeCommit=service.merged!.mergeCommit;
  }finally{await closeService(service);}
});

test('busy owner and submitting tool are not queried for never-dispatched closeout',async()=>{
  const service=await openService();
  const {f,runtime}=service;
  try{
    const before=runtime.store.task(service.task.id);
    f.states.set(f.owner,{id:f.owner,workspaceId:'origin-workspace',status:'running',active:true,permissions:true,error:''});
    const adapter=runtime.adapter;
    const observe=adapter.observe.bind(adapter);
    adapter.observe=async id=>{if(id===f.owner)throw Error('planning observation queried');return observe(id);};
    const timeline=adapter.agentTimelinePage, history=longToolHistory(10801);
    history.push({timestamp:now(),item:{type:'tool_call',callId:'submitting',name:'exec',status:'running'}});
    let reads=0;
    if(timeline) adapter.agentTimelinePage=async (...args)=>{if(args[0]===f.owner){reads++;return toolTimelineTail(history,args[1]??200);}return timeline.apply(adapter,args);};
    await runtime.taskControl(closeout(service,{qualification:ACCEPTANCE}));
    assert.equal(reads,0);
    assertAcceptedCloseout(service,before);
  }finally{await closeService(service);}
});

test('unrelated custody still refuses before anything is accepted',async()=>{
  const service=await openService({paused:false});
  const {f,runtime,task}=service,store=runtime.store;
  try{
    const before=store.task(task.id);
    // A competing unfinished operation of the same task is never this invocation.
    for(const state of ['pending','running','needs_attention'] as const){
      const competing=queueOperationSchema.parse({id:hexId(`competing-${state}`),key:`competing-${state}`,kind:'task_control',
        inputHash:'e'.repeat(64),state,taskId:before.id,expectedVersion:null,repoPath:f.repo,submissionId:null,createdAt:now(),
        startedAt:now(),settledAt:null,attempts:0,diagnostic:'',result:null,effect:null});
      store.putOperation(competing);
      await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/outside that boundary|Only an unmerged dispatched task/,
        `a competing ${state} operation is never mistaken for this invocation`);
      store.putOperation({...competing,state:'failed',settledAt:now()});
      assertUntouched(service,before);
    }

    // A historical run of any role closes the never-dispatched boundary.
    store.putRun({id:'history-run',taskId:before.id,role:'reviewer',generation:1,head:f.oldHead,base:f.planningCommit,
      agentId:'old-reviewer',workspaceId:before.workspaceId!,profile:f.reviewer,status:'finished',createdAt:now(),lastObservedAt:now(),
      active:false,idleSince:now(),completion:null,released:true});
    await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/outside that boundary|Only an unmerged dispatched task/);
    assert.deepEqual(store.task(before.id).resolution.ownerAcceptances,[]);
    assert.equal(store.task(before.id).version,before.version);
    assert.equal(events(service,before.id,'owner_acceptance').length,0);
  }finally{await closeService(service);}
});

test('a stale version, a missing invocation and a mutated invocation exempt nothing',async()=>{
  const service=await openService({paused:false});
  const {f,runtime,task}=service,store=runtime.store,engine=runtime.engine;
  try{
    const before=store.task(task.id);

    // A stale version refuses through the durable route; its own operation fails.
    const stale={...closeout(service,{qualification:ACCEPTANCE}),version:before.version-1};
    await assert.rejects(runtime.taskControl(stale),/Task changed/);
    assert.equal(store.operationForKey(taskControlOperation(stale).key)!.state,'failed');
    assertUntouched(service,before);

    // A direct engine call carries no internal invocation identity: the parent
    // refusal stands for callers outside the durable lane.
    await assert.rejects(engine.performTaskControl(closeout(service,{qualification:ACCEPTANCE})),/outside that boundary|Only an unmerged dispatched task/,
      'a missing internal invocation identity exempts nothing');
    assertUntouched(service,before);

    // A forged invocation (a running task-control operation for a different
    // request) exempts nothing either.
    const control=closeout(service,{qualification:ACCEPTANCE});
    const forged:TaskControlInput={...control,reason:`${control.reason} (different request)`};
    const forgedOperation=taskControlOperation(forged);
    const running=queueOperationSchema.parse({id:hexId('forged-invocation'),key:forgedOperation.key,kind:'task_control',
      inputHash:operationInputHash(forgedOperation.payload),state:'running',taskId:before.id,expectedVersion:before.version,
      repoPath:f.repo,submissionId:null,createdAt:now(),startedAt:now(),settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
    store.putOperation(running,forgedOperation.payload);
    await assert.rejects(engine.performTaskControl(control,running.id),/outside that boundary|Only an unmerged dispatched task/,
      'a running operation for another request is not this invocation');
    store.putOperation({...store.operation(running.id)!,state:'failed',settledAt:now()});
    assertUntouched(service,before);

    // The invocation is mutated inside the awaited proof: the commit-time
    // re-read exempts nothing and writes nothing.
    const {key}=taskControlOperation(control);
    f.state.onMerge=()=>{
      const current=store.operationForKey(key)!;
      store.putOperation({...current},{type:'task_control',control:{...control,reason:'invocation payload changed during the merge proof'}});
    };
    await assert.rejects(runtime.taskControl(control),/boundary or recorded merge changed|Only an unmerged dispatched task/);
    f.state.onMerge=null;
    assert.equal(store.operationForKey(key)!.state,'failed','the mutated invocation is not reported as applied');
    assertUntouched(service,before);
  }finally{f.state.onMerge=null;await closeService(service);}
});

test('with the host disconnected, custody and a missing invocation still refuse before the wait',async()=>{
  const service=await openService({paused:false});
  const {f,runtime,task}=service,store=runtime.store;
  try{
    const before=store.task(task.id);
    // nucleus#927: the recorded host is disconnected, so any control that waits
    // waits until it returns. A control no host could ever accept refuses now.
    runtime.engine.hostAvailable=()=>false;

    // A competing unfinished operation of the same task is never this invocation.
    const competing=queueOperationSchema.parse({id:hexId('offline-competing'),key:'offline-competing',kind:'task_control',
      inputHash:'e'.repeat(64),state:'pending',taskId:before.id,expectedVersion:null,repoPath:f.repo,submissionId:null,createdAt:now(),
      startedAt:now(),settledAt:null,attempts:0,diagnostic:'',result:null,effect:null});
    store.putOperation(competing);
    await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/outside that boundary/);
    assert.equal(store.operationForKey(taskControlOperation(closeout(service,{qualification:ACCEPTANCE})).key)!.state,'failed',
      'the refused closeout is settled, not parked in the host wait');
    assertUntouched(service,before);

    // The boundary is still reachable for the invocation itself: with the
    // competing operation settled, the same closeout waits for its host instead.
    store.putOperation({...store.operation(competing.id)!,state:'failed',settledAt:now()});
    const control=closeout(service,{qualification:ACCEPTANCE}),{key,payload}=taskControlOperation(control);
    const accepted=await runtime.engine.startOperation({key,kind:'task_control',payload,taskId:control.taskId,expectedVersion:control.version});
    assert.ok('accepted'in accepted);
    if('accepted'in accepted){
      const deadline=Date.now()+5000;
      while(!store.operation(accepted.operation.id)!.diagnostic&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
      const parked=store.operation(accepted.operation.id)!;
      assert.equal(parked.state,'pending','the accepted closeout enters the host wait');
      assert.match(parked.diagnostic,/Waiting for host/);
      store.putOperation({...parked,state:'failed',settledAt:now()});
    }
    assertUntouched(service,before);

    // A historical run of any role closes the never-dispatched boundary.
    store.putRun({id:'offline-history-run',taskId:before.id,role:'reviewer',generation:1,head:f.oldHead,base:f.planningCommit,
      agentId:'old-reviewer',workspaceId:before.workspaceId!,profile:f.reviewer,status:'finished',createdAt:now(),lastObservedAt:now(),
      active:false,idleSince:now(),completion:null,released:true});
    await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/outside that boundary/);
    assert.equal(store.task(before.id).version,before.version);
    assert.deepEqual(store.task(before.id).resolution.ownerAcceptances,[]);
    assert.equal(events(service,before.id,'owner_acceptance').length,0);

    // A direct engine call carries no authenticated invocation, so the
    // never-dispatched boundary is unreachable and the closeout refuses.
    await assert.rejects(runtime.engine.performTaskControl(closeout(service,{qualification:ACCEPTANCE})),/outside that boundary/);
    assert.deepEqual(store.task(before.id).resolution.ownerAcceptances,[]);
    assert.equal(store.task(before.id).version,before.version);
  }finally{await closeService(service);}
});

test('a task or workspace moved during the awaited proof refuses atomically',async()=>{
  // The bound external workspace moves after the forge observation, before the
  // commit. The observation is re-read synchronously immediately before it.
  {
    const service=await openService({paused:false});
    const {f,runtime,task}=service,store=runtime.store;
    try{
      const before=store.task(task.id);
      let pushed=false;
      f.state.onMerge=()=>{queueMicrotask(()=>{pushed=true;f.pushRevision('source pushed during the merge proof');});};
      await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/moved during the external merge proof|Task or run changed/);
      assert.equal(pushed,true,'the mutation landed after the forge observation, before the commit');
      f.state.onObserve=null;
      assertUntouched(service,before);
    }finally{f.state.onObserve=null;await closeService(service);}
  }
  // A dirty bound workspace is never read as the merged source.
  {
    const service=await openService({paused:false});
    const {f,runtime,task}=service,store=runtime.store;
    try{
      const before=store.task(task.id);
      writeFileSync(join(f.workspace,'uncommitted.txt'),'uncommitted\n');
      await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/workspace is dirty|moved during the external merge proof/);
      assertUntouched(service,before);
    }finally{await closeService(service);}
  }
  // The task itself changes during the proof: the guarded commit writes nothing.
  {
    const service=await openService({paused:false});
    const {f,runtime,task}=service,store=runtime.store;
    try{
      const before=store.task(task.id);
      let changed=false;
      f.state.onMerge=()=>{queueMicrotask(()=>{changed=true;store.update(before.id,{reason:'A concurrent note'});});};
      await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/Task or run changed during external merge verification|Task changed/);
      assert.equal(changed,true,'the mutation landed after the forge observation, before the commit');
      f.state.onObserve=null;
      const after=store.task(before.id);
      assert.deepEqual(after.resolution.ownerAcceptances,[]);
      assert.equal(after.resolution.mergedCommit,null);
      assert.equal(events(service,before.id,'external_merge_observed').length,0);
    }finally{f.state.onObserve=null;await closeService(service);}
  }
});

test('the preserved recorded source head survives the automatic external-merge recovery tick while a FIFO turn is held',async()=>{
  const service=await openService({paused:false});
  const {f,runtime,task,merged}=service,store=runtime.store;
  try{
    const before=store.task(task.id);
    // A same-repository task holding an EARLIER integration turn keeps this
    // closeout waiting in `merging` for another turn instead of going straight
    // to `syncing`, which is the state isolated fixtures never reached.
    const blocker=store.insert(submissionSchema.parse({submissionId:'earlier-integration',title:'Earlier integration',
      repoPath:f.repo,planningCommit:f.planningCommit,handoffPath:'docs/handoff.md',originAgentId:'origin'}),'host','handoff',f.planningCommit);
    const blockerTask=store.task(blocker.id);
    // The blocker holds integration turn 1 and is inert: its own retained
    // prerequisite wait lets no lifecycle step change its phase or attention, so
    // the FIFO state this test depends on cannot be raced by the same tick.
    const prereq=store.insert(submissionSchema.parse({submissionId:'integration-prereq',title:'Incomplete prerequisite',
      repoPath:f.repo,planningCommit:f.planningCommit,handoffPath:'docs/handoff.md',originAgentId:'origin'}),'host','handoff',f.planningCommit);
    store.update(prereq.id,{phase:'working',reason:'Unrelated work still in progress'});
    store.setMeta(`integrationTurnSeq:${f.repo}`,1);
    store.update(blocker.id,{phase:'verifying',reason:'Earlier task holds the repository integration turn',
      resolution:{...blockerTask.resolution,integrationTurn:{sequence:1,acceptedAt:now()}},
      prerequisiteWait:{id:randomUUID(),waitsFor:[prereq.id],reason:'Waiting for its retained prerequisite',releasedAt:null}});

    await runtime.taskControl(closeout(service,{qualification:ACCEPTANCE}));
    const waiting=store.task(task.id);
    assert.equal(waiting.phase,'merging','the closeout waits for the earlier integration turn');
    assert.equal(waiting.prHead,before.prHead);
    assert.equal(waiting.resolution.mergeHead,merged!.head);
    const recordedAtAccept=events(service,before.id,'external_merge_observed').length;
    assert.ok(recordedAtAccept>=1,'the accepted merge is recorded once');

    // The next engine tick probes external-merge recovery for every task that
    // occupies a slot, `merging` included.
    const resolution=runtime.engine.resolution as unknown as {recoverExternalMerge:(candidate:Task)=>Promise<boolean>};
    const original=resolution.recoverExternalMerge.bind(resolution);
    let probes=0;
    resolution.recoverExternalMerge=async(candidate:Task)=>{if(candidate.id===task.id)probes++;return original(candidate);};
    try{await runtime.engine.wake();}finally{resolution.recoverExternalMerge=original;}
    assert.ok(probes>0,'the recovery probe ran for the waiting closeout');

    const after=store.task(task.id);
    // The recovery re-records the merge but never re-decides the recorded head.
    assert.ok(events(service,before.id,'external_merge_observed').length>recordedAtAccept,
      'the probe re-recorded the observed merge for the waiting FIFO turn');
    assert.equal(after.prHead,before.prHead,'the recorded source head is preserved, not replaced by mergeHead');
    assert.equal(after.resolution.mergeHead,merged!.head);
    assert.equal(after.resolution.mergedCommit,merged!.mergeCommit);
    assert.equal(after.resolution.ownerAcceptances!.length,1);
    assert.equal(after.resolution.ownerAcceptances![0]!.head,merged!.head);
    assert.deepEqual(after.holds,before.holds,'both holds and their owners stand through the tick');
    assert.equal(after.resolution.review,null);
    assert.deepEqual(store.runs(task.id),[]);

    // A second tick and the ordinary FIFO claim still never move the recorded head.
    await runtime.engine.wake();
    assert.equal(store.task(task.id).prHead,before.prHead);
  }finally{await closeService(service);}
});

test('the real forge identity proof refuses every wrong canonical identity through the public route',async()=>{
  // Paused: the closeout applies while paused, and no lifecycle step runs on the
  // disposable fixture afterwards. The identity proof is the subject here.
  const service=await openService({paused:true,merge:false});
  const {f,runtime,task}=service,store=runtime.store;
  const forge=realForge(f);
  try{
    const before=store.task(task.id);
    const merged=f.mergeExternally('external source merged at a published descendant');
    service.merged=merged;
    const canonical=pullAnswer(f)(merged.head,{mergeCommit:merged.mergeCommit});
    const cases:{name:string;answer:unknown;refusal:RegExp}[]=[
      {name:'wrong repository',answer:{...canonical,head:{repo:{full_name:'other/repo'},ref:'feature/external',sha:merged.head},
        base:{repo:{full_name:'other/repo'},ref:'main'}},refusal:/External merge identity does not match the task repository and branches/},
      {name:'wrong branch',answer:pullAnswer(f)(merged.head,{mergeCommit:merged.mergeCommit,headRef:'feature/other'}),refusal:/External merge identity does not match the task repository and branches/},
      {name:'wrong base',answer:pullAnswer(f)(merged.head,{mergeCommit:merged.mergeCommit,baseRef:'release'}),refusal:/External merge identity does not match the task repository and branches/},
      {name:'PR head differs from the bound worktree',answer:pullAnswer(f)('a'.repeat(40),{mergeCommit:merged.mergeCommit}),refusal:/External merge head differs from recorded task work/},
      {name:'unmerged PR',answer:pullAnswer(f)(merged.head,{mergeCommit:merged.mergeCommit,merged:false}),refusal:/The task PR is not merged/},
      {name:'no exact merge commit',answer:pullAnswer(f)(merged.head,{mergeCommit:''}),refusal:/The task PR is not merged|did not name an exact merged head and commit/},
    ];
    for(const item of cases){
      forge.answer(item.answer);
      await forge.run(runtime,async()=>{
        await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),item.refusal,item.name);
      });
      assertUntouched(service,before);
    }
    // The same real proof accepts the genuine canonical merged identity, so the
    // refusals above are the identity checks and not a broken seam.
    forge.answer(canonical);
    await forge.run(runtime,async()=>{
      await runtime.taskControl(closeout(service,{qualification:ACCEPTANCE}));
    });
    const after=assertAcceptedCloseout(service,before);
    assert.equal(after.phase,'syncing','paused: the accepted merge waits at the synchronization step');
    assert.equal(after.resolution.ownerAcceptances!.length,1);
  }finally{await closeService(service);forge.close();}
});

test('only the task owner thread or a truthful authorized relay may record the acceptance',async()=>{
  // Paused: the verb applies while paused, so the authority proofs are the
  // subject and no lifecycle step runs on the disposable fixture.
  const service=await openService({paused:true});
  const {f,runtime,task}=service,store=runtime.store;
  try{
    const before=store.task(task.id);
    const project=store.projectFor(before.repoPath,normalizeRepositoryOrigin(before.repository??''))!;
    // An ordinary caller with an owner-sounding reason has no authority; a
    // caller claiming the retired project-owner role is refused like any other.
    await assert.rejects(runtime.taskControl(closeout(service,{caller:'stranger',qualification:ACCEPTANCE})),
      /needs the operator at the board or a relayed operator authorization note; stranger has none/);
    await assert.rejects(runtime.taskControl(closeout(service,{caller:f.owner,qualification:ACCEPTANCE})),
      /needs the operator at the board or a relayed operator authorization note/);
    assertUntouched(service,before);

    // A relay without its recorded operator note is refused before any proof.
    await assert.rejects(runtime.taskControl(closeout(service,{caller:'stranger',relayed:true,qualification:ACCEPTANCE})),
      /requires the recorded operator authorization note/);
    assertUntouched(service,before);

    // An unattributed caller is refused outright.
    await assert.rejects(runtime.taskControl(closeout(service,{caller: undefined, qualification:ACCEPTANCE})),
      /refuses an unattributed caller/);
    assertUntouched(service,before);

    // A relayed operator ruling with its note records the relay authority and
    // the acting caller, never a role it did not prove.
    const relayed=await runtime.taskControl(closeout(service,{caller:'relay-thread',relayed:true,
      note:'Operator relay 96991948 accepted this exact final head post hoc',qualification:ACCEPTANCE})) as Task;
    const acceptance=relayed.resolution.ownerAcceptances!.at(-1)!;
    assert.equal(acceptance.actor.agentId,'relay-thread');
    assert.equal(acceptance.actor.role,'authorized_relay');
    assert.equal(acceptance.authority.kind,'relayed_note');
    assert.match(acceptance.authority.note!,/96991948/);
    assert.equal(relayed.prHead,before.prHead);

    // The operator at the board records the operator authority on its own task.
    const second=await openService({paused:true,key:'operator-board-intake'});
    try{
      const control=taskControlInputSchema.parse({taskId:second.task.id,version:second.runtime.store.task(second.task.id).version,
        action:'move',to:'closeout',reason:'The board accepts the merged external source head',caller:OPERATOR_BOARD_CALLER,
        qualification:ACCEPTANCE});
      const moved=await second.runtime.taskControl(control) as Task;
      const record=moved.resolution.ownerAcceptances!.at(-1)!;
      assert.equal(record.actor.agentId,OPERATOR_BOARD_CALLER);
      assert.equal(record.actor.role,'operator');
      assert.equal(record.authority.kind,'operator');
    }finally{await closeService(second);}
  }finally{await closeService(service);}
});

test('an unsettled intake still refuses and unrelated queued work is never touched',async()=>{
  // Paused: the closeout applies while paused and no lifecycle step races the
  // neighbour comparison.
  const service=await openService({paused:true});
  const {f,runtime,task}=service,store=runtime.store;
  try{
    const before=store.task(task.id);
    // An unrelated queued worker task in the same repository is a neighbour, not
    // an owner and not a casualty of this closeout.
    const neighbour=store.insert(submissionSchema.parse({submissionId:'queued-neighbour',title:'Queued neighbour',
      repoPath:f.repo,planningCommit:f.planningCommit,handoffPath:'docs/handoff.md',originAgentId:'origin'}),'host','handoff',f.planningCommit);
    store.update(neighbour.id,holdPatch(store.task(neighbour.id),'dispatch','effigy-root','Unrelated queued work that must not dispatch'));
    const neighbourBefore=store.task(neighbour.id);

    // The intake operation is still in flight: provenance is not settled.
    const intake=store.operation(before.reviewEntry!.operationId)!;
    store.putOperation({...intake,state:'running',settledAt:null});
    await assert.rejects(runtime.taskControl(closeout(service,{qualification:ACCEPTANCE})),/outside that boundary|Only an unmerged dispatched task/);
    assertUntouched(service,before);
    store.putOperation({...intake,state:'succeeded',settledAt:now()});

    // With the intake settled the closeout applies, and the queued neighbour is
    // untouched: no merge, no acceptance, no run, same phase and reason.
    await runtime.taskControl(closeout(service,{qualification:ACCEPTANCE}));
    assertAcceptedCloseout(service,before);
    const neighbourAfter=store.task(neighbour.id);
    assert.deepEqual(neighbourAfter,neighbourBefore,'an unrelated queued task is not changed by the closeout');
    assert.deepEqual(store.runs(neighbour.id),[]);
  }finally{await closeService(service);}
});
