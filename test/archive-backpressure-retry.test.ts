import { fakeAdapter } from './support/fakes';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { Admission, AdmissionDeferred, BACKPRESSURE_DEFERRAL, admitAdapter } from '../core/host/admission';
import type { Adapter, ExternalWorkspaceArchiveInput } from '../core/host';
import { reviewEntryRecordSchema, submissionSchema, type ExternalWorkspaceArchive } from '../shared/contracts';
import { terminalArchiveFixture } from './support/terminal-archive-fixture';

/**
 * A terminal archive the admission breaker deferred is not a failed attempt.
 * On 2026-10-26 a false inventory trip held the breaker from 02:47 to 05:57;
 * every merged task's archive recorded each deferral as a failure, doubled its
 * delay to the one-hour cap, and stayed visible for up to an hour after the
 * breaker cleared. Titles already wait without backoff; Queue-owned and
 * preserved-external catalog archives now match.
 */

const deferral = `${BACKPRESSURE_DEFERRAL}3 slow critical Paseo calls in 60s: inventory 19540 ms (threshold 10000 ms)`;

function admission(degraded: boolean) {
  const clock = { now: 0 };
  const result = new Admission({ now: () => clock.now, startIntervalMs: 0 });
  return { admission: result, trip: async () => {
    if (!degraded) return;
    for (let i = 0; i < 3; i++) await result.run('inventory', async () => { clock.now += 11_000; });
    assert.equal(result.degradedNow, true);
  } };
}

async function fixture(t: TestContext, degraded: boolean) {
  const f = await terminalArchiveFixture(t);
  f.remote.participant.status = 'closed';
  // The deferral recorded while the breaker held: attempt 5, next retry an hour away.
  f.updateResolution({ workspaceArchiveRetries: [{ workspaceId: 'ws', attempts: 5, error: deferral,
    nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() }], cleanupReason: `Workspace archive for ws failed: ${deferral}` });
  const gate = admission(degraded);
  await gate.trip();
  // The admission wrapper binds adapter methods when it is built, so the native
  // archive is swappable through this seam rather than on the raw adapter.
  const real = f.adapter.archiveTaskWorkspace.bind(f.adapter);
  const seam = { archive: real as typeof real };
  (f.adapter as { archiveTaskWorkspace: typeof real }).archiveTaskWorkspace = (...args) => seam.archive(...args);
  const engine = new Engine(f.store, admitAdapter(f.adapter, gate.admission), 0, () => true, f.retirement);
  const pass = async () => { engine.enqueueCleanup(f.task().id); await engine.drainCleanup(); };
  return { ...f, engine, pass, seam, real };
}

test('a breaker deferral is due on the first admitted pass, not after its recorded backoff', async t => {
  const f = await fixture(t, false);
  try {
    await f.pass();
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
    assert.deepEqual(f.task().resolution.workspaceArchiveRetries, []);
    assert.equal(f.remote.archives.length, 1);
    assert.equal(existsSync(f.directory), false);
  } finally { await f.engine.stop(); }
});

test('while the breaker holds, a pass makes and records no archive attempt', async t => {
  const f = await fixture(t, true);
  try {
    // Due by its own clock too, so only the breaker can explain a skipped attempt.
    f.updateResolution({ workspaceArchiveRetries: f.task().resolution.workspaceArchiveRetries.map(record => ({ ...record, nextAttemptAt: new Date(0).toISOString() })) });
    const before = f.task();
    const events = f.store.events(before.id).length;
    await f.pass();
    assert.equal(f.remote.archives.length, 0);
    assert.equal(f.task().version, before.version, 'no write while deferred');
    assert.equal(f.store.events(before.id).length, events, 'no event while deferred');
    assert.equal(existsSync(f.directory), true);
  } finally { await f.engine.stop(); }
});

test('a deferral raised mid-attempt neither counts nor doubles the delay', async t => {
  const f = await fixture(t, false);
  try {
    f.seam.archive = async () => { throw new AdmissionDeferred('backpressure', deferral); };
    await f.pass();
    const record = f.task().resolution.workspaceArchiveRetries.find(item => item.workspaceId === 'ws')!;
    assert.equal(record.attempts, 5, 'a deferral is not an attempt');
    assert.ok(Date.parse(record.nextAttemptAt) <= Date.now(), 'and is due again at once');
    f.seam.archive = f.real;
    await f.pass();
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
  } finally { await f.engine.stop(); }
});

test('an ordinary archive failure keeps its counted, doubling backoff', async t => {
  const f = await fixture(t, false);
  try {
    f.updateResolution({ workspaceArchiveRetries: [{ workspaceId: 'ws', attempts: 2, error: 'Paseo refused', nextAttemptAt: new Date(0).toISOString() }] });
    f.seam.archive = async () => { throw Error('Paseo refused again'); };
    await f.pass();
    const record = f.task().resolution.workspaceArchiveRetries.find(item => item.workspaceId === 'ws')!;
    assert.equal(record.attempts, 3);
    assert.ok(Date.parse(record.nextAttemptAt) > Date.now());
  } finally { await f.engine.stop(); }
});

test('an owner retry while the breaker holds reports the deferral and sends no request', async t => {
  const f = await fixture(t, true);
  try {
    // retry() closes over the unwrapped fixture engine; the admitted adapter is on f.engine.
    await assert.rejects(f.engine.performTaskControl({ action: 'retry_effect', taskId: f.task().id, version: f.task().version,
      effect: 'workspace_archive.ws', caller: 'operator (board)', reason: 'Retry the deferred archive' }), (error: unknown) => {
      assert.match((error as Error).message, /^Workspace archive retry for ws attempt 5 failed: Paseo admission backpressure:/);
      return true;
    });
    assert.equal(f.remote.archives.length, 0);
    const record = f.task().resolution.workspaceArchiveRetries.find(item => item.workspaceId === 'ws')!;
    assert.equal(record.attempts, 5, 'a deferral is not an attempt');
    assert.ok(record.error.startsWith(BACKPRESSURE_DEFERRAL));
  } finally { await f.engine.stop(); }
});

const workspaceId = 'ws-ext';
const head = 'a'.repeat(40);
const placement = { kind: 'directory', isPaseoOwnedWorktree: false, mainRepoRoot: null };

function catalogRecord(taskId: string, directory: string, extra: Partial<ExternalWorkspaceArchive> = {}): ExternalWorkspaceArchive {
  return {
    workspaceId, directory, requestId: `ns-catalog-archive-${taskId}-${workspaceId}`,
    state: 'held', observed: null, participants: [], native: null, folderPresent: true, detail: deferral,
    attempts: 3, source: null, folderRemovalAuthorized: false, folderRemovedBy: null,
    samePathRegistrations: [workspaceId], intentAt: null, settledAt: new Date().toISOString(),
    nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(), ...extra,
  };
}

async function externalFixture(t: TestContext, degraded: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ns-archive-backpressure-ext-')));
  const directory = join(root, 'external');
  await mkdir(directory);
  const store = new Store(join(root, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'External catalog archive deferral', repoPath: join(root, 'repo'),
    planningCommit: head, handoffPath: 'docs/handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', head, {
    entrypoint: 'review',
    reviewEntry: reviewEntryRecordSchema.parse({
      operationId: 'c'.repeat(64), prNumber: 41, repository: 'example/repo', branch: 'feature/external',
      workspaceId, verifiedHead: head, verifiedBase: head, planningCommit: head,
      authority: 'Operator approved takeover',
      authorDeclaration: { models: ['openai/gpt-5'], githubAuthor: 'external-author', authoringSystem: 'external-agent', attestedBy: 'operator', provenance: 'Fixture attestation' },
      checkedAt: new Date().toISOString(), preserveWorkspace: true, directory,
    }),
  });
  store.update(inserted.id, {
    workspaceId, directory, prHead: head, prUrl: 'https://github.com/example/repo/pull/41', branch: 'feature/external',
    phase: 'done', resolution: { ...inserted.resolution, mergedCommit: head, syncedCommit: head,
      externalWorkspaceArchives: [catalogRecord(inserted.id, directory)],
      cleanupReason: `External workspace catalog entry held for ${workspaceId}: ${deferral}` },
  });
  const calls = { entered: 0, sent: 0 };
  const present = { value: true };
  const seam = {
    archive: async (input: ExternalWorkspaceArchiveInput) => {
      calls.entered++;
      if (!input.allowed(placement, [], null)) return { status: 'declined' as const, reason: 'declined' };
      calls.sent++;
      present.value = false;
      return { status: 'archived' as const, observed: placement, participants: [],
        native: { archivedAt: new Date().toISOString(), error: null }, folderPresent: true };
    },
  };
  const raw: Adapter = fakeAdapter({
    profiles: async () => [], validate: async () => '', createWorkspace: async () => { throw Error('unused'); },
     verifyWorkspace: async task => task.branch,
    createAgent: async () => { throw Error('unused'); },
    observe: async id => ({ id, workspaceId, status: 'idle', active: false, permissions: false, error: '' }),
    archiveTaskWorkspace: async () => { throw Error('a preserved external workspace must never use the Queue-owned teardown path'); },
    taskWorkspaceArchived: async () => !present.value,
    archiveExternalWorkspace: input => seam.archive(input),
    verifyPr: async () => ({ url: '', head: '' }),
  });
  const gate = admission(degraded);
  await gate.trip();
  const engine = new Engine(store, admitAdapter(raw, gate.admission), 0);
  t.after(async () => { await engine.stop(); store.close(); await rm(root, { recursive: true, force: true }); });
  const task = () => store.task(inserted.id);
  const record = () => task().resolution.externalWorkspaceArchives.find(item => item.workspaceId === workspaceId) ?? null;
  const pass = async () => { engine.enqueueCleanup(inserted.id); await engine.drainCleanup(); };
  const retry = () => engine.performTaskControl({ action: 'retry_effect', taskId: inserted.id, version: task().version,
    effect: `external_workspace_archive.${workspaceId}`, caller: 'operator (board)', reason: 'Retry the deferred catalog archive' });
  return { store, engine, calls, seam, present, task, record, pass, retry, directory };
}

test('while the breaker holds, a preserved-external pass makes and records no catalog attempt', async t => {
  const f = await externalFixture(t, true);
  f.store.update(f.task().id, { resolution: { ...f.task().resolution, externalWorkspaceArchives: f.task().resolution.externalWorkspaceArchives.map(item => ({ ...item, nextAttemptAt: new Date(0).toISOString() })) } });
  const before = f.task();
  const events = f.store.events(before.id).length;
  await f.pass();
  assert.equal(f.calls.entered, 0);
  assert.equal(f.calls.sent, 0);
  assert.equal(f.task().version, before.version, 'no write while deferred');
  assert.equal(f.store.events(before.id).length, events, 'no event while deferred');
  assert.equal(f.record()!.state, 'held');
  assert.equal(f.record()!.attempts, 3);
});

test('a preserved-external breaker deferral is due on the first admitted pass, not after its recorded backoff', async t => {
  const f = await externalFixture(t, false);
  await f.pass();
  assert.equal(f.record()!.state, 'archived');
  assert.equal(f.calls.sent, 1);
  assert.equal(existsSync(f.directory), true);
});

test('a pre-fix uncertain preserved-external deferral with no intent is due on the first admitted pass', async t => {
  const f = await externalFixture(t, false);
  f.store.update(f.task().id, { resolution: { ...f.task().resolution, externalWorkspaceArchives: [
    catalogRecord(f.task().id, f.directory, {
      state: 'uncertain', detail: `Catalog archive could not be requested: ${deferral}`,
      attempts: 5, nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(), intentAt: null,
    }),
  ] } });
  await f.pass();
  assert.equal(f.record()!.state, 'archived');
  assert.equal(f.calls.entered, 1);
  assert.equal(f.calls.sent, 1);
  assert.equal(existsSync(f.directory), true);
});

test('a preserved-external deferral raised mid-attempt neither counts nor delays the retry', async t => {
  const f = await externalFixture(t, false);
  f.seam.archive = async () => { throw new AdmissionDeferred('backpressure', deferral); };
  await f.pass();
  const held = f.record()!;
  assert.equal(held.state, 'held');
  assert.equal(held.attempts, 3, 'a deferral is not an attempt');
  assert.equal(held.detail, deferral);
  assert.ok(Date.parse(held.nextAttemptAt!) <= Date.now(), 'and is due again at once');
  assert.equal(f.calls.sent, 0);
  f.seam.archive = async (input: ExternalWorkspaceArchiveInput) => {
    f.calls.entered++;
    if (!input.allowed(placement, [], null)) return { status: 'declined' as const, reason: 'declined' };
    f.calls.sent++;
    return { status: 'archived' as const, observed: placement, participants: [],
      native: { archivedAt: new Date().toISOString(), error: null }, folderPresent: true };
  };
  await f.pass();
  assert.equal(f.record()!.state, 'archived');
  assert.equal(f.calls.sent, 1);
});

test('an ordinary preserved-external archive throw keeps its counted backoff and stays uncertain', async t => {
  const f = await externalFixture(t, false);
  f.seam.archive = async (input: ExternalWorkspaceArchiveInput) => {
    f.calls.entered++;
    if (!input.allowed(placement, [], null)) return { status: 'declined' as const, reason: 'declined' };
    throw Error('Paseo refused');
  };
  await f.pass();
  const record = f.record()!;
  assert.equal(record.state, 'uncertain');
  assert.equal(record.attempts, 4);
  assert.ok(Date.parse(record.nextAttemptAt!) > Date.now());
  assert.match(record.detail, /Catalog archive could not be requested: Paseo refused/);
  assert.equal(f.calls.entered, 1);
});

test('an uncertain preserved-external record that already wrote intent is not auto-replayed', async t => {
  const f = await externalFixture(t, false);
  const wrapped = `Catalog archive could not be requested: ${deferral}`;
  f.store.update(f.task().id, { resolution: { ...f.task().resolution, externalWorkspaceArchives: [
    catalogRecord(f.task().id, f.directory, {
      state: 'uncertain', detail: wrapped, attempts: 1, nextAttemptAt: new Date(0).toISOString(),
      intentAt: new Date(0).toISOString(),
    }),
  ] } });
  await f.pass();
  const record = f.record()!;
  assert.equal(record.state, 'uncertain', 'an automatic pass never replays an unknown delivery');
  assert.equal(f.calls.entered, 0);
  assert.equal(f.calls.sent, 0);
  assert.match(record.detail, /prior catalog archive request/);
});

test('an owner retry of a preserved-external deferral while the breaker holds reports the hold', async t => {
  const f = await externalFixture(t, true);
  await assert.rejects(f.retry(), (error: unknown) => {
    assert.match((error as Error).message, new RegExp(`^External workspace catalog archive for ${workspaceId} is held: Paseo admission backpressure:`));
    return true;
  });
  assert.equal(f.calls.entered, 0);
  assert.equal(f.calls.sent, 0);
  const held = f.record()!;
  assert.equal(held.state, 'held');
  assert.equal(held.attempts, 3);
  assert.ok(held.detail.startsWith(BACKPRESSURE_DEFERRAL));
  assert.ok(Date.parse(held.nextAttemptAt!) <= Date.now());
});
