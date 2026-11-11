import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { callerNativeId, formatAgentId, nativeAgentId, parseAgentId, qualifyLegacyAgentId, sameCallerIdentity } from '../shared/agent-identity';

test('qualified identities preserve opaque host and native values without collisions', () => {
  const a = formatAgentId('host:a', 'agent"\\');
  const b = formatAgentId('host:b', 'agent"\\');
  assert.notEqual(a, b);
  assert.deepEqual(parseAgentId(a), { hostId: 'host:a', nativeAgentId: 'agent"\\' });
  assert.equal(nativeAgentId(a, 'host:a'), 'agent"\\');
  assert.throws(() => nativeAgentId(a, 'host:b'), /different host/);
  assert.equal(qualifyLegacyAgentId('legacy', 'host:a'), formatAgentId('host:a', 'legacy'));
  assert.deepEqual(parseAgentId(qualifyLegacyAgentId(a, 'host:b')), { hostId: 'host:b', nativeAgentId: a });
  assert.equal(parseAgentId('legacy'), null);
  assert.throws(() => nativeAgentId('legacy', 'host:a'), /Expected/);
});

test('reserved malformed identities cannot be interpreted as legacy', () => {
  for (const id of ['nucleus-agent:v1:', 'nucleus-agent:v1:[]', 'nucleus-agent:v1:["a", "b"]'])
    assert.throws(() => parseAgentId(id), /Malformed/);
  assert.throws(() => formatAgentId('', 'agent'), /required/);
});


test('caller identities match legacy Paseo IDs without joining hosts', () => {
  const paseo = formatAgentId('paseo-server', 'planner');
  const t3 = formatAgentId('t3code:server', 'planner');
  assert.equal(sameCallerIdentity('planner', paseo), true);
  assert.equal(sameCallerIdentity(paseo, 'planner'), true);
  assert.equal(sameCallerIdentity('planner', t3), false);
  assert.equal(sameCallerIdentity('planner', t3, 't3code:server'), true);
  assert.equal(sameCallerIdentity(paseo, t3), false);
  assert.equal(sameCallerIdentity(paseo, formatAgentId('other-server', 'planner')), false);
  assert.equal(callerNativeId(t3, 't3code:server'), 'planner');
  assert.throws(() => callerNativeId(t3, 'paseo-server'), /belongs to host t3code:server, not paseo-server/);
  assert.throws(() => callerNativeId(t3, null), /belongs to host t3code:server, not an unknown host/);
});
