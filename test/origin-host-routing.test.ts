import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('origin notices wait for their own host and never route through the worker host', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const adapter = (host: string) => ({ observe: observeIdle('origin-ws'), notify: async () => { calls.push(host); } }) as unknown as Adapter;
  const a = adapter('a'), b = adapter('b');
  const engine = new Engine(store, a, 0);
  let aOnline = false;
  engine.resolveHostAdapter = id => id === 'a' && aOnline ? a : id === 'b' ? b : undefined;
  engine.hostAvailable = id => id === 'a' ? aOnline : id === 'b';
  store.setMeta('paused', false);
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'origin-route', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'b', 'h', 'a'.repeat(40), { originHostId: 'a' });
    store.putNotice({ id: 'completion', taskId: task.id, agentId: 'origin', recipientAgentId: 'origin', workspaceId: 'origin-ws', sources: [], originEntry: true, kind: 'completion', status: 'pending', error: '', text: 'done' });
    await engine.resolution.deliverNotices();
    assert.deepEqual(calls, []);
    assert.match(store.notices(task.id)[0]!.error, /Waiting for host a/);
    aOnline = true;
    await engine.resolution.deliverNotices();
    assert.deepEqual(calls, ['a']);
    assert.equal(store.notices(task.id)[0]!.status, 'delivered');
  } finally { await engine.stop(); store.close(); }
});
