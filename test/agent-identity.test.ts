import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatAgentId, nativeAgentId, parseAgentId, qualifyLegacyAgentId } from '../shared/agent-identity';

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
