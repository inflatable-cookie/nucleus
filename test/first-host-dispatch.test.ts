import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { poolSchema } from '../shared/contracts';
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
  engine.profiles = profiles;
  engine.hostIds = () => ['paseo:one', 't3code:one'];
  engine.resolveHostAdapter = id => id === 'paseo:one' ? paseo : t3;
  engine.profileCatalogKnownFor = () => true;
  engine.profilesFor = id => id === 't3code:one' ? profiles.filter(p => p.id !== 'paseo-only') : profiles.filter(p => p.id !== 't3-only');
  engine.launchAgent = async () => {};
  engine.enqueueTitle = () => {};
  try {
    for (const [id, expected] of [['t3-only', 't3code:one'], ['both', 'paseo:one']] as const) {
      const task = store.insert(submission({ preferredProfileId: id, requirePreferred: true }), 'paseo:one', 'handoff', 'a'.repeat(40));
      await engine.dispatchTask(task.id, false);
      const result = store.task(task.id);
      assert.equal(result.hostId, expected);
      assert.equal(result.profile?.id, id);
      assert.equal(result.hostSelection?.basis, 'worker_profile');
      assert.match(result.hostSelection?.reason ?? '', new RegExp(id));
      assert.equal(created.at(-1), `${expected === 'paseo:one' ? 'paseo' : 't3'}:${expected}`);
    }
    engine.hostAvailable = id => id !== 't3code:one';
    const offline = store.insert(submission({ preferredProfileId: 't3-only', requirePreferred: false }), 'paseo:one', 'handoff', 'a'.repeat(40));
    await engine.dispatchTask(offline.id, false);
    assert.notEqual(store.task(offline.id).profile?.id, 't3-only');
    assert.equal(store.task(offline.id).hostId, 'paseo:one');
    const dispatched = store.task(offline.id);
    assert.throws(() => store.update(dispatched.id, { hostId: 't3code:one' }), /host cannot be changed/);
  } finally { await engine.stop(); store.close(); }
});
