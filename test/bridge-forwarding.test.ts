import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, rmSync, realpathSync, writeFileSync, readFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import { ServiceBridgeUnavailable } from '../hosts/paseo/plugin/bridge';
import { QueueRuntime } from '../service/runtime-owner';
import type { Adapter } from '../core/host';
import { readServiceInfo, writeServiceInfo } from '../service/transport/identity';
import { currentServiceBuildId } from '../shared/service/build';
import { RPC_CATALOGUE } from '../shared/rpc-catalogue';
import * as contracts from '../shared/contracts';
import { bridgeSupport } from './support/bridge-fixture';

// Split from bridge.test.ts so the slow service-spawn tests run in parallel files.
const { spawnedPids, fakeAdapter, serviceCommand, bridgeFixture, trackedBridge, killServices, dispose, pidAliveNumber, sleep } = bridgeSupport('nb1');
void spawnedPids; void fakeAdapter; void serviceCommand; void pidAliveNumber; void sleep;

test('the bridge forwards board reads through the service it spawns and reports a typed state', async () => {
  const { bridge, dataDir, paseoHome, root } = await bridgeFixture();
  try {
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    const before = bridge.current();
    assert.equal(before.state, 'absent');
    const state = await bridge.forward(entry, {}) as Record<string, unknown>;
    assert.ok(Array.isArray(state.tasks), 'forwarded ui-snapshot must be a validated board projection');
    const running = bridge.current();
    assert.equal(running.state, 'running');
    const typed = await bridge.serviceState();
    assert.equal(typed.state, 'running');
    assert.ok(existsSync(readServiceInfo(dataDir)!.socketPath));
    // A second forward reuses the same connected client without respawning.
    const info = readServiceInfo(dataDir)!;
    const second = await bridge.forward(entry, {}) as Record<string, unknown>;
    assert.ok(Array.isArray(second.tasks));
    assert.deepEqual(readServiceInfo(dataDir)!, info, 'no respawn happened for a healthy service');
    void paseoHome;
  } finally {
    bridge.close();
    await dispose(root);
  }
});

test('service-state adopts a live service without any preceding forwarded RPC', async () => {
  const { bridge, dataDir, paseoHome, root } = await bridgeFixture();
  let spawns = 0;
  const observer = trackedBridge({ dataDir, paseoHome, serviceCommand: () => { spawns++; return serviceCommand(); } });
  try {
    await bridge.forward(RPC_CATALOGUE.find(entry => entry.name === 'queue.ui-snapshot')!, {});
    const original = readServiceInfo(dataDir)!;
    const state = await observer.serviceState();
    assert.equal(state.state, 'running');
    assert.equal(state.pid, original.pid);
    assert.equal(spawns, 0);
    assert.deepEqual(readServiceInfo(dataDir), original);
  } finally {
    observer.close(); bridge.close(); await dispose(root);
  }
});

test('service-state alone starts an absent service', async () => {
  const { bridge, dataDir, root } = await bridgeFixture();
  try {
    const state = await bridge.serviceState();
    assert.equal(state.state, 'running');
    assert.equal(state.pid, readServiceInfo(dataDir)?.pid);
  } finally { bridge.close(); await dispose(root); }
});

test('a dead identity with an already missing socket does not prevent respawn', async () => {
  const { bridge, dataDir, root } = await bridgeFixture();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeServiceInfo(dataDir, { protocolVersion: 1, buildId: currentServiceBuildId(), socketPath: join(dataDir, 'queue-service.sock'), credential: 'a'.repeat(64), pid: 999_999_999, startedAt: new Date(0).toISOString() });
    await bridge.forward(RPC_CATALOGUE.find(entry => entry.name === 'queue.ui-snapshot')!, {});
    assert.equal(bridge.current().state, 'running');
    assert.notEqual(readServiceInfo(dataDir)?.pid, 999_999_999);
  } finally { bridge.close(); await dispose(root); }
});

test('an unreadable backend set refuses service comparison before spawn', async () => {
  const { dataDir, root } = await bridgeFixture();
  let spawns = 0;
  const bridge = trackedBridge({ dataDir, sourcePath: join(root, 'missing-source'), serviceCommand: () => { spawns++; return serviceCommand(); } });
  try {
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    await assert.rejects(() => bridge.forward(entry, {}), /Cannot read backend source set/);
    assert.equal(bridge.current().state, 'unhealthy');
    assert.equal(spawns, 0);
  } finally {
    bridge.close();
    await dispose(root);
  }
});
