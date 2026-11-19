import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { OperatorSettledRefusalError, ProvenPreSendRefusalError, type Adapter } from '../core/host';
import { formatAgentId } from '../shared/agent-identity';
import { submissionSchema, type Run } from '../shared/contracts';
import { agentMessageSchema } from '../core/questions/agent-messages';

/**
 * Tom, 2026-11-19: a T3 thread the operator settled by hand is put away, like an
 * archived one. A project message never queues on it: the next live candidate takes
 * the message, or the sender is told to handle it. The host double reports the settle
 * the way the T3 projection does (`settledOverride`) and refuses a send the way the
 * T3 adapter does; the resolver and delivery path are the real ones.
 */

const repo = '/synthetic/example';
const base = 'a'.repeat(40);
const SETTLED_TEXT = 'T3Code thread is manually settled; unsettle it in T3 before continuing';
const messageId = (n: number) => n.toString(16).padStart(64, '0');

function fixture() {
  const store = new Store(':memory:');
  const archived = new Set<string>();
  /** Threads the operator settled on the host. */
  const settled = new Set<string>();
  /** Threads whose settle the origin read does not show, so only the send refuses. */
  const hidden = new Set<string>();
  /** When set, a refusal arrives as a plain pre-send refusal, as a stored row from before the typed refusal did. */
  let legacyRefusal = false;
  const sent: string[] = [];
  const threads = [
    { id: 'own', title: 'own', workspaceId: null, directory: repo, updatedAt: '2098-01-01T00:00:00Z' },
    { id: 'other', title: 'other', workspaceId: null, directory: repo, updatedAt: '2099-01-02T00:00:00Z' },
  ];
  const adapter = {
    hostId: 'paseo-synthetic',
    listLiveAgents: async () => threads.filter(thread => !archived.has(thread.id)),
    originAgent: async (id: string) => ({
      id,
      title: id,
      workspaceId: null,
      archived: archived.has(id),
      settled: settled.has(id) && !hidden.has(id),
    }),
    observe: async (id: string) => ({
      id, workspaceId: null, status: archived.has(id) ? 'closed' : 'idle', active: false, permissions: false, error: '', archived: archived.has(id),
    }),
    notify: async (id: string) => {
      if (settled.has(id))
        throw legacyRefusal ? new ProvenPreSendRefusalError(SETTLED_TEXT) : new OperatorSettledRefusalError(SETTLED_TEXT);
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
  return {
    store, engine, archived, settled, hidden, sent, tell,
    setLegacyRefusal: (value: boolean) => { legacyRefusal = value; },
    /** The stored row the message left behind. */
    row: (n: number) => store.message(messageId(n)),
  };
}

test('an operator-settled project thread is not a candidate: the next live thread takes the message', async () => {
  const f = fixture();
  try {
    f.settled.add('own');
    const receipt = await f.tell(1);
    assert.equal(receipt.status, 'delivered');
    assert.deepEqual(f.sent, ['other']);
    assert.equal(f.row(1)?.status, 'delivered');
  } finally { f.store.close(); }
});

test('with no other live thread, a settled project thread expires the message to the sender instead of queueing it', async () => {
  const f = fixture();
  try {
    f.settled.add('own');
    f.archived.add('other');
    const receipt = await f.tell(2);
    assert.equal(receipt.status, 'expired');
    assert.match('detail' in receipt ? receipt.detail : '', /No live responsible thread for example; handle it yourself/);
    assert.equal(f.row(2)?.status, 'expired');
    assert.deepEqual(f.sent, []);
  } finally { f.store.close(); }
});

test('a cached shortlist that still names a thread the operator has since settled re-resolves at delivery', async () => {
  const f = fixture();
  try {
    assert.equal((await f.tell(3)).status, 'delivered');
    assert.deepEqual(f.sent, ['own']);
    // The shortlist is still cached as routable; the settle lands after it was read.
    f.settled.add('own');
    assert.equal((await f.tell(4)).status, 'delivered');
    assert.deepEqual(f.sent, ['own', 'other']);
    assert.equal(f.row(4)?.toAgentId, formatAgentId('paseo-synthetic', 'other'));
  } finally { f.store.close(); }
});

test('a send the host refuses as settled, though the read did not show it, moves on once and never queues on that thread', async () => {
  const f = fixture();
  try {
    f.settled.add('own');
    f.hidden.add('own');
    const receipt = await f.tell(5);
    assert.equal(receipt.status, 'delivered');
    assert.deepEqual(f.sent, ['other']);
    assert.equal(f.row(5)?.status, 'delivered');
  } finally { f.store.close(); }
});

test('a queued message refused on a settled thread settles on the next pass through the ordinary owner', async () => {
  const f = fixture();
  try {
    // The stored state from before this change: the send was refused, the row stayed queued
    // and its refusal names the old "Reviewer continuation" route.
    f.setLegacyRefusal(true);
    f.settled.add('own');
    f.hidden.add('own');
    const queued = await f.tell(6);
    assert.equal(queued.status, 'queued');
    assert.equal(f.row(6)?.status, 'queued');
    assert.equal(f.row(6)?.deliveryIntentState, 'refused');
    assert.match(f.row(6)?.error ?? '', /Project message refused before send: T3Code thread is manually settled/);
    assert.deepEqual(f.sent, []);

    // The next pass: the read now shows the settle, so the thread is put away and the other live thread takes it.
    f.setLegacyRefusal(false);
    f.hidden.clear();
    await f.engine.resolution.deliverQueuedMessages();
    assert.equal(f.row(6)?.status, 'delivered');
    assert.deepEqual(f.sent, ['other']);
  } finally { f.store.close(); }
});

test('a queued message refused on a settled thread with no other live thread expires on the next pass', async () => {
  const f = fixture();
  try {
    f.setLegacyRefusal(true);
    f.settled.add('own');
    f.hidden.add('own');
    assert.equal((await f.tell(7)).status, 'queued');
    f.archived.add('other');
    f.setLegacyRefusal(false);
    f.hidden.clear();
    await f.engine.resolution.deliverQueuedMessages();
    assert.equal(f.row(7)?.status, 'expired');
    assert.match(f.row(7)?.error ?? '', /No live responsible thread for example; handle it yourself/);
    assert.deepEqual(f.sent, []);
  } finally { f.store.close(); }
});
