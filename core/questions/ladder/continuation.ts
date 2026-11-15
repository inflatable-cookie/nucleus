import type { Task, TaskControlInput } from '../../../shared/contracts';
import type { Ladder } from './ladder';
import { plannerEscalations } from './records';

/**
 * How the ladder ends: the same retained worker continues with the recorded
 * direction, and an ordinary owner control that disposes of the task answers the
 * escalation it stepped over.
 */

/** The one continuation shape both ladder exits use: the same retained worker continues with the recorded direction. */
export function continueWorkerAfterLadder(
  ladder: Ladder,
  t: Task,
  input: { instruction: string; event: string; reason: string; detail: string },
): void {
  const current = ladder.store.task(t.id);
  ladder.resolution.update(current, { currentRunId: null, integrationTurn: null, attention: false, stop: null,
    pendingRevisionCause: 'consult' as const, pendingWorkerInstruction: input.instruction.slice(0, 12000) },
    { phase: 'changes_requested', reason: input.reason }, input.event, input.detail);
}

/** An ordinary owner control that moved a parked task answers the escalations it stepped over. */
export function settleLadderControl(ladder: Ladder, before: Task, after: Task, action: TaskControlInput["action"]): void {
  if (after.resolution.stop || !["move", "restart", "route", "retry_effect", "complete", "stop"].includes(action)) return;
  for (const escalation of plannerEscalations(ladder.store.eventsAll(before.id)).filter(item => !item.answered)) {
    ladder.store.event(before.id, "planner_escalation_answered", `${escalation.id}: answered by ordinary ${action}: task control moved the task`);
  }
}
