import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { poolSchema, summarizeTask, taskControlInputSchema } from '../shared/contracts';
import { fakeAdapter, profile, submission } from './support/fakes';

test('first dispatch binds the selected profile host before workspace creation', async () => {
  const store = new Store(':memory:');
  const created: string[] = [];
  const adapter = (host: string) => fakeAdapter({
    validate: async () => 'a'.repeat(40),
    createWorkspace: async task => { created.push(`${host}:${task.hostId}`); return { id: `ws-${task.id}`, directory: `/synthetic/${task.id}` }; },
  });
  const paseo = adapter('paseo'), t3 = adapter('t3');
  const engine = new Engine(store, paseo, 0);
  const profiles = [profile('paseo-only'), profile('t3-only'), profile('both')];
  store.setMeta('pool', profiles.map(p => poolSchema.parse({ profileId: p.id, enabled: true, group: p.id, weight: 1, scopes: ['general'], capability: 'medium', cost: 'medium' })));
  store.setMeta('paused', false);
  store.setMeta('globalLimit', 12);
  engine.profiles = profiles;
  engine.hostIds = () => ['paseo:one', 't3code:one'];
  engine.resolveHostAdapter = id => id === 'paseo:one' ? paseo : t3;
  engine.profileCatalogKnownFor = () => true;
  engine.profilesFor = id => id === 't3code:one' ? profiles.filter(p => p.id !== 'paseo-only') : profiles.filter(p => p.id !== 't3-only');
  engine.launchAgent = async () => {};
  engine.enqueueTitle = () => {};
  try {
    const legacy = store.insert(submission({ repoPath: '/synthetic/legacy' }), 'paseo:one', 'handoff', 'a'.repeat(40));
    const legacyRetry = store.update(legacy.id, { profile: profiles[0]!, profileGroup: 'paseo-only' });
    assert.equal(engine.firstWorkerUnbound(legacyRetry), false, 'a previously selected legacy profile keeps its host');
    store.update(legacy.id, { phase: 'done' });
    store.chargeAssignment('paseo-only', 'paseo-only');
    store.chargeAssignment('both', 'both');
    const rotated = store.insert(submission({ repoPath: '/synthetic/rotation' }), 'paseo:one', 'handoff', 'a'.repeat(40));
    await engine.dispatchTask(rotated.id, false);
    assert.equal(store.task(rotated.id).profile?.id, 't3-only');
    assert.equal(store.task(rotated.id).hostId, 't3code:one');
    assert.equal(created.at(-1), 't3:t3code:one');
    for (const [id, expected] of [['t3-only', 't3code:one'], ['both', 'paseo:one']] as const) {
      const task = store.insert(submission({ preferredProfileId: id, requirePreferred: true }), 'paseo:one', 'handoff', 'a'.repeat(40));
      await engine.dispatchTask(task.id, false);
      const result = store.task(task.id);
      assert.equal(result.hostId, expected);
      assert.equal(result.profile?.id, id);
      assert.equal(result.hostSelection?.basis, 'worker_profile');
      assert.match(result.hostSelection?.reason ?? '', new RegExp(id));
      assert.equal(created.at(-1), `${expected === 'paseo:one' ? 'paseo' : 't3'}:${expected}`);
      const summary = summarizeTask(result, false, false, {}, [], undefined, 'paseo:one', store.eventsAll(task.id));
      assert.equal(summary.hostReason, result.hostSelection?.reason);
      if (id === 't3-only') {
        const reviewer = engine.withHost(expected, () => engine.resolution.select(result, 'reviewer'));
        assert.equal(reviewer?.profile.id, 'both');
        assert.equal(engine.workerRoutingProfiles(result).find(p => p.id === 'paseo-only'), undefined);
        const route = taskControlInputSchema.parse({ taskId: result.id, version: result.version, action: 'route', role: 'worker', profileId: 'paseo-only', reason: 'Change worker' });
        await assert.rejects(engine.applyTaskControlRoute(route, value => value), /paseo-only cannot run on task host t3code:one/);
        const hosts = engine.routingHostViews(result);
        assert.equal(hosts.find(host => host.hostId === 't3code:one')?.profiles.find(p => p.profileId === id)?.eligible, true);
        assert.equal(hosts.find(host => host.hostId === 'paseo:one')?.profiles.find(p => p.profileId === id)?.eligible, false);
        const retry = store.update(result.id, { phase: 'queued', workspaceId: null, directory: null, workspaceIntent: false });
        assert.equal(engine.firstWorkerUnbound(retry), false, 'a released workspace intent never reopens host selection');
      }
    }
    engine.hostAvailable = id => id !== 't3code:one';
    const held = store.insert(submission({ repoPath: '/synthetic/held', preferredProfileId: 't3-only', requirePreferred: true }), 'paseo:one', 'handoff', 'a'.repeat(40));
    store.setMeta('paused', true);
    await engine.dispatchTask(held.id, false);
    assert.notEqual(store.task(held.id).resolution.stop?.reason, 'route_unavailable', 'pause wins over a missing eligible profile');
    store.setMeta('paused', false);
    const offline = store.insert(submission({ preferredProfileId: 't3-only', requirePreferred: false }), 'paseo:one', 'handoff', 'a'.repeat(40));
    await engine.dispatchTask(offline.id, false);
    assert.notEqual(store.task(offline.id).profile?.id, 't3-only');
    assert.equal(store.task(offline.id).hostId, 'paseo:one');
    const dispatched = store.task(offline.id);
    assert.throws(() => store.update(dispatched.id, { hostId: 't3code:one' }), /host cannot be changed/);
  } finally { await engine.stop(); store.close(); }
});
