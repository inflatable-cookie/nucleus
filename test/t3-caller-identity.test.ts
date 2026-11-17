import test from 'node:test';
import assert from 'node:assert/strict';
import { Decisions } from '../core/planning/decisions';
import { Store } from '../core/store/store';
import { QueueRuntime } from '../service/runtime-owner';
import { formatAgentId } from '../shared/agent-identity';

function runtimeFixture(observe: (id: string) => Promise<{ id: string; status: string }>) {
  const observed: string[] = [];
  const adapter = { observe: async (id: string) => { observed.push(id); return observe(id); } };
  const hostId = 't3code:32be2844-7204-4edc-a95a-35b05e42ded4';
  const runtime = {
    engine: { withHost: (_hostId: string, fn: () => unknown) => fn(), adapter, host: adapter },
    hostRegistry: {
      onlineIds: () => [hostId],
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
      { hostKind: 't3code', nativeAgentId: 'mcp:b619ccc9-a078-49f6-b80f-6bececcfa6ca', hostScope: 'e3587e2bcde8d42fdde2f3615032716c' });
    assert.deepEqual(fixture.observed, ['mcp:b619ccc9-a078-49f6-b80f-6bececcfa6ca']);
    assert.equal(identity.caller, formatAgentId('t3code:32be2844-7204-4edc-a95a-35b05e42ded4', 'mcp:b619ccc9-a078-49f6-b80f-6bececcfa6ca'));

    const decision = new Decisions(store).add({ question: 'Which planning lane?', askedBy: identity.caller,
      project: { origin: 'synthetic/t3-caller', path: repoPath } });
    assert.equal(store.decision(decision.id).askedBy.agentId, formatAgentId('t3code:32be2844-7204-4edc-a95a-35b05e42ded4', 'mcp:b619ccc9-a078-49f6-b80f-6bececcfa6ca'));
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
      /T3Code thread claimed-thread is not owned by any online host; online T3 hosts: t3code:32be2844-7204-4edc-a95a-35b05e42ded4/, label);
      assert.deepEqual(store.listDecisions(), [], `${label}: no decision was recorded`);
    }
  } finally { store.close(); }
});

test('caller.resolve verifies the thread when the desktop scope differs from the online environment id', async () => {
  const fixture = runtimeFixture(async id => ({ id, status: 'idle' }));
  const identity = await QueueRuntime.prototype.resolveHostCaller.call(fixture.runtime,
    { hostKind: 't3code', nativeAgentId: 'mcp:known-thread', hostScope: 'e3587e2bcde8d42fdde2f3615032716c' });
  assert.equal(identity.hostId, 't3code:32be2844-7204-4edc-a95a-35b05e42ded4');
  assert.deepEqual(fixture.observed, ['mcp:known-thread']);
});

test('reparent resolves a bare T3 thread by the same exact thread observation', async () => {
  const threadId = 'mcp:b619ccc9-a078-49f6-b80f-6bececcfa6ca';
  const fixture = runtimeFixture(async id => ({ id, status: 'idle' }));
  let sent: unknown;
  const runtime = {
    started: Promise.resolve(), anyHostConnected: () => true,
    hostRegistry: fixture.runtime.hostRegistry,
    engine: { ...fixture.runtime.engine, reparent: async (input: unknown) => { sent = input; return { ok: true }; } },
  };
  await QueueRuntime.prototype.reparent.call(runtime, { toAgentId: threadId, caller: 'operator (board)', reason: 'Move owner', taskIds: ['task'] } as never);
  assert.deepEqual(fixture.observed, [threadId]);
  assert.equal((sent as { toAgentId: string }).toAgentId,
    formatAgentId('t3code:32be2844-7204-4edc-a95a-35b05e42ded4', threadId));
});
