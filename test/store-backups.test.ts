import { getWorkRoot } from "../core/workspaces/work-root.mjs";
import { after as restoreEnvironmentAfterTests } from "node:test";
const previousWorkRoot = process.env.NUCLEUS_WORK_ROOT;
const previousWorkVolumeId = process.env.NUCLEUS_WORK_VOLUME_ID;
process.env.NUCLEUS_WORK_ROOT = "/fixture/work";
process.env.NUCLEUS_WORK_VOLUME_ID = "";
restoreEnvironmentAfterTests(() => {
  if (previousWorkRoot === undefined) delete process.env.NUCLEUS_WORK_ROOT;
  else process.env.NUCLEUS_WORK_ROOT = previousWorkRoot;
  if (previousWorkVolumeId === undefined) delete process.env.NUCLEUS_WORK_VOLUME_ID;
  else process.env.NUCLEUS_WORK_VOLUME_ID = previousWorkVolumeId;
});
import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA, Store } from '../core/store/store';
import { backupListSchema } from '../shared/contracts';
import { QueueRuntime } from '../service/runtime-owner';
import type { Adapter } from '../core/host';
import { backupBeforeMigration, backupCommand, backupDirForDataDir, backupHealth, liveBackupDir, newestScheduledSnapshotAt } from '../core/store/backups';
import { timingTest, performanceAssert } from './support/timing';
import { cpuSample } from './support/cpu-time';
// The child-process implementation is plain JavaScript so Node can run it without a TS loader.
import { assertBackupVolume, backupDirState, createBackup, listBackups, liveStorePath, readBackupStatus, volumeRootFor } from '../core/store/backup-worker.mjs';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'queue-backup-'));
  const dataDir = join(dir, 'queue');
  mkdirSync(dataDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dataDir, 'queue.sqlite');
  return { dir, dataDir, path, backups: join(dataDir, 'backups'), store: new Store(path) };
}
const local = (result: { snapshots: Array<{ kind: string; name: string; at: string; verified: boolean }> }, kind?: string) =>
  result.snapshots.filter(entry => !kind || entry.kind === kind);
/** A fixture standing in for the mounted external volume; `/tmp` names no volume, so no mount check applies. */
const fixtureVolume = (dir: string) => join(dir, 'external');
const copiesAt = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.sqlite.gz')).length;
const adapterFor = (dir: string) => ({ client: { isConnected: true }, hostId: 'fixture', socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'worker-helper.mjs'),
  connect: async () => {}, close: async () => {}, catalog: async () => ({ providers: [] }),
  observe: observeIdle('ws', 'worker') } as unknown as Adapter);

test('Spec 028 row 1: snapshot during committed store changes is consistent and verified', async t => {
  const { path, backups, store } = fixture(t);
  store.db.exec('CREATE TABLE backup_oracle(left_value INTEGER, right_value INTEGER)');
  store.db.prepare('INSERT INTO backup_oracle VALUES(0,0)').run();
  let value = 0;
  const timer = setInterval(() => store.transaction(() => {
    value++; store.db.prepare('UPDATE backup_oracle SET left_value=?,right_value=?').run(value, value);
  }), 1);
  try {
    const result = await backupCommand('now', path, backups);
    const file = join(backups, local(result, 'hourly')[0].name);
    const restored = join(path.replace('queue.sqlite', 'snapshot.sqlite'));
    writeFileSync(restored, gunzipSync(readFileSync(file)));
    const db = new DatabaseSync(restored, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      const row = db.prepare('SELECT * FROM backup_oracle').get();
      assert.equal(row?.left_value, row?.right_value);
    } finally { db.close(); }
  } finally { clearInterval(timer); store.close(); }
});

test('schema 50 migration backs up before dropping retired storage and null meta', t => {
  const { dataDir, path, backups, store } = fixture(t);
  store.db.exec(`CREATE TABLE brief_drafts(id TEXT PRIMARY KEY,status TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE shadow_stream(row INTEGER PRIMARY KEY, at TEXT);
    CREATE INDEX runs_identity_agent ON runs(json_extract(data,'$.agentId'),taskId);
    CREATE INDEX runs_identity_workspace ON runs(json_extract(data,'$.workspaceId'),taskId);
    INSERT INTO brief_drafts VALUES('retired','draft','{}');
    INSERT INTO shadow_stream VALUES(1,'2026-01-01');
    INSERT INTO meta VALUES('clear-me','null'),('threadArchiveProbe:old','null'),('shadowStream:file','2'),
      ('originNotificationTransfer:old','{}'),('capacityAuthorityFacts','{}'),('hostRunEnvFileRedaction','{}'),
      ('host_run_env_redaction','{}'),('legacyPapercutSourceEvidence','{}'),('legacyHostSelectionOperations','[1]');
    INSERT INTO meta VALUES('keep-me','"value"');`);
  store.db.prepare("UPDATE meta SET value='50' WHERE key='schema'").run();
  store.close();
  const migrated = new Store(path, backups);
  try {
    assert.equal(migrated.getMeta('schema'), CURRENT_SCHEMA);
    assert.equal(migrated.getMeta('keep-me'), 'value');
    assert.equal(migrated.getMeta('clear-me'), undefined, 'missing metadata still reads as undefined');
    assert.equal(migrated.getMeta('threadArchiveProbe:old'), undefined);
    assert.equal(migrated.getMeta('shadowStream:file'), undefined);
    assert.equal(migrated.getMeta('originNotificationTransfer:old'), undefined);
    assert.equal(migrated.getMeta('capacityAuthorityFacts'), undefined);
    assert.equal(migrated.getMeta('hostRunEnvFileRedaction'), undefined);
    assert.equal(migrated.getMeta('host_run_env_redaction'), undefined);
    assert.equal(migrated.getMeta('legacyPapercutSourceEvidence'), undefined);
    assert.equal(migrated.getMeta('legacyHostSelectionOperations'), undefined);
    assert.equal(migrated.getMeta('hostSelectionMigrationV1'), true);
    for (const name of ['brief_drafts', 'shadow_stream'])
      assert.equal(migrated.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?").get(name), undefined);
    for (const name of ['runs_identity_agent', 'runs_identity_workspace'])
      assert.equal(migrated.db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name=?").get(name), undefined);
    const snapshot = local(listBackups(backups, dataDir), 'hourly')[0];
    assert.ok(snapshot?.verified);
    const raw = join(dataDir, 'old.sqlite');
    writeFileSync(raw, gunzipSync(readFileSync(join(backups, snapshot.name))));
    const old = new DatabaseSync(raw, { readOnly: true });
    try {
      assert.equal(JSON.parse(String(old.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value)), 50);
      assert.ok(old.prepare("SELECT name FROM sqlite_schema WHERE name='brief_drafts'").get(), 'backup retains the source schema');
    } finally { old.close(); }
  } finally { migrated.close(); }
});

test('schema 49 is below the supported store floor', t => {
  const { path } = fixture(t);
  const store = new Store(path); store.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE meta SET value='49' WHERE key='schema'").run(); db.close();
  assert.throws(() => new Store(path), /Unsupported database schema 49; schema 50 is the minimum supported version/);
});

test('Spec 028 row 3: rotation keeps 24 hourly, 14 daily and 8 weekly inside the one backup directory', async t => {
  const { dataDir, path, backups, store } = fixture(t);
  for (let day = 0; day < 75; day++) await createBackup(path, backups, new Date(Date.UTC(2026, 0, 1 + day)).toISOString());
  const result = listBackups(backups, dataDir);
  assert.equal(local(result, 'hourly').length, 24);
  assert.equal(local(result, 'daily').length, 14);
  assert.equal(local(result, 'weekly').length, 8);
  assert.equal(result.snapshots.length, 46, 'no second location holds a copy');
  // Nothing else is in the protected directory, and the rotation wrote nothing beside it.
  assert.ok(readdirSync(backups).every(name => /\.(hourly|daily|weekly)\.sqlite\.gz$/.test(name)), `unexpected files: ${readdirSync(backups).join(', ')}`);
  assert.deepEqual(readdirSync(dataDir).filter(name => !/^queue\.sqlite(-wal|-shm)?$/.test(name)).sort(), ['backup-status.json', 'backups']);
  store.close();
});

test('nucleus#965: Back up now is listed as manual, on every tier of its file, and the record follows retention', async t => {
  const { dataDir, path, backups, store } = fixture(t);
  try {
    const manualAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
    await createBackup(path, backups, manualAt, { origin: 'manual' });
    await createBackup(path, backups, new Date(Date.UTC(2026, 0, 1, 6)).toISOString());
    let result = listBackups(backups, dataDir);
    assert.equal(result.dir, backups, 'the listing names its one backup directory');
    assert.deepEqual(result.retention, { hourly: 24, daily: 14, weekly: 8 }, 'the listing carries the rotation counts it enforces');
    assert.equal(backupListSchema.parse(result).dir, backups, 'the RPC contract accepts dir, retention and manual');
    const manual = result.snapshots.filter(entry => entry.manual);
    assert.deepEqual(manual.map(entry => entry.kind).sort(), ['daily', 'hourly', 'weekly'], 'the manual mark rides every tier linked to the file');
    assert.ok(manual.every(entry => entry.at === manualAt));
    assert.ok(result.snapshots.filter(entry => entry.at !== manualAt).every(entry => !entry.manual), 'a scheduled snapshot is not marked');
    // Through the CLI the operator route marks its snapshot too.
    const listed = await backupCommand('manual', path, backups);
    assert.equal(listed.snapshots.filter(entry => entry.manual && entry.kind === 'hourly').length, 2);
    // A recorded stem whose files rotation removed is forgotten on the next snapshot.
    const statusPath = join(dataDir, 'backup-status.json');
    const seeded = JSON.parse(readFileSync(statusPath, 'utf8'));
    writeFileSync(statusPath, JSON.stringify({ ...seeded, manual: [...seeded.manual, '2025-01-01T00-00-00-000Z-0000aaaa'] }));
    await createBackup(path, backups, new Date(Date.UTC(2026, 0, 2)).toISOString());
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(status.manual.length, 2, 'both live manual stems stay, the rotated one goes');
    const stems = new Set(readdirSync(backups).map(name => name.replace(/\.(hourly|daily|weekly)\.sqlite\.gz$/, '')));
    assert.ok(status.manual.every((item: string) => stems.has(item)), 'no recorded stem outlives its files');
  } finally { store.close(); }
});

test('Spec 028 row 4: failed integrity check is deleted and reported', async t => {
  const { dataDir, path, backups, store } = fixture(t);
  await assert.rejects(() => createBackup(path, backups, new Date().toISOString(), { failIntegrity: true }), /integrity_check/);
  const result = listBackups(backups, dataDir);
  assert.match(result.localError ?? '', /integrity_check/);
  assert.equal(result.snapshots.length, 0);
  assert.deepEqual(readdirSync(backups).filter(name => name.endsWith('.sqlite')), []);
  store.close();
});

test('Spec 028 row 5: an absent backup volume writes nothing, records the failure durably and a later run retries it', async t => {
  const { dir, dataDir, path, store } = fixture(t);
  store.close();
  const backups = join(fixtureVolume(dir), 'queue', 'backups');
  // The drive is away: the observation is the mounted volume's, an absent one.
  const absent = () => { throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' }); };
  const at = new Date(Date.UTC(2026, 0, 1, 6)).toISOString();
  await assert.rejects(() => createBackup(path, backups, at, { volumeRoot: fixtureVolume(dir), volumeStat: absent }), /Backup volume unavailable: .* is not mounted/);
  assert.equal(existsSync(fixtureVolume(dir)), false, 'the absent volume is not created as an ordinary directory');
  assert.equal(existsSync(backups), false);
  assert.equal(existsSync(join(dataDir, 'backups')), false, 'no snapshot or fallback copy is written to the internal disk');
  // The failure is durable beside the store, so a listing, the board and a later service
  // lifetime all read it, even though the backup directory does not exist.
  assert.match(readBackupStatus(dataDir).localError ?? '', /Backup volume unavailable/);
  assert.match(listBackups(backups, dataDir).localError ?? '', /Backup volume unavailable/);
  assert.match(backupHealth(backups, dataDir).localError ?? '', /Backup volume unavailable/);
  assert.equal(newestScheduledSnapshotAt(backups), null, 'no snapshot means the next due check retries at once');
  // The drive is mounted again: the same route succeeds and clears the recorded failure.
  const mounted = (root: string) => ({ dev: root === fixtureVolume(dir) ? 7 : 3, isDirectory: () => true });
  const retried = await createBackup(path, backups, at, { volumeRoot: fixtureVolume(dir), volumeStat: mounted });
  assert.equal(retried.localError, null);
  assert.equal(copiesAt(backups), 3, 'the retry published its hourly, daily and weekly snapshot');
  assert.equal(readBackupStatus(dataDir).localError, null);
  assert.equal(existsSync(join(dataDir, 'backups')), false, 'the retry still wrote only to the backup volume');
});

test('Spec 028: an unwritable backup volume records the failure and writes no fallback', async t => {
  const { dir, dataDir, path, store } = fixture(t);
  store.close();
  const volume = fixtureVolume(dir);
  const backups = join(volume, 'queue', 'backups');
  mkdirSync(volume, { recursive: true, mode: 0o500 });
  const mounted = (root: string) => ({ dev: root === volume ? 7 : 3, isDirectory: () => true });
  await assert.rejects(
    () => createBackup(path, backups, undefined, { volumeRoot: volume, volumeStat: mounted }),
    /Backup storage unavailable: .*could not be created \(EACCES\)/);
  assert.equal(existsSync(backups), false);
  assert.equal(existsSync(join(dataDir, 'backups')), false, 'nothing is written to the internal disk instead');
  assert.match(readBackupStatus(dataDir).localError ?? '', /Backup storage unavailable/);
  assert.match(backupHealth(backups, dataDir).localError ?? '', /Backup storage unavailable/);
});

test('Spec 028: an absent volume is never created as an ordinary directory at its mount point', async t => {
  const { dataDir, path, store } = fixture(t);
  store.close();
  // A unique name under /Volumes cannot be a real drive and cannot be created without root,
  // so the mount check is the only thing that can let a write through.
  const volumeRoot = join('/Volumes', `queue-backup-fixture-${randomUUID()}`);
  const backups = join(volumeRoot, 'queue', 'backups');
  await assert.rejects(() => createBackup(path, backups), /Backup volume unavailable: .* is not mounted/);
  assert.equal(existsSync(volumeRoot), false, 'nothing was created at the mount point on the internal disk');
  assert.equal(existsSync(backups), false);
  assert.match(readBackupStatus(dataDir).localError ?? '', /Backup volume unavailable/);
});

test('Spec 028: a backup volume must be a real mount, not an ordinary directory at the mount point', () => {
  const missing = () => { throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' }); };
  assert.throws(() => assertBackupVolume('/Volumes/example-volume', missing), /Backup volume unavailable: \/Volumes\/example-volume is not mounted/);
  // A directory on the same device as its parent is the internal disk wearing the volume's name.
  const internal = (path: string) => ({ dev: path === '/Volumes/example-volume' ? 7 : 7, isDirectory: () => true });
  assert.throws(() => assertBackupVolume('/Volumes/example-volume', internal), /is not a mounted volume/);
  assert.throws(() => assertBackupVolume('/Volumes/example-volume', () => ({ dev: 7, isDirectory: () => false })), /is not a directory/);
  // A mount point is a directory on another device than its parent.
  const mounted = (path: string) => ({ dev: path === '/Volumes/example-volume' ? 7 : 3, isDirectory: () => true });
  assert.doesNotThrow(() => assertBackupVolume('/Volumes/example-volume', mounted));
  assert.equal(volumeRootFor(liveBackupDir()), null, 'an unpinned work root needs no external volume');
  assert.equal(volumeRootFor('/var/tmp/queue-backups'), null, 'an ordinary directory names no volume');
  assert.deepEqual(backupDirState('/Volumes/example-volume/queue/backups', null), { available: true, error: null }, 'a directory with no volume root needs no mount');
});

test('Spec 028: the live store backs up under its configured work root and other instances remain isolated', () => {
  // The live store is the account's ~/.nucleus (path comparison, not an adopt check).
  const live = dirname(liveStorePath());
  assert.equal(liveBackupDir(), join(getWorkRoot(), 'queue', 'backups'));
  assert.equal(backupDirForDataDir(live), liveBackupDir());
  for (const root of ['project-c-pool', 'project-c-outputs', 'scratch', 'caches'])
    assert.ok(!liveBackupDir().includes(`/${root}/`), `${liveBackupDir()} stays outside the ${root} prune root`);
  assert.equal(backupDirForDataDir(join(tmpdir(), 'some-queue-data')), join(tmpdir(), 'some-queue-data', 'backups'));
});

test('Spec 028: a snapshot on the backup volume is discovered for listing, health and restore', async t => {
  const { dir, dataDir, path, store } = fixture(t);
  store.db.exec("CREATE TABLE restore_oracle(value TEXT); INSERT INTO restore_oracle VALUES('before')");
  const backups = join(fixtureVolume(dir), 'queue', 'backups');
  mkdirSync(join(fixtureVolume(dir), 'queue'), { recursive: true });
  const turned = await createBackup(path, backups);
  assert.equal(turned.localError, null);
  const listed = listBackups(backups, dataDir);
  assert.equal(listed.snapshots.filter(entry => entry.kind === 'hourly').length, 1);
  assert.equal(listed.localError, null);
  const health = backupHealth(backups, dataDir);
  assert.equal(health.newestSnapshotAt, local(listed, 'hourly')[0].at);
  assert.equal(health.localError, null);
  assert.equal(newestScheduledSnapshotAt(backups), Date.parse(health.newestSnapshotAt!));
  // The runbook's restore path reads the same file: gzip -dc into the data directory.
  const restored = join(dataDir, 'restored.sqlite');
  writeFileSync(restored, gunzipSync(readFileSync(join(backups, local(listed, 'hourly')[0].name))));
  const db = new DatabaseSync(restored, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(db.prepare('SELECT value FROM restore_oracle').get()?.value, 'before');
  } finally { db.close(); }
  store.close();
});

test('Spec 028: a migration with the backup volume away proceeds, writes no fallback copy and records the outage', t => {
  const { dataDir, path, store } = fixture(t);
  store.db.exec("CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('before')");
  store.db.exec("");
  store.db.prepare("UPDATE meta SET value='50' WHERE key='schema'").run();
  store.close();
  const volumeRoot = join('/Volumes', `queue-backup-fixture-${randomUUID()}`);
  const migrated = new Store(path, join(volumeRoot, 'queue', 'backups'));
  try {
    assert.equal(migrated.getMeta('schema'), CURRENT_SCHEMA, 'the migration still runs, so Queue still starts');
    assert.equal(migrated.db.prepare('SELECT value FROM keep').get()?.value, 'before');
    assert.match(readBackupStatus(dataDir).localError ?? '', /Backup volume unavailable/);
    assert.equal(existsSync(join(dataDir, 'backups')), false, 'no pre-migration snapshot on the internal disk');
    assert.equal(existsSync(volumeRoot), false);
  } finally { migrated.close(); }
});

test('Spec 028: a snapshot that fails on a volume that is there still stops the migration', t => {
  const { dataDir, path, store } = fixture(t);
  store.db.exec("");
  store.db.prepare("UPDATE meta SET value='50' WHERE key='schema'").run();
  store.close();
  writeFileSync(join(dataDir, 'backups'), 'not a directory');
  assert.throws(() => new Store(path), /Pre-migration backup failed/);
  assert.equal(Store.storedSchema(path), 50, 'the store was not migrated without its snapshot');
});

test('Spec 028: a failing backup stays visible without latching the service startup error, and survives a roll', async t => {
  const { dir, dataDir, store } = fixture(t);
  store.close();
  const first = new QueueRuntime({ dataDir, adapterFactory: () => adapterFor(dir), timers: false });
  try {
    await first.started;
    writeFileSync(join(dataDir, 'backups'), 'refused');
    await assert.rejects(() => first.backupNow({}));
    assert.equal(first.startError, '');
    assert.equal(first.health().ready, true);
    assert.ok((await first.backupList({})).localError);
    const failingBoard = first.uiSnapshot({});
    assert.ok(!('unchanged' in failingBoard) && failingBoard.backup.localError, 'the board carries the failure');
  } finally { await first.stop(); }
  // A new service lifetime reads the same durable status: the failure did not die with the process.
  const second = new QueueRuntime({ dataDir, adapterFactory: () => adapterFor(dir), timers: false });
  try {
    await second.started;
    assert.ok((await second.backupList({})).localError, 'the recorded failure is durable');
    rmSync(join(dataDir, 'backups'));
    await second.backupNow({});
    assert.equal((await second.backupList({})).localError, null);
  } finally { await second.stop(); }
});

test('Spec 028: the service lists snapshots in its own process, never by spawning one to stat them', async t => {
  const { dir, dataDir, path, backups, store } = fixture(t);
  store.close();
  const runtime = new QueueRuntime({ dataDir, adapterFactory: () => adapterFor(dir), timers: false });
  const execPath = process.execPath;
  try {
    await runtime.started;
    await createBackup(path, backups, new Date(Date.UTC(2026, 0, 1, 6)).toISOString());
    // Falsification: a listing that spawned a child cannot answer with no node to spawn.
    process.execPath = join(dir, 'no-such-node');
    try {
      const listed = await runtime.backupList({});
      assert.equal(listed.localError, null);
      assert.equal(listed.snapshots.filter(entry => entry.kind === 'hourly').length, 1, 'the snapshot is listed in process');
    } finally { process.execPath = execPath; }
  } finally { process.execPath = execPath; await runtime.stop(); }
});

test('Spec 028: snapshot health rides the board projection and re-projects when it changes', async t => {
  const { dir, dataDir, store } = fixture(t);
  store.close();
  const runtime = new QueueRuntime({ dataDir, adapterFactory: () => adapterFor(dir), timers: false });
  try {
    await runtime.started;
    const before = runtime.uiSnapshot({});
    assert.ok(!('unchanged' in before));
    assert.deepEqual(before.backup, { newestSnapshotAt: null, localError: null }, 'no snapshot yet');
    await runtime.backupNow({});
    const after = runtime.uiSnapshot({});
    assert.ok(!('unchanged' in after));
    assert.ok(after.backup.newestSnapshotAt, 'the newest verified snapshot is on the board');
    assert.ok(Math.abs(Date.parse(after.backup.newestSnapshotAt!) - Date.now()) < 120_000, 'the snapshot it names is the one just taken');
    assert.equal(after.backup.localError, null);
    // A poller holding the earlier revision re-projects instead of keeping the old fact.
    const polled = runtime.uiSnapshot({ revision: before.revision });
    assert.ok(!('unchanged' in polled), 'the settled snapshot advanced the board revision');
    assert.equal(polled.backup.newestSnapshotAt, after.backup.newestSnapshotAt);
    // A failing backup location is on the board too, so a Settings tab needs no listing of its own.
    rmSync(join(dataDir, 'backups'), { recursive: true, force: true });
    writeFileSync(join(dataDir, 'backups'), 'refused');
    await assert.rejects(() => runtime.backupNow({}));
    const failing = runtime.uiSnapshot({});
    assert.ok(!('unchanged' in failing));
    assert.match(failing.backup.localError ?? '', /is not a directory/);
    rmSync(join(dataDir, 'backups'));
  } finally { await runtime.stop(); }
});

test('Spec 028 row 6: runbook restore keeps replaced files and opens snapshot records', async t => {
  const { dir, dataDir, path, backups, store } = fixture(t);
  store.db.exec("CREATE TABLE restore_oracle(value TEXT); INSERT INTO restore_oracle VALUES('before')");
  const snapshot = local(await createBackup(path, backups), 'hourly')[0];
  store.db.exec("UPDATE restore_oracle SET value='after'");
  store.close(); // Runbook step 1: the plugin has stopped before file moves.
  const replaced = join(dir, 'replaced-fixture'); mkdirSync(replaced);
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) renameSync(path + suffix, join(replaced, 'queue.sqlite' + suffix));
  }
  writeFileSync(path, gunzipSync(readFileSync(join(dataDir, 'backups', snapshot.name))));
  const restored = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(restored.prepare('SELECT value FROM restore_oracle').get()?.value, 'before');
  } finally { restored.close(); }
  assert.ok(existsSync(join(replaced, 'queue.sqlite')));
});

test('A fixture data directory never backs up to the live work root, even with timers on', async t => {
  // A temporary HOME keeps the live store's iCloud folder and accounts out of reach.
  const home = mkdtempSync(join(tmpdir(), 'queue-fake-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const dir = mkdtempSync(join(tmpdir(), 'queue-timer-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = mkdtempSync(join(tmpdir(), 'queue-plugin-source-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  writeFileSync(join(source, 'mcp-report.mjs'), 'export {};\n');
  const liveBefore = existsSync(liveBackupDir());
  // Timers on and no adapter factory: the shape that once wrote fixture backups into the live folder.
  const runtime = new QueueRuntime({ dataDir: dir, sourcePath: source, connectTimeoutMs: 250 });
  try {
    const target = (runtime as unknown as { backupDir: string }).backupDir;
    assert.equal(target, join(dir, 'backups'));
    assert.notEqual(target, liveBackupDir());
    assert.equal(existsSync(liveBackupDir()), liveBefore, 'the live volume is untouched');
    assert.equal(existsSync(join(home, 'Library/Mobile Documents/com~apple~CloudDocs/Paseo Northstar Queue/backups')), false, 'no iCloud copy is written');
  } finally {
    await runtime.stop();
  }
});

test('Backup worker refuses a non-live store aimed at the live backup directory', async t => {
  // HOME points at a temp directory so the real backup volume is never written.
  const home = mkdtempSync(join(tmpdir(), 'queue-fake-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const dir = mkdtempSync(join(tmpdir(), 'queue-guarded-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'queue.sqlite');
  const store = new Store(path);
  store.close();
  const liveBefore = existsSync(liveBackupDir());
  await backupCommand('now', path, liveBackupDir()).then(
    () => assert.fail('expected the worker to refuse the live directory'),
    (error: unknown) => assert.match(String((error as { stderr?: unknown }).stderr ?? error), /Refusing/),
  );
  assert.equal(existsSync(liveBackupDir()), liveBefore, 'nothing was written at the live location');
  assert.equal(existsSync(join(dir, 'backups')), false);
  assert.throws(() => backupBeforeMigration(path, liveBackupDir()), /Refusing/);
  assert.equal(existsSync(liveBackupDir()), liveBefore);
});

timingTest('Spec 028 row 7: snapshot of a live-size store keeps reads under the Spec 012 budget', async t => {
  const { path, backups, store } = fixture(t);
  store.db.exec('CREATE TABLE payload(value TEXT)');
  const insert = store.db.prepare('INSERT INTO payload VALUES(?)');
  store.transaction(() => { for (let i = 0; i < 100; i++) insert.run('x'.repeat(200_000)); });
  let worst = 0;
  const timer = setInterval(() => {
    worst = Math.max(worst, cpuSample(() => store.getMeta('schema')).ms);
  }, 1);
  try { await backupCommand('now', path, backups); }
  finally { clearInterval(timer); store.close(); }
  performanceAssert(worst <= 100, `read held for ${worst.toFixed(1)} ms`);
});

test('a daily and weekly snapshot is a hard link to its hourly file in the same backup directory (Tom, 2026-10-20)', async t => {
  const { dataDir, path, backups, store } = fixture(t);
  const at = new Date(Date.UTC(2026, 9, 21, 6)).toISOString();
  const result = await createBackup(path, backups, at);
  const inode = (name: string) => statSync(join(backups, name)).ino;
  const hourly = local(result, 'hourly')[0].name, daily = local(result, 'daily')[0].name, weekly = local(result, 'weekly')[0].name;
  assert.equal(inode(daily), inode(hourly), 'daily shares the hourly file');
  assert.equal(inode(weekly), inode(hourly), 'weekly shares the hourly file');
  assert.equal(readdirSync(backups).filter(name => name.endsWith('.sqlite.gz')).length, 3, 'three names, one stored file');
  assert.deepEqual(readFileSync(join(backups, daily)), readFileSync(join(backups, hourly)));
  assert.equal(local(listBackups(backups, dataDir), 'daily').length, 1);
  store.close();
});

test('scheduled snapshots run every 6 hours and read as stale after one interval plus an hour (Tom, 2026-10-20)', async () => {
  const { BACKUP_INTERVAL_MS, BACKUP_STALE_AFTER_MS } = await import('../shared/contracts');
  assert.equal(BACKUP_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.equal(BACKUP_STALE_AFTER_MS, 7 * 60 * 60 * 1000);
});

test('scheduled snapshots are due against the newest verified one, so service rolls never postpone them (review #570)', async t => {
  const fs = require('node:fs') as typeof import('node:fs');
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  const { BACKUP_DUE_CHECK_MS } = await import('../shared/contracts');
  const hour = 60 * 60 * 1000;
  const dir = fs.mkdtempSync(join(tmpdir(), 'nsq-backup-due-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(join(dir, 'mcp-report.mjs'), 'export {};');
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-21T00:00:00.000Z') });
  const snapshotAt = (at: number) => {
    fs.mkdirSync(join(dir, 'backups'), { recursive: true });
    fs.writeFileSync(join(dir, 'backups', `${new Date(at).toISOString().replace(/:/g, '-').replace('.', '-')}-${randomUUID()}.hourly.sqlite.gz`), '');
  };
  // Isolate the scheduling policy: no daemon work, and a backup writes a snapshot at the mocked time.
  t.mock.method(QueueRuntime.prototype as any, 'start', async () => {});
  let backups = 0;
  t.mock.method(QueueRuntime.prototype, 'backupNow', async () => { backups++; snapshotAt(Date.now()); return { snapshots: [], localError: null }; });
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback: any, ms: number, ...args: any[]) => interval(ms === BACKUP_DUE_CHECK_MS ? callback : () => {}, ms, ...args));
  const lifetime = async (hours: number) => {
    const runtime = new QueueRuntime({ dataDir: dir, sourcePath: dir });
    await runtime.started; await Promise.resolve(); await Promise.resolve();
    for (let elapsed = 0; elapsed < hours * hour; elapsed += BACKUP_DUE_CHECK_MS) t.mock.timers.tick(BACKUP_DUE_CHECK_MS);
    await runtime.stop();
  };
  snapshotAt(Date.now() - hour);
  await lifetime(4);
  assert.equal(backups, 0, 'a start with a recent snapshot takes none');
  // Timeline: snapshot at -1 h; lifetimes cover 0-4 h, 4-8 h, 8-12 h and 12-16 h.
  await lifetime(4);
  assert.equal(backups, 1, 'due at 5 h, inside the second lifetime: taken once across the roll');
  await lifetime(4);
  assert.equal(backups, 2, 'next due at 11 h, inside the third lifetime');
  await lifetime(4);
  assert.equal(backups, 2, 'nothing before 17 h, however often the service rolls');
});

test('a store with no snapshot takes one at its first start', async t => {
  const fs = require('node:fs') as typeof import('node:fs');
  const dir = fs.mkdtempSync(join(tmpdir(), 'nsq-backup-first-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(join(dir, 'mcp-report.mjs'), 'export {};');
  t.mock.method(QueueRuntime.prototype as any, 'start', async () => {});
  let backups = 0;
  t.mock.method(QueueRuntime.prototype, 'backupNow', async () => { backups++; return { snapshots: [], localError: null }; });
  const runtime = new QueueRuntime({ dataDir: dir, sourcePath: dir, timers: true });
  try {
    await runtime.started; await Promise.resolve(); await Promise.resolve();
    assert.equal(backups, 1);
  } finally { await runtime.stop(); }
});


test('backup listing reads its one directory and still lists local snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-list-'));
  const backups = join(root, 'backups'); mkdirSync(backups);
  const name = '2026-11-05T00-00-00-000Z-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.hourly.sqlite.gz';
  writeFileSync(join(backups, name), 'fixture');
  const result = listBackups(backups, root);
  assert.equal(result.snapshots[0]?.name, name);
  assert.equal('unavailableRetained' in result, false, 'a retired drive is never listed');
});
