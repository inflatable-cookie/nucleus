import { projectDispatchLimitOverridesSchema, DEFAULT_PAPERCUT_PROJECT_LIMIT, DEFAULT_PROJECT_LIMIT, type Task } from "../../shared/contracts";
import { StoreCore } from "./store-core";
import { repositoryMemberMatches, type StoreProjectRegistry } from "./store-project-registry";

const PROJECT_DISPATCH_LIMIT_OVERRIDES_META_KEY = "projectDispatchLimitOverrides";

type DispatchTask = Pick<Task, "repoPath" | "repository">;

/**
 * Per-project dispatch slots: the default limit, the operator's per-project
 * overrides and the papercut lane's own limit. Every resolver reads the same
 * project membership through `repositoryMemberMatches`.
 */
export class StoreProjectLimits {
  constructor(private readonly core: StoreCore, private readonly registry: StoreProjectRegistry) {}

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
  projectInFlightLimitFor(task: DispatchTask): number {
    return 2 * this.projectDispatchLimitFor(task);
  }

  projectDispatchLimitResolver(): (task: DispatchTask) => number {
    const projectLimit = this.core.getMeta<number>("projectLimit") ?? DEFAULT_PROJECT_LIMIT;
    const overrides = this.projectDispatchLimitOverrides();
    const projects = this.registry.projects();
    return task => {
      const project = projects.find(candidate => candidate.repositories.some(repo => repositoryMemberMatches(repo, task.repoPath, task.repository)));
      return project ? overrides[project.key] ?? projectLimit : projectLimit;
    };
  }

  papercutDispatchPolicy() {
    const projects = this.registry.projects();
    return {
      limit: this.core.getMeta<number>("papercutProjectLimit") ?? DEFAULT_PAPERCUT_PROJECT_LIMIT,
      projectKeyFor: (task: Task) => projects.find(project => project.repositories.some(repo => repositoryMemberMatches(repo, task.repoPath, task.repository)))?.key ?? task.repository ?? task.repoPath,
    };
  }

  projectDispatchLimitFor(task: DispatchTask): number {
    return this.projectDispatchLimitResolver()(task);
  }
}
