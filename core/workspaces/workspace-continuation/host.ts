import type {
  HostProcessFact,
  HostWorktreeWorkspaceSpec,
} from "../../host/types";
import type { Task } from "../../../shared/contracts";
import { intakeOwnedReviewWorkspace } from "../../../shared/workspace-ownership";
import { workspaceOutsideQueueAllocation } from "../../../shared/workspace-ownership";
import type { HostWorkspaceRef } from "../../../shared/host";
import { existsSync } from "node:fs";
import { git, queueCheckoutStatus } from "../../git/index";
import { workspaceToolProcessIssue } from "../../recovery/stall";
import type { ParticipantRuntime } from "../../machine/participant-runtime";
import type {
  WorkspaceInventoryEntry,
  WorkspacePlacement,
} from "../workspace-lifecycle";

export type { HostWorktreeWorkspaceSpec } from "../../host/types";

/**
 * The retained and closeout workspace policy of one task — whether a worker's
 * recorded workspace may receive a continuation, whether its processes are
 * gone, and the closeout workspace's identity and source proof — as core policy
 * over a host.
 *
 * Step 4 row 2 of the Paseo split map (task 901) moved this out of
 * `host/paseo/paseo.ts`, which held it only because the adapter was the one
 * object core had. What decides is here: the process proof over the host's own
 * process table, the owned-path admission and the identity comparison the
 * continuation preflight refuses on, the closeout branch's identity and request
 * shape, the one registration it looks for, and the exact-head and cleanliness
 * proof a recovered closeout checkout must pass. What only a host can see stays
 * with it, and core reads it through {@link WorkspaceContinuationHost}: the
 * registration handle and its refresh, the complete workspace inventory and the
 * native registration.
 *
 * Every host fact is read at the call that uses it, never captured: a replaced
 * daemon surface, a test's placement or owned-path override and a stubbed
 * process table are all seen by the next call. The policy also reaches the
 * machine seams it re-enters (`placement`, `ownedPathFor`, `hostProcessListing`)
 * through the host, so an override on the adapter still governs the whole
 * operation exactly as the adapter's own self-calls did.
 *
 * Nothing here awaits differently from the code it replaces, and the moved
 * bodies are token-identical modulo that receiver rewrite and the one native
 * registration call the move relocates into the host: see `evidence/903/`.
 *
 * The folder's other owner is `accepted-pr.ts`: the reconciliation of a parked
 * accepted PR's workspace is a task-level decision over the store, not a host
 * workspace policy, so the two never share a file.
 */
export class WorkspaceContinuation {
  constructor(private readonly host: WorkspaceContinuationHost) {}

  async noLiveWorkspaceProcesses(
    workspaceId: string,
    runIds: readonly string[],
    runtime: ParticipantRuntime = {},
  ): Promise<string | null> {
    if (!runIds.length)
      return "the participant has no recorded run identity for process proof";
    const workspace = this.host.workspaceHost.workspaceRef(workspaceId);
    if (!(await workspace.refresh()))
      return "the participant workspace is unreadable for process proof";
    const directory = workspace.current()?.workspaceDirectory;
    if (!directory)
      return "the participant workspace directory is unreadable for process proof";
    const processes = await this.host.hostProcessListing();
    if (!processes) return "the host process listing is unreadable";
    return workspaceToolProcessIssue(processes, directory, runIds, runtime);
  }
  /** Check the exact retained task worktree before a deferred worker message is delivered. */
  async preflightWorkerContinuation(
    task: Task,
  ): Promise<{ available: true } | { available: false; reason: string }> {
    const unavailable = (reason: string) => ({
      available: false as const,
      reason,
    });
    if (!task.workspaceId || !task.directory)
      return unavailable(
        "Retained worker workspace identity is incomplete; no continuation was sent",
      );
    const placement = this.host.placement();
    // External and intake-owned review-entry workspaces live outside Queue
    // placement. The latter still receive a direct volume check; every binding
    // is then checked against the retained workspace's own record and folder.
    if (placement && workspaceOutsideQueueAllocation(task)) {
      try {
        if (intakeOwnedReviewWorkspace(task))
          (placement.admitIntake ?? placement.admit)(task.directory);
      } catch (error) {
        return unavailable(
          error instanceof Error ? error.message : String(error),
        );
      }
    } else if (placement) {
      try {
        if (task.directory === (await this.host.ownedPathFor(task)))
          placement.admit(task.directory);
      } catch (error) {
        return unavailable(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const workspace = this.host.workspaceHost.workspaceRef(task.workspaceId);
    await workspace.refresh();
    const current = workspace.current();
    if (!current || !workspace.directory || !existsSync(workspace.directory))
      return unavailable(
        `Retained worker workspace ${task.workspaceId} was archived or removed before continuation dispatch; no continuation was sent`,
      );
    if (
      workspace.directory !== task.directory ||
      (current.projectRootPath !== task.repoPath &&
        current.projectRootPath !== task.directory)
    )
      return unavailable(
        `Retained worker workspace ${task.workspaceId} changed identity before continuation dispatch; no continuation was sent`,
      );
    return { available: true };
  }
  async createCloseoutWorkspace(task: Task) {
    const slug = `ns-closeout-${task.id}`;
    const workspace = await this.host.workspaceHost.createCloseoutWorkspace({
      title: `Closeout: ${task.title}`,
      requestId: `ns-closeout-workspace-${task.id}`,
      source: {
        kind: "worktree",
        cwd: task.repoPath,
        action: "branch-off",
        baseBranch: task.resolution.closeoutWorkspaceHead!,
        branchName: slug,
        worktreeSlug: slug,
      },
    });
    if (!workspace.directory)
      throw Error("Closeout workspace returned no directory");
    return { id: workspace.id, directory: workspace.directory };
  }
  async findCloseoutWorkspaces(task: Task) {
    const slug = `ns-closeout-${task.id}`,
      entries = await this.host.workspaceHost.workspaceInventory();
    return entries
      .filter(
        (w) => w.projectRootPath === task.repoPath && w.worktreeSlug === slug,
      )
      .map((w) => ({ id: w.id, directory: w.workspaceDirectory ?? "" }));
  }
  async verifyCloseoutWorkspace(task: Task, id: string, directory: string) {
    const workspace = this.host.workspaceHost.workspaceRef(id);
    await workspace.refresh();
    const current = workspace.current();
    if (
      current?.projectRootPath !== task.repoPath ||
      current.worktreeSlug !== `ns-closeout-${task.id}` ||
      workspace.directory !== directory
    )
      throw Error("Closeout workspace identity changed");
    if (
      (await git(directory, "rev-parse", "HEAD")) !==
        task.resolution.closeoutWorkspaceHead ||
      (await queueCheckoutStatus(directory, "status", "--porcelain"))
    )
      throw Error(
        "Closeout workspace must be clean at its recorded integration commit",
      );
  }
}

/**
 * What the retained and closeout workspace policy reads from the host it runs
 * on. The Paseo adapter supplies it as `this`; nothing here is a Paseo type, and
 * every member is read at the call that uses it.
 */
export interface WorkspaceContinuationHost {
  /** The host's native workspace calls: one registration's handle, the complete inventory and the worktree registration. */
  readonly workspaceHost: WorkspaceContinuationHostCalls;
  /**
   * The core seams and machine facts this policy re-enters, so an override on the
   * adapter still governs the whole operation exactly as the adapter's own
   * self-calls did: every internal call to one of these goes through the host.
   */
  placement(): WorkspacePlacement;
  ownedPathFor(task: Task): Promise<string>;
  hostProcessListing(): Promise<HostProcessFact[] | null>;
}

/** The native workspace calls core makes: each returns the host's own answer, unmapped. */
export interface WorkspaceContinuationHostCalls {
  /** One registration's handle; the caller awaits its refresh and then reads its record. */
  workspaceRef(id: string): HostWorkspaceRef;
  /** The complete active inventory, paged to its end by the host. */
  workspaceInventory(): Promise<WorkspaceInventoryEntry[]>;
  /** The host's own worktree registration; a registration without a directory is the host's answer. */
  createCloseoutWorkspace(
    spec: HostWorktreeWorkspaceSpec,
  ): Promise<{ id: string; directory: string | null }>;
}
