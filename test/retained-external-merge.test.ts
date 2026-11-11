import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Task } from '../shared/contracts';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { participantToolRunIds } from '../core/resolution';
import { fixture, git } from './support/retained-external-merge-fixture';
import { ownerEffectHook } from './support/review-entry-fixture';
import { longToolHistory, toolTimelineTail } from './support/tool-timeline';

test('authenticated move records the observed descendant and preserves the dispatched source and receipt', {timeout:90000}, async()=>{
  const f=await fixture(true,true); try{
    const before=f.runtime.store.task(f.taskId), runs=f.runtime.store.runs(f.taskId), tree=git(f.workspace,'rev-parse','HEAD^{tree}');
    const index=git(f.workspace,'write-tree'), indexPath=resolve(f.workspace,git(f.workspace,'rev-parse','--git-path','index'));
    const indexBytes=readFileSync(indexPath), branch=git(f.workspace,'branch','--show-current');
    const view=ownerTaskNext(collectOwnerVerbFacts(f.runtime.store,before)).verbs.find(v=>v.verb==='move' && v.args?.to==='closeout');
    assert.deepEqual(view?.fill,['reason']);
    assert.deepEqual(view?.qualifyingFill,['qualification','head'],'the descendant pair is offered beside the reason-only closeout');
    assert.match(view?.note??'',/needs qualification and that exact final head together/);
    const control=f.control(), result=await f.runtime.taskControl(control) as Task;
    assert.equal(result.resolution.mergeHead,f.final); assert.equal(result.resolution.mergedCommit,f.mergeCommit);
    assert.equal(result.prHead,f.head); assert.equal(result.resolution.ownerAcceptances.at(-1)?.head,f.final);
    assert.equal(result.resolution.ownerAcceptances.at(-1)?.kind,'operator_source');
    assert.deepEqual(result.completion,before.completion); assert.deepEqual(result.resolution.review,before.resolution.review);
    assert.equal(before.resolution.review?.status,'changes_required');
    assert.equal(before.proofExecutions[0]?.status,'passed');
    assert.deepEqual(result.proofExecutions,before.proofExecutions);
    for(const run of runs){
      const after=f.runtime.store.run(run.id)!;
      if(run.released)assert.deepEqual(after,run);
      else {assert.equal(after.released,true);assert.equal(after.status,'superseded');assert.deepEqual(after.completion,run.completion);}
    }
    assert.equal(git(f.workspace,'rev-parse','HEAD'),f.head);assert.equal(git(f.workspace,'rev-parse','HEAD^{tree}'),tree);
    assert.deepEqual(readFileSync(indexPath),indexBytes);
    assert.equal(git(f.workspace,'write-tree'),index);assert.equal(git(f.workspace,'branch','--show-current'),branch);
    assert.equal(git(f.workspace,'status','--porcelain'),'');
    await f.runtime.taskControl(control);
    assert.equal(f.runtime.store.task(f.taskId).resolution.ownerAcceptances.length,1);
    assert.equal(f.counts().mergeCalls,0);
  }finally{await f.close();}
});

test('the planning thread is not polled during retained closeout', {timeout:90000}, async()=>{
  const f=await fixture(true,true); try{
    const adapter=f.adapter, observe=adapter.observe.bind(adapter), timeline=adapter.agentTimelinePage;
    const ownerHistory=longToolHistory(10801);
    ownerHistory.push({timestamp:new Date().toISOString(),item:{type:'tool_call',callId:'submit',name:'exec',status:'running'}});
    const current=f.runtime.store.task(f.taskId);
    f.runtime.store.update(current.id,{coordinatorAgentId:'busy-coordinator',resolution:{...current.resolution,coordinatorWorkspaceId:'coordinator-workspace'}});
    let reads=0,observations=0;
    adapter.observe=async id=>{if(id==='owner'||id==='busy-coordinator'){observations++;return {id,workspaceId:'owner-workspace',status:'running',active:true,permissions:true,error:''};}return observe(id);};
    if(timeline) adapter.agentTimelinePage=async (...args)=>{if(args[0]==='owner'||args[0]==='busy-coordinator'){reads++;return toolTimelineTail(ownerHistory,args[1]??200);}return timeline.apply(adapter,args);};
    const result=await f.runtime.taskControl(f.control()) as Task;
    assert.equal(result.resolution.mergeHead,f.final);
    assert.equal(reads,0);assert.equal(observations,0);
  }finally{await f.close();}
});

test('an owner who is also the bound worker remains an execution participant', {timeout:90000}, async()=>{
  const f=await fixture();try{
    const store=f.runtime.store,task=store.task(f.taskId),project=store.projectFor(task.repoPath,task.repository!)!;
    store.setProjectPlanner({key:project.key,agentId:task.agentId!,setBy:'test',note:'Worker also plans the project'});
    const before=store.task(task.id);
    f.setTool();
    await assert.rejects(f.runtime.taskControl(f.control()),/live or unknown tool effects/);
    assert.deepEqual(store.task(task.id),before);
  }finally{await f.close();}
});

// effigy#524 (task 5766f0ad): Codex left the parent's `[Sub-agent]` call running
// after the turn that started it completed, so the idle author read as holding an
// owned tool for ever. The turn is over and the call cannot outlive it.
test('a sub-agent call left running by a finished turn does not fence the external acceptance', {timeout:90000}, async()=>{
  const f=await fixture(true,true);try{
    f.setTool({type:'tool_call',callId:'left-behind',name:'Sub-agent',status:'running',detail:{type:'sub_agent',description:'Review the diff',log:''}});
    const result=await f.runtime.taskControl(f.control()) as Task;
    assert.equal(result.resolution.mergeHead,f.final,'the idle author holds no live tool once its turn is over');
    assert.equal(f.counts().mergeCalls,0);
  }finally{await f.close();}
});

// The same seam still refuses the tool kinds that genuinely outlive a turn: a
// background shell is a process the finished turn detached.
test('a background shell left by a finished turn still fences the external acceptance', {timeout:90000}, async()=>{
  const f=await fixture(true,true);try{
    const store=f.runtime.store,before=store.task(f.taskId);
    f.adapter.noLiveWorkspaceProcesses=async()=> 'process 123 remains in the task workspace process tree';
    f.setTool({type:'tool_call',callId:'left-behind',name:'Bash',status:'running',detail:{type:'shell',command:'effigy qa'}});
    await assert.rejects(f.runtime.taskControl(f.control()),/live or unknown tool effects: an owned tool is still live: observed tool Bash \(shell\) is running; process 123 remains in the task workspace process tree/);
    assert.deepEqual(store.task(f.taskId),before);
  }finally{await f.close();}
});

test('an idle pi-style participant with a stale shell item settles after a no-process proof', {timeout:90000}, async()=>{
  const f=await fixture(true,true);try{
    const task=f.runtime.store.task(f.taskId);
    const checkedRunIds:string[][]=[];
    f.adapter.noLiveWorkspaceProcesses=async(_workspaceId,runIds)=>{checkedRunIds.push([...runIds]);return null;};
    f.setTool({type:'tool_call',callId:'left-behind',name:'Bash',status:'running',detail:{type:'shell',command:'effigy qa'}});
    const result=await f.runtime.taskControl(f.control()) as Task;
    assert.equal(result.resolution.mergeHead,f.final);
    assert.ok(task.runId && checkedRunIds.some(runIds=>runIds.includes(task.runId!)),'initial task-row run identity is included in the process proof');
  }finally{await f.close();}
});

test('retired worker process proofs include their task-row run identity',()=>{
  const task={agentId:'current',workspaceId:'workspace',runId:'current-run',retiredWorkers:[{agentId:'retired',runId:'retired-run'}]} as unknown as Task;
  assert.deepEqual(participantToolRunIds(task,[],'retired','workspace'),['retired-run']);
});

for(const role of ['reviewer','executor'] as const) test(`a released ${role} with a live tool still fences closeout`, {timeout:90000}, async()=>{
  const f=await fixture(true,true);try{
    const store=f.runtime.store, before=store.task(f.taskId), run=store.runs(f.taskId).find(item=>item.role===role)!;
    assert.ok(run.released && run.agentId);
    const adapter=f.adapter, timeline=adapter.agentTimelinePage!;
    adapter.agentTimelinePage=async (...args)=>args[0]===run.agentId
      ? toolTimelineTail([{timestamp:new Date().toISOString(),item:{type:'tool_call',callId:'live',name:'exec',status:'running'}}],200)
      : timeline.apply(adapter,args);
    await assert.rejects(f.runtime.taskControl(f.control()),/live or unknown tool effects/);
    assert.deepEqual(store.task(f.taskId),before);
  }finally{await f.close();}
});

test('a transaction failure rolls back merge, acceptance and run settlement together', {timeout:90000}, async()=>{
  const f=await fixture(true);try{
    const store=f.runtime.store, before=store.task(f.taskId), events=store.eventsAll(f.taskId), runs=store.runs(f.taskId);
    assert.ok(runs.some(run=>!run.released),'the move has a real revision lease to settle');
    const original=store.event.bind(store);
    store.event=((id:string,kind:string,detail:string)=>{if(kind==='external_merge_head_accepted')throw Error('injected commit refusal');return original(id,kind,detail);}) as typeof store.event;
    try{await assert.rejects(f.runtime.taskControl(f.control()),/injected commit refusal/);}finally{store.event=original;}
    assert.deepEqual(store.task(f.taskId),before);
    assert.deepEqual(store.runs(f.taskId),runs);
    assert.equal(store.eventsAll(f.taskId).filter(e=>e.kind==='owner_acceptance').length,events.filter(e=>e.kind==='owner_acceptance').length);
  }finally{await f.close();}
});
