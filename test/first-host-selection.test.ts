import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseFirstWorkerHost } from '../core/dispatch/first-host-selection';
import { profile } from './support/fakes';
import { poolSchema, submissionSchema, type Task } from '../shared/contracts';
import { DEMAND_ROLE_OFFSETS } from '../shared/demand';

const task = { ...submissionSchema.parse({ submissionId: 's', title: 't', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'o', complexity: 'medium', hostId: 'paseo' }), workerExclusions: [] } as unknown as Task;
const paseo = profile('paseo-only'), t3 = profile('t3-only'), both = profile('both');
const pool = [paseo, t3, both].map(p => poolSchema.parse({ profileId: p.id, enabled: true, group: p.id, weight: 1, scopes: ['general'], capability: 'medium', cost: 'medium' }));
const hosts = [{ hostId: 'paseo', profiles: [paseo, both] }, { hostId: 't3', profiles: [t3, both] }];
function pick(id: string, catalogs = hosts) {
  return chooseFirstWorkerHost({ ...task, preferredProfileId: id, requirePreferred: true }, catalogs, pool, {}, new Set(), {}, 'normal', DEMAND_ROLE_OFFSETS);
}

test('first worker selects across hosts and uses the preference only when the profile can run there', () => {
  assert.equal(pick('t3-only')?.hostId, 't3');
  assert.equal(pick('both')?.hostId, 'paseo');
  assert.equal(pick('paseo-only')?.hostId, 'paseo');
  assert.equal(pick('t3-only', hosts.slice(0, 1)), null);
});

test('the selected thinking option must be supported by the chosen host', () => {
  const catalogs = [{ hostId: 'paseo', profiles: [{ ...both, supportedThinking: ['low'] }] }, { hostId: 't3', profiles: [{ ...both, supportedThinking: ['high'] }] }];
  const selected = chooseFirstWorkerHost({ ...task, preferredProfileId: 'both', requirePreferred: true, thinkingOptionId: 'high' }, catalogs, pool, {}, new Set(), {}, 'normal', DEMAND_ROLE_OFFSETS);
  assert.equal(selected?.hostId, 't3');
});

test('rotation gives each profile one entry across the online hosts', () => {
  const selected = chooseFirstWorkerHost(task, hosts, pool, {}, new Set(),
    { 'profile:paseo-only': 4, 'profile:both': 4, 'profile:t3-only': 0 }, 'normal', DEMAND_ROLE_OFFSETS);
  assert.equal(selected?.profile.id, 't3-only');
  assert.equal(selected?.hostId, 't3');
});

test('repository preference precedes the operator default when both can run the profile', () => {
  const realHosts = [{ hostId: 'paseo:one', profiles: [both] }, { hostId: 't3code:one', profiles: [both] }];
  const selected = chooseFirstWorkerHost(task, realHosts, pool, {}, new Set(), {}, 'normal', DEMAND_ROLE_OFFSETS, ['t3code', 'paseo']);
  assert.equal(selected?.hostId, 't3code:one');
});
