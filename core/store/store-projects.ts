import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { taskHasUnreleasedRun, repositorySettingsSchema, DEFAULT_REPOSITORY_CHECKS_POLICY, DEFAULT_HOST_KIND, type RepositoryChecksPolicy, type HostKind, projectSchema, projectTombstoneSchema, projectUpsertInputSchema, projectDispatchLimitOverridesSchema, projectPlanSchema, projectQaRunSchema, repositoryMatchSpecificity, DEFAULT_PROJECT_LIMIT, DEFAULT_PAPERCUT_PROJECT_LIMIT, isOperatorOrigin, QUEUE_REPOSITORY_ORIGIN, NUCLEUS_REPOSITORY_ORIGIN, type Lead, type Decision, type ProjectPlan, type PendingSubmission, type Run, type Outcome, type Task, type Lane, type Project, type ProjectRemovalBlocker, type ProjectManagementPreview, type ProjectManageInput, type ProjectRemoveRepositoryInput, type ProjectMergeInput, type ProjectMergeResult, type ProjectMergeCheck, type ProjectMergeCheckInput, type ProjectTombstone, type ProjectUpsertInput, type RepositorySettings, type ProjectCloseout, type ProjectValidation, type ProjectQa } from "../../shared/contracts";
import { type QueueOperation } from "../../shared/operations";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { projectRemovalBlockerText, projectRemovalBlockers, projectRemovalRefusal, projectRepositoryMatches } from "../../shared/project-removal";
import { repositoryScratchNamespace } from "../workspaces/run-scratch";
import { applyRepositoryRekey as applyRekey, previewRepositoryRekey as previewRekey } from "../planning/repository-rekey";
import { repositoryRekeyInputSchema, repositoryRekeyReceiptSchema, type RepositoryRekeyInput, type RepositoryRekeyPreview, type RepositoryRekeyPreviewInput, type RepositoryRekeyReceipt, type RepositoryRekeyReceiptQuery, type RepositoryRekeyResult } from "../../shared/repository-rekey";
import { StoreCore, now, digest, operationInputHash } from "./store-core";

const PROJECT_DISPATCH_LIMIT_OVERRIDES_META_KEY = "projectDispatchLimitOverrides";
interface ProjectsAccess {
  rekeyed(): void;
  allTasks(): Task[];
  leads(): Lead[];
  lanes(): Lane[];
  listDecisions(query: {status?: Decision["status"]}): Decision[];
  outcomes(): Outcome[];
  taskRepositories(): Array<{taskId: string; repository: string}>;
  pendingSubmissions(): PendingSubmission[];
  numberedOperation(data: string): QueueOperation;
  operationPayload(id: string): unknown;
  plan(input: {project: string}): ProjectPlan;
  runs(taskId?: string): Run[];
  updateLead(lead: Lead): Lead;
  setLaneStatus(key: string, status: Lane["status"], note?: string): Lane;
  updateDecision(decision: Decision): Decision;
  storedPlan(project: string, version?: number): ProjectPlan | null;
}

export class StoreProjects {
  private projectsCache: {clock: number; rows: Project[]} | null = null;
  clearCache(): void { this.projectsCache = null; }
  constructor(private readonly core: StoreCore, private readonly access: ProjectsAccess) {}
  private get db() { return this.core.db; }
  /** Spec 022: a repository settings row is keyed by the repository identity — origin when known, else the local path. */
  repositoryKey(identity: RepositorySettings["repository"]): string { return identity.origin ?? identity.path; }
  repositoryByKey(key: string): RepositorySettings | null {
    const row = this.db.prepare("SELECT data FROM repository_settings WHERE key=?").get(key);
    return row ? repositorySettingsSchema.parse(JSON.parse(String(row.data))) : null;
  }
  repositories(): RepositorySettings[] {
    return this.db.prepare("SELECT data FROM repository_settings ORDER BY rowid").all().map(row => repositorySettingsSchema.parse(JSON.parse(String(row.data))));
  }
  /**
   * Spec 056: what a fresh re-key would do, read-only. It never applies later
   * drifted input: apply re-checks every one of these facts in its transaction.
   */
  previewRepositoryRekey(input: RepositoryRekeyPreviewInput): RepositoryRekeyPreview {
    return previewRekey(this.db, input, operationInputHash(input), now());
  }
  /**
   * Spec 056: one repository namespace re-key, one transaction, one durable
   * idempotent receipt. A lost reply reads the receipt written by this step;
   * repeating the same key with the same input returns it unchanged, and the
   * same key with different input refuses before any write.
   */
  rekeyRepository(input: RepositoryRekeyInput): RepositoryRekeyResult {
    const parsed = repositoryRekeyInputSchema.parse(input);
    const inputHash = operationInputHash(parsed);
    return this.core.transaction(() => {
      const existing = this.repositoryRekeyReceipt({ key: parsed.idempotencyKey });
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error("Repository re-key key already used with different input");
        return { receipt: existing, replayed: true };
      }
      const id = digest(`repository-rekey\n${parsed.idempotencyKey}`);
      const receipt = applyRekey(this.db, parsed, { id, key: parsed.idempotencyKey, inputHash, at: now() });
      this.db.prepare("INSERT INTO repository_rekeys(id,key,at,inputHash,data) VALUES(?,?,?,?,?)")
        .run(receipt.id, receipt.key, receipt.at, receipt.inputHash, JSON.stringify(receipt));
      // The re-key bypasses the write funnels, so every projection and cache that
      // derives from a re-keyed row is dropped rather than trusted.
      this.access.rekeyed();
      return { receipt, replayed: false };
    });
  }
  /** The durable receipt of one applied re-key, read by its caller key or by its id. */
  repositoryRekeyReceipt(query: RepositoryRekeyReceiptQuery): RepositoryRekeyReceipt | null {
    const row = "id" in query
      ? this.db.prepare("SELECT data FROM repository_rekeys WHERE id=?").get(query.id)
      : this.db.prepare("SELECT data FROM repository_rekeys WHERE key=?").get(query.key);
    return row ? repositoryRekeyReceiptSchema.parse(JSON.parse(String(row.data))) : null;
  }
  /** Every applied re-key receipt, oldest first; operator evidence, never rewritten. */
  repositoryRekeys(): RepositoryRekeyReceipt[] {
    return this.db.prepare("SELECT data FROM repository_rekeys ORDER BY rowid").all()
      .map(row => repositoryRekeyReceiptSchema.parse(JSON.parse(String(row.data))));
  }
  /** Match a repository settings row by exact origin slug or exact local path, so a caller may name either. */
  repositoryFor(repository: string): RepositorySettings | null {
    return this.repositories().find(project => project.repository.origin === repository || (Boolean(project.repository.path) && project.repository.path === repository)) ?? null;
  }
  /** The row a patch or set by this identity reads before it writes: its own key first, then a path-only predecessor it re-keys. */
  repositorySettingsFor(identity: RepositorySettings["repository"]): RepositorySettings | null {
    return this.repositoryByKey(identity.origin ?? identity.path)
      ?? (identity.origin && identity.path ? this.repositoryByKey(identity.path) : null);
  }
  /**
   * Fill a repository identity that arrived as an origin string. A provided path
   * is kept; an unrecognized origin falls back to that resolved path, as lead
   * and papercut writes did. With no path, the registered checkout is the one
   * `papercut.list` would resolve.
   */
  resolveRepositoryIdentity(input: { origin: string; path: string }): { origin: string; path: string } {
    const path = input.path.trim();
    if (path) return { origin: normalizeRepositoryOrigin(input.origin) ?? resolve(path), path };
    const origin = normalizeRepositoryOrigin(input.origin) ?? input.origin;
    const row = this.repositoryFor(origin);
    const hinted = (row?.repository.path ?? "").trim()
      || (this.projects().flatMap(project => project.repositories).find(repo => repo.origin === origin)?.path ?? "").trim();
    if (!hinted) throw new Error(`No local checkout for ${origin}: pass {origin, path} or register the repository first`);
    return { origin: row?.repository.origin ?? origin, path: hinted };
  }
  /** Monotonic write ordinal for repository settings rows, allocated inside the caller's transaction: durable latest-setting order independent of clock resolution. */
  nextRepositoryRevision(): number {
    const revision = (this.core.getMeta<number>("projectRevision") ?? 0) + 1;
    this.core.setMeta("projectRevision", revision);
    return revision;
  }
  putRepository(identity: RepositorySettings["repository"], closeout: ProjectCloseout | null, note: string, validation: ProjectValidation | null = null, reviewer: RepositorySettings["reviewer"] = null, qa: ProjectQa | null = null, checksPolicy: RepositorySettings["checksPolicy"] | undefined = undefined, scratchNamespace?: string | null, hostKind?: HostKind): RepositorySettings {
    if (!identity.origin && !identity.path) throw new Error("A project needs a repository origin or local path");
    const write = () => {
      // A path hint set from a real checkout survives a later origin-only set.
      const existing = this.repositoryByKey(identity.origin ?? identity.path);
      // An origin appearing after a path-only set re-keys that predecessor in the
      // loop below; its checks policy moves with the row rather than silently
      // reverting the repository to the blocking default.
      const pathOnlyPredecessor = identity.origin && identity.path ? this.repositoryByKey(identity.path) : null;
      const merged = existing && !identity.path && existing.repository.path ? { ...identity, path: existing.repository.path } : identity;
      // When an origin appears after a path-only set, the row re-keys: absorb the
      // path-keyed predecessor in the same transaction. A row that carries a known
      // origin is a different repository identity whenever its origin differs, so
      // a reused local path never absorbs — or deletes — another project's
      // permanent settings.
      for (const row of this.repositories()) {
        const rowKey = this.repositoryKey(row.repository);
        if (rowKey === this.repositoryKey(merged)) continue;
        if (row.repository.origin === null && merged.path && row.repository.path === merged.path)
          this.db.prepare("DELETE FROM repository_settings WHERE key=?").run(rowKey);
      }
      const parsed = repositorySettingsSchema.parse({ repository: merged, scratchNamespace: scratchNamespace === undefined ? existing?.scratchNamespace ?? pathOnlyPredecessor?.scratchNamespace ?? null : scratchNamespace, closeout, validation, reviewer, qa, checksPolicy: checksPolicy === undefined ? existing?.checksPolicy ?? pathOnlyPredecessor?.checksPolicy ?? null : checksPolicy, hostKind: hostKind ?? existing?.hostKind ?? pathOnlyPredecessor?.hostKind ?? DEFAULT_HOST_KIND, note, updatedAt: now(), revision: this.nextRepositoryRevision() });
      this.db.prepare("INSERT INTO repository_settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(this.repositoryKey(merged), JSON.stringify(parsed));
      this.ensureProject(merged.path, merged.origin);
      this.core.advanceRevision();
      return parsed;
    };
    return this.db.isTransaction ? write() : this.core.transaction(write);
  }
  /** Patch semantics: only the named fields change; `null` clears one and an absent field keeps its stored value. Returns the full resulting row. */
  patchRepository(identity: RepositorySettings["repository"], patch: { scratchNamespace?: string | null; closeout?: ProjectCloseout | null; validation?: ProjectValidation | null; reviewer?: RepositorySettings["reviewer"]; qa?: ProjectQa | null; checksPolicy?: RepositorySettings["checksPolicy"]; hostKind?: HostKind; note?: string }): RepositorySettings {
    const apply = () => {
      const existing = this.repositorySettingsFor(identity);
      const base = existing ?? { closeout: null, validation: null, reviewer: null, qa: null, checksPolicy: null, note: "" };
      return this.putRepository(identity, patch.closeout !== undefined ? patch.closeout : base.closeout, patch.note !== undefined ? patch.note : base.note,
        patch.validation !== undefined ? patch.validation : base.validation, patch.reviewer !== undefined ? patch.reviewer : base.reviewer,
        patch.qa !== undefined ? patch.qa : base.qa,
        patch.checksPolicy !== undefined ? patch.checksPolicy : base.checksPolicy,
        patch.scratchNamespace, patch.hostKind);
    };
    return this.db.isTransaction ? apply() : this.core.transaction(apply);
  }
  scratchNamespaceFor(task: Pick<Task, "repoPath" | "repository">): string {
    const row = this.canonicalRepository(task.repoPath, task.repository);
    return repositoryScratchNamespace(task.repository ?? task.repoPath, row?.scratchNamespace);
  }
  /** Task 382: the effective hosted-check policy for a task's repository. An absent or null setting keeps every check blocking, so existing repositories never gain advisory behaviour implicitly. */
  checksPolicyFor(task: Pick<Task, "repoPath" | "repository">): RepositoryChecksPolicy {
    return this.canonicalRepository(task.repoPath, task.repository)?.checksPolicy ?? DEFAULT_REPOSITORY_CHECKS_POLICY;
  }
  /** The canonical row a repository's settings resolve to: specificity first (origin identity over path hint), then the monotonic write revision — the same row closeout authority reads. */
  canonicalRepository(repoPath: string, origin?: string | null): RepositorySettings | null {
    const ranked = this.repositories()
      .map(project => ({ project, weight: repositoryMatchSpecificity(project, repoPath, origin) }))
      .filter(entry => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight || b.project.revision - a.project.revision);
    return ranked[0]?.project ?? null;
  }
  /** Spec 022: the closeout override for a repository with no manifest, when a repository settings row sets it. The canonical row binds tightest — origin identity over path hint — and among equally specific rows the highest monotonic write revision carries the operator's latest intent, whatever the clock did. */
  repositoryCloseoutOverride(repoPath: string, origin?: string | null): ProjectCloseout | null {
    return this.canonicalRepository(repoPath, origin)?.closeout ?? null;
  }
  defaultProject(repo: Project["repositories"][number]): Project {
    const identity = repo.origin ?? repo.path;
    return projectSchema.parse({ key: `repo-${digest(identity).slice(0, 20)}`, name: basename(identity), repositories: [repo], primary: repo, version: 1, visibility: "active" });
  }
  isDefaultProject(project: Project): boolean {
    return project.repositories.length === 1 && project.key === this.defaultProject(project.repositories[0]).key;
  }
  insertDefaultProject(repo: Project["repositories"][number]) {
    const project = this.defaultProject(repo);
    // A recreated project is live: an old tombstone for its key must not hide it
    // from an export (Spec 027 removal).
    this.db.prepare("DELETE FROM project_tombstones WHERE key=?").run(project.key);
    this.db.prepare("INSERT OR IGNORE INTO projects(key,data) VALUES(?,?)").run(project.key, JSON.stringify(project));
  }
  projects(): Project[] {
    const clock = this.core.readClock("projects");
    if (!this.projectsCache || this.projectsCache.clock !== clock) {
      const rows = this.db.prepare("SELECT data FROM projects ORDER BY rowid").all()
        .map(row => projectSchema.parse(JSON.parse(String(row.data))));
      this.projectsCache = { clock, rows };
    }
    // Preserve detached, mutable results without parsing unchanged rows again.
    return structuredClone(this.projectsCache.rows);
  }
  projectByKey(key: string): Project | null { return this.projects().find(project => project.key === key) ?? null; }
  /** The project that holds this repository's origin, whatever its stored key is. */
  queueProject(): Project | null {
    return this.projects().find(project => project.repositories.some(repo => (repo.origin === QUEUE_REPOSITORY_ORIGIN || repo.origin === NUCLEUS_REPOSITORY_ORIGIN))) ?? null;
  }
  setProjectVisibility(input: { key: string; version: number }, visibility: Project["visibility"]): Project {
    return this.core.transaction(() => {
      const project = this.projectByKey(input.key);
      if (!project) throw new Error(`Unknown project ${input.key}`);
      if (project.version !== input.version) throw new Error(`Stale project version: expected ${project.version}`);
      if (project.visibility === visibility) return project;
      const updated = projectSchema.parse({ ...project, visibility, version: project.version + 1 });
      this.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(updated), input.key);
      this.core.advanceRevision();
      return updated;
    });
  }
  /**
   * Spec 058 (task 540): names the planner thread that answers delegated questions for a project.
   * It is a plain project field, not ownership: it grants no verb, hold or notice.
   */
  setProjectPlanner(input: { key: string; agentId: string | null; setBy: string; note?: string }, at = now()): Project {
    return this.core.transaction(() => {
      const project = this.projectByKey(input.key);
      if (!project) throw new Error(`Unknown project ${input.key}`);
      const planner = input.agentId ? { agentId: input.agentId, setBy: input.setBy, setAt: at } : null;
      // Every assignment, including clearing or reassigning the same thread, revokes its old identity ticket.
      this.core.deleteMeta(`plannerParticipant:${input.key}`);
      this.core.setMeta(`plannerParticipantGeneration:${input.key}`, randomUUID());
      const updated = projectSchema.parse({ ...project, planner });
      this.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(updated), input.key);
      this.core.event(`project:${input.key}`, planner ? "project_planner_set" : "project_planner_cleared",
        planner ? `${planner.agentId} by ${planner.setBy}; previous planner ${project.planner?.agentId ?? "none"}${input.note ? `; ${input.note}` : ""}` : `was ${project.planner?.agentId ?? "none"}; by ${input.setBy}`);
      this.core.advanceRevision();
      return updated;
    });
  }
  /**
   * Spec 058 cutover 5: the one-time owner→planner migration drops a project's archived or
   * missing owner record. The live-owner case keeps its owner field as readable history and
   * gains the thread as planner instead; only a dead owner is dropped here.
   */
  retireProjectOwner(key: string, reason: string, at = now()): Project | null {
    return this.core.transaction(() => {
      const project = this.projectByKey(key);
      if (!project?.owner) return project;
      const updated = projectSchema.parse({ ...project, owner: null, ownerMissingAt: null, ownerCheckedAt: null });
      this.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(updated), key);
      this.core.event(`project:${key}`, "project_owner_retired", `${reason}; was ${project.owner.agentId} (assigned by ${project.owner.assignedBy} at ${project.owner.assignedAt})`.slice(0, 2000));
      this.core.advanceRevision();
      return updated;
    });
  }
  /**
   * Spec 058 cutover 5: the project-level notice recipient — the project's planner, else the
   * Queue planner (the project that holds origin `inflatable-cookie/paseo-northstar-queue`),
   * else null. The retired owner field is never read.
   */
  projectPlannerRecipient(project: Pick<Project, "planner"> | null | undefined): string | null {
    const planner = project?.planner?.agentId;
    if (planner && !isOperatorOrigin(planner)) return planner;
    const queuePlanner = this.queueProject()?.planner?.agentId;
    return queuePlanner && !isOperatorOrigin(queuePlanner) ? queuePlanner : null;
  }
  /** One read of the project table for many lookups; `projectFor` re-reads it per call. */
  projectKeyResolver(projects = this.projects()): (task: Pick<Task, "repoPath" | "repository">) => string | null {
    const keys = new Map<string, string | null>();
    return task => {
      const memo = `${task.repoPath}\0${task.repository ?? ""}`;
      const known = keys.get(memo);
      if (known !== undefined) return known;
      const origin = task.repository ? normalizeRepositoryOrigin(task.repository) : null;
      const key = projects.find(project => project.repositories.some(repo =>
        origin && repo.origin ? repo.origin === origin : repo.path === task.repoPath && Boolean(repo.path)))?.key ?? null;
      keys.set(memo, key);
      return key;
    };
  }
  projectFor(repoPath: string, origin?: string | null): Project | null {
    const normalizedOrigin = origin ? normalizeRepositoryOrigin(origin) : null;
    return this.projects().find(project => project.repositories.some(repo =>
      normalizedOrigin && repo.origin ? repo.origin === normalizedOrigin : repo.path === repoPath && Boolean(repo.path))) ?? null;
  }
  projectDispatchLimitOverrides(): Record<string, number> {
    return projectDispatchLimitOverridesSchema.parse(this.core.getMeta<unknown>(PROJECT_DISPATCH_LIMIT_OVERRIDES_META_KEY) ?? {});
  }
  setProjectDispatchLimitOverride(projectKey: string, limit: number | null) {
    const overrides = this.projectDispatchLimitOverrides();
    if (limit === null) delete overrides[projectKey];
    else overrides[projectKey] = limit;
    this.core.setMeta(PROJECT_DISPATCH_LIMIT_OVERRIDES_META_KEY, overrides);
  }
  /**
   * A project's in-flight cap: always twice its effective slot limit (Tom, 2026-11-08).
   * A value an older build stored under `projectInFlightLimitOverrides` is ignored.
   */
  projectInFlightLimitFor(task: Pick<Task, "repoPath" | "repository">): number {
    return 2 * this.projectDispatchLimitFor(task);
  }
  projectDispatchLimitResolver(): (task: Pick<Task, "repoPath" | "repository">) => number {
    const projectLimit = this.core.getMeta<number>("projectLimit") ?? DEFAULT_PROJECT_LIMIT;
    const overrides = this.projectDispatchLimitOverrides();
    const projects = this.projects();
    return task => {
      const project = projects.find(candidate => candidate.repositories.some(repo =>
        task.repository && repo.origin ? repo.origin === task.repository : repo.path === task.repoPath && Boolean(repo.path)));
      return project ? overrides[project.key] ?? projectLimit : projectLimit;
    };
  }
  papercutDispatchPolicy() {
    const projects = this.projects();
    return {
      limit: this.core.getMeta<number>("papercutProjectLimit") ?? DEFAULT_PAPERCUT_PROJECT_LIMIT,
      projectKeyFor: (task: Task) => projects.find(project => project.repositories.some(repo =>
        task.repository && repo.origin ? repo.origin === task.repository : repo.path === task.repoPath && Boolean(repo.path)))?.key ?? task.repository ?? task.repoPath,
    };
  }
  projectDispatchLimitFor(task: Pick<Task, "repoPath" | "repository">): number {
    return this.projectDispatchLimitResolver()(task);
  }
  ensureProject(repoPath: string, origin?: string | null): Project {
    const existing = this.projectFor(repoPath, origin);
    if (existing) {
      if (repoPath && origin && existing.repositories.some(repo => repo.origin === origin && !repo.path)) {
        const updated = projectSchema.parse({ ...existing, version: existing.version + 1, repositories: existing.repositories.map(repo =>
          repo.origin === origin && !repo.path ? { ...repo, path: repoPath } : repo),
          primary: existing.primary.origin === origin ? { ...existing.primary, path: repoPath } : existing.primary });
        this.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(updated), existing.key);
        this.core.advanceRevision();
        return updated;
      }
      if (origin && existing.repositories.some(repo => !repo.origin && repo.path === repoPath)) {
        const upgraded = projectSchema.parse({ ...existing, version: existing.version + 1, repositories: existing.repositories.map(repo =>
          !repo.origin && repo.path === repoPath ? { ...repo, origin } : repo),
          primary: !existing.primary.origin && existing.primary.path === repoPath ? { ...existing.primary, origin } : existing.primary });
        if (this.isDefaultProject(existing)) {
          const replacement = this.defaultProject({ origin, path: repoPath });
          replacement.visibility = existing.visibility; replacement.planner = existing.planner; replacement.owner = existing.owner; replacement.ownerMissingAt = existing.ownerMissingAt; replacement.ownerCheckedAt = existing.ownerCheckedAt;
          this.db.prepare("DELETE FROM projects WHERE key=?").run(existing.key);
          this.db.prepare("DELETE FROM project_tombstones WHERE key=?").run(replacement.key);
          this.db.prepare("INSERT OR REPLACE INTO projects(key,data) VALUES(?,?)").run(replacement.key, JSON.stringify(replacement));
          this.core.advanceRevision();
          return replacement;
        }
        this.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(upgraded), existing.key);
        this.core.advanceRevision();
        return upgraded;
      }
      return existing;
    }
    const repo = { origin: origin ?? null, path: repoPath };
    const project = this.defaultProject(repo);
    this.insertDefaultProject(repo);
    this.core.advanceRevision();
    return project;
  }
  upsertProject(input: ProjectUpsertInput): Project {
    const { create, ...parsed } = projectUpsertInputSchema.parse(input);
    const primary = parsed.primary ?? parsed.repositories[0];
    const primaryIndex = parsed.repositories.findIndex(repo =>
      repo.origin && primary.origin ? repo.origin === primary.origin : Boolean(repo.path && repo.path === primary.path));
    if (primaryIndex < 0) throw new Error("Primary repository must belong to the project");
    const repositories = [...parsed.repositories];
    repositories.unshift(...repositories.splice(primaryIndex, 1));
    const project = projectSchema.parse({ ...parsed, repositories, primary: repositories[0], version: 1, visibility: "active" });
    const identities = project.repositories.map(repo => repo.origin ?? repo.path);
    if (new Set(identities).size !== identities.length) throw new Error("A repository may appear only once in a project");
    const write = () => {
      const previous = this.projectByKey(project.key);
      if (create && previous) throw new Error(`Project ${project.key} already exists. Nothing changed; choose another name.`);
      if (previous) { project.version = previous.version + 1; project.visibility = previous.visibility; }
      // Spec 041: the next-aim episode is operational state; an operator edit never resets it.
      if (previous) { project.drain = previous.drain; project.planner = previous.planner; project.owner = previous.owner; project.ownerMissingAt = previous.ownerMissingAt; project.ownerCheckedAt = previous.ownerCheckedAt; }
      if (previous && !project.repositories.some(repo =>
        repo.origin && previous.primary.origin ? repo.origin === previous.primary.origin : Boolean(repo.path && repo.path === previous.primary.path)) &&
        (!parsed.primary || (parsed.primary.origin && previous.primary.origin ? parsed.primary.origin === previous.primary.origin : parsed.primary.path === previous.primary.path)))
        throw new Error("Name another primary repository before removing the current primary");
      for (const repo of project.repositories) {
        const owner = this.projectFor(repo.path, repo.origin);
        if (owner && owner.key !== project.key && !this.isDefaultProject(owner))
          throw new Error(`Repository ${repo.origin ?? repo.path} already belongs to project ${owner.key}`);
      }
      for (const repo of project.repositories) {
        const owner = this.projectFor(repo.path, repo.origin);
        if (owner && owner.key !== project.key)
          this.db.prepare("DELETE FROM projects WHERE key=?").run(owner.key);
      }
      this.db.prepare("INSERT INTO projects(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
        .run(project.key, JSON.stringify(project));
      // An explicit re-create clears the tombstone, so the project exports again.
      this.db.prepare("DELETE FROM project_tombstones WHERE key=?").run(project.key);
      for (const repo of previous?.repositories ?? []) {
        if (!project.repositories.some(member => (member.origin ?? member.path) === (repo.origin ?? repo.path)))
          this.insertDefaultProject(repo);
      }
      this.core.advanceRevision();
      return project;
    };
    return this.db.isTransaction ? write() : this.core.transaction(write);
  }
  projectTombstones(): ProjectTombstone[] {
    return this.db.prepare("SELECT data FROM project_tombstones ORDER BY key").all()
      .map(row => projectTombstoneSchema.parse(JSON.parse(String(row.data))));
  }
  /**
   * Spec 027: the blockers a removal refusal would name, read by the board so its
   * confirmation never recomputes them from a filtered view.
   */
  /** Confirmation identity excludes task progress, but includes every task ID and complete planning records. */
  managementRecords(key: string) {
    const project = this.projectByKey(key);
    if (!project) throw new Error(`Unknown project ${key}`);
    const matches = (repo: { origin?: string | null; path?: string | null }) => projectRepositoryMatches(project, repo.path, repo.origin);
    const tasks = this.access.allTasks().filter(task => projectRepositoryMatches(project, task.repoPath, task.repository));
    const leads = this.access.leads().filter(lead => (lead.state === "open" || lead.state === "promoted" && Boolean(lead.papercut)) && lead.repositories.some(matches));
    const lanes = this.access.lanes().filter(lane => (lane.status === "active" || lane.status === "paused") && lane.repositories.some(matches));
    // Resolve by ID through the same authoritative blocker predicate, including purged task history.
    const decisions = this.access.listDecisions({status:"open"}).filter(decision => projectRemovalBlockers(project, {
      tasks:this.access.allTasks(), leads:this.access.leads(), outcomes:this.access.outcomes(), taskRepositories:this.access.taskRepositories(),
      lanes:[], submissions:[], decisions:[decision],
    }).some(blocker => blocker.kind === "decision"));
    const submissions = this.access.pendingSubmissions().filter(item => projectRepositoryMatches(project, item.repoPath, item.repository));
    const operations = this.db.prepare("SELECT data FROM operations WHERE state IN ('pending','running','needs_attention') ORDER BY rowid").all().map(row=>this.access.numberedOperation(String(row.data))).filter(operation=>{
      const payload=this.access.operationPayload(operation.id) as {id?:string;source?:{id?:string};submission?:{repoPath:string};input?:{submission?:{repoPath:string}}}|null;
      return projectRepositoryMatches(project,operation.repoPath) || Boolean(operation.taskId && tasks.some(task=>task.id===operation.taskId)) || Boolean(payload && (
        leads.some(lead=>lead.id===(payload.source?.id??payload.id)) ||
        projectRepositoryMatches(project,payload.submission?.repoPath??payload.input?.submission?.repoPath)));
    });
    const qa = this.db.prepare("SELECT data FROM project_qa_runs WHERE json_extract(data,'$.state') IN ('queued','running') OR json_extract(data,'$.finishedAt') IS NULL").all()
      .map(row=>projectQaRunSchema.parse(JSON.parse(String(row.data)))).filter(run=>matches(run.repository));
    return {project,tasks,leads,lanes,decisions,submissions,operations,qa,plan:this.access.plan({project:key})};
  }
  projectManagementPreview(input: {key: string; target?: string}): ProjectManagementPreview {
    if (input.target === input.key) throw new Error("Choose a different destination project");
    const records = this.managementRecords(input.key);
    const target = input.target ? this.managementRecords(input.target) : null;
    const shared = (repos: Array<{origin?:string|null;path?:string|null}>) => repos.some(repo => !projectRepositoryMatches(records.project,repo.path,repo.origin));
    const items: ProjectManagementPreview["items"] = [
      ...records.tasks.filter(task=>task.phase!=="done"&&task.phase!=="cancelled").map(task=>({kind:"task" as const,id:task.id,label:task.reference??task.title,shared:false})),
      ...records.leads.map(lead=>({kind:lead.papercut?"papercut" as const:"lead" as const,id:lead.id,label:lead.title,shared:shared(lead.repositories)})),
      ...records.lanes.map(lane=>({kind:"lane" as const,id:lane.key,label:lane.title||lane.key,shared:shared(lane.repositories)})),
      ...records.decisions.map(decision=>({kind:"decision" as const,id:decision.id,label:decision.question,shared:true})),
      ...records.operations.map(item=>({kind:"operation" as const,id:item.id,label:`${item.kind}: ${item.state}`,shared:false})),
      ...records.qa.map(item=>({kind:"qa" as const,id:item.id,label:`QA ${item.state}`,shared:false})),
      ...records.submissions.map(item=>({kind:"submission" as const,id:item.id,label:item.title,shared:false})),
    ];
    const identity = (value: typeof records) => ({...value,tasks:value.tasks.map(task=>task.id).sort()});
    const cancellation=this.db.prepare("SELECT value FROM meta WHERE key LIKE 'bulkDisposition:%' ORDER BY rowid DESC").all()
      .map(row=>JSON.parse(String(row.value)) as import("../../shared/contracts").BulkDisposition)
      .find(batch=>batch.operationId?.startsWith(`project-removal-${input.key.slice(0,64)}-`) && batch.action==="cancel" && batch.workDisposition==="preserve" && batch.items.length>0 && batch.items.every(item=>records.tasks.some(task=>task.id===item.taskId)))??null;
    return {project:records.project,target:target?.project??null,items,cancellation,
      tasks:records.tasks.filter(task=>task.phase!=="done"&&task.phase!=="cancelled").map(task=>({taskId:task.id,version:task.version})),
      digest:digest(JSON.stringify([identity(records),target ? identity(target) : null]))};
  }
  resetProjectCancellation(input: {key:string;operationId:string;tasks:Array<{taskId:string;version:number}>}) {
    return this.core.transaction(() => {
      if (!input.operationId.startsWith(`project-removal-${input.key.slice(0,64)}-`)) throw new Error("Cancellation identity does not belong to this project cleanup");
      if (this.core.getMeta(`bulkDisposition:${input.operationId}`)) throw new Error("Cancellation was accepted; reconcile its existing receipt instead");
      const refused=this.core.getMeta<{input:import("../../shared/contracts").BulkDispositionRequest}>(`bulkDispositionRefused:${input.operationId}`);
      if (!refused || refused.input.action!=="cancel" || refused.input.workDisposition!=="preserve" || JSON.stringify(refused.input.tasks)!==JSON.stringify(input.tasks))
        throw new Error("No matching definitive refusal; preserve uncertain delivery and reconcile its original identity");
      const records=this.managementRecords(input.key);
      const current=input.tasks.map(item=>{
        const task=records.tasks.find(task=>task.id===item.taskId);
        if (!task) throw new Error("Cancellation task identity is not in this project");
        return {task,version:item.version};
      });
      if (!current.some(({task,version})=>task.version>version && !task.disposition)) throw new Error("Unaccepted delivery is not proven stale; preserve the request identity and reconcile it");
      // The same transaction retires the ID. A queued or late original delivery
      // checks this fence before ever accepting a batch or cancelling a task.
      this.core.setMeta(`bulkDispositionRetired:${input.operationId}`,{reason:"Stale unaccepted project cancellation",tasks:input.tasks,at:now()});
      return {reset:true as const};
    });
  }
  manageRemoveProject(input: ProjectManageInput): ProjectTombstone {
    return this.core.transaction(() => {
      const receiptKey=`projectManagement:${input.key}:${input.digest}`;
      const receipt=this.core.getMeta<{input:ProjectManageInput;result:ProjectTombstone}>(receiptKey);
      if (receipt) {
        if (JSON.stringify(receipt.input)!==JSON.stringify(input)) throw new Error("This confirmation already belongs to another project cleanup request");
        return receipt.result;
      }
      const record=(result:ProjectTombstone)=>{this.core.setMeta(receiptKey,{input,result});return result};
      const preview = this.projectManagementPreview({key:input.key,target:input.target});
      if (preview.project.version!==input.version || preview.digest!==input.digest) throw new Error("Project or attached work changed; refresh the confirmation before continuing");
      const records = this.managementRecords(input.key);
      if (records.qa.length) throw new Error("Project QA must settle before moving or deleting the project");
      if (input.target) {
        if (input.cancellationOperationId) throw new Error("Reassignment must not cancel work");
        const destination = preview.target!;
        const members = [...destination.repositories];
        for (const repo of records.project.repositories) if (!members.some(member=>(member.origin??member.path)===(repo.origin??repo.path))) members.push(repo);
        const updated = projectSchema.parse({...destination,repositories:members,version:destination.version+1});
        const targetPlan = this.access.plan({project:destination.key});
        this.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(updated),destination.key);
        let nextPlanVersion = targetPlan.version;
        for (const row of this.db.prepare("SELECT data FROM project_plans WHERE project=? ORDER BY version").all(input.key)) {
          const old = projectPlanSchema.parse(JSON.parse(String(row.data)));
          this.db.prepare("INSERT INTO project_plans(project,version,data) VALUES(?,?,?)").run(destination.key,++nextPlanVersion,JSON.stringify({...old,project:destination.key,version:nextPlanVersion}));
        }
        const entries = [...targetPlan.entries,...records.plan.entries.filter(entry=>!targetPlan.entries.some(existing=>existing.lane===entry.lane))];
        this.db.prepare("INSERT INTO project_plans(project,version,data) VALUES(?,?,?)").run(destination.key,++nextPlanVersion,JSON.stringify(projectPlanSchema.parse({project:destination.key,version:nextPlanVersion,entries,author:"operator (project management)",createdAt:now()})));
        // Record history stays on its original repository identities; only membership changes.
        this.db.prepare("DELETE FROM project_plans WHERE project=?").run(input.key);
        this.db.prepare("DELETE FROM projects WHERE key=?").run(input.key);
        const tombstone = projectTombstoneSchema.parse({key:input.key,repositories:records.project.repositories,reason:input.reason,removedAt:now()});
        this.db.prepare("INSERT INTO project_tombstones(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(input.key,JSON.stringify(tombstone));
        this.core.advanceRevision();
        return record(tombstone);
      }
      if (records.operations.length) throw new Error("Accepted operations must settle before removal; move the project contents instead or resolve the listed operations");
      if (records.submissions.length) throw new Error("Pending submissions must settle before removal; move the project contents instead or refresh after settlement");
      if (preview.tasks.length) throw new Error("Cancel the listed tasks with preserved work before removing the project");
      // Cancellation has external side effects; finish only after its durable operation and all leases settle.
      if (input.cancellationOperationId) {
        const operation = this.core.getMeta<import("../../shared/contracts").BulkDisposition>(`bulkDisposition:${input.cancellationOperationId}`);
        if (!operation || operation.status!=="complete" || operation.action!=="cancel" || operation.workDisposition!=="preserve" || operation.items.some(item=>!records.tasks.some(task=>task.id===item.taskId)))
          throw new Error("Task cancellation has not completed for this project");
      }
      if (records.tasks.some(task=>taskHasUnreleasedRun(task,this.access.runs(task.id).some(run=>!run.released)) || (task.disposition && task.disposition.status!=="complete"))) throw new Error("Task work preservation is still settling; refresh before deleting");
      const stamp=now();
      for (const lead of records.leads) this.access.updateLead({...lead,state:lead.papercut?"closed":"dropped",dropReason:lead.papercut?lead.dropReason:input.reason,
        closure:lead.papercut?{reason:"deprecated",note:input.reason,at:stamp}:lead.closure,updatedAt:stamp,closedAt:stamp});
      for (const lane of records.lanes) this.access.setLaneStatus(lane.key,"abandoned",input.reason);
      for (const decision of records.decisions) {
        const withdrawal={reason:input.reason,withdrawnBy:"operator (project management)",withdrawnAt:stamp};
        this.access.updateDecision({...decision,status:"withdrawn",withdrawal,version:decision.version+1,updatedAt:stamp,
          versions:[...decision.versions,{version:decision.version+1,question:decision.question,context:decision.context,options:decision.options,recommendation:decision.recommendation,headline:decision.headline,choices:decision.choices,recommended:decision.recommended,details:decision.details,links:decision.links,status:"withdrawn",answer:decision.answer,withdrawal,supersededBy:decision.supersededBy,by:withdrawal.withdrawnBy,at:stamp}]});
      }
      return record(this.removeProject({key:input.key,version:input.version,reason:input.reason}));
    });
  }
  removalBlockers(key: string, repository?: string): ProjectRemovalBlocker[] {
    const found = this.projectByKey(key);
    if (!found) throw new Error(`Unknown project ${key}`);
    // One member alone: the blockers the project it would become would have (nucleus#967).
    const project = repository === undefined ? found : { ...found, repositories: [this.projectMember(found, repository)] };
    return projectRemovalBlockers(project, {
      tasks: this.access.allTasks(), leads: this.access.leads(), outcomes: this.access.outcomes(), taskRepositories: this.access.taskRepositories(), lanes: this.access.lanes(),
      submissions: this.access.pendingSubmissions(), decisions: this.access.listDecisions({ status: "open" }),
    });
  }
  projectMember(project: Project, repository: string): Project["repositories"][number] {
    const origin = normalizeRepositoryOrigin(repository);
    const member = project.repositories.find(repo => origin && repo.origin ? repo.origin === origin : Boolean(repo.path && repo.path === repository));
    if (!member) throw new Error(`Repository ${repository} is not in project ${project.key}`);
    return member;
  }
  /**
   * nucleus#967: take a member out of a project and delete the one-repository
   * project it becomes, as one write. A blocker, a stale version or the primary
   * refuses the whole step, so the repository never ends up split off but not removed.
   */
  removeProjectRepository(input: ProjectRemoveRepositoryInput): { project: Project; tombstone: ProjectTombstone } {
    return this.core.transaction(() => {
      const project = this.projectByKey(input.key);
      if (!project) throw new Error(`Unknown project ${input.key}`);
      if (project.version !== input.version) throw new Error(`Stale project version: expected ${project.version}`);
      const member = this.projectMember(project, input.repository);
      const identity = member.origin ?? member.path;
      if (identity === (project.primary.origin ?? project.primary.path)) throw new Error("Name another primary repository before removing the current primary");
      const blockers = this.removalBlockers(input.key, input.repository);
      if (blockers.length) throw new Error(`Repository ${identity} cannot be removed: ${projectRemovalBlockerText(blockers)}`);
      const rest = project.repositories.filter(repo => (repo.origin ?? repo.path) !== identity);
      const updated = this.upsertProject({ key: project.key, name: project.name, repositories: rest, ...(rest.length > 1 ? { primary: project.primary } : {}) });
      const split = this.projectFor(member.path, member.origin);
      if (!split || split.repositories.length !== 1) throw new Error(`Repository ${identity} did not split into its own project`);
      const tombstone = this.removeProject({ key: split.key, version: split.version, reason: input.reason });
      return { project: updated, tombstone };
    });
  }
  /**
   * Spec 027: delete a project record. Anything still using it blocks the delete
   * and is named; a durable tombstone keeps an export or import from resurrecting
   * it, and a repository settings row shared with another project stays.
   */
  removeProject(input: { key: string; version: number; reason: string }): ProjectTombstone {
    const write = () => {
      const project = this.projectByKey(input.key);
      if (!project) throw new Error(`Unknown project ${input.key}`);
      if (project.version !== input.version) throw new Error(`Stale project version: expected ${project.version}`);
      const blockers = this.removalBlockers(input.key);
      if (blockers.length) throw new Error(projectRemovalRefusal(project, blockers));
      return this.retireProject(project, input.reason);
    };
    return this.db.isTransaction ? write() : this.core.transaction(write);
  }
  /**
   * The record side of a removal, inside the caller's transaction: the row, its
   * plan, its slot override and any settings row no remaining project uses go,
   * and a tombstone keeps an export or import from resurrecting it.
   */
  retireProject(project: Project, reason: string): ProjectTombstone {
    this.db.prepare("DELETE FROM projects WHERE key=?").run(project.key);
    const remaining = this.projects();
    for (const row of this.repositories()) {
      const belongs = projectRepositoryMatches(project, row.repository.path, row.repository.origin);
      const used = remaining.some(candidate => projectRepositoryMatches(candidate, row.repository.path, row.repository.origin));
      if (belongs && !used) this.db.prepare("DELETE FROM repository_settings WHERE key=?").run(this.repositoryKey(row.repository));
    }
    // A plan keys on the project key and has no meaning without it; clear it so
    // the export never carries a dangling plan into an import.
    this.db.prepare("DELETE FROM project_plans WHERE project=?").run(project.key);
    if (project.key in this.projectDispatchLimitOverrides()) this.setProjectDispatchLimitOverride(project.key, null);
    const tombstone = projectTombstoneSchema.parse({ key: project.key, repositories: project.repositories, reason, removedAt: now() });
    this.db.prepare("INSERT INTO project_tombstones(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(tombstone.key, JSON.stringify(tombstone));
    this.core.advanceRevision();
    return tombstone;
  }
  /**
   * nucleus#984: what a move would refuse on, and what it carries along. A move
   * takes every record attached to the moving repositories with them (tasks,
   * leads, papercuts, lanes, drafts, submissions, decisions, QA history), so
   * those are `carried`, not blockers. Only state that can't change projects
   * mid-flight blocks: a queued or running project QA, or an in-flight
   * repository re-key, on a moving repository.
   */
  mergeCheck(input: ProjectMergeCheckInput): ProjectMergeCheck {
    const source = this.projectByKey(input.source);
    if (!source) throw new Error(`Unknown project ${input.source}`);
    const moving = input.repository === undefined ? source : { ...source, repositories: [this.projectMember(source, input.repository)] };
    return { blockers: this.mergeBlockers(moving), carried: this.removalBlockers(source.key, input.repository) };
  }
  mergeBlockers(moving: Project): ProjectRemovalBlocker[] {
    const label = (repo: { origin?: string | null; path?: string | null }) => repo.origin ?? repo.path ?? "repository";
    const qa = this.db.prepare("SELECT data FROM project_qa_runs WHERE json_extract(data,'$.state') IN ('queued','running') OR json_extract(data,'$.finishedAt') IS NULL").all()
      .map(row => projectQaRunSchema.parse(JSON.parse(String(row.data)))).filter(run => projectRepositoryMatches(moving, run.repository.path, run.repository.origin));
    const rekeys = this.db.prepare("SELECT payload FROM operations WHERE kind='repository_rekey' AND state IN ('pending','running','needs_attention') ORDER BY rowid").all()
      .map(row => (JSON.parse(String(row.payload)) as { input?: { source?: string } } | null)?.input?.source).filter((source): source is string => Boolean(source && projectRepositoryMatches(moving, source, source)));
    const blockers: ProjectRemovalBlocker[] = [];
    if (qa.length) blockers.push({ kind: "qa", label: "project QA run", names: qa.map(run => `${label(run.repository)} ${run.state}`) });
    if (rekeys.length) blockers.push({ kind: "operation", label: "repository re-key", names: rekeys });
    return blockers;
  }
  /**
   * nucleus#969: move a project, or one of its members, into another project as
   * one write. The target keeps its name, planner, slots and primary. Records
   * attached to the moving repositories follow them unchanged (nucleus#984); a
   * source left empty is removed, its saved plan entries join the end of the
   * target's plan and its slot override goes. Only `mergeBlockers` refuse. A
   * repository is never in two projects.
   */
  mergeProject(input: ProjectMergeInput): ProjectMergeResult {
    return this.core.transaction(() => {
      if (input.source === input.target) throw new Error("Choose a different project to move into");
      const source = this.projectByKey(input.source), target = this.projectByKey(input.target);
      if (!source) throw new Error(`Unknown project ${input.source}`);
      if (!target) throw new Error(`Unknown project ${input.target}`);
      if (source.version !== input.versions.source) throw new Error(`Stale project version for ${source.key}: expected ${source.version}`);
      if (target.version !== input.versions.target) throw new Error(`Stale project version for ${target.key}: expected ${target.version}`);
      const moving = input.repository === undefined ? source.repositories : [this.projectMember(source, input.repository)];
      const blockers = this.mergeBlockers({ ...source, repositories: moving });
      if (blockers.length) throw new Error(`${source.name} cannot move into ${target.name}: ${projectRemovalBlockerText(blockers)}`);
      const identity = (repo: Project["repositories"][number]) => repo.origin ?? repo.path;
      const rest = source.repositories.filter(repo => !moving.some(moved => identity(moved) === identity(repo)));
      let kept: Project | null = null, tombstone: ProjectTombstone | null = null;
      if (rest.length) {
        if (!rest.some(repo => identity(repo) === identity(source.primary)))
          throw new Error(`Name another primary repository in ${source.name} before moving its current primary`);
        kept = this.upsertProject({ key: source.key, name: source.name, repositories: rest, ...(rest.length > 1 ? { primary: source.primary } : {}) });
      } else if (!this.isDefaultProject(source)) {
        this.db.prepare("DELETE FROM projects WHERE key=?").run(source.key);
      }
      const members = [...target.repositories, ...moving.filter(repo => !target.repositories.some(member => identity(member) === identity(repo)))];
      const project = this.upsertProject({ key: target.key, name: target.name, repositories: members, primary: target.primary });
      if (!rest.length && !this.isDefaultProject(source)) {
        this.mergePlanInto(source.key, target.key);
        tombstone = this.retireProject(source, input.reason);
      }
      for (const repo of moving) {
        const holders = this.projects().filter(candidate => projectRepositoryMatches(candidate, repo.path, repo.origin));
        if (holders.length !== 1) throw new Error(`Repository ${identity(repo)} would be in ${holders.length} projects; nothing changed`);
      }
      return { project, source: kept, tombstone };
    });
  }
  /**
   * nucleus#984: a removed source's saved plan order joins the end of the
   * target's, skipping lanes the target already orders, as one new target plan
   * version. The target's idle mark stays only while no now or next lane joins.
   */
  mergePlanInto(source: string, target: string): void {
    const from = this.access.storedPlan(source);
    if (!from?.entries.length) return;
    const into = this.access.storedPlan(target);
    const known = new Set((into?.entries ?? []).map(entry => entry.lane));
    const entries = [...(into?.entries ?? []), ...from.entries.filter(entry => !known.has(entry.lane))].slice(0, 200);
    if (entries.length === (into?.entries.length ?? 0)) return;
    const idle = into?.idle && !entries.some(entry => entry.horizon === "now" || entry.horizon === "next") ? { idle: into.idle } : {};
    const version = (into?.version ?? 0) + 1;
    this.db.prepare("INSERT INTO project_plans(project,version,data) VALUES(?,?,?)").run(target, version,
      JSON.stringify(projectPlanSchema.parse({ project: target, version, entries, author: "operator (project management)", createdAt: now(), ...idle })));
  }
}
