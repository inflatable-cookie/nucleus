import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdBadgeTone, phaseBadgeTone, recordBadgeTone } from '../shared/badge-tones';

test('papercuts are red and leads green; the other badges follow the same tones', () => {
  assert.equal(recordBadgeTone('Papercut'), 'danger');
  assert.equal(recordBadgeTone('papercut'), 'danger', 'a papercut tag matches too');
  assert.equal(recordBadgeTone('Lead'), 'success');
  assert.equal(recordBadgeTone('Checks failed · missing section'), 'danger');
  assert.equal(recordBadgeTone('Checks passed'), 'success');
  assert.equal(recordBadgeTone('Unchecked'), 'neutral');
  assert.equal(recordBadgeTone('Approved'), 'accent');
  assert.equal(recordBadgeTone('Unapproved'), 'warning');
  assert.equal(recordBadgeTone('Submitting'), 'accent');
  assert.equal(recordBadgeTone('shared integration checkout'), 'neutral', 'areas and lanes stay neutral');
});

test('task phase badges: attention red, needs a hand amber, in progress blue, heading to done green', () => {
  const t = (phase: string, extra: object = {}) => ({ held: false, phase, disposition: null, ...extra });
  for (const phase of ['blocked', 'error', 'needs_attention']) assert.equal(phaseBadgeTone(t(phase)), 'danger', phase);
  assert.equal(phaseBadgeTone(t('working', { disposition: { status: 'intent' } })), 'danger', 'cancelling');
  assert.equal(phaseBadgeTone(t('changes_requested')), 'warning');
  assert.equal(phaseBadgeTone(t('queued', { held: true })), 'neutral', 'the phase keeps its own tone');
  assert.equal(holdBadgeTone('dispatch'), 'warning');
  assert.equal(holdBadgeTone('merge'), 'accent');
  for (const phase of ['dispatching', 'working']) assert.equal(phaseBadgeTone(t(phase)), 'accent', phase);
  for (const phase of ['awaiting_review', 'reviewing', 'verifying', 'merging', 'syncing', 'closing']) assert.equal(phaseBadgeTone(t(phase)), 'success', phase);
  assert.equal(phaseBadgeTone(t('queued')), 'neutral');
});
