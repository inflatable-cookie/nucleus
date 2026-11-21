import { execFile, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { BackupHealth, BackupList } from '../../shared/contracts';
import { backupDirState, isLiveStoreDir, listBackups, listLiveBackups, liveBackupDir, newestLiveScheduledSnapshotAt, readBackupStatus, recordBackupOutage, snapshotName } from './backup-worker.mjs';

/**
 * Spec 028: Queue's one backup location and the rule that picks it belong to the
 * worker, so the service and its children can never disagree about where a snapshot
 * goes. The live store's snapshots live on the configured work root; every other
 * data directory keeps its own, so no fixture can write to or prune the live set.
 */
export { backupDirForDataDir, backupDirState, legacyLiveBackupDir, liveBackupDir, liveBackupReadDirs } from './backup-worker.mjs';
export { recordBackupOutage };

const worker = fileURLToPath(new URL('./backup-cli.mjs', import.meta.url));
const run = promisify(execFile);
/** Snapshot and verification subprocesses must finish inside the migration readiness cap. */
const BACKUP_TIMEOUT_MS = 120_000;
/**
 * When the newest verified scheduled snapshot was taken, from its file name, or
 * null when there is none. Reads only the backup directory listing, so the due
 * check writes nothing. Schedules key off this durable fact, not process lifetime,
 * so frequent service rolls never postpone a snapshot (review #570).
 */
export function newestScheduledSnapshotAt(dir: string): number | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  let newest: number | null = null;
  for (const name of names) {
    // The schedule keys off the hourly tier; a daily or weekly name is a hard link of it.
    const snapshot = snapshotName(name);
    if (snapshot?.kind !== 'hourly') continue;
    const at = Date.parse(snapshot.at);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** True when `dir` is the live store's own backup location (not a fixture's own folder). */
function isLiveBackupLocation(dir: string, dataDir: string): boolean {
  if (!isLiveStoreDir(dataDir)) return false;
  // A placement edited to something incoherent while the service runs must not
  // turn a listing or a due check into a throw: this answer is the only thing it
  // needs, and the next startup refuses the settings by name.
  try { return dir === liveBackupDir(); } catch { return false; }
}

/**
 * The newest scheduled snapshot the live store has, across every location it reads
 * while the retired `queue/backups` set is still there.
 */
export function newestBackupAt(dir: string, dataDir: string): number | null {
  return isLiveBackupLocation(dir, dataDir) ? newestLiveScheduledSnapshotAt() : newestScheduledSnapshotAt(dir);
}

/** `manual` is the operator's Back up now: the same snapshot, recorded as manual for the listing. */
export async function backupCommand(mode: 'now' | 'manual', path: string, dir: string, signal?: AbortSignal): Promise<BackupList> {
  const { stdout } = await run(process.execPath, [worker, mode, path, dir], { maxBuffer: 16 * 1024 * 1024, timeout: BACKUP_TIMEOUT_MS, signal });
  return JSON.parse(stdout) as BackupList;
}
/**
 * Spec 028: the snapshot list, read in this process. Statting the backups directory
 * needs no child, and spawning one with a TypeScript loader to do it cost a Node
 * start-up on every Settings poll (2026-10-25 performance audit).
 */
export function listBackupSnapshots(dir: string, dataDir: string): BackupList {
  return isLiveBackupLocation(dir, dataDir) ? listLiveBackups(dataDir) : listBackups(dir, dataDir);
}
/**
 * Spec 028: verified-snapshot health for the board projection — the newest
 * scheduled snapshot and the last failure. It is two directory reads and one stat of
 * the backup volume, so no surface has to poll `backup.list` just to age a snapshot.
 */
export function backupHealth(dir: string, dataDir: string): BackupHealth {
  const newest = newestBackupAt(dir, dataDir);
  const status = readBackupStatus(dataDir);
  return {
    newestSnapshotAt: newest === null ? null : new Date(newest).toISOString(),
    localError: backupDirState(dir).error ?? status.localError,
  };
}
export function backupBeforeMigration(path: string, dir: string, source?: { sourcePath: string; sourceFd: number }) {
  const args = source ? [worker, 'migration-staged', path, dir, source.sourcePath] : [worker, 'migration', path, dir];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: BACKUP_TIMEOUT_MS,
    ...(source ? { stdio: ['ignore', 'pipe', 'pipe', source.sourceFd] as const } : {}) });
  if (result.status === 0) return null;
  // Exit 2 is the backup volume being away, not a snapshot that failed. A staged
  // migration returns the outage to Store for recording only after admission commits.
  // Queue must not block startup on a missing drive (Tom, 2026-10-26); other snapshot
  // failures still stop migration before it writes.
  if (result.status === 2) return source ? String(result.stderr || 'Backup volume unavailable') : null;
  throw new Error(`Pre-migration backup failed: ${result.stderr || result.error || result.status}`);
}
