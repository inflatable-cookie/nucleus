import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { agentMessageRecordSchema, submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('an unknown message send stays bound to its host across old-writer updates and retries', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const a = { notify: async () => { calls.push('a'); } } as unknown as Adapter;
  const b = { notify: async () => { calls.push('b'); throw Error('delivery outcome unknown'); } } as unknown as Adapter;
  const engine = new Engine(store, a, 0);
  engine.resolveHostAdapter = id => id === 'a' ? a : id === 'b' ? b : undefined;
  engine.hostAvailable = () => true;
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'recipient', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'b', 'h', 'a'.repeat(40));
    const working = store.update(task.id, { phase: 'working', agentId: 'worker', runId: 'worker-run' });
    const message = agentMessageRecordSchema.parse({ id: 'message', contentKey: 'content', fromTaskId: 'sender', fromRole: 'worker', toTaskId: task.id, toRole: 'worker', textDigest: 'digest', text: 'hello', status: 'queued', createdAt: new Date().toISOString() });
    store.putMessage(message);
    const receipt = await engine.resolution.agentMessages.deliverAgentMessage(working, message);
    assert.equal(receipt.status, 'uncertain');
    if (receipt.status !== 'uncertain') throw Error('expected uncertain delivery');
    assert.match(receipt.detail ?? '', /outcome is unknown/);
    const saved = store.message(message.id)!;
    assert.equal(saved.deliveryHostId, 'b');
    assert.throws(() => store.db.prepare("UPDATE task_messages SET data=json_remove(data,'$.deliveryIntentAt') WHERE id=?").run(message.id), /intent cannot be removed/);
    await engine.resolution.agentMessages.deliverAgentMessage(working, saved);
    assert.deepEqual(calls, ['b']);
  } finally { await engine.stop(); store.close(); }
});
