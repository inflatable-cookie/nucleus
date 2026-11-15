import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { submissionSchema } from '../shared/contracts';
import { DelegatedHostUnavailable } from '../core/questions/delegation';
import type { Adapter } from '../core/host/adapter';

test('planner delivery waits for the origin host and records intent only before its selected send', async () => {
  const store = new Store(':memory:');
  const sent: string[] = [];
  const make = (host: string) => ({ askPlanner: async () => { sent.push(host); return null; } }) as unknown as Adapter;
  const a = make('a'), b = make('b'), engine = new Engine(store, b, 0);
  let online = false;
  engine.resolveHostAdapter = id => id === 'a' && online ? a : id === 'b' ? b : undefined;
  engine.hostAvailable = id => id === 'a' ? online : id === 'b';
  engine.resolution.delegatedAnswerWaitMs = 1;
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'delegated-host', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'planner' }), 'b', 'h', 'a'.repeat(40), { originHostId: 'a' });
    const request = { prompt: 'question', signal: new AbortController().signal, timeoutMs: 10, messageId: 'host-test' };
    await assert.rejects(engine.resolution.askBound(task, 'planner', request, 'planner'), DelegatedHostUnavailable);
    assert.equal(store.eventsAll('delegation:host-test').length, 0);
    online = true;
    await engine.resolution.askBound(task, 'planner', request, 'planner');
    assert.deepEqual(sent, ['a']);
    assert.equal(JSON.parse(store.eventsAll('delegation:host-test')[0]!.detail).hostId, 'a');
  } finally { await engine.stop(); store.close(); }
});

test('planner delivery uses the recorded owner host after handover when native IDs collide', async () => {
  const store = new Store(':memory:');
  const sent: string[] = [];
  const make = (host: string) => ({ askPlanner: async () => { sent.push(host); return null; } }) as unknown as Adapter;
  const a = make('a'), b = make('b'), engine = new Engine(store, a, 0);
  engine.resolveHostAdapter = id => id === 'a' ? a : id === 'b' ? b : undefined;
  engine.hostAvailable = id => id === 'a' || id === 'b';
  const inventories = new Map([['a', ['new-owner']], ['b', ['new-owner']]]);
  let lookups = 0;
  engine.identifyOriginHost = async id => {
    lookups++;
    const matches = [...inventories].filter(([, ids]) => ids.includes(id));
    return matches.length === 1 ? matches[0]![0] : undefined;
  };
  engine.resolution.delegatedAnswerWaitMs = 1;
  try {
    const original = store.insert(submissionSchema.parse({ submissionId: 'delegated-owner', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'old-owner' }), 'a', 'h', 'a'.repeat(40), { originHostId: 'a' });
    const task = store.update(original.id, { notificationAgentId: 'new-owner', originHostId: 'b', originWorkspaceId: 'new-workspace' }, 'owner_changed', 'handover');
    await engine.resolution.askBound(task, 'new-owner', { prompt: 'question', signal: new AbortController().signal, timeoutMs: 10, messageId: 'owner-test' }, 'planner');
    assert.equal(lookups, 0);
    assert.deepEqual(sent, ['b']);
    assert.equal(JSON.parse(store.eventsAll('delegation:owner-test')[0]!.detail).hostId, 'b');
  } finally { await engine.stop(); store.close(); }
});

/**
 * nucleus#1242: a decider is archived on the decider task's own host, and a failed
 * archive is recorded on the delegation stream so the host keeps a visible orphan
 * instead of the ledger losing it. The delivery failure still reaches the caller.
 */
test('a decider whose archive fails is recorded on the delegation stream', async () => {
  const store = new Store(':memory:');
  const archived: string[] = [];
  const adapter = {
    runDecider: async () => ({ agentId: 'decider-1' }),
    askPlanner: async () => { throw Error('delivery unknown'); },
    archiveAgent: async (id: string) => { archived.push(id); throw Error('archive refused'); },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.resolveHostAdapter = () => adapter;
  engine.hostAvailable = () => true;
  engine.resolution.delegatedAnswerWaitMs = 1;
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'decider-archive', title: 'Task', repoPath: '/repo',
      planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'planner' }), 'b', 'h', 'a'.repeat(40), { originHostId: 'b' });
    await assert.rejects(
      engine.resolution.deciderBound(task, { prompt: 'question', profile: { id: 'p' } as never,
        signal: new AbortController().signal, timeoutMs: 10, decisionId: 'd-1' }),
      /delivery unknown/,
      'the delivery failure still reaches the caller',
    );
    assert.deepEqual(archived, ['decider-1'], 'the decider is archived on its own host');
    const failed = store.eventsAll('delegation:ns-decider-d-1').find(event => event.kind === 'delegated_decider_archive_failed');
    assert.ok(failed, 'the failed archive is recorded');
    assert.match(failed.detail, /decider-1: archive refused/);
  } finally { await engine.stop(); store.close(); }
});
