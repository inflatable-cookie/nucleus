import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, head } from './support/responsible-lifecycle-fixture';
import { ANSWERING_WINDOW_MS, waitFor } from './support/budgets';

/**
 * Papercut a1bc9fe5: bovine-accelerator#5986's proof question went to
 * `operator_question_unknown` when the Paseo transport dropped at 21:07. It was
 * never delegated, so `question.answer` refused the project planner and a forced
 * merge refused for lack of an applied verdict; the Nucleus planner had to relay
 * a qualified acceptance by hand.
 *
 * A question whose native delivery goes unknown now falls back to the same
 * question id on the planner ladder: the planner answers through question.answer
 * and the answer settles that one question. A late native answer is recorded
 * against the same question and applies nothing twice.
 */
test('a1bc9fe5: an unknown-delivery proof question is answerable on the planner ladder', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Choice: Leave held for the planner\nReason: Keep the proofs outstanding until the planner decides.' } });
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    const current = f.current();
    const at = new Date().toISOString();
    f.store.update(f.submitted.id, {
      phase: 'needs_attention',
      reason: 'Source approved at the head; awaiting proof: run the hardware soak',
      resolution: {
        ...current.resolution,
        stop: {
          reason: 'awaiting_proof',
          detail: 'Source approved; externally produced proofs outstanding: run the hardware soak',
          since: at,
          suggestedVerbs: ['move'],
        },
        review: {
          eventId: 'review-proof', taskId: f.submitted.id, runId: 'reviewer-initial', status: 'blocked',
          summary: 'Source approved; external proofs outstanding', head, sourceApproved: true,
          awaitingProofs: [{ proof: 'run the hardware soak', route: 'external' }],
        },
      },
    }, 'test_awaiting_proof', 'reviewer approved the head with an external proof outstanding');
    // The recorded shape: native delivery dropped before Paseo observed a request.
    f.adapter.raiseTaskDecision = async () => { throw Error('Transport not connected'); };
    await f.engine.resolution.raiseOperatorQuestions(f.submitted.id);
    await waitFor(() => f.events('operator_question_unknown').length === 1, ANSWERING_WINDOW_MS, 'unknown native delivery');
    await waitFor(() => f.events('operator_question_answered').length === 1, ANSWERING_WINDOW_MS, 'the planner ladder answer');
    const unknown = f.events('operator_question_unknown')[0]!;
    const id = unknown.detail.split(':', 1)[0]!;
    assert.ok(f.events('operator_question_unknown_delegated').some(event => event.detail.startsWith(`${id}:`)),
      'the unknown delivery falls back to the planner ladder for the same question id');
    assert.ok(f.events('delegated_command_answered').some(event => event.detail.includes(id)),
      'the planner answered through question.answer as the delegated recipient');
    assert.ok(f.events('operator_question_answered')[0]!.detail.startsWith(`${id}:`), 'the same question is answered, not a second one');
    assert.ok(f.events('operator_question_applied').some(event => event.detail.startsWith(`${id}:`)),
      'the answer applies through the ordinary owner controls');
    // A late native answer reconciles with the same question and applies nothing twice.
    const applied = f.events('operator_question_applied').length;
    await f.engine.resolution.settleOperatorQuestion(f.submitted.id, {
      id, kind: 'proof_acceptance', question: 'How should the task proceed at that head?',
      choices: [{ label: 'Leave held for the planner' }],
    }, 'Leave held for the planner');
    assert.equal(f.events('operator_question_answered').length, 1, 'a late answer never records a second answer');
    assert.equal(f.events('operator_question_applied').length, applied, 'a late answer applies no second control');
    assert.ok(f.events('operator_question_late_answer').length === 1);
  } finally { await f.close(); }
});
