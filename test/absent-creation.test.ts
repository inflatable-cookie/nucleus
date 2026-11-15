import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absentReplacementRecord, absentReplacementRole, absentReplacementSpent } from '../core/recovery/absent-creation';
import type { Run } from '../shared/contracts';

const replaced = (role: Run['role'], runId: string) =>
  ({ kind: 'absent_creation_replaced', detail: absentReplacementRecord(role, runId, `Confirmed absent ${role} creation; Nucleus issued one replacement`) });

test('the one-replacement budget is read from the record it wrote', () => {
  const events = [replaced('reviewer', 'review-run')];
  assert.equal(absentReplacementSpent(events, 'reviewer'), true);
  assert.equal(absentReplacementSpent(events, 'executor'), false);
  assert.equal(absentReplacementSpent([], 'reviewer'), false);
  assert.equal(absentReplacementRole(absentReplacementRecord('closeout', 'closeout-run', 'Replacement issued')), 'closeout');
});

test('only a replacement record spends a budget', () => {
  const detail = absentReplacementRecord('reviewer', 'review-run', 'text');
  assert.equal(absentReplacementSpent([{ kind: 'absent_worker_retry', detail }], 'reviewer'), false);
  assert.equal(absentReplacementSpent([{ kind: 'absent_creation_replaced', detail: 'something else' }], 'reviewer'), false);
  assert.equal(absentReplacementRole('something else'), null);
});

test('a replacement recorded before the scoped detail still spends its role budget', () => {
  // The legacy record named the role inside the sentence; a task created under it
  // still owns one replacement, so the read keeps recognising it.
  const legacy = [{ kind: 'absent_creation_replaced', detail: 'Confirmed absent executor creation; Nucleus issued one replacement' }];
  assert.equal(absentReplacementSpent(legacy, 'executor'), true);
  assert.equal(absentReplacementSpent(legacy, 'reviewer'), false);
});
