import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostConnections, wireEngineHosts } from '../service/host-connections';
import { HostRegistry } from '../core/host/host-registry';
import { Admission } from '../core/host/admission';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../core/host/adapter';
import type { HostConnectionOwner, RegisteredHost } from '../service/host-connections';

function registry() {
  let known: { id: string; endpoint: string }[] = [];
  return new HostRegistry<RegisteredHost>({
    read: () => known, write: value => { known = [...value]; }, transaction: work => work(),
  });
}

test('connected retires a mismatched Paseo claim and anyHostConnected counts the registry', () => {
  const hosts = registry();
  const adapter = { client: { isConnected: false } } as unknown as Adapter;
  const admission = new Admission();
  const token = hosts.connect('paseo-env', 'ws://127.0.0.1/ws', { adapter, admission });
  const owner = {
    adapter,
    hostSession: { id: 'paseo-env', token },
    hostRegistry: hosts,
    t3Host: null,
    bootstrapped: true,
    closing: false,
    idleShutdownLatched: false,
    bootstrapRunning: null,
    serveHostRunEndpoint: false,
    hostRunEndpoint: null,
    hostRuns: { liveRuns: () => [] },
    store: { getMeta: () => null, setMeta() {}, deleteMeta() {}, advanceRevision() {}, projectPlannerRecipient: () => null, queueProject: () => null },
    engine: {} as Engine,
    pluginLostGraceMs: 1,
    paseoHostId: 'paseo-env',
  } as unknown as HostConnectionOwner;
  const connections = new HostConnections(owner);
  assert.equal(connections.connected(), false);
  assert.equal(owner.hostSession, null);
  assert.equal(owner.bootstrapped, false);
  assert.equal(connections.anyHostConnected(), false);
});

test('wireEngineHosts refuses an unregistered explicit host and resolves a lone online host', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || '', 'host-connections-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const adapter = { observe: async (id: string) => ({ id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '' }) } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  const hosts = registry();
  hosts.connect('only-host', 'ws://127.0.0.1/ws', { adapter, admission: new Admission() });
  try {
    wireEngineHosts(engine, {
      adapter, admission: new Admission(), hostRegistry: hosts, hostSession: null,
      connected: () => true, settings: { daemonUrl: 'ws://127.0.0.1/ws' }, store,
    });
    assert.equal(engine.selectIngressHost(), 'only-host');
    assert.throws(() => engine.selectIngressHost('missing'), /not registered/);
  } finally { void engine.stop(); store.close(); }
});
