import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('the question recovery sweep resumes an unsent question when its recorded host reconnects', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const a = { notify: async () => { calls.push('a'); } } as unknown as Adapter;
  const b = { notify: async () => { calls.push('b'); } } as unknown as Adapter;
  const engine = new Engine(store, a, 0);
  let online = false;
  engine.resolveHostAdapter = id => id === 'b' ? b : a;
  engine.hostAvailable = id => id !== 'b' || online;
  try {
    store.setMeta('paused', false);
    const task = store.insert(submissionSchema.parse({ submissionId: 'queue-reconnect', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'b', 'h', 'a'.repeat(40));
    store.update(task.id, { phase: 'working', agentId: 'worker' });
    const question = { id: 'question', kind: 'review' as const, question: 'Continue?', options: ['yes', 'no'] };
    store.event(task.id, 'queue_ask_payload', JSON.stringify(question));
    engine.resolution.queueAskRaises.set(question.id, { resolve() {}, reject() {} });
    await engine.resolution.resumeAskQuestions();
    assert.deepEqual(calls, []);
    online = true;
    assert.equal(store.maintenanceTasks(true).some(item => item.id === task.id), true);
    assert.equal(engine.taskHostAvailable(store.task(task.id)), true);
    assert.equal(engine.resolution.paused(), false);
    assert.equal(engine.resolution.queueAskRaises.has(question.id), true);
    await engine.resolution.resumeAskQuestions();
    await engine.resolution.resumeAskQuestions();
    assert.equal(store.eventsAll(task.id).filter(event => event.kind === 'queue_ask_delivery').length, 1, JSON.stringify(store.eventsAll(task.id)));
    assert.deepEqual(calls, ['b']);
  } finally { engine.resolution.queueAskRaises.clear(); await engine.stop(); store.close(); }
});
