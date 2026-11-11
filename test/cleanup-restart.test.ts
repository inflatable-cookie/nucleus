import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host';

test('a new engine recovers all terminal cleanup entries from durable tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-restart-'));
  const store = new Store(join(root, 'queue.sqlite'));
  const adapter = {} as Adapter;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: `Task ${i}`, repoPath: root,
      planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
    store.update(task.id, { phase: 'done', workspaceId: `ws-${i}`, directory: join(root, `work-${i}`), prHead: 'b'.repeat(40),
      resolution: { ...task.resolution, mergedCommit: 'b'.repeat(40), syncedCommit: 'b'.repeat(40) } });
    ids.push(task.id);
  }
  store.setMeta('paused', true);
  const before = new Engine(store, adapter, 0);
  for (const id of ids) before.enqueueCleanup(id);
  await before.drainCleanup();
  await before.stop();
  store.setMeta('paused', false);
  const after = new Engine(store, adapter, 0);
  const started: string[] = [];
  (after as any).lifecycle.archive = async (task: { id: string }) => { started.push(task.id); };
  try {
    await new Lifecycle(after).enqueuePass();
    await after.drainCleanup();
    assert.deepEqual(new Set(started), new Set(ids));
  } finally { await after.stop(); store.close(); }
});
