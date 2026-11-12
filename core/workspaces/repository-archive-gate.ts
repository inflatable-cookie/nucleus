import type { Task } from "../../shared/contracts";
import type { Adapter } from "../host/adapter";

/**
 * Whether a host has a project registration shared by repository workspaces.
 * Paseo worktrees are independent registrations; T3Code has one project per
 * repository. This describes project retirement, not task worktree archives.
 */
export function repositorySharedWorkspaces(adapter: Pick<Adapter, "capabilities">): boolean {
  return adapter.capabilities?.().repositorySharedWorkspaces === true;
}

/**
 * A live task on the same host and repository still uses the shared project
 * registration. Terminal tasks do not use it.
 */
export function liveRepositorySharer(tasks: readonly Task[], task: Task): boolean {
  return tasks.some(other => other.id !== task.id && !other.removedAt
    && !["done", "cancelled"].includes(other.phase)
    && other.hostId === task.hostId && other.repoPath === task.repoPath);
}

/**
 * The hold reason for retiring a shared project registration while a live task
 * still uses it. Individual worktree archives do not call this gate.
 */
export function sharedRepositoryArchiveHold(adapter: Pick<Adapter, "capabilities">, tasks: readonly Task[], task: Task): string | null {
  if (!repositorySharedWorkspaces(adapter)) return null;
  return liveRepositorySharer(tasks, task)
    ? "Waiting: another live task in this repository still uses the shared project registration" : null;
}
