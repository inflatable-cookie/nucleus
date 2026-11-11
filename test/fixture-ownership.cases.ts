import { test, weighted, currentShard } from "./support/sharded-test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readServiceInfo, writeServiceInfo, SERVICE_STARTUP_FAILURE_FILE } from "../service/transport/identity";
import { currentServiceBuildId, SERVICE_PROTOCOL_VERSION } from "../shared/service/build";
import { processCommandLine } from "../core/machine/process-identity";
import { RPC_CATALOGUE } from "../shared/rpc-catalogue";
import { bridgeInFlightWork, bridgeSupport, livenessFromProbeError, processLiveness, recordSpawnIdentity, serviceOwnershipVerdict } from "./support/bridge-fixture";

/**
 * Fixture ownership: a spawn-heavy roll file's services must settle even when
 * its test cannot (2026-10-15 milestone QA: a timeout-cancelled test left a
 * detached fixture service running outside the QA root). These focused tests
 * exercise the guard's parts directly: spawn-record ownership, the closed
 * bridge's refusal to start anything, close-all-before-sweep, and the proof
 * that a fixture's own service and the group it led are gone before the
 * fixture's disposable data directory is removed.
 *
 * Milestone 3bf3e818 (2026-10-31) is the reason ownership is a record and not a
 * command line: `bridge-migration-readiness` starts the service through
 * `test/fixtures/migrating-service.mjs`, which imports the queue-service entry
 * into its own process and keeps the wrapper's argv. Matching `queue-service.mjs`
 * in argv called that live, fixture-owned service `foreign`, teardown never
 * signalled it, and its startup snapshot was still being written into
 * `<root>/northstar-queue/backups` while the test removed the directory
 * (`ENOTEMPTY`). The leak case uses its own guard instance, because a passing
 * file here is the proof: the leaked service is alive when the test ends, so
 * only the file-level guard can have settled it.
 */
const shardTag = String(currentShard().index);
const leaked = bridgeSupport(`nsfoa${shardTag}`);
const owned = bridgeSupport(`nsfob${shardTag}`);
const wrappers = bridgeSupport(`nsfoc${shardTag}`);
/** A guard with a short proof window, for the teardown that must not report clean. */
const unproved = bridgeSupport(`nsfod${shardTag}`, { teardownWaitMs: 1_500 });
/** A guard whose only candidate target is discovered from an identity file. */
const discovered = bridgeSupport(`nsfoe${shardTag}`, { teardownWaitMs: 1_200 });
/** A guard with headroom to let an abandoned spawn attempt settle. */
const inflight = bridgeSupport(`nsoff${shardTag}`, { teardownWaitMs: 20_000 });
/** A guard with a short proof window, for the disposal that must refuse a root. */
const undisposed = bridgeSupport(`nsofg${shardTag}`, { teardownWaitMs: 1_200 });
/**
 * Every identity read this file makes, in order, with the first read of each pid
 * answered unreadably. A second read of the same spawn would hand back a real
 * identity, which is exactly how a spawn record could be upgraded into proof.
 */
const identityReads: Array<{ pid: number }> = [];
const singleRead = bridgeSupport(`nsofh${shardTag}`, {
  teardownWaitMs: 1_500,
  startIdentity: pid => {
    identityReads.push({ pid });
    return identityReads.filter(read => read.pid === pid).length === 1 ? `${pid}@unknown` : `${pid}@2026-10-31T15:00:00Z`;
  },
});

const repo = fileURLToPath(new URL('..', import.meta.url));

/**
 * A fixture service whose process keeps a wrapper's argv: the same shape
 * `bridge-migration-readiness` uses for its migration and maintenance phases.
 */
const wrapperCommand = () => ({ command: process.execPath, args: ['--import', 'tsx', join(repo, 'test/fixtures/migrating-service.mjs')] });

/** A ready fixture service with its spawn owned by the guard, on an isolated dir. */
async function startedFixture(trackedBridge: typeof owned.trackedBridge, prefix: string, command = owned.serviceCommand) {
  prefix = `${prefix}${shardTag}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const dataDir = join(root, 'northstar-queue');
  writeFileSync(join(root, 'config.json'), JSON.stringify({ plugins: { nucleus: { path: fileURLToPath(new URL('..', import.meta.url)) } } }), { mode: 0o600 });
  const bridge = trackedBridge({ dataDir, paseoHome: root, serviceCommand: command, readinessBudgetMs: 60_000 });
  const before = await bridge.serviceState();
  return { root, dataDir, bridge, before };
}

/** Wait for the live service's own startup snapshot, the write the milestone's disposal raced. */
async function startupSnapshots(dataDir: string, budgetMs: number): Promise<string[]> {
  const deadline = Date.now() + budgetMs;
  const dir = join(dataDir, 'backups');
  while (Date.now() < deadline) {
    try {
      const names = readdirSync(dir);
      if (names.length) return names;
    } catch { /* the service has not written its snapshot yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return [];
}

/**
 * The ownership rule itself, on recorded evidence. This is where the milestone
 * defect lives: the fixture spawned the process, so its record owns it, and the
 * wrapper's argv (which names no `queue-service.mjs`) says nothing about that.
 */
test('a fixture spawn is owned by its record, and no command line owns or clears a pid', () => {
  const spawned = { alive: true, zombie: false, pid: 4242, spawned: true, groupId: 4242 };
  const recordedIdentity = '4242@2026-10-31T12:48:21Z';

  // The wrapper shape is why argv is not ownership: it names no service entry,
  // yet it is the fixture's own live service.
  assert.equal(serviceOwnershipVerdict({ ...spawned, recordedIdentity, liveIdentity: recordedIdentity }), 'ours',
    'the spawn record owns the wrapper process it started, whatever its argv says');

  // Safety: a recycled number, an unreadable identity and a zombie are never ours.
  assert.equal(serviceOwnershipVerdict({ ...spawned, recordedIdentity, liveIdentity: '4242@2026-10-31T13:02:07Z' }), 'foreign',
    'a recycled pid no longer matches the recorded start identity');
  assert.equal(serviceOwnershipVerdict({ ...spawned, recordedIdentity, liveIdentity: null }), 'unknown',
    'an unreadable identity is never a signal and never a clean teardown');
  assert.equal(serviceOwnershipVerdict({ ...spawned, recordedIdentity: '4242@unknown', liveIdentity: '4242@unknown' }), 'unknown');
  assert.equal(serviceOwnershipVerdict({ ...spawned, recordedIdentity, liveIdentity: recordedIdentity, groupId: 7 }), 'foreign',
    'the process that owns the record is the leader of the group teardown signals');
  assert.equal(serviceOwnershipVerdict({ ...spawned, recordedIdentity, liveIdentity: recordedIdentity, groupId: null }), 'unknown');
  assert.equal(serviceOwnershipVerdict({ ...spawned, alive: false, recordedIdentity, liveIdentity: null }), 'gone');
  assert.equal(serviceOwnershipVerdict({ ...spawned, zombie: true, recordedIdentity, liveIdentity: recordedIdentity }), 'gone',
    'a reaped-but-uncollected zombie answers signals but is already dead');

  // A pid this file did not spawn is unproved while it is alive, and no command
  // line changes that: a wrapper omits the entry it imported, so argv absence
  // says nothing about who owns the process (review 5723080357).
  assert.equal(serviceOwnershipVerdict({ alive: true, zombie: false, pid: 4242, spawned: false, recordedIdentity, liveIdentity: recordedIdentity, groupId: 4242 }), 'unknown',
    'a pid this file did not spawn is never ours and never clean');
});

weighted(3)('the file guard settles a fixture service its test leaked', async () => {
  const { trackedBridge, spawnedPids, serviceProof, pidAliveNumber } = leaked;
  const { bridge, before } = await startedFixture(trackedBridge, 'nsfoa');
  assert.equal(before.state, 'running', before.detail);
  assert.ok(before.pid && pidAliveNumber(before.pid), 'the fixture service is alive and deliberately left behind');
  assert.ok(before.pid && spawnedPids.has(before.pid), 'the spawn-ownership hook tracked the pid before any identity file existed');
  assert.equal(serviceProof(before.pid!), 'ours', 'the leaked service is this file\'s own spawn');
  // No cleanup on purpose: this file passes only if the nsfoa guard settled it.
});

weighted(3)('the file guard settles a wrapper service its test leaked', async () => {
  const { trackedBridge, spawnedPids, serviceProof, pidAliveNumber } = leaked;
  process.env.FIXTURE_MIGRATION_MS = '0';
  const { bridge, before } = await startedFixture(trackedBridge, 'nsfoa', wrapperCommand);
  delete process.env.FIXTURE_MIGRATION_MS;
  assert.equal(before.state, 'running', before.detail);
  assert.ok(before.pid && pidAliveNumber(before.pid), 'the wrapper service is alive and deliberately left behind');
  assert.ok(before.pid && spawnedPids.has(before.pid));
  assert.equal(serviceProof(before.pid!), 'ours', 'a wrapper keeps its own argv; the spawn record owns it');
  assert.match(processCommandLine(before.pid!) ?? '', /migrating-service\.mjs/);
  // No cleanup on purpose: cancellation is the shape, and only the nsfoa guard
  // runs after it. On the milestone's argv rule this process was called foreign
  // and leaked; the guard now owns, settles and proves it.
});

weighted(3)('a closed bridge refuses to start or spawn a service', async t => {
  const { trackedBridge, dispose } = owned;
  const { root, dataDir, bridge, before } = await startedFixture(trackedBridge, 'nsfob');
  t.after(async () => { await dispose(root); });
  assert.equal(before.state, 'running', before.detail);
  bridge.close();
  const closed = await bridge.serviceState();
  assert.equal(closed.state, 'unhealthy');
  assert.match(closed.detail, /this bridge is closed and cannot start the service/);
  const lanes = RPC_CATALOGUE.find(entry => entry.name === 'lanes');
  assert.ok(lanes);
  await assert.rejects(() => bridge.forward(lanes, {}), /this bridge is closed and cannot start the service/,
    'forwarding cannot bring a closed bridge back either');
  assert.equal(readServiceInfo(dataDir)?.pid, before.pid, 'the running service stays; no second owner was spawned');
  assert.equal(existsSync(join(dataDir, 'queue-service.claim.json')), false, 'no spawn claim was taken after close');
});

weighted(3)('the guard closes every tracked bridge before its sweep and proves the service exited', async t => {
  const { trackedBridge, serviceProof, ownedGroupEmpty, killServices, dispose } = owned;
  const { root, dataDir, bridge, before } = await startedFixture(trackedBridge, 'nsfob');
  t.after(async () => { await dispose(root); });
  assert.equal(before.state, 'running', before.detail);
  assert.equal(serviceProof(before.pid!), 'ours', 'an ordinary fixture service is owned by its spawn record');
  await killServices();
  const swept = await bridge.serviceState();
  assert.equal(swept.state, 'unhealthy');
  assert.match(swept.detail, /this bridge is closed and cannot start the service/,
    'a swept bridge can never spawn a service behind the guard');
  assert.equal(readServiceInfo(dataDir), null, 'the sweep removed the identity and stopped the service group');
  assert.equal(serviceProof(before.pid!), 'gone', 'the sweep proved this file\'s service exited');
  assert.equal(ownedGroupEmpty(before.pid!), true, 'and the group it led is empty, so no child outlives it');
});

/**
 * The fixture's own bridge is owned like any other. `bridgeFixture` used to hand
 * back an untracked bridge, so a service it started was never in the spawn
 * record: teardown could not close its admission and could only find the
 * service by scanning an identity file, which is not ownership (review
 * 5722890385).
 */
weighted(3)('the fixture bridge is tracked, so its service is owned and settled before disposal', async () => {
  const { spawnedPids, serviceProof, ownedGroupEmpty, killServices, dispose } = owned;
  const { bridge, dataDir, paseoHome, root } = await owned.bridgeFixture();
  const state = await bridge.serviceState();
  assert.equal(state.state, 'running', state.detail);
  const pid = state.pid!;
  try {
    assert.ok(spawnedPids.has(pid), 'the fixture bridge records its own spawn before any identity file exists');
    assert.equal(serviceProof(pid), 'ours', 'the fixture bridge\'s service is owned by that record');
    assert.equal(readServiceInfo(dataDir)?.pid, pid);
    await killServices();
    const closed = await bridge.serviceState();
    assert.equal(closed.state, 'unhealthy', 'teardown closed the fixture bridge\'s admission');
    assert.match(closed.detail, /this bridge is closed and cannot start the service/);
    assert.equal(serviceProof(pid), 'gone', 'and proved the service it started exited');
    assert.equal(ownedGroupEmpty(pid), true, 'with the group it led empty');
    // Disposal goes through the guard: it refuses to remove this root when the
    // settlement above could not be proved (review 5723236447).
    await dispose(root);
    assert.equal(existsSync(root), false, 'the data dir is removed only after that proof');
  } finally {
    void paseoHome;
    bridge.close();
  }
});

/**
 * The milestone's own shape: the migration wrapper's service writes its startup
 * snapshot into the directory the test disposes. Baseline teardown called that
 * live, owned process `foreign`, never signalled it, and the removal raced the
 * writer (`ENOTEMPTY` on `backups`). The assertions are the proof the brief
 * asks for: a stable owned identity, the writer it identifies, and a settled
 * process and group before disposal — not a sleep and not a lucky removal.
 */
weighted(4)('a fixture-owned migration wrapper is settled and proved gone before its data dir is disposed', async t => {
  const { trackedBridge, spawnedPids, serviceProof, ownedGroupEmpty, killServices, dispose } = wrappers;
  process.env.FIXTURE_MIGRATION_MS = '0';
  const { root, dataDir, bridge, before } = await startedFixture(trackedBridge, 'nsfoc', wrapperCommand);
  t.after(async () => {
    delete process.env.FIXTURE_MIGRATION_MS;
    bridge.close();
    await dispose(root);
  });
  assert.equal(before.state, 'running', before.detail);
  const pid = before.pid!;
  const command = processCommandLine(pid) ?? '';
  assert.ok(spawnedPids.has(pid), 'the bridge recorded this spawn itself, before any identity file existed');
  assert.equal(serviceProof(pid), 'ours', 'the fixture\'s own spawn is owned by its record, not by its command line');
  assert.match(command, /migrating-service\.mjs/, 'the wrapper process keeps the wrapper argv');
  assert.equal(command.includes('queue-service.mjs'), false, 'that argv never names the service entry it imported');

  // The live service writes its startup snapshot into the very directory the
  // fixture disposes: this is the writer, observed through its own record.
  const snapshots = await startupSnapshots(dataDir, 60_000);
  assert.ok(snapshots.length > 0, 'the running fixture service wrote a startup snapshot into <root>/northstar-queue/backups');
  assert.equal(serviceProof(pid), 'ours', 'the writer was still this file\'s owned service when it wrote');

  await killServices();
  assert.equal(serviceProof(pid), 'gone', 'the signalled wrapper service is proved exited');
  assert.equal(ownedGroupEmpty(pid), true, 'the group it led is empty, so no child writer outlives it');
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false, 'the disposable data dir is removed only after that proof');
});

weighted(3)('a fixture-owned maintenance wrapper is settled and proved gone before its data dir is disposed', async t => {
  const { trackedBridge, spawnedPids, serviceProof, ownedGroupEmpty, killServices, dispose } = wrappers;
  process.env.FIXTURE_MAINTENANCE_MS = '0';
  const { root, dataDir, bridge, before } = await startedFixture(trackedBridge, 'nsfoc', wrapperCommand);
  t.after(async () => {
    delete process.env.FIXTURE_MAINTENANCE_MS;
    bridge.close();
    await dispose(root);
  });
  assert.equal(before.state, 'running', before.detail);
  const pid = before.pid!;
  assert.ok(spawnedPids.has(pid), 'the replacement in its maintenance window is this file\'s own spawn');
  assert.equal(serviceProof(pid), 'ours', 'the wrapper\'s maintenance phase is owned by the same spawn record');
  await killServices();
  assert.equal(serviceProof(pid), 'gone', 'the maintenance wrapper is proved exited');
  assert.equal(ownedGroupEmpty(pid), true);
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(join(dataDir, 'queue-service.sock')), false, 'the identity is gone with the settled service');
  assert.equal(existsSync(root), false);
});

/**
 * Ownership is fixed at the spawn. Recording a later observation of the same
 * number would describe whatever process holds it by then — the recycled-pid
 * hole that put a foreign group under teardown's signal (review 5723330718).
 */
test('a spawn identity is recorded once and never replaced by a later observation', () => {
  const record = new Map<number, string>();
  assert.equal(recordSpawnIdentity(record, 4242, '4242@2026-10-31T12:00:00Z'), true);
  assert.equal(recordSpawnIdentity(record, 4242, '4242@2026-10-31T13:30:00Z'), false,
    'a later observation of the same number never replaces the spawn identity');
  assert.equal(record.get(4242), '4242@2026-10-31T12:00:00Z');
  assert.equal(serviceOwnershipVerdict({ alive: true, zombie: false, pid: 4242, spawned: true,
    recordedIdentity: record.get(4242)!, liveIdentity: '4242@2026-10-31T13:30:00Z', groupId: 4242 }), 'foreign',
    'so a number the OS recycled is foreign, never ours, and its group is never signalled');

  // An unreadable first observation stays unproved even if a later read succeeds.
  const unreadable = new Map<number, string>();
  assert.equal(recordSpawnIdentity(unreadable, 4243, '4243@unknown'), true);
  assert.equal(recordSpawnIdentity(unreadable, 4243, '4243@2026-10-31T13:30:00Z'), false);
  assert.equal(serviceOwnershipVerdict({ alive: true, zombie: false, pid: 4243, spawned: true,
    recordedIdentity: unreadable.get(4243)!, liveIdentity: '4243@2026-10-31T13:30:00Z', groupId: 4243 }), 'unknown',
    'a spawn this file could not identify at the time is never claimed later');
});

/**
 * The real spawn path is the one that matters: the bridge's `onSpawn` must make a
 * single identity read and keep it. Reading twice let the second observation
 * replace the first — including replacing an unreadable one with a readable
 * identity, which turns an unproved spawn into something teardown may signal
 * (review 5723412625).
 */
weighted(3)('the spawn hook records one identity read and never upgrades an unreadable one', async () => {
  const { trackedBridge, spawnedPids, serviceProof, killServices, pidAliveNumber, dispose } = singleRead;
  const { root, dataDir, bridge } = await startedFixture(trackedBridge, 'nsofh');
  const pid = readServiceInfo(dataDir)!.pid;
  let settled = false;
  try {
    assert.ok(spawnedPids.has(pid), 'the bridge recorded the spawn');
    assert.equal(identityReads.filter(read => read.pid === pid).length, 1,
      'the spawn hook made exactly one identity read; a second one could replace the spawn record');
    // That one read was unreadable, so this spawn is unproved: never signalled and
    // never settled, even though a later read of the same pid would look fine.
    assert.equal(serviceProof(pid), 'unknown', 'an unreadable spawn identity is never upgraded into proof');
    await assert.rejects(() => killServices(), /could not prove 1 service\(s\) exited/,
      'teardown reports it instead of clearing it');
    assert.equal(pidAliveNumber(pid), true, 'and never signals the process it could not identify');
  } finally {
    bridge.close();
    // This test's own child: stop it so the file guard can settle a gone pid.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && pidAliveNumber(pid)) await new Promise(resolve => setTimeout(resolve, 50));
    await dispose(root).then(() => { settled = true; }, () => { /* the guard reports it */ });
    void settled;
  }
});

/**
 * A fixture only removes its disposable root when settlement is proved. A
 * `finally` that removed the root after a thrown teardown would dispose the
 * directory behind the very process it could not rule out, which is the shape
 * the guard exists to stop (review 5723236447).
 */
test('disposal refuses to remove a root whose settlement is unproved', async () => {
  const { spawnedPids, serviceProof, ownedGroupEmpty, dispose } = undisposed;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `nsofg${shardTag}`)));
  const ready = join(dir, 'child-ready');
  const leader = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.READY, 'ready'); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: 'ignore', env: { ...process.env, READY: ready } });
  const pid = leader.pid!;
  try {
    spawnedPids.add(pid);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !existsSync(ready)) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(existsSync(ready), true, 'the group child is running with its drain handler installed');
    await assert.rejects(() => dispose(dir), /could not prove 1 service\(s\) exited/,
      'the guard never removes a root it could not prove settled');
    assert.equal(existsSync(dir), true, 'so the directory is still there for a later teardown');
    assert.equal(ownedGroupEmpty(pid), false, 'its group is exactly what could not be proved');
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the group already exited */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !ownedGroupEmpty(pid)) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(serviceProof(pid), 'gone');
    await dispose(dir);
    assert.equal(existsSync(dir), false, 'and removes it once the group is proved empty');
  }
});

/**
 * A liveness probe that fails for any reason other than `ESRCH` proves nothing:
 * the process exists but this host may not signal or inspect it. Reading such an
 * error as `gone` reported an unowned live process clean (review 5723236447).
 */
test('a failed liveness probe proves absence only on ESRCH', async () => {
  assert.equal(livenessFromProbeError('ESRCH'), 'gone');
  assert.equal(livenessFromProbeError('EPERM'), 'unknown', 'a process this host may not signal is not gone');
  assert.equal(livenessFromProbeError(undefined), 'unknown');
  assert.equal(processLiveness(process.pid), 'alive');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const pid = child.pid!;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && processLiveness(pid) !== 'alive') await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(processLiveness(pid), 'alive');
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && processLiveness(pid) !== 'gone') await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(processLiveness(pid), 'gone', 'a reaped pid is the one case ESRCH proves');
  }
});

/**
 * A teardown that cannot prove settlement must not become a clean report on the
 * next call. The sweep removes each service's identity file, so an unproved
 * target is only kept by the guard's own record; dropping it let a later
 * `killServices()` return nothing to report while the owned group was still
 * alive (review 5722842535). The fixture here is the real stuck shape: the
 * leader drains, and a child it started ignores the drain, so the group it led
 * never empties.
 */
test('an unproved teardown stays a target and is never reported clean later', async () => {
  const { spawnedPids, serviceProof, ownedGroupEmpty, killServices, pidAliveNumber } = unproved;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `nsfod${shardTag}`)));
  const ready = join(dir, 'child-ready');
  const leader = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.READY, 'ready'); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: 'ignore', env: { ...process.env, READY: ready } });
  const pid = leader.pid!;
  try {
    // The bridge's own `onSpawn` records the pid exactly like this before any
    // identity file exists.
    spawnedPids.add(pid);
    assert.equal(serviceProof(pid), 'ours', 'the guard owns the group leader it started');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !existsSync(ready)) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(existsSync(ready), true, 'the group child is running with its drain handler installed');

    await assert.rejects(() => killServices(), /could not prove 1 service\(s\) exited/,
      'a group that did not empty is never a clean teardown');
    assert.equal(serviceProof(pid), 'gone', 'the drain ended the leader');
    assert.equal(ownedGroupEmpty(pid), false, 'its child still holds the group it led');
    assert.equal(spawnedPids.has(pid), true, 'an unproved target stays a target');

    await assert.rejects(() => killServices(), /could not prove 1 service\(s\) exited/,
      'a later teardown re-proves the same target instead of reporting clean');
  } finally {
    // Only this test's own group: this test started it and its leader is gone.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the group already exited */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !ownedGroupEmpty(pid)) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(pidAliveNumber(pid), false);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A pid discovered in an identity file is never signalled and never a clean
 * teardown (review 5722890385). The file only carries a number, and adopting it
 * would record whatever identity that number has now — so a recycled sibling's
 * service, which shares this checkout's argv, would pass every check the file
 * could make and be killed as if it were ours.
 */
test('a discovered identity file never authorizes a signal or a clean teardown', async () => {
  const { spawnedPids, serviceProof, killServices, pidAliveNumber } = discovered;
  const root = realpathSync(mkdtempSync(join(tmpdir(), `nsfoe${shardTag}`)));
  const dataDir = join(root, 'northstar-queue');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // A live wrapper: it names the migration fixture, never the service entry it
  // would import — the milestone's own shape, and the one that used to be read as
  // "not ours" and disposed over (review 5723080357).
  const decoy = spawn(process.execPath, ['-e', `setInterval(() => {}, 1000); // ${join(repo, 'test/fixtures/migrating-service.mjs')}`], { detached: true, stdio: 'ignore' });
  const pid = decoy.pid!;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !pidAliveNumber(pid)) await new Promise(resolve => setTimeout(resolve, 50));
    // A stale identity file from a run whose spawn record this process never had.
    writeServiceInfo(dataDir, {
      protocolVersion: SERVICE_PROTOCOL_VERSION, buildId: currentServiceBuildId(), socketPath: join(dataDir, 'queue-service.sock'),
      credential: 'a'.repeat(64), pid, startedAt: new Date().toISOString(),
    });
    await assert.rejects(() => killServices(), /could not prove 1 service\(s\) exited/,
      'an unproved discovered pid is never reported clean, whatever its command line says');
    assert.equal(pidAliveNumber(pid), true, 'and it is never signalled: the file never recorded its spawn');
    assert.equal(serviceProof(pid), 'unknown', 'it stays an unproved target, not a settled one');
    assert.equal(spawnedPids.has(pid), false, 'an identity file never creates an ownership record either');
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the decoy already exited */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && pidAliveNumber(pid)) await new Promise(resolve => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The fixture's disposable directory is only safe once the bridge has stopped
 * writing to it. `close()` refuses new work but does not abort a spawn's
 * readiness wait, and that wait keeps refreshing its claim and then writes the
 * startup-failure record when its child exits — after the service is gone
 * (review 5723080357). This is the abandoned-attempt shape a cancelled test
 * leaves behind.
 */
weighted(5)('teardown waits for an abandoned spawn attempt to settle before disposal', async () => {
  const { trackedBridge, spawnedPids, serviceProof, killServices, dispose, pidAliveNumber } = inflight;
  const root = realpathSync(mkdtempSync(join(tmpdir(), `nsoff${shardTag}`)));
  const dataDir = join(root, 'northstar-queue');
  writeFileSync(join(root, 'config.json'), JSON.stringify({ plugins: { nucleus: { path: repo } } }), { mode: 0o600 });
  // A silent slow start: the spawned child never reports ready, so the abandoned
  // readiness wait is still in flight when teardown begins.
  process.env.FIXTURE_MIGRATION_MS = '60000';
  process.env.FIXTURE_NO_MARKER = '1';
  const bridge = trackedBridge({ dataDir, paseoHome: root, readinessBudgetMs: 60_000, serviceCommand: wrapperCommand });
  const claimPath = join(dataDir, 'queue-service.claim.json');
  let settled = false;
  const abandoned = bridge.forward(RPC_CATALOGUE.find(entry => entry.name === 'queue.ui-snapshot')!, {}).catch(() => null).finally(() => { settled = true; });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !existsSync(claimPath)) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(existsSync(claimPath), true, 'the abandoned attempt holds a spawn claim in the directory teardown will remove');
    assert.equal(bridgeInFlightWork(bridge).length, 1, 'the readiness wait is still in flight');
    const pid = [...spawnedPids][0];
    assert.ok(pid, 'the abandoned attempt spawned a service the guard recorded');
    assert.equal(serviceProof(pid), 'ours');

    await killServices();

    assert.equal(settled, true, 'teardown returned only after the abandoned spawn attempt settled');
    assert.equal(bridgeInFlightWork(bridge).length, 0, 'no bridge work is left writing to the directory');
    assert.equal(pidAliveNumber(pid), false, 'the service it spawned is proved gone');
    assert.equal(serviceProof(pid), 'gone');
    assert.equal(existsSync(claimPath), false, 'the claim the attempt refreshed is gone');
    assert.equal(existsSync(join(dataDir, SERVICE_STARTUP_FAILURE_FILE)), true,
      'the attempt wrote its startup-failure record before teardown reported, so disposal races no write');
    await dispose(root);
    assert.equal(existsSync(root), false);
  } finally {
    delete process.env.FIXTURE_MIGRATION_MS;
    delete process.env.FIXTURE_NO_MARKER;
    bridge.close();
    await abandoned;
  }
});

/**
 * Safety in the other direction: teardown only touches what this file recorded.
 * A live stranger and a live process whose command line imitates this checkout's
 * service entry are both preserved — a command pattern is not ownership, so the
 * sweep never signals either.
 */
test('teardown preserves a process this file never owned', async () => {
  const { serviceProof, killServices, pidAliveNumber } = owned;
  const decoy = spawn(process.execPath, ['-e', `setInterval(() => {}, 1000); // ${join(repo, 'bin/queue-service.mjs')}`], { detached: true, stdio: 'ignore' });
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    assert.ok(decoy.pid && stranger.pid);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(pidAliveNumber(decoy.pid) && pidAliveNumber(stranger.pid))) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(serviceProof(decoy.pid), 'unknown', 'a pid this file never recorded is never proved ours or foreign');
    assert.equal(serviceProof(stranger.pid), 'unknown');
    await killServices();
    assert.equal(pidAliveNumber(decoy.pid), true, 'the imitating process is preserved: a command line never authorizes a signal');
    assert.equal(pidAliveNumber(stranger.pid), true);
  } finally {
    for (const child of [decoy, stranger]) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && pidAliveNumber(child.pid)) await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
});
