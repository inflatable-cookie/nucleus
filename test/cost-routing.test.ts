import { profile } from './support/fakes';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store/store';
import {Engine} from '../core/engine';
import {chooseProfile} from '../core/dispatch/routing';
import {submissionSchema,profileRequestsSchema,poolSchema,type Profile,type ProfileCapability,type ProfileWeight} from '../shared/contracts';
import type {Adapter} from '../core/host';
import {activeGroupLimit,normalizeRetryAt,saveProfileSettings} from '../shared/pool';

const profiles=[profile('normal'),profile('astra'),profile('fable')];
const pool=profiles.map(p=>poolSchema.parse({profileId:p.id,enabled:true,group:p.id,roles:['worker','reviewer','coordinator'],weight:'default',scopes:['general','complex'],capability:p.id==='normal'?null:'frontier'}));
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ns-cost-')),store=new Store(join(dir,'db'));
 const task=store.insert(submissionSchema.parse({submissionId:'task',title:'Complex work',repoPath:'/repo',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin',scope:'complex'}),'host','handoff','a'.repeat(40));
 return {store,task,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('frontier profiles never enter automatic selection or fallback at Normal, regardless of weight',()=>{
 const f=fixture();try{
  assert.equal(chooseProfile(f.task,profiles,pool,{normal:999},new Set())?.profile.id,'normal');
  assert.equal(chooseProfile(f.task,profiles,pool,{},new Set(['normal'])),null);
  assert.equal(chooseProfile({...f.task,preferredProfileId:'astra',requirePreferred:true},profiles,pool,{},new Set()),null);
  const task={...f.task,profileRequests:{worker:{profileId:'astra',reason:'Difficult cross-system reasoning',required:false}}};
  assert.equal(chooseProfile(task,profiles,pool,{},new Set())?.profile.id,'astra');
  assert.equal(chooseProfile(task,profiles,pool,{},new Set(['astra']))?.profile.id,'normal');
  assert.equal(chooseProfile(task,profiles,pool,{},new Set(['astra','normal'])),null);
  assert.equal(chooseProfile({...task,profileRequests:{worker:{...task.profileRequests.worker,required:true}}},profiles,pool,{},new Set(['astra'])),null);
 }finally{f.close();}
});
test('a Heavyweight profile needs a request at Normal even when not frontier: automatic recovery never selects it (papercut 09748034)',()=>{
 const f=fixture();try{
  // A Heavyweight profile (rated below Frontier): worker failover, reviewer replacement and
  // coordinator selection all choose through chooseProfile with no request.
  const unflagged=pool.map(entry=>({...entry,capability:entry.capability&&'heavyweight' as const}));
  for(const role of ['worker','reviewer','coordinator'] as const){
   assert.equal(chooseProfile(f.task,profiles,unflagged,{normal:999},new Set(),role)?.profile.id,'normal',`${role}: the unrated Worker profile wins`);
   assert.equal(chooseProfile(f.task,profiles,unflagged,{},new Set(['normal']),role),null,`${role}: with it unavailable, nothing falls back to Heavyweight`);
  }
  const requested={...f.task,profileRequests:{worker:{profileId:'astra',reason:'Two same-defect review rounds',required:false}}};
  assert.equal(chooseProfile(requested,profiles,unflagged,{},new Set(['normal']))?.profile.id,'astra','an explicit owner request with a reason still selects it');
 }finally{f.close();}
});
test('requests remain subject to enabled state and provider availability; scope and role no longer gate (Spec 053)',()=>{
 const f=fixture();try{
  const task={...f.task,profileRequests:{worker:{profileId:'astra',reason:'Complexity justified',required:true}}};
  assert.equal(chooseProfile(task,profiles,pool.map(p=>p.profileId==='astra'?poolSchema.parse({...p,enabled:false}):p),{},new Set()),null);
  for(const changed of [{scopes:['mechanical'] as const},{roles:['reviewer'] as const}]){
   const entries=pool.map(p=>p.profileId==='astra'?poolSchema.parse({...p,...changed}):p);
   assert.equal(chooseProfile(task,profiles,entries,{},new Set())?.profile.id,'astra');
  }
  assert.equal(chooseProfile(task,profiles.map(p=>p.id==='astra'?{...p,available:false}:p),pool,{},new Set()),null);
  assert.throws(()=>profileRequestsSchema.parse({worker:{profileId:'astra',reason:' '}}));
 }finally{f.close();}
});
test('review and coordinator routing require their own request, including recovery selection',()=>{
 const f=fixture();try{
  f.store.setMeta('pool',pool);const engine=new Engine(f.store,{} as Adapter);engine.profiles=profiles;
  const workerRequested={...f.task,workerModel:'other-author',profileRequests:{worker:{profileId:'astra',reason:'Worker needs it',required:true}}};
  assert.equal(engine.resolution.select(workerRequested,'reviewer')?.profile.id,'normal');
  assert.equal(engine.resolution.select(workerRequested,'coordinator')?.profile.id,'normal');
  for(const role of ['reviewer','coordinator'] as const){
   const explicit={...workerRequested,profileRequests:{...workerRequested.profileRequests,[role]:{profileId:'fable',reason:'Independent complex reasoning required',required:true}}};
   assert.equal(engine.resolution.select(explicit,role)?.profile.id,'fable');
  }
  const sameAuthor={...workerRequested,workerModel:'fable',profileRequests:{reviewer:{profileId:'fable',reason:'Review',required:true}}};
  assert.equal(engine.resolution.select(sameAuthor,'reviewer'),null);
 }finally{f.close();}
});
test('group feedback tracks disabled and expired groups; profile autosave preserves the capability rating',()=>{
 const a={group:'fable',unavailable:true,reason:'Usage limit reached',retryAt:'2026-09-12'};
 assert.equal(activeGroupLimit([a],'fable',Date.parse('2026-09-08'))?.reason,'Usage limit reached');
 assert.equal(activeGroupLimit([a],'fable',Date.parse('2026-09-13')),undefined);
 assert.equal(activeGroupLimit([{...a,retryAt:'2026-09-12T09:00:00Z'}],'fable',Date.parse('2026-09-12T08:59:59Z'))?.group,'fable');
 assert.equal(activeGroupLimit([{...a,retryAt:'2026-09-12T09:00:00Z'}],'fable',Date.parse('2026-09-12T09:00:01Z')),undefined);
 assert.equal(activeGroupLimit([a],'astra',Date.parse('2026-09-08')),undefined);
 assert.equal(activeGroupLimit([{...a,retryAt:null}],'fable')?.group,'fable');
 assert.equal(activeGroupLimit([{...a,unavailable:false}],'fable'),undefined);
 assert.equal(normalizeRetryAt(''),null);assert.equal(normalizeRetryAt('   '),null);assert.equal(normalizeRetryAt(null),null);
 assert.equal(normalizeRetryAt(' 2026-09-12 '),'2026-09-12');assert.throws(()=>normalizeRetryAt('later'));
 assert.equal(saveProfileSettings(pool,pool[1]).at(-1)?.capability,'frontier');
});

// Spec 052 (Tom, 2026-10-18): the operator's usage level.
const tiered=(ids:Record<string,{capability?:ProfileCapability;weight?:ProfileWeight}>)=>({
  profiles:Object.keys(ids).map(id => profile(id)),
  pool:Object.entries(ids).map(([id,o])=>poolSchema.parse({profileId:id,enabled:true,group:id,roles:['worker','reviewer','coordinator'],weight:o.weight??'default',scopes:['general','complex'],capability:o.capability??null})),
});
// The live shape: a heavily weighted cheap Mechanical profile, two Worker
// profiles (what were medium and high), a Heavyweight Sol-class profile and a
// Frontier Opus-class one. The task's complexity is unset (medium).
const live=tiered({cheap:{capability:'mechanical',weight:'most'},mid:{capability:'worker'},pricey:{capability:'worker'},'frontier-a':{capability:'heavyweight'},'frontier-b':{capability:'frontier'}});
const pick=(usage:'low'|'normal'|'high'|'extra_high'|'maximum',recent:Record<string,number>={},unavailable=new Set<string>(),request?:{profileId:string;reason:string})=>{
  const f=fixture();try{
    const task=f.store.update(f.task.id,{profileRequests:request?profileRequestsSchema.parse({worker:{...request,required:false}}):undefined});
    return chooseProfile(task,live.profiles,live.pool,recent,unavailable,'worker',recent,usage,true)?.profile.id??null;
  }finally{f.close()}
};

test('Spec 053: the level starts a run at its own bracket, and Maximum starts a medium task on Heavyweight',()=>{
  assert.equal(pick('normal'),'mid','a medium task selects the Worker pool, the first Worker leading an equal rotation');
  assert.equal(pick('normal',{'profile:mid':50}),'pricey','history rotates inside the one Worker pool, never above it');
  assert.equal(pick('normal',{},new Set(['mid','pricey'])),'cheap','with no Worker profile, the nearest covered profile below is the shortfall');
  assert.equal(pick('high'),'mid','a medium task may climb no higher than Worker, so High still starts there');
  assert.equal(pick('extra_high'),'mid','Extra high starts on Worker too');
  assert.notEqual(pick('high'),'frontier-a','a profile above the climb bracket is never automatic');
  assert.notEqual(pick('extra_high'),'frontier-b','the tier bound holds at Extra high too');
  // Maximum follows the 2026-11-23 matrix: a medium task starts on Heavyweight,
  // and it no longer reserves the top two tiers.
  assert.equal(pick('maximum'),'frontier-a','at Maximum a medium task starts on Heavyweight');
  assert.equal(pick('maximum',{'profile:frontier-a':3}),'frontier-a','rotation stays inside the Heavyweight bracket; Frontier is not pooled with it');
  assert.equal(pick('maximum',{},new Set(['frontier-a'])),'frontier-b','with no Heavyweight profile, the nearest bracket above serves');
  assert.match(String(pick('maximum',{},new Set(['frontier-a','frontier-b']))),/^(mid|pricey)$/,'with neither top bracket available, Maximum falls short to the Worker pool');
  assert.equal(pick('low'),'cheap','a medium task at Low starts one bracket below: Mechanical');
});

test('Spec 052 (Tom, 2026-11-17): Extra high needs no permission, weight excludes nothing, and the requested-tier bound still applies; Low gates the top two tiers',()=>{
  assert.equal(pick('extra_high'),'mid','Extra high starts at the requested medium tier');
  assert.notEqual(pick('extra_high'),'frontier-b','a frontier profile above the requested tier is an explicit route');
  assert.equal(pick('extra_high',{},new Set(),{profileId:'frontier-b',reason:'Needs the strongest model'}),'frontier-b','an explicit request reaches above the requested tier');
  assert.equal(pick('low'),'cheap','at Low a medium task starts a tier below and keeps to the covered tiers');
  assert.notEqual(pick('low'),'frontier-b','a frontier profile still needs permission at Low');
  assert.equal(pick('low',{},new Set(),{profileId:'frontier-b',reason:'Needs the strongest model'}),'frontier-b','an explicit request is unaffected by the level');
});

test('Spec 052: a frontier profile needs permission at High whatever its weight, and is automatic at Maximum',()=>{
  const special=tiered({cheap:{},frontier:{capability:'frontier',weight:'most'}});
  const f=fixture();try{
    const task=f.store.task(f.task.id);
    assert.equal(chooseProfile(task,special.profiles,special.pool,{},new Set(),'worker',{},'high')?.profile.id,'cheap','at High a cheap frontier profile still needs a request');
    assert.equal(chooseProfile(task,special.profiles,special.pool,{},new Set(),'worker',{},'maximum')?.profile.id,'frontier','at Maximum demand reaches frontier and the frontier profile meets it');
  }finally{f.close()}
});

test('Spec 052: the stored level returns to normal when its end time passes',()=>{
  const f=fixture();try{
    assert.equal(f.store.usageLevel(),'normal');
    f.store.setMeta('usageLevel',{level:'maximum',until:new Date(Date.now()+60_000).toISOString(),setAt:new Date().toISOString()});
    assert.equal(f.store.usageLevel(),'maximum');
    assert.equal(f.store.usageLevel(Date.now()+120_000),'normal');
    assert.deepEqual({...f.store.usageView(Date.now()+120_000),until:null},{level:'normal',setLevel:'maximum',until:null,expired:true});
  }finally{f.close()}
});

test('Spec 052: a role left without a profile by the level permission says so and names the way out', () => {
  const f=fixture();try{
    // The author's own model cannot review it; the only other reviewer is
    // Heavyweight, which a high task reaches only by a recorded climb, so it
    // needs permission at Normal and Low.
    const reviewPool=tiered({author:{},critic:{capability:'heavyweight'}});
    f.store.setMeta('pool',reviewPool.pool);const engine=new Engine(f.store,{} as Adapter);engine.profiles=reviewPool.profiles;
    const task={...f.task,workerModel:'author',complexity:'high' as const};
    assert.equal(engine.resolution.select(task,'reviewer'),null);
    assert.equal(engine.resolution.usageCeilingNote(task,'reviewer'),'; the normal usage level requires an explicit profile request for heavyweight runs: route the reviewer to a profile or raise the usage level');
    f.store.setMeta('usageLevel',{level:'extra_high',until:null,setAt:new Date().toISOString()});
    assert.equal(engine.resolution.select(task,'reviewer')?.profile.id,'critic','Extra high needs no permission');
    assert.equal(engine.resolution.usageCeilingNote(task,'reviewer'),'');
    // The retained-reviewer replacement wait carries the same note.
    f.store.setMeta('usageLevel',{level:'low',until:null,setAt:new Date().toISOString()});
    const retained={...task,phase:'awaiting_review' as const,resolution:{...task.resolution,reviewerProfile:{...reviewPool.profiles[1],id:'gone'}}};
    assert.match(engine.resolution.usageCeilingNote(retained,'reviewer'),/low usage level requires an explicit profile request for heavyweight runs/);
    // When the pool itself has no candidate, the note stays silent.
    f.store.setMeta('pool',tiered({author:{}}).pool);
    assert.equal(engine.resolution.usageCeilingNote(task,'reviewer'),'');
  }finally{f.close()}
});

test('a required role request that cannot serve is named in the wait, with the route to fix it', () => {
  const f=fixture();try{
    const reviewPool=tiered({author:{},critic:{}});
    f.store.setMeta('pool',reviewPool.pool);const engine=new Engine(f.store,{} as Adapter);engine.profiles=reviewPool.profiles;
    const required=(profileId:string)=>({...f.task,profileRequests:profileRequestsSchema.parse({coordinator:{profileId,reason:'Owner pinned it',required:true}})});
    assert.equal(engine.resolution.requiredRouteNote(required('critic'),'coordinator'),'','an eligible required profile needs no note');
    assert.equal(engine.resolution.requiredRouteNote(required('astra'),'coordinator'),'; the required coordinator request names astra, but it is not in the profile pool: route role=coordinator to another profile');
    f.store.setMeta('pool',reviewPool.pool.map(entry=>entry.profileId==='critic'?{...entry,enabled:false}:entry));
    assert.match(engine.resolution.requiredRouteNote(required('critic'),'coordinator'),/it is disabled/);
    assert.equal(engine.resolution.requiredRouteNote(f.task,'coordinator'),'','no required request, no note');
  }finally{f.close()}
});
