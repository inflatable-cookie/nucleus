import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_DETAIL_SUMMARY_LIMIT, eventActorFact, eventDetailSummary, eventKindLabel, lowValueActivityKinds } from '../shared/task-events';
import { isTerminalPhase, TERMINAL_PHASES } from '../shared/task-state';

/**
 * The Activity tab shows what a recorded event says. The event contract carries
 * a kind and a detail string and no actor, so the actor is a reading of the
 * detail; these cases pin that reading, the human kind label, the bounded detail
 * line, and the terminal-phase pair the Runs and Coordination sections share.
 */

test('an event actor is named only when the recorded detail names one', () => {
  assert.deepEqual(eventActorFact('ask-7: answered by delegated planner agent-2: yes'), { kind: 'named', actor: 'delegated planner agent-2' });
  assert.deepEqual(eventActorFact('Origin: Tom; workspace ws-1'), { kind: 'named', actor: 'Tom' });
  assert.deepEqual(eventActorFact('Worker agent-4 registered for the host'), { kind: 'named', actor: 'agent-4' });
  // The reading stops at the punctuation that ends the name.
  assert.deepEqual(eventActorFact('note recorded by Tom: confirmed the exact review head'), { kind: 'named', actor: 'Tom' });
  // No name recorded anywhere in the detail: unrecorded, never the kind or an empty label.
  assert.deepEqual(eventActorFact('validation_wait'), { kind: 'unrecorded' });
  assert.deepEqual(eventActorFact(''), { kind: 'unrecorded' });
});

test('the first detail reading that names an actor decides it', () => {
  // The first pattern matched without naming anybody; a later pattern's match of
  // the same detail must not stand in, so the actor stays unrecorded.
  assert.deepEqual(eventActorFact('Origin: somewhere; recorded by   '), { kind: 'unrecorded' });
});

test('an event kind reads in words without changing the recorded key', () => {
  assert.equal(eventKindLabel('worker_report'), 'Worker Report');
  assert.equal(eventKindLabel('pre_merge_candidate_created'), 'Pre Merge Candidate Created');
  assert.equal(eventKindLabel('note'), 'Note');
});

test('the detail line is bounded once and the raw record keeps the rest', () => {
  const exact = 'a'.repeat(EVENT_DETAIL_SUMMARY_LIMIT);
  assert.equal(eventDetailSummary(exact), exact);
  const longer = `${exact}b`;
  assert.equal(eventDetailSummary(longer), `${exact}…`);
  assert.equal(eventDetailSummary('short'), 'short');
});

test('low-value stage mechanics are one shared set', () => {
  for (const kind of ['telemetry_stage', 'pre_merge_candidate_intent', 'pre_merge_warm_candidate_missing']) assert.ok(lowValueActivityKinds.has(kind), kind);
  for (const kind of ['worker_report', 'note', 'operator_question_answered']) assert.equal(lowValueActivityKinds.has(kind), false, kind);
});

test('the terminal phases are done and cancelled, and nothing else', () => {
  assert.deepEqual([...TERMINAL_PHASES], ['done', 'cancelled']);
  assert.equal(isTerminalPhase('done'), true);
  assert.equal(isTerminalPhase('cancelled'), true);
  for (const phase of ['queued', 'dispatching', 'working', 'blocked', 'needs_attention', 'reviewing', 'merging', 'closing'] as const) assert.equal(isTerminalPhase(phase), false, phase);
});
