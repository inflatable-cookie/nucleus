import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSettings, type SettingsContext } from '../core/runtime/settings';
import { Store } from '../core/store/store';
import { configurePool, configureProfile } from '../shared/rpc/settings';
import type { PoolEntry } from '../shared/contracts';
import type { NucleusProfile } from '../shared/profiles';

// Nucleus#1492: a pool save validates profile identity against the stored Nucleus
// profile records, never the routing snapshot a live host catalog builds. With the
// primary catalog unread, the routing list is empty; the stored records still stand.

const sol: NucleusProfile = { id: 'sol-heavyweight', name: 'Sol Heavyweight', provider: 'openai', model: 'gpt-5', notes: '' };
const oracle: NucleusProfile = { id: 'oracle', name: 'Oracle', provider: 'anthropic', model: 'claude-opus-5-5', notes: '' };

/** A stored pool row as the store keeps it: the canonical shape, one weight stop. */
const row = (profileId: string, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  profileId, enabled: true, group: 'openai', roles: ['worker'], capability: 'heavyweight', weight: 'default', scopes: ['general'], ...extra,
});

/** RuntimeSettings over a real store, with an engine whose routing snapshot is empty (no primary catalog read). */
function settingsOver(store: Store, catalogReads: { count: number }) {
  const adapter = {
    catalog: async () => { catalogReads.count++; throw new Error('host catalog unavailable'); },
  };
  const context = {
    store,
    engine: { profiles: [], wake: async () => {}, resumePausedStops: async () => {} },
    decisions: {} as never,
    capacityChanges: {} as never,
    started: Promise.resolve(),
    hostId: 'paseo:primary',
    startError: '',
    adapter,
    connected: () => true,
    wakeAndSettlePostBootstrapTimeout: async () => {},
    markStoreAccess: () => {},
  } as unknown as SettingsContext;
  return new RuntimeSettings(context);
}

function withStore(run: (store: Store, dir: string) => void) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ns-profile-pool-identity-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try { run(store, dir); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('a weight-only change to a stored profile saves through the single-entry Settings path with no routing snapshot', () => {
  withStore((store) => {
    store.setProfiles([sol]);
    store.setMeta('pool', [row(sol.id)]);
    const reads = { count: 0 };
    const settings = settingsOver(store, reads);
    for (const weight of ['more', 'default', 'most'] as const) {
      // The RPC boundary validates the input exactly as the wire does.
      const input = configureProfile.input.parse({ ...store.pool()[0], weight });
      assert.deepEqual(settings.configureProfile(input), { ok: true });
      assert.equal(store.pool()[0]?.weight, weight, `read-back after saving ${weight}`);
    }
    assert.equal(reads.count, 0, 'validating a stored profile never queries a host');
  });
});

test('other single-entry fields save through the same owner while the routing snapshot is empty', () => {
  withStore((store) => {
    store.setProfiles([sol]);
    store.setMeta('pool', [row(sol.id)]);
    const settings = settingsOver(store, { count: 0 });
    settings.configureProfile(configureProfile.input.parse({ ...store.pool()[0], group: 'other-subscription' }));
    assert.equal(store.pool()[0]?.group, 'other-subscription');
    settings.configureProfile(configureProfile.input.parse({ ...store.pool()[0], enabled: false }));
    assert.equal(store.pool()[0]?.enabled, false);
    settings.configureProfile(configureProfile.input.parse({ ...store.pool()[0], capability: 'worker' }));
    assert.equal(store.pool()[0]?.capability, 'worker');
  });
});

test('a whole-pool save keeps an unrelated retained row and saves the changed Sol weight', () => {
  withStore((store) => {
    store.setProfiles([sol, oracle]);
    // A retained row for a profile the operator removed from Nucleus is unchanged, so it stays.
    const retired = row('retired-profile', { enabled: false, group: 'opencode-go' });
    store.setMeta('pool', [row(sol.id), row(oracle.id, { capability: 'worker' }), retired]);
    const settings = settingsOver(store, { count: 0 });
    const stored = store.pool();
    const entries = stored.map(entry => entry.profileId === sol.id ? { ...entry, weight: 'more' as const } : entry);
    settings.configurePool(configurePool.input.parse({ entries }));
    const after = store.pool();
    assert.equal(after.find(entry => entry.profileId === sol.id)?.weight, 'more');
    assert.equal(after.find(entry => entry.profileId === oracle.id)?.capability, 'worker');
    assert.deepEqual(after.find(entry => entry.profileId === 'retired-profile'), retired);
  });
});

test('a new or changed orphan entry is refused with wording that names the missing profile, not a catalog refresh', () => {
  withStore((store) => {
    store.setProfiles([sol]);
    store.setMeta('pool', [row(sol.id)]);
    const settings = settingsOver(store, { count: 0 });
    const before = store.pool();
    assert.throws(
      () => settings.configureProfile(configureProfile.input.parse(row('ghost-profile'))),
      (error: Error) => /^Unknown profile ghost-profile\b/.test(error.message) && !/refresh the catalog/.test(error.message),
    );
    assert.throws(
      () => settings.configurePool(configurePool.input.parse({ entries: [...before, row('ghost-profile')] })),
      /Unknown profile ghost-profile/,
    );
    assert.deepEqual(store.pool(), before, 'a refused save leaves the stored pool as it was');
  });
});

test('duplicate and reserved-group validation still refuse a whole-pool save', () => {
  withStore((store) => {
    store.setProfiles([sol]);
    store.setMeta('pool', [row(sol.id)]);
    const settings = settingsOver(store, { count: 0 });
    assert.throws(() => settings.configurePool({ entries: [row(sol.id), row(sol.id)] }), /Duplicate pool profile/);
    assert.throws(() => settings.configureProfile(configureProfile.input.parse(row(sol.id, { group: 'profile:x' }))), /reserved/);
  });
});
