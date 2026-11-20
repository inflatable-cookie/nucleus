import type { Task, TaskControlInput } from '../../../shared/contracts';
import type { Ladder } from './ladder';
import { plannerEscalations } from './records';
import type { Store } from '../../store/store';

/** Retire every recorded refusal follow-up and return prompt once its escalation has settled. */
export function closeEscalationFollowups(store: Store, taskId: string, escalationId: string): void {
  const closeWindow = (questionId: string) => {
    for (const candidate of [questionId, `${questionId}-project`]) {
      const key = `delegation:${candidate}`, events = store.eventsAll(key);
      if (events.length && !events.some(event => event.kind === 'delegated_closed'))
        store.event(key, 'delegated_closed', 'The escalation settled; this follow-up is superseded');
    }
  };
  closeWindow(`ns-escalation-return-${escalationId}`);
  closeWindow(`ns-escalation-return-refusal-${escalationId}`);
  const offers = store.eventsAll(taskId).filter(event => event.kind === 'planner_escalation_followup_offered'
    && event.detail.startsWith(`${escalationId}: `));
  for (const offer of offers) {
    let id: unknown;
    try { id = (JSON.parse(offer.detail.slice(escalationId.length + 2)) as { questionId?: unknown }).questionId; }
    catch { continue; }
    if (typeof id !== 'string' || (!id.startsWith(`ns-escalation-refusal-${escalationId}`) && !id.startsWith(`ns-escalation-return-refusal-${escalationId}`))) continue;
    closeWindow(id);
  }
}

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
    closeEscalationFollowups(ladder.store, before.id, escalation.id);
  }
}
