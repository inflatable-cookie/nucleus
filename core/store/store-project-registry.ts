import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { isOperatorOrigin, NUCLEUS_REPOSITORY_ORIGIN, projectSchema, projectTombstoneSchema, projectUpsertInputSchema, QUEUE_REPOSITORY_ORIGIN, type Project, type ProjectTombstone, type ProjectUpsertInput, type Task } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { digest, now, StoreCore } from "./store-core";

/**
 * One repository member against a task or query: origin identity when both sides
 * know one, else the local path. The caller normalizes `origin` before the match,
 * exactly as each lookup did before this rule had one owner.
 */
export const repositoryMemberMatches = (repo: Project["repositories"][number], repoPath: string, origin: string | null | undefined): boolean =>
  origin && repo.origin ? repo.origin === origin : repo.path === repoPath && Boolean(repo.path);

/**
 * The project registry: the one owner of project rows, their cache, their
 * membership and their default projects. Agents, limits, removal, merge and
 * management write through `persist`, never a row of their own.
 */
export class StoreProjectRegistry {
  private projectsCache: { clock: number; rows: Project[] } | null = null;
  constructor(private readonly core: StoreCore) {}
  private get db() { return this.core.db; }

  clearCache(): void { this.projectsCache = null; }

  /** Write one project row whose key is unchanged; every in-place project edit goes through here. */
  persist(project: Project): void {
    this.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(project), project.key);
  }

  /**
   * The drain episode a lane-drain evaluation decided for one project; null when the row is gone.
   * Episode state is operational, so it never bumps the operator-edit version.
   */
  setProjectDrain(key: string, drain: Project["drain"]): Project | null {
    const project = this.projectByKey(key);
    if (!project) return null;
    const updated = projectSchema.parse({ ...project, drain });
    this.persist(updated);
    this.core.advanceRevision();
    return updated;
  }

  defaultProject(repo: Project["repositories"][number]): Project {
    const identity = repo.origin ?? repo.path;
    return projectSchema.parse({ key: `repo-${digest(identity).slice(0, 20)}`, name: basename(identity), repositories: [repo], primary: repo, version: 1 });
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

  projectTombstones(): ProjectTombstone[] {
    return this.db.prepare("SELECT data FROM project_tombstones ORDER BY key").all()
      .map(row => projectTombstoneSchema.parse(JSON.parse(String(row.data))));
  }

  /** The member of a project for one repository identity, by origin or path. */
  projectMember(project: Project, repository: string): Project["repositories"][number] {
    const origin = normalizeRepositoryOrigin(repository);
    const member = project.repositories.find(repo => repositoryMemberMatches(repo, repository, origin));
    if (!member) throw new Error(`Repository ${repository} is not in project ${project.key}`);
    return member;
  }

  /** One read of the project table for many lookups; `projectFor` re-reads it per call. */
  projectKeyResolver(projects = this.projects()): (task: Pick<Task, "repoPath" | "repository">) => string | null {
    const keys = new Map<string, string | null>();
    return task => {
      const memo = `${task.repoPath}\0${task.repository ?? ""}`;
      const known = keys.get(memo);
      if (known !== undefined) return known;
      const origin = task.repository ? normalizeRepositoryOrigin(task.repository) : null;
      const key = projects.find(project => project.repositories.some(repo => repositoryMemberMatches(repo, task.repoPath, origin)))?.key ?? null;
      keys.set(memo, key);
      return key;
    };
  }

  projectFor(repoPath: string, origin?: string | null): Project | null {
    const normalizedOrigin = origin ? normalizeRepositoryOrigin(origin) : null;
    return this.projects().find(project => project.repositories.some(repo => repositoryMemberMatches(repo, repoPath, normalizedOrigin))) ?? null;
  }

  /**
   * The project a repository belongs to, creating its default one-repository project
   * when none holds it. A known origin upgrades a path-only member, and a default
   * project re-keys itself to its origin.
   */
  ensureProject(repoPath: string, origin?: string | null): Project {
    const existing = this.projectFor(repoPath, origin);
    if (existing) {
      if (repoPath && origin && existing.repositories.some(repo => repo.origin === origin && !repo.path)) {
        const updated = projectSchema.parse({ ...existing, version: existing.version + 1, repositories: existing.repositories.map(repo =>
          repo.origin === origin && !repo.path ? { ...repo, path: repoPath } : repo),
          primary: existing.primary.origin === origin ? { ...existing.primary, path: repoPath } : existing.primary });
        this.persist(updated);
        this.core.advanceRevision();
        return updated;
      }
      if (origin && existing.repositories.some(repo => !repo.origin && repo.path === repoPath)) {
        const upgraded = projectSchema.parse({ ...existing, version: existing.version + 1, repositories: existing.repositories.map(repo =>
          !repo.origin && repo.path === repoPath ? { ...repo, origin } : repo),
          primary: !existing.primary.origin && existing.primary.path === repoPath ? { ...existing.primary, origin } : existing.primary });
        if (this.isDefaultProject(existing)) {
          const replacement = this.defaultProject({ origin, path: repoPath });
          replacement.planner = existing.planner; replacement.owner = existing.owner; replacement.ownerMissingAt = existing.ownerMissingAt; replacement.ownerCheckedAt = existing.ownerCheckedAt;
          this.db.prepare("DELETE FROM projects WHERE key=?").run(existing.key);
          this.db.prepare("DELETE FROM project_tombstones WHERE key=?").run(replacement.key);
          this.db.prepare("INSERT OR REPLACE INTO projects(key,data) VALUES(?,?)").run(replacement.key, JSON.stringify(replacement));
          this.core.advanceRevision();
          return replacement;
        }
        this.persist(upgraded);
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
    const primaryIndex = parsed.repositories.findIndex(repo => repositoryMemberMatches(repo, primary.path, primary.origin));
    if (primaryIndex < 0) throw new Error("Primary repository must belong to the project");
    const repositories = [...parsed.repositories];
    repositories.unshift(...repositories.splice(primaryIndex, 1));
    const project = projectSchema.parse({ ...parsed, repositories, primary: repositories[0], version: 1 });
    const identities = project.repositories.map(repo => repo.origin ?? repo.path);
    if (new Set(identities).size !== identities.length) throw new Error("A repository may appear only once in a project");
    const write = () => {
      const previous = this.projectByKey(project.key);
      if (create && previous) throw new Error(`Project ${project.key} already exists. Nothing changed; choose another name.`);
      if (previous) project.version = previous.version + 1;
      // Spec 041: the next-aim episode is operational state; an operator edit never resets it.
      if (previous) { project.drain = previous.drain; project.planner = previous.planner; project.owner = previous.owner; project.ownerMissingAt = previous.ownerMissingAt; project.ownerCheckedAt = previous.ownerCheckedAt; }
      if (previous && !project.repositories.some(repo => repositoryMemberMatches(repo, previous.primary.path, previous.primary.origin)) &&
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

  /** Spec 058 (task 540): names the planner thread that answers delegated questions for a project. It is a plain project field, not ownership. */
  setProjectPlanner(input: { key: string; agentId: string | null; setBy: string; note?: string }, at = now()): Project {
    return this.core.transaction(() => {
      const project = this.projectByKey(input.key);
      if (!project) throw new Error(`Unknown project ${input.key}`);
      const registered = input.agentId ? (project.agents ?? []).find(agent => agent.agentId === input.agentId) : undefined;
      const planner = input.agentId
        ? { agentId: input.agentId, ...(registered ? { name: registered.name } : {}), setBy: input.setBy, setAt: at }
        : null;
      // Every assignment, including clearing or reassigning the same thread, revokes its old identity ticket.
      this.core.deleteMeta(`plannerParticipant:${input.key}`);
      this.core.setMeta(`plannerParticipantGeneration:${input.key}`, randomUUID());
      const updated = projectSchema.parse({ ...project, planner });
      this.persist(updated);
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
  retireProjectOwner(key: string, reason: string): Project | null {
    return this.core.transaction(() => {
      const project = this.projectByKey(key);
      if (!project?.owner) return project;
      const updated = projectSchema.parse({ ...project, owner: null, ownerMissingAt: null, ownerCheckedAt: null });
      this.persist(updated);
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
}
