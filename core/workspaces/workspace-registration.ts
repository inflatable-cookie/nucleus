import type { Task } from "../../shared/contracts";
import { HostReadRefusalError } from "../host/errors";
import { expiredQuantumDeadlineError } from "../scheduling/pass-snapshot";
import type { Store } from "../store/store";
import { worktreeLinksForBinding } from "./worktree-links";

export type WorkspaceRegistration = {
  id: string;
  directory: string;
  adopted?: Pick<Task, "hostId" | "repoPath" | "branch">;
};

export function workspaceBoundByOtherTask(
  store: Store,
  taskId: string,
  workspaceId: string,
): boolean {
  try {
    store.task(taskId);
    return (
      store
        .allTasks()
        .some(
          (task) =>
            task.id !== taskId &&
            (task.workspaceId === workspaceId ||
              task.resolution.coordinatorWorkspaceId === workspaceId ||
              task.resolution.closeoutWorkspaceId === workspaceId ||
              task.resolution.workspaceRetirement?.workspaceId ===
                workspaceId ||
              task.resolution.archivedWorkspaceIds.includes(workspaceId) ||
              task.resolution.displacedHostWorkspaces.some(
                (entry) => entry.workspaceId === workspaceId,
              )),
        ) ||
      Boolean(
        store.db
          .prepare(
            "SELECT 1 FROM runs WHERE taskId<>? AND json_extract(data,'$.workspaceId')=? LIMIT 1",
          )
          .get(taskId, workspaceId),
      )
    );
  } catch (error) {
    throw new HostReadRefusalError(
      `Workspace ownership could not be read for ${workspaceId}`,
      { cause: error },
    );
  }
}

export function workspaceRegistrationRefusal(
  directory: string,
  ids: string[],
): Error {
  const single = ids.length === 1;
  return Error(
    `Workspace registration for ${directory} was not sent: the folder already has workspace registration${single ? "" : "s"} ${ids.join(", ")}, which ${single ? "is" : "are"} not this task's. Nucleus never adds a second registration for one folder and never reparents another owner's workspace; inspect the existing registration instead.`,
  );
}

export function bindWorkspaceRegistration(
  store: Store,
  taskId: string,
  workspace: WorkspaceRegistration,
  event: "workspace_created" | "workspace_recovered",
  patch: Pick<Partial<Task>, "phase"> = {},
): Task {
  const apply = () => {
    const task = store.task(taskId);
    if (workspace.adopted) {
      const expired = expiredQuantumDeadlineError(
        "workspace registration adoption",
      );
      if (expired) throw expired;
      if (
        task.workspaceId === workspace.id &&
        task.directory === workspace.directory
      )
        return task;
      if (
        task.workspaceId ||
        task.directory ||
        task.removedAt ||
        task.hostId !== workspace.adopted.hostId ||
        task.repoPath !== workspace.adopted.repoPath ||
        task.branch !== workspace.adopted.branch ||
        task.phase === "cancelled" ||
        task.phase === "done"
      )
        throw Error(
          "Task changed before workspace adoption; refresh before retrying",
        );
      if (workspaceBoundByOtherTask(store, taskId, workspace.id))
        throw workspaceRegistrationRefusal(workspace.directory, [workspace.id]);
    }
    const binding = {
      workspaceId: workspace.id,
      directory: workspace.directory,
    };
    const bound = store.update(
      taskId,
      { ...patch, ...binding, ...worktreeLinksForBinding(task, binding) },
      event,
      workspace.id,
    );
    if (workspace.adopted)
      store.event(taskId, "workspace_registration_adopted", workspace.id);
    return bound;
  };
  return workspace.adopted && !store.db.isTransaction
    ? store.transaction(apply)
    : apply();
}
