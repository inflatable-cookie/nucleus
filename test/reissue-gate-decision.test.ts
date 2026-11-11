import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Task } from '../shared/contracts';
import { UNCERTAIN_MERGE_PROOF_TIMEOUT_MS } from '../shared/contracts';
import { reissueGateDecision } from '../core/merge/merge-intent';
import type { MergeGateResult } from '../core/resolution';

test('reissue gate decides identity, refusal, hold and issue in order', () => {
  const task = { resolution: { mergeHead: 'head', mergeBase: 'base' } } as Task;
  const gate = { head: 'head', base: 'base' } as MergeGateResult;
  const cases: Array<[Partial<MergeGateResult>, number, string, string]> = [
    [{head: 'other', base: 'other'}, 0, 'escalate', 'The PR head is other'],
    [{base: 'other'}, 0, 'escalate', 'The integration base is other'],
    [{wait: 'checks', checksFailed: true}, 0, 'escalate', 'current exact-head gates refuse'],
    [{wait: 'checks'}, UNCERTAIN_MERGE_PROOF_TIMEOUT_MS, 'escalate', 'within 30 minutes'],
    [{wait: 'checks'}, 0, 'wait', 'waits for current exact-head gates'],
    [{}, 0, 'issue', ''],
  ];
  for (const [changes, elapsed, kind, reason] of cases) {
    const result = reissueGateDecision(task, { ...gate, ...changes }, elapsed);
    assert.equal(result.kind, kind);
    if (result.kind !== 'issue') assert.ok(result.reason.includes(reason));
  }
});
