import { digest, } from '../store/store';
import type { Task } from '../../shared/contracts';
import { taskControlInputSchema } from '../../shared/contracts';
import { reviewContinuationState } from '../review/review-continuation';
import { restartShape } from '../verbs/owner-verbs';
import type { RecoverySettlementContext } from './coordinator-settlement';

/**
 * Spec 058 slice 2: a responsible task's mechanical faults are settled by code
 * where it can, before a coordinator episode opens. A reviewer that stopped
 * without a verdict is replaced by the ordinary fresh-reviewer path on the same
 * task and exact head; one mechanical restart per stopped head. A repeat at that
 * head is a fault code cannot settle, so recovery keeps it and opens the one
 * retained recovery thread. A reviewer whose saved checkpoint Queue can still
 * continue itself is left to that continuation: a checkpoint is not a crash.
 */
export async function settleResponsibleFault(engine: RecoverySettlementContext, task: Task): Promise<boolean> {
  const current = engine.store.task(task.id);
  if (current.removedAt) return false;
  if (!["reviewing", "awaiting_review", "needs_attention", "blocked", "error"].includes(current.phase)) return false;
  const shape = restartShape(current, engine.store.runs(current.id), "reviewer", engine.store.eventsAll(current.id));
  if (shape !== "stopped_reviewer" && shape !== "checkpoint_reviewer") return false;
  // Queue continues an awaiting or delivered checkpoint itself; only a closed
  // agent (or a reviewer with no checkpoint) leaves an impossible continuation.
  const continuation = reviewContinuationState(current, engine.store);
  if (continuation !== null && continuation !== "closed") return false;
  const run = current.resolution.currentRunId ? engine.store.run(current.resolution.currentRunId) : null;
  if (!run || run.role !== "reviewer" || run.completion || run.released || run.active === true) return false;
  // A paused-stop marker owns the thread until its unpause resume settles: a
  // deliberate operator stop is not a crash, and the closed-session check
  // below must not race the resume (Queue #650).
  if (run.pausedStop) return false;
  // Only a positively stopped reviewer is a crash. An idle reviewer waiting on
  // its own operator question or permission is a wait, not a fault, so the
  // recorded stop or incident must name the reviewer stopping without a result.
  const incident = current.resolution.incident;
  const stoppedWithoutResult = Boolean(run.retainedAgentClosedAt)
    || /^The reviewer (?:thread stopped|callback reminder expired)/.test(current.reason)
    || Boolean(incident && incident.role === "reviewer" && incident.status !== "resolved"
      && (incident.cause === "missing_callback" || incident.cause === "stalled_turn"));
  if (!stoppedWithoutResult) return false;
  const identity = digest(`responsible-fault:${current.id}:${run.head}:${shape}`);
  if (engine.store.eventsAll(current.id).some(event => event.kind === "responsible_fault_restart" && event.detail === identity)) return false;
  // The event is the durable intent, written before the control and outside the
  // task row, so even a refused restart leaves one recorded decision.
  engine.store.event(current.id, "responsible_fault_restart", identity);
  try {
    await engine.performTaskControl(taskControlInputSchema.parse({
      taskId: current.id, version: current.version, action: "restart", role: "reviewer", fresh: true, caller: "queue",
      reason: "Responsible task: the reviewer stopped without a result; Nucleus restarts it at the same exact head (Spec 058). "
        + (shape === "checkpoint_reviewer" ? "Its saved checkpoint cannot receive a same-agent continuation because the agent is closed." : "The stopped reviewer run is replaced on the same task."),
    }));
    return true;
  } catch (error) {
    engine.store.event(current.id, "responsible_fault_restart_refused", `${identity}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
