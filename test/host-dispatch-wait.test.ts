import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('an offline or unknown task host waits without starting a workspace effect', async () => {
  const store = new Store(':memory:');
  let creates = 0;
  const engine = new Engine(store, { createWorkspace: async () => { creates++; throw Error('must not run'); } } as unknown as Adapter, 0);
  engine.hostAvailable = id => id === 'online';
  try {
    const make = (id: string, host: string) => store.insert(submissionSchema.parse({ submissionId: id, title: id, repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'handoff', originAgentId: 'origin' }), host, 'handoff', 'a'.repeat(40));
    const offline = make('offline', 'offline');
    const unknown = make('unknown', '');
    await engine.dispatchTask(offline.id, false);
    await engine.dispatchTask(unknown.id, false);
    assert.match(store.task(offline.id).reason, /Waiting for host offline/);
    assert.match(store.task(unknown.id).reason, /proven host/);
    assert.equal(creates, 0);
    assert.equal(store.task(offline.id).workspaceIntent, false);
    assert.equal(store.task(unknown.id).workspaceIntent, false);
  } finally { await engine.stop(); store.close(); }
});
