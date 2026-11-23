import type { Run, Task } from "../../shared/contracts";
import type { AgentObservation } from "../host/adapter";
import { isAgentGoneRefusal, ThreadUnobservedError } from "../host/errors";
import type { Store } from "../store/store";
import { active } from "./task-reasons";

export type CompletionObservation =
  | { kind: "observed"; state: AgentObservation }
  | { kind: "unobservable"; error?: unknown };

/** Older authenticated completions get a full grace window on their first sweep. */
export function timestampCompletion(store: Store, run: Run, at: string): Run {
  const completion = run.completion;
  if (
    !completion ||
    run.completionReceivedAt ||
    completion.taskId !== run.taskId ||
    completion.runId !== run.id ||
    !store.receiptHash(completion.eventId, run.taskId, run.id)
  )
    return run;
  return { ...run, completionReceivedAt: at };
}

/** A report can settle its own turn after the grace period, even when the host still shows it. */
export function completedTurnCanRelease(
  run: Pick<Task, "agentId" | "workspaceId" | "participantActivity" | "completion"> &
    Pick<Run, "completionReceivedAt">,
  observation: CompletionObservation,
  at: string,
  graceMs: number,
): boolean {
  if (!run.completion || !run.completionReceivedAt) return false;
  const reportedAt = Date.parse(run.completionReceivedAt);
  const afterGrace = Date.parse(at) - reportedAt >= graceMs;
  const savedStart = Date.parse(run.participantActivity?.turnStartedAt ?? "");
  if (observation.kind === "unobservable") {
    return (
      isAgentGoneRefusal(observation.error) ||
      observation.error instanceof ThreadUnobservedError ||
      (afterGrace && !(savedStart > reportedAt))
    );
  }
  const { state } = observation;
  if (state.id !== run.agentId || state.workspaceId !== run.workspaceId)
    return false;
  if (state.archived || ["archived", "gone"].includes(state.status)) return true;
  if (!active(state) && !state.activeTurnId)
    return ["idle", "error", "closed"].includes(state.status) || afterGrace;
  if (!afterGrace || Date.parse(state.lastUserMessageAt ?? "") > reportedAt)
    return false;
  const sameTurn = state.activeTurnId &&
    state.activeTurnId === run.participantActivity?.turnId;
  const turnStart = state.turnStartedAt
    ? Date.parse(state.turnStartedAt)
    : sameTurn ? savedStart : NaN;
  return turnStart <= reportedAt;
}
