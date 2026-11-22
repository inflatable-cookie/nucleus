import type { Task, TaskControlInput } from '../../../shared/contracts';
import { TASK_PROGRESSING_REASON } from '../../../shared/task-stop';
import { appliedMergeVerdict, escalationOutlived, readyReviewAtHead } from '../../recovery/task-reasons';
import type { Ladder } from './ladder';
import { plannerEscalations, type LadderEvent, type PlannerEscalation } from './records';
import type { Store } from '../../store/store';

function escalationPayload(events: readonly LadderEvent[], id: string): Record<string, unknown> | null {
  const event = events.find(item => item.kind === 'planner_escalation_payload' && item.detail.startsWith(`${id}:`));
  if (!event) return null;
  try {
    const parsed: unknown = JSON.parse(event.detail.slice(event.detail.indexOf(':') + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Spec 067 batch 4: an open escalation closes itself when its recorded cause
 * clears. Returns the human-readable reason it cleared, or null while open.
 */
export function escalationCauseClearedReason(
  store: Store,
  task: Task,
  escalation: PlannerEscalation,
  events: readonly LadderEvent[],
): string | null {
  if (escalation.answered) return null;
  if (task.removedAt) return 'the task was removed';
  if (escalationOutlived(task)) return 'the task merged or ended';
  const intentEvent = events.find(
    item => item.kind === 'planner_escalation' && item.detail.startsWith(`${escalation.id}:`),
  );
  const payload = escalationPayload(events, escalation.id);
  if (payload?.reviewContinuation) {
    if (readyReviewAtHead(task)) return 'a ready review verdict arrived for the current head';
    if (typeof payload.reader === 'string') {
      const reader = store.run(payload.reader);
      if (!reader || reader.released || (task.resolution.currentRunId && task.resolution.currentRunId !== payload.reader))
        return 'the stopped reviewer run was released or replaced';
    }
  }
  if (typeof payload?.commit === 'string' && typeof payload?.head === 'string' && appliedMergeVerdict(task, payload.head))
    return 'review or operator source acceptance arrived for the merged head';
  if (typeof payload?.revisionCap === 'number' && readyReviewAtHead(task))
    return 'a ready review verdict arrived for the current head';
  if (payload?.cause === 'recovery-pending' && (!task.resolution.incident || task.resolution.incident.status === 'resolved'))
    return 'the escalated incident cleared';
  if (
    intentEvent &&
    (payload?.source === 'worker' || payload?.source === 'revision') &&
    !escalation.refusal &&
    task.completion?.status === 'ready_for_review' &&
    events.some(item => item.id > intentEvent.id && item.detail.includes(task.completion!.eventId))
  )
    return 'a ready result arrived after the blocker escalation';
  const currentRun = task.resolution.currentRunId ? store.run(task.resolution.currentRunId) : null;
  if (
    intentEvent &&
    currentRun &&
    !currentRun.released &&
    !currentRun.completion &&
    currentRun.role !== 'recovery' &&
    currentRun.id !== escalation.runId &&
    Date.parse(currentRun.createdAt) > Date.parse(intentEvent.at)
  )
    return `a new ${currentRun.role} run (${currentRun.id}) took over the task`;
  return null;
}

/** Close any open escalations on this task whose cause has already cleared. */
export function closeClearedEscalations(store: Store, task: Task): string[] {
  const current = store.taskOrNull(task.id);
  if (!current) return [];
  const events = store.eventsAll(current.id) as LadderEvent[];
  const closed: string[] = [];
  for (const escalation of plannerEscalations(events)) {
    if (escalation.answered) continue;
    const cleared = escalationCauseClearedReason(store, current, escalation, events);
    if (!cleared) continue;
    store.event(current.id, 'planner_escalation_resolved', `${escalation.id}: closed automatically; ${cleared}`);
    closeEscalationFollowups(store, current.id, escalation.id);
    const latest = store.task(current.id);
    if (latest.resolution.stop?.fact?.code === 'escalation' && latest.resolution.stop.fact.subject === escalation.id) {
      store.update(
        current.id,
        {
          resolution: { ...latest.resolution, stop: null },
          ...(!['done', 'cancelled', 'blocked', 'error', 'needs_attention'].includes(latest.phase)
            ? { reason: TASK_PROGRESSING_REASON }
            : {}),
        },
        'planner_escalation_cause_cleared',
        `${escalation.id}: ${cleared}`,
      );
    }
    closed.push(escalation.id);
  }
  return closed;
}

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
