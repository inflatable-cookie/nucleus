import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "./shell";
import * as api from "../shared/contracts";
import type { Project, ProjectUpsertInput } from "../shared/contracts";
import type { ProjectManagementApi } from "./project-management-view";
import type { ProjectSelectorActions } from "./project-scope-controls";

/*
 * The board project selector's row actions (nucleus#1430). Each one calls the RPC
 * Settings → Projects already calls, with the project's version where the RPC is
 * versioned, and refreshes the board state and the Settings project list whether
 * the call succeeds or is refused (a refused call often means a newer version has
 * landed). Remove reuses the shared removal dialog, ProjectManagementView, which the
 * board renders outside the picker so its preview, blockers and confirmation stay as
 * they are in Settings.
 */
export function useProjectSelectorActions(refreshBoard: () => Promise<unknown>) {
  const queryClient = useQueryClient();
  const parkRpc = useRpc(api.projectPark),
    unparkRpc = useRpc(api.projectUnpark),
    upsertRpc = useRpc(api.projectUpsert);
  const previewRpc = useRpc(api.projectManagementPreview),
    removeRpc = useRpc(api.projectManage),
    cancelRpc = useRpc(api.bulkDisposition),
    cancellationRpc = useRpc(api.bulkDispositionDetail),
    resetRpc = useRpc(api.projectResetCancellation);

  // A failed refresh never turns a saved change into a failure: the board's own read error shows it.
  const refresh = async () => {
    await Promise.all([
      refreshBoard(),
      queryClient.invalidateQueries({ queryKey: ["nucleus", "project-settings"] }),
    ]).catch(() => undefined);
  };
  async function run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } finally {
      await refresh();
    }
  }

  const actions: ProjectSelectorActions = {
    park: (project: Project) => run(() => parkRpc({ key: project.key, version: project.version })),
    unpark: (project: Project) => run(() => unparkRpc({ key: project.key, version: project.version })),
    // Settings' rule: the name changes, the key, repositories and primary stay. Upsert takes no version.
    rename: (project: Project, name: string) => {
      const input: ProjectUpsertInput = {
        key: project.key,
        name: name.trim(),
        repositories: project.repositories,
        ...(project.repositories.length > 1 ? { primary: project.repositories[0] } : {}),
      };
      return run(() => upsertRpc(input));
    },
  };

  const removal: ProjectManagementApi = {
    previewRpc,
    removeRpc,
    cancelRpc,
    cancellationRpc,
    resetRpc,
  };

  return { actions, removal, refresh };
}
