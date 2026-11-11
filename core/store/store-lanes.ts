import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_LANE_DRAIN_ESCALATION_MINUTES,DEFAULT_LANE_DRAIN_MINUTES,isOperatorOrigin,laneDocumentVersionSchema,laneSchema,projectDormant,projectPlanSchema,projectSchema,type Lane,type LaneDocumentPin,type LaneDocumentVersion,type LaneView,type Lead,type Notice,type Outcome,type Project,type ProjectPlan,type Task } from "../../shared/contracts";
import { laneListsRepository,normalizeRepositoryOrigin } from "../../shared/lanes";
import { briefDigest } from "../planning/brief";
import { attachableLane,buildLaneViews,evaluateDrains,idleLaneKeys,indexOutcomesByLane,LANE_IDLE_CLOSE_NOTE,laneSnapshot,laneViewMatches,type LaneDrainInput,type LaneRecordActivity,type ProjectDrainInput } from "../planning/lanes";
import { appendStoredHistoryVersion,HistoryBodyCache,PlanningHistory,readStoredHistory } from "../planning/planning-history";
import { now,StoreCore } from "./store-core";
import type { StoreTasks } from "./store-tasks";

/** A Spec 042 seed id was a thread id prefix until its first liveness check resolved it; the owner role is retired, but old rows can still carry one. */
export const UNRESOLVED_SEED = /^[0-9a-f]{8}$/;

interface StoreLanesAccess {
  readClock: (name: string) => number;
  db: DatabaseSync;
  uiTasks: () => Task[];
  ensureProject: (repoPath: string, origin?: string | null) => Project;
  update: (id: string, change: Partial<Task> & { attention?: never; }, kind?: string, detail?: string, expected?: number) => Task;
  advanceRevision: () => void;
  transaction: <T>(fn: () => T) => T;
  laneViewsCache: { clock: number; value: LaneView[] } | null;
  tasksStore: StoreTasks;
  lastEventAtByTask: Map<string, string> | null;
  eventTimesClock: number;
  laneOutcomeIndex: Map<string, Outcome[]> | null;
  outcomeRowsClock: number;
  outcomes: () => Outcome[];
  laneActivity: Map<string, LaneRecordActivity> | null;
  ensureLeadLaneIndex: () => void;
  projects: () => Project[];
  projectKeyResolver: (projects?: Project[]) => (task: Pick<Task, "repoPath" | "repository">) => string | null;
  openLeads: () => Lead[];
  task: (id: string) => Task;
  plan: (input: { project?: string; repository?: string; version?: number }) => ProjectPlan;
  projectPlannerRecipient: (project: Pick<Project, "planner"> | null | undefined) => string | null;
  getMeta: <T>(key: string) => T | undefined;
  projectByKey: (key: string) => Project | null;
  notices: (taskId?: string) => Notice[];
  putNotice: (n: Notice) => void;
}

export class StoreLanes {
  private readonly planningBodies = new HistoryBodyCache();
  clearHistoryCache(): void { this.planningBodies.clear(); }
  constructor(private readonly core: StoreCore, private readonly access: StoreLanesAccess) {}
  private get readClock() { return this.access.readClock; }
  private get db() { return this.access.db; }
  private get uiTasks() { return this.access.uiTasks; }
  private get ensureProject() { return this.access.ensureProject; }
  private get update() { return this.access.update; }
  private get advanceRevision() { return this.access.advanceRevision; }
  private get transaction() { return this.access.transaction; }
  private get laneViewsCache() { return this.access.laneViewsCache; }
  private set laneViewsCache(value: { clock: number; value: LaneView[] } | null) { this.access.laneViewsCache = value; }
  private get tasksStore() { return this.access.tasksStore; }
  private get lastEventAtByTask() { return this.access.lastEventAtByTask; }
  private set lastEventAtByTask(value: Map<string, string> | null) { this.access.lastEventAtByTask = value; }
  private get eventTimesClock() { return this.access.eventTimesClock; }
  private set eventTimesClock(value: number) { this.access.eventTimesClock = value; }
  private get laneOutcomeIndex() { return this.access.laneOutcomeIndex; }
  private set laneOutcomeIndex(value: Map<string, Outcome[]> | null) { this.access.laneOutcomeIndex = value; }
  private get outcomeRowsClock() { return this.access.outcomeRowsClock; }
  private set outcomeRowsClock(value: number) { this.access.outcomeRowsClock = value; }
  private get outcomes() { return this.access.outcomes; }
  private get laneActivity() { return this.access.laneActivity; }
  private set laneActivity(value: Map<string, LaneRecordActivity> | null) { this.access.laneActivity = value; }
  private get ensureLeadLaneIndex() { return this.access.ensureLeadLaneIndex; }
  private get projects() { return this.access.projects; }
  private get projectKeyResolver() { return this.access.projectKeyResolver; }
  private get openLeads() { return this.access.openLeads; }
  private get task() { return this.access.task; }
  private get plan() { return this.access.plan; }
  private get projectPlannerRecipient() { return this.access.projectPlannerRecipient; }
  private get getMeta() { return this.access.getMeta; }
  private get projectByKey() { return this.access.projectByKey; }
  private get notices() { return this.access.notices; }
  private get putNotice() { return this.access.putNotice; }

  /**
   * The clock the cached lane views were built at. SQLite triggers advance it on every write
   * to a table a lane view derives from — tasks, lanes, events, outcomes, leads and brief
   * drafts, the actual lane and outcome revisions — so a write that bypasses the store's
   * funnels (a fixture backdating rows, a repair script) rebuilds the views instead of
   * serving them stale, and a run, notice, project or configuration write, which no view
   * derives from, leaves them alone. Each read is one row.
   */
  laneViewRevision(): number { return this.readClock("laneViews"); }

  laneByKey(key: string): Lane | null {
    const row = this.db.prepare("SELECT data FROM lanes WHERE key=?").get(key);
    return row ? laneSchema.parse(JSON.parse(String(row.data))) : null;
  }

  lanes(): Lane[] {
    return this.db.prepare("SELECT data FROM lanes ORDER BY rowid").all().map(row => laneSchema.parse(JSON.parse(String(row.data))));
  }

  requireAttachableLanes(keys: string[], repoPath: string, origin?: string | null): Lane[] {
    // Validate every key before any caller may attach, so one bad key refuses the whole set.
    return keys.map(key => attachableLane(this.laneByKey(key), key, repoPath, origin));
  }

  /** The denormalised prompt/detail context for a task's lane list, in membership order. */
  laneContextFor(keys: string[]): Array<{ key: string; title: string; aim: string }> {
    return keys.flatMap(key => {
      const lane = this.laneByKey(key);
      return lane ? [{ key, title: lane.title, aim: lane.aim }] : [];
    });
  }

  upsertLane(input: { key: string; title: string; aim: string; repositories: Lane["repositories"] }): Lane {
    const write = () => {
      const existing = this.laneByKey(input.key);
      const parsed = existing
        ? laneSchema.parse({ ...existing, title: input.title, aim: input.aim, repositories: input.repositories, updatedAt: now() })
        : laneSchema.parse({
          id: randomUUID(), key: input.key, title: input.title, aim: input.aim, status: "active", note: "",
          repositories: input.repositories, createdAt: now(), updatedAt: now(), closedAt: null,
        });
      if (existing) {
        const blocking = this.uiTasks().filter(task => task.lanes.includes(parsed.key) && !["done", "cancelled"].includes(task.phase)
          && !laneListsRepository(parsed.repositories, task.repoPath));
        if (blocking.length) throw new Error(`Cannot remove a repository that still has live tasks in lane ${parsed.key}`);
      }
      for (const repo of parsed.repositories) this.ensureProject(repo.path, repo.origin);
      this.db.prepare("INSERT INTO lanes(id,key,data) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(parsed.id, parsed.key, JSON.stringify(parsed));
      if (existing && (existing.title !== parsed.title || existing.aim !== parsed.aim)) {
        for (const task of this.uiTasks().filter(task => task.lanes.includes(parsed.key))) {
          this.update(task.id, { laneContext: this.laneContextFor(task.lanes) }, "lane_updated", `${parsed.key} title/aim refreshed`);
        }
      }
      this.advanceRevision();
      return parsed;
    };
    return this.db.isTransaction ? write() : this.transaction(write);
  }

  setLaneStatus(key: string, status: Lane["status"], note = ""): Lane {
    const write = () => {
      const existing = this.laneByKey(key);
      if (!existing) throw new Error(`Unknown lane key ${key}`);
      if (existing.status === status && (note === "" || existing.note === note)) return existing;
      const closed = status === "done" || status === "abandoned";
      // Spec 041: a lane that is no longer active cannot carry a drain episode.
      const parsed = laneSchema.parse({
        ...existing, status, note: note || existing.note, drain: status === "active" ? existing.drain : null,
        updatedAt: now(), closedAt: closed ? (existing.closedAt ?? now()) : null,
      });
      this.db.prepare("UPDATE lanes SET data=? WHERE key=?").run(JSON.stringify(parsed), key);
      this.advanceRevision();
      return parsed;
    };
    return this.db.isTransaction ? write() : this.transaction(write);
  }

  /**
   * Spec 041: keep answers a lane's drain prompt. The required reason ends the episode
   * (and restarts the drain window from now); the keep stays on the lane as the answer.
   */
  keepLane(input: { key: string; reason: string; author: string }): Lane {
    return this.transaction(() => {
      const existing = this.laneByKey(input.key);
      if (!existing) throw new Error(`Unknown lane key ${input.key}`);
      const at = now();
      // One timestamp: a keep must never read as activity after itself (Spec 041 re-drain).
      const parsed = laneSchema.parse({ ...existing, keep: { reason: input.reason, at, by: input.author }, drain: null, updatedAt: at });
      this.db.prepare("UPDATE lanes SET data=? WHERE key=?").run(JSON.stringify(parsed), input.key);
      this.advanceRevision();
      return parsed;
    });
  }

  /** Writes a lane's drain episode without touching its activity timestamp, so the evaluation never resets its own window. */
  setLaneDrain(key: string, drain: Lane["drain"]): void {
    const existing = this.laneByKey(key);
    if (!existing) return;
    const parsed = laneSchema.parse({ ...existing, drain });
    this.db.prepare("UPDATE lanes SET data=? WHERE key=?").run(JSON.stringify(parsed), key);
    this.advanceRevision();
  }

  setTaskLanes(task: Task, keys: string[], origin?: string | null): Task {
    if (["done", "cancelled"].includes(task.phase) || task.removedAt) throw new Error("Lane attachment can only change on a live task");
    const attached = keys.length ? this.requireAttachableLanes(keys, task.repoPath, origin) : [];
    const next = laneSnapshot(attached);
    if (JSON.stringify(task.lanes) === JSON.stringify(next.lanes)) return task;
    return this.update(task.id, next, "lane_changed", `${task.lanes.join(", ") || "none"} → ${next.lanes.join(", ") || "none"}`, task.version);
  }

  laneViews(query: { status?: Lane["status"]; repository?: string } = {}): LaneView[] {
    const views = this.cachedLaneViews();
    return query.status || query.repository ? views.filter(view => laneViewMatches(view, query)) : views;
  }

  /**
   * Lane views are derived from lanes, outcomes, live task phases and event times only, so they
   * are rebuilt once per `laneViewRevision()` change and served from cache in between. The value
   * is never stored inside a transaction: a rollback rewinds the rows the views came from.
   */
  cachedLaneViews(): LaneView[] {
    const clock = this.laneViewRevision();
    if (!this.db.isTransaction && this.laneViewsCache?.clock === clock) return this.laneViewsCache.value;
    const lanes = this.lanes();
    let views: LaneView[] = [];
    if (lanes.length) {
      this.tasksStore.ensureTaskProjection();
      const times = this.eventTimes();
      this.tasksStore.ensureQueuedLaneStats();
      const active = [...this.tasksStore.boardOtherIds].map(id => this.tasksStore.taskProjection!.get(id)!);
      views = buildLaneViews(lanes, active, this.outcomesByLane(), times, this.laneRecordActivity()).map(view => {
        const queued = this.tasksStore.queuedLaneStats.get(view.key);
        if (!queued) return view;
        const byRepository = { ...view.liveByRepository };
        for (const [repo, count] of queued.repos) byRepository[repo] = (byRepository[repo] ?? 0) + count;
        const at = queued.activity.at(-1)?.at;
        return { ...view, liveByPhase: { ...view.liveByPhase, queued: queued.count }, liveByRepository: byRepository,
          lastActivityAt: at && (!view.lastActivityAt || at > view.lastActivityAt) ? at : view.lastActivityAt };
      }).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.title.localeCompare(b.title));
    }
    // The cached views are shared between reads, so each one is frozen: a caller that
    // mutated a view would otherwise corrupt every later board until the next write.
    for (const view of views) Object.freeze(view);
    if (!this.db.isTransaction) this.laneViewsCache = { clock, value: views };
    return views;
  }

  /**
   * The newest event time per task, loaded once and maintained by `event()`. A write that
   * bypassed the funnel (a backdated fixture, a repair) moves the `eventRows` clock, and the
   * map is then rebuilt from the rows rather than answered from memory.
   */
  eventTimes(): Map<string, string> {
    const clock = this.readClock("eventRows");
    if (this.lastEventAtByTask && this.eventTimesClock === clock) return this.lastEventAtByTask;
    const loaded = new Map<string, string>();
    for (const row of this.db.prepare("SELECT taskId, MAX(at) AS at FROM events GROUP BY taskId").all()) loaded.set(String(row.taskId), String(row.at));
    this.lastEventAtByTask = loaded;
    this.tasksStore.queuedLaneStatsValid = false;
    this.eventTimesClock = clock;
    return loaded;
  }

  /**
   * Spec 019: one outcome-by-lane index, built once from the permanent rows and extended by
   * `insertOutcomeRow`. A row written outside that funnel moves the `outcomeRows` clock, and
   * the index is then rebuilt from the rows.
   */
  outcomesByLane(): Map<string, Outcome[]> {
    const clock = this.readClock("outcomeRows");
    if (this.laneOutcomeIndex && this.outcomeRowsClock === clock) return this.laneOutcomeIndex;
    this.laneOutcomeIndex = indexOutcomesByLane(this.outcomes());
    this.outcomeRowsClock = clock;
    return this.laneOutcomeIndex;
  }

  /** Spec 019: lead (including papercut-tagged lead) activity per lane. */
  laneRecordActivity(): Map<string, LaneRecordActivity> {
    if (this.laneActivity) return new Map([...this.laneActivity].map(([key, value]) => [key, { ...value }]));
    this.ensureLeadLaneIndex();
    const activity = new Map<string, LaneRecordActivity>();
    const note = (lane: string, at: string | null, open: number) => {
      const current = activity.get(lane) ?? { at: null, open: 0 };
      activity.set(lane, { at: at && (!current.at || at > current.at) ? at : current.at, open: current.open + open });
    };
    const rows = this.db.prepare(`SELECT index_rows.lane AS lane, MAX(json_extract(r.data,'$.updatedAt')) AS at, SUM(r.state='open') AS open
        FROM lead_lane_index index_rows JOIN leads r ON r.id=index_rows.leadId GROUP BY index_rows.lane`).all();
    for (const row of rows) note(String(row.lane), row.at == null ? null : String(row.at), Number(row.open ?? 0));
    this.laneActivity = activity;
    return new Map([...activity].map(([key, value]) => [key, { ...value }]));
  }

  /**
   * Spec 019 revision (2026-09-27): close active lanes idle for 14 days. Closing is
   * `done` with the automatic note, never deletion, and touches no task or record.
   * Returns the closed keys.
   */
  closeIdleLanes(at = Date.now()): string[] {
    if (!this.lanes().some(lane => lane.status === "active")) return [];
    return this.transaction(() => {
      const keys = idleLaneKeys(this.laneViews({ status: "active" }), this.laneRecordActivity(), at);
      for (const key of keys) this.setLaneStatus(key, "done", LANE_IDLE_CLOSE_NOTE);
      return keys;
    });
  }

  /**
   * Spec 041: one drain pass over the active projects' saved plans. Parked projects
   * and plans nobody saved start no episode; a stored episode still escalates by its
   * timer. Episodes and notices land in one transaction, so a pass never leaves a
   * started episode without its prompt.
   */
  evaluateLaneDrains(at = Date.now()): void {
    const registered = this.projects();
    const projectKey = this.projectKeyResolver(registered);
    const byProject = new Map(registered.map(project => [project.key, project]));
    const all = registered.filter(project => project.visibility === "active");
    // Spec 042, re-derived for the planner (Spec 058 cutover 5): a project with no planner and no
    // live owner record is silent, and an owner id not yet resolved from its seed prefix is not routable.
    const projects = all.filter(project => !projectDormant(project)
      && !(project.owner && !project.planner?.agentId && UNRESOLVED_SEED.test(project.owner.agentId)));
    if (!all.length) return;
    this.transaction(() => {
      const tasks = this.uiTasks();
      const views = this.laneViews({});
      const byKey = new Map(views.map(view => [view.key, view]));
      const leads = this.openLeads();
      const laneInputs: LaneDrainInput[] = [];
      const projectInputs: ProjectDrainInput[] = [];
      const claimed = new Set<string>();
      // Read every active run, not just the latest per repository: a newer
      // settled row must not hide an older milestone still in progress.
      const activeQaRuns = new Map<string, number>();
      for (const row of this.db.prepare(`SELECT json_extract(data,'$.repository.path') AS repoPath,
          json_extract(data,'$.repository.origin') AS origin FROM project_qa_runs
          WHERE json_extract(data,'$.state') IN ('queued','running')`).all()) {
        const key = projectKey({ repoPath: String(row.repoPath), repository: row.origin ? String(row.origin) : null });
        if (key) activeQaRuns.set(key, (activeQaRuns.get(key) ?? 0) + 1);
      }
      // Latest task finishes per project; finished tasks are not in uiTasks.
      // The general drain still counts any project task. An explicit idle mark
      // is answered only by its planner's submission or an operator submission.
      const lastFinished = new Map<string, string>();
      const idleSubmittedFinished = new Map<string, string>();
      for (const row of this.db.prepare(`SELECT id, json_extract(data,'$.repoPath') AS repoPath, json_extract(data,'$.repository') AS repository,
          json_extract(data,'$.finishedAt') AS finishedAt, json_extract(data,'$.originAgentId') AS originAgentId FROM tasks
          WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.finishedAt') IS NOT NULL
          ORDER BY finishedAt DESC`).all()) {
        const repository = row.repository ? String(row.repository) : null;
        const key = projectKey({ repoPath: String(row.repoPath), repository: repository && normalizeRepositoryOrigin(repository) ? repository : null });
        const project = key ? byProject.get(key) : null;
        if (!key || !row.finishedAt) continue;
        const at = String(row.finishedAt);
        if (!lastFinished.has(key) || lastFinished.get(key)! < at) lastFinished.set(key, at);
        const submitter = this.task(String(row.id))?.originAgentId ?? (typeof row.originAgentId === "string" ? row.originAgentId : "");
        if (submitter === project!.planner?.agentId || isOperatorOrigin(submitter)) {
          if (!idleSubmittedFinished.has(key) || idleSubmittedFinished.get(key)! < at) idleSubmittedFinished.set(key, at);
        }
      }
      for (const project of all.filter(project => !projects.includes(project) && project.drain)) {
        this.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(projectSchema.parse({ ...project, drain: null })), project.key);
        this.advanceRevision();
      }
      for (const project of projects) {
        const read = this.plan({ project: project.key });
        // Only the saved order counts as “in a plan”; joined lanes wait behind “unplanned”.
        // A requested version returns exactly as saved, closed lanes included, so every step
        // re-checks that its lane is still open. A project nobody ever saved a plan for —
        // including the default per-repository project — has no roadmap and no owner, so it
        // is never prompted, never escalated, and never carries an episode (review 5402595790).
        let saved = read.version > 0 ? this.plan({ project: project.key, version: read.version }) : null;
        if (saved?.idle) {
          const eligibleFinish = idleSubmittedFinished.get(project.key);
          if (eligibleFinish && Date.parse(eligibleFinish) > Date.parse(saved.idle.at)) {
            // Keep the saved idle acknowledgement in history, and append the same
            // plan without it so the current mark visibly ends on eligible work.
            const { idle: _idle, ...planWithoutIdle } = saved;
            const ended = projectPlanSchema.parse({ ...planWithoutIdle, version: saved.version + 1, createdAt: new Date(at).toISOString() });
            this.db.prepare("INSERT INTO project_plans(project,version,data) VALUES(?,?,?)").run(ended.project, ended.version, JSON.stringify(ended));
            this.advanceRevision();
            saved = ended;
          }
        }
        if (!saved) continue;
        // Shared lanes belong to every saved project plan. Only lane-level notices
        // are deduplicated; each board still reads its complete roadmap.
        const entries = saved.entries;
        const openView = (key: string) => {
          const view = byKey.get(key);
          return view && (view.status === "active" || view.status === "paused") ? view : null;
        };
        const horizonStep = (horizon: "now" | "next") => entries.find(entry => entry.horizon === horizon && openView(entry.lane));
        for (const entry of entries) {
          const view = byKey.get(entry.lane);
          if (!view || claimed.has(entry.lane)) continue;
          claimed.add(entry.lane);
          laneInputs.push({
            key: view.key, title: view.title, aim: view.aim, drain: view.drain, status: view.status, lastActivityAt: view.lastActivityAt ?? view.updatedAt, keptAt: view.keep?.at ?? null,
            liveTasks: Object.values(view.liveByPhase).reduce((sum, count) => sum + count, 0),
            openLeads: leads.filter(lead => lead.lanes.includes(entry.lane)).length,
            plan: { project: project.key, projectName: project.name, owner: this.projectPlannerRecipient(project) ?? "", doneWhen: entry.doneWhen ?? "" },
            outcomes: view.recentOutcomes.map(outcome => ({ title: outcome.title, outcome: outcome.outcome, prNumber: outcome.prNumber, finishedAt: outcome.finishedAt })),
          });
        }
        const topNowEntry = horizonStep("now"), firstNextEntry = horizonStep("next");
        const topNow = topNowEntry ? openView(topNowEntry.lane) : null;
        const firstNext = firstNextEntry ? openView(firstNextEntry.lane) : null;
        projectInputs.push({
          key: project.key, name: project.name, drain: project.drain, lastFinishedAt: lastFinished.get(project.key) ?? null,
          idleSubmittedFinishedAt: idleSubmittedFinished.get(project.key) ?? null, idleSince: saved.idle?.at ?? null,
          activeQaRuns: activeQaRuns.get(project.key) ?? 0,
          liveTasks: tasks.filter(task => !["done", "cancelled"].includes(task.phase) && !task.removedAt
            && projectKey({ repoPath: task.repoPath, repository: task.repository && normalizeRepositoryOrigin(task.repository) ? task.repository : null }) === project.key).length,
          topNow: topNow && topNowEntry ? {
            lane: topNowEntry.lane, title: topNow.title, aim: topNow.aim, doneWhen: topNowEntry.doneWhen ?? "",
            documentVersion: this.laneDocument(topNowEntry.lane)?.version ?? 0,
          } : null,
          firstNext: firstNext && firstNextEntry ? { lane: firstNextEntry.lane, title: firstNext.title, aim: firstNext.aim } : null,
          openLeads: topNowEntry ? leads.filter(lead => lead.lanes.includes(topNowEntry.lane)).map(lead => ({ id: lead.id, title: lead.title })) : [],
          owner: this.projectPlannerRecipient(project) ?? "",
        });
      }
      // A lane no active project's saved plan names any more ends any open episode.
      for (const view of views) {
        if (claimed.has(view.key)) continue;
        laneInputs.push({ key: view.key, title: view.title, aim: view.aim, drain: view.drain, status: view.status,
          lastActivityAt: view.lastActivityAt ?? view.updatedAt, liveTasks: 0, openLeads: 0, plan: null, outcomes: [] });
      }
      const evaluation = evaluateDrains(laneInputs, projectInputs,
        { drainMinutes: this.getMeta<number>("laneDrainMinutes") ?? DEFAULT_LANE_DRAIN_MINUTES,
          escalationMinutes: this.getMeta<number>("laneDrainEscalationMinutes") ?? DEFAULT_LANE_DRAIN_ESCALATION_MINUTES }, at);
      for (const [key, drain] of Object.entries(evaluation.lanes)) this.setLaneDrain(key, drain);
      for (const [key, drain] of Object.entries(evaluation.projects)) {
        const project = this.projectByKey(key);
        if (!project) continue;
        // Episode state is operational: it never bumps the operator-edit version.
        const parsed = projectSchema.parse({ ...project, drain });
        this.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(parsed), key);
        this.advanceRevision();
      }
      for (const notice of evaluation.notices) {
        const existing = this.notices(notice.taskId).find(item => item.id === notice.id);
        if (existing) {
          if (existing.status === "pending" && existing.text !== notice.text) this.putNotice({ ...existing, text: notice.text });
          continue;
        }
        this.putNotice({ id: notice.id, taskId: notice.taskId, agentId: notice.agentId, recipientAgentId: notice.agentId, workspaceId: null,
          sources: [], originEntry: false, kind: notice.kind, status: "pending", error: "", text: notice.text });
      }
    });
  }



  /** A task's linked lane documents: each lane attachable to the task's repository and holding a document. */
  requireLaneDocuments(keys: string[], repoPath: string, origin?: string | null): void {
    for (const key of keys) {
      attachableLane(this.laneByKey(key), key, repoPath, origin);
      if (!this.laneDocument(key)) throw new Error(`Lane ${key} has no document to link`);
    }
  }


  /** The latest pinned versions of a task's linked lane documents, recorded once at first dispatch. */
  laneDocumentPinsFor(task: Pick<Task, "laneDocuments" | "laneDocumentPins">): LaneDocumentPin[] | null {
    if (!task.laneDocuments?.length || task.laneDocumentPins?.length) return null;
    return task.laneDocuments.map(key => {
      const document = this.laneDocument(key);
      if (!document) throw new Error(`Lane ${key} has no document to link`);
      return { key, version: document.version, digest: document.digest, text: document.text };
    });
  }


  /** The newest stored version number of a lane document, from either storage form. */
  private latestLaneDocumentVersion(key: string): number {
    const row = this.core.db.prepare(`SELECT MAX(version) AS version FROM (
        SELECT version FROM lane_documents WHERE lane=? UNION ALL SELECT version FROM lane_document_deltas WHERE lane=?)`).get(key, key);
    return Number(row?.version ?? 0);
  }


  laneDocument(key: string, version?: number): LaneDocumentVersion | null {
    const wanted = version ?? this.latestLaneDocumentVersion(key);
    if (!wanted) return null;
    // The newest version and every snapshot are stored in full, so an exact read needs no
    // history; an older reverse delta rebuilds from its snapshot with a digest check.
    const full = this.core.db.prepare("SELECT data FROM lane_documents WHERE lane=? AND version=?").get(key, wanted);
    if (full) return laneDocumentVersionSchema.parse(JSON.parse(String(full.data)));
    const history = new PlanningHistory(readStoredHistory(this.core.db, "laneDocument", key), `Lane document ${key}`);
    const row = history.row(wanted);
    return row ? laneDocumentVersionSchema.parse({ ...row.data, text: history.body(wanted, this.planningBodies) }) : null;
  }


  /** Saves a new version against the latest one the author read; a stale save writes nothing. */
  editLaneDocument(input: { key: string; version: number; digest?: string; text: string; author: string }): LaneDocumentVersion {
    return this.core.transaction(() => {
      if (!this.laneByKey(input.key)) throw new Error(`Unknown lane key ${input.key}`);
      const latest = this.latestLaneDocumentVersion(input.key);
      if (latest !== input.version) throw new Error(`Lane document ${input.key} changed to version ${latest}; reload before saving`);
      if (input.digest !== undefined && this.laneDocument(input.key)?.digest !== input.digest)
        throw new Error(`Lane document ${input.key} digest changed; reload before saving`);
      const value = laneDocumentVersionSchema.parse({ key: input.key, version: latest + 1, text: input.text, digest: briefDigest(input.text), author: input.author, createdAt: now() });
      const previousRow = latest ? this.core.db.prepare("SELECT data FROM lane_documents WHERE lane=? AND version=?").get(input.key, latest) : null;
      const previous = previousRow ? laneDocumentVersionSchema.parse(JSON.parse(String(previousRow.data))) : null;
      appendStoredHistoryVersion(this.core.db, "laneDocument", input.key,
        previous ? { version: previous.version, body: previous.text, data: previous } : null,
        { version: value.version, body: value.text, data: value }, value.version);
      this.planningBodies.clear();
      this.core.advanceRevision();
      return value;
    });
  }

}
