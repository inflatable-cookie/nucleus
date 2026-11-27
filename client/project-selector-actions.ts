import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "./shell";
import * as api from "../shared/contracts";
import type { Project, ProjectUpsertInput } from "../shared/contracts";
import type { ProjectManagementApi } from "./project-management-view";
import type { ProjectSelectorActions } from "./project-scope-controls";
import { rustProjectArchive } from "./rust-contracts";

/** Archive and Restore change the project membership of all three board collections. */
export function useArchiveProject() {
  const queryClient = useQueryClient();
  const archiveRpc = useRpc(rustProjectArchive);
  return async (project: string, archived: boolean) => {
    await archiveRpc({ project, archived });
    await queryClient.invalidateQueries({
      queryKey: ["nucleus"],
      predicate: ({ queryKey: [, area] }) =>
        area === "leads" || area === "decisions" || area === "plans",
    });
  };
}

/*
 * The board project selector's row actions (nucleus#1430). Each one calls the RPC
 * Settings → Projects already calls, with the project's version where the RPC is
 * versioned, and refreshes the board state and the Settings project list whether
 * the call succeeds or is refused (a refused call often means a newer version has
 * landed). Remove reuses the shared removal dialog, ProjectManagementView, which the
 * board renders outside the picker so its preview, blockers and confirmation stay as
 * they are in Settings.
 */
export function useProjectSelectorActions(
  refreshBoard: () => Promise<unknown>,
  canArchive: boolean,
) {
  const queryClient = useQueryClient();
  const upsertRpc = useRpc(api.projectUpsert);
  const archiveProject = useArchiveProject();
  const previewRpc = useRpc(api.projectManagementPreview),
    removeRpc = useRpc(api.projectManage);

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
    archive: canArchive ? (project) => run(() => archiveProject(project.key, true)) : undefined,
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

  const removal: ProjectManagementApi = { previewRpc, removeRpc };

  return { actions, removal, refresh };
}
