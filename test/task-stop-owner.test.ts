import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  legacyStopHolderAgentId, recordedStopIsHeld, recordedStopIsWait, taskStopClassification, taskStopRecord, taskStopVerbsFor, unclassifiedTaskStop,
} from '../shared/task-stop';

/**
 * One declared family per stop reason, in precedence order, and one owner for
 * what a *recorded* stop is (nucleus#1252). These are the table's boundaries: the
 * order two families are read in, the declared tail, and the typed reads a
 * surface makes of a record instead of the sentence it also stores.
 */
const at = '2026-10-27T00:00:00.000Z';

test('the first declared family a detail matches decides its reason', () => {
  assert.deepEqual(taskStopClassification('Merge held by operator: capacity is fine').reason, 'held');
  assert.deepEqual(taskStopClassification('Dispatch held by a planner thread').suggestedVerbs, []);
  assert.deepEqual(taskStopClassification('An uncertain side effect blocks review: effect e1').suggestedVerbs, ['retry_effect']);
  assert.equal(taskStopClassification('Command failed: gh api repos/o/r/pulls/9 HTTP 502').reason, 'external_unavailable');
  assert.equal(taskStopClassification('No eligible profile for the reviewer role').reason, 'route_unavailable');
  // A wait the ladder writes is a wait, not attention.
  assert.equal(taskStopClassification('Waiting with the retained reviewer: consult c1 is out').reason, 'escalated');
  assert.equal(taskStopClassification('Waiting on project-a host h1 since 2026-10-27T00:00:00Z').reason, 'host_unavailable');
});

test('detail no family names is the declared tail, not a silent default', () => {
  const tail = unclassifiedTaskStop();
  assert.deepEqual(tail, { reason: 'operator_needed', suggestedVerbs: taskStopVerbsFor('operator_needed') });
  assert.deepEqual(taskStopClassification('Something nobody declared happened'), tail);
  assert.deepEqual(taskStopClassification('').reason, 'operator_needed');
});

test('a recorded stop is a wait or a hold by its own typed reason, with its detail only for an older row', () => {
  const record = taskStopRecord('capacity', 'Waiting for a project slot…', null, at);
  assert.equal(recordedStopIsWait(record), true);
  assert.equal(recordedStopIsHeld(record), false);
  // A row whose reason was typed before its sentence changed keeps both answers.
  assert.equal(recordedStopIsWait(taskStopRecord('operator_needed', 'Origin author thread 0b355fd4 active turn', null, at)), true);
  assert.equal(recordedStopIsHeld(taskStopRecord('held', 'a sentence that names no hold', null, at)), true);
  assert.equal(recordedStopIsHeld(taskStopRecord('operator_needed', 'Merge held by operator: receipt pending', null, at)), true);
  assert.equal(recordedStopIsWait(taskStopRecord('operator_needed', 'Needs a decision', null, at)), false);
});

test('the escalation holder is a typed fact on the record, absent when the writer names none', () => {
  const held = taskStopRecord('escalated', 'Waiting with the planner or task owner agent-1: blocker escalation e1 is open', null, at, [], 'agent-1');
  assert.equal(held.holderAgentId, 'agent-1');
  const unnamed = taskStopRecord('escalated', 'Waiting with the planner: blocker escalation e1 is open', null, at);
  assert.equal(unnamed.holderAgentId, undefined);
  // A re-recorded stop keeps the reason's first timestamp and its own holder.
  const again = taskStopRecord('escalated', 'Waiting with the planner or task owner agent-1: still open', held, '2026-10-27T01:00:00.000Z', [], 'agent-1');
  assert.equal(again.since, held.since);
  assert.equal(again.holderAgentId, 'agent-1');
});

test('a stop written before the holder field still names the agent its sentence named', () => {
  const holder = '7a3c4bc4-e0db-48bb-9071-4ae6f3a09222';
  assert.equal(legacyStopHolderAgentId(`Waiting with the planner or task owner ${holder}: blocker escalation e1 is open`), holder);
  assert.equal(legacyStopHolderAgentId('Waiting with the planner: blocker escalation e1 is open'), undefined);
  assert.equal(legacyStopHolderAgentId(null), undefined);
  assert.equal(legacyStopHolderAgentId(undefined), undefined);
});
