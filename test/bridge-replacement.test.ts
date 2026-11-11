import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, rmSync, realpathSync, writeFileSync, readFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import { ServiceBridgeUnavailable } from '../hosts/paseo/plugin/bridge';
import { QueueRuntime } from '../service/runtime-owner';
import type { Adapter } from '../core/host';
import { readServiceInfo, writeServiceInfo } from '../service/transport/identity';
import { currentServiceBuildId } from '../shared/service/build';
import { RPC_CATALOGUE } from '../shared/rpc-catalogue';
import * as contracts from '../shared/contracts';
import { bridgeSupport } from './support/bridge-fixture';
import { standbyReadyPath } from '../service/install/standby';

// Split from bridge.test.ts so the slow service-spawn tests run in parallel files.
const { spawnedPids, fakeAdapter, serviceCommand, bridgeFixture, trackedBridge, killServices, dispose, pidAliveNumber, sleep } = bridgeSupport('nb2');
void fakeAdapter; void killServices;

test('an incompatible service build is drained and replaced, never restarted in place', async () => {
  const { bridge, dataDir, root, paseoHome } = await bridgeFixture();
  try {
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    // Put a protocol-compatible but build-incompatible fake service in place.
    const { spawn } = await import('node:child_process');
    const fake = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/incompatible-service.mjs', import.meta.url))], { detached: true, stdio: 'ignore', env: { ...process.env, PASEO_HOME: paseoHome } });
    fake.unref();
    if (fake.pid) spawnedPids.recordOwnSpawn(fake.pid);
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(dataDir, 'queue-service.json')) && Date.now() < deadline) await sleep(100);
    assert.ok(existsSync(join(dataDir, 'queue-service.json')), 'fixture service published its identity');
    const forged = readServiceInfo(dataDir)!;
    assert.equal(forged.buildId, 'incompatible-build');
    const replaced = await bridge.forward(entry, {}) as Record<string, unknown>;
    assert.ok(Array.isArray(replaced.tasks), 'the incompatible service is drained and a compatible one takes over');
    const fresh = readServiceInfo(dataDir)!;
    assert.equal(fresh.buildId, currentServiceBuildId(), 'the replacement service advertises the bridge build identity');
    assert.equal(bridge.current().state, 'running');
  } finally {
    bridge.close();
    await dispose(root);
  }
});

test('a service in the same login session is kept', async () => {
  const { bridge, dataDir, root, paseoHome } = await bridgeFixture();
  const observer = trackedBridge({ dataDir, paseoHome, readinessPollMs: 10, serviceCommand });
  try {
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    await bridge.forward(entry, {});
    const original = readServiceInfo(dataDir)!;
    assert.ok(original.sessionId);
    const same = trackedBridge({ dataDir, paseoHome, readinessPollMs: 10, serviceCommand, sessionId: original.sessionId });
    await same.forward(entry, {});
    assert.deepEqual(readServiceInfo(dataDir), original, 'the same login session reuses the live service');
    same.close();
    observer.close();
  } finally {
    bridge.close();
    await dispose(root);
  }
});

test('a service in a different login session is drained and replaced', async () => {
  const { bridge, dataDir, root, paseoHome } = await bridgeFixture();
  let spawns = 0;
  const other = trackedBridge({
    dataDir, paseoHome, sessionId: 'other-session',
    serviceCommand: () => { spawns++; return serviceCommand(); },
  });
  try {
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    await bridge.forward(entry, {});
    const original = readServiceInfo(dataDir)!;
    assert.ok(original.sessionId);
    assert.notEqual(original.sessionId, 'other-session');
    const replaced = await other.forward(entry, {}) as Record<string, unknown>;
    assert.ok(Array.isArray(replaced.tasks), 'the other-session bridge drains the previous service and serves reads');
    const fresh = readServiceInfo(dataDir)!;
    assert.notEqual(fresh.pid, original.pid);
    assert.equal(fresh.sessionId, 'other-session');
    assert.ok(spawns >= 1);
    assert.equal(other.current().state, 'running');
  } finally {
    other.close();
    bridge.close();
    await dispose(root);
  }
});

test('an absent service is spawned from the installed checkout and stale ownership never duplicates a spawn', async () => {
  const { bridge, dataDir, root, paseoHome } = await bridgeFixture();
  try {
    // First forward spawns the service.
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    await bridge.forward(entry, {});
    const firstInfo = readServiceInfo(dataDir)!;
    bridge.close();
    // Simulate a crash: kill the owner process, then remove its identity and socket.
    try { process.kill(firstInfo.pid, 'SIGKILL'); } catch {}
    for (let i = 0; i < 50 && !!(function pidCheck() { try { process.kill(firstInfo.pid, 0); return true; } catch { return false; } })(); i++) await sleep(100);
    rmSync(join(dataDir, 'queue-service.json'), { force: true });
    // A closed bridge never spawns again; a reload builds a fresh bridge, which respawns.
    const reloaded = trackedBridge({ dataDir, paseoHome, readinessPollMs: 10, serviceCommand, readinessBudgetMs: 60_000 });
    const respawned = await reloaded.forward(entry, {}) as Record<string, unknown>;
    assert.ok(Array.isArray(respawned.tasks), 'a definitely absent service is spawned and serves reads');
    const secondInfo = readServiceInfo(dataDir)!;
    assert.notEqual(secondInfo.pid, firstInfo.pid, 'a new service process replaced the dead one');
    // A live but unreachable service must not spawn a duplicate.
    writeFileSync(join(dataDir, 'queue-service.json'), JSON.stringify({ ...secondInfo, pid: process.pid, socketPath: join(dataDir, 'ghost.sock') }), { mode: 0o600 });
    const observer = trackedBridge({ dataDir, paseoHome, readinessPollMs: 10, serviceCommand, readinessBudgetMs: 60_000 });
    await assert.rejects(() => observer.forward(entry, {}), /alive but is not answering|not answering/);
    assert.equal(observer.current().state === 'starting' || observer.current().state === 'unhealthy', true);
    assert.ok(!existsSync(join(dataDir, 'ghost.sock')), 'no duplicate service was spawned over an uncertain owner');
    assert.equal(existsSync(join(dataDir, 'queue-service.claim.json')), false, 'the spawn claim is released after readiness');
    // Remove the forged identity before cleanup so no cleanup step ever
    // signals a process it did not own.
    rmSync(join(dataDir, 'queue-service.json'), { force: true });
  } finally {
    bridge.close();
    await dispose(root);
  }
});

test('an unresponsive live owner is replaced by a standby, never a second writer', async () => {
  const { bridge, dataDir, root, paseoHome } = await bridgeFixture();
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  dummy.unref();
  if (dummy.pid) spawnedPids.recordOwnSpawn(dummy.pid);
  try {
    const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
    await bridge.forward(entry, {});
    const original = readServiceInfo(dataDir)!;
    bridge.close();
    try { process.kill(original.pid, 'SIGKILL'); } catch { /* already gone */ }
    for (let i = 0; i < 50 && pidAliveNumber(original.pid); i++) await sleep(100);
    assert.ok(dummy.pid);
    writeServiceInfo(dataDir, {
      protocolVersion: original.protocolVersion,
      buildId: 'incompatible-build',
      socketPath: join(dataDir, 'gone.sock'),
      credential: original.credential,
      pid: dummy.pid,
      startedAt: new Date().toISOString(),
      sessionId: original.sessionId,
    });
    let standbyPid = 0;
    const replacement = trackedBridge({ dataDir, paseoHome, readinessPollMs: 10, serviceCommand, readinessBudgetMs: 60_000, onSpawn: pid => { standbyPid = pid; } });
    const pending = replacement.forward(entry, {});
    const deadline = Date.now() + 60_000;
    while ((!standbyPid || !existsSync(standbyReadyPath(dataDir, standbyPid))) && Date.now() < deadline) await sleep(10);
    assert.ok(standbyPid && existsSync(standbyReadyPath(dataDir, standbyPid)), 'standby reports ready');
    assert.equal(readServiceInfo(dataDir)?.pid, dummy.pid, 'the live owner is not overwritten while it is alive');
    try { process.kill(dummy.pid, 'SIGKILL'); } catch { /* already gone */ }
    for (let i = 0; i < 50 && pidAliveNumber(dummy.pid); i++) await sleep(100);
    const served = await pending as Record<string, unknown>;
    assert.ok(Array.isArray(served.tasks), 'the standby takes over once the owner exits');
    assert.notEqual(readServiceInfo(dataDir)?.pid, dummy.pid);
    replacement.close();
  } finally {
    try { if (dummy.pid) process.kill(dummy.pid, 'SIGKILL'); } catch { /* gone */ }
    await dispose(root);
  }
});
