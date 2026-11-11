import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { formatAgentId } from '../shared/agent-identity';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import type { Adapter, AgentObservation } from '../core/host';
import { fakeAdapter } from './support/fakes';
import { socketFixtureDirectory } from './support/socket-fixture';

test('direct host adapter calls unwrap qualified recipient and source IDs only for their host', async () => {
  const directory = socketFixtureDirectory('queue.sqlite');
  const store = new Store(join(directory, 'queue.sqlite'));
  const calls: Array<[string, ...string[]]> = [];
  const adapter = fakeAdapter({
    originAgent: async id => { calls.push(['originAgent', id]); return { id, workspaceId: 'workspace', title: 'planner', archived: false }; },
    observe: async id => { calls.push(['observe', id]); return { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' }; },
    notify: async (id, _messageId, _text, source) => { calls.push(['notify', id, source ?? '']); },
    archiveAgent: async id => { calls.push(['archiveAgent', id]); },
    askPlanner: async (id, input) => { calls.push(['askPlanner', id, input.sourceAgentId ?? '']); return null; },
  }) as Adapter;
  const engine = new Engine(store, adapter);
  try {
    const qualified = formatAgentId('t3code:one', 'native-agent');
    await engine.withHost('t3code:one', async () => {
      await engine.adapter.originAgent!(qualified);
      await engine.adapter.observe(qualified);
      await engine.adapter.notify!(qualified, 'message', 'text', qualified);
      await engine.adapter.askPlanner!(qualified, { prompt: 'Question', signal: new AbortController().signal,
        timeoutMs: 100, messageId: 'ask', sourceAgentId: qualified });
      await engine.adapter.archiveAgent(qualified);
    });
    assert.deepEqual(calls, [
      ['originAgent', 'native-agent'], ['observe', 'native-agent'],
      ['notify', 'native-agent', 'native-agent'], ['askPlanner', 'native-agent', 'native-agent'], ['archiveAgent', 'native-agent'],
    ]);
    // The registry decides which hosts exist: an unknown host refuses, named,
    // and a registered one serves the identities qualified for it — the call
    // re-enters the proxy under that host's context and unwraps there.
    engine.resolveHostAdapter = id => (id === 't3code:one' ? adapter : undefined);
    await assert.rejects(async () => engine.withHost('t3code:one', () => engine.adapter.observe(formatAgentId('t3code:other', 'native-agent'))), /belongs to host t3code:other.*unknown or offline/);
    assert.equal(calls.length, 5, 'an unknown identity host is refused before reaching the adapter');

    const routed: string[] = [];
    const routedAdapter = fakeAdapter({
      observe: async id => { routed.push(id); return { id, workspaceId: 'routed-ws', status: 'idle', active: false, permissions: false, error: '' } as AgentObservation; },
    }) as Adapter;
    engine.resolveHostAdapter = id => (id === 't3code:one' ? adapter : id === 't3code:two' ? routedAdapter : undefined);
    await engine.withHost('t3code:one', async () => {
      const observed = await engine.adapter.observe(formatAgentId('t3code:two', 'native-agent'));
      assert.equal(observed.workspaceId, 'routed-ws');
    });
    assert.deepEqual(routed, ['native-agent']);
    assert.equal(calls.length, 5, 'the bound adapter served nothing for the routed identity');

    // A routed send drops a source from yet another host rather than failing the send.
    const routedMessages: Array<{ id: string; source?: string }> = [];
    (routedAdapter as unknown as { notify: unknown }).notify = async (id: string, _messageId: string, _text: string, source?: string) => { routedMessages.push({ id, source }); };
    await engine.withHost('t3code:one', () => engine.adapter.notify!(formatAgentId('t3code:two', 'native-agent'), 'message', 'text', formatAgentId('t3code:one', 'planner')));
    assert.deepEqual(routedMessages, [{ id: 'native-agent', source: undefined }]);
  } finally {
    await engine.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
