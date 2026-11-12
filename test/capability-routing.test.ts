import { profile, observeIdle } from './support/fakes';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store/store';
import {Engine} from '../core/engine';
import {chooseProfile,eligibilityReasons,validateNamedProfile} from '../core/dispatch/routing';
import { liveRepositorySharer, repositorySharedWorkspaces, sharedRepositoryArchiveHold } from '../core/workspaces/repository-archive-gate';
import {parseNorthstarDocument,submissionQueueFields} from '../core/planning/handoff';
import {
  capabilityLevelSchema,outcomeSchema,poolRecordFromLegacy,poolSchema,scopeSchema,
  submissionRecordFromLegacy,submissionSchema,taskControlInputSchema,type Profile,type PoolEntry,type Task,type UsageLevel,
} from '../shared/contracts';
import {saveProfileSettings} from '../shared/pool';
import type {Adapter} from '../core/host';


/** One worker per profile capability stop (frontier is request-only below Maximum), equal weight, distinct groups. */
const ladder=():{profiles:Profile[];pool:PoolEntry[]}=>{
  const levels=['low','medium','high','very_high','frontier'] as const;
  const profiles=levels.map(level=>profile(`agent-${level}`));
  const pool=profiles.map((p,i)=>poolSchema.parse({profileId:p.id,enabled:true,group:`g-${i}`,roles:['worker'],weight:1,scopes:['general','mechanical','complex'],capability:levels[i],cost:['very_low','low','medium','high','high'][i]}));
  return {profiles,pool};
};
const taskOf=(more:Partial<Task>={}):Task=>submissionSchema.parse({
  submissionId:'weighted',title:'Weighted work',repoPath:'/repo',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin',...more,
}) as Task;
/** Equal nonzero usage for every profile, so ordering is decided by fit instead of the id tie-break. */
const equalUsage=(pool:PoolEntry[]):Record<string,number>=>
  Object.fromEntries([...pool.map(e=>[`profile:${e.profileId}`,1]),...pool.map(e=>[e.group,1])]);
const ids=(chosen:ReturnType<typeof chooseProfile>)=>chosen?.profile.id ?? null;


test('invalid enum values are refused on the pool rating, task complexity and scope spellings',()=>{
  assert.throws(()=>poolSchema.parse({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:1,scopes:['general'],capability:'enormous'}));
  assert.throws(()=>poolSchema.parse({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:1,scopes:['general'],capability:2}));
  assert.throws(()=>submissionSchema.parse({submissionId:'s',title:'t',repoPath:'/r',planningCommit:'a'.repeat(40),handoffPath:'h',originAgentId:'o',complexity:'huge'}));
  assert.throws(()=>scopeSchema.parse('optional'));
  const parsed=poolSchema.parse({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:1,scopes:['general'],capability:'very_high'});
  assert.equal(parsed.capability,'very_high');
  assert.equal(submissionSchema.parse({submissionId:'s',title:'t',repoPath:'/r',planningCommit:'a'.repeat(40),handoffPath:'h',originAgentId:'o',complexity:null}).complexity,null,'complexity clears explicitly');
});






test('explicit preferred and required requests win independent of rating distance',()=>{
  const {profiles,pool}=ladder();
  const far=pool.find(e=>e.profileId==='agent-low')!,near=pool.find(e=>e.profileId==='agent-very_high')!;
  const usage=equalUsage(pool);
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_high',preferredProfileId:far.profileId}),profiles,pool,usage,new Set())),far.profileId,'optional preference wins over the best fit');
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_low',preferredProfileId:near.profileId}),profiles,pool,usage,new Set())),near.profileId);
  assert.equal(chooseProfile(taskOf({complexity:'very_high',preferredProfileId:far.profileId,requirePreferred:true}),profiles,pool.filter(e=>e.profileId!==far.profileId),usage,new Set()),null,'required preference never falls back to a perfect fit');
  const requested=taskOf({complexity:'very_high',profileRequests:{worker:{profileId:far.profileId,reason:'Operator asked for this profile',required:false}}});
  assert.equal(ids(chooseProfile(requested,profiles,pool,usage,new Set())),far.profileId);
});

test('Spec 053: disabled, frontier (below Maximum) and unavailable profiles stay gated; roles and scopes no longer gate',()=>{
  const {profiles,pool}=ladder();
  const task=taskOf({complexity:'very_high'});
  const usage=equalUsage(pool);
  for(const changed of [{enabled:false},{capability:'frontier'}] as const){
    const entries=pool.map(e=>e.profileId==='agent-very_high'?poolSchema.parse({...e,...changed}):e);
    assert.equal(ids(chooseProfile(task,profiles,entries,usage,new Set())),'agent-high',`${JSON.stringify(changed)} never admits the gated profile; the demand falls short to the next`);
  }
  assert.equal(ids(chooseProfile(task,profiles,pool,usage,new Set(['g-3']))),'agent-high','an unavailable group is gated');
  for(const changed of [{scopes:['mechanical'] as const},{roles:['reviewer'] as const}] as const){
    const entries=pool.map(e=>e.profileId==='agent-very_high'?poolSchema.parse({...e,...changed}):e);
    assert.equal(ids(chooseProfile(task,profiles,entries,usage,new Set())),'agent-very_high',`${JSON.stringify(changed)} no longer gates (Spec 053)`);
  }
  assert.match(eligibilityReasons({...task,scope:'complex'},profiles,pool.map(e=>e.profileId==='agent-very_high'?{...e,enabled:false}:e),[{group:'g-0',unavailable:true,reason:'quota',retryAt:null}]),/disabled/);
  assert.match(eligibilityReasons({...task,scope:'complex'},profiles,pool,[{group:'g-0',unavailable:true,reason:'quota',retryAt:null}]),/quota/);
  const narrow=pool.map(e=>e.profileId==='agent-low'?poolSchema.parse({...e,scopes:['general'] as const,roles:['reviewer'] as const}):e);
  assert.doesNotThrow(()=>validateNamedProfile('agent-low','worker','complex',profiles,narrow,'reason'),'a route is no longer refused on role or scope');
});

test('Spec 053: the demand keeps every profile that meets it, rotates within them, and falls short to the most capable',()=>{
  const {profiles,pool}=ladder();
  const usage=equalUsage(pool);
  for(const level of ['very_low','low','medium','high','very_high'] as const)
    assert.equal(ids(chooseProfile(taskOf({complexity:level}),profiles,pool,usage,new Set())),`agent-${level==='very_low'?'low':level}`,`complexity ${level}`);
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_high'}),profiles,pool,usage,new Set(),'worker',usage,'maximum')),'agent-frontier','at Maximum demand reaches frontier and the frontier profile is automatic');
  assert.equal(ids(chooseProfile(taskOf({}),profiles,pool,usage,new Set())),'agent-medium','an unset complexity counts as medium');
  const priced=pool.map(e=>poolSchema.parse({...e,cost:e.profileId==='agent-very_high'?'low':'very_high'}));
  assert.equal(ids(chooseProfile(taskOf({complexity:'medium'}),profiles,priced,usage,new Set(),'worker',usage,'maximum')),'agent-very_high','a cheaper profile that meets the demand beats a closer but costlier fit');
  const capped=pool.filter(e=>e.profileId!=='agent-very_high'&&e.profileId!=='agent-high');
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_high'}),profiles,capped,usage,new Set())),'agent-medium','a shortfall takes the most capable available');
  assert.equal(ids(chooseProfile(taskOf({complexity:'high'}),profiles,pool,usage,new Set(),'worker',usage,'low')),'agent-medium','the Low usage level takes a step off the demand');
  const sameCost=pool.map(e=>poolSchema.parse({...e,cost:'medium'}));
  assert.deepEqual([0,1,2].map(i=>ids(chooseProfile(taskOf({complexity:'medium'}),profiles,sameCost,{...usage,[`profile:agent-medium`]:9,[`profile:agent-high`]:9+i},new Set()))),['agent-very_high','agent-very_high','agent-very_high'],'every profile meeting the demand rotates at equal cost, the least used first');
  assert.equal(ids(chooseProfile(taskOf({complexity:'medium'}),profiles,sameCost,usage,new Set())),'agent-high','equal use: the id tie-break inside the tier');
});

test('Spec 053: the stored role offsets move every automatic selection; invalid stored offsets fall back to the defaults',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ns-offsets-')),store=new Store(join(dir,'db'));
  try{
    const {profiles,pool}=ladder();
    store.setMeta('pool',pool);
    const engine=new Engine(store,{} as Adapter);engine.profiles=profiles;
    const base={...taskOf({complexity:'high'}),workerModel:'other-author',workerModels:['other-author']};
    assert.deepEqual(store.demandRoleOffsets(),{worker:0,reviewer:0,coordinator:-2});
    assert.equal(engine.resolution.select(base,'reviewer')?.profile.id,'agent-high');
    store.setMeta('demandRoleOffsets',{worker:1,reviewer:-1,coordinator:0});
    assert.equal(engine.resolution.select(base,'reviewer')?.profile.id,'agent-high','reviewer −1 admits every profile rated medium or above; a fresh pool ties and the id breaks it');
    assert.equal(engine.resolution.select(base,'coordinator')?.profile.id,'agent-high','coordinator 0');
    assert.equal(ids(chooseProfile(base,profiles,pool,equalUsage(pool),new Set(),'worker',equalUsage(pool),'normal',store.demandRoleOffsets())),'agent-very_high','worker +1');
    store.setMeta('demandRoleOffsets',{worker:9,reviewer:0,coordinator:0});
    assert.deepEqual(store.demandRoleOffsets(),{worker:0,reviewer:0,coordinator:-2},'an out-of-range stored value is ignored');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('Spec 053: worker, reviewer and coordinator selection use the demand; the coordinator needs two steps less; explicit requests still lead',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ns-capability-')),store=new Store(join(dir,'db'));
  try{
    const {profiles,pool}=ladder();
    store.setMeta('pool',pool);
    const engine=new Engine(store,{} as Adapter);engine.profiles=profiles;
    for(const entry of pool){store.chargeAssignment(entry.group,entry.profileId);}
    const base={...taskOf({complexity:'very_high'}),workerModel:'other-author',workerModels:['other-author']};
    assert.equal(engine.resolution.select(base,'reviewer')?.profile.id,'agent-very_high','the reviewer matches the task');
    assert.equal(engine.resolution.select(base,'coordinator')?.profile.id,'agent-medium','the coordinator needs two steps less');
    const requested={...base,profileRequests:{...base.profileRequests,reviewer:{profileId:'agent-low',reason:'Operator named the reviewer',required:false}}};
    assert.equal(engine.resolution.select(requested,'reviewer')?.profile.id,'agent-low');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('set_routing carries complexity, clears it with null, records it in the event and refuses the legacy capability spelling',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ns-capability-')),store=new Store(join(dir,'db'));
  const adapter={profiles:async()=>[],observe:observeIdle('ws', 'agent')} as unknown as Adapter;
  const engine=new Engine(store,adapter,0);
  try{
    const task=store.insert(taskOf(),'host','handoff','a'.repeat(40));
    assert.throws(()=>taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'set_routing',reason:'r',capability:'complex'}),/legacy "capability" field is refused/);
    assert.equal(taskControlInputSchema.safeParse({taskId:task.id,version:1,action:'set_routing',reason:'r',complexity:'absurd'}).success,false);
    const raised=await engine.performTaskControl(taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'set_routing',reason:'Hard reasoning work',complexity:'very_high'}));
    assert.equal(raised.complexity,'very_high');
    let event=store.events(task.id).find(e=>e.kind==='routing_changed')!;
    assert.deepEqual(JSON.parse(event.detail).after,{critical:false,scope:'general',complexity:'very_high',preferredProfileId:'',requirePreferred:false,thinkingOptionId:'',profileRequests:{}});
    const cleared=await engine.performTaskControl(taskControlInputSchema.parse({taskId:task.id,version:store.task(task.id).version,action:'set_routing',reason:'Back to automatic',complexity:null}));
    assert.equal(cleared.complexity,null);
    event=store.events(task.id).filter(e=>e.kind==='routing_changed')[0]!;
    assert.equal(JSON.parse(event.detail).after.complexity,null);
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('durable rows round-trip complexity; legacy task rows parse without migration mutations',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ns-capability-'));
  try{
    const store=new Store(join(dir,'db'));
    const inserted=store.insert(submissionSchema.parse({submissionId:'complex',title:'Complex work',repoPath:'/repo',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'origin',scope:'complex',complexity:'high'}),'host','handoff','a'.repeat(40));
    assert.equal(inserted.scope,'complex');assert.equal(inserted.complexity,'high');
    const row=JSON.parse(String((store.db.prepare('SELECT data FROM tasks WHERE id=?').get(inserted.id) as {data:string}).data));
    assert.equal(row.scope,'complex');assert.equal(row.complexity,'high');assert.ok(!('capability' in row),'current writes never carry the legacy spelling');
    store.close();
    const reopened=new Store(join(dir,'db'));
    assert.equal(reopened.task(inserted.id).complexity,'high');
    // A row written before the rename parses with its legacy key intact on disk.
    reopened.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({...row,scope:undefined,capability:'complex'}),inserted.id);
    const legacyTask=reopened.task(inserted.id);
    assert.equal(legacyTask.scope,'complex');assert.equal(legacyTask.complexity,'high');
    const onDisk=JSON.parse(String((reopened.db.prepare('SELECT data FROM tasks WHERE id=?').get(inserted.id) as {data:string}).data));
    assert.equal(onDisk.capability,'complex','the read boundary never rewrites stored bytes');
    reopened.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('submission and pool records rename the legacy keys and refuse a record carrying both spellings',()=>{
  const base={submissionId:'s',title:'t',repoPath:'/r',planningCommit:'a'.repeat(40),handoffPath:'h',originAgentId:'o'};
  const legacy=submissionSchema.parse(submissionRecordFromLegacy({...base,capability:'mechanical'}));
  assert.equal(legacy.scope,'mechanical');assert.equal(legacy.complexity,undefined);
  assert.throws(()=>submissionRecordFromLegacy({...base,capability:'general',scope:'complex'}),/both the legacy "capability" and the current "scope"/);
  const poolLegacy=poolSchema.parse(poolRecordFromLegacy({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:1,capabilities:['general','complex'],cost:'low',capability:'low'}));
  assert.deepEqual(poolLegacy.scopes,['general','complex']);assert.equal(poolLegacy.capability,'low');assert.equal(poolLegacy.cost,'low');
  assert.throws(()=>poolRecordFromLegacy({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:1,capabilities:['general'],scopes:['complex']}),/both the legacy "capabilities" and the current "scopes"/);
  assert.equal(saveProfileSettings([poolLegacy],{...poolLegacy,group:'g2'}).at(-1)!.capability,'low','pool saves never drop the rating or cost');
  assert.equal(saveProfileSettings([poolLegacy],{...poolLegacy,group:'g2'}).at(-1)!.cost,'low');
});

const outcomeRecord=(taskId:string,routing:Record<string,unknown>)=>({
  taskId,submissionId:`s-${taskId}`,title:'T',repository:{origin:'owner/repo',path:'/repo'},outcome:'done',reason:'Merged',
  pr:null,mergeCommit:null,syncedCommit:null,review:null,validation:null,closeout:null,
  brief:{digest:`sha256:${'a'.repeat(64)}`,mediaType:'text/markdown',text:'B',source:'handoff',version:null,earlierDigests:[]},
  workers:[],reviewers:[],siblings:[],startedAt:'2026-10-12T00:00:00.000Z',finishedAt:null,backfilled:false,routing,
});

test('outcome routing records scope and complexity',()=>{
  const outcome=outcomeSchema.parse(outcomeRecord('t',{scope:'complex',complexity:'high',preferredProfileId:'',requirePreferred:false,thinkingOptionId:''}));
  assert.equal(outcome.routing?.scope,'complex');assert.equal(outcome.routing?.complexity,'high');
  // The legacy `capability` spelling went with schema 54 (task 989): the strict schema
  // refuses it, and the store step rewrote the stored rows once on open.
  assert.throws(()=>outcomeSchema.parse(outcomeRecord('t2',{capability:'mechanical',preferredProfileId:'',requirePreferred:false,thinkingOptionId:''})));
});

test('brief frontmatter parses legacy capability and current scope+complexity; a document with both is refused',()=>{
  const wrap=(queue:string)=>`---\ntitle: Frontmatter fixture\nqueue_approval: "Tom approves"\nqueue:\n${queue}---\n\n## Outcome\n\nBuild it.\n`;
  const legacy=parseNorthstarDocument(wrap('  capability: mechanical\n'),'brief');
  assert.equal(legacy.queue.scope,'mechanical');
  const current=parseNorthstarDocument(wrap('  scope: complex\n  complexity: very_high\n'),'brief');
  assert.equal(current.queue.scope,'complex');assert.equal(current.queue.complexity,'very_high');
  assert.throws(()=>parseNorthstarDocument(wrap('  capability: general\n  scope: general\n'),'brief'),/both the legacy "capability" and the current "scope"/);
  assert.throws(()=>parseNorthstarDocument(wrap('  scope: complex\n  complexity: enormous\n'),'brief'),/Invalid brief frontmatter/);
  const submission=submissionSchema.parse({submissionId:'frontmatter',title:'Frontmatter fixture',repoPath:'/repo',planningCommit:'a'.repeat(40),originAgentId:'origin',brief:{text:wrap('  scope: complex\n  complexity: very_high\n'),mediaType:'text/markdown',digest:'sha256:'+'c'.repeat(64)},...submissionQueueFields(current.queue)});
  assert.equal(submission.scope,'complex');assert.equal(submission.complexity,'very_high');
});

/** Spec 053 cost lean: the share of `selections` picks each profile gets when every pick is recorded (recent and lifetime counts both). */
const simulate=(task:Task,profiles:Profile[],pool:PoolEntry[],selections:number,unavailable:Set<string>=new Set(),usage:UsageLevel='normal'):Record<string,number>=>{
  const counts:Record<string,number>={};
  for(let i=0;i<selections;i++){
    const chosen=chooseProfile(task,profiles,pool,counts,unavailable,'worker',counts,usage);
    if(!chosen)break;
    counts[`profile:${chosen.profile.id}`]=(counts[`profile:${chosen.profile.id}`]??0)+1;
    counts[chosen.entry.group]=(counts[chosen.entry.group]??0)+1;
  }
  return Object.fromEntries(Object.entries(counts).filter(([key])=>key.startsWith('profile:')).map(([key,n])=>[key.slice('profile:'.length),n]));
};
test('Spec 053 cost lean (Tom, 2026-11-04): cost shifts the share within the set, never removes a profile',()=>{
  // The live pool at medium demand as the 2026-11-04 report describes it: GLM is cost low; DeepSeek, Grok and Haiku cost medium; all rated medium or above.
  const live=[['glm','low','medium'],['deepseek','medium','high'],['grok','medium','medium'],['haiku','medium','medium']] as const;
  const profiles=live.map(([id])=>profile(id));
  const pool=live.map(([id,cost,capability])=>poolSchema.parse({profileId:id,enabled:true,group:id,roles:['worker'],weight:1,scopes:['general'],cost,capability}));
  const shares=simulate(taskOf({complexity:'medium'}),profiles,pool,100);
  assert.deepEqual(shares,{glm:40,deepseek:20,grok:20,haiku:20},'100 selections: GLM (low, lean 8) takes 40, each medium-cost profile (lean 4) takes 20; none starved');
  const high=simulate(taskOf({complexity:'medium'}),profiles,pool.map(e=>e.profileId==='grok'?poolSchema.parse({...e,cost:'high'}):e),100);
  assert.ok(Math.abs(high.grok-100*2/18)<=1,`a high-cost profile in the set takes its lean share (2 of 18), not none: ${high.grok}`);
});
test('Spec 053 cost lean: equal cost follows configured weight; a very_low-cost profile gets 16 times a very_high-cost one',()=>{
  const profiles=[profile('heavy'),profile('light')];
  const pool=[poolSchema.parse({profileId:'heavy',enabled:true,group:'heavy',roles:['worker'],weight:2,scopes:['general'],cost:'medium',capability:'high'}),
    poolSchema.parse({profileId:'light',enabled:true,group:'light',roles:['worker'],weight:1,scopes:['general'],cost:'medium',capability:'high'})];
  assert.deepEqual(simulate(taskOf({complexity:'high'}),profiles,pool,30),{heavy:20,light:10},'weight 2 to weight 1 at equal cost');
  const costs=[poolSchema.parse({profileId:'cheap',enabled:true,group:'cheap',roles:['worker'],weight:1,scopes:['general'],cost:'very_low',capability:'very_high'}),
    poolSchema.parse({profileId:'dear',enabled:true,group:'dear',roles:['worker'],weight:1,scopes:['general'],cost:'very_high',capability:'very_high'})];
  const ratio=simulate(taskOf({complexity:'very_high'}),[profile('cheap'),profile('dear')],costs,170,new Set(),'maximum');
  assert.deepEqual(ratio,{cheap:160,dear:10},'16 : 1 by the cost lean, and the frontier profile still runs at its predictable share');
});
test('Spec 053 cost lean: an unavailable group leaves the set and the rest rotate; ceilings and the frontier tier still exclude',()=>{
  const live=[['glm','low','medium'],['deepseek','medium','high'],['haiku','medium','medium'],['frontier','very_high','very_high'],['flagged','medium','frontier']] as const;
  const profiles=live.map(([id])=>profile(id));
  const pool=live.map(([id,cost,capability])=>poolSchema.parse({profileId:id,enabled:true,group:id,roles:['worker'],weight:1,scopes:['general'],cost,capability}));
  const skipped=simulate(taskOf({complexity:'medium'}),profiles,pool,60,new Set(['glm']));
  assert.deepEqual(skipped,{deepseek:30,haiku:30},'an unavailable group is skipped; the rest of the set rotates at equal lean; the frontier profile stays out');
  const top=simulate(taskOf({complexity:'very_high'}),profiles,pool,20);
  assert.equal(top.frontier,undefined,'very_high cost stays above the Normal ceiling without a request');
  assert.equal(top.flagged,undefined,'a frontier profile stays out of automatic selection below Maximum');
  assert.deepEqual(top,{deepseek:20},'a shortfall takes the most capable automatic profile');
});

test('deterministic ties break by profile id and stay stable across repeated selection',()=>{
  const profiles=[profile('b-agent'),profile('a-agent')];
  const pool=profiles.map(p=>poolSchema.parse({profileId:p.id,enabled:true,group:'same',roles:['worker'],weight:1,scopes:['general'],capability:'high'}));
  const task=taskOf({complexity:'high'});
  for(let round=0;round<5;round++)assert.equal(ids(chooseProfile(task,profiles,pool,{},new Set())),'a-agent');
  assert.equal(ids(chooseProfile(task,[...profiles].reverse(),[...pool].reverse(),{},new Set())),'a-agent');
});

test('set_routing naming a profile before the catalog loads refuses as retryable; complexity-only routing still applies (QA 622c955c)',async()=>{
  const {PROFILE_CATALOG_LOADING_REFUSAL}=await import('../core/engine');
  const dir=mkdtempSync(join(tmpdir(),'ns-capability-')),store=new Store(join(dir,'db'));
  const adapter={profiles:async()=>[],observe:observeIdle('ws', 'agent')} as unknown as Adapter;
  const engine=new Engine(store,adapter,0);
  try{
    const task=store.insert(taskOf(),'host','handoff','a'.repeat(40));
    await assert.rejects(engine.performTaskControl(taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'set_routing',reason:'Name the author',preferredProfileId:'agent-very_high'})),
      new RegExp(PROFILE_CATALOG_LOADING_REFUSAL.slice(0,40)));
    assert.equal(store.task(task.id).version,task.version,'the refusal writes nothing');
    const scoped=await engine.performTaskControl(taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'set_routing',reason:'Scope only',complexity:'low'}));
    assert.equal(scoped.complexity,'low');
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('nucleus#1139: a task\'s host catalog keeps profiles it cannot run out of selection', async t => {
  // One profile with a thinking level the T3 catalog does not report, one it does.
  const luna=profile('luna','luna-model',{thinkingOptionId:'xhigh',supportedThinking:['xhigh']});
  const sol=profile('sol','sol-model',{thinkingOptionId:'high',supportedThinking:['high']});
  const all=[luna,sol];
  const pool=all.map((p,i)=>poolSchema.parse({profileId:p.id,enabled:true,group:`g-${i}`,roles:['worker'],weight:1,scopes:['general','mechanical','complex'],capability:'medium'}));
  const t3Catalog={providers:[{key:'test',label:'test',available:true,problem:'',models:[
    {id:'luna-model',label:'Luna',aliases:[],thinkingOptions:[{id:'low',label:'Low'},{id:'high',label:'High'}],defaultThinkingOptionId:null,modes:[],features:[]},
    {id:'sol-model',label:'Sol',aliases:[],thinkingOptions:[{id:'high',label:'High'}],defaultThinkingOptionId:null,modes:[],features:[]}]}]};
  const primaryAdapter={profiles:async()=>all,observe:observeIdle('ws','agent'),catalog:async()=>({providers:[]})} as unknown as Adapter;
  const t3Adapter={profiles:async()=>[],observe:observeIdle('ws','agent'),catalog:async()=>t3Catalog} as unknown as Adapter;
  const dir=mkdtempSync(join(tmpdir(),'ns-host-routing-')),store=new Store(join(dir,'db'));
  store.setProfiles([{ id: luna.id, name: luna.id, provider: luna.provider, model: luna.model, thinkingOptionId: 'xhigh', notes: '' },
    { id: sol.id, name: sol.id, provider: sol.provider, model: sol.model, thinkingOptionId: 'high', notes: '' }]);
  const engine=new Engine(store,primaryAdapter,0);
  engine.hostIds=()=>['t3code:env'];
  engine.resolveHostAdapter=id=>id==='t3code:env'?t3Adapter:primaryAdapter;
  try{
    assert.equal(engine.profileCatalogKnownFor('t3code:env'),false,'a secondary host waits for its own catalog');
    await engine.refresh();
    assert.equal(engine.profileCatalogKnownFor('t3code:env'),true);
    assert.equal(engine.profileCatalogKnownFor('paseo-primary'),true,'the primary host reads the primary set');
    // The task host's snapshot: Luna (xhigh) is unavailable on T3, Sol stays.
    const onT3=engine.profilesFor('t3code:env');
    assert.equal(onT3.find(p=>p.id==='luna')?.available,false,'xhigh is not reported by the T3 catalog');
    assert.deepEqual(onT3.find(p=>p.id==='luna')?.supportedThinking,['low','high']);
    assert.equal(onT3.find(p=>p.id==='sol')?.available,true);
    // The primary set is untouched: both profiles available from the empty primary catalog.
    const onPrimary=engine.profilesFor(undefined);
    assert.equal(onPrimary.find(p=>p.id==='luna')?.available,false,'the primary catalog offers no providers at all');
    assert.match(onPrimary.find(p=>p.id==='luna')?.problem ?? '',/Provider test is not available/);
    const task=taskOf({complexity:'high',thinkingOptionId:'xhigh'});
    assert.equal(ids(chooseProfile(task,onT3,pool,equalUsage(pool),new Set())),null,'a task pinned to xhigh has no eligible T3 profile');
    assert.equal(ids(chooseProfile({...task,thinkingOptionId:'high'},onT3,pool,equalUsage(pool),new Set())),'sol','the supported level selects Sol on T3');
    // Route validation reads the task host's snapshot too: a mode or feature
    // value the host does not report refuses the routing instead of recording
    // a request that refuses at launch (nucleus#1139 review).
    const novaFeature=profile('nova','sol-model',{featureValues:{fast:true}});
    store.setProfiles([...store.profiles(),{id:novaFeature.id,name:novaFeature.id,provider:novaFeature.provider,model:novaFeature.model,featureValues:{fast:true},notes:''}]);
    const storeTask=store.insert(taskOf({complexity:'high'}),'t3code:env','handoff','a'.repeat(40));
    store.update(storeTask.id,{phase:'queued',reason:'Queued for dispatch',profile:sol,profileGroup:'g-1',workspaceId:'ws',directory:'/worktree'});
    await engine.refresh();
    assert.equal(engine.profilesFor('t3code:env').find(p=>p.id==='nova')?.available,false,'the feature value is not reported by the T3 catalog');
    await assert.rejects(engine.performTaskControl(taskControlInputSchema.parse({taskId:storeTask.id,version:store.task(storeTask.id).version,
      action:'set_routing',reason:'Route the grind profile',caller:'operator (board)',
      profileRequests:{worker:{profileId:'nova',reason:'The trial runs grind work on the grind profile',required:false}}})),
      /Profile nova is unavailable: Configured option fast is not supported/);
    // The same routing on the primary host's view is only unavailable for a
    // different reason, never the T3 feature answer.
    assert.equal(engine.profilesFor(undefined).find(p=>p.id==='nova')?.problem,'Provider test is not available on this host');
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test("nucleus#1139 review: a shared-project archive holds while a live task shares the repository", () => {
  const t3Adapter = { capabilities: () => ({ repositorySharedWorkspaces: true }) } as never;
  const paseoAdapter = { capabilities: () => ({}) } as never;
  const task = (id: string, over: Partial<Task> = {}): Task => ({
    ...taskOf(), id, hostId: 't3code:env', repoPath: '/repo', phase: 'working', ...over,
  }) as Task;
  const base = task('archiving');
  // A live sibling on the same host and repository holds the shared registration.
  const withLiveSibling = [base, task('other')];
  assert.equal(liveRepositorySharer(withLiveSibling, base), true);
  assert.match(sharedRepositoryArchiveHold(t3Adapter, withLiveSibling, base) ?? '', /another live task in this repository still uses the shared project registration/);
  // A terminal, removed, other-host or other-repository sibling holds nothing.
  assert.equal(liveRepositorySharer([base, task('done', { phase: 'done' })], base), false);
  assert.equal(liveRepositorySharer([base, task('gone', { removedAt: new Date().toISOString() })], base), false);
  assert.equal(liveRepositorySharer([base, task('paseo', { hostId: 'paseo:primary' })], base), false);
  assert.equal(liveRepositorySharer([base, task('elsewhere', { repoPath: '/other' })], base), false);
  assert.equal(sharedRepositoryArchiveHold(t3Adapter, [base, task('paseo', { hostId: 'paseo:primary' })], base), null);
  // Paseo worktrees are independent registrations: no gate at all.
  assert.equal(sharedRepositoryArchiveHold(paseoAdapter, withLiveSibling, base), null);
});
