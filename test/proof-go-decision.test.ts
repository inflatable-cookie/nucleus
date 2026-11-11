import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { DecisionView, Task, TaskControlInput } from '../shared/contracts';
import { proofGoDecision } from '../core/qa/proof-activation';

test('proof GO uses recorded evidence before requesting a board decision', () => {
  const task = { id: 'task', phase: 'blocked' } as Task;
  const input = { relayed: true, note: 'qid' } as TaskControlInput;
  const answer = { kind: 'operator_question_answered', detail: 'qid: GO — run the qualification — answered by operator', at: 'answered' };
  const question = { kind: 'operator_question', detail: 'qid: intent', at: 'asked' };
  const link = { kind: 'operator_question_decision', detail: 'qid: decision d', at: 'linked' };
  assert.deepEqual(proofGoDecision(task, input, [], 'qid', null), { kind: 'refuse', message: 'A proof-only qualification requires the operator GO from its release-kind question before execution' });
  assert.deepEqual(proofGoDecision(task, input, [answer], 'qid', null), { kind: 'refuse', message: 'The proof-only release question evidence is incomplete; no execution was activated' });
  assert.deepEqual(proofGoDecision(task, input, [answer, question, link], 'qid', 'question'), { kind: 'decision', id: 'd' });
  const bad = { question: 'other', links: { tasks: ['task'] }, answer: null } as unknown as DecisionView;
  assert.deepEqual(proofGoDecision(task, input, [answer, question, link], 'qid', 'question', bad), { kind: 'refuse', message: 'The linked board decision does not match the recorded release answer; no execution was activated' });
  const board = { question: 'question', links: { tasks: ['task'] }, answer: { text: 'GO — run the qualification', answeredBy: 'operator', relayed: false, note: '', answeredAt: 'answered' } } as unknown as DecisionView;
  const boardResult = proofGoDecision(task, input, [answer, question, link], 'qid', 'question', board);
  assert.equal(boardResult.kind, 'accepted');
  const unauthorised = { ...board, answer: { ...board.answer!, answeredBy: 'worker' } };
  assert.deepEqual(proofGoDecision(task, input, [answer, question, link], 'qid', 'question', unauthorised), { kind: 'refuse', message: 'The release answer is not recorded as operator GO or a planner relay with the operator quote' });
  const result = proofGoDecision(task, input, [answer, question], 'qid', 'question');
  assert.equal(result.kind, 'accepted');
  if (result.kind === 'accepted') assert.equal(result.evidence.answeredBy, 'operator');
});
