import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHost } from '../hosts/t3code';
import { T3HostConnection } from '../service/t3code-host';
import { HostRegistry, type KnownHost } from '../core/host/host-registry';
import { Admission } from '../core/host/admission';
import type { Adapter } from '../core/host';
import { t3Fake } from './support/t3code-fake';

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
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
        const host = createHost({ ...config, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 100 });
        native.push(host);
        return host;
      },
      adapter: () => ({} as Adapter),
    });
  t.after(() => connection.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await connection.ensureConnected();
  assert.equal(connection.status().connected, true);
  server.controls.heartbeat = false;
  t.mock.timers.tick(100);
  await until(() => server.controlFrames.filter(frame => frame._tag === 'Ping').length === 1);
  t.mock.timers.tick(100);
  await until(() => server.controlFrames.filter(frame => frame._tag === 'Ping').length === 2);
  assert.equal(connection.status().connected, true, 'one missed pong cannot retire a host');
  // Ordinary successful reads do not substitute for the liveness exchange.
  await native[0]!.catalog();
  t.mock.timers.tick(100);
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
  t.mock.timers.tick(100);
  await until(() => server.controlFrames.filter(frame => frame._tag === 'Ping').length === 3);
  // The config response follows Pong on the same socket, so this drains it.
  await native[1]!.catalog();
  t.mock.timers.tick(100);
  await native[1]!.catalog();
  assert.equal(connection.status().connected, true);
  connection.close();
  await until(() => server.closes === 2);
  const pings = server.controlFrames.filter(frame => frame._tag === 'Ping').length;
  t.mock.timers.tick(1_000);
  assert.equal(server.controlFrames.filter(frame => frame._tag === 'Ping').length, pings, 'close cancels heartbeat timers');
});
