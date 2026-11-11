import {test} from "node:test";
import assert from "node:assert/strict";
import {rmSync} from "node:fs";
import {join} from "node:path";
import {reviewEntryInputSchema,submissionSchema,type Task} from "../shared/contracts";
import {Store,now} from "../core/store/store";
import {queueOperationSchema} from "../shared/operations";
import {holdPatch} from "../core/merge/merge-hold";
import {bindReviewEntry} from "../core/review/review-entry";
import {Engine} from "../core/engine";
import type {Adapter} from "../core/host";
import {approveBrief,base,head,ownerEffectHook,queueHeldBriefFixture,record} from './support/review-entry-fixture';

const INTAKE_OPERATION='e'.repeat(64);

/**
 * A supported review-entry admission: an existing external PR and workspace are
 * verified and bound, the task is queued with zero runs, Queue is paused and both
 * holds stand. Returns the fixture so the test can assert nothing else moved.
 */
async function admittedReviewEntry(){
  const fixture=queueHeldBriefFixture(),store=new Store(join(fixture.root,'queue.sqlite'));
  try{
    approveBrief(store,fixture);
    store.setMeta('paused',true);
    const input=reviewEntryInputSchema.parse({...fixture.reviewInput,workspaceMode:'isolated'});
    const operation=queueOperationSchema.parse({id:INTAKE_OPERATION,key:'review-entry-dependencies',kind:'review_entry',inputHash:'d'.repeat(64),
      state:'running',taskId:null,expectedVersion:null,repoPath:fixture.repo,submissionId:input.submission.submissionId,createdAt:now(),startedAt:now(),
      settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
    const bound=await bindReviewEntry(store,fixture.adapter,operation,input);
    // The real service settles the intake operation as succeeded; this store has no
    // operation loop, so its settled metadata is recorded the same way.
    store.putOperation({...store.operation(INTAKE_OPERATION)!,state:'succeeded',settledAt:now()});
    store.update(bound.id,holdPatch(store.task(bound.id),'dispatch','operator','Root dispatch hold before the first run'));
    store.update(bound.id,holdPatch(store.task(bound.id),'merge','owner','Owner merge hold before the first run'));
    const engine=new Engine(store,fixture.adapter as unknown as Adapter,0);
    return {fixture,store,engine,task:store.task(bound.id)};
  }catch(error){store.close();rmSync(fixture.root,{recursive:true,force:true});throw error;}
}

/** Add a prerequisite (or dependent) task through the ordinary queue entry point. */
function addTask(store:Store,repoPath:string,planningCommit:string,submissionId:string,dependsOn:string[]=[],phase:Task["phase"]="queued"){
  return store.insert(submissionSchema.parse({submissionId,title:submissionId,repoPath,planningCommit,handoffPath:'docs/handoff.md',originAgentId:'origin',dependsOn}),
    'host','fixture handoff',planningCommit,{phase},undefined,'example/repo');
}

/** A queued review-entry row shaped exactly like a bound admission, without a store operation loop. */
function reviewEntryShape(store:Store,submissionId:string){
  return store.insert(submissionSchema.parse({submissionId,title:'External PR',repoPath:'/repo',planningCommit:base,handoffPath:'docs/handoff.md',originAgentId:'origin'}),
    'host','fixture handoff',base,{entrypoint:'review',reviewEntry:record(),workspaceId:'workspace',directory:'/worktree',
      branch:'feature/external',workspaceIntent:true,resumePrNumber:41,prHead:head,prUrl:'https://github.com/example/repo/pull/41'},undefined,'example/repo');
}

function operation(store:Store,id:string,taskId:string,state:"pending"|"running"|"succeeded"){
  const existing=store.operation(id);
  const record=queueOperationSchema.parse({id,key:`review-entry-dependency-${id}`,kind:'task_control',inputHash:'a'.repeat(64),state,
    taskId,expectedVersion:null,repoPath:'/repo',submissionId:null,createdAt:now(),startedAt:now(),settledAt:null,attempts:1,diagnostic:'',result:null,effect:null});
  store.putOperation(existing?{...record,createdAt:existing.createdAt}:record);
  return record;
}

test('a queued review-entry task bound to an external workspace corrects prerequisites before its first run',async()=>{
  const f=await admittedReviewEntry();
  try{
    const {store,engine,fixture}=f,before={...f.task};
    assert.equal(before.phase,'queued');assert.equal(before.workspaceId,before.reviewEntry?.workspaceId);
    assert.equal(before.workspaceId,'isolated-workspace');assert.equal(before.reviewEntry?.dispatchBase,null);
    assert.deepEqual(store.runs(before.id),[]);assert.equal(store.getMeta('paused'),true);
    assert.equal(before.held,true);assert.equal(before.mergeHold,true);
    const prerequisite=addTask(store,fixture.repo,fixture.planningCommit,'review-entry-prerequisite');

    // Mechanism-revert falsification: with the review-entry proof removed (main's
    // condition alone) this same-task correction refuses with the reported message.
    const patchable=store as unknown as Record<string,unknown>,original=patchable.reviewEntryBeforeFirstRun;
    patchable.reviewEntryBeforeFirstRun=()=>false;
    try{
      await assert.rejects(engine.performTaskControl({taskId:before.id,version:before.version,action:'set_dependencies',dependsOn:[prerequisite.id],caller:'owner-thread'}),
        /Dependencies can only change before dispatch begins/);
    }finally{patchable.reviewEntryBeforeFirstRun=original;}
    assert.equal(store.task(before.id).version,before.version);
    assert.deepEqual(store.task(before.id).dependsOn,[]);

    await engine.performTaskControl({taskId:before.id,version:before.version,action:'set_dependencies',dependsOn:[prerequisite.id],caller:'owner-thread'});
    const after=store.task(before.id);
    assert.deepEqual(after.dependsOn,[prerequisite.id]);assert.match(after.reason,/Waiting for prerequisites/);
    assert.equal(after.version,before.version+1);

    // Task, PR, head, workspace, source, brief approval, author declaration and holds stay exact.
    assert.equal(after.id,before.id);assert.equal(after.number,before.number);assert.equal(after.reference,before.reference);assert.equal(after.title,before.title);
    assert.equal(after.prUrl,before.prUrl);assert.equal(after.prHead,before.prHead);assert.equal(after.resumePrNumber,before.resumePrNumber);
    assert.equal(after.workspaceId,before.workspaceId);assert.equal(after.directory,before.directory);assert.equal(after.branch,before.branch);
    assert.equal(after.planningCommit,before.planningCommit);assert.equal(after.planningBase,before.planningBase);assert.equal(after.handoffText,before.handoffText);
    assert.deepEqual(after.reviewEntry,before.reviewEntry);
    assert.deepEqual(after.reviewEntry?.authorDeclaration,before.reviewEntry?.authorDeclaration);
    assert.equal(after.reviewEntry?.briefDigest,fixture.approval.digest);assert.equal(after.reviewEntry?.briefVersion,1);
    assert.deepEqual(after.brief,before.brief);assert.deepEqual(after.briefVersions,before.briefVersions);
    assert.deepEqual(after.holds,before.holds);assert.equal(after.held,true);assert.equal(after.mergeHold,true);
    assert.equal(after.holdOwner,before.holdOwner);assert.equal(after.holdReason,before.holdReason);assert.equal(after.holdGeneration,before.holdGeneration);
    assert.equal(after.holdUntil,before.holdUntil);assert.equal(after.phase,'queued');
    assert.equal(after.agentId,null);assert.equal(after.runId,null);assert.equal(after.completion,null);
    const unexpected=Object.keys(after).filter(key=>!['dependsOn','reason','version','updatedAt','lastSubstantiveVersion'].includes(key)
      && JSON.stringify(after[key as keyof Task])!==JSON.stringify(before[key as keyof Task]));
    assert.deepEqual(unexpected,[]);

    // No run started and the operator's pause is untouched.
    assert.deepEqual(store.runs(before.id),[]);assert.equal(store.getMeta('paused'),true);
    const audit=store.events(before.id).find(event=>event.kind==='dependencies_changed');
    assert.match(audit!.detail,new RegExp(`none → ${prerequisite.id}; requested by operator control`));
    assert.ok(store.events(before.id).some(event=>event.kind==='owner_control'));

    // The same task also accepts the changed valid set and clearing it again.
    await engine.performTaskControl({taskId:after.id,version:after.version,action:'set_dependencies',dependsOn:[],caller:'owner-thread'});
    const cleared=store.task(before.id);
    assert.deepEqual(cleared.dependsOn,[]);assert.equal(cleared.reason,'Waiting for dispatch');assert.equal(cleared.phase,'queued');
    assert.deepEqual(cleared.reviewEntry,before.reviewEntry);assert.deepEqual(cleared.holds,before.holds);assert.deepEqual(store.runs(before.id),[]);
    assert.equal(store.getMeta('paused'),true);
  }finally{await f.engine.stop();f.store.close();rmSync(f.fixture.root,{recursive:true,force:true});}
});

test('dependency-list refusals stay atomic on a queued review-entry task',async()=>{
  const f=await admittedReviewEntry();
  try{
    const {store,engine,fixture}=f,task=store.task(f.task.id);
    const dependent=addTask(store,fixture.repo,fixture.planningCommit,'review-entry-dependent',[task.id]);
    const removed=addTask(store,fixture.repo,fixture.planningCommit,'review-entry-removed');
    store.update(removed.id,{removedAt:now(),phase:'cancelled',reason:'Removed before completion'});
    const cases:Array<[string,string[],RegExp]>= [
      ['self',[task.id],/depend on itself/],
      ['missing',['missing-task'],/does not exist/],
      ['cycle',[dependent.id],/cycle/],
      ['removed',[removed.id],/removed before completion/],
    ];
    for(const [name,dependsOn,refusal] of cases){
      const current=store.task(task.id),events=store.events(task.id).length;
      await assert.rejects(engine.performTaskControl({taskId:task.id,version:current.version,action:'set_dependencies',dependsOn,caller:'owner-thread'}),
        refusal,`${name} must refuse`);
      const unchanged=store.task(task.id);
      assert.equal(unchanged.version,current.version,`${name} must write nothing`);
      assert.deepEqual(unchanged.dependsOn,current.dependsOn,`${name} must leave dependencies alone`);
      assert.equal(store.events(task.id).length,events,`${name} must write no task event`);
    }
    const stale=store.task(task.id);
    await assert.rejects(engine.performTaskControl({taskId:task.id,version:stale.version-1,action:'set_dependencies',dependsOn:[],caller:'owner-thread'}),/Task changed/);
    assert.equal(store.task(task.id).version,stale.version);
    assert.equal(store.getMeta('paused'),true);assert.deepEqual(store.runs(task.id),[]);
  }finally{await f.engine.stop();f.store.close();rmSync(f.fixture.root,{recursive:true,force:true});}
});

test('any run, agent, completion, merge or pending side-effect intent still fences the correction',()=>{
  const store=new Store(':memory:');
  try{
    // The settled intake operation is provenance, not execution.
    const baseline=reviewEntryShape(store,'review-entry-baseline');
    assert.equal(store.updateDependencies(baseline,[]).version,baseline.version);

    const historicalRun=reviewEntryShape(store,'review-entry-run');
    store.putRun({id:'old-reviewer-run',taskId:historicalRun.id,role:'reviewer',generation:1,head,base:head,agentId:'old-reviewer',workspaceId:'workspace',profile:null,
      status:'superseded',createdAt:now(),lastObservedAt:null,active:false,idleSince:null,completion:null,released:true});
    const completed=reviewEntryShape(store,'review-entry-completion');
    const completion={eventId:'old-review-event',taskId:completed.id,runId:'old-review-run',status:'ready_to_merge' as const,summary:'Old approval',head};
    const reviewed=reviewEntryShape(store,'review-entry-review');
    const merging=reviewEntryShape(store,'review-entry-merge');
    const agentBound=reviewEntryShape(store,'review-entry-agent');
    const runBound=reviewEntryShape(store,'review-entry-run-id');
    const admitted=reviewEntryShape(store,'review-entry-dispatch-base');
    const otherWorkspace=reviewEntryShape(store,'review-entry-other-workspace');
    const hooked=reviewEntryShape(store,'review-entry-hook');
    const operated=reviewEntryShape(store,'review-entry-operation');
    const intake=reviewEntryShape(store,'review-entry-intake');
    const cases:Array<[string,Task,() => void,RegExp]> = [
      ['a released historical run',historicalRun,()=>{},/before dispatch begins/],
      ['a recorded completion',completed,()=>store.update(completed.id,{completion}),/before dispatch begins/],
      ['accepted review credit',reviewed,()=>store.update(reviewed.id,{resolution:{...reviewed.resolution,review:completion}}),/before dispatch begins/],
      ['merge intent',merging,()=>store.update(merging.id,{resolution:{...merging.resolution,mergeIntent:true,mergeHead:head}}),/before dispatch begins/],
      ['a bound agent',agentBound,()=>store.update(agentBound.id,{agentId:'worker-agent',agentIntent:true}),/before dispatch begins/],
      ['a retained run ID',runBound,()=>store.update(runBound.id,{runId:'worker-run'}),/before dispatch begins/],
      ['a review admission',admitted,()=>store.update(admitted.id,{reviewEntry:{...admitted.reviewEntry!,dispatchBase:head}}),/before dispatch begins/],
      ['a workspace the intake did not bind',otherWorkspace,()=>store.update(otherWorkspace.id,{workspaceId:'other-workspace'}),/before dispatch begins/],
      ['an outstanding hook delivery',hooked,()=>store.putHookEvent(ownerEffectHook(hooked,'uncertain')),/before dispatch begins/],
      ['another unfinished operation',operated,()=>{operation(store,'1'.repeat(64),operated.id,'running');},/before dispatch begins/],
      ['an unsettled intake operation',intake,()=>{operation(store,intake.reviewEntry!.operationId,intake.id,'running');},/before dispatch begins/],
    ];
    for(const [name,task,mutate,refusal] of cases){
      mutate();
      const current=store.task(task.id),events=store.events(task.id).length;
      assert.throws(()=>store.updateDependencies(current,[]),refusal,`${name} must refuse`);
      assert.equal(store.task(task.id).version,current.version,`${name} must write nothing`);
      assert.equal(store.events(task.id).length,events,`${name} must write no task event`);
    }
    // A settled intake operation stays provenance: the same task accepts the change.
    operation(store,intake.reviewEntry!.operationId,intake.id,'succeeded');
    assert.equal(store.updateDependencies(store.task(intake.id),[]).version,intake.version);
    // A settled hook is history too; the baseline shape stays editable while it
    // has no run and no dispatch.
    store.putHookEvent(ownerEffectHook(hooked,'published'));
    assert.equal(store.updateDependencies(store.task(hooked.id),[]).version,hooked.version);

    // An ordinary worker-created workspace stays immutable.
    const worker=addTask(store,'/repo',base,'worker-created-workspace');
    store.update(worker.id,{workspaceIntent:true,workspaceId:'wks_0123456789abcdef',directory:'/worktree'});
    const workerVersion=store.task(worker.id).version;
    assert.throws(()=>store.updateDependencies(store.task(worker.id),[]),/before dispatch begins/);
    assert.equal(store.task(worker.id).version,workerVersion);
  }finally{store.close();}
});
