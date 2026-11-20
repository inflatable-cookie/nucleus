import type { DecisionView } from '../../../shared/contracts';
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
    const expected = escalationWaitState(id, wait);
    const recordedWait = events.findLast(event => event.kind === 'planner_escalation_wait' && event.detail.startsWith(`${id}:`)
      && !events.some(superseded => superseded.kind === 'planner_escalation_wait_superseded' && superseded.id > event.id && superseded.detail.startsWith(`${id}:`))
      && (() => {
        try {
          const value = JSON.parse(event.detail.slice(id.length + 2)) as { kind?: string; target?: string; stopDetail?: string; stopReason?: string };
          const prior = escalationWaitState(id, { ...wait, stopDetail: value.stopDetail, stopReason: value.stopReason as 'lifecycle' | 'escalated' | undefined });
          return value.kind === wait.kind && value.target === wait.target
            && prior.stopDetail === expected.stopDetail && prior.stopReason === expected.stopReason;
        } catch { return false; }
      })());
    if (!recordedWait) ladder.store.event(taskId, 'planner_escalation_wait', `${id}: ${JSON.stringify({ ...wait, stopDetail, stopReason })}`);
    const stop = ladder.store.task(taskId).resolution.stop;
    if (stop?.reason !== stopReason || stop.detail !== stopDetail)
      ladder.resolution.waiting(ladder.store.task(taskId), stopDetail, stopReason);
    const established = ladder.store.task(taskId).resolution.stop;
    return established?.reason === stopReason && established.detail === stopDetail;
  });
}
