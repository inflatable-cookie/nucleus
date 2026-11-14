import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Task } from "../../shared/contracts";
import { backupBeforeMigration, backupDirForDataDir, recordBackupOutage } from "./backups";
import { StoreCore, StoreMaintenanceError } from "./store-core";
import type { StoreMigration } from "./store-migration";
import { encodeStoredValue } from "./store-reclaim";
import type { StoreRetention } from "./store-retention";
import { FRESH_STORE_SCHEMA, LEAD_READ_VIEW_SQL, OUTCOME_SEARCH_INDEX_SQL, STORE_OPEN_DDL } from "./store-schema";

// Schema 55: the lean store (outcome search and lead reads rebuilt, task_texts
// retired).
// Schema 56 (task 1005): credentials gain a revocation marker. A release revokes
// the run's credential (it authenticates nothing) instead of deleting the row, so
// a live re-bind of the same run identity restores the same credential.
// Schema 57 (task 1010): one row stores independent publication counters.
// Schema 58 (task 1112): the usage gauge's stored samples and per-subscription read state.
export const CURRENT_SCHEMA = 58;

/**
 * Spec 028 revision "Store compaction" (audit B9): the WAL file is bounded after a
 * checkpoint instead of growing until SQLite's next natural truncation, and the page
 * cache is one stated number rather than the build's default. Both are per-connection
 * settings in SQLite, so they are set on every open; neither changes a stored row.
 */
export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export const CACHE_SIZE_KIB = 64 * 1024;

/** The facts admission needs from the store's other owners; nothing else on the store is read. */
export interface AdmissionHooks {
  /** The schema probe and snapshot comparison the store class exposes; admission never
   *  reaches around them, so a caller that proves an admission fault can substitute one. */
  storedSchema: (path: string, checkIntegrity?: boolean) => number | undefined;
  schemaIn: (db: DatabaseSync, checkIntegrity?: boolean) => number;
  verifyMigrationSnapshot: (source: DatabaseSync, snapshot: DatabaseSync) => void;
  numberedTask: (data: string) => Task;
  taskRow: (task: Task, before?: Task | null) => string;
  storedReviewValue: (value: unknown) => unknown;
  migration: StoreMigration;
  retention: StoreRetention;
}

/**
 * Opening a store: the writable admission, the schema version it must be at, the migration
 * path, and the bounded maintenance window. Every statement a store needs to serve its
 * lookups comes from `store-schema.ts`, so a fresh database and a migrated one are built by
 * one schema source.
 */
export class StoreAdmission {
  constructor(private readonly core: StoreCore, private readonly hooks: AdmissionHooks) {}
  private get db() { return this.core.db; }

  /** Read the schema under SQLite's native snapshot, including committed WAL. */
  static storedSchema(path: string, checkIntegrity = true): number | undefined {
    if (path === ":memory:" || !existsSync(path)) return undefined;
    if (statSync(path).size === 0) return undefined;
    const db = new DatabaseSync(path, { readOnly: true });
    try { return StoreAdmission.schemaIn(db, checkIntegrity); } finally { db.close(); }
  }

  static schemaIn(db: DatabaseSync, checkIntegrity = true): number {
    let value: unknown;
    try { value = db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value; }
    catch { throw new Error("Unversioned or corrupt database; use an older build to upgrade first"); }
    let schema: unknown;
    try { schema = JSON.parse(String(value)); } catch { throw new Error("Unversioned or corrupt database; use an older build to upgrade first"); }
    if (!Number.isSafeInteger(schema) || Number(schema) < 1) throw new Error("Unversioned or corrupt database; use an older build to upgrade first");
    if (Number(schema) < 50) throw new Error(`Unsupported database schema ${schema}; schema 50 is the minimum supported version; use an older build to upgrade first`);
    if (Number(schema) > CURRENT_SCHEMA) throw new Error(`Unsupported future database schema ${schema}`);
    const required = ["meta", "tasks", "runs", "events", "leads", "lead_versions", "outcomes", "decisions"];
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => String(row.name)));
    if (required.some(name => !tables.has(name))) throw new Error(`Corrupt database schema ${schema}: required table missing`);
    if (checkIntegrity) {
      const checked = db.prepare("PRAGMA quick_check(1)").get();
      if (checked?.quick_check !== "ok") throw new Error(`Corrupt database schema ${schema}: SQLite quick_check failed`);
    }
    return Number(schema);
  }

  /** Compare native snapshots by every stored value and meaningful row order. */
  static verifyMigrationSnapshot(source: DatabaseSync, snapshot: DatabaseSync): void {
    const names = (db: DatabaseSync) => {
      const rows = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all() as Array<{ name: string; sql: string | null }>;
      const virtual = rows.filter(row => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(row.sql ?? ''))).map(row => row.name);
      const shadows = new Set(virtual.flatMap(name => ['data','idx','content','docsize','config'].map(suffix => `${name}_${suffix}`)));
      return rows.filter(row => !shadows.has(row.name));
    };
    const original = names(source), copied = names(snapshot);
    if (JSON.stringify(original) !== JSON.stringify(copied)) throw new Error("Migration snapshot schema differs from source");
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    for (const table of original) {
      const columns = source.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as Array<{ name: string; pk: number }>;
      const fields = columns.map(column => quote(column.name)).join(',');
      const order = /\bWITHOUT\s+ROWID\b/i.test(String(table.sql ?? ''))
        ? columns.filter(column => Number(column.pk) > 0).sort((a,b) => Number(a.pk)-Number(b.pk)).map(column => quote(column.name)).join(',')
        : 'rowid';
      const sql = `SELECT ${fields} FROM ${quote(table.name)} ORDER BY ${order}`;
      const a = source.prepare(sql).iterate()[Symbol.iterator](), b = snapshot.prepare(sql).iterate()[Symbol.iterator]();
      for (;;) {
        const left = a.next(), right = b.next();
        if (left.done || right.done) {
          if (left.done !== right.done) throw new Error(`Migration snapshot row count differs for ${table.name}`);
          break;
        }
        for (const column of columns)
          if (!encodeStoredValue(left.value[column.name]).equals(encodeStoredValue(right.value[column.name])))
            throw new Error(`Migration snapshot content differs for ${table.name}`);
      }
    }
  }

  initialize(path: string, backupDir?: string, onMigrationStart?: () => void) {
    const memory = path === ":memory:";
    const exists = !memory && existsSync(path);
    const fresh = memory || !exists || statSync(path).size === 0;
    if (!memory && fresh && ["-wal", "-shm", "-journal"].some(suffix => existsSync(path + suffix)))
      throw new Error("Unversioned database with sidecars; refusing to initialize");
    const source = !fresh ? statSync(path) : null;
    // Reject unsupported schemas before writable admission; check integrity once under the lock.
    if (!fresh) this.hooks.storedSchema(path, false);
    if (!memory && !exists) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const sourceFd = source ? openSync(path, "r") : null;
    const checkSource = () => {
      if (sourceFd === null || source === null) return;
      let current: ReturnType<typeof statSync>;
      try { current = statSync(path); } catch { throw new Error("Database changed during admission"); }
      const held = fstatSync(sourceFd);
      if (source.dev !== held.dev || source.ino !== held.ino || held.dev !== current.dev || held.ino !== current.ino)
        throw new Error("Database changed during admission");
    };
    let backupOutage: string | null = null;
    try { this.core.db = new DatabaseSync(path); }
    catch (error) { if (sourceFd !== null) closeSync(sourceFd); throw error; }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      checkSource();
      const schema = fresh ? undefined : this.hooks.schemaIn(this.db);
      if (fresh) {
        if (this.db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get()) throw new Error("Database changed during admission");
        // Keep exclusive custody while setting the fresh database vacuum mode.
        this.db.exec("PRAGMA locking_mode=EXCLUSIVE; COMMIT; PRAGMA auto_vacuum=INCREMENTAL; VACUUM; BEGIN IMMEDIATE");
        this.db.exec(FRESH_STORE_SCHEMA);
        this.createOutcomeSearchIndex();
        this.createLeadReadView();
        this.core.setMeta("schema", CURRENT_SCHEMA); this.core.setMeta("paused", true); this.core.setMeta("pool", []);
      } else if (schema !== undefined && schema < CURRENT_SCHEMA) {
        onMigrationStart?.();
        checkSource();
        if (!memory && sourceFd !== null) {
          const privateDir = mkdtempSync(join(tmpdir(), "queue-migration-snapshot-"));
          try {
            const snapshotPath = join(privateDir, "snapshot.sqlite");
            // VACUUM INTO uses the admitted connection, and never reopens the source path.
            // The lock is reacquired before validating that its snapshot is still current.
            this.db.exec("COMMIT");
            this.db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
            this.db.exec("BEGIN IMMEDIATE");
            checkSource();
            if (this.hooks.schemaIn(this.db) !== schema) throw new Error("Database changed during admission");
            const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
            try { this.hooks.schemaIn(snapshot); this.hooks.verifyMigrationSnapshot(this.db, snapshot); }
            finally { snapshot.close(); }
            checkSource();
            backupOutage = backupBeforeMigration(snapshotPath, backupDir ?? backupDirForDataDir(dirname(path)), { sourcePath: path, sourceFd });
            // Bounded: one private directory holding the migration snapshot file and
            // its verification copy, removed from the synchronous admission path.
            // The unbounded trees (checkouts) go through `removeTree` instead
            // (nucleus#1179).
          } finally { rmSync(privateDir, { recursive: true, force: true }); }
        }
        checkSource();
        this.db.exec(FRESH_STORE_SCHEMA);
        this.db.exec(`DROP TABLE IF EXISTS brief_drafts;
          DROP TABLE IF EXISTS shadow_stream;
          DROP INDEX IF EXISTS runs_identity_agent;
          DROP INDEX IF EXISTS runs_identity_workspace;
          DELETE FROM meta WHERE value='null'
            OR key GLOB 'threadArchiveProbe:*'
            OR key GLOB 'shadowStream*'
            OR key GLOB 'originNotificationTransfer:*'
            OR key IN ('capacityAuthorityFacts','hostRunEnvFileRedaction','host_run_env_redaction','legacyPapercutSourceEvidence','legacyHostSelectionOperations','legacyHostSelectionTasks');`);
        this.core.setMeta('hostSelectionMigrationV1', true);
        // Schema 52 (task 987): the retention windows for rows that outlived their task or run.
        // The same rules run daily, so the one-time backlog and the steady state are one rule set.
        this.hooks.retention.pruneRetainedRows(Date.now());
        this.hooks.migration.migrateLeanReceiptsAndArchives();
        // Schema 55 (task 1005): the revocation marker on existing credential rows.
        this.hooks.migration.migrateRevocableCredentials();
        // Schema 54 (task 989): the retired row fields and the creation-step events are
        // stripped by `stripRetiredRowFields` on every open below, so the migration backlog
        // and any row an older build wrote are one rule set.
        if (schema < 55) {
          this.db.exec("DROP TRIGGER IF EXISTS outcomes_fts_insert; DROP TRIGGER IF EXISTS outcomes_fts_delete; DROP TRIGGER IF EXISTS outcomes_fts_update; DROP TABLE IF EXISTS outcomes_fts; DROP VIEW IF EXISTS outcome_search_content; DROP VIEW IF EXISTS lead_read;");
          this.createOutcomeSearchIndex();
          this.createLeadReadView();
          const tasks = this.db.prepare("SELECT data FROM tasks").all()
            .map(row => this.hooks.numberedTask(String(row.data)));
          for (const task of tasks)
            this.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(this.hooks.taskRow(task, task), task.id);
          for (const row of this.db.prepare("SELECT taskId,seq,data FROM task_reviews").all()) {
            const value = JSON.parse(String(row.data));
            this.db.prepare("UPDATE task_reviews SET data=? WHERE taskId=? AND seq=?")
              .run(JSON.stringify(this.hooks.storedReviewValue(value)), String(row.taskId), Number(row.seq));
          }
          this.db.exec("DROP TABLE IF EXISTS task_texts");
          this.db.exec(`UPDATE leads SET data=json_remove(data,'$.body')
            WHERE json_type(data,'$.body')='text' AND json_extract(data,'$.body') IS
              (SELECT json_extract(v.data,'$.body') FROM lead_versions v
               WHERE v.leadId=leads.id AND v.version=json_extract(leads.data,'$.version'))`);
          this.db.exec("INSERT INTO outcomes_fts(outcomes_fts) VALUES ('rebuild')");
        }
        if (schema < 57) {
          if (!this.db.prepare("PRAGMA table_info(projection_clock)").all().some(row => row.name === "board_version"))
            this.db.exec("ALTER TABLE projection_clock ADD COLUMN board_version INTEGER NOT NULL DEFAULT 0");
          this.db.prepare("INSERT INTO projection_clock(name,version,board_version) VALUES('publication',?,?) ON CONFLICT(name) DO UPDATE SET version=MAX(version,excluded.version),board_version=MAX(board_version,excluded.board_version)")
            .run(this.core.getMeta<number>("telemetryRevision") ?? 0, this.core.getMeta<number>("boardRevision") ?? 0);
          this.core.deleteMeta("telemetryRevision"); this.core.deleteMeta("boardRevision");
        }
        this.core.setMeta("schema", CURRENT_SCHEMA);
      }
      checkSource();
      // The retired per-repository validation policy and the By request pool fields are
      // stripped on every open, so rows written by an older build parse the current schema.
      this.hooks.migration.stripRetiredRepositoryPolicy();
      this.hooks.migration.stripRetiredPoolFields();
      // Task 1158: stored profiles move to the canonical vocabulary once; a
      // profile with a value the migration doesn't know stays as stored and is
      // reported in the record.
      this.hooks.migration.migrateProfileVocabulary();
      // Schema 54 (task 989): the retired row fields and the workspace creation-step
      // events go. The strip runs on every open so rows a rolled-back build wrote
      // during its window parse the current strict schema, exactly like the
      // validation-policy strip above; on a clean store it scans and changes nothing
      // (about 190 ms at the live store's size).
      this.hooks.migration.stripRetiredRowFields();
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      this.db.close();
      if (sourceFd !== null) closeSync(sourceFd);
      throw error;
    }
    if (sourceFd !== null) { try { fchmodSync(sourceFd, 0o600); } finally { closeSync(sourceFd); } }
    else if (!memory) chmodSync(path, 0o600);
    if (fresh) this.db.exec("PRAGMA locking_mode=NORMAL");
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}; PRAGMA cache_size=-${CACHE_SIZE_KIB};`);
    // Every lookup the store serves, from the one schema source. Additive, so an older build
    // reads none of it and rollback stays safe.
    this.db.exec(STORE_OPEN_DDL);
    // Spec 058 rollout step 3 (task 621): a delivery intent an earlier build recorded wrongly
    // is fenced before anything reads it.
    this.hooks.migration.fenceLegacyMessageDelivery();
    // Preserve prior status on every failed startup; the outage is advisory after
    // the admitted store has finished its ordinary initialization.
    if (backupOutage !== null) { try { recordBackupOutage(dirname(path), backupOutage); } catch { /* store is already initialized */ } }
  }

  /**
   * Spec 028 revision "Store compaction" (audit B9): the store's write funnels are
   * closed for one bounded maintenance window. This is service-local: it never writes
   * the operator's `paused` key and never changes dispatch policy, so pausing Queue is
   * still the operator's own action and a maintenance window neither sets nor clears it.
   *
   * The window is entered only by service code that has already drained its own work and
   * that performs the conversion in one synchronous turn, so no caller can be writing at
   * the moment it opens. The funnels below refuse a new write anyway, and the conversion
   * itself proves no other connection holds a lock (an exclusive lock probe) before it
   * touches the file: a busy store fails before anything is changed.
   */
  beginMaintenanceWindow(): void {
    if (this.core.maintenanceOpen) throw new StoreMaintenanceError("A store maintenance window is already open");
    if (this.db.isTransaction) throw new StoreMaintenanceError("Cannot start store maintenance from inside an open transaction");
    this.core.maintenanceOpen = true;
  }

  /** Release the window's write funnels; the window's own writes are all committed. */
  endMaintenanceWindow(): void { this.core.maintenanceOpen = false; }

  /** External content keeps searchable text only in the permanent outcome row. */
  createOutcomeSearchIndex(): void { this.db.exec(OUTCOME_SEARCH_INDEX_SQL); }

  /** Resolve the current body from its version unless it has independent bytes. */
  createLeadReadView(): void { this.db.exec(LEAD_READ_VIEW_SQL); }
}
