import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { assertSocketPathWithinBound, socketFixtureDirectory } from './support/socket-fixture';
import { submissionSchema } from '../shared/contracts';
import { QueueService } from '../service/transport/server';
import { ServiceClient } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';
import type { AdmissionOptions } from '../core/host/admission';

/**
 * A blocked call cannot starve every request (nucleus#1179).
 *
 * Reads are served on the persistence executor's single thread, so whatever
 * holds that thread is what a read waits behind. Two shapes are covered here:
 * a host call that never returns (it must hold its admission slot no past its
 * deadline, and must not stop reads while it waits) and a request holding the
 * executor (health must name it with its holder and age).
 */

const base = 'b'.repeat(40);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface Fixture { service: QueueService; client: ServiceClient; dir: string }

async function startService(fixture: string, options: { admission?: AdmissionOptions; heldSlotWarnMs?: number } = {}): Promise<Fixture> {
  const dir = socketFixtureDirectory('queue-service.sock');
  const service = new QueueService({
    owner: { dataDir: dir, timers: false, ...(options.admission ? { admission: options.admission } : {}) },
    fixture, fixtureState: {}, debug: true,
    ...(options.heldSlotWarnMs !== undefined ? { heldSlotWarnMs: options.heldSlotWarnMs } : {}),
  });
  await service.start();
  const info = readServiceInfo(dir)!;
  assertSocketPathWithinBound(info.socketPath);
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  return { service, client, dir };
}

const insert = (submissionId: string) => ({ target: 'store', method: 'insert', args: [submissionSchema.parse({
  submissionId, title: 'A blocked call cannot starve reads', repoPath: '/fixture', planningCommit: base,
  handoffPath: `docs/handoffs/${submissionId}.md`, originAgentId: 'origin',
}), 'fixture-host', 'Handoff', base] });

/** Poll health until `accept` holds; the executor publishes health on a one-second tick. */
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

test('a host call that never returns does not stop reads, and its slot is freed at its deadline', async () => {
  const { service, client, dir } = await startService('hang', { admission: { callDeadlineMs: 600, heldSlotWarnMs: 150 } });
  try {
    const task = await service.debug(insert('held-slot-host')) as { id: string };
    await service.debug({ target: 'fixture', action: 'set-host-hang', value: true });
    // One host catalog read that never returns: it holds the inventory slot.
    const hung = service.debug({ target: 'runtime', method: 'refresh' }).then(() => assert.fail('the hung host call must not answer'), error => error);

    // While it is in flight, every read the planners use answers promptly.
    await sleep(200);
    for (const [method, input] of [
      ['queue.ui-snapshot', {}],
      ['queue.snapshot', {}],
      ['task.next', { taskId: task.id }],
      ['queue.detail', { taskId: task.id }],
    ] as const) {
      const startedAt = Date.now();
      await client.request(method, input);
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 500, `${method} answered in ${elapsedMs} ms while a host call was hung, not waiting on it`);
    }
    const health = await client.request('service.health', {}) as { ready: boolean };
    assert.equal(health.ready, true, 'health still answers while a host call is hung');

    // The deadline abandons the call as unknown, frees the slot and names it.
    const error = await hung;
    assert.ok(error instanceof Error, `the caller hears the abandonment (${error})`);
    assert.match(error.message, /unknown/);
    assert.match(error.message, /not resent/);
    assert.match(error.message, /catalog held its admission slot/, 'the abandonment names the held call and how long it held it');

    const settled = await eventually(
      () => client.request('service.health', {}) as Promise<{ admission: { inventory: { running: number; waiting: number }; heldSlots: unknown[]; abandoned: { count: number; last: { holder?: string } | null } } }>,
      value => value.admission.abandoned.count >= 1,
      'the abandoned host call to reach published health',
    );
    assert.equal(settled.admission.inventory.running, 0, 'the abandoned call freed its class slot');
    assert.equal(settled.admission.abandoned.count, 1, 'exactly one call was abandoned');
    assert.match(settled.admission.abandoned.last?.holder ?? '', /catalog/, 'the abandonment names its holder');
    assert.deepEqual(settled.admission.heldSlots, [], 'nothing is still named as held');

    // Reads still answer promptly after the abandonment, and the slot is reusable.
    const after = Date.now();
    await client.request('queue.detail', { taskId: task.id });
    assert.ok(Date.now() - after < 500, 'a read answers promptly once the slot is free');
    await service.debug({ target: 'fixture', action: 'set-host-hang', value: false });
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service.health names the request holding the executor, its holder and its age', async () => {
  const { service, client, dir } = await startService('slow-db', { heldSlotWarnMs: 100 });
  try {
    const task = await service.debug(insert('held-slot-executor')) as { id: string };
    await service.debug({ target: 'fixture', action: 'set-slow-db', value: 900 });
    const blocking = service.debug({ target: 'store', method: 'update', args: [task.id, { held: true }] });
    // A read queued behind the blocked thread, so the ledger reports both.
    const queued = client.request('queue.detail', { taskId: task.id }, 30_000).catch(error => error);
    await sleep(150);

    const health = await client.request('service.health', {}) as {
      ready: boolean;
      requestTimings: { inFlight: number; held: { held: Array<{ method: string; ageMs: number; startedAt: string }>; inFlight: number; waiting: number; thresholdMs: number } };
    };
    assert.equal(health.ready, true, 'health answers from the request loop while the executor is held');
    const held = health.requestTimings.held;
    assert.equal(held.thresholdMs, 100);
    assert.ok(held.inFlight >= 2, `both requests are outstanding (${held.inFlight})`);
    assert.equal(held.held.length >= 1, true, 'the held slot is named');
    assert.equal(held.held[0]!.method, 'debug:store.update', `the holder is named (${JSON.stringify(held.held)})`);
    assert.ok(held.held[0]!.ageMs >= 100, `the age past the threshold is reported (${held.held[0]!.ageMs} ms)`);
    assert.ok(Date.parse(held.held[0]!.startedAt) > 0, 'the moment the holder started is reported');
    assert.equal(held.waiting >= 1, true, `the queued read is counted behind the holder (${held.waiting})`);

    await blocking;
    await queued;
    const after = await client.request('service.health', {}) as { requestTimings: { held: { held: unknown[]; inFlight: number } } };
    assert.deepEqual(after.requestTimings.held.held, [], 'a settled holder is no longer named');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
