import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearDecisionRead, readDecisions } from '../client/decision-read';

test('board and pill share an in-flight read and only read again when the revision changes', async () => {
  clearDecisionRead();
  let calls = 0;
  const read = async () => { calls++; return []; };
  const first = readDecisions(1, read);
  assert.equal(readDecisions(1, read), first);
  await first;
  await readDecisions(1, read);
  assert.equal(calls, 1);
  await readDecisions(2, read);
  assert.equal(calls, 2);
  clearDecisionRead();
  await readDecisions(2, read);
  assert.equal(calls, 3, 'a write forces a fresh read immediately');
});

test('failed and unknown reads are never cached as empty decisions', async () => {
  clearDecisionRead();
  await assert.rejects(readDecisions(1, async () => { throw Error('offline'); }), /offline/);
  let calls = 0;
  const read = async () => { calls++; return []; };
  await readDecisions(1, read);
  await readDecisions(undefined, read);
  await readDecisions(undefined, read);
  assert.equal(calls, 3);
});
