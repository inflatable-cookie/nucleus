import {test} from 'node:test';
import assert from 'node:assert/strict';
import {poolSchema} from '../shared/contracts';
import {checkPoolEntries, removePoolEntry, saveProfileSettings, stalePoolEntries} from '../shared/pool';
const entry=(profileId:string,group='subscription',weight=1)=>poolSchema.parse({profileId,group,weight,enabled:true,scopes:['general']});
test('profiles in one subscription may carry different weights and a save preserves its own',()=>{
 const pool=[{...entry('a'),cost:'high' as const},entry('b','subscription',3),entry('c','other')];
 const saved=saveProfileSettings(pool,{...pool[0],cost:'very_low',weight:2});
 assert.equal(saved.find(p=>p.profileId==='a')?.weight,2);assert.equal(saved.find(p=>p.profileId==='a')?.cost,'very_low');
 assert.equal(saved.find(p=>p.profileId==='b')?.weight,3);assert.equal(saved.find(p=>p.profileId==='c')?.weight,1);
 const moved=saveProfileSettings(saved,{...saved.find(p=>p.profileId==='a')!,group:'new'});
 assert.equal(moved.at(-1)?.weight,2);assert.equal(moved.at(-1)?.group,'new');
 assert.equal(moved.find(p=>p.profileId==='b')?.weight,3);assert.equal(moved.find(p=>p.profileId==='c')?.weight,1);
});
test('a brand-new profile defaults to weight 1 and the 1–10 integer range still holds',()=>{
 const settings={profileId:'new',enabled:true,group:'subscription',roles:['worker'] as ['worker'],weight:1,scopes:['general'] as ['general']};
 assert.equal(saveProfileSettings([entry('a','subscription',5)],settings).at(-1)?.weight,1);
 assert.equal(entry('a','subscription',10).weight,10);
 assert.throws(()=>entry('a','subscription',0));assert.throws(()=>entry('a','subscription',11));assert.throws(()=>entry('a','subscription',1.5));
});
test('legacy costs stay unset and all five explicit cost levels round-trip',()=>{
 assert.equal(entry('a').cost,undefined);
 for(const cost of ['very_high','high','medium','low','very_low'])assert.equal(poolSchema.parse({...entry('a'),cost}).cost,cost);
 assert.equal(poolSchema.parse({...entry('a'),cost:null}).cost,null);
});

test('a stale entry for a profile gone from Paseo does not block other pool saves, but a new or changed one is refused',()=>{
 const stale={...entry('gone','opencode-go'),enabled:false};
 const stored=[entry('a'),stale];
 const known=new Set(['a','b']);
 // The live shape: changing 'a' re-sends the whole pool, including the untouched stale entry.
 const edited=saveProfileSettings(stored,{...stored[0],weight:4});
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
