import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeAgents } from '../client/agent-observer';
import type { BoardHost } from '../client/shell/types';

test('both pills share one inventory, follow updates and reconnect snapshots, and release it once', async () => {
  let lists = 0, releases = 0;
  let handlers: any;
  const client = { agents: { list: async () => {
    lists++;
    return { entries: [{ agent: { id: 'a', pendingPermissions: [] } }], pageInfo: { hasMore: false },
      subscription: { subscribe: (value: any) => { handlers = value; }, release: () => { releases++; } } };
  } } } as unknown as BoardHost;
  const a: any[] = [], b: any[] = [];
  const stopA = observeAgents(client, event => a.push(event), 5);
  const stopB = observeAgents(client, event => b.push(event), 5);
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(lists, 1);
    assert.deepEqual(a, b);
    handlers.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { id: 'a', pendingPermissions: ['question'] } } });
    assert.deepEqual(a.at(-1).agent.pendingPermissions, ['question']);
    handlers.snapshot({ entries: [] });
    assert.deepEqual(a.at(-1), { kind: 'remove', agentId: 'a' });
    assert.deepEqual(a, b);
    stopA();
    assert.equal(releases, 0);
  } finally { stopB(); }
  assert.equal(releases, 1);
});
