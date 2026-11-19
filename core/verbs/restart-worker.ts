import { TaskChangedRefusal } from "../../shared/task-version";
import { RETAINED_PREREQUISITE_REFUSAL } from "./verb-refusal-text";
import { groupIsUnavailable } from "../../shared/pool";
import {
  OPERATOR_BOARD_CALLER,
  WORKER_REPLACEMENT_CEILING,
  runHoldsSlot,
  type Run,
  type Task,
  type TaskControlInput,
} from "../../shared/contracts";
import type { AgentObservation } from "../host/adapter";
import { hostFailureRefusalDetail } from "../host/errors";
import { DurableFenceRefusal } from "../intake/run-settlement";
import {
  isBlockingRecoveryEffect,
  recoveryEffects,
  recoveryEffectsRefusal,
} from "../recovery/recovery-effects";
import { runsUnchangedSince } from "../recovery/observation-advance";
import {
  decideWorkerReplacement,
  isWorkerRouteApproved,
  retainedWorkerFailureCause,
} from "../recovery/worker-replacement";
import { OPERATOR_WORKER_REMAP_REASON } from "../recovery/task-reasons";
import { taskHasPr } from "../forge/index";
import { digest, now } from "../store/store";
import { occupiesSlot } from "../dispatch/capacity";
import { resolveWorkerHostForProfile } from "../dispatch/first-host-selection";
import {
  bindWorkerCreation,
  observeWorkerCreation,
  releaseStaleWorkerIntent,
  recordWorkerCreationRestart,
  sameWorkerCreation,
  workerCreationRefusal,
} from "../recovery/absent-creation/stale-worker";
import type { Engine } from "../engine";
import { restartResumeChoice } from "../task-decision-rules";
import {
  collectOwnerVerbFacts,
  currentRouteProfile,
  RestartRefusal,
  workerRestartRefusal,
} from "./owner-verbs";
import type { RestartRequest } from "./owner-shared";

/**
 * The worker half of `restart`: the shapes that continue or replace a worker run
 * — the owner-stopped initial worker, pre-dispatch replay, absent creation, the
 * blocked/retained worker and a stopped revision. Every shape settles the fences
 * it retires inside the transaction that applies its action, so a refused restart
 * changes nothing.
 */
export class WorkerRestarts {
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

  async restartWorker(c: RestartRequest): Promise<Task> {
    switch (c.shape) {
      case "owner_stopped_worker":
        return this.ownerStoppedWorker(c);
      case "pre_dispatch":
        return this.preDispatch(c);
      case "absent_worker":
        return this.absentWorker(c);
      case "blocked_worker":
      case "retained_worker":
      case "blocked_with_pr":
      case "stopped_revision":
        return this.resumeWorker(c);
      default:
        throw Error(`restart does not support the ${c.shape} state`);
    }
  }

  /** Re-run a parked step for restart's parked fallback; runs inside the caller's transaction. */
  restartParkedStep(
    task: Task,
    instruction: string | undefined,
    reviewerInstruction: string | undefined,
  ): Task {
    if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt)
      throw Error(RETAINED_PREREQUISITE_REFUSAL);
    const resumable = task.prerequisiteWait?.releasedAt
      ? this.store.update(
          task.id,
          { prerequisiteWait: null },
          "prerequisite_wait_resumed",
          "Operator explicitly resumed the task after the prerequisite notice",
        )
      : task;
    // A never-dispatched task parked in attention by a dispatch refusal returns
    // to queued through the ordinary operator-return episode closure, so an
    // escalated recovery, its incident, the attention flag and any pending
    // attention notices are settled before dispatch validation re-runs.
    if (
      resumable.phase === "needs_attention" &&
      this.engine.neverDispatched(resumable)
    ) {
      this.engine.rejectFenced(resumable, "pre-dispatch retry");
      return this.resolution.returnToDispatch(
        resumable,
        false,
        "Pre-dispatch retry requested; validating current state",
        "pre_dispatch_retry_requested",
      );
    }
    // Closeout resynchronization finishes merged work without admitting a worker.
    // Finishing already-merged work must remain possible at full capacity. The
    // ruling applies whatever the project's occupancy: an operator decision is not
    // a resource request, and refusing it left the lane blocked with the decision
    // made and nothing to show for it. The revision dispatch waits for a slot
    // instead - see the changes_requested branch in the resolution. The
    // instruction is a retained-worker remap override; retry() refuses it
    // anywhere else.
    const reportingRun = this.engine.coordinatorActionRunId.getStore();
    return this.resolution.prepareRetry(
      resumable,
      false,
      instruction,
      true,
      false,
      false,
      undefined,
      reviewerInstruction,
      reportingRun ? [reportingRun] : [],
    )();
  }

  /** Handler-owned admission for restart displacement. */
  async prepareWorkerResume(input: {
    taskId: string;
    version: number;
    instruction: string;
    settleFences?: {
      detail: string;
      runIds: string[];
      displacedRunIds?: string[];
    };
  }): Promise<Task | (() => Task)> {
    const task = this.store.task(input.taskId),
      runs = this.store.runs(task.id);
    const check = () => {
      const current = this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(
        current,
        input.version,
        "Task changed during absent-worker verification",
      );
      if (!runsUnchangedSince(runs, this.store.runs(task.id)))
        throw new TaskChangedRefusal(
          "Task changed during absent-worker verification",
          input.version,
          current.version,
        );
      this.engine.rejectFenced(current, "worker recovery");
      return current;
    };
    check();
    const settling = input.settleFences
      ? [
          ...input.settleFences.runIds,
          ...(input.settleFences.displacedRunIds ?? []),
        ]
      : [];
    if (task.agentIntent && !task.agentId) {
      const refusal = workerCreationRefusal(this.store, task, settling);
      if (refusal) throw new RestartRefusal(refusal);
      if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt)
        throw new RestartRefusal(RETAINED_PREREQUISITE_REFUSAL);
      const observed = await observeWorkerCreation(
        this.store,
        this.adapter,
        task,
        this.resolution.graceMs,
      );
      const current = check();
      if (current.resolution.deferredVerb)
        throw new RestartRefusal(
          "Another recorded direction already owns this task",
        );
      if (!sameWorkerCreation(this.store, current, observed))
        throw new TaskChangedRefusal(
          "Worker creation changed during restart",
          input.version,
          current.version,
        );
      if (observed.kind !== "absent") {
        // The direction remains owned while other runs settle through their
        // ordinary lifecycle. Binding by itself authorizes no cancellation.
        return this.store.transaction(() => {
          const recorded = recordWorkerCreationRestart(
            this.store,
            current,
            input.instruction,
          );
          if (observed.kind === "bound")
            return bindWorkerCreation(this.store, recorded, observed.agentId);
          if (
            !recorded.resolution.stop ||
            ["lifecycle", "operator_needed"].includes(
              recorded.resolution.stop.reason,
            )
          )
            this.resolution.waiting(recorded, observed.detail, "lifecycle");
          return this.store.task(task.id);
        });
      }
      if (
        this.adapter.workspaceAvailable &&
        !(await this.adapter.workspaceAvailable(task.workspaceId!))
      )
        throw new RestartRefusal(
          "Worker creation recovery requires the retained workspace online",
        );
      return () =>
        this.store.transaction(() => {
          const latest = check();
          const refusal = workerCreationRefusal(this.store, latest, settling);
          if (refusal) throw new RestartRefusal(refusal);
          if (!sameWorkerCreation(this.store, latest, observed))
            throw new TaskChangedRefusal(
              "Worker creation changed during restart",
              input.version,
              latest.version,
            );
          if (input.settleFences)
            this.engine.settleVerbFences(task.id, input.settleFences);
          return releaseStaleWorkerIntent(
            this.store,
            this.store.task(task.id),
            observed.proof,
            input.instruction,
          );
        });
    }
    this.resolution.prepareResumeWorker(
      task,
      input.instruction,
      true,
      settling,
    );
    return () => {
      const current = check();
      this.resolution.prepareResumeWorker(
        current,
        input.instruction,
        true,
        settling,
      );
      return this.store.transaction(() => {
        if (input.settleFences)
          this.engine.settleVerbFences(task.id, input.settleFences);
        return this.resolution.resumeWorker(
          this.store.task(task.id),
          input.instruction,
          true,
        );
      });
    };
  }

  /**
   * What `restart role=worker` adds to the move-to-work transition: both steps run
   * inside `moveToWork`'s transaction, one before it binds the PR and revises, one
   * after. `move` passes neither, because its schema refuses `fresh`.
   */
  workerRestartArm(
    task: Task,
    input: {
      reason: string;
      instruction?: string;
      caller?: string;
      relayed?: boolean;
      note?: string;
      fresh?: boolean;
      observedWorker?: AgentObservation;
      supersedeNonDelivery?: boolean;
    },
  ): {
    afterSettlement: (settled: Task) => Task;
    afterRevision: (revised: Task) => Task;
  } {
    const instruction =
      input.instruction?.trim() ||
      "Continue the existing task under its current approved instruction source and within its approved scope.";
    return {
      afterSettlement: (settledTask) => {
        if (
          input.supersedeNonDelivery &&
          settledTask.resolution.nonDeliveryRoutePending
        ) {
          this.resolution.update(
            settledTask,
            { nonDeliveryRoutePending: false, pendingRevisionCause: null },
            {},
            "non_delivery_replacement_superseded",
            `Owner restart worker: ${input.reason}`,
          );
          settledTask = this.store.task(task.id);
        }
        return settledTask;
      },
      afterRevision: (revised) => {
        // A fresh worker restart (explicit role worker) takes the revision on the
        // worker route through the existing replacement fields, set inside the
        // same accepted transition, so a refusal above leaves them untouched.
        const observedFailure = input.observedWorker
          ? retainedWorkerFailureCause({
              task: revised,
              observedStatus: input.observedWorker.status,
              observedError: input.observedWorker.error,
              observedActive:
                input.observedWorker.active ||
                Boolean(input.observedWorker.activeTurnId),
              observedPermissions: input.observedWorker.permissions,
              observedWorkspaceId: input.observedWorker.workspaceId,
            })
          : null;
        if (!input.fresh && observedFailure?.kind !== "agent_errored")
          return revised;
        // Spec 058 task 577: one worker thread. A fresh restart replaces only
        // on failure, on an approved route to a different model, or with an
        // explicit operator-relayed reason; otherwise the retained worker
        // continues the revision and the refusal names its rule.
        const moveRoute =
          currentRouteProfile(revised, "worker") ?? revised.profile!.id;
        const moveGroup =
          revised.profileGroup ??
          this.store
            .pool()
            .find((entry) => entry.profileId === revised.profile?.id)?.group ??
          null;
        const moveAvailabilityRow = moveGroup
          ? this.store.db
              .prepare("SELECT data FROM availability WHERE group_id=?")
              .get(moveGroup)
          : null;
        const moveAvailability = moveAvailabilityRow
          ? JSON.parse(String((moveAvailabilityRow as { data: string }).data))
          : null;
        const moveCatalogs = this.engine.workerHostCatalogs(revised);
        const moveHostSelection = resolveWorkerHostForProfile(
          revised,
          moveCatalogs,
          moveRoute,
          revised.profile?.thinkingOptionId ?? "",
          this.engine.preferredHostKindsForTask(revised),
          true,
        );
        const moveDecision = decideWorkerReplacement({
          task: revised,
          requestedProfileId: moveRoute,
          requestedModel:
            this.engine
              .workerRoutingProfiles(revised)
              .find((candidate) => candidate.id === moveRoute)?.model ??
            revised.profile?.model ??
            null,
          currentModel: revised.profile?.model ?? null,
          approved: isWorkerRouteApproved(
            revised,
            moveRoute,
            this.store.pool(),
            this.store.usageLevel(),
          ),
          hostChanges: Boolean(
            moveHostSelection && moveHostSelection.hostId !== revised.hostId,
          ),
          failure: retainedWorkerFailureCause({
            task: revised,
            observedStatus: input.observedWorker?.status,
            observedError: input.observedWorker?.error,
            observedActive: input.observedWorker
              ? input.observedWorker.active ||
                Boolean(input.observedWorker.activeTurnId)
              : undefined,
            observedPermissions: input.observedWorker?.permissions,
            observedWorkspaceId: input.observedWorker?.workspaceId,
            groupUnavailable:
              moveAvailability && groupIsUnavailable(moveAvailability)
                ? {
                    group: moveGroup!,
                    reason: String(moveAvailability.reason ?? ""),
                  }
                : null,
          }),
          // The explicit operator relay is the reason this fresh
          // replacement can proceed without a failure or model change.
          explicitOperatorRelay:
            input.caller === OPERATOR_BOARD_CALLER ||
            (input.relayed === true && Boolean(input.note?.trim())),
          freshRestart: true,
        });
        if (!moveDecision.allowed) {
          this.store.event(
            task.id,
            "worker_replacement_refused",
            `${moveDecision.rule}: ${moveDecision.detail}`,
          );
          return revised;
        }
        const moveCallerRelay =
          input.caller === OPERATOR_BOARD_CALLER ||
          (input.relayed === true && Boolean(input.note?.trim()));
        return this.store.update(
          revised.id,
          {
            failoverReason:
              `${OPERATOR_WORKER_REMAP_REASON}. Continue the existing task: ${instruction}`.slice(
                0,
                2000,
              ),
            replacementProfile:
              observedFailure?.kind === "agent_errored"
                ? null
                : {
                    profileId: moveRoute,
                    reason: input.reason.slice(0, 4000),
                    // Spec 058 task 577: the explicit operator relay travels with the arm.
                    ...(moveCallerRelay
                      ? { operatorRelayed: true as const }
                      : {}),
                  },
          },
          "restart_worker_requested",
        );
      },
    };
  }

  /**
   * A stalled live run is stopped through the existing durable targeted stop.
   * The stall incident is that stop's own evidence, so it is not settled first.
   */
  private async ownerStoppedWorker(c: RestartRequest): Promise<Task> {
    const { task, input, reason, instruction } = c;
    if (input.fresh)
      throw new RestartRefusal(
        "An owner-stopped initial worker resumes only on its retained thread",
      );
    if (
      !task.runId ||
      !task.agentId ||
      !task.workspaceId ||
      !this.engine.ownerStopNamesRun(task, task.runId)
    )
      throw new RestartRefusal(
        "The owner stop no longer names the retained initial worker run",
      );
    if (!this.adapter.notify)
      throw new RestartRefusal(
        "Retained-thread instruction delivery is unavailable",
      );
    let observed: AgentObservation;
    try {
      observed = await this.engine.onTaskHost(task, () =>
        this.engine.host.observe(task.agentId!),
      );
    } catch (error) {
      throw new RestartRefusal(
        `The retained worker cannot be observed (${hostFailureRefusalDetail(error)}); restore observation before restarting`,
      );
    }
    if (
      observed.id !== task.agentId ||
      observed.workspaceId !== task.workspaceId ||
      observed.permissions ||
      observed.active ||
      observed.activeTurnId ||
      !["idle", "error", "closed"].includes(observed.status)
    )
      throw new RestartRefusal(
        "The retained worker is no longer positively idle in its workspace; no instruction was delivered",
      );
    const messageId = `ns-owner-restart-${digest(`${task.id}:${task.runId}:${digest(instruction || reason)}`).slice(0, 32)}`;
    const events = this.store.eventsAll(task.id);
    const alreadySent = events.some(
      (event) =>
        event.kind === "owner_restart_instruction_sent" &&
        event.detail.includes(messageId),
    );
    const priorIntent = events.some((event) => {
      if (event.kind !== "owner_restart_instruction_intent") return false;
      try {
        return JSON.parse(event.detail).messageId === messageId;
      } catch {
        return false;
      }
    });
    // The intent is durable before the send and the sent marker after it: an
    // intent with neither marker is an unknown delivery and is never resent.
    if (!alreadySent && priorIntent)
      throw new RestartRefusal(
        "Owner restart instruction delivery is unknown; inspect the retained worker before deciding what to do next",
      );
    if (!alreadySent) {
      this.store.event(
        task.id,
        "owner_restart_instruction_intent",
        JSON.stringify({ runId: task.runId, agentId: task.agentId, messageId }),
      );
      await this.adapter.notify(
        task.agentId,
        messageId,
        `Owner restart instruction for the existing task run ${task.runId}: ${instruction || `Continue the existing task. Reason: ${reason}`}`,
      );
      this.store.event(
        task.id,
        "owner_restart_instruction_sent",
        JSON.stringify({ runId: task.runId, agentId: task.agentId, messageId }),
      );
    }
    return this.store.task(task.id);
  }

  /** Never-dispatched or re-admitted pre-PR work returns through its own existing admission path. */
  private async preDispatch(c: RestartRequest): Promise<Task> {
    const { task, input, role, reason } = c;
    // An owner move can leave a pre-PR task in changes_requested without
    // an author thread. Resume it through the ordinary move-to-work
    // replacement path so the retained workspace, branch and route are
    // reused; validation retry is reserved for tasks that have not entered
    // that author lifecycle.
    if (
      !task.agentId &&
      (task.runId || task.phase === "changes_requested") &&
      (task.profile || currentRouteProfile(task, "worker"))
    )
      return this.engine.moveToWork({
        taskId: task.id,
        version: task.version,
        reason,
        instruction: input.instruction,
        caller: input.caller,
      });
    // An initial pre-dispatch task replays admission through the existing
    // validation retry, which verifies any retained workspace. A review
    // entry re-admits from `queued` whatever its attention flag said.
    if (
      task.entrypoint !== "review" &&
      (task.workspaceIntent || task.workspaceId)
    )
      return this.engine.retryValidation({
        taskId: task.id,
        version: task.version,
        rebindWorkspaceId: input.rebindWorkspaceId,
        settleFences: { detail: `restart ${role}: ${reason}`, runIds: [] },
      });
    const retained = Boolean(task.workspaceIntent);
    return this.engine.control(
      () =>
        this.store.transaction(() => {
          this.engine.settleVerbFences(task.id, {
            detail: `restart ${role}: ${reason}`,
            runIds: [],
          });
          return this.resolution.returnToDispatch(
            this.store.task(task.id),
            retained,
            `Restart requested: ${reason}`,
            "restart_requested",
          );
        }),
      `task:${task.id}`,
    );
  }

  /**
   * The worker run is the task's own, not a Run row, so every Run row here is
   * another role: settle the finished ones with the restart, and the episode's own
   * reporting run with it.
   */
  private async absentWorker(c: RestartRequest): Promise<Task> {
    const { task, role, reason, instruction } = c;
    const version = task.version;
    const finished = await this.engine.collectVerbFinishedRuns(
      task.id,
      (run) => run.id === this.engine.openEpisodeRunId(task.id),
    );
    if (finished.fenced.length)
      throw new DurableFenceRefusal(
        this.engine.verbRunFenceRefusal(finished.fenced[0]!),
      );
    const displacement = await this.engine.planEpisodeDisplacement(
      task.id,
      version,
      `restart ${role}`,
    );
    return this.engine.control(
      () =>
        this.engine.executeEpisodeRestart(
          task.id,
          displacement,
          () =>
            this.engine.prepareWorkerResume({
              taskId: task.id,
              version,
              instruction,
              settleFences: {
                detail: `restart ${role}: ${reason}`,
                runIds: finished.settleable.map((item) => item.id),
                displacedRunIds: displacement.runIds,
              },
            }),
          finished.settleable.map((run) => run.id),
        ),
      `task:${task.id}`,
    );
  }

  /**
   * Spec 050 (#3569): finished runs of other roles settle by observation before
   * the continuation; a run that cannot settle keeps fencing the ordinary paths
   * and is left alone here. The coordinator episode this stop waits on settles
   * with the same continuation, so its reporting run never fences the restart: it
   * is planned here and cancelled only after every refusal check below, so a
   * refused continuation leaves the coordinator's work untouched.
   */
  private async resumeWorker(c: RestartRequest): Promise<Task> {
    const { task, input, role, reason, shape, instruction } = c;
    const version = task.version;
    const runsBefore = this.store.runs(task.id);
    const subject =
      shape === "stopped_revision"
        ? runsBefore.findLast(
            (run) =>
              run.role === "revision" &&
              !run.released &&
              !run.completion &&
              run.agentId === task.agentId &&
              run.workspaceId === task.workspaceId,
          )
        : undefined;
    const finished = await this.engine.collectVerbFinishedRuns(
      task.id,
      (run) =>
        run.id === subject?.id ||
        run.id === this.engine.openEpisodeRunId(task.id),
    );
    if (finished.fenced.length)
      throw new RestartRefusal(
        this.engine.verbRunFenceRefusal(finished.fenced[0]!),
      );
    const displacement = await this.engine.planEpisodeDisplacement(
      task.id,
      version,
      `restart ${role}`,
    );
    return this.engine.control(
      () =>
        this.engine.executeEpisodeRestart(
          task.id,
          displacement,
          async () => {
            const current = this.store.task(task.id);
            this.engine.requireOwnerControlCurrent(
              current,
              version,
              "Task changed; read next again before restarting",
            );
            if (!current.agentId || !current.profile)
              throw new RestartRefusal(
                "Worker restart requires the retained worker and route",
              );
            if (input.fresh) {
              if (!this.adapter.verifyResume)
                throw new RestartRefusal(
                  "Continuation worktree verification is unavailable",
                );
              await this.adapter.verifyResume(current);
            }
            let observed: AgentObservation;
            try {
              observed = await this.engine.onTaskHost(current, () =>
                this.engine.host.observe(current.agentId!),
              );
            } catch (error) {
              throw new RestartRefusal(
                `The retained worker cannot be observed (${hostFailureRefusalDetail(error)}); restore observation before restarting. No continuation was sent`,
              );
            }
            // Run rows and effect records can change without a task-version bump.
            // Recheck them after all awaits, before any settlement or authorization.
            const latest = this.store.task(task.id);
            this.engine.requireOwnerControlCurrent(
              latest,
              version,
              "Task changed during restart verification; read next again before restarting",
            );
            if (!runsUnchangedSince(runsBefore, this.store.runs(task.id)))
              throw new RestartRefusal(
                "A run changed during restart verification; read next again before restarting",
              );
            const refusal = workerRestartRefusal(
              collectOwnerVerbFacts(this.store, latest),
              shape,
              observed,
            );
            if (refusal) throw new RestartRefusal(refusal);
            const pending = recoveryEffects(this.store, latest).filter(
              (effect) =>
                finished.settleable.some((run) => run.id === effect.runId) &&
                isBlockingRecoveryEffect(effect),
            );
            if (pending.length)
              throw new RestartRefusal(recoveryEffectsRefusal(pending)!);
            // Spec 050 atomic verbs: the fences settle with the continuation's
            // own writes. Stopped-revision recovery owns its transaction, so its
            // settlement commits alone before the delegated recovery.
            const settleFences = {
              detail: `restart ${role}: ${reason}`,
              runIds: finished.settleable.map((item) => item.id),
              displacedRunIds: displacement.runIds,
            };
            const settling = [
              ...settleFences.runIds,
              ...settleFences.displacedRunIds,
            ];
            const hasPr = taskHasPr(current);
            // An ordinary owner restart resumes the retained worker. It supersedes
            // a queued non-delivery replacement in the same transaction, so a
            // later dispatch cannot route away from that retained thread.
            const supersedingReplacement =
              !input.fresh && current.resolution.nonDeliveryRoutePending;
            const resumeTask = supersedingReplacement
              ? this.resolution.update(
                  current,
                  {
                    nonDeliveryRoutePending: false,
                    pendingRevisionCause: null,
                  },
                  {},
                  "non_delivery_replacement_superseded",
                  `Owner restart ${role}: ${reason}`,
                )
              : current;
            const resumeChoice = restartResumeChoice(current, shape);
            if (resumeChoice === "worker")
              this.resolution.prepareResumeWorker(
                resumeTask,
                instruction,
                true,
                settling,
              );
            else if (resumeChoice === "revision")
              this.resolution.admitStoppedRevision(
                resumeTask,
                instruction,
                !hasPr,
                settling,
              );
            else
              this.resolution.prepareRetry(
                resumeTask,
                resumeChoice !== "review",
                resumeChoice === "review" ? undefined : instruction,
                true,
                false,
                !hasPr,
                undefined,
                undefined,
                settling,
              );
            return async () => {
              if (input.fresh)
                await this.adapter.verifyResume!(this.store.task(task.id));
              const afterCancel = await this.engine.onTaskHost(current, () =>
                this.engine.host.observe(current.agentId!),
              );
              this.engine.assertUnchangedBeforeCancel(
                task.id,
                version,
                runsBefore,
              );
              const afterRefusal = workerRestartRefusal(
                collectOwnerVerbFacts(this.store, this.store.task(task.id)),
                shape,
                afterCancel,
              );
              if (afterRefusal) throw new RestartRefusal(afterRefusal);
              const settle = () =>
                this.engine.settleVerbFences(task.id, settleFences);
              const continueWorker = () => {
                const hasPr = taskHasPr(current);
                // Spec 058 task 577: one worker thread. A fresh restart replaces
                // the retained worker only on provider failure, quota exhaustion,
                // a closed agent or an unrecoverable session, on an approved route
                // to a different model, or with an explicit operator-relayed
                // reason. Otherwise the refusal names its rule and the retained
                // worker continues on the same thread.
                const observedFailure = retainedWorkerFailureCause({
                  task: this.store.task(task.id),
                  observedStatus: afterCancel.status,
                  observedError: afterCancel.error,
                  observedActive:
                    afterCancel.active || Boolean(afterCancel.activeTurnId),
                  observedPermissions: afterCancel.permissions,
                  observedWorkspaceId: afterCancel.workspaceId,
                });
                // An errored retained thread gets one continuation attempt first;
                // error status alone must not arm replacement during restart.
                let effectiveFresh =
                  input.fresh === true &&
                  observedFailure?.kind !== "agent_errored";
                if (effectiveFresh) {
                  const latestTask = this.store.task(task.id);
                  const restartRoute =
                    currentRouteProfile(latestTask, "worker") ??
                    latestTask.profile!.id;
                  const routeGroup =
                    latestTask.profileGroup ??
                    this.store
                      .pool()
                      .find(
                        (entry) => entry.profileId === latestTask.profile?.id,
                      )?.group ??
                    null;
                  const routeAvailabilityRow = routeGroup
                    ? this.store.db
                        .prepare(
                          "SELECT data FROM availability WHERE group_id=?",
                        )
                        .get(routeGroup)
                    : null;
                  const routeAvailability = routeAvailabilityRow
                    ? JSON.parse(
                        String((routeAvailabilityRow as { data: string }).data),
                      )
                    : null;
                  const restartCatalogs = this.engine.workerHostCatalogs(latestTask);
                  const restartHostSelection = resolveWorkerHostForProfile(
                    latestTask,
                    restartCatalogs,
                    restartRoute,
                    latestTask.profile?.thinkingOptionId ?? "",
                    this.engine.preferredHostKindsForTask(latestTask),
                    true,
                  );
                  const decision = decideWorkerReplacement({
                    task: latestTask,
                    requestedProfileId: restartRoute,
                    requestedModel:
                      this.engine
                        .workerRoutingProfiles(latestTask)
                        .find((candidate) => candidate.id === restartRoute)
                        ?.model ??
                      latestTask.profile?.model ??
                      null,
                    currentModel: latestTask.profile?.model ?? null,
                    approved: isWorkerRouteApproved(
                      latestTask,
                      restartRoute,
                      this.store.pool(),
                      this.store.usageLevel(),
                    ),
                    hostChanges: Boolean(
                      restartHostSelection &&
                        restartHostSelection.hostId !== latestTask.hostId,
                    ),
                    failure: retainedWorkerFailureCause({
                      task: latestTask,
                      observedStatus: afterCancel.status,
                      observedError: afterCancel.error,
                      observedActive:
                        afterCancel.active || Boolean(afterCancel.activeTurnId),
                      observedPermissions: afterCancel.permissions,
                      observedWorkspaceId: afterCancel.workspaceId,
                      groupUnavailable:
                        routeAvailability &&
                        groupIsUnavailable(routeAvailability)
                          ? {
                              group: routeGroup!,
                              reason: String(routeAvailability.reason ?? ""),
                            }
                          : null,
                    }),
                    explicitOperatorRelay:
                      input.caller === OPERATOR_BOARD_CALLER ||
                      (input.relayed === true && Boolean(input.note?.trim())),
                    freshRestart: true,
                  });
                  if (!decision.allowed) {
                    effectiveFresh = false;
                    this.store.event(
                      task.id,
                      "worker_replacement_refused",
                      `${decision.rule}: ${decision.detail}`,
                    );
                  }
                }
                // A pre-PR continuation parked behind a released prerequisite wait
                // re-arms through the worker resume, which keeps its blocked evidence.
                const continued =
                  resumeChoice === "worker"
                    ? this.resolution.resumeWorker(current, instruction, true)
                    : resumeChoice === "revision"
                      ? this.resolution.restartStoppedRevision(
                          current,
                          instruction,
                          !hasPr,
                          settleFences,
                        )
                      : (this.engine.resumeReleasedPrerequisiteWait(current.id),
                        resumeChoice === "review"
                          ? this.resolution.retry(
                              this.store.task(current.id),
                              false,
                              undefined,
                              true,
                            )
                          : this.resolution.retry(
                              this.store.task(current.id),
                              true,
                              instruction,
                              true,
                              false,
                              !hasPr,
                            ));
                const callerRelay =
                  input.caller === OPERATOR_BOARD_CALLER ||
                  (input.relayed === true && Boolean(input.note?.trim()));
                return this.store.update(
                  continued.id,
                  {
                    // Replacement uses the existing durable failover machinery, but
                    // pins the worker route (an owner's required request wins over
                    // the profile that last ran) rather than choosing a higher profile.
                    failoverReason: effectiveFresh
                      ? `${OPERATOR_WORKER_REMAP_REASON}. Continue the existing task: ${instruction}`.slice(
                          0,
                          2000,
                        )
                      : "",
                    replacementProfile: effectiveFresh
                      ? observedFailure?.kind === "agent_errored"
                        ? null
                        : {
                            profileId:
                              currentRouteProfile(current, "worker") ??
                              current.profile!.id,
                            reason,
                            // Spec 058 task 577: the explicit operator relay travels with
                            // the arm so the sweep can retire on it.
                            ...(callerRelay
                              ? { operatorRelayed: true as const }
                              : {}),
                          }
                      : null,
                    // An owner's instruction is the continuation; without one, the
                    // continuation keeps what it resumed (a pending or one-shot scoped
                    // instruction), never the generic default over it.
                    resolution: {
                      ...continued.resolution,
                      pendingWorkerInstruction: input.instruction?.trim()
                        ? instruction
                        : (continued.resolution.pendingWorkerInstruction ??
                          null),
                    },
                  },
                  "restart_worker_requested",
                );
              };
              if (shape === "stopped_revision") {
                // Stopped-revision recovery owns its transaction and settles inside
                // it; calling it here would nest a transaction. The slot hold is
                // written in that same transaction (restartStoppedRevision).
                return continueWorker();
              }
              return this.store.transaction(() => {
                const restartSlot = this.workerRestartSlot(task, runsBefore);
                settle();
                const continued = continueWorker();
                return restartSlot && !continued.resolution.restartSlotHold
                  ? this.resolution.update(
                      continued,
                      { restartSlotHold: restartSlot },
                      {},
                      "restart_worker_slot_hold",
                    )
                  : continued;
              });
            };
          },
          finished.settleable.map((run) => run.id),
        ),
      `task:${task.id}`,
    );
  }

  /** Capture the current ownership before settling the old run. */
  private workerRestartSlot(
    before: Task,
    runs: Run[],
  ): Task["resolution"]["restartSlotHold"] {
    if (!occupiesSlot(before, runs)) return null;
    const from =
      runs.find(runHoldsSlot)?.id ??
      before.resolution.currentRunId ??
      before.runId;
    return from ? { role: "worker", at: now(), fromRunId: from } : null;
  }
}
