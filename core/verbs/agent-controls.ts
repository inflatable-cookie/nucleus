import {
  taskWaitStateContext,
  taskWithCurrentWait,
} from "../recovery/wait-context";
import type {
  BulkDisposition,
  BulkDispositionRequest,
  TaskControlRequest,
  Task,
} from "../../shared/contracts";
import { taskControlInputSchema } from "../../shared/contracts";
import {
  requestDisposition,
  withdrawCancellation,
  type DispositionRequest,
} from "./disposition";
import type { Engine } from "../engine";
import { actingRunFor } from "../dispatch/acting-run";
import { collectOwnerVerbFacts, ownerTaskNext } from "./owner-verbs";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { operationInputHash } from "../store/store";

/**
 * The controls a task's own run reaches over its authenticated callback. Only
 * `server/callback.ts` calls in, through the same-name `Engine` delegates.
 */
export class AgentControls {
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }
  disposeTaskFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: DispositionRequest,
  ): Promise<Task> {
    return this.engine.control(() => {
      this.engine.authenticateAgentControl(
        caller.taskId,
        caller.runId,
        caller.token,
      );
      if (caller.taskId === input.taskId)
        throw Error(
          "A worker, reviewer or recovery callback cannot dispose its own task",
        );
      return requestDisposition(this.store, this.engine.dispositionDeps(), {
        ...input,
        requestedBy: `Queue run ${caller.runId}`,
      });
    }, `task:${input.taskId}`);
  }
  async withdrawCancellationFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: { taskId: string; version: number; reason: string },
  ): Promise<Task> {
    const withdrawn = await this.engine.control(() => {
      this.engine.authenticateAgentControl(
        caller.taskId,
        caller.runId,
        caller.token,
      );
      if (caller.taskId === input.taskId)
        throw Error(
          "A worker, reviewer or recovery callback cannot withdraw its own task cancellation",
        );
      return withdrawCancellation(
        this.store,
        input.taskId,
        input.version,
        input.reason,
        `Queue run ${caller.runId}`,
      );
    }, `task:${input.taskId}`);
    await this.engine.continueWithdrawnWorker(withdrawn);
    return withdrawn;
  }
  bulkDispositionDetailFromAgent(
    caller: { taskId: string; runId: string; token: string },
    operationId: string,
  ): BulkDisposition {
    this.engine.authenticateAgentControl(
      caller.taskId,
      caller.runId,
      caller.token,
    );
    return this.engine.bulkDispositionDetail(operationId);
  }
  startBulkDispositionFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: BulkDispositionRequest,
  ): Promise<BulkDisposition> {
    this.engine.authenticateAgentControl(
      caller.taskId,
      caller.runId,
      caller.token,
    );
    if (input.tasks.some((task) => task.taskId === caller.taskId))
      throw new Error(
        "A worker, reviewer or recovery callback cannot bulk-dispose its own task",
      );
    return this.engine.startBulkDisposition(input, `Queue run ${caller.runId}`);
  }
  retryBulkDispositionFromAgent(
    caller: { taskId: string; runId: string; token: string },
    operationId: string,
  ): Promise<BulkDisposition> {
    this.engine.authenticateAgentControl(
      caller.taskId,
      caller.runId,
      caller.token,
    );
    const batch = this.engine.bulkDispositionDetail(operationId);
    if (batch.items.some((item) => item.taskId === caller.taskId))
      throw new Error(
        "A worker, reviewer or recovery callback cannot bulk-dispose its own task",
      );
    return this.engine.retryBulkDisposition(operationId);
  }
  async taskControlFromAgent(
    caller: { taskId: string; runId: string; token: string },
    request: TaskControlRequest,
  ) {
    this.store.authenticate(caller.runId, caller.token);
    const input = this.engine.resolveTaskControl(request);
    if (
      input.taskId !== caller.taskId ||
      !input.force ||
      input.action !== "move"
    )
      throw new DurableFenceRefusal(
        "Authenticated self-force applies only to move on your own task",
      );
    // Self-force reads this run's credential from its ticket: a retained thread's
    // stale ticket acts for the thread's current run (nucleus#1376).
    const acting = actingRunFor(
      this.store,
      this.store.task(caller.taskId),
      caller.runId,
    );
    const actingRunId = acting?.id ?? caller.runId;
    return this.engine.selfForceRunId.run(actingRunId, async () => {
      if (!this.engine.selfForceRole(this.store.task(caller.taskId)))
        throw new DurableFenceRefusal(
          "Stale assignment or critical task cannot self-force",
        );
      const control = taskControlInputSchema.parse({
        ...input,
        caller: `run:${actingRunId}`,
        relayed: false,
        delegated: false,
      });
      const payload = {
        type: "task_control",
        control,
        authenticatedForceRunId: actingRunId,
      };
      this.store.setMeta(
        `selfForceGrant:${operationInputHash(payload)}`,
        actingRunId,
      );
      return this.engine.startOperation({
        key: `self-force:${actingRunId}:${operationInputHash(payload)}`,
        kind: "task_control",
        payload,
        taskId: caller.taskId,
        expectedVersion: input.version,
      });
    });
  }
  authenticateAgentControl(taskId: string, runId: string, token: string) {
    this.store.authenticate(runId, token);
    const task = this.store.task(taskId),
      presented = this.store.run(runId);
    if (presented ? presented.taskId !== task.id : task.runId !== runId)
      throw Error("Stale report: task and run identity do not match");
    // A retained thread's shell may still export an earlier run's ticket; this
    // thread's current run acts for it, so the caller's own work is never
    // refused for a stale environment value (nucleus#1376).
    const run = actingRunFor(this.store, task, runId);
    const current = run
      ? (run.role === "recovery"
          ? task.resolution.recovery?.runId
          : task.resolution.currentRunId) === run.id &&
        !run.released &&
        !run.completion
      : task.runId === runId &&
        !task.completion &&
        ["working", "dispatching", "needs_attention"].includes(task.phase);
    if (!current || (run && run.taskId !== task.id))
      throw Error("Stale Nucleus assignment cannot use Nucleus controls");
    return { task, run };
  }
  dependencyDetail(
    caller: { taskId: string; runId: string; token: string },
    targetTaskId: string,
  ) {
    this.engine.authenticateAgentControl(
      caller.taskId,
      caller.runId,
      caller.token,
    );
    const task = this.store.task(targetTaskId);
    return {
      taskId: task.id,
      title: task.title,
      version: task.version,
      phase: task.phase,
      held: task.held,
      dependsOn: task.dependsOn,
      dependencies: task.dependsOn.map((id) => this.store.taskReference(id)),
    };
  }
  authenticatedDispositionDetail(
    caller: { taskId: string; runId: string; token: string },
    taskId: string,
  ) {
    this.engine.authenticateAgentControl(
      caller.taskId,
      caller.runId,
      caller.token,
    );
    return this.engine.dispositionDetail(taskId);
  }
  /**
   * The task-scoped plan `next` derives, read by the recovery coordinator that
   * holds this task's current run credential. It reads its own task only, so
   * the same plan reaches the coordinator's refresh as the owner's `next`.
   */
  recoveryTaskNextFromAgent(caller: {
    taskId: string;
    runId: string;
    token: string;
  }) {
    const { task, run } = this.engine.authenticateAgentControl(
      caller.taskId,
      caller.runId,
      caller.token,
    );
    if (run?.role !== "recovery")
      throw Error(
        "Only the recovery coordinator reads the task plan with its run credential",
      );
    const runId = run.id;
    const wait = taskWaitStateContext(this.store, task, null, (candidate) =>
      this.engine.resolution.slotAdmissionReason(
        candidate,
        candidate.phase === "needs_attention",
      ),
    );
    return ownerTaskNext({
      ...collectOwnerVerbFacts(this.store, task, null, runId),
      creationGraceMs: this.engine.resolution.graceMs,
      activityWaitContext: { ...wait, decisionId: this.store.listDecisions({ status: "open", task: task.id })[0]?.id ?? null },
      waitTask: taskWithCurrentWait(this.store, task, wait, (candidate) =>
        this.engine.queuedExternalWait(candidate),
      ),
      hostProfiles: this.engine.workerRoutingProfiles(task),
      hostViews: this.engine.routingHostViews(task),
    });
  }
  updateDependenciesFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: { taskId: string; version: number; dependsOn: string[] },
  ) {
    return this.store.transaction(() => {
      this.engine.authenticateAgentControl(
        caller.taskId,
        caller.runId,
        caller.token,
      );
      const task = this.store.task(input.taskId);
      this.engine.rejectFenced(task, "dependency changes");
      if (task.version !== input.version)
        throw Error("Task changed; inspect dependencies before retrying");
      const updated = this.store.updateDependencies(
        task,
        input.dependsOn,
        `Queue run ${caller.runId}`,
      );
      return {
        taskId: updated.id,
        version: updated.version,
        phase: updated.phase,
        dependsOn: updated.dependsOn,
        reason: updated.reason,
      };
    });
  }
  projectQueueDetail(
    caller: { taskId: string; runId: string; token: string },
    targetTaskId: string,
  ) {
    this.engine.authenticateAgentControl(
      caller.taskId,
      caller.runId,
      caller.token,
    );
    const target = this.store.task(targetTaskId);
    const tasks = this.store
      .tasks()
      .filter(
        (task) => task.repoPath === target.repoPath && task.phase === "queued",
      )
      .sort(
        (a, b) =>
          b.queuePriority - a.queuePriority ||
          Date.parse(a.createdAt) - Date.parse(b.createdAt),
      );
    return {
      repoPath: target.repoPath,
      tasks: tasks.map((task, index) => ({
        taskId: task.id,
        title: task.title,
        version: task.version,
        position: index + 1,
        held: task.held,
        queuePriority: task.queuePriority,
      })),
    };
  }
  promoteTaskFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: { taskId: string; version: number },
  ) {
    return this.store.transaction(() => {
      this.engine.authenticateAgentControl(
        caller.taskId,
        caller.runId,
        caller.token,
      );
      const task = this.store.task(input.taskId);
      this.engine.rejectFenced(task, "promotion");
      if (task.version !== input.version)
        throw Error("Task changed; inspect the project queue before retrying");
      const updated = this.store.promoteQueuedTask(
        task,
        `Queue run ${caller.runId}`,
      );
      return {
        taskId: updated.id,
        version: updated.version,
        phase: updated.phase,
        queuePriority: updated.queuePriority,
      };
    });
  }
}
