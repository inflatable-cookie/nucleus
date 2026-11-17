import test from 'node:test';
import assert from 'node:assert/strict';
import { Decisions } from '../core/planning/decisions';
import { Store } from '../core/store/store';
import { QueueRuntime } from '../service/runtime-owner';
import { formatAgentId } from '../shared/agent-identity';
import { hostCallerIdentity } from '../bin/queue-client.mjs';

const hostId = `bb:${'b'.repeat(64)}`;

function runtimeFixture(observe: (id: string) => Promise<{ id: string; status: string }>) {
  const observed: string[] = [];
  const adapter = { observe: async (id: string) => { observed.push(id); return observe(id); } };
  const runtime = {
    engine: { withHost: (_hostId: string, fn: () => unknown) => fn(), adapter, host: adapter },
    hostRegistry: { onlineIds: () => [hostId] },
    plannerTickets: { forCaller: async () => '/synthetic/participant-ticket.json' },
  };
  return { runtime, observed };
}

test('BB thread environment resolves to a verified caller and decision.add records its host-qualified identity', async () => {
  const env = { BB_THREAD_ID: 'thr_9ri7tsq68p', BB_ENVIRONMENT_ID: 'env_personal', BB_PROJECT_ID: 'proj_personal' } as NodeJS.ProcessEnv;
  const source = hostCallerIdentity(env);
  assert.deepEqual(source, { hostKind: 'bb', nativeAgentId: 'thr_9ri7tsq68p' });

  const fixture = runtimeFixture(async id => ({ id, status: 'idle' }));
  const identity = await QueueRuntime.prototype.resolveHostCaller.call(fixture.runtime, source!);
  assert.deepEqual(fixture.observed, ['thr_9ri7tsq68p']);
  assert.equal(identity.caller, formatAgentId(hostId, 'thr_9ri7tsq68p'));
  assert.equal(identity.participantTicket, '/synthetic/participant-ticket.json', 'BB planner identity receives its participant ticket on its own call');

  const store = new Store(':memory:');
  try {
    store.upsertProject({ key: 'bb-caller-project', name: 'BB caller project', repositories: [{ origin: 'synthetic/bb-caller', path: '/synthetic/bb-caller' }] });
    const decision = new Decisions(store).add({ question: 'Which plan?', askedBy: identity.caller,
      project: { origin: 'synthetic/bb-caller', path: '/synthetic/bb-caller' } });
    assert.equal(store.decision(decision.id).askedBy.agentId, formatAgentId(hostId, 'thr_9ri7tsq68p'));
  } finally { store.close(); }
});

test('BB caller resolution refuses an unknown or unverifiable thread', async () => {
  for (const observe of [
    async () => ({ id: 'thr_other', status: 'idle' }),
    async (id: string) => ({ id, status: 'gone' }),
    async () => { throw new Error('fixture read failed'); },
  ]) {
    const fixture = runtimeFixture(observe);
    await assert.rejects(QueueRuntime.prototype.resolveHostCaller.call(fixture.runtime,
      { hostKind: 'bb', nativeAgentId: 'thr_unknown' }),
    /BB thread thr_unknown is not owned by any online host/);
    assert.deepEqual(fixture.observed, ['thr_unknown']);
  }
});

test('partial BB context refuses instead of falling through to Paseo', () => {
  assert.throws(() => hostCallerIdentity({ BB_PROJECT_ID: 'proj_personal', PASEO_AGENT_ID: 'paseo-thread' }),
    /BB caller identity is incomplete/);
});
