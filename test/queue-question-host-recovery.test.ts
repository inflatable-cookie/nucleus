import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('a queue question waits for its host and never repeats an uncertain send', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const a = { notify: async () => { calls.push('a'); } } as unknown as Adapter;
  const b = { notify: async () => { calls.push('b'); throw Error('unknown delivery'); } } as unknown as Adapter;
  const engine = new Engine(store, a, 0);
  let online = false;
  engine.resolveHostAdapter = id => id === 'b' ? b : a;
  engine.hostAvailable = id => id !== 'b' || online;
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'queue-question', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'b', 'h', 'a'.repeat(40));
    const working = store.update(task.id, { phase: 'working', agentId: 'worker' });
    const question = { id: 'question', kind: 'review' as const, question: 'Continue?', options: ['yes', 'no'] };
    await engine.resolution.deliverQueueAsk(working, question);
    assert.equal(store.eventsAll(task.id).filter(event => event.kind === 'queue_ask_delivery').length, 0);
    online = true;
    await engine.resolution.deliverQueueAsk(working, question);
    await engine.resolution.deliverQueueAsk(working, question);
    assert.deepEqual(calls, ['b']);
    assert.equal(store.eventsAll(task.id).filter(event => event.kind === 'queue_ask_delivery').length, 1);
  } finally { await engine.stop(); store.close(); }
});
