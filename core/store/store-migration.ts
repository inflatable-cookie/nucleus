import { withoutRetiredPoolFields } from "../../shared/contracts";
import { qualifiedThreadArchiveEffectKey, StoreCore } from "./store-core";
import {
  migrateProfileOptions,
  migrateProfileThinking,
  migrateProfileVocabulary,
} from "./profile-vocabulary-migration";
import type { HostVocabulary } from "../../shared/profile-vocabulary";
import type { Decisions } from "../planning/decisions";
import {
  bracketFor,
  migratePoolCapabilities,
  type CapabilityBracketMigration,
} from "./capability-bracket-migration";

/** The record that the one-time canonical profile migration ran (task 1158). */
export const PROFILE_VOCABULARY_MIGRATION_KEY = "profileVocabularyMigration";
/** The record of the canonical thinking migration's first run and of every run that changed a profile (nucleus#1365). */
export const PROFILE_THINKING_MIGRATION_KEY = "profileThinkingMigration";
/** The record of the canonical option migration's first run and of every run that changed a profile (nucleus#1386). */
export const PROFILE_OPTION_MIGRATION_KEY = "profileOptionMigration";

/** The record of the capability bracket migration's first run and of every run that changed something (nucleus#1385). */
export const CAPABILITY_BRACKET_MIGRATION_KEY = "capabilityBracketMigration";
/** The record of the hold-tag migration: each lead that became a park, and when (nucleus#1543). */
export const LEAD_PARKING_MIGRATION_KEY = "leadParkingMigration";
export const ROUTING_APPROVAL_MIGRATION_KEY = "routingApprovalMigration";

/** The archive-key facts a migration reads and prunes; retention owns them. */
export interface MigrationHooks {
  retainedArchiveKeys: () => Set<string>;
  pruneThreadArchiveKeys: () => void;
  withdrawDecision: (
    input: Parameters<Decisions["withdrawInTransaction"]>[0],
  ) => void;
}

/**
 * Every migration step a store needs on open, each idempotent and each naming what it retires.
 * One owner for "make a stored row of an older build parse the current schema": the one-time
 * backlog and any row a rolled-back older build wrote during its window are one rule set, so a
 * clean store is scanned and left byte-identical.
 */
export class StoreMigration {
  constructor(
    private readonly core: StoreCore,
    private readonly hooks: MigrationHooks,
  ) {}
  private get db() {
    return this.core.db;
  }

  /** Task 1002: rewrite the stored pool without retired fields; a no-op once clean. */
  stripRetiredPoolFields(): void {
    const stored = this.core.getMeta<unknown[]>("pool");
    if (!Array.isArray(stored)) return;
    const cleaned = stored.map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? withoutRetiredPoolFields(entry as Record<string, unknown>)
        : entry,
    );
    if (cleaned.some((entry, index) => entry !== stored[index]))
      this.core.setMeta("pool", cleaned);
  }

  /**
   * Spec 052 naming (Tom, 2026-11-17): `minimal` is removed and a stored value
   * reads as `low`. Runs on every open, so the one-time backlog and a row an
   * older build wrote during its window are one rule; `normal`, `high` and
   * `maximum` are untouched.
   */
  migrateUsageLevelName(): void {
    const stored = this.core.getMeta<Record<string, unknown>>("usageLevel");
    if (!stored || stored.level !== "minimal") return;
    this.core.setMeta("usageLevel", { ...stored, level: "low" });
  }

  /**
   * Capability brackets (nucleus#1385, Tom 2026-11-19): the stored pool's
   * capabilities and each task's recorded worker climb move from the five-point
   * scale to Mechanical, Worker, Heavyweight and Frontier, and the retired
   * role-demand offsets are dropped and noted. Idempotent, so it runs on every
   * open: a row a rolled-back build wrote moves too, and a clean store is read
   * and left as it was. The record is written on the first run, on any run that
   * changes something, and on any run whose unrecognised values differ from the
   * record's; an unrecognised value stays as stored and is listed.
   */
  migrateCapabilityBrackets(): void {
    const record: CapabilityBracketMigration = {
      at: new Date().toISOString(),
      changes: [],
      unknown: [],
    };
    const stored = this.core.getMeta<unknown[]>("pool");
    if (Array.isArray(stored)) {
      const { pool, changes, unknown } = migratePoolCapabilities(stored);
      if (changes.length) this.core.setMeta("pool", pool);
      record.changes.push(...changes);
      record.unknown.push(...unknown);
    }
    const climbs = this.db
      .prepare(
        "SELECT id, json_extract(data,'$.resolution.workerClimb.from') AS climbFrom, json_extract(data,'$.resolution.workerClimb.to') AS climbTo FROM tasks WHERE json_type(data,'$.resolution.workerClimb')='object'",
      )
      .all() as Array<{ id: string; climbFrom: unknown; climbTo: unknown }>;
    const update = this.db.prepare(
      "UPDATE tasks SET data=json_set(data,?,?) WHERE id=?",
    );
    for (const row of climbs) {
      for (const [field, value] of [
        ["from", row.climbFrom],
        ["to", row.climbTo],
      ] as const) {
        const result = bracketFor(value);
        if (result === "keep") continue;
        if (result === "unknown") {
          record.unknown.push({
            id: row.id,
            field: `resolution.workerClimb.${field}`,
            value,
          });
          continue;
        }
        update.run(`$.resolution.workerClimb.${field}`, result.to, row.id);
        record.changes.push({
          id: row.id,
          field: `resolution.workerClimb.${field}`,
          from: String(value),
          to: result.to,
        });
      }
    }
    const offsets = this.core.getMeta<unknown>("demandRoleOffsets");
    if (offsets !== undefined) {
      record.droppedDemandRoleOffsets = offsets;
      this.core.deleteMeta("demandRoleOffsets");
    }
    const previous = this.core.getMeta<CapabilityBracketMigration>(
      CAPABILITY_BRACKET_MIGRATION_KEY,
    );
    const changed = record.changes.length > 0 || offsets !== undefined;
    // A run that finds a different set of unknown values records them too, so a
    // value written after the first run is listed; the same set rewrites nothing.
    const unknownMoved =
      JSON.stringify(previous?.unknown ?? []) !==
      JSON.stringify(record.unknown);
    if (previous !== undefined && !changed && !unknownMoved) return;
    // A later run keeps what earlier runs noted: their conversions and the
    // dropped role offsets stay in the one record; `unknown` is the current scan.
    if (previous) {
      record.changes = [...(previous.changes ?? []), ...record.changes];
      if (
        record.droppedDemandRoleOffsets === undefined &&
        previous.droppedDemandRoleOffsets !== undefined
      )
        record.droppedDemandRoleOffsets = previous.droppedDemandRoleOffsets;
    }
    this.core.setMeta(CAPABILITY_BRACKET_MIGRATION_KEY, record);
    for (const item of record.unknown)
      console.warn(
        `[nucleus] ${item.id} keeps ${item.field} ${JSON.stringify(item.value)}: not a capability bracket, left as stored`,
      );
  }

  /** Retire profile approvals on open while keeping the recorded requests and their reasons. */
  retireRoutingApprovals(): void {
    const grants = this.core.getMeta<unknown>("routingGrants");
    const droppedGrants = Array.isArray(grants) ? grants.length : 0;
    const decisions = [
      ...this.db
        .prepare(
          `
      SELECT id, json_extract(data, '$.version') AS version
      FROM decisions
      WHERE status = 'open' AND id IN (
        SELECT json_extract(CASE WHEN json_valid(detail) THEN detail END, '$.decisionId')
        FROM events WHERE kind = 'routing_signoff_requested'
        UNION
        SELECT json_extract(value, '$.decisionId') FROM json_each(?)
        WHERE type = 'object'
        UNION
        SELECT json_extract(request.value, '$.signoff.decisionId')
        FROM tasks, json_each(tasks.data, '$.profileRequests') AS request
        WHERE request.type = 'object'
      )
    `,
        )
        .iterate(JSON.stringify(Array.isArray(grants) ? grants : [])),
    ];
    // The old approval flow could turn a legacy preference into a request
    // itself. Keep the preference, but give direct routing only to requests
    // somebody actually made.
    this.db.exec(`
      UPDATE tasks SET data=json_remove(data,'$.profileRequests.worker')
      WHERE json_extract(data,'$.profileRequests.worker.reason')='Required worker preference in the submitted task'
        AND json_type(data,'$.profileRequests.worker.requestedBy') IS NULL
        AND EXISTS (SELECT 1 FROM events WHERE taskId=tasks.id AND kind='routing_preference_requested')
    `);
    for (const [table, prefix] of [
      ["tasks", "$.profileRequests"],
      ["outcomes", "$.routing.profileRequests"],
    ]) {
      const fields = ["worker", "reviewer", "coordinator"].map(
        (role) => `${prefix}.${role}.signoff`,
      );
      this.db
        .prepare(
          `UPDATE ${table} SET data=json_remove(data, ?, ?, ?)
        WHERE json_type(data, ?) IS NOT NULL OR json_type(data, ?) IS NOT NULL OR json_type(data, ?) IS NOT NULL`,
        )
        .run(...fields, ...fields);
    }
    const withdrawn: string[] = [];
    for (const { id, version } of decisions) {
      if (typeof id !== "string" || typeof version !== "number")
        throw Error(
          "A retired routing decision is missing its stored identity",
        );
      this.hooks.withdrawDecision({
        id,
        version,
        withdrawnBy: "queue",
        reason:
          "Overtaken by the 2026-11-22 ruling that explicit profile requests apply directly.",
      });
      withdrawn.push(id);
    }

    if (grants !== undefined) this.core.deleteMeta("routingGrants");
    const previous = this.core.getMeta<{
      droppedGrants: number;
      withdrawn: string[];
    }>(ROUTING_APPROVAL_MIGRATION_KEY);
    if (previous && grants === undefined && !withdrawn.length) return;
    this.core.setMeta(ROUTING_APPROVAL_MIGRATION_KEY, {
      at: new Date().toISOString(),
      droppedGrants: (previous?.droppedGrants ?? 0) + droppedGrants,
      withdrawn: [...(previous?.withdrawn ?? []), ...withdrawn],
    });
  }

  /** Schema 59 (task 1302): subscription usage readings now belong to host apps and plugins. */
  dropSubscriptionUsageStorage(): void {
    this.db.exec(
      "DROP TABLE IF EXISTS usage_samples; DROP TABLE IF EXISTS usage_read_state;",
    );
  }

  /**
   * nucleus#1261: a task registered by `task.register` before this build has no
   * `workspaceOwnership` field, so the schema default would read its own
   * worktree as a Queue allocation and the preflight would refuse it. The
   * `registered` event is the durable proof that this row's directory is the
   * caller's own checkout, so those rows are marked external on every open: the
   * one-time backlog and any row a rolled-back older build wrote are one rule.
   * Planned rows never carry that event.
   */
  markRegisteredExternalWorkspaces(): void {
    this.db
      .exec(`UPDATE tasks SET data=json_set(data,'$.workspaceOwnership','external')
      WHERE json_type(data,'$.workspaceOwnership') IS NULL
        AND json_extract(data,'$.directory') IS NOT NULL
        AND EXISTS (SELECT 1 FROM events e WHERE e.taskId=tasks.id AND e.kind='registered')`);
  }

  /**
   * Parking is retired (Tom, 2026-11-22): the project `visibility` field goes from stored rows on
   * every open, so a row an older build wrote with `visibility: "parked"` parses the current strict
   * schema. Nothing reads the field afterwards; a clean store is scanned and left as it was.
   */
  stripRetiredProjectVisibility(): void {
    this.db.exec(
      "UPDATE projects SET data=json_remove(data,'$.visibility') WHERE json_type(data,'$.visibility') IS NOT NULL",
    );
  }

  /**
   * Task 985: the per-repository validation policy is retired (Tom, 2026-11-09); the values are
   * archived outside the store. Strip stored copies on every open so rows written by an older
   * build parse the current schema, and drop the retired Nucleus-wide default.
   */
  stripRetiredRepositoryPolicy(): void {
    this.db.exec(
      "UPDATE repository_settings SET data=json_remove(data,'$.validationPolicy') WHERE json_type(data,'$.validationPolicy') IS NOT NULL",
    );
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
    this.db.exec(
      "UPDATE outcomes SET data=json_remove(json_set(data,'$.routing.scope',json_extract(data,'$.routing.capability')),'$.routing.capability')\n      WHERE json_type(data,'$.routing.capability') IS NOT NULL",
    );
    this.db.exec(
      "UPDATE outcomes SET data=json_remove(data,'$.stageRuns') WHERE json_type(data,'$.stageRuns') IS NOT NULL",
    );
    this.db.exec(
      "UPDATE tasks SET data=json_remove(data,'$.extraReplacements','$.resolution.mechanicalReviewCarry','$.resolution.authorEscalations')\n      WHERE json_type(data,'$.extraReplacements') IS NOT NULL OR json_type(data,'$.resolution.mechanicalReviewCarry') IS NOT NULL OR json_type(data,'$.resolution.authorEscalations') IS NOT NULL",
    );
    this.db.exec(
      "UPDATE runs SET data=json_remove(data,'$.reviewScopeDigest','$.formalReviewerLogin')\n      WHERE json_type(data,'$.reviewScopeDigest') IS NOT NULL OR json_type(data,'$.formalReviewerLogin') IS NOT NULL",
    );
    this.db.exec(
      "UPDATE project_qa_runs SET data=json_remove(data,'$.queueCapacityDeadlineAt') WHERE json_type(data,'$.queueCapacityDeadlineAt') IS NOT NULL",
    );
    this.db.exec(
      "DELETE FROM events WHERE kind GLOB 'workspace_creation_step_*'",
    );
  }

  migrateRevocableCredentials(): void {
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(credentials)")
        .all()
        .map((row) => String(row.name)),
    );
    if (!columns.has("revoked"))
      this.db.exec(
        "ALTER TABLE credentials ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0",
      );
  }

  /**
   * Earlier builds recorded a live recipient as "delivered" before sending, and left failed
   * sends queued. Either shape may have crossed the boundary. Fence those rows without changing
   * their IDs or historical events.
   */
  fenceLegacyMessageDelivery(): void {
    this.core.transaction(() => {
      this.db
        .exec(`UPDATE task_messages SET data=json_patch(json_set(data,'$.status','uncertain',
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

  /**
   * Nucleus#1543 (Tom, 2026-11-22): a park replaces the `hold` tag. Every lead still tagged `hold`
   * loses the tag. An open lead also becomes parked with the reason "Held before parking existed"
   * and no recheck date; a lead in any other state only loses the tag, since only open leads park.
   * Idempotent on every open: a clean store is scanned and left as it was, and the record lists
   * each lead the migration changed, with whether it was parked.
   */
  migrateHoldTagsToParked(): void {
    const rows = this.db
      .prepare(
        "SELECT id, data FROM leads WHERE EXISTS (SELECT 1 FROM json_each(leads.data,'$.tags') WHERE value='hold')",
      )
      .all();
    if (!rows.length) return;
    const at = new Date().toISOString();
    const update = this.db.prepare("UPDATE leads SET data=? WHERE id=?");
    const changes: Array<{
      id: string;
      title: string;
      state: string;
      parked: boolean;
    }> = [];
    for (const row of rows) {
      // The raw record is rewritten as it is stored, so a stripped body stays stripped.
      const lead = JSON.parse(String(row.data)) as {
        title: string;
        state: string;
        tags: string[];
        parked?: unknown;
      };
      const parks = lead.state === "open" && !lead.parked;
      const next = {
        ...lead,
        tags: lead.tags.filter((tag) => tag !== "hold"),
        ...(parks
          ? {
              parked: {
                reason: "Held before parking existed",
                revisitAt: null,
                by: "migration",
                at,
              },
            }
          : {}),
      };
      update.run(JSON.stringify(next), String(row.id));
      changes.push({
        id: String(row.id),
        title: lead.title,
        state: lead.state,
        parked: parks,
      });
    }
    this.core.advanceLeadRevision();
    const previous = this.core.getMeta<{ at: string; changes: typeof changes }>(
      LEAD_PARKING_MIGRATION_KEY,
    );
    this.core.setMeta(LEAD_PARKING_MIGRATION_KEY, {
      at,
      changes: [...(previous?.changes ?? []), ...changes],
    });
  }

  migrateLeanReceiptsAndArchives(): void {
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(receipts)")
        .all()
        .map((row) => String(row.name)),
    );
    if (!columns.has("report_hash"))
      this.db.exec("ALTER TABLE receipts ADD COLUMN report_hash TEXT");
    if (!columns.has("report_response"))
      this.db.exec("ALTER TABLE receipts ADD COLUMN report_response TEXT");
    const intent = this.db.prepare(
      "INSERT INTO receipts(id,task,run,hash,response,report_hash) VALUES(?,?,'', '','',?) ON CONFLICT(id) DO UPDATE SET report_hash=excluded.report_hash",
    );
    for (const row of this.db
      .prepare("SELECT key,value FROM meta WHERE key GLOB 'mcpReportIntent:*'")
      .all()) {
      const value = JSON.parse(String(row.value));
      const hash = typeof value === "string" ? value : value?.hash;
      if (hash)
        intent.run(
          String(row.key).slice("mcpReportIntent:".length),
          typeof value === "string" ? "" : (value.taskId ?? ""),
          hash,
        );
    }
    const report = this.db.prepare(
      "INSERT INTO receipts(id,task,run,hash,response,report_hash,report_response) VALUES(?,'','','','',?,?) ON CONFLICT(id) DO UPDATE SET report_hash=coalesce(receipts.report_hash,excluded.report_hash),report_response=excluded.report_response",
    );
    for (const row of this.db
      .prepare("SELECT key,value FROM meta WHERE key GLOB 'mcpReport:*'")
      .all()) {
      const value = JSON.parse(String(row.value));
      report.run(
        String(row.key).slice("mcpReport:".length),
        value.hash,
        JSON.stringify({ hash: value.hash, response: value.response }),
      );
    }
    const retained = this.hooks.retainedArchiveKeys();
    const host = this.core.getMeta<string>("hostId");
    if (
      host &&
      !(this.core.getMeta<Array<{ id: string }>>("hostRegistry") ?? []).length
    )
      this.core.setMeta("hostRegistry", [{ id: host, endpoint: "" }]);
    if (host) {
      const write = this.db.prepare(
        "INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
      );
      for (const row of this.db
        .prepare("SELECT key,value FROM meta WHERE key GLOB 'threadArchive:*'")
        .all()) {
        const key = qualifiedThreadArchiveEffectKey(
          host,
          String(row.key).slice("threadArchive:".length),
        );
        const value = JSON.parse(String(row.value));
        if (retained.has(key) && !value?.qualifiedFence)
          write.run(key, row.value);
      }
    }
    this.db.exec(
      "DELETE FROM meta WHERE key GLOB 'threadArchive:*' OR key GLOB 'mcpReport:*' OR key GLOB 'mcpReportIntent:*' OR key='hostId'",
    );
    this.hooks.pruneThreadArchiveKeys();
  }

  /** The one-time canonical profile migration (task 1158), recorded under its meta key. */
  migrateProfileVocabulary(): void {
    if (
      this.core.getMeta<unknown>(PROFILE_VOCABULARY_MIGRATION_KEY) !== undefined
    )
      return;
    const stored = this.core.getMeta<unknown[]>("profiles");
    const { profiles, record } = migrateProfileVocabulary(
      Array.isArray(stored) ? stored : [],
    );
    if (record.changes.length) this.core.setMeta("profiles", profiles);
    this.core.setMeta(PROFILE_VOCABULARY_MIGRATION_KEY, record);
    for (const item of record.unknown)
      console.warn(
        `[nucleus] profile ${item.profileId} keeps ${item.field} ${JSON.stringify(item.value)}: not in Nucleus's vocabulary, left as stored`,
      );
  }

  /**
   * Stored profiles' thinking in one canonical field (nucleus#1365), mapped back
   * through every host's table. Idempotent, so it runs on every open: a profile a
   * rolled-back build wrote during its window moves too, and a clean store is read
   * and left as it was. The record is written on the first run and on any run that
   * changes a profile; a value no table maps stays as stored and is reported.
   */
  migrateProfileThinking(vocabularies: readonly HostVocabulary[]): void {
    const stored = this.core.getMeta<unknown[]>("profiles");
    const { profiles, record } = migrateProfileThinking(
      Array.isArray(stored) ? stored : [],
      vocabularies,
    );
    const first =
      this.core.getMeta<unknown>(PROFILE_THINKING_MIGRATION_KEY) === undefined;
    if (record.changes.length) this.core.setMeta("profiles", profiles);
    if (!first && !record.changes.length) return;
    this.core.setMeta(PROFILE_THINKING_MIGRATION_KEY, record);
    for (const item of record.unknown)
      console.warn(
        `[nucleus] profile ${item.profileId} keeps ${item.field} ${JSON.stringify(item.value)}: no host table maps it to one canonical thinking level, left as stored`,
      );
  }

  /**
   * Stored profiles' shared provider options under their canonical keys
   * (nucleus#1386): `service_tier` and its other spellings move to `speed`
   * through every host's table. Idempotent like the thinking move, recorded on
   * the first run and on any run that changes a profile; a value no table maps
   * stays as stored and is reported.
   */
  migrateProfileOptions(vocabularies: readonly HostVocabulary[]): void {
    const stored = this.core.getMeta<unknown[]>("profiles");
    const { profiles, record } = migrateProfileOptions(
      Array.isArray(stored) ? stored : [],
      vocabularies,
    );
    const first =
      this.core.getMeta<unknown>(PROFILE_OPTION_MIGRATION_KEY) === undefined;
    if (record.changes.length) this.core.setMeta("profiles", profiles);
    if (!first && !record.changes.length) return;
    this.core.setMeta(PROFILE_OPTION_MIGRATION_KEY, record);
    for (const item of record.unknown)
      console.warn(
        `[nucleus] profile ${item.profileId} keeps ${item.field} ${JSON.stringify(item.value)}: no host table maps it to one canonical option value, left as stored`,
      );
  }
}
