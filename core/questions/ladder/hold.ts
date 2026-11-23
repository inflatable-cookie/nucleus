import type { DecisionView } from '../../../shared/contracts';
import type { TaskDecisionFact, TaskStopRecord } from '../../../shared/task-stop';
import { Decisions } from '../../planning/decisions';
import type { Ladder } from './ladder';

/**
 * The task-side wait an escalation establishes: the durable wait event and the
 * task stop are one state transition, so a restart reads the same wait the board
 * shows and a settled wait wakes the parked step on its ordinary verb.
 */

/** The wait an escalation holds: a named time, or an operator decision. */
export type EscalationWait = {
  kind: 'time' | 'decision';
  target: string;
  stopDetail?: string;
  stopReason?: 'lifecycle' | 'escalated';
};

export function escalationWaitFact(id: string, { kind, target }: EscalationWait): TaskDecisionFact {
  return { code: 'escalation', subject: id, escalationWait: { kind, target } };
}

export function matchesEscalationWait(stop: TaskStopRecord | null, id: string, wait: EscalationWait): boolean {
  const fact = stop?.fact;
  return stop?.reason === escalationWaitState(id, wait).stopReason
    && fact?.code === 'escalation' && fact.subject === id
    && fact.escalationWait?.kind === wait.kind && fact.escalationWait.target === wait.target;
}

/** The stop the wait writes, with the recorded detail and reason winning. */
export function escalationWaitState(id: string, wait: EscalationWait) {
  const stopDetail = wait.stopDetail ?? (wait.kind === 'time'
    ? `Escalation ${id}: waiting until ${wait.target}`
    : `Escalation ${id}: waiting for operator decision ${wait.target}`);
  const stopReason = wait.stopReason ?? (wait.kind === 'time' ? 'lifecycle' : 'escalated');
  return { stopDetail, stopReason };
}

/** The wait event and the actual task stop are one durable state transition. */
export function establishEscalationWait(ladder: Ladder, taskId: string, id: string, wait: EscalationWait, afterEventId = 0): boolean {
  return ladder.store.transaction(() => {
    const current = ladder.store.task(taskId);
    if (['done', 'cancelled'].includes(current.phase)) return false;
    const events = ladder.store.eventsAll(taskId);
    if (afterEventId > 0 && events.some(event => event.id > afterEventId && event.kind === 'operator_control' && event.detail !== 'note')) return false;
    if (wait.kind === 'decision') {
      let decision: DecisionView;
      try { decision = new Decisions(ladder.store).get({ id: wait.target }); } catch { return false; }
      if (!['open', 'answered'].includes(decision.status)) return false;
    }
    const { stopDetail, stopReason } = escalationWaitState(id, wait);
    const recordedWait = events.findLast(event => event.kind === 'planner_escalation_wait' && event.detail.startsWith(`${id}:`));
    const matchesRecordedWait = recordedWait
      && !events.some(event => event.kind === 'planner_escalation_wait_superseded' && event.id > recordedWait.id && event.detail.startsWith(`${id}:`))
      && (() => {
        try {
          const prior: EscalationWait = JSON.parse(recordedWait.detail.slice(id.length + 2));
          const state = escalationWaitState(id, prior);
          return prior.kind === wait.kind && prior.target === wait.target
            && state.stopDetail === stopDetail && state.stopReason === stopReason;
        } catch { return false; }
      })();
    if (!matchesRecordedWait) ladder.store.event(taskId, 'planner_escalation_wait', `${id}: ${JSON.stringify({ ...wait, stopDetail, stopReason })}`);
    if (!matchesEscalationWait(current.resolution.stop, id, wait) || current.resolution.stop?.detail !== stopDetail)
      ladder.resolution.waiting(current, stopDetail, stopReason, { fact: escalationWaitFact(id, wait) });
    return matchesEscalationWait(ladder.store.task(taskId).resolution.stop, id, wait);
  });
}
