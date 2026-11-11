import { formatAgentId } from '../shared/agent-identity';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../core/engine';
import {Store,digest} from '../core/store/store';
import {completionMembership,holdOwnerOf,holdsOf,QUEUE_REPOSITORY_ORIGIN,reparentResultSchema,submissionSchema,taskControlInputSchema,TASK_OWNER_HOLD,taskOwner,type Notice} from '../shared/contracts';
import type {Adapter,OriginAgent} from '../core/host';

/**
 * Spec 040 (Tom, 2026-10-26): "There should be one owner field so reparenting is
 * a single change". A task's owner is `notificationAgentId`; owner-placed holds,
 * origin notices and the creator's own completion nomination all resolve through
 * it, so one write per task moves every responsibility, with no preflight and no
 * proof that the old owner is still alive.
 */
const commit='a'.repeat(40);
const QUEUE_LIVE_KEY=`repo-${digest(QUEUE_REPOSITORY_ORIGIN).slice(0,20)}`;
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ns-task-owner-')),store=new Store(join(dir,'queue.sqlite'));
 const agents=new Map<string,OriginAgent>([
  ['old',{id:'old',workspaceId:'planning',title:'Chatterbox',archived:true}],
  ['new',{id:'new',workspaceId:'planning-2',title:'Chatterbox',archived:false}],
  ['live-old',{id:'live-old',workspaceId:'planning',title:'Chatterbox',archived:false}],
  ['other-planner',{id:'other-planner',workspaceId:'planning',title:'Chatterbox',archived:false}],
  ['worker',{id:'worker',workspaceId:'planning',title:'Worker',archived:false}],
 ]);
 const notified:{agentId:string;noticeId:string}[]=[];
 const adapter={profiles:async()=>[],originAgent:async(id:string)=>agents.get(id)??null,
  observe:async(id:string)=>({id,workspaceId:agents.get(id)?.workspaceId??'planning',status:'idle',active:false,permissions:false,error:''}),
  notify:async(agentId:string,noticeId:string)=>{notified.push({agentId,noticeId})}} as unknown as Adapter;
 const engine=new Engine(store,adapter,0);store.setMeta('paused',false);
 engine.identifyOriginHost=async()=> 'host';
 store.upsertProject({key:'project-c',name:'Project-C',repositories:[{origin:null,path:'/repo'}]});
 store.upsertProject({key:'other-app',name:'Other',repositories:[{origin:null,path:'/other-repo'}]});
 const add=(submissionId:string,originAgentId='old',initial:Record<string,unknown>={},repoPath='/repo')=>store.insert(submissionSchema.parse({submissionId,title:submissionId,repoPath,
  planningCommit:commit,handoffPath:`${submissionId}.md`,originAgentId}),'host','handoff',commit,{originWorkspaceId:'planning',...initial});
 const notice=(id:string,taskId:string,agentId:string,extra:Partial<Notice>={}):Notice=>({id,taskId,agentId,recipientAgentId:agentId,workspaceId:null,sources:[],originEntry:false,kind:'hold',status:'pending',error:'',text:`Notice ${id}`,...extra});
 const reparent=(input:Record<string,unknown>)=>engine.reparent({toAgentId:'new',caller:'operator (board)',reason:'Owner replaced',...input} as never);
 return {dir,store,engine,adapter,agents,notified,add,notice,reparent,close:async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true})}};
}

test('a task records its owner at submission, and an owner-placed hold stores the owner marker', async () => {
 const f=fixture();try{
  const task=f.add('t1');
  assert.equal(task.notificationAgentId,'old');assert.equal(taskOwner(task),'old');
  const held=await f.engine.performTaskControl(taskControlInputSchema.parse({action:'hold',taskId:task.id,version:task.version,kind:'dispatch',reason:'wait for the release',agentId:'old'}));
  assert.equal(holdsOf(held).dispatch?.owner,TASK_OWNER_HOLD,'the owner\'s own hold follows the owner');
  const operator=f.add('t2');
  const operatorHeld=await f.engine.performTaskControl(taskControlInputSchema.parse({action:'hold',taskId:operator.id,version:operator.version,kind:'dispatch',reason:'board hold'}));
  assert.equal(holdsOf(operatorHeld).dispatch?.owner,'operator','a board hold stays the operator\'s');
 }finally{await f.close()}
});

test('one write moves the owner, owner-placed holds and owner notices; other holds and settled history stay', async () => {
 const f=fixture();try{
  const task=f.add('held',undefined,{holds:{
   dispatch:{owner:'release-team',reason:'release window',at:'2026-10-01T00:00:00.000Z',generation:4,until:null},
   merge:{owner:TASK_OWNER_HOLD,reason:'external receipt',at:'2026-10-02T00:00:00.000Z',generation:7,until:null},
  }});
  const pending=f.notice('owner-hold',task.id,'old',{recipientAgentId:TASK_OWNER_HOLD});
  const delivered=f.notice('owner-hold-delivered',task.id,'old',{recipientAgentId:TASK_OWNER_HOLD,status:'delivered'});
  const thirdParty=f.notice('third-party',task.id,'release-team');
  for(const item of [pending,delivered,thirdParty])f.store.putNotice(item);
  const before=f.store.task(task.id);
  const result=reparentResultSchema.parse(await f.reparent({taskIds:[task.id]}));
  assert.deepEqual(result.changed.map(item=>[item.taskId,item.from]),[[task.id,'old']]);
  const after=f.store.task(task.id);
  assert.equal(after.notificationAgentId,'new');assert.equal(after.originWorkspaceId,'planning-2','the owner\'s workspace moves with it');
  assert.equal(after.originAgentId,'old','the creator stays history');
  assert.deepEqual(holdsOf(after),holdsOf(before),'no hold fence is rewritten');
  assert.equal(holdOwnerOf(after,holdsOf(after).merge!.owner),'new','the owner-placed hold answers to the new owner');
  assert.equal(holdOwnerOf(after,holdsOf(after).dispatch!.owner),'release-team');
  assert.equal(f.store.events(task.id).filter(event=>event.kind==='owner_changed').length,1);
  await f.engine.resolution.deliverHoldNotices();await f.engine.resolution.deliverHoldNotices();
  assert.deepEqual(f.notified.toSorted((a,b)=>a.noticeId.localeCompare(b.noticeId)),[{agentId:'new',noticeId:pending.id},{agentId:'release-team',noticeId:thirdParty.id}],'the pending owner prompt reaches the new owner once, the third-party prompt its own owner');
  assert.equal(f.store.notices(task.id).find(item=>item.id===delivered.id)?.agentId,'old','a delivered notice keeps its recipient');
  const again=await f.reparent({taskIds:[task.id]});
  assert.deepEqual(again.changed,[]);assert.deepEqual(again.unchanged,[task.id]);
  assert.equal(f.store.task(task.id).version,after.version,'reparenting to the current owner writes nothing');
 }finally{await f.close()}
});

test('the bulk form moves every open task one thread owns in a project, and nothing else', async () => {
 const f=fixture();try{
  const owned=[f.add('a'),f.add('b')];
  const otherOwner=f.add('c','other-planner');
  const otherProject=f.add('d','old',{},'/other-repo');
  const finished=f.store.update(f.add('e').id,{phase:'done'});
  const result=await f.reparent({project:'project-c',fromAgentId:'old'});
  assert.deepEqual(result.changed.map(item=>item.taskId).sort(),owned.map(task=>task.id).sort(),'an archived old owner needs no liveness proof');
  for(const task of owned)assert.equal(taskOwner(f.store.task(task.id)),'new');
  assert.equal(taskOwner(f.store.task(otherOwner.id)),'other-planner');
  assert.equal(taskOwner(f.store.task(otherProject.id)),'old');
  assert.equal(f.store.task(finished.id).notificationAgentId,'old','a finished task keeps its history');
  const replay=await f.reparent({project:'project-c',fromAgentId:'old'});
  assert.deepEqual(replay,{toAgentId:'new',workspaceId:'planning-2',changed:[],unchanged:[]},'a replay finds nothing left to move');
 }finally{await f.close()}
});

test('the operator or the current owner may reparent; anyone else — including a thread claiming the retired project-owner role — is refused before any write', async () => {
 const f=fixture();try{
  const task=f.add('t','live-old');
  await assert.rejects(f.reparent({taskIds:[task.id],caller:'other-planner'}),/needs the operator at the board or its current owner live-old/);
  assert.equal(taskOwner(f.store.task(task.id)),'live-old');
  await f.reparent({taskIds:[task.id],caller:'live-old',toAgentId:'other-planner'});
  assert.equal(taskOwner(f.store.task(task.id)),'other-planner','the current owner hands its own task on');
  await f.reparent({taskIds:[task.id]});
  assert.equal(taskOwner(f.store.task(task.id)),'new','the operator at the board moves it back');
 }finally{await f.close()}
});

test('the registered project planner and Queue planner may reparent a task',async()=>{
 const f=fixture();try{
  const task=f.add('missing-origin','sweep',{originError:'Origin thread is missing and its workspace was not recorded'});
  f.store.setProjectPlanner({key:'project-c',agentId:'other-planner',setBy:'test'});
  await f.engine.reparent({toAgentId:'new',caller:'other-planner',reason:'Missing origin successor',taskIds:[task.id]} as never);
  assert.equal(taskOwner(f.store.task(task.id)),'new');
  const queueTask=f.add('queue-fallback','sweep',{originError:'Origin thread is missing and its workspace was not recorded'});
  f.store.upsertProject({key:QUEUE_LIVE_KEY,name:'Queue',repositories:[{origin:QUEUE_REPOSITORY_ORIGIN,path:'/queue'}]});
  f.store.setProjectPlanner({key:QUEUE_LIVE_KEY,agentId:'other-planner',setBy:'test'});
  await f.engine.reparent({toAgentId:'new',caller:'other-planner',reason:'Queue fallback successor',taskIds:[queueTask.id]} as never);
  assert.equal(taskOwner(f.store.task(queueTask.id)),'new');
  const both=f.add('both-planners','sweep',{originError:'Origin thread is missing and its workspace was not recorded'});
  f.store.setProjectPlanner({key:'project-c',agentId:'other-planner',setBy:'test'});
  f.store.setProjectPlanner({key:QUEUE_LIVE_KEY,agentId:'new',setBy:'test'});
  await f.engine.reparent({toAgentId:'other-planner',caller:'new',reason:'Queue planner authority',taskIds:[both.id]} as never);
  assert.equal(taskOwner(f.store.task(both.id)),'other-planner','the Queue planner remains authorized when a project planner exists');
 }finally{await f.close()}
});

test('the new owner must be a live planning thread, and only open tasks move', async () => {
 const f=fixture();try{
  const task=f.add('t');
  const working=f.store.update(f.add('w').id,{agentId:'worker',phase:'working'});
  await assert.rejects(f.reparent({taskIds:[task.id],toAgentId:'old'}),/must be a live, unarchived host thread/);
  await assert.rejects(f.reparent({taskIds:[task.id],toAgentId:'missing'}),/must be a live, unarchived host thread/);
  await assert.rejects(f.reparent({taskIds:[task.id],toAgentId:'operator'}),/operator is not a thread/);
  await assert.rejects(f.reparent({taskIds:[task.id],toAgentId:'worker'}),new RegExp(`worker is a worker, reviewer or coordinator of task ${working.id}`));
  const done=f.store.update(f.add('done').id,{phase:'done'});
  await assert.rejects(f.reparent({taskIds:[task.id,done.id]}),/only an open task changes owner/);
  assert.equal(taskOwner(f.store.task(task.id)),'old','a refused request writes nothing');
 }finally{await f.close()}
});

test('a creator that nominated itself for completion follows the owner, and the old owner\'s choice moves with it', async () => {
 const f=fixture();try{
  // The Project-C 134/135 shape: no origin closeout notice, the creator nominated itself.
  const task=f.add('nominated','old',{notifyOriginOnCloseout:false,
   creatorCompletionRecipients:[{agentId:'old',workspaceId:'planning'},{agentId:'other-planner',workspaceId:'planning'}]});
  assert.deepEqual(completionMembership(task).map(member=>[member.agentId,member.originEntry]),[['old',true],['other-planner',false]],
   'the self-nomination is the owner entry, not a literal copy of the creator');
  await f.reparent({taskIds:[task.id]});
  const done=f.store.update(task.id,{phase:'done'});
  assert.deepEqual(done.completionNotificationCohort?.map(member=>[member.agentId,member.originEntry]),[['old',true],['other-planner',false]]);
  await f.engine.resolution.deliverNotices();await f.engine.resolution.deliverNotices();
  assert.deepEqual([...new Set(f.notified.map(item=>item.agentId))].sort(),['new','other-planner'],'the archived creator receives nothing; the new owner does');

  const opted=f.add('opted-out','live-old',{notifyOriginOnCloseout:true,completionSubscriptionOverrides:[{agentId:'live-old',workspaceId:'planning',subscribed:false}]});
  assert.deepEqual(completionMembership(opted),[],'the owner opted out of its own completion notice');
  await f.reparent({taskIds:[opted.id]});
  assert.deepEqual(f.store.task(opted.id).completionSubscriptionOverrides,[{agentId:'new',workspaceId:'planning-2',subscribed:false}],'the choice moves with the task');
  assert.deepEqual(completionMembership(f.store.task(opted.id)),[]);
 }finally{await f.close()}
});

test('schema 50 upgrade preserves task owners, hold markers and pending prompts', async () => {
 const f=fixture();
 try{
  const task=f.add('legacy','old',{holds:{merge:{owner:TASK_OWNER_HOLD,reason:'legacy',at:'2026-10-02T00:00:00.000Z',generation:2,until:null},
   dispatch:{owner:'operator',reason:'board',at:'2026-10-02T00:00:00.000Z',generation:1,until:null}}});
  f.store.putNotice(f.notice('legacy-prompt',task.id,'old',{recipientAgentId:TASK_OWNER_HOLD}));
  // Live-store shape the 48→49 step must not leave delivering to the creator:
  // origin=old, owner already moved, fence still named old.
  const moved=f.add('moved','old',{notificationAgentId:'new',holds:{merge:{owner:TASK_OWNER_HOLD,reason:'creator fence',at:'2026-10-02T00:00:00.000Z',generation:3,until:null}}});
  f.store.putNotice(f.notice('creator-prompt',moved.id,'old',{recipientAgentId:TASK_OWNER_HOLD}));
  f.store.putNotice(f.notice('third-party',moved.id,'release-team'));
  f.store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
  f.store.setMeta('schema',50);
  await f.engine.stop();f.store.close();
  const reopened=new Store(join(f.dir,'queue.sqlite'));
  const engine=new Engine(reopened,f.adapter,0);reopened.setMeta('paused',false);
  try{
   const migrated=reopened.task(task.id);
   assert.equal(migrated.notificationAgentId,'old');
   assert.equal(holdsOf(migrated).merge?.owner,TASK_OWNER_HOLD);
   assert.equal(holdsOf(migrated).dispatch?.owner,'operator');
   assert.equal(reopened.notices(task.id).find(item=>item.id==='legacy-prompt')?.recipientAgentId,TASK_OWNER_HOLD);
   const migratedMoved=reopened.task(moved.id);
   assert.equal(migratedMoved.notificationAgentId,'new');
   assert.equal(holdsOf(migratedMoved).merge?.owner,TASK_OWNER_HOLD);
   assert.equal(reopened.notices(moved.id).find(item=>item.id==='creator-prompt')?.recipientAgentId,TASK_OWNER_HOLD);
   assert.equal(reopened.notices(moved.id).find(item=>item.id==='third-party')?.recipientAgentId,'release-team');
   await engine.resolution.deliverHoldNotices();await engine.resolution.deliverHoldNotices();
   assert.deepEqual(f.notified.filter(item=>item.noticeId==='creator-prompt'),[{agentId:'new',noticeId:'creator-prompt'}]);
   assert.equal(reopened.notices(moved.id).find(item=>item.id==='creator-prompt')?.status,'delivered');
   assert.deepEqual(f.notified.filter(item=>item.noticeId==='third-party'),[{agentId:'release-team',noticeId:'third-party'}]);
  }finally{await engine.stop();reopened.close()}
 }finally{rmSync(f.dir,{recursive:true,force:true})}
});

test('the CLI takes the caller from its own thread and calls the one reparent method', () => {
 const source=readFileSync(new URL('../bin/nucleus-reparent.mjs',import.meta.url),'utf8');
 assert.match(source,/await resolveCliCaller/);
 assert.match(source,/client\.request\('queue\.reparent'/);
 assert.doesNotMatch(source,/--caller/);
 assert.match(readFileSync(new URL('../shared/rpc-catalogue.ts',import.meta.url),'utf8'),/name: "queue\.reparent", contract: contracts\.reparent, method: "reparent"/);
});


test('qualified callers retain legacy owner authority and owner hold semantics', async () => {
 const f=fixture();try{
  const task=f.add('qualified-owner','live-old',{originHostId:'host'});
  const caller=formatAgentId('host','live-old');
  const held=await f.engine.performTaskControl(taskControlInputSchema.parse({action:'hold',taskId:task.id,version:task.version,kind:'dispatch',reason:'Waiting',agentId:caller,caller}));
  assert.equal(holdsOf(held).dispatch?.owner,TASK_OWNER_HOLD);
  await assert.rejects(f.reparent({taskIds:[task.id],caller:formatAgentId('other-host','live-old')}),/is neither/);
  await f.reparent({taskIds:[task.id],caller});
  assert.equal(taskOwner(f.store.task(task.id)),'new');
  assert.equal(f.store.task(task.id).originAgentId,'live-old','historical creator is untouched');
 }finally{await f.close()}
});

test('qualified subscription choices merge with legacy completion recipients', () => {
 const policy={originAgentId:'origin',notificationAgentId:'origin',originWorkspaceId:'planning',notifyOriginOnCloseout:true,
  creatorCompletionRecipients:[{agentId:'alpha',workspaceId:'a'}],
  completionSubscriptionOverrides:[{agentId:formatAgentId('host','alpha'),workspaceId:'a',subscribed:false},
    {agentId:formatAgentId('host','origin'),workspaceId:'planning',subscribed:false}]};
 assert.deepEqual(completionMembership(policy),[]);
});
