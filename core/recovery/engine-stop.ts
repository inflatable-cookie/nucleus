import type { Task } from "../../shared/contracts";
import { taskStopClassification, taskStopVerbsFor, type TaskStopReason } from "../../shared/task-stop";
import { isRepositoryContention, repositoryContentionNeedsAttention } from '../scheduling/repository-contention';
import type { Engine } from '../engine';

export type EngineStopContext = Pick<Engine, 'resolution' | 'store'>;

export class EngineStop {
  constructor(readonly context: EngineStopContext) {}
  note(id: string, reason: string, stop: TaskStopReason | "classify", phase?: Task["phase"]) {
    const task = this.context.store.task(id);
    if (phase === "needs_attention" && isRepositoryContention(reason) && !repositoryContentionNeedsAttention(this.context.store, task, reason)) { phase = undefined; stop = "lifecycle"; }
    if (reason === "Worker running" && !phase) {
      this.context.resolution.waiting(task, reason, "lifecycle");
      return;
    }
    const classification = stop === "classify" ? taskStopClassification(reason) : { reason: stop, suggestedVerbs: taskStopVerbsFor(stop) };
    this.context.resolution.recordStop(task, classification.reason, reason, classification.suggestedVerbs, phase);
  }
}
