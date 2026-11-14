import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/responsible-lifecycle-fixture';

/**
 * The retired errored agent archive (task 646) keeps Paseo workspaces out of
 * Failed once nothing runs behind a displaced errored agent. The sweep belongs to
 * the thread-archive owner, and its two read/archive failures are recorded on the
 * archive wait lane instead of being dropped: a workspace that stays Failed is
 * visible to the operator, not silent.
 */
test('the retired errored agent sweep archives a stopped agent and records each failure', async () => {
  const f = fixture();
  try {
    const retired = (agentId: string) => ({ agentId, runId: `run-${agentId}`, profile: f.author, reason: 'provider failure' });
    f.states.set('retired-1', { id: 'retired-1', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: 'boom' });
    f.states.set('retired-2', { id: 'retired-2', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: 'boom' });
    f.states.set('retired-3', { id: 'retired-3', workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: 'boom' });
    f.store.update(f.submitted.id, { retiredWorkers: [retired('retired-1'), retired('retired-2'), retired('retired-3')] });
    const adapter = f.engine.adapter as unknown as {
      observe: (id: string) => Promise<unknown>;
      archiveAgent: (id: string) => Promise<void>;
    };
    const observe = adapter.observe, archive = adapter.archiveAgent;
    adapter.observe = async (id: string) => {
      if (id === 'retired-2') throw Error('the thread projection is unreadable');
      return observe(id);
    };
    adapter.archiveAgent = async (id: string) => {
      if (id === 'retired-3') throw Error('archive refused by the host');
      return archive(id);
    };
    await f.engine.archiveRetiredErroredAgents();
    assert.deepEqual(f.events('retired_errored_agent_archived').map(event => event.detail.match(/retired-\d/g)![0]), ['retired-1'],
      'the readable, archivable retired agent is archived');
    const waits = f.events('thread_archive_wait').map(event => event.detail);
    assert.ok(waits.some(detail => /retired-2.*could not be observed.*unreadable/.test(detail)),
      'an unreadable retired agent records its wait instead of being dropped');
    assert.ok(waits.some(detail => /retired-3.*archiving the retired errored agent failed.*archive refused/i.test(detail)),
      'a refused archive records its wait instead of being dropped');
  } finally { await f.close(); }
});
