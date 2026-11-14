import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHost, T3RpcError } from '../hosts/t3code';
import { T3HostConnection } from '../service/t3code-host';
import { HostRegistry, type KnownHost } from '../core/host/host-registry';
import { Admission } from '../core/host/admission';
import type { Adapter } from '../core/host';
import { t3Fake } from './support/t3code-fake';

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('Nightly transport did not reach the expected state');
}

test('two heartbeat failures retire the host and reconnect once; health retains the reason', async t => {
  const directory = mkdtempSync(join(tmpdir(), 't3-heartbeat-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = await t3Fake(t, directory);
  let known: readonly KnownHost[] = [];
  const hosts = new HostRegistry<{ adapter: Adapter; admission: Admission }>({
    read: () => known, write: value => { known = value; }, transaction: work => work(),
  });
  const native: ReturnType<typeof createHost>[] = [];
  const connection = new T3HostConnection({ endpoint: server.endpoint, bearer: 'synthetic-bearer' }, directory, hosts,
    () => new Admission(), {
      create: config => {
        const host = createHost({ ...config, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1_000 });
        native.push(host);
        return host;
      },
      adapter: () => ({} as Adapter),
    });
  t.after(() => connection.close());
  await connection.ensureConnected();
  assert.equal(connection.status().connected, true);
  const pingsBeforeFailure = server.controlFrames.filter(frame => frame._tag === 'Ping').length;
  server.controls.heartbeat = false;
  await until(() => server.controlFrames.filter(frame => frame._tag === 'Ping').length === pingsBeforeFailure + 1);
  await until(() => server.controlFrames.filter(frame => frame._tag === 'Ping').length === pingsBeforeFailure + 2);
  assert.equal(connection.status().connected, true, 'one missed pong cannot retire a host');
  // Ordinary successful reads do not substitute for the liveness exchange.
  await native[0]!.catalog();
  await until(() => !native[0]!.connected);
  assert.equal(connection.status().connected, false);
  assert.equal(connection.status().lastDisconnectReason, 'heartbeat_failure');
  assert.deepEqual(hosts.onlineIds(), [], 'the registry exposes host_unavailable');
  await until(() => server.closes === 1);
  server.controls.heartbeat = true;
  await Promise.all([connection.ensureConnected(), connection.ensureConnected()]);
  assert.equal(native.length, 2);
  assert.equal(server.upgrades, 2);
  assert.equal(server.closes, 1);
  assert.equal(connection.status().connected, true);
  assert.equal(connection.status().lastDisconnectReason, 'heartbeat_failure', 'reconnect must retain the last disconnect reason');
  const pingsBeforeHealthy = server.controlFrames.filter(frame => frame._tag === 'Ping').length;
  await until(() => server.controlFrames.filter(frame => frame._tag === 'Ping').length > pingsBeforeHealthy);
  // The config response follows Pong on the same socket, so this drains it.
  await native[1]!.catalog();
  await delay(200);
  await native[1]!.catalog();
  assert.equal(connection.status().connected, true);
  connection.close();
  await until(() => server.closes === 2);
  const pings = server.controlFrames.filter(frame => frame._tag === 'Ping').length;
  await delay(200);
  assert.equal(server.controlFrames.filter(frame => frame._tag === 'Ping').length, pings, 'close cancels heartbeat timers');
});

test('an unparseable frame closes the shared connection and reconnects once; health names the branch', async t => {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch, 'TMPDIR must be this run\'s scratch');
  const directory = mkdtempSync(join(scratch, 't3-unparseable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = await t3Fake(t, directory);
  let known: readonly KnownHost[] = [];
  const hosts = new HostRegistry<{ adapter: Adapter; admission: Admission }>({
    read: () => known, write: value => { known = value; }, transaction: work => work(),
  });
  const native: ReturnType<typeof createHost>[] = [];
  const connection = new T3HostConnection({ endpoint: server.endpoint, bearer: 'synthetic-bearer' }, directory, hosts,
    () => new Admission(), {
      create: config => {
        const host = createHost({ ...config, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1_000 });
        native.push(host);
        return host;
      },
      adapter: () => ({} as Adapter),
    });
  t.after(() => connection.close());
  await connection.ensureConnected();
  assert.equal(connection.status().connected, true);
  assert.equal(connection.status().lastProtocolError, null);
  server.injectRaw('{');
  await until(() => connection.status().connected === false);
  assert.equal(connection.status().lastDisconnectReason, 'protocol_error');
  assert.deepEqual(connection.status().lastProtocolError, { branch: 'unparseable_frame', tag: null });
  await until(() => server.closes === 1);
  await Promise.all([connection.ensureConnected(), connection.ensureConnected()]);
  assert.equal(native.length, 2);
  assert.equal(server.upgrades, 2);
  assert.equal(server.closes, 1);
  assert.equal(connection.status().connected, true);
  assert.equal(connection.status().lastDisconnectReason, 'protocol_error');
  assert.deepEqual(connection.status().lastProtocolError, { branch: 'unparseable_frame', tag: null });
  await native[1]!.catalog();
  await delay(200);
  assert.equal(server.upgrades, 2, 'an unparseable frame reconnects once');
  assert.equal(connection.status().connected, true);
});

test('a per-request Defect stays on that request; health names the branch and the connection stays up', async t => {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch, 'TMPDIR must be this run\'s scratch');
  const directory = mkdtempSync(join(scratch, 't3-defect-health-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = await t3Fake(t, directory);
  let known: readonly KnownHost[] = [];
  const hosts = new HostRegistry<{ adapter: Adapter; admission: Admission }>({
    read: () => known, write: value => { known = value; }, transaction: work => work(),
  });
  const native: ReturnType<typeof createHost>[] = [];
  const connection = new T3HostConnection({ endpoint: server.endpoint, bearer: 'synthetic-bearer' }, directory, hosts,
    () => new Admission(), {
      create: config => {
        const host = createHost({ ...config, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1_000 });
        native.push(host);
        return host;
      },
      adapter: () => ({} as Adapter),
    });
  t.after(() => connection.close());
  await connection.ensureConnected();
  assert.equal(connection.status().connected, true);
  const before = server.requests.filter(request => request.tag === 'orchestration.subscribeThread').length;
  server.controls.slowSnapshotMs = 5_000;
  const read = native[0]!.readProjection('synthetic-probe', 'observation');
  await until(() => server.requests.filter(request => request.tag === 'orchestration.subscribeThread').length > before);
  const request = [...server.requests].reverse().find(frame => frame.tag === 'orchestration.subscribeThread');
  assert.ok(request);
  server.inject({ _tag: 'Defect', requestId: request.id });
  await assert.rejects(read, error => error instanceof T3RpcError && error.code === 'protocol' && error.delivery === 'unknown');
  assert.equal(connection.status().connected, true);
  assert.equal(connection.status().lastDisconnectReason, null);
  assert.deepEqual(connection.status().lastProtocolError, { branch: 'defect', tag: 'Defect' });
  await native[0]!.catalog();
  assert.equal(server.upgrades, 1);
  assert.equal(connection.status().connected, true);
});
