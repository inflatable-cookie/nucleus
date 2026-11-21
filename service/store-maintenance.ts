import { getWorkRoot } from '../core/workspaces/work-root.mjs';
import { backupCommand, backupHealth, listBackupSnapshots, newestBackupAt } from '../core/store/backups';
import type { Store } from '../core/store/store';
import type { StoreCompactor } from '../core/store/store-compaction';
import { BACKUP_FAILURE_RETRY_MS, BACKUP_HEALTH_REFRESH_MS, BACKUP_INTERVAL_MS, type BackupHealth, type BackupList } from '../shared/contracts';

/** The runtime ports store backup and compaction health read. */
export interface StoreMaintenanceOwner {
  closing: boolean;
  store: Store;
  dataDir: string;
  backupDir: string;
  compaction: StoreCompactor;
  /** Public `backup.now`: due and verified snapshots go through this so prototype mocks still bind. */
  backupNow(_input?: Record<string, never>, origin?: 'manual' | 'automatic'): Promise<BackupList>;
}

/**
 * Operator and scheduled snapshots, verified-snapshot health for the board,
 * and the compaction facts health projects. QueueRuntime keeps the RPC names
 * as one-line delegates so prototype mocks still bind.
 */
export class StoreMaintenance {
  private backupRunning: Promise<BackupList> | null = null;
  private backupAbort: AbortController | null = null;
  private backupError: string | null = null;
  private boardBackup: { readAt: number; value: BackupHealth } | null = null;
  private backupFailedAt = 0;

  constructor(private readonly owner: StoreMaintenanceOwner) {}

  get running(): Promise<BackupList> | null { return this.backupRunning; }
  abort(): void { this.backupAbort?.abort(); }
  clearBoardBackup(): void { this.boardBackup = null; }

  async verifiedSnapshot(): Promise<{ name: string; bytes: number }> {
    const list = await this.owner.backupNow({}, 'automatic');
    const newest = list.snapshots.filter(snapshot => snapshot.verified)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
    if (!newest) throw new Error(list.localError ? `the snapshot failed: ${list.localError}` : 'no verified snapshot was written');
    return { name: newest.name, bytes: newest.size };
  }

  backupIfDue(): void {
    if (this.owner.closing || this.backupRunning) return;
    const newest = newestBackupAt(this.owner.backupDir, this.owner.dataDir);
    if (newest !== null && Date.now() - newest < BACKUP_INTERVAL_MS) return;
    if (Date.now() - this.backupFailedAt < BACKUP_FAILURE_RETRY_MS) return;
    void this.owner.backupNow({}, 'automatic').catch(() => { this.backupFailedAt = Date.now(); });
  }

  backupNow(_input: Record<string, never> = {}, origin: 'manual' | 'automatic' = 'manual'): Promise<BackupList> {
    if (this.owner.closing) throw new Error('Nucleus runtime is draining');
    if (!this.backupRunning) {
      this.backupAbort = new AbortController();
      this.backupRunning = backupCommand(origin === 'manual' ? 'manual' : 'now', this.owner.store.path, this.owner.backupDir, this.backupAbort.signal)
        .then(result => { this.backupError = null; this.boardBackup = null; return result; },
          error => { if (!this.owner.closing) this.backupError = String(error); this.boardBackup = null; throw error; })
        .finally(() => { this.backupRunning = null; this.backupAbort = null; });
    }
    return this.backupRunning;
  }

  async backupList(_input: Record<string, never> = {}): Promise<BackupList> {
    try {
      const result = listBackupSnapshots(this.owner.backupDir, this.owner.dataDir);
      return { ...result, workRoot: getWorkRoot(this.owner.dataDir), localError: this.backupError ?? result.localError };
    } catch (error) {
      return { snapshots: [], workRoot: getWorkRoot(this.owner.dataDir), localError: this.backupError ?? String(error) };
    }
  }

  backupHealthProjection(): BackupHealth {
    const at = Date.now();
    if (!this.boardBackup || at - this.boardBackup.readAt >= BACKUP_HEALTH_REFRESH_MS) {
      let value: BackupHealth;
      try { value = backupHealth(this.owner.backupDir, this.owner.dataDir); }
      catch (error) { value = { newestSnapshotAt: null, localError: `Snapshot health unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
      this.boardBackup = { readAt: at, value };
    }
    return { ...this.boardBackup.value, localError: this.backupError ?? this.boardBackup.value.localError };
  }

  compactionHealth(): {
    autoVacuum: number; freePages: number; fileBytes: number;
    state: 'running' | 'converted' | 'landed' | 'refused' | 'failed' | null;
    attempts: number; reason: string | null; at: string | null;
    verification?: 'verified' | 'changed' | 'not-run' | null;
    fingerprint?: string | null;
    settledFrom?: 'running' | 'landed' | 'refused' | 'failed' | null;
  } {
    const facts = this.owner.store.storeFacts();
    const record = this.owner.compaction.record();
    return { autoVacuum: facts.autoVacuum, freePages: facts.freePages, fileBytes: facts.fileBytes,
      state: record?.state ?? null, attempts: record?.attempts ?? 0, reason: record?.reason ?? null, at: record?.at ?? null,
      verification: record?.verification?.content ?? null, fingerprint: record?.fingerprint ?? null,
      settledFrom: record?.settledFrom ?? null };
  }
}
