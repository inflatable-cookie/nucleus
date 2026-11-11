import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createBackup } from '../core/store/backup-worker.mjs';

test('source replacement at backup publication refuses before managed files are created', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-staged-publish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.sqlite'), old = join(dir, 'old.sqlite'), replacement = join(dir, 'replacement.sqlite');
  const stage = join(dir, 'stage.sqlite'), destination = join(dir, 'managed-backups'), volume = join(dir, 'volume');
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES('admitted')");
  db.exec(`VACUUM INTO '${stage.replaceAll("'", "''")}'`); db.close();
  const foreign = new DatabaseSync(replacement); foreign.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES('other')"); foreign.close();
  const fd = openSync(source, 'r'); let changed = false;
  try {
    const volumeStat = (name: string) => {
      if (!changed) { changed = true; renameSync(source, old); renameSync(replacement, source); }
      return { isDirectory: () => true, dev: name === volume ? 1 : 2 };
    };
    await assert.rejects(createBackup(stage, destination, new Date().toISOString(), {
      admittedSource: { path: source, fd }, volumeRoot: volume, volumeStat,
    }), /Database changed during admission/);
    assert.ok(changed);
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(join(dir, 'backup-status.json')), false);
    const read = new DatabaseSync(source, { readOnly: true });
    try { assert.equal(read.prepare('SELECT value FROM data').get()?.value, 'other'); }
    finally { read.close(); }
  } finally { closeSync(fd); }
});

test('late source replacement preserves all pre-existing managed state', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-staged-copy-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.sqlite'), old = join(dir, 'old.sqlite'), replacement = join(dir, 'replacement.sqlite');
  const stage = join(dir, 'stage.sqlite'), destination = join(dir, 'managed-backups');
  const db = new DatabaseSync(source); db.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES('admitted')");
  db.exec(`VACUUM INTO '${stage.replaceAll("'", "''")}'`); db.close();
  const foreign = new DatabaseSync(replacement); foreign.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES('other')"); foreign.close();
  mkdirSync(destination);
  const priorBackup = join(destination, '2020-01-01T00-00-00-000Z-aaaaaaaa.hourly.sqlite.gz');
  const interrupted = join(destination, '.unrelated.sqlite.gz.tmp');
  const status = join(dir, 'backup-status.json');
  writeFileSync(priorBackup, 'existing backup'); writeFileSync(interrupted, 'unrelated interrupted work');
  writeFileSync(status, '{"localError":"prior outage"}');
  const fd = openSync(source, 'r'), originalCopy = fs.copyFileSync; let changed = false;
  Object.defineProperty(fs, 'copyFileSync', { value: (...args: Parameters<typeof fs.copyFileSync>) => {
    if (!changed) { changed = true; renameSync(source, old); renameSync(replacement, source); }
    return originalCopy(...args);
  }, writable: true, configurable: true });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createBackup(stage, destination, new Date().toISOString(), { admittedSource: { path: source, fd } }), /Database changed during admission/);
    assert.ok(changed);
    assert.equal(readFileSync(priorBackup, 'utf8'), 'existing backup');
    assert.equal(readFileSync(interrupted, 'utf8'), 'unrelated interrupted work');
    assert.equal(readFileSync(status, 'utf8'), '{"localError":"prior outage"}');
    assert.deepEqual(readdirSync(destination).sort(), ['.unrelated.sqlite.gz.tmp', '2020-01-01T00-00-00-000Z-aaaaaaaa.hourly.sqlite.gz']);
    for (const [path, expected] of [[source, 'other'], [old, 'admitted']]) {
      const read = new DatabaseSync(path, { readOnly: true });
      try { assert.equal(read.prepare('SELECT value FROM data').get()?.value, expected); } finally { read.close(); }
    }
  } finally {
    Object.defineProperty(fs, 'copyFileSync', { value: originalCopy, writable: true, configurable: true }); syncBuiltinESMExports();
    closeSync(fd);
  }
});

test('source replacement during outage reporting preserves existing backup status', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-staged-outage-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.sqlite'), old = join(dir, 'old.sqlite'), replacement = join(dir, 'replacement.sqlite');
  const stage = join(dir, 'stage.sqlite'), destination = join(dir, 'managed-backups'), status = join(dir, 'backup-status.json');
  const db = new DatabaseSync(source); db.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES('admitted')");
  db.exec(`VACUUM INTO '${stage.replaceAll("'", "''")}'`); db.close();
  const foreign = new DatabaseSync(replacement); foreign.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES('other')"); foreign.close();
  writeFileSync(status, '{"localError":"previous"}');
  const fd = openSync(source, 'r'), originalRename = fs.renameSync; let changed = false, statusWritten = false;
  Object.defineProperty(fs, 'renameSync', { value: (...args: Parameters<typeof fs.renameSync>) => {
    if (args[1] === status) statusWritten = true;
    return originalRename(...args);
  }, writable: true, configurable: true });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createBackup(stage, destination, new Date().toISOString(), {
      admittedSource: { path: source, fd }, volumeRoot: join(dir, 'unavailable'), volumeStat: () => {
        changed = true; originalRename(source, old); originalRename(replacement, source); throw new Error('offline');
      },
    }));
    assert.ok(changed);
    assert.equal(statusWritten, false);
    assert.equal(readFileSync(status, 'utf8'), '{"localError":"previous"}');
  } finally {
    Object.defineProperty(fs, 'renameSync', { value: originalRename, writable: true, configurable: true }); syncBuiltinESMExports();
    closeSync(fd);
  }
});
