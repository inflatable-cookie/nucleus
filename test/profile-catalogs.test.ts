import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileCatalogs } from '../core/host/profile-catalogs';
import type { Adapter } from '../core/host/adapter';
import type { Profile } from '../shared/contracts';
import type { NucleusProfile } from '../shared/profiles';
import type { HostCatalog } from '../shared/host';

const stored: NucleusProfile = { id: 'sol', name: 'Sol', provider: 'test', model: 'test-model', notes: '' };
const emptyCatalog: HostCatalog = { providers: [] };

function adapter(id: string, hostCatalog: HostCatalog = emptyCatalog): Adapter {
  return { hostId: id, catalog: async () => hostCatalog } as unknown as Adapter;
}

test('a host never read answers unknown; refresh marks the catalog known', async () => {
  const primary = adapter('primary');
  const owner = {
    store: { profiles: () => [stored] },
    adapter: primary,
    primaryAdapter: primary,
    resolveHostAdapter: (id: string) => id === 'primary' ? primary : undefined,
    hostIds: () => ['primary'] as const,
    hostOnline: (id: string) => id === 'primary',
    profiles: [] as Profile[],
  };
  const catalogs = new ProfileCatalogs(owner);
  const unread = catalogs.profileCompatibility();
  assert.equal(unread.rows[0]?.status, 'unknown');
  assert.equal(catalogs.profileCatalogKnown(), false);
  await catalogs.refresh();
  assert.equal(catalogs.profileCatalogKnown(), true);
  assert.equal(catalogs.profileCatalogKnownFor('primary'), true);
});

test('a secondary host keeps its previous snapshot when a later catalog read fails', async () => {
  let secondaryReads = 0;
  const primary = adapter('primary');
  const secondary = {
    hostId: 't3code:env',
    catalog: async () => { secondaryReads++; if (secondaryReads === 2) throw Error('catalog unavailable'); return emptyCatalog; },
  } as unknown as Adapter;
  const owner = {
    store: { profiles: () => [stored] },
    adapter: primary,
    primaryAdapter: primary,
    resolveHostAdapter: (id: string) => id === 'primary' ? primary : secondary,
    hostIds: () => ['primary', 't3code:env'] as const,
    hostOnline: () => true,
    profiles: [] as Profile[],
  };
  const catalogs = new ProfileCatalogs(owner);
  await catalogs.refresh();
  assert.equal(catalogs.profileCatalogKnownFor('t3code:env'), true);
  await catalogs.refresh();
  assert.equal(catalogs.profileCatalogKnownFor('t3code:env'), true);
  assert.equal(secondaryReads, 2);
});
