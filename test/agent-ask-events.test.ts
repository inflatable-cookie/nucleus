import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { askLifecycle, askLifecycles } from '../core/questions/agent-ask-events';
import { agentAskId } from '../core/questions/agent-ask';

/**
 * The ask lifecycle decoder's boundary: every record shape the ask service once
 * matched by prefix is decoded once, in one place, and the resulting state is
 * what every reader decides from.
 */
const askId = agentAskId('task-1', 'scope', 'Which route?', ['A', 'B']);
const ask = (kind: string, detail: string, at = '2026-11-15T00:00:00.000Z') => ({ kind, detail, at });

test('the decoder reads one ask lifecycle from its records, never from a caller prefix', () => {
  const events = [
    ask('agent_ask', `${askId}: kind scope; run run-1 (revision); agent agent-1; question abc (13 chars); choices none`),
    ask('agent_ask_delegated', `${askId}: task planner planner-1; asked`),
    ask('agent_ask_delegation_unknown', `${askId}: planner planner-1: provider error`),
  ];
  const state = askLifecycle(events, askId);
  assert.ok(state);
  assert.equal(state!.asked, true);
  assert.equal(state!.kind, 'scope');
  assert.equal(state!.runId, 'run-1');
  assert.equal(state!.agentId, 'agent-1');
  assert.equal(state!.askedAt, '2026-11-15T00:00:00.000Z');
  assert.deepEqual(state!.planner, { agentId: 'planner-1', rung: 'task' });
  assert.equal(state!.delegationUnknown, true);
  assert.equal(state!.answered, null);
});

test('an answered ask names who answered and what, and a joined ask keeps its Queue question', () => {
  const events = [
    ask('agent_ask', `${askId}: kind scope; run run-1 (revision); agent agent-1; question abc (13 chars); choices none`),
    ask('agent_ask_joined', `${askId}: queue question question-1`),
    ask('agent_ask_answered', `${askId}: answered by reviewer reviewer-9: take route A — because the tests bind it`),
  ];
  const state = askLifecycle(events, askId)!;
  assert.equal(state.joined, 'question-1');
  assert.deepEqual(state.answered, { who: 'reviewer reviewer-9', answer: 'take route A — because the tests bind it' });
});

test('supersession, reviewer ruling, misses and resumes are separate typed facts', () => {
  const events = [
    ask('agent_ask', `${askId}: kind scope; run run-1 (revision); agent agent-1; question abc (13 chars); choices none`),
    ask('agent_ask_delegated', `${askId}: reviewer reviewer-1; consult`),
    ask('agent_ask_planning_ruling', `${askId}: reviewer reviewer-1: Decision: planner`),
    ask('agent_ask_resume_intent', `${askId}: host host-1; agent agent-1; run run-1`),
    ask('agent_ask_superseded', `${askId}: the originating run ended`),
  ];
  const state = askLifecycle(events, askId)!;
  assert.equal(state.reviewer, 'reviewer-1');
  assert.equal(state.planningRuling, true);
  assert.ok(state.planningRulingDetail?.includes('Decision: planner'));
  assert.equal(state.reviewerMissed, false);
  assert.equal(state.resumeIntent, true);
  assert.equal(state.resumed, false);
  assert.equal(state.superseded, true);
});

test('records of another ask or another domain stay out of this ask', () => {
  const other = agentAskId('task-2', 'scope', 'Which other?', []);
  const events = [
    ask('agent_ask', `${other}: kind scope; run run-2 (revision); agent agent-2; question def (3 chars); choices none`),
    ask('operator_question_answered', `${askId}: answered by operator: not an ask record`),
  ];
  const states = askLifecycles(events);
  assert.deepEqual([...states.keys()], [other]);
  assert.equal(states.get(other)!.answered, null);
  assert.equal(askLifecycle(events, askId), null, 'a Queue-question record is not an ask record');
});

test('the decoder ignores a malformed record instead of inventing an ask', () => {
  const events = [ask('agent_ask', 'no separator here'), ask('agent_ask_answered', ': answered by nobody: nothing')];
  assert.deepEqual([...askLifecycles(events).keys()], []);
});
