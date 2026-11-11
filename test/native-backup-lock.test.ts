import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('a WAL writer can commit after the initial transaction, and VACUUM snapshots the admitted connection', t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-native-snapshot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'queue.sqlite'), snapshot = join(dir, 'snapshot.sqlite');
  const owner = new DatabaseSync(path), other = new DatabaseSync(path);
  try {
    owner.exec("PRAGMA journal_mode=WAL; CREATE TABLE data(value TEXT); INSERT INTO data VALUES('admitted')");
    owner.exec('BEGIN IMMEDIATE; PRAGMA locking_mode=EXCLUSIVE; COMMIT');
    other.exec("INSERT INTO data VALUES('changed')");
    owner.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    const copy = new DatabaseSync(snapshot, { readOnly: true });
    try { assert.deepEqual(copy.prepare('SELECT value FROM data ORDER BY rowid').all().map(row => row.value), ['admitted', 'changed']); }
    finally { copy.close(); }
  } finally { other.close(); owner.close(); }
});

test('VACUUM snapshot retains the order of legacy text-keyed rows', t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-native-order-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'queue.sqlite'), snapshot = join(dir, 'snapshot.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE legacy(id TEXT PRIMARY KEY,data TEXT); INSERT INTO legacy VALUES('a','one'),('b','two'),('c','three'); DELETE FROM legacy WHERE id='b'");
    const before = db.prepare('SELECT rowid AS source_rowid,id,data FROM legacy ORDER BY rowid').all();
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    const copy = new DatabaseSync(snapshot, { readOnly: true });
    try { assert.deepEqual(copy.prepare('SELECT rowid AS source_rowid,id,data FROM legacy ORDER BY rowid').all(), before); }
    finally { copy.close(); }
  } finally { db.close(); }
});
