import type { TaskControlInput, TaskControlRequest } from "../../shared/contracts";
import type { TaskControlTask } from "../../shared/contracts";
import { controlHasExternalEffect } from "./control-decisions";
import { stopControlNeedsHost } from "./owner-stop";
import { hostIndependentControlRefusal } from "../host/host-independent-refusals";
import { operationInputHash } from "../store/store";
import type { Engine } from '../engine';

export type TaskControlLifecycleContext = Pick<Engine, 'store' | 'resolveTaskControl' | 'hostAvailable' | 'withHost' | 'taskControlDispatcher' | 'resolution' | 'forceCallerAuthorized' | 'selfForceRole'>;

export class TaskControlLifecycle {
  constructor(readonly context: TaskControlLifecycleContext) {}
  resolveTaskControl(input: TaskControlRequest): TaskControlInput {
    const task = this.context.store.task(this.context.store.resolveTaskId(input.taskId));
    if (input.phase !== undefined && input.phase !== task.phase)
      throw Error(`Task changed: phase expected ${input.phase}, now ${task.phase}; read next again`);
    return { ...input, taskId: task.id, version: input.version ?? task.version,
      ...(input.dependsOn ? { dependsOn: input.dependsOn.map(id => this.context.store.resolveTaskId(id)) } : {}),
      ...(input.waitsFor ? { waitsFor: input.waitsFor.map(id => this.context.store.resolveTaskId(id)) } : {}),
      ...(input.replacementTaskId ? { replacementTaskId: this.context.store.resolveTaskId(input.replacementTaskId) } : {}) };
  }

  async performTaskControl(request: TaskControlRequest, operationId?: string): Promise<TaskControlTask> {
    const input = this.context.resolveTaskControl(request);
    if (
      operationId &&
      input.action === "move" &&
      input.to === "closeout" &&
      input.qualification
    ) {
      // Only the operation serving this request can exempt itself from the
      // never-dispatched review-entry check.
      const operation = this.context.store.operation(operationId);
      const inputHash = operationInputHash({ type: "task_control", control: request });
      if (operation?.inputHash !== inputHash) operationId = undefined;
    }
    const hostId = this.context.store.task(input.taskId).hostId;
    if (controlHasExternalEffect(input)) {
      const task = this.context.store.task(input.taskId);
      const needsHost =
        input.action !== "stop" ||
        stopControlNeedsHost(task, this.context.store.runs(task.id), input);
      if (needsHost) {
        const waiting = hostId ? !this.context.withHost(hostId, () => this.context.hostAvailable(hostId)) : true;
        // #927: a control refuses on stored facts before it waits for an offline
        // host, and only a control that would otherwise be accepted enters the
        // wait. A reachable host changes nothing: its verb answers first.
        if (waiting) {
          const refusal = await hostIndependentControlRefusal(this.context, input, operationId);
          if (refusal) return Promise.reject(new Error(refusal));
        }
        if (!hostId) return Promise.reject(new Error('Task is waiting for a proven host identity'));
        if (waiting)
          return Promise.reject(new Error(`Transport not connected: waiting for host ${hostId}`));
      }
    }
    return hostId ? this.context.withHost(hostId, () => this.context.taskControlDispatcher.performTaskControl(input, operationId))
      : this.context.taskControlDispatcher.performTaskControl(input, operationId);
  }
}
