import { onRepositorySyncRollRequest, requestServiceRollAfterRepositorySync as requestCoreRoll } from "../core/forge/roll-request";
import { bridgeProcessActions } from "../service/install/bridge-process-actions";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import { boardSource } from './support/board-source';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import { ServiceBridge } from '../hosts/paseo/plugin/bridge';
import { readServiceInfo, readServiceRoll, readServiceStartupFailure, SERVICE_STARTUP_FAILURE_FILE, writeServiceInfo, writeServiceRoll } from '../service/transport/identity';
import { serviceNotices } from '../shared/service-roll';
import { requestServiceRollAfterRepositorySync } from '../service/install/roll-request';
import { backendSourceDigest } from '../shared/service/build';
import { createFrameReader, encodeFrame, PROTOCOL_VERSION } from '../shared/service/protocol';
import { localQueueClient } from '../shared/service/local-client';
import { startRollProxy } from './support/roll-proxy';
import { rpcContractDigests } from '../shared/rpc-contracts';
import { bridgeSupport } from './support/bridge-fixture';
import { timingTest } from './support/timing';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dependencies = dirname(dirname(createRequire(import.meta.url).resolve('tsx/package.json')));

/**
 * Roll acceptance boots whole fixture services on isolated dirs, so it is a
 * serial wall-clock oracle (see support/timing): under the parallel suite's
 * fixture contention the rolls stretch until a deadline cancels valid cases
 * (2026-10-15 milestone QA). The spawning tests run alone in
 * `npm run test:timing` and skip the parallel suite; purely in-process tests
 * stay here. Every fixture bridge is tracked, so the file-level guard settles
 * every service this file spawned — including one a cancelled test left
 * booting — and asserts none survive.
 */
const { trackedBridge } = bridgeSupport('nsr');

/** A fixture checkout contains copied source and dependencies; it never links a real checkout. */
function fixtureCheckout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nsr')));
  const checkout = join(root, 'checkout'), dataDir = join(root, 'northstar-queue');
  mkdirSync(checkout);
  for (const name of ['bin', 'core', 'service', 'shared', 'hosts', 'mcp-report.mjs', 'package.json', 'tsconfig.json']) cpSync(join(repo, name), join(checkout, name), { recursive: true });
  cpSync(dependencies, join(checkout, 'node_modules'), { recursive: true, dereference: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ plugins: { nucleus: { path: checkout } } }), { mode: 0o600 });
  return { root, checkout, dataDir };
}

function cli(checkout: string, root: string) {
  // A fixture home keeps the child off the operator's real data home and journal.
  return spawnSync(process.execPath, [join(checkout, 'bin', 'queue-cli.mjs'), 'lanes'], { cwd: checkout, env: { ...process.env, PASEO_HOME: root, NUCLEUS_DATA_HOME: join(root, 'northstar-queue'), HOME: join(root, 'home') }, encoding: 'utf8', timeout: 30_000 });
}

function cliAsync(checkout: string, root: string, method: string, payload?: unknown) {
  const args = [join(checkout, 'bin', 'queue-cli.mjs'), method];
  if (payload !== undefined) args.push('-');
  const child = spawn(process.execPath, args, { cwd: checkout, env: { ...process.env, PASEO_HOME: root, NUCLEUS_DATA_HOME: join(root, 'northstar-queue'), HOME: join(root, 'home') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.end(payload === undefined ? undefined : JSON.stringify(payload));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Queue CLI subprocess exceeded its 25 second test bound'));
    }, 25_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', status => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
  });
}

async function fixtureQueueClient(checkout: string, dataDir: string, rollWaitMs = 10_000, onProgress?: (message: string) => void) {
  const { queueClient } = await import(pathToFileURL(join(checkout, 'bin', 'queue-client.mjs')).href);
  return queueClient({ dataDir, rollWaitMs, onProgress });
}

async function cleanup(bridge: ServiceBridge, root: string, dataDir: string, pids: number[]) {
  bridge.close();
  const info = readServiceInfo(dataDir);
  const targets = new Set([...pids, ...(info ? [info.pid] : [])]);
  for (const pid of targets) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && [...targets].some(alive)) await sleep(100);
  for (const pid of targets) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  rmSync(root, { recursive: true, force: true });
}

timingTest('the CLI recovers when canonical sync leaves contracts half-written during bootstrap', { timeout: 120_000 }, async t => {
  const { root, checkout, dataDir } = fixtureCheckout();
  const bridge = trackedBridge({ dataDir, paseoHome: root, rollCheckMs: 0, rollSettleMs: 0 });
  const pids: number[] = [];
  const contractsPath = join(checkout, 'shared', 'contracts.ts');
  const completeSource = readFileSync(contractsPath, 'utf8');
  t.after(() => cleanup(bridge, root, dataDir, pids));
  try {
    const before = await bridge.serviceState();
    pids.push(before.pid!);
    writeFileSync(contractsPath, completeSource.slice(0, 200));
    const pending = cliAsync(checkout, root, 'lanes');
    await sleep(350);
    let settled = false;
    void pending.then(() => { settled = true; });
    await sleep(100);
    assert.equal(settled, false, 'the failed import waits for source stability instead of exiting immediately');
    writeFileSync(contractsPath, completeSource);

    const run = await pending;
    assert.equal(run.status, 0, `CLI recovers after the source is stable: ${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), []);
  } finally {
    writeFileSync(contractsPath, completeSource);
    await cleanup(bridge, root, dataDir, pids);
  }
});

timingTest('a persistent bootstrap failure makes no mutating request', { timeout: 120_000 }, async t => {
  const { root, checkout, dataDir } = fixtureCheckout();
  const bridge = trackedBridge({ dataDir, paseoHome: root, rollCheckMs: 0, rollSettleMs: 0 });
  const pids: number[] = [];
  const contractsPath = join(checkout, 'shared', 'contracts.ts');
  const completeSource = readFileSync(contractsPath, 'utf8');
  t.after(() => cleanup(bridge, root, dataDir, pids));
  try {
    const before = await bridge.serviceState();
    pids.push(before.pid!);
    writeFileSync(contractsPath, completeSource.slice(0, 200));
    const failed = await cliAsync(checkout, root, 'lane.upsert', {
      key: 'bootstrap-should-not-write', title: 'Bootstrap guard', aim: 'Prove failed bootstrap sends no request.',
      repositories: [{ origin: 'example/queue', path: '/fixture' }],
    });
    assert.notEqual(failed.status, 0, 'an incomplete stable source remains a visible failure');
    assert.match(failed.stderr, /no service request was sent/);

    writeFileSync(contractsPath, completeSource);
    const lanes = await cliAsync(checkout, root, 'lanes');
    assert.equal(lanes.status, 0, lanes.stderr);
    assert.deepEqual(JSON.parse(lanes.stdout), [], 'the mutation was not delivered before bootstrap failed');
  } finally {
    writeFileSync(contractsPath, completeSource);
    await cleanup(bridge, root, dataDir, pids);
  }
});

timingTest('the local CLI waits for service identity during a roll and gives a bounded timeout message', async t => {
  const { root, checkout, dataDir } = fixtureCheckout();
  const bridge = trackedBridge({ dataDir, paseoHome: root, rollCheckMs: 0, rollSettleMs: 0 });
  let local: Awaited<ReturnType<typeof fixtureQueueClient>> | null = null;
  let restoreTimer: NodeJS.Timeout | null = null;
  t.after(() => { if (restoreTimer) clearTimeout(restoreTimer); local?.close(); return cleanup(bridge, root, dataDir, []); });
  try {
    await bridge.serviceState();
    const info = readServiceInfo(dataDir)!;
    writeServiceRoll(dataDir, {
      status: 'replacing', fromBuild: info.buildId, toBuild: info.buildId,
      digest: 'd'.repeat(16), at: new Date().toISOString(), detail: 'Replacing the service',
    });
    rmSync(join(dataDir, 'queue-service.json'), { force: true });

    const { waitForLocalServiceRoll } = await import('../shared/service/local-client');
    await assert.rejects(
      () => waitForLocalServiceRoll(dataDir, 1_000),
      /still unavailable after 1 second while its service roll is in progress/,
    );

    restoreTimer = setTimeout(() => writeServiceInfo(dataDir, info), 100);
    local = await fixtureQueueClient(checkout, dataDir, 50);
    await local.connect();
    assert.equal((await local.request('service.health', {}) as { service: string }).service, 'nucleus');
  } finally {
    if (restoreTimer) clearTimeout(restoreTimer);
    local?.close();
    await cleanup(bridge, root, dataDir, []);
  }
});

timingTest('protocol mismatch fences every direct CLI call even while a roll is pending', async t => {
  const { root, checkout, dataDir } = fixtureCheckout();
  const bridge = trackedBridge({ dataDir, paseoHome: root, rollCheckMs: 0, rollSettleMs: 60_000 });
  const pids: number[] = [];
  t.after(() => cleanup(bridge, root, dataDir, pids));
  try {
    const before = await bridge.serviceState();
    pids.push(before.pid!);
    const info = readServiceInfo(dataDir)!;
    writeServiceRoll(dataDir, {
      status: 'deferred', fromBuild: info.buildId, toBuild: null,
      digest: 'd'.repeat(16), at: new Date().toISOString(), detail: 'Waiting for the settle window',
    });
    writeServiceInfo(dataDir, { ...info, protocolVersion: PROTOCOL_VERSION + 1 });
    const local = await fixtureQueueClient(checkout, dataDir, 1_000);
    await assert.rejects(() => local.connect(), /protocol .* incompatible/);
    local.close();
  } finally { await cleanup(bridge, root, dataDir, pids); }
});

test('a dropped mutation response during a roll reports unknown outcome and its confirming read', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nsr-client')));
  const dataDir = join(root, 'northstar-queue');
  mkdirSync(dataDir);
  const socketPath = join(root, 'q.sock');
  const credential = 'c'.repeat(64);
  let mutations = 0;
  const server = createServer(socket => {
    const reader = createFrameReader(frame => {
      const request = frame as { id: string; method: string };
      if (request.method === 'service.auth') {
        socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: request.id, result: { ok: true, protocolVersion: PROTOCOL_VERSION, buildId: 'fixture-build', pid: process.pid } }));
      } else if (request.method === 'service.health') {
        socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: request.id, result: { protocolVersion: PROTOCOL_VERSION, rpcContracts: rpcContractDigests() } }));
      } else {
        mutations++;
        socket.destroy();
      }
    }, () => socket.destroy());
    socket.on('data', chunk => reader.feed(chunk));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    chmodSync(socketPath, 0o600);
    writeServiceInfo(dataDir, {
      protocolVersion: PROTOCOL_VERSION, buildId: 'fixture-build',
      socketPath, credential, pid: process.pid, startedAt: new Date().toISOString(),
    });
    const local = localQueueClient(dataDir);
    try {
      await local.connect();
      await assert.rejects(
        () => local.request('papercut.add', { repository: { origin: 'owner/repo', path: '/repo' }, title: 'Fixture', happened: 'today', impact: 'test' }),
        /Outcome of papercut\.add is unknown.*read-only papercut\.list.*Nucleus did not retry it/,
      );
      assert.equal(mutations, 1, 'the mutation was sent once and was not replayed');
      const operationId = 'a'.repeat(64);
      await assert.rejects(
        () => local.request('queue.operation-status', { operationId }),
        new RegExp(`Outcome of queue\\.operation-status is unknown.*queue\\.operation-status with operationId ${operationId}.*Nucleus did not retry it`),
      );
      assert.equal(mutations, 2, 'inspection is not retried or turned into an operation-start after a lost response');
    } finally { local.close(); }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

timingTest('failed child startup diagnostics persist redacted and bounded, then clear after a healthy retry', async t => {
  const { root, checkout, dataDir } = fixtureCheckout();
  const entry = join(checkout, 'bin', 'queue-service.mjs');
  const originalEntry = readFileSync(entry, 'utf8');
  const secretName = 'NSQ_FIXTURE_API_TOKEN';
  const priorSecret = process.env[secretName];
  const secret = 'fixture-secret-value-please-redact';
  const token = `ghp_${'a'.repeat(36)}`;
  process.env[secretName] = secret;
  const failedEntry = `
const { once } = await import('node:events');
const message = 'startup diagnostic ' + process.env.${secretName} + ' ${token} ' + 'x'.repeat(800) + '\\n';
for (let i = 0; i < 80; i++) if (!process.stderr.write(message)) await once(process.stderr, 'drain');
process.exitCode = 23;
`;
  writeFileSync(entry, failedEntry);
  const bridge = trackedBridge({ dataDir, paseoHome: root, rollCheckMs: 0, readinessBudgetMs: 10_000 });
  let retryBridge: ServiceBridge | null = null;
  const pids: number[] = [];
  t.after(async () => {
    bridge.close();
    if (retryBridge) await cleanup(retryBridge, root, dataDir, pids);
    else await cleanup(bridge, root, dataDir, pids);
    if (priorSecret === undefined) delete process.env[secretName];
    else process.env[secretName] = priorSecret;
  });
  try {
    const failed = await bridge.serviceState();
    assert.equal(failed.state, 'unhealthy');
    assert.match(failed.detail, /child exited with code 23/);
    assert.ok(failed.detail.includes('startup diagnostic'));
    assert.ok(!failed.detail.includes(secret), 'environment secrets are redacted');
    assert.ok(!failed.detail.includes(token), 'provider-shaped output tokens are redacted');
    assert.ok(Buffer.byteLength(failed.detail) < 2_500, 'the visible detail is bounded');

    const diagnostic = readServiceStartupFailure(dataDir)!;
    assert.equal(diagnostic.exitCode, 23);
    assert.ok(diagnostic.output.includes('[redacted]'));
    assert.ok(Buffer.byteLength(diagnostic.output) <= 2_000);
    assert.equal(statSync(join(dataDir, SERVICE_STARTUP_FAILURE_FILE)).mode & 0o777, 0o600);

    // Exercise the custom command path with sustained output before the service
    // becomes ready. Waiting for drain proves the bridge consumes both pipes.
    writeFileSync(entry, `
const { once } = await import('node:events');
for (let i = 0; i < 256; i++) if (!process.stdout.write(Buffer.alloc(8_192, 97))) await once(process.stdout, 'drain');
${originalEntry.replace(/^#!.*\n/, '')}
`);
    retryBridge = trackedBridge({
      dataDir, paseoHome: root, rollCheckMs: 0, readinessBudgetMs: 20_000,
      serviceCommand: () => ({ command: process.execPath, args: ['--import', 'tsx', entry] }),
    });
    const recovered = await retryBridge.serviceState();
    assert.equal(recovered.state, 'running', recovered.detail);
    pids.push(recovered.pid!);
    assert.equal(readServiceStartupFailure(dataDir), null, 'a compatible healthy service clears the old failure');
  } finally {
    bridge.close();
    if (retryBridge) await cleanup(retryBridge, root, dataDir, pids);
    else await cleanup(bridge, root, dataDir, pids);
    if (priorSecret === undefined) delete process.env[secretName];
    else process.env[secretName] = priorSecret;
  }
});

timingTest('the detached service survives a later log write after its bridge exits', async t => {
  const { root, checkout, dataDir } = fixtureCheckout();
  const standalone = join(checkout, 'service', 'standalone.ts');
  const originalStandalone = readFileSync(standalone, 'utf8');
  const startLine = '    await service.start();';
  assert.ok(originalStandalone.includes(startLine), 'fixture has the standalone readiness boundary');
  writeFileSync(standalone, originalStandalone.replace(startLine, `${startLine}\n    setTimeout(() => console.log('detached lifetime probe'), 500).unref();`));

  const launcher = join(root, 'bridge-launcher.mjs');
  const bridgeModule = join(repo, 'hosts', 'paseo', 'plugin', 'bridge.ts');
  writeFileSync(launcher, `
import { ServiceBridge } from ${JSON.stringify(bridgeModule)};
import { bridgeProcessActions } from ${JSON.stringify(join(repo, "service/install/bridge-process-actions.ts"))};
const bridge = new ServiceBridge({ processActions: bridgeProcessActions, dataDir: ${JSON.stringify(dataDir)}, paseoHome: ${JSON.stringify(root)}, rollCheckMs: 0 });
const state = await bridge.serviceState();
process.stdout.write('BRIDGE_RESULT:' + JSON.stringify({ state: state.state, pid: state.pid }) + '\\n', () => {
  bridge.close();
  process.exit(state.state === 'running' ? 0 : 1);
});
`);

  const bridgeProcess = spawn(process.execPath, ['--import', 'tsx', launcher], {
    cwd: repo, env: { ...process.env, PASEO_HOME: root, HOME: join(root, 'home') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  bridgeProcess.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  bridgeProcess.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const result = new Promise<{ status: number | null; timedOut: boolean }>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; bridgeProcess.kill('SIGKILL'); }, 30_000);
    bridgeProcess.once('error', error => { clearTimeout(timer); reject(error); });
    bridgeProcess.once('close', status => { clearTimeout(timer); resolve({ status, timedOut }); });
  });

  const observer = trackedBridge({ dataDir, paseoHome: root, rollCheckMs: 0 });
  const pids: number[] = [];
  t.after(() => cleanup(observer, root, dataDir, pids));
  try {
    const launched = await result;
    assert.equal(launched.timedOut, false, 'the bridge child exited within its test bound');
    assert.equal(launched.status, 0, stderr);
    const line = stdout.split('\n').find(value => value.startsWith('BRIDGE_RESULT:'));
    assert.ok(line, `bridge child returned its service state: ${stdout}`);
    const ready = JSON.parse(line.slice('BRIDGE_RESULT:'.length)) as { state: string; pid: number };
    assert.equal(ready.state, 'running');
    pids.push(ready.pid);

    // The service logs after the bridge process closes its inherited pipe.
    await sleep(1_250);
    const after = await observer.serviceState();
    if (after.pid) pids.push(after.pid);
    assert.equal(after.state, 'running', after.detail);
    assert.equal(after.pid, ready.pid, 'the original detached service survived the bridge exit');
  } finally { await cleanup(observer, root, dataDir, pids); }
});

/** A fixture plugin reload that records each invocation instead of reloading anything. */
function reloadRecorder(log: string) {
  return () => ({ command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(1).join(' ') + '\\n')`, 'plugin', 'reload', 'nucleus'] });
}

test('a bridge that did not start a roll handoff waits for it and never spawns a second owner', async t => {
  // 2026-10-04: a reload during a roll left a new bridge watching a handoff it did
  // not start. Spawning there raced two owners; the loser unlinked the live socket.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nsr-handoff-')));
  const dataDir = join(root, 'northstar-queue');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeServiceRoll(dataDir, {
    status: 'replacing', fromBuild: 'a'.repeat(16), toBuild: 'b'.repeat(16),
    digest: 'c'.repeat(16), at: new Date().toISOString(), detail: 'Typecheck passed; replacing the service',
  });
  const bridge = trackedBridge({ dataDir, paseoHome: root, rollCheckMs: 0, rollSettleMs: 0, handoffWaitMs: 300 });
  t.after(() => { bridge.close(); rmSync(root, { recursive: true, force: true }); });
  try {
    const state = await bridge.serviceState();
    assert.equal(state.state, 'unhealthy');
    assert.match(state.detail, /handoff did not settle/);
    assert.equal(readServiceInfo(dataDir), null, 'no second owner was spawned over the handoff');
    assert.equal(existsSync(join(dataDir, 'queue-service.claim.json')), false, 'no spawn claim was taken');
  } finally { bridge.close(); rmSync(root, { recursive: true, force: true }); }
});

timingTest('a fresh bridge settles an interrupted replacing roll once its target build answers', async t => {
  const { root, dataDir } = fixtureCheckout();
  let bridge = trackedBridge({ dataDir, paseoHome: root, rollCheckMs: 0, rollSettleMs: 0 });
  const pids: number[] = [];
  t.after(() => cleanup(bridge, root, dataDir, pids));
  try {
    const before = await bridge.serviceState();
    pids.push(before.pid!);
    bridge.close();

    writeServiceRoll(dataDir, {
      status: 'replacing', fromBuild: 'a'.repeat(16), toBuild: before.buildId!,
      digest: 'c'.repeat(16), at: new Date().toISOString(), detail: 'Typecheck passed; replacing the service',
    });

    // A plugin reload creates a new bridge after the old bridge has gone away.
    bridge = trackedBridge({ dataDir, paseoHome: root, rollCheckMs: 0, rollSettleMs: 0 });
    const after = await bridge.serviceState();
    assert.equal(after.state, 'running');
    assert.equal(after.buildId, before.buildId);
    assert.equal(after.roll?.status, 'rolled');
    assert.equal(after.roll?.toBuild, before.buildId);
  } finally { await cleanup(bridge, root, dataDir, pids); }
});

test('the UI notice appears when the client bundle is older than the service build', () => {
  const base = { state: 'running', detail: '', buildId: 'b'.repeat(16), pluginBuildId: 'b'.repeat(16), roll: null };
  assert.deepEqual(serviceNotices(base), []);
  assert.deepEqual(serviceNotices({ ...base, buildId: 'c'.repeat(16) }), [{ tone: 'quiet', text: 'Nucleus updated; reload the plugin to refresh the UI' }]);
  assert.deepEqual(serviceNotices({ ...base, state: 'upgrading', buildId: null, detail: 'draining' }), [{ tone: 'warning', text: 'Nucleus service upgrading · draining' }]);
  assert.deepEqual(serviceNotices({
    ...base,
    roll: {
      status: 'deferred', fromBuild: 'a'.repeat(16), toBuild: null, digest: 'c'.repeat(16),
      at: new Date().toISOString(), detail: 'a heavy run has an attached follower', deferrals: [],
    },
  }), [{ tone: 'quiet', text: 'Nucleus is deferring a service roll: a heavy run has an attached follower' }]);
  const ui = boardSource();
  assert.match(ui, /serviceNotices\(serviceStateQuery\.data\)/);
});

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

timingTest('settlement on connect touches only an unfinished roll naming the answering build or loaded source, with honest provenance and no extra reload', async t => {
  const { root, checkout, dataDir } = fixtureCheckout();
  const reloads = join(root, 'reloads.log');
  writeFileSync(reloads, '');
  const options = { dataDir, paseoHome: root, rollCheckMs: 0, rollSettleMs: 600_000, reloadPluginCommand: reloadRecorder(reloads) };
  let bridge = trackedBridge(options);
  const pids: number[] = [];
  t.after(() => cleanup(bridge, root, dataDir, pids));
  try {
    const running = await bridge.serviceState();
    assert.equal(running.state, 'running');
    assert.equal(typeof running.pid, 'number', 'the first observation names a pid');
    pids.push(running.pid!);
    const loaded = backendSourceDigest(checkout), other = 'f'.repeat(16);
    const base = { fromBuild: 'a'.repeat(16), at: new Date().toISOString(), deferrals: [] };
    // Each case: a record, a fresh bridge on the same source connecting to the same service.
    const settle = async (roll: Parameters<typeof writeServiceRoll>[1]) => {
      writeServiceRoll(dataDir, roll);
      bridge.close();
      bridge = trackedBridge(options);
      const state = await bridge.serviceState();
      assert.equal(state.state, 'running');
      assert.equal(state.pid, running.pid, 'the compatible service is kept');
      return readServiceRoll(dataDir)!;
    };
    const typechecking = await settle({ ...base, status: 'typechecking', toBuild: null, digest: loaded, detail: 'Typechecking the changed checkout' });
    assert.equal(typechecking.status, 'rolled');
    assert.equal(typechecking.toBuild, running.buildId);
    assert.match(typechecking.detail, /while the roll was typechecking; that check's completion was not observed and no passing roll typecheck is recorded/);
    assert.doesNotMatch(typechecking.detail, /after a passing typecheck|did not run/);

    const superseded = await settle({ ...base, status: 'retrying', toBuild: 'b'.repeat(16), digest: other, detail: 'old failed replacement' });
    assert.equal(superseded.status, 'rolled');
    assert.equal(superseded.toBuild, running.buildId);
    assert.match(superseded.detail, /superseded.*healthy/);

    for (const roll of [
      { ...base, status: 'deferred' as const, toBuild: null, digest: other, detail: 'waiting' },
      { ...base, status: 'typechecking' as const, toBuild: null, digest: other, detail: 'Typechecking the changed checkout' },
      { ...base, status: 'replacing' as const, toBuild: 'b'.repeat(16), digest: loaded, detail: 'Typecheck passed; replacing the service' },
      { ...base, status: 'retrying' as const, toBuild: 'b'.repeat(16), digest: loaded, detail: 'current source is still selected' },
      { ...base, status: 'failed' as const, toBuild: null, digest: loaded, detail: 'the changed checkout failed its typecheck' },
      { ...base, status: 'rolled' as const, toBuild: 'b'.repeat(16), digest: other, detail: 'Service replaced after a passing typecheck' },
    ]) {
      const replacingOther = roll.status === 'replacing';
      if (replacingOther) {
        // A replacing record names its own target; a bridge answering at another build waits on it, so only the record is checked.
        writeServiceRoll(dataDir, roll);
        assert.deepEqual(readServiceRoll(dataDir), roll);
        continue;
      }
      assert.deepEqual(await settle(roll), roll, `${roll.status} for ${roll.digest === loaded ? 'the loaded source' : 'other source'} is left as written`);
    }
    assert.equal(readFileSync(reloads, 'utf8'), '', 'the plugin already runs the answering build, so nothing reloads it');
  } finally { await cleanup(bridge, root, dataDir, pids); }
});


test('an installed main channel gets the immediate sync hint only for its build repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'main-hint-'));
  const priorHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  try {
    const source = join(root, 'package'), repository = join(root, 'repository');
    mkdirSync(source); mkdirSync(repository);
    writeFileSync(join(source, 'manifest.json'), '{}');
    const base = join(process.env.HOME, '.local/share/nucleus');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'channel.json'), JSON.stringify({ channel: 'main', repository }));
    assert.equal(requestServiceRollAfterRepositorySync(repository, { sourcePath: source, dataDir: join(root, 'data') }), true);
    assert.equal(requestServiceRollAfterRepositorySync(root, { sourcePath: source, dataDir: join(root, 'other') }), false);
  } finally { if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome; }
});


test('a pending activation is retried on each unchanged roll check, not on connect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'act-roll-'));
  const checkout = join(root, 'checkout');
  for (const dir of ['core', 'service', 'shared', 'hosts', 'bin']) mkdirSync(join(checkout, dir), { recursive: true });
  writeFileSync(join(checkout, 'core', 'entry.ts'), 'export {};');
  writeFileSync(join(checkout, 'shared', 'entry.ts'), 'export {};');
  writeFileSync(join(checkout, 'bin', 'queue-service.mjs'), '');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const priorHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  let spawns = 0;
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions,
    sourcePath: checkout, dataDir, paseoHome: root, rollCheckMs: 0, readinessBudgetMs: 2_000,
    serviceCommand: () => { spawns++; return { command: process.execPath, args: ['-e', 'process.exit(1)'] }; },
  });
  (bridge as unknown as { mainChannel: unknown }).mainChannel = { target: async () => ({ key: backendSourceDigest(checkout) }) };
  let activated = 0, fail = true;
  (bridge as unknown as { activateInstalled: (() => Promise<void>) | null }).activateInstalled = async () => {
    activated++;
    if (fail) throw new Error('activation not ready');
  };
  try {
    await bridge.checkSource();
    assert.equal(activated, 1);
    assert.equal(spawns, 0, 'a first failed activation does not spawn; there is no replacement to retry yet');
    assert.equal(typeof (bridge as unknown as { activateInstalled: unknown }).activateInstalled, 'function', 'a failed activation stays pending');
    const failed = readServiceRoll(dataDir);
    assert.equal(failed?.status, 'retrying');
    assert.match(failed?.detail ?? '', /activation not ready/);
    fail = false;
    await bridge.checkSource();
    assert.equal(activated, 2);
    assert.equal((bridge as unknown as { activateInstalled: unknown }).activateInstalled, null);
    assert.equal(spawns, 1, 'a retrying record retries the replacement');
    const still = readServiceRoll(dataDir);
    assert.equal(still?.status, 'retrying', 'activation success without a live target does not write rolled');
    assert.match(still?.detail ?? '', /replacement did not complete and is retried/);
    await bridge.checkSource();
    assert.equal(activated, 2, 'a finished activation is not repeated');
    assert.equal(spawns, 2, 'the next check still retries the replacement');
    assert.equal(readServiceRoll(dataDir)?.status, 'retrying');
  } finally {
    bridge.close();
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  }
});

test('a seeded retrying replacement is not marked rolled when activation succeeds but ensure fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'act-ensure-'));
  const checkout = join(root, 'checkout');
  for (const dir of ['core', 'service', 'shared', 'hosts', 'bin']) mkdirSync(join(checkout, dir), { recursive: true });
  writeFileSync(join(checkout, 'core', 'entry.ts'), 'export {};');
  writeFileSync(join(checkout, 'shared', 'entry.ts'), 'export {};');
  writeFileSync(join(checkout, 'bin', 'queue-service.mjs'), '');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const digest = backendSourceDigest(checkout);
  writeServiceRoll(dataDir, {
    status: 'retrying', fromBuild: 'a'.repeat(16), toBuild: 'b'.repeat(16), digest,
    at: new Date().toISOString(), detail: 'the replacement did not complete and is retried: previous', deferrals: [],
  });
  const priorHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  let spawns = 0;
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions,
    sourcePath: checkout, dataDir, paseoHome: root, rollCheckMs: 0, readinessBudgetMs: 2_000,
    serviceCommand: () => { spawns++; return { command: process.execPath, args: ['-e', 'process.exit(1)'] }; },
  });
  (bridge as unknown as { mainChannel: unknown }).mainChannel = { target: async () => ({ key: digest }) };
  (bridge as unknown as { activateInstalled: (() => Promise<void>) | null }).activateInstalled = async () => {};
  try {
    await bridge.checkSource();
    assert.equal(spawns, 1);
    const roll = readServiceRoll(dataDir);
    assert.equal(roll?.status, 'retrying');
    assert.match(roll?.detail ?? '', /replacement did not complete and is retried/);
    await bridge.checkSource();
    assert.equal(spawns, 2, 'a rolled write would have stopped the per-check replacement retry');
    assert.equal(readServiceRoll(dataDir)?.status, 'retrying');
  } finally {
    bridge.close();
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  }
});

test('a quiet unchanged check returns null rather than the standing record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quiet-roll-'));
  const checkout = join(root, 'checkout');
  for (const dir of ['core', 'service', 'shared', 'hosts', 'bin']) mkdirSync(join(checkout, dir), { recursive: true });
  writeFileSync(join(checkout, 'core', 'entry.ts'), 'export {};');
  writeFileSync(join(checkout, 'shared', 'entry.ts'), 'export {};');
  writeFileSync(join(checkout, 'bin', 'queue-service.mjs'), '');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const standing = {
    status: 'rolled' as const, fromBuild: 'a'.repeat(16), toBuild: 'b'.repeat(16),
    digest: backendSourceDigest(checkout), at: new Date().toISOString(),
    detail: 'Service replaced after a passing typecheck', deferrals: [],
  };
  writeServiceRoll(dataDir, standing);
  const priorHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions, sourcePath: checkout, dataDir, paseoHome: root, rollCheckMs: 0 });
  try {
    assert.equal(await bridge.checkSource(), null, 'a quiet check reports that nothing happened');
    assert.deepEqual(readServiceRoll(dataDir), standing, 'the standing record is left as written');
  } finally {
    bridge.close();
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  }
});

test('an unreadable checkout leaves the roll record alone even when the data directory is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unreadable-'));
  const checkout = join(root, 'checkout');
  for (const dir of ['core', 'service', 'shared', 'hosts', 'bin']) mkdirSync(join(checkout, dir), { recursive: true });
  writeFileSync(join(checkout, 'core', 'entry.ts'), 'export {};');
  writeFileSync(join(checkout, 'shared', 'entry.ts'), 'export {};');
  writeFileSync(join(checkout, 'bin', 'queue-service.mjs'), '');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const prior = { status: 'deferred' as const, fromBuild: 'a'.repeat(16), toBuild: null, digest: backendSourceDigest(checkout), at: new Date().toISOString(), detail: 'existing roll', deferrals: [] };
  writeServiceRoll(dataDir, prior);
  const blocked = join(root, 'blocked');
  writeFileSync(blocked, 'not a directory');
  const priorHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  const bridges = [dataDir, join(blocked, 'data'), join(root, 'no-record')].map(dir => new ServiceBridge({ processActions: bridgeProcessActions, sourcePath: checkout, dataDir: dir, paseoHome: root, rollCheckMs: 0 }));
  try {
    renameSync(join(checkout, 'shared'), join(checkout, 'shared-in-flight'));
    for (const bridge of bridges) assert.equal(await bridge.checkSource(true), null);
    assert.deepEqual(readServiceRoll(dataDir), prior, 'no false main failure overwrites the existing roll');
    assert.equal(readServiceRoll(join(root, 'no-record')), null, 'no false failure notice is created');
  } finally {
    for (const bridge of bridges) bridge.close();
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  }
});

test('main rolls coalesce revisions, defer for followers, honor force and retain the running build on failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'main-roll-'));
  const dataDir = join(root, 'data');
  let attached = false;
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions, sourcePath: root, dataDir, paseoHome: root, rollSettleMs: 60_000, heavyFollowers: () => attached });
  const state = bridge as unknown as {
    mainChannel: unknown; expectedBuild: string; sourceDigest: string; lastDigestChangeAt: number;
    sourcePath: string; activateInstalled: unknown;
    ensure: () => Promise<unknown>; convergeActivation: () => Promise<null>;
  };
  state.expectedBuild = 'old-build';
  state.sourceDigest = 'old';
  let revision = 'one', broken = false, spawned = 0;
  const built: string[] = [], prepared: string[] = [];
  state.mainChannel = {
    target: async () => ({ key: revision, revision }),
    build: async (next: string) => {
      built.push(next);
      if (broken) throw Error('fixture main build failure');
      return { root, revision: next, buildId: `build-${next}` };
    },
    prepare: async (_staged: unknown, target: { key: string }) => { prepared.push(target.key); },
    activated: async () => {},
  };
  state.ensure = async () => { spawned++; return {}; };
  state.convergeActivation = async () => { state.activateInstalled = null; return null; };
  try {
    assert.equal((await bridge.checkSource())?.status, 'deferred');
    revision = 'two';
    assert.equal((await bridge.checkSource())?.status, 'deferred', 'latest revision resets the settle window');
    assert.equal(spawned, 0);
    state.lastDigestChangeAt = 0;
    attached = true;
    assert.equal((await bridge.checkSource())?.deferrals.at(-1)?.reason, 'heavy_follower');
    const rolled = await bridge.checkSource(true);
    assert.equal(rolled?.status, 'rolled');
    assert.equal(rolled?.toBuild, 'build-two');
    assert.deepEqual(prepared, ['two'], 'superseded revision never reaches preparation');
    assert.equal(spawned, 1);
    assert.equal(await bridge.checkSource(), null, 'landed revision stays quiet');
    revision = 'three';
    broken = true;
    assert.match((await bridge.checkSource(true))?.detail ?? '', /fixture main build failure/);
    const attempts = built.length;
    assert.equal(await bridge.checkSource(true), null, 'failed revision is suppressed');
    assert.equal(built.length, attempts);
    assert.equal(state.expectedBuild, 'build-two', 'failed build keeps the selected running build');
  } finally { bridge.close(); }
});

test('a checkout without an installed main channel never rolls changed source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'no-dev-roll-'));
  for (const dir of ['core', 'service', 'shared', 'hosts', 'bin']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'shared', 'entry.ts'), 'export const version = 1;');
  writeFileSync(join(root, 'bin', 'queue-service.mjs'), '');
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions, sourcePath: root, dataDir: join(root, 'data'), paseoHome: root });
  assert.equal(typeof (bridge as unknown as { expectedBuild: unknown }).expectedBuild, 'string', 'fixture starts with a readable backend identity');
  (bridge as unknown as { mainChannel: null }).mainChannel = null;
  try {
    writeFileSync(join(root, 'shared', 'entry.ts'), 'export const version = 2;');
    assert.equal(await bridge.checkSource(true), null);
    assert.equal(readServiceRoll(join(root, 'data')), null);
  } finally { bridge.close(); }
});

test('repository-sync roll requests stay synchronous through the core port', () => {
  const observed: string[] = [];
  onRepositorySyncRollRequest(path => { observed.push(path); return true; });
  try {
    assert.equal(requestCoreRoll('repository'), true);
    assert.deepEqual(observed, ['repository']);
    const failure = new Error('synchronous failure');
    onRepositorySyncRollRequest(() => { throw failure; });
    assert.throws(() => requestCoreRoll('repository'), error => error === failure);
  } finally { onRepositorySyncRollRequest(requestServiceRollAfterRepositorySync); }
});
