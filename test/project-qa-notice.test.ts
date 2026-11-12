import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectQaNotice, uniqueProjectQaRecipients } from '../core/qa/project-qa-notice';
import { formatAgentId } from '../shared/agent-identity';

const index = { stage: 'test:timing', tests: 3, failed: 2, cancelled: 0, skipped: 0,
  identities: [{ id: 1, title: 'timing: CPU budget', location: 'test/cost.ts:2:3', status: 'failed' as const },
    { id: 2, title: 'timing: wall budget', location: null, status: 'failed' as const }],
  omittedIdentities: 0, truncated: false, diagnosticsTruncated: false };

test('passed QA names inconclusive timing oracles instead of hiding failures as advisory', () => {
  const notice = projectQaNotice({ id: 'run', state: 'passed', failureIndexes: [index] });
  assert.match(notice, /Milestone QA passed: 0 failed, 0 cancelled/);
  assert.match(notice, /timing inconclusive under load: 2 performance oracles failed/);
  assert.match(notice, /timing: CPU budget \(test\/cost.ts:2:3\)/);
  assert.match(notice, /timing: wall budget/);
  assert.doesNotMatch(notice, /advisory/);
});

test('failed timing QA counts functional failures and cancellation as blocking', () => {
  const notice = projectQaNotice({ id: 'run', state: 'failed', failureIndexes: [{ ...index, cancelled: 1 }] });
  assert.match(notice, /Milestone QA failed: 2 failed, 1 cancelled/);
  assert.match(notice, /test:timing: 2 failed, 1 cancelled/);
  assert.doesNotMatch(notice, /inconclusive/);
});

test('QA settlement fan-out sends one notice for qualified and bare forms of a Paseo thread', () => {
  const qualified = formatAgentId('paseo:fixture', 'planner-thread');
  assert.deepEqual(uniqueProjectQaRecipients([qualified, 'planner-thread']), [qualified]);
});

test('QA settlement fan-out keeps equal native IDs on different hosts distinct', () => {
  assert.deepEqual(uniqueProjectQaRecipients([
    formatAgentId('paseo:fixture', 'same-thread'),
    formatAgentId('t3code:fixture', 'same-thread'),
    'same-thread',
  ]), [formatAgentId('paseo:fixture', 'same-thread'), formatAgentId('t3code:fixture', 'same-thread')]);
});
