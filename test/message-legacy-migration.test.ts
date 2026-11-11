import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { agentMessageRecordSchema, submissionSchema } from '../shared/contracts';

test('legacy live-recipient message stays uncertain after restart without changing its identity or history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-message-host-')), path = join(dir, 'queue.sqlite');
  let store = new Store(path);
  const task = store.insert(submissionSchema.parse({ submissionId: 'target', title: 'Target', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'b', 'h', 'a'.repeat(40));
  const message = agentMessageRecordSchema.parse({ id: 'message', contentKey: 'content', fromTaskId: 'sender', fromRole: 'worker', toTaskId: task.id, toRole: 'worker', textDigest: 'digest', text: 'hello', status: 'queued', createdAt: new Date().toISOString() });
  store.putMessage(message); store.event('sender', 'agent_message_sent', 'message: to target (worker); delivered');
  const events = store.eventsAll('sender'); store.close();
  store = new Store(path);
  const migrated = store.message('message')!;
  assert.equal(migrated.status, 'uncertain'); assert.equal(migrated.deliveryHostId, 'b');
  assert.equal(store.queuedMessages().length, 0); assert.deepEqual(store.eventsAll('sender'), events);
  store.close(); store = new Store(path);
  assert.deepEqual(store.message('message'), migrated); store.close();
});
