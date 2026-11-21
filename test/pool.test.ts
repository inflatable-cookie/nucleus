import {test} from 'node:test';
import assert from 'node:assert/strict';
import {poolRecordFromLegacy,poolSchema,type ProfileWeight} from '../shared/contracts';
import {checkPoolEntries, removePoolEntry, saveProfileSettings, stalePoolEntries} from '../shared/pool';
const entry=(profileId:string,group='subscription',weight:ProfileWeight='default')=>poolSchema.parse({profileId,group,weight,enabled:true,scopes:['general']});
test('profiles in one subscription may carry different weights and a save preserves its own',()=>{
 const pool=[entry('a'),entry('b','subscription','most'),entry('c','other')];
 const saved=saveProfileSettings(pool,{...pool[0],weight:'more'});
 assert.equal(saved.find(p=>p.profileId==='a')?.weight,'more');
 assert.equal(saved.find(p=>p.profileId==='b')?.weight,'most');assert.equal(saved.find(p=>p.profileId==='c')?.weight,'default');
 const moved=saveProfileSettings(saved,{...saved.find(p=>p.profileId==='a')!,group:'new'});
 assert.equal(moved.at(-1)?.weight,'more');assert.equal(moved.at(-1)?.group,'new');
 assert.equal(moved.find(p=>p.profileId==='b')?.weight,'most');assert.equal(moved.find(p=>p.profileId==='c')?.weight,'default');
});
test('a brand-new profile saves at the Default weight and only the five stops are valid',()=>{
 const settings={profileId:'new',enabled:true,group:'subscription',roles:['worker'] as ['worker'],weight:'default' as const,scopes:['general'] as ['general']};
 assert.equal(saveProfileSettings([entry('a','subscription','most')],settings).at(-1)?.weight,'default');
 for(const stop of ['fewest','fewer','default','more','most'] as const)assert.equal(entry('a','subscription',stop).weight,stop);
 assert.throws(()=>poolSchema.parse({...entry('a'),weight:1}),'a bare integer is a legacy input, never a stored value');
 assert.throws(()=>poolSchema.parse({...entry('a'),weight:'heavy'}));
 assert.throws(()=>poolSchema.parse({...entry('a'),cost:'low'}),'the retired Cost field is not part of the contract');
});
test('legacy records map the old integer weight and drop Cost at the read boundary only',()=>{
 const legacy=(weight:unknown,extra:Record<string,unknown>={})=>poolSchema.parse(poolRecordFromLegacy({profileId:'p',enabled:true,group:'g',roles:['worker'],scopes:['general'],weight,...extra}));
 assert.equal(legacy(1).weight,'default');assert.equal(legacy(2).weight,'more');
 for(const n of [3,4,7,10])assert.equal(legacy(n).weight,'most',`legacy ${n}`);
 for(const bad of [0,11,1.5,'2',null])assert.throws(()=>legacy(bad),`legacy ${String(bad)} still fails validation`);
 const rated=legacy(1,{cost:'very_low',capability:'worker',notes:'kept'});
 assert.equal('cost' in rated,false);assert.equal(rated.capability,'worker');
 assert.equal(legacy(1,{cost:'very_high'}).weight,legacy(1,{cost:null}).weight,'cost never changes the migrated weight');
 const raw={profileId:'p',enabled:true,group:'g',roles:['worker'],scopes:['general'],weight:2,cost:'low'};
 poolRecordFromLegacy(raw);assert.deepEqual(raw.weight,2,'the stored record is never mutated');
});
test('a stale entry for a profile gone from Paseo does not block other pool saves, but a new or changed one is refused',()=>{
 const stale={...entry('gone','opencode-go'),enabled:false};
 const stored=[entry('a'),stale];
 const known=new Set(['a','b']);
 // The live shape: changing 'a' re-sends the whole pool, including the untouched stale entry.
 const edited=saveProfileSettings(stored,{...stored[0],weight:'most'});
 assert.doesNotThrow(()=>checkPoolEntries(edited,known,stored));
 // Key order from a different surface does not make an unchanged entry look changed.
 const reordered=edited.map(e=>Object.fromEntries(Object.entries(e).reverse()) as typeof e);
 assert.doesNotThrow(()=>checkPoolEntries(reordered,known,stored));
 assert.throws(()=>checkPoolEntries([...stored,entry('never-existed')],known,stored),/Unknown profile/);
 assert.throws(()=>checkPoolEntries([entry('a'),{...stale,enabled:true}],known,stored),/Unknown profile/,'re-enabling a stale entry is a change');
 assert.throws(()=>checkPoolEntries([entry('a'),entry('a')],known,stored),/Duplicate pool profile/);
 assert.throws(()=>checkPoolEntries([entry('b','profile:x')],known,stored),/reserved/);
});

test('a pool with one stale entry is marked; removing it saves exactly the other entries',()=>{
 const live=entry('a'),stale={...entry('gone','opencode-go'),enabled:false};
 const stored=[live,stale];
 const marked=stalePoolEntries(stored,[{id:'a'},{id:'b'}]);
 assert.deepEqual(marked,[stale]);
 assert.equal(marked[0],stale,'the stale row is the stored entry, not a copy');
 const remaining=removePoolEntry(stored,'gone');
 assert.deepEqual(remaining,[live]);
 assert.equal(remaining[0],live,'every other entry stays the same object');
 assert.doesNotThrow(()=>checkPoolEntries(remaining,new Set(['a','b']),stored));
});

test('an empty or unloaded catalog marks nothing stale',()=>{
 const stored=[entry('a'),{...entry('gone','opencode-go'),enabled:false}];
 assert.deepEqual(stalePoolEntries(stored,[]),[]);
 assert.deepEqual(stalePoolEntries([],[{id:'a'}]),[]);
});
