import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSocketPathWithinBound, socketFixtureDirectory } from './support/socket-fixture';
import { submissionSchema } from '../shared/contracts';
import { QueueService } from '../service/transport/server';
import { ServiceClient } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';

/**
 * A long removal on the executor keeps the reads prompt (nucleus#1179
 * acceptance 1, as revised by the planner's ruling).
 *
 * The merge base answers the named reads in 2-17 ms while a host call never
 * returns, so the host-call case is measured fact rather than a hang. The read
 * hang that does reproduce is a removal on the executor thread: `rmSync` walks a
 * checkout synchronously, and every read queues behind it.
 *
 * This test drives the real production removal (`Engine.removeSiblings` over the
 * task's own sibling root) and proves the reads overlap the walk itself, not just
 * the pending request: it watches the checkout's own entry count drop (the walk is
 * deleting inside the tree) and only then reads all four named methods, so a
 * passing result cannot come from reads that ran before the walk or while it sat
 * in Git. It then requires the walk to still have been in progress when every
 * read answered.
 */

const planningCommit = 'b'.repeat(40);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const READ_BOUND_MS = 400;
/**
 * A deep, wide tree: the walk has to readdir every directory, which takes seconds
 * on the configured volume, so the reads below overlap it with room to spare.
 */
const TOP = 60;
const MID = 40;
const FILES = 5;

interface Fixture { service: QueueService; client: ServiceClient; dir: string }

async function startService(): Promise<Fixture> {
  const dir = socketFixtureDirectory('queue-service.sock');
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: 'fake', fixtureState: {}, debug: true });
  await service.start();
  const info = readServiceInfo(dir)!;
  assertSocketPathWithinBound(info.socketPath);
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  return { service, client, dir };
}

const insert = (submissionId: string) => ({ target: 'store', method: 'insert', args: [submissionSchema.parse({
  submissionId, title: 'A removal must not starve reads', repoPath: '/fixture', planningCommit,
  handoffPath: `docs/handoffs/${submissionId}.md`, originAgentId: 'origin',
}), 'fixture-host', 'Handoff', planningCommit] });

test('a long removal on the executor keeps every named read prompt while it walks the tree', async () => {
  const { service, client, dir } = await startService();
  try {
    const task = await service.debug(insert('read-promptness')) as { id: string };
    // The task's own sibling root, which the production cleanup removes.
    const siblingRoot = join(dir, 'siblings', task.id);
    const checkout = join(siblingRoot, 'checkout-0');
    for (let top = 0; top < TOP; top++) {
      for (let mid = 0; mid < MID; mid++) {
        const path = join(checkout, `a-${top}`, `b-${mid}`);
        mkdirSync(path, { recursive: true });
        for (let file = 0; file < FILES; file++) writeFileSync(join(path, `f${file}.js`), 'module.exports = 1;\n');
      }
    }
    // Sentinels spread across the tree: whichever directory the walk reaches first
    // proves it is deleting inside the tree, not sitting in Git or in a queue.
    const sentinels = [0, 1, 2, TOP - 1].flatMap(top => [0, 1, 2, MID - 1].map(mid => join(checkout, `a-${top}`, `b-${mid}`, 'f0.js')));
    assert.equal(sentinels.every(file => existsSync(file)), true, 'the removal target exists');

    const startedAt = Date.now();
    const removal = service.debug({ target: 'engine', method: 'removeSiblings', args: [task.id] });

    // Wait for the walk to delete a sentinel while the checkout root still exists.
    let midWalk = false;
    while (Date.now() - startedAt < 60_000) {
      if (existsSync(checkout) && sentinels.some(file => !existsSync(file))) { midWalk = true; break; }
      if (!existsSync(checkout)) break;
      await sleep(5);
    }
    assert.equal(midWalk, true, 'the filesystem walk was deleting inside the tree when the reads started');
    const walkedMs = Date.now() - startedAt;

    const named = ['queue.ui-snapshot', 'queue.snapshot', 'task.next', 'queue.detail'] as const;
    const reads = await Promise.all(named.map(async method => {
      const input = method === 'task.next' || method === 'queue.detail' ? { taskId: task.id } : {};
      const readStartedAt = Date.now();
      await client.request(method, input);
      return { method, ms: Date.now() - readStartedAt };
    }));
    for (const row of reads)
      assert.ok(row.ms < READ_BOUND_MS, `${row.method} answered in ${row.ms} ms while the executor walked a ${TOP * MID * FILES}-file checkout`);
    // The walk must still have been running when every read answered, otherwise the
    // reads could have slipped into a gap after it finished.
    assert.equal(existsSync(checkout), true, `every read answered while the walk was still running (walk started at ${walkedMs} ms)`);

    await removal;
    assert.equal(existsSync(siblingRoot), false, 'the production removal finished');
    const after = Date.now();
    await client.request('queue.detail', { taskId: task.id });
    assert.ok(Date.now() - after < READ_BOUND_MS, 'reads stay prompt after the removal');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
