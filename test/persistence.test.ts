import {test} from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { assertSocketPathWithinBound, socketFixtureDirectory } from './support/socket-fixture';
import { submissionSchema } from '../shared/contracts';
import { QueueService } from '../service/transport/server';
import { ServiceClient, ServiceRequestError } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';

/**
 * g01.027 acceptance oracle (Spec 013 "Asynchronous persistence").
 *
 * A five-second database fixture inside the single persistence executor cannot
 * delay `service.health` or a cached board read; mutations keep their exact
 * serial order with short serialized transactions; executor saturation returns
 * typed backpressure instead of a longer timeout; and a drain still leaves one
 * writable owner. Every fixture uses fake adapters and a temporary store: no
 * live Queue or Paseo state is touched.
 */

const base = 'b'.repeat(40);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface Fixture { service: QueueService; client: ServiceClient; dataDir: string; dir: string }

async function startService(fixture: string, fixtureState: Record<string, unknown> = {}): Promise<Fixture> {
  const dir = socketFixtureDirectory('queue-service.sock');
  const dataDir = dir;
  const service = new QueueService({ owner: { dataDir, timers: false }, fixture, fixtureState, debug: true });
  await service.start();
  const info = readServiceInfo(dataDir)!;
  assertSocketPathWithinBound(info.socketPath);
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  return { service, client, dataDir, dir };
}

const insert = (submissionId: string) => ({ target: 'store', method: 'insert', args: [submissionSchema.parse({
  submissionId, title: 'Asynchronous persistence', repoPath: '/fixture', planningCommit: base,
  handoffPath: `docs/handoffs/${submissionId}.md`, originAgentId: 'origin',
}), 'fixture-host', 'Handoff', base] });

test('a five-second database operation cannot delay service health or a cached board read', async () => {
  const fixture = await startService('slow-db', { slowDbMs: 0 });
  const { service, client, dir } = fixture;
  try {
    const task = await service.debug(insert('persist-1')) as { id: string; version: number };
    const board = await client.request('queue.ui-snapshot', {}) as { revision: number };
    assert.equal(typeof board.revision, 'number');

    // Arm the five-second database fixture, then start a mutation that must
    // stall inside the persistence executor while the request loop keeps
    // answering health and cached board reads.
    await service.debug({ target: 'fixture', action: 'set-slow-db', value: 5_000 });
    const stalled = service.debug({ target: 'store', method: 'update', args: [task.id, { held: true }] });

    const queuedRead = client.request('queue.detail', { taskId: task.id });
    const healthStart = Date.now();
    const health = await client.request('service.health', {}) as Record<string, unknown>;
    const healthMs = Date.now() - healthStart;
    assert.equal(health.ready, true, 'the service stays ready during delayed database work');
    assert.ok(healthMs < 200, `health answered from the executor snapshot in ${healthMs} ms`);

    const ackStart = Date.now();
    const ack = await client.request('queue.ui-snapshot', { revision: board.revision }) as Record<string, unknown>;
    const ackMs = Date.now() - ackStart;
    assert.equal(ack.unchanged, true, 'the unchanged revision is acknowledged from the in-memory projection');
    assert.ok(ackMs < 100, `a cached board read must not wait behind the delayed database operation (took ${ackMs} ms)`);

    // The stalled mutation settles exactly once after its delay, and the cache
    // then serves the new revision instead of a stale acknowledgement.
    await stalled;
    await queuedRead;
    const measured = await client.request('service.health', {}) as { requestTimings: { recent: import('../service/executor/executor').ExecutorRequestTiming[] } };
    const delayed = measured.requestTimings.recent.find(row => row.handlerMs! >= 4_900);
    const waiting = measured.requestTimings.recent.find(row => row.method === 'queue.detail');
    assert.ok(delayed, 'the database stall is attributed to handler work');
    assert.ok(waiting && waiting.queueMs! > 4_000, 'the detail wait is attributed to executor queue delay');
    for (const row of measured.requestTimings.recent) {
      for (const key of ['totalMs', 'queueMs', 'handlerMs', 'publicationMs', 'returnMs'] as const)
        assert.ok(Number.isFinite(row[key]) && row[key]! >= 0, key);
    }

    const settled = await service.debug({ target: 'store', method: 'task', args: [task.id] }) as { held: boolean; version: number };
    assert.equal(settled.held, true);
    assert.equal(settled.version, task.version + 1, 'the delayed mutation landed exactly once');
    const refreshed = await client.request('queue.ui-snapshot', { revision: board.revision }) as { unchanged?: unknown };
    assert.equal(refreshed.unchanged, undefined, 'a completed durable change must invalidate the cached acknowledgement');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutations apply in submission order with exact versions behind one serialized executor', async () => {
  const fixture = await startService('slow-db', { slowDbMs: 25 });
  const { service, client, dir } = fixture;
  try {
    const task = await service.debug(insert('persist-order-1')) as { id: string; version: number };
    // Fire four mutations without awaiting; the executor applies them in
    // exactly the submitted order with one short transaction each.
    const first = service.debug({ target: 'store', method: 'update', args: [task.id, { held: true }] });
    const second = service.debug({ target: 'store', method: 'update', args: [task.id, { reason: 'second hold marker' }] });
    const third = service.debug({ target: 'store', method: 'update', args: [task.id, { held: false }] });
    const fourth = service.debug({ target: 'store', method: 'update', args: [task.id, { reason: 'released marker' }] });
    await Promise.all([first, second, third, fourth]);
    const settled = await service.debug({ target: 'store', method: 'task', args: [task.id] }) as { held: boolean; version: number; reason: string };
    assert.equal(settled.version, task.version + 4, 'every mutation advanced the version exactly once');
    assert.equal(settled.held, false, 'the final hold state matches the last mutation');
    assert.equal(settled.reason, 'released marker');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executor saturation returns typed backpressure instead of a longer timeout', async () => {
  const fixture = await startService('slow-db', { slowDbMs: 100 });
  const { service, client, dataDir, dir } = fixture;
  try {
    const task = await service.debug(insert('persist-busy-1')) as { id: string; version: number };
    // Flood the executor with slow detail reads across four connections; the
    // executor bound is 96 in-flight operations, so requests beyond it must be
    // answered with typed busy backpressure immediately.
    const clients: ServiceClient[] = [client];
    for (let i = 0; i < 3; i++) {
      const info = readServiceInfo(dataDir)!;
      const extra = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
      await extra.connect();
      clients.push(extra);
    }
    const results: Promise<unknown>[] = [];
    for (const connection of clients) {
      for (let i = 0; i < 26; i++) {
        results.push(connection.request('queue.detail', { taskId: task.id }, 30_000).catch(error => error));
      }
    }
    const settled = await Promise.all(results);
    const busies = settled.filter(result => result instanceof ServiceRequestError && result.code === 'busy');
    assert.ok(busies.length >= 4, `saturation beyond the executor bound must answer with typed busy backpressure (got ${busies.length} busy results)`);
    // Every admitted request still settled exactly once: no lost work.
    const completed = settled.filter(result => !(result instanceof ServiceRequestError)).length;
    assert.equal(completed, settled.length - busies.length, 'every admitted request answered');
    for (const connection of clients.slice(1)) connection.close();
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drain releases the store and a fresh service reopens the same identities', async () => {
  const fixture = await startService('slow-db', { slowDbMs: 0 });
  const { service, client, dataDir, dir } = fixture;
  try {
    await service.debug(insert('persist-stop-1'));
    const health = await client.request('service.health', {}) as Record<string, unknown>;
    assert.equal(health.ready, true);
    assert.ok((health as { taskIdentities: number }).taskIdentities >= 1, 'health reads the executor store without SQLite on the request loop');
  } finally {
    await client.close();
    await service.stop();
  }
  assert.ok(!existsSync(service.socketPath), 'drain must release the socket');
  const again = new QueueService({ owner: { dataDir, timers: false }, fixture: 'slow-db', fixtureState: {}, debug: true });
  await again.start();
  await again.stop();
  rmSync(dir, { recursive: true, force: true });
});


test('a completed mutation publishes despite a slow-board budget', async () => {
  const { service, client } = await startService('slow-db', { projectionDelayMs: 125 });
  try {
    const task = await service.debug(insert('publish-mutation')) as { id: string };
    const before = await client.request('queue.ui-snapshot', {}) as { revision: number };
    await service.debug({ target: 'store', method: 'update', args: [task.id, { reason: 'published immediately' }] });
    const after = await client.request('queue.ui-snapshot', { revision: before.revision }) as { unchanged?: boolean; tasks?: Array<{ id: string; reason: string }> };
    assert.notEqual(after.unchanged, true);
    assert.equal(after.tasks?.find(item => item.id === task.id)?.reason, 'published immediately');
  } finally { await client.close(); await service.stop(); }
});
