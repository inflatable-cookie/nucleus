import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../shared/contracts';
import { fixture, git } from './support/retained-external-merge-fixture';
import { ownerEffectHook } from './support/review-entry-fixture';
import {collectOwnerVerbFacts, ownerTaskNext} from '../core/verbs/owner-verbs';

test('descendant acceptance requires qualification and an exact observed final head', {timeout:90000}, async()=>{
  const f=await fixture();try{
    const before=f.runtime.store.task(f.taskId);
    await assert.rejects(f.runtime.taskControl(f.control({qualification:undefined,head:undefined})),/differs from recorded task work/);
    await assert.rejects(f.runtime.taskControl(f.control({head:undefined})),/exact final head/);
    assert.deepEqual(f.runtime.store.task(f.taskId),before);
  }finally{await f.close();}
});

for(const fault of ['diverged','unreadable'] as const)test(`descendant acceptance refuses ${fault} ancestry`,{timeout:90000},async()=>{
  const f=await fixture();try{
    const before=f.runtime.store.task(f.taskId);
    const other=fault==='diverged'?before.planningBase:'a'.repeat(40);
    f.respond({...f.payload,head:{...f.payload.head,sha:other}});
    await assert.rejects(f.runtime.taskControl(f.control({head:other})),/does not descend|ancestry is unreadable/);
    assert.deepEqual(f.runtime.store.task(f.taskId),before);
  }finally{await f.close();}
});

test('a task binding changed during the forge read is refused', {timeout:90000}, async()=>{
  const f=await fixture();try{
    f.setProof(()=>{const task=f.runtime.store.task(f.taskId);f.runtime.store.update(task.id,{reason:'Concurrent owner change'});f.setProof(null);});
    await assert.rejects(f.runtime.taskControl(f.control()),/changed during external merge/);
    const task=f.runtime.store.task(f.taskId);assert.equal(task.reason,'Concurrent owner change');
    assert.equal(task.resolution.mergedCommit,null);assert.equal(task.resolution.ownerAcceptances.length,0);
  }finally{await f.close();}
});

test('an unresolved hook effect refuses before the forge read', {timeout:90000}, async()=>{
  const f=await fixture();try{
    const store=f.runtime.store, task=store.task(f.taskId);
    store.putHookEvent(ownerEffectHook(task,'uncertain'));
    const before=store.task(task.id), reads=f.counts().sourceReads;
    const view=ownerTaskNext(collectOwnerVerbFacts(store,before)).verbs.find(v=>v.verb==='move' && v.args?.to==='closeout');
    assert.match(view?.note??'',/Descendant acceptance currently refuses:.*hook/i);
    await assert.rejects(f.runtime.taskControl(f.control()),/hook.*uncertain/i);
    assert.equal(f.counts().sourceReads,reads);assert.deepEqual(store.task(task.id),before);
  }finally{await f.close();}
});
