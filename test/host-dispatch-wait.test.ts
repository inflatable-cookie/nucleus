import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { submissionSchema, summarizeTask } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';
import { fakeAdapter, profile, submission } from './support/fakes';

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
    // The known offline host is one named host wait (Tom, 2026-11-14, T3 lane v18
    // host dropout option 1: wait); a task with no proven host keeps its own wait.
    assert.match(store.task(offline.id).reason, /Waiting on Paseo host offline since /);
    assert.equal(store.task(offline.id).resolution.stop?.reason, 'host_unavailable');
    assert.match(store.task(unknown.id).reason, /proven host/);
    assert.equal(creates, 0);
    assert.equal(store.task(offline.id).workspaceIntent, false);
    assert.equal(store.task(unknown.id).workspaceIntent, false);
  } finally { await engine.stop(); store.close(); }
});

test('new dispatch for a project on an offline host waits with host_unavailable', async () => {
  const store = new Store(':memory:');
  let creates = 0;
  const engine = new Engine(store, { createWorkspace: async () => { creates++; throw Error('must not run'); } } as unknown as Adapter, 0);
  engine.hostAvailable = id => id === 'online';
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'host-wait', title: 'Host wait',
      repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'handoff', originAgentId: 'origin' }), 'offline', 'handoff', 'a'.repeat(40));
    await engine.dispatchTask(task.id, false);
    const waiting = store.task(task.id);
    // Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): new dispatch for
    // a project whose host is away waits on that host, visibly and with its start.
    assert.equal(waiting.resolution.stop?.reason, 'host_unavailable');
    assert.match(waiting.resolution.stop?.detail ?? '', /^Waiting on Paseo host offline since \d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(waiting.resolution.hostWait && { hostId: waiting.resolution.hostWait.hostId }, { hostId: 'offline' },
      'the task records its own host wait while it is queued');
    assert.equal(waiting.phase, 'queued');
    assert.equal(creates, 0);
    assert.equal(waiting.workspaceIntent, false);
    const card = summarizeTask(waiting, false, false, {}, [], undefined, 'online', store.eventsAll(task.id));
    assert.equal(card.stop, 'wait');
    assert.match(card.stopRecord?.detail ?? '', /Waiting on Paseo host offline since /);
  } finally { await engine.stop(); store.close(); }
});

test('real admission gives one free slot to healthy hosts while a BB host waits, then resumes BB', async () => {
  const store = new Store(':memory:');
  const worker = profile('worker');
  const launches: string[] = [];
  const adapter = fakeAdapter({
    validate: async () => 'a'.repeat(40),
    createWorkspace: async task => ({ id: `ws-${task.id}`, directory: `/synthetic/workspaces/${task.id}` }),
  });
  const engine = new Engine(store, adapter, 0);
  store.setMeta('paused', false);
  store.setMeta('globalLimit', 1);
  store.setMeta('pool', [{ profileId: worker.id, enabled: true, group: 'workers', weight: 1, scopes: ['general'] }]);
  store.setProfiles([{ id: worker.id, name: worker.name, provider: worker.provider, model: worker.model, notes: '' }]);
  engine.profiles = [worker];
  engine.profileCatalogKnown = () => true;
  engine.profilesFor = () => [worker];
  let bbOnline = false;
  engine.hostAvailable = host => host !== 'bb:offline' || bbOnline;
  engine.enqueueTitle = () => {};
  engine.launchAgent = async task => {
    launches.push(task.id);
    store.update(task.id, { phase: 'working', agentId: `agent-${task.id}`, agentActive: true });
  };
  const add = (hostId: string, title: string) => store.insert(submission({ title, repoPath: `/synthetic/${title}` }), hostId, 'handoff', 'a'.repeat(40));
  const bb = add('bb:offline', 'bb');
  const paseo = add('paseo:primary', 'paseo');
  const t3 = add('t3code:primary', 't3');
  try {
    await engine.dispatchQueued();
    assert.equal(store.task(bb.id).resolution.stop?.reason, 'host_unavailable');
    assert.deepEqual(launches, [paseo.id], 'the real first-dispatch admission starts Paseo');
    store.update(paseo.id, { phase: 'done', agentActive: false });
    await engine.dispatchQueued();
    assert.deepEqual(launches, [paseo.id, t3.id], 'T3 takes the released slot');
    store.update(t3.id, { phase: 'done', agentActive: false });
    bbOnline = true;
    engine.hostWait(store.task(bb.id));
    await engine.dispatchQueued();
    assert.deepEqual(launches, [paseo.id, t3.id, bb.id], 'BB starts once on return');
    await engine.dispatchQueued();
    assert.deepEqual(launches, [paseo.id, t3.id, bb.id], 'no duplicate launch');
  } finally { await engine.stop(); store.close(); }
});
