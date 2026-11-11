import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/retained-external-merge-fixture';
import {taskControlOperation} from '../core/verbs/task-control-key';
import {holdPatch, OWNER_STOP_HOLD_PREFIX} from '../core/merge/merge-hold';
import {holdsOf} from '../shared/contracts';

test('an interrupted response after settlement replays the same durable operation', {timeout:90000}, async()=>{
  const f=await fixture(true);try{
    const store=f.runtime.store;
    store.update(f.taskId,holdPatch(store.task(f.taskId),'dispatch','operator',`${OWNER_STOP_HOLD_PREFIX} fixture stop`));
    store.update(f.taskId,holdPatch(store.task(f.taskId),'merge','review-owner','Independent review hold'));
    const control=f.control(), key=taskControlOperation(control).key;
    const event=store.event.bind(store);
    store.event=((id:string,kind:string,detail:string)=>{
      if(kind==='operator_control')throw Error('injected response interruption');
      return event(id,kind,detail);
    }) as typeof store.event;
    try { await f.runtime.taskControl(control); } finally { store.event=event; }
    const operation=store.operationForKey(key)!;
    assert.equal(operation.state,'succeeded');
    const after=store.task(f.taskId), runs=store.runs(f.taskId);
    assert.equal(after.resolution.mergeHead,f.final);
    assert.equal(after.resolution.ownerAcceptances.length,1);
    assert.equal(holdsOf(after).dispatch,undefined);
    assert.equal(holdsOf(after).merge?.owner,'review-owner');
    await f.runtime.taskControl(control);
    assert.equal(store.operationForKey(key)!.id,operation.id);
    assert.deepEqual(store.task(f.taskId),after);
    assert.deepEqual(store.runs(f.taskId),runs);
    // Reopen the exact committed result as the runner would see it after a
    // crash between the transaction and the outer operation settlement.
    store.putOperation({...store.operationForKey(key)!,state:'running',settledAt:null});
    f.runtime.engine.scheduleAcceptedOperation(operation.id);
    const reconciled=await f.runtime.engine.awaitOperation(operation.id,10000);
    assert.equal(reconciled.state,'succeeded');
    assert.deepEqual(store.task(f.taskId),after);
    assert.deepEqual(store.runs(f.taskId),runs);
    assert.equal(store.eventsAll(f.taskId).filter(e=>e.kind==='owner_acceptance').length,1);
    assert.equal(f.counts().mergeCalls,0);
  }finally{await f.close();}
});
