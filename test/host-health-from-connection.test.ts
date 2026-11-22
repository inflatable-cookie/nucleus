import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, type Profile } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';
import { HostTransportFault, recordHostFailure } from '../core/host/adapter-routing';
import { T3RpcError } from '../hosts/t3code/rpc';

/**
 * Tom, 2026-11-22: host health comes from the host's connection, never from a
 * task's own record or a slow call. On 22 November a stale host wait on one
 * visited task, re-asserted by every submission's dispatch pass, kept a connected
 * T3 host "unavailable" for 47 minutes and rewrote every task's stop each time.
 */
const HOST = 't3code:synthetic-environment';
const base = 'b'.repeat(40);
const profile: Profile = {
  id: 'synthetic-profile', name: 'Synthetic', provider: 'synthetic-provider', model: 'synthetic-model',
  available: true, problem: '', notes: '', supportedThinking: [],
};

function fixture(t: { after: (fn: () => void) => void }) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setMeta('paused', false);
  const insert = (title: string) =>
    store.insert(submissionSchema.parse({ submissionId: randomUUID(), title, repoPath: '/synthetic/repo',
      planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), HOST, 'handoff.md', base);
  const queued = insert('Queued work');
  const working = insert('Working task');
  store.update(working.id, {
    phase: 'working', workspaceIntent: true, agentIntent: true, workspaceId: 'synthetic-workspace',
    agentId: 'synthetic-worker', runId: 'initial', directory: '/synthetic/repo', branch: 'ns-synthetic', baseBranch: 'main',
    profile, workerModel: profile.model, workerModels: [profile.model],
  }, 'dispatched');
  const adapter = { hostId: HOST } as unknown as Adapter;
  const engine = new Engine(store, adapter, 60_000);
  engine.hostIds = () => [HOST];
  engine.hostAvailable = id => id === HOST;
  t.after(() => engine.stop());
  return { store, engine, queued, working };
}

const stopReasons = (store: Store, ...ids: string[]) =>
  ids.map(id => store.task(id).resolution.stop?.reason ?? null);

test('a failure with no error on a connected host is not an outage and rewrites no task', t => {
  const { store, engine, queued, working } = fixture(t);
  // The dispatch post-check's shape: the visited task still carries an old host
  // wait, and the recorder is called with no error.
  assert.equal(recordHostFailure(engine.adapter, HOST, undefined), false, 'the recorder declines it');
  assert.equal(engine.hostOutages.current(HOST), null, 'no outage is opened');
  assert.deepEqual(stopReasons(store, queued.id, working.id), [null, null], 'no task gets a host wait');
  assert.equal(store.eventsAll(working.id).some(event => event.kind === 'host_outage_wait'), false);
});

test('a timed-out call on a connected host is that call\'s failure, not an outage', t => {
  const { store, engine, queued, working } = fixture(t);
  const timeout = new T3RpcError('timeout', 'orchestration.subscribeShell');
  assert.equal(recordHostFailure(engine.adapter, HOST, timeout), false);
  assert.equal(recordHostFailure(engine.adapter, HOST, new HostTransportFault(HOST, timeout)), false,
    'a timeout attributed at the adapter boundary is declined the same way');
  assert.equal(engine.hostOutages.current(HOST), null);
  assert.deepEqual(stopReasons(store, queued.id, working.id), [null, null]);
});

test('a lost connection still parks the host\'s tasks', t => {
  const { store, engine, working } = fixture(t);
  engine.resolveHostAdapter = () => undefined;
  assert.equal(recordHostFailure(engine.adapter, HOST, undefined), true);
  assert.ok(engine.hostOutages.current(HOST), 'the outage is opened');
  assert.equal(store.task(working.id).resolution.stop?.reason, 'host_unavailable');
});

test('a transport error on a claimed connection still counts (Spec 066 R6)', t => {
  const { store, engine, working } = fixture(t);
  const lost = new T3RpcError('transport', 'orchestration.subscribeThread');
  assert.equal(recordHostFailure(engine.adapter, HOST, lost), true);
  assert.ok(engine.hostOutages.current(HOST));
  assert.equal(store.task(working.id).resolution.stop?.reason, 'host_unavailable');
});
