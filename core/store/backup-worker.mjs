import { writeOwnedJson } from "../machine/owned-file.mjs";
import { CURRENT_DATA_HOME_LEAF } from "../../shared/data-home.mjs";
import { getWorkStorage, readWorkVolume } from '../workspaces/work-root.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, realpathSync, linkSync, fstatSync, constants } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

const kinds = { hourly: 24, daily: 14, weekly: 8 };
const namePattern = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-([a-f0-9-]+)\.(hourly|daily|weekly)\.sqlite\.gz$/;
/**
 * Spec 028: the durable backup status lives in the data directory beside the store,
 * not in the backup directory. An absent backup volume is exactly the failure it has
 * to report, so it must not be where the report lives (Tom, 2026-10-26, relayed by
 * the Project-c Supervisor).
 */
const statusName = 'backup-status.json';
const statusPath = dataDir => join(dataDir, statusName);
const loadStatus = dataDir => {
  try { return JSON.parse(readFileSync(statusPath(dataDir), 'utf8')); }
  catch { return {}; }
};
/** Spec 028: the durable status a listing and the board's snapshot health read. */
export function readBackupStatus(dataDir) {
  const status = loadStatus(dataDir);
  return { localError: status.localError ?? null };
}
/** Record an outage only after the store has successfully admitted its source. */
export function recordBackupOutage(dataDir, error) {
  const status = loadStatus(dataDir);
  status.localError = error;
  saveStatus(dataDir, status);
}
const saveStatus = (dataDir, status) => {
  writeOwnedJson(statusPath(dataDir), status);
};
const samePath = (a, b) => {
  try { a = realpathSync(a); } catch {}
  try { b = realpathSync(b); } catch {}
  return resolve(a) === resolve(b);
};

/**
 * Spec 028: Queue's backups live on the configured work root. The work root
 * is not a consumer prune root, so no cleanup can reclaim a snapshot there. The
 * drive that held earlier snapshots is retired (Tom, 2026-11-05): it is never listed,
 * probed or written.
 */
export const liveBackupDir = () => join(getWorkStorage(liveStoreDir()).root, 'queue', 'backups');
// Instance overrides choose their own store, never the shared live backup set.
// The live-store boundary is a path comparison to the account's ~/.nucleus, not
// an adopt check: a private NUCLEUS_DATA_HOME instance must still start when
// that folder is empty or another product's.
const liveStoreDir = () => join(userInfo().homedir, CURRENT_DATA_HOME_LEAF);
export const liveStorePath = () => join(liveStoreDir(), 'queue.sqlite');
/**
 * A process whose HOME is not the account's own home is never the live store. A
 * fixture that reproduces the live data directory's shape (one test does, with a
 * throwaway HOME) must not be able to write to or prune the live backup set.
 */
const homeIsAccountHome = () => {
  try { return resolve(homedir()) === resolve(userInfo().homedir); }
  catch { return false; }
};
/** True for the one data directory whose backups go to the external volume. */
export const isLiveStoreDir = dataDir => homeIsAccountHome() && samePath(dataDir, liveStoreDir());
/**
 * The backup directory for a data directory: the external volume for the live store,
 * `<data dir>/backups/` for anything else (a fixture, a private NUCLEUS_DATA_HOME
 * instance), so no other store can write into the live set.
 */
export const backupDirForDataDir = dataDir => isLiveStoreDir(dataDir) ? liveBackupDir() : join(dataDir, 'backups');

/** A pinned work root, or the volume root of an explicitly named external path. */
export const volumeRootFor = dir => {
  const path = resolve(dir);
  const storage = /\/queue\/backups(?:\/|$)/.test(path) || process.env.NUCLEUS_WORK_ROOT ? getWorkStorage() : null;
  if (storage && (path === storage.root || path.startsWith(`${storage.root}/`))) return storage.volumeId ? storage.root : null;
  const match = /^\/Volumes\/([^/]+)(?:\/|$)/.exec(resolve(dir));
  return match ? join('/', 'Volumes', match[1]) : null;
};
const unavailable = (root, reason) => Object.assign(
  new Error(`Backup volume unavailable: ${root} ${reason}`), { code: 'BACKUP_STORAGE_UNAVAILABLE' });
const unwritable = (dir, reason) => Object.assign(
  new Error(`Backup storage unavailable: ${dir} ${reason}`), { code: 'BACKUP_STORAGE_UNAVAILABLE' });
/**
 * Put the backup directory in place, or refuse before anything exists. The mount check
 * comes first so an absent volume is never turned into a directory at its mount point; a
 * path that is already there and is not a directory is a configured wrong path, not an
 * outage, so it stays an ordinary failure.
 */
const prepareBackupDir = (dir, volumeRoot, stat) => {
  if (volumeRoot) assertBackupVolume(volumeRoot, stat);
  let existing = null;
  try { existing = statSync(dir); } catch {}
  if (existing) {
    if (!existing.isDirectory()) throw new Error(`Backup directory ${dir} is not a directory`);
    return;
  }
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  catch (error) { throw unwritable(dir, `could not be created (${error?.code ?? error?.message ?? error})`); }
};
/** True for the failure that means storage is absent rather than a snapshot that broke. */
export const isStorageUnavailable = error => Boolean(error && error.code === 'BACKUP_STORAGE_UNAVAILABLE');
/**
 * Spec 028: a backup directory on an external volume is usable only when that volume is
 * actually there. macOS leaves /Volumes writable with the drive away, so `mkdir -p`
 * would quietly create the backup directory on the internal SSD at the mount point:
 * files hidden behind the mount once the drive returns, on the one disk backups must
 * never touch. A mount point is a directory on a different device than its parent.
 */
export function assertBackupVolume(root, stat = statSync) {
  let facts;
  try { facts = stat(root); }
  catch (error) { throw unavailable(root, `is not mounted (${error?.code ?? error})`); }
  if (typeof facts?.isDirectory !== 'function' || !facts.isDirectory()) throw unavailable(root, 'is not a directory');
  let parent;
  try { parent = stat(dirname(root)); }
  catch { throw unavailable(root, 'has no reachable parent'); }
  if (parent?.dev === undefined || parent.dev === facts.dev) throw unavailable(root, 'is not a mounted volume');
  const storage = stat === statSync ? getWorkStorage() : null;
  if (storage?.root === root && storage.volumeId) {
    let volume;
    try { volume = readWorkVolume(root); }
    catch { throw unavailable(root, 'volume identity could not be read'); }
    if (volume.MountPoint !== root || volume.VolumeUUID?.toUpperCase() !== storage.volumeId.toUpperCase())
      throw unavailable(root, 'mounted volume identity does not match');
  }
}
/**
 * The storage state a listing and the board read: whether the backup directory is
 * usable right now, and why not. It only reads, so a listing never writes.
 */
export function backupDirState(dir, volumeRoot = volumeRootFor(dir)) {
  if (!volumeRoot) return { available: true, error: null };
  try { assertBackupVolume(volumeRoot); return { available: true, error: null }; }
  catch (error) { return { available: false, error: String(error) }; }
}

/** A snapshot's file stem: its hourly, daily and weekly names share it (hard links of one file). */
const snapshotStem = name => name.replace(/\.(?:hourly|daily|weekly)\.sqlite\.gz$/, '');
const files = dir => existsSync(dir) ? readdirSync(dir).filter(name => namePattern.test(name)).sort().reverse() : [];
const entries = dir => files(dir).map(name => {
  const match = name.match(namePattern);
  return { name, kind: match[3], at: match[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'),
    size: statSync(join(dir, name)).size, verified: true };
});
const rotate = (dir, allowed) => {
  for (const kind of allowed) {
    for (const name of files(dir).filter(name => name.includes(`.${kind}.`)).slice(kinds[kind])) rmSync(join(dir, name));
  }
};
/** Spec 028: the verified snapshots in the one backup directory, and why the last one failed. */
export function listBackups(dir, dataDir = dirname(dir)) {
  const status = readBackupStatus(dataDir);
  const state = backupDirState(dir);
  // Manual snapshots are recorded by stem in the status file beside the store.
  const recorded = loadStatus(dataDir).manual;
  const manual = new Set(Array.isArray(recorded) ? recorded : []);
  const snapshots = state.available ? entries(dir).map(entry => manual.has(snapshotStem(entry.name)) ? { ...entry, manual: true } : entry) : [];
  snapshots.sort((a, b) => b.at.localeCompare(a.at));
  return { snapshots, localError: state.error ?? status.localError, dir, retention: { ...kinds } };
}
const key = at => at.slice(0, 10);
const week = at => {
  const date = new Date(at); const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  return `${year}-${Math.ceil((((date - start) / 86400000) + 1) / 7)}`;
};
// A daily or weekly snapshot is a hard link to its verified hourly file: identical
// bytes and durability with no second write (Tom, 2026-10-20, to cut writes). A
// volume that refuses links falls back to a copy.
const linkAtomically = (source, destination) => {
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    try { linkSync(source, temp); } catch { copyFileSync(source, temp); }
    renameSync(temp, destination);
  } finally { rmSync(temp, { force: true }); }
};
const clearInterruptedFiles = dir => {
  for (const name of readdirSync(dir)) {
    if (/^\.\d{4}-\d\d-\d\dT.*\.(?:sqlite|sqlite\.gz\.tmp)$/.test(name)
      || /^\d{4}-\d\d-\d\dT.*\.(?:daily|weekly)\.sqlite\.gz\.[a-f0-9-]+\.tmp$/.test(name))
      rmSync(join(dir, name), { recursive: true, force: true });
  }
};
/** One bounded chunk in flight, whatever the store's size (Spec 028: never the whole file in memory). */
const streamChunk = 256 * 1024;
// A stage that fails as soon as data reaches it: the stream-failure seam for tests, in
// the same spirit as `options.failIntegrity`, so a full disk, a bad read or a broken
// compressor can be proved without one.
const failingStage = (message, code) => new Transform({
  transform(_chunk, _encoding, callback) { callback(Object.assign(new Error(message), { code })); },
});
/**
 * Read a compressed snapshot back through a streaming decompressor and require the
 * digest of the bytes that were verified before compression. This is how a published
 * snapshot is proved, and it is the same check a restore relies on.
 */
export async function verifySnapshot(compressed, expectedDigest) {
  const restored = createHash('sha256');
  await pipeline(
    createReadStream(compressed, { highWaterMark: streamChunk }),
    createGunzip(),
    new Writable({ write(chunk, _encoding, callback) { restored.update(chunk); callback(); } }),
  );
  const actual = restored.digest('hex');
  if (actual !== expectedDigest) throw new Error('Compressed snapshot does not decompress to the verified bytes');
  return actual;
}
/**
 * Compress the verified raw snapshot into `compressed` as a stream, digesting the raw
 * bytes as they pass, then prove the written file decompresses to exactly those bytes.
 * Memory stays bounded by one chunk plus the compressor's window, and a snapshot is
 * published only when the compression and its round trip both prove out, so a broken
 * compressor, a full disk or an interrupted write leaves no restore point (Spec 028).
 */
async function compressSnapshot(raw, compressed, options) {
  const fault = options.fault ?? null;
  const rawDigest = createHash('sha256');
  const digesting = new Transform({ transform(chunk, _encoding, callback) { rawDigest.update(chunk); callback(null, chunk); } });
  // A valid gzip of other bytes is the "bad snapshot" the round-trip check has to catch.
  const corrupting = new Transform({ transform(chunk, _encoding, callback) { callback(null, Buffer.alloc(chunk.length, 0)); } });
  const stages = [
    createReadStream(raw, { highWaterMark: streamChunk }),
    fault === 'read' ? failingStage('injected snapshot read failure', 'EIO') : digesting,
  ];
  if (fault === 'mismatch') stages.push(corrupting);
  stages.push(fault === 'compress' ? failingStage('injected compressor failure', 'EIO') : createGzip());
  // A full disk fails the write stage, so the injected error lands where ENOSPC would.
  stages.push(fault === 'diskFull' ? failingStage('injected disk full', 'ENOSPC') : createWriteStream(compressed, { flags: 'wx', mode: 0o600 }));
  await pipeline(...stages);
  return verifySnapshot(compressed, rawDigest.digest('hex'));
}
/** Publish a verified private snapshot only after rechecking its admitted source. */
async function publishStagedBackup(dbPath, dir, at, options, dataDir, verifySource) {
  const stem = `${at.replace(/:/g, '-').replace('.', '-')}-${randomUUID()}`;
  const privateCompressed = join(dirname(dbPath), `.${stem}.sqlite.gz.tmp`);
  const managedCompressed = join(dir, `.${stem}.sqlite.gz.tmp`);
  const hourly = join(dir, `${stem}.hourly.sqlite.gz`);
  let prepared = false;
  try {
    const snapshot = new DatabaseSync(dbPath, { readOnly: true });
    try {
      if (options.failIntegrity || snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw new Error('Snapshot integrity_check failed');
    } finally { snapshot.close(); }
    const expected = await compressSnapshot(dbPath, privateCompressed, options);
    const volumeRoot = options.volumeRoot === undefined ? volumeRootFor(dir) : options.volumeRoot;
    if (volumeRoot) assertBackupVolume(volumeRoot, options.volumeStat ?? statSync);
    verifySource();
    prepareBackupDir(dir, null, options.volumeStat ?? statSync);
    prepared = true;
    copyFileSync(privateCompressed, managedCompressed, constants.COPYFILE_EXCL);
    await verifySnapshot(managedCompressed, expected);
    verifySource();
    renameSync(managedCompressed, hourly);
    const existing = entries(dir);
    for (const [kind, samePeriod] of [['daily', entry => key(entry.at) === key(at)], ['weekly', entry => week(entry.at) === week(at)]]) {
      if (!existing.some(entry => entry.kind === kind && samePeriod(entry))) linkAtomically(hourly, join(dir, `${stem}.${kind}.sqlite.gz`));
    }
    // Startup may still reject a replaced source after this worker returns.
    // Leave existing status, retention and interrupted files to a normal backup.
    return listBackups(dir, dataDir);
  } catch (error) {
    // A failed source identity check must not create or update managed status.
    if (prepared) { rmSync(hourly, { force: true }); rmSync(managedCompressed, { force: true }); }
    if (error?.message !== 'Database changed during admission') verifySource();
    throw error;
  } finally { rmSync(privateCompressed, { force: true }); }
}

export async function createBackup(dbPath, dir = backupDirForDataDir(dirname(dbPath)), at = new Date().toISOString(), options = {}) {
  // A staged snapshot may publish for the live store only while its inherited
  // source descriptor still names the original path. Check before managed writes.
  const admitted = options.admittedSource;
  const verifySource = () => {
    if (!admitted) return;
    try {
      const held = fstatSync(admitted.fd), current = statSync(admitted.path);
      if (held.dev === current.dev && held.ino === current.ino) return;
    } catch { /* missing or replaced source */ }
    throw new Error('Database changed during admission');
  };
  verifySource();
  const dataDir = dirname(admitted ? admitted.path : dbPath);
  // The live backup directory serves only the live store: a fixture or temporary store
  // aimed at it is refused before anything is written or pruned (2026-10-04: test runs
  // once wrote into the live folder and pruned its real backups).
  if (!isLiveStoreDir(dataDir) && /\/queue\/backups\/?$/.test(dir) && samePath(dir, liveBackupDir())) {
    throw new Error(`Refusing to back up ${dbPath} to the live backup directory ${dir}: it holds only the live store ${liveStorePath()}`);
  }
  if (admitted) return publishStagedBackup(dbPath, dir, at, options, dataDir, verifySource);
  const status = loadStatus(dataDir);
  // Storage comes first: an absent volume writes nothing anywhere and is recorded in the
  // data directory, so a later listing and the board can show it across service rolls.
  const volumeRoot = options.volumeRoot === undefined ? volumeRootFor(dir) : options.volumeRoot;
  try {
    prepareBackupDir(dir, volumeRoot, options.volumeStat ?? statSync);
  } catch (error) {
    status.localError = String(error);
    saveStatus(dataDir, status);
    throw error;
  }
  clearInterruptedFiles(dir);
  const stem = `${at.replace(/:/g, '-').replace('.', '-')}-${randomUUID()}`;
  const raw = join(dir, `.${stem}.sqlite`);
  const hourly = join(dir, `${stem}.hourly.sqlite.gz`);
  const compressed = join(dir, `.${stem}.sqlite.gz.tmp`);
  try {
    const source = new DatabaseSync(dbPath, { readOnly: true });
    try { source.exec(`VACUUM INTO '${raw.replaceAll("'", "''")}'`); }
    finally { source.close(); }
    const verify = new DatabaseSync(raw, { readOnly: true });
    try {
      if (options.failIntegrity || verify.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('Snapshot integrity_check failed');
    } finally { verify.close(); }
    await compressSnapshot(raw, compressed, options);
    renameSync(compressed, hourly);
    const existing = entries(dir);
    for (const [kind, samePeriod] of [['daily', entry => key(entry.at) === key(at)], ['weekly', entry => week(entry.at) === week(at)]]) {
      if (!existing.some(entry => entry.kind === kind && samePeriod(entry))) linkAtomically(hourly, join(dir, `${stem}.${kind}.sqlite.gz`));
    }
    status.localError = null;
    rotate(dir, ['hourly', 'daily', 'weekly']);
    // The manual record keeps only stems that are still on disk, so it stays bounded by retention.
    const kept = new Set(files(dir).map(snapshotStem));
    const manual = (Array.isArray(status.manual) ? status.manual : []).filter(item => kept.has(item));
    if (options.origin === 'manual' && kept.has(stem)) manual.push(stem);
    if (manual.length) status.manual = manual; else delete status.manual;
  } catch (error) {
    rmSync(hourly, { force: true });
    rmSync(compressed, { force: true });
    status.localError = String(error);
    saveStatus(dataDir, status);
    throw error;
  } finally { rmSync(raw, { force: true }); rmSync(compressed, { force: true }); }
  saveStatus(dataDir, status);
  return listBackups(dir, dataDir);
}
