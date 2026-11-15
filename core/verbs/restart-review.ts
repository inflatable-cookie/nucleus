import type { Task } from "../../shared/contracts";
import type { Engine } from "../engine";
import { RestartRefusal, plainHandoverFreshRestart } from "./owner-verbs";
import type { RestartRequest } from "./owner-shared";

/**
 * The reviewer half of `restart`: continue the retained reader from its latest
 * checkpoint, or relaunch a stopped reader. Both keep the same admission path and
 * the exact head they are bound to; a plain handover with no checkpoint is only
 * relaunched by an explicit fresh request.
 */
export class ReviewRestarts {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }

  async restartReviewer(c: RestartRequest): Promise<Task> {
    const { task, input, role, reason, operationId, instruction } = c;
    const version = task.version;
    if (c.shape === 'checkpoint_reviewer') {
      const run = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
      const checkpoint = run?.reviewCheckpoints?.at(-1);
      if (!run || run.role !== "reviewer" || !checkpoint) throw Error("The reviewer checkpoint is no longer current");
      if (input.fresh) return this.engine.restartReview(task.id, reason, instruction);
      return this.engine.continueRetainedReviewer(task, { version, reason, instruction,
        ownerStopYields: this.engine.isOwnerCall() || Boolean(this.engine.replayingDeferredVerb.getStore() && this.engine.deferredRestartSupersedesOwnerStop(task)),
        deferrable: input, verb: "restart" }, operationId);
    }
    if (c.shape === 'stopped_reviewer') {
      if (!input.fresh) {
        const refusal = plainHandoverFreshRestart(task, this.store.runs(task.id));
        if (refusal) throw new RestartRefusal(refusal);
      }
      return this.engine.restartReview(task.id, reason, instruction, input.fresh);
    }
    throw Error(`restart does not support the ${role} reviewer state`);
  }
}
