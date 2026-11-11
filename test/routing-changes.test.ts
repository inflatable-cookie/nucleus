import { fakeAdapter, createTaskAgent, observeIdle } from './support/fakes';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store/store';
import {Engine} from '../core/engine';
import {eligibilityReasons,validateNamedProfile} from '../core/dispatch/routing';
import {submissionSchema,taskControlInputSchema,type Profile,type Task} from '../shared/contracts';
import type {Adapter} from '../core/host';
import { assertCompleted, cleanupDiagnostic, observeOutcome, type BackgroundOutcome } from './support/background-outcome';

const profile=(id:string):Profile=>({id,name:id,provider:'test',model:id,available:true,problem:'',notes:'',supportedThinking:['low']});
const profiles=[profile('normal'),profile('strong'),profile('special')];
const pool=[
 {profileId:'normal',enabled:true,group:'normal',roles:['worker'] as const,weight:1,scopes:['general'] as const},
 {profileId:'strong',enabled:true,group:'strong',roles:['worker'] as const,weight:1,scopes:['general','complex'] as const},
 {profileId:'special',enabled:true,group:'special',roles:['worker'] as const,weight:1,scopes:['complex'] as const,capability:'frontier'},
];
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'queue-routing-')),path=join(dir,'queue.sqlite'),store=new Store(path);
 store.setMeta('paused',false);
 store.setMeta('pool',pool);
 const task=store.insert(submissionSchema.parse({submissionId:'routing',title:'Routing',repoPath:'/repo',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin',preferredProfileId:'normal',requirePreferred:true}),'host','handoff','a'.repeat(40));
 const dependent=store.insert(submissionSchema.parse({submissionId:'dependent',title:'Dependent',repoPath:'/repo',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin',dependsOn:[task.id]}),'host','handoff','a'.repeat(40));
 const adapter=fakeAdapter({profiles:async()=>profiles,validate:async()=>task.planningCommit,createWorkspace:async(t:Task)=>({id:`ws-${t.id}`,directory:'/fixture'}),verifyWorkspace:async(t:Task)=>t.branch,createAgent:createTaskAgent,observe:observeIdle('ws', 'agent'),verifyPr:async()=>({url:'https://github.com/example/repo/pull/1',head:'a'.repeat(40)})} as unknown as Adapter);
 const engine=new Engine(store,adapter,0);engine.profiles=profiles;
 return {store,engine,adapter,task,dependent,path,close:async()=>{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('030-1/8 queued routing changes retain identity, dependencies and the event through restart; next pass uses the new profile',async()=>{
 const f=fixture();try{
  f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('normal',JSON.stringify({group:'normal',unavailable:true,reason:'quota',retryAt:null}));
  const changed=await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.task.version,action:'set_routing',reason:'Use available group',preferredProfileId:'strong',requirePreferred:true,relayed:true,note:'Tom approved in chat'}));
  assert.equal(changed.number,f.task.number);assert.equal(changed.handoffPath,f.task.handoffPath);assert.deepEqual(f.store.task(f.dependent.id).dependsOn,[f.task.id]);
  const event=f.store.events(f.task.id).find(e=>e.kind==='routing_changed');assert.ok(event);assert.match(event.detail,/Use available group/);assert.match(event.detail,/relayed: Tom approved in chat/);assert.match(event.detail,/"before"/);assert.match(event.detail,/"after"/);
  const reopened=new Store(f.path);try{assert.equal(reopened.task(f.task.id).preferredProfileId,'strong');assert.equal(reopened.events(f.task.id).find(e=>e.kind==='routing_changed')?.detail,event.detail);}finally{reopened.close();}
  await f.engine.wake();assert.equal(f.store.task(f.task.id).profile?.id,'strong');
  f.store.update(f.task.id,{phase:'done',finishedAt:new Date().toISOString()});
  assert.equal(f.store.outcome(f.task.id)?.routing?.preferredProfileId,'strong','the permanent outcome keeps the routing change');
 }finally{await f.close();}
});
test('030-2/3/4 routing validates the new scope, version and dispatch fence',async()=>{
 const f=fixture();try{
  const change=(more:Record<string,unknown>)=>f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.store.task(f.task.id).version,action:'set_routing',reason:'Routing decision',...more}));
  const accepted=await change({scope:'complex',preferredProfileId:'special',profileRequests:{worker:{profileId:'special',reason:'Complex analysis',required:true}}});assert.equal(accepted.scope,'complex');
  const boardEvent=f.store.events(f.task.id).find(e=>e.kind==='routing_changed');assert.ok(boardEvent);
  assert.equal(JSON.parse(boardEvent.detail).authority,'operator (board)');
  assert.deepEqual(f.store.events(f.task.id).filter(e=>e.kind==='operator_control').map(e=>e.detail),['set_routing']);
  await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.task.version,action:'set_routing',reason:'Stale',preferredProfileId:'strong'})),/Task changed/);
  assert.equal(f.store.events(f.task.id).filter(e=>e.kind==='operator_control').length,1,'refused controls do not count as operator actions');
  f.store.update(f.task.id,{agentIntent:true});await assert.rejects(change({preferredProfileId:'strong'}),/use restart \(fresh: true to replace the worker\)/);
  assert.equal(taskControlInputSchema.safeParse({taskId:f.task.id,version:1,action:'set_routing',reason:'Empty'}).success,false);
  assert.equal(taskControlInputSchema.safeParse({taskId:f.task.id,version:1,action:'set_routing',preferredProfileId:'strong'}).success,false);
  assert.equal(taskControlInputSchema.safeParse({taskId:f.task.id,version:1,action:'set_routing',reason:'x',preferredProfileId:'strong',relayed:true}).success,false);
 }finally{await f.close();}
});
test('030-1 routing changed during remote pre-dispatch validation cannot launch the stale selection',async()=>{
 const f=fixture();let first:Promise<BackgroundOutcome>|undefined,failed=false,release:()=>void=()=>{};try{
  let entered!:()=>void;
  const begun=new Promise<void>(resolve=>{entered=resolve});
  const held=new Promise<void>(resolve=>{release=resolve});
  f.adapter.validate=async()=>{entered();await held;return f.task.planningCommit};
  first=observeOutcome(f.engine.wake());await begun;
  await f.engine.performTaskControl(taskControlInputSchema.parse({taskId:f.task.id,version:f.task.version,action:'set_routing',reason:'Move to strong',preferredProfileId:'strong'}));
  release();await assertCompleted(first,'the first wake');
  assert.notEqual(f.store.task(f.task.id).profile?.id,'normal');
  await f.engine.wake();assert.equal(f.store.task(f.task.id).profile?.id,'strong');
 }catch(error){failed=true;throw error}finally{
  release();await f.close();
  const note=failed?await cleanupDiagnostic(first,'the first wake'):null;if(note)process.stderr.write(`[routing] secondary: ${note}\n`);
 }
});
test('030-5/6 replacement profile validation and bounded specific eligibility reasons',()=>{
 const f=fixture();try{
  const task=f.task;
  assert.equal(validateNamedProfile('normal','worker','complex',profiles,f.store.pool(),'Change').profile.id,'normal','scope no longer gates (Spec 053)');
  assert.equal(validateNamedProfile('special','worker','complex',profiles,f.store.pool(),'Needed').profile.id,'special');
  const mixed=eligibilityReasons({...task,scope:'complex',preferredProfileId:'normal',requirePreferred:true},profiles,f.store.pool().map(e=>e.profileId==='strong'?{...e,enabled:false}:e),[{group:'normal',unavailable:true,reason:'quota',retryAt:'2099-01-01'}]);
  assert.match(mixed,/preference required but ineligible/);assert.doesNotMatch(mixed,/scope/);assert.match(mixed,/disabled/);assert.match(mixed,/frontier below Maximum without a signed-off request/);assert.match(mixed,/group normal unavailable: quota \(retry 2099-01-01\)/);assert.ok(mixed.length<=2000);
 }finally{void f.close();}
});

test('papercut 4befc74b: a worker request thinking level is applied, kept by route, and a conflicting pair is refused', async () => {
  const { chooseProfile, workerThinking } = await import('../core/dispatch/routing');
  const f = fixture(); try {
    // A brief may name the worker level on the worker request alone: selection applies it.
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'nested-thinking', title: 'Nested', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin',
      profileRequests: { worker: { profileId: 'strong', reason: 'Needs the strong worker', thinkingOptionId: 'low' } } }), 'host', 'handoff', 'a'.repeat(40));
    assert.equal(task.thinkingOptionId, '');
    assert.equal(workerThinking(task), 'low');
    const chosen = chooseProfile(task, profiles, pool as never, {}, new Set());
    assert.equal(chosen?.profile.id, 'strong');
    assert.equal(chosen?.profile.thinkingOptionId, 'low', 'the requested worker level reaches the launched profile');
    // An unsupported nested level makes the worker ineligible, as a top-level one does.
    const high = { ...task, profileRequests: { worker: { ...task.profileRequests!.worker!, thinkingOptionId: 'high' } } } as Task;
    assert.equal(chooseProfile(high, profiles, pool as never, {}, new Set()), null);
    // Two different levels are refused at intake and in set_routing.
    assert.throws(() => f.store.insert(submissionSchema.parse({ submissionId: 'conflict', title: 'Conflict', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin', thinkingOptionId: 'low',
      profileRequests: { worker: { profileId: 'strong', reason: 'x', thinkingOptionId: 'high' } } }), 'host', 'handoff', 'a'.repeat(40)), /Conflicting worker thinking levels/);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: task.id, version: f.store.task(task.id).version, action: 'set_routing', reason: 'Conflict', thinkingOptionId: 'low',
      profileRequests: { worker: { profileId: 'strong', reason: 'x', thinkingOptionId: 'high' } } })), /Conflicting worker thinking levels/);
    // A route for the worker that names no level keeps the effective one on the task.
    const routed = await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: task.id, version: f.store.task(task.id).version, action: 'route', role: 'worker', profileId: 'normal', reason: 'Back to the normal worker' }));
    assert.equal(routed.thinkingOptionId, 'low');
    assert.equal(workerThinking(routed), 'low');
  } finally { await f.close(); }
});
