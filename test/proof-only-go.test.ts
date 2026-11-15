import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Run, Task } from '../shared/contracts';
import { busyGoAnswerRefusal, openProofOnlyGo, proofOnlyGoQuestionId } from '../core/qa/proof-only-go';

const head = 'a'.repeat(40);
const task = { id: 'proof-task', phase: 'blocked', proofOnly: { commit: head }, requiresOperatorGo: 'a live consumer', proofExecutions: [] } as unknown as Task;
const id = proofOnlyGoQuestionId(task);

const reviewer = (overrides: Partial<Run> = {}): Run => ({
  id: 'reviewer-1', taskId: task.id, role: 'reviewer', head, proofOnly: true,
  completion: { status: 'blocked', summary: 'Waiting for the operator release GO' },
  ...overrides,
} as unknown as Run);

const executor = (): Run => ({ id: 'executor-1', taskId: task.id, role: 'executor', head } as unknown as Run);
const event = (kind: string, detail = `${id}: GO — run the qualification`) => ({ kind, detail });

test('the wait is the reviewer run\'s recorded proof-only intent, not the prose it was handed', () => {
  assert.equal(openProofOnlyGo(task, [reviewer()], []), id);
  // The same blocked reviewer without the proof-only intent is not a GO-gate
  // reviewer: prompt wording alone never opens the operator wait.
  assert.equal(openProofOnlyGo(task, [reviewer({ proofOnly: undefined })], []), null);
  assert.equal(openProofOnlyGo(task, [reviewer({ completion: { status: 'completed' } as unknown as Run['completion'] })], []), null);
  // A receipt-reviewer round already means the qualification ran.
  assert.equal(openProofOnlyGo(task, [reviewer()], []), id, 'the receipt guard is the task record, not the run');
  assert.equal(openProofOnlyGo({ ...task, proofExecutions: [{ status: 'passed' }] } as unknown as Task, [reviewer()], []), null);
  assert.equal(openProofOnlyGo(task, [reviewer(), executor()], []), null);
  assert.equal(openProofOnlyGo({ ...task, requiresOperatorGo: null } as unknown as Task, [reviewer()], []), null);
  assert.equal(openProofOnlyGo({ ...task, phase: 'working' } as unknown as Task, [reviewer()], []), null);
});

test('an answer keeps the GO open until it is applied, and an unknown delivery ends it', () => {
  assert.equal(openProofOnlyGo(task, [reviewer()], [event('operator_question_answered')]), null, 'an applied answer closes the wait');
  assert.equal(openProofOnlyGo(task, [reviewer()], [event('operator_question_answered'), event('operator_question_applied')]), null);
  // A busy worker refused the control: the GO is retried, not asked again.
  const busy = event('operator_question_refused', `${id}: GO — run the qualification: host capacity remains reserved`);
  assert.equal(busyGoAnswerRefusal(busy.detail), true);
  assert.equal(openProofOnlyGo(task, [reviewer()], [event('operator_question_answered'), busy]), id);
  assert.equal(openProofOnlyGo(task, [reviewer()], [event('operator_question_answered'), busy, event('operator_question_applied')]), null);
  // A refusal that is not a busy one leaves the answer settled.
  const refused = event('operator_question_refused', `${id}: GO — run the qualification: the task version moved`);
  assert.equal(busyGoAnswerRefusal(refused.detail), false);
  assert.equal(openProofOnlyGo(task, [reviewer()], [event('operator_question_answered'), refused]), null);
  // Unknown delivery stays terminal: an answer Queue could not observe is never inferred.
  assert.equal(openProofOnlyGo(task, [reviewer()], [event('operator_question_unknown')]), null);
  assert.equal(openProofOnlyGo(task, [reviewer()], [event('operator_question_answered'), busy, event('operator_question_unknown')]), null);
  // Another question's events never decide this one.
  assert.equal(openProofOnlyGo(task, [reviewer()], [event('operator_question_answered', 'other: GO')]), id);
});
