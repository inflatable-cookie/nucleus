import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../core/store/store';
import { createBackup, listBackups, verifySnapshot } from '../core/store/backup-worker.mjs';

/**
 * Spec 028: a snapshot is compressed and verified as a stream. These prove the shape a
 * live snapshot must keep — bounded memory, a verified round trip, no published bad
 * restore point and no leaked working files — and reproduce the whole-file buffering the
 * streaming path replaced, so the memory claim is measured rather than asserted.
 */

const worker = new URL('../core/store/backup-cli.mjs', import.meta.url).pathname;
const rssWorker = new URL('./support/backup-rss.worker.mjs', import.meta.url).pathname;

function fixture(t: { after: (fn: () => void) => void }, filler?: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'queue-backup-stream-'));
  const dataDir = join(dir, 'queue');
  mkdirSync(dataDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dataDir, 'queue.sqlite');
  const backups = join(dataDir, 'backups');
  const store = new Store(path);
  if (filler) {
    store.db.exec('CREATE TABLE payload(value BLOB)');
    const insert = store.db.prepare('INSERT INTO payload VALUES(?)');
    store.transaction(() => { for (let i = 0; i < filler.length; i += 1_000_000) insert.run(filler.subarray(i, i + 1_000_000)); });
  }
  return { dataDir, dir, path, store, backups };
}

const snapshots = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.sqlite.gz'));
/** The scheduled snapshot itself; a daily or weekly entry is a hard link to it. */
const scheduled = (dir: string) => snapshots(dir).filter(name => name.includes('.hourly.'));
const workingFiles = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.sqlite') || name.includes('.tmp'));
const only = <T,>(values: T[], label: string): T => {
  assert.equal(values.length, 1, `${label}: ${values.join(', ')}`);
  return values[0]!;
};

test('Spec 028: a streamed snapshot is standard gzip that restores the verified bytes', async t => {
  const { backups, dir, dataDir, path, store } = fixture(t);
  store.db.exec("CREATE TABLE oracle(value TEXT); INSERT INTO oracle VALUES('before')");
  const result = await createBackup(path, backups);
  const file = join(backups, only(scheduled(backups), 'one published snapshot'));
  assert.equal(result.snapshots[0]?.verified, true);
  const compressed = readFileSync(file);
  assert.deepEqual([...compressed.subarray(0, 2)], [0x1f, 0x8b], 'the file is gzip, so the runbook gzip -dc and gunzipSync still read it');
  // The old decoder is the compatibility oracle: a restore written before this change
  // must read a snapshot written after it, byte for byte.
  assert.deepEqual(workingFiles(backups), [], 'the raw snapshot and the compression temp are gone');
  const raw = gunzipSync(compressed);
  const restored = join(dir, 'restored.sqlite');
  writeFileSync(restored, raw);
  const db = new DatabaseSync(restored, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(db.prepare('SELECT value FROM oracle').get()?.value, 'before');
  } finally { db.close(); }
  store.close();
});

test('Spec 028: reading a compressed snapshot back proves the digest of the verified bytes', async t => {
  const { backups, dataDir, path, store } = fixture(t);
  store.db.exec("CREATE TABLE oracle(value TEXT); INSERT INTO oracle VALUES('before')");
  await createBackup(path, backups);
  const raw = gunzipSync(readFileSync(join(backups, only(scheduled(backups), 'one published snapshot'))));
  const digest = (await import('node:crypto')).createHash('sha256').update(raw).digest('hex');
  assert.equal(await verifySnapshot(join(backups, scheduled(backups)[0]!), digest), digest);
  // A snapshot whose contents differ from the verified bytes is refused, not published.
  await assert.rejects(() => verifySnapshot(join(backups, scheduled(backups)[0]!), '0'.repeat(64)), /does not decompress to the verified bytes/);
  const truncated = join(backups, 'truncated.sqlite.gz');
  writeFileSync(truncated, readFileSync(join(backups, scheduled(backups)[0]!)).subarray(0, 4096));
  await assert.rejects(() => verifySnapshot(truncated, digest));
  rmSync(truncated);
  store.close();
});

for (const [fault, pattern] of [
  ['read', /injected snapshot read failure/],
  ['compress', /injected compressor failure/],
  ['diskFull', /injected disk full/],
  ['mismatch', /does not decompress to the verified bytes/],
] as const) {
  test(`Spec 028: a ${fault} failure publishes no snapshot and keeps the last verified one`, async t => {
    const { backups, dataDir, path, store } = fixture(t, randomBytes(4_000_000));
    store.db.exec("CREATE TABLE oracle(value TEXT); INSERT INTO oracle VALUES('before')");
    const published = await createBackup(path, backups, new Date(Date.UTC(2026, 0, 1, 6)).toISOString());
    const verified = only(published.snapshots.filter(entry => entry.kind === 'hourly'), 'the verified snapshot');
    assert.ok(published.snapshots.some(entry => entry.kind === 'weekly'), 'the daily and weekly links are published before the failure');
    await assert.rejects(() => createBackup(path, backups, new Date(Date.UTC(2026, 0, 1, 12)).toISOString(), { fault }), pattern);
    const result = listBackups(backups, dataDir);
    assert.deepEqual(result.snapshots, published.snapshots, 'the failed run published nothing, rotated nothing and copied nothing');
    assert.equal(scheduled(backups).length, 1);
    assert.equal(scheduled(backups)[0], verified.name, 'the last verified snapshot is still the newest one');
    assert.match(result.localError ?? '', pattern, 'the failure is visible in the listing');
    assert.deepEqual(workingFiles(backups), [], 'no raw snapshot, compression temp or partial file is left behind');
    store.close();
  });
}

test('Spec 028: an interrupted snapshot publishes nothing and the next run clears its working files', async t => {
  const { backups, path, store } = fixture(t, randomBytes(64_000_000));
  store.db.exec("CREATE TABLE oracle(value TEXT); INSERT INTO oracle VALUES('before')");
  const first = await createBackup(path, backups, new Date(Date.UTC(2026, 0, 1, 6)).toISOString());
  const verified = only(first.snapshots.filter(entry => entry.kind === 'hourly'), 'the verified snapshot');
  // A real interruption: the worker is killed while it compresses, so no cleanup runs.
  const child = spawn(process.execPath, [worker, 'migration', path, backups], { stdio: 'ignore' });
  const deadline = Date.now() + 60_000;
  let interrupted = false;
  while (Date.now() < deadline && child.exitCode === null) {
    if (readdirSync(backups).some(name => name.endsWith('.sqlite.gz.tmp'))) { interrupted = true; child.kill('SIGKILL'); break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => child.once('exit', resolve));
  assert.ok(interrupted, 'the worker reached compression before it was killed');
  assert.equal(scheduled(backups).length, 1, 'the killed run never renamed its temp file into a snapshot');
  assert.equal(scheduled(backups)[0], verified.name);
  assert.ok(workingFiles(backups).length > 0, 'the killed run left its working files behind, as a kill does');
  // The next snapshot clears them and publishes its own verified file.
  const next = await createBackup(path, backups, new Date(Date.UTC(2026, 0, 1, 12)).toISOString());
  assert.equal(next.snapshots.filter(entry => entry.kind === 'hourly').length, 2);
  assert.deepEqual(workingFiles(backups), [], 'the interrupted working files are cleared');
  assert.ok(scheduled(backups).includes(verified.name), 'the interrupted run removed no verified snapshot');
  store.close();
});

test('Spec 028: a snapshot is streamed, so its process never holds the whole store (parent falsification)', async t => {
  // Whole-file buffering costs the raw copy plus the compressed result, so its peak grows
  // with the store. A stream holds one chunk, so its peak must not. Both numbers are one
  // process's own peak RSS, and the buffered shape is the code this task replaced.
  const snapshot = (mode: 'stream' | 'buffer', storeBytes: number) => new Promise<number>((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), `queue-backup-rss-${mode}-`));
    const payload = randomBytes(storeBytes);
    const store = new Store(join(dir, 'queue.sqlite'), join(dir, 'backups'));
    store.db.exec('CREATE TABLE payload(value BLOB)');
    const insert = store.db.prepare('INSERT INTO payload VALUES(?)');
    store.transaction(() => { for (let i = 0; i < payload.length; i += 1_000_000) insert.run(payload.subarray(i, i + 1_000_000)); });
    store.close();
    execFile(process.execPath, [rssWorker, mode, join(dir, 'queue.sqlite'), join(dir, 'backups')], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      rmSync(dir, { recursive: true, force: true });
      if (error) return reject(error);
      const measured = JSON.parse(stdout) as { baseline: number; peak: number };
      resolve(measured.peak - measured.baseline);
    });
  });
  const [streamSmall, streamLarge, bufferedSmall, bufferedLarge] = [
    await snapshot('stream', 16_000_000), await snapshot('stream', 64_000_000),
    await snapshot('buffer', 16_000_000), await snapshot('buffer', 64_000_000),
  ];
  const growth = (label: string, value: number) => `${label} grew ${Math.round(value / 1024)} MB`;
  void t;
  // Four times the store: buffering grows with it (about 3.5x here), a stream does not.
  assert.ok(bufferedLarge >= bufferedSmall * 2.5, `${growth('whole-file buffering at 16 MB', bufferedSmall)} and ${growth('at 64 MB', bufferedLarge)}: buffering is not proportional to the store`);
  assert.ok(streamLarge <= streamSmall * 2, `${growth('streaming at 16 MB', streamSmall)} and ${growth('at 64 MB', streamLarge)}: a streamed snapshot is not bounded`);
  // And at one size, the streamed snapshot costs a fraction of the buffered one.
  assert.ok(streamLarge <= bufferedLarge * 0.5, `${growth('the streamed snapshot', streamLarge)} against ${growth('the buffered snapshot', bufferedLarge)}`);
});
