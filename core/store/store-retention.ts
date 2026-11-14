import { existsSync } from "node:fs";
import type { SQLInputValue } from "node:sqlite";
import { taskReferenceSchema, type Notice, type Run, type Task } from "../../shared/contracts";
import type { HookRecord } from "../../shared/hooks";
import { hookRetentionBlocksPurge } from "../hooks/hook-retention";
import { HOST_RUN_SELECTOR, qualifiedThreadArchiveEffectKey, StoreCore } from "./store-core";
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

export const HISTORY_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;

/** How long a finished task's history (task, events, runs) is kept before purge (Spec 018; Tom, 2026-10-20: "4 days for queue", from 14). */
const TASK_HISTORY_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;

/** Count of rows each window removed in one pass (for the record and the tests). */
export interface RetainedRowPrune {
  operations: number; checkPolicyObservations: number; notices: number; events: number; qaScheduleMerges: number;
  hostRuns: number; hostRunSidecars: number; projectQaRuns: number; hostRunOutputFailures: number; assignmentHistory: number;
}

/** The facts retention needs from the store's other owners; nothing else on the store is read. */
export interface RetentionHooks {
  numberedTask: (data: string) => Task;
  runs: (taskId?: string) => Run[];
  hookEvents: (taskId?: string) => HookRecord[];
  notices: (taskId?: string) => Notice[];
  deleteCredential: (run: string) => void;
  tasksStore: () => StoreTasks;
  lastEventAtByTask: () => Map<string, string> | null;
  cachedTaskCount: () => number | null;
  setCachedTaskCount: (value: number | null) => void;
  advanceRevision: () => void;
  taskChanged: (taskId: string | null) => void;
}

/**
 * The store's retention windows: finished-task history, settled host-run journals and the rows
 * that outlive their task, run or request. One owner for every window and every prune rule;
 * callers own the transaction (the migration and the daily sweep both pass one).
 */
export class StoreRetention {
  constructor(private readonly core: StoreCore, private readonly hooks: RetentionHooks) {}
  private get db() { return this.core.db; }

  purgeOldTasks(at=Date.now(),cleanupFiles?:(taskId:string,runIds:string[])=>void) {
    const cutoff=at-TASK_HISTORY_RETENTION_MS;
    const purged:string[]=[];
    this.core.transaction(()=>{
      for(const row of this.db.prepare("SELECT * FROM tasks").all()){
        // A schema-45 row names its text and observations by reference, so the read
        // resolves them exactly as every public read does.
        const task=this.hooks.numberedTask(String(row.data));
        const runs=this.hooks.runs(task.id);
        if(!this.retentionEligible(task,runs,cutoff))continue;
        // Audit B5: hook records carry the only proof of an isolated checkout's ownership,
        // so a task whose hook retention is not settled keeps its whole history. The
        // hourly reaper runs before the purge and marks the rows it settled; whatever is
        // left here still names a checkout that exists, or an execution whose ownership a
        // caller never proved, and neither may be deleted.
        const hooks=this.hooks.hookEvents(task.id);
        if(hooks.some(record=>hookRetentionBlocksPurge(record,existsSync)))continue;
        const runIds=[...new Set([task.runId,...task.retiredWorkers.map(w=>w.runId),...runs.map(r=>r.id)].filter((id):id is string=>Boolean(id)))];
        cleanupFiles?.(task.id,runIds);
        // Spec 043 (c) goal gate: the permanent outcome row keeps the merged task's
        // own record, but dependents read this host-local tombstone after retention.
        // Carry the goal-unmet fact so a purged prerequisite still never satisfies a
        // dependent. It stays out of the portable submissionTombstones export, whose
        // explicit field pick does not name it.
        this.db.prepare("INSERT INTO tombstones VALUES(?,?,?,?)").run(task.id,task.submissionId,String(row.input_hash),JSON.stringify({...taskReferenceSchema.parse(task),goalUnmet:task.resolution.goalUnmet??null,purgedAt:new Date(at).toISOString()}));
        for(const id of runIds){this.hooks.deleteCredential(id);this.db.prepare("DELETE FROM meta WHERE key=?").run(`reviewPublication:${id}`);}
        this.db.prepare("DELETE FROM meta WHERE key=?").run(`workspaceTitle:${task.id}`);
        // Lean store 2 (task 987): the task's own check-policy observation goes with it.
        this.db.prepare("DELETE FROM meta WHERE key=?").run(`checkPolicyObservation:${task.id}`);
        for(const table of ['events','runs','notices','hook_events','task_observations'])this.db.prepare(`DELETE FROM ${table} WHERE taskId=?`).run(task.id);
        this.db.prepare("DELETE FROM task_messages WHERE fromTaskId=? OR toTaskId=?").run(task.id,task.id);
        this.hooks.lastEventAtByTask()?.delete(task.id);
        this.db.prepare("DELETE FROM receipts WHERE task=?").run(task.id);this.db.prepare("DELETE FROM task_brief_versions WHERE taskId=?").run(task.id);this.db.prepare("DELETE FROM task_reviews WHERE taskId=?").run(task.id);this.db.prepare("DELETE FROM tasks WHERE id=?").run(task.id);purged.push(task.id);
      }
      if (purged.length) this.pruneThreadArchiveKeys();
      this.core.setMeta('lastRetentionAt',at);
      // Purging deletes in bulk (and runs caller cleanup in between), so drop
      // the projection instead of tracking each row; the next read rebuilds.
      // Purges are rare and off the hot path.
      if (purged.length) this.hooks.tasksStore().invalidateProjections();
      if (purged.length) { this.hooks.setCachedTaskCount(null); this.hooks.advanceRevision(); for (const id of purged) this.hooks.taskChanged(id); }
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
      const task=this.hooks.numberedTask(String(row.data));
      if(!this.retentionEligible(task,this.hooks.runs(task.id),cutoff))continue;
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
      if(this.hooks.notices(task.id).some(n=>['pending','intent','uncertain'].includes(n.status)))return false;
      return true;
  }

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
        const changes = this.core.transaction(() => Number(this.db.prepare(sql).run(cutoff, batch).changes));
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
      if (!retained.has(String(row.key))) remove.run(String(row.key));
    for (const row of this.db.prepare("SELECT key FROM meta WHERE key GLOB 'threadArchiveQualifiedProbe:*'").all()) {
      const effect = String(row.key).replace('threadArchiveQualifiedProbe:', 'threadArchiveQualified:');
      if (!retained.has(effect)) remove.run(String(row.key));
    }
    for (const row of this.db.prepare("SELECT key FROM meta WHERE key GLOB 'threadArchiveUnknownProbe:*'").all()) {
      const [taskId] = JSON.parse(String(row.key).slice('threadArchiveUnknownProbe:'.length));
      if (!this.db.prepare('SELECT 1 FROM tasks WHERE id=?').get(taskId)) remove.run(String(row.key));
    }
  }
}
