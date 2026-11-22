import {
  FORCE_ACTION_REFUSAL,
  FORCE_CALLER_REFUSAL,
  FORCE_REASON_REFUSAL,
} from "./verb-refusal-text";
import { REMOVED_TASK_REFUSAL } from "./control-refusals";
import { taskNeverDispatched } from "../task-decision-rules";
import type {
  Task,
  TaskControlInput,
  TaskControlTask,
} from "../../shared/contracts";
import {
  currentReadyPrEvidence,
  deriveRestartRole,
  ownerControlEventDetail,
  reviewerSharesAuthorModel,
} from "./owner-verbs";
import { DurableFenceRefusal } from "../intake/run-settlement";
import {
  openProofOnlyGo,
  PROOF_GO_WAIT_REFUSAL,
  PROOF_GO_WAIT_VERBS,
} from "../qa/proof-only-go";
import type { Engine } from "../engine";
import { taskPrNumber } from "../forge/index";
import { taskControlChanges } from "../../shared/task-control-changes";
import { withdrawCancellation } from "./disposition";
import { applyBudgetExtension } from "./budget-extension";
import { applyControlWithVersionHint } from "./control-outcomes";
import { assertAuthorRevisionAllowance } from "./author-revision-cap";
import {
  assertDelegatedAuthority,
  assertOwnerAuthority,
} from "./owner-authority";
import { applyReceiptAcceptance } from "./receipt-acceptance";
import { recordNoAutomaticRetryRule } from "./no-automatic-retry-record";
import { sameCallerIdentity } from "../../shared/agent-identity";

/**
 * Every task control enters here: the audit lines, the force and cap gates, and
 * the ordered switch that hands each action to its own owner. The authority
 * proofs, the budget and receipt settlements, the durable retry rule and the
 * outcome record with its stale-version hint live in their own modules. Same-name
 * `Engine` methods delegate here, and sibling calls go back through them, so an
 * override still fires. `store` and `resolution` read the engine per call.
 */
export class TaskControlDispatcher {
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }
  get resolution() {
    return this.engine.resolution;
  }
  neverDispatched(task: Task): boolean {
    return taskNeverDispatched(task, this.store.runs(task.id));
  }
  /**
   * Every task control, local or external-effect, in one place. Local actions
   * are one short transaction; external-effect actions perform their remote
   * work here, inside the durable operation lane and after its intent persisted.
   */
  async performTaskControl(
    input: TaskControlInput,
    operationId?: string,
  ): Promise<TaskControlTask> {
    if (
      input.action === "accept_receipt" &&
      this.store.task(input.taskId).proofReceiptAcceptance
    ) {
      if (input.delegated)
        throw Error(
          "Receipt acceptance requires the operator, not a delegated answer",
        );
      assertOwnerAuthority(
        input.caller,
        input.relayed,
        input.note,
        "Receipt acceptance",
      );
      if (!input.reason?.trim())
        throw Error("Receipt acceptance requires a reason");
      return this.store.task(input.taskId);
    }
    this.refuseWhileProofGoOpen(input);
    if (input.caller === undefined) {
      const before = this.store.task(input.taskId);
      const result = await this.engine.appliedWithVersionHint(
        input,
        operationId,
      );
      this.engine.settleLadderControl(before, result, input.action);
      const after = this.recordNoAutomaticRetryRule(input, result);
      return { ...after, changes: taskControlChanges(before, after) };
    }
    // Spec 050: a control applied with a caller identity — through the owner
    // verb registry — records one owner_control event: verb, caller, whether
    // the caller is the task project's owner thread, reason, phase before and
    // after, and the derived identities. Record only: the audit line never
    // refuses the control, and a lost line never fails an applied control.
    const before = (() => {
      try {
        return this.store.task(input.taskId);
      } catch {
        return null;
      }
    })();
    const routeWaiver = Boolean(
      before &&
        input.action === "route" &&
        input.role === "reviewer" &&
        input.profileId &&
        (() => {
          const profile = this.engine.profiles.find(
            (candidate) => candidate.id === input.profileId,
          );
          return profile
            ? reviewerSharesAuthorModel(before, profile.model)
            : false;
        })(),
    );
    const result = await this.engine.appliedWithVersionHint(input, operationId);
    if (
      ["restart", "move", "route", "complete", "cancel", "supersede"].includes(
        input.action,
      )
    )
      this.engine.clearHostReadTransient(input.taskId, "task");
    if (before) {
      this.engine.settleLadderControl(before, result, input.action);
      // An applied owner instruction replaces open questions about the prior
      // task state. Their later answers remain auditable but cannot steer it.
      const marker = this.engine.replayingDeferredVerb.getStore()
        ? before.resolution.deferredVerb?.input.__workerAsk
        : null;
      const askId =
        marker &&
        typeof marker === "object" &&
        "askId" in marker &&
        typeof marker.askId === "string"
          ? marker.askId
          : undefined;
      this.resolution.supersedeOpenOwnerQuestions(
        input.taskId,
        `${input.action} applied at task version ${result.version}`,
        askId,
      );
    }
    try {
      this.store.event(
        input.taskId,
        "owner_control",
        ownerControlEventDetail(
          this.store.task(input.taskId),
          input,
          before?.phase ?? null,
          result.phase,
          routeWaiver,
        ),
      );
    } catch {
      /* the applied control stands even if its audit line could not be written */
    }
    const after = this.recordNoAutomaticRetryRule(input, result);
    return {
      ...after,
      changes: before ? taskControlChanges(before, after) : [],
    };
  }
  /**
   * effigy#697: the same GO fact that bounds `next` bounds the control itself. While
   * a proof-only release GO is open, a control that would start or re-drive a run
   * is refused whoever sends it, including a stale planner answer.
   */
  refuseWhileProofGoOpen(input: TaskControlInput): void {
    if (!PROOF_GO_WAIT_VERBS.has(input.action)) return;
    let task: Task;
    try {
      task = this.store.task(input.taskId);
    } catch {
      return;
    }
    if (
      openProofOnlyGo(
        task,
        this.store.runs(task.id),
        this.store.eventsAll(task.id),
      )
    )
      throw new DurableFenceRefusal(PROOF_GO_WAIT_REFUSAL);
  }
  /** Task 645: the owner's own control records whether automatic retry stays forbidden. */
  recordNoAutomaticRetryRule(input: TaskControlInput, result: Task): Task {
    return recordNoAutomaticRetryRule(this.engine, input, result);
  }
  /** Apply one control, record its outcome, and name the version to re-read when it is stale. */
  appliedWithVersionHint(
    input: TaskControlInput,
    operationId?: string,
  ): Promise<Task> {
    return applyControlWithVersionHint(this.engine, input, operationId);
  }

  async performTaskControlApplied(
    input: TaskControlInput,
    operationId?: string,
  ): Promise<Task> {
    const operated = <T>(result: T) => {
      this.store.event(input.taskId, "operator_control", input.action);
      return result;
    };
    const task = this.store.task(input.taskId);
    if (input.force) {
      if (input.action === "retry_effect")
        throw new DurableFenceRefusal("Use run.release or record.clear kind=effect for explicit settlement");
      if (!input.reason?.trim())
        throw new DurableFenceRefusal(FORCE_REASON_REFUSAL);
      if (
        input.action === "move" &&
        input.to === "closeout" &&
        task.resolution.mergedCommit
      ) {
        if (!await this.engine.forceCallerAuthorized(task, input.caller))
          throw new DurableFenceRefusal(FORCE_CALLER_REFUSAL);
        return this.engine.applyTaskControlMove(
          { ...input, force: false },
          operated,
          operationId,
        );
      }
      if (input.action === "move")
        return operated(await this.engine.forceMove(task, input, operationId));
      throw new DurableFenceRefusal(FORCE_ACTION_REFUSAL);
    }
    assertAuthorRevisionAllowance(this.engine, input, task);
    if (
      (input.action === "route" ||
        (input.action === "set_routing" && input.profileRequests !== undefined)) &&
      [task.agentId, task.resolution.reviewerAgentId].some((agentId) =>
        sameCallerIdentity(input.caller, agentId, undefined, task.hostId),
      )
    )
      throw new DurableFenceRefusal("The task's worker and reviewer cannot request a profile for this task");
    if (input.action === "complete")
      return await this.engine.applyTaskControlComplete(
        input,
        operated,
        operationId,
      );
    if (input.action === "cancel" || input.action === "supersede")
      return await this.engine.applyTaskControlDispose(input, operated);
    if (input.action === "withdraw_cancel")
      return await this.engine.applyTaskControlWithdrawCancellation(
        input,
        operated,
      );
    if (input.action === "route")
      return await this.engine.applyTaskControlRoute(
        input,
        operated,
        operationId,
      );
    if (input.action === "restart")
      return await this.applyTaskControlRestartHold(
        input,
        operated,
        operationId,
      );
    if (input.action === "stop")
      return operated(await this.engine.stopTask(input, operationId));
    if (input.action === "move" && input.to === "review" && input.prNumber) {
      const task = this.store.task(input.taskId);
      // A retained number is already the task's PR identity. An optional
      // number must agree with it, not select replacement adoption. On a task
      // with no bound PR, the number the current authenticated ready result
      // names is the move's own (Project-d #117); any other number still selects
      // replacement adoption.
      const evidenced =
        !task.prUrl &&
        currentReadyPrEvidence(task, this.store.runs(task.id))?.prNumber ===
          input.prNumber;
      if (
        !task.resumePrNumber &&
        (!task.prUrl || taskPrNumber(task) !== input.prNumber) &&
        !evidenced
      )
        return await this.engine.applyTaskControlReplacementPr(input, operated);
    }
    if (input.action === "move") {
      const moved = await this.engine.applyTaskControlMove(
        input,
        operated,
        operationId,
      );
      return this.engine.releaseOwnerStopHold(input.taskId)
        ? this.store.task(input.taskId)
        : moved;
    }
    if (input.action === "proof")
      return await this.engine.applyTaskControlProof(
        input,
        operated,
        operationId,
      );
    if (input.action === "accept_receipt")
      return operated(applyReceiptAcceptance(this.engine, input, operated));
    if (input.action === "extend_budget")
      return applyBudgetExtension(this.engine, input, operated);
    if (input.action === "retry_effect")
      return await this.engine.applyTaskControlRetryEffect(
        input,
        operated,
        operationId,
      );
    if (input.action === "amend_brief")
      return input.brief
        ? this.engine.applyTaskControlAmendBrief(input, operated)
        : await this.engine.applyTaskControlRepinInstruction(input, operated);
    if (input.action === "set_lane")
      return await this.engine.applyTaskControlSetLane(input, operated);
    if (input.action === "set_routing") {
      const planner = input.critical !== undefined && input.caller !== undefined &&
        input.caller !== "operator (board)" && await this.engine.forcePlannerMatches(task, input.caller);
      return this.engine.applyTaskControlSetRouting(input, operated, planner);
    }
    if (input.action === "exclude_worker")
      return this.engine.applyTaskControlExcludeWorker(input, operated);
    return this.engine.applyTaskControlLocal(input, operated);
  }
  /**
   * The owner's restart supersedes their own stop — except for a live proof
   * executor's re-report request, which is a reporting continuation and never
   * the owner's next continuation (nucleus#1195).
   */
  private async applyTaskControlRestartHold(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    const restarted = await this.engine.applyTaskControlRestart(
      input,
      operated,
      operationId,
    );
    const role =
      input.role ?? deriveRestartRole(restarted, this.store.runs(restarted.id));
    if (role === "executor") return restarted;
    const preserveStoppedWorker =
      role === "worker" &&
      this.engine.ownerStopHold(restarted) &&
      this.engine.ownerStopNamesRun(restarted, restarted.runId);
    if (restarted.resolution.deferredVerb || preserveStoppedWorker)
      return restarted;
    const deferredYield = Boolean(
      this.engine.replayingDeferredVerb.getStore() &&
        this.engine.deferredRestartSupersedesOwnerStop(restarted),
    );
    return this.engine.releaseOwnerStopHold(input.taskId, deferredYield)
      ? this.store.task(input.taskId)
      : restarted;
  }
  async applyTaskControlComplete(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    const result = await this.engine.completeTask(input, operationId);
    return result.idempotent ? result.task : operated(result.task);
  }
  async applyTaskControlDispose(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Promise<Task> {
    return operated(
      await this.engine.disposeTask({
        taskId: input.taskId,
        version: input.version,
        action: input.action as "cancel" | "supersede",
        reason: input.reason,
        replacementTaskId: input.replacementTaskId,
        workDisposition: input.workDisposition,
      }),
    );
  }
  async applyTaskControlWithdrawCancellation(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Promise<Task> {
    const withdrawn = await this.engine.control(
      () =>
        withdrawCancellation(
          this.store,
          input.taskId,
          input.version,
          input.reason!,
          "operator control",
        ),
      `task:${input.taskId}`,
    );
    await this.engine.continueWithdrawnWorker(withdrawn);
    void this.engine.cleanContext(() => this.engine.wakeTask(withdrawn.id));
    void this.engine.cleanContext(() =>
      this.engine.wakeRepository(withdrawn.repoPath),
    );
    return operated(withdrawn);
  }
  async applyTaskControlRoute(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    const result = await this.engine.routeTask(input, operationId);
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() =>
      this.engine.wakeRepository(result.repoPath),
    );
    return operated(result);
  }
  async applyTaskControlRestart(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    const result = await this.engine.restartTask(input, operationId);
    const role =
      input.role ?? deriveRestartRole(result, this.store.runs(result.id));
    // A re-report request to the live proof executor starts no run, so it wakes no dispatch.
    if (
      role !== "executor" &&
      !result.resolution.deferredVerb &&
      !(
        role === "worker" &&
        this.engine.ownerStopHold(result) &&
        this.engine.ownerStopNamesRun(result, result.runId)
      )
    ) {
      void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
      void this.engine.cleanContext(() =>
        this.engine.wakeRepository(result.repoPath),
      );
    }
    return operated(result);
  }
  async applyTaskControlReplacementPr(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Promise<Task> {
    // The replacement-PR binding: strict canonical branch, base and head
    // reconciliation in resolution.adoptReplacementPr, then ordinary review.
    const task = this.store.task(input.taskId);
    if (task.removedAt) throw new Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(
      task,
      input.version,
      "Task changed; refresh before retrying",
    );
    const result = await this.resolution.adoptReplacementPr(
      task,
      input.prNumber!,
    );
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() =>
      this.engine.wakeRepository(result.repoPath),
    );
    return operated(result);
  }
  async applyTaskControlRetryEffect(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    const result = await this.engine.retryEffect(input, operationId);
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() =>
      this.engine.wakeRepository(result.repoPath),
    );
    return operated(result);
  }
  async applyTaskControlRepinInstruction(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Promise<Task> {
    const result = await this.engine.repinInstruction({
      taskId: input.taskId,
      version: input.version,
    });
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() =>
      this.engine.wakeRepository(result.repoPath),
    );
    return operated(result);
  }
  applyTaskControlAmendBrief(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Task {
    const result = this.engine.amendBrief({
      taskId: input.taskId,
      version: input.version,
      brief: input.brief ?? "",
      reason: input.reason ?? "",
      overtakes: input.overtakes,
    });
    return operated(result);
  }
  /** Spec 058 (task 540): a delegated answer carries the answering agent and its recorded note. */
  assertDelegatedAuthority(
    caller: string | undefined,
    relayNote: string | undefined,
    purpose: string,
  ): { role: "delegated"; kind: "delegated"; note: string } {
    return assertDelegatedAuthority(caller, relayNote, purpose);
  }
  /** The authority a qualified owner acceptance needs, proved before anything is written. */
  assertOwnerAuthority(
    caller: string | undefined,
    relayed: boolean | undefined,
    relayNote: string | undefined,
    purpose = "Qualified owner acceptance",
  ): {
    role: "operator" | "authorized_relay";
    kind: "operator" | "relayed_note";
    note: string | null;
  } {
    return assertOwnerAuthority(caller, relayed, relayNote, purpose);
  }
}
