import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsibleThreadCache, type ResponsibleThreadFact } from '../core/questions/responsible-thread-cache';
import { formatAgentId } from '../shared/agent-identity';

const fact = (nativeId: string, lastInteraction: string, extra: Partial<ResponsibleThreadFact> = {}): ResponsibleThreadFact =>
  ({ nativeId, lastInteraction, belongsToProject: true, taskRole: false, closed: false, registeredHint: false, ...extra });

test('ranks eligible host-qualified candidates by hint and recent interaction', async () => {
  const cache = new ResponsibleThreadCache();
  const result = await cache.resolve('project', [
    { id: 't3code:one', inventory: async () => [fact('mcp:opaque', '2026-01-02'), fact('worker', '2026-01-04', { taskRole: true })] },
    { id: 'paseo:two', inventory: async () => [fact('hint', '2026-01-01', { registeredHint: true }), fact('closed', '2026-01-05', { closed: true }), fact('other', '2026-01-06', { belongsToProject: false })] },
  ]);
  assert.deepEqual(result.threads.map(thread => thread.agentId), [formatAgentId('paseo:two', 'hint'), formatAgentId('t3code:one', 'mcp:opaque')]);
});

test('caches briefly, invalidates, and prevents an old inventory restoring the cache', async () => {
  let now = 0, calls = 0;
  let finish!: (facts: ResponsibleThreadFact[]) => void;
  const cache = new ResponsibleThreadCache(100, 1000, () => now);
  const host = { id: 't3code:one', inventory: () => { calls++; return calls === 1 ? new Promise<ResponsibleThreadFact[]>(resolve => { finish = resolve; }) : Promise.resolve([fact('new', '2026-01-02')]); } };
  const old = cache.resolve('project', [host]);
  cache.invalidate('project');
  const fresh = await cache.resolve('project', [host]);
  finish([fact('old', '2026-01-01')]);
  await assert.rejects(old, /inventory was invalidated/);
  assert.deepEqual(await cache.resolve('project', [host]), fresh);
  assert.equal(calls, 2);
  now = 101;
  await cache.resolve('project', [host]);
  assert.equal(calls, 3);
});

test('an offline or slow host does not block another host', async () => {
  const cache = new ResponsibleThreadCache(100, 20);
  const result = await cache.resolve('project', [
    { id: 't3code:slow', inventory: () => new Promise(() => {}) },
    { id: 'bb:offline', inventory: async () => { throw new Error('offline'); } },
    { id: 'paseo:live', inventory: async () => [fact('live', '2026-01-01')] },
  ]);
  assert.deepEqual(result.threads.map(thread => thread.agentId), [formatAgentId('paseo:live', 'live')]);
});
