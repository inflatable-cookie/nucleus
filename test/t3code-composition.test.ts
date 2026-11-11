import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T3HostConnection } from '../service/t3code-host';
import { HostRegistry, type KnownHost } from '../core/host/host-registry';
import { Admission } from '../core/host/admission';
import type { Adapter } from '../core/host';

type RegisteredHost = { adapter: Adapter; admission: Admission };
function registry() {
  let known: readonly KnownHost[] = [];
  const hosts = new HostRegistry<RegisteredHost>({
    read: () => known, write: value => { known = value; }, transaction: work => work(),
  });
  const primary = { adapter: {} as Adapter, admission: new Admission() };
  const primaryToken = hosts.connect('paseo-environment', 'ws://127.0.0.1:10001/ws', primary);
  return { hosts, primary, primaryToken };
}

class NativeHost {
  connected = false;
  hostId = 't3code:synthetic-environment';
  version = 'nightly-synthetic';
  threadShapePending = false;
  compatibilityFailure = '';
  connects = 0;
  closes = 0;
  probe: string | undefined;
  failure: Error | null = null;
  wait: Promise<void> | null = null;
  async connect(probe?: string) {
    this.connects++;
    this.probe = probe;
    await this.wait;
    if (this.failure) throw this.failure;
    this.connected = true;
  }
  close() { this.connected = false; this.closes++; }
}

function connection(hosts: HostRegistry<RegisteredHost>, candidates: NativeHost[]) {
  const config = { endpoint: 'ws://127.0.0.1:10002/ws', bearer: 'synthetic-private-bearer', probeThreadId: 'synthetic-probe' };
  let creations = 0;
  const manager = new T3HostConnection(config, '/synthetic-state', hosts, () => new Admission(), {
    create: input => {
      assert.equal(input.bearer, config.bearer);
      assert.equal(input.probeThreadId, config.probeThreadId);
      assert.match(input.statePath, /hosts[/\\]t3code\.json$/);
      return candidates[creations++]!;
    },
    adapter: () => ({ observe: async (id: string) => ({ id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '' }) } as Adapter),
  });
  return { manager, config, creations: () => creations };
}

test('second host registers separately, retains its admission on reconnect, and never closes Paseo', async () => {
  const { hosts, primary, primaryToken } = registry();
  const first = new NativeHost(), second = new NativeHost();
  const { manager } = connection(hosts, [first, second]);
  try {
    await manager.ensureConnected();
    assert.deepEqual(hosts.onlineIds(), ['paseo-environment', first.hostId]);
    assert.equal(hosts.get('paseo-environment'), primary);
    const admission = hosts.get(first.hostId)!.admission;
    assert.notEqual(admission, primary.admission);
    assert.equal(first.probe, 'synthetic-probe');
    assert.deepEqual(manager.status(), { id: first.hostId, connected: true, error: '', version: first.version, threadShapePending: false });

    first.connected = false;
    manager.retireDisconnected();
    assert.deepEqual(hosts.onlineIds(), ['paseo-environment']);
    assert.equal(hosts.known().length, 2, 'disconnect retains durable identity');
    await manager.ensureConnected();
    assert.equal(hosts.get(second.hostId)!.admission, admission);
    assert.equal(hosts.get('paseo-environment'), primary);
    manager.close();
    assert.deepEqual(hosts.onlineIds(), ['paseo-environment']);
  } finally {
    manager.close();
    hosts.disconnect('paseo-environment', primaryToken);
  }
});

test('an empty T3 host registers online while its thread shape is pending', async () => {
  const { hosts } = registry();
  const empty = new NativeHost(); empty.threadShapePending = true;
  const { manager } = connection(hosts, [empty]);
  try {
    await manager.ensureConnected();
    assert.deepEqual(hosts.onlineIds(), ['paseo-environment', empty.hostId]);
    assert.deepEqual(manager.status(), { id: empty.hostId, connected: true, error: '', version: empty.version, threadShapePending: true });
  } finally { manager.close(); }
});

test('connection is single-flight and a close while probing cannot publish a stale claim', async () => {
  const { hosts } = registry();
  const native = new NativeHost();
  let release!: () => void;
  native.wait = new Promise<void>(resolve => { release = resolve; });
  const { manager, creations } = connection(hosts, [native]);
  const first = manager.ensureConnected();
  assert.equal(first, manager.ensureConnected());
  manager.close();
  release();
  await first;
  assert.equal(creations(), 1);
  assert.equal(native.connected, false);
  assert.deepEqual(hosts.onlineIds(), ['paseo-environment']);
  await manager.ensureConnected();
  assert.equal(creations(), 1, 'closed manager never reconnects');
});

test('auth and compatibility refusals create no registry claim and redact credentials', async () => {
  const { hosts } = registry();
  const auth = new NativeHost(), compatibility = new NativeHost();
  auth.failure = new Error('Authentication refused synthetic-private-bearer wsTicket=synthetic-ticket');
  compatibility.failure = new Error('Missing field shell.activeRunId');
  const { manager, config } = connection(hosts, [auth, compatibility]);
  try {
    await manager.ensureConnected();
    const status = manager.status();
    assert.equal(status.connected, false);
    assert.doesNotMatch(JSON.stringify(status), /synthetic-private-bearer|synthetic-ticket/);
    assert.doesNotMatch(JSON.stringify(manager), new RegExp(config.bearer));
    assert.deepEqual(hosts.onlineIds(), ['paseo-environment']);
    await manager.ensureConnected();
    assert.match(manager.status().error, /shell\.activeRunId/);
    assert.equal(hosts.known().length, 1);
    assert.equal(auth.connected, false);
    assert.equal(compatibility.connected, false);
  } finally { manager.close(); }
});

test('an endpoint identity change refuses registration and preserves its original identity', async () => {
  const { hosts } = registry();
  const original = new NativeHost(), changed = new NativeHost();
  changed.hostId = 't3code:other-environment';
  const { manager } = connection(hosts, [original, changed]);
  try {
    await manager.ensureConnected();
    original.connected = false;
    await manager.ensureConnected();
    assert.match(manager.status().error, /different identity/);
    assert.equal(manager.status().id, original.hostId);
    assert.equal(changed.connected, false);
    assert.deepEqual(hosts.known().map(host => host.id), ['paseo-environment', original.hostId]);
    assert.deepEqual(hosts.onlineIds(), ['paseo-environment']);
  } finally { manager.close(); }
});

test('a persisted endpoint claim also refuses an identity change after service restart', async () => {
  const { hosts } = registry();
  const token = hosts.connect('t3code:previous-environment', 'ws://127.0.0.1:10002/ws', { adapter: {} as Adapter, admission: new Admission() });
  hosts.disconnect('t3code:previous-environment', token);
  const native = new NativeHost();
  const { manager } = connection(hosts, [native]);
  try {
    await manager.ensureConnected();
    assert.match(manager.status().error, /different identity/);
    assert.deepEqual(hosts.onlineIds(), ['paseo-environment']);
    assert.equal(hosts.known().length, 2);
  } finally { manager.close(); }
});

test('private connection settings refuse credential-bearing endpoints', () => {
  const { hosts } = registry();
  for (const endpoint of ['ws://user:secret@127.0.0.1/ws', 'ws://127.0.0.1/ws?token=secret', 'file:///synthetic']) {
    assert.throws(() => new T3HostConnection({ endpoint, bearer: 'synthetic' }, '/synthetic-state', hosts, () => new Admission()), /endpoint/);
  }
});
