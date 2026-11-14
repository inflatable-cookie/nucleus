import { observeIdle } from './support/fakes';
import { bridgeProcessActions } from "../service/install/bridge-process-actions";
import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, realpathSync, mkdirSync, copyFileSync} from 'node:fs';
import { socketFixtureDirectory, assertSocketPathWithinBound } from './support/socket-fixture';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect} from 'node:net';
import {fileURLToPath} from 'node:url';
import { resolutionSchema, submissionSchema, taskControlInputSchema, type Completion, type ReviewVerdict, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { QueueService } from '../service/transport/server';
import { QueueRuntime } from '../service/runtime-owner';
import { Store, digest, operationInputHash } from '../core/store/store';
import { ServiceClient, ServiceRequestError } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';
import { PROTOCOL_VERSION, MAX_FRAME_BYTES, createFrameReader, encodeFrame } from '../shared/service/protocol';
import { currentServiceBuildId } from '../shared/service/build';
import { RPC_CATALOGUE } from '../shared/rpc-catalogue';
import { formatAgentId } from '../shared/agent-identity';
import { defaultHostRunStateDir } from '../service/callbacks/host-run-endpoint';
import { EXTERNAL_MERGE_CHECK_REASON_PREFIX } from '../core/resolution';

/** Minimal fake adapter: enough of the Paseo surface for a quiet fixture store. */
function fakeAdapter(dir: string): Adapter {
  return {
    client: { isConnected: true },
    hostId: 'fixture-host',
    socketPath: join(dir, 'callback.sock'),
    helperPath: join(dir, 'worker-helper.mjs'),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
    observe: observeIdle('ws', 'worker'),
  } as unknown as Adapter;
}

interface Fixture { service: QueueService; client: ServiceClient; dir: string }

test('a non-live runtime refuses an explicitly configured live host-run state dir before opening its store', () => {
  const root = mkdtempSync(join(tmpdir(), 'q'));
  const dataDir = join(root, 'northstar-queue');
  assert.throws(() => new QueueRuntime({ dataDir, hostRunStateDir: defaultHostRunStateDir() }), /non-live Nucleus data directory.*live host-run state directory/);
  assert.equal(existsSync(dataDir), false, 'refusal happens before creating the isolated store directory');
  rmSync(root, { recursive: true, force: true });
});

// The root prefix stays short: the service binds queue-service.sock inside the
// data directory, and macOS rejects a Unix socket path over ~104 bytes, which a
// deep TMPDIR would otherwise exceed.
async function startFixture(options: { dataDir?: string } = {}): Promise<Fixture> {
  const dataDir = options.dataDir ?? socketFixtureDirectory('queue-service.sock');
  const dir = dataDir;
  const service = new QueueService({
    owner: { dataDir },
    fixture: 'fake', debug: true,
  });
  await service.start();
  const info = readServiceInfo(dataDir);
  if (info) assertSocketPathWithinBound(info.socketPath);
  assert.ok(info, 'the service must publish its owner-only identity file');
  assert.equal(info.protocolVersion, PROTOCOL_VERSION);
  assert.equal(info.buildId, currentServiceBuildId());
  assert.equal(existsSync(info.socketPath), true);
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  return { service, client, dir: dataDir };
}

test('service transport parity: catalogue RPCs over the socket match the durable store', async () => {
  const { service, client, dir } = await startFixture();
  try {
    // Two consecutive reads return identical projections from the revisioned cache.
    const first = await client.request('queue.ui-snapshot', {});
    const again = await client.request('queue.ui-snapshot', {});
    assert.deepEqual(first, again, 'socket responses must be identical for the same revision');
    assert.ok(Array.isArray((first as { tasks: unknown[] }).tasks));

    // Mutation keeps its durable identity and lands in the executor-owned store.
    const paused = await client.request('queue.control', { paused: false });
    assert.deepEqual(paused, { ok: true });
    assert.equal(await service.debug({ target: 'store', method: 'getMeta', args: ['paused'] }), false);

    // Health is typed and bounded: no secrets, no private credential.
    const health = await client.request('service.health', {}) as Record<string, unknown>;
    assert.equal(health.protocolVersion, PROTOCOL_VERSION);
    assert.equal(health.buildId, currentServiceBuildId());
    assert.equal(health.service, 'nucleus');
    assert.equal(typeof health.paused, 'boolean');
    assert.ok(!JSON.stringify(health).includes(readServiceInfo(dir)!.credential));

    // Unknown methods fail closed with a typed error.
    await assert.rejects(() => client.request('queue.not-a-method', {}), (error: unknown) =>
      error instanceof ServiceRequestError && error.code === 'method_unknown');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live snapshot omits handoff text and completed tasks while detail retains their closeout', async () => {
  const { service, client, dir } = await startFixture();
  try {
    const handoffText = 'handoff '.repeat(125_000);
    const task = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'snapshot-1', title: 'Snapshot', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/snapshot-1.md', originAgentId: 'origin', notifyOriginOnCloseout: true,
    }), 'fixture-host', handoffText, 'b'.repeat(40)] }) as { id: string; number: number; reference: string };
    assert.equal(task.number, 1);
    assert.equal(task.reference, 'fixture#001');
    const board = await client.request('queue.ui-snapshot', {}) as {
      revision: number; tasks: unknown[]; connected: boolean; paused: boolean; quiet: boolean;
      activeWorkers: number; unsettled: number; error: string;
    };
    const first = await client.request('queue.snapshot', {}) as { tasks: Record<string, unknown>[] };
    const again = await client.request('queue.snapshot', {}) as { tasks: Record<string, unknown>[] };
    assert.deepEqual(first, again);
    assert.equal(first.tasks.length, 1);
    assert.equal('handoffText' in first.tasks[0], false);
    await service.debug({ target: 'store', method: 'update', args: [task.id, { held: true, mergeHold: true }] });
    const heldSnapshot = await client.request('queue.snapshot', {}) as { tasks: Record<string, unknown>[] };
    assert.equal(heldSnapshot.tasks[0].holdKind, 'merge');
    const detail = await client.request('queue.detail', { taskId: task.id }) as { task: { handoffText: string } };
    assert.equal(detail.task.handoffText, handoffText);
    assert.equal((detail.task as { holdKind?: string }).holdKind, 'merge');
    const numberedDetail = await client.request('queue.detail', { reference: 'fixture#1' }) as { task: { id: string } };
    assert.equal(numberedDetail.task.id, task.id);
    const structuredDetail = await client.request('queue.detail', { repository: '/fixture', number: 1 }) as { task: { id: string } };
    assert.equal(structuredDetail.task.id, task.id);
    const completion = { eventId: 'closeout', taskId: task.id, runId: 'run', status: 'closed', summary: 'Merged and closed', prNumber: 42, head: 'c'.repeat(40) };
    await service.debug({ target: 'store', method: 'update', args: [task.id, { originWorkspaceId: 'origin-ws' }] });
    await service.debug({ target: 'store', method: 'update', args: [task.id, { phase: 'done', completion }] });
    const afterCloseout = await client.request('queue.snapshot', {}) as { tasks: unknown[] };
    assert.equal(afterCloseout.tasks.length, 0);
    const completedDetail = await client.request('queue.detail', { taskId: task.id }) as { task: { handoffText: string; completion: typeof completion } };
    assert.equal(completedDetail.task.handoffText, handoffText);
    assert.deepEqual(completedDetail.task.completion, completion);
    const outcomeByReference = await client.request('queue.outcome', { reference: 'fixture#1' }) as { taskId: string; number: number; reference: string };
    assert.deepEqual([outcomeByReference.taskId, outcomeByReference.number, outcomeByReference.reference], [task.id, 1, 'fixture#001']);
    const outcomeByNumber = await client.request('queue.outcome', { repository: '/fixture', number: 1 }) as { taskId: string };
    assert.equal(outcomeByNumber.taskId, task.id);
    assert.equal((completedDetail.task as typeof completedDetail.task & { originAgentId: string }).originAgentId, 'origin');
    const notices = completedDetail as typeof completedDetail & { notices: { recipientAgentId: string; status: string }[] };
    assert.ok(notices.notices.some(notice => notice.recipientAgentId === 'origin' && notice.status === 'pending'));
    const dependent = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'dependent-1', title: 'Dependent', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/dependent-1.md', originAgentId: 'origin', dependsOn: [task.id],
    }), 'fixture-host', 'Dependent handoff', 'b'.repeat(40)] }) as { id: string };
    assert.ok(dependent.id);
    const duplicate = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'snapshot-1', title: 'Snapshot', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/snapshot-1.md', originAgentId: 'origin', notifyOriginOnCloseout: true,
    }), 'fixture-host', handoffText, 'b'.repeat(40)] }) as { id: string };
    assert.equal(duplicate.id, task.id);
    const telemetry = await client.request('queue.telemetry', { window: 'all' }) as { matchingTasks: number; groups: { completedCount: number }[] };
    assert.ok(telemetry.matchingTasks >= 2);
    assert.ok(telemetry.groups.some(group => group.completedCount >= 1));
    assert.notDeepEqual(await client.request('queue.ui-snapshot', {}), board);
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live snapshot size stays flat across thousands of completed tasks at the 64-slot maximum', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'q')));
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => fakeAdapter(dir), timers: false });
  try {
    await runtime.started;
    const store = runtime.store;
    store.setMeta('globalLimit', 64);
    store.setMeta('projectLimit', 32);
    for (let i = 0; i < 64; i++) {
      const task = store.insert(submissionSchema.parse({
        submissionId: `live-${i}`, title: `Live ${i}`, repoPath: `/fixture-${Math.floor(i / 32)}`, planningCommit: 'a'.repeat(40),
        handoffPath: `docs/handoffs/live-${i}.md`, originAgentId: 'origin',
      }), 'fixture-host', 'handoff', 'b'.repeat(40));
      store.update(task.id, { phase: 'working', reason: 'r'.repeat(5_000) });
    }
    const before = runtime.snapshot();
    const beforeBytes = Buffer.byteLength(JSON.stringify(before));
    const template = store.tasks()[0];
    const insert = store.db.prepare('INSERT INTO tasks(id,submission,input_hash,data) VALUES(?,?,?,?)');
    store.transaction(() => {
      for (let i = 0; i < 3_000; i++) {
        const id = `historical-${i}`;
        const task = { ...template, id, submissionId: id, phase: 'done', finishedAt: template.updatedAt,
          reason: 'Closed', completion: { eventId: id, taskId: id, runId: id, status: 'closed', summary: 'c'.repeat(8_000) } };
        insert.run(id, id, id, JSON.stringify(task));
      }
    });
    const after = runtime.snapshot();
    const afterBytes = Buffer.byteLength(JSON.stringify(after));
    console.log(`live snapshot: ${afterBytes} bytes for 64 live and 3,000 completed tasks (${beforeBytes} bytes before history)`);
    assert.equal(after.tasks.length, 64);
    assert.equal(after.hasMore, false);
    assert.equal(after.cursor, null);
    assert.ok(afterBytes <= beforeBytes + 1_024, `history changed snapshot size from ${beforeBytes} to ${afterBytes}`);
    assert.ok(afterBytes < MAX_FRAME_BYTES, `64 live tasks used ${afterBytes} bytes`);
    assert.equal(store.countTasks(), 3_064, 'history remains durable');
    assert.equal(store.task('historical-2999').completion?.summary.length, 8_000);
    assert.equal(runtime.detail({ taskId: 'historical-2999' }).task.completion?.summary.length, 8_000);
  } finally {
    await runtime.drain();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task detail and full snapshot preserve a complete saved external-merge reason without rewriting it',async()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'q')));
  const runtime=new QueueRuntime({dataDir:dir,adapterFactory:()=>fakeAdapter(dir),timers:false});
  try{
    await runtime.started;
    const created=runtime.store.insert(submissionSchema.parse({
      submissionId:'long-external-merge-reason',title:'Long external-merge reason',repoPath:'/fixture',
      planningCommit:'a'.repeat(40),handoffPath:'long-external-merge-reason.md',originAgentId:'origin',
    }),'fixture-host','handoff','b'.repeat(40),{},undefined,'owner/fixture');
    const savedReason=`Valid task reason: ${'full evidence without loss '.repeat(220)}`;
    assert.ok(savedReason.length>4000);
    runtime.store.update(created.id,{phase:'awaiting_review',reason:savedReason,prHead:'a'.repeat(40),prUrl:'https://github.com/owner/fixture/pull/1'});
    runtime.engine.resolution.attention(runtime.store.task(created.id),`${EXTERNAL_MERGE_CHECK_REASON_PREFIX} fixture check failed`);
    const before=JSON.parse(String(runtime.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(created.id)?.data));
    assert.deepEqual(before.resolution.externalMergePreAttention,{phase:'awaiting_review',reason:savedReason});

    const detail=runtime.detail({taskId:created.id});
    assert.equal(detail.task.resolution.externalMergePreAttention?.reason,savedReason);
    const snapshot=runtime.snapshot({limit:10});
    assert.equal(snapshot.tasks.find(task=>task.id===created.id)?.resolution.externalMergePreAttention?.reason,savedReason);
    const after=JSON.parse(String(runtime.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(created.id)?.data));
    assert.deepEqual(after,before,'native read surfaces do not rewrite the persisted task record');

    const short=resolutionSchema.parse({externalMergePreAttention:{phase:'awaiting_review',reason:'Ready'}});
    assert.equal(short.externalMergePreAttention?.reason,'Ready');
    assert.throws(()=>resolutionSchema.parse({externalMergePreAttention:{phase:'awaiting_review',reason:'Ready',unexpected:true}}),/Unrecognized key/);
    assert.throws(()=>taskControlInputSchema.parse({taskId:created.id,version:1,action:'move',to:'closeout',reason:'x'.repeat(4001)}),/too_big|Too big/i);
  }finally{
    await runtime.drain();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('lead.get omits historical bodies and lead.version reads one full version', async () => {
  const { service, client, dir } = await startFixture();
  try {
    const stamp = new Date().toISOString();
    const largeBody = 'x'.repeat(420_000);
    const initial = await service.debug({ target: 'store', method: 'addLead', args: [{
      id: 'long-lead', title: 'Long lead', body: largeBody, repositories: [{ origin: 'owner/fixture', path: '/fixture' }],
      author: 'author-1', state: 'open', version: 1, dropReason: null, targets: [], source: null,
      createdAt: stamp, updatedAt: stamp, closedAt: null,
    }, 'author-1'] }) as { id: string; version: number; body: string; [key: string]: unknown };
    let current = initial;
    for (let version = 2; version <= 48; version++) {
      const updatedAt = new Date(Date.now() + version * 1000).toISOString();
      const body = version === 2 ? `---\ntitle: Long lead\n---\n${'v'.repeat(420_000)}` : largeBody;
      const versionDigest = `sha256:${digest(body)}`;
      const approval = version === 2 ? {
        version, digest: versionDigest, approver: 'operator (board)', approvedAt: updatedAt, note: '', relayed: false,
      } : null;
      current = await service.debug({ target: 'store', method: 'updateLead', args: [{
        ...current, version, title: `Long lead ${version}`, body, updatedAt, check: null,
        ...(approval ? { digest: approval.digest } : { digest: undefined }), approval,
      }, `author-${version}`] }) as typeof current;
    }

    const detail = await client.request('lead.get', { id: 'long-lead' }) as {
      body: string; version: number; versions: Record<string, unknown>[];
    };
    const responseBytes = Buffer.byteLength(JSON.stringify(detail));
    assert.ok(responseBytes < MAX_FRAME_BYTES, `compact lead.get used ${responseBytes} bytes`);
    assert.equal(detail.version, 48);
    assert.equal(detail.body, largeBody);
    assert.equal(detail.versions.length, 48);
    assert.equal('body' in detail.versions[0], false);
    assert.equal(detail.versions[0].author, 'author-1');
    assert.equal(typeof detail.versions[0].createdAt, 'string');
    assert.equal(detail.versions[0].check, null);
    assert.equal(detail.versions[0].approval, null);
    assert.equal(detail.versions[1].approval && (detail.versions[1].approval as { approver: string }).approver, 'operator (board)');
    assert.equal(detail.versions[47].body, largeBody);

    const historical = await client.request('lead.version', { id: 'long-lead', version: 1 }) as { version: number; body: string };
    assert.equal(historical.version, 1);
    assert.equal(historical.body, largeBody);

    const small = await service.debug({ target: 'store', method: 'addLead', args: [{
      id: 'small-lead', title: 'Small lead', body: 'First body', repositories: [{ origin: 'owner/fixture', path: '/fixture' }],
      author: 'planner', state: 'open', version: 1, dropReason: null, targets: [], source: null,
      createdAt: stamp, updatedAt: stamp, closedAt: null,
    }, 'planner'] }) as { [key: string]: unknown };
    await service.debug({ target: 'store', method: 'updateLead', args: [{
      ...small, version: 2, title: 'Small lead', body: 'Latest body', updatedAt: new Date().toISOString(), check: null, approval: null,
    }, 'editor'] });
    const smallDetail = await client.request('lead.get', { id: 'small-lead' }) as { body: string; versions: Record<string, unknown>[] };
    assert.equal(smallDetail.body, 'Latest body');
    assert.equal(smallDetail.versions.length, 2);
    assert.equal('body' in smallDetail.versions[0], false);
    assert.equal(smallDetail.versions[1].body, 'Latest body');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oversize response leaves one bounded durable method and byte-count record', async () => {
  const { service, client, dir } = await startFixture();
  let replacement: ServiceClient | undefined;
  try {
    const task = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'oversize-1', title: 'Oversize', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/oversize-1.md', originAgentId: 'origin',
    }), 'fixture-host', 'Handoff', 'b'.repeat(40)] }) as { id: string };
    await service.debug({ target: 'store', method: 'update', args: [task.id, { reason: 'x'.repeat(MAX_FRAME_BYTES) }] });
    await assert.rejects(() => client.request('queue.snapshot', {}), (error: unknown) => {
      assert.ok(error instanceof ServiceRequestError);
      assert.equal(error.code, 'oversize');
      assert.match(error.message, /Response for queue\.snapshot is \d+\.\d MB, over the 16 MiB bound/);
      return true;
    });
    const recordPath = join(dir, 'oversize-response.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { method: string; bytes: number; ceiling: number; at: string };
    assert.equal(record.method, 'queue.snapshot');
    assert.ok(record.bytes > MAX_FRAME_BYTES);
    assert.equal(record.ceiling, MAX_FRAME_BYTES);
    assert.ok(Number.isFinite(Date.parse(record.at)));
    assert.ok(readFileSync(recordPath).length < 256);
    await service.debug({ target: 'store', method: 'update', args: [task.id, { reason: 'Short' }] });
    const info = readServiceInfo(dir)!;
    replacement = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
    await replacement.connect();
    assert.equal((await replacement.request('queue.snapshot', {}) as { tasks: unknown[] }).tasks.length, 1);
  } finally {
    await replacement?.close();
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credential authentication fails closed before any other method', async () => {
  const dir = socketFixtureDirectory('queue-service.sock');
  const dataDir = dir;
  const service = new QueueService({ owner: { dataDir, adapterFactory: () => fakeAdapter(dir) } });
  await service.start();
  try {
    const info = readServiceInfo(dataDir)!;
    // Wrong credential: typed rejection and a closed connection.
    const impostor = new ServiceClient({ socketPath: info.socketPath, credential: 'f'.repeat(64) });
    await assert.rejects(() => impostor.connect(), (error: unknown) => error instanceof ServiceRequestError && error.code === 'unauthenticated');
    // Requests before authentication are rejected too.
    const raw = await rawRequest(info.socketPath, { v: PROTOCOL_VERSION, id: 'early-1', method: 'queue.control', input: {} });
    assert.equal(raw.error?.code, 'unauthenticated');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Raw single-request helper used to inspect protocol-level failures. */
function rawRequest(socketPath: string, payload: unknown): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  const sentId = (payload as { id: string }).id;
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response: { result?: unknown; error?: { code: string; message: string } } | undefined;
    const reader = createFrameReader(frame => {
      const candidate = frame as { id?: unknown };
      if (candidate.id === sentId) response = frame as typeof response;
    }, error => { socket.destroy(); reject(error); });
    socket.on('data', chunk => reader.feed(chunk));
    socket.on('error', () => {});
    socket.on('close', () => { if (response) resolve(response); });
    socket.on('connect', () => socket.write(encodeFrame(payload)));
    setTimeout(() => { if (response) resolve(response); }, 500);
    setTimeout(() => { if (!response) { socket.destroy(); reject(new Error('raw request timed out')); } }, 4000);
  });
}

test('one writer: a second owner on the same store fails closed and releases cleanly afterwards', async () => {
  const dir = socketFixtureDirectory('queue-service.sock');
  const dataDir = dir;
  const first = new QueueService({ owner: { dataDir, timers: false }, fixture: 'fake' });
  await first.start();
  try {
    // A second service against the same database is refused before any socket exists.
    await assert.rejects(() => new QueueService({ owner: { dataDir, timers: false }, fixture: 'fake' }).start(),
      (error: unknown) => error instanceof Error && /Another Nucleus backend still owns this database/.test(error.message));
    assert.ok(!existsSync(join(dataDir, 'queue-service2.sock')));
  } finally {
    await first.stop();
  }
  // Drain releases socket, identity file and the durable process lease.
  assert.ok(!existsSync(first.socketPath), 'drain must release the socket');
  assert.equal(readServiceInfo(dataDir), null, 'drain must remove the identity file');
  const reopened = new QueueService({ owner: { dataDir, timers: false }, fixture: 'fake' });
  await reopened.start();
  await reopened.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a detached service drains when its published identity disappears', async () => {
  const dir = socketFixtureDirectory('queue-service.sock');
  const dataDir = dir;
  const service = new QueueService({ owner: { dataDir, timers: false }, fixture: 'fake', ownershipCheckMs: 20 });
  await service.start();
  assert.ok(readServiceInfo(dataDir));
  rmSync(join(dataDir, 'queue-service.json'), { force: true });
  const deadline = Date.now() + 2_000;
  while (!service.drainingNow && Date.now() < deadline) await sleep(20);
  assert.equal(service.drainingNow, true, 'loss of discoverable ownership stops the detached service');
  while (existsSync(service.socketPath) && Date.now() < deadline) await sleep(20);
  assert.equal(existsSync(service.socketPath), false);
  rmSync(dir, { recursive: true, force: true });
});

test('the executable runs standalone, serves the catalogue and drains on command', async () => {
  const innerSocket = join('host-run', 'run', `inner-${process.pid}-${'f'.repeat(8)}.sock`);
  const dir = socketFixtureDirectory(innerSocket, 2);
  assertSocketPathWithinBound(join(dir, 'queue-service.sock'));
  assertSocketPathWithinBound(join(dir, 'host-run', 'run', 'scheduler.sock'));
  const { spawn } = await import('node:child_process');
  // config.json points the service at this checkout for its MCP reporting bridge.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ plugins: { nucleus: { path: new URL('..', import.meta.url).pathname } } }), { mode: 0o600 });
  const dataDir = dir;
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  // The isolated data dir owns its host-run state even when HOME is separate.
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../bin/queue-service.mjs', import.meta.url).pathname, `--data-dir=${dataDir}`], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PASEO_HOME: dir, HOME: home }, cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  child.unref();
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    // Wait for the identity file, then prove catalogue parity over the wire.
    const deadline = Date.now() + 30_000;
    let info = readServiceInfo(dataDir);
    while (!info && Date.now() < deadline) { await sleep(100); info = readServiceInfo(dataDir); }
    assert.ok(info, `service did not publish its identity file: ${stderr}`);
    // The CLI resolves its normal PASEO_HOME layout. Point that lookup at this
    // direct data directory with an isolated identity copy so every socket stays
    // under the short fixture root.
    const cliDataDir = join(dir, 'northstar-queue');
    mkdirSync(cliDataDir);
    copyFileSync(join(dataDir, 'queue-service.json'), join(cliDataDir, 'queue-service.json'));
    const hostRunStateDir = join(dataDir, 'host-run');
    while (!existsSync(join(hostRunStateDir, 'authority.json')) && Date.now() < deadline) await sleep(100);
    assert.ok(existsSync(join(hostRunStateDir, 'authority.json')), `service did not publish host-run state beside its data: ${stderr}`);
    assert.equal(existsSync(join(home, '.local', 'state', 'host-run')), false, 'a non-live service never creates the HOME-derived scheduler state path');
    const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
    await client.connect();
    const state = await client.request('queue.ui-snapshot', {}) as Record<string, unknown>;
    assert.ok(Array.isArray(state.tasks));
    // A bounded drain request stops the service and releases socket and lease.
    const drained = await client.request('service.drain', {}) as Record<string, unknown>;
    assert.deepEqual(drained, { ok: true, draining: true });
    const exit = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => { resolve(null); }, 30_000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exit, 0, `service must exit cleanly after drain (stderr: ${stderr})`);
    assert.ok(!existsSync(info.socketPath), 'drain must release the socket');
    assert.equal(readServiceInfo(dataDir), null, 'drain must remove the identity file');
    client.close();
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the board answers an unchanged revision with a bounded acknowledgement and refreshes on durable change', async () => {
  const fixture = await startFixture();
  const { service, client, dir } = fixture;
  try {
    // #1001: queued wait text reads the profile catalog, so its first load is a board change. Start after it.
    for (let attempt = 0; attempt < 200 && !await service.debug({ target: 'engine', method: 'profileCatalogKnown', args: [] }); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25));
    await client.request('queue.ui-snapshot', {});
    const full = await client.request('queue.ui-snapshot', {}) as Record<string, unknown>;
    assert.equal(typeof full.revision, 'number');
    const fullFrame = encodeFrame(full).length - 4;
    assert.ok(fullFrame < 128 * 1024, `the compact initial board must stay under 128 KiB (was ${fullFrame})`);
    // Unchanged refresh: counters only, no task payloads, bounded frame.
    const ack = await client.request('queue.ui-snapshot', { revision: full.revision }) as Record<string, unknown>;
    assert.equal(ack.unchanged, true);
    assert.equal(ack.revision, full.revision);
    assert.ok(!('tasks' in ack));
    assert.ok(encodeFrame(ack).length - 4 < 2048, `an unchanged refresh must stay under 2 KiB (was ${encodeFrame(ack).length - 4})`);
    // History-only writes preserve board revision; dynamic errors still reach the cached board.
    await service.debug({ target: 'store', method: 'event', args: ['fixture', 'history', 'not a board change'] });
    await service.debug({ target: 'store', method: 'setMeta', args: ['engineError', 'fixture dynamic error'] });
    const dynamic = await client.request('queue.ui-snapshot', { revision: full.revision }) as Record<string, unknown>;
    assert.equal(dynamic.unchanged, true); assert.equal(dynamic.error, 'fixture dynamic error');
    const stillFull = await client.request('queue.ui-snapshot', {}) as Record<string, unknown>;
    assert.ok(Array.isArray(stillFull.tasks)); assert.equal(stillFull.unchanged, undefined);
    await service.debug({ target: 'store', method: 'acceptOperation', args: [{ key: 'board-operation', kind: 'submit', inputHash: 'a'.repeat(64), payload: {} }] });
    const operationBoard = await client.request('queue.ui-snapshot', { revision: full.revision }) as Record<string, unknown>;
    assert.equal(operationBoard.unchanged, undefined); assert.equal(operationBoard.operationBacklog, 1);

    // A board-visible durable change advances the revision, so the same caller revision must not get an ack.
    await client.request('queue.control', { paused: false });
    assert.notEqual(await service.debug({ target: 'store', method: 'telemetryRevision', args: [] }), full.revision);
    const refreshed = await client.request('queue.ui-snapshot', { revision: full.revision }) as Record<string, unknown>;
    assert.equal(refreshed.unchanged, undefined, 'a durable change must return a full board, not a stale acknowledgement');
    assert.ok(Array.isArray(refreshed.tasks));
    assert.notEqual(refreshed.revision, full.revision);
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a 436-row review stays off uiTasks, board and snapshot payloads while detail retains it', async () => {
  const { service, client, dir } = await startFixture();
  try {
    const task = await service.debug({ target: 'store', method: 'insert', args: [
      submissionSchema.parse({ submissionId: 'matrix-review', title: 'Matrix review', repoPath: '/fixture', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }),
      'fixture-host', 'handoff', 'a'.repeat(40),
    ] }) as Task;
    const verdicts: ReviewVerdict[] = Array.from({ length: 436 }, (_, index) => {
      const id = `stage-subject-${String(index).padStart(3, '0')}`;
      return { id, subject: id, verdict: 'pass', evidence: `stage-evidence-${index}-` + 'x'.repeat(1000) };
    });
    const completion: Completion = {
      eventId: 'stage-review', taskId: task.id, runId: 'review-run', status: 'ready_to_merge', summary: 'Reviewed', head: 'b'.repeat(40), verdicts,
    };
    const reviewRecord = {
      runId: 'review-run', agentId: 'reviewer', head: 'b'.repeat(40), status: 'ready_to_merge' as const,
      reviewId: null, reviewCommentId: 17, at: '2026-10-06T00:00:00.000Z', verdicts,
    };
    await service.debug({ target: 'store', method: 'update', args: [task.id, {
      completion,
      resolution: {
        ...task.resolution, review: completion, reviews: [reviewRecord],
      },
    }] });

    const uiTasks = await service.debug({ target: 'store', method: 'uiTasks', args: [] }) as Task[];
    assert.equal(uiTasks[0]!.resolution.reviews[0]!.verdicts.length, 0);
    assert.doesNotMatch(JSON.stringify(uiTasks), /stage-evidence-/);

    const board = await client.request('queue.ui-snapshot', {}) as Record<string, unknown>;
    const boardBytes = encodeFrame(board).length - 4;
    assert.ok(boardBytes < 128 * 1024, `the compact board stays under 128 KiB (was ${boardBytes})`);
    assert.doesNotMatch(JSON.stringify(board), /stage-evidence-/);

    const snapshot = await client.request('queue.snapshot', {}) as { tasks: Task[] };
    assert.equal(snapshot.tasks[0]!.resolution.reviews[0]!.verdicts.length, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /stage-evidence-/);

    const detail = await client.request('queue.detail', { taskId: task.id }) as { task: Task };
    assert.equal(detail.task.resolution.review!.verdicts!.length, 436);
    assert.equal(detail.task.resolution.reviews[0]!.verdicts.length, 436);
    assert.equal(detail.task.resolution.reviews[0]!.verdicts[0]!.id, detail.task.resolution.reviews[0]!.verdicts[0]!.subject);
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every served method name lives in the catalogue and unknown methods fail closed', async () => {
  const fixture = await startFixture();
  const { service, client, dir } = fixture;
  try {
    // The advertised build identity covers the served method set; the parity
    // fixture in catalogue.test.ts proves the catalogue covers every contract.
    assert.equal(currentServiceBuildId().length, 16);
    const unknown = await client.request('queue.absent-method', {}).catch((error: unknown) => error);
    assert.ok(unknown instanceof ServiceRequestError && unknown.code === 'method_unknown');
    assert.equal(service['connections'].size, 1);
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback: after a durable drain the prior backend takes the lease and identities are preserved', async () => {
  const dir = socketFixtureDirectory('queue-service.sock');
  const dataDir = dir;
  const service = new QueueService({ owner: { dataDir, timers: false }, fixture: 'fake', debug: true });
  await service.start();
  const submission = submissionSchema.parse({
    submissionId: 'rollback-1', title: 'Rollback identity', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
    handoffPath: 'docs/handoffs/rollback-1.md', originAgentId: 'origin',
  });
  const task = await service.debug({ target: 'store', method: 'insert', args: [submission, 'fixture-host', 'Handoff for the rollback fixture', 'b'.repeat(40)] }) as { id: string; version: number };
  const info = readServiceInfo(dataDir)!;
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  await client.request('service.drain', {});
  await service.drainedPromise();
  client.close();
  assert.ok(!existsSync(info.socketPath), 'rollback requires the socket released');
  assert.equal(readServiceInfo(dataDir), null, 'rollback requires the identity file released');
  // The prior backend (old plugin shape) restores: it acquires the released
  // lease as the single writable owner and the task identity is preserved.
  const legacy = new QueueRuntime({ dataDir, adapterFactory: () => fakeAdapter(dir), timers: false });
  const restored = legacy.store.task(task.id);
  assert.equal(restored.submissionId, 'rollback-1');
  assert.equal(restored.version, task.version);
  const previous = legacy.store.getMeta<{ pid: number }>("processOwner");
  assert.equal(previous?.pid, process.pid, 'exactly one writable owner after rollback');
  await legacy.drain();
  rmSync(dir, { recursive: true, force: true });
});

test('unknown delivery: a lost response reconciles the same durable operation without a second effect', async () => {
  const fixture = await startFixture();
  const { service, client, dir } = fixture;
  try {
    const task = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'unknown-1', title: 'Unknown delivery', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/unknown-1.md', originAgentId: 'origin',
    }), 'fixture-host', 'Handoff', 'b'.repeat(40)] }) as { id: string; version: number };
    const key = 'unknown-delivery-1';
    const request = { key, kind: 'task_control', payload: { type: 'task_control', control: { taskId: task.id, version: task.version, action:'hold',reason:'Test hold' } }, taskId: task.id, expectedVersion: task.version };
    // First delivery: send the framed request and destroy the socket before the
    // response is read, so the caller cannot know whether it landed.
    await lostDelivery(readServiceInfo(dir)!.socketPath, { v: PROTOCOL_VERSION, id: 'lost-1', method: 'queue.operation-start', input: request });
    await sleep(300);
    // The retry over a fresh connection must reconcile the same durable identity.
    const retry = await client.request('queue.operation-start', request) as { operation: { id: string; key: string } };
    const again = await client.request('queue.operation-start', request) as { operation: { id: string; key: string } };
    assert.equal(again.operation.id, retry.operation.id, 'a repeated caller key returns the same durable operation, never a new effect');
    assert.equal(again.operation.key, key);
    assert.equal(((await service.debug({ target: 'store', method: 'operations', args: [{}] })) as { key: string }[]).filter(record => record.key === key).length, 1, 'exactly one durable operation record exists for the key');
    // The hold effect ran exactly once: the settled task state proves the retry
    // did not repeat the local effect across the transport retry.
    const held = await service.debug({ target: 'store', method: 'task', args: [task.id] }) as { held: boolean; version: number };
    assert.equal(held.held, true, 'the lost-delivery hold still landed exactly once');
    assert.equal(held.version, task.version + 1, 'the local effect did not repeat');
    assert.equal(((await service.debug({ target: 'store', method: 'eventsAll', args: [task.id] })) as { kind: string }[]).filter(event => event.kind === 'hold').length, 1, 'exactly one hold event');
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Send one framed request and close without reading the response. */
function lostDelivery(socketPath: string, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.on('error', () => {});
    socket.on('connect', () => {
      socket.write(encodeFrame(payload));
      socket.end();
      resolve();
    });
    setTimeout(() => reject(new Error('lost delivery timed out')), 3000);
  });
}

/** The whole dispatch-limit state a Settings write carries. */
const CAPACITY_STATE = { globalLimit: 20, projectLimit: 4, papercutProjectLimit: 2, paseoCallLimit: 6,
  stallThresholdMinutes: 30, holdReminderMinutes: 120, holdEscalationMinutes: 240,
  laneDrainMinutes: 120, laneDrainEscalationMinutes: 1440, hostOutageNoticeMinutes: 120 };
interface CapacityStateView {
  effective: Record<string, number>;
  changes: { version: number; at: string; surface: string; before: Record<string, number>; after: Record<string, number> }[];
}

/**
 * One raw framed request on its own authenticated connection. This is the shape a
 * same-uid process can write deliberately: it proves the honest limit of the
 * Settings-only rule rather than claiming a discrimination the transport cannot make.
 */
async function rawRequestWithSurface(socketPath: string, credential: string, method: string, input: unknown, extra: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('raw request timed out')); }, 5000);
    let authed = false;
    const reader = createFrameReader(frame => {
      const message = frame as { result?: unknown; error?: { code: string; message: string } };
      if (!authed) {
        authed = true;
        socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: 'raw-capacity', method, input, ...extra }));
        return;
      }
      clearTimeout(timer); socket.end(); resolve(message);
    }, error => { clearTimeout(timer); socket.destroy(); reject(error); });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: 'raw-auth', method: 'service.auth', input: { credential } })));
    socket.on('data', chunk => reader.feed(chunk));
  });
}

test('Settings applies capacity through the real bridge forward, records it with the change, and keeps it across a restart', async () => {
  const first = await startFixture();
  const { service, client, dir } = first;
  type State = CapacityStateView;
  const { ServiceBridge } = await import('../hosts/paseo/plugin/bridge');
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions, dataDir: dir, sourcePath: fileURLToPath(new URL('..', import.meta.url)) });
  const capacityEntry = RPC_CATALOGUE.find(entry => entry.name === 'queue.capacity')!;
  const before = await client.request('queue.capacity-state', {}) as State;
  assert.deepEqual(before.changes, [], 'nothing is recorded yet and no host document is needed');
  try {
    // The Settings screen's own route: plugin RPC → ServiceBridge.forward → socket.
    // Parent falsification: at the dispatch base this same forward refuses with
    // `refused`, so this assertion is what the change turns around.
    assert.deepEqual(await bridge.forward(capacityEntry, { globalLimit: 20, projectLimit: 4 }), { ok: true });
    const applied = await client.request('queue.capacity-state', {}) as State;
    assert.equal(applied.effective.globalLimit, 20);
    assert.equal(applied.effective.projectLimit, 4);
    assert.equal(applied.effective.papercutProjectLimit, before.effective.papercutProjectLimit, 'an omitted field keeps the value in force');
    assert.equal(applied.changes.length, 1);
    const change = applied.changes[0]!;
    assert.equal(change.version, 1);
    assert.equal(change.surface, 'paseo', 'the record names the surface the transport derived');
    assert.ok(!Number.isNaN(Date.parse(change.at)), 'the record is time-stamped');
    assert.deepEqual(change.before, before.effective, 'the record carries the whole state the change replaced');
    assert.deepEqual(change.after, applied.effective, 'and the whole state it put in force');
    // The board reflects the applied limits, so the record did not lie about the store.
    const board = await client.request('queue.ui-snapshot', {}) as { globalLimit: number };
    assert.equal(board.globalLimit, 20);

    // Saving the values already in force is a no-op with no record and no new version.
    assert.deepEqual(await bridge.forward(capacityEntry, { globalLimit: 20, projectLimit: 4 }), { ok: true });
    const noop = await client.request('queue.capacity-state', {}) as State;
    assert.deepEqual(noop.effective, applied.effective);
    assert.equal(noop.changes.length, 1, 'a save that changes nothing records nothing');
    // An invalid value is refused as input before the handler, so no record appears either.
    await assert.rejects(() => bridge.forward(capacityEntry, { globalLimit: 0, projectLimit: 4 }),
      (error: unknown) => error instanceof Error && /globalLimit|too_small/i.test(error.message));
    assert.equal(((await client.request('queue.capacity-state', {})) as State).changes.length, 1);

    // A second change records the whole before and after at the next version and moves the board.
    await bridge.forward(capacityEntry, { globalLimit: 21, projectLimit: 4, stallThresholdMinutes: 45 });
    const second = await client.request('queue.capacity-state', {}) as State;
    assert.equal(second.changes.length, 2);
    assert.equal(second.changes[1]!.version, 2);
    assert.deepEqual(second.changes[1]!.before, applied.effective);
    assert.equal(second.changes[1]!.after.stallThresholdMinutes, 45);
    assert.equal(((await client.request('queue.ui-snapshot', {})) as { globalLimit: number }).globalLimit, 21);
  } finally {
    bridge.close();
    await client.close();
    await service.stop();
  }
  // A restart reads the same values and the same record: nothing resets them.
  const restarted = await startFixture({ dataDir: dir });
  try {
    const state = await restarted.client.request('queue.capacity-state', {}) as State;
    assert.equal(state.effective.globalLimit, 21, 'a restart does not reset a Settings change');
    assert.equal(state.effective.stallThresholdMinutes, 45);
    assert.equal(state.changes.length, 2, 'the record survives the restart');
    const board = await restarted.client.request('queue.ui-snapshot', {}) as { globalLimit: number };
    assert.equal(board.globalLimit, 21, 'the scheduler reads the same values after the restart');
  } finally {
    await restarted.client.close();
    await restarted.service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Settings-only capacity: every other surface refuses with zero mutation, and imitating the bridge is recorded honestly', async () => {
  const { service, client, dir } = await startFixture();
  const info = readServiceInfo(dir)!;
  // A task session's shape: the published credential and the installed checkout are
  // both readable by the same uid, so this is the caller the refusal is for.
  const taskClient = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await taskClient.connect();
  try {
    const before = await client.request('queue.capacity-state', {}) as CapacityStateView;
    assert.deepEqual(before.changes, []);

    // The documented CLI route, a direct client and a task session's own
    // authenticated connection all arrive without the bridge's surface: each is
    // refused, and a repeat is refused the same way without changing anything.
    const refusals = [
      client.request('queue.capacity', { globalLimit: 24, projectLimit: 4 }),
      client.request('queue.capacity', { globalLimit: 24, projectLimit: 4 }),
      client.request('queue.capacity', { globalLimit: 24, projectLimit: 4, papercutProjectLimit: 3, paseoCallLimit: 6 }),
      taskClient.request('queue.capacity', { globalLimit: 64, projectLimit: 32, papercutProjectLimit: 32, paseoCallLimit: 32,
        stallThresholdMinutes: 240, holdReminderMinutes: 10080, holdEscalationMinutes: 10080, laneDrainMinutes: 10080, laneDrainEscalationMinutes: 10080, hostOutageNoticeMinutes: 10080 }),
      taskClient.request('queue.capacity', { globalLimit: 1, projectLimit: 1 }),
    ];
    for (const refusal of refusals) {
      await assert.rejects(() => refusal, (error: unknown) => {
        assert.ok(error instanceof ServiceRequestError, 'the refusal is a typed service error');
        assert.equal(error.code, 'refused', 'a policy refusal is not an internal or transport failure');
        assert.match(error.message, /queue\.capacity is refused/);
        assert.match(error.message, /only the operator changes Nucleus's dispatch limits, in Settings/);
        assert.match(error.message, /Nothing changed; do not retry/);
        return true;
      });
    }
    // A payload claiming an operator identity is refused as input before the
    // refusal above: no actor field authenticates anything on this path.
    for (const forged of [
      { globalLimit: 24, projectLimit: 4, authority: 'operator' },
      { globalLimit: 24, projectLimit: 4, caller: 'operator (board)' },
      { globalLimit: 24, projectLimit: 4, relayed: true, approver: 'operator' },
      { globalLimit: 24, projectLimit: 4, via: 'paseo' },
      { globalLimit: 24, projectLimit: 4, surface: 'settings' },
    ]) {
      await assert.rejects(() => taskClient.request('queue.capacity', forged),
        (error: unknown) => error instanceof ServiceRequestError && error.code === 'invalid_input');
    }
    // Nothing recorded a change, every value is unchanged, and ordinary reads answer.
    const after = await client.request('queue.capacity-state', {}) as CapacityStateView;
    assert.deepEqual(after.effective, before.effective);
    assert.deepEqual(after.changes, [], 'a refused write records no change');
    const board = await client.request('queue.snapshot', {}) as { tasks: unknown[] };
    assert.ok(Array.isArray(board.tasks), 'ordinary reads keep answering');
    await client.request('queue.ui-snapshot', {});
    const health = await client.request('service.health', {}) as Record<string, unknown>;
    assert.ok(health.capacityAuthority, "health carries the capacity record's compact state");

    // The honest limit, stated as a proof: a same-uid process that writes the
    // bridge's own frame is not stopped, and the record names that surface. This is
    // accident prevention, never authentication.
    const imitated = await rawRequestWithSurface(info.socketPath, info.credential, 'queue.capacity', { globalLimit: 23, projectLimit: 4 }, { via: 'paseo' });
    assert.deepEqual(imitated.result, { ok: true });
    const recorded = await client.request('queue.capacity-state', {}) as CapacityStateView;
    assert.equal(recorded.effective.globalLimit, 23);
    assert.equal(recorded.changes.length, 1);
    assert.equal(recorded.changes[0]!.surface, 'paseo', 'the record can only say which surface arrived, not who sent it');
    // An unknown surface value fails closed as protocol input instead of being guessed at.
    const unknownSurface = await rawRequestWithSurface(info.socketPath, info.credential, 'queue.capacity', { globalLimit: 24, projectLimit: 4 }, { via: 'settings' });
    assert.equal(unknownSurface.error?.code, 'invalid_input');
    assert.equal(((await client.request('queue.capacity-state', {})) as CapacityStateView).effective.globalLimit, 23);
  } finally {
    await taskClient.close();
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service transport coverage: every catalogue method answers with a validated result or typed domain error', async () => {
  const fixture = await startFixture();
  const { service, client, dir } = fixture;
  try {
    const task = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'coverage-1', title: 'Coverage', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/coverage-1.md', originAgentId: 'origin',
    }), 'fixture-host', 'Handoff', 'b'.repeat(40)] }) as { id: string; version: number };
    const cases: [string, unknown][] = [
      ['queue.snapshot', {}],
      ['queue.ui-snapshot', {}],
      ['queue.detail', { taskId: task.id }],
      ['queue.outcome', { taskId: task.id }],
      ['lane.upsert', { key: 'coverage-lane', title: 'Coverage', aim: 'Coverage lane for transport proof.', repositories: [{ origin: 'example/coverage', path: '/fixture' }] }],
      ['lane.status', { key: 'coverage-lane', status: 'paused', note: 'Coverage' }],
      ['lanes', {}],
      ['queue.telemetry', {}],
      ['queue.task', { taskId: task.id, version: task.version, action:'hold',reason:'Test hold' }],
      ['queue.operation-start', { key: 'coverage-op-1', kind: 'task_control', payload: { type: 'task_control', control: { taskId: task.id, version: task.version, action: 'release' } }, taskId: task.id, expectedVersion: task.version }],
      ['queue.operation-status', { operationId: 'coverage-absent' }],
      ['queue.pool', { entries: [] }],
      ['queue.profile', { profileId: 'missing-profile', enabled: true, group: 'coverage', roles: ['worker'], weight: 1, scopes: ['general'] }],
      ['queue.control', { paused: true }],
      ['queue.bulk-disposition', { operationId: 'coverage-bulk', tasks: [{ taskId: task.id, version: task.version }], action: 'cancel', reason: 'Coverage disposition' }],
      ['queue.bulk-disposition-detail', { operationId: 'coverage-bulk' }],
      ['queue.bulk-disposition-retry', { operationId: 'coverage-bulk' }],
      ['queue.completion-subscription', { taskId: task.id, version: task.version, agentId: 'agent-x', action: 'subscribe' }],
      ['queue.reparent', { toAgentId: 'agent-y', caller: 'operator (board)', reason: 'Coverage reparent', taskIds: [task.id] }],
      ['queue.remove', { taskId: task.id, version: task.version }],
      ['queue.availability', { group: 'coverage', unavailable: true, reason: 'Coverage window', retryAt: null }],
      ['queue.refresh', {}],
      // The Settings-only capacity rule answers a direct caller with its typed policy refusal.
      ['queue.capacity', { globalLimit: 4, projectLimit: 2 }],
      ['queue.capacity-state', {}],
      ['repository.set', { repository: 'acme/retired', validationPolicy: 'Run compile only. No tests.' }],
      ['queue.submit', { submissionId: 'coverage-submit', title: 'Coverage submit', repoPath: '/fixture', planningCommit: 'a'.repeat(40), handoffPath: 'docs/handoffs/coverage-submit.md', originAgentId: 'origin', baseBranch: 'main' }],
      ['queue.submit-instruction', { submissionId: 'coverage-instr', title: 'Coverage instruction', repoPath: '/fixture', planningCommit: 'a'.repeat(40), originAgentId: 'origin', instruction: { path: 'docs/handoffs/coverage-instr.md', content: 'Instruction', at: new Date().toISOString() } }],
      ['queue.handoff', { handoffPath: 'docs/handoffs/absent-handoff.md', originAgentId: 'origin', dryRun: true, baseBranch: 'main' }],
    ];
    for (const [method, input] of cases) {
      const outcome = await client.request(method, input, 30_000).then(
        () => 'result',
        (error: unknown) => error instanceof ServiceRequestError ? error.code : 'transport',
      );
      assert.ok(outcome === 'result' || outcome === 'internal' || outcome === 'invalid_input' || outcome === 'refused',
        `${method} must answer over the service transport with a validated result or a typed domain error, never a transport failure (got ${outcome})`);
    }
  } finally {
    await client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unreachable daemon: startup captures the failure and drain still releases the lease', async () => {
  const dir = socketFixtureDirectory('callback.sock');
  const dataDir = dir;
  const { PaseoAdapter } = await import('../service/paseo-composition');
  const unreachable = new PaseoAdapter('ws://127.0.0.1:1/ws', join(dir, 'callback.sock'), join(dir, 'worker-report.mjs'));
  const owner = new QueueRuntime({ dataDir, settings: { daemonUrl: 'ws://127.0.0.1:1/ws' }, adapterFactory: () => unreachable, timers: false });
  try {
    // `started` may be pending while the SDK retries; drain must still finish.
    await owner.drain();
    assert.equal(owner.phase, 'stopped');
    const probe = new Store(join(dataDir, 'queue.sqlite'));
    assert.equal(probe.getMeta<{ pid: number }>('processOwner'), undefined, 'the durable lease is released even when the SDK never settled');
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transient daemon outage at startup self-heals and resumes accepted durable operations', async () => {
  const dir = socketFixtureDirectory('callback.sock');
  const dataDir = dir;
  let reachable = false;
  const adapter = {
    client: { isConnected: false },
    hostId: 'fixture-host',
    socketPath: join(dir, 'callback.sock'),
    helperPath: join(dir, 'worker-helper.mjs'),
    connect: async () => {
      if (!reachable) throw new Error('Daemon connection did not settle inside 300 ms');
      (adapter.client as { isConnected: boolean }).isConnected = true;
    },
    close: async () => { (adapter.client as { isConnected: boolean }).isConnected = false; },
    catalog: async () => ({ providers: [] }),
    observe: observeIdle('ws', 'w'),
  } as unknown as Adapter & { client: { isConnected: boolean } };
  const owner = new QueueRuntime({ dataDir, adapterFactory: () => adapter, timers: false, connectTimeoutMs: 300 });
  try {
    // Accept a durable operation while the daemon is unreachable; nothing may
    // run it yet beyond durable acceptance.
    const task = owner.store.insert(submissionSchema.parse({
      submissionId: 'outage-1', title: 'Outage recovery', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/outage-1.md', originAgentId: 'origin',
    }), 'fixture-host', 'Handoff', 'b'.repeat(40));
    const control = { taskId: task.id, version: task.version, action:'hold' as const,reason:'Test hold' };
    const acceptance = owner.store.acceptOperation({
      key: 'outage-op-1', kind: 'task_control', inputHash: operationInputHash(control),
      taskId: task.id, expectedVersion: task.version, payload: { type: 'task_control', control },
      hostId: task.hostId, hostSelection: task.hostSelection, // Queue #912: accepted operations record their task's host
    });
    if (!('accepted' in acceptance)) throw new Error('fixture acceptance failed');
    await owner.started; // bounded connect failed; startError carries the transient outage
    await owner.bootstrap?.catch(() => {}); // wait for the detached bootstrap attempt to record its error
    assert.ok(owner.startError.length > 0, 'the outage surfaces as a startup error, not a wedge');
    assert.equal(owner.bootstrapped, false);
    // The daemon becomes reachable: the next bootstrap attempt resumes without
    // any operator action and runs the accepted durable operation.
    reachable = true;
    (adapter.client as { isConnected: boolean }).isConnected = true;
    const resumed = await owner.ensureBootstrap();
    assert.equal(resumed, true, 'the deferred bootstrap completes when the daemon becomes reachable');
    assert.equal(owner.startError, '', 'the recovered bootstrap clears the outage error');
    const held = owner.store.task(task.id);
    assert.equal(held.held, true, 'the accepted hold resumes and lands exactly once');
    assert.equal(held.version, task.version + 1);
    const settled = owner.store.operation(acceptance.operation.id);
    assert.ok(settled && ['succeeded', 'running'].includes(settled.state));
    assert.equal(owner.store.operations({}).filter(record => record.key === 'outage-op-1').length, 1);
  } finally {
    reachable = false;
    await owner.drain();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a post-bootstrap reconciliation that keeps finishing quanta is not timed out; a stalled one is (2026-10-21)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'q')));
  const owner = new QueueRuntime({ dataDir: join(root, 'northstar-queue'), adapterFactory: () => fakeAdapter(root), timers: false });
  try {
    await owner.started;
    await owner.bootstrap;
    owner.bootstrapped = false;
    let mark = 0, resolveWork!: () => void;
    const work = new Promise<void>(resolve => { resolveWork = resolve; });
    const engine = owner.engine as unknown as { wake: () => Promise<void>; progressMark: () => number };
    engine.wake = () => work;
    engine.progressMark = () => mark;
    const internals = owner as unknown as { boundedBootstrapStep<T>(step: string, work: Promise<T>, timeoutMs?: number, settlement?: object): Promise<T> };
    const bounded = internals.boundedBootstrapStep.bind(owner);
    internals.boundedBootstrapStep = (step, promise, timeoutMs, settlement) =>
      bounded(step, promise, step === 'Post-bootstrap reconciliation' ? 40 : timeoutMs, settlement);
    const ticker = setInterval(() => { mark++; }, 10);
    const bootstrap = owner.ensureBootstrap();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    assert.equal(owner.startError, '', 'five stall windows passed with progress in each: no timeout');
    clearInterval(ticker);
    await bootstrap.catch(() => {});
    assert.match(owner.startError, /^Post-bootstrap reconciliation made no progress for 40 ms \(running \d+ ms\)$/, 'a stall after progress times out and says so');
    resolveWork();
  } finally {
    await owner.drain();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the post-bootstrap progress bound never runs past its cap, even when a late window saw progress (Sol, #589)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'q')));
  const owner = new QueueRuntime({ dataDir: join(root, 'northstar-queue'), adapterFactory: () => fakeAdapter(root), timers: false });
  const realNow = Date.now, realSetTimeout = globalThis.setTimeout;
  try {
    await owner.started;
    await owner.bootstrap;
    // A deterministic clock and timer queue: each scheduled callback runs at its due time, one at a time.
    let clock = 1_000_000;
    const due: Array<{ at: number; run: () => void }> = [];
    Date.now = () => clock;
    globalThis.setTimeout = ((run: () => void, ms: number) => { due.push({ at: clock + ms, run }); return { unref() {} } as unknown as NodeJS.Timeout; }) as typeof setTimeout;
    let mark = 0;
    let error = null as Error | null;
    const internals = owner as unknown as { boundedBootstrapStep<T>(step: string, work: Promise<T>, timeoutMs?: number, settlement?: object): Promise<T> };
    const step = internals.boundedBootstrapStep('Post-bootstrap reconciliation', new Promise<void>(() => {}), 60_000, {
      progress: () => mark, onTimeout: (failure: Error) => { error = failure; },
    }).catch(() => {});
    void step;
    // The first window fires late, at 599 s, as a stalled event loop would, and saw progress.
    // No quantum finishes in the clamped last second: the cap still decides the message.
    const fire = (lateBy = 0, progress = true) => { due.sort((a, b) => a.at - b.at); const next = due.shift()!; clock = next.at + lateBy; if (progress) mark++; next.run(); };
    fire(539_000);
    assert.equal(clock - 1_000_000, 599_000);
    fire(0, false);
    assert.ok(error, 'the bound fired');
    assert.equal(clock - 1_000_000, 600_000, 'the last window was clamped to the remaining 1 s of the cap');
    assert.equal(error!.message, 'Post-bootstrap reconciliation did not settle inside 600000 ms');
  } finally {
    Date.now = realNow; globalThis.setTimeout = realSetTimeout;
    await owner.drain();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a timed-out post-bootstrap reconciliation settles only its own diagnostic', async () => {
  const createAttempt = async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'q')));
    const owner = new QueueRuntime({ dataDir: join(root, 'northstar-queue'), adapterFactory: () => fakeAdapter(root), timers: false });
    await owner.started;
    await owner.bootstrap;
    owner.bootstrapped = false;
    let resolveWork!: () => void;
    let rejectWork!: (error: Error) => void;
    const work = new Promise<void>((resolve, reject) => { resolveWork = resolve; rejectWork = reject; });
    (owner.engine as unknown as { wake: () => Promise<void> }).wake = () => work;
    const internals = owner as unknown as {
      boundedBootstrapStep<T>(step: string, work: Promise<T>, timeoutMs?: number, settlement?: {
        onTimeout?(error: Error): void;
        onLateSuccess?(): void;
        onLateFailure?(error: Error): void;
      }): Promise<T>;
    };
    const boundedBootstrapStep = internals.boundedBootstrapStep.bind(owner);
    internals.boundedBootstrapStep = (step, promise, timeoutMs, settlement) =>
      boundedBootstrapStep(step, promise, step === 'Post-bootstrap reconciliation' ? 25 : timeoutMs, settlement);
    await owner.ensureBootstrap();
    assert.equal(owner.startError, 'Post-bootstrap reconciliation did not settle inside 25 ms');
    return { owner, root, resolveWork, rejectWork };
  };

  const lateSuccess = await createAttempt();
  try {
    lateSuccess.resolveWork();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lateSuccess.owner.startError, '', 'late success clears the diagnostic owned by its timed-out attempt');
  } finally {
    await lateSuccess.owner.drain();
    rmSync(lateSuccess.root, { recursive: true, force: true });
  }

  const ownedFollowup = await createAttempt();
  try {
    (ownedFollowup.owner.engine as unknown as { wake: () => Promise<void> }).wake = async () => {};
    ownedFollowup.owner.queueControl({ paused: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(ownedFollowup.owner.startError, '', 'a successful runtime-owned full wake settles the diagnostic even if its original promise is still pending');
    ownedFollowup.resolveWork();
  } finally {
    await ownedFollowup.owner.drain();
    rmSync(ownedFollowup.root, { recursive: true, force: true });
  }

  const lateFailure = await createAttempt();
  try {
    lateFailure.rejectWork(new Error('reconciliation failed after timeout'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lateFailure.owner.startError, 'reconciliation failed after timeout', 'late failure replaces the timeout with its failure evidence');
  } finally {
    await lateFailure.owner.drain();
    rmSync(lateFailure.root, { recursive: true, force: true });
  }

  const newerError = await createAttempt();
  try {
    newerError.owner.startError = 'Host-run endpoint: newer failure';
    newerError.resolveWork();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(newerError.owner.startError, 'Host-run endpoint: newer failure', 'late success preserves a newer startup or host error');
  } finally {
    await newerError.owner.drain();
    rmSync(newerError.root, { recursive: true, force: true });
  }
});

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

test('local CLI reaches Queue without Paseo and fences only a different method contract', async () => {
  const root = socketFixtureDirectory('northstar-queue/queue-service.sock');
  const dir = join(root, 'northstar-queue');
  const { service } = await startFixture({ dataDir: dir });
  const { localQueueClient } = await import('../shared/service/local-client');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const local = localQueueClient(dir);
  try {
    await local.connect();
    const health = await local.request('service.health', {}) as { service: string; rpcContracts: Record<string, string> };
    assert.equal(health.service, 'nucleus');
    assert.match(health.rpcContracts.lanes, /^[a-f0-9]{64}$/);
    // There is no Paseo daemon behind this fixture; exercise the actual plain-node CLI loader.
    const cli = await promisify(execFile)(process.execPath, ['bin/queue-cli.mjs', 'service.health'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000,
      env: { ...process.env, NUCLEUS_DATA_HOME: dir, HOME: join(root, 'home') },
    });
    assert.equal(JSON.parse(cli.stdout).service, 'nucleus');
    const task = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'cli-controls', title: 'CLI controls', repoPath: '/fixture', planningCommit: 'a'.repeat(40),
      handoffPath: 'docs/handoffs/cli.md', originAgentId: 'origin',
    }), 'fixture-host', 'handoff', 'a'.repeat(40)] }) as { id: string };
    // The three legacy task-control helpers were copies of one versioned owner
    // verb each and sent no caller; they were removed, so these operations are
    // exercised through the one service client the CLI also uses.
    const { createServer: createHttpServer } = await import('node:http');
    const callerPath = join(dir, 'caller.sock');
    const caller = { caller: formatAgentId('fixture-host', 'fixture-cli'), hostId: 'fixture-host', source: 'run-ticket' };
    const callerServer = createHttpServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(caller));
    });
    await new Promise<void>(resolve => callerServer.listen(callerPath, resolve));
    const ticketPath = join(dir, 'run-ticket.json');
    writeFileSync(ticketPath, JSON.stringify({ socketPath: callerPath, token: 'fixture-token', taskId: task.id, runId: 'fixture-run' }), { mode: 0o600 });
    const controlCli = async (input: Record<string, unknown>) => {
      const payloadPath = join(dir, `control-${input.action as string}.json`);
      writeFileSync(payloadPath, JSON.stringify({ taskId: task.id, ...input }));
      const cli = await promisify(execFile)(process.execPath, ['bin/queue-cli.mjs', 'task', payloadPath], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000,
        env: { ...process.env, NUCLEUS_DATA_HOME: dir, HOME: join(root, 'home'), NUCLEUS_TICKET: ticketPath },
      });
      return JSON.parse(cli.stdout) as Record<string, unknown>;
    };
    try {
      assert.deepEqual((await controlCli({ action: 'set_dependencies', dependsOn: [] })).dependsOn, []);
      assert.ok((await controlCli({ action: 'promote' })).queuePriority as number > 0);
      const disposition = await controlCli({ action: 'cancel', reason: 'Fixture complete' });
      assert.ok(disposition.phase === 'cancelled' || disposition.accepted === true);
    } finally { await new Promise<void>(resolve => callerServer.close(() => resolve())); }

    const path = join(dir, 'queue-service.json');
    const original = readFileSync(path, 'utf8');
    try {
      writeFileSync(path, JSON.stringify({ ...JSON.parse(original), buildId: '0'.repeat(16) }));
      assert.deepEqual(await local.request('lanes', {}), [], 'a different whole-build identity does not fence a compatible method');
    } finally { writeFileSync(path, original); }
  } finally { local.close(); await service.stop(); rmSync(root, { recursive: true, force: true }); }
});


test('executor timing samples are bounded and exclude request input', async () => {
  const { service, client, dir } = await startFixture();
  try {
    for (let i = 0; i < 36; i++) await assert.rejects(() => client.request('queue.detail', { taskId: 'private-task-id' }), /Task not found/);
    await assert.rejects(() => service.debug({ target: 'store', method: 'missingMethod' }));
    const health = await client.request('service.health', {}) as { requestTimings: { inFlight: number; recent: import('../service/executor/executor').ExecutorRequestTiming[] } };
    assert.equal(health.requestTimings.recent.length, 32);
    assert.equal(health.requestTimings.inFlight, 0);
    assert.equal(health.requestTimings.recent.at(-1)?.outcome, 'error');
    assert.ok(!JSON.stringify(health.requestTimings).includes('private-task-id'));
  } finally { await client.close(); await service.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('a refusal reaches the client as its reason, without the server stack', async () => {
  // Planners read "Task changed; refresh before retrying" wrapped in a server stack as an opaque stream error.
  const { service, client, dir } = await startFixture();
  try {
    await assert.rejects(() => client.request('queue.detail', { taskId: 'missing-task' }), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Task not found/);
      assert.doesNotMatch(message, /\n\s+at /, 'no stack frames in the client-facing message');
      assert.equal(message.split('\n').length, 1);
      return true;
    });
  } finally { await client.close(); await service.stop(); rmSync(dir, { recursive: true, force: true }); }
});
