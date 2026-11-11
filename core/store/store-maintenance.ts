import { createHash } from "node:crypto";
import { chmodSync,closeSync,existsSync,fchmodSync,fstatSync,mkdirSync,mkdtempSync,openSync,rmSync,statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname,join } from "node:path";
import { DatabaseSync,type SQLInputValue } from "node:sqlite";
import { taskReferenceSchema,withoutRetiredPoolFields,type Notice,type Run,type Task } from "../../shared/contracts";
import { type HookRecord } from "../../shared/hooks";
import { backupBeforeMigration,backupDirForDataDir,recordBackupOutage } from "./backups";
import { hookRetentionBlocksPurge } from "../hooks/hook-retention";
import { digest,HOST_RUN_SELECTOR,qualifiedThreadArchiveEffectKey,StoreCore,StoreMaintenanceError } from "./store-core";
import { FRESH_STORE_SCHEMA } from "./store-schema";
import type { StoreTasks } from "./store-tasks";

/** Task control outcomes are kept 30 days. */
export const VERB_OUTCOME_RETENTION_MS = 30 * 86_400_000;

/**
 * Lean store 2 (task 987; Tom, 2026-11-09: "30 days / latest 50"). Finished operations of a
 * purged task, and settled project and lane notices and events, keep 30 days. The latest 50
 * settled host runs per selector and the latest 50 QA runs per repository keep their rows;
 * unsettled rows and rows a live row still points at are never pruned by these windows.
 */
const RETAINED_ROW_MS = 30 * 86_400_000;

export const HOST_RUN_KEEP_PER_SELECTOR = 50;

export const PROJECT_QA_KEEP_PER_REPOSITORY = 50;

/** The assignment history the profile picker reads (`recentCounts`). */
export const ASSIGNMENT_HISTORY_KEEP = 50;

/** Count of rows each window removed in one pass (for the record and the tests). */
export interface RetainedRowPrune {
  operations: number; checkPolicyObservations: number; notices: number; events: number; qaScheduleMerges: number;
  hostRuns: number; hostRunSidecars: number; projectQaRuns: number; hostRunOutputFailures: number; assignmentHistory: number;
}


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

/** Auto-vacuum modes as `PRAGMA auto_vacuum` reports them. */
export const AUTO_VACUUM_NONE = 0, AUTO_VACUUM_INCREMENTAL = 2;

/** The durable one-shot compaction record and the last bounded reclamation record (Queue-internal meta). */
export const STORE_COMPACTION_META_KEY = "storeCompaction";

export const STORE_MAINTENANCE_META_KEY = "storeMaintenance";

/** The last page release that failed, with its time and reason (task 987). */
const STORE_MAINTENANCE_ERROR_META_KEY = "storeMaintenanceError";

/**
 * A freed-page pass releases at most this many pages, in chunks, inside this time budget.
 *
 * Task 987: a chunk is one short write transaction, so it holds the writer for a fraction of the
 * time a whole pass does. At 250 ms a pass stopped after two 512-page chunks (about 8 MB), so the
 * freelist left by a prune drained over a dozen hourly ticks; 1 s clears up to 16 MB a tick.
 */
export const RECLAIM_MAX_PAGES = 4096, RECLAIM_CHUNK_PAGES = 256, RECLAIM_BUDGET_MS = 1000;

/**
 * Lean store 4 (task 989): the release drain for a large freelist. While free pages exceed the
 * threshold, every maintenance tick (the 20 s engine sweep) runs one bounded pass, so a freelist
 * the size of a prune's backlog drains in minutes instead of the days the hourly-only passes
 * took (about 6 pages a minute after task 987 rolled). Below the threshold only the passes
 * after the hourly and daily prunes release, so an idle store is not touched every sweep.
 * Sized from a measured live-equivalent copy: a 256-page chunk takes about 40–90 ms, so a 2 s
 * budget clears several thousand pages a tick and 30k pages in well under an hour.
 */
export const RECLAIM_DRAIN_FREE_PAGES = 4096, RECLAIM_DRAIN_MAX_PAGES = 8192, RECLAIM_DRAIN_BUDGET_MS = 2000;

/** The store's own file and page facts: what compaction decisions and records are made from. */
export interface StoreFacts {
  fileBytes: number; walBytes: number; pageSize: number; pageCount: number; freePages: number; autoVacuum: number;
}

/** One table's contribution to `Store.contentFingerprint()`: logical rows, exact stored bytes and an order-independent row digest. */
interface ContentTableDigest { table: string; rows: number; bytes: number; sum: string; xor: string; digest: string }

/** The whole store's canonical content digest (Spec 028 revision "truthful preservation"). */
export interface ContentFingerprint { digest: string; rows: number; bytes: number; tables: number; ms: number }

/** The 64-bit accumulation mask used to combine row hashes order-independently. */
const MASK64 = (BigInt(1) << BigInt(64)) - BigInt(1);

/**
 * One table's canonical content digest: every column value of every row, hashed from its exact
 * stored bytes, combined as count + 64-bit sum + 64-bit xor so row order and rowid are not part
 * of the answer but multiplicity, content and stored width are.
 */
function contentTableDigest(db: DatabaseSync, table: string): ContentTableDigest {
  const names = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => String(column.name));
  const statement = db.prepare(`SELECT ${names.length ? names.map(name => `"${name}"`).join(",") : "1 AS empty"} FROM "${table}"`);
  let rows = 0, bytes = 0, sum = BigInt(0), xor = BigInt(0);
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    const hash = createHash("sha256");
    for (const name of names) {
      const encoded = encodeStoredValue(row[name]);
      hash.update(encoded); bytes += encoded.length;
    }
    const value = hash.digest().readBigUInt64BE(0);
    sum = (sum + value) & MASK64; xor ^= value; rows++;
  }
  return { table, rows, bytes, sum: sum.toString(16), xor: xor.toString(16),
    digest: digest(JSON.stringify([table, rows, sum.toString(16), xor.toString(16)])) };
}

/**
 * A stored value's exact bytes with a type tag and its length, so two values of different type
 * or different length can never encode alike, and a same-length edit always differs. Text is
 * hashed as its UTF-8 bytes (what SQLite stores and returns), a blob as its bytes, an integer
 * or real as its exact SQLite text form, and NULL as its own tag.
 */
function encodeStoredValue(value: unknown): Buffer {
  if (value === null || value === undefined) return Buffer.from("n", "latin1");
  if (typeof value === "string") { const body = Buffer.from(value, "utf8"); return Buffer.concat([Buffer.from(`s${body.length}:`, "latin1"), body]); }
  if (typeof value === "number" || typeof value === "bigint") { const text = String(value); return Buffer.from(`i${text.length}:${text}`, "latin1"); }
  if (value instanceof Uint8Array) { const body = Buffer.from(value); return Buffer.concat([Buffer.from(`b${body.length}:`, "latin1"), body]); }
  const text = String(value); return Buffer.from(`u${text.length}:${text}`, "latin1");
}

/** One bounded freed-page reclamation pass (Spec 028: free pages after the prune passes). */
export interface ReclaimResult {
  pages: number; freePagesBefore: number; freePagesAfter: number;
  fileBytesBefore: number; fileBytesAfter: number; durationMs: number;
  /** Why this pass did nothing, or null when it reclaimed (or found nothing to reclaim). */
  skipped: string | null; error: string | null;
}


export const HISTORY_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;

/** How long a finished task's history (task, events, runs) is kept before purge (Spec 018; Tom, 2026-10-20: "4 days for queue", from 14). */
const TASK_HISTORY_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;

interface StoreMaintenanceAccess {
  storedSchema(path: string, checkIntegrity?: boolean): number | undefined;
  schemaIn(db: DatabaseSync, checkIntegrity?: boolean): number;
  verifyMigrationSnapshot(source: DatabaseSync, snapshot: DatabaseSync): void;
  db: DatabaseSync;
  setMeta: (key: string, value: unknown) => void;
  numberedTask: (data: string) => Task;
  taskRow: (task: Task, before?: Task | null) => string;
  storedReviewValue: (value: unknown) => unknown;
  getMeta: <T>(key: string) => T | undefined;
  deleteMeta: (key: string) => void;
  transaction: <T>(fn: () => T) => T;
  maintenanceOpen: boolean;
  path: string;
  runs: (taskId?: string) => Run[];
  hookEvents: (taskId?: string) => HookRecord[];
  deleteCredential: (run: string) => void;
  lastEventAtByTask: Map<string, string> | null;
  tasksStore: StoreTasks;
  cachedTaskCount: number | null;
  advanceRevision: () => void;
  taskChanged: (taskId: string | null) => void;
  notices: (taskId?: string) => Notice[];
}

export class StoreMaintenance {
  constructor(private readonly core: StoreCore, private readonly access: StoreMaintenanceAccess) {}
  private get db() { return this.access.db; }
  private get setMeta() { return this.access.setMeta; }
  private get numberedTask() { return this.access.numberedTask; }
  private get taskRow() { return this.access.taskRow; }
  private get storedReviewValue() { return this.access.storedReviewValue; }
  private get getMeta() { return this.access.getMeta; }
  private get deleteMeta() { return this.access.deleteMeta; }
  private get transaction() { return this.access.transaction; }
  private get maintenanceOpen() { return this.access.maintenanceOpen; }
  private set maintenanceOpen(value: boolean) { this.core.maintenanceOpen = value; }
  private get path() { return this.access.path; }
  private get runs() { return this.access.runs; }
  private get hookEvents() { return this.access.hookEvents; }
  private get deleteCredential() { return this.access.deleteCredential; }
  private get lastEventAtByTask() { return this.access.lastEventAtByTask; }
  private set lastEventAtByTask(value: Map<string, string> | null) { this.access.lastEventAtByTask = value; }
  private get tasksStore() { return this.access.tasksStore; }
  private get cachedTaskCount() { return this.access.cachedTaskCount; }
  private set cachedTaskCount(value: number | null) { this.access.cachedTaskCount = value; }
  private get advanceRevision() { return this.access.advanceRevision; }
  private get taskChanged() { return this.access.taskChanged; }
  private get notices() { return this.access.notices; }

  /** Read the schema under SQLite's native snapshot, including committed WAL. */
  static storedSchema(path: string, checkIntegrity = true): number | undefined {
    if (path === ":memory:" || !existsSync(path)) return undefined;
    if (statSync(path).size === 0) return undefined;
    const db = new DatabaseSync(path, { readOnly: true });
    try { return StoreMaintenance.schemaIn(db, checkIntegrity); } finally { db.close(); }
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
    if (!fresh) this.access.storedSchema(path, false);
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
      const schema = fresh ? undefined : this.access.schemaIn(this.db);
      if (fresh) {
        if (this.db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get()) throw new Error("Database changed during admission");
        // Keep exclusive custody while setting the fresh database vacuum mode.
        this.db.exec("PRAGMA locking_mode=EXCLUSIVE; COMMIT; PRAGMA auto_vacuum=INCREMENTAL; VACUUM; BEGIN IMMEDIATE");
        this.db.exec(FRESH_STORE_SCHEMA);
        this.createOutcomeSearchIndex();
        this.createLeadReadView();
        this.setMeta("schema", CURRENT_SCHEMA); this.setMeta("paused", true); this.setMeta("pool", []);
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
            if (this.access.schemaIn(this.db) !== schema) throw new Error("Database changed during admission");
            const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
            try { this.access.schemaIn(snapshot); this.access.verifyMigrationSnapshot(this.db, snapshot); }
            finally { snapshot.close(); }
            checkSource();
            backupOutage = backupBeforeMigration(snapshotPath, backupDir ?? backupDirForDataDir(dirname(path)), { sourcePath: path, sourceFd });
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
        this.setMeta('hostSelectionMigrationV1', true);
        // Schema 52 (task 987): the retention windows for rows that outlived their task or run.
        // The same rules run daily, so the one-time backlog and the steady state are one rule set.
        this.pruneRetainedRows(Date.now());
        this.migrateLeanReceiptsAndArchives();
        // Schema 55 (task 1005): the revocation marker on existing credential rows.
        this.migrateRevocableCredentials();
        // Schema 54 (task 989): the retired row fields and the creation-step events are
        // stripped by `stripRetiredRowFields` on every open below, so the migration backlog
        // and any row an older build wrote are one rule set.
        if (schema < 55) {
          this.db.exec("DROP TRIGGER IF EXISTS outcomes_fts_insert; DROP TRIGGER IF EXISTS outcomes_fts_delete; DROP TRIGGER IF EXISTS outcomes_fts_update; DROP TABLE IF EXISTS outcomes_fts; DROP VIEW IF EXISTS outcome_search_content; DROP VIEW IF EXISTS lead_read;");
          this.createOutcomeSearchIndex();
          this.createLeadReadView();
          const tasks = this.db.prepare("SELECT data FROM tasks").all()
            .map(row => this.numberedTask(String(row.data)));
          for (const task of tasks)
            this.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(this.taskRow(task, task), task.id);
          for (const row of this.db.prepare("SELECT taskId,seq,data FROM task_reviews").all()) {
            const value = JSON.parse(String(row.data));
            this.db.prepare("UPDATE task_reviews SET data=? WHERE taskId=? AND seq=?")
              .run(JSON.stringify(this.storedReviewValue(value)), String(row.taskId), Number(row.seq));
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
            .run(this.getMeta<number>("telemetryRevision") ?? 0, this.getMeta<number>("boardRevision") ?? 0);
          this.deleteMeta("telemetryRevision"); this.deleteMeta("boardRevision");
        }
        this.setMeta("schema", CURRENT_SCHEMA);
      }
      checkSource();
      // Task 985: the per-repository validation policy is retired (Tom, 2026-11-09);
      // the values are archived outside the store. Strip stored copies on every open
      // so rows written by an older build parse the current schema, and drop the
      // retired Nucleus-wide default.
      this.db.exec("UPDATE repository_settings SET data=json_remove(data,'$.validationPolicy') WHERE json_type(data,'$.validationPolicy') IS NOT NULL");
      this.db.exec("DELETE FROM meta WHERE key='defaultValidationPolicy'");
      // Task 1002: By request is retired (Tom, 2026-11-09) and capability `very_low`
      // reads as `low`. Strip the stored flags on every open, idempotently.
      this.stripRetiredPoolFields();
      // Schema 54 (task 989): the retired row fields and the workspace creation-step
      // events go. The strip runs on every open so rows a rolled-back build wrote
      // during its window parse the current strict schema, exactly like the
      // validation-policy strip above; on a clean store it scans and changes nothing
      // (about 190 ms at the live store's size).
      this.stripRetiredRowFields();
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
    // Audit A7: host-run history reads by selector (admission budgets) instead of
    // parsing the whole growing table. Additive like the lookups below; no stored
    // row, schema version or export shape changes, so an older build reads none of
    // it and rollback is safe. The indexed expression reads only well-formed rows:
    // a bare json_extract index aborted every write of an undecodable row and would
    // stop the store opening over one, where such a row must list as unreadable.
    this.db.exec(`DROP INDEX IF EXISTS host_run_records_selector;
      CREATE INDEX IF NOT EXISTS host_run_records_valid_selector ON host_run_records(${HOST_RUN_SELECTOR})`);
    for (const field of ["key", "repository.origin", "repository.path"]) {
      const expression = `lower(json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.${field}'))`;
      this.db.exec(`CREATE INDEX IF NOT EXISTS qa_budget_${field.replaceAll('.', '_')} ON project_qa_runs(${expression})`);
    }
    // Additive lookup indexes: existing records and schema-12 rollback remain intact.
    this.db.exec(`CREATE INDEX IF NOT EXISTS events_task ON events(taskId);
      CREATE INDEX IF NOT EXISTS events_paused_resume ON events(at,json_extract(detail,'$.agentId')) WHERE kind='paused_resume';
      CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId);
      CREATE INDEX IF NOT EXISTS notices_task ON notices(taskId);
      -- Audit B10: the board's unsettled-notice count and the audit pass's pending
      -- read were both SCANs over notices through json_extract.
      CREATE INDEX IF NOT EXISTS notices_status ON notices(json_extract(data,'$.status'));
      -- Audit B10: an absence proof looks a submission up by its stored identity, so that
      -- branch of its OR is an index search instead of a scan of settled history.
      CREATE INDEX IF NOT EXISTS operations_submission ON operations(json_extract(data,'$.submissionId'));
      -- Audit B7: one row per (lead, lane), maintained by the lead write funnels, so the
      -- board's lane activity read no longer runs json_each over every retained lead body.
      CREATE INDEX IF NOT EXISTS lead_lane_index_lane ON lead_lane_index(lane);`);
    // Spec 058 rollout step 3 (task 621): worker-to-worker messages. Additive like the
    // lookup indexes above — no stored row, schema version or export shape changes, so an
    // older build reads none of it and rollback is safe.
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_messages(id TEXT PRIMARY KEY, fromTaskId TEXT NOT NULL, toTaskId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_messages_to ON task_messages(toTaskId);
      CREATE INDEX IF NOT EXISTS task_messages_queued ON task_messages(json_extract(data,'$.status'));
      CREATE TRIGGER IF NOT EXISTS task_message_intent_guard BEFORE UPDATE ON task_messages
      WHEN json_type(OLD.data,'$.deliveryIntentAt')='text' AND
        (json_type(NEW.data,'$.deliveryIntentAt') IS NOT 'text' OR
         json_extract(NEW.data,'$.deliveryHostId') IS NOT json_extract(OLD.data,'$.deliveryHostId') OR
         (json_extract(OLD.data,'$.status')='uncertain' AND json_extract(NEW.data,'$.status')='queued'
          AND json_extract(NEW.data,'$.deliveryIntentState') IS NOT 'refused'))
      BEGIN SELECT RAISE(ABORT,'message delivery intent cannot be removed or moved'); END;`);
    // Earlier builds recorded a live recipient as "delivered" before sending,
    // and left failed sends queued. Either shape may have crossed the boundary.
    // Fence those rows without changing their IDs or historical events.
    this.transaction(() => {
      this.db.exec(`UPDATE task_messages SET data=json_patch(json_set(data,'$.status','uncertain',
        '$.deliveryIntentAt',json_extract(data,'$.createdAt'),'$.deliveryIntentState','intent'),
        CASE WHEN EXISTS (SELECT 1 FROM tasks WHERE tasks.id=task_messages.toTaskId AND length(json_extract(tasks.data,'$.hostId'))>0)
          THEN json_object('deliveryHostId',(SELECT json_extract(tasks.data,'$.hostId') FROM tasks WHERE tasks.id=task_messages.toTaskId))
          ELSE '{}' END)
        WHERE json_extract(data,'$.status')='queued' AND json_type(data,'$.deliveryIntentAt') IS NULL
          AND (json_extract(data,'$.error') LIKE 'delivery failed:%' OR EXISTS (
            SELECT 1 FROM events WHERE events.taskId=task_messages.fromTaskId AND events.kind='agent_message_sent'
              AND instr(events.detail,task_messages.id || ':')=1 AND events.detail LIKE '%; delivered'))`);
    });
    // Expression indexes stay transactionally current without another identity cache.
    for (const [name, path] of [
      ['agent','agentId'], ['coordinator','coordinatorAgentId'], ['reviewer','resolution.reviewerAgentId'],
      ['workspace','workspaceId'], ['coordinator_workspace','resolution.coordinatorWorkspaceId'], ['closeout_workspace','resolution.closeoutWorkspaceId'],
    ]) this.db.exec(`CREATE INDEX IF NOT EXISTS tasks_identity_${name} ON tasks(json_extract(data,'$.${path}')) WHERE json_extract(data,'$.removedAt') IS NULL`);
    for (const [name, path] of [['agent','agentId'], ['workspace','workspaceId']]) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS runs_identity_${name}_host ON runs(json_extract(data,'$.${path}'),taskId,json_extract(data,'$.hostId'))`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS tasks_retired_identity ON tasks(id)
      WHERE json_extract(data,'$.removedAt') IS NULL AND json_array_length(data,'$.retiredWorkers')>0`);
    // The lane-view clock: every table a lane view derives from, and no other. The plan read
    // clock (`plans`) covers the retained plan versions the Done band derives from; no plan
    // read is cached against `writes`, and both are additive like the indexes above — an older
    // build never reads either row and its own `writes` row is untouched, so rollback is safe.
    this.db.exec(([
      ["tasks", ["laneViews"]], ["lanes", ["laneViews"]], ["leads", ["laneViews"]],
      ["events", ["laneViews", "eventRows"]], ["outcomes", ["laneViews", "outcomeRows"]], ["project_plans", ["plans", "planInputs"]],
      // The board's per-domain read keys (`planningRevisions()`): open decisions follow their
      // own table, and the plan read follows every table it derives from.
      ["decisions", ["decisionRows"]], ["lanes", ["planInputs"]], ["projects", ["planInputs", "projects"]],
    ] as Array<[string, string[]]>).flatMap(([table, clocks]) => ["INSERT", "UPDATE", "DELETE"].flatMap(operation => clocks.map(clock =>
      `CREATE TRIGGER IF NOT EXISTS ${table}_${clock}_clock_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
        INSERT INTO projection_clock(name,version) VALUES('${clock}',1) ON CONFLICT(name) DO UPDATE SET version=version+1;
      END;`))).join("\n"));

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
    if (this.maintenanceOpen) throw new StoreMaintenanceError("A store maintenance window is already open");
    if (this.db.isTransaction) throw new StoreMaintenanceError("Cannot start store maintenance from inside an open transaction");
    this.maintenanceOpen = true;
  }

  /** Release the window's write funnels; the window's own writes are all committed. */
  endMaintenanceWindow(): void { this.maintenanceOpen = false; }

  /** True while a bounded maintenance window holds the write funnels closed. */
  get maintenance(): boolean { return this.maintenanceOpen; }

  /** The store's auto-vacuum mode as SQLite reports it (0 none, 2 incremental). */
  autoVacuumMode(): number {
    return Number((this.db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined)?.auto_vacuum ?? AUTO_VACUUM_NONE);
  }

  /** True when the file holds no table yet: the only moment SQLite accepts an auto-vacuum mode. */
  /** The store's file and page facts, from one stat and three cheap pragmas. */
  storeFacts(): StoreFacts {
    const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
    const page = (name: string) => Number((this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined)?.[name] ?? 0);
    return {
      fileBytes: this.path === ":memory:" ? 0 : size(this.path),
      walBytes: this.path === ":memory:" ? 0 : size(`${this.path}-wal`),
      pageSize: page("page_size"), pageCount: page("page_count"), freePages: page("freelist_count"),
      autoVacuum: this.autoVacuumMode(),
    };
  }

  /**
   * Spec 028 revision "truthful preservation": the canonical content digest of the store's
   * authoritative logical rows and settings.
   *
   * Every column value of every row of every authoritative table is hashed from its exact
   * stored bytes, and one table's rows are combined order-independently, so a digest is a
   * function of the stored content alone: a rewrite that moves pages, changes rowids or
   * reorders rows leaves it identical, and a same-length edit inside a value changes it. The
   * per-table combination is a count plus the sum and xor of the row hashes (64-bit), so
   * duplicate rows still count and the read needs no sort, no temp file and bounded memory.
   *
   * Excluded, with the reason: SQLite's own `sqlite_*` bookkeeping (`sqlite_sequence` holds an
   * AUTOINCREMENT high-water mark derived from the rows, and the other `sqlite_*` names are
   * internal); FTS5's shadow tables (`<fts>_data`, `_idx`, `_content`, `_docsize`, `_config`),
   * whose page and segment layout is the index's representation of the text the virtual table
   * itself returns, so the virtual table's own logical rows are hashed instead; and this
   * module's own two maintenance records in `meta`, which change around the window by design.
   * Every other table, and every other `meta` row (pause, limits, pool, availability, usage,
   * retention marks, every Queue-internal fact), is hashed exactly.
   */
  contentFingerprint(): ContentFingerprint {
    const started = performance.now();
    const internal = new Set([STORE_COMPACTION_META_KEY, STORE_MAINTENANCE_META_KEY]);
    const tableRows = this.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    const virtualTables = tableRows.filter(row => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(row.sql ?? ""))).map(row => String(row.name));
    const shadow = new Set(virtualTables.flatMap(name => ["data", "idx", "content", "docsize", "config"].map(suffix => `${name}_${suffix}`)));
    const tables: ContentTableDigest[] = [];
    let rows = 0, bytes = 0;
    for (const { name } of tableRows) {
      // `meta` is hashed row by row below so this module's own two records can be left out.
      if (shadow.has(name) || name === "meta") continue;
      const digest = contentTableDigest(this.db, name);
      tables.push(digest);
      rows += digest.rows; bytes += digest.bytes;
    }
    // `meta` is hashed row by row rather than as a table so this module's own records can be
    // left out; every other key is a setting or a Queue-internal fact and is hashed exactly.
    const meta: Array<[string, string]> = [];
    for (const row of this.db.prepare("SELECT key,value FROM meta ORDER BY key").all() as Array<{ key: string; value: string }>) {
      const key = String(row.key);
      if (internal.has(key)) continue;
      const value = String(row.value);
      meta.push([key, digest(value)]);
      rows++; bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    }
    return { digest: digest(JSON.stringify({ schema: this.getMeta("schema") ?? null, tables, meta })), rows, bytes, tables: tables.length, ms: Math.round(performance.now() - started) };
  }

  /**
   * Spec 028: return freed pages after a prune pass, bounded rather than a full rewrite.
   *
   * Incremental auto-vacuum keeps deleted pages on the store's freelist; this asks SQLite to
   * release at most `maxPages` of them, in chunks, and stops after `budgetMs`, so an hourly or
   * daily prune pays one short write pass instead of an unbounded writer stall. `pages` is what
   * the file actually gave back (a truncation can take a few pages more than the chunk it was
   * asked for). The WAL is then checkpointed to `journal_size_limit`. A pass that finds nothing
   * to reclaim writes nothing, so an idle store is not rewritten every hour.
   */
  reclaimFreedPages(options: { maxPages?: number; budgetMs?: number } = {}): ReclaimResult {
    const started = performance.now();
    const before = this.storeFacts();
    const result: ReclaimResult = { pages: 0, freePagesBefore: before.freePages, freePagesAfter: before.freePages,
      fileBytesBefore: before.fileBytes, fileBytesAfter: before.fileBytes, durationMs: 0, skipped: null, error: null };
    const finish = () => { result.durationMs = Math.round(performance.now() - started); return result; };
    if (this.maintenanceOpen) { result.skipped = "a maintenance window is open"; return finish(); }
    if (before.autoVacuum !== AUTO_VACUUM_INCREMENTAL) { result.skipped = `the store is not in incremental auto-vacuum (mode ${before.autoVacuum})`; return finish(); }
    if (before.freePages === 0) { result.skipped = "no free pages"; return finish(); }
    const maxPages = Math.max(1, Math.trunc(options.maxPages ?? RECLAIM_MAX_PAGES));
    const budgetMs = Math.max(1, options.budgetMs ?? RECLAIM_BUDGET_MS);
    try {
      let remaining = Math.min(before.freePages, maxPages);
      for (let pass = 0; remaining > 0 && performance.now() - started < budgetMs && pass < maxPages; pass++) {
        const free = this.storeFacts().freePages;
        if (free === 0) break;
        const chunk = Math.min(remaining, RECLAIM_CHUNK_PAGES, free);
        this.transaction(() => this.db.exec(`PRAGMA incremental_vacuum(${chunk})`));
        remaining -= chunk;
        // A freelist whose pages cannot be released from the end stops the pass; the next
        // pass retries with the same bound instead of spinning here.
        if (this.storeFacts().freePages >= free) break;
      }
      // The WAL is bounded after the rewrite; a concurrent reader (a snapshot child) can
      // make the truncating checkpoint return busy, which leaves the file as it was.
      this.checkpointWal();
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
    const after = this.storeFacts();
    result.pages = Math.max(0, before.pageCount - after.pageCount);
    result.freePagesAfter = after.freePages;
    result.fileBytesAfter = after.fileBytes;
    // Task 987: a failed release is recorded, not only returned. The hourly and daily passes
    // ignore the result, so before this a refused pass left no trace on the live store.
    const durationMs = Math.round(performance.now() - started);
    if (result.pages > 0 && !result.error) {
      try { this.setMeta(STORE_MAINTENANCE_META_KEY, { at: new Date().toISOString(), pages: result.pages,
        freePagesBefore: result.freePagesBefore, freePagesAfter: result.freePagesAfter,
        fileBytesBefore: result.fileBytesBefore, fileBytesAfter: result.fileBytesAfter, durationMs }); }
      catch { /* the release still happened; the record is retried by the next pass */ }
    }
    if (result.error) { try { this.setMeta(STORE_MAINTENANCE_ERROR_META_KEY, { at: new Date().toISOString(), error: result.error }); } catch { /* the store refused the write too */ } }
    return finish();
  }

  /** One truncating WAL checkpoint; `busy` reports a reader that kept the WAL in place. */
  checkpointWal(): { busy: number; log: number; checkpointed: number } {
    const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number; log?: number; checkpointed?: number } | undefined;
    return { busy: Number(row?.busy ?? 0), log: Number(row?.log ?? 0), checkpointed: Number(row?.checkpointed ?? 0) };
  }

  purgeOldTasks(at=Date.now(),cleanupFiles?:(taskId:string,runIds:string[])=>void) {
    const cutoff=at-TASK_HISTORY_RETENTION_MS;
    const purged:string[]=[];
    this.transaction(()=>{
      for(const row of this.db.prepare("SELECT * FROM tasks").all()){
        // A schema-45 row names its text and observations by reference, so the read
        // resolves them exactly as every public read does.
        const task=this.numberedTask(String(row.data));
        const runs=this.runs(task.id);
        if(!this.retentionEligible(task,runs,cutoff))continue;
        // Audit B5: hook records carry the only proof of an isolated checkout's ownership,
        // so a task whose hook retention is not settled keeps its whole history. The
        // hourly reaper runs before the purge and marks the rows it settled; whatever is
        // left here still names a checkout that exists, or an execution whose ownership a
        // caller never proved, and neither may be deleted.
        const hooks=this.hookEvents(task.id);
        if(hooks.some(record=>hookRetentionBlocksPurge(record,existsSync)))continue;
        const runIds=[...new Set([task.runId,...task.retiredWorkers.map(w=>w.runId),...runs.map(r=>r.id)].filter((id):id is string=>Boolean(id)))];
        cleanupFiles?.(task.id,runIds);
        // Spec 043 (c) goal gate: the permanent outcome row keeps the merged task's
        // own record, but dependents read this host-local tombstone after retention.
        // Carry the goal-unmet fact so a purged prerequisite still never satisfies a
        // dependent. It stays out of the portable submissionTombstones export, whose
        // explicit field pick does not name it.
        this.db.prepare("INSERT INTO tombstones VALUES(?,?,?,?)").run(task.id,task.submissionId,String(row.input_hash),JSON.stringify({...taskReferenceSchema.parse(task),goalUnmet:task.resolution.goalUnmet??null,purgedAt:new Date(at).toISOString()}));
        for(const id of runIds){this.deleteCredential(id);this.db.prepare("DELETE FROM meta WHERE key=?").run(`reviewPublication:${id}`);}
        this.db.prepare("DELETE FROM meta WHERE key=?").run(`workspaceTitle:${task.id}`);
        // Lean store 2 (task 987): the task's own check-policy observation goes with it.
        this.db.prepare("DELETE FROM meta WHERE key=?").run(`checkPolicyObservation:${task.id}`);
        for(const table of ['events','runs','notices','hook_events','task_observations'])this.db.prepare(`DELETE FROM ${table} WHERE taskId=?`).run(task.id);
        this.db.prepare("DELETE FROM task_messages WHERE fromTaskId=? OR toTaskId=?").run(task.id,task.id);
        this.lastEventAtByTask?.delete(task.id);
        this.db.prepare("DELETE FROM receipts WHERE task=?").run(task.id);this.db.prepare("DELETE FROM task_brief_versions WHERE taskId=?").run(task.id);this.db.prepare("DELETE FROM task_reviews WHERE taskId=?").run(task.id);this.db.prepare("DELETE FROM tasks WHERE id=?").run(task.id);purged.push(task.id);
      }
      if (purged.length) this.pruneThreadArchiveKeys();
      this.setMeta('lastRetentionAt',at);
      // Purging deletes in bulk (and runs caller cleanup in between), so drop
      // the projection instead of tracking each row; the next read rebuilds.
      // Purges are rare and off the hot path.
      if (purged.length) this.tasksStore.invalidateProjections();
      if (purged.length) { this.cachedTaskCount=null; this.advanceRevision(); for (const id of purged) this.taskChanged(id); }
    });
    return purged;
  }

  /**
   * Audits B5: the tasks the next purge would delete, so the caller can reap their owned
   * hook checkouts first. This is the same retention fact the purge re-checks inside its
   * transaction; a task that changes in between simply keeps its history for one more pass.
   */
  retentionCandidates(at=Date.now()): Task[] {
    const cutoff=at-TASK_HISTORY_RETENTION_MS;
    const candidates:Task[]=[];
    for(const row of this.db.prepare("SELECT data FROM tasks ORDER BY rowid").all()){
      // Resolved exactly as a public read, so a schema-45 row's text and observation
      // references are never mistaken for missing task facts.
      const task=this.numberedTask(String(row.data));
      if(!this.retentionEligible(task,this.runs(task.id),cutoff))continue;
      candidates.push(task);
    }
    return candidates;
  }

  /** Shared settled-history rule; purge additionally waits for hook cleanup, which candidates feed. */
  retentionEligible(task: Task, runs: Run[], cutoff: number): boolean {
      if(!task.removedAt && (task.originError||task.originLookupError||!['done','cancelled'].includes(task.phase)))return false;
      const finished=task.removedAt??task.finishedAt??String(this.db.prepare("SELECT at FROM events WHERE taskId=? AND kind IN ('closed_out','cancel') ORDER BY id DESC LIMIT 1").get(task.id)?.at??task.updatedAt);
      if(!Number.isFinite(Date.parse(finished))||Date.parse(finished)>=cutoff)return false;
      if(runs.some(r=>!r.released)||task.resolution.archiveIntentWorkspaceId||task.resolution.mergeIntent&&!task.resolution.mergedCommit)return false;
      if(task.resolution.buildOutputCleanups.some(record=>record.state!=='complete'))return false;
      if(task.resolution.workspaceRetirement && task.resolution.workspaceRetirement.state!=='archived')return false;
      if(task.resolution.runtimeRetirements.some(record=>record.state==='pending'||record.state==='failed'))return false;
      if(task.resolution.externalWorkspaceArchives.some(record=>record.state==='intent'||record.state==='uncertain'))return false;
      if(!task.removedAt && task.phase==='done' && [task.reviewEntry?.preserveWorkspace ? null : task.workspaceId,task.resolution.closeoutWorkspaceId,...runs.filter(run=>run.reviewSourceView).map(run=>run.workspaceId)].some(id=>id&&!task.resolution.archivedWorkspaceIds.includes(id)))return false;
      if(this.notices(task.id).some(n=>['pending','intent','uncertain'].includes(n.status)))return false;
      return true;
  }

  /**
   * Unreleased runs of one agent on tasks that are not removed: the same rows as
   * `runs().filter(r => r.agentId === agentId && !r.released)`, without loading and
   * parsing every run. Thread archival asked that per released run on every pass and
   * stalled the runtime thread for up to 14 s on 7,134 runs (2026-10-03).
   */
  /**
   * Retention (Tom, 2026-10-16; 4 days since 2026-10-20): a settled host run's journal,
   * its internal CPU reason (meta `hostRunCpuCoverage:<runId>`) and its internal
   * admission identity (meta `hostRunIdentity:<runId>`) are kept
   * `HISTORY_RETENTION_MS`. Journal fact rows (`nested`, `override`,
   * `container_report`) stay regardless, because endpoint reconciliation and
   * container-report dedupe look them up by fact id. Bounded batches, yielding between
   * them so request handling interleaves.
   *
   */
  async pruneRetainedHistory(cutoff = new Date(Date.now() - HISTORY_RETENTION_MS).toISOString(), batch = 2000): Promise<{ journal: number }> {
    const drain = async (sql: string) => {
      let total = 0;
      for (;;) {
        const changes = this.transaction(() => Number(this.db.prepare(sql).run(cutoff, batch).changes));
        total += changes;
        if (changes < batch) return total;
        await new Promise(resolve => setImmediate(resolve));
      }
    };
    const journal = await drain(`DELETE FROM host_run_journal WHERE id IN (SELECT journal.id FROM host_run_journal AS journal
      JOIN host_run_records AS record ON record.id=journal.run_id
      WHERE record.state='settled' AND json_extract(record.data,'$.settledAt')<?
        AND journal.event NOT IN ('nested','override','container_report') LIMIT ?)`);
    // A settled run's internal CPU reason goes with its journal.
    await drain(`DELETE FROM meta WHERE key IN (SELECT meta.key FROM meta JOIN host_run_records AS record
      ON meta.key='hostRunCpuCoverage:' || record.id
      WHERE meta.key GLOB 'hostRunCpuCoverage:*' AND record.state='settled' AND json_extract(record.data,'$.settledAt')<? LIMIT ?)`);
    // So does its internal admission identity: the run is settled, so nothing
    // observes it any more. An older Queue never deletes this key, so a rollback
    // leaves it behind; the row itself stays readable either way.
    await drain(`DELETE FROM meta WHERE key IN (SELECT meta.key FROM meta JOIN host_run_records AS record
      ON meta.key='hostRunIdentity:' || record.id
      WHERE meta.key GLOB 'hostRunIdentity:*' AND record.state='settled' AND json_extract(record.data,'$.settledAt')<? LIMIT ?)`);
    return { journal };
  }

  /**
   * Lean store 2 (task 987): the retention windows for rows that outlive their task, run or
   * request. The caller owns the transaction (the schema-52 migration and the daily sweep both
   * run it inside one), and every rule is idempotent, so the one-time backlog and the steady
   * state are one rule set. Each rule names what it keeps:
   *
   * - finished (succeeded or failed) operations whose task is gone, 30 days after they settled;
   *   pending, running and needs-attention operations always stay;
   * - per-task meta (`checkPolicyObservation:<task>`) whose task is gone;
   * - settled (delivered or superseded) project and lane notices and project and lane events,
   *   30 days after they were made (a notice's time is the ISO stamp its id ends with);
   * - QA schedule merges only for repositories that have a schedule, so the backlog of an
   *   unscheduled repository is deleted and never refused by the 1,000-row guard;
   * - the latest 50 settled host runs per selector, except a run whose accounting retirement is
   *   still inside the history retention; a pruned run takes its identity, CPU and disposition
   *   sidecars and its retained-output failure with it;
   * - the latest 50 QA runs per repository, except active runs, the run a status row names, and
   *   the latest passing main run of each repository (the schedule's green reading);
   * - the assignment history the profile picker reads.
   */
  pruneRetainedRows(at: number): RetainedRowPrune {
    const changes = (sql: string, ...params: SQLInputValue[]) => Number(this.db.prepare(sql).run(...params).changes);
    const iso = (offsetMs: number) => new Date(at - offsetMs).toISOString();
    // Read raw: the migration runs before the schema-51 strip of retired repository fields is
    // applied, so the typed reader would refuse a row it is about to clean.
    const scheduled = (this.db.prepare(`SELECT COALESCE(json_extract(data,'$.repository.origin'),json_extract(data,'$.repository.path')) AS key
      FROM repository_settings WHERE json_type(data,'$.qa.schedule') NOT IN ('null') AND json_type(data,'$.qa.schedule') IS NOT NULL`).all() as Array<{ key: string | null }>)
      .flatMap(row => row.key ? [row.key] : []);
    const checkPolicyPrefix = "checkPolicyObservation:";
    const hostRunPrefixes = ["hostRunIdentity:", "hostRunCpuCoverage:", "hostRunAccountingDisposition:"];
    return {
      operations: changes(`DELETE FROM operations WHERE state IN ('succeeded','failed') AND taskId IS NOT NULL
        AND taskId NOT IN (SELECT id FROM tasks) AND COALESCE(json_extract(data,'$.settledAt'),createdAt) < ?`, iso(RETAINED_ROW_MS)),
      checkPolicyObservations: changes(`DELETE FROM meta WHERE key GLOB 'checkPolicyObservation:*'
        AND substr(key,?) NOT IN (SELECT id FROM tasks)`, checkPolicyPrefix.length + 1),
      notices: changes(`DELETE FROM notices WHERE (taskId LIKE 'lane:%' OR taskId LIKE 'project:%')
        AND json_extract(data,'$.status') IN ('delivered','superseded')
        AND id GLOB '*:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND substr(id,-24) < ?`, iso(RETAINED_ROW_MS)),
      events: changes(`DELETE FROM events WHERE (taskId LIKE 'lane:%' OR taskId LIKE 'project:%') AND at < ?`, iso(RETAINED_ROW_MS)),
      qaScheduleMerges: scheduled.length
        ? changes(`DELETE FROM qa_schedule_merges WHERE repository NOT IN (${scheduled.map(() => "?").join(",")})`, ...scheduled)
        : changes("DELETE FROM qa_schedule_merges"),
      hostRuns: changes(`DELETE FROM host_run_records WHERE state='settled' AND id IN (
          SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY selector ORDER BY rowid DESC) AS newest FROM (
            SELECT id, rowid, ${HOST_RUN_SELECTOR} AS selector FROM host_run_records WHERE state='settled' AND json_valid(data))
            WHERE selector IS NOT NULL)
          WHERE newest > ?)
        AND id NOT IN (SELECT substr(key,30) FROM meta WHERE key GLOB 'hostRunAccountingDisposition:*'
          AND CASE WHEN json_valid(value) THEN json_extract(value,'$.disposedAt') END >= ?)`, HOST_RUN_KEEP_PER_SELECTOR, iso(HISTORY_RETENTION_MS)),
      hostRunSidecars: changes(`DELETE FROM meta WHERE
        (key GLOB '${hostRunPrefixes[0]}*' AND substr(key,${hostRunPrefixes[0].length + 1}) NOT IN (SELECT id FROM host_run_records))
        OR (key GLOB '${hostRunPrefixes[1]}*' AND substr(key,${hostRunPrefixes[1].length + 1}) NOT IN (SELECT id FROM host_run_records))
        OR (key GLOB '${hostRunPrefixes[2]}*' AND substr(key,${hostRunPrefixes[2].length + 1}) NOT IN (SELECT id FROM host_run_records))`),
      projectQaRuns: changes(`DELETE FROM project_qa_runs WHERE rowid IN (
          SELECT rowid FROM (SELECT rowid, id, ROW_NUMBER() OVER (PARTITION BY repository ORDER BY rowid DESC) AS newest,
            json_extract(data,'$.state') AS state FROM project_qa_runs)
          WHERE newest > ? AND state NOT IN ('queued','running')
            AND id NOT IN (SELECT id FROM project_qa_latest)
            AND rowid NOT IN (SELECT MAX(rowid) FROM project_qa_runs
              WHERE json_extract(data,'$.baseBranch')='main' AND json_extract(data,'$.state')='passed' GROUP BY repository))`, PROJECT_QA_KEEP_PER_REPOSITORY),
      hostRunOutputFailures: changes("DELETE FROM host_run_output_failures WHERE runId NOT IN (SELECT id FROM host_run_records)"),
      assignmentHistory: changes("DELETE FROM assignment_history WHERE id NOT IN (SELECT id FROM assignment_history ORDER BY id DESC LIMIT ?)", ASSIGNMENT_HISTORY_KEEP),
    };
  }

  /** Collect host-qualified identities still represented by a retained task or run. */
  retainedArchiveKeys(): Set<string> {
    const keys = new Set<string>();
    const visit = (value: unknown, host: string) => {
      if (Array.isArray(value)) for (const item of value) visit(item, host);
      else if (value && typeof value === 'object') for (const [field, item] of Object.entries(value)) {
        if (/agentId$/i.test(field) && typeof item === 'string' && item) keys.add(qualifiedThreadArchiveEffectKey(host, item));
        else visit(item, host);
      }
    };
    for (const row of this.db.prepare("SELECT data FROM tasks").iterate()) {
      const task = JSON.parse(String(row.data));
      if (task.hostId) visit(task, task.hostId);
    }
    for (const row of this.db.prepare("SELECT r.data, json_extract(t.data,'$.hostId') AS taskHost FROM runs r JOIN tasks t ON t.id=r.taskId").iterate()) {
      const run = JSON.parse(String(row.data));
      const host = run.hostId || row.taskHost;
      if (typeof host === 'string' && host) visit(run, host);
    }
    return keys;
  }

  pruneThreadArchiveKeys(): void {
    const retained = this.retainedArchiveKeys();
    const remove = this.db.prepare("DELETE FROM meta WHERE key=?");
    for (const row of this.db.prepare("SELECT key FROM meta WHERE key GLOB 'threadArchiveQualified:*'").all())
      if (!retained.has(String(row.key))) remove.run(row.key);
    for (const row of this.db.prepare("SELECT key FROM meta WHERE key GLOB 'threadArchiveQualifiedProbe:*'").all()) {
      const effect = String(row.key).replace('threadArchiveQualifiedProbe:', 'threadArchiveQualified:');
      if (!retained.has(effect)) remove.run(row.key);
    }
    for (const row of this.db.prepare("SELECT key FROM meta WHERE key GLOB 'threadArchiveUnknownProbe:*'").all()) {
      const [taskId] = JSON.parse(String(row.key).slice('threadArchiveUnknownProbe:'.length));
      if (!this.db.prepare('SELECT 1 FROM tasks WHERE id=?').get(taskId)) remove.run(row.key);
    }
  }

  migrateLeanReceiptsAndArchives(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(receipts)').all().map(row => String(row.name)));
    if (!columns.has('report_hash')) this.db.exec('ALTER TABLE receipts ADD COLUMN report_hash TEXT');
    if (!columns.has('report_response')) this.db.exec('ALTER TABLE receipts ADD COLUMN report_response TEXT');
    const intent = this.db.prepare("INSERT INTO receipts(id,task,run,hash,response,report_hash) VALUES(?,?, '', '', '', ?) ON CONFLICT(id) DO UPDATE SET report_hash=excluded.report_hash");
    for (const row of this.db.prepare("SELECT key,value FROM meta WHERE key GLOB 'mcpReportIntent:*'").all()) {
      const value = JSON.parse(String(row.value));
      const hash = typeof value === 'string' ? value : value?.hash;
      if (hash) intent.run(String(row.key).slice('mcpReportIntent:'.length), typeof value === 'string' ? '' : value.taskId ?? '', hash);
    }
    const report = this.db.prepare("INSERT INTO receipts(id,task,run,hash,response,report_hash,report_response) VALUES(?, '', '', '', '', ?, ?) ON CONFLICT(id) DO UPDATE SET report_hash=coalesce(receipts.report_hash,excluded.report_hash),report_response=excluded.report_response");
    for (const row of this.db.prepare("SELECT key,value FROM meta WHERE key GLOB 'mcpReport:*'").all()) {
      const value = JSON.parse(String(row.value));
      report.run(String(row.key).slice('mcpReport:'.length), value.hash, JSON.stringify({hash:value.hash,response:value.response}));
    }
    const retained = this.retainedArchiveKeys();
    const host = this.getMeta<string>('hostId');
    if (host && !(this.getMeta<Array<{id:string}>>('hostRegistry') ?? []).length) this.setMeta('hostRegistry', [{id:host,endpoint:''}]);
    if (host) {
      const write = this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)');
      for (const row of this.db.prepare("SELECT key,value FROM meta WHERE key GLOB 'threadArchive:*'").all()) {
        const key = qualifiedThreadArchiveEffectKey(host, String(row.key).slice('threadArchive:'.length));
        const value = JSON.parse(String(row.value));
        if (retained.has(key) && !value?.qualifiedFence) write.run(key, row.value);
      }
    }
    this.db.exec("DELETE FROM meta WHERE key GLOB 'threadArchive:*' OR key GLOB 'mcpReport:*' OR key GLOB 'mcpReportIntent:*' OR key='hostId'");
    this.pruneThreadArchiveKeys();
  }


  /** External content keeps searchable text only in the permanent outcome row. */
  createOutcomeSearchIndex(): void {
    this.db.exec(`CREATE VIEW IF NOT EXISTS outcome_search_content AS
      SELECT rowid, taskId, json_extract(data,'$.title') AS title,
        json_extract(data,'$.brief.text') AS brief,
        coalesce(json_extract(data,'$.review.summary'),'') AS review,
        json_extract(data,'$.reason') AS reason FROM outcomes;
      CREATE VIRTUAL TABLE outcomes_fts USING fts5(title,brief,review,reason,taskId UNINDEXED,
        content='outcome_search_content',content_rowid='rowid',tokenize='porter');
      CREATE TRIGGER outcomes_fts_insert AFTER INSERT ON outcomes BEGIN
        INSERT INTO outcomes_fts(rowid,title,brief,review,reason,taskId)
          SELECT rowid,title,brief,review,reason,taskId FROM outcome_search_content WHERE rowid=new.rowid;
      END;
      CREATE TRIGGER outcomes_fts_delete AFTER DELETE ON outcomes BEGIN
        INSERT INTO outcomes_fts(outcomes_fts,rowid,title,brief,review,reason,taskId)
          VALUES('delete',old.rowid,json_extract(old.data,'$.title'),json_extract(old.data,'$.brief.text'),
            coalesce(json_extract(old.data,'$.review.summary'),''),json_extract(old.data,'$.reason'),old.taskId);
      END;
      CREATE TRIGGER outcomes_fts_update AFTER UPDATE OF data ON outcomes BEGIN
        INSERT INTO outcomes_fts(outcomes_fts,rowid,title,brief,review,reason,taskId)
          VALUES('delete',old.rowid,json_extract(old.data,'$.title'),json_extract(old.data,'$.brief.text'),
            coalesce(json_extract(old.data,'$.review.summary'),''),json_extract(old.data,'$.reason'),old.taskId);
        INSERT INTO outcomes_fts(rowid,title,brief,review,reason,taskId)
          SELECT rowid,title,brief,review,reason,taskId FROM outcome_search_content WHERE rowid=new.rowid;
      END;`);
  }

  /** Resolve the current body from its version unless it has independent bytes. */
  createLeadReadView(): void {
    this.db.exec(`CREATE VIEW IF NOT EXISTS lead_read AS
      SELECT leads.rowid AS rowid, leads.id AS id, leads.state AS state, leads.content_key AS content_key,
        CASE WHEN json_type(leads.data,'$.body') IS NOT NULL THEN leads.data
          ELSE json_set(leads.data,'$.body', (SELECT json_extract(v.data,'$.body') FROM lead_versions v
            WHERE v.leadId=leads.id AND v.version=json_extract(leads.data,'$.version'))) END AS data
      FROM leads`);
  }

  /** Task 1002: rewrite the stored pool without retired fields; a no-op once clean. */
  stripRetiredPoolFields(): void {
    const stored = this.getMeta<unknown[]>("pool");
    if (!Array.isArray(stored)) return;
    const cleaned = stored.map(entry => entry && typeof entry === "object" && !Array.isArray(entry) ? withoutRetiredPoolFields(entry as Record<string, unknown>) : entry);
    if (cleaned.some((entry, index) => entry !== stored[index])) this.setMeta("pool", cleaned);
  }

  /**
   * Schema 54 (task 989): stored rows lose their retired fields and the store loses the
   * `workspace_creation_step_*` events, which nothing reads. Runs on every open, idempotently:
   * the one-time backlog (outcomes still carrying `routing.capability`, tasks carrying the
   * retired defaults, runs and QA runs carrying the write-only fields) and any row a
   * rolled-back older build wrote during its window are one rule set. A clean store is
   * scanned and left byte-identical. The old reader functions went with the step: the
   * outcome `routing.capability` → `scope` rewrite above is the last legacy reader.
   */
  stripRetiredRowFields(): void {
    this.db.exec("UPDATE outcomes SET data=json_remove(json_set(data,'$.routing.scope',json_extract(data,'$.routing.capability')),'$.routing.capability')\n      WHERE json_type(data,'$.routing.capability') IS NOT NULL");
    this.db.exec("UPDATE outcomes SET data=json_remove(data,'$.stageRuns') WHERE json_type(data,'$.stageRuns') IS NOT NULL");
    this.db.exec("UPDATE tasks SET data=json_remove(data,'$.extraReplacements','$.resolution.mechanicalReviewCarry','$.resolution.authorEscalations')\n      WHERE json_type(data,'$.extraReplacements') IS NOT NULL OR json_type(data,'$.resolution.mechanicalReviewCarry') IS NOT NULL OR json_type(data,'$.resolution.authorEscalations') IS NOT NULL");
    this.db.exec("UPDATE runs SET data=json_remove(data,'$.reviewScopeDigest','$.formalReviewerLogin')\n      WHERE json_type(data,'$.reviewScopeDigest') IS NOT NULL OR json_type(data,'$.formalReviewerLogin') IS NOT NULL");
    this.db.exec("UPDATE project_qa_runs SET data=json_remove(data,'$.queueCapacityDeadlineAt') WHERE json_type(data,'$.queueCapacityDeadlineAt') IS NOT NULL");
    this.db.exec("DELETE FROM events WHERE kind GLOB 'workspace_creation_step_*'");
  }

  migrateRevocableCredentials(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(credentials)').all().map(row => String(row.name)));
    if (!columns.has('revoked')) this.db.exec('ALTER TABLE credentials ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0');
  }

}
