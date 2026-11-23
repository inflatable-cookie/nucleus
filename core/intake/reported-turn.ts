import type { Run, Task } from "../../shared/contracts";
import type { Resolution } from "../resolution";

/**
 * Spec 068 §3 (bovine-accelerator#6863, 2026-11-23): a reviewer that reported an
 * authenticated verdict at the exact head has finished its review, even while
 * its thread still shows the end of its turn. Applying the verdict proves the
 * review checkout is free, so a turn left running after the report used to park
 * the task in attention with every owner action refused and nothing retrying.
 *
 * The verdict gets an owner instead. Inside the grace after the report the task
 * waits, named. Past it, Nucleus stops that leftover turn once (the report is
 * already authenticated, so nothing the verdict needs is lost) and the next pass
 * applies the verdict through the ordinary result path. A turn that still will
 * not settle after that stop records a typed stop naming its explicit command.
 */

export type ReportedTurnContext = Pick<
  Resolution,
  "graceMs" | "host" | "onTaskHost" | "store" | "waiting"
>;

export const REPORTED_TURN_STOPPED = "reported_turn_stopped";

export async function settleReportedReviewerTurn(
  ctx: ReportedTurnContext,
  task: Task,
  run: Run,
): Promise<"settled" | "waiting"> {
  if (run.role !== "reviewer" || !run.agentId || !run.completion)
    return "settled";
  const agentId = run.agentId;
  let state;
  try {
    state = await ctx.onTaskHost(run, () => ctx.host.observe(agentId));
  } catch {
    // A thread that is gone holds no turn; any other failed read is left to the
    // ordinary application step, which owns its own refusal.
    return "settled";
  }
  if (!state.active && !state.activeTurnId && !state.permissions)
    return "settled";
  const store = ctx.store;
  const reportedAt = Date.parse(run.completionReceivedAt ?? run.createdAt);
  const stopAt = new Date(reportedAt + ctx.graceMs).toISOString();
  const verdict = `Reviewer run ${run.id} reported ${run.completion.status} at ${(run.completion.head ?? run.head).slice(0, 12)}`;
  const stopped = store
    .eventsAll(task.id)
    .some((event) => event.kind === REPORTED_TURN_STOPPED && event.detail === run.id);
  const wait = (reason: string, stop: "lifecycle" | "operator_needed") => {
    const current = store.task(task.id);
    if (current.reason !== reason)
      ctx.waiting(current, reason, stop, {
        fact: { code: "thread_running", subject: run.id },
      });
    return "waiting" as const;
  };
  if (Date.now() < reportedAt + ctx.graceMs)
    return wait(
      `${verdict}; its thread is still ending its turn, and the verdict applies once it settles (Nucleus stops the leftover turn at ${stopAt})`,
      "lifecycle",
    );
  if (!stopped) {
    try {
      await ctx.onTaskHost(run, () => ctx.host.stopAgentTurn(agentId));
    } catch {
      // The stop is best effort; the next pass observes the thread again.
    }
    store.event(task.id, REPORTED_TURN_STOPPED, run.id);
    return wait(
      `${verdict}; Nucleus stopped the reviewer's leftover turn so the verdict can apply on the next pass`,
      "lifecycle",
    );
  }
  if (Date.now() < reportedAt + 3 * ctx.graceMs)
    return wait(
      `${verdict}; Nucleus stopped the reviewer's leftover turn and waits for its thread to settle`,
      "lifecycle",
    );
  return wait(
    `${verdict}, but its thread still shows a live turn after Nucleus stopped it. Stop the thread in its host, or use run.start reviewer fresh replacing=${run.id} accepting discard_reported_verdict`,
    "operator_needed",
  );
}
