import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { agentMessageRecordSchema, submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('unknown message delivery survives restart and cannot be resent by a stale writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'message-unknown-restart-')), path = join(dir, 'queue.sqlite');
  let store = new Store(path); let calls = 0;
  const adapter = { notify: async () => { calls++; throw Error('outcome unknown'); } } as unknown as Adapter;
  let engine = new Engine(store, adapter, 0);
  const task = store.insert(submissionSchema.parse({ submissionId: 'target', title: 'Target', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'b', 'h', 'a'.repeat(40));
  const working = store.update(task.id, { phase: 'working', agentId: 'worker', runId: 'worker-run' });
  const message = agentMessageRecordSchema.parse({ id: 'message', contentKey: 'content', fromTaskId: 'sender', fromRole: 'worker', toTaskId: task.id, toRole: 'worker', textDigest: 'digest', text: 'hello', status: 'queued', createdAt: new Date().toISOString() });
  store.putMessage(message);
  const first = await engine.resolution.agentMessages.deliverAgentMessage(working, message);
  assert.equal(first.status, 'uncertain'); await engine.stop(); store.close();
  store = new Store(path); engine = new Engine(store, adapter, 0);
  try {
    assert.equal(store.message('message')?.status, 'uncertain'); assert.equal(store.queuedMessages().length, 0);
    assert.throws(() => store.db.prepare("UPDATE task_messages SET data=json_set(json_remove(data,'$.deliveryIntentAt','$.deliveryHostId','$.deliveryIntentState'),'$.status','queued') WHERE id=?").run('message'), /intent cannot be removed/);
    const retry = await engine.resolution.agentMessages.deliverAgentMessage(store.task(task.id), store.message('message')!);
    assert.equal(retry.status, 'uncertain'); assert.equal(calls, 1);
  } finally { await engine.stop(); store.close(); }
});
