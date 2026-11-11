import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingInactiveParticipant } from '../core/intake/run-settlement';
import type { AgentObservation } from '../core/host';

const participant = { agentId: 'agent', workspaceId: 'workspace' };
const observed = (overrides: Partial<AgentObservation> = {}): AgentObservation => ({
  id: 'agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', ...overrides,
});

test('closed-implies-error: every closed-accepting list admits an errored agent with no turn and no permission', async () => {
  for (const statuses of [['idle', 'closed'], ['closed'], ['idle', 'error', 'closed']] as const) {
    assert.equal(matchingInactiveParticipant(participant, observed({ status: 'error' }), [...statuses]), true, JSON.stringify(statuses));
    assert.equal(matchingInactiveParticipant(participant, observed({ status: 'closed' }), [...statuses]), true, JSON.stringify(statuses));
  }
  for (const statuses of [['idle', 'closed'], ['idle', 'error', 'closed']] as const) {
    assert.equal(matchingInactiveParticipant(participant, observed({ status: 'idle' }), [...statuses]), true, JSON.stringify(statuses));
  }
  assert.equal(matchingInactiveParticipant(participant, observed({ status: 'idle' }), ['closed']), false, 'a closed-only list stays terminal, not idle');
});

test('idle-only lists stay strict: an errored agent is not idle', async () => {
  assert.equal(matchingInactiveParticipant(participant, observed({ status: 'error' }), ['idle']), false);
  assert.equal(matchingInactiveParticipant(participant, observed({ status: 'closed' }), ['idle']), false);
  assert.equal(matchingInactiveParticipant(participant, observed({ status: 'idle' }), ['idle']), true);
});

test('an errored agent with a live turn, an active flag or a pending permission still fences', async () => {
  for (const statuses of [['idle', 'closed'], ['closed'], ['idle', 'error', 'closed']] as const) {
    const list = [...statuses];
    assert.equal(matchingInactiveParticipant(participant, observed({ status: 'error', activeTurnId: 'turn-live' }), list), false, JSON.stringify(list));
    assert.equal(matchingInactiveParticipant(participant, observed({ status: 'error', active: true }), list), false, JSON.stringify(list));
    assert.equal(matchingInactiveParticipant(participant, observed({ status: 'error', permissions: true }), list), false, JSON.stringify(list));
    assert.equal(matchingInactiveParticipant(participant, observed({ status: 'closed', active: true }), list), false, JSON.stringify(list));
  }
});

test('identity and workspace still bind: a matching error elsewhere is not this participant', async () => {
  assert.equal(matchingInactiveParticipant(participant, observed({ id: 'someone-else', status: 'error' })), false);
  assert.equal(matchingInactiveParticipant(participant, observed({ workspaceId: 'other-workspace', status: 'error' })), false);
  assert.equal(matchingInactiveParticipant({ agentId: null, workspaceId: 'workspace' }, observed({ status: 'error' })), false);
  assert.equal(matchingInactiveParticipant(participant, observed({ status: 'running' })), false);
});
