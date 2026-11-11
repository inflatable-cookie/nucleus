import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import type { Adapter } from '../core/host/adapter';

test('concurrent task contexts resolve the selected adapter at each call', async () => {
  const store = new Store(':memory:');
  const adapter = (name: string) => ({ observe: async (id: string) => { await Promise.resolve(); return { id, workspaceId: name, status: 'idle', active: false, permissions: false, error: '' }; } }) as Adapter;
  const a = adapter('a'), b = adapter('b');
  const engine = new Engine(store, a, 0);
  engine.resolveHostAdapter = id => id === 'a' ? a : id === 'b' ? b : undefined;
  try {
    const [first, second] = await Promise.all([
      engine.withHost('a', () => engine.resolution.host.observe('same')),
      engine.withHost('b', () => engine.resolution.host.observe('same')),
    ]);
    assert.equal(first.workspaceId, 'a');
    assert.equal(second.workspaceId, 'b');
    assert.throws(() => engine.withHost('missing', () => engine.adapter.observe('same')), /unavailable/);
  } finally { await engine.stop(); store.close(); }
});
