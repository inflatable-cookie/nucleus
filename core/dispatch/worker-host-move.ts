import { existsSync } from "node:fs";
import type {
  DisplacedHostWorkspace,
  Profile,
  Task,
} from "../../shared/contracts";
import type { Adapter } from "../host/adapter";
import { git, queueCheckoutStatus } from "../git/index";
import type { Store } from "../store/store";
import { worktreeLinksForBinding } from "../workspaces/worktree-links";

/**
 * Inspect the old host checkout before a cross-host worker move removes or
 * displaces it. Dirty files always refuse the move so unpublished edits are
 * never stranded; synthetic non-Git paths in tests pass cleanly with null head.
 */
export async function verifyMoveSourceClean(
  oldDirectory: string | null | undefined,
): Promise<{ head: string | null }> {
  if (!oldDirectory || !existsSync(oldDirectory)) return { head: null };
  const isGit = await git(oldDirectory, "rev-parse", "--git-dir").then(
    () => true,
    () => false,
  );
  if (!isGit) return { head: null };
  if (await queueCheckoutStatus(oldDirectory, "status", "--porcelain"))
    throw new Error(
      "Cannot move task to another host while its current workspace has uncommitted changes; commit or settle the workspace first",
    );
  const head = await git(oldDirectory, "rev-parse", "HEAD").catch(() => null);
  return { head };
}

function collectDisplacedHostAgentIds(task: Task, oldHostId: string): string[] {
  return [
    ...new Set(
      [
        task.agentId,
        ...task.retiredWorkers
          .filter((worker) => (worker.hostId ?? oldHostId) === oldHostId)
          .map((worker) => worker.agentId),
        task.resolution.reviewerAgentId,
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
}

export interface MoveTaskToWorkerHostParams {
  store: Store;
  taskId: string;
  targetHostId: string;
  hostSelection: NonNullable<Task["hostSelection"]>;
  targetProfile: Profile;
  targetGroup: string | null;
  oldHead: string | null;
  retireReason: string;
  patch?: Partial<Task>;
  resolutionPatch?: Partial<Task["resolution"]>;
  auditDetail?: string;
}

/**
 * Move an idle or freshly released task to `targetHostId` inside one store
 * transaction: record any displaced workspace/threads from `oldHostId` for the
 * cleanup owner, preserve branch & PR continuity, and update host + profile.
 */
export function moveTaskToWorkerHost(params: MoveTaskToWorkerHostParams): Task {
  const apply = () => {
    const current = params.store.task(params.taskId);
    const oldHostId = current.hostId;
    if (!oldHostId || oldHostId === params.targetHostId) return current;
    if (params.store.runs(current.id).some((run) => !run.released))
      throw new Error(
        "Cannot move task to another host while a run is still active",
      );
    const retiredWorkers =
      current.agentId &&
      current.profile &&
      !current.retiredWorkers.some(
        (worker) =>
          worker.agentId === current.agentId &&
          worker.runId === (current.runId ?? ""),
      )
        ? [
            ...current.retiredWorkers,
            {
              agentId: current.agentId,
              runId: current.runId ?? "",
              profile: current.profile,
              reason: params.retireReason.slice(0, 2000),
              hostId: oldHostId,
            },
          ]
        : current.retiredWorkers;
    const oldAgentIds = collectDisplacedHostAgentIds(current, oldHostId);
    const hasDisplacedState = Boolean(
      current.workspaceId || current.directory || oldAgentIds.length > 0,
    );
    const existingDisplaced = current.resolution.displacedHostWorkspaces ?? [];
    let displacedHostWorkspaces = existingDisplaced;
    if (hasDisplacedState) {
      const idx = existingDisplaced.findIndex(
        (entry) =>
          entry.hostId === oldHostId &&
          entry.workspaceId === current.workspaceId &&
          entry.state !== "archived",
      );
      const nextEntry: DisplacedHostWorkspace = {
        hostId: oldHostId,
        workspaceId: current.workspaceId,
        directory: current.directory,
        branch: current.branch,
        head: params.oldHead,
        agentIds:
          idx >= 0
            ? [
                ...new Set([
                  ...existingDisplaced[idx]!.agentIds,
                  ...oldAgentIds,
                ]),
              ]
            : oldAgentIds,
        external: Boolean(current.reviewEntry?.preserveWorkspace),
        state: "pending",
        intentAt: null,
        archivedAt: null,
        detail: "",
      };
      displacedHostWorkspaces =
        idx >= 0
          ? existingDisplaced.map((entry, index) =>
              index === idx ? nextEntry : entry,
            )
          : [...existingDisplaced, nextEntry];
    }
    const previousModel = current.workerModel || current.profile?.model || "";
    const workerModels = previousModel
      ? [...new Set([...current.workerModels, previousModel])]
      : current.workerModels;
    const {
      resolution: patchResolution,
      retiredWorkers: _ignoredRetired,
      hostId: _ignoredHostId,
      hostSelection: _ignoredHostSelection,
      ...restPatch
    } = params.patch ?? {};
    return params.store.update(
      current.id,
      {
        hostId: params.targetHostId,
        hostSelection: params.hostSelection,
        workspaceId: null,
        workspaceIntent: false,
        directory: null,
        agentId: null,
        runId: null,
        agentIntent: false,
        completion: null,
        agentActive: null,
        lastObservedAt: null,
        lastAgentStatus: null,
        idleSince: null,
        transientProviderRetry: undefined,
        workerModel: null,
        workerModels,
        profile: params.targetProfile,
        profileGroup: params.targetGroup,
        retiredWorkers,
        resumePrNumber:
          current.resumePrNumber ?? current.completion?.prNumber ?? null,
        ...restPatch,
        resolution: {
          ...current.resolution,
          ...patchResolution,
          ...params.resolutionPatch,
          currentRunId: null,
          reviewerAgentId: null,
          reviewerProfile: null,
          stalledTurnStop: null,
          displacedHostWorkspaces,
        },
      },
      "worker_host_moved",
      params.auditDetail ??
        `${oldHostId} → ${params.targetHostId} for ${params.targetProfile.id}: ${params.hostSelection.reason}`.slice(
          0,
          2000,
        ),
    );
  };
  return params.store.db.isTransaction
    ? apply()
    : params.store.transaction(apply);
}

/**
 * Provision the destination host's workspace for a task whose worker host moved
 * after initial dispatch. Waits until any non-external displaced workspace on
 * an online host or shared local checkout path finishes cleanup so same-machine
 * Paseo/T3 worktree directories and branch checkouts never collide.
 */
export async function provisionHostMovedWorkspace(
  context: {
    store: Store;
    adapter: Pick<
      Adapter,
      | "findWorkspaces"
      | "recoverTaskWorkspace"
      | "populateTaskWorktree"
      | "createWorkspace"
    >;
    hostAvailable: (hostId: string) => boolean;
    enqueueCleanup: (taskId?: string) => void;
    waiting: (task: Task, reason: string) => void;
  },
  task: Task,
): Promise<boolean> {
  if (task.workspaceId || task.workspaceIntent) return true;
  if (task.phase === "queued" || task.hostSelection?.basis !== "worker_profile")
    return true;
  const displaced = task.resolution.displacedHostWorkspaces ?? [];
  if (
    displaced.length === 0 &&
    !task.retiredWorkers.some((w) => w.hostId && w.hostId !== task.hostId) &&
    !context.store
      .runs(task.id)
      .some((r) => r.hostId && r.hostId !== task.hostId)
  )
    return true;
  const blocking = displaced.filter(
    (entry) =>
      !entry.external &&
      entry.state !== "archived" &&
      (context.hostAvailable(entry.hostId) ||
        Boolean(entry.directory && existsSync(entry.directory))),
  );
  if (blocking.length > 0) {
    context.enqueueCleanup(task.id);
    context.waiting(
      task,
      `Waiting for host ${blocking[0]!.hostId} cleanup before provisioning workspace on ${task.hostId}`,
    );
    return false;
  }
  const found = context.adapter.findWorkspaces
    ? await context.adapter.findWorkspaces(task).catch(() => [])
    : [];
  let workspace: { id: string; directory: string } | null = null;
  if (found.length === 1) workspace = found[0]!;
  else {
    const localBranch = await git(
      task.repoPath,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${task.branch}`,
    ).then(
      () => true,
      () => false,
    );
    const remoteBranch = await git(
      task.repoPath,
      "ls-remote",
      "--heads",
      "origin",
      task.branch,
    ).then(
      (out) => Boolean(out.trim()),
      () => false,
    );
    if (
      (localBranch || remoteBranch || task.prHead) &&
      context.adapter.recoverTaskWorkspace
    ) {
      workspace = await context.adapter.recoverTaskWorkspace(task, {
        target: "branch",
      });
    } else {
      let freshlyPopulated = false;
      if (context.adapter.populateTaskWorktree) {
        const populated = await context.adapter.populateTaskWorktree(task);
        freshlyPopulated = populated.populated;
      }
      workspace = await context.adapter.createWorkspace(task, {
        freshlyPopulated,
      });
    }
  }
  const current = context.store.task(task.id);
  if (
    current.version !== task.version ||
    current.workspaceId ||
    current.hostId !== task.hostId
  )
    return false;
  context.store.update(
    current.id,
    {
      workspaceId: workspace.id,
      directory: workspace.directory,
      ...worktreeLinksForBinding(current, {
        workspaceId: workspace.id,
        directory: workspace.directory,
      }),
    },
    "workspace_created",
    workspace.id,
  );
  return true;
}
