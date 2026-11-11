import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAutoSave} from '../shared/autosave';
test('autosave serializes in-flight edits and keeps the latest pending value',async()=>{
 const writes:number[]=[],status:string[]=[];let release!:()=>void;
 const saver=createAutoSave<number>(async value=>{writes.push(value);if(value===1)await new Promise<void>(r=>release=r)},s=>status.push(s));
 saver.enqueue(1);saver.enqueue(2);saver.enqueue(3);assert.deepEqual(writes,[1]);release();await new Promise(r=>setTimeout(r,0));assert.deepEqual(writes,[1,3]);assert.equal(status.at(-1),'Saved');
});
test('text edits debounce, flush when leaving, and invalid input cancels pending edits',async()=>{
 const writes:string[]=[];const saver=createAutoSave<string>(async value=>{writes.push(value)},()=>{});
 saver.enqueue('a',1000);saver.enqueue('abc',1000);assert.deepEqual(writes,[]);await saver.flush();assert.deepEqual(writes,['abc']);
 saver.enqueue('invalid draft',1000);saver.cancelPending();await saver.flush();assert.deepEqual(writes,['abc']);
});
test('failed saves stay explicit and a later edit can recover',async()=>{
 const statuses:string[]=[];const saver=createAutoSave<number>(async n=>{if(n===1)throw Error('Disconnected')},s=>statuses.push(s));
 saver.enqueue(1);await new Promise(r=>setTimeout(r,0));assert.match(statuses.at(-1)!,/Not saved: Disconnected/);saver.enqueue(2);await new Promise(r=>setTimeout(r,0));assert.equal(statuses.at(-1),'Saved');
});
