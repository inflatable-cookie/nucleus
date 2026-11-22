import { writeOwnedJson } from "../machine/owned-file.mjs";
import { CURRENT_DATA_HOME_LEAF } from "../../shared/data-home.mjs";
import { getRetiredWorkClassPath, getWorkClassPath, getWorkStorage, readWorkVolume } from '../workspaces/work-root.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, realpathSync, linkSync, fstatSync, constants } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

const kinds = { hourly: 24, daily: 14, weekly: 8 };
const namePattern = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-([a-f0-9-]+)\.(hourly|daily|weekly)\.sqlite\.gz$/;
/**
 * The snapshot a backup file name names, or null when the name is not one: its
 * period, the stem every tier of that snapshot shares, and the tier. This is the one
 * reader of the name shape; a listing, the due check and retention all use it.
 */
export function snapshotName(name) {
  const match = namePattern.exec(name);
  if (!match) return null;
  return {
    stem: `${match[1]}-${match[2]}`, kind: match[3],
    at: match[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'),
  };
}
/** One snapshot's file name for one of its tiers. */
export const snapshotFileName = (stem, kind) => `${stem}.${kind}.sqlite.gz`;
/**
 * Spec 028: the durable backup status lives in the data directory beside the store,
 * not in the backup directory. An absent backup volume is exactly the failure it has
 * to report, so it must not be where the report lives (Tom, 2026-10-26, relayed by
 * the Project-c Supervisor).
 */
const statusName = 'backup-status.json';
const statusPath = dataDir => join(dataDir, statusName);
/**
 * The status the listing and the board read, and whether the file itself is readable.
 * An absent file is no status yet; a file that cannot be read or does not hold a status
 * object is a failure the listing reports, never a healthy one (Spec 028).
 */
const readStatusFile = dataDir => {
  let text;
  try { text = readFileSync(statusPath(dataDir), 'utf8'); }
  catch (error) {
    return { status: {}, error: error?.code === 'ENOENT' ? null : `Backup status could not be read (${error?.code ?? error})` };
  }
  try {
    const status = JSON.parse(text);
    return status && typeof status === 'object' && !Array.isArray(status)
      ? { status, error: null } : { status: {}, error: 'Backup status is not a status record' };
  } catch { return { status: {}, error: 'Backup status is not valid JSON' }; }
};
const loadStatus = dataDir => readStatusFile(dataDir).status;
/** Spec 028: the durable status a listing and the board's snapshot health read. */
export function readBackupStatus(dataDir) {
  const { status, error } = readStatusFile(dataDir);
  return { localError: status.localError ?? error ?? null };
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
 * Spec 028: Queue's backups live in the configured backup location on the work
 * volume (`backupRoot` in `settings.json`, default `<workRoot>/archives/nucleus-backups`).
 * The work root is not a consumer prune root, so no cleanup can reclaim a
 * snapshot there. The drive that held earlier snapshots is retired
 * (Tom, 2026-11-05): it is never listed, probed or written.
 */
export const liveBackupDir = () => getWorkClassPath('backupRoot', liveStoreDir());
/** The retired `<workRoot>/queue/backups` location an existing install still reads. */
export const legacyLiveBackupDir = () => getRetiredWorkClassPath('backupRoot', liveStoreDir());
/**
 * Every location the live backup set is read from: the configured one, then the
 * retired one while it still holds a snapshot. Reads never delete: an existing
 * install keeps working until its old files are migrated or removed by hand.
 */
export function liveBackupReadDirs(placement = { backupRoot: liveBackupDir(), retired: { backupRoot: legacyLiveBackupDir() } }) {
  const live = placement.backupRoot;
  const legacy = placement.retired.backupRoot;
  if (!legacy || legacy === live) return [live];
  return files(legacy).length ? [live, legacy] : [live];
}
/** The newest verified scheduled snapshot in any live backup location, or null. */
export function newestLiveScheduledSnapshotAt(dirs = liveBackupReadDirs()) {
  let newest = null;
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const snapshot = snapshotName(name);
      if (snapshot?.kind !== 'hourly') continue;
      const at = Date.parse(snapshot.at);
      if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
    }
  }
  return newest;
}
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
  // A live class root is proved against the configured volume, whatever its path.
  try {
    const storage = getWorkStorage();
    if (path === getWorkClassPath('backupRoot') || path === getRetiredWorkClassPath('backupRoot'))
      return storage.volumeId ? storage.root : null;
  } catch { /* A refused placement falls through to the external-path shape below. */ }
  const storage = /\/queue\/backups(?:\/|$)|\/archives\/nucleus-backups(?:\/|$)/.test(path) || process.env.NUCLEUS_WORK_ROOT ? getWorkStorage() : null;
  if (storage && (path === storage.root || path.startsWith(`${storage.root}/`))) return storage.volumeId ? storage.root : null;
  const match = /^\/Volumes\/([^/]+)(?:\/|$)/.exec(resolve(dir));
  return match ? join('/', 'Volumes', match[1]) : null;
};
const unavailable = (root, reason) => Object.assign(
  new Error(`Backup volume unavailable: ${root} ${reason}`), { code: 'BACKUP_STORAGE_UNAVAILABLE' });
const unwritable = (dir, reason) => Object.assign(
  new Error(`Backup storage unavailable: ${dir} ${reason}`), { code: 'BACKUP_STORAGE_UNAVAILABLE' });
/**
 * The live backup class is a path setting (nucleus#1526), so every existing level
 * from the work root down to it must be a real directory on the mount's own
 * device: a symlinked `archives` level would otherwise receive snapshots somewhere
 * else on the drive, or off it.
 *
 * An absent work root is not a fault. An unpinned install may not have it yet, and
 * the recursive mkdir that follows creates the tree exactly as it did before these
 * paths were settings; a pinned volume was already proved by the mount check, which
 * refuses an absent drive. The answer says whether a level existed to prove.
 */
export function assertLiveBackupComponents(workRoot, backupRoot, options = {}) {
  const stat = options.stat ?? statSync;
  const lstat = options.lstat ?? lstatSync;
  const realpath = options.realpath ?? realpathSync;
  let mount;
  try { mount = stat(workRoot); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (typeof mount?.isDirectory === 'function' && !mount.isDirectory())
    throw new Error(`Work root ${workRoot} is not a directory`);
  const components = [workRoot];
  let path = workRoot;
  for (const part of relative(workRoot, backupRoot).split(sep)) {
    path = join(path, part);
    components.push(path);
  }
  for (const component of components) {
    let current;
    try { current = lstat(component); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== mount.dev || realpath(component) !== component)
      throw new Error(`Backup directory ${component} is redirected or is not a directory on the backup volume`);
  }
  return true;
}

/** Prove the live backup class's own levels, when this directory is the live one. */
const proveLivePlacement = (dir, stat = statSync) => {
  let live, workRoot;
  try { live = liveBackupDir(); workRoot = getWorkStorage(liveStoreDir()).root; } catch { return; }
  if (dir !== live) return;
  assertLiveBackupComponents(workRoot, live, { stat });
};

/**
 * Put the backup directory in place, or refuse before anything exists. The mount check
 * comes first so an absent volume is never turned into a directory at its mount point; a
 * path that is already there and is not a directory is a configured wrong path, not an
 * outage, so it stays an ordinary failure.
 */
const prepareBackupDir = (dir, volumeRoot, stat) => {
  if (volumeRoot) assertBackupVolume(volumeRoot, stat);
  proveLivePlacement(dir, stat);
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

const files = dir => existsSync(dir) ? readdirSync(dir).filter(name => snapshotName(name)).sort().reverse() : [];
const entries = dir => files(dir).map(name => {
  const snapshot = snapshotName(name);
  return { name, kind: snapshot.kind, at: snapshot.at, size: statSync(join(dir, name)).size, verified: true };
});
const rotate = (dir, allowed) => {
  for (const kind of allowed) {
    for (const name of files(dir).filter(name => name.includes(`.${kind}.`)).slice(kinds[kind])) rmSync(join(dir, name));
  }
};
/** Spec 028: the verified snapshots in the one backup directory, and why the last one failed. */
export function listBackups(dir, dataDir = dirname(dir)) {
  const { status, error } = readStatusFile(dataDir);
  const state = backupDirState(dir);
  // Manual snapshots are recorded by stem in the status file beside the store.
  const manual = new Set(Array.isArray(status.manual) ? status.manual : []);
  const snapshots = state.available ? entries(dir).map(entry => manual.has(snapshotName(entry.name).stem) ? { ...entry, manual: true } : entry) : [];
  snapshots.sort((a, b) => b.at.localeCompare(a.at));
  return { snapshots, localError: state.error ?? status.localError ?? error ?? null, dir, retention: { ...kinds } };
}
/**
 * The live backup listing: the configured location and, while it still holds
 * snapshots, the retired one. One snapshot's identical name in both places is
 * one entry, and the listing names the configured directory it writes to.
 */
export function listLiveBackups(dataDir, dirs = liveBackupReadDirs()) {
  const { status, error } = readStatusFile(dataDir);
  const states = dirs.map(dir => ({ dir, state: backupDirState(dir) }));
  const manual = new Set(Array.isArray(status.manual) ? status.manual : []);
  const seen = new Set();
  const snapshots = [];
  for (const { dir, state } of states) {
    if (!state.available) continue;
    for (const entry of entries(dir)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      snapshots.push(manual.has(snapshotName(entry.name).stem) ? { ...entry, manual: true } : entry);
    }
  }
  snapshots.sort((a, b) => b.at.localeCompare(a.at));
  const unavailable = states.find(item => !item.state.available);
  return { snapshots, localError: unavailable?.state.error ?? status.localError ?? error ?? null, dir: dirs[0], retention: { ...kinds } };
}
const key = at => at.slice(0, 10);
const week = at => {
  const date = new Date(at); const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  return `${year}-${Math.ceil((((date - start) / 86400000) + 1) / 7)}`;
};
/** The stem a new snapshot's hourly, daily and weekly file names share. */
const stemFor = at => `${at.replace(/:/g, '-').replace('.', '-')}-${randomUUID()}`;
/**
 * The daily and weekly tier exist once per period, so a new snapshot links its verified
 * hourly file only for the periods not already recorded.
 */
const linkPeriods = (dir, stem, hourly, at) => {
  const existing = entries(dir);
  for (const [kind, samePeriod] of [['daily', entry => key(entry.at) === key(at)], ['weekly', entry => week(entry.at) === week(at)]]) {
    if (!existing.some(entry => entry.kind === kind && samePeriod(entry)))
      linkAtomically(hourly, join(dir, snapshotFileName(stem, kind)));
  }
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
/**
 * Test seam (Spec 028): the stages one snapshot pipeline runs in place of its own, one slot
 * per component. A test supplies only the slots it needs, so a read error, a corrupted
 * stream, a broken compressor and a full disk are each proved at the position they happen,
 * and the cleanup that follows is the production one. Product callers never set it; the
 * faults, their codes and their messages belong to the test that proves them.
 */
const pipelineStages = (raw, compressed, digesting, stages = {}) => [
  stages.source ?? createReadStream(raw, { highWaterMark: streamChunk }),
  digesting,
  ...(stages.afterDigest ? [stages.afterDigest] : []),
  stages.compressor ?? createGzip(),
  stages.writer ?? createWriteStream(compressed, { flags: 'wx', mode: 0o600 }),
];
async function compressSnapshot(raw, compressed, options) {
  const rawDigest = createHash('sha256');
  const digesting = new Transform({ transform(chunk, _encoding, callback) { rawDigest.update(chunk); callback(null, chunk); } });
  await pipeline(...pipelineStages(raw, compressed, digesting, options.stages));
  return verifySnapshot(compressed, rawDigest.digest('hex'));
}
/** The admitted source no longer names the file a staged snapshot was taken from. */
const SOURCE_CHANGED = 'BACKUP_SOURCE_CHANGED';
const sourceChanged = () => Object.assign(new Error('Database changed during admission'), { code: SOURCE_CHANGED });
/** Publish a verified private snapshot only after rechecking its admitted source. */
async function publishStagedBackup(dbPath, dir, at, options, dataDir, verifySource) {
  const stem = stemFor(at);
  const privateCompressed = join(dirname(dbPath), `.${stem}.sqlite.gz.tmp`);
  const managedCompressed = join(dir, `.${stem}.sqlite.gz.tmp`);
  const hourly = join(dir, snapshotFileName(stem, 'hourly'));
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
    linkPeriods(dir, stem, hourly, at);
    // Startup may still reject a replaced source after this worker returns.
    // Leave existing status, retention and interrupted files to a normal backup.
    return listBackups(dir, dataDir);
  } catch (error) {
    // A failed source identity check must not create or update managed status.
    if (prepared) { rmSync(hourly, { force: true }); rmSync(managedCompressed, { force: true }); }
    if (error?.code !== SOURCE_CHANGED) verifySource();
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
    throw sourceChanged();
  };
  verifySource();
  const dataDir = dirname(admitted ? admitted.path : dbPath);
  // The live backup directory serves only the live store: a fixture or temporary store
  // aimed at it is refused before anything is written or pruned (2026-10-04: test runs
  // once wrote into the live folder and pruned its real backups). The retired live
  // location holds only the live store too, so a fixture cannot write there either.
  if (!isLiveStoreDir(dataDir) && (samePath(dir, liveBackupDir()) || samePath(dir, legacyLiveBackupDir()))) {
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
  const stem = stemFor(at);
  const raw = join(dir, `.${stem}.sqlite`);
  const hourly = join(dir, snapshotFileName(stem, 'hourly'));
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
    linkPeriods(dir, stem, hourly, at);
    status.localError = null;
    rotate(dir, ['hourly', 'daily', 'weekly']);
    // The manual record keeps only stems that are still on disk, so it stays bounded by retention.
    const kept = new Set(files(dir).map(name => snapshotName(name).stem));
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
