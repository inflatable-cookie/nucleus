import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('uncertain workspace recovery observes only its recorded host and never creates blindly', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const adapter = (host: string) => ({ findWorkspaces: async () => { calls.push(`find-${host}`); return []; }, createWorkspace: async () => { calls.push(`create-${host}`); throw Error('unexpected create'); } }) as unknown as Adapter;
  const a = adapter('a'), b = adapter('b'), engine = new Engine(store, a, 0);
  engine.resolveHostAdapter = id => id === 'a' ? a : id === 'b' ? b : undefined;
  engine.hostAvailable = id => id === 'a' || id === 'b';
  store.setMeta('paused', false);
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'recovery-host', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'b', 'h', 'a'.repeat(40));
    store.update(task.id, { phase: 'needs_attention', workspaceIntent: true });
    await engine.scheduleTaskQuantum(task.id);
    assert.ok(calls.includes('find-b'));
    assert.ok(!calls.includes('find-a'));
    assert.ok(!calls.some(call => call.startsWith('create-')));
    assert.equal(store.task(task.id).workspaceIntent, true);
  } finally { await engine.stop(); store.close(); }
});
