import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { CURRENT_SCHEMA, Store } from '../core/store/store';
import { QueueRuntime } from '../service/runtime-owner';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'queue-schema-floor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'queue.sqlite') };
}
function versioned(path: string, schema: number) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES(\'original\')');
  db.prepare('INSERT INTO meta VALUES(?,?)').run('schema', JSON.stringify(schema)); db.close();
}
function retained(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { schema: db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value,
    value: db.prepare('SELECT value FROM retained').get()?.value }; } finally { db.close(); }
}

test('fresh store works and old or future stores refuse before application changes', t => {
  const { dir, path } = fixture(t);
  const fresh = new Store(path); assert.equal(fresh.getMeta('schema'), CURRENT_SCHEMA); assert.equal(fresh.autoVacuumMode(), 2); fresh.close();
  rmSync(path);
  for (const version of [1, 48, 49, CURRENT_SCHEMA + 1]) {
    versioned(path, version);
    const mode = statSync(path).mode;
    assert.throws(() => new Store(path), version < 50 ? /schema .*minimum supported version/ : /future database schema/);
    assert.deepEqual(retained(path), { schema: String(version), value: 'original' });
    assert.equal(statSync(path).mode, mode);
    assert.equal(readdirSync(dir).includes('backups'), false);
    rmSync(path);
  }
});

test('nonempty unversioned and corrupt stores and orphan sidecars refuse', t => {
  const { path } = fixture(t);
  const db = new DatabaseSync(path); db.exec('CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES(\'original\')'); db.close();
  assert.throws(() => new Store(path), /Unversioned or corrupt/);
  const check = new DatabaseSync(path, { readOnly: true }); assert.equal(check.prepare('SELECT value FROM retained').get()?.value, 'original'); check.close();
  rmSync(path); writeFileSync(path, 'not sqlite'); assert.throws(() => new Store(path));
  rmSync(path); writeFileSync(path + '-wal', 'orphan'); assert.throws(() => new Store(path), /sidecars/);
});

test('a source replaced after schema probing refuses before writes', t => {
  const { dir, path } = fixture(t); const other = join(dir, 'replacement.sqlite');
  const old = new Store(path); old.close(); versioned(other, 48);
  const probe = Store.storedSchema;
  Store.storedSchema = (name: string) => { const result = probe(name); renameSync(other, path); return result; };
  try { assert.throws(() => new Store(path), /changed during admission/); }
  finally { Store.storedSchema = probe; }
  assert.deepEqual(retained(path), { schema: '48', value: 'original' });
});

test('service refuses an old store without creating application settings', t => {
  const { dir, path } = fixture(t); versioned(path, 48);
  assert.throws(() => new QueueRuntime({ dataDir: dir, timers: false }), /schema 48.*minimum supported version/);
  assert.deepEqual(retained(path), { schema: '48', value: 'original' });
  assert.equal(readdirSync(dir).includes('settings.json'), false);
});

test('committed WAL schema wins over an older main database in both directions', t => {
  const { path, dir } = fixture(t);
  const initial = new Store(path); initial.close();
  const writer = new DatabaseSync(path);
  try {
    writer.exec('');
    writer.exec('PRAGMA journal_mode=WAL');
    writer.prepare("UPDATE meta SET value=? WHERE key='schema'").run('48');
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    writer.prepare("UPDATE meta SET value=? WHERE key='schema'").run('50');
    const opened = new Store(path, join(dir, 'backups'));
    assert.equal(opened.getMeta('schema'), CURRENT_SCHEMA); opened.close();
    writer.prepare("UPDATE meta SET value=? WHERE key='schema'").run('50');
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    writer.prepare("UPDATE meta SET value=? WHERE key='schema'").run('48');
    assert.throws(() => new Store(path, join(dir, 'backups')), /schema 48.*minimum supported version/);
    assert.equal(writer.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value, '48');
  } finally { writer.close(); }
});

test('a concurrent SQLite writer prevents writable admission', t => {
  const { path } = fixture(t); const initial = new Store(path); initial.close();
  const writer = new DatabaseSync(path); writer.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => new Store(path), /locked/); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
  const check = new Store(path); assert.equal(check.getMeta('schema'), CURRENT_SCHEMA); check.close();
});

test('the documented restore preflight refuses an old backup before moving the destination', t => {
  const { dir, path } = fixture(t);
  versioned(path, 48);
  const snapshot = join(dir, 'old.sqlite.gz');
  writeFileSync(snapshot, gzipSync(readFileSync(path)));
  const destination = join(dir, 'destination.sqlite');
  writeFileSync(destination, 'existing managed data');
  const runbook = readFileSync(join(process.cwd(), 'docs/knowledge/operations/restore.md'), 'utf8');
  const command = runbook.match(/```sh\n([\s\S]*?)```/)?.[1];
  assert.ok(command);
  const result = spawnSync('zsh', ['-c', `set -e\n${command}`], { env: { ...process.env, snapshot, TMPDIR: dir }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported or corrupt snapshot \(schema 48\)/);
  assert.equal(readFileSync(destination, 'utf8'), 'existing managed data');
});

test('source replacement after writable admission refuses before backup or application writes', t => {
  const { dir, path } = fixture(t), replacement = join(dir, 'replacement.sqlite'), original = join(dir, 'original.sqlite');
  const current = new Store(path);
  current.db.exec('');
  current.setMeta('schema', 50); current.close();
  versioned(replacement, 48);
  const backup = join(dir, 'backups');
  assert.throws(() => {
    const opened = new Store(path, backup, () => { renameSync(path, original); renameSync(replacement, path); });
    opened.close();
  }, /changed during admission/);
  assert.deepEqual(retained(path), { schema: '48', value: 'original' });
  assert.equal(readdirSync(dir).includes('backups'), false);
});

test('replacement after verified backup publication refuses migration and retains the admitted snapshot', t => {
  const { dir, path } = fixture(t), replacement = join(dir, 'replacement.sqlite'), original = join(dir, 'original.sqlite');
  const backup = join(dir, 'backups');
  const current = new Store(path);
  current.db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('admitted')");
  current.setMeta('schema', 50); current.close(); versioned(replacement, 48);
  const originalSpawn = childProcess.spawnSync; let replaced = false;
  Object.defineProperty(childProcess, 'spawnSync', { configurable: true, writable: true, value: (...args: Parameters<typeof childProcess.spawnSync>) => {
    const result = originalSpawn(...args);
    if (!replaced && Array.isArray(args[1]) && args[1].includes('migration-staged')) {
      replaced = true; renameSync(path, original); renameSync(replacement, path);
    }
    return result;
  } });
  syncBuiltinESMExports();
  try { assert.throws(() => new Store(path, backup), /changed during admission/); }
  finally { Object.defineProperty(childProcess, 'spawnSync', { configurable: true, writable: true, value: originalSpawn }); syncBuiltinESMExports(); }
  assert.ok(replaced);
  assert.deepEqual(retained(path), { schema: '48', value: 'original' });
  assert.deepEqual(retained(original), { schema: '50', value: 'admitted' });
  const hourly = readdirSync(backup).find(name => name.endsWith('.hourly.sqlite.gz'));
  assert.ok(hourly);
  const restored = join(dir, 'restored.sqlite');
  writeFileSync(restored, gunzipSync(readFileSync(join(backup, hourly))));
  assert.deepEqual(retained(restored), { schema: '50', value: 'admitted' });
});

test('replacement after an outage response leaves existing status and both stores unchanged', t => {
  const { dir, path } = fixture(t), replacement = join(dir, 'replacement.sqlite'), original = join(dir, 'original.sqlite');
  const current = new Store(path);
  current.db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('admitted')");
  current.setMeta('schema', 50); current.close(); versioned(replacement, 48);
  const status = join(dir, 'backup-status.json'); writeFileSync(status, '{"localError":"previous"}');
  const originalSpawn = childProcess.spawnSync; let replaced = false;
  Object.defineProperty(childProcess, 'spawnSync', { configurable: true, writable: true, value: (...args: Parameters<typeof childProcess.spawnSync>) => {
    if (!replaced && Array.isArray(args[1]) && args[1].includes('migration-staged')) {
      replaced = true; renameSync(path, original); renameSync(replacement, path);
      return { status: 2, stderr: 'Backup volume unavailable: fixture' };
    }
    return originalSpawn(...args);
  } });
  syncBuiltinESMExports();
  try { assert.throws(() => new Store(path, join(dir, 'backups')), /changed during admission/); }
  finally { Object.defineProperty(childProcess, 'spawnSync', { configurable: true, writable: true, value: originalSpawn }); syncBuiltinESMExports(); }
  assert.ok(replaced);
  assert.equal(readFileSync(status, 'utf8'), '{"localError":"previous"}');
  assert.deepEqual(retained(path), { schema: '48', value: 'original' });
  assert.deepEqual(retained(original), { schema: '50', value: 'admitted' });
});

test('a successful schema 50 upgrade records a backup volume outage', t => {
  const { dir, path } = fixture(t), current = new Store(path);
  current.db.exec('');
  current.setMeta('schema', 50); current.close();
  const originalSpawn = childProcess.spawnSync; let simulated = false;
  Object.defineProperty(childProcess, 'spawnSync', { configurable: true, writable: true, value: (...args: Parameters<typeof childProcess.spawnSync>) => {
    if (!simulated && Array.isArray(args[1]) && args[1].includes('migration-staged')) {
      simulated = true; return { status: 2, stderr: 'Backup volume unavailable: fixture' };
    }
    return originalSpawn(...args);
  } });
  syncBuiltinESMExports();
  try { const upgraded = new Store(path, join(dir, 'backups')); assert.equal(upgraded.getMeta('schema'), CURRENT_SCHEMA); upgraded.close(); }
  finally { Object.defineProperty(childProcess, 'spawnSync', { configurable: true, writable: true, value: originalSpawn }); syncBuiltinESMExports(); }
  assert.ok(simulated);
  assert.match(JSON.parse(readFileSync(join(dir, 'backup-status.json'), 'utf8')).localError, /Backup volume unavailable/);
});

test('a committed schema change after the first probe is rejected at writable admission', t => {
  const { dir, path } = fixture(t);
  const current = new Store(path); current.close();
  const beforeMode = statSync(path).mode;
  const probe = Store.storedSchema;
  Store.storedSchema = (name: string) => {
    const result = probe(name);
    const writer = new DatabaseSync(name);
    try { writer.prepare("UPDATE meta SET value='48' WHERE key='schema'").run(); writer.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
    finally { writer.close(); }
    return result;
  };
  try { assert.throws(() => new Store(path), /schema 48.*minimum supported version/); }
  finally { Store.storedSchema = probe; }
  const check = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(check.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value, '48'); }
  finally { check.close(); }
  assert.equal(statSync(path).mode, beforeMode);
  assert.equal(readdirSync(dir).includes('backups'), false);
});


test('a committed older WAL with missing shm refuses without application writes', async t => {
  const { dir, path } = fixture(t);
  const initial = new Store(path); initial.close();
  const program = `const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(process.argv[1]);
    d.exec("PRAGMA journal_mode=WAL; UPDATE meta SET value='50' WHERE key='schema'; PRAGMA wal_checkpoint(TRUNCATE); UPDATE meta SET value='48' WHERE key='schema'");
    process.send('ready'); process.stdin.resume(); process.stdin.on('end',()=>{d.close(); process.exit(0)});`;
  const child = spawn(process.execPath, ['--experimental-sqlite', '-e', program, path], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', code => reject(new Error(`writer exited early: ${code}`))); });
    unlinkSync(path + '-shm');
    const beforeMode = statSync(path).mode;
    assert.throws(() => new Store(path), /schema 48.*minimum supported version/);
    const reader = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(reader.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value, '48'); }
    finally { reader.close(); }
    assert.equal(statSync(path).mode, beforeMode);
    assert.equal(readdirSync(dir).includes('backups'), false);
  } finally {
    child.stdin?.end();
    await new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once('exit', () => resolve()));
  }
});


test('a supported version with missing required tables refuses before application changes', t => {
  const { dir, path } = fixture(t); versioned(path, CURRENT_SCHEMA);
  assert.throws(() => new Store(path), /Corrupt database schema .*required table missing/);
  assert.deepEqual(retained(path), { schema: String(CURRENT_SCHEMA), value: 'original' });
  assert.equal(readdirSync(dir).includes('backups'), false);
});


test('schema 50 receives missing additive tables without dropping retained records', t => {
  const { dir, path } = fixture(t); const store = new Store(path);
  store.db.exec('DROP TABLE host_run_output_failures');
  store.setMeta('schema', 50); store.close();
  const upgraded = new Store(path, join(dir, 'backups'));
  try { assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='host_run_output_failures'").get()); }
  finally { upgraded.close(); }
});

test('a replacement between identity recheck and backup must not create a managed backup', t => {
  const { dir, path } = fixture(t), replacement = join(dir, 'replacement.sqlite'), original = join(dir, 'original.sqlite');
  const current = new Store(path);
  current.db.exec('');
  current.setMeta('schema', 50); current.close(); versioned(replacement, 48);
  const originalStat = fs.statSync;
  let armed = false, replaced = false;
  const interceptedStat = ((name: Parameters<typeof fs.statSync>[0], ...args: any[]) => {
    const value = (originalStat as (...values: any[]) => any)(name, ...args);
    if (armed && name === path) {
      armed = false; replaced = true;
      renameSync(path, original); renameSync(replacement, path);
    }
    return value;
  }) as typeof fs.statSync;
  Object.defineProperty(fs, 'statSync', { value: interceptedStat, writable: true, configurable: true });
  syncBuiltinESMExports();
  try {
    assert.throws(() => new Store(path, join(dir, 'backups'), () => { armed = true; }), /changed during admission/);
    assert.ok(replaced, 'the replacement happened immediately after the identity sample');
    assert.deepEqual(retained(path), { schema: '48', value: 'original' });
    assert.equal(readdirSync(dir).includes('backups'), false, 'no managed backup may precede refusal');
  } finally { Object.defineProperty(fs, 'statSync', { value: originalStat, writable: true, configurable: true }); syncBuiltinESMExports(); }
});

test('a writer changing schema after native snapshot capture refuses before backup', t => {
  const { dir, path } = fixture(t), backupDir = join(dir, 'backups');
  const store = new Store(path);
  store.db.exec('');
  store.setMeta('schema', 50); store.close();
  const originalExec = DatabaseSync.prototype.exec;
  let changed = false;
  DatabaseSync.prototype.exec = function(sql: string) {
    const result = originalExec.call(this, sql);
    if (!changed && sql.startsWith('VACUUM INTO')) {
      changed = true;
      const writer = new DatabaseSync(path);
      try { writer.prepare("UPDATE meta SET value='48' WHERE key='schema'").run(); }
      finally { writer.close(); }
    }
    return result;
  };
  try { assert.throws(() => new Store(path, backupDir), /schema 48.*minimum supported version/); }
  finally { DatabaseSync.prototype.exec = originalExec; }
  assert.ok(changed);
  assert.equal(readdirSync(dir).includes('backups'), false);
  const raw = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(raw.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value, '48'); }
  finally { raw.close(); }
});

test('a writer changing content after native snapshot capture refuses before backup', t => {
  const { dir, path } = fixture(t), backupDir = join(dir, 'backups');
  const store = new Store(path);
  store.db.exec('');
  store.setMeta('schema', 50); store.setMeta('fixture-data', 'before'); store.close();
  const originalExec = DatabaseSync.prototype.exec;
  let changed = false;
  DatabaseSync.prototype.exec = function(sql: string) {
    const result = originalExec.call(this, sql);
    if (!changed && sql.startsWith('VACUUM INTO')) {
      changed = true;
      const writer = new DatabaseSync(path);
      try { writer.prepare("UPDATE meta SET value='\\\"after\\\"' WHERE key='fixture-data'").run(); }
      finally { writer.close(); }
    }
    return result;
  };
  try { assert.throws(() => new Store(path, backupDir), /snapshot content differs/); }
  finally { DatabaseSync.prototype.exec = originalExec; }
  assert.ok(changed);
  assert.equal(readdirSync(dir).includes('backups'), false);
});

test('replacement after snapshot validation is refused by the backup worker before publication', t => {
  const { dir, path } = fixture(t), backupDir = join(dir, 'backups'), replacement = join(dir, 'replacement.sqlite'), original = join(dir, 'original.sqlite');
  const store = new Store(path);
  store.db.exec('');
  store.setMeta('schema', 50); store.close(); versioned(replacement, 48);
  const storeClass = Store as unknown as { verifyMigrationSnapshot: (...args: any[]) => void };
  const originalVerify = storeClass.verifyMigrationSnapshot, originalStat = fs.statSync;
  let armed = false, replaced = false;
  storeClass.verifyMigrationSnapshot = (...args) => { originalVerify.apply(Store, args); armed = true; };
  const intercepted = ((name: Parameters<typeof fs.statSync>[0], ...args: any[]) => {
    const value = (originalStat as (...values: any[]) => any)(name, ...args);
    if (armed && name === path) { armed = false; replaced = true; renameSync(path, original); renameSync(replacement, path); }
    return value;
  }) as typeof fs.statSync;
  Object.defineProperty(fs, 'statSync', { value: intercepted, writable: true, configurable: true }); syncBuiltinESMExports();
  try {
    assert.throws(() => new Store(path, backupDir), /Database changed during admission/);
    assert.ok(replaced); assert.equal(readdirSync(dir).includes('backups'), false);
    assert.deepEqual(retained(path), { schema: '48', value: 'original' });
  } finally {
    storeClass.verifyMigrationSnapshot = originalVerify;
    Object.defineProperty(fs, 'statSync', { value: originalStat, writable: true, configurable: true }); syncBuiltinESMExports();
  }
});
