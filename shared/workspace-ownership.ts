import type { Task } from "./schema/tasks";

/**
 * The two ownership classes of a task's bound directory (nucleus#1261).
 *
 * `queue` is a Queue allocation: the lifecycle admits its volume, cleans its
 * build output and archives the worktree at closeout. `external` is a worktree
 * Nucleus did not create and never archives or deletes — a registered thread's
 * own worktree (`task.register`), or the checkout a review entry was bound to
 * (`reviewEntry.preserveWorkspace`). One predicate reads both records so every
 * lifecycle decision agrees on the class.
 */
export function externalWorkspace(task: Pick<Task, "workspaceOwnership" | "reviewEntry">): boolean {
  return task.workspaceOwnership === "external" || task.reviewEntry?.preserveWorkspace === true;
}

/**
 * Whether the task's recorded directory may be used without proving it is a
 * Queue allocation. Intake-owned review-entry workspaces are still archived
 * by Nucleus at closeout, so keep this admission rule separate from
 * `externalWorkspace`'s cleanup and retention meaning.
 */
export function workspaceOutsideQueueAllocation(task: Pick<Task, "workspaceOwnership" | "reviewEntry" | "workspaceId" | "directory">): boolean {
  if (externalWorkspace(task)) return true;
  const entry = task.reviewEntry;
  return Boolean(entry && entry.preserveWorkspace === false && task.workspaceId
    && task.directory && entry.workspaceId === task.workspaceId && entry.directory === task.directory);
}
