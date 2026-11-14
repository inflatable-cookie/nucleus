import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core/store/store';
import {submissionSchema,runSchema,noticeSchema} from '../shared/contracts';
import {hookRecordSchema} from '../shared/hooks';
import {createTaskDetailCache} from '../core/telemetry/task-detail';
const head='a'.repeat(40),at='2026-09-01T00:00:00.000Z';
const add=(store:Store,id:string,dependsOn:string[]=[])=>store.insert(submissionSchema.parse({submissionId:id,title:id,repoPath:'/fixture',planningCommit:head,handoffPath:`${id}.md`,originAgentId:'origin',dependsOn}),'host','handoff',head);

test('detail cache scopes invalidation, keeps dependencies fresh and bounds clock staleness',()=>{
 const store=new Store(':memory:');let clock=Date.now();
 try{
  const dependency=add(store,'dependency'),task=add(store,'selected',[dependency.id]);
  let reads=0;const events=store.eventsAll.bind(store);store.eventsAll=id=>{reads++;return events(id);};
  const read=createTaskDetailCache(store,{now:()=>clock});const first=read(task.id);
  store.event(dependency.id,'state','unrelated evidence');store.update(dependency.id,{phase:'done'});
  const second=read(task.id);assert.equal(reads,1);assert.equal(second.dependencies[0].phase,'done');assert.equal(second.telemetry.generatedAt,first.telemetry.generatedAt);
  clock+=15000;assert.notEqual(read(task.id).telemetry.generatedAt,first.telemetry.generatedAt);assert.equal(reads,2);
  store.event(task.id,'fixture','new evidence');assert.equal(read(task.id).events[0].kind,'fixture');assert.equal(reads,3);
  store.update(task.id,{reason:'new reason'});assert.equal(read(task.id).task.reason,'new reason');assert.equal(reads,4);
  store.putRun(runSchema.parse({id:'run',taskId:task.id,role:'reviewer',generation:1,head,base:head,agentId:null,workspaceId:'workspace',profile:null,status:'running',createdAt:at,lastObservedAt:null,active:null,idleSince:null,completion:null,released:false}));
    assert.equal(read(task.id).runs.length,1);assert.equal(reads,5);
    assert.equal(read(task.id).missingResult,null);
  store.putNotice(noticeSchema.parse({id:'notice',taskId:task.id,agentId:'origin',kind:'attention',status:'pending',error:'',text:'attention'}));
  assert.equal(read(task.id).notices.length,1);assert.equal(reads,6);
  store.putHookEvent(hookRecordSchema.parse({id:'hook',taskId:task.id,hookId:'generic',event:'task.closeout',eventId:'b'.repeat(48),occurrence:1,mode:'integration_write',delivery:'required',state:'intent',manifest:{path:'.paseo/queue.json',commit:head,digest:`sha256:${'b'.repeat(64)}`},executable:{path:'.paseo/hook',commit:head,digest:`sha256:${'c'.repeat(64)}`},instruction:null,baseBranch:'main',baseCommit:head,attempt:1,argv:[],timeoutMs:1000,maxOutputBytes:1024,allowedPaths:['docs/'],commitSubject:{prefix:'hook',maxBytes:80},eventDigest:'d'.repeat(64),eventPayload:null,workspace:null,processId:null,result:null,commit:null,remote:null,summary:'',error:'',reconciledAt:null,createdAt:at,updatedAt:at}));
  assert.equal(read(task.id).hooks.length,1);assert.equal(reads,7);
  const accepted=store.acceptOperation({key:'control',kind:'task_control',inputHash:'a'.repeat(64),taskId:task.id,payload:{}});assert.ok('accepted' in accepted);
  assert.equal(read(task.id).operations.length,1);assert.equal(reads,8);
  if('accepted' in accepted)store.putOperation({...accepted.operation,state:'succeeded',settledAt:at});
  assert.equal(read(task.id).operations[0].state,'succeeded');assert.equal(reads,9);
  assert.throws(()=>store.transaction(()=>{store.update(task.id,{reason:'rolled back'});assert.equal(read(task.id).task.reason,'rolled back');throw Error('rollback');}),/rollback/);
  assert.equal(read(task.id).task.reason,'new reason');assert.equal(reads,11);
 }finally{store.close();}
});

test('detail evidence cache ignores unrelated operation acceptance and reloads on its own event',()=>{
 const store=new Store(':memory:');
 try{
  const task=add(store,'selected');let reads=0;const events=store.eventsAll.bind(store);
  store.eventsAll=id=>{reads++;return events(id);};
  const read=createTaskDetailCache(store);
  read(task.id);assert.equal(reads,1);
  const accepted=store.acceptOperation({key:'unrelated-acceptance',kind:'submit',inputHash:'a'.repeat(64),payload:{}});
  assert.ok('accepted' in accepted);
  read(task.id);assert.equal(reads,1,'unrelated acceptance must reuse selected-task evidence');
  store.event(task.id,'fixture','selected task changed');
  read(task.id);assert.equal(reads,2,'the selected task event must invalidate its cached evidence');
 }finally{store.close();}
});

test('detail cache evicts old selections and refuses oversized entries',()=>{
 const store=new Store(':memory:');
 try{
  const one=add(store,'one'),two=add(store,'two');let reads=0;const events=store.eventsAll.bind(store);store.eventsAll=id=>{reads++;return events(id);};
  const read=createTaskDetailCache(store,{maxEntries:1});read(one.id);read(one.id);assert.equal(reads,1);read(two.id);read(one.id);assert.equal(reads,3);
  const small=createTaskDetailCache(store,{maxBytes:1});small(one.id);small(one.id);assert.equal(reads,5);
 }finally{store.close();}
});

test('task detail exposes the derived hold kind without replacing the queued reason',()=>{
 const store=new Store(':memory:');
 try{
  const ordinary=add(store,'ordinary'),prerequisite=add(store,'prerequisite'),merge=add(store,'merge',[prerequisite.id]),gated=add(store,'gated'),dispatched=add(store,'dispatched');
  store.update(ordinary.id,{held:true,mergeHold:false,reason:'Waiting for a dispatch slot'});
  store.update(merge.id,{held:true,mergeHold:true,reason:'Waiting for prerequisites'});
  store.update(gated.id,{held:true,mergeHold:true,reason:'Waiting for the fixture gate'});
  store.update(dispatched.id,{phase:'working',held:true,mergeHold:false});
  const read=createTaskDetailCache(store);
  assert.equal(read(ordinary.id).task.holdKind,'dispatch');
  const mergeDetail=read(merge.id);
  assert.equal(mergeDetail.task.holdKind,'merge');
  // #1001: prerequisite text is derived from the live dependency, and a reason Nucleus does not derive stays.
  assert.match(mergeDetail.task.reason,/^Waiting for prerequisites:/);
  assert.equal(read(gated.id).task.reason,'Waiting for the fixture gate');
  assert.equal(read(dispatched.id).task.holdKind,'merge');
  assert.equal('holdKind' in read(add(store,'unheld').id).task,false);
 }finally{store.close();}
});
