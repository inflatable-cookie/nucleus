import { existsSync, lstatSync } from "node:fs";
import { isTransportFailure } from "../../shared/transport";
import type { Resolution } from "../resolution";
import {
  holdsOf,
  runtimeRetirementFailure,
  type Run,
  type Task,
} from "../../shared/contracts";
import { OWNER_STOP_HOLD_PREFIX, releasePatch } from "../merge/merge-hold";
import type { Engine } from "../engine";
import { hostRunHoldReason, now } from "../store/store";
import { externalWorkspace } from "../../shared/workspace-ownership";
import { hookHoldReason } from "../hooks/hooks";
import { reportOnlySourceHead } from "../git/index";
import { archiveFailureKeepsScope } from "../workspaces/archive-failure";
import { workspaceDiscardKey, type WorkspaceDiscard } from "../workspaces/orphan-worktree";
import {
  settleArchive,
  type ArchiveEffect,
} from "../workspaces/thread-archive-effect";
import { threadBoundToAnotherLiveTask } from "../workspaces/thread-ownership";
import { portsContext } from "../port-context";
import { CloseoutRecovery } from "./recovery";

import {
  externalWorkspaceArchiveDue,
  settleExternalWorkspaceArchive,
} from "../workspaces/external-workspace-archive";
import {
  archiveIntentOutstanding,
  archiveSettledByOwner,
} from "../workspaces/archive-intent";
import {
  buildOutputCleanupHooks,
  buildOutputDirectoryAbsent,
} from "../workspaces/worktree-cleanup";
import {
  archiveRetryWaiting,
  recordArchiveRetry,
  terminalArchiveSource,
  terminalArchiveWorkspaces,
  workspaceArchiveFailureReason,
  type TerminalWorkspace,
  type WorkspaceArchiveRetry,
} from "./terminal-archive";
import { ArchiveScheduler } from "./archive-scheduler";
import { runTerminalHooks } from "./terminal-hooks";
import { missingOriginHasPlanner } from "../questions/origin";
import { admissionOf } from "../host/admission";
import { cleanupTerminalBranches } from "./branch-cleanup";

function canRecordWorkspaceArchive(task: Task, id: string): boolean {
  const prior = task.resolution.archiveIntentWorkspaceId;
  return (
    !archiveIntentOutstanding(task) ||
    prior === id ||
    task.resolution.workspaceArchiveRetries.some(
      (record) => record.workspaceId === prior,
    )
  );
}

export type LifecycleContext = Pick<
  Engine,
  | "adapter"
  | "drainCleanup"
  | "enqueueCleanup"
  | "hooks"
  | "host"
  | "hostAvailable"
  | "onTaskHost"
  | "removeSiblings"
  | "retirement"
  | "scheduleRetirement"
  | "scheduleRunBuildOutputs"
  | "settleObservedIdleRuns"
  | "settleTerminalIntentRuns"
  | "settleTerminalRecoveryEpisode"
  | "stopped"
  | "store"
  | "taskHostAvailable"
  | "wakeTask"
  | "withHost"
> & {
  readonly resolution: Pick<
    Resolution,
    | "adapter"
    | "closeoutAuthority"
    | "hasEarlierIntegrationTurn"
    | "lease"
    | "attention"
    | "environmentDeferred"
    | "transportDeferred"
    | "update"
  >;
};

export class Lifecycle {
  private readonly closeoutRecovery: CloseoutRecovery;
  private readonly scheduler: ArchiveScheduler;
  constructor(readonly engine: LifecycleContext) {
    this.closeoutRecovery = new CloseoutRecovery({
      get adapter() {
        return engine.adapter;
      },
      get host() {
        return engine.host;
      },
      get onTaskHost() {
        return engine.onTaskHost.bind(engine);
      },
      get resolution() {
        return portsContext(engine.resolution, [
          "adapter",
          "closeoutAuthority",
          "hasEarlierIntegrationTurn",
          "lease",
          "update",
        ]);
      },
      get stopped() {
        return engine.stopped;
      },
      get store() {
        return engine.store;
      },
    });
    this.scheduler = new ArchiveScheduler({
      adapter: engine.adapter,
      drainCleanup: () => engine.drainCleanup(),
      enqueueCleanup: (taskId, retryWorkspaceId) =>
        engine.enqueueCleanup(taskId, retryWorkspaceId),
      hooks: engine.hooks,
      scheduleRetirement: (taskId) => engine.scheduleRetirement(taskId),
      scheduleRunBuildOutputs: (taskId) =>
        engine.scheduleRunBuildOutputs(taskId),
      settleTerminalIntentRuns: (taskId) =>
        engine.settleTerminalIntentRuns(taskId),
      get stopped() {
        return engine.stopped;
      },
      store: engine.store,
      taskHostAvailable: (task) => engine.taskHostAvailable(task),
      withHost: (id, fn) => engine.withHost(id, fn),
      resolution: {
        attention: (...args) => engine.resolution.attention(...args),
        environmentDeferred: (...args) =>
          engine.resolution.environmentDeferred(...args),
        transportDeferred: (...args) =>
          engine.resolution.transportDeferred(...args),
        update: (...args) => engine.resolution.update(...args),
      },
      closeout: {
        renewStaleCloseoutBase: (task) => this.renewStaleCloseoutBase(task),
        renewConsumerBlockedCloseout: (task) =>
          this.renewConsumerBlockedCloseout(task),
        recover: (task) => this.recover(task),
      },
    });
  }
  get store() {
    return this.engine.store;
  }
  get adapter() {
    return this.engine.adapter;
  }
  paused() {
    return this.engine.stopped || this.store.getMeta("paused") === true;
  }
  recover(task: Task) {
    return this.closeoutRecovery.recover(task);
  }
  private renewStaleCloseoutBase(task: Task) {
    return this.closeoutRecovery.renewStaleCloseoutBase(task);
  }
  get consumerBlockFetchMs() {
    return this.closeoutRecovery.consumerBlockFetchMs;
  }
  set consumerBlockFetchMs(value: number) {
    this.closeoutRecovery.consumerBlockFetchMs = value;
  }
  private renewConsumerBlockedCloseout(task: Task) {
    return this.closeoutRecovery.renewConsumerBlockedCloseout(task);
  }
  /** A passed retention reconciliation makes the retained workspace ready for immediate cleanup. */
  retentionReconciled(taskId: string, workspaceId: string | null) {
    const current = this.store.task(taskId);
    if (workspaceId) {
      const retries = current.resolution.workspaceArchiveRetries;
      const workspaceArchiveRetries = retries.filter(
        (record) => record.workspaceId !== workspaceId,
      );
      if (workspaceArchiveRetries.length !== retries.length) {
        const archiveFailure = workspaceArchiveFailureReason(retries);
        const cleanupReason =
          current.resolution.cleanupReason === archiveFailure
            ? runtimeRetirementFailure(current) ||
              workspaceArchiveFailureReason(workspaceArchiveRetries)
            : current.resolution.cleanupReason;
        this.engine.resolution.update(
          current,
          { workspaceArchiveRetries, cleanupReason },
          {},
          "workspace_archive_retry_cleared",
          workspaceId,
        );
      }
    }
    this.engine.enqueueCleanup(taskId);
  }
  /**
   * One pass over the preserved external workspace's catalog archive. The
   * module owns the record, the at-most-once identity and the bounded retry;
   * this method only gives it the engine's adapter, pause fence and the
   * versioned resolution write.
   */
  private async settlePreservedCatalogArchive(
    task: Task,
    retryWorkspaceId?: string,
  ): Promise<Task> {
    try {
      return await settleExternalWorkspaceArchive(
        {
          store: this.store,
          adapter: this.adapter,
          paused: () => this.paused(),
          resolution: this.engine.resolution,
        },
        task.id,
        retryWorkspaceId,
      );
    } catch (error) {
      this.store.event(
        task.id,
        "external_workspace_archive_warning",
        error instanceof Error ? error.message : String(error),
      );
      return this.store.task(task.id);
    }
  }
  /**
   * Settle a passed pre-archive gate. The gate names the retained worktree it ran in,
   * not a workspace identity, so map that directory to the owned workspace it belongs
   * to (primary, closeout or a reviewer source view) before clearing only that
   * workspace's archive backoff. An unknown directory settles nothing.
   */
  retentionReconciledAt(taskId: string, worktree: string | null) {
    if (!worktree) return;
    const task = this.store.task(taskId);
    const runs = this.store.runs(taskId);
    const owned = [
      { id: task.workspaceId, directory: task.directory },
      {
        id: task.resolution.closeoutWorkspaceId,
        directory: task.resolution.closeoutDirectory,
      },
      ...runs
        .filter((run) => run.reviewSourceView?.directory)
        .map((run) => ({
          id: run.workspaceId,
          directory: run.reviewSourceView!.directory,
        })),
    ];
    const match = owned.find(
      (workspace) => workspace.id && workspace.directory === worktree,
    );
    if (match?.id) this.retentionReconciled(taskId, match.id);
  }
  /**
   * Whether this pass owes any archive effect. A workspace archive that already
   * succeeded, or whose recorded bounded retry is not due yet, owes nothing: its
   * finished hook, its manifest discovery and its host-process sweep were owed by
   * the terminal transition, whose own durable intents (`finishedHook`,
   * `hostProcessSweep`) are the restart authority and are still honoured here.
   * A pause, ownership or content proof only ever refuses an attempt after this
   * point, so gating on due work changes no gate - it only stops re-proving them
   * on passes that cannot act.
   */
  private archiveWorkDue(task: Task, retryWorkspaceId?: string): boolean {
    if (task.resolution.finishedHook || task.resolution.hostProcessSweep)
      return true;
    if (
      task.resolution.displacedHostWorkspaces?.some(
        (entry) => entry.state !== "archived",
      )
    )
      return true;
    if (externalWorkspaceArchiveDue(task, retryWorkspaceId)) return true;
    const runs = this.store.runs(task.id);
    return terminalArchiveWorkspaces(task, runs).some((workspace) => {
      if (!workspace.id || !workspace.directory || !workspace.head)
        return false;
      if (
        retryWorkspaceId !== workspace.id &&
        archiveSettledByOwner(task, workspace.id)
      )
        return false;
      if (task.resolution.archivedWorkspaceIds.includes(workspace.id))
        return false;
      if (retryWorkspaceId) return retryWorkspaceId === workspace.id;
      return !archiveRetryWaiting(
        task.resolution.workspaceArchiveRetries.find(
          (record) => record.workspaceId === workspace.id,
        ),
      );
    });
  }
  /** A finished task's owner-stop dispatch hold is released; it has no work left to stop. */
  private releaseFinishedStopHold(task: Task): Task {
    const hold = holdsOf(task).dispatch;
    if (
      task.phase !== "done" ||
      !hold ||
      !hold.reason.startsWith(OWNER_STOP_HOLD_PREFIX)
    )
      return task;
    return this.store.update(
      task.id,
      releasePatch(task, "dispatch"),
      "hold_released",
      `Dispatch hold released: the task finished, so its owner stop (${hold.reason.slice(0, 300)}) has no work left to stop`,
    );
  }
  /** A prior archive may have settled while its build-output result was still missing. */
  private async settleArchivedBuildOutput(
    task: Task,
    workspace: TerminalWorkspace,
  ) {
    const { id, directory } = workspace;
    if (
      !id ||
      !directory ||
      !this.adapter.taskWorkspaceArchived ||
      !this.adapter.preflightWorkspaceStorage ||
      this.paused()
    )
      return;
    const pending = (current: Task) =>
      current.resolution.archivedWorkspaceIds.includes(id) &&
      current.resolution.buildOutputCleanups.some(
        (record) =>
          !record.runId &&
          record.workspaceId === id &&
          record.directory === directory &&
          record.state === "intent",
      );
    if (!pending(task) || !(await buildOutputDirectoryAbsent(directory)))
      return;
    await this.adapter.preflightWorkspaceStorage(task);
    if (
      !(await this.adapter.taskWorkspaceArchived(id)) ||
      !(await buildOutputDirectoryAbsent(directory))
    )
      return;
    const current = this.store.task(task.id);
    if (
      this.paused() ||
      current.removedAt ||
      current.version !== task.version ||
      !pending(current)
    )
      return;
    buildOutputCleanupHooks(
      this.store,
      task.id,
      id,
      directory,
      () => !this.paused(),
    ).observed({
      safe: true,
      removed: false,
      detail: "directory absent; nothing to clean up",
      observations: [],
    });
  }
  private updateDisplacedHostWorkspace(
    taskId: string,
    index: number,
    patch: Partial<Task["resolution"]["displacedHostWorkspaces"][number]>,
    extra?: {
      archivedWorkspaceId?: string | null;
      eventKind?: string;
      detail?: string;
    },
  ): void {
    const latest = this.store.task(taskId);
    const list = [...(latest.resolution.displacedHostWorkspaces ?? [])];
    const current = list[index];
    if (!current) return;
    list[index] = { ...current, ...patch };
    const archivedWorkspaceIds =
      extra?.archivedWorkspaceId &&
      !latest.resolution.archivedWorkspaceIds.includes(
        extra.archivedWorkspaceId,
      )
        ? [...latest.resolution.archivedWorkspaceIds, extra.archivedWorkspaceId]
        : latest.resolution.archivedWorkspaceIds;
    this.engine.resolution.update(
      latest,
      { displacedHostWorkspaces: list, archivedWorkspaceIds },
      {},
      extra?.eventKind ?? "displaced_host_workspace_updated",
      extra?.detail ?? `${current.hostId}: ${patch.state ?? current.state}`,
    );
  }

  /** Clean up old-host workspaces and threads displaced by a cross-host worker move. */
  private async archiveDisplacedHostWorkspaces(taskId: string): Promise<void> {
    if (this.paused()) return;
    const initial = this.store.task(taskId);
    const entries = initial.resolution.displacedHostWorkspaces ?? [];
    for (let index = 0; index < entries.length; index++) {
      const entry =
        this.store.task(taskId).resolution.displacedHostWorkspaces?.[index];
      if (!entry || entry.state === "archived") continue;
      if (this.paused()) return;
      await this.engine.withHost(entry.hostId, async () => {
        if (!this.engine.hostAvailable(entry.hostId) || this.paused()) return;
        const currentTask = this.store.task(taskId);
        const currentEntry =
          currentTask.resolution.displacedHostWorkspaces?.[index];
        if (!currentEntry || currentEntry.state === "archived") return;
        const adapter = this.adapter;
        let finished = false;
        try {
          if (
            !currentEntry.external &&
            currentEntry.workspaceId &&
            currentEntry.directory &&
            adapter.archiveTaskWorkspace
          ) {
            if (currentEntry.state === "pending") {
              this.updateDisplacedHostWorkspace(taskId, index, {
                state: "intent",
                intentAt: currentEntry.intentAt ?? now(),
                detail: "",
              });
            }
            const refreshed = this.store.task(taskId);
            const result = await adapter.archiveTaskWorkspace(
              refreshed,
              currentEntry.workspaceId,
              currentEntry.directory,
              currentEntry.head ?? "",
              () => !this.paused(),
              currentEntry.state === "uncertain",
              {
                requirePublished: true,
                requireDirectory: false,
                attachedAgentIds: new Set(currentEntry.agentIds),
                displacedBranch: currentEntry.branch,
              },
            );
            if (result === false) return;
          }
          if (!currentEntry.external) {
            for (const agentId of currentEntry.agentIds) {
              if (this.paused()) return;
              if (
                this.store.unreleasedRunsForAgent(agentId, currentEntry.hostId)
                  .length > 0 ||
                threadBoundToAnotherLiveTask(
                  this.store,
                  this.store.task(taskId),
                  agentId,
                )
              ) {
                throw new Error(
                  `Thread ${agentId} on ${currentEntry.hostId} still serves live work`,
                );
              }
              const key = this.store.threadArchiveKey(
                agentId,
                currentEntry.hostId,
              );
              if (!key) continue;
              const effect = this.store.getMeta<ArchiveEffect>(key);
              if (effect?.status === "archived") continue;
              if (adapter.originAgent) {
                await settleArchive(
                  this.store,
                  adapter,
                  taskId,
                  agentId,
                  key,
                  !effect,
                  effect ?? { status: "ready", at: now() },
                );
              } else if (typeof adapter.archiveAgent === "function") {
                await this.engine.host.archiveAgent(agentId);
                this.store.putThreadArchiveEffect(key, agentId, {
                  status: "archived",
                  at: now(),
                  detail: `Archived displaced host thread on ${currentEntry.hostId}`,
                  op: "archive",
                });
              }
            }
          }
          this.updateDisplacedHostWorkspace(
            taskId,
            index,
            {
              state: "archived",
              archivedAt: now(),
              detail: `Cleaned up on ${currentEntry.hostId}`,
            },
            {
              archivedWorkspaceId: !currentEntry.external
                ? currentEntry.workspaceId
                : null,
              eventKind: "displaced_host_workspace_archived",
              detail: `${currentEntry.hostId} (${currentEntry.workspaceId ?? "no-workspace"})`,
            },
          );
          finished = true;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.updateDisplacedHostWorkspace(taskId, index, {
            state:
              currentEntry.state === "intent" && isTransportFailure(error)
                ? "uncertain"
                : currentEntry.state,
            detail: message.slice(0, 1500),
          });
        }
        if (finished) void this.engine.wakeTask(taskId);
      });
    }
  }

  async archive(task: Task, retryWorkspaceId?: string) {
    // A terminal task's stale recovery episode settles before any gate below can
    // return: a cancelled task never reaches the done-only archive, and a done task
    // without a recorded merge stops at the merge guard. The settlement is store-only.
    if (
      ["done", "cancelled"].includes(task.phase) &&
      task.resolution.recoveryActive
    ) {
      this.engine.settleTerminalRecoveryEpisode(task.id, "end-of-task cleanup");
      task = this.store.task(task.id);
    }
    await this.archiveDisplacedHostWorkspaces(task.id);
    task = this.store.task(task.id);
    const { reportOnly, proofOnlyDone } = terminalArchiveSource(task);
    if (
      (task.originError && !missingOriginHasPlanner(this.store, task)) ||
      task.originLookupError ||
      this.paused() ||
      task.phase !== "done" ||
      (!reportOnly &&
        !proofOnlyDone &&
        (!task.resolution.mergedCommit || !task.resolution.syncedCommit)) ||
      !this.adapter.archiveTaskWorkspace
    )
      return;
    // Degraded admission defers archive work as it defers titles: no attempt is
    // made or recorded, and the next healthy pass finds the same work due. An
    // owner retry still runs, so its refusal is reported rather than swallowed.
    if (!retryWorkspaceId && admissionOf(this.adapter)?.degradedNow) return;
    // An owner stop pauses work; a finished task has none left, so its stop hold
    // stops nothing and would only refuse the archive for good (#456, Effigy #377,
    // Tom 2026-10-26: "It keeps happening!"). Release it, recorded, before archiving.
    // Any other dispatch hold is a deliberate preservation and still keeps the workspace.
    task = this.releaseFinishedStopHold(task);
    // Spec 050 terminal-cleanup liveness (papercut b87375b0): a never-reporting
    // run whose agent is observed idle, with no active turn and no pending
    // permission, is released with history kept before the archive waits on it.
    // This runs before the recoveryActive gate because such a run is exactly
    // what keeps the recovery episode reading active.
    if (
      task.resolution.recoveryActive ||
      this.store.runs(task.id).some((run) => !run.released)
    ) {
      await this.engine.settleObservedIdleRuns(
        task.id,
        "End-of-task cleanup released an idle run with no live turn",
      );
      task = this.store.task(task.id);
    }
    if (task.resolution.recoveryActive) return;
    // The advisory finished-task runtime stop and the terminal host-process
    // sweep are expensive (three to five Git spawns, `ps` and `lsof`) and only
    // owed once per terminal transition, so they run on a pass that is actually
    // due - a due owned-workspace archive, a due preserved catalog archive or
    // the durable terminal-transition intents - never on every pass of a
    // workspace whose retry is still backed off.
    if (this.archiveWorkDue(task, retryWorkspaceId))
      await runTerminalHooks(
        { store: this.store, hooks: this.engine.hooks, adapter: this.adapter },
        task,
      );
    // Spec 027: sibling worktrees leave with the task's own workspaces.
    if (task.siblingPins.length) await this.engine.removeSiblings(task.id);
    // Spec 017: a merged review-entry task's preserved external workspace keeps
    // its folder; only Paseo's sidebar entry is archived, and only behind the
    // adapter's source-backed placement proof. It runs before the owned-workspace
    // loop so a held owned archive never delays it, and it never throws into that
    // loop: its own durable record and events are the visible state.
    task = await this.settlePreservedCatalogArchive(task, retryWorkspaceId);
    const runs = this.store.runs(task.id);
    const attachedAgentIds = new Set(
      [
        task.agentId,
        task.coordinatorAgentId,
        task.resolution.reviewerAgentId,
        ...task.retiredWorkers.map((worker) => worker.agentId),
        ...runs.map((run) => run.agentId),
      ]
        .filter((id): id is string => Boolean(id))
        .filter((id) => {
          // Terminal deletion is already confirmed by the host and recorded in
          // the thread lane. Such a thread has no projection left to observe.
          // Pending/unknown effects and live runs keep the participant proof.
          const key = this.store.threadArchiveKey(id, task.hostId);
          const effect = key
            ? this.store.getMeta<{ status: string; op?: string }>(key)
            : undefined;
          return (
            effect?.status !== "archived" ||
            effect.op !== "delete" ||
            runs.some((run) => run.agentId === id && !run.released)
          );
        }),
    );
    const workspaces = terminalArchiveWorkspaces(task, runs);
    for (const workspace of workspaces) {
      if (retryWorkspaceId && retryWorkspaceId !== workspace.id) continue;
      if (
        workspace.id &&
        task.resolution.archivedWorkspaceIds.includes(workspace.id)
      ) {
        await this.settleArchivedBuildOutput(task, workspace);
        task = this.store.task(task.id);
        continue;
      }
      if (!workspace.id || !workspace.directory || !workspace.head) continue;
      const id = workspace.id;
      if (
        retryWorkspaceId !== id &&
        archiveSettledByOwner(this.store.task(task.id), id)
      )
        continue;
      if (!canRecordWorkspaceArchive(task, id)) continue;
      const retry: WorkspaceArchiveRetry | undefined = this.store
        .task(task.id)
        .resolution.workspaceArchiveRetries.find(
          (record) => record.workspaceId === id,
        );
      // An owner may retry now, outside the ordinary backoff interval.
      if (!retryWorkspaceId && archiveRetryWaiting(retry)) continue;
      await this.archiveWorkspace(task, workspace, runs, attachedAgentIds);
      task = this.store.task(task.id);
      await this.settleArchivedBuildOutput(task, workspace);
      task = this.store.task(task.id);
    }
    // nucleus#1548: the merge made the Nucleus-created branch disposable, and the
    // worktree that carried it is gone, so closeout deletes it here. The cleanup
    // records its own intent, cause and retry; it never blocks the task's `done`.
    await cleanupTerminalBranches(
      { store: this.store, adapter: this.adapter },
      task.id,
      { retry: Boolean(retryWorkspaceId) },
    );
  }
  /** Archive one owned workspace, or record the bounded retry that holds it. */
  private async archiveWorkspace(
    task: Task,
    workspace: TerminalWorkspace,
    runs: Run[],
    attachedAgentIds: ReadonlySet<string>,
  ): Promise<void> {
    const id = workspace.id!;
    try {
      await this.attemptWorkspaceArchive(
        task,
        { ...workspace, id, directory: workspace.directory! },
        runs,
        attachedAgentIds,
      );
    } catch (error) {
      if (this.engine.stopped) return;
      const reason = error instanceof Error ? error.message : String(error);
      recordArchiveRetry(
        {
          store: this.store,
          update: this.engine.resolution.update.bind(this.engine.resolution),
        },
        task.id,
        id,
        reason,
        false,
      );
      // A teardown Paseo reported as failed is not a clean archive either:
      // preserve the failure evidence and any captured token for retry.
      if (archiveFailureKeepsScope(this.engine.retirement, task.id, id, error))
        this.engine.retirement.flagArchiveFailure(task.id, id, reason);
    }
  }
  private async attemptWorkspaceArchive(
    task: Task,
    workspace: TerminalWorkspace & { id: string; directory: string },
    runs: Run[],
    attachedAgentIds: ReadonlySet<string>,
  ): Promise<void> {
    const id = workspace.id,
      directory = workspace.directory;
    if (runs.some((run) => !run.released))
      throw Error("Waiting for all task runs to release");
    const hostRun = this.store.hostRunHoldingWorkspace(directory);
    if (hostRun) throw Error(`Waiting: ${hostRunHoldReason(hostRun)}`);
    const discardRecord = this.store.getMeta<WorkspaceDiscard>(
      workspaceDiscardKey(task.id, id),
    );
    const discard =
      discardRecord && discardRecord.directory === directory
        ? discardRecord
        : null;
    const intent = this.store.task(task.id).resolution;
    const head =
      !workspace.reportSource || discard
        ? workspace.head!
        : intent.archiveIntentWorkspaceId === id
          ? (intent.archiveIntentHead ?? workspace.head!)
          : existsSync(directory)
            ? await reportOnlySourceHead(task, runs)
            : workspace.head!;
    const reviewRun = runs.find(
      (run) => run.reviewSourceView?.workspaceId === id,
    );
    const sharedWorkspace = () =>
      this.store.workspaceUsedByOtherTaskRun(task.id, id) ||
      this.store.tasks().some((other) =>
        other.id !== task.id &&
        ([
          other.workspaceId,
          other.resolution.coordinatorWorkspaceId,
          other.resolution.closeoutWorkspaceId,
        ].includes(id) || other.directory === directory),
      );
    if (sharedWorkspace()) throw Error("Workspace is referenced by another task");
    const allowed = () => {
      const current = this.store.task(task.id);
      return (
        !this.paused() &&
        !current.removedAt &&
        current.phase === "done" &&
        !holdsOf(current).dispatch &&
        canRecordWorkspaceArchive(current, id) &&
        current.workspaceId === task.workspaceId &&
        current.directory === task.directory &&
        current.branch === task.branch &&
        (!reviewRun ||
          JSON.stringify(this.store.run(reviewRun.id)?.reviewSourceView) ===
            JSON.stringify(reviewRun.reviewSourceView)) &&
        !(id === current.workspaceId && externalWorkspace(current)) &&
        !this.store.runs(task.id).some((run) => !run.released) &&
        !this.store.hostRunHoldingWorkspace(directory) &&
        !sharedWorkspace()
      );
    };
    if (!allowed())
      throw Error(
        "Workspace archive held by task identity, ownership or a hold",
      );
    let sourcePresent = true;
    try {
      lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      sourcePresent = false;
    }
    if (!sourcePresent && await this.adapter.taskWorkspaceArchived?.(id)) {
      if (allowed())
        await this.recordWorkspaceArchived(task.id, id, "Workspace already absent");
      return;
    }
    const buildOutputCleanup = buildOutputCleanupHooks(
      this.store,
      task.id,
      id,
      directory,
      allowed,
    );
    if (sourcePresent) {
      await this.engine.retirement.capture(task.id, id, directory);
      const retention = await this.engine.hooks.retentionGate(task, {
        directory,
        head,
        reason: `Closeout archive of task workspace ${id}`,
      });
      if (retention.hold) throw Error(hookHoldReason(retention));
    }
    if (!allowed())
      throw Error("Workspace archive held by task identity, ownership or a hold");
    // Persist intent when the adapter is ready to mutate the workspace.
    const archived = await this.adapter.archiveTaskWorkspace!(
      task,
      id,
      directory,
      head,
      () => {
        if (!allowed()) return false;
        const current = this.store.task(task.id);
        if (
          current.resolution.archiveIntentWorkspaceId === id &&
          archiveIntentOutstanding(current)
        )
          return (current.resolution.archiveIntentHead ?? head) === head;
        this.engine.resolution.update(
          current,
          { archiveIntentWorkspaceId: id, archiveIntentHead: head },
          {},
          "workspace_archive_intent",
          head,
        );
        return true;
      },
      false,
      {
        requirePublished: true,
        attachedAgentIds,
        requireDirectory: true,
        allowIdleForeignThreads: !reviewRun,
        buildOutputCleanup,
        reviewRun: reviewRun ?? undefined,
        discard,
        primaryArchived: () =>
          Boolean(
            task.workspaceId &&
            this.store.task(task.id).resolution.archivedWorkspaceIds.includes(task.workspaceId),
          ),
      },
    );
    if (this.engine.stopped) return;
    if (!archived) {
      const retained = this.store
        .task(task.id)
        .resolution.buildOutputCleanups.find(
          (item) =>
            item.workspaceId === id &&
            !item.runId &&
            (item.state === "skipped" || item.state === "uncertain"),
        );
      if (retained)
        recordArchiveRetry(
          {
          store: this.store,
          update: this.engine.resolution.update.bind(this.engine.resolution),
        },
          task.id,
          id,
          retained.detail,
          true,
        );
      return;
    }
    const foreign = Array.isArray(archived) ? archived : [];
    if (discard)
      this.store.event(
        task.id,
        "workspace_contents_discarded",
        JSON.stringify({
          ...discard,
          detail:
            "Unproven contents discarded: no clean or published source is claimed",
        }),
      );
    const detail = [
      foreign.length
        ? `foreign threads ${foreign.join(",")}`
        : "workspace_archived",
      ...(discard
        ? [
            `unproven contents discarded by ${discard.caller} (${discard.authority})`,
          ]
        : []),
      ...(head !== workspace.head
        ? [`report-only source ${head} preserved on ${task.branch}`]
        : []),
    ].join("; ");
    await this.recordWorkspaceArchived(task.id, id, detail);
  }

  private async recordWorkspaceArchived(taskId: string, id: string, detail: string) {
    const latest = this.store.task(taskId);
    const runtimeRetirements = this.engine.retirement.markArchived(latest, id);
    const workspaceArchiveRetries =
      latest.resolution.workspaceArchiveRetries.filter(
        (record) => record.workspaceId !== id,
      );
    this.engine.resolution.update(
      latest,
      {
        archivedWorkspaceIds: [
          ...new Set([...latest.resolution.archivedWorkspaceIds, id]),
        ],
        ...(latest.resolution.archiveIntentWorkspaceId === id
          ? { archiveIntentWorkspaceId: null, archiveIntentHead: null }
          : {}),
        workspaceArchiveRetries,
        cleanupReason:
          runtimeRetirementFailure({
            resolution: { ...latest.resolution, runtimeRetirements },
          }) || workspaceArchiveFailureReason(workspaceArchiveRetries),
        runtimeRetirements,
      },
      {},
      "workspace_archived",
      `${detail}; workspace ${id}`,
    );
    await this.engine.retirement.archived(taskId, id);
  }
  async enqueuePass(scopedHost?: string): Promise<void> {
    return this.scheduler.enqueuePass(scopedHost);
  }
  /** Direct pass: reconcile recoverable tasks, then await the serial cleanup drain. */
  async pass(): Promise<void> {
    return this.scheduler.pass();
  }
}
