import { projectRemovalBlockerText, projectRemovalBlockers, projectRemovalRefusal, projectRepositoryMatches } from "../../shared/project-removal";
import { projectTombstoneSchema, type Decision, type Lane, type Lead, type Outcome, type PendingSubmission, type Project, type ProjectRemoveRepositoryInput, type ProjectRemovalBlocker, type ProjectTombstone, type Task } from "../../shared/contracts";
import { now, StoreCore } from "./store-core";
import { repositoryKey, type StoreRepositorySettings } from "./store-repository-settings";
import { type StoreProjectLimits } from "./store-project-limits";
import { type StoreProjectRegistry } from "./store-project-registry";

interface RemovalAccess {
  allTasks(): Task[];
  leads(): Lead[];
  lanes(): Lane[];
  outcomes(): Outcome[];
  taskRepositories(): Array<{ taskId: string; repository: string }>;
  pendingSubmissions(): PendingSubmission[];
  listDecisions(query: { status?: Decision["status"] }): Decision[];
}

/**
 * Project removal: the blockers a removal names, the record side of a removal (the
 * row, its plan, its slot override and any settings row no remaining project uses,
 * plus the tombstone) and the one-repository split of a member.
 */
export class StoreProjectRemoval {
  constructor(private readonly core: StoreCore, private readonly registry: StoreProjectRegistry,
    private readonly settings: StoreRepositorySettings, private readonly limits: StoreProjectLimits, private readonly access: RemovalAccess) {}
  private get db() { return this.core.db; }

  /**
   * Spec 027: the blockers a removal refusal would name, read by the board so its
   * confirmation never recomputes them from a filtered view.
   */
  removalBlockers(key: string, repository?: string): ProjectRemovalBlocker[] {
    const found = this.registry.projectByKey(key);
    if (!found) throw new Error(`Unknown project ${key}`);
    // One member alone: the blockers the project it would become would have (nucleus#967).
    const project = repository === undefined ? found : { ...found, repositories: [this.registry.projectMember(found, repository)] };
    return projectRemovalBlockers(project, {
      tasks: this.access.allTasks(), leads: this.access.leads(), outcomes: this.access.outcomes(), taskRepositories: this.access.taskRepositories(), lanes: this.access.lanes(),
      submissions: this.access.pendingSubmissions(), decisions: this.access.listDecisions({ status: "open" }),
    });
  }

  /**
   * nucleus#967: take a member out of a project and delete the one-repository
   * project it becomes, as one write. A blocker, a stale version or the primary
   * refuses the whole step, so the repository never ends up split off but not removed.
   */
  removeProjectRepository(input: ProjectRemoveRepositoryInput): { project: Project; tombstone: ProjectTombstone } {
    return this.core.transaction(() => {
      const project = this.registry.projectByKey(input.key);
      if (!project) throw new Error(`Unknown project ${input.key}`);
      if (project.version !== input.version) throw new Error(`Stale project version: expected ${project.version}`);
      const member = this.registry.projectMember(project, input.repository);
      const identity = member.origin ?? member.path;
      if (identity === (project.primary.origin ?? project.primary.path)) throw new Error("Name another primary repository before removing the current primary");
      const blockers = this.removalBlockers(input.key, input.repository);
      if (blockers.length) throw new Error(`Repository ${identity} cannot be removed: ${projectRemovalBlockerText(blockers)}`);
      const rest = project.repositories.filter(repo => (repo.origin ?? repo.path) !== identity);
      const updated = this.registry.upsertProject({ key: project.key, name: project.name, repositories: rest, ...(rest.length > 1 ? { primary: project.primary } : {}) });
      const split = this.registry.projectFor(member.path, member.origin);
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
      const project = this.registry.projectByKey(input.key);
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
    const remaining = this.registry.projects();
    for (const row of this.settings.repositories()) {
      const belongs = projectRepositoryMatches(project, row.repository.path, row.repository.origin);
      const used = remaining.some(candidate => projectRepositoryMatches(candidate, row.repository.path, row.repository.origin));
      if (belongs && !used) this.db.prepare("DELETE FROM repository_settings WHERE key=?").run(repositoryKey(row.repository));
    }
    // A plan keys on the project key and has no meaning without it; clear it so
    // the export never carries a dangling plan into an import.
    this.db.prepare("DELETE FROM project_plans WHERE project=?").run(project.key);
    if (project.key in this.limits.projectDispatchLimitOverrides()) this.limits.setProjectDispatchLimitOverride(project.key, null);
    const tombstone = projectTombstoneSchema.parse({ key: project.key, repositories: project.repositories, reason, removedAt: now() });
    this.db.prepare("INSERT INTO project_tombstones(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(tombstone.key, JSON.stringify(tombstone));
    this.core.advanceRevision();
    return tombstone;
  }
}
