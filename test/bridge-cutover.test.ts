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
const { spawnedPids, fakeAdapter, serviceCommand, bridgeFixture, trackedBridge, killServices, dispose, pidAliveNumber, sleep } = bridgeSupport('nb3');
void spawnedPids; void fakeAdapter; void serviceCommand; void pidAliveNumber; void sleep;

test('first cutover: a live old backend blocks the service fail-closed, then hands over cleanly', async () => {
  const { bridge, dataDir, paseoHome, root } = await bridgeFixture();
  try {
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    // The old backend (pre-cutover plugin shape) still owns the lease.
    const legacy = new QueueRuntime({ dataDir, adapterFactory: () => fakeAdapter(root), timers: false });
    const outcome = await bridge.forward(entry, {}).then(
      () => 'result',
      (error: unknown) => error instanceof ServiceBridgeUnavailable ? error.state : 'transport',
    );
    assert.ok(outcome === 'unhealthy' || outcome === 'absent' || outcome === 'starting',
      `the bridge must report a typed state while the old backend owns the lease (got ${outcome})`);
    // The blocked spawn left no writable second owner: the legacy owner's lease stands.
    assert.equal(legacy.store.getMeta<{ pid: number }>("processOwner")?.pid, process.pid);
    // Handover: the old backend drains and releases the lease, then the bridge ensures the service.
    await legacy.drain();
    const state = await bridge.forward(entry, {}) as Record<string, unknown>;
    assert.ok(Array.isArray(state.tasks), 'after the old backend releases the lease the service takes over and serves reads');
    assert.equal(bridge.current().state, 'running');
    // The service this file started is owned by the bridge's own spawn record:
    // a pid read back from the service's identity file never creates one.
    assert.ok(readServiceInfo(dataDir)?.pid, 'the running service publishes its identity');
    void paseoHome;
  } finally {
    bridge.close();
    await dispose(root);
  }
});

test('a stale spawn claim from a dead bridge is reclaimed, not waited on', async () => {
  const { bridge, dataDir, paseoHome, root } = await bridgeFixture();
  try {
    // A bridge that died between claiming and spawning left its claim behind:
    // dead pid, older than the fresh window. It must not block the next spawn.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'queue-service.claim.json'), JSON.stringify({ pid: 999_999_999, at: new Date(Date.now() - 3_600_000).toISOString() }), { mode: 0o600 });
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    let spawnAttempts = 0;
    const counter = () => { spawnAttempts++; return serviceCommand(); };
    const reviving = trackedBridge({ dataDir, paseoHome, readinessPollMs: 10, serviceCommand: counter, readinessBudgetMs: 25_000 });
    try {
      const state = await reviving.forward(entry, {}) as Record<string, unknown>;
      assert.ok(Array.isArray(state.tasks), 'a stale claim is reclaimed and the service starts');
      assert.equal(spawnAttempts, 1, 'the reclaimed stale claim lets our bridge spawn');
      assert.ok(!existsSync(join(dataDir, 'queue-service.claim.json')), 'the reclaimed claim is released after readiness');
      assert.equal(reviving.current().state, 'running');
      assert.ok(readServiceInfo(dataDir)?.pid, 'the reclaimed claim spawned a service that publishes its identity');
    } finally {
      reviving.close();
    }
    void bridge;
  } finally {
    await dispose(root);
  }
});

test('two bridges racing an absent service spawn exactly one service', async () => {
  const { dataDir, paseoHome, root } = await bridgeFixture();
  let spawnAttempts = 0;
  const spawnCounter = () => { spawnAttempts++; return serviceCommand(); };
  const bridgeA = trackedBridge({ dataDir, paseoHome, readinessPollMs: 10, serviceCommand: spawnCounter, readinessBudgetMs: 25_000 });
  const bridgeB = trackedBridge({ dataDir, paseoHome, readinessPollMs: 10, serviceCommand: spawnCounter, readinessBudgetMs: 25_000 });
  try {
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    const [a, b] = await Promise.all([bridgeA.forward(entry, {}), bridgeB.forward(entry, {})]) as Record<string, unknown>[];
    assert.ok(Array.isArray(a.tasks) && Array.isArray(b.tasks), 'both bridges end up served by the one compatible service');
    assert.ok(spawnAttempts <= 1, `the spawn claim must suppress duplicate spawns (attempts: ${spawnAttempts})`);
    assert.ok(readServiceInfo(dataDir)?.pid, 'the one service that won the race publishes its identity');
    assert.ok(!existsSync(join(dataDir, 'queue-service.claim.json')), 'the winning bridge releases the claim after readiness');
    assert.equal(bridgeA.current().state, 'running');
    assert.equal(bridgeB.current().state, 'running');
  } finally {
    bridgeA.close();
    bridgeB.close();
    await dispose(root);
  }
});

test('the bridge exposes the typed service-state contract for operators', async () => {
  const { bridge, root } = await bridgeFixture();
  try {
    const state = await bridge.serviceState();
    const parsed = (contracts.serviceState.output as { parse: (value: unknown) => { state: string; detail: string } }).parse(state);
    assert.equal(parsed.state, 'running');
    assert.ok(typeof parsed.detail === 'string');
  } finally {
    bridge.close();
    await dispose(root);
  }
});
