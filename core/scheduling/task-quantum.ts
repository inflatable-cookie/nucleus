import { settleWorkerCreation } from "../recovery/creation-lookup";
import { stopClearedPatch } from "../../shared/task-stop";
import { recordedSlotWait } from "../recovery/wait-context";
import { TASK_PROGRESSING_REASON } from "../../shared/task-detail-summary";
import {
  hostOwesRunProcessCleanup,
  sweepSettledRunProcesses,
} from "../machine/run-process-cleanup";
import { LANE_PRIORITY_AUDIT } from "./lane-priorities";
import {
  QUANTUM_READ_DEADLINE_MS,
  QUANTUM_TOTAL_READ_BUDGET_MS,
  boundedRead,
  runInTaskQuantumScope,
} from "./pass-snapshot";
import { onCheckoutVolume } from "../workspaces/checkout-volume";
import { reconcileUsageGate } from "../dispatch/usage-gate";
import { reconcileUnavailablePreference } from "../dispatch/unavailable-preference";
import { provisionHostMovedWorkspace } from "../dispatch/worker-host-move";
import { archiveFinishedThreads } from "../workspaces/thread-archive";
import { archiveSupersededWorkers } from "../workspaces/thread-archive-replacement";
import type { Task } from "../../shared/contracts";
import { missingOriginHasPlanner } from "../questions/origin";
import {
  taskStopClassification,
  taskStopRecord,
  taskStopVerbsFor,
  UNKNOWN_TASK_ATTENTION_REASON,
} from "../../shared/task-stop";
import {
  hostReadTransientKey,
  isHostReadRecoveryHeld,
  readHostReadTransientEpisode,
  taskHostReadOccurrenceKey,
  taskHostReadStep,
  taskHostReadTarget,
  unwrapCoordinatorRouteWrapper,
  type HostReadTransientEpisode,
} from "../recovery/host-read-transient";
import { holdsOf, taskHasUnreleasedRun } from "../../shared/contracts";
import { startsNoRuns } from "../closeout/queue-drain";
import { isDispositionActive } from "../../shared/contracts";
import type { Resolution } from "../resolution";
import { participantToolRunIds } from "../recovery/task-reasons";
import { releasedRunDeliveryEvidence } from "../recovery/recovery-effects";
import { proofExecutionRunning } from "../qa/proof-admission";
import { hookHoldReason } from "../hooks/hooks";
import { OrphanPhases } from "../recovery/orphan-phase";
import type { Engine } from "../engine";

export type TaskQuantumContext = Pick<
  Engine,
  | "adapter"
  | "cleanContext"
  | "enqueueCleanup"
  | "enqueueTitle"
  | "hooks"
  | "launchAgent"
  | "launchProofOnly"
  | "moveToReview"
  | "moveToWork"
  | "note"
  | "noteStepFailure"
  | "observeOwnerStop"
  | "preferredHostKindsForTask"
  | "prerequisiteWaitYieldsToLiveWork"
  | "profileCatalogKnown"
  | "profileCatalogKnownFor"
  | "profiles"
  | "quantumFinish"
  | "quantumSteps"
  | "reconcile"
  | "reconcileBlockedEffects"
  | "reconcileClosedRetainedReviewer"
  | "recoverExistingWorkspace"
  | "scheduleLane"
  | "settleFinishedRuns"
  | "settleHistoricalProofExecutions"
  | "settleRunBuildOutputs"
  | "settleSupersededIdleRuns"
  | "routingDecisions"
  | "stopped"
  | "store"
  | "wakeRepository"
  | "workerHostCatalogPending"
  | "workerHostCatalogs"
  | "workerRoutingProfiles"
  | "hostAvailable"
> & {
  readonly resolution: Pick<
    Resolution,
    | "adapter"
    | "advance"
    | "beginValidationScanPass"
    | "graceMs"
    | "hostAvailable"
    | "onTaskHost"
    | "store"
    | "clearHostReadTransient"
    | "holdProofOnlyGoWait"
    | "ownedToolHold"
    | "owns"
    | "quantumReadBudgetMs"
    | "quantumReadTimeoutMs"
    | "raiseOperatorQuestions"
    | "reconcileHoldUntil"
    | "reconcileUncertainRunDelivery"
    | "recordStop"
    | "recoverExternalMerge"
    | "recovery"
    | "resumeClearedAttention"
    | "settleBudgetClock"
    | "settleSettledWaitStop"
    | "slotAdmissionReason"
    | "update"
    | "waiting"
  >;
};

export class TaskQuantum {
  /** Spec 068 §4: orphan phases return to admission or record a typed stop. */
  readonly orphanPhases: OrphanPhases;
  constructor(readonly context: TaskQuantumContext) {
    this.orphanPhases = new OrphanPhases(context);
  }
  private readonly deliveryOffset = new Map<string, number>();

  private async observeReleasedRunDeliveries(taskId: string): Promise<void> {
    const { adapter, resolution, store } = this.context;
    if (!adapter.originAgent || !adapter.agentTimelinePage) return;
    const eligible = store
      .runs(taskId)
      .filter(
        (run) =>
          run.released &&
          run.status === "uncertain" &&
          Boolean(run.agentId) &&
          Boolean(run.workspaceId) &&
          !releasedRunDeliveryEvidence(store, run),
      );
    if (!eligible.length) return;
    const offset = this.deliveryOffset.get(taskId) ?? 0;
    this.deliveryOffset.set(taskId, (offset + 1) % eligible.length);
    const start = offset % eligible.length;
    const ordered =
      start === 0
        ? eligible
        : [...eligible.slice(start), ...eligible.slice(0, start)];
    const budgetMs =
      resolution.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS;
    const deadlineAt = Date.now() + budgetMs;
    for (const run of ordered) {
      if (Date.now() >= deadlineAt) return;
      try {
        await resolution.reconcileUncertainRunDelivery(
          taskId,
          run.id,
          deadlineAt,
        );
      } catch {
        /* An unreadable or changed timeline leaves this occurrence unknown. */
      }
    }
  }

  prerequisiteWaitYieldsToLiveWork(task: Task): boolean {
    if (task.resolution.recoveryActive) return true;
    const runs = this.context.store.runs(task.id);
    if (runs.some((run) => !run.released)) return true;
    const current = task.resolution.currentRunId
      ? this.context.store.run(task.resolution.currentRunId)
      : null;
    if (current?.completion) return true;
    return taskHasUnreleasedRun(task, false);
  }

  /**
   * Settled-run process cleanup is durable work, not this task's work. It runs on
   * its own host lane, one queued sweep per host, so a slow, hung or unavailable
   * process table can never hold the task's exclusive lane and starve an owner
   * control behind it (nucleus#1306). The intent on the store is the proof of
   * completion; the waiting quantum is not.
   *
   * The queued sweep is host-scoped, not task-scoped: a burst of tasks on one host
   * coalesces onto the one sweep already waiting, and that sweep owes every run of
   * the host. Task-scoping it while coalescing across tasks would settle only the
   * first task's runs and silently leave the rest (review 5943860105). Nothing is
   * queued while the host owes no cleanup, so the sweep never reads a process
   * table a task quantum does not need.
   */
  scheduleRunProcessCleanup(taskId: string): void {
    if (this.context.stopped) return;
    const hostId = this.context.store.task(taskId).hostId;
    const store = this.context.store,
      adapter = this.context.adapter;
    if (!hostOwesRunProcessCleanup(store, hostId)) return;
    void this.context
      .cleanContext(() =>
        this.context.scheduleLane(
          `cleanup:${hostId}`,
          LANE_PRIORITY_AUDIT,
          () =>
            sweepSettledRunProcesses(store, hostId, {
              pendingOnly: true,
              readProcesses: () => adapter.hostProcessListing!(),
            }),
          { coalesce: "settled-run-process-cleanup" },
        ),
      )
      .catch(() => {
        /* the durable intent waits for the next pass */
      });
  }

  reconcileProfileAdmission(task: Task): Task {
    const { store, routingDecisions } = this.context;
    reconcileUsageGate(store, routingDecisions, task.id);
    const current = store.task(task.id);
    if (current.removedAt) return current;
    if (
      this.context.profileCatalogKnown() ||
      this.context.profileCatalogKnownFor(current.hostId) ||
      this.context.workerHostCatalogs(current).length > 0
    )
      return reconcileUnavailablePreference(
        store,
        routingDecisions,
        current,
        this.context.workerRoutingProfiles(current),
        this.context.workerHostCatalogPending(current),
      );
    return current;
  }

  async taskQuantum(taskId: string): Promise<void> {
    const budgetMs =
      this.context.resolution.quantumReadBudgetMs ??
      QUANTUM_TOTAL_READ_BUDGET_MS;
    return runInTaskQuantumScope(budgetMs, async () => {
      const task = this.reconcileProfileAdmission(
        this.context.store.task(taskId),
      );
      const quantum = { pausedForPrerequisiteWait: false };
      // One pass, one worktree-validation scan: every read this quantum makes for
      // the same task worktree and selector argv shares it, and the next quantum
      // reads again (task 450).
      this.context.resolution.beginValidationScanPass();
      try {
        await this.context.quantumSteps(taskId, task, quantum);
      } finally {
        if (!quantum.pausedForPrerequisiteWait)
          await this.context.quantumFinish(taskId);
      }
    });
  }

  async quantumSteps(
    taskId: string,
    task: Task,
    quantum: { pausedForPrerequisiteWait: boolean },
  ): Promise<void> {
    try {
      if (task.directory && onCheckoutVolume(task.directory))
        await this.context.adapter.preflightWorkspaceStorage?.(task);
      if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt) {
        const wait = this.context.store.reconcilePrerequisiteWait(task.id);
        task = this.context.store.task(taskId);
        if (
          wait === "waiting" &&
          !this.context.prerequisiteWaitYieldsToLiveWork(task)
        ) {
          quantum.pausedForPrerequisiteWait = true;
          return;
        }
      }
      if (task.resolution.ownerStop) {
        await this.context.observeOwnerStop(task.id);
        task = this.context.store.task(taskId);
      }
      // Spec 046: a self-lifting hold ends by itself once its condition is met, before
      // anything in this pass acts on the held task. Re-read so the pass sees the release.
      const fences = holdsOf(task);
      if (
        (fences.dispatch?.until || fences.merge?.until || task.holdUntil) &&
        this.context.resolution.reconcileHoldUntil(task.id) === "auto_released"
      ) {
        task = this.context.store.task(taskId);
        if (task.phase === "queued")
          this.context.cleanContext(() => {
            void this.context.wakeRepository(task.repoPath);
          });
      }
      // Settle finished runs before anything that can skip a task, so a recorded completion
      // is never left holding a lane. Pause defers this path so a recovery escalate stays
      // stored. A reported unreleased thread reaches release in Observation (nucleus#937).
      this.context.settleFinishedRuns(task);
      this.scheduleRunProcessCleanup(taskId);
      if (isDispositionActive(this.context.store.task(task.id))) return;
      // Queue #342: settle finished runs' regenerable output before any launch below, in the task's serial lane.
      await this.context.settleRunBuildOutputs(task.id);
      const pendingStallStop = this.context.store.task(task.id).resolution
        .stalledTurnStop;
      if (pendingStallStop && pendingStallStop.status !== "completed") {
        const stoppedRun =
          pendingStallStop.role === "worker"
            ? null
            : this.context.store.run(pendingStallStop.runId);
        const targetComplete =
          pendingStallStop.role === "worker"
            ? this.context.store.task(task.id).completion?.runId ===
              pendingStallStop.runId
            : stoppedRun?.completion?.runId === pendingStallStop.runId;
        const sameTarget =
          pendingStallStop.role === "worker"
            ? this.context.store.task(task.id).runId === pendingStallStop.runId
            : this.context.store.task(task.id).resolution.currentRunId ===
              pendingStallStop.runId;
        if (sameTarget && !targetComplete) {
          if (
            pendingStallStop.role === "worker" &&
            this.context.store.task(task.id).agentId
          )
            await this.context.reconcile(this.context.store.task(task.id));
          return;
        }
        if (!sameTarget && !targetComplete) {
          const reason = `Stalled-turn stop for ${pendingStallStop.role} run ${pendingStallStop.runId} no longer matches the task's assigned run; owner inspection is required`;
          if (this.context.store.task(task.id).reason !== reason)
            this.context.store.update(
              task.id,
              {
                reason,
                ...stopClearedPatch(this.context.store.task(task.id), reason),
              },
              "stalled_turn_binding_changed",
              reason,
            );
          return;
        }
      }
      if (
        task.phase === "needs_attention" &&
        task.completion?.status === "ready_for_review" &&
        task.workspaceId &&
        this.context.adapter.workspaceAvailable
      ) {
        const deadlineMs =
          this.context.resolution.quantumReadTimeoutMs ??
          QUANTUM_READ_DEADLINE_MS;
        const avail = await boundedRead(
          "workspace availability",
          () => this.context.adapter.workspaceAvailable!(task.workspaceId!),
          deadlineMs,
        );
        if (avail.state === "ok" && !avail.value) {
          await this.context.resolution.advance(task);
          return;
        }
      }
      task = this.context.store.task(taskId);
      const probeExternalMerge = !["done", "cancelled"].includes(task.phase);
      if (probeExternalMerge) {
        if (await this.context.resolution.recoverExternalMerge(task)) return;
        // The probe may have restored the pre-attention phase and reason it found on
        // a cleared external-merge-check strand; re-read so this pass advances it.
        task = this.context.store.task(taskId);
      }
      if (
        task.phase !== "queued" &&
        !["done", "cancelled"].includes(task.phase) &&
        recordedSlotWait(task) &&
        (task.phase === "verifying" ||
          !this.context.resolution.slotAdmissionReason(
            task,
            task.phase === "needs_attention",
          ))
      ) {
        // A recorded fault (the attention flag) keeps its own reason; a phase alone
        // names no fault, so a wait that owned nothing falls back to the progressing
        // prose and cannot become a stop later (nucleus#1437).
        const settledReason = task.resolution.attention
          ? task.reason === task.resolution.stop!.detail
            ? UNKNOWN_TASK_ATTENTION_REASON
            : task.reason
          : TASK_PROGRESSING_REASON;
        task = this.context.resolution.update(
          task,
          { stop: null },
          { reason: settledReason },
          "slot_wait_settled",
          task.resolution.stop!.detail,
        );
      }
      // nucleus#1437: a stored settled-wait prose stop with no live owner settles before
      // the ordinary pass reads ownership, so a released verdict is not held behind it.
      task = this.context.resolution.settleSettledWaitStop(task);
      // nucleus#1461: normalize any persisted host-read exhaustion record that
      // previously fell into `route_unavailable` or a coordinator recovery wrapper.
      if (
        isHostReadRecoveryHeld(this.context.store, task) === "exhausted" &&
        (task.resolution.stop?.reason === "route_unavailable" ||
          task.reasonFact?.code === "coordinator_unavailable" ||
          task.resolution.recovery)
      ) {
        const normalizedReason = unwrapCoordinatorRouteWrapper(task.reason);
        task = this.context.resolution.update(
          task,
          {
            recovery: null,
            recoveryActive: false,
            stop: taskStopRecord(
              "operator_needed",
              normalizedReason,
              task.resolution.stop,
              undefined,
              ["restart", "move"],
            ),
          },
          { reason: normalizedReason },
          "host_read_transient_normalized",
          normalizedReason,
        );
        if (
          !readHostReadTransientEpisode(this.context.store, task.id, "task")
        ) {
          const startedAt =
            Date.parse(task.resolution.stop?.since ?? "") || Date.now();
          this.context.store.setMeta(hostReadTransientKey("task", task.id), {
            startedAt,
            attempts: 0,
            retryAt: 0,
            detail: normalizedReason.slice(0, 1000),
            step: taskHostReadStep(task),
            hostId: task.hostId ?? null,
            target: taskHostReadTarget(task),
            occurrenceKey: taskHostReadOccurrenceKey(task),
            exhaustedAt: Date.now(),
            resumePhase: null,
            movedToAttention: task.phase === "needs_attention",
          } satisfies HostReadTransientEpisode);
        }
      }
      // Project-a #1837: a restart can leave the flag cleared on a recorded pre-attention
      // state. Restore it so the ordinary resolution path advances instead of idling.
      const resumed = this.context.resolution.resumeClearedAttention(task);
      if (resumed) task = resumed;
      if (
        !startsNoRuns(this.context.store) &&
        !task.workspaceId &&
        !task.workspaceIntent &&
        [
          "dispatching",
          "changes_requested",
          "awaiting_review",
          "reviewing",
          "needs_attention",
        ].includes(task.phase)
      ) {
        const ready = await provisionHostMovedWorkspace(
          {
            store: this.context.store,
            adapter: this.context.adapter,
            hostAvailable: (hostId) => this.context.hostAvailable(hostId),
            enqueueCleanup: (id) => this.context.enqueueCleanup(id ?? task.id),
            waiting: (currentTask, waitReason) =>
              this.context.resolution.waiting(
                currentTask,
                waitReason,
                "lifecycle",
              ),
          },
          task,
        );
        if (!ready) return;
        task = this.context.store.task(task.id);
      }
      if (this.context.resolution.owns(task)) {
        await this.context.resolution.advance(task);
        return;
      }
      const hookState = await this.context.hooks.reconcileTask(
        this.context.store.task(task.id),
      );
      if (hookState.hold) {
        this.context.note(
          task.id,
          hookHoldReason(hookState),
          "operator_needed",
          "needs_attention",
        );
        return;
      }
      const hostReadHold = isHostReadRecoveryHeld(this.context.store, task);
      const hostReadEpisode = hostReadHold
        ? readHostReadTransientEpisode(this.context.store, task.id, "task")
        : null;
      const canResumeHostReadQueued =
        task.phase === "needs_attention" &&
        !task.workspaceId &&
        !task.agentId &&
        hostReadHold !== null &&
        hostReadEpisode?.resumePhase === "queued" &&
        !startsNoRuns(this.context.store);
      const canResumeHostReadDispatch =
        task.phase === "needs_attention" &&
        Boolean(task.directory && task.workspaceId && task.profile) &&
        !task.agentIntent &&
        !task.agentId &&
        hostReadHold === "exhausted" &&
        (hostReadEpisode?.resumePhase === "dispatching" ||
          (!hostReadEpisode?.resumePhase && task.retiredWorkers.length === 0));
      if (canResumeHostReadQueued) {
        if (task.directory && onCheckoutVolume(task.directory))
          await this.context.adapter.preflightWorkspaceStorage?.(task);
        this.context.resolution.clearHostReadTransient?.(task.id, "task");
        const restored = this.context.resolution.update(
          this.context.store.task(task.id),
          { stop: null, attention: false },
          {
            phase: "queued",
            reason: "Fresh host observation recovered; requeued",
          },
          "host_read_transient_phase_restored",
          "queued",
        );
        this.context.cleanContext(() => {
          void this.context.wakeRepository(restored.repoPath);
        });
        return;
      }
      if (
        (task.workspaceIntent && !task.workspaceId) ||
        (task.agentIntent && !task.agentId)
      ) {
        const bound =
          (task.workspaceIntent && !task.workspaceId) ||
          (task.entrypoint === "proof" && task.proofOnly)
            ? await this.context.recoverExistingWorkspace(task)
            : false;
        const latest = this.context.store.task(task.id);
        // Spec 068 §3: the initial worker's uncertain creation settles by lookup
        // (bind, release for one relaunch, or a named wait) like every role's.
        const settled =
          !bound && latest.agentIntent && !latest.agentId && latest.workspaceId
            ? await settleWorkerCreation(this.context.resolution, latest)
            : "skipped";
        if (settled === "relaunched")
          this.context.cleanContext(() => {
            void this.context.wakeRepository(latest.repoPath);
          });
        if (!bound && settled === "skipped" && !latest.resolution.stop) {
          this.context.resolution.waiting(
            latest,
            latest.agentIntent && !latest.agentId
              ? `Worker creation is uncertain; use run.start worker fresh${latest.runId ? ` replacing=${latest.runId}` : ""} or run.release`
              : "Workspace creation is uncertain; inspect the host and resolve explicitly",
            "lifecycle",
            {
              fact: {
                code: "worker_lookup",
                ...(latest.runId ? { subject: latest.runId } : {}),
              },
            },
          );
        }
      } else if (
        task.agentId &&
        (["working", "needs_attention", "dispatching"].includes(task.phase) ||
          (!task.completion && ["blocked", "error"].includes(task.phase)))
      )
        await this.context.reconcile(this.context.store.task(task.id));
      else if (
        task.workspaceId &&
        !task.agentIntent &&
        (task.phase === "dispatching" ||
          (task.phase === "needs_attention" &&
            (task.retiredWorkers.length > 0 || canResumeHostReadDispatch))) &&
        !startsNoRuns(this.context.store)
      ) {
        const current = this.context.store.task(task.id);
        if (current.entrypoint === "proof" && current.proofOnly)
          await this.context.launchProofOnly(current);
        else await this.context.launchAgent(current);
      }
    } catch (error) {
      this.context.noteStepFailure(task.id, error);
    }
  }

  async quantumFinish(taskId: string): Promise<void> {
    if (!this.context.stopped) {
      try {
        let current = this.context.store.task(taskId);
        // Spec 058 budgets (nucleus#1153): this pass is where every live task is
        // observed, so the wall clock's pause intervals are settled here first —
        // a task held on a Nucleus-side cause must not spend its budget on it.
        current = this.context.resolution.settleBudgetClock(current, {
          returned: true,
        });
        // A budget stop always asks its question (nucleus#1153). Asking from the
        // task's own pass means a phase that records the stop, a task host that is
        // offline and a support step that failed earlier in the sweep cannot leave
        // the pause silent; the recorded intent still makes the raise idempotent.
        if (
          current.resolution.stop?.reason === "budget" &&
          !current.removedAt &&
          !this.context.store.getMeta("paused")
        )
          await this.context.resolution.raiseOperatorQuestions(taskId);
        current = this.context.store.task(taskId);
        // effigy#697: a release-GO wait is the operator's whatever a later write did to the stop.
        if (
          !current.removedAt &&
          this.context.resolution.holdProofOnlyGoWait(current)
        )
          current = this.context.store.task(taskId);
        // nucleus#1195: a running proof execution owns the lane. Its dispatch records
        // an ordinary thread-running wait over the reviewed phase, so the task must
        // not be re-stamped as a stopped task while the executor is still working;
        // its receipt is what moves the task.
        if (
          !this.context.store.getMeta("paused") &&
          !current.resolution.stop &&
          !current.removedAt &&
          !proofExecutionRunning(
            this.context.store.runs(current.id),
            current.resolution.currentRunId,
          ) &&
          ((current.originError &&
            !missingOriginHasPlanner(this.context.store, current)) ||
            current.resolution.attention ||
            ["blocked", "error", "needs_attention"].includes(current.phase)) &&
          // Settled-wait prose is no fault, so no stop is synthesized from it (nucleus#1437).
          (current.originError || current.reasonFact?.code !== "progressing")
        ) {
          // Only Queue's own origin error text is classified. A task reason can
          // be an agent's report, and reading a wait out of it invents one.
          const detail =
            current.originError ||
            current.reason ||
            UNKNOWN_TASK_ATTENTION_REASON;
          const classification = current.originError
            ? taskStopClassification(detail)
            : {
                reason: "operator_needed" as const,
                suggestedVerbs: taskStopVerbsFor("operator_needed"),
              };
          current = this.context.resolution.recordStop(
            current,
            classification.reason,
            detail,
            classification.suggestedVerbs,
            undefined,
            current.originError ? { code: "origin_error" } : undefined,
          );
        }
        this.reconcileProfileAdmission(current);
        // A checkpointed reviewer whose own agent was positively observed
        // closed can never receive its same-run continuation. Record that
        // terminal observation before recovery reads the task, so neither
        // `next` nor the coordinator advertises an impossible continuation.
        await this.context.reconcileClosedRetainedReviewer(taskId);
        // Task 560: a superseded executor's still-running record settles
        // from its own timeline before the release sweep reads it, so
        // history is truthful at rest; a late report still upgrades it.
        await this.context.settleHistoricalProofExecutions(
          taskId,
          "reconciler historical proof settlement",
        );
        // Nucleus#1159: later task evidence answers an uncertain host effect, and
        // a phase still blocked on one past its bound becomes attention rather
        // than staying the quiet wait nobody sees.
        if (!current.removedAt) await this.observeReleasedRunDeliveries(taskId);
        this.context.reconcileBlockedEffects(taskId);
        // Superseded idle runs release before recovery observes: a stale
        // run whose episode was cleared must not hold the recovery busy
        // wait or fence the next dispatch. Holds write nothing, so a pass
        // with nothing settleable leaves the task untouched.
        await this.context.settleSupersededIdleRuns(
          taskId,
          "reconciler superseded-idle settlement",
        );
        // Recovery.pass records fresh idle observations while paused but
        // gates every action after the observation. The task stop and any
        // coordinator dispatch remain untouched until resume.
        await this.context.resolution.recovery.pass(taskId);
        current = this.context.store.task(taskId);
        if (
          !this.context.store.getMeta("paused") &&
          !current.removedAt &&
          (current.resolution.stop ||
            (current.originError &&
              !missingOriginHasPlanner(this.context.store, current)))
        )
          await this.context.resolution.recovery.route(current);
        // Spec 068 §4: a phase nothing owns returns to admission for its role.
        if (!current.removedAt)
          await this.orphanPhases.settle(
            taskId,
            Boolean(this.context.store.getMeta("paused")),
          );
      } catch (error) {
        this.context.noteStepFailure(taskId, error);
      }
    }
    this.scheduleRunProcessCleanup(taskId);
    await archiveFinishedThreads(
      this.context.store,
      this.context.adapter,
      taskId,
      async (agentId, workspaceId) => {
        const task = this.context.store.task(taskId),
          runs = this.context.store.runs(taskId);
        const runIds = participantToolRunIds(task, runs, agentId, workspaceId);
        return this.context.resolution.ownedToolHold(agentId, {
          requireCompleteEvidence: true,
          runId: runIds[0],
          runIds,
          taskId,
          workspaceId,
        });
      },
    ).catch((error) => {
      this.context.store.event(
        taskId,
        "thread_archive_reconcile_error",
        String(error),
      );
    });
    // A superseded worker is archived straight away (nucleus#1181), not at
    // closeout: its replacement already runs on a new thread, and the old one
    // must leave T3's main list. T3-only; Paseo keeps its existing handling.
    await archiveSupersededWorkers(
      this.context.store,
      this.context.adapter,
      taskId,
    ).catch((error) => {
      this.context.store.event(
        taskId,
        "thread_archive_reconcile_error",
        String(error),
      );
    });
    // Title projection is enqueued on its own serial lane: a slow Paseo
    // rename can never hold this task's delivery lane.
    this.context.enqueueTitle(taskId);
  }
}
