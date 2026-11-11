import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { Store, type StoreFacts } from '../core/store/store';
import {
  COMPACTION_MAX_BLOCKED_MS, COMPACTION_VERIFY_BYTES_PER_MS, StoreCompactor, estimatedBlockedMs, freeBytesOn,
  requiredFreeBytes,
} from '../core/store/store-compaction';
import { backupCommand } from '../core/store/backups';
import { timingTest } from './support/timing';

/**
 * Spec 028 revision "Store compaction" (audit B9; Tom's 2026-10-25 "Shrink the DB
 * file" ruling a1a817c3): the measured before/after of the one-shot conversion and
 * of the bounded reclamation that follows a prune.
 *
 * The workload is an isolated store shaped like the audit's reported populations
 * (from the 2026-10-25 performance audit, baseline main d5e20937): a large retained
 * task/history population, a 541-version lead ledger, ~2,400 notices, ~11,000
 * operations, ~6,800 outcomes, ~20,000 hook occurrences, a host-run journal and
 * closed shadow-stream segments. It is built in a fresh temporary directory and
 * deleted afterwards: no live database, snapshot, credential, profile, pause state
 * or process is read or written.
 *
 * It is a serial wall-clock oracle (the timing lane): the file sizes, the write
 * rate the blocked interval is estimated from, RSS and the durations are host
 * measurements, so they run alone rather than under the parallel suite's fixtures.
 * It prints its receipt as one JSON line (`NS_BENCH_RECEIPT ...`), and the committed
 * receipt in `evidence/store-compaction-20261025.json` is that output.
 */

const round = (value: number) => Math.round(value * 100) / 100;
const mb = (bytes: number) => round(bytes / (1024 * 1024));
const rssMb = () => mb(process.memoryUsage().rss);
const fileBytes = (path: string) => { try { return statSync(path).size; } catch { return 0; } };

/** Audit-shaped populations; the brief's "logical deletion vs file shrink" is measured on these. */
const population = {
  tasks: 900, events: 12_000, leads: 5_895, ledgerVersions: 541, notices: 2_400, operations: 11_000,
  outcomes: 6_792, hookOccurrences: 10_679, journalRows: 20_000,
};

function buildAuditStore(path: string) {
  const store = new Store(path);
  // The pre-change file: the store the audit measured says auto_vacuum=0.
  store.db.exec('PRAGMA auto_vacuum=NONE');
  store.db.exec('VACUUM');
  assert.equal(store.autoVacuumMode(), 0);
  const stamp = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString();
  // Row bodies are hex text, not repeated seeds: real JSON store rows compress about 4:1
  // (1.05 GB -> 264 MB in the live backups), so a repeated payload would make the snapshot
  // and therefore the measured space requirement unrealistically small.
  const row = (size: number, seed: string) => JSON.stringify({ seed, at: '2026-10-01T00:00:00.000Z',
    body: randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size) });
  const tx = store.transaction.bind(store);

  // Task rows at the audit's width (about 10 KB each), then their history.
  tx(() => {
    const insert = store.db.prepare('INSERT INTO tasks(id,submission,input_hash,data) VALUES(?,?,?,?)');
    for (let i = 0; i < population.tasks; i++)
      insert.run(`task-${i}`, `submission-${i}`, `hash-${i}`, row(10_000, `task${i}\n`));
    const event = store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)');
    for (let i = 0; i < population.events; i++) event.run(`task-${i % population.tasks}`, stamp(i), 'audit', row(300, 'event'));
  });
  // Leads and one long ledger, as the audit reported (272 open, one 541-version history).
  tx(() => {
    const lead = store.db.prepare('INSERT INTO leads(id,state,content_key,data) VALUES(?,?,?,?)');
    for (let i = 0; i < population.leads; i++) lead.run(`lead-${i}`, i < 272 ? 'open' : 'promoted', `content-${i}`, row(2_000, `lead${i}\n`));
  });
  // The history table holds the ledger's older versions as full documents.
  tx(() => {
    const version = store.db.prepare('INSERT INTO lead_versions(leadId,version,data) VALUES(?,?,?)');
    for (let i = 0; i < population.ledgerVersions; i++) version.run('lead-0', i + 1, row(8_000, `ledger${i}\n`));
    const notice = store.db.prepare('INSERT INTO notices(id,taskId,data) VALUES(?,?,?)');
    for (let i = 0; i < population.notices; i++) notice.run(`notice-${i}`, `task-${i % population.tasks}`, row(1_000, 'notice'));
    const operation = store.db.prepare('INSERT INTO operations(id,key,kind,inputHash,state,createdAt,payload,data) VALUES(?,?,?,?,?,?,?,?)');
    for (let i = 0; i < population.operations; i++) operation.run(`op-${i}`, `key-${i}`, 'audit', `hash-${i}`, 'settled', stamp(i), '{}', row(2_000, 'operation'));
  });
  tx(() => {
    const outcome = store.db.prepare('INSERT INTO outcomes(taskId,submissionId,data) VALUES(?,?,?)');
    for (let i = 0; i < population.outcomes; i++) outcome.run(`task-${i}`, `submission-${i}`, row(1_500, 'outcome'));
    const hook = store.db.prepare('INSERT INTO hook_events(id,taskId,eventKey,eventId,data) VALUES(?,?,?,?,?)');
    for (let i = 0; i < population.hookOccurrences; i++) hook.run(`hook-${i}`, `task-${i % population.tasks}`, 'task.closeout', `event-${i}`, row(4_000, 'hook'));
  });
  // The retained host-run journal and closed hook occurrences are the pruning population.
  tx(() => {
    const journal = store.db.prepare('INSERT INTO host_run_journal(run_id,event,at,data) VALUES(?,?,?,?)');
    for (let i = 0; i < population.journalRows; i++) journal.run(String(1 + (i % 500)), 'output', stamp(i), row(4_000, 'journal'));
  });
  store.checkpointWal();
  store.setMeta('paused', true);
  store.setMeta('globalLimit', 4);
  store.setMeta('projectLimit', 2);
  return store;
}

/** The audit's hourly prune: settled history past its four-day retention. */
function pruneHistory(store: Store) {
  const before = store.storeFacts();
  store.transaction(() => {
    store.db.prepare("DELETE FROM host_run_journal WHERE id IN (SELECT id FROM host_run_journal WHERE event='output' ORDER BY id DESC LIMIT 8000)").run();
    store.db.prepare("DELETE FROM hook_events WHERE rowid IN (SELECT rowid FROM hook_events WHERE eventKey='task.closeout' ORDER BY rowid DESC LIMIT 4000)").run();
  });
  store.checkpointWal();
  return { before, after: store.storeFacts() };
}

const RUNS = 3;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

timingTest('store compaction: the one-shot conversion and the bounded reclamation, measured', { timeout: 540_000 }, async t => {
  const receipt: Record<string, unknown> = {
    kind: 'queue.store-compaction-bench', at: new Date().toISOString(), task: 440,
    audit: 'Queue performance audit 2026-10-25 (baseline main d5e20937), item B9 "Shrink the DB file"',
    population,
    runs: RUNS,
    method: 'Each run builds one isolated store in its own fresh temporary directory, to the audit populations; the pre-change file says auto_vacuum=0 and its pruned history is deleted before any measurement. One conversion per store, because the conversion is one-shot: the runs are independent stores, not repeats on one file. Bytes are file sizes after wal_checkpoint(TRUNCATE); the blocked interval is the synchronous window measured inside the conversion (including the rollback-journal gate, the retained exclusive lock, the probes, both integrity checks and both canonical content passes); the estimate is what the code compared to its 120 s bound before touching the file. The snapshot is the production backup.now route on the same fixture, so its size and time are part of the measured recovery step. The verification timings are the same Store.contentFingerprint passes the window runs, measured around the conversion. The page cache is warm from the build and the prune; nothing else runs in this lane.',
    environment: { node: process.version, cpu: cpus()[0]?.model, cpus: cpus().length, totalMemGiB: round(totalmem() / (1024 ** 3)), loadavg: loadavg().map(round) },
  };
  const runs: Array<Record<string, number>> = [];
  for (let run = 0; run < RUNS; run++) {
    const dir = mkdtempSync(join(tmpdir(), 'ns-compact-bench-'));
    const path = join(dir, 'queue.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const startRss = rssMb();
    const store = buildAuditStore(path);
    const built = store.storeFacts();
    const pruned = pruneHistory(store);
    const before = pruned.after;
    // Logical deletion, not a file shrink: the rows are gone and the pages are free, but the
    // file keeps its high-water mark because the store is not incremental.
    const reclaimOnLegacy = store.reclaimFreedPages({ maxPages: 65_536 });
    assert.equal(reclaimOnLegacy.pages, 0);
    assert.match(String(reclaimOnLegacy.skipped), /not in incremental auto-vacuum/);
    assert.equal(store.storeFacts().fileBytes, before.fileBytes);
    assert.ok(before.freePages > 0);

    const estimate = estimatedBlockedMs(before);
    const required = requiredFreeBytes(before, 0);
    const free = freeBytesOn(path);
    assert.ok(free > required, `the bench store has room for the rewrite (${free} > ${required})`);
    let snapshotBytes = 0;
    // The canonical content verification the window runs, measured the way the window does:
    // one pass before the rewrite and one after it, over every authoritative logical row.
    const verificationBeforeStarted = performance.now();
    const contentBefore = store.contentFingerprint();
    const verificationBeforeMs = Math.round(performance.now() - verificationBeforeStarted);
    const compactor = new StoreCompactor(store, {
      snapshot: async () => {
        const list = await backupCommand('now', path, join(dir, 'backups'), undefined);
        const snapshot = list.snapshots.filter(entry => entry.verified)[0];
        assert.ok(snapshot, `the verified snapshot succeeded: ${JSON.stringify(list.localError)}`);
        snapshotBytes = snapshot.size;
        return { name: snapshot.name, bytes: snapshot.size };
      },
      freeBytes: () => freeBytesOn(path),
      log: () => {},
    });
    const conversion = await compactor.run('bench');
    assert.equal(conversion.record.state, 'converted', String(conversion.record.reason));
    assert.equal(conversion.converted, true);
    assert.equal(conversion.record.verification?.content, 'verified', 'the rows, not their width, were verified');
    assert.equal(conversion.record.exclusion?.exclusive, true);
    assert.equal(conversion.record.exclusion?.probeBefore, true);
    assert.equal(conversion.record.exclusion?.probeAfter, true);
    const after = store.storeFacts();
    const verificationAfterStarted = performance.now();
    const contentAfter = store.contentFingerprint();
    const verificationAfterMs = Math.round(performance.now() - verificationAfterStarted);
    assert.equal(contentAfter.digest, contentBefore.digest, `every one of ${contentBefore.rows} rows and every setting survived`);
    const verificationBytes = contentBefore.bytes + contentAfter.bytes;
    const verificationMs = verificationBeforeMs + verificationAfterMs;
    assert.equal((store.db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>).map(row => Object.values(row)[0]).join(';'), 'ok');
    const peakRss = rssMb();

    // Bounded maintenance after a later prune: the new deletions are returned in one pass.
    const secondPrune = pruneHistory(store);
    const growBefore = store.storeFacts();
    const reclaim = store.reclaimFreedPages({ maxPages: 4096 });
    assert.equal(reclaim.error, null);
    const drained = (() => { for (let pass = 0; pass < 256 && store.storeFacts().freePages > 0; pass++) store.reclaimFreedPages({ maxPages: 4096 }); return store.storeFacts(); })();

    runs.push({
      run: run + 1,
      builtBytes: built.fileBytes, builtPageCount: built.pageCount,
      prunedBytes: before.fileBytes, prunedFreePages: before.freePages,
      afterConversionBytes: after.fileBytes, afterConversionPages: after.pageCount,
      afterConversionFreePages: after.freePages,
      secondPruneBytes: growBefore.fileBytes, secondPruneFreePages: secondPrune.after.freePages,
      reclaimedPages: reclaim.pages, reclaimedBytes: drained.fileBytes, reclaimedFreePagesLeft: drained.freePages,
      walBytesBefore: before.walBytes, walBytesAfter: after.walBytes, snapshotBytes,
      estimatedBlockedMs: estimate, blockedMs: conversion.record.blockedMs ?? 0,
      verificationBeforeMs, verificationAfterMs, verificationMs,
      verificationRows: contentBefore.rows, verificationContentBytes: verificationBytes,
      verificationKiBPerMs: Math.round(verificationBytes / Math.max(1, verificationMs) / 1024),
      boundedReclaimMs: reclaim.durationMs, rssBeforeMb: startRss, rssAfterMb: peakRss,
      shrinkBytes: before.fileBytes - after.fileBytes,
      shrinkPercent: round(((before.fileBytes - after.fileBytes) / before.fileBytes) * 100),
      requiredFreeBytes: conversion.record.requiredFreeBytes ?? required, availableFreeBytes: free,
    });
    assert.ok(after.fileBytes < before.fileBytes, 'the conversion returned the pruned pages');
    assert.ok(drained.fileBytes < growBefore.fileBytes, 'bounded maintenance returned the later prune');
    assert.ok(estimate >= (conversion.record.blockedMs ?? 0), `the estimate (${estimate} ms) is above the measured window (${conversion.record.blockedMs} ms)`);
    assert.ok(estimate >= verificationMs, `the estimate covers the measured verification (${verificationMs} ms)`);
    store.close();
  }
  const column = (key: string) => runs.map(run => run[key]);
  receipt.details = runs;
  receipt.median = Object.fromEntries(['builtBytes', 'prunedBytes', 'prunedFreePages', 'afterConversionBytes', 'snapshotBytes',
    'estimatedBlockedMs', 'blockedMs', 'verificationBeforeMs', 'verificationAfterMs', 'verificationMs', 'verificationKiBPerMs',
    'boundedReclaimMs', 'rssBeforeMb', 'rssAfterMb', 'shrinkBytes', 'shrinkPercent', 'reclaimedPages']
    .map(key => [key, median(column(key))]));
  receipt.estimateVsMeasured = {
    note: 'The estimate is a floor from the code constant, deliberately above the measured window so a store too large for the bound is refused before it is touched; the live store measured 1.05 GB, whose estimate is stated below.',
    estimatedRateKiBPerMs: Math.round(median(column('prunedBytes')) / median(column('estimatedBlockedMs')) / 1024),
    measuredRateKiBPerMs: Math.round(median(column('prunedBytes')) / Math.max(1, median(column('blockedMs'))) / 1024),
    verificationFloorBytesPerMs: Math.round(COMPACTION_VERIFY_BYTES_PER_MS),
    verificationMeasuredKiBPerMs: median(column('verificationKiBPerMs')),
    verificationNote: 'The estimate counts one canonical content pass before the rewrite and one after it, at a floor three times below the slowest measured pass; the pass reads every authoritative logical row from SQLite, so its throughput is per stored content byte beside the file scan the rewrite pays.',
    liveStoreBytes: 1_049_186_304,
    liveStoreEstimatedMs: estimatedBlockedMs({ fileBytes: 1_049_186_304 }),
    liveStoreWithinBound: estimatedBlockedMs({ fileBytes: 1_049_186_304 }) <= COMPACTION_MAX_BLOCKED_MS,
  };
  console.log(`NS_BENCH_RECEIPT ${JSON.stringify(receipt)}`);
});
