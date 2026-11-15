import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { digest } from '../core/store/store';
import { decisionAnswerLinks, delegatedDecisionRouteRecords, intentNamesQuestion, intentOptions, operatorQuestionRecord,
  operatorQuestionRecords, queueAskPayloads, questionRecordKinds } from '../core/questions/question-events';
import type { OperatorQuestion } from '../core/questions/operator-question';

/**
 * The operator-question decoder's boundary: the raise intent, its decision link and
 * the marks that fence a re-raise or a re-answer are decoded once here, so no raise,
 * answer or recovery path compares event text.
 */
const id = 'question-1';
const at = '2026-11-15T00:00:00.000Z';
const event = (kind: string, detail: string, eventId = 1) => ({ id: eventId, taskId: 'task-1', at, kind, detail });
const intent = (question: string, labels: string[], kind = 'budget') =>
  `${id}: kind ${kind}; stop budget; head none; question ${digest(question)} (${question.length} chars); options ${intentOptions(labels)}`;
const question = (text: string, labels: string[]): OperatorQuestion =>
  ({ id, kind: 'budget', question: text, choices: labels.map(label => ({ label, consequence: '' })) }) as unknown as OperatorQuestion;

test('the raise intent decodes its kind, stop, head, digest and options once', () => {
  const decoded = operatorQuestionRecord([event('operator_question', intent('Extend the budget?', ['Extend the budget', 'Stop and keep the work']))], id)!;
  assert.equal(decoded.intent?.kind, 'budget');
  assert.equal(decoded.intent?.stop, 'budget');
  assert.equal(decoded.intent?.head, 'none');
  assert.equal(decoded.intent?.questionDigest, digest('Extend the budget?'));
  assert.equal(decoded.intent?.questionLength, 'Extend the budget?'.length);
  assert.deepEqual(decoded.intent?.options, ['Extend the budget', 'Stop and keep the work']);
  assert.equal(decoded.kinds.has('operator_question'), true);
});

test('an intent names exactly its own question and never a changed one', () => {
  const decoded = operatorQuestionRecord([event('operator_question', intent('Extend the budget?', ['Extend the budget']))], id)!;
  assert.equal(intentNamesQuestion(decoded.intent!, question('Extend the budget?', ['Extend the budget'])), true);
  assert.equal(intentNamesQuestion(decoded.intent!, question('Extend the budget?', ['Stop and keep the work'])), false);
  assert.equal(intentNamesQuestion(decoded.intent!, question('Change the approach?', ['Extend the budget'])), false);
});

test('the decision link keeps the decision id and the reason the board was chosen', () => {
  const decisionId = '11111111-1111-1111-1111-111111111111';
  const decoded = operatorQuestionRecord([
    event('operator_question', intent('Extend the budget?', [])),
    event('operator_question_decision', `${id}: decision ${decisionId}; the planner ladder ran out without an answer`, 2),
  ], id)!;
  assert.deepEqual(decoded.link, { decisionId, why: 'the planner ladder ran out without an answer' });
  assert.equal(decoded.kinds.has('operator_question_decision'), true);
});

test('a refused question keeps its last refusal, and a delegation records its unknown and miss', () => {
  const events = [
    event('operator_question', intent('Extend the budget?', [])),
    event('operator_question_refused', `${id}: Extend the budget: worker running`, 2),
    event('operator_question_refused', `${id}: Extend the budget: capacity exhausted`, 3),
    event('operator_question_delegation_unknown', `${id}: planner planner-1: provider error`, 4),
    event('operator_question_delegation_missed', `${id}: no delegated answer was produced; the question waits`, 5),
  ];
  const decoded = operatorQuestionRecord(events, id)!;
  assert.equal(decoded.refusal, 'capacity exhausted');
  assert.equal(decoded.delegationUnknown, true);
  assert.equal(decoded.noAnswerMissed, true);
  assert.equal(operatorQuestionRecord(events, 'another-question'), null);
});

test('a decision answer names every record that linked it, by kind and id', () => {
  const decisionId = '22222222-2222-2222-2222-222222222222';
  const links = decisionAnswerLinks([
    event('operator_question_decision', `${id}: decision ${decisionId}; board`, 1),
    event('agent_ask_decision', `ask-1: decision ${decisionId}`, 2),
    event('planner_escalation_decision_linked', `escalation-1: decision ${decisionId}`, 3),
    event('operator_question_decision', `question-2: decision 33333333-3333-3333-3333-333333333333; other`, 4),
  ], decisionId);
  assert.deepEqual(links, [
    { kind: 'operator_question_decision', id },
    { kind: 'agent_ask_decision', id: 'ask-1' },
    { kind: 'planner_escalation_decision_linked', id: 'escalation-1' },
  ]);
});

test('the recorded kinds name every question-scoped record an id wrote', () => {
  const kinds = questionRecordKinds([
    event('operator_question', intent('Extend the budget?', [])),
    event('operator_question_answered', `${id}: Extend the budget — answered by operator`, 2),
    event('agent_ask_superseded', `ask-1: the question moved on`, 3),
    event('queue_ask_payload', JSON.stringify({ id, kind: 'budget', question: 'Extend?', options: [] }), 4),
  ]);
  assert.deepEqual([...(kinds.get(id) ?? [])].sort(), ['operator_question', 'operator_question_answered']);
  assert.equal(kinds.get('ask-1')?.has('agent_ask_superseded'), true);
});

test('only unreadable JSON is dropped; an incomplete saved payload is handed on as recorded', () => {
  const complete = { id, kind: 'budget', question: 'Extend?', options: ['A'] };
  const incomplete = { id: 'missing-options', kind: 'process', question: 'Continue?' };
  const payloads = queueAskPayloads([
    event('queue_ask_payload', JSON.stringify(complete)),
    event('queue_ask_payload', '{not json', 2),
    event('queue_ask_payload', JSON.stringify(incomplete), 3),
  ]);
  // The decoder is a boundary, not a filter: an incomplete payload reaches the
  // recovery path, where its missing field surfaces instead of vanishing here.
  assert.deepEqual(payloads, [complete, incomplete]);
});

test('a delegated route is recovered in record order, and an unreadable later record never hides it', () => {
  const decision = { id, kind: 'budget' as const, question: 'Extend?', options: ['A'] };
  const valid = { decision, request: { requestId: 'request-1', header: 'Budget' } };
  const records = delegatedDecisionRouteRecords([
    event('delegated_decision_route', JSON.stringify(valid), 6),
    event('delegated_decision_route', '{not json', 7),
  ]);
  assert.deepEqual(records, [
    { eventId: 6, route: valid },
    { eventId: 7, route: null },
  ]);
  // The recovery sweep starts each readable route as it meets it, then names the
  // unreadable record, exactly as the per-record loop did before the decoder.
  const started: string[] = [];
  let named: string | null = null;
  for (const entry of records) {
    if (!entry.route) { named = `Delegated decision route ${entry.eventId} is not readable JSON`; break; }
    started.push(entry.route.decision.id);
  }
  assert.deepEqual(started, [id]);
  assert.equal(named, 'Delegated decision route 7 is not readable JSON');
  assert.deepEqual(delegatedDecisionRouteRecords([event('delegated_decision_route', '{not json', 7)]),
    [{ eventId: 7, route: null }]);
});

test('a recorded native request decodes the identity the raise compares', () => {
  const records = operatorQuestionRecords([
    event('operator_question', intent('Extend the budget?', [])),
    event('operator_question_native_request', `${id}: request native-1 header Question 1 on worker`, 2),
  ]);
  const recorded = records.get(id)!;
  assert.deepEqual(recorded.nativeRequests, [{ requestId: 'native-1', header: 'Question 1', agentId: 'worker' }]);
  // Every record is decoded, so a repeat is visible as two identities of the same request.
  const repeated = operatorQuestionRecords([
    event('operator_question', intent('Extend the budget?', [])),
    event('operator_question_native_request', `${id}: request native-1 header Question 1 on worker`, 2),
    event('operator_question_native_request', `${id}: request native-1 header Question 1 on worker`, 3),
  ]).get(id)!;
  assert.deepEqual(repeated.nativeRequests.map(item => item.requestId), ['native-1', 'native-1']);
});

test('operator question records keep a question apart from a responsible question', () => {
  const records = operatorQuestionRecords([
    event('operator_question', intent('Extend the budget?', [])),
    event('responsible_question', `joint-1: kind review; stop none; head none; question abc (3 chars); options none`, 2),
  ]);
  assert.equal(records.get(id)?.kinds.has('operator_question'), true);
  assert.equal(records.get('joint-1')?.kinds.has('responsible_question'), true);
  assert.equal(records.get('joint-1')?.intent, null);
});
