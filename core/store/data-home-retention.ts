import { readdirSync, lstatSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { backupDirForDataDir, isLiveStoreDir, listBackups, liveBackupDir, snapshotName } from "./backup-worker.mjs";

export interface RetentionRemoval { path: string; bytes: number }

/** Decide which local snapshot copies are superseded by a verified live snapshot. */
export function staleBackupCopies(local: readonly { path: string; at: string; bytes: number }[], newestLiveAt: string | null): RetentionRemoval[] {
  if (!newestLiveAt) return [];
  return local.filter(item => item.at <= newestLiveAt).map(({ path, bytes }) => ({ path, bytes }));
}

/** Remove stale backup copies from the live data home only; the external set is read-only here. */
export function pruneLiveDataHomeBackupCopies(dataDir: string): RetentionRemoval[] {
  if (!isLiveStoreDir(dataDir) || backupDirForDataDir(dataDir) !== liveBackupDir()) return [];
  const live = listBackups(liveBackupDir(), dataDir);
  const newestLiveAt = live.snapshots[0]?.at ?? null;
  if (!newestLiveAt) return [];

  const removed: RetentionRemoval[] = [];
  for (const leaf of ["backups", ".external-backups"]) {
    const directory = join(dataDir, leaf);
    let names: string[];
    try { names = readdirSync(directory); } catch { continue; }
    const candidates = names.flatMap(name => {
      const snapshot = snapshotName(name);
      if (!snapshot) return [];
      const path = join(directory, name);
      try {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink()) return [];
        return [{ path, at: snapshot.at, bytes: info.size }];
      } catch { return []; }
    });
    for (const removal of staleBackupCopies(candidates, newestLiveAt)) {
      try { unlinkSync(removal.path); removed.push(removal); } catch { /* The next hourly pass rechecks the copy. */ }
    }
    try { if (readdirSync(directory).length === 0) rmdirSync(directory); } catch { /* Keep unknown or concurrently written entries. */ }
  }
  return removed;
}
