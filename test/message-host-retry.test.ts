import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { ProvenPreSendRefusalError } from '../core/recovery/task-reasons';
import { agentMessageRecordSchema, submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('only a proved pre-send refusal permits a host-bound message retry', async () => {
  const store = new Store(':memory:'); let calls = 0;
  const adapter = { notify: async () => { calls++; if (calls === 1) throw new ProvenPreSendRefusalError('not sent'); } } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'target', title: 'Target', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'b', 'h', 'a'.repeat(40));
    const working = store.update(task.id, { phase: 'working', agentId: 'worker', runId: 'worker-run' });
    const message = agentMessageRecordSchema.parse({ id: 'message', contentKey: 'content', fromTaskId: 'sender', fromRole: 'worker', toTaskId: task.id, toRole: 'worker', textDigest: 'digest', text: 'hello', status: 'queued', createdAt: new Date().toISOString() });
    store.putMessage(message);
    const first = await engine.resolution.agentMessages.deliverAgentMessage(working, message);
    assert.equal(first.status, 'queued'); assert.equal(store.message('message')?.deliveryIntentState, 'refused');
    const second = await engine.resolution.agentMessages.deliverAgentMessage(working, store.message('message')!);
    assert.equal(second.status, 'delivered'); assert.equal(calls, 2); assert.equal(store.message('message')?.deliveryHostId, 'b');
  } finally { await engine.stop(); store.close(); }
});
