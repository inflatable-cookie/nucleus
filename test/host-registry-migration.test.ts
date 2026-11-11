import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, operationInputHash } from '../core/store/store';
import { HostRegistry, type KnownHost } from '../core/host/host-registry';
import { submissionSchema } from '../shared/contracts';

test('mixed store registration preserves historical events and pending operation identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-migration-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    store.setMeta('hostId', 'legacy');
    const task = store.insert(submissionSchema.parse({ submissionId: 'migration', title: 'Migration', repoPath: '/fixture', planningCommit: 'a'.repeat(40), handoffPath: 'docs/handoffs/migration.md', originAgentId: 'origin' }), 'legacy', 'Handoff', 'b'.repeat(40));
    const control = { taskId: task.id, version: task.version, action: 'hold' as const, reason: 'test' };
    const pending = store.acceptOperation({ key: 'pending', kind: 'task_control', inputHash: operationInputHash(control), taskId: task.id, expectedVersion: task.version, payload: { type: 'task_control', control } });
    if (!('accepted' in pending)) throw new Error('fixture operation was not accepted');
    const events = store.events(task.id);
    const open = () => new HostRegistry({ read: () => store.getMeta<KnownHost[]>('hostRegistry') ?? [], write: hosts => store.setMeta('hostRegistry', hosts), transaction: fn => store.transaction(fn) });
    const register = () => open().connect('legacy', 'endpoint', {}, () => assert.equal(store.getMeta('hostId'), 'legacy'));
    register();
    register();
    assert.deepEqual(store.events(task.id), events);
    assert.equal(store.operation(pending.operation.id)?.id, pending.operation.id);
    assert.equal(store.task(task.id).hostId, 'legacy');
    assert.equal(store.getMeta<KnownHost[]>('hostRegistry')?.length, 1);
  } finally { store.close(); }
});
