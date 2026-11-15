import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSettled, settledAgentStatuses } from '../core/machine/agent-settled';

/**
 * The settled-thread predicate every launch, lease, reap and archive proof now
 * reads. These pin the three facts it decides on, and the one equivalence it
 * owns: an errored thread with no live turn and no pending permission is
 * inactive wherever a caller accepts `closed`.
 */

const observation = (fields: Partial<{ active: boolean; permissions: boolean; status: string }> = {}) =>
  ({ active: false, permissions: false, status: 'idle', ...fields });

test('a settled thread has no live turn, no pending permission and an accepted status', () => {
  assert.equal(agentSettled(observation()), true);
  for (const status of ['idle', 'closed', 'error']) assert.equal(agentSettled(observation({ status })), true, status);
  assert.equal(agentSettled(observation({ active: true })), false, 'a live turn is not settled');
  assert.equal(agentSettled(observation({ permissions: true })), false, 'a pending permission is not settled');
  for (const status of ['running', 'initializing', 'blocked', 'unknown']) {
    assert.equal(agentSettled(observation({ status })), false, `an unaccepted status (${status}) is not settled`);
  }
});

test('a caller names the statuses it accepts, and closed carries the error equivalence', () => {
  assert.deepEqual(settledAgentStatuses(['idle', 'closed']), ['idle', 'closed', 'error']);
  assert.deepEqual(settledAgentStatuses(['idle', 'error']), ['idle', 'error']);
  assert.deepEqual(settledAgentStatuses(['idle']), ['idle']);
  assert.equal(agentSettled(observation({ status: 'closed' }), ['idle']), false, 'a caller that accepts only idle keeps it');
  assert.equal(agentSettled(observation({ status: 'error' }), ['idle', 'closed']), true, 'closed admits the errored thread');
  assert.equal(agentSettled(observation({ status: 'error' }), ['idle', 'error']), true);
});
