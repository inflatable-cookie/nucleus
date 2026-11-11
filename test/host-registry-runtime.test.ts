import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QueueRuntime } from '../service/runtime-owner';
import { Store } from '../core/store/store';
import type { Adapter } from '../core/host/adapter';
import { admissionOf } from '../core/host/admission';

function fixture(dir: string, identity: string) {
  const client = { isConnected: false, reachable: true };
  const adapter = {
    client, hostId: identity, socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'worker-helper.mjs'),
    connect: async () => { if (!client.reachable) throw new Error('offline'); client.isConnected = true; }, close: async () => { client.isConnected = false; },
    catalog: async () => ({ providers: [] }),
    observe: async () => ({ id: 'w', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }),
  };
  return { adapter, client };
}

test('registered host identity rejects mismatches and retains admission across restart and reconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-registry-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('hostRegistry', [{ id: 'old-host', endpoint: 'ws://127.0.0.1:6767/ws' }]);
  store.close();
  const f = fixture(dir, 'other-host');
  const open = () => new QueueRuntime({ dataDir: dir, adapterFactory: () => f.adapter as unknown as Adapter, timers: false });
  let runtime = open();
  await runtime.started;
  await runtime.bootstrap;
  assert.match(runtime.startError, /identity changed/);
  assert.deepEqual(runtime.store.getMeta('hostRegistry'), [{ id: 'old-host', endpoint: 'ws://127.0.0.1:6767/ws' }]);
  assert.equal(runtime.hostRegistry.get('other-host'), undefined);
  await runtime.drain();

  f.adapter.hostId = 'old-host';
  runtime = open();
  await runtime.started;
  await runtime.bootstrap;
  assert.deepEqual(runtime.store.getMeta('hostRegistry'), [{ id: 'old-host', endpoint: 'ws://127.0.0.1:6767/ws' }]);
  const admission = runtime.hostRegistry.resource('old-host', () => { throw new Error('missing admission'); });
  assert.equal(admission, runtime.admission);
  assert.equal(admissionOf(runtime.adapter), admission);
  assert.equal(runtime.hostRegistry.get('old-host')?.admission, admission);
  assert.deepEqual(runtime.health().admission, runtime.admission.snapshot());
  assert.throws(() => runtime.hostRegistry.resource('other-host', () => admission), /another identity/);
  f.client.reachable = false;
  f.client.isConnected = false;
  await assert.rejects(runtime.refreshCatalog(), /offline|identity|disconnected/);
  assert.equal(runtime.hostRegistry.get('old-host'), undefined);
  f.client.reachable = true;
  await runtime.ensureBootstrap();
  assert.ok(runtime.hostRegistry.get('old-host'));
  assert.equal(runtime.hostRegistry.get('old-host')?.admission, admission);
  await runtime.drain();

  runtime = open();
  await runtime.started;
  await runtime.bootstrap;
  assert.equal(runtime.hostRegistry.known().length, 1);
  await runtime.drain();
});
