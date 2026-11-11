import type { Disposition, WorkDisposition } from "./contracts";

/**
 * The proof policy a disposition applies now: the policy its original request
 * named, or the latest attributed owner transition. Losing a replacement never
 * changes what the supersession was, only which safe proof this step may run.
 */
export function dispositionWorkPolicy(disposition: Pick<Disposition, "workDisposition" | "proofPolicies">): WorkDisposition {
  return disposition.proofPolicies.at(-1)?.policy ?? disposition.workDisposition;
}

/** True while a persisted disposition fence blocks ordinary advancement, recovery and relaunch. */
export function isDispositionActive(task: { disposition?: Disposition | null }): boolean {
  return Boolean(task.disposition && task.disposition.status !== "complete");
}

/** True once disposition has terminally removed a task from ordinary projection work. */
export function isDispositionComplete(task: { disposition?: Disposition | null }): boolean {
  return task.disposition?.status === "complete";
}

/**
 * Why this task's recorded cancellation cannot be withdrawn, or null when the
 * owner's `withdraw_cancel` applies. This is the one rule `next` and the
 * applied control share, so the read view and the verb never disagree. Before
 * any effect lands only pending thread-stop requests exist, so intent and
 * draining withdraw as before. A disposition parked in needs_attention
 * withdraws too (nucleus#1000): its uncertain step held the fence, and the
 * effects that landed are reversible hygiene (thread stops, run releases,
 * thread archives) or acted only on the task's own PR, so a withdrawal leaves
 * no foreign side effect behind.
 */
export function cancellationWithdrawalRefusal(task: { phase: string; disposition?: Disposition | null }): string | null {
  const disposition = task.disposition;
  if (!disposition || disposition.kind !== "cancel")
    return "Only an active cancellation can be withdrawn";
  if (["done", "cancelled"].includes(task.phase))
    return "A terminal task cancellation cannot be withdrawn";
  if (disposition.status === "needs_attention") return null;
  if (!["intent", "draining"].includes(disposition.status))
    return `Only an active cancellation in intent or draining can be withdrawn; this cancellation is ${disposition.status}`;
  const effectsAreReversible = disposition.effects.every(effect =>
    effect.kind === "stop_thread" && effect.result === null && effect.resultAt === null && !effect.uncertain);
  if (!effectsAreReversible)
    return "Cancellation can no longer be withdrawn after a disposition effect has landed";
  return null;
}
