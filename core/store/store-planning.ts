import { z } from "zod";
import type { Submission } from "../../shared/contracts";
import { decisionDeliverySchema,decisionSchema,storedDecisionSchema,laneSchema,LEAD_PREVIEW_MAX,leadSchema,leadVersionMetadataSchema,leadVersionSchema,papercutSchema,planEntrySchema,projectPlanSchema,type BoardLead,type BoardLeadLink,type Decision,type Lane,type LaneDocumentPin,type LaneDocumentVersion,type Lead,type LeadVersion,type Papercut,type Project,type ProjectPlan,type Task } from "../../shared/contracts";
import { laneListsRepository,normalizeRepositoryOrigin } from "../../shared/lanes";
import { leadFromPapercut,papercutFromLead } from "../../shared/papercut-lead";
import { attachableLane } from "../planning/lanes";
import { appendStoredHistoryVersion,HistoryBodyCache,PlanningHistory,readStoredHistory,updateStoredHistoryMetadata,writeStoredHistory } from "../planning/planning-history";
import { deepFreeze,digest,now,StoreCore } from "./store-core";

/** The lane facts a plan read derives from; the lane index holds these instead of whole rows. */
type PlanLane = Pick<Lane, "key" | "status" | "closedAt" | "repositories">;

/**
 * The board reads narrow facts only: one multi-path `json_extract` for the
 * fields it projects, plus `json_type` presence for the defaulted ones. No
 * body, approval note, check message, papercut text or reopen history crosses
 * the SQLite boundary (review #561). Presence keeps the canonical lead rules: a
 * field a legacy row never stored is omitted, so it takes exactly the default
 * `lead.list` gives it, while a field present but invalid (an explicit `null`
 * tag list) still fails as it does there (live #377: older rows had no `tags`).
 */
const BOARD_LEAD_FACTS = "json_extract(data,'$.id','$.title','$.state','$.version','$.repositories','$.lanes','$.tags','$.targets','$.check.ok','$.papercut.area')";

const BOARD_LEAD_PRESENCE = "json_array(json_type(data,'$.lanes'),json_type(data,'$.tags'),json_type(data,'$.check'),json_type(data,'$.approval'),json_type(data,'$.papercut'),json_type(data,'$.papercut.area'))";

const boardLeadFactsSchema = leadSchema.pick({ id: true, title: true, state: true, version: true, repositories: true, lanes: true, tags: true, targets: true });

type BoardLeadFacts = z.infer<typeof boardLeadFactsSchema> & { checkOk: boolean | null; approved: boolean; papercutArea: string | null };

function boardLeadFacts(facts: string, presence: string): BoardLeadFacts {
  const [id, title, state, version, repositories, lanes, tags, targets, checkOk, papercutArea] = JSON.parse(facts) as unknown[];
  const [lanesType, tagsType, checkType, approvalType, papercutType, areaType] = JSON.parse(presence) as Array<string | null>;
  // An absent key stays absent so the canonical default applies; a present one keeps its value.
  const lead = boardLeadFactsSchema.parse({ id, title, state, version, repositories, targets,
    ...(lanesType === null ? {} : { lanes }), ...(tagsType === null ? {} : { tags }) });
  // `check`, `approval` and `papercut` are nullable objects defaulting to null:
  // absent or null reads as none, an object must carry the fact the board reads,
  // and anything else is as invalid here as in `lead.list`.
  const present = (type: string | null, field: string, valid: boolean) => {
    if (type === null || type === "null") return false;
    if (type !== "object" || !valid) throw new Error(`Lead ${lead.id} has a malformed ${field}`);
    return true;
  };
  return { ...lead,
    checkOk: present(checkType, "check", typeof checkOk === "boolean") ? checkOk as boolean : null,
    approved: present(approvalType, "approval", true),
    // A papercut's area is a required key whose value is text or null (review #561).
    papercutArea: present(papercutType, "papercut", areaType === "text" || areaType === "null") ? papercutArea as string | null : null,
  };
}

/** One narrow board card from the projected facts and the body preview. */
function boardLeadRow(facts: string, presence: string, preview: string): BoardLead {
  const lead = boardLeadFacts(facts, presence);
  return {
    id: lead.id, title: lead.title, preview, repositories: lead.repositories, lanes: lead.lanes, tags: lead.tags,
    papercutArea: lead.papercutArea,
    state: lead.state === "promoted" ? "promoted" : "open",
    version: lead.version,
    check: lead.checkOk === null ? null : { ok: lead.checkOk },
    approved: lead.approved,
    targets: lead.targets.filter(target => target.kind === "draft" || target.kind === "task")
      .map(target => ({ kind: target.kind as "draft" | "task", repository: target.repository })),
  };
}

/** Link facts for a promoted lead an open decision links, projected the same way. */
function boardLeadLinkRow(facts: string, presence: string): BoardLeadLink {
  const lead = boardLeadFacts(facts, presence);
  return { id: lead.id, lanes: lead.lanes, repositories: lead.repositories };
}
interface PlanningAccess {
  requireLaneDocuments(keys: string[], repoPath: string, origin?: string | null): void;
  laneDocumentPinsFor(task: Pick<Task, "laneDocuments" | "laneDocumentPins">): LaneDocumentPin[] | null;
  laneDocument(key: string, version?: number): LaneDocumentVersion | null;
  editLaneDocument(input: { key: string; version: number; digest?: string; text: string; author: string }): LaneDocumentVersion;
  laneByKey(key: string): Lane | null;
  requireAttachableLanes(keys: string[], repoPath: string, origin?: string | null): Lane[];
  projectByKey(key: string): Project | null;
  projectFor(repoPath: string, origin?: string | null): Project | null;
  projects(): Project[];
  ensureProject(repoPath: string, origin?: string | null): Project;
  invalidateLaneActivity(): void;
}
export class StorePlanning {
  constructor(private readonly core: StoreCore, private readonly access: PlanningAccess) {}
  clearHistoryCache(): void { this.planningBodies.clear(); }

  /**
   * The lane facts a plan read derives from, in lane creation order, read once per
   * lane-view revision. A plan read used to scan every lane row for its open list
   * and scan them all again for each saved entry in the Done band: audit A2
   * (2026-10-25) counted 228 `lanes()` calls inside one `plans` poll over 240 lanes.
   * The clock is the one the lane views already keep, so a lane, task, outcome,
   * event or lead write rebuilds this index and a run, notice, project or
   * configuration write leaves it alone; no second lane revision is introduced.
   */
  private laneIndexCache: { clock: number; lanes: PlanLane[]; byKey: Map<string, PlanLane> } | null = null;

  /**
   * Each project's saved plan entries by lane, newest version first — the whole
   * input to the Done band — cached against the `plans` write clock. Triggers
   * advance that clock on every `project_plans` write (a save, a project merge, an
   * import or a repair that bypasses the store), so a cached entry is served only
   * while every retained version of the project's plan is the one it was read
   * from. The band's lane side (status and close time) is read fresh from the lane
   * index on every call.
   */
  private planEntriesCache: { clock: number; byProject: Map<string, Map<string, ProjectPlan["entries"][number]>> } | null = null;

  /**
   * Rebuilt older planning-history versions, bounded by entry count and bytes (audit B1).
   * A hit is digest-checked again before it is served, so the cache never hides corruption,
   * and every planning-history write clears it.
   */
  private readonly planningBodies = new HistoryBodyCache();

  addPapercut(record: Omit<Papercut, "lanes" | "draftId" | "version"> & { lanes?: string[]; draftId?: string | null }): Papercut {
    const value = papercutSchema.parse(record);
    this.addLead(leadFromPapercut(value), value.filedBy);
    return value;
  }

  papercut(id: string): Papercut {
    const row = this.core.db.prepare("SELECT data FROM lead_read AS leads WHERE id=?").get(id);
    if (!row) throw new Error("Papercut not found");
    return papercutFromLead(leadSchema.parse(JSON.parse(String(row.data))));
  }

  listPapercuts(query: { repository?: string; state?: Papercut["state"] } = {}): Papercut[] {
    return this.core.db.prepare("SELECT data FROM lead_read AS leads WHERE state=? ORDER BY json_extract(data,'$.createdAt') DESC,rowid").all(query.state ?? "open")
      .map(row => leadSchema.parse(JSON.parse(String(row.data))))
      .filter(lead => lead.tags.includes("papercut") && (!query.repository || lead.repositories[0].origin === query.repository))
      .map(papercutFromLead);
  }

  updatePapercut(record: Papercut): Papercut {
    const value = papercutSchema.parse(record);
    const current = this.lead(value.id);
    const mapped = leadFromPapercut(value);
    const stamp = now();
    const targets = value.taskId && !current.targets.some(target => target.kind === "task" && target.reference === value.taskId)
      ? [...current.targets, { kind: "task" as const, repository: value.repository.origin, reference: value.taskId, at: stamp }]
      : current.targets;
    this.updateLead({ ...current, title: mapped.title, body: mapped.body, repositories: mapped.repositories, lanes: mapped.lanes,
      author: mapped.author, state: mapped.state, papercut: mapped.papercut, closure: mapped.closure,
      targets, source: mapped.source, createdAt: mapped.createdAt, updatedAt: stamp, closedAt: mapped.closedAt });
    return value;
  }

  /**
   * Spec 026 record lanes under Spec 019: each lane exists, is active or paused and
   * lists one of the record's repositories. One bad key refuses the whole list.
   */
  requireRecordLanes(keys: string[], repositories: Array<{ origin: string | null; path: string }>): Lane[] {
    return keys.map(key => {
      const lane = this.access.laneByKey(key);
      let refusal: unknown = new Error(`Lane ${key} does not list this repository`);
      for (const repo of repositories) {
        try { return attachableLane(lane, key, repo.path, repo.origin); } catch (error) { refusal = error; }
      }
      throw refusal;
    });
  }

  /** A task's linked lane documents: each lane attachable to the task's repository and holding a document. */
  requireLaneDocuments(keys: string[], repoPath: string, origin?: string | null): void { return this.access.requireLaneDocuments(keys, repoPath, origin); }

  /** Submission lane checks: membership and linked documents, both refused whole. */
  requireSubmissionLanes(submission: Pick<Submission, "lanes" | "laneDocuments" | "repoPath">, origin?: string | null): void {
    if (submission.lanes.length) this.access.requireAttachableLanes(submission.lanes, submission.repoPath, origin);
    if (submission.laneDocuments?.length) this.requireLaneDocuments(submission.laneDocuments, submission.repoPath, origin);
  }

  /** The latest pinned versions of a task's linked lane documents, recorded once at first dispatch. */
  laneDocumentPinsFor(task: Pick<Task, "laneDocuments" | "laneDocumentPins">): LaneDocumentPin[] | null { return this.access.laneDocumentPinsFor(task); }

  laneDocument(key: string, version?: number): LaneDocumentVersion | null { return this.access.laneDocument(key, version); }

  /** Saves a new version against the latest one the author read; a stale save writes nothing. */
  editLaneDocument(input: { key: string; version: number; digest?: string; text: string; author: string }): LaneDocumentVersion { return this.access.editLaneDocument(input); }

  /** Resolve a plan's project by key, or by a repository origin or path through Spec 027 membership. */
  planProject(input: { project?: string; repository?: string }): Project {
    if (input.project) {
      const project = this.access.projectByKey(input.project);
      if (!project) throw new Error(`Unknown project ${input.project}`);
      return project;
    }
    const origin = normalizeRepositoryOrigin(input.repository!);
    const project = this.access.projectFor(input.repository!, origin);
    if (!project) throw new Error(`No project holds repository ${input.repository}`);
    return project;
  }

  private planLaneListsProject(lane: PlanLane, project: Project): boolean {
    return project.repositories.some(repo => laneListsRepository(lane.repositories, repo.path, repo.origin));
  }

  /** The lane facts a plan read uses, indexed once per lane-view revision. */
  private planLaneIndex(): { lanes: PlanLane[]; byKey: Map<string, PlanLane> } {
    const clock = this.core.readClock("laneViews");
    if (this.laneIndexCache?.clock === clock) return this.laneIndexCache;
    const lanes = this.core.db.prepare("SELECT data FROM lanes ORDER BY rowid").all().map(row => {
      const lane = laneSchema.parse(JSON.parse(String(row.data)));
      return deepFreeze({ key: lane.key, status: lane.status, closedAt: lane.closedAt, repositories: lane.repositories });
    });
    const cache = { clock, lanes, byKey: new Map(lanes.map(lane => [lane.key, lane])) };
    this.laneIndexCache = cache;
    return cache;
  }

  /** Every project's saved entries by lane, newest version first, read once per plan write clock. */
  private planEntriesByProject(): Map<string, Map<string, ProjectPlan["entries"][number]>> {
    const clock = this.core.readClock("plans");
    if (this.planEntriesCache?.clock === clock) return this.planEntriesCache.byProject;
    const byProject = new Map<string, Map<string, ProjectPlan["entries"][number]>>();
    // One entry per lane: the newest saved version that names it wins, exactly as the historical
    // read decided, so later duplicates of a lane are skipped unread. Only the entries are read —
    // a retained version's plan-level fields are validated when that version itself is read (the
    // latest row through `planFor`, any version through `storedPlan`).
    for (const row of this.core.db.prepare(`SELECT project_plans.project AS project, json_extract(json_each.value,'$.lane') AS lane,
        json_each.value AS entry FROM project_plans, json_each(project_plans.data,'$.entries')
        ORDER BY project_plans.project, project_plans.version DESC, json_each.key`).all()) {
      const project = String(row.project);
      const found = byProject.get(project) ?? new Map<string, ProjectPlan["entries"][number]>();
      byProject.set(project, found);
      const lane = String(row.lane);
      if (found.has(lane)) continue;
      found.set(lane, planEntrySchema.parse(JSON.parse(String(row.entry))));
    }
    const cache = { clock, byProject };
    this.planEntriesCache = cache;
    return byProject;
  }

  storedPlan(project: string, version?: number): ProjectPlan | null {
    const row = version
      ? this.core.db.prepare("SELECT data FROM project_plans WHERE project=? AND version=?").get(project, version)
      : this.core.db.prepare("SELECT data FROM project_plans WHERE project=? ORDER BY version DESC LIMIT 1").get(project);
    return row ? projectPlanSchema.parse(JSON.parse(String(row.data))) : null;
  }

  /**
   * A project's plan as read from an already-read lane index. The latest save keeps
   * its order for open lanes that still list a member repository; any other open
   * listing lane joins the end, in lane creation order. A requested version is
   * returned exactly as saved, before this point.
   */
  private planFor(project: Project, index: { lanes: PlanLane[]; byKey: Map<string, PlanLane> }): ProjectPlan {
    const saved = this.storedPlan(project.key);
    const open = index.lanes.filter(lane => (lane.status === "active" || lane.status === "paused") && this.planLaneListsProject(lane, project));
    const openKeys = new Set(open.map(lane => lane.key));
    const kept = (saved?.entries ?? []).filter(entry => openKeys.has(entry.lane));
    const named = new Set(kept.map(entry => entry.lane));
    const joined = open.filter(lane => !named.has(lane.key)).map(lane => ({ lane: lane.key, note: "", horizon: "now" as const }));
    const done = this.planDoneEntries(project.key, index);
    return projectPlanSchema.parse({ project: project.key, version: saved?.version ?? 0, entries: [...kept, ...joined], ...(done.length ? { done } : {}),
      author: saved?.author ?? null, createdAt: saved?.createdAt ?? null, ...(saved?.idle ? { idle: saved.idle } : {}) });
  }

  /**
   * A project's plan as read. The latest save keeps its order for open lanes that
   * still list a member repository; any other open listing lane joins the end, in
   * lane creation order. A requested version is returned exactly as saved.
   */
  plan(input: { project?: string; repository?: string; version?: number }): ProjectPlan {
    const project = this.planProject(input);
    if (input.version) {
      const saved = this.storedPlan(project.key, input.version);
      if (!saved) throw new Error(`Plan version ${input.version} not found for project ${project.key}`);
      return saved;
    }
    return this.planFor(project, this.planLaneIndex());
  }

  /** Every project's current plan from one project read and one lane read, so a board poll parses no project or lane twice (audit A2). */
  plans() {
    const projects = this.access.projects(), index = this.planLaneIndex();
    return projects.map(project => ({
      ...this.planFor(project, index),
      savedEntries: this.storedPlan(project.key)?.entries ?? [],
    }));
  }

  /** Lanes that once sat in the project's plan and are now done or abandoned, newest close first. Read from saved versions, never written back. */
  private planDoneEntries(project: string, index: { byKey: Map<string, PlanLane> }): NonNullable<ProjectPlan["done"]> {
    const found = this.planEntriesByProject().get(project);
    if (!found) return [];
    const done: NonNullable<ProjectPlan["done"]> = [];
    for (const [key, entry] of found) {
      const lane = index.byKey.get(key);
      if (lane && (lane.status === "done" || lane.status === "abandoned")) done.push({ ...entry, status: lane.status, closedAt: lane.closedAt });
    }
    return done.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  }

  setPlan(input: { project?: string; repository?: string; version: number; entries: Array<{ lane: string; note?: string; horizon?: "now" | "next" | "later"; doneWhen?: string }>; author: string; idle?: string }): ProjectPlan {
    return this.core.transaction(() => {
      const project = this.planProject(input);
      const latest = this.storedPlan(project.key)?.version ?? 0;
      if (latest !== input.version) throw new Error(`Plan for ${project.key} changed to version ${latest}; reload before saving`);
      this.requireRecordLanes(input.entries.map(entry => entry.lane), project.repositories);
      if (input.idle && input.entries.some(entry => (entry.horizon ?? "now") !== "later"))
        throw new Error("An idle plan has no now or next lane; move them to later or drop idle");
      const value = projectPlanSchema.parse({ project: project.key, version: latest + 1, entries: input.entries, author: input.author, createdAt: now(),
        ...(input.idle ? { idle: { reason: input.idle, at: now() } } : {}) });
      this.core.db.prepare("INSERT INTO project_plans(project,version,data) VALUES(?,?,?)").run(value.project, value.version, JSON.stringify(value));
      this.core.advanceRevision();
      return value;
    });
  }

  /** Same-title submission lookup stays repository-scoped and reads no unrelated bodies. */
  findLeadSubmission(title: string, repository: { origin: string; path: string }): { taskId: string } | { leadId: string } | null {
    const task = this.core.db.prepare(`SELECT n.task_id FROM task_numbers n JOIN (
      SELECT id AS taskId, json_extract(data,'$.title') AS title FROM tasks
      UNION ALL SELECT taskId, json_extract(data,'$.title') FROM outcomes
      UNION ALL SELECT id, json_extract(data,'$.title') FROM tombstones
    ) t ON t.taskId=n.task_id
      WHERE n.repository IN (?,?) AND lower(trim(t.title))=lower(trim(?)) ORDER BY n.number LIMIT 1`)
      .get(repository.origin, repository.path, title);
    if (task) return { taskId: String(task.task_id) };
    const lead = this.core.db.prepare(`SELECT id FROM leads
      WHERE lower(trim(json_extract(data,'$.title')))=lower(trim(?))
      AND EXISTS (SELECT 1 FROM json_each(leads.data,'$.repositories') r WHERE json_extract(r.value,'$.origin')=?)
      ORDER BY rowid LIMIT 1`).get(title, repository.origin);
    return lead ? { leadId: String(lead.id) } : null;
  }

  addLead(lead: z.input<typeof leadSchema>, author: string): Lead {
    if (!this.core.db.isTransaction) return this.core.transaction(() => this.addLead(lead, author));
    const value = leadSchema.parse(lead);
    for (const repo of value.repositories) this.access.ensureProject(repo.path, repo.origin);
    this.core.db.prepare("INSERT INTO leads(id,state,content_key,data) VALUES(?,?,?,?)").run(value.id, value.state, value.source?.contentKey ?? null, this.storedLeadData(value, true));
    this.putLeadVersion(value, author);
    this.access.invalidateLaneActivity();
    this.core.advanceLeadRevision();
    this.indexLeadLanes(value);
    this.core.advanceRevision();
    return value;
  }

  /**
   * Keep the lead-to-lane index current inside the lead's own write (audit B7). The
   * marker records the `leadRevision` the index matches, so a write that bypassed this
   * funnel (an import, a legacy migration or an older build) rebuilds it once, lazily.
   */
  private indexLeadLanes(lead: Lead): void {
    this.core.db.prepare("DELETE FROM lead_lane_index WHERE leadId=?").run(lead.id);
    for (const lane of lead.lanes) this.core.db.prepare("INSERT OR IGNORE INTO lead_lane_index(leadId,lane) VALUES(?,?)").run(lead.id, lane);
    this.core.setMeta("leadLaneIndex", this.core.leadRevision());
  }

  ensureLeadLaneIndex(): void {
    if (this.core.getMeta<number>("leadLaneIndex") === this.core.leadRevision()) return;
    const rebuild = () => {
      this.core.db.prepare("DELETE FROM lead_lane_index").run();
      this.core.db.prepare(`INSERT OR IGNORE INTO lead_lane_index(leadId,lane) SELECT leads.id,json_each.value FROM leads, json_each(leads.data,'$.lanes')`).run();
      this.core.setMeta("leadLaneIndex", this.core.leadRevision());
    };
    if (this.core.db.isTransaction) rebuild(); else this.core.transaction(rebuild);
  }

  /**
   * Records one lead version. The new version is stored in full and, unless it is a
   * snapshot point, the version it supersedes becomes a reverse delta against it (audit
   * B1), so the history stays exact without keeping every body.
   */
  private putLeadVersion(lead: Lead, author: string) {
    const version = leadVersionSchema.parse({ version: lead.version, title: lead.title, body: lead.body, author, createdAt: lead.updatedAt,
      ...(/^---\r?\n/.test(lead.body) ? { digest: `sha256:${digest(lead.body)}` } : {}), check: lead.check,
      approval: lead.approval?.version === lead.version ? lead.approval : null });
    // Only the version this one supersedes changes form, and it is the previous latest
    // version, which is stored in full; reading its row is enough to demote it.
    const previousRow = version.version > 1
      ? this.core.db.prepare("SELECT data FROM lead_versions WHERE leadId=? AND version=?").get(lead.id, version.version - 1) as { data: string } | undefined
      : undefined;
    const previous = previousRow ? leadVersionSchema.parse(JSON.parse(String(previousRow.data))) : null;
    appendStoredHistoryVersion(this.core.db, "lead", lead.id,
      previous ? { version: previous.version, body: previous.body, data: previous } : null,
      { version: version.version, body: lead.body, data: version }, version.version);
    this.planningBodies.clear();
  }

  private storedLeadHistory(id: string): PlanningHistory {
    return new PlanningHistory(readStoredHistory(this.core.db, "lead", id), `Lead ${id}`);
  }

  private leadVersionOf(history: PlanningHistory, version: number): LeadVersion {
    const row = history.row(version);
    if (!row) throw new Error(`Lead version ${version} not found`);
    return leadVersionSchema.parse({ ...row.data, body: history.body(version, this.planningBodies) });
  }

  lead(id: string): Lead {
    const row = this.core.db.prepare("SELECT data FROM lead_read AS leads WHERE id=?").get(id);
    if (!row) throw new Error("Lead not found");
    return leadSchema.parse(JSON.parse(String(row.data)));
  }

  leadByContentKey(key: string): Lead | null {
    const row = this.core.db.prepare("SELECT data FROM lead_read AS leads WHERE content_key=?").get(key);
    return row ? leadSchema.parse(JSON.parse(String(row.data))) : null;
  }

  leadVersions(id: string): LeadVersion[] {
    const history = this.storedLeadHistory(id);
    // One downward pass rebuilds every version once; each rebuild still checks its digest.
    const bodies = history.allBodies();
    return history.rows.map(row => leadVersionSchema.parse({ ...row.data, body: bodies.get(row.version)! }));
  }

  leadVersion(id: string, version: number): LeadVersion {
    const found = this.leadVersionOrNull(id, version);
    if (!found) throw new Error(`Lead version ${version} not found`);
    return found;
  }

  /** One exact version, or null; a caller that only needs a version never reads the history. */
  leadVersionOrNull(id: string, version: number): LeadVersion | null {
    const history = this.storedLeadHistory(id);
    return history.row(version) ? this.leadVersionOf(history, version) : null;
  }

  /** Store one lead's history as part of a restore or a legacy conversion (Spec 026, contract 008 import). */
  private writeLeadHistory(id: string, versions: LeadVersion[]): void {
    writeStoredHistory(this.core.db, "lead", id, versions.map(version => ({ version: version.version, body: version.body, data: version })));
    this.planningBodies.clear();
  }

  /**
   * The detail read's version history (audit B7): the current version in full — the caller
   * already holds that body — and every older version as metadata only, with SQLite dropping
   * the body before it crosses the boundary. A 541-version lead no longer reads and parses
   * 137 MB of superseded text on every `lead.get`, and every kept version is still listed.
   */
  leadVersionHistory(id: string, currentVersion: number): Array<LeadVersion | z.infer<typeof leadVersionMetadataSchema>> {
    // A snapshot's body is removed in SQLite before it crosses the boundary (audit B7); a
    // reverse delta never stored one, so its metadata row is all there is. Only the current
    // version is read in full.
    const rows = (this.core.db.prepare(`SELECT version,CASE WHEN version=? THEN data ELSE json_remove(data,'$.body') END AS data
        FROM lead_versions WHERE leadId=?`).all(currentVersion, id) as Array<{ version: number; data: string }>)
      .map(row => ({ version: Number(row.version), data: String(row.data) }));
    rows.push(...(this.core.db.prepare("SELECT version,data FROM lead_version_deltas WHERE leadId=?").all(id) as Array<{ version: number; data: string }>)
      .map(row => ({ version: Number(row.version), data: String(row.data) })));
    rows.sort((left, right) => left.version - right.version);
    return rows.map(row => {
      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      if (row.version !== currentVersion) return leadVersionMetadataSchema.parse(parsed);
      // The current version is always stored in full; a store that lost that row still
      // rebuilds the exact bytes from its history rather than answering with metadata.
      return typeof parsed.body === "string" ? leadVersionSchema.parse(parsed) : this.leadVersionOf(this.storedLeadHistory(id), currentVersion);
    });
  }

  /** The recorded digests of every version before the latest, in version order; never a body. */
  leadVersionDigestsBeforeLatest(id: string): string[] {
    const latest = this.storedLeadHistory(id).latest;
    return (this.core.db.prepare(`SELECT version,json_extract(data,'$.digest') AS digest FROM lead_versions WHERE leadId=? AND version<?
        UNION ALL SELECT version,json_extract(data,'$.digest') FROM lead_version_deltas WHERE leadId=? AND version<?
        ORDER BY version`).all(id, latest, id, latest) as Array<{ digest: string | null }>)
      .flatMap(row => (typeof row.digest === "string" && row.digest ? [row.digest] : []));
  }

  preservePapercutVersion(lead: Lead, body: string): void {
    if (!this.core.db.isTransaction) return this.core.transaction(() => this.preservePapercutVersion(lead, body));
    if (!lead.papercut || !lead.tags.includes("papercut")) throw new Error("Lead is not a papercut");
    const history = this.storedLeadHistory(lead.id);
    if (this.leadVersionOf(history, lead.version).body === body) return;
    // The prior rendered body is kept on the version it belonged to. An ordinary store holds
    // that version in full; a history that keeps it as a reverse delta is re-encoded with the
    // replaced text, so the recorded bytes and the metadata both survive.
    const bodies = history.allBodies();
    bodies.set(lead.version, body);
    this.core.db.prepare("UPDATE leads SET data=json_set(data,'$.body',?) WHERE id=? AND json_type(data,'$.body') IS NULL")
      .run(lead.body, lead.id);
    this.writeLeadHistory(lead.id, history.rows.map(row => leadVersionSchema.parse({ ...row.data, body: bodies.get(row.version)! })));
  }

  listLeads(query: { repository?: string; lane?: string; state: Lead["state"]; pageSize?: number; before?: { createdAt: string; id: string } }): Lead[] {
    if (query.pageSize !== undefined) {
      const clauses = ["state=?"], values: (string | number)[] = [query.state];
      if (query.repository) {
        clauses.push("EXISTS (SELECT 1 FROM json_each(leads.data,'$.repositories') repo WHERE json_extract(repo.value,'$.origin')=? OR json_extract(repo.value,'$.path')=?)");
        values.push(query.repository, query.repository);
      }
      if (query.lane) { clauses.push("EXISTS (SELECT 1 FROM json_each(leads.data,'$.lanes') lane WHERE lane.value=?)"); values.push(query.lane); }
      if (query.before) {
        clauses.push("(json_extract(data,'$.createdAt') < ? OR (json_extract(data,'$.createdAt') = ? AND id < ?))");
        values.push(query.before.createdAt, query.before.createdAt, query.before.id);
      }
      values.push(query.pageSize);
      return this.core.db.prepare(`SELECT data FROM lead_read AS leads WHERE ${clauses.join(" AND ")} ORDER BY json_extract(data,'$.createdAt') DESC, id DESC LIMIT ?`)
        .all(...values).map(row => leadSchema.parse(JSON.parse(String(row.data))));
    }
    return this.core.db.prepare("SELECT data FROM lead_read AS leads WHERE state=? ORDER BY json_extract(data,'$.createdAt') DESC, rowid DESC").all(query.state)
      .map(row => leadSchema.parse(JSON.parse(String(row.data))))
      .filter(lead => (!query.repository || lead.repositories.some(repo => repo.origin === query.repository || repo.path === query.repository))
        && (!query.lane || lead.lanes.includes(query.lane)));
  }

  /**
   * Narrow planning-list read for the board (lead.board): card facts for every open lead and
   * every promoted lead that has a draft or task target and still a repository without one —
   * the same records the Pipeline projection shows — plus link facts for leads
   * outside that set which an open decision links, so decision placement keeps its lanes
   * without promoted history. The projection runs in SQLite's JSON functions and the body
   * leaves the row only as the bounded preview, so the read and its response never grow with
   * body or history bytes.
   */
  listBoardLeads(): { cards: BoardLead[]; links: BoardLeadLink[] } {
    const cards = this.core.db.prepare(
      `SELECT ${BOARD_LEAD_FACTS} AS facts, ${BOARD_LEAD_PRESENCE} AS presence,
         coalesce(substr(json_extract(data,'$.body'),1,${LEAD_PREVIEW_MAX}),'') AS preview
       FROM lead_read AS leads WHERE state IN ('open','promoted') AND (state='open' OR (
         EXISTS (SELECT 1 FROM json_each(leads.data,'$.targets') boardKind WHERE json_extract(boardKind.value,'$.kind') IN ('draft','task'))
         AND EXISTS (
           SELECT 1 FROM json_each(leads.data,'$.repositories') boardRepo
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(leads.data,'$.targets') boardTarget
             WHERE json_extract(boardTarget.value,'$.repository') = json_extract(boardRepo.value,'$.origin')
               AND json_extract(boardTarget.value,'$.kind') IN ('draft','task')))))
       ORDER BY json_extract(data,'$.createdAt') DESC, id DESC`)
      .all().map(row => boardLeadRow(String(row.facts), String(row.presence), String(row.preview)));
    // Open decisions resolve lanes and scope against linked leads, including tagged papercuts.
    // Records outside the card set carry link facts alone.
    const cardIds = new Set(cards.map(card => card.id));
    const linked = new Set<string>();
    for (const decision of this.listDecisions({ status: "open" }))
      for (const id of [...decision.links.leads, ...decision.links.papercuts]) if (!cardIds.has(id)) linked.add(id);
    const links = linked.size ? this.core.db.prepare(
      `SELECT ${BOARD_LEAD_FACTS} AS facts, ${BOARD_LEAD_PRESENCE} AS presence FROM lead_read AS leads WHERE id IN (${[...linked].map(() => "?").join(",")})`)
      .all(...linked).map(row => boardLeadLinkRow(String(row.facts), String(row.presence))) : [];
    return { cards, links };
  }

  /** Every lead whatever its state, for resolving a decision's links against terminal history. */
  leads(): Lead[] {
    return this.core.db.prepare("SELECT data FROM lead_read AS leads ORDER BY rowid").all().map(row => leadSchema.parse(JSON.parse(String(row.data))));
  }

  /**
   * The open leads only. `leads().filter(state === 'open')` parsed every retained lead and its
   * body to keep about five percent of them on each hourly drain pass and each drain-notice
   * delivery (audit B7); `leads_state` makes this an index range read.
   */
  openLeads(): Lead[] {
    return this.core.db.prepare("SELECT data FROM lead_read AS leads WHERE state='open' ORDER BY rowid").all().map(row => leadSchema.parse(JSON.parse(String(row.data))));
  }

  /** Writes the lead; a body or title change records a new version by `author`. */
  /**
   * A merged papercut-sourced lead closes with the task that completed it. One owner for
   * "what completing a task means to the records that named it": the lead's own state, its
   * closure note and its time, read from the promoted targets that name this task. Returns
   * the papercuts closed, so the caller records their audit events.
   */
  completePapercutsForTask(task: Pick<Task, "id" | "prUrl" | "finishedAt" | "updatedAt"> & { resolution: Pick<Task["resolution"], "mergedCommit"> }): Papercut[] {
    if (!task.prUrl || !task.resolution.mergedCommit) return [];
    const linked = this.core.db.prepare(`SELECT data FROM lead_read AS leads WHERE state='promoted'
      AND EXISTS (SELECT 1 FROM json_each(leads.data,'$.targets')
        WHERE json_extract(value,'$.kind')='task' AND json_extract(value,'$.reference')=?)`).all(task.id);
    const closed: Papercut[] = [];
    for (const row of linked) {
      const lead = leadSchema.parse(JSON.parse(String(row.data)));
      if (!lead.tags.includes("papercut") || !lead.papercut) continue;
      const cut = papercutFromLead(lead);
      if (cut.taskId !== task.id) continue;
      const closedAt = task.finishedAt ?? task.updatedAt;
      this.updateLead({ ...lead, state: "closed", closedAt, updatedAt: task.updatedAt,
        closure: { reason: "completed", at: closedAt,
          note: `Completed by ${task.prUrl}; merge commit ${task.resolution.mergedCommit}.` } });
      closed.push(cut);
    }
    return closed;
  }

  updateLead(lead: Lead, author?: string): Lead {
    if (!this.core.db.isTransaction) return this.core.transaction(() => this.updateLead(lead, author));
    const value = leadSchema.parse(lead);
    const result = this.core.db.prepare("UPDATE leads SET state=?,data=? WHERE id=?").run(value.state, this.storedLeadData(value, Boolean(author)), value.id);
    if (!result.changes) throw new Error("Lead not found");
    if (author) this.putLeadVersion(value, author);
    this.access.invalidateLaneActivity();
    this.core.advanceLeadRevision();
    this.indexLeadLanes(value);
    this.core.advanceRevision();
    return value;
  }

  markLeadCheckPending(id: string, version: number, expectedDigest: string, operationId: string): Lead {
    return this.core.transaction(() => {
      const lead = this.lead(id);
      if (lead.version !== version || `sha256:${digest(lead.body)}` !== expectedDigest)
        throw new Error("Lead changed before brief check was accepted; reload");
      return this.updateLead({ ...lead, checkOperationId: operationId, updatedAt: now() });
    });
  }

  recordLeadCheck(id: string, version: number, check: Lead["check"], operationId?: string): Lead {
    return this.core.transaction(() => {
      const lead = this.lead(id);
      if (lead.version !== version) throw new Error("Lead changed during check; reload");
      if (operationId && lead.checkOperationId !== operationId) throw new Error("Lead check operation changed; reload");
      const checked = check ? { ...check, baseBranch: check.baseBranch ?? lead.baseBranch } : null;
      const approvalBaseBranch = lead.approval?.baseBranch ?? (lead.baseBranch === "main" ? lead.check?.baseBranch ?? "main" : null);
      const approvalHead = lead.approval?.planningCommit ?? (lead.baseBranch === "main" ? lead.check?.planningCommit : null);
      const approval = lead.approval && checked?.ok
        && (approvalBaseBranch !== checked.baseBranch || approvalHead !== checked.planningCommit) ? null : lead.approval;
      const value = this.updateLead({ ...lead, digest: `sha256:${digest(lead.body)}`, check: checked, approval, checkOperationId: null, updatedAt: now() });
      // The checked version is the stored one: an exact metadata write, never a history parse (audit B7).
      if (!updateStoredHistoryMetadata(this.core.db, "lead", id, version, { digest: `sha256:${digest(lead.body)}`, check: checked, approval }))
        throw new Error(`Lead version ${version} not found`);
      this.planningBodies.clear();
      return value;
    });
  }

  recordLeadApproval(id: string, version: number, approval: NonNullable<Lead["approval"]>): void {
    if (!updateStoredHistoryMetadata(this.core.db, "lead", id, version, { approval })) throw new Error(`Lead version ${version} not found`);
    this.planningBodies.clear();
  }

  addDecision(record: z.input<typeof decisionSchema>): Decision {
    const value = decisionSchema.parse(record);
    this.core.db.prepare("INSERT INTO decisions(id,status,data) VALUES(?,?,?)").run(value.id, value.status, JSON.stringify(value));
    this.core.advanceLeadRevision();
    this.core.advanceRevision();
    return value;
  }

  decision(id: string): Decision {
    const row = this.core.db.prepare("SELECT data FROM decisions WHERE id=?").get(id);
    if (!row) throw new Error("Decision not found");
    // Stored rows predate the view limit or bypassed it; reads stay lenient and
    // the decision view clips the question, so one over-long record never
    // breaks a whole read. Writes keep the strict schema.
    return storedDecisionSchema.parse(JSON.parse(String(row.data)));
  }

  updateDecision(record: Decision): Decision {
    // Lenient like the other stored-record parses: the Decisions boundary
    // already validated new rows strictly, and an update must never refuse a
    // row it already holds.
    const value = storedDecisionSchema.parse(record);
    const result = this.core.db.prepare("UPDATE decisions SET status=?,data=? WHERE id=?").run(value.status, JSON.stringify(value), value.id);
    if (!result.changes) throw new Error("Decision not found");
    this.core.advanceLeadRevision();
    this.core.advanceRevision();
    return value;
  }

  /** Delivery state is operational: it never changes the decision's version or content. */
  updateDecisionDelivery(id: string, delivery: Decision["delivery"]): Decision {
    const value = this.decision(id);
    return this.updateDecision({ ...value, delivery: delivery === null ? null : decisionDeliverySchema.parse(delivery) });
  }

  listDecisions(query: { status?: Decision["status"]; asker?: string; project?: string; task?: string; lead?: string; papercut?: string } = {}): Decision[] {
    const sql = query.status ? "SELECT data FROM decisions WHERE status=? ORDER BY json_extract(data,'$.createdAt') DESC, rowid DESC"
      : "SELECT data FROM decisions ORDER BY json_extract(data,'$.createdAt') DESC, rowid DESC";
    const rows = query.status ? this.core.db.prepare(sql).all(query.status) : this.core.db.prepare(sql).all();
    return rows.map(row => storedDecisionSchema.parse(JSON.parse(String(row.data)))).filter(decision =>
      (!query.asker || decision.askedBy.agentId === query.asker)
      && (!query.project || [decision.askedBy.project?.origin, decision.askedBy.project?.path].includes(query.project))
      && (!query.task || decision.links.tasks.includes(query.task))
      && (!query.lead || decision.links.leads.includes(query.lead))
      && (!query.papercut || decision.links.papercuts.includes(query.papercut)));
  }

  /** Answered decisions whose notice has not settled; delivery retries until it does. */
  pendingDecisionDeliveries(): Decision[] {
    return this.core.db.prepare("SELECT data FROM decisions WHERE status='answered'").all()
      .map(row => storedDecisionSchema.parse(JSON.parse(String(row.data))))
      .filter(decision => decision.delivery !== null && ["pending", "intent", "uncertain"].includes(decision.delivery.status));
  }

  private storedLeadData(lead: Lead, versionWillBeWritten = false): string {
    const version = versionWillBeWritten ? lead.body : this.core.db.prepare(
      "SELECT json_extract(data,'$.body') AS body FROM lead_versions WHERE leadId=? AND version=?")
      .get(lead.id, lead.version)?.body;
    return JSON.stringify(version === lead.body ? { ...lead, body: undefined } : lead);
  }
}
