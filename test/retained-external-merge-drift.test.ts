import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './support/retained-external-merge-fixture';
import {taskControlOperation} from '../core/verbs/task-control-key';

for (const fault of ['run','source','delivery'] as const) test(`retained merge refuses ${fault} drift or uncertainty`,{timeout:90000},async()=>{
  const f=await fixture(true);try{
    const store=f.runtime.store, before=store.task(f.taskId), run=store.runs(f.taskId).find(item=>!item.released)!;
    assert.ok(run,'an actual revision run owns the retained workspace');
    if(fault==='delivery') store.putRun({...run,status:'uncertain'});
    if(fault==='run') f.setProof(()=>{store.putRun({...store.run(run.id)!,idleSince:new Date().toISOString()});f.setProof(null);});
    if(fault==='source') f.setProof(()=>{writeFileSync(join(f.workspace,'work.txt'),'concurrent source\n');f.setProof(null);});
    await assert.rejects(f.runtime.taskControl(f.control()),fault==='delivery'?/delivery|uncertain/:fault==='source'?/dirty|switched/:/changed during external merge|run changed/i);
    const after=store.task(f.taskId);
    assert.equal(after.resolution.mergedCommit,null);assert.deepEqual(after.resolution.ownerAcceptances,before.resolution.ownerAcceptances);
    assert.equal(store.run(run.id)!.released,false);
  }finally{await f.close();}
});

test('a changed acceptance in the running operation refuses without settlement',{timeout:90000},async()=>{
  const f=await fixture(true);try{
    const store=f.runtime.store, control=f.control(), before=store.task(f.taskId), key=taskControlOperation(control).key;
    f.setProof(()=>{
      const operation=store.operationForKey(key)!;
      store.putOperation(operation,{type:'task_control',control:{...control,qualification:'A different acceptance'}});
      f.setProof(null);
    });
    await assert.rejects(f.runtime.taskControl(control),/operation changed during external merge/);
    const after=store.task(f.taskId);
    assert.equal(after.resolution.mergedCommit,null);
    assert.deepEqual(after.resolution.ownerAcceptances,before.resolution.ownerAcceptances);
  }finally{await f.close();}
});
