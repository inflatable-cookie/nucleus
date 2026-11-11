import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AUTO_VACUUM_INCREMENTAL, CACHE_SIZE_KIB, CURRENT_SCHEMA, JOURNAL_SIZE_LIMIT_BYTES, STORE_COMPACTION_META_KEY,
  STORE_MAINTENANCE_META_KEY, Store, StoreMaintenanceError, type StoreFacts,
} from '../core/store/store';
import {
  COMPACTION_MAX_ATTEMPTS, COMPACTION_MAX_BLOCKED_MS, COMPACTION_VERIFY_BYTES_PER_MS, StoreCompactor, compactionDue,
  estimatedBlockedMs, freeBytesOn, readCompactionRecord, requiredFreeBytes, storeCompactionRecordSchema,
  type StoreCompactionDeps,
} from '../core/store/store-compaction';
import { MAINTENANCE_READINESS_CAP_MS } from '../service/install/standby';
import { backupCommand } from '../core/store/backups';
import { QueueRuntime } from '../service/runtime-owner';
import { outcomeSchema, submissionSchema } from '../shared/contracts';

/** The retired contract 009 producer's per-host setting key; migration must carry it unchanged. */

/**
 * Spec 028 revision "lighter backups and a compacting store" (audit B9; Tom's
 * 2026-10-25 "Shrink the DB file" ruling a1a817c3): incremental auto-vacuum for new
 * stores, one service-owned conversion of an existing `auto_vacuum=0` store, and
 * bounded freed-page reclamation after the prune passes.
 *
 * Every store here is an isolated fixture under a fresh temporary directory. No live
 * database, backup, profile, pause state, credential or process is read or written;
 * the live one-shot conversion belongs to the operator's activation, and the root
 * owns that quiet-window, disk and backup review.
 */

const HEAD = 'a'.repeat(40);
const repo = { origin: 'owner/repo', path: '/repo' };

const dirFixture = (t: { after: (fn: () => void) => void }, prefix = 'ns-compact-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'queue.sqlite') };
};

/** A record's exact stored bytes, for the "nothing changed" assertions. */
const meta = (store: Store, key: string) => store.getMeta<unknown>(key);

function submit(store: Store, id: string, extra: Record<string, unknown> = {}) {
  return store.insert(submissionSchema.parse({ submissionId: id, title: id, repoPath: '/repo',
    planningCommit: HEAD, handoffPath: `${id}.md`, originAgentId: 'origin', ...extra }), 'host', `# ${id}\n`, HEAD);
}

/** The public, durable state a compaction must preserve, as one comparable value. */
function publicState(store: Store, ids: string[]) {
  return JSON.parse(JSON.stringify({
    tasks: ids.map(id => store.task(id)),
    runs: store.runs(),
    events: store.eventsAll(ids[0]),
    notices: store.notices(),
    meta: Object.fromEntries(['schema', 'paused', 'pool', 'globalLimit', 'projectLimit', 'stallThresholdMinutes',
      'usageLevel', 'capacityChanges', 'retentionError', 'lastRetentionAt'].map(key => [key, meta(store, key) ?? null])),
    availability: store.availability(),
    counts: store.counts(),
  }));
}

/**
 * A store as the previous build left it: real tasks, runs, events, notices, holds, limits,
 * pause, a profile pool, subscription availability — and `auto_vacuum=0`, which is what a
 * store created before this change says. Deleting rows afterwards leaves free pages that
 * only a rewrite can return, which is the audit's claim.
 */
function legacyStore(t: { after: (fn: () => void) => void }) {
  const { dir, path } = dirFixture(t, 'ns-compact-legacy-');
  const store = new Store(path);
  store.setMeta('paused', true);
  store.setMeta('globalLimit', 3);
  store.setMeta('projectLimit', 2);
  store.setMeta('stallThresholdMinutes', 11);
  store.setMeta('pool', [{ profile: 'worker', enabled: true, count: 1 }]);
  store.db.prepare('INSERT INTO availability VALUES(?,?)').run('group-a', JSON.stringify({ group: 'group-a', unavailable: false, reason: '', retryAt: null }));
  const task = submit(store, 'kept');
  store.update(task.id, { reason: 'holds must survive the rewrite' });
  store.event(task.id, 'note', 'history that must survive');
  store.putRun({ id: 'run-keep', taskId: task.id, role: 'revision', generation: 1, head: HEAD, base: HEAD,
    agentId: 'agent-1', workspaceId: 'ws-1', profile: null, status: 'running', createdAt: '2026-10-08T00:00:00.000Z',
    lastObservedAt: null, active: true, idleSince: null, completion: null, released: false });
  store.putNotice({ id: 'notice-keep', taskId: task.id, agentId: 'agent-1', text: 'notice that must survive',
    status: 'pending', error: '', kind: 'hold', recipientAgentId: 'agent-1', workspaceId: 'ws-1', sources: ['origin'], originEntry: true });
  store.event(task.id, 'closed_out', 'kept');
  // Back to the pre-change mode, exactly as a store written before this build reads. The
  // rewrite also leaves the file compact, so the pruned history below is what leaves free
  // pages that only another rewrite could return.
  store.db.exec('PRAGMA auto_vacuum=NONE');
  store.db.exec('VACUUM');
  store.checkpointWal();
  assert.equal(store.autoVacuumMode(), 0, 'the fixture starts in auto_vacuum=0');
  // Bulk history that will be pruned: whole pages become free and an auto_vacuum=0 store
  // can never return them.
  const filler = 'x'.repeat(3000);
  const insert = store.db.prepare("INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)");
  store.transaction(() => { for (let i = 0; i < 600; i++) insert.run(task.id, `2026-10-0${1 + (i % 9)}T00:00:00.000Z`, 'filler', filler); });
  store.checkpointWal();
  store.transaction(() => { store.db.prepare("DELETE FROM events WHERE kind='filler'").run(); });
  store.checkpointWal();
  // Outcome-freeze the fixture: closing releases nothing and the file is a plain store.
  store.close();
  const reopened = new Store(path);
  assert.equal(reopened.autoVacuumMode(), 0, 'reopening a pre-change store keeps its mode');
  return { dir, path, store: reopened, taskId: task.id };
}

/** The real verified-snapshot route, on an isolated fixture store. */
async function realSnapshot(path: string) {
  const dir = dirname(path);
  const list = await backupCommand('now', path, join(dir, 'backups'), undefined);
  const snapshot = list.snapshots.filter(entry => entry.verified)[0];
  assert.ok(snapshot, `a verified local snapshot is required: ${JSON.stringify(list.localError)}`);
  assert.ok(existsSync(join(dir, 'backups', snapshot.name)), 'the verified snapshot is on disk');
  return { name: snapshot.name, bytes: snapshot.size };
}

function deps(path: string, overrides: Partial<StoreCompactionDeps> = {}): StoreCompactionDeps {
  return { snapshot: () => realSnapshot(path), freeBytes: () => freeBytesOn(path), log: () => {}, ...overrides };
}

test('a new store starts in incremental auto-vacuum with the bounded WAL and cache pragmas', t => {
  const { path } = dirFixture(t);
  const store = new Store(path);
  try {
    assert.equal(store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL, 'a store this build creates can return freed pages');
    assert.equal(store.getMeta('schema'), CURRENT_SCHEMA);
    assert.equal(Number((store.db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit), JOURNAL_SIZE_LIMIT_BYTES);
    assert.equal(Number((store.db.prepare('PRAGMA cache_size').get() as { cache_size: number }).cache_size), -CACHE_SIZE_KIB);
    assert.equal(Number((store.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size) > 0, true);
  } finally { store.close(); }
  // The mode is a property of the file, not of one connection.
  const reopened = new Store(path);
  try {
    assert.equal(reopened.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
    // The pragmas are per connection: an existing store opened later gets them too.
    assert.equal(Number((reopened.db.prepare('PRAGMA cache_size').get() as { cache_size: number }).cache_size), -CACHE_SIZE_KIB);
  } finally { reopened.close(); }
  const memory = new Store(':memory:');
  try { assert.equal(memory.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL); }
  finally { memory.close(); }
});

test('the parent: an auto_vacuum=0 store never returns a freed page, and the conversion is what changes that', async t => {
  const { path, store, taskId } = legacyStore(t);
  try {
    const facts = store.storeFacts();
    assert.ok(facts.freePages > 0, `the pruned history left free pages (${facts.freePages})`);
    const fileBytes = facts.fileBytes, pageCount = facts.pageCount;
    // Parent behaviour: bounded reclamation is refused and the file keeps its high-water mark.
    const refused = store.reclaimFreedPages();
    assert.equal(refused.pages, 0);
    assert.match(String(refused.skipped), /not in incremental auto-vacuum/);
    store.checkpointWal();
    assert.deepEqual([store.storeFacts().fileBytes, store.storeFacts().pageCount], [fileBytes, pageCount], 'no page or byte came back');

    // Child behaviour: the rewrite returns the pages the pruned history left, and the freed
    // pages that arrive afterwards are then returned by bounded maintenance alone.
    const before = store.storeFacts();
    const run = await new StoreCompactor(store, deps(path)).run('test');
    assert.equal(run.converted, true);
    assert.equal(store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
    const converted = store.storeFacts();
    assert.ok(converted.fileBytes < before.fileBytes, `the rewrite returned the pruned pages: ${before.fileBytes} -> ${converted.fileBytes}`);
    const filler = 'z'.repeat(3000);
    const insert = store.db.prepare("INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)");
    store.transaction(() => { for (let i = 0; i < 600; i++) insert.run(taskId, '2026-10-02T00:00:00.000Z', 'filler2', filler); });
    // The growth reaches the file only once the WAL is checkpointed, which is what a real
    // busy hour does; the deletion below then leaves those pages free inside the file.
    store.checkpointWal();
    const grown = store.storeFacts();
    store.transaction(() => { store.db.prepare("DELETE FROM events WHERE kind='filler2'").run(); });
    assert.ok(store.storeFacts().freePages > 0, 'the new deletion left free pages');
    const reclaimed = store.reclaimFreedPages({ maxPages: 4096 });
    assert.equal(reclaimed.error, null);
    assert.ok(reclaimed.pages > 0, `bounded maintenance returned the new pages (${reclaimed.pages})`);
    assert.ok(store.storeFacts().fileBytes < grown.fileBytes, `and the file shrank again: ${grown.fileBytes} -> ${store.storeFacts().fileBytes}`);
    assert.equal(store.task(taskId).reason, 'holds must survive the rewrite');
  } finally { store.close(); }
});

test('the one-shot conversion runs exactly once and preserves every stored record and setting', async t => {
  const { path, store, taskId } = legacyStore(t);
  const before = publicState(store, [taskId]);
  const fingerprint = store.contentFingerprint().digest;
  const facts = store.storeFacts();
  let snapshots = 0;
  const compactor = new StoreCompactor(store, deps(path, {
    snapshot: async () => { snapshots++; return realSnapshot(path); },
  }));
  try {
    assert.equal(compactionDue(store), true, 'a pre-change store is due');
    const first = await compactor.run('test');
    assert.equal(first.converted, true);
    assert.equal(snapshots, 1, 'the recovery route is one verified snapshot');
    assert.equal(first.record.state, 'converted');
    assert.equal(first.record.attempts, 1);
    assert.equal(first.record.fingerprint, fingerprint, 'the record keeps the pre-rewrite content digest');
    assert.equal(first.record.verification?.content, 'verified', 'preservation was verified from the rows, not their width');
    assert.ok((first.record.verification?.rows ?? 0) > 0);
    assert.equal(first.record.exclusion?.exclusive, true, "the window held SQLite exclusive locking mode");
    assert.equal(first.record.exclusion?.probeBefore, true, 'a competing write was refused before the rewrite');
    assert.equal(first.record.exclusion?.probeAfter, true, 'and still refused after it');
    assert.equal(first.record.exclusion?.journalMode, 'delete', 'the gate left WAL, which needs exclusive access');
    assert.match(String(first.record.snapshot), /\.(hourly|daily|weekly)\.sqlite\.gz$/);
    assert.equal(existsSync(join(dirname(path), 'backups', String(first.record.snapshot))), true, 'the cited snapshot exists');
    assert.equal(typeof first.record.blockedMs, 'number');
    assert.equal(typeof first.record.estimatedBlockedMs, 'number');
    assert.ok((first.record.blockedMs ?? 0) >= 0 && (first.record.estimatedBlockedMs ?? 0) > 0);
    assert.equal(first.record.before?.freePages, facts.freePages);
    assert.equal(first.record.after?.autoVacuum, AUTO_VACUUM_INCREMENTAL);
    // The rewrite kept the store's rows and settings, and SQLite agrees the file is sound.
    assert.equal(store.contentFingerprint().digest, fingerprint);
    assert.deepEqual(publicState(store, [taskId]), before);
    assert.equal((store.db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>).map(row => Object.values(row)[0]).join(';'), 'ok');
    assert.equal(store.getMeta('paused'), true, 'the operator pause is untouched');
    assert.equal(store.getMeta('globalLimit'), 3);
    // Exactly once: a second attempt is not due and rewrites nothing.
    assert.equal(compactionDue(store), false);
    const second = await compactor.runIfDue('test');
    assert.equal(second?.converted, false);
    assert.equal(second?.record.attempts, 1, 'no second attempt is recorded');
    assert.equal(snapshots, 1, 'and no second snapshot is taken');
  } finally { store.close(); }
});

test('an interrupted attempt is settled from the store, and an unknown outcome never rewrites twice', async t => {
  const { path, store } = legacyStore(t);
  try {
    const compactor = new StoreCompactor(store, deps(path));
    // A crash after the intent but before the outcome: the store still says 0, so the
    // bounded attempt may run again (VACUUM's own transaction left the file as it was).
    store.setMeta(STORE_COMPACTION_META_KEY, storeCompactionRecordSchema.parse({
      version: 1, state: 'running', trigger: 'test', attempts: 1, at: '2026-10-25T00:00:00.000Z',
      startedAt: '2026-10-25T00:00:00.000Z', finishedAt: null, before: store.storeFacts(), after: null,
      requiredFreeBytes: 1, freeBytes: 1, estimatedBlockedMs: 1, blockedMs: null, snapshot: 'old.sqlite.gz', fingerprint: null, reason: null,
    }));
    assert.equal(compactionDue(store), true, 'an unknown outcome is retried');
    const retried = await compactor.run('test');
    assert.equal(retried.converted, true);
    assert.equal(retried.record.attempts, 2);

    // A crash after the rewrite but before the outcome: the store already says 2, so the
    // completion is recorded from the store and no second VACUUM runs.
    const convertedFacts = store.storeFacts();
    store.setMeta(STORE_COMPACTION_META_KEY, storeCompactionRecordSchema.parse({
      version: 1, state: 'running', trigger: 'test', attempts: 2, at: '2026-10-25T00:10:00.000Z',
      startedAt: '2026-10-25T00:10:00.000Z', finishedAt: null, before: convertedFacts, after: null,
      requiredFreeBytes: 1, freeBytes: 1, estimatedBlockedMs: 1, blockedMs: null, snapshot: 'new.sqlite.gz', fingerprint: null, reason: null,
    }));
    const settled = await compactor.run('test');
    assert.equal(settled.converted, false, 'the conversion is not repeated');
    assert.equal(settled.record.state, 'landed', 'the mode proves the rewrite landed, not that the rows survived');
    assert.equal(settled.record.attempts, 2, 'the interrupted attempt keeps its number');
    assert.equal(settled.record.settledFrom, 'running');
    assert.match(String(settled.record.reason), /preservation was never verified/);
    assert.doesNotMatch(String(settled.record.reason), /openable and unchanged/, 'a landed rewrite is never called unchanged');
    assert.match(String(settled.record.reason), /not that its records are unchanged/);
  } finally { store.close(); }
});

test('the start path settles an unknown outcome that already landed, and takes no snapshot', async t => {
  const { path, store } = legacyStore(t);
  let snapshots = 0;
  try {
    // The store is already converted, as a rewrite that landed leaves it.
    await new StoreCompactor(store, deps(path)).run('test');
    assert.equal(store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
    assert.equal(readCompactionRecord(store)?.state, 'converted');
    const before = store.storeFacts();
    // A crash between the rewrite and its outcome leaves `running`; the service start path is
    // `runIfDue`, so that is what must settle it (Spec 028 acceptance 11).
    store.setMeta(STORE_COMPACTION_META_KEY, storeCompactionRecordSchema.parse({
      version: 1, state: 'running', trigger: 'service-start', attempts: 1, at: '2026-10-25T00:20:00.000Z',
      startedAt: '2026-10-25T00:20:00.000Z', finishedAt: null, before, after: null,
      requiredFreeBytes: 1, freeBytes: 1, estimatedBlockedMs: 1, blockedMs: null, snapshot: 'landed.sqlite.gz', fingerprint: null, reason: null,
    }));
    assert.equal(compactionDue(store), true, 'an already-incremental store with an unknown outcome is still due');
    const settled = await new StoreCompactor(store, deps(path, { snapshot: async () => { snapshots++; return realSnapshot(path); } })).runIfDue('service-start');
    assert.equal(snapshots, 0, 'settling a landed rewrite needs no snapshot and no rewrite');
    assert.equal(settled?.converted, false);
    assert.equal(settled?.record.state, 'landed', 'settling from the mode never mints a verified conversion');
    assert.equal(settled?.record.verification?.content, 'not-run');
    assert.match(String(settled?.record.verification?.reason), /no preservation verification ran/);
    assert.equal(settled?.record.attempts, 1, 'the interrupted attempt keeps its number');
    assert.equal(settled?.record.fingerprint, null, 'the dead attempt recorded no digest, and none is invented');
    assert.match(String(settled?.record.reason), /preservation was never verified/);
    assert.equal(store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
    // A landed record is final: an incremental store is not rewritten to clean up its health.
    assert.equal(compactionDue(store), false);
    const again = await new StoreCompactor(store, deps(path)).runIfDue('service-start');
    assert.equal(again?.record.state, 'landed');
    assert.equal(again?.converted, false);

    // A `failed` record whose rewrite nevertheless landed is settled the same way.
    store.setMeta(STORE_COMPACTION_META_KEY, storeCompactionRecordSchema.parse({
      version: 1, state: 'failed', trigger: 'service-start', attempts: 2, at: '2026-10-25T00:30:00.000Z',
      startedAt: '2026-10-25T00:30:00.000Z', finishedAt: '2026-10-25T00:30:05.000Z', before, after: store.storeFacts(),
      requiredFreeBytes: 1, freeBytes: 1, estimatedBlockedMs: 1, blockedMs: 2, snapshot: 'landed.sqlite.gz', fingerprint: null,
      reason: 'the rewritten store changed during the conversion',
    }));
    assert.equal(compactionDue(store), true);
    const failedSettled = await new StoreCompactor(store, deps(path, { snapshot: async () => { snapshots++; return realSnapshot(path); } })).runIfDue('service-start');
    assert.equal(snapshots, 0);
    assert.equal(failedSettled?.record.state, 'landed', 'a failed record whose rewrite landed stays a landed rewrite');
    assert.equal(failedSettled?.record.attempts, 2);
    // The dead attempt's evidence is kept, not replaced by the settlement.
    assert.equal(failedSettled?.record.prior?.state, 'failed');
    assert.equal(failedSettled?.record.prior?.reason, 'the rewritten store changed during the conversion');
    assert.equal(failedSettled?.record.prior?.snapshot, 'landed.sqlite.gz');
    assert.match(String(failedSettled?.record.reason), /the rewritten store changed during the conversion/);
    assert.equal(compactionDue(store), false);
  } finally { store.close(); }
});

test('the conversion is refused before it touches the store when the space, the window or the snapshot is missing', async t => {
  const { path, store } = legacyStore(t);
  try {
    const facts = store.storeFacts();
    const fingerprint = store.contentFingerprint().digest;
    let snapshots = 0;
    const counting = async () => { snapshots++; return realSnapshot(path); };

    // The rewrite comes after the schema steps: a store this build cannot read is never
    // rewritten into a shape it would then fail to read. Clearing the record afterwards
    // keeps each refusal below on its own bounded attempt.
    store.setMeta('schema', CURRENT_SCHEMA - 1);
    const stale = await new StoreCompactor(store, deps(path)).run('test');
    assert.equal(stale.record.state, 'refused');
    assert.match(String(stale.record.reason), new RegExp(`schema \\(${CURRENT_SCHEMA - 1}\\) is not current`));
    store.setMeta('schema', CURRENT_SCHEMA);
    store.deleteMeta(STORE_COMPACTION_META_KEY);

    const noSpace = await new StoreCompactor(store, deps(path, { freeBytes: () => 1 })).run('test');
    assert.equal(noSpace.record.state, 'refused');
    assert.match(String(noSpace.record.reason), /insufficient free space before the snapshot/);
    assert.equal(noSpace.record.attempts, 1);
    assert.equal(noSpace.record.requiredFreeBytes, requiredFreeBytes(noSpace.record.before!, 0));
    assert.equal(snapshots, 0, 'no snapshot is taken when there is no room for the rewrite');

    const tooLong = await new StoreCompactor(store, deps(path, { maxBlockedMs: 1 })).run('test');
    assert.equal(tooLong.record.state, 'refused');
    assert.match(String(tooLong.record.reason), /estimated blocked interval/);
    assert.equal(tooLong.record.attempts, 2, 'a refusing attempt still counts toward the bound');
    assert.ok(Number(tooLong.record.estimatedBlockedMs) > 1);

    const noSnapshot = await new StoreCompactor(store, deps(path, { snapshot: async () => { snapshots++; throw new Error('the snapshot child failed'); } })).run('test');
    assert.equal(noSnapshot.record.state, 'refused');
    assert.match(String(noSnapshot.record.reason), /no verified snapshot: the snapshot child failed/);
    assert.equal(snapshots, 1);

    // Every refusal left the store's records and pages exactly as they were; the only rows
    // written are the bounded record itself.
    assert.equal(store.autoVacuumMode(), 0);
    assert.equal(store.contentFingerprint().digest, fingerprint);
    assert.ok(store.storeFacts().freePages >= facts.freePages, 'no page was returned by a refusal');

    // A spent attempt budget is reported, never silently exceeded.
    assert.ok(COMPACTION_MAX_ATTEMPTS >= 2);
    store.setMeta(STORE_COMPACTION_META_KEY, storeCompactionRecordSchema.parse({
      version: 1, state: 'refused', trigger: 'test', attempts: COMPACTION_MAX_ATTEMPTS, at: new Date().toISOString(),
      startedAt: null, finishedAt: null, before: facts, after: null, requiredFreeBytes: 1, freeBytes: 1,
      estimatedBlockedMs: 1, blockedMs: null, snapshot: null, fingerprint: null, reason: 'insufficient free space',
    }));
    assert.equal(compactionDue(store), false);
    const spent = await new StoreCompactor(store, deps(path)).run('test');
    assert.equal(spent.record.state, 'refused');
    assert.match(String(spent.record.reason), /bounded attempt count is spent/);
    // An unknown outcome with the budget spent is settled to that refusal on the next start,
    // so `running` never stays the last word on the record.
    store.setMeta(STORE_COMPACTION_META_KEY, storeCompactionRecordSchema.parse({
      version: 1, state: 'running', trigger: 'test', attempts: COMPACTION_MAX_ATTEMPTS, at: new Date().toISOString(),
      startedAt: new Date().toISOString(), finishedAt: null, before: facts, after: null, requiredFreeBytes: 1, freeBytes: 1,
      estimatedBlockedMs: 1, blockedMs: null, snapshot: null, fingerprint: null, reason: null,
    }));
    assert.equal(compactionDue(store), true, 'an unknown outcome is settled rather than left running');
    const settledSpent = await new StoreCompactor(store, deps(path)).run('test');
    assert.equal(settledSpent.record.state, 'refused');
    assert.match(String(settledSpent.record.reason), /bounded attempt count is spent/);
  } finally { store.close(); }
});

test('a failed rewrite leaves the original store openable, unchanged and writing again', async t => {
  const { path, store, taskId } = legacyStore(t);
  const before = publicState(store, [taskId]);
  const fingerprint = store.contentFingerprint().digest;
  try {
    const failed = await new StoreCompactor(store, deps(path, { failConversion: 'before-vacuum' })).run('test');
    assert.equal(failed.converted, false);
    assert.equal(failed.record.state, 'failed');
    assert.match(String(failed.record.reason), /fixture: conversion failed before VACUUM/);
    assert.match(String(failed.record.reason), /the store was not rewritten \(auto_vacuum is still 0\)/);
    assert.equal(failed.record.verification?.content, 'not-run', 'nothing claims preservation was verified');
    assert.equal(store.autoVacuumMode(), 0, 'the pending mode is cleared with the failed attempt');
    assert.equal(store.contentFingerprint().digest, fingerprint);
    assert.deepEqual(publicState(store, [taskId]), before);
    assert.equal(store.db.isTransaction, false);
    // Writers resume: the gate is released and the store still takes ordinary writes.
    store.setMeta('paused', false);
    store.event(taskId, 'note', 'writers resumed after a failed conversion');
    assert.equal(store.getMeta('paused'), false);
    assert.equal(store.eventsAll(taskId).some(event => event.detail === 'writers resumed after a failed conversion'), true);
    // Reopening the file proves it is intact after the failed attempt.
    store.close();
    const reopened = new Store(path);
    try {
      assert.equal(reopened.autoVacuumMode(), 0);
      assert.equal(reopened.task(taskId).reason, 'holds must survive the rewrite');
      assert.equal((reopened.db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>).map(row => Object.values(row)[0]).join(';'), 'ok');
      assert.equal(readCompactionRecord(reopened)?.state, 'failed');
    } finally { reopened.close(); }
  } finally { try { store.close(); } catch { /* already closed by the reopen check */ } }
});

test('a rewrite that landed without verification is landed, never converted or unchanged', async t => {
  const first = legacyStore(t);
  try {
    const interrupted = await new StoreCompactor(first.store, deps(first.path, { failConversion: 'after-vacuum' })).run('test');
    assert.equal(interrupted.converted, false);
    assert.equal(interrupted.record.state, 'landed');
    assert.match(String(interrupted.record.reason), /the rewrite landed \(auto_vacuum=2\) but preservation was not verified/);
    assert.doesNotMatch(String(interrupted.record.reason), /openable and unchanged/);
    assert.match(String(interrupted.record.reason), /not proven unchanged/);
    assert.equal(interrupted.record.verification?.content, 'not-run');
    assert.ok(interrupted.record.fingerprint, 'the pre-rewrite digest is kept for the operator');
    assert.ok(interrupted.record.snapshot, 'and the snapshot a restore would use');
    assert.equal(first.store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL, 'the rewrite itself landed');
    // The next start settles it from the store instead of rewriting a second time.
    const settled = await new StoreCompactor(first.store, deps(first.path)).run('test');
    assert.equal(settled.converted, false);
    assert.equal(settled.record.state, 'landed');
    assert.equal(settled.record.prior?.state, 'landed');
    assert.equal(settled.record.prior?.fingerprint, interrupted.record.fingerprint, 'the dead attempt\'s digest is kept');
  } finally { first.store.close(); }

  const second = legacyStore(t);
  try {
    const changed = await new StoreCompactor(second.store, deps(second.path, { failConversion: 'changed-store' })).run('test');
    assert.equal(changed.converted, false);
    assert.equal(changed.record.state, 'landed', 'a landed rewrite with changed rows is still a landed rewrite');
    assert.equal(changed.record.verification?.content, 'changed');
    assert.match(String(changed.record.reason), /logical content changed across the rewrite/);
    assert.doesNotMatch(String(changed.record.reason), /openable and unchanged/);
    assert.equal(second.store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
    // The changed row is still there: the conversion never rolls a foreign write back.
    assert.equal(second.store.getMeta('compactionFixtureChange'), 'written while the store was being converted');
  } finally { second.store.close(); }
});

test('a busy store is refused before the pragma runs, and a writer holding the file changes nothing', async t => {
  const { path, store, taskId } = legacyStore(t);
  const fingerprint = store.contentFingerprint().digest;
  const reader = new DatabaseSync(path);
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS n FROM tasks').get();
    const busy = await new StoreCompactor(store, deps(path)).run('test');
    assert.equal(busy.converted, false);
    assert.equal(busy.record.state, 'refused', 'a window that cannot be proved is a refusal, not a failed rewrite');
    assert.match(String(busy.record.reason), /still active|locked|refused exclusive access/);
    assert.match(String(busy.record.reason), /the store was not rewritten/);
    assert.equal(busy.record.exclusion?.exclusive, false);
    assert.equal(store.autoVacuumMode(), 0, 'the pragma is not reached while the file is held');
    assert.equal(store.contentFingerprint().digest, fingerprint);
    assert.equal(store.db.isTransaction, false, 'the gate left no transaction behind');
    reader.exec('ROLLBACK');
  } finally { reader.close(); }
  try {
    // Writers resume after the failed window.
    store.event(taskId, 'note', 'after a busy conversion attempt');
    assert.equal(store.storeFacts().autoVacuum, 0);

    // A second connection holding a write transaction blocks the intent record itself, so
    // the attempt fails before anything is written or touched.
    const writer = new DatabaseSync(path);
    writer.exec('BEGIN IMMEDIATE');
    try {
      assert.ok(readCompactionRecord(store));
      const previous = JSON.stringify(readCompactionRecord(store));
      await assert.rejects(new StoreCompactor(store, deps(path)).run('test'), /locked|busy/i);
      assert.equal(JSON.stringify(readCompactionRecord(store)), previous, 'no record was half-written');
      assert.equal(store.autoVacuumMode(), 0);
    } finally { writer.exec('ROLLBACK'); writer.close(); }
    assert.equal(store.task(taskId).reason, 'holds must survive the rewrite');
    assert.equal((store.db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>).map(row => Object.values(row)[0]).join(';'), 'ok');
  } finally { store.close(); }
});

test('the write funnels are closed inside the maintenance window and the operator pause is not the gate', t => {
  const { path } = dirFixture(t);
  const store = new Store(path);
  try {
    store.setMeta('paused', true);
    store.beginMaintenanceWindow();
    assert.equal(store.maintenance, true);
    assert.throws(() => store.setMeta('paused', false), StoreMaintenanceError);
    assert.throws(() => store.transaction(() => store.setMeta('globalLimit', 9)), StoreMaintenanceError);
    assert.throws(() => store.beginMaintenanceWindow(), /already open/);
    assert.equal(store.getMeta('paused'), true, 'the pause key is not the maintenance gate');
    assert.equal(store.getMeta('globalLimit'), undefined);
    assert.equal(store.reclaimFreedPages().skipped, 'a maintenance window is open');
    store.endMaintenanceWindow();
    assert.equal(store.maintenance, false);
    store.setMeta('globalLimit', 4);
    assert.equal(store.getMeta('globalLimit'), 4);
  } finally { store.close(); }
});

test('freed pages are returned in bounded passes, and the WAL is bounded after them', t => {
  const { path } = dirFixture(t);
  const store = new Store(path);
  try {
    const task = submit(store, 'bulk');
    const filler = 'y'.repeat(4000);
    const insert = store.db.prepare("INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)");
    store.transaction(() => { for (let i = 0; i < 800; i++) insert.run(task.id, '2026-10-01T00:00:00.000Z', 'filler', filler); });
    store.checkpointWal();
    store.transaction(() => { store.db.prepare("DELETE FROM events WHERE kind='filler'").run(); });
    store.checkpointWal();
    const start = store.storeFacts();
    assert.ok(start.freePages > 32, `the deletion left free pages (${start.freePages})`);
    assert.equal(statSync(path).size, start.fileBytes);

    // A bounded pass: at most the pages asked for, in one short turn.
    const firstPass = store.reclaimFreedPages({ maxPages: 8 });
    assert.equal(firstPass.error, null);
    assert.ok(firstPass.pages > 0 && firstPass.pages <= 8, `bounded to the pages asked for (${firstPass.pages})`);
    assert.ok(firstPass.durationMs >= 0);
    assert.ok(store.storeFacts().freePages < start.freePages);

    // Draining the rest returns the file towards its live size.
    for (let pass = 0; pass < 64 && store.storeFacts().freePages > 0; pass++) store.reclaimFreedPages({ maxPages: 64 });
    const end = store.storeFacts();
    assert.equal(end.freePages, 0);
    assert.ok(end.fileBytes < start.fileBytes, `the file shrank: ${start.fileBytes} -> ${end.fileBytes}`);
    assert.ok(end.walBytes <= JOURNAL_SIZE_LIMIT_BYTES, 'the WAL is inside its bound');
    // The last bounded pass leaves one small durable record, never a ledger.
    const record = store.getMeta<{ pages: number; freePagesAfter: number }>(STORE_MAINTENANCE_META_KEY);
    assert.ok(record && record.pages > 0);
    assert.equal(record.freePagesAfter, 0);
    // Nothing to reclaim writes nothing.
    const before = JSON.stringify(store.getMeta(STORE_MAINTENANCE_META_KEY));
    const idle = store.reclaimFreedPages();
    assert.equal(idle.pages, 0);
    assert.equal(idle.skipped, 'no free pages');
    assert.equal(JSON.stringify(store.getMeta(STORE_MAINTENANCE_META_KEY)), before);
  } finally { store.close(); }
});

test('the service converts a pre-change store at start, before it serves, and reports the record', async t => {
  const { path, store, taskId } = legacyStore(t);
  const dir = dirname(path);
  const before = publicState(store, [taskId]);
  store.close();
  // The fixture supplies the recovery route; the store, the window, the pragmas and the
  // verification are the production path.
  const snapshotPath = join(dir, 'fixture-snapshot.sqlite');
  const runtime = new QueueRuntime({ dataDir: dir, timers: false, connectTimeoutMs: 200,
    storeCompaction: { snapshot: async source => {
      // A real consistent copy through the supported route's own checkpoint, kept in the
      // fixture directory: the conversion's recovery point.
      copyFileSync(source, snapshotPath);
      return { name: 'fixture.hourly.sqlite.gz', bytes: statSync(snapshotPath).size };
    } } });
  try {
    await runtime.started;
    const health = runtime.health();
    assert.equal(health.storeCompaction?.autoVacuum, AUTO_VACUUM_INCREMENTAL);
    assert.equal(health.storeCompaction?.state, 'converted');
    assert.equal(health.storeCompaction?.attempts, 1);
    assert.equal(health.storeCompaction?.verification, 'verified');
    assert.equal(health.storeCompaction?.settledFrom, null);
    assert.equal(runtime.store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
    assert.deepEqual(publicState(runtime.store, [taskId]), before);
  } finally { await runtime.stop(); }
});

test('the service start settles an unknown outcome that already landed, without a rewrite', async t => {
  const { path, store, taskId } = legacyStore(t);
  const dir = dirname(path);
  // A store already converted by an earlier attempt whose process died before it could record
  // the outcome: exactly the restart the acceptance oracle names. The planted record is the
  // only state a crash can leave behind, and the service's own start path must settle it.
  await new StoreCompactor(store, deps(path)).run('service-start');
  assert.equal(store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
  const converted = store.storeFacts();
  store.setMeta(STORE_COMPACTION_META_KEY, storeCompactionRecordSchema.parse({
    version: 1, state: 'running', trigger: 'service-start', attempts: 1, at: '2026-10-25T00:40:00.000Z',
    startedAt: '2026-10-25T00:40:00.000Z', finishedAt: null, before: converted, after: null,
    requiredFreeBytes: 1, freeBytes: 1, estimatedBlockedMs: 1, blockedMs: null, snapshot: 'landed.sqlite.gz', fingerprint: null, reason: null,
  }));
  const publicBefore = publicState(store, [taskId]);
  store.close();
  let snapshots = 0;
  const runtime = new QueueRuntime({ dataDir: dir, timers: false, connectTimeoutMs: 200,
    storeCompaction: { snapshot: async () => { snapshots++; throw new Error('a settled rewrite must take no snapshot'); } } });
  try {
    await runtime.started;
    const record = runtime.compaction.record();
    assert.equal(record?.state, 'landed', 'the service start settles the mode as a landed rewrite, not a verified one');
    assert.equal(record?.attempts, 1, 'the interrupted attempt keeps its number');
    assert.equal(record?.settledFrom, 'running');
    assert.match(String(record?.reason), /preservation was never verified/);
    assert.equal(snapshots, 0, 'settling a landed rewrite takes no snapshot');
    assert.equal(runtime.store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
    assert.deepEqual(publicState(runtime.store, [taskId]), publicBefore);
    assert.equal(runtime.health().storeCompaction?.state, 'landed');
    assert.equal(runtime.health().storeCompaction?.verification, 'not-run');
  } finally { await runtime.stop(); }
});

test('a timerless fixture is not converted at start unless it opts in', async t => {
  const { path, store, taskId } = legacyStore(t);
  const dir = dirname(path);
  store.close();
  const runtime = new QueueRuntime({ dataDir: dir, timers: false, connectTimeoutMs: 200 });
  try {
    await runtime.started;
    assert.equal(runtime.store.autoVacuumMode(), 0, 'no test rewrites a store it did not ask to rewrite');
    assert.equal(runtime.health().storeCompaction?.state, null);
    assert.equal(runtime.store.task(taskId).reason, 'holds must survive the rewrite');
  } finally { await runtime.stop(); }
});

test('the blocked-interval estimate and the required space are stated in the record before the touch', async t => {
  const { path, store } = legacyStore(t);
  try {
    const facts: StoreFacts = store.storeFacts();
    assert.ok(estimatedBlockedMs(facts) > 0);
    assert.ok(estimatedBlockedMs({ fileBytes: facts.fileBytes * 2 }) > estimatedBlockedMs(facts), 'the estimate grows with the file');
    // The live store's measured size must fit the stated bound, or the audit's own store
    // would be refused for ever.
    assert.ok(estimatedBlockedMs({ fileBytes: 1_049_186_304 }) <= COMPACTION_MAX_BLOCKED_MS, 'the live store size fits the bound');
    assert.equal(requiredFreeBytes(facts, 1024), facts.fileBytes * 2 + facts.walBytes + 1024 + 256 * 1024 * 1024);
    assert.ok(freeBytesOn(path) > 0);
    const record = readCompactionRecord(store);
    assert.equal(record, null, 'an untouched store has no record');
    // The estimate includes the canonical content verification's two passes, not only the
    // rewrite: the brief's bound has to cover what the window will actually do.
    assert.ok(COMPACTION_VERIFY_BYTES_PER_MS > 0);
    const rewriteOnly = Math.ceil(facts.fileBytes / (24 * 1024 * 1024 / 1000)) + 5_000;
    assert.ok(estimatedBlockedMs(facts) > rewriteOnly, 'the verification and checks are inside the estimate');
    // The maintenance admission the roll waits for covers the whole 120 s window plus the
    // snapshot and start-up phases around it.
    assert.ok(MAINTENANCE_READINESS_CAP_MS >= COMPACTION_MAX_BLOCKED_MS, 'the roll waits out a full window');
    assert.ok(MAINTENANCE_READINESS_CAP_MS - COMPACTION_MAX_BLOCKED_MS >= 30_000, 'with room for the snapshot before it');
  } finally { store.close(); }
});

/** One store with retained outcome, hook and host-run records. */
function recordedStore(t: { after: (fn: () => void) => void }) {
  const fixture = legacyStore(t);
  const { store, taskId } = fixture;
  store.db.prepare('INSERT INTO host_run_journal(run_id,event,at,data) VALUES(?,?,?,?)')
    .run('run-010', 'output', '2026-10-25T20:00:00.000Z', JSON.stringify({ line: 'contract-010 journal line' }));
  store.db.prepare('INSERT INTO hook_events(id,taskId,eventKey,eventId,data) VALUES(?,?,?,?,?)')
    .run('hook-1', taskId, 'task.closeout', 'event-1', JSON.stringify({ evidenced: true }));
  const outcome = store.putOutcome(outcomeSchema.parse({
    taskId, submissionId: 'sub-1', title: 'a searchable outcome title', repository: repo,
    outcome: 'done', replacementTaskId: null, reason: 'the reason the search reads', pr: null, mergeCommit: null,
    syncedCommit: null, review: { status: 'ready_to_merge', summary: 'accepted', commentId: null }, validation: null,
    closeout: { authority: 'queue', commit: null },
    brief: { digest: `sha256:${'c'.repeat(64)}`, mediaType: 'text/markdown', text: 'a brief the index holds', source: 'queue', version: 1, earlierDigests: [] },
    workers: [], reviewers: [], startedAt: '2026-10-25T19:00:00.000Z', finishedAt: '2026-10-25T20:00:00.000Z',
    backfilled: false, lanes: [],
  }));
  store.checkpointWal();
  return { ...fixture, outcome };
}

test('the window refuses a competing writer before and during the rewrite, in this process and another', async t => {
  const { path, store } = legacyStore(t);
  const fingerprint = store.contentFingerprint().digest;
  const attempts: Array<{ phase: string; refused: boolean }> = [];
  try {
    const run = await new StoreCompactor(store, deps(path, {
      // Inside the window, after the exclusive lock is taken, a second connection must be
      // refused. This is the instrumented commit barrier, not an inference from timestamps.
      duringWindow: competing => {
        const probe = new DatabaseSync(path);
        probe.exec('PRAGMA busy_timeout=0');
        let refused = false;
        try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); } catch { refused = true; }
        try { probe.prepare('SELECT COUNT(*) AS n FROM tasks').get(); } catch { refused = true; }
        probe.close();
        attempts.push({ phase: 'in-window', refused });
        assert.equal(competing(), true, 'the window\'s own probe is still refused');
      },
    })).run('test');
    assert.equal(run.record.state, 'converted');
    assert.deepEqual(attempts, [{ phase: 'in-window', refused: true }], 'a competing connection was refused inside the window');
    assert.equal(run.record.exclusion?.exclusive, true);
    assert.equal(run.record.exclusion?.probeBefore, true);
    assert.equal(run.record.exclusion?.probeAfter, true);
    assert.equal(run.record.exclusion?.journalMode, 'delete');
    assert.equal(store.contentFingerprint().digest, fingerprint);
  } finally { store.close(); }
});

test('a same-length change to a stored value fails preservation verification instead of passing it', async t => {
  const { path, store } = legacyStore(t);
  const before = store.getMeta('pool');
  try {
    const run = await new StoreCompactor(store, deps(path, { failConversion: 'same-length-change' })).run('test');
    assert.equal(run.record.state, 'landed');
    assert.equal(run.record.verification?.content, 'changed', 'the canonical digest sees a same-length edit');
    assert.match(String(run.record.reason), /logical content changed across the rewrite/);
    assert.doesNotMatch(String(run.record.reason), /openable and unchanged/);
    assert.notDeepEqual(store.getMeta('pool'), before, 'the changed value is still there: nothing was rolled back');
    // The cheap count-and-width digest the parent used cannot tell these apart, which is why
    // it is not what the conversion relies on.
    assert.equal(store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
  } finally { store.close(); }
});

test('FTS shadow pages may be rebuilt while the logical index and its rowid identity survive', async t => {
  const { path, store, outcome } = recordedStore(t);
  const logical = () => (store.db.prepare('SELECT rowid,title,brief,review,reason,taskId FROM outcomes_fts ORDER BY rowid').all() as Array<Record<string, unknown>>);
  const before = logical();
  const fingerprint = store.contentFingerprint().digest;
  try {
    const run = await new StoreCompactor(store, deps(path, { failConversion: 'fts-optimize' })).run('test');
    assert.equal(run.record.state, 'converted', 'the index\'s own representation is not a content change');
    assert.equal(run.record.verification?.content, 'verified');
    assert.deepEqual(logical(), before, 'every indexable value is the same');
    // The rowid identity the search joins and deletes by still holds.
    const joined = store.db.prepare('SELECT COUNT(*) AS n FROM outcomes_fts f JOIN outcomes o ON o.rowid=f.rowid').get() as { n: number };
    assert.equal(Number(joined.n), 1);
    assert.equal(store.contentFingerprint().digest, fingerprint);
    // The shadow tables are derived: the digest covers the virtual table's logical rows.
    assert.equal(store.contentFingerprint().rows > 0, true);
    assert.equal(store.outcome(outcome.taskId)?.title, 'a searchable outcome title');
    assert.equal(store.searchOutcomes({ text: 'searchable' }).results.length, 1);
  } finally { store.close(); }
});

test('the conversion carries outcome, hook, host-run and setting records exactly', async t => {
  const { path, store, taskId } = recordedStore(t);
  const content = store.contentFingerprint();
  const before = publicState(store, [taskId]);
  try {
    const run = await new StoreCompactor(store, deps(path)).run('test');
    assert.equal(run.record.state, 'converted');
    assert.equal(store.contentFingerprint().digest, content.digest, `every one of ${content.rows} rows survived`);
    assert.deepEqual(publicState(store, [taskId]), before);
    // Host-run journal, hook occurrence, outcome and its index.
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM host_run_journal').get() as { n: number }).n, 1);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM hook_events').get() as { n: number }).n, 1);
    assert.equal(store.getMeta('paused'), true, 'the operator pause is untouched');
    assert.equal(store.getMeta('globalLimit'), 3);
    assert.equal(store.getMeta('projectLimit'), 2);
    assert.equal((store.getMeta<Array<{ profile: string }>>('pool') ?? [])[0]?.profile, 'worker');
  } finally { store.close(); }
});

test('the store still takes writes after a landed migration, and no second rewrite is attempted', async t => {
  const { path, store, taskId } = legacyStore(t);
  try {
    const landed = await new StoreCompactor(store, deps(path, { failConversion: 'after-vacuum' })).run('test');
    assert.equal(landed.record.state, 'landed');
    const attempts = landed.record.attempts;
    // Ordinary work resumes on the incremental store.
    store.setMeta('paused', false);
    store.event(taskId, 'note', 'after a landed rewrite');
    assert.equal(store.eventsAll(taskId).some(event => event.detail === 'after a landed rewrite'), true);
    // A later start settles the same record and never rewrites: the store is already incremental.
    const settled = await new StoreCompactor(store, deps(path)).run('service-start');
    assert.equal(settled.converted, false);
    assert.equal(settled.record.state, 'landed');
    assert.equal(settled.record.attempts, attempts, 'no attempt is spent and none is added');
    assert.equal(compactionDue(store), false, 'a landed record is final');
    assert.equal(store.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
  } finally { store.close(); }
});

test('a store left in rollback-journal mode by a dead window reopens and converts normally', async t => {
  const { path, store, taskId } = legacyStore(t);
  const content = store.contentFingerprint().digest;
  // The on-disk state a process killed inside the window leaves: the store is in the
  // rollback journal the window switched to, with no connection holding it any more.
  store.db.exec('PRAGMA journal_mode=DELETE');
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(String((reopened.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode), 'wal',
      'every open restores the journal mode this build and its readers expect');
    assert.equal(reopened.autoVacuumMode(), 0, 'the rewrite never ran, so the mode is untouched');
    assert.equal(reopened.contentFingerprint().digest, content, 'no row moved');
    assert.equal(reopened.task(taskId).reason, 'holds must survive the rewrite');
    const run = await new StoreCompactor(reopened, deps(path)).run('service-start');
    assert.equal(run.record.state, 'converted');
    assert.equal(run.record.exclusion?.journalMode, 'delete');
    assert.equal(reopened.autoVacuumMode(), AUTO_VACUUM_INCREMENTAL);
  } finally { reopened.close(); }
});
