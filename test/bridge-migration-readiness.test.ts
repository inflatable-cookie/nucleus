import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RPC_CATALOGUE } from '../shared/rpc-catalogue';
import { readServiceInfo } from '../service/transport/identity';
import {
  MAINTENANCE_READINESS_CAP_MS, maintenanceMarkerPath, maintenanceMs, markMaintenance, markMigration,
  migrationMarkerPath, migrationMs, MIGRATION_READINESS_CAP_MS, startupExtensionMs,
} from '../service/install/standby';
import { COMPACTION_MAX_BLOCKED_MS } from '../core/store/store-compaction';
import { bridgeSupport } from './support/bridge-fixture';

// The 2026-10-21 schema 43 roll: a start that migrates its store outlasted the
// fixed readiness budget, so the bridge called it unhealthy and retried beside it.
const { spawnedPids, bridgeFixture, trackedBridge, killServices, dispose } = bridgeSupport('nb5');
const entry = RPC_CATALOGUE.find(candidate => candidate.name === 'queue.ui-snapshot')!;
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const migratingService = () => ({ command: process.execPath, args: ['--import', 'tsx', fileURLToPath(new URL('./fixtures/migrating-service.mjs', import.meta.url))] });

test('a start that reports migrating its store is waited for past the readiness budget, with one spawn', async () => {
  const { dataDir, paseoHome, root } = await bridgeFixture();
  process.env.FIXTURE_MIGRATION_MS = '1';
  process.env.FIXTURE_GATE_PHASE = 'migration';
  process.env.FIXTURE_RELEASE_FILE = join(root, 'release');
  let spawns = 0, pid = 0, clock = Date.now(), clockReads = 0;
  const bridge = trackedBridge({ dataDir, paseoHome, readinessBudgetMs: 2_000, readinessPollMs: 10, readinessNow: () => { clockReads++; return clock; }, onSpawn: child => { pid = child; }, serviceCommand: () => { spawns++; return migratingService(); } });
  try {
    const forwarded = bridge.forward(entry, {});
    // The waiting bridge keeps its spawn claim fresh (Sol, #574): an aged claim is
    // rewritten, so a second bridge sees a live spawn instead of spawning beside it.
    const claimPath = join(dataDir, 'queue-service.claim.json');
    await waitFor(() => pid > 0 && existsSync(migrationMarkerPath(dataDir, pid)));
    clock = Date.now() + 10_000;
    const aged = new Date(Date.now() - 46_000).toISOString();
    writeFileSync(claimPath, JSON.stringify({ ...JSON.parse(readFileSync(claimPath, 'utf8')), at: aged }));
    const readsBefore = clockReads;
    await waitFor(() => clockReads > readsBefore + 2 && JSON.parse(readFileSync(claimPath, 'utf8')).at !== aged);
    assert.ok(Date.now() - Date.parse(JSON.parse(readFileSync(claimPath, 'utf8')).at) < 5_000, 'the claim is fresh again');
    const second = trackedBridge({ dataDir, paseoHome, readinessBudgetMs: 10_000, readinessPollMs: 10, serviceCommand: () => { spawns++; return migratingService(); } });
    const secondForward = second.forward(entry, {});
    writeFileSync(process.env.FIXTURE_RELEASE_FILE!, 'go');
    const state = await forwarded as Record<string, unknown>;
    await secondForward.catch(() => null);
    second.close();
    assert.ok(Array.isArray(state.tasks), 'the migrated service serves reads');
    assert.equal(bridge.current().state, 'running');
    assert.equal(spawns, 1, 'no second service is spawned beside a migrating one');
    const serving = readServiceInfo(dataDir)!;
    assert.equal(existsSync(migrationMarkerPath(dataDir, serving.pid)), false, 'the bridge clears the marker once it is done waiting');
  } finally {
    writeFileSync(process.env.FIXTURE_RELEASE_FILE!, 'go');
    delete process.env.FIXTURE_MIGRATION_MS; delete process.env.FIXTURE_GATE_PHASE; delete process.env.FIXTURE_RELEASE_FILE;
    bridge.close();
    await dispose(root);
  }
});

test('a silent slow start still fails at the readiness budget', async () => {
  const { dataDir, paseoHome, root } = await bridgeFixture();
  process.env.FIXTURE_MIGRATION_MS = '60000';
  process.env.FIXTURE_NO_MARKER = '1';
  let clock = Date.now(), pid = 0;
  const bridge = trackedBridge({ dataDir, paseoHome, readinessBudgetMs: 2_000, readinessPollMs: 10, readinessNow: () => clock, onSpawn: child => { pid = child; }, serviceCommand: migratingService });
  try {
    const started = Date.now();
    const rejected = assert.rejects(bridge.forward(entry, {}));
    await waitFor(() => pid > 0);
    clock += 3_000;
    await rejected;
    assert.ok(Date.now() - started < 20_000, 'the ordinary bound still applies without a migration marker');
    assert.match(bridge.current().detail, /did not become ready within the bounded window/);
  } finally {
    delete process.env.FIXTURE_MIGRATION_MS; delete process.env.FIXTURE_NO_MARKER;
    bridge.close();
    await dispose(root);
  }
});

test('a migration marker extends only the spawn that wrote it, within the cap', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'nsq-migration-marker-'));
  try {
    const pid = 4242, now = Date.now();
    markMigration(dataDir, pid, 'spawn-a', now - 30_000);
    assert.equal(migrationMs(dataDir, pid, 'spawn-a', now), 30_000, 'an unfinished migration counts up to now');
    assert.equal(migrationMs(dataDir, pid, 'spawn-b', now), 0, 'a marker another spawn left (a recycled pid) never extends this one');
    assert.equal(migrationMs(dataDir, pid, undefined, now), 0, 'a start without a spawn token is never extended');
    assert.equal(migrationMs(dataDir, pid + 1, 'spawn-a', now), 0);
    markMigration(dataDir, pid, 'spawn-a', now - 30_000, now - 10_000);
    assert.equal(migrationMs(dataDir, pid, 'spawn-a', now), 20_000, 'a finished migration counts its duration only');
    markMigration(dataDir, pid, 'spawn-a', now - 3_600_000);
    assert.equal(migrationMs(dataDir, pid, 'spawn-a', now), MIGRATION_READINESS_CAP_MS, 'the extension is capped');
    markMigration(dataDir, pid, undefined, now);
    assert.equal(JSON.parse(readFileSync(migrationMarkerPath(dataDir, pid), 'utf8')).token, 'spawn-a', 'a tokenless start writes no marker');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('a bounded store-maintenance window is waited for by the roll, with one replacement', async () => {
  const { dataDir, paseoHome, root } = await bridgeFixture();
  // The one-shot conversion's window is the service's own bounded work, admitted durably
  // before it runs. A roll that only allowed its ordinary budget would call the replacement
  // hung while it is converting the store, and retry beside it.
  process.env.FIXTURE_MAINTENANCE_MS = '1';
  process.env.FIXTURE_GATE_PHASE = 'maintenance';
  process.env.FIXTURE_RELEASE_FILE = join(root, 'release');
  let spawns = 0, pid = 0, clock = Date.now(), clockReads = 0;
  const secondClock = Date.now();
  const bridge = trackedBridge({ dataDir, paseoHome, readinessBudgetMs: 2_000, readinessPollMs: 10, readinessNow: () => { clockReads++; return clock; }, onSpawn: child => { pid = child; }, serviceCommand: () => { spawns++; return migratingService(); } });
  try {
    const forwarded = bridge.forward(entry, {});
    // Keep the competing bridge's bounded wait under test control too. Its
    // real-time budget could expire under a loaded QA runner before the first
    // service finished its admitted maintenance window.
    const second = trackedBridge({ dataDir, paseoHome, readinessBudgetMs: 10_000, readinessPollMs: 10, readinessNow: () => secondClock, serviceCommand: () => { spawns++; return migratingService(); } });
    const secondForward = second.forward(entry, {});
    await waitFor(() => pid > 0 && existsSync(maintenanceMarkerPath(dataDir, pid)));
    const claimPath = join(dataDir, 'queue-service.claim.json');
    const aged = new Date(Date.now() - 46_000).toISOString();
    writeFileSync(claimPath, JSON.stringify({ ...JSON.parse(readFileSync(claimPath, 'utf8')), at: aged }));
    clock = Date.now() + 10_000;
    const readsBefore = clockReads;
    await waitFor(() => clockReads > readsBefore + 2 && existsSync(claimPath) && JSON.parse(readFileSync(claimPath, 'utf8')).at !== aged);
    clock = Date.now();
    writeFileSync(process.env.FIXTURE_RELEASE_FILE!, 'go');
    const state = await forwarded as Record<string, unknown>;
    await secondForward.catch(() => null);
    second.close();
    assert.ok(Array.isArray(state.tasks), 'the replacement serves reads once its window finished');
    assert.equal(bridge.current().state, 'running');
    assert.equal(spawns, 1, 'no second replacement is started beside a service in its maintenance window');
    const serving = readServiceInfo(dataDir)!;
    assert.equal(existsSync(maintenanceMarkerPath(dataDir, serving.pid)), false, 'the bridge clears the marker once it is done waiting');
  } finally {
    writeFileSync(process.env.FIXTURE_RELEASE_FILE!, 'go');
    delete process.env.FIXTURE_MAINTENANCE_MS; delete process.env.FIXTURE_GATE_PHASE; delete process.env.FIXTURE_RELEASE_FILE;
    bridge.close();
    await dispose(root);
  }
});

test('a maintenance marker extends only the spawn that wrote it, inside its own cap', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'nsq-maintenance-marker-'));
  try {
    const pid = 4343, now = Date.now();
    assert.ok(MAINTENANCE_READINESS_CAP_MS >= COMPACTION_MAX_BLOCKED_MS + 30_000,
      'the roll waits out a full conversion window plus its snapshot and start-up phases');
    markMaintenance(dataDir, pid, 'spawn-a', now - 30_000);
    assert.equal(maintenanceMs(dataDir, pid, 'spawn-a', now), 30_000, 'an open window counts up to now');
    assert.equal(maintenanceMs(dataDir, pid, 'spawn-b', now), 0, 'another spawn\'s marker never extends this one');
    assert.equal(maintenanceMs(dataDir, pid, undefined, now), 0, 'a start without a spawn token is never extended');
    markMaintenance(dataDir, pid, 'spawn-a', now - 30_000, now - 12_000);
    assert.equal(maintenanceMs(dataDir, pid, 'spawn-a', now), 18_000, 'a finished window counts its duration only');
    markMaintenance(dataDir, pid, 'spawn-a', now - 3_600_000);
    assert.equal(maintenanceMs(dataDir, pid, 'spawn-a', now), MAINTENANCE_READINESS_CAP_MS, 'the extension is capped');
    // The two phases are separate markers and are counted once each, never twice.
    markMigration(dataDir, pid, 'spawn-a', now - 20_000, now - 15_000);
    assert.equal(startupExtensionMs(dataDir, pid, 'spawn-a', now), MAINTENANCE_READINESS_CAP_MS + 5_000);
    assert.equal(startupExtensionMs(dataDir, pid, 'spawn-b', now), 0);
    markMaintenance(dataDir, pid, undefined, now);
    assert.equal(existsSync(maintenanceMarkerPath(dataDir, pid)), true, 'a tokenless start writes no marker over a live one');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
