import { profile, observeIdle } from './support/fakes';
import { nightlyProviders } from './support/pool-shapes';
import { t3Fake } from './support/t3code-fake';
import { createHost } from '../hosts/t3code';
import { t3codeVocabulary } from '../hosts/t3code/vocabulary';
import { paseoVocabulary } from '../hosts/paseo/vocabulary';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store/store';
import {Engine} from '../core/engine';
import {chooseProfile,eligibilityReasons,validateNamedProfile} from '../core/dispatch/routing';
import {parseBriefDocument,submissionQueueFields} from '../core/planning/handoff';
import {
  capabilityLevelSchema,outcomeSchema,poolRecordFromLegacy,poolSchema,scopeSchema,
  submissionRecordFromLegacy,submissionSchema,taskControlInputSchema,usageLevels,type Profile,type PoolEntry,type Task,type UsageLevel,
} from '../shared/contracts';
import {saveProfileSettings} from '../shared/pool';
import type {Adapter} from '../core/host';


/** One worker per capability bracket (Frontier is request-only below Extra high), equal weight, distinct groups. */
const ladder=():{profiles:Profile[];pool:PoolEntry[]}=>{
  const levels=['mechanical','worker','heavyweight','frontier'] as const;
  const profiles=levels.map(level=>profile(`agent-${level}`));
  const pool=profiles.map((p,i)=>poolSchema.parse({profileId:p.id,enabled:true,group:`g-${i}`,roles:['worker'],weight:"default",scopes:['general','mechanical','complex'],capability:levels[i]}));
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
  assert.throws(()=>poolSchema.parse({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:"default",scopes:['general'],capability:'enormous'}));
  assert.throws(()=>poolSchema.parse({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:"default",scopes:['general'],capability:2}));
  assert.throws(()=>submissionSchema.parse({submissionId:'s',title:'t',repoPath:'/r',planningCommit:'a'.repeat(40),handoffPath:'h',originAgentId:'o',complexity:'huge'}));
  assert.throws(()=>scopeSchema.parse('optional'));
  const parsed=poolSchema.parse({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:"default",scopes:['general'],capability:'very_high'});
  assert.equal(parsed.capability,'heavyweight','a five-point rating reads as its bracket');
  assert.equal(submissionSchema.parse({submissionId:'s',title:'t',repoPath:'/r',planningCommit:'a'.repeat(40),handoffPath:'h',originAgentId:'o',complexity:null}).complexity,null,'complexity clears explicitly');
});






test('explicit preferred and required requests win independent of rating distance',()=>{
  const {profiles,pool}=ladder();
  const far=pool.find(e=>e.profileId==='agent-mechanical')!;
  const usage=equalUsage(pool);
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_high',preferredProfileId:far.profileId}),profiles,pool,usage,new Set())),far.profileId,'optional preference wins over the best fit');
  assert.equal(ids(chooseProfile(taskOf({complexity:'medium',preferredProfileId:far.profileId}),profiles,pool,usage,new Set())),far.profileId,'a preference within the climb bracket wins over the best fit');
  assert.equal(chooseProfile(taskOf({complexity:'very_low',preferredProfileId:'agent-heavyweight',requirePreferred:true}),profiles,pool,usage,new Set()),null,'a preference never reaches a profile the level needs permission for (Spec 052)');
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_low',preferredProfileId:'agent-worker'}),profiles,pool,usage,new Set())),'agent-mechanical','a preference above the climb bracket is not automatic');
  const signed={status:'approved' as const,decisionId:'d',by:'operator (board)',at:'2026-11-17T00:00:00.000Z',note:''};
  const above={...taskOf({complexity:'medium'}),profileRequests:{worker:{profileId:'agent-heavyweight',reason:'Explicit route above the climb bracket',required:false}}};
  assert.equal(ids(chooseProfile(above,profiles,pool,usage,new Set(),'worker',usage,'extra_high')),'agent-heavyweight','an explicit request reaches above the climb bracket');
  assert.equal(ids(chooseProfile({...above,profileRequests:{worker:{profileId:'agent-heavyweight',reason:'Explicit request',required:false}}},profiles,pool,usage,new Set(),'worker',usage,'extra_high')),'agent-heavyweight','an explicit request (no sign-off needed at Extra high) reaches above the climb bracket');
  const lowerRequest={...taskOf({complexity:'very_high'}),profileRequests:{worker:{profileId:'agent-worker',reason:'Cheaper please',required:true}}};
  assert.equal(chooseProfile(lowerRequest,profiles,pool,usage,new Set(),'worker',usage,'maximum'),null,'a required Worker request cannot serve at Maximum');
  assert.equal(chooseProfile(taskOf({complexity:'very_high',preferredProfileId:far.profileId,requirePreferred:true}),profiles,pool.filter(e=>e.profileId!==far.profileId),usage,new Set()),null,'required preference never falls back to a perfect fit');
  const requested=taskOf({complexity:'very_high',profileRequests:{worker:{profileId:far.profileId,reason:'Operator asked for this profile',required:false}}});
  assert.equal(ids(chooseProfile(requested,profiles,pool,usage,new Set())),far.profileId);
});

test('Spec 053: disabled, frontier (below Extra high) and unavailable profiles stay gated; roles and scopes no longer gate',()=>{
  const {profiles,pool}=ladder();
  const task=taskOf({complexity:'very_high'});
  const usage=equalUsage(pool);
  assert.equal(ids(chooseProfile(task,profiles,pool,usage,new Set())),'agent-heavyweight','a very-high task starts on Heavyweight at Normal');
  for(const changed of [{enabled:false},{capability:'frontier'}] as const){
    const entries=pool.map(e=>e.profileId==='agent-heavyweight'?poolSchema.parse({...e,...changed}):e);
    assert.equal(ids(chooseProfile(task,profiles,entries,usage,new Set())),'agent-worker',`${JSON.stringify(changed)} never admits the gated profile; the demand falls short to the next`);
  }
  assert.equal(ids(chooseProfile(task,profiles,pool,usage,new Set(['g-2']))),'agent-worker','an unavailable group is gated');
  for(const changed of [{scopes:['mechanical'] as const},{roles:['reviewer'] as const}] as const){
    const entries=pool.map(e=>e.profileId==='agent-heavyweight'?poolSchema.parse({...e,...changed}):e);
    assert.equal(ids(chooseProfile(task,profiles,entries,usage,new Set())),'agent-heavyweight',`${JSON.stringify(changed)} no longer gates (Spec 053)`);
  }
  assert.match(eligibilityReasons({...task,scope:'complex'},profiles,pool.map(e=>e.profileId==='agent-heavyweight'?{...e,enabled:false}:e),[{group:'g-0',unavailable:true,reason:'quota',retryAt:null}]),/disabled/);
  assert.match(eligibilityReasons({...task,scope:'complex'},profiles,pool,[{group:'g-0',unavailable:true,reason:'quota',retryAt:null}]),/quota/);
  const narrow=pool.map(e=>e.profileId==='agent-mechanical'?poolSchema.parse({...e,scopes:['general'] as const,roles:['reviewer'] as const}):e);
  assert.doesNotThrow(()=>validateNamedProfile('agent-mechanical','worker','complex',profiles,narrow,'reason'),'a route is no longer refused on role or scope');
});

test('Spec 053: the demand selects the run\'s bracket and falls short to the most capable',()=>{
  const {profiles,pool}=ladder();
  const usage=equalUsage(pool);
  for(const [level,expected] of [['very_low','agent-mechanical'],['low','agent-mechanical'],['medium','agent-worker'],['high','agent-worker'],['very_high','agent-heavyweight']] as const)
    assert.equal(ids(chooseProfile(taskOf({complexity:level}),profiles,pool,usage,new Set())),expected,`complexity ${level}`);
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_high'}),profiles,pool,usage,new Set(),'worker',usage,'maximum')),'agent-frontier','at Maximum workers run on Heavyweight or Frontier, Frontier automatic');
  assert.equal(ids(chooseProfile(taskOf({}),profiles,pool,usage,new Set())),'agent-worker','an unset complexity counts as medium');
  const capped=pool.filter(e=>e.profileId!=='agent-heavyweight');
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_high'}),profiles,capped,usage,new Set())),'agent-worker','a shortfall takes the most capable permitted');
  assert.equal(ids(chooseProfile(taskOf({complexity:'medium'}),profiles,pool,usage,new Set(),'worker',usage,'low')),'agent-mechanical','Low takes a bracket off a medium task');
  assert.equal(ids(chooseProfile(taskOf({complexity:'high'}),profiles,pool,usage,new Set(),'worker',usage,'high')),'agent-heavyweight','High starts a high task on Heavyweight');
});

test('nucleus#1385: a stored role offset is ignored; the reviewer and coordinator follow the level',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ns-offsets-')),store=new Store(join(dir,'db'));
  try{
    const {profiles,pool}=ladder();
    store.setMeta('pool',pool);
    store.setMeta('demandRoleOffsets',{worker:2,reviewer:2,coordinator:2});
    const engine=new Engine(store,{} as Adapter);engine.profiles=profiles;
    const base={...taskOf({complexity:'very_high'}),workerModel:'other-author',workerModels:['other-author']};
    assert.equal(ids(chooseProfile(base,profiles,pool,equalUsage(pool),new Set(),'worker',equalUsage(pool),'normal')),'agent-heavyweight','the worker starts on its level bracket, whatever is stored');
    assert.equal(engine.resolution.select(base,'reviewer')?.profile.id,'agent-worker','the reviewer is one bracket below at Normal');
    assert.equal(engine.resolution.select(base,'coordinator')?.profile.id,'agent-mechanical','the coordinator runs on Mechanical');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('Spec 052: the coordinator runs on Mechanical at every level, Maximum included, else the lowest permitted bracket',()=>{
  const {profiles,pool}=ladder();
  const usage=equalUsage(pool);
  for(const level of usageLevels)
    assert.equal(ids(chooseProfile(taskOf({complexity:'very_high'}),profiles,pool,usage,new Set(),'coordinator',usage,level)),'agent-mechanical',`${level}: the coordinator is on Mechanical`);
  const noMechanical=pool.filter(e=>e.profileId!=='agent-mechanical');
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_high'}),profiles,noMechanical,usage,new Set(),'coordinator',usage,'normal')),'agent-worker','the next lowest permitted bracket');
  // Maximum reserves Heavyweight and Frontier for workers and reviewers, not the coordinator.
  const mediumProfile=profile('mid');
  const mediumOnly=[poolSchema.parse({profileId:'mid',enabled:true,group:'mid',roles:['coordinator'],weight:"default",scopes:['general'],capability:'worker'})];
  assert.equal(ids(chooseProfile(taskOf({complexity:'very_high'}),[mediumProfile],mediumOnly,{},new Set(),'coordinator',{},'maximum')),'mid','the coordinator has a pick at Maximum');
  assert.equal(chooseProfile(taskOf({complexity:'very_high'}),[mediumProfile],mediumOnly,{},new Set(),'worker',{},'maximum'),null,'a worker still needs a top-two profile at Maximum');
  assert.equal(chooseProfile(taskOf({complexity:'very_high'}),[mediumProfile],mediumOnly,{},new Set(),'reviewer',{},'maximum'),null,'a reviewer still needs a top-two profile at Maximum');
});

test('Spec 053: worker, reviewer and coordinator selection use the demand; explicit requests still lead',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ns-capability-')),store=new Store(join(dir,'db'));
  try{
    const {profiles,pool}=ladder();
    store.setMeta('pool',pool);
    const engine=new Engine(store,{} as Adapter);engine.profiles=profiles;
    for(const entry of pool){store.chargeAssignment(entry.group,entry.profileId);}
    const base={...taskOf({complexity:'very_high'}),workerModel:'other-author',workerModels:['other-author']};
    assert.equal(engine.resolution.select(base,'reviewer')?.profile.id,'agent-worker','the reviewer is one bracket below the Heavyweight start');
    assert.equal(engine.resolution.select(base,'coordinator')?.profile.id,'agent-mechanical','the coordinator runs on Mechanical');
    const requested={...base,profileRequests:{...base.profileRequests,reviewer:{profileId:'agent-mechanical',reason:'Operator named the reviewer',required:false}}};
    assert.equal(engine.resolution.select(requested,'reviewer')?.profile.id,'agent-mechanical');
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
  const poolLegacy=poolSchema.parse(poolRecordFromLegacy({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:3,capabilities:['general','complex'],cost:'low',capability:'low'}));
  assert.deepEqual(poolLegacy.scopes,['general','complex']);assert.equal(poolLegacy.capability,'mechanical');assert.equal('cost' in poolLegacy,false,'a legacy Cost is discarded at the read boundary');assert.equal(poolLegacy.weight,'most','a legacy weight 3 reads as the highest stop');
  assert.throws(()=>poolRecordFromLegacy({profileId:'p',enabled:true,group:'g',roles:['worker'],weight:"default",capabilities:['general'],scopes:['complex']}),/both the legacy "capabilities" and the current "scopes"/);
  assert.equal(saveProfileSettings([poolLegacy],{...poolLegacy,group:'g2'}).at(-1)!.capability,'mechanical','pool saves never drop the rating');
  assert.equal('cost' in saveProfileSettings([poolLegacy],{...poolLegacy,group:'g2'}).at(-1)!,false,'a profile write emits only the canonical form');
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
  const legacy=parseBriefDocument(wrap('  capability: mechanical\n'),'brief');
  assert.equal(legacy.queue.scope,'mechanical');
  const current=parseBriefDocument(wrap('  scope: complex\n  complexity: very_high\n'),'brief');
  assert.equal(current.queue.scope,'complex');assert.equal(current.queue.complexity,'very_high');
  assert.throws(()=>parseBriefDocument(wrap('  capability: general\n  scope: general\n'),'brief'),/both the legacy "capability" and the current "scope"/);
  assert.throws(()=>parseBriefDocument(wrap('  scope: complex\n  complexity: enormous\n'),'brief'),/Invalid brief frontmatter/);
  const submission=submissionSchema.parse({submissionId:'frontmatter',title:'Frontmatter fixture',repoPath:'/repo',planningCommit:'a'.repeat(40),originAgentId:'origin',brief:{text:wrap('  scope: complex\n  complexity: very_high\n'),mediaType:'text/markdown',digest:'sha256:'+'c'.repeat(64)},...submissionQueueFields(current.queue)});
  assert.equal(submission.scope,'complex');assert.equal(submission.complexity,'very_high');
});

/** Spec 053 rotation: the share of `selections` picks each profile gets when every pick is recorded (recent and lifetime counts both). */
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
test('Spec 053 rotation (Tom, 2026-11-21): equal weights rotate equally within the set whatever the legacy Cost, and nothing leaves it',()=>{
  // Legacy saved profiles rated GLM low-cost and Grok high-cost; reading them drops the Cost, so the four rotate evenly.
  const live=[['glm','low'],['deepseek','medium'],['grok','high'],['haiku','very_high']] as const;
  const profiles=live.map(([id])=>profile(id));
  const pool=live.map(([id,cost])=>poolSchema.parse(poolRecordFromLegacy({profileId:id,enabled:true,group:id,roles:['worker'],weight:1,scopes:['general'],cost,capability:'worker'})));
  const shares=simulate(taskOf({complexity:'medium'}),profiles,pool,100);
  assert.deepEqual(shares,{glm:25,deepseek:25,grok:25,haiku:25},'prior cost gives no profile more of the rotation');
});

test('Spec 053 rotation: one notch is a fixed share step from Default (80/90/100/110/120), never a promised percentage of all work',()=>{
  const profiles=[profile('heavy'),profile('light')];
  const pool=[poolSchema.parse({profileId:'heavy',enabled:true,group:'heavy',roles:['worker'],weight:'more',scopes:['general'],capability:'worker'}),
    poolSchema.parse({profileId:'light',enabled:true,group:'light',roles:['worker'],weight:'default',scopes:['general'],capability:'worker'})];
  assert.deepEqual(simulate(taskOf({complexity:'high'}),profiles,pool,210),{heavy:110,light:100},'More (110%) to Default (100%)');
  const ends=[poolSchema.parse({profileId:'heavy',enabled:true,group:'heavy',roles:['worker'],weight:'most',scopes:['general'],capability:'worker'}),
    poolSchema.parse({profileId:'light',enabled:true,group:'light',roles:['worker'],weight:'fewest',scopes:['general'],capability:'worker'})];
  assert.deepEqual(simulate(taskOf({complexity:'high'}),profiles,ends,200),{heavy:120,light:80},'Most (120%) to Fewest (80%)');
});
test('Spec 053 rotation: an unavailable group leaves the set and the rest rotate; the level permission still excludes',()=>{
  const live=[['glm','worker'],['deepseek','worker'],['haiku','worker'],['heavy','heavyweight'],['flagged','frontier']] as const;
  const profiles=live.map(([id])=>profile(id));
  const pool=live.map(([id,capability])=>poolSchema.parse({profileId:id,enabled:true,group:id,roles:['worker'],weight:'default',scopes:['general'],capability}));
  const skipped=simulate(taskOf({complexity:'medium'}),profiles,pool,60,new Set(['glm']));
  assert.deepEqual(skipped,{deepseek:30,haiku:30},'an unavailable group is skipped; the Worker pool rotates; Heavyweight and Frontier stay out');
  const top=simulate(taskOf({complexity:'very_high'}),profiles,pool,20);
  assert.equal(top.flagged,undefined,'a Frontier profile stays out of automatic selection at Normal');
  assert.deepEqual(top,{heavy:20},'a very-high task starts on Heavyweight');
});

test('deterministic ties break by profile id and stay stable across repeated selection',()=>{
  const profiles=[profile('b-agent'),profile('a-agent')];
  const pool=profiles.map(p=>poolSchema.parse({profileId:p.id,enabled:true,group:'same',roles:['worker'],weight:"default",scopes:['general'],capability:'worker'}));
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
    await assert.rejects(engine.performTaskControl(taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'set_routing',reason:'Name the author',preferredProfileId:'agent-heavyweight'})),
      new RegExp(PROFILE_CATALOG_LOADING_REFUSAL.slice(0,40)));
    assert.equal(store.task(task.id).version,task.version,'the refusal writes nothing');
    const scoped=await engine.performTaskControl(taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'set_routing',reason:'Scope only',complexity:'low'}));
    assert.equal(scoped.complexity,'low');
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('nucleus#1139: a task\'s host catalog keeps profiles it cannot run out of selection', async t => {
  // The recorded nightly T3 catalog (#1143's shared shape), not a hand-made one:
  // a level the model's own option reports selects, one it does not leaves the
  // profile out of selection.
  const root = mkdtempSync(join(tmpdir(), 'ns-host-routing-t3-'));
  const server = await t3Fake(t, root);
  server.controls.providers = nightlyProviders();
  const host = createHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'), timeoutMs: 1_000,
    probeThreadId: 'synthetic-probe' });
  t.after(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
  await host.connect();
  const t3Catalog = await host.catalog();
  // One profile pinned to a thinking level the model's T3 option does not offer,
  // one it does: the level is canonical and the table can express it, and the
  // host's own option list decides.
  const luna=profile('luna','opencode-go/deepseek-v4.1-flash',{thinkingOptionId:'medium',supportedThinking:['medium'],provider:'pi'});
  const sol=profile('sol','opencode-go/deepseek-v4.1-flash',{thinkingOptionId:'high',supportedThinking:['high'],provider:'pi'});
  const all=[luna,sol];
  const pool=all.map((p,i)=>poolSchema.parse({profileId:p.id,enabled:true,group:`g-${i}`,roles:['worker'],weight:"default",scopes:['general','mechanical','complex'],capability:'worker'}));
  const primaryAdapter={profiles:async()=>all,observe:observeIdle('ws','agent'),catalog:async()=>({providers:[]}),vocabulary:paseoVocabulary} as unknown as Adapter;
  const t3Adapter={profiles:async()=>[],observe:observeIdle('ws','agent'),catalog:async()=>t3Catalog,vocabulary:t3codeVocabulary} as unknown as Adapter;
  const dir=mkdtempSync(join(tmpdir(),'ns-host-routing-')),store=new Store(join(dir,'db'));
  store.setProfiles([{ id: luna.id, name: luna.id, provider: luna.provider, model: luna.model, thinkingOptionId: 'medium', notes: '' },
    { id: sol.id, name: sol.id, provider: sol.provider, model: sol.model, thinkingOptionId: 'high', notes: '' }]);
  const engine=new Engine(store,primaryAdapter,0);
  engine.hostIds=()=>['t3code:env'];
  engine.resolveHostAdapter=id=>id==='t3code:env'?t3Adapter:primaryAdapter;
  try{
    assert.equal(engine.profileCatalogKnownFor('t3code:env'),false,'a secondary host waits for its own catalog');
    await engine.refresh();
    assert.equal(engine.profileCatalogKnownFor('t3code:env'),true);
    assert.equal(engine.profileCatalogKnownFor('paseo-primary'),true,'the primary host reads the primary set');
    // The task host's snapshot: Luna (medium) is unavailable on T3, Sol stays.
    const onT3=engine.profilesFor('t3code:env');
    assert.equal(onT3.find(p=>p.id==='luna')?.available,false,'medium is not offered by the model\'s T3 thinking option');
    assert.deepEqual(onT3.find(p=>p.id==='luna')?.supportedThinking,['low','high','max'],'the snapshot names the levels the host really runs');
    assert.equal(onT3.find(p=>p.id==='sol')?.available,true);
    // The primary set is untouched: both profiles unavailable from the empty primary catalog.
    const onPrimary=engine.profilesFor(undefined);
    assert.equal(onPrimary.find(p=>p.id==='luna')?.available,false,'the primary catalog offers no providers at all');
    assert.match(onPrimary.find(p=>p.id==='luna')?.problem ?? '',/Provider pi is not available/);
    const task=taskOf({complexity:'high',thinkingOptionId:'medium'});
    assert.equal(ids(chooseProfile(task,onT3,pool,equalUsage(pool),new Set())),null,'a task pinned to medium has no eligible T3 profile');
    assert.equal(ids(chooseProfile({...task,thinkingOptionId:'high'},onT3,pool,equalUsage(pool),new Set())),'sol','the supported level selects Sol on T3');
    // Route validation reads the task host's snapshot too: a mode or feature
    // value the host does not report refuses the routing instead of recording
    // a request that refuses at launch (nucleus#1139 review).
    const novaFeature=profile('nova','opencode-go/deepseek-v4.1-flash',{featureValues:{fast:true},provider:'pi'});
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
    assert.equal(engine.profilesFor(undefined).find(p=>p.id==='nova')?.problem,'Provider pi is not available on this host');
  }finally{await engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});


test('a reviewer takes the nearest permitted bracket above when no independent profile carries its bracket (2026-11-18 review backlog)',()=>{
  const {profiles,pool}=ladder();
  const usage=equalUsage(pool);
  // The worker ran on the only Worker profile, so review independence removes it.
  const worker=profiles.find(p=>p.id==='agent-worker')!;
  const task={...taskOf({complexity:'high'}),profile:worker} as Task;
  const independent=profiles.filter(p=>p.id!=='agent-worker');
  assert.equal(ids(chooseProfile(task,independent,pool,usage,new Set(),'reviewer',usage,'high')),'agent-heavyweight','at High the reviewer is on the worker\'s bracket, so Heavyweight serves instead of parking');
  assert.equal(ids(chooseProfile(task,independent,pool,usage,new Set(),'reviewer',usage,'extra_high')),'agent-heavyweight','the nearest bracket above, not the top one');
  assert.equal(ids(chooseProfile(task,independent,pool,usage,new Set(),'reviewer',usage,'normal')),'agent-mechanical','at Normal the reviewer is one bracket below');
  assert.equal(ids(chooseProfile(task,profiles,pool,usage,new Set(),'reviewer',usage,'high')),'agent-worker','an independent profile at the exact bracket still wins over a higher one');
  assert.equal(ids(chooseProfile({...task,complexity:'medium'} as Task,independent,pool,usage,new Set(),'worker',usage,'high')),'agent-mechanical','a medium worker stays capped at Worker');
});

test('the usage level sets the reviewer bracket, a critical task prefers at least the worker, and no reviewer floor parks review (Tom, 2026-11-19)',()=>{
  const {profiles:base,pool:basePool}=ladder();
  const profiles=[...base,profile('agent-worker-2')];
  const pool=[...basePool,poolSchema.parse({profileId:'agent-worker-2',enabled:true,group:'g-w2',roles:['worker'],weight:"default",scopes:['general'],capability:'worker'})];
  const usage=equalUsage(pool);
  const worker=profiles.find(p=>p.id==='agent-worker')!;
  const task={...taskOf({complexity:'medium'}),profile:worker} as Task;
  const independent=profiles.filter(p=>p.id!=='agent-worker');
  assert.equal(ids(chooseProfile(task,independent,pool,usage,new Set(),'reviewer',usage,'normal')),'agent-mechanical','a Worker author gets a Mechanical reviewer at Normal');
  assert.equal(ids(chooseProfile(task,independent,pool,usage,new Set(),'reviewer',usage,'high')),'agent-worker-2','and a Worker reviewer at High');
  assert.equal(ids(chooseProfile({...task,critical:true} as Task,independent,pool,usage,new Set(),'reviewer',usage,'normal')),'agent-worker-2','a critical task prefers a reviewer at least as capable as the worker');
  // A Frontier worker: the only other top profile is Heavyweight.
  const top=profiles.find(p=>p.id==='agent-frontier')!;
  const frontierTask={...taskOf({complexity:'very_high',critical:true}),profile:top} as Task;
  const others=profiles.filter(p=>p.id!=='agent-frontier');
  assert.equal(ids(chooseProfile(frontierTask,others,pool,usage,new Set(),'reviewer',usage,'high')),'agent-heavyweight','a Heavyweight reviewer reviews a Frontier worker instead of parking');
});
