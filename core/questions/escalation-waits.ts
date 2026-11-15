import { taskControlInputSchema, type DecisionView, type Task } from '../../shared/contracts';
import { Decisions } from '../planning/decisions';
import type { Resolution } from '../resolution';
import { escalationWaitDetail, type LadderEvent } from './blocker-ladder';
import { decisionLinkedExactly, escalationWaitEpisodes, escalationWaitsOf, requireEscalationWait,
  type EscalationWaitEpisode, type EscalationWaitRecord } from './escalation-events';

/** The wait control one escalation establishment applies: a time or an operator decision. */
export type EscalationWaitControl = {
  kind: 'time' | 'decision';
  target: string;
  stopDetail?: string;
  stopReason?: 'lifecycle' | 'escalated';
};

/** A wait this owner establishes: a time, an operator decision, or the task's prerequisite. */
type AnyEscalationWait = EscalationWaitControl | { kind: 'task'; target: string; waitId?: string; stopDetail?: string; stopReason?: 'lifecycle' | 'escalated' };

/**
 * Owns the task-side wait one escalation is parked on: establishing it as one
 * durable state transition, and resuming it after a restart. An escalation's
 * routing and its recovery read the typed facts (`escalation-events.ts`); this
 * owner is the only place that turns a wait into a task stop and back again.
 */
export class EscalationWaits {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  /** The stop an established wait asserts, with the seat's own defaults. */
  private escalationWaitState(id: string, wait: AnyEscalationWait) {
    const stopDetail = wait.stopDetail ?? (wait.kind === 'time'
      ? `Escalation ${id}: waiting until ${wait.target}`
      : `Escalation ${id}: waiting for operator decision ${wait.target}`);
    const stopReason = wait.stopReason ?? (wait.kind === 'time' ? 'lifecycle' : 'escalated');
    return { stopDetail, stopReason };
  }
  /** The wait event and the actual task stop are one durable state transition. */
  establishEscalationWait(taskId: string, id: string, wait: EscalationWaitControl, afterEventId = 0): boolean {
    return this.store.transaction(() => {
      const current = this.store.task(taskId);
      if (['done', 'cancelled'].includes(current.phase)) return false;
      const events = this.store.eventsAll(taskId);
      if (afterEventId > 0 && events.some(event => event.id > afterEventId && event.kind === 'operator_control' && event.detail !== 'note')) return false;
      if (wait.kind === 'decision') {
        let decision: DecisionView;
        try { decision = new Decisions(this.store).get({ id: wait.target }); } catch { return false; }
        if (!['open', 'answered'].includes(decision.status)) return false;
      }
      const { stopDetail, stopReason } = this.escalationWaitState(id, wait);
      const expected = this.escalationWaitState(id, wait);
      const recordedWait = escalationWaitsOf(events, id).findLast(record => this.waitMatches(record, id, wait, expected));
      if (!recordedWait) this.store.event(taskId, 'planner_escalation_wait', `${id}: ${JSON.stringify({ ...wait, stopDetail, stopReason })}`);
      const stop = this.store.task(taskId).resolution.stop;
      if (stop?.reason !== stopReason || stop.detail !== stopDetail)
        this.resolution.waiting(this.store.task(taskId), stopDetail, stopReason);
      const established = this.store.task(taskId).resolution.stop;
      return established?.reason === stopReason && established.detail === stopDetail;
    });
  }
  /** One recorded wait is this establishment's: same seat and same asserted stop. */
  private waitMatches(record: EscalationWaitRecord, id: string, wait: EscalationWaitControl, expected: { stopDetail: string; stopReason: string }): boolean {
    const recorded = record.wait;
    if (!recorded) return false;
    const prior = this.escalationWaitState(id, { ...wait, stopDetail: recorded.stopDetail, stopReason: recorded.stopReason });
    return recorded.kind === wait.kind && recorded.target === wait.target
      && prior.stopDetail === expected.stopDetail && prior.stopReason === expected.stopReason;
  }
  async resumeEscalationWaits(task: Task): Promise<void> {
    const events = this.store.eventsAll(task.id);
    for (const episode of escalationWaitEpisodes(events)) {
      const id = episode.id;
      if (episode.superseded) continue;
      if (episode.wakeIntent) {
        if (!episode.wakeFinished && !this.resolution.wakingEscalations.has(id)) this.resolution.waiting(this.store.task(task.id), `Escalation ${id} wake outcome is unknown; inspect before retrying`, 'escalated');
        continue;
      }
      const wait = requireEscalationWait(episode.record, id);
      if (events.some(event => event.id > episode.record.eventId && event.kind === 'operator_control' && event.detail !== 'note')) {
        this.store.event(task.id, 'planner_escalation_wait_superseded', `${id}: a later owner control changed the task`);
        continue;
      }
      let current = this.store.task(task.id);
      if (wait.kind === 'task' && current.prerequisiteWait && current.prerequisiteWait.id === wait.waitId && !current.prerequisiteWait.releasedAt) {
        this.store.reconcilePrerequisiteWait(current.id);
        current = this.store.task(task.id);
      }
      if (wait.kind === 'task' && current.prerequisiteWait?.id !== wait.waitId) {
        this.store.event(task.id, 'planner_escalation_wait_superseded', `${id}: prerequisite wait changed`);
        continue;
      }
      if (wait.kind === 'time' || wait.kind === 'decision') {
        const control: EscalationWaitControl = { kind: wait.kind, target: wait.target, stopDetail: wait.stopDetail, stopReason: wait.stopReason };
        if (!this.restored(task.id, id, control, episode, events)) continue;
      }
      current = this.store.task(task.id);
      if (wait.kind === 'task' && !current.prerequisiteWait?.releasedAt) continue;
      if (wait.kind === 'time' && Date.parse(wait.target) > Date.now()) continue;
      let decision: DecisionView | null = null;
      if (wait.kind === 'decision') {
        try { decision = new Decisions(this.store).get({ id: wait.target }); } catch { continue; }
        if (decision.status !== 'answered' || !decision.answer) continue;
      }
      this.store.event(task.id, 'planner_escalation_wake_intent', `${id}: ${wait.kind} ${wait.target}`);
      this.resolution.wakingEscalations.add(id);
      if (decision?.answer) {
        const refusal = await this.resolution.settlePlannerEscalation(current, id, decision.answer.text, decision.answer.answeredBy);
        if (refusal) this.store.event(task.id, 'planner_escalation_wake_refused', `${id}: ${refusal}`);
        else this.store.event(task.id, 'planner_escalation_woke', `${id}: operator decision ${wait.target} applied`);
        this.resolution.wakingEscalations.delete(id);
        continue;
      }
      try {
        if (!this.resolution.applyOperatorControl) throw Error('No control applier is bound');
        // Restart is the ordinary owner verb for resuming the parked step. It
        // rechecks the saved task and all delivery and exact-head gates.
        await this.resolution.applyOperatorControl(taskControlInputSchema.parse({ taskId: current.id, version: current.version,
          action: 'restart', reason: `Escalation ${id}: ${wait.kind} ${wait.target} settled` }));
        this.store.event(task.id, 'planner_escalation_woke', `${id}: ${wait.kind} ${wait.target} settled; restarted the parked step`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.event(task.id, 'planner_escalation_wake_refused', `${id}: ${message}`.slice(0, 4000));
        this.resolution.waiting(this.store.task(task.id), `Escalation ${id} wake was refused: ${message}`, 'escalated');
      } finally { this.resolution.wakingEscalations.delete(id); }
    }
  }
  /**
   * The task's stop this wait asserted is still in force, or could be restored from
   * its own recorded answer intent or its linked operator classification.
   */
  private restored(taskId: string, id: string, wait: EscalationWaitControl, episode: EscalationWaitEpisode, events: LadderEvent[]): boolean {
    const current = this.store.task(taskId);
    const expected = this.escalationWaitState(id, wait);
    if (current.resolution.stop?.reason === expected.stopReason && current.resolution.stop.detail === expected.stopDetail) return true;
    const pending = episode.pendingAnswers.findLast(intent => intent.wait?.kind === wait.kind && intent.wait.target === wait.target);
    const linkedClassification = wait.kind === 'decision'
      && expected.stopDetail === escalationWaitDetail.operator(id, wait.target)
      && decisionLinkedExactly(events, id, wait.target);
    const repaired = Boolean(pending || linkedClassification) && this.establishEscalationWait(taskId, id, wait, pending?.eventId ?? 0);
    const after = this.store.task(taskId);
    if (repaired && after.resolution.stop?.reason === expected.stopReason && after.resolution.stop.detail === expected.stopDetail) return true;
    this.store.event(taskId, 'planner_escalation_wait_superseded', `${id}: task stop changed and the recorded wait could not be restored`);
    return false;
  }
}
