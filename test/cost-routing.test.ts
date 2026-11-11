import { profile } from './support/fakes';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store/store';
import {Engine} from '../core/engine';
import {chooseProfile} from '../core/dispatch/routing';
import {submissionSchema,profileRequestsSchema,poolSchema,type Profile} from '../shared/contracts';
import type {Adapter} from '../core/host';
import {activeGroupLimit,normalizeRetryAt,saveProfileSettings} from '../shared/pool';
/** Spec 052: these requests were signed off on the board (2026-10-21). */
const SIGNED={status:'approved' as const,decisionId:'decision',by:'operator (board)',at:'2026-10-21T00:00:00.000Z',note:''};

const profiles=[profile('normal'),profile('astra'),profile('fable')];
const pool=profiles.map(p=>poolSchema.parse({profileId:p.id,enabled:true,group:p.id,roles:['worker','reviewer','coordinator'],weight:1,scopes:['general','complex'],capability:p.id==='normal'?null:'frontier',cost:p.id==='normal'?'low':'very_high'}));
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ns-cost-')),store=new Store(join(dir,'db'));
 const task=store.insert(submissionSchema.parse({submissionId:'task',title:'Complex work',repoPath:'/repo',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin',scope:'complex'}),'host','handoff','a'.repeat(40));
 return {store,task,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('frontier profiles never enter automatic selection or fallback below Maximum, regardless of weight or usage',()=>{
 const f=fixture();try{
  assert.equal(chooseProfile(f.task,profiles,pool,{normal:999},new Set())?.profile.id,'normal');
  assert.equal(chooseProfile(f.task,profiles,pool,{},new Set(['normal'])),null);
  assert.equal(chooseProfile({...f.task,preferredProfileId:'astra',requirePreferred:true},profiles,pool,{},new Set()),null);
  const task={...f.task,profileRequests:{worker:{profileId:'astra',reason:'Difficult cross-system reasoning',required:false,signoff:SIGNED}}};
  assert.equal(chooseProfile(task,profiles,pool,{},new Set())?.profile.id,'astra');
  assert.equal(chooseProfile(task,profiles,pool,{},new Set(['astra']))?.profile.id,'normal');
  assert.equal(chooseProfile(task,profiles,pool,{},new Set(['astra','normal'])),null);
  assert.equal(chooseProfile({...task,profileRequests:{worker:{...task.profileRequests.worker,required:true}}},profiles,pool,{},new Set(['astra'])),null);
 }finally{f.close();}
});
test('a very_high-cost profile needs a request at Normal even when not frontier: automatic recovery never selects it (papercut 09748034)',()=>{
 const f=fixture();try{
  // A very_high-cost profile rated below frontier: worker failover, reviewer replacement and
  // coordinator selection all choose through chooseProfile with no request.
  const unflagged=pool.map(entry=>({...entry,capability:entry.capability&&'very_high' as const}));
  for(const role of ['worker','reviewer','coordinator'] as const){
   assert.equal(chooseProfile(f.task,profiles,unflagged,{normal:999},new Set(),role)?.profile.id,'normal',`${role}: the cheap profile wins`);
   assert.equal(chooseProfile(f.task,profiles,unflagged,{},new Set(['normal']),role),null,`${role}: with it unavailable, nothing falls back to very_high`);
  }
  const requested={...f.task,profileRequests:{worker:{profileId:'astra',reason:'Two same-defect review rounds',required:false,signoff:SIGNED}}};
  assert.equal(chooseProfile(requested,profiles,unflagged,{},new Set(['normal']))?.profile.id,'astra','an explicit owner request with a reason still selects it');
 }finally{f.close();}
});
test('requests remain subject to enabled state and provider availability; scope and role no longer gate (Spec 053)',()=>{
 const f=fixture();try{
  const task={...f.task,profileRequests:{worker:{profileId:'astra',reason:'Complexity justified',required:true,signoff:SIGNED}}};
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
  const workerRequested={...f.task,workerModel:'other-author',profileRequests:{worker:{profileId:'astra',reason:'Worker needs it',required:true,signoff:SIGNED}}};
  assert.equal(engine.resolution.select(workerRequested,'reviewer')?.profile.id,'normal');
  assert.equal(engine.resolution.select(workerRequested,'coordinator')?.profile.id,'normal');
  for(const role of ['reviewer','coordinator'] as const){
   const explicit={...workerRequested,profileRequests:{...workerRequested.profileRequests,[role]:{profileId:'fable',reason:'Independent complex reasoning required',required:true,signoff:SIGNED}}};
   assert.equal(engine.resolution.select(explicit,role)?.profile.id,'fable');
  }
  const sameAuthor={...workerRequested,workerModel:'fable',profileRequests:{reviewer:{profileId:'fable',reason:'Review',required:true,signoff:SIGNED}}};
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
type Level='very_low'|'low'|'medium'|'high'|'very_high';
const tiered=(ids:Record<string,{cost:Level|null;capability?:Exclude<Level,'very_low'>|'frontier';weight?:number}>)=>({
  profiles:Object.keys(ids).map(id => profile(id)),
  pool:Object.entries(ids).map(([id,o])=>poolSchema.parse({profileId:id,enabled:true,group:id,roles:['worker','reviewer','coordinator'],weight:o.weight??1,scopes:['general','complex'],cost:o.cost,capability:o.capability??null})),
});
// The live shape: a heavily weighted cheap profile, a very_high-cost Sol-class
// profile and a frontier Opus-class one. The task's complexity is unset (medium).
const live=tiered({cheap:{cost:'very_low',capability:'low',weight:4},mid:{cost:'medium',capability:'medium'},pricey:{cost:'high',capability:'high'},'frontier-a':{cost:'very_high',capability:'very_high'},'frontier-b':{cost:'very_high',capability:'frontier'}});
const pick=(usage:'minimal'|'low'|'normal'|'high'|'maximum',recent:Record<string,number>={},unavailable=new Set<string>(),request?:{profileId:string;reason:string})=>{
  const f=fixture();try{
    const task=f.store.update(f.task.id,{profileRequests:request?profileRequestsSchema.parse({worker:{...request,required:false,signoff:SIGNED}}):undefined});
    return chooseProfile(task,live.profiles,live.pool,recent,unavailable,'worker',recent,usage)?.profile.id??null;
  }finally{f.close()}
};

test('Spec 053: the usage level moves the demand; the set meeting it rotates with the cost lean, and frontier stays out at normal',()=>{
  assert.equal(pick('normal'),'mid','demand medium: every profile rated medium or above rotates, cost leaning the share (mid lean 4, pricey lean 2)');
  assert.equal(pick('normal',{'profile:mid':50}),'pricey','heavy use leans the share to the costlier profile in the set; mid stays in it (Tom, 2026-11-04)');
  assert.equal(pick('normal',{},new Set(['mid'])),'pricey','an unavailable group leaves the tier');
  assert.match(String(pick('high')),/^(pricey|frontier-a)$/,'demand high: pricey and, at High usage, the very_high-cost profile rotate; the frontier profile stays request-only (Spec 052, Spec 053)');
  assert.equal(pick('high',{'profile:pricey':50}),'frontier-a','at High the very_high-cost, very_high-capability profile is automatic');
  assert.notEqual(pick('high',{'profile:pricey':50,'profile:frontier-a':50}),'frontier-b','at High a frontier profile is never automatic');
  assert.match(String(pick('maximum')),/^frontier-[ab]$/,'demand very_high: both the very_high and the frontier profile are automatic at Maximum');
  assert.equal(pick('maximum',{'profile:frontier-a':3}),'frontier-b','rotation stays inside the tier');
  assert.equal(pick('maximum',{},new Set(['frontier-a','frontier-b'])),'pricey','a shortfall takes the most capable available');
  assert.equal(pick('low'),'cheap','demand low');
});

test('Spec 053: minimal keeps to the low cost ceiling; an explicit request is unaffected by the level',()=>{
  assert.equal(pick('minimal'),'cheap');
  assert.equal(pick('minimal',{},new Set(['cheap'])),null,'nothing above low cost is automatic at minimal');
  assert.equal(pick('minimal',{},new Set(),{profileId:'pricey',reason:'Needs the stronger model'}),'pricey');
});

test('Spec 052: a frontier profile is request-only below Maximum whatever its cost, and automatic at Maximum',()=>{
  const special=tiered({cheap:{cost:'very_low'},frontier:{cost:'low',capability:'frontier',weight:9}});
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

test('Spec 052: a role left without a profile by the usage ceiling says so and names the way out', () => {
  const f=fixture();try{
    // The only independent reviewer costs high: Normal selects it, Low does not.
    const reviewPool=tiered({author:{cost:'low'},critic:{cost:'high'}});
    f.store.setMeta('pool',reviewPool.pool);const engine=new Engine(f.store,{} as Adapter);engine.profiles=reviewPool.profiles;
    const task={...f.task,workerModel:'author'};
    assert.equal(engine.resolution.select(task,'reviewer')?.profile.id,'critic');
    assert.equal(engine.resolution.usageCeilingNote(task,'reviewer'),'');
    f.store.setMeta('usageLevel',{level:'low',until:null,setAt:new Date().toISOString()});
    assert.equal(engine.resolution.select(task,'reviewer'),null);
    assert.equal(engine.resolution.usageCeilingNote(task,'reviewer'),'; the low usage level holds automatic selection below critic (high cost): raise the usage level or route the reviewer to a profile');
    // The retained-reviewer replacement wait carries the same note.
    const retained={...task,phase:'awaiting_review' as const,resolution:{...task.resolution,reviewerProfile:{...reviewPool.profiles[1],id:'gone'}}};
    assert.match(engine.resolution.usageCeilingNote(retained,'reviewer'),/low usage level holds automatic selection below critic/);
    // When the pool itself has no candidate, the note stays silent.
    f.store.setMeta('pool',tiered({author:{cost:'low'}}).pool);
    assert.equal(engine.resolution.usageCeilingNote(task,'reviewer'),'');
  }finally{f.close()}
});

test('a required role request that cannot serve is named in the wait, with the route to fix it', () => {
  const f=fixture();try{
    const reviewPool=tiered({author:{cost:'low'},critic:{cost:'low'}});
    f.store.setMeta('pool',reviewPool.pool);const engine=new Engine(f.store,{} as Adapter);engine.profiles=reviewPool.profiles;
    const required=(profileId:string)=>({...f.task,profileRequests:profileRequestsSchema.parse({coordinator:{profileId,reason:'Owner pinned it',required:true,signoff:SIGNED}})});
    assert.equal(engine.resolution.requiredRouteNote(required('critic'),'coordinator'),'','an eligible required profile needs no note');
    assert.equal(engine.resolution.requiredRouteNote(required('astra'),'coordinator'),'; the required coordinator request names astra, but it is not in the profile pool: route role=coordinator to another profile');
    f.store.setMeta('pool',reviewPool.pool.map(entry=>entry.profileId==='critic'?{...entry,enabled:false}:entry));
    assert.match(engine.resolution.requiredRouteNote(required('critic'),'coordinator'),/it is disabled/);
    assert.equal(engine.resolution.requiredRouteNote(f.task,'coordinator'),'','no required request, no note');
  }finally{f.close()}
});
