import type { Task } from "../../shared/contracts";

/**
 * The immutable source a task checkout must represent when it is provisioned.
 * Every path that creates, reuses, resyncs or re-provisions a task's checkout
 * resolves its target here, and nowhere else: a proof-only task detaches at its
 * recorded proof commit even when the planning base has advanced past it.
 */
export function taskCheckoutTarget(task: Pick<Task, "proofOnly" | "planningBase" | "planningCommit">): string {
  return task.proofOnly?.commit ?? task.planningBase ?? task.planningCommit;
}
