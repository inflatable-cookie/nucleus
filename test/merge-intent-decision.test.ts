import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { UNCERTAIN_MERGE_PROOF_TIMEOUT_MS } from '../shared/contracts';
import type { Task } from '../shared/contracts';
import { mergeIntentDecision } from '../core/merge/merge-intent';

test('merge intent proof window and retry fences', () => {
  const cases: Array<[object, number, number, string]> = [
    [{mergeResponseOutcome: 'uncertain'}, 0, 100, 'gate_then_reissue'],
    [{mergeResponseOutcome: 'uncertain', mergeAutoRetryExhausted: true}, 0, 100, 'wait'],
    [{mergeResponseOutcome: 'uncertain', mergeRetryAt: 'then', mergeRetryOutcome: 'pending'}, UNCERTAIN_MERGE_PROOF_TIMEOUT_MS, 100, 'wait'],
    [{mergeResponseOutcome: 'uncertain', mergeRetryAt: 'then', mergeRetryOutcome: 'accepted'}, UNCERTAIN_MERGE_PROOF_TIMEOUT_MS, 100, 'escalate'],
    [{mergeResponseOutcome: 'uncertain'}, UNCERTAIN_MERGE_PROOF_TIMEOUT_MS, 100, 'gate_then_reissue'],
    [{mergeResponseOutcome: 'pending'}, UNCERTAIN_MERGE_PROOF_TIMEOUT_MS, 100, 'escalate'],
    [{mergeResponseOutcome: 'uncertain'}, 0, NaN, 'wait'],
  ];
  for (const [resolution, elapsed, clock, expected] of cases)
    assert.equal(mergeIntentDecision({ resolution } as Task, 0, elapsed, 100, clock), expected);
});

test('merge observation and proof window decisions', async () => {
  const { mergeObservationDecision, mergeProofDecision } = await import('../core/merge/merge-intent');
  const task = {baseBranch: 'main', resolution: {mergeHead: 'head'}} as Task;
  const merged = {merged: true, head: 'head', base: 'main', commit: 'commit'} as const;
  for (const [result, expected] of [
    [merged, 'verified'], [{...merged, head: 'other'}, 'identity_mismatch'],
    [{...merged, base: 'other'}, 'identity_mismatch'], [{...merged, commit: ''}, 'identity_mismatch'],
    [{merged: false}, 'reconcile'],
  ] as const) assert.equal(mergeObservationDecision(task, result as Parameters<typeof mergeObservationDecision>[1]), expected);
  for (const [proven, since, elapsed, expected] of [
    [false, null, 0, 'incomplete_wait'], [false, null, UNCERTAIN_MERGE_PROOF_TIMEOUT_MS, 'incomplete_escalate'],
    [true, 'bad', 0, 'reset'], [true, null, 0, 'start'],
    [true, null, UNCERTAIN_MERGE_PROOF_TIMEOUT_MS, 'window_escalate'], [true, '2026-01-01', 0, 'continue'],
  ] as const) assert.equal(mergeProofDecision(proven, since, elapsed, 1), expected);
});

test('map bug 40: a pending retry remains spent while its response is unrecorded', () => {
  const task = {resolution: {mergeResponseOutcome: 'uncertain', mergeRetryAt: 'then',
    mergeRetryOutcome: 'pending', mergeAutoRetryExhausted: true}} as Task;
  assert.equal(mergeIntentDecision(task, 0, UNCERTAIN_MERGE_PROOF_TIMEOUT_MS, 100, 100), 'wait');
});
