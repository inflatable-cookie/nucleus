import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { submissionSchema, type Run } from '../shared/contracts';
import { QueueService } from '../service/transport/server';
import { ServiceClient, ServiceRequestError } from '../shared/service/client';
import { readServiceExecutorFault, readServiceInfo, SERVICE_EXECUTOR_FAULT_FILE } from '../service/transport/identity';

/**
 * Persistence write-boundary and executor fault oracles (Spec 013 "Asynchronous
 * persistence"). Every fixture lives in a fresh mkdtemp directory with fake
 * adapters: no live Queue, Paseo or consumer state is touched, and no fault is
 * injected into production records. Executor faults come from the named test
 * fixtures in the worker registry only.
 */

const base = 'b'.repeat(40);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function until(condition: () => boolean, label: string, limitMs = 5_000) {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

function storeFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ns-persist-faults-')));
  const path = join(dir, 'queue.sqlite');
  const store = new Store(path);
  const task = store.insert(submissionSchema.parse({ submissionId: 'task', title: 'Task', repoPath: '/repo',
    planningCommit: base, handoffPath: 'task.md', originAgentId: 'origin' }), 'host', 'h', base);
  return { dir, path, store, task };
}

const rowOf = (store: Store, id: string) => String((store.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as { data: string }).data);
const runOf = (store: Store, id: string) => String((store.db.prepare('SELECT data FROM runs WHERE id=?').get(id) as { data: string }).data);
const credentialOf = (store: Store, run: string) => String((store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(run) as { hash: string }).hash);
const eventCount = (store: Store, id: string) => (store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE taskId=?').get(id) as { n: number }).n;

test('an invalid nested task write rolls back its row, revision, events, notices and the prior authenticated result', () => {
  const f = storeFixture();
  try {
    // An accepted worker result: the run's credential and its authenticated completion,
    // mirrored on the task. A refused write must leave every piece of it as it was.
    const runId = 'run-accepted', token = 'accepted-callback-token';
    const completion = { eventId: 'accepted-event', taskId: f.task.id, runId, status: 'ready_for_review' as const, summary: 'accepted worker result' };
    f.store.setCredential(runId, token);
    f.store.putRun({ id: runId, taskId: f.task.id, role: 'revision', generation: 1, head: 'a'.repeat(40), base, agentId: null, workspaceId: '',
      profile: null, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null,
      completion, released: false } as Run);
    const accepted = f.store.update(f.task.id, { completion, runId }, 'callback_accepted', 'accepted worker result');

    const row = rowOf(f.store, f.task.id), runRow = runOf(f.store, runId), credential = credentialOf(f.store, runId);
    const events = eventCount(f.store, f.task.id), notices = f.store.notices(f.task.id).length;
    const revision = f.store.getMeta<number>('boardRevision');
    assert.throws(() => f.store.update(f.task.id, {
      reason: 'should not commit',
      resolution: { ...accepted.resolution, recoveryAttempts: 'many' as unknown as number },
    }, 'probe', 'refused write'), /recoveryAttempts/);

    assert.equal(rowOf(f.store, f.task.id), row, 'the persisted task JSON is unchanged');
    assert.equal(runOf(f.store, runId), runRow, 'the accepted run record is unchanged');
    assert.equal(credentialOf(f.store, runId), credential, 'the callback credential is unchanged');
    assert.doesNotThrow(() => f.store.authenticate(runId, token), 'the prior callback still authenticates');
    assert.deepEqual(f.store.task(f.task.id).completion, completion, 'the accepted result is still on the task');
    assert.equal(eventCount(f.store, f.task.id), events, 'no event row survives the refusal');
    assert.equal(f.store.notices(f.task.id).length, notices, 'no notice row survives the refusal');
    assert.equal(f.store.getMeta<number>('boardRevision'), revision, 'the board revision does not advance');
    assert.equal(f.store.task(f.task.id).reason, accepted.reason, 'the warm projection serves the prior record');
    assert.equal(f.store.task(f.task.id).version, accepted.version);
    // A cold reader parses every stored row: the refusal left nothing unreadable behind.
    f.store.close();
    const reopened = new Store(f.path);
    try {
      assert.equal(reopened.task(f.task.id).version, accepted.version);
      assert.deepEqual(reopened.task(f.task.id).completion, completion);
    } finally { reopened.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a valid external-merge reason beyond 4000 characters stays byte-complete across reopen', () => {
  const f = storeFixture();
  const reason = Array.from({ length: 5264 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('');
  try {
    f.store.update(f.task.id, {
      resolution: { ...f.task.resolution, externalMergePreAttention: { phase: f.task.phase, reason } },
    }, 'external_merge', 'saved reason');
    assert.equal(f.store.task(f.task.id).resolution.externalMergePreAttention?.reason, reason);
    f.store.close();
    const reopened = new Store(f.path);
    try {
      const cold = reopened.task(f.task.id).resolution.externalMergePreAttention;
      assert.equal(cold?.reason.length, 5264);
      assert.equal(cold?.reason, reason, 'the cold read returns the saved text verbatim');
    } finally { reopened.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

interface Fixture { service: QueueService; client: ServiceClient; dataDir: string; dir: string }

async function startService(fixture: string, fixtureState: Record<string, unknown> = {}, onExecutorDeath?: () => void): Promise<Fixture> {
  // Short prefix: the service socket path must stay under the local transport bound.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq')));
  const dataDir = join(dir, 'northstar-queue');
  const service = new QueueService({ owner: { dataDir, timers: false }, fixture, fixtureState, debug: true, onExecutorDeath });
  await service.start();
  const info = readServiceInfo(dataDir)!;
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  return { service, client, dataDir, dir };
}

const insert = (submissionId: string) => ({ target: 'store', method: 'insert', args: [submissionSchema.parse({
  submissionId, title: 'Persistence faults', repoPath: '/fixture', planningCommit: base,
  handoffPath: `docs/handoffs/${submissionId}.md`, originAgentId: 'origin',
}), 'fixture-host', 'Handoff', base] });

const requestCode = (error: unknown) => error instanceof ServiceRequestError ? error.code : null;

/**
 * Arming the fault: the arming reply itself publishes after its handler, so it is
 * the first refused publication and must answer as an uncertain outcome.
 */
async function armProjectionFault(service: QueueService, value: true | 'clone' = true) {
  const reply = await service.debug({ target: 'fixture', action: 'set-projection-fault', value }).then(() => null, (error: Error) => error);
  assert.ok(reply, 'the arming reply is refused');
  assert.match(reply.message, /outcome is uncertain/);
}

test('an invalid persisted write is refused through the executor with the prior record intact', async () => {
  const fixture = await startService('fake');
  const { service, client, dir } = fixture;
  try {
    const task = await service.debug(insert('fault-invalid-1')) as { id: string; version: number };
    await assert.rejects(service.debug({ target: 'store', method: 'update', args: [task.id, { resolution: { recoveryAttempts: 'many' } }] }), /recoveryAttempts/);
    const settled = await service.debug({ target: 'store', method: 'task', args: [task.id] }) as { version: number };
    assert.equal(settled.version, task.version, 'a refused write never advances the task version');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a projection publication fault keeps the worker alive, withholds health and the board, and recovers on a fresh publication', async () => {
  const fixture = await startService('fake');
  const { service, client, dir } = fixture;
  try {
    await service.debug(insert('fault-projection-1'));
    await armProjectionFault(service);
    await until(() => service.executor.fault()?.kind === 'projection', 'the projection fault');
    await until(() => (service.executor.fault()?.repeats ?? 0) >= 2, 'repeated projection failures');

    // The executor is alive: the fault is a projection fault, never an exit.
    assert.equal(service.executor.fault()?.kind, 'projection');
    const health = await client.request('service.health', {}).catch(error => error);
    assert.equal(requestCode(health), 'unavailable');
    assert.match((health as Error).message, /not publishing/);
    assert.match((health as Error).message, /Stack: .*Fixture projection publication fault/s, 'the refusal carries the bounded stack');
    const board = await client.request('queue.ui-snapshot', {}).catch(error => error);
    assert.equal(requestCode(board), 'unavailable', 'a stale cached board never answers as current');
    assert.equal(existsSync(join(fixture.dataDir, SERVICE_EXECUTOR_FAULT_FILE)), false, 'a projection fault is not a death record');

    await service.debug({ target: 'fixture', action: 'set-projection-fault', value: false });
    await until(() => service.executor.fault() === null, 'a fresh successful projection');
    const healthy = await client.request('service.health', {}) as { ready: boolean };
    assert.equal(healthy.ready, true);
    const fresh = await client.request('queue.ui-snapshot', {}) as { revision: number };
    assert.equal(typeof fresh.revision, 'number');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed board post does not advance the publication cursor, so recovery resends the board the parent is missing', async () => {
  const fixture = await startService('fake');
  const { service, client, dir } = fixture;
  try {
    const task = await service.debug(insert('fault-cursor-1')) as { id: string; version: number };
    await client.request('queue.ui-snapshot', {});
    // Every publication now fails at postMessage: the board never reaches the parent.
    await armProjectionFault(service, 'clone');
    await until(() => service.executor.fault()?.kind === 'projection', 'the post fault');
    const changed = 'changed while the board was unpublished';
    const uncertain = await service.debug({ target: 'store', method: 'update', args: [task.id, { reason: changed }] }).then(() => null, (error: Error) => error);
    assert.ok(uncertain, 'the change during the fault is reported as uncertain');

    await service.debug({ target: 'fixture', action: 'set-projection-fault', value: false });
    await until(() => service.executor.fault() === null, 'a fresh successful publication');
    // A cursor that advanced on the failed post would answer "unchanged" here and leave the
    // parent's older task list in place under the new revision.
    const board = await client.request('queue.ui-snapshot', {}) as { unchanged?: true; revision: number; tasks: { id: string; reason: string }[] };
    assert.equal(board.unchanged, undefined, 'the parent receives a full board, not an acknowledgement');
    assert.equal(board.revision, service.executor.current().revision);
    assert.equal(board.tasks.find(row => row.id === task.id)?.reason, changed, 'the parent board shows the change made while unpublished');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a committed write whose projection fails is reported as uncertain and applied exactly once', async () => {
  const fixture = await startService('fake');
  const { service, client, dir } = fixture;
  try {
    const task = await service.debug(insert('fault-postcommit-1')) as { id: string; version: number };
    await armProjectionFault(service);
    await until(() => service.executor.fault()?.kind === 'projection', 'the projection fault');

    const uncertain = await service.debug({ target: 'store', method: 'update', args: [task.id, { held: true }] }).catch(error => error as Error);
    assert.ok(uncertain instanceof Error, 'the caller does not receive a success');
    assert.match(uncertain.message, /outcome is uncertain/);

    await service.debug({ target: 'fixture', action: 'set-projection-fault', value: false });
    await until(() => service.executor.fault() === null, 'a fresh successful projection');
    const settled = await service.debug({ target: 'store', method: 'task', args: [task.id] }) as { held: boolean; version: number };
    assert.equal(settled.held, true, 'the committed change is durable');
    assert.equal(settled.version, task.version + 1, 'the change landed exactly once: no replay was needed or performed');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [crash, label] of [['error', 'an unhandled worker error'], ['exit-nonzero', 'an unexpected nonzero exit'], ['exit-zero', 'an unexpected zero exit']] as const) {
  test(`${label} rejects pending work promptly and retains its cause on health, the board and the diagnostic record`, async () => {
    const fixture = await startService('fake');
    const { service, client, dataDir, dir } = fixture;
    try {
      await service.debug(insert(`fault-${crash}-1`));
      const started = Date.now();
      const pending = service.debug({ target: 'fixture', action: 'crash', value: crash }).catch(error => error as ServiceRequestError | Error);
      const lost = await pending;
      assert.ok(Date.now() - started < 5_000, `the pending request settles promptly (took ${Date.now() - started} ms)`);
      assert.ok(lost instanceof Error);
      assert.match(lost.message, /gone/);

      const fault = service.executor.fault();
      assert.ok(fault, 'the death is retained');
      assert.equal(fault.kind, crash === 'error' ? 'error' : 'exited');
      assert.equal(fault.exitCode, crash === 'error' ? null : crash === 'exit-zero' ? 0 : 3);
      assert.ok(fault.message.length <= 512 && fault.stack.length <= 2_000, 'the retained cause stays bounded');

      const health = await client.request('service.health', {}).catch(error => error);
      assert.equal(requestCode(health), 'unavailable', 'health stops reporting the cached ready state');
      assert.match((health as Error).message, /gone/);
      if (crash === 'error') assert.match((health as Error).message, /Stack: .*Fixture executor fault/s, 'the refusal carries the bounded stack');
      const board = await client.request('queue.ui-snapshot', {}).catch(error => error);
      assert.equal(requestCode(board), 'unavailable', 'the cached board is withheld');
      assert.match((board as Error).message, /gone/);
      const detail = await client.request('queue.detail', { taskId: 'missing' }).catch(error => error);
      assert.equal(requestCode(detail), 'unavailable', 'requests fail closed once the worker is dead');

      const record = readServiceExecutorFault(dataDir);
      assert.ok(record, 'the death is kept in the owner-only diagnostic record');
      assert.equal(record.pid, process.pid);
      assert.equal(record.kind, fault.kind);
      assert.equal(record.exitCode, fault.exitCode);
      assert.equal(record.message, fault.message);
    } finally {
      await client.close();
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a dead worker tells the service to go, once, so the bridge can replace it', async () => {
  let deaths = 0;
  const { service, client, dir } = await startService('fake', {}, () => { deaths++; });
  try {
    await service.debug({ target: 'fixture', action: 'crash', value: 'error' }).catch(() => {});
    for (let i = 0; i < 100 && !deaths; i++) await sleep(20);
    assert.equal(deaths, 1);
    await sleep(100);
    assert.equal(deaths, 1, 'one death, one exit');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deliberate drain does not read as a dead worker', async () => {
  let deaths = 0;
  const { service, client, dir } = await startService('fake', {}, () => { deaths++; });
  try {
    await client.close();
    await service.stop();
    assert.equal(deaths, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deliberate drain is not classified as an executor loss', async () => {
  const fixture = await startService('fake');
  const { service, client, dataDir, dir } = fixture;
  try {
    await service.debug(insert('fault-drain-1'));
    await client.close();
    await service.stop();
    assert.equal(service.executor.fault(), null, 'a drain retains no executor fault');
    assert.equal(existsSync(join(dataDir, SERVICE_EXECUTOR_FAULT_FILE)), false, 'a drain writes no death record');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a worker that dies during boot rejects start without advancing the boot watchdog', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq')));
  const dataDir = join(dir, 'northstar-queue');
  const service = new QueueService({ owner: { dataDir, timers: false }, fixture: 'boot-crash', fixtureState: {}, debug: true });
  // Keep the parent watchdog parked while the real worker fails. The error
  // must settle boot without a timeout, regardless of host module-load speed.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assert.rejects(service.start(), /Fixture boot crash|exited before publishing/);
    assert.ok(service.executor.fault(), 'the boot death is retained');
  } finally {
    t.mock.timers.reset();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-11-07: a roll's replacement that never started was stopped by the bridge, and its
// cleanup unlinked the live service's socket. The live service kept running and owning the
// store with no way in, and every CLI and board call hung for 19 minutes.
test('a service that never bound the socket leaves the live socket file alone when stopped', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq')));
  const dataDir = join(dir, 'northstar-queue');
  try {
    const service = new QueueService({ owner: { dataDir, timers: false }, fixture: 'fake', fixtureState: {}, debug: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(service.socketPath, 'live owner socket');
    await service.stop();
    assert.equal(existsSync(service.socketPath), true, 'the live owner keeps its socket');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
