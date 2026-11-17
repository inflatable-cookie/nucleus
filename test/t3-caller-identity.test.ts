import test from 'node:test';
import assert from 'node:assert/strict';
import { Decisions } from '../core/planning/decisions';
import { Store } from '../core/store/store';
import { QueueRuntime } from '../service/runtime-owner';
import { formatAgentId } from '../shared/agent-identity';

function runtimeFixture(observe: (id: string) => Promise<{ id: string; status: string }>) {
  const observed: string[] = [];
  const adapter = { observe: async (id: string) => { observed.push(id); return observe(id); } };
  const runtime = {
    hostRegistry: {
      onlineIds: () => ['t3code:synthetic-environment'],
      get: (id: string) => id === 't3code:synthetic-environment' ? { adapter } : undefined,
    },
    plannerTickets: { forCaller: async () => undefined },
  };
  return { runtime, observed };
}

test('caller.resolve verifies a known T3 thread and its decision is stored under the canonical caller', async () => {
  const store = new Store(':memory:');
  try {
    const repoPath = '/synthetic/t3-caller-project';
    store.upsertProject({ key: 't3-caller-project', name: 'T3 caller project', repositories: [{ origin: 'synthetic/t3-caller', path: repoPath }] });
    const fixture = runtimeFixture(async id => ({ id, status: 'idle' }));
    const identity = await QueueRuntime.prototype.resolveHostCaller.call(fixture.runtime,
      { hostKind: 't3code', nativeAgentId: 'known-thread', hostScope: 'synthetic-environment' });
    assert.deepEqual(fixture.observed, ['known-thread']);
    assert.equal(identity.caller, formatAgentId('t3code:synthetic-environment', 'known-thread'));

    const decision = new Decisions(store).add({ question: 'Which planning lane?', askedBy: identity.caller,
      project: { origin: 'synthetic/t3-caller', path: repoPath } });
    assert.equal(store.decision(decision.id).askedBy.agentId, formatAgentId('t3code:synthetic-environment', 'known-thread'));
  } finally { store.close(); }
});

test('caller.resolve refuses an unknown or unreadable T3 thread without recording a decision', async () => {
  const store = new Store(':memory:');
  try {
    for (const [label, observe] of [
      ['unknown', async () => ({ id: 'different-thread', status: 'idle' })],
      ['unverifiable', async () => { throw new Error('fixture read failed'); }],
      ['deleted', async (id: string) => ({ id, status: 'gone' })],
    ] as const) {
      const fixture = runtimeFixture(observe);
      await assert.rejects(QueueRuntime.prototype.resolveHostCaller.call(fixture.runtime,
        { hostKind: 't3code', nativeAgentId: 'claimed-thread', hostScope: 'synthetic-environment' }),
      /T3Code thread claimed-thread could not be verified on registered host t3code:synthetic-environment/, label);
      assert.deepEqual(store.listDecisions(), [], `${label}: no decision was recorded`);
    }
  } finally { store.close(); }
});

test('caller.resolve refuses a T3 scope without a matching online registered host', async () => {
  const fixture = runtimeFixture(async id => ({ id, status: 'idle' }));
  await assert.rejects(QueueRuntime.prototype.resolveHostCaller.call(fixture.runtime,
    { hostKind: 't3code', nativeAgentId: 'known-thread', hostScope: 'other-environment' }),
  /T3Code host scope other-environment is not registered and online/);
  assert.deepEqual(fixture.observed, []);
});
