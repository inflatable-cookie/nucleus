import { withoutRetiredPoolFields } from "../../shared/contracts";
import { qualifiedThreadArchiveEffectKey, StoreCore } from "./store-core";
import { migrateProfileVocabulary } from "./profile-vocabulary-migration";

/** The record that the one-time canonical profile migration ran (task 1158). */
export const PROFILE_VOCABULARY_MIGRATION_KEY = "profileVocabularyMigration";

/** The archive-key facts a migration reads and prunes; retention owns them. */
export interface MigrationHooks {
  retainedArchiveKeys: () => Set<string>;
  pruneThreadArchiveKeys: () => void;
}

/**
 * Every migration step a store needs on open, each idempotent and each naming what it retires.
 * One owner for "make a stored row of an older build parse the current schema": the one-time
 * backlog and any row a rolled-back older build wrote during its window are one rule set, so a
 * clean store is scanned and left byte-identical.
 */
export class StoreMigration {
  constructor(private readonly core: StoreCore, private readonly hooks: MigrationHooks) {}
  private get db() { return this.core.db; }

  /** Task 1002: rewrite the stored pool without retired fields; a no-op once clean. */
  stripRetiredPoolFields(): void {
    const stored = this.core.getMeta<unknown[]>("pool");
    if (!Array.isArray(stored)) return;
    const cleaned = stored.map(entry => entry && typeof entry === "object" && !Array.isArray(entry) ? withoutRetiredPoolFields(entry as Record<string, unknown>) : entry);
    if (cleaned.some((entry, index) => entry !== stored[index])) this.core.setMeta("pool", cleaned);
  }

  /**
   * Task 985: the per-repository validation policy is retired (Tom, 2026-11-09); the values are
   * archived outside the store. Strip stored copies on every open so rows written by an older
   * build parse the current schema, and drop the retired Nucleus-wide default.
   */
  stripRetiredRepositoryPolicy(): void {
    this.db.exec("UPDATE repository_settings SET data=json_remove(data,'$.validationPolicy') WHERE json_type(data,'$.validationPolicy') IS NOT NULL");
    this.db.exec("DELETE FROM meta WHERE key='defaultValidationPolicy'");
  }

  /**
   * Schema 54 (task 989): stored rows lose their retired fields and the store loses the
   * `workspace_creation_step_*` events, which nothing reads. Runs on every open, idempotently:
   * the one-time backlog (outcomes still carrying `routing.capability`, tasks carrying the
   * retired defaults, runs and QA runs carrying the write-only fields) and any row a
   * rolled-back older build wrote during its window are one rule set. A clean store is
   * scanned and left byte-identical. The old reader functions went with the step: the
   * outcome `routing.capability` → `scope` rewrite below is the last legacy reader.
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

  /**
   * Earlier builds recorded a live recipient as "delivered" before sending, and left failed
   * sends queued. Either shape may have crossed the boundary. Fence those rows without changing
   * their IDs or historical events.
   */
  fenceLegacyMessageDelivery(): void {
    this.core.transaction(() => {
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
  }

  migrateLeanReceiptsAndArchives(): void {
    const columns = new Set(this.db.prepare('PRAGMA table_info(receipts)').all().map(row => String(row.name)));
    if (!columns.has('report_hash')) this.db.exec('ALTER TABLE receipts ADD COLUMN report_hash TEXT');
    if (!columns.has('report_response')) this.db.exec('ALTER TABLE receipts ADD COLUMN report_response TEXT');
    const intent = this.db.prepare("INSERT INTO receipts(id,task,run,hash,response,report_hash) VALUES(?,?,'', '','',?) ON CONFLICT(id) DO UPDATE SET report_hash=excluded.report_hash");
    for (const row of this.db.prepare("SELECT key,value FROM meta WHERE key GLOB 'mcpReportIntent:*'").all()) {
      const value = JSON.parse(String(row.value));
      const hash = typeof value === 'string' ? value : value?.hash;
      if (hash) intent.run(String(row.key).slice('mcpReportIntent:'.length), typeof value === 'string' ? '' : value.taskId ?? '', hash);
    }
    const report = this.db.prepare("INSERT INTO receipts(id,task,run,hash,response,report_hash,report_response) VALUES(?,'','','','',?,?) ON CONFLICT(id) DO UPDATE SET report_hash=coalesce(receipts.report_hash,excluded.report_hash),report_response=excluded.report_response");
    for (const row of this.db.prepare("SELECT key,value FROM meta WHERE key GLOB 'mcpReport:*'").all()) {
      const value = JSON.parse(String(row.value));
      report.run(String(row.key).slice('mcpReport:'.length), value.hash, JSON.stringify({hash:value.hash,response:value.response}));
    }
    const retained = this.hooks.retainedArchiveKeys();
    const host = this.core.getMeta<string>('hostId');
    if (host && !(this.core.getMeta<Array<{id:string}>>('hostRegistry') ?? []).length) this.core.setMeta('hostRegistry', [{id:host,endpoint:''}]);
    if (host) {
      const write = this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)');
      for (const row of this.db.prepare("SELECT key,value FROM meta WHERE key GLOB 'threadArchive:*'").all()) {
        const key = qualifiedThreadArchiveEffectKey(host, String(row.key).slice('threadArchive:'.length));
        const value = JSON.parse(String(row.value));
        if (retained.has(key) && !value?.qualifiedFence) write.run(key, row.value);
      }
    }
    this.db.exec("DELETE FROM meta WHERE key GLOB 'threadArchive:*' OR key GLOB 'mcpReport:*' OR key GLOB 'mcpReportIntent:*' OR key='hostId'");
    this.hooks.pruneThreadArchiveKeys();
  }

  /** The one-time canonical profile migration (task 1158), recorded under its meta key. */
  migrateProfileVocabulary(): void {
    if (this.core.getMeta<unknown>(PROFILE_VOCABULARY_MIGRATION_KEY) !== undefined) return;
    const stored = this.core.getMeta<unknown[]>("profiles");
    const { profiles, record } = migrateProfileVocabulary(Array.isArray(stored) ? stored : []);
    if (record.changes.length) this.core.setMeta("profiles", profiles);
    this.core.setMeta(PROFILE_VOCABULARY_MIGRATION_KEY, record);
    for (const item of record.unknown)
      console.warn(`[nucleus] profile ${item.profileId} keeps ${item.field} ${JSON.stringify(item.value)}: not in Nucleus's vocabulary, left as stored`);
  }
}
