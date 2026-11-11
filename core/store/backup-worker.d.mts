/**
 * Types for the plain-JavaScript backup worker (Spec 028). It stays JavaScript so
 * Node can run it in a child without a TypeScript loader, including the
 * pre-migration snapshot taken before the store opens, and so the service can read
 * the snapshots and their status in its own process.
 */
import type { BackupList } from '../../shared/contracts';

/** The stream stage a test makes fail, as a real read error, compressor error or full disk would. */
export type BackupFault = 'read' | 'compress' | 'diskFull' | 'mismatch';
export interface BackupOptions {
  /** `manual` records the snapshot as the operator's Back up now (nucleus#965). */
  origin?: 'manual';
  /** Internal pre-migration snapshot publication bound to the admitted source. */
  admittedSource?: { path: string; fd: number };
  /** Fixture seam: a stream stage fails as soon as data reaches it. */
  fault?: BackupFault;
  /** Fixture seam: fail the snapshot's own integrity check. */
  failIntegrity?: boolean;
  /** Spec 029: the daily records export, injected so the worker imports no TypeScript. */
  records?: { export: (raw: string, target: string) => void; verify: (dir: string) => unknown };
  /**
   * The volume the backup directory must be mounted on. Defaults to the volume root the
   * directory names; null means the directory needs no volume. A
   * fixture uses it to prove the refusal without a removable drive.
   */
  volumeRoot?: string | null;
  /** Fixture seam: the volume observation, so a test can be an absent drive and then a mounted one. */
  volumeStat?: (path: string) => VolumeStat;
}
export interface BackupStatus {
  localError: string | null;
}
export function recordBackupOutage(dataDir: string, error: string): void;
/** Minimal `statSync` shape the mount check needs; a test may supply its own. */
export interface VolumeStat {
  dev: number | bigint;
  isDirectory(): boolean;
}

/**
 * Spec 028: Queue's one backup directory. It is on the configured work root, which is
 * not a consumer prune root, and it is the only place a snapshot is written.
 */
export function liveBackupDir(): string;
/** The live store's path, so a refusal can name the only store the live set holds. */
export function liveStorePath(): string;
/** True for the one data directory whose backups use the configured work root. */
export function isLiveStoreDir(dataDir: string): boolean;
/** The backup directory for a data directory: the configured work root for the live store. */
export function backupDirForDataDir(dataDir: string): string;
/** The volume root a path lives on, or null when it names no external volume. */
export function volumeRootFor(dir: string): string | null;
/** True when a failure says the backup volume is absent rather than a snapshot is broken. */
export function isStorageUnavailable(error: unknown): boolean;
/** Require an external volume root to be a mounted directory, not an ordinary local one. */
export function assertBackupVolume(root: string, stat?: (path: string) => VolumeStat): void;
/** Whether the backup directory is usable right now, and why not. */
export function backupDirState(dir: string, volumeRoot?: string | null): { available: boolean; error: string | null };

/** The verified snapshots in the one backup directory, and why the last snapshot failed. */
export function listBackups(dir: string, dataDir?: string): BackupList;
/** The durable status a listing and the board's snapshot health read, kept beside the store. */
export function readBackupStatus(dataDir: string): BackupStatus;
/** Decompress a snapshot in a stream and require the digest of the verified bytes. */
export function verifySnapshot(compressed: string, expectedDigest: string): Promise<string>;
/** Take, verify, compress, verify again and publish one snapshot, then rotate the retained set. */
export function createBackup(dbPath: string, dir?: string, at?: string, options?: BackupOptions): Promise<BackupList>;
