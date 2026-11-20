import type {
  Task,
  WorkspaceAllocation,
  WorkspaceProvider,
} from "../../shared/contracts";
import type { Store } from "../store/store";
import type { BargeClientOptions } from "./barge-cli";

export interface SaveWorkspaceAllocationOptions {
  displaceCurrent?: boolean;
  auditEvent?: { kind: string; detail: string };
}

export interface WorkspaceAllocationBridge {
  workspaceProviderFor(
    task: Pick<Task, "repoPath" | "repository">,
  ): WorkspaceProvider;
  task?(taskId: string): Task | undefined;
  saveWorkspaceAllocation(
    taskId: string,
    allocation: WorkspaceAllocation,
    options?: SaveWorkspaceAllocationOptions,
  ): Task;
  bargeCliOptions?: BargeClientOptions;
  custodianControlRootDir?: string;
}

export function createStoreWorkspaceAllocationBridge(
  store: Store,
  options: {
    bargeCliOptions?: BargeClientOptions;
    custodianControlRootDir?: string;
  } = {},
): WorkspaceAllocationBridge {
  return {
    workspaceProviderFor: (task) => store.workspaceProviderFor(task),
    task: (taskId) => {
      try {
        return store.task(taskId);
      } catch {
        return undefined;
      }
    },
    saveWorkspaceAllocation: (taskId, allocation, saveOptions) =>
      store.transaction(() => {
        const latest = store.task(taskId);
        const existingDisplaced =
          latest.resolution.displacedWorkspaceAllocations ?? [];

        const matchesDisplaced = existingDisplaced.some(
          (entry) => entry.allocationId === allocation.allocationId,
        );
        const isDisplacedUpdate =
          matchesDisplaced &&
          latest.workspaceAllocation?.allocationId !== allocation.allocationId &&
          !saveOptions?.displaceCurrent;

        if (isDisplacedUpdate) {
          const updatedDisplaced = existingDisplaced.map((entry) =>
            entry.allocationId === allocation.allocationId ? allocation : entry,
          );
          return store.update(
            latest.id,
            {
              resolution: {
                ...latest.resolution,
                displacedWorkspaceAllocations: updatedDisplaced,
              },
            },
            saveOptions?.auditEvent?.kind ?? "barge_allocation_updated",
            saveOptions?.auditEvent?.detail ??
              `${allocation.allocationId}: ${allocation.state}`,
          );
        }

        let displaced = existingDisplaced;
        if (
          saveOptions?.displaceCurrent &&
          latest.workspaceAllocation &&
          latest.workspaceAllocation.allocationId !== allocation.allocationId
        ) {
          const filtered = existingDisplaced.filter(
            (entry) =>
              entry.allocationId !== latest.workspaceAllocation!.allocationId,
          );
          displaced = [...filtered, latest.workspaceAllocation];
        }

        return store.update(
          latest.id,
          {
            workspaceAllocation: allocation,
            ...(displaced !== existingDisplaced
              ? {
                  resolution: {
                    ...latest.resolution,
                    displacedWorkspaceAllocations: displaced,
                  },
                }
              : {}),
          },
          saveOptions?.auditEvent?.kind ?? "barge_allocation_updated",
          saveOptions?.auditEvent?.detail ??
            `${allocation.allocationId}: ${allocation.state}`,
        );
      }),
    bargeCliOptions: options.bargeCliOptions,
    custodianControlRootDir: options.custodianControlRootDir,
  };
}
