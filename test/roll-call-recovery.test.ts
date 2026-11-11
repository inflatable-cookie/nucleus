import { bridgeProcessActions } from "../service/install/bridge-process-actions";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourcePathFromModule } from '../shared/service/build';
import { QueueService } from '../service/transport/server';
import { ServiceClient, ServiceRequestError } from '../shared/service/client';
import { readServiceInfo, writeServiceInfo, writeServiceRoll, type ServiceInfo } from '../service/transport/identity';
import { localQueueClient } from '../shared/service/local-client';
import { ServiceBridge } from '../hosts/paseo/plugin/bridge';
import { RPC_CATALOGUE } from '../shared/rpc-catalogue';
import { CallNotSentError, callWithRollRecovery, UnknownOutcomeError } from '../shared/service/roll-recovery';
import { readServiceRoll } from '../service/transport/identity';
import { startRollProxy, type RollProxy } from './support/roll-proxy';

/**
 * Roll call recovery over the real transport (service-boundary contract,
 * "Rolls: calls wait out the replacement"). A real fixture service answers
 * behind a proxy that loses exactly one response, a fresh `replacing` roll
 * record simulates the roll, and a second real service on the same store is
 * the replacement the recovery answers from: the ledger's recorded outcome
 * comes back applied exactly once, a proven non-receipt is resent once, and a
 * read answers from the replacement. The full two-build roll driven by the
 * bridge is proven separately in `test/service-roll.test.ts`'s serial oracle.
 */

interface Proxy extends RollProxy {}

/**
 * The old side loses one response for `method`; and every outcome ask that
 * would travel the old side is dropped too, so a recovery can only settle by
 * asking the replacement.
 */
async function startProxy(upstream: string, socketPath: string, method: string, mode: 'lose-response' | 'never-receive'): Promise<Proxy> {
  return await startRollProxy(upstream, socketPath, [
    { method, mode },
    { method: 'service.request-outcome', mode: 'never-receive' },
  ]);
}

interface Fixture {
  dataDir: string;
  root: string;
  oldService: QueueService;
  oldInfo: ServiceInfo;
  proxy: Proxy;
  /** The replacement the roll hands over to; started by `handOver`. */
  newService: QueueService | null;
}

/**
 * The old side loses one response for `method`; and every outcome ask that
 * would travel the old side is dropped too, so a recovery can only settle by
 * asking the replacement.
 */
async function startFixture(method: string, mode: 'lose-response' | 'never-receive'): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'nsq-roll-'));
  const dataDir = join(root, 'northstar-queue');
  const oldService = new QueueService({ owner: { dataDir }, fixture: 'fake' });
  await oldService.start();
  const oldInfo = readServiceInfo(dataDir)!;
  const proxy = await startProxy(oldInfo.socketPath, join(root, 'proxy.sock'), method, mode);
  writeServiceInfo(dataDir, { ...oldInfo, socketPath: proxy.socketPath });
  return { dataDir, root, oldService, oldInfo, proxy, newService: null };
}

/**
 * The roll itself: the old service releases the store and its identity, and a
 * replacement starts on the same store. The identity file then names the
 * replacement's own socket, the way a bridge-rewritten identity does.
 */
async function handOver(fixture: Fixture): Promise<void> {
  await fixture.oldService.stop();
  fixture.newService = new QueueService({ owner: { dataDir: fixture.dataDir }, fixture: 'fake' });
  await fixture.newService.start();
}

async function cleanup(fixture: Fixture) {
  await fixture.proxy.close();
  await fixture.oldService.stop();
  await fixture.newService?.stop();
  rmSync(fixture.root, { recursive: true, force: true });
}

function recordRoll(dataDir: string, from: ServiceInfo) {
  writeServiceRoll(dataDir, {
    status: 'replacing', fromBuild: from.buildId, toBuild: 'next-build', digest: 'd'.repeat(16),
    at: new Date().toISOString(), detail: 'Typecheck passed; replacing the service',
  });
}

async function waitFor(predicate: () => boolean, what: string, waitMs = 10_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`fixture never observed: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const PAPERCUT = { repository: { origin: 'owner/repo', path: '/repo' } };

test('a mutation whose response is lost mid-roll returns its applied outcome on the replacement, exactly once', async t => {
  const fixture = await startFixture('papercut.add', 'lose-response');
  t.after(() => cleanup(fixture));
  const input = { ...PAPERCUT, title: 'Mid-roll', happened: 'today', impact: 'roll' };
  recordRoll(fixture.dataDir, fixture.oldInfo);
  const client = localQueueClient(fixture.dataDir, { compatibilityWaitMs: 20_000 });
  try {
    await client.connect();
    const pending = client.request('papercut.add', input);
    // The old service received the mutation and settled it; only the response is lost.
    await waitFor(() => fixture.proxy.interfered >= 1, 'the lost response');
    await handOver(fixture);
    const result = await pending as { id: string };
    assert.equal(result.id, await papercutId(fixture, 'Mid-roll'), 'the answer is the recorded applied outcome');
    assert.equal(await papercutCount(fixture, 'Mid-roll'), 1, 'the effect applied exactly once');
  } finally { client.close(); }
});

test('a request the replacement never received returns not received and is resent once, exactly once', async t => {
  const fixture = await startFixture('papercut.add', 'never-receive');
  t.after(() => cleanup(fixture));
  const input = { ...PAPERCUT, title: 'Unreceived', happened: 'today', impact: 'roll' };
  recordRoll(fixture.dataDir, fixture.oldInfo);
  const client = localQueueClient(fixture.dataDir, { compatibilityWaitMs: 20_000 });
  try {
    await client.connect();
    const pending = client.request('papercut.add', input);
    await waitFor(() => fixture.proxy.interfered >= 1, 'the dropped request');
    await handOver(fixture);
    const result = await pending as { id: string };
    assert.equal(result.id, await papercutId(fixture, 'Unreceived'), 'the proven-safe resend executed and answered');
    assert.equal(await papercutCount(fixture, 'Unreceived'), 1, 'the resend applied exactly once');
  } finally { client.close(); }
});

test('a read issued mid-roll waits for the replacement and answers from it', async t => {
  const fixture = await startFixture('papercut.list', 'lose-response');
  t.after(() => cleanup(fixture));
  recordRoll(fixture.dataDir, fixture.oldInfo);
  const client = localQueueClient(fixture.dataDir, { compatibilityWaitMs: 20_000 });
  try {
    await client.connect();
    const pending = client.request('papercut.list', {});
    await waitFor(() => fixture.proxy.interfered >= 1, 'the lost read response');
    await handOver(fixture);
    assert.deepEqual(await pending, [], 'the read answers from the replacement');
  } finally { client.close(); }
});

test('a mutation lost with no roll underway keeps the unknown-outcome answer and never resends', async t => {
  const fixture = await startFixture('papercut.add', 'lose-response');
  t.after(() => cleanup(fixture));
  // No roll record and no replacement: nothing is recorded anywhere, so the
  // honest answer is the established unknown-outcome message with its read.
  const input = { ...PAPERCUT, title: 'No roll', happened: 'today', impact: 'none' };
  const client = localQueueClient(fixture.dataDir, { compatibilityWaitMs: 20_000 });
  try {
    await client.connect();
    await assert.rejects(
      () => client.request('papercut.add', input),
      /Outcome of papercut\.add is unknown.*read-only papercut\.list.*Nucleus did not retry it/,
    );
    assert.equal(await papercutCount(fixture, 'No roll'), 1, 'the first execution stands and nothing was replayed');
  } finally { client.close(); }
});

test('service.request-outcome answers recorded outcomes, and a malformed key fails closed', async t => {
  const fixture = await startFixture('papercut.close', 'lose-response');
  t.after(() => cleanup(fixture));
  const client = new ServiceClient({ socketPath: fixture.oldInfo.socketPath, credential: fixture.oldInfo.credential });
  try {
    await client.connect();
    assert.deepEqual(await client.request('service.request-outcome', { key: 'missing' }), { status: 'not_received' });
    const input = { ...PAPERCUT, title: 'Recorded', happened: 'today', impact: '' };
    await client.request('papercut.add', input, undefined, undefined, 'recorded-key');
    assert.equal((await client.request('service.request-outcome', { key: 'recorded-key' }) as { status: string }).status, 'applied');
    // The same key and input replays without a second effect.
    await client.request('papercut.add', input, undefined, undefined, 'recorded-key');
    assert.equal(await papercutCount(fixture, 'Recorded'), 1, 'the replay never re-ran the handler');
    await assert.rejects(
      () => client.request('papercut.add', input, undefined, undefined, 'bad key with spaces'),
      (error: unknown) => error instanceof ServiceRequestError && error.code === 'invalid_input',
      'a key outside the wire pattern fails closed',
    );
    assert.equal(await papercutCount(fixture, 'Recorded'), 1);
  } finally { await client.close(); }
});

test('a mutation refused before the roll replays its exact refusal', async t => {
  const fixture = await startFixture('papercut.close', 'lose-response');
  t.after(() => cleanup(fixture));
  const added = await rawRead(fixture, 'papercut.add', { ...PAPERCUT, title: 'Twice', happened: 'today', impact: '' }) as { id: string };
  // Close it once for real; the second close is the definite refusal whose
  // response this proxy loses.
  await rawRead(fixture, 'papercut.close', { id: added.id, reason: 'completed', note: '' });
  recordRoll(fixture.dataDir, fixture.oldInfo);
  const client = localQueueClient(fixture.dataDir, { compatibilityWaitMs: 20_000 });
  try {
    await client.connect();
    const pending = client.request('papercut.close', { id: added.id, reason: 'completed', note: '' });
    await waitFor(() => fixture.proxy.interfered >= 1, 'the lost refusal');
    await handOver(fixture);
    await assert.rejects(() => pending, /Papercut already closed/, 'the refusal the lost response carried is replayed as-is');
  } finally { client.close(); }
});

/** Read one papercut id back through the real (unproxied) identity, or fail loudly. */
async function papercutId(fixture: Fixture, title: string): Promise<string> {
  const listed = await rawRead(fixture, 'papercut.list', {}) as Array<{ id: string; title: string }>;
  const found = listed.find(papercut => papercut.title === title);
  assert.ok(found, `the papercut exists: ${JSON.stringify(listed)}`);
  return found.id;
}

async function papercutCount(fixture: Fixture, title: string): Promise<number> {
  const listed = await rawRead(fixture, 'papercut.list', {}) as Array<{ title: string }>;
  return listed.filter(papercut => papercut.title === title).length;
}

/** One direct read against a real service socket: the old one until the hand-over, then the replacement's recorded identity. */
async function rawRead(fixture: Fixture, method: string, input: unknown): Promise<unknown> {
  const info = fixture.newService ? readServiceInfo(fixture.dataDir)! : fixture.oldInfo;
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  try {
    await client.connect();
    return await client.request(method, input);
  } finally { await client.close(); }
}

for (const phase of ['build', 'startup proof']) {
  test(`reads and writes keep using the running service during a failing ${phase}`, async t => {
    const fixture = await startFixture('papercut.close', 'lose-response');
    t.after(() => cleanup(fixture));
    // Bypass the interference proxy: this roll fails without any transport loss.
    writeServiceInfo(fixture.dataDir, fixture.oldInfo);
    const bridge = new ServiceBridge({ processActions: bridgeProcessActions, dataDir: fixture.dataDir, sourcePath: sourcePathFromModule(), paseoHome: fixture.root, serviceCommand: () => { throw new Error("fixture must not spawn"); }, rollSettleMs: 0 });
    const local = localQueueClient(fixture.dataDir, { compatibilityWaitMs: 2_000 });
    t.after(() => { bridge.close(); local.close(); });
    let entered!: () => void, refuse!: (error: Error) => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<never>((_resolve, reject) => { refuse = reject; });
    const staged = { root: fixture.root, buildId: 'next-build' };
    (bridge as unknown as { mainChannel: unknown }).mainChannel = {
      target: async () => ({ key: 'new-revision', revision: 'new-revision' }),
      build: async () => { if (phase === 'build') { entered(); await gate; } return staged; },
      prepare: async () => { entered(); await gate; },
    };
    const rolling = bridge.checkSource(true);
    await reached;
    try {
      assert.equal(readServiceRoll(fixture.dataDir)?.status, 'typechecking');
      for (const surface of ['bridge', 'CLI']) {
        const request = (method: string, input: unknown) => surface === 'bridge'
          ? bridge.forward(RPC_CATALOGUE.find(entry => entry.name === method)!, input)
          : local.request(method, input);
        const input = { ...PAPERCUT, title: `${phase} ${surface}`, happened: 'today', impact: 'roll' };
        assert.ok((await request('papercut.add', input) as { id: string }).id);
        assert.equal((await request('papercut.list', {}) as unknown[]).length > 0, true);
      }
    } finally { refuse(new Error(`${phase} refused`)); }
    const failed = await rolling;
    assert.equal(failed?.status, 'failed');
    assert.match(failed!.detail, /refused/);
    assert.deepEqual(await local.request('lanes', {}), []);
    assert.deepEqual(await bridge.forward(RPC_CATALOGUE.find(entry => entry.name === 'lanes')!, {}), []);
    assert.equal(readServiceInfo(fixture.dataDir)?.pid, fixture.oldInfo.pid);
  });
}

test('a foreign handover that aborts reconnects to the running service', async t => {
  const fixture = await startFixture('papercut.close', 'lose-response');
  t.after(() => cleanup(fixture));
  writeServiceInfo(fixture.dataDir, fixture.oldInfo);
  recordRoll(fixture.dataDir, fixture.oldInfo);
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions, dataDir: fixture.dataDir, sourcePath: sourcePathFromModule(), paseoHome: fixture.root, serviceCommand: () => { throw new Error("fixture must not spawn"); }, handoffWaitMs: 2_000 });
  t.after(() => bridge.close());
  const pending = bridge.forward(RPC_CATALOGUE.find(entry => entry.name === 'lanes')!, {});
  await waitFor(() => bridge.current().state === 'starting', 'handover wait');
  writeServiceRoll(fixture.dataDir, { ...readServiceRoll(fixture.dataDir)!, status: 'failed', detail: 'standby refused' });
  assert.deepEqual(await pending, []);
});

test('an undispatched mutation retries after an aborted handover without asking the ledger', async () => {
  let attempts = 0;
  assert.equal(await callWithRollRecovery({
    method: 'papercut.add', mutating: true, input: {}, waitMs: 2_000,
    attempt: async () => { if (++attempts === 1) throw new CallNotSentError(new Error('handover aborted')); return 'applied'; },
    awaitService: async () => ({}),
    askOutcome: async () => { throw new Error('must not ask for an undispatched request'); },
    confirmingRead: () => 'papercut.list',
  }), 'applied');
  assert.equal(attempts, 2);
});

test('a lost mutation response stays unknown with its request key if recovery cannot connect', async () => {
  let key: string | undefined;
  await assert.rejects(() => callWithRollRecovery({
    method: 'papercut.add', mutating: true, input: {}, waitMs: 2_000,
    attempt: async requestKey => { key = requestKey; throw new Error('Service socket closed'); },
    awaitService: async () => { throw new Error('roll failed'); },
    askOutcome: async () => ({ status: 'not_received' }),
    confirmingRead: () => 'papercut.list',
  }), error => error instanceof UnknownOutcomeError && error.key === key);
});
