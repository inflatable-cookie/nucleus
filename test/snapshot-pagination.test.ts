import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { submissionSchema, SNAPSHOT_DEFAULT_LIMIT, SNAPSHOT_MAX_LIMIT } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { QueueRuntime } from '../service/runtime-owner';
import { QueueService } from '../service/transport/server';
import { ServiceClient, ServiceRequestError } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';
import { MAX_FRAME_BYTES } from '../shared/service/protocol';
import { Store } from '../core/store/store';

function fakeAdapter(dir: string): Adapter {
  return {
    client: { isConnected: true },
    hostId: 'fixture-host',
    socketPath: join(dir, 'callback.sock'),
    helperPath: join(dir, 'worker-helper.mjs'),
    connect: async () => {},
    close: async () => {},
    profiles: async () => [],
    observe: async () => ({ id: 'worker', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }),
  } as unknown as Adapter;
}

function submit(store: Store, id: string, repoPath: string, origin: string) {
  return store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath, planningCommit: 'a'.repeat(40),
    handoffPath: `${id}.md`, originAgentId: 'origin',
  }), 'fixture-host', 'handoff', 'b'.repeat(40), {}, undefined, origin);
}

function seedHistory(store: Store, template: ReturnType<Store['insert']>, count: number, phase: 'done' | 'queued', prefix: string) {
  const insertTask = store.db.prepare('INSERT INTO tasks(id,submission,input_hash,data) VALUES(?,?,?,?)');
  const insertEvent = store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)');
  const at = template.updatedAt;
  store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `${prefix}-${i}`;
      const task = {
        ...template, id, submissionId: id, phase,
        repoPath: template.repoPath, repository: template.repository,
        reason: phase === 'done' ? 'Closed' : `live-${i}`,
        finishedAt: phase === 'done' ? at : null,
        completion: phase === 'done'
          ? { eventId: id, taskId: id, runId: id, status: 'closed', summary: 'c'.repeat(4_000) }
          : null,
      };
      insertTask.run(id, id, id, JSON.stringify(task));
      if (phase === 'done') insertEvent.run(id, at, 'history', 'e'.repeat(8_000));
    }
  });
}

test('a store with more than 1,000 tasks and long histories pages every live task once under the transport bound', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'q')));
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => fakeAdapter(dir), timers: false });
  try {
    await runtime.started;
    const store = runtime.store;
    const alpha = { origin: 'acme/alpha', path: '/repos/alpha' };
    const beta = { origin: 'acme/beta', path: '/repos/beta' };
    store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: alpha });
    const liveAlpha = submit(store, 'live-alpha', alpha.path, alpha.origin);
    const liveBeta = submit(store, 'live-beta', beta.path, beta.origin);
    seedHistory(store, liveAlpha, 1_100, 'queued', 'live-alpha');
    seedHistory(store, liveAlpha, 1_100, 'done', 'done-alpha');
    seedHistory(store, liveBeta, 40, 'queued', 'live-beta');
    store.advanceRevision();

    const boardBefore = runtime.uiSnapshot();
    const compact = runtime.snapshot();
    const compactBytes = Buffer.byteLength(JSON.stringify(compact));
    assert.equal(compact.tasks.length, SNAPSHOT_DEFAULT_LIMIT);
    assert.equal(compact.hasMore, true);
    assert.ok(compact.cursor);
    assert.ok(compactBytes < MAX_FRAME_BYTES, `paged snapshot used ${compactBytes} bytes`);
    assert.equal('handoffText' in compact.tasks[0], false);
    const boardAfter = runtime.uiSnapshot();
    if ("unchanged" in boardBefore || "unchanged" in boardAfter) throw new Error("expected a full board projection");
    assert.equal(boardAfter.revision, boardBefore.revision);
    assert.deepEqual(boardAfter.tasks, boardBefore.tasks, "queue.ui-snapshot is unchanged by a paged snapshot read");

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const page = runtime.snapshot({ limit: 37, cursor });
      pages += 1;
      for (const task of page.tasks) {
        assert.equal(seen.has(task.id), false, `duplicate live task ${task.id}`);
        seen.add(task.id);
        assert.notEqual(task.phase, 'done');
        assert.notEqual(task.phase, 'cancelled');
      }
      if (!page.hasMore) { assert.equal(page.cursor, null); break; }
      assert.ok(page.cursor);
      cursor = page.cursor;
    }
    assert.equal(seen.size, 1_142);
    assert.ok(pages > 1);

    const byRepo = runtime.snapshot({ repository: alpha.origin, limit: SNAPSHOT_MAX_LIMIT });
    assert.equal(byRepo.tasks.length, SNAPSHOT_MAX_LIMIT);
    assert.ok(byRepo.tasks.every(task => task.repository === alpha.origin || task.repoPath === alpha.path));
    assert.equal(byRepo.tasks.some(task => task.id === liveBeta.id), false);

    const byPath = runtime.snapshot({ repository: alpha.path, limit: SNAPSHOT_MAX_LIMIT });
    assert.ok(byPath.tasks.every(task => task.repoPath === alpha.path || task.repository === alpha.origin));

    const byProject = runtime.snapshot({ project: 'suite', limit: SNAPSHOT_MAX_LIMIT });
    assert.equal(byProject.hasMore, true);
    assert.ok(byProject.tasks.some(task => task.id === liveAlpha.id || task.repoPath === alpha.path));
    assert.ok(byProject.tasks.some(task => task.repository === beta.origin || task.repoPath === beta.path));

    const scoped = runtime.snapshot({ project: 'suite', repository: beta.origin, limit: 100 });
    assert.ok(scoped.tasks.every(task => task.repository === beta.origin || task.repoPath === beta.path));
    assert.equal(scoped.tasks.some(task => task.id === liveBeta.id), true);
    assert.equal(scoped.hasMore, false);

    assert.throws(() => runtime.snapshot({ project: 'missing' }), /Unknown project: missing/);
    assert.throws(() => runtime.snapshot({ cursor: 'not-a-cursor' }), /Invalid snapshot cursor/);
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n), 2_242, 'history remains durable');
    assert.equal(runtime.detail({ taskId: 'done-alpha-1099' }).events.some(event => event.kind === 'history'), true);
  } finally {
    await runtime.drain();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI reports method, response size and bound when a response is oversize', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'q')));
  const dataDir = join(dir, 'northstar-queue');
  const service = new QueueService({ owner: { dataDir }, fixture: 'fake', debug: true });
  let client: ServiceClient | undefined;
  try {
    await service.start();
    const info = readServiceInfo(dataDir)!;
    client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
    await client.connect();
    const task = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'cli-oversize', title: 'CLI oversize', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/cli-oversize.md', originAgentId: 'origin',
    }), 'fixture-host', 'Handoff', 'b'.repeat(40)] }) as { id: string };
    await service.debug({ target: 'store', method: 'update', args: [task.id, { reason: 'x'.repeat(MAX_FRAME_BYTES) }] });
    const payload = join(dir, 'snapshot.json');
    writeFileSync(payload, JSON.stringify({ limit: 1 }));
    const root = fileURLToPath(new URL('..', import.meta.url));
    await assert.rejects(
      () => promisify(execFile)(process.execPath, ['bin/queue-cli.mjs', 'snapshot', payload], {
        cwd: root, timeout: 20_000, env: { ...process.env, NUCLEUS_DATA_HOME: dataDir },
      }),
      (error: unknown) => {
        const stderr = error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr: string }).stderr) : '';
        assert.match(stderr, /Response for queue\.snapshot is \d+\.\d MB, over the 16 MiB bound/);
        assert.doesNotMatch(stderr, /^Error: Service socket closed/m);
        return true;
      },
    );
    await service.debug({ target: 'store', method: 'update', args: [task.id, { reason: 'Short' }] });
    const ok = await promisify(execFile)(process.execPath, ['bin/queue-cli.mjs', 'snapshot'], {
      cwd: root, timeout: 10_000, env: { ...process.env, NUCLEUS_DATA_HOME: dataDir },
    });
    const parsed = JSON.parse(ok.stdout) as { tasks: unknown[]; hasMore: boolean; cursor: string | null };
    assert.equal(parsed.tasks.length, 1);
    assert.equal(parsed.hasMore, false);
    assert.equal(parsed.cursor, null);
  } finally {
    await client?.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queue.snapshot paging is served over the socket with the same compact default', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'q')));
  const dataDir = join(dir, 'northstar-queue');
  const service = new QueueService({ owner: { dataDir }, fixture: 'fake', debug: true });
  let client: ServiceClient | undefined;
  try {
    await service.start();
    const info = readServiceInfo(dataDir)!;
    client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
    await client.connect();
    for (let i = 0; i < 3; i++) {
      await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
        submissionId: `rpc-live-${i}`, title: `RPC ${i}`, repoPath: '/fixture', planningCommit: 'a'.repeat(40),
        handoffPath: `docs/handoffs/rpc-${i}.md`, originAgentId: 'origin',
      }), 'fixture-host', 'Handoff', 'b'.repeat(40)] });
    }
    const first = await client.request('queue.snapshot', { limit: 2 }) as { tasks: { id: string }[]; cursor: string; hasMore: boolean };
    assert.equal(first.tasks.length, 2);
    assert.equal(first.hasMore, true);
    const rest = await client.request('queue.snapshot', { limit: 2, cursor: first.cursor }) as { tasks: { id: string }[]; hasMore: boolean; cursor: string | null };
    assert.equal(rest.tasks.length, 1);
    assert.equal(rest.hasMore, false);
    assert.equal(new Set([...first.tasks, ...rest.tasks].map(task => task.id)).size, 3);
    await assert.rejects(() => client!.request('queue.snapshot', { limit: SNAPSHOT_MAX_LIMIT + 1 }), (error: unknown) =>
      error instanceof ServiceRequestError && error.code === 'invalid_input');
  } finally {
    await client?.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
