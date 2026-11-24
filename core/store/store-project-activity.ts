import type { Task } from "../../shared/contracts";
import {
  activityItems,
  EXECUTING_TASK_PHASES,
  isSubstantiveEventKind,
  LEAD_LINK_EVENT_KINDS,
  PROJECT_ACTIVITY_WINDOW_MS,
  ROUTINE_EVENT_KINDS,
  ROUTINE_EVENT_SUFFIXES,
  type ActivityItemFact,
  type ActivityRepository,
  type ProjectActivityFacts,
} from "../../shared/project-activity";
import { type StoreCore } from "./store-core";

/** The SQL form of `isSubstantiveEventKind`, over an events.kind column. */
const SUBSTANTIVE_EVENT_SQL = `NOT (e.kind IN (${ROUTINE_EVENT_KINDS.map((kind) => `'${kind}'`).join(",")})
  OR ${ROUTINE_EVENT_SUFFIXES.map((suffix) => `substr(e.kind, -${suffix.length}) = '${suffix}'`).join(" OR ")})`;
const LINK_EVENT_SQL = LEAD_LINK_EVENT_KINDS.map((kind) => `'${kind}'`).join(
  ",",
);

type TaskActivity = { repository: ActivityRepository | null; at: string };

const repoOf = (origin: unknown, path: unknown): ActivityRepository | null =>
  path == null && origin == null
    ? null
    : {
        origin: origin == null ? null : String(origin),
        path: String(path ?? ""),
      };
const newer = (a: string | null, b: string | null): string | null =>
  !a ? b : !b ? a : b > a ? b : a;

/**
 * Spec 026 (nucleus#1446, brief v3): the store-wide facts behind project activity. Each task's newest
 * substantive event is kept as the event funnel writes it, the way per-task event times are, and a
 * write that bypasses the funnel moves the `eventRows` clock so the map is rebuilt from rows. Outcome
 * finish times are read once per outcome clock change. Leads are read on each facts call, from their
 * columns and not their bodies. Items are formed per read: a task and every lead linked to it form
 * one item, and only items recent or executing at the read time are returned.
 */
export class StoreProjectActivity {
  private tasks: Map<
    string,
    TaskActivity & { repository: ActivityRepository | null }
  > | null = null;
  private links: Map<string, Set<string>> = new Map();
  private eventClock = -1;
  private eventMarker = "";
  private outcomeCache: {
    key: string;
    rows: Map<string, TaskActivity>;
  } | null = null;

  constructor(private readonly core: StoreCore) {}

  /**
   * Called by the event funnel after an insert. The trigger moves `eventRows` by exactly one per
   * insert, so the maps are extended only when the clock sits one past the last sync; any other
   * movement means a write the maps did not see, and the next read rebuilds them.
   */
  eventWritten(taskId: string, kind: string, detail: string, at: string): void {
    if (!this.tasks) return;
    const clock = this.core.readClock("eventRows");
    if (clock !== this.eventClock + 1) {
      this.tasks = null;
      return;
    }
    this.eventClock = clock;
    if (LEAD_LINK_EVENT_KINDS.includes(kind)) this.addLink(taskId, detail);
    if (!isSubstantiveEventKind(kind)) return;
    const row = this.core.db
      .prepare(
        "SELECT json_extract(data,'$.repository') AS origin, json_extract(data,'$.repoPath') AS path FROM tasks WHERE id=?",
      )
      .get(taskId);
    // A task row that is not there yet has no repository to credit; the rebuild path sees it once it exists.
    if (!row) return;
    const current = this.tasks.get(taskId);
    this.tasks.set(taskId, {
      repository: repoOf(row.origin, row.path),
      at: newer(current?.at ?? null, at)!,
    });
  }

  /**
   * The items recent or executing at the read time, plus the store-wide facts every project reads.
   * `activeTasks` is the live, non-queued board band: the compact projection executing work reads from.
   */
  facts(
    activeTasks: readonly Task[],
    nowMs: number = Date.now(),
  ): ProjectActivityFacts {
    this.ensureEventFacts();
    const outcomes = this.outcomeFacts();
    const executing = new Set(
      activeTasks
        .filter((task) => EXECUTING_TASK_PHASES.includes(task.phase))
        .map((task) => task.id),
    );
    const union = activityItems();
    const taskKey = (id: string) => `t:${id}`;
    const leadKey = (id: string) => `l:${id}`;
    const taskRepository = (id: string) =>
      this.tasks!.get(id)?.repository ?? outcomes.get(id)?.repository ?? null;
    const taskAt = (id: string) =>
      newer(this.tasks!.get(id)?.at ?? null, outcomes.get(id)?.at ?? null);
    const addTask = (id: string, at: string | null, live: boolean) => {
      const repository = taskRepository(id);
      union.add(taskKey(id), {
        repositories: repository ? [repository] : [],
        at,
        executing: live,
      });
    };
    for (const id of new Set([...this.tasks!.keys(), ...outcomes.keys()]))
      addTask(id, taskAt(id), executing.has(id));
    for (const task of activeTasks)
      addTask(
        task.id,
        newer(taskAt(task.id), task.updatedAt),
        executing.has(task.id),
      );
    for (const lead of this.leads()) {
      union.add(leadKey(lead.id), {
        repositories: lead.repositories,
        at: lead.at,
        executing: false,
      });
      for (const reference of lead.taskReferences)
        union.join(leadKey(lead.id), taskKey(reference));
    }
    for (const [taskId, leadIds] of this.links)
      for (const leadId of leadIds)
        union.join(taskKey(taskId), leadKey(leadId));
    // Each component is one item: its members' newest activity and executing state, and their repositories.
    const cutoff = nowMs - PROJECT_ACTIVITY_WINDOW_MS;
    const items: ActivityItemFact[] = [];
    // Each repository's newest item time, unwindowed: a project's last activity however long ago (nucleus#1531).
    const latest = new Map<string, ActivityRepository & { at: string }>();
    for (const [id, info] of union.components()) {
      if (!info.repositories.length || !info.at) continue;
      for (const repo of info.repositories) {
        const key = `${repo.origin ?? ""}\n${repo.path}`;
        const known = latest.get(key);
        if (!known || info.at > known.at)
          latest.set(key, { ...repo, at: info.at });
      }
      if (!info.executing && Date.parse(info.at) <= cutoff) continue;
      items.push({
        id,
        repositories: info.repositories,
        at: info.at,
        executing: info.executing,
      });
    }
    return { items, latest: [...latest.values()] };
  }

  private addLink(taskId: string, leadId: string): void {
    const set = this.links.get(taskId) ?? new Set<string>();
    set.add(leadId);
    this.links.set(taskId, set);
  }

  /** Rebuilds the task and link maps when the event clock or the rekey marker moved since they were read. */
  private ensureEventFacts(): void {
    const clock = this.core.readClock("eventRows");
    const marker = this.rekeyMarker();
    if (this.tasks && this.eventClock === clock && this.eventMarker === marker)
      return;
    const rows = this.core.db
      .prepare(
        `SELECT e.taskId AS taskId, json_extract(t.data,'$.repository') AS origin, json_extract(t.data,'$.repoPath') AS path, MAX(e.at) AS at
      FROM events e JOIN tasks t ON t.id=e.taskId WHERE ${SUBSTANTIVE_EVENT_SQL} GROUP BY e.taskId`,
      )
      .all();
    this.tasks = new Map();
    for (const row of rows)
      this.tasks.set(String(row.taskId), {
        repository: repoOf(row.origin, row.path),
        at: String(row.at),
      });
    this.links = new Map();
    for (const row of this.core.db
      .prepare(
        `SELECT taskId, detail FROM events WHERE kind IN (${LINK_EVENT_SQL})`,
      )
      .all())
      this.addLink(String(row.taskId), String(row.detail));
    this.eventClock = clock;
    this.eventMarker = marker;
  }

  /** Repository rekeys rewrite task and outcome rows; their marker moves the key so every fact rereads. */
  private rekeyMarker(): string {
    const row = this.core.db
      .prepare("SELECT COUNT(*) AS n, MAX(at) AS at FROM repository_rekeys")
      .get();
    return `${String(row?.n ?? 0)}:${String(row?.at ?? "")}`;
  }

  /** Each task's newest completion, by its outcome row's finish time. Read once per outcome clock change. */
  private outcomeFacts(): Map<string, TaskActivity> {
    const key = `${this.core.readClock("outcomeRows")}|${this.rekeyMarker()}`;
    if (this.outcomeCache?.key !== key) {
      const rows = new Map<string, TaskActivity>();
      for (const row of this.core.db
        .prepare(
          `SELECT taskId, json_extract(data,'$.repository.origin') AS origin, json_extract(data,'$.repository.path') AS path, finished_at AS at
        FROM outcomes WHERE finished_at IS NOT NULL`,
        )
        .all())
        rows.set(String(row.taskId), {
          repository: repoOf(row.origin, row.path),
          at: String(row.at),
        });
      this.outcomeCache = { key, rows };
    }
    return this.outcomeCache.rows;
  }

  /** Leads are read from their columns: the newest update, the repositories and the task references their targets name. */
  private leads(): Array<{
    id: string;
    repositories: ActivityRepository[];
    at: string | null;
    taskReferences: string[];
  }> {
    return this.core.db
      .prepare(
        "SELECT id, json_extract(data,'$.updatedAt') AS at, json_extract(data,'$.repositories') AS repositories, json_extract(data,'$.targets') AS targets FROM leads",
      )
      .all()
      .map((row) => {
        const repositories = (
          JSON.parse(String(row.repositories ?? "[]")) as Array<{
            origin?: unknown;
            path?: unknown;
          }>
        )
          .map((repo) => repoOf(repo.origin, repo.path))
          .filter((repo): repo is ActivityRepository => repo !== null);
        const targets = JSON.parse(String(row.targets ?? "[]")) as Array<{
          kind?: unknown;
          reference?: unknown;
        }>;
        return {
          id: String(row.id),
          repositories,
          at: row.at == null ? null : String(row.at),
          taskReferences: targets
            .filter(
              (target) =>
                target.kind === "task" && typeof target.reference === "string",
            )
            .map((target) => String(target.reference)),
        };
      });
  }
}
