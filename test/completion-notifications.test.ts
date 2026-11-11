import { formatAgentId } from '../shared/agent-identity';
import { fakeAdapter } from './support/fakes';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store/store';
import {Engine} from '../core/engine';
import {submissionSchema} from '../shared/contracts';
import type {Adapter,AgentObservation,OriginAgent} from '../core/host';
import {validateCompletionRecipients} from '../core/scheduling/cohort';

const commit='a'.repeat(40);
function fixture(input:Record<string,unknown>={}){
  const dir=mkdtempSync(join(tmpdir(),'ns-completion-')),store=new Store(join(dir,'queue.sqlite'));
  const agents=new Map<string,OriginAgent>([
    ['origin',{id:'origin',workspaceId:'planning',title:'Chatterbox',archived:false}],
    ['alpha',{id:'alpha',workspaceId:'project-a',title:'Thread A',archived:false}],
    ['beta',{id:'beta',workspaceId:'project-b',title:'Thread B',archived:false}],
  ]);
  const states=new Map<string,AgentObservation>([...agents.values()].map(agent=>[agent.id,{id:agent.id,workspaceId:agent.workspaceId,status:'idle',active:false,permissions:false,error:''}]));
  const delivered:string[]=[];
  const sources:Array<string|undefined>=[];
  const adapter=fakeAdapter({
    profiles:async()=>[],validate:async()=>commit,createWorkspace:async()=>{throw Error('unused')},verifyWorkspace:async()=>'',createAgent:async()=>{throw Error('unused')},verifyPr:async()=>{throw Error('unused')},
    originAgent:async(id:string)=>agents.get(id)??null,observe:async(id:string)=>{const state=states.get(id);if(!state)throw Error('Agent was not found');return state;},notify:async(id:string,_messageId:string,_text:string,source?:string)=>{delivered.push(id);sources.push(source)},
  } as unknown as Adapter & {notify(agentId:string,messageId:string,text:string):Promise<void>});
  const submission=submissionSchema.parse({submissionId:'task',title:'Completion cohorts',repoPath:'/repo',planningCommit:commit,handoffPath:'handoff.md',originAgentId:'origin',...input});
  const bindings=submission.completionNotificationAgentIds.map(agentId=>({agentId,workspaceId:agents.get(agentId)!.workspaceId!}));
  const task=store.insert(submission,'host','handoff',commit,{originWorkspaceId:'planning',creatorCompletionRecipients:bindings});
  const engine=new Engine(store,adapter);store.setMeta('paused',false);
  return {dir,store,engine,adapter,agents,states,delivered,sources,task,close:async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true})}};
}

test('quiet defaults preserve legacy identity; creator policy is normalized, bounded and immutable',async()=>{
  const f=fixture();try{
    const legacy=submissionSchema.parse({submissionId:'task',title:'Completion cohorts',repoPath:'/repo',planningCommit:commit,handoffPath:'handoff.md',originAgentId:'origin',notifyOriginOnCloseout:false,completionNotificationAgentIds:[]});
    assert.equal(f.store.existing(legacy)?.id,f.task.id);
    const normalized=submissionSchema.parse({...legacy,submissionId:'normalized',completionNotificationAgentIds:['beta','alpha','beta']});
    assert.deepEqual(normalized.completionNotificationAgentIds,['alpha','beta']);
    assert.throws(()=>submissionSchema.parse({...legacy,completionNotificationAgentIds:Array.from({length:33},(_,i)=>`agent-${i}`)}));
    assert.throws(()=>f.store.existing({...legacy,notifyOriginOnCloseout:true}),/different content/);
    const unchanged=f.store.update(f.task.id,{notifyOriginOnCloseout:true,completionNotificationAgentIds:['alpha'],creatorCompletionRecipients:[{agentId:'alpha',workspaceId:'project-a'}]});
    assert.equal(unchanged.notifyOriginOnCloseout,false);assert.deepEqual(unchanged.completionNotificationAgentIds,[]);assert.deepEqual(unchanged.creatorCompletionRecipients,[]);
    const done=f.store.update(f.task.id,{phase:'done'});assert.deepEqual(done.completionNotificationCohort,[]);assert.deepEqual(f.store.notices(done.id),[]);
  }finally{await f.close()}
});

test('creator recipients must be live and retain their observed cross-project workspace binding',async()=>{
  const input=submissionSchema.parse({submissionId:'validated',title:'Validated',repoPath:'/repo',planningCommit:commit,handoffPath:'handoff.md',originAgentId:'origin',completionNotificationAgentIds:['alpha','beta']});
  const agents=new Map<string,OriginAgent>([['origin',{id:'origin',workspaceId:'planning',title:'Chatterbox',archived:false}],['alpha',{id:'alpha',workspaceId:'one',title:'A',archived:false}],['beta',{id:'beta',workspaceId:'two',title:'B',archived:false}]]);
  assert.deepEqual((await validateCompletionRecipients(input,async id=>agents.get(id)??null)).recipients,[{agentId:'alpha',workspaceId:'one'},{agentId:'beta',workspaceId:'two'}]);
  agents.set('beta',{...agents.get('beta')!,archived:true});await assert.rejects(validateCompletionRecipients(input,async id=>agents.get(id)??null),/beta/);
  const originOnly=submissionSchema.parse({...input,completionNotificationAgentIds:[],notifyOriginOnCloseout:true});agents.delete('origin');await assert.rejects(validateCompletionRecipients(originOnly,async id=>agents.get(id)??null),/origin closeout/i);
});

test('self-service validates and binds the caller, rejects stale/terminal mutations, and can suppress a creator seed',async()=>{
  const f=fixture({completionNotificationAgentIds:['alpha']});try{
    const subscribed=await f.engine.completionSubscription({taskId:f.task.id,version:f.store.task(f.task.id).version,agentId:'beta',action:'subscribe'});
    assert.deepEqual(subscribed.completionSubscriptionOverrides,[{agentId:'beta',workspaceId:'project-b',subscribed:true}]);
    await assert.rejects(f.engine.completionSubscription({taskId:f.task.id,version:f.task.version,agentId:'alpha',action:'subscribe'}),/changed/);
    const unsubscribed=await f.engine.completionSubscription({taskId:f.task.id,version:subscribed.version,agentId:'alpha',action:'unsubscribe'});
    f.agents.delete('beta');await assert.rejects(f.engine.completionSubscription({taskId:f.task.id,version:unsubscribed.version,agentId:'beta',action:'subscribe'}),/live Paseo agent/);
    const done=f.store.update(f.task.id,{phase:'done'});
    assert.deepEqual(done.completionNotificationCohort?.map(member=>member.agentId),['beta']);
    await assert.rejects(f.engine.completionSubscription({taskId:f.task.id,version:done.version,agentId:'alpha',action:'subscribe'}),/terminal/);
  }finally{await f.close()}
});

test('an archived or missing recipient leaves the future cohort on its recorded workspace, and nothing else may',async()=>{
 const archived=fixture({completionNotificationAgentIds:['alpha']});try{
  archived.agents.set('alpha',{...archived.agents.get('alpha')!,archived:true});
  let task=archived.store.task(archived.task.id);
  await assert.rejects(archived.engine.completionSubscription({taskId:task.id,version:task.version,agentId:'alpha',action:'subscribe'}),/live Paseo agent/,'adding still needs a fresh live identity');
  const unsubscribed=await archived.engine.completionSubscription({taskId:task.id,version:task.version,agentId:'alpha',action:'unsubscribe'});
  assert.deepEqual(unsubscribed.completionSubscriptionOverrides,[{agentId:'alpha',workspaceId:'project-a',subscribed:false}],'the durable creator binding supplies the workspace');
  assert.deepEqual(unsubscribed.creatorCompletionRecipients,[{agentId:'alpha',workspaceId:'project-a'}],'creator history is not rewritten');
  const again=await archived.engine.completionSubscription({taskId:task.id,version:unsubscribed.version,agentId:'alpha',action:'unsubscribe'});
  assert.deepEqual(again.completionSubscriptionOverrides,unsubscribed.completionSubscriptionOverrides,'a suppressed recipient stays suppressed');
  assert.deepEqual(archived.store.update(task.id,{phase:'done'}).completionNotificationCohort,[],'the archived recipient receives no future notice');
 }finally{await archived.close()}

 const missing=fixture({completionNotificationAgentIds:['alpha']});try{
  missing.agents.delete('alpha');
  const task=missing.store.task(missing.task.id);
  await assert.rejects(missing.engine.completionSubscription({taskId:task.id,version:task.version,agentId:'alpha',action:'subscribe'}),/live Paseo agent/);
  const removed=await missing.engine.completionSubscription({taskId:task.id,version:task.version,agentId:'alpha',action:'unsubscribe'});
  assert.deepEqual(removed.completionSubscriptionOverrides,[{agentId:'alpha',workspaceId:'project-a',subscribed:false}]);
  assert.deepEqual(missing.store.update(removed.id,{phase:'done'}).completionNotificationCohort,[],'a missing recipient is removed before the freeze');
 }finally{await missing.close()}

 const refuse=fixture({completionNotificationAgentIds:['alpha']});try{
  const task=refuse.store.task(refuse.task.id);
  await assert.rejects(refuse.engine.completionSubscription({taskId:task.id,version:task.version,agentId:'nobody',action:'unsubscribe'}),/durable workspace evidence/,'an unrecorded recipient is never manufactured');
  await assert.rejects(refuse.engine.completionSubscription({taskId:task.id,version:task.version,agentId:'nobody',action:'subscribe'}),/live Paseo agent/,'an arbitrary subscribe is refused');
  refuse.agents.set('alpha',{id:'alpha',workspaceId:'elsewhere',title:'A',archived:true});
  await assert.rejects(refuse.engine.completionSubscription({taskId:task.id,version:task.version,agentId:'alpha',action:'unsubscribe'}),/mismatched evidence/,'an archived thread that moved cannot reinterpret the record');
  refuse.agents.set('alpha',{...refuse.agents.get('alpha')!,workspaceId:'project-a'});
  const beta=await refuse.engine.completionSubscription({taskId:task.id,version:task.version,agentId:'beta',action:'subscribe'});
  refuse.agents.delete('beta');
  const removed=await refuse.engine.completionSubscription({taskId:task.id,version:beta.version,agentId:'beta',action:'unsubscribe'});
  assert.deepEqual(removed.completionSubscriptionOverrides,[{agentId:'beta',workspaceId:'project-b',subscribed:false}],'a recorded subscription is durable evidence too');
  refuse.agents.delete('alpha');
  refuse.adapter.originAgent=async(id:string)=>{if(id==='alpha')throw Error('daemon timeout');return refuse.agents.get(id)??null};
  await assert.rejects(refuse.engine.completionSubscription({taskId:removed.id,version:removed.version,agentId:'alpha',action:'unsubscribe'}),/unreadable|unknown evidence/,'an unreadable identity refuses rather than guessing');
 }finally{await refuse.close()}
});

test('done freezes a normalized cohort and independently fences delivery, missing recipients and retries',async()=>{
  const f=fixture({notifyOriginOnCloseout:true,completionNotificationAgentIds:['alpha','beta']});try{
    let task=await f.engine.completionSubscription({taskId:f.task.id,version:f.store.task(f.task.id).version,agentId:'alpha',action:'subscribe'});
    task=f.store.update(task.id,{phase:'done',agentId:'worker',prUrl:'https://github.com/example/repo/pull/7'});
    assert.deepEqual(task.completionNotificationCohort?.map(member=>[member.agentId,member.sources]),[
      ['alpha',['creator','self']],['beta',['creator']],['origin',['origin']],
    ]);
    assert.equal(f.store.notices(task.id).length,3);assert.ok(f.store.notices(task.id).every(notice=>notice.text.includes('State: done')&&notice.text.includes('Repository: /repo')));
    f.agents.set('beta',{...f.agents.get('beta')!,archived:true});f.store.setMeta('paused',true);await f.engine.resolution.deliverNotices();assert.deepEqual(f.delivered,[]);
    f.store.setMeta('paused',false);await f.engine.resolution.deliverNotices();assert.deepEqual(new Set(f.delivered),new Set(['alpha','origin']));assert.deepEqual(f.sources,['worker','worker']);
    assert.equal(f.store.notices(task.id).find(notice=>notice.recipientAgentId==='beta')?.status,'superseded');
    await f.engine.resolution.deliverNotices();assert.equal(f.delivered.length,2);
    assert.equal(f.store.task(task.id).originError,'');
  }finally{await f.close()}
});

test('origin reassignment coalesces completion entries that resolve to the same live thread',async()=>{
  const before=fixture({notifyOriginOnCloseout:true});try{
    let task=await before.engine.completionSubscription({taskId:before.task.id,version:before.task.version,agentId:'alpha',action:'subscribe'});
    task=before.store.update(task.id,{notificationAgentId:'alpha',phase:'done'});
    await before.engine.resolution.deliverNotices();
    assert.deepEqual(before.delivered,['alpha']);
    const notices=before.store.notices(task.id);
    assert.equal(notices.filter(notice=>notice.status==='delivered').length,1);
    assert.equal(notices.find(notice=>notice.status==='delivered')?.originEntry,true);
    assert.match(notices.find(notice=>notice.status==='superseded')?.error??'',/multiple cohort entries/);
  }finally{await before.close()}

  const after=fixture({notifyOriginOnCloseout:true});try{
    let task=await after.engine.completionSubscription({taskId:after.task.id,version:after.task.version,agentId:'alpha',action:'subscribe'});
    after.states.set('origin',{...after.states.get('origin')!,status:'running',active:true});
    task=after.store.update(task.id,{phase:'done'});
    await after.engine.resolution.deliverNotices();
    assert.deepEqual(after.delivered,['alpha']);
    after.store.update(task.id,{notificationAgentId:'alpha'});
    await after.engine.resolution.deliverNotices();
    assert.deepEqual(after.delivered,['alpha']);
    assert.equal(after.store.notices(task.id).find(notice=>notice.originEntry)?.status,'superseded');
  }finally{await after.close()}
});

test('uncertain completion sends are never retried and subscriber membership receives no attention notices',async()=>{
  const f=fixture({completionNotificationAgentIds:['alpha']});try{
    let attempts=0;f.adapter.notify=async()=>{attempts++;throw Error('unknown delivery')};
    let task=f.store.update(f.task.id,{phase:'done'});await f.engine.resolution.deliverNotices();await f.engine.resolution.deliverNotices();
    assert.equal(attempts,1);assert.equal(f.store.notices(task.id)[0].status,'uncertain');

    const other=fixture();try{
      task=await other.engine.completionSubscription({taskId:other.task.id,version:other.task.version,agentId:'alpha',action:'subscribe'});
      other.store.update(task.id,{phase:'blocked',reason:'Needs operator decision',resolution:{...task.resolution,attention:true}});
      await other.engine.resolution.deliverNotices();assert.deepEqual(other.delivered,['origin']);
      assert.equal(other.store.notices(task.id).some(notice=>notice.agentId==='alpha'),false);
    }finally{await other.close()}
  }finally{await f.close()}
});

test('agent helper derives identity from the shared caller resolver and root registration includes the RPC',()=>{
  const helper=readFileSync(new URL('../bin/nucleus-subscribe.mjs',import.meta.url),'utf8');
  assert.match(helper,/await resolveCliCaller/);assert.ok(!helper.includes('--agent'));
  assert.match(readFileSync(new URL('../shared/rpc-catalogue.ts',import.meta.url),'utf8'),/name: "queue\.completion-subscription", contract: contracts\.completionSubscription, method: "completionSubscription"/);
});

test('consumer #687: an operator-origin completion entry goes to the project planner and coalesces with its own cohort entry',async()=>{
  for(const operator of ['operator','operator (board)']){const f=fixture({notifyOriginOnCloseout:true,originAgentId:operator});try{
    f.store.upsertProject({key:'app',name:'App',repositories:[{origin:null,path:'/repo'}]});
    f.store.setProjectPlanner({key:'app',agentId:'alpha',setBy:'test'});
    let task=await f.engine.completionSubscription({taskId:f.task.id,version:f.task.version,agentId:'alpha',action:'subscribe'});
    task=f.store.update(task.id,{phase:'done'});
    await f.engine.resolution.deliverNotices();await f.engine.resolution.deliverNotices();
    assert.deepEqual(f.delivered,['alpha'],`${operator}: one completion, to the project planner, never to "${operator}"`);
    const notices=f.store.notices(task.id);
    assert.equal(notices.filter(notice=>notice.status==='delivered').length,1);
    assert.match(notices.find(notice=>notice.status==='superseded')?.error??'',/multiple cohort entries resolve to alpha/);
  }finally{await f.close()}}
});

test('consumer #687 (review #602): missing planner does not prevent stale attention settlement',async()=>{
 const f=fixture({originAgentId:'operator'});try{
  f.store.putNotice({id:'old-episode',taskId:f.task.id,agentId:'operator',recipientAgentId:'operator',workspaceId:'planning',sources:[],originEntry:true,kind:'attention',status:'pending',error:'',text:'old attention'});
  await f.engine.resolution.deliverNotices();
  assert.equal(f.store.notices(f.task.id)[0].status,'superseded');
 }finally{await f.close()}
});
test('consumer #687 (review #602): missing planner still settles interrupted intent as uncertain',async()=>{
 const f=fixture({notifyOriginOnCloseout:true,originAgentId:'operator'});try{
  f.store.update(f.task.id,{phase:'done'});
  const n=f.store.notices(f.task.id)[0];f.store.putNotice({...n,status:'intent',agentId:'old-owner'});
  await f.engine.resolution.deliverNotices();
  assert.equal(f.store.notices(f.task.id)[0].status,'uncertain');
 }finally{await f.close()}
});
test('consumer #687 (review #602): changed project planner is rechecked before pending send',async()=>{
 const f=fixture({notifyOriginOnCloseout:true,originAgentId:'operator'});try{
  f.store.upsertProject({key:'app',name:'App',repositories:[{origin:null,path:'/repo'}]});
  f.store.setProjectPlanner({key:'app',agentId:'alpha',setBy:'test'});
  f.store.update(f.task.id,{phase:'done'});
  const observe=f.adapter.observe;
  f.adapter.observe=async id=>{f.store.setProjectPlanner({key:'app',agentId:'beta',setBy:'test'});return observe(id)};
  await f.engine.resolution.deliverNotices();
  assert.ok(!f.delivered.includes('alpha'),JSON.stringify(f.delivered));
 }finally{await f.close()}
});

test('consumer #687 (review #602): delivered origin history does not suppress a different cohort recipient after planner change',async()=>{
 const f=fixture({notifyOriginOnCloseout:true,originAgentId:'operator',completionNotificationAgentIds:['beta']});try{
  f.store.upsertProject({key:'app',name:'App',repositories:[{origin:null,path:'/repo'}]});
  f.store.setProjectPlanner({key:'app',agentId:'alpha',setBy:'test'});
  f.states.set('beta',{...f.states.get('beta')!,status:'running',active:true});
  f.store.update(f.task.id,{phase:'done'});
  await f.engine.resolution.deliverNotices();
  assert.deepEqual(f.delivered,['alpha']);
  f.store.setProjectPlanner({key:'app',agentId:'beta',setBy:'test'});
  f.states.set('beta',{...f.states.get('beta')!,status:'idle',active:false});
  await f.engine.resolution.deliverNotices();
  assert.deepEqual(f.delivered,['alpha','beta']);
 }finally{await f.close()}
});

test('consumer #687 (review #602): an interrupted origin intent retains its recorded recipient when the new planner already has a delivered cohort entry',async()=>{
 const f=fixture({notifyOriginOnCloseout:true,originAgentId:'operator',completionNotificationAgentIds:['beta']});try{
  f.store.upsertProject({key:'app',name:'App',repositories:[{origin:null,path:'/repo'}]});
  f.store.setProjectPlanner({key:'app',agentId:'beta',setBy:'test'});
  f.store.update(f.task.id,{phase:'done'});
  for(const n of f.store.notices(f.task.id))f.store.putNotice({...n,status:n.originEntry?'intent':'delivered',agentId:n.originEntry?'alpha':'beta'});
  await f.engine.resolution.deliverNotices();
  const n=f.store.notices(f.task.id).find(n=>n.originEntry)!;
  assert.deepEqual({status:n.status,agentId:n.agentId},{status:'uncertain',agentId:'alpha'});
 }finally{await f.close()}
});


test('qualified self-subscriptions route to their host and replace legacy subscription entries', async () => {
 const f=fixture({completionNotificationAgentIds:['alpha']});try {
  f.engine.identifyOriginHost=async()=> 'host';
  const caller=formatAgentId('host','alpha');
  const first=await f.engine.completionSubscription({taskId:f.task.id,version:f.task.version,agentId:'alpha',action:'subscribe'});
  const second=await f.engine.completionSubscription({taskId:f.task.id,version:first.version,agentId:caller,action:'unsubscribe'});
  assert.deepEqual(second.completionSubscriptionOverrides,[{agentId:caller,workspaceId:'project-a',subscribed:false}]);
  assert.deepEqual(second.creatorCompletionRecipients,[{agentId:'alpha',workspaceId:'project-a'}]);
 } finally {await f.close();}
});
