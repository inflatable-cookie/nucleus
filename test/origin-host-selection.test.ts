import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostRegistry, resolveOriginHost, type KnownHost } from '../core/host/host-registry';

test('origin host requires a complete unique observation across known hosts', async () => {
  let known: readonly KnownHost[] = [];
  const registry = new HostRegistry<{ ids: string[] }>({ read: () => known, write: value => { known = value; }, transaction: fn => fn() });
  const a = registry.connect('a', 'a-endpoint', { ids: ['origin'] });
  registry.connect('b', 'b-endpoint', { ids: [] });
  const lookup = async (host: { ids: string[] }, id: string) => host.ids.includes(id) ? {} : null;
  assert.equal(await resolveOriginHost(registry, 'origin', lookup), 'a');
  registry.get('b')!.ids.push('origin');
  assert.equal(await resolveOriginHost(registry, 'origin', lookup), undefined);
  registry.disconnect('a', a);
  assert.equal(await resolveOriginHost(registry, 'origin', lookup), undefined);
});
