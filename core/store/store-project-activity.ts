import type { Task } from "../../shared/contracts";
import {
  EXECUTING_TASK_PHASES,
  isSubstantiveEventKind,
  ROUTINE_EVENT_KINDS,
  ROUTINE_EVENT_SUFFIXES,
  type ProjectActivityFacts,
  type RepositoryActivityFact,
} from "../../shared/project-activity";
import { type StoreCore } from "./store-core";

/** The SQL form of `isSubstantiveEventKind`, over an events.kind column. */
const SUBSTANTIVE_EVENT_SQL = `NOT (e.kind IN (${ROUTINE_EVENT_KINDS.map(kind => `'${kind}'`).join(",")})
  OR ${ROUTINE_EVENT_SUFFIXES.map(suffix => `substr(e.kind, -${suffix.length}) = '${suffix}'`).join(" OR ")})`;

const repoKey = (origin: string | null, path: string) => `${origin ?? ""}\u0000${path}`;

/**
 * Spec 026 (nucleus#1446): the store-wide facts behind project activity. Events are
 * maintained as one newest-time map per repository, the way `eventTimes` keeps per-task
 * times: the event funnel adds each substantive event as it is written, and a write that
 * bypassed the funnel moves the `eventRows` clock, so the map is then rebuilt from rows.
 * Outcomes and plans are read once per clock change. Nothing here is per project.
 */
export class StoreProjectActivity {
  private byRepository: Map<string, RepositoryActivityFact> | null = null;
  private eventClock = -1;
  private eventMarker = "";
  private outcomeCache: { key: string; rows: RepositoryActivityFact[] } | null = null;
  private planCache: { key: string; rows: Array<{ project: string; at: string }> } | null = null;

  constructor(private readonly core: StoreCore) {}

  /**
   * Called by the event funnel after an insert. The trigger moves `eventRows` by exactly one
   * per insert, so the map is extended only when the clock sits one past the last sync; any
   * other movement means a write the map did not see, and the next read rebuilds it.
   */
  eventWritten(taskId: string, kind: string, at: string): void {
    if (!this.byRepository) return;
    const clock = this.core.readClock("eventRows");
    if (clock !== this.eventClock + 1) {
      this.byRepository = null;
      return;
    }
    this.eventClock = clock;
    if (!isSubstantiveEventKind(kind)) return;
    const row = this.core.db.prepare("SELECT json_extract(data,'$.repository') AS origin, json_extract(data,'$.repoPath') AS path FROM tasks WHERE id=?").get(taskId);
    // A task row that is not there yet has no repository to credit; the rebuild path sees it once it exists.
    if (!row) return;
    this.note(row.origin == null ? null : String(row.origin), String(row.path ?? ""), at);
  }

  /** The store-wide facts. `activeTasks` is the live, non-queued board band, the compact projection executing work reads from. */
  facts(activeTasks: readonly Task[]): ProjectActivityFacts {
    const executing = activeTasks
      .filter(task => EXECUTING_TASK_PHASES.includes(task.phase))
      .map(task => ({ origin: task.repository ?? null, path: task.repoPath }));
    return { repositories: [...this.eventFacts(), ...this.outcomeFacts(), ...this.leadFacts()], plans: this.planFacts(), executing };
  }

  private note(origin: string | null, path: string, at: string): void {
    if (!this.byRepository) return;
    const key = repoKey(origin, path);
    const current = this.byRepository.get(key);
    if (!current || at > current.at) this.byRepository.set(key, { origin, path, at });
  }

  /** Repository rekeys rewrite task and outcome rows; their marker moves the key so every fact rereads. */
  private rekeyMarker(): string {
    const row = this.core.db.prepare("SELECT COUNT(*) AS n, MAX(at) AS at FROM repository_rekeys").get();
    return `${String(row?.n ?? 0)}:${String(row?.at ?? "")}`;
  }

  private eventFacts(): RepositoryActivityFact[] {
    const clock = this.core.readClock("eventRows");
    const marker = this.rekeyMarker();
    if (!this.byRepository || this.eventClock !== clock || this.eventMarker !== marker) {
      const rows = this.core.db.prepare(`SELECT json_extract(t.data,'$.repository') AS origin, json_extract(t.data,'$.repoPath') AS path, MAX(e.at) AS at
        FROM events e JOIN tasks t ON t.id=e.taskId WHERE ${SUBSTANTIVE_EVENT_SQL} GROUP BY origin, path`).all();
      this.byRepository = new Map();
      for (const row of rows) this.byRepository.set(repoKey(row.origin == null ? null : String(row.origin), String(row.path ?? "")), { origin: row.origin == null ? null : String(row.origin), path: String(row.path ?? ""), at: String(row.at) });
      this.eventClock = clock;
      this.eventMarker = marker;
    }
    return [...this.byRepository.values()];
  }

  private outcomeFacts(): RepositoryActivityFact[] {
    const key = `${this.core.readClock("outcomeRows")}|${this.rekeyMarker()}`;
    if (this.outcomeCache?.key !== key) {
      const rows = this.core.db.prepare(`SELECT json_extract(data,'$.repository.origin') AS origin, json_extract(data,'$.repository.path') AS path, MAX(finished_at) AS at
        FROM outcomes WHERE finished_at IS NOT NULL GROUP BY origin, path`).all();
      this.outcomeCache = { key, rows: rows.map(row => ({ origin: row.origin == null ? null : String(row.origin), path: String(row.path ?? ""), at: String(row.at) })) };
    }
    return this.outcomeCache.rows;
  }

  /** Leads are few, so their newest update is read directly; a lead's repositories are a JSON list. */
  private leadFacts(): RepositoryActivityFact[] {
    return this.core.db.prepare(`SELECT json_extract(r.value,'$.origin') AS origin, json_extract(r.value,'$.path') AS path, MAX(json_extract(l.data,'$.updatedAt')) AS at
      FROM leads l, json_each(l.data,'$.repositories') r GROUP BY origin, path`).all()
      .map(row => ({ origin: row.origin == null ? null : String(row.origin), path: String(row.path ?? ""), at: String(row.at) }));
  }

  private planFacts(): Array<{ project: string; at: string }> {
    const key = String(this.core.readClock("plans"));
    if (this.planCache?.key !== key) {
      const rows = this.core.db.prepare("SELECT project, MAX(json_extract(data,'$.createdAt')) AS at FROM project_plans WHERE json_extract(data,'$.createdAt') IS NOT NULL GROUP BY project").all();
      this.planCache = { key, rows: rows.map(row => ({ project: String(row.project), at: String(row.at) })) };
    }
    return this.planCache.rows;
  }
}
