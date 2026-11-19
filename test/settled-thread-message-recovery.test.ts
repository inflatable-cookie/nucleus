import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { ProvenPreSendRefusalError, type Adapter } from '../core/host';
import { submissionSchema, type Run } from '../shared/contracts';
import { agentMessageSchema } from '../core/questions/agent-messages';

/**
 * A project message the T3 gate refused before send (the thread was still settled after
 * its unsettle) stays queued as a refused, safely retryable delivery. The next sweep
 * delivers it through the ordinary path, and the refusal names the project route.
 */

const repo = '/synthetic/example';
const base = 'a'.repeat(40);
const messageId = (n: number) => n.toString(16).padStart(64, '0');

function fixture() {
  const store = new Store(':memory:');
  const sent: string[] = [];
  /** Refusals still to raise, in order, as the T3 gate raises them before send. */
  const refusals: string[] = [];
  const threads = [{ id: 'own', title: 'own', workspaceId: null, directory: repo, updatedAt: '2098-01-01T00:00:00Z' }];
  const adapter = {
    hostId: 'paseo-synthetic',
    listLiveAgents: async () => threads,
    originAgent: async (id: string) => ({ id, title: id, workspaceId: null, archived: false }),
    observe: async (id: string) => ({ id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '', archived: false }),
    notify: async (id: string) => {
      const reason = refusals.shift();
      if (reason) throw new ProvenPreSendRefusalError(reason);
      sent.push(id);
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => 'paseo-synthetic';
  // A fresh store opens paused; the sweep that delivers queued rows runs unpaused.
  store.setMeta('paused', false);
  store.upsertProject({ key: 'example', name: 'Example', repositories: [{ origin: null, path: repo }] });
  const task = store.insert(submissionSchema.parse({ submissionId: 'fixture', title: 'Fixture', repoPath: repo,
    planningCommit: base, brief: { text: 'Fixture brief' }, originAgentId: 'own' }), 'paseo-synthetic', 'brief', base);
  store.update(task.id, { phase: 'working', runId: 'run', agentId: 'worker', workspaceId: 'ws' });
  store.putRun({ id: 'run', taskId: task.id, role: 'revision', generation: 1, head: base, agentId: 'worker', hostId: 'paseo-synthetic', workspaceId: 'ws', status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false } as unknown as Run);
  store.update(task.id, { resolution: { ...store.task(task.id).resolution, currentRunId: 'run' } });
  store.setCredential('run', 'token');
  const tell = (n: number) => engine.resolution.agentMessage(agentMessageSchema.parse({ eventId: messageId(n), taskId: task.id, runId: 'run', to: { project: 'example' }, text: `message ${n}` }), 'token');
  return { store, engine, sent, refusals, tell, row: (n: number) => store.message(messageId(n)) };
}

test('a project message refused before send stays queued as a refused, retryable row, and the next sweep delivers it', async () => {
  const f = fixture();
  try {
    f.refusals.push('T3Code still shows the thread settled after its unsettle; nothing was sent and the message waits for the next pass');
    const receipt = await f.tell(1);
    assert.equal(receipt.status, 'queued');
    assert.match('detail' in receipt ? receipt.detail : '', /Project message refused before send: T3Code still shows the thread settled/);
    assert.equal(f.row(1)?.status, 'queued');
    assert.equal(f.row(1)?.deliveryIntentState, 'refused');
    assert.deepEqual(f.sent, []);

    await f.engine.resolution.deliverQueuedMessages();
    assert.equal(f.row(1)?.status, 'delivered');
    assert.deepEqual(f.sent, ['own']);
  } finally { f.store.close(); }
});
