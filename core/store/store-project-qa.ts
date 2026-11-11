import { projectQaRunSchema, type ProjectQaRun } from "../../shared/contracts";
import { StoreCore } from "./store-core";

export class StoreProjectQa {
  constructor(private readonly core: StoreCore) {}

  /** Exact request delivery lookup; never fetches, reconciles or submits a host run. */
  qaRequestRecords(input: { requestId: string } | { repository: string; since: string; expectedHead: string }): unknown[] {
    if ("requestId" in input) {
      const record = this.core.getMeta(`projectQaRequest:${input.requestId}`);
      return record ? [record] : [];
    }
    return this.core.db.prepare("SELECT value FROM meta WHERE key GLOB 'projectQaRequest:*' AND json_extract(value,'$.input.repository')=? AND json_extract(value,'$.receivedAt')>=? ORDER BY key LIMIT 101")
      .all(input.repository, input.since).map(row => JSON.parse(String(row.value)));
  }

  qaHistoryForRequest(input: { repository: string; since: string; expectedHead: string }): ProjectQaRun[] {
    return this.core.db.prepare("SELECT data FROM project_qa_runs WHERE (json_extract(data,'$.repository.origin')=? OR json_extract(data,'$.repository.path')=?) AND json_extract(data,'$.base')=? AND COALESCE(json_extract(data,'$.submittedAt'),json_extract(data,'$.startedAt'))>=? ORDER BY rowid LIMIT 101")
      .all(input.repository, input.repository, input.expectedHead, input.since).map(row => projectQaRunSchema.parse(JSON.parse(String(row.data))));
  }

  /** Milestone QA runs (task 104): durable history, newest rowid first. Keeps the latest-per-repository index current in the same transaction. */
  putQaRun(run: ProjectQaRun): ProjectQaRun {
    const parsed = projectQaRunSchema.parse(run);
    const write = () => {
      this.core.db.prepare("INSERT INTO project_qa_runs(id,repository,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository, data=excluded.data")
        .run(parsed.id, parsed.key, JSON.stringify(parsed));
      this.core.db.prepare("INSERT INTO project_qa_latest(key,id) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET id=excluded.id")
        .run(parsed.key, parsed.id);
      this.core.advanceRevision();
      return parsed;
    };
    return this.core.db.isTransaction ? write() : this.core.transaction(write);
  }

  qaRun(id: string): ProjectQaRun | null {
    const row = this.core.db.prepare("SELECT data FROM project_qa_runs WHERE id=?").get(id);
    return row ? projectQaRunSchema.parse(JSON.parse(String(row.data))) : null;
  }

  /** The board-read current run for one repository key, via the bounded latest index. */
  latestQaRun(key: string): ProjectQaRun | null {
    const link = this.core.db.prepare("SELECT id FROM project_qa_latest WHERE key=?").get(key);
    return link ? this.qaRun(String(link.id)) : null;
  }

  /** Latest run per repository key, newest first, bounded by the latest index plus a row cap. */
  latestQaRuns(limit = 250): ProjectQaRun[] {
    return this.core.db.prepare(`SELECT r.data FROM project_qa_latest l JOIN project_qa_runs r ON r.id=l.id
      ORDER BY json_extract(r.data,'$.startedAt') DESC LIMIT ?`).all(limit)
      .map(row => projectQaRunSchema.parse(JSON.parse(String(row.data))));
  }

  /**
   * Latest run for each named repository key, newest first. Settings reads this
   * so a board-style recency cap cannot drop a project's own outcome.
   */
  latestQaRunsFor(keys: readonly string[]): ProjectQaRun[] {
    const unique = [...new Set(keys)].filter(key => key.length > 0);
    if (unique.length === 0) return [];
    const rows: ProjectQaRun[] = [];
    const chunk = 400;
    for (let i = 0; i < unique.length; i += chunk) {
      const slice = unique.slice(i, i + chunk);
      rows.push(...this.core.db.prepare(`SELECT r.data FROM project_qa_latest l JOIN project_qa_runs r ON r.id=l.id
        WHERE l.key IN (${slice.map(() => "?").join(",")})`).all(...slice)
        .map(row => projectQaRunSchema.parse(JSON.parse(String(row.data)))));
    }
    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }

  /**
   * The board's QA read (Tom, 2026-11-01): the latest run per repository that is not dismissed and is
   * either not passing or finished on or after `passedSince`. Bounded by the repositories with a card.
   */
  qaBoardRuns(passedSince: string): ProjectQaRun[] {
    return this.core.db.prepare(`SELECT r.data FROM project_qa_latest l JOIN project_qa_runs r ON r.id=l.id
      WHERE json_extract(r.data,'$.dismissal') IS NULL
      AND (json_extract(r.data,'$.state') IS NOT 'passed' OR json_extract(r.data,'$.finishedAt') IS NULL OR json_extract(r.data,'$.finishedAt') >= ?)
      ORDER BY json_extract(r.data,'$.startedAt'), r.rowid`).all(passedSince)
      .map(row => projectQaRunSchema.parse(JSON.parse(String(row.data))));
  }

  /** Only authenticated done/main outcomes enter the schedule projection. */
  qaScheduleMerges(key: string): Array<{ taskId: string; title: string; mergeCommit: string; prUrl: string | null; finishedAt: string; attemptedRun: string | null; checkedGreenRun: string | null }> {
    const rows = this.core.db.prepare(`SELECT o.taskId,json_extract(o.data,'$.title') AS title,o.merge_commit AS mergeCommit,
      json_extract(o.data,'$.pr.url') AS prUrl,o.finished_at AS finishedAt,m.attemptedRun,m.checkedGreenRun
      FROM qa_schedule_merges m JOIN outcomes o ON o.taskId=m.taskId
      WHERE m.repository=? AND m.coveredRun IS NULL ORDER BY o.finished_at,o.taskId LIMIT 1001`).all(key);
    if (rows.length > 1000) throw new Error("Scheduled QA has more than 1000 unreconciled merges; owner reconciliation required");
    return rows as ReturnType<StoreProjectQa["qaScheduleMerges"]>;
  }

  markQaScheduleMerges(taskIds: string[], runId: string, passed: boolean): void {
    this.core.transaction(() => { for (const id of taskIds)
      this.core.db.prepare(passed ? "UPDATE qa_schedule_merges SET coveredRun=?,attemptedRun=? WHERE taskId=?"
        : "UPDATE qa_schedule_merges SET attemptedRun=? WHERE taskId=? AND coveredRun IS NULL")
        .run(...(passed ? [runId,runId,id] : [runId,id])); });
  }

  checkQaScheduleGreen(taskIds: string[], runId: string): void {
    this.core.transaction(() => { for (const id of taskIds)
      this.core.db.prepare("UPDATE qa_schedule_merges SET checkedGreenRun=? WHERE taskId=?").run(runId,id); });
  }

  /** Scheduling ignores release-line QA and inspects the full durable history. */
  qaScheduleRuns(key: string): { latest: ProjectQaRun | null; green: ProjectQaRun | null; active: ProjectQaRun | null } {
    const read = (condition: string) => {
      const row = this.core.db.prepare(`SELECT data FROM project_qa_runs WHERE repository=? AND ${condition}
        ORDER BY rowid DESC LIMIT 1`).get(key);
      return row ? projectQaRunSchema.parse(JSON.parse(String(row.data))) : null;
    };
    return { latest: read("json_extract(data,'$.baseBranch')='main'"),
      green: read("json_extract(data,'$.baseBranch')='main' AND json_extract(data,'$.state')='passed'"),
      active: read("json_extract(data,'$.state') IN ('queued','running')") };
  }
}
