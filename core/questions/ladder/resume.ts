import type { DecisionView, Run, Task } from '../../../shared/contracts';
import { taskControlInputSchema } from '../../../shared/contracts';
import { Decisions } from '../../planning/decisions';
import { DelegatedHostUnavailable } from '../delegation';
import { threadRunningReason } from '../../intake/thread-waits';
import { liveWorkingParticipant } from '../../recovery/live-noop';
import { collectOwnerVerbFacts, ownerVerbViews, restartShape } from '../../verbs/owner-verbs';
import { NO_RESOLUTION_RUN_REFUSAL } from '../../verbs/verb-refusal-text';
import { escalationWaitState, establishEscalationWait, type EscalationWait } from './hold';
import type { Ladder } from './ladder';
import { consultRecovery, escalationRecovery } from './pass';
import { plannerEscalations, reviewerConsults, type LadderEvent } from './records';
import { routePlannerEscalation } from './routing';
import { escalationWaitDetail } from './waits';

/** Owner verbs that resume parked work. stop and route do not. */
const ORDINARY_RESUME_VERBS = new Set(['restart', 'move', 'retry_effect']);

/** The run that raised this escalation is missing or already released. */
function raisingRunReleased(ladder: Ladder, task: Task, id: string): boolean {
  const escalation = plannerEscalations(ladder.store.eventsAll(task.id)).find(item => item.id === id);
  if (!escalation?.runId) return true;
  const run = ladder.store.run(escalation.runId);
  return !run || Boolean(run.released);
}

function restoreLiveWait(ladder: Ladder, task: Task, live: Run, id: string, wait: { kind: string; target: string }): void {
  const current = ladder.store.task(task.id);
  const recovery = current.resolution.recovery;
  const phase = ['blocked', 'error', 'needs_attention'].includes(current.phase)
    ? live.role === 'reviewer' ? 'reviewing' : live.role === 'revision' ? 'changes_requested' : 'working'
    : undefined;
  ladder.resolution.update(current, {
    stop: null,
    attention: false,
    ...(recovery && recovery.status !== 'resolved' ? {
      recovery: { ...recovery, status: 'resolved' as const, summary: `Escalation ${id} wait ended; ${live.role} is live` },
      recoveryActive: false,
    } : {}),
  }, { ...(phase ? { phase } : {}) }, 'planner_escalation_wake', `${id}: ordinary next`);
  ladder.resolution.waiting(ladder.store.task(task.id), threadRunningReason(live.role), 'lifecycle');
  ladder.store.event(task.id, 'planner_escalation_woke', `${id}: ${wait.kind} ${wait.target} settled; ordinary next; ${live.role} is live`);
}

function parkAfterEscalationWait(
  ladder: Ladder, task: Task, id: string, wait: { kind: string; target: string },
  refusal?: string,
): void {
  const current = ladder.store.task(task.id);
  const recovery = current.resolution.recovery;
  const clipped = refusal?.slice(0, 1200);
  const detail = clipped
    ? `Escalation ${id} wait ended; ${clipped}`
    : `Escalation ${id} wait ended; no parked step to resume`;
  if (recovery && recovery.status !== 'resolved') {
    ladder.resolution.update(current, {
      recovery: { ...recovery, status: 'resolved' as const, summary: detail },
      recoveryActive: false,
    }, {}, 'planner_escalation_wake', `${id}: wait ended`);
  }
  // Visible lifecycle stop, empty suggested verbs: recovery treats it as a wait
  // and does not open another episode. Event text names that nothing ran, or
  // the refusal that stopped the retained resume — never a silent fresh replacement.
  ladder.resolution.waiting(ladder.store.task(task.id), detail, 'lifecycle');
  ladder.store.event(task.id, 'planner_escalation_woke', clipped
    ? `${id}: ${wait.kind} ${wait.target} settled; ${clipped}`.slice(0, 4000)
    : `${id}: ${wait.kind} ${wait.target} settled; no resume verb ran`);
}

async function applyOrdinaryResume(
  ladder: Ladder, taskId: string, id: string, wait: { kind: string; target: string },
  extra: Record<string, unknown>, verbLabel: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!ladder.resolution.applyOperatorControl) return { ok: false, message: 'No control applier is bound' };
  const current = ladder.store.task(taskId);
  try {
    await ladder.resolution.applyOperatorControl(taskControlInputSchema.parse({
      ...extra,
      taskId: current.id, version: current.version,
      reason: `Escalation ${id}: ${wait.kind} ${wait.target} settled`,
    }));
    ladder.store.event(taskId, 'planner_escalation_woke', `${id}: ${wait.kind} ${wait.target} settled; ordinary ${verbLabel}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Wake into a live wait, `next`'s first resume verb, or a visible stop. Never a dead wake-refused stop, never a silent fresh reviewer, and never event text for an action that did not run. */
async function wakeIntoOrdinaryNext(ladder: Ladder, task: Task, id: string, wait: { kind: string; target: string }): Promise<void> {
  const current = ladder.store.task(task.id);
  const live = liveWorkingParticipant(current, ladder.store.runs(current.id));
  if (live) {
    restoreLiveWait(ladder, current, live, id, wait);
    return;
  }
  const facts = collectOwnerVerbFacts(ladder.store, current);
  const view = ownerVerbViews(facts)
    .find(item => item.available && ORDINARY_RESUME_VERBS.has(item.verb) && item.args
      && (item.fill ?? []).every(field => field === 'reason')
      && item.args.fresh !== true);
  if (view?.args) {
    const attempt = await applyOrdinaryResume(ladder, current.id, id, wait, view.args, view.verb);
    if (attempt.ok) return;
    // #1217: default restart is the worker parked step, which refuses with
    // "No resolution run to resume" when the last non-recovery run has no
    // completion. Ordinary next is retained restart of that released reviewer.
    // Any other refusal stays visible; the wake never retries as fresh.
    if (!attempt.message.includes(NO_RESOLUTION_RUN_REFUSAL)) {
      parkAfterEscalationWait(ladder, current, id, wait, attempt.message);
      return;
    }
  }
  const reviewerShape = restartShape(current, facts.runs, 'reviewer', facts.events);
  if (reviewerShape === 'stopped_reviewer' || reviewerShape === 'checkpoint_reviewer') {
    const attempt = await applyOrdinaryResume(ladder, current.id, id, wait, { action: 'restart', role: 'reviewer' }, 'restart');
    if (attempt.ok) return;
    parkAfterEscalationWait(ladder, current, id, wait, attempt.message);
    return;
  }
  parkAfterEscalationWait(ladder, current, id, wait);
}

/**
 * What a restarted service re-attaches to. A recorded consult or escalation resumes
 * its own answer window; a send nobody observed stays unknown and is never repeated;
 * a recorded wait is re-asserted, or wakes the parked step through its ordinary verb
 * once its target has settled.
 */

/** Resume the consults and escalations a restart left recorded, in the order they were made. */
export function resumeDelegations(ladder: Ladder, task: Task): void {
  const events = ladder.store.eventsAll(task.id);
  // Spec 058 slice 17: durable consult and escalation intents survive a restart.
  // A recorded delivery resumes its original answer window or consumes its receipt.
  // Without that journal evidence, an unobserved send remains unknown and is never
  // repeated. Settled answers and operator classifications remain terminal.
  for (const consult of reviewerConsults(events)) {
    if (consultRecovery({
      answered: consult.answered,
      unknown: consult.unknown,
      recoverable: consult.unknown ? ladder.resolution.recoverableDelegation([`ns-reviewer-consult-${consult.id}`]) : false,
      question: consult.question,
      hasAdapter: consult.reviewer ? Boolean(ladder.adapter.askReviewer) : Boolean(ladder.adapter.createConsultReviewer && ladder.adapter.askReviewer),
      inFlight: ladder.resolution.routingConsults.has(consult.id),
    }).kind === 'skip' || !consult.question) continue;
    ladder.resolution.routingConsults.add(consult.id);
    void ladder.resolution.runReviewerConsult(task, { id: consult.id, reviewer: consult.reviewer, question: consult.question })
      .catch(error => {
        if (ladder.resolution.stopped() || !ladder.resolution.consultStillOwnsWait(task.id, consult.id)) return;
        if (error instanceof DelegatedHostUnavailable) return;
        ladder.store.event(task.id, 'reviewer_consult_unknown', `${consult.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        ladder.resolution.escalateConsultedBlocker(task, { id: consult.id });
      })
      .finally(() => ladder.resolution.routingConsults.delete(consult.id));
  }
  for (const escalation of plannerEscalations(events)) {
    const windows = [`ns-escalation-${escalation.id}`, `ns-escalation-${escalation.id}-project`, `ns-decider-${escalation.id}`];
    if (escalationRecovery({
      missedNoAnswer: events.some(event => event.kind === 'planner_escalation_missed' && event.detail.startsWith(`${escalation.id}: no delegated answer was produced;`)),
      answered: escalation.answered,
      unknown: escalation.unknown,
      observing: escalation.unknown ? ladder.resolution.recoverableDelegation(windows, false) : false,
      missed: escalation.missed,
      recoverable: escalation.missed ? ladder.resolution.recoverableDelegation(windows) : false,
      decisionId: escalation.decisionId,
      question: escalation.question,
      inFlight: ladder.routingEscalations.has(escalation.id),
    }).kind === 'skip' || !escalation.question) continue;
    ladder.routingEscalations.add(escalation.id);
    void routePlannerEscalation(ladder, task, escalation.id, escalation.question)
      .catch(error => {
        if (ladder.resolution.stopped()) return;
        ladder.store.event(task.id, 'planner_escalation_unknown', `${escalation.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        ladder.resolution.waiting(ladder.store.task(task.id), escalationWaitDetail.unknown(escalation.id), 'escalated');
      })
      .finally(() => ladder.routingEscalations.delete(escalation.id));
  }
}

/** Re-assert every recorded escalation wait, and wake the ones whose target settled. */
export async function resumeEscalationWaits(ladder: Ladder, task: Task): Promise<void> {
  const events = ladder.store.eventsAll(task.id);
  for (const event of events.filter(item => item.kind === 'planner_escalation_wait')) {
    const id = event.detail.split(':', 1)[0]!;
    if (events.some(item => item.kind === 'planner_escalation_wait_superseded' && item.detail.startsWith(`${id}:`))) continue;
    const intent = events.some(item => item.kind === 'planner_escalation_wake_intent' && item.detail.startsWith(`${id}:`));
    if (intent) {
      const finished = events.some(item => ['planner_escalation_woke', 'planner_escalation_wake_refused'].includes(item.kind) && item.detail.startsWith(`${id}:`));
      if (!finished && !ladder.resolution.wakingEscalations.has(id)) ladder.resolution.waiting(ladder.store.task(task.id), `Escalation ${id} wake outcome is unknown; inspect before retrying`, 'escalated');
      continue;
    }
    const wait = JSON.parse(event.detail.slice(id.length + 2)) as {
      kind: 'task' | 'time' | 'decision';
      target: string;
      waitId?: string;
      stopDetail?: string;
      stopReason?: 'lifecycle' | 'escalated';
    };
    if (events.some(item => item.id > event.id && item.kind === 'operator_control' && item.detail !== 'note')) {
      ladder.store.event(task.id, 'planner_escalation_wait_superseded', `${id}: a later owner control changed the task`);
      continue;
    }
    let current = ladder.store.task(task.id);
    if (wait.kind === 'task' && current.prerequisiteWait && current.prerequisiteWait.id === wait.waitId && !current.prerequisiteWait.releasedAt) {
      ladder.store.reconcilePrerequisiteWait(current.id);
      current = ladder.store.task(task.id);
    }
    if (wait.kind === 'task' && current.prerequisiteWait?.id !== wait.waitId) {
      ladder.store.event(task.id, 'planner_escalation_wait_superseded', `${id}: prerequisite wait changed`);
      continue;
    }
    if (wait.kind !== 'task') {
      const waitControl: EscalationWait = { kind: wait.kind as 'time' | 'decision', target: wait.target,
        stopDetail: wait.stopDetail, stopReason: wait.stopReason };
      const expected = escalationWaitState(id, waitControl);
      if (current.resolution.stop?.reason !== expected.stopReason || current.resolution.stop.detail !== expected.stopDetail) {
        const pending = events.findLast(item => item.kind === 'planner_escalation_answer_pending' && item.detail.startsWith(`${id}:`)
          && item.id < event.id && (() => {
            try {
              const answer = JSON.parse(item.detail.slice(id.length + 1).trim()) as { control?: { kind?: string; target?: string } };
              return answer.control?.kind === waitControl.kind && answer.control.target === waitControl.target;
            } catch { return false; }
          })());
        const linkedClassification = waitControl.kind === 'decision'
          && expected.stopDetail === escalationWaitDetail.operator(id, waitControl.target)
          && events.some(item => item.kind === 'planner_escalation_decision_linked' && item.detail === `${id}: decision ${waitControl.target}`);
        const repaired = (pending || linkedClassification)
          && establishEscalationWait(ladder, task.id, id, waitControl, pending?.id ?? 0);
        current = ladder.store.task(task.id);
        if (!repaired || current.resolution.stop?.reason !== expected.stopReason || current.resolution.stop.detail !== expected.stopDetail) {
          ladder.store.event(task.id, 'planner_escalation_wait_superseded', `${id}: task stop changed and the recorded wait could not be restored`);
          continue;
        }
      }
    }
    if (wait.kind === 'task' && !current.prerequisiteWait?.releasedAt) continue;
    if (wait.kind === 'time' && Date.parse(wait.target) > Date.now()) continue;
    let decision: DecisionView | null = null;
    if (wait.kind === 'decision') {
      try { decision = new Decisions(ladder.store).get({ id: wait.target }); } catch { continue; }
      if (decision.status !== 'answered' || !decision.answer) continue;
    }
    ladder.store.event(task.id, 'planner_escalation_wake_intent', `${id}: ${wait.kind} ${wait.target}`);
    ladder.resolution.wakingEscalations.add(id);
    if (decision?.answer) {
      const refusal = await ladder.resolution.settlePlannerEscalation(current, id, decision.answer.text, decision.answer.answeredBy);
      if (refusal) ladder.store.event(task.id, 'planner_escalation_wake_refused', `${id}: ${refusal}`);
      else ladder.store.event(task.id, 'planner_escalation_woke', `${id}: operator decision ${wait.target} applied`);
      ladder.resolution.wakingEscalations.delete(id);
      continue;
    }
    try {
      if (!ladder.resolution.applyOperatorControl) throw Error('No control applier is bound');
      if (raisingRunReleased(ladder, current, id)) {
        await wakeIntoOrdinaryNext(ladder, current, id, wait);
      } else {
        // Restart is the ordinary owner verb for resuming the parked step while
        // the raising run still owns it. It rechecks the saved task and all
        // delivery and exact-head gates.
        await ladder.resolution.applyOperatorControl(taskControlInputSchema.parse({ taskId: current.id, version: current.version,
          action: 'restart', reason: `Escalation ${id}: ${wait.kind} ${wait.target} settled` }));
        ladder.store.event(task.id, 'planner_escalation_woke', `${id}: ${wait.kind} ${wait.target} settled; restarted the parked step`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (raisingRunReleased(ladder, current, id)) {
        parkAfterEscalationWait(ladder, current, id, wait, message);
      } else if (message.includes(NO_RESOLUTION_RUN_REFUSAL)) {
        try { await wakeIntoOrdinaryNext(ladder, current, id, wait); }
        catch (inner) {
          parkAfterEscalationWait(ladder, current, id, wait, inner instanceof Error ? inner.message : String(inner));
        }
      } else {
        ladder.store.event(task.id, 'planner_escalation_wake_refused', `${id}: ${message}`.slice(0, 4000));
        ladder.resolution.waiting(ladder.store.task(task.id), `Escalation ${id} wake was refused: ${message}`, 'escalated');
      }
    } finally { ladder.resolution.wakingEscalations.delete(id); }
  }
}
