import type { Task } from "../../shared/contracts";
import type { Adapter } from "../host/adapter";

/**
 * Whether one workspace archive retires a registration every task in the
 * repository shares. Paseo worktrees are independent registrations and never
 * set this; T3Code projects are one per repository (nucleus#1139 review).
 */
export function repositorySharedWorkspaces(adapter: Pick<Adapter, "capabilities">): boolean {
  return adapter.capabilities?.().repositorySharedWorkspaces === true;
}

/**
 * A live task on the same host and repository keeps the shared registration
 * alive. Terminal tasks do not hold: each completes its own retirement against
 * whatever registration state the last closer leaves, including the archived
 * one.
 */
export function liveRepositorySharer(tasks: readonly Task[], task: Task): boolean {
  return tasks.some(other => other.id !== task.id && !other.removedAt
    && !["done", "cancelled"].includes(other.phase)
    && other.hostId === task.hostId && other.repoPath === task.repoPath);
}

/**
 * The hold reason a workspace archive owes while a live task shares the
 * repository's project registration; empty when the archive may proceed. The
 * hold is a wait, never a failure: the workspace stays preserved and the next
 * pass retries, and the last closer retires the registration.
 */
export function sharedRepositoryArchiveHold(adapter: Pick<Adapter, "capabilities">, tasks: readonly Task[], task: Task): string | null {
  if (!repositorySharedWorkspaces(adapter)) return null;
  return liveRepositorySharer(tasks, task)
    ? "Waiting: another live task in this repository still uses the shared project registration" : null;
}
