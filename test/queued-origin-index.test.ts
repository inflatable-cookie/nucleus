import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host';

test('queued origin routing observes each owner once and touches tasks only when its fact changes', async () => {
  const store = new Store(':memory:');
  const agents = new Map([['origin', { id: 'origin', workspaceId: 'planning', title: 'Planner', archived: false }],
    ['replacement', { id: 'replacement', workspaceId: 'planning', title: 'Replacement', archived: false }]]);
  let calls = 0;
  const adapter = { originAgent: async (id: string) => { calls++; return agents.get(id) ?? null; } } as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => 'host';
  try {
    store.setMeta('paused', false);
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) ids.push(store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Queued', repoPath: '/fixture',
      planningCommit: 'a'.repeat(40), handoffPath: 'fixture.md', originAgentId: 'origin' }), 'host', 'brief', 'a'.repeat(40), { originWorkspaceId: 'planning' }).id);
    let writes = 0;
    const update = store.update.bind(store);
    store.update = (...args: Parameters<Store['update']>) => { writes++; return update(...args); };
    await engine.resolution.origins.pass();
    assert.equal(calls, 1); assert.equal(writes, 0);
    calls = 0; await engine.resolution.origins.pass();
    assert.equal(calls, 1); assert.equal(writes, 0);
    agents.delete('origin'); calls = 0;
    await engine.resolution.origins.pass();
    assert.equal(calls, 1); assert.ok(writes >= 1000 && writes <= 2000);
    assert.ok(ids.every(id => store.task(id).originError.startsWith('Origin thread is missing')));
    await engine.resolution.origins.reparent({ toAgentId: 'replacement', caller: 'operator (board)', reason: 'New owner', taskIds: [ids[0]] });
    assert.equal(store.task(ids[0]).notificationAgentId, 'replacement');
    assert.ok(store.queuedOriginGroups().some(group => group.owner === 'replacement' && group.ids.has(ids[0])));
  } finally { await engine.stop(); store.close(); }
});
