import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSocketPathWithinBound, socketFixtureDirectory } from './support/socket-fixture';
import { submissionSchema } from '../shared/contracts';
import { QueueService } from '../service/transport/server';
import { ServiceClient } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';

/**
 * A long removal on the executor keeps the reads prompt (nucleus#1179
 * acceptance 1, revised by the planner's ruling on the measured baseline).
 *
 * The merge base answers the named reads in 2-17 ms while a host call never
 * returns, so the host-call case is measured fact, not a hang. The hang that does
 * reproduce is a removal on the executor thread: `rmSync` walks a checkout
 * synchronously for as long as the walk takes (1.9 s for 2,000 files on the
 * configured volume), and every read queues behind it. This test drives the real
 * production removal (`Engine.removeSiblings` over the task's own sibling root)
 * and reads the three named reads while it runs.
 */

const base = 'b'.repeat(40);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const READ_BOUND_MS = 400;
const FILES = 2_000;

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
  submissionId, title: 'A removal must not starve reads', repoPath: '/fixture', planningCommit: base,
  handoffPath: `docs/handoffs/${submissionId}.md`, originAgentId: 'origin',
}), 'fixture-host', 'Handoff', base] });

test('a long removal on the executor does not stop board, task.next or queue.detail', async () => {
  const { service, client, dir } = await startService();
  try {
    const task = await service.debug(insert('read-promptness')) as { id: string };
    // The task's own sibling root, which the production cleanup removes.
    const siblingRoot = join(dir, 'siblings', task.id);
    const checkout = join(siblingRoot, 'checkout-0');
    for (let directory = 0; directory < 40; directory++) {
      const path = join(checkout, `node_modules-${directory}`, 'fixture');
      mkdirSync(path, { recursive: true });
      for (let file = 0; file < FILES / 40; file++) writeFileSync(join(path, `file-${file}.js`), 'module.exports = 1;\n');
    }
    assert.ok(existsSync(checkout), 'the removal target exists');

    // Start the production removal, then keep reading until it settles. The
    // removal spends part of its life in an async Git call and part of it inside
    // the walk itself, so a single burst can slip between the two; repeating the
    // reads guarantees some of them start while the walk is holding the thread.
    let removing = true;
    const removalStartedAt = Date.now();
    const removal = service.debug({ target: 'engine', method: 'removeSiblings', args: [task.id] })
      .then(value => { removing = false; return value; }, error => { removing = false; throw error; });
    const named = ['queue.ui-snapshot', 'queue.snapshot', 'task.next', 'queue.detail'] as const;
    const observed: Array<{ method: string; ms: number; startedWhileRemoving: boolean }> = [];
    while (removing && observed.length < 240) {
      for (const method of named) {
        const input = method === 'task.next' || method === 'queue.detail' ? { taskId: task.id } : {};
        const startedWhileRemoving = removing;
        const startedAt = Date.now();
        await client.request(method, input);
        observed.push({ method, ms: Date.now() - startedAt, startedWhileRemoving });
        if (!removing) break;
      }
    }
    const removalMs = Date.now() - removalStartedAt;
    const duringRemoval = observed.filter(row => row.startedWhileRemoving);
    assert.ok(duringRemoval.length >= 2, `reads ran while the removal was in flight (${duringRemoval.length} of ${observed.length})`);
    for (const row of duringRemoval)
      assert.ok(row.ms < READ_BOUND_MS, `${row.method} answered in ${row.ms} ms while the executor removed a 2,000-file checkout (${removalMs} ms removal)`);

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
