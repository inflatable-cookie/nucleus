import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkHistoryFromStore, classifyPrChecks} from '../core/forge/index';
import type {Store} from '../core/store/store';

test('observed heads get independent pending timers', () => {
 const data = new Map<string, unknown>();
 const store = {getMeta:(key:string)=>data.get(key),setMeta:(key:string,value:unknown)=>data.set(key,value),deleteMeta:(key:string)=>data.delete(key)} as unknown as Store;
 const pending = [{__typename:'StatusContext' as const,context:'ci',state:'PENDING'}];
 const now = Date.parse('2026-11-09T00:00:00Z');
 classifyPrChecks(pending,checkHistoryFromStore(store,'repo',now,'old').forHead!('first'));
 const history=checkHistoryFromStore(store,'repo',now+31*60_000,'old');
 assert.equal(classifyPrChecks(pending,history.forHead!('second')).wait,'PR checks are pending');
});
