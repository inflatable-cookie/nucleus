/**
 * The QA admission refusal vocabulary: a scheduler decides whether a batch may
 * resume from the typed code on the stored request, and never from diagnostic
 * text that happens to look like a lifecycle refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qaAdmissionRefusalCodeSchema, qaAdmissionRefusalCodes } from '../shared/contracts';
import {
  QaAdmissionRefusal, qaAdmissionRefusalCode, qaAdmissionRefusalResumesBatch, refuseQaAdmission,
} from '../core/qa/project-qa-refusals';

test('exactly the lifecycle codes let a scheduled batch resume under a new request identity', () => {
  assert.deepEqual(qaAdmissionRefusalCodes.filter(code => qaAdmissionRefusalResumesBatch(code)), [
    'schedule_paused', 'schedule_owner_closing', 'schedule_no_planner',
    'release_line_acquired', 'concurrent_head_moved', 'fence', 'interrupted_preparation']);
  for (const code of ['request_conflict', 'expected_head_mismatch', 'existing_head_mismatch', 'storage_unavailable', 'unclassified'] as const)
    assert.equal(qaAdmissionRefusalResumesBatch(code), false, code);
  assert.equal(qaAdmissionRefusalResumesBatch(null), false, 'an absent code never resumes a batch');
  assert.equal(qaAdmissionRefusalResumesBatch(undefined), false);
});

test('a refusal records its code and keeps the diagnostic text every stored request already carried', () => {
  const fenced = new QaAdmissionRefusal('fence', 'QA admission is fenced until 2026-11-15T00:00:00.000Z (reason); no QA run was created');
  assert.equal(fenced.code, 'fence');
  assert.equal(String(fenced), 'Error: QA admission is fenced until 2026-11-15T00:00:00.000Z (reason); no QA run was created',
    'a refusal renders exactly as the plain Error it replaces');
  assert.equal(qaAdmissionRefusalCode(fenced), 'fence');
  assert.throws(() => refuseQaAdmission('schedule_paused', 'paused'),
    (error: unknown) => error instanceof QaAdmissionRefusal && error.code === 'schedule_paused' && error.message === 'paused');
});

test('a failure outside the vocabulary is unclassified, never guessed from its message', () => {
  assert.equal(qaAdmissionRefusalCode(new Error('Scheduled QA paused, disabled or repository settings changed before admission')), 'unclassified',
    'matching lifecycle text alone never classifies a refusal');
  assert.equal(qaAdmissionRefusalCode('Scheduled QA requires an active project with a planner'), 'unclassified');
  assert.equal(qaAdmissionRefusalCode(undefined), 'unclassified');
  assert.equal(qaAdmissionRefusalResumesBatch(qaAdmissionRefusalCode(new Error('QA admission is fenced'))), false);
  assert.equal(qaAdmissionRefusalCodeSchema.parse('interrupted_preparation'), 'interrupted_preparation');
});
