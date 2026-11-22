import { unsettledControlRefusal } from "../recovery/recovery-effects";
import { restartTerminalRefusal } from "./verb-refusal-text";
import {
  DISPOSITION_CONTROL_REFUSAL,
  REMOVED_TASK_REFUSAL,
  parkedRestartRefusal,
} from "./control-refusals";
import {
  OPERATOR_BOARD_CALLER,
  isDispositionActive,
  WORKER_REPLACEMENT_CEILING,
  type Task,
  type TaskControlInput,
} from "../../shared/contracts";
import type { AgentObservation } from "../host/adapter";
import { HostReadRefusalError } from "../host";
import { taskPrNumber } from "../forge/index";
import type { RestartRole } from "./owner-verbs";
import {
  RestartRefusal,
  collectOwnerVerbFacts,
  deriveRestartRole,
  parkedRestart,
  restartShape,
  restartTakesParkedStep,
  unservedParkedStep,
  workerRestartRefusal,
} from "./owner-verbs";
import { escalatedWorkerRestart } from "./owner-restart";
import { hostFailureRefusalDetail } from "../host/errors";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { digest, now } from "../store/store";
import type { Engine } from "../engine";
import { resendExecutorReport } from "./executor-report";
import {
  exhaustedReviewer,
  requestReviewerReport,
  requireReviewerReplacement,
  reviewerReportPlan,
} from "./reviewer-report";
import { verifyEnclosingOperation } from "../planning/enclosing-operation";
import type { RestartRequest } from "./owner-shared";

/** Raised after read-only verification or the parked transaction has refused. */
class ParkedRestartPreSendRefusal extends Error {
  constructor(
    message: string,
    readonly taskEvidenceHash: string,
    readonly runEvidenceHash: string,
  ) {
    super(message);
  }
}
export { ParkedRestartPreSendRefusal };

/**
 * The owner's `restart` verb. This module owns the verb's admission: the
 * terminal and disposition gates, the role and shape derivation, the retained
 * workspace recovery, the replacement ceiling, the owner-stop deferral and the
 * parked-step fallback. Each shape is served by its own owner: worker
 * (`restart-worker.ts`), reviewer (`restart-review.ts`), resolution episode
 * (`restart-episode.ts`), the proof executor's one re-report request
 * (`executor-report.ts`) and a stalled turn's stop (`stalled-turn-stop.ts`).
 * `store`, `adapter` and `resolution` read the engine per call: tests replace the
 * adapter.
 */
export class RestartControls {
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }
  get adapter() {
    return this.engine.adapter;
  }
  get resolution() {
    return this.engine.resolution;
  }
  /** Re-run a parked step for restart's parked fallback; runs inside the caller's transaction. */
  restartParkedStep(
    task: Task,
    instruction: string | undefined,
    reviewerInstruction: string | undefined,
  ): Task {
    return this.engine.workerRestarts.restartParkedStep(
      task,
      instruction,
      reviewerInstruction,
    );
  }

  /** Handler-owned admission for restart displacement. */
  prepareWorkerResume(input: {
    taskId: string;
    version: number;
    instruction: string;
    record?: (task: Task) => Task;
    settleFences?: {
      detail: string;
      runIds: string[];
      displacedRunIds?: string[];
    };
  }): Promise<Task | (() => Task)> {
    return this.engine.workerRestarts.prepareWorkerResume(input);
  }

  /**
   * Round 4 (Tom, 2026-10-19): `restart` where no run of the role needs one
   * (`parkedRestart` decides, as `next` does). It re-runs a parked step, or
   * answers an escalation with the restart's reason, which stays the owner's:
   * a coordinator's restart never answers one.
   */
  async restartParked(
    input: TaskControlInput,
    task: Task,
    role: RestartRole,
    reason: string,
    operationId?: string,
  ): Promise<Task> {
    const parked = parkedRestart(
      collectOwnerVerbFacts(
        this.store,
        task,
        operationId,
        this.engine.coordinatorActionRunId.getStore(),
      ),
    );
    // A parked refusal is decided from store reads before any binding or send, so
    // it is a definite pre-send refusal: the durable operation settles as refused
    // instead of leaving an unresolved effect that fences the next owner verb.
    if ("refusal" in parked)
      throw new RestartRefusal(parkedRestartRefusal(role, parked.refusal));
    if (parked.kind === "answer") {
      if (!this.engine.isOwnerCall())
        throw Error(
          "Answering an escalation is the owner's decision; a coordinator's restart cannot answer it",
        );
      this.engine.rejectFenced(task, "escalation answer");
      return this.resolution.resolveEscalation(task, reason, true);
    }
    if (operationId) {
      const operation = this.store.operation(operationId);
      if (
        !operation ||
        operation.state !== "running" ||
        operation.taskId !== task.id ||
        operation.kind !== "task_control"
      )
        throw Error(
          "The task-control operation changed before its parked boundary",
        );
      this.store.putOperation({
        ...operation,
        preSendBoundaryStartedAt: now(),
      });
    }
    // A reviewer instruction routes a blocked, reviewed task back to review;
    // GitHub's PR head must still be the head that instruction is about.
    const reviewerInstruction =
      role === "reviewer" ? input.instruction : undefined;
    // The commit runs in the same continuation as the head proof, with no yield
    // between the proof's version recheck and the transaction.
    const commit = () =>
      this.store.transaction(() => {
        const current = this.store.task(task.id);
        this.engine.requireOwnerControlCurrent(
          current,
          input.version,
          "Task changed; refresh before restarting",
        );
        const restarted = this.engine.restartParkedStep(
          current,
          role === "reviewer" ? undefined : input.instruction,
          reviewerInstruction,
        );
        if (
          role === "reviewer" &&
          input.fresh === true &&
          restarted.phase === "awaiting_review"
        )
          return this.store.update(
            restarted.id,
            {
              resolution: {
                ...restarted.resolution,
                reviewerAgentId: null,
                reviewerProfile: null,
              },
            },
            "restart_review_fresh",
            reason,
          );
        return restarted;
      });
    try {
      return await ((reviewerInstruction
        ? this.engine.reviewerInstructionHeadProof(task, input.version, commit)
        : null) ?? commit());
    } catch (error) {
      // Verification is read-only and all local writes are rolled back; neither
      // route can authorize or send a continuation before it returns.
      throw new ParkedRestartPreSendRefusal(
        error instanceof Error ? error.message : String(error),
        digest(JSON.stringify(this.store.task(task.id))),
        digest(JSON.stringify(this.store.runs(task.id))),
      );
    }
  }

  /** The GitHub PR-head proof a reviewer instruction needs, then `commit`; null when no proof applies (no await, no yield). */
  reviewerInstructionHeadProof(
    task: Task,
    version: number,
    commit: () => Task,
  ): Promise<Task> | null {
    const peek = this.store.task(task.id);
    if (
      peek.removedAt ||
      peek.version !== version ||
      !["blocked", "error"].includes(peek.phase)
    )
      return null;
    const review = this.resolution.acceptedReviewAtUnchangedHead(peek);
    const advanced = review?.head
      ? null
      : this.resolution.retainedWorkerAdvancedReviewHead(peek);
    const executor = this.store.runs(peek.id).at(-1);
    const proof =
      executor?.role === "executor" && peek.resolution.reviewerAgentId
        ? (peek.proofExecutions ?? []).find(
            (item) =>
              item.runId === executor.id &&
              item.head === executor.head &&
              item.settledAt,
          )
        : undefined;
    if (!review?.head && !advanced && !proof) return null;
    return (async () => {
      const expected = proof?.head ?? review?.head ?? advanced?.head;
      const pr = await this.adapter.verifyPr(peek, taskPrNumber(peek));
      if (pr.head !== expected) {
        const source = proof
          ? "settled proof"
          : review?.head
            ? "accepted review"
            : "retained worker's latest pushed head";
        throw new Error(
          `The current PR head ${pr.head} differs from the ${source} head ${expected}; a reviewer instruction requires that head to be unchanged`,
        );
      }
      this.engine.requireOwnerControlCurrent(
        this.store.task(peek.id),
        version,
        "Task changed during PR head verification; refresh before retrying",
      );
      return commit();
    })();
  }

  private async restartBlockedWorkerWithPr(
    task: Task,
    input: TaskControlInput,
    reason: string,
    fresh: boolean,
    operationId?: string,
  ): Promise<Task> {
    const shape = "blocked_with_pr" as const;
    const unobserved = workerRestartRefusal(
      collectOwnerVerbFacts(this.store, task),
      shape,
    );
    if (unobserved) throw new RestartRefusal(unobserved);
    let observed: AgentObservation;
    try {
      observed = await this.engine.onTaskHost(task, () =>
        this.engine.host.observe(task.agentId!),
      );
    } catch (error) {
      if (error instanceof HostReadRefusalError) throw error;
      throw new RestartRefusal(
        `The retained worker cannot be observed (${hostFailureRefusalDetail(error)}); restore observation before restarting. No continuation was sent`,
      );
    }
    const latest = this.store.task(task.id);
    this.engine.requireOwnerControlCurrent(
      latest,
      task.version,
      "Task changed during restart verification; read next again before restarting",
    );
    const refusal = workerRestartRefusal(
      collectOwnerVerbFacts(this.store, latest),
      shape,
      observed,
    );
    if (refusal) throw new RestartRefusal(refusal);
    return this.engine.moveToWork({
      taskId: task.id,
      version: task.version,
      reason,
      instruction: input.instruction,
      caller: input.caller,
      ...(fresh
        ? {
            parentRestart: {
              before: () =>
                this.engine.workerRestarts.restoreParent({
                  task,
                  input,
                  operationId,
                }),
              commit: (result: Task, restored: boolean) =>
                this.engine.workerRestarts.recordRestoredRestart(
                  result,
                  operationId,
                  restored,
                ),
              restoreRetained: true,
            },
          }
        : {}),
      restart: this.engine.workerRestartArm(task, {
        reason,
        instruction: input.instruction,
        caller: input.caller,
        relayed: input.relayed,
        note: input.note,
        fresh,
        observedWorker: observed,
        supersedeNonDelivery: !fresh && task.resolution.nonDeliveryRoutePending,
      }),
    });
  }

  /** Recheck and commit the escalated worker's existing admission. */
  private applyEscalatedWorkerRestart(
    task: Task,
    input: TaskControlInput,
    reason: string,
    operationId?: string,
    restored = false,
  ): Task | null {
    return this.store.transaction(() => {
      const current = this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(
        current,
        input.version,
        "Task changed; refresh before restarting",
      );
      const plan = escalatedWorkerRestart(
        collectOwnerVerbFacts(this.store, current),
        verifyEnclosingOperation(this.store, input, operationId),
      );
      if (!plan) return null;
      if ("refusal" in plan) throw new RestartRefusal(plan.refusal);
      const detail = `restart worker: ${reason}`;
      this.engine.settleVerbFences(current.id, { detail, runIds: [] });
      this.engine.resumeReleasedPrerequisiteWait(current.id);
      const latest = this.store.task(current.id);
      const ready = this.resolution.update(latest, {
        stop: null,
        ...(input.instruction
          ? { pendingWorkerInstruction: input.instruction }
          : {}),
      });
      const restarted = this.resolution.returnToDispatch(
        ready,
        true,
        `Restart requested: ${reason}`,
        "restart_requested",
      );
      return this.engine.workerRestarts.recordRestoredRestart(
        restarted,
        operationId,
        restored,
      );
    });
  }

  /** Resume only the admitted worker branch after observing its exact restore. */
  async resumeRestoredWorker(
    input: TaskControlInput,
    operationId: string,
  ): Promise<Task> {
    const task = this.store.task(input.taskId);
    this.engine.requireOwnerControlCurrent(
      task,
      input.version,
      "Task changed during parent restore; read next again",
    );
    if (
      !verifyEnclosingOperation(this.store, input, operationId) ||
      task.removedAt ||
      isDispositionActive(task) ||
      ["done", "cancelled"].includes(task.phase) ||
      task.resolution.mergedCommit
    )
      throw new RestartRefusal("The original restart is no longer admitted");
    const role =
      (input.role as RestartRole | undefined) ??
      deriveRestartRole(task, this.store.runs(task.id));
    if (role !== "worker")
      throw new RestartRefusal(
        "The restored operation no longer names a worker restart",
      );
    const reason = (input.reason ?? "").trim();
    if (!reason) throw new RestartRefusal("restart requires a reason");
    const plan = escalatedWorkerRestart(
      collectOwnerVerbFacts(this.store, task),
      verifyEnclosingOperation(this.store, input, operationId),
    );
    if (plan && !("refusal" in plan))
      return this.applyEscalatedWorkerRestart(
        task,
        input,
        reason,
        operationId,
        true,
      )!;
    const shape = restartShape(
      task,
      this.store.runs(task.id),
      role,
      this.store.eventsAll(task.id),
    );
    if (
      shape === "blocked_with_pr" &&
      input.role === "worker" &&
      input.fresh === true
    )
      return this.restartBlockedWorkerWithPr(
        task,
        input,
        reason,
        true,
        operationId,
      );
    if (
      shape !== "absent_worker" &&
      shape !== "pre_dispatch" &&
      !(
        input.fresh &&
        (shape === "blocked_worker" ||
          shape === "retained_worker" ||
          shape === "stopped_revision")
      )
    )
      throw new RestartRefusal(
        "The original worker restart is no longer admissible after parent restoration",
      );
    return this.engine.restartWorker({
      task,
      input,
      role,
      shape,
      reason,
      operationId,
      instruction:
        input.instruction?.trim() ||
        "Continue the existing task under its current approved instruction source and within its approved scope.",
    });
  }

  /**
   * Spec 050 `restart`: get a stopped, stalled or checkpointed run going again.
   * The role is derived from the phase when omitted. Queue settles the fences
   * the restart supersedes, releases or stops the old run and starts the next
   * one through the existing internals: a continuation on the same agent by
   * default, or a fresh agent on the role's current route when `fresh` is set.
   * Every identity is derived here; the caller supplies only a reason and,
   * optionally, an instruction.
   */
  async restartTask(
    input: TaskControlInput,
    operationId?: string,
  ): Promise<Task> {
    const reason = (input.reason ?? "").trim();
    if (!reason) throw Error("restart requires a reason");
    const fresh = input.fresh === true;
    let task = this.store.task(input.taskId);
    if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(
      task,
      input.version,
      "Task changed; refresh before restarting",
    );
    if (isDispositionActive(task)) throw Error(DISPOSITION_CONTROL_REFUSAL);
    // Round 4: a restart applies while paused; what it would start waits (deferOwnerVerb).
    const role =
      (input.role as RestartRole | undefined) ??
      deriveRestartRole(task, this.store.runs(task.id));
    const replacement =
      role === "reviewer" && fresh
        ? await requireReviewerReplacement(
            this.engine,
            task,
            input.version,
            true,
          )
        : null;
    if (
      ["done", "cancelled"].includes(task.phase) ||
      task.resolution.mergedCommit
    ) {
      if (
        task.resolution.mergedCommit &&
        !["done", "cancelled", "syncing", "closing", "closeout"].includes(
          task.phase,
        )
      )
        return this.engine.moveToCloseout({
          taskId: task.id,
          version: task.version,
          reason,
          caller: input.caller,
          enclosing: () =>
            verifyEnclosingOperation(this.store, input, operationId),
        });
      // A finished or merged task restarts no run; a merged one still re-runs its
      // parked step (a closeout resynchronization), and either answers an escalation.
      const parked = parkedRestart(
        collectOwnerVerbFacts(
          this.store,
          task,
          operationId,
          this.engine.coordinatorActionRunId.getStore(),
        ),
      );
      if (
        "kind" in parked &&
        (parked.kind === "answer" ||
          (task.resolution.mergedCommit &&
            !["done", "cancelled"].includes(task.phase)))
      )
        return this.engine.restartParked(
          input,
          task,
          role,
          reason,
          operationId,
        );
      throw Error(
        restartTerminalRefusal(
          task,
          "refusal" in parked ? parked.refusal : undefined,
        ),
      );
    }
    if (role === "worker") {
      const preview = escalatedWorkerRestart(
        collectOwnerVerbFacts(this.store, task),
        verifyEnclosingOperation(this.store, input, operationId),
      );
      let restored = false;
      if (preview && !("refusal" in preview)) {
        // The same task lane and the same plan are checked again at commit.
        restored = await this.engine.workerRestarts.restoreParent({
          task,
          input,
          operationId,
        });
      }
      const escalated = this.applyEscalatedWorkerRestart(
        task,
        input,
        reason,
        operationId,
        restored,
      );
      if (escalated) return escalated;
    }
    const runs = this.store.runs(task.id);
    const shape =
      role === "reviewer" && exhaustedReviewer(task, runs)
        ? "stopped_reviewer"
        : restartShape(task, runs, role, this.store.eventsAll(task.id));
    const controlRefusal = unsettledControlRefusal(this.store, task);
    if (controlRefusal) {
      const reading =
        !fresh && shape === "checkpoint_reviewer"
          ? runs.find((run) => run.id === task.resolution.currentRunId)
          : undefined;
      const delivery = reading?.reviewDeliveries?.findLast(
        (item) => item.status === "reserved" || item.status === "uncertain",
      );
      // This control may observe the exact earlier delivery it is fenced on.
      // Even a positive answer stops here and never authorizes another send.
      if (
        reading &&
        delivery &&
        !unsettledControlRefusal(this.store, task, delivery.operationId)
      ) {
        const observed = await this.resolution.reconcileReviewDelivery(
          reading,
          delivery,
        );
        if (observed.status === "delivered") return this.store.task(task.id);
        throw Error(
          `Reviewer delivery ${delivery.deliveryId} remains uncertain; the durable hold is retained and no resend occurred`,
        );
      }
      throw new RestartRefusal(controlRefusal);
    }
    // nucleus#1195: the proof executor's one continuation is a re-report request,
    // never a relaunch, a fresh agent or a selector re-run.
    if (shape === "unreported_executor")
      return await resendExecutorReport(this.engine, input, task, reason);
    // A worker continuation whose recorded workspace is gone re-creates the
    // worktree from the branch on origin through the move-to-work transition, so
    // the task, PR and approval stay and the role starts on a fresh thread
    // (nucleus#974). A parked step that never needed the worker keeps its shape.
    const workerShape =
      shape !== null &&
      [
        "blocked_worker",
        "retained_worker",
        "blocked_with_pr",
        "stopped_revision",
        "owner_stopped_worker",
      ].includes(shape);
    if (
      role === "worker" &&
      workerShape &&
      task.workspaceId &&
      this.adapter.workspaceAvailable &&
      !(await this.adapter.workspaceAvailable(task.workspaceId))
    ) {
      if (!this.adapter.recoverTaskWorkspace)
        throw new RestartRefusal(
          "The recorded task workspace is gone and this host cannot re-create a worktree; restore the workspace before restarting",
        );
      return this.engine.moveToWork({
        taskId: task.id,
        version: task.version,
        reason,
        instruction: input.instruction,
        caller: input.caller,
      });
    }
    if (
      restartTakesParkedStep(
        task,
        shape,
        collectOwnerVerbFacts(
          this.store,
          task,
          operationId,
          this.engine.coordinatorActionRunId.getStore(),
        ),
        { explicitRole: input.role !== undefined },
      )
    )
      return this.engine.restartParked(input, task, role, reason, operationId);
    // A role shape the task cannot serve has no path of its own; the parked step's
    // refusal is the truthful answer (and is a definite pre-send refusal).
    if (shape && unservedParkedStep(task, shape)) {
      const parked = parkedRestart(
        collectOwnerVerbFacts(
          this.store,
          task,
          operationId,
          this.engine.coordinatorActionRunId.getStore(),
        ),
      );
      if ("refusal" in parked)
        throw new RestartRefusal(parkedRestartRefusal(role, parked.refusal));
    }
    const targetRunId =
      shape === "owner_stopped_worker"
        ? task.runId
        : role === "reviewer"
          ? task.resolution.currentRunId
          : shape === "stopped_revision"
            ? this.store
                .runs(task.id)
                .findLast(
                  (run) =>
                    run.role === "revision" &&
                    !run.released &&
                    run.agentId === task.agentId,
                )?.id
            : null;
    if (
      this.engine.ownerStopHold(task) &&
      targetRunId &&
      this.engine.ownerStopNamesRun(task, targetRunId)
    ) {
      if (shape === "stopped_reviewer") {
        // A held reviewer restart may be deferred, but the hold cannot hide an
        // unrelated durable run fence that would refuse the same restart.
        const finished = await this.engine.collectVerbFinishedRuns(
          task.id,
          (run) =>
            run.role === "reviewer" ||
            run.id === this.engine.openEpisodeRunId(task.id),
        );
        if (finished.fenced.length)
          throw new DurableFenceRefusal(
            this.engine.verbRunFenceRefusal(finished.fenced[0]!),
          );
        return this.engine.deferOwnerVerb(task, input, "held", {
          runId: targetRunId,
        });
      }
      if (["owner_stopped_worker", "stopped_revision"].includes(shape ?? ""))
        return this.engine.deferOwnerVerb(task, input, "held", {
          runId: targetRunId,
        });
    }
    const report =
      role === "reviewer" && !fresh && shape !== "stalled_run"
        ? reviewerReportPlan(
            task,
            this.store.runs(task.id),
            this.store.eventsAll(task.id),
          )
        : null;
    if (report) {
      if ("refusal" in report) throw new RestartRefusal(report.refusal);
      const run = report.run;
      const wait = this.engine.dispatchWaitsFor(
        task,
        this.engine.isOwnerCall(),
        true,
      );
      if (wait)
        return this.engine.deferOwnerVerb(task, input, wait, {
          runId: run.id,
          head: run.head,
        });
      return requestReviewerReport(
        this.engine,
        task,
        run,
        input.version,
        reason,
        input.instruction,
      );
    }
    // The ceiling remains the automatic loop breaker. Only a deliberate
    // operator-relayed fresh worker restart can pass it.
    const workerReplacementShape =
      shape !== null &&
      [
        "blocked_worker",
        "retained_worker",
        "blocked_with_pr",
        "stopped_revision",
      ].includes(shape);
    const armsReplacement =
      fresh && role === "worker" && workerReplacementShape;
    const operatorRelayed =
      input.caller === OPERATOR_BOARD_CALLER ||
      (input.relayed === true && Boolean(input.note?.trim()));
    if (
      armsReplacement &&
      task.retiredWorkers.length >= WORKER_REPLACEMENT_CEILING &&
      !operatorRelayed
    ) {
      throw new RestartRefusal(this.engine.replacementCeilingRefusal(task));
    }
    // Tom, 2026-10-23 ("Worker continues"): an explicitly named worker restart
    // on a blocked or errored task with a PR continues the retained worker on
    // that PR through the move-to-work transition (author revision on the same
    // workspace, branch and PR). project-a #1655 keeps resume_worker and the pre-PR
    // resume closed to this shape; a restart without a role still resumes into
    // review below. The worker refusals run first with a fresh observation.
    if (shape === "blocked_with_pr" && input.role === "worker")
      return this.restartBlockedWorkerWithPr(
        task,
        input,
        reason,
        fresh,
        operationId,
      );
    if (shape === "coordinator" && fresh)
      throw Error(
        "Coordinator restart retries the existing resolution; fresh is unsupported here. Use run.start coordinator fresh replacing=<run> to replace its agent",
      );
    const instruction =
      input.instruction?.trim() ||
      "Continue the existing task under its current approved instruction source and within its approved scope.";

    // A stalled live run is stopped through the existing durable targeted stop.
    // The stall incident is that stall's own evidence, so it is not settled first.
    if (shape === "stalled_run") {
      const runId =
        task.resolution.incident?.runId ??
        task.resolution.currentRunId ??
        task.runId;
      if (!runId)
        throw Error("The stalled run has no recorded identity to stop");
      const stopped = await this.engine.stopStalledTurn({
        taskId: task.id,
        version: task.version,
        runId,
      });
      const stop = stopped.resolution.stalledTurnStop;
      // The stop is asynchronous: the continuation is recorded with the stop so
      // the reconciliation that observes inactivity releases the run and starts
      // the continuation instead of parking. When inactivity is already
      // confirmed, continue now through the ordinary shapes.
      if (stop && stop.status !== "stopped" && stop.status !== "completed") {
        return this.store.update(
          stopped.id,
          {
            resolution: {
              ...stopped.resolution,
              stalledTurnStop: {
                ...stop,
                restartInstruction: instruction,
                restartFresh: fresh,
              },
            },
          },
          "stalled_turn_restart_requested",
          instruction.slice(0, 600),
        );
      }
      if (stop?.status === "stopped")
        return this.engine.restartTask(
          { ...input, version: stopped.version },
          operationId,
        );
      return stopped;
    }

    // Spec 050 atomic verbs: every restart shape settles the fences it retires
    // inside the transaction that applies its action, so a refused restart
    // changes nothing. A coordinator restart preserves its own recovery episode
    // while settling other finished runs: the retry path needs the episode
    // intact. A stalled live run settles nothing: the stall incident is
    // that stop's own evidence.
    task = this.store.task(task.id);
    const request: RestartRequest = {
      input,
      task,
      role,
      shape: shape!,
      reason,
      operationId,
      instruction,
    };
    if (replacement)
      return this.engine.restartReview(
        task.id,
        reason,
        instruction,
        true,
        replacement,
      );
    switch (shape) {
      case "owner_stopped_worker":
      case "pre_dispatch":
      case "absent_worker":
      case "blocked_worker":
      case "retained_worker":
      case "blocked_with_pr":
      case "stopped_revision":
        return this.engine.restartWorker(request);
      case "checkpoint_reviewer":
      case "stopped_reviewer":
        return this.engine.restartReviewer(request);
      case "absent_resolution":
      case "coordinator":
        return this.engine.restartEpisode(request);
      default:
        throw Error(`restart does not support the ${shape} state`);
    }
  }
}
