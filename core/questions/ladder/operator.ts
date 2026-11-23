import type { Decision, Task } from '../../../shared/contracts';
import { clipDecisionQuestion, isOperatorOrigin, taskOwner, taskPlanner } from '../../../shared/contracts';
import { normalizeRepositoryOrigin } from '../../../shared/lanes';
import { Decisions } from '../../planning/decisions';
import { digest } from '../../store/store-core';
import { establishEscalationWait, matchesEscalationWait, type EscalationWait } from './hold';
import type { Ladder } from './ladder';
import { plannerEscalationSuggestedVerbs } from './proof';
import { plannerEscalations, type LadderEvent } from './records';
import { escalationWaitDetail } from './waits';

/**
 * The ladder's last rung: only concrete operator choices with real consequences
 * reach the operator as one Spec 032 decision, and the task waits on that
 * decision instead of on a planner. A bare classification or options that only
 * defer planning return the exact occurrence to the planner ladder instead
 * (Tom, 2026-11-20).
 */

export interface OperatorEscalationChoice {
  label: string;
  consequence: string;
  /** Structured authority role; choices that only defer planning or hold never open an operator card. */
  kind?: 'action' | 'defer_planning' | 'hold';
}

export interface OperatorEscalationHandoff {
  authority?: 'bare_classification' | 'operator_choices';
  sourceQuestionId?: string;
  choices?: readonly OperatorEscalationChoice[];
  recommended?: string;
  question?: string;
  headline?: string;
  context?: string;
  details?: string;
}

/** Structured check: genuine operator handoffs carry >=2 concrete choices with consequences, not defer-only options. */
export function hasConcreteOperatorChoices(handoff?: OperatorEscalationHandoff): boolean {
  if (!handoff || handoff.authority === 'bare_classification') return false;
  const choices = handoff.choices ?? [];
  if (choices.length < 2) return false;
  if (choices.some(choice => !choice.label.trim() || !choice.consequence.trim())) return false;
  if (!choices.some(choice => choice.kind !== 'defer_planning' && choice.kind !== 'hold')) return false;
  if (handoff.recommended && !choices.some(choice => choice.label.trim() === handoff.recommended!.trim())) return false;
  return true;
}

/** Stored-record check (no label matching): legacy placeholder decisions have fewer than two explicit options or stored choices. */
export function isPlaceholderDecisionRecord(stored: Pick<Decision, 'choices' | 'options'>): boolean {
  return !stored.choices || stored.choices.length < 2 || stored.options.length < 2;
}

function readOperatorDecision(ladder: Ladder, taskId: string, decisionId: string): Decision | null {
  try {
    const decision = ladder.store.decision(decisionId);
    return (decision.status === 'open' || decision.status === 'answered') && decision.links.tasks.includes(taskId)
      && !isPlaceholderDecisionRecord(decision) ? decision : null;
  } catch { return null; }
}

/** The last link or return distinguishes a deliberate replacement from a retry. */
function escalationDecisionId(taskId: string, id: string, generation: number): string {
  const hash = digest(JSON.stringify(['escalation decision', taskId, id, generation]));
  // UUID version 8 with the RFC variant. Decision readers expect UUIDs.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function operatorWait(id: string, decisionId: string): EscalationWait {
  return { kind: 'decision', target: decisionId, stopDetail: escalationWaitDetail.operator(id, decisionId) };
}

function isReturnQuestionId(questionId: string | undefined, escalationId: string): boolean {
  return Boolean(
    questionId &&
      (questionId.startsWith(`ns-escalation-return-${escalationId}`) ||
        questionId.startsWith(`ns-escalation-return-refusal-${escalationId}`)),
  );
}

function escalationHolderAgentId(ladder: Ladder, task: Task): string | undefined {
  const planner = taskPlanner(task);
  if (planner && !isOperatorOrigin(planner)) return planner;
  const project = ladder.store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? ''));
  if (project?.planner?.agentId && !isOperatorOrigin(project.planner.agentId)) return project.planner.agentId;
  const owner = taskOwner(task);
  return owner && !isOperatorOrigin(owner) ? owner : undefined;
}

export function scheduleEscalationReturn(ladder: Ladder, taskId: string, id: string): void {
  const returnKey = `return:${id}`;
  if (ladder.routingEscalations.has(returnKey)) return;
  ladder.routingEscalations.add(returnKey);
  queueMicrotask(() => {
    if (ladder.resolution.stopped()) {
      ladder.routingEscalations.delete(returnKey);
      return;
    }
    void ladder.resolution
      .routePlannerEscalationReturn(ladder.store.task(taskId), id)
      .catch(error => {
        if (ladder.resolution.stopped()) return;
        ladder.store.event(taskId, 'planner_escalation_unknown',
          `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        ladder.resolution.waiting(ladder.store.task(taskId), escalationWaitDetail.unknown(id), 'escalated');
      })
      .finally(() => ladder.routingEscalations.delete(returnKey));
  });
}

/** Whether an escalation's genuine operator decision is recorded, linked and holding the task. */
export function operatorDecisionApplied(ladder: Ladder, taskId: string, id: string): boolean {
  const events = ladder.store.eventsAll(taskId);
  const linked = events.findLast(event => event.kind === 'planner_escalation_decision_linked' && event.detail.startsWith(`${id}:`));
  const decisionId = linked?.detail.match(/decision ([0-9a-f-]{36})/)?.[1];
  if (!linked || !decisionId) return false;
  if (events.some(event => event.kind === 'planner_escalation_returned' && event.id > linked.id && event.detail.startsWith(`${id}:`)))
    return false;
  const waitEvent = events.findLast(event => event.kind === 'planner_escalation_wait' && event.detail.startsWith(`${id}:`));
  if (!waitEvent || waitEvent.id <= linked.id || events.some(event => event.kind === 'planner_escalation_wait_superseded' && event.id > waitEvent.id && event.detail.startsWith(`${id}:`))) return false;
  const stop = ladder.store.task(taskId).resolution.stop;
  if (!matchesEscalationWait(stop, id, { kind: 'decision', target: decisionId })) return false;
  try {
    const wait: { kind?: string; target?: string } = JSON.parse(waitEvent.detail.slice(id.length + 2));
    return wait.kind === 'decision' && wait.target === decisionId && Boolean(readOperatorDecision(ladder, taskId, decisionId));
  } catch { return false; }
}

/** Complete a handoff left by the older writer after its link committed. */
export function restoreLinkedOperatorWaits(ladder: Ladder, taskId: string, events: LadderEvent[]): boolean {
  if (!events.some(event => event.kind === 'planner_escalation_decision_linked')) return false;
  let restored = false;
  for (const { id, decisionId, answered } of plannerEscalations(events)) {
    if (!decisionId || answered) continue;
    const linked = events.findLast(event => event.kind === 'planner_escalation_decision_linked'
      && event.detail === `${id}: decision ${decisionId}`);
    if (!linked || events.some(event => event.detail.startsWith(`${id}:`) && (
      event.kind === 'planner_escalation_wake_intent' || (event.id > linked.id && (
        event.kind === 'planner_escalation_wait' || event.kind === 'planner_escalation_wait_superseded'
      ))
    ))) continue;
    if (!readOperatorDecision(ladder, taskId, decisionId)) continue;
    if (establishEscalationWait(ladder, taskId, id, operatorWait(id, decisionId), linked.id)) restored = true;
  }
  return restored;
}

/** Return a bare classification or placeholder decision to the planner ladder without creating an operator card. */
function returnEscalationToPlanner(
  ladder: Ladder,
  t: Task,
  id: string,
  reason: string,
  who: string,
  handoff?: OperatorEscalationHandoff,
): void {
  let shouldSchedule = false;
  const run = () => {
    const current = ladder.store.task(t.id);
    if (['done', 'cancelled'].includes(current.phase)) return;
    const events = ladder.store.eventsAll(t.id);
    const escalation = plannerEscalations(events as LadderEvent[]).find(item => item.id === id);
    if (!escalation || escalation.answered) return;
    if (operatorDecisionApplied(ladder, t.id, id)) return;

    const returnedEvent = events.findLast(event => event.kind === 'planner_escalation_returned' && event.detail.startsWith(`${id}:`));
    const linked = events.findLast(event => event.kind === 'planner_escalation_decision_linked' && event.detail.startsWith(`${id}:`));
    const linkedId = linked?.detail.match(/decision ([0-9a-f-]{36})/)?.[1];
    if (linked && linkedId && (!returnedEvent || linked.id > returnedEvent.id)) {
      let stored: Decision | null = null;
      try { stored = ladder.store.decision(linkedId); } catch { stored = null; }
      if (stored) {
        if (stored.status === 'answered') return;
        if (stored.status === 'open') {
          if (!isPlaceholderDecisionRecord(stored)) return;
          new Decisions(ladder.store).withdrawInTransaction({
            id: stored.id,
            version: stored.version,
            reason: 'Returned to the planner automatically: placeholder choices only deferred planning',
            withdrawnBy: 'nucleus',
          });
          for (const waitEvent of events.filter(item => item.kind === 'planner_escalation_wait' && item.detail.startsWith(`${id}:`))) {
            if (events.some(sup => sup.kind === 'planner_escalation_wait_superseded' && sup.id > waitEvent.id && sup.detail.startsWith(`${id}:`))) continue;
            try {
              const wait = JSON.parse(waitEvent.detail.slice(id.length + 2)) as { kind?: string; target?: string };
              if (wait.kind === 'decision' && wait.target === stored.id)
                ladder.store.event(t.id, 'planner_escalation_wait_superseded', `${id}: legacy placeholder decision ${stored.id} returned to the planner automatically`);
            } catch { /* unreadable wait stays untouched */ }
          }
        }
      }
    }

    const freshEvents = ladder.store.eventsAll(t.id);
    const holderAgentId = escalationHolderAgentId(ladder, current);
    const suggestedVerbs = plannerEscalationSuggestedVerbs(current);
    const existingReturned = freshEvents.findLast(event => event.kind === 'planner_escalation_returned' && event.detail.startsWith(`${id}:`));
    if (existingReturned) {
      if (isReturnQuestionId(handoff?.sourceQuestionId, id)) {
        if (!freshEvents.some(event => event.kind === 'planner_escalation_return_exhausted' && event.detail.startsWith(`${id}:`) && event.id >= existingReturned.id))
          ladder.store.event(t.id, 'planner_escalation_return_exhausted',
            `${id}: ${who} again could not decide (${reason.slice(0, 300)}); keeping escalation ${id} open and parked without asking the operator`.slice(0, 4000));
        ladder.resolution.waiting(ladder.store.task(t.id), escalationWaitDetail.returnedNoPlanner(id), 'escalated', {
          suggestedVerbs,
          ...(holderAgentId ? { holderAgentId } : {}),
        });
      }
      return;
    }

    ladder.store.event(t.id, 'planner_escalation_returned', `${id}: ${JSON.stringify({
      who,
      reason: reason.slice(0, 500),
      sourceQuestionId: handoff?.sourceQuestionId ?? null,
      ...(linkedId ? { legacyDecisionId: linkedId } : {}),
      at: new Date().toISOString(),
    })}`);
    ladder.resolution.waiting(ladder.store.task(t.id), escalationWaitDetail.returned(id), 'escalated', {
      suggestedVerbs,
      ...(holderAgentId ? { holderAgentId } : {}),
    });
    shouldSchedule = true;
  };
  if (ladder.store.db.isTransaction) run();
  else ladder.store.transaction(run);
  if (shouldSchedule) scheduleEscalationReturn(ladder, t.id, id);
}

/** Withdraw any still-open legacy placeholder ladder decisions and return their escalation occurrence to the planner. */
export function reconcileLegacyPlaceholderDecisions(ladder: Ladder, t: Task): void {
  if (['done', 'cancelled'].includes(t.phase)) return;
  const events = ladder.store.eventsAll(t.id);
  for (const escalation of plannerEscalations(events as LadderEvent[])) {
    if (escalation.answered || !escalation.decisionId) continue;
    const linked = events.findLast(event => event.kind === 'planner_escalation_decision_linked'
      && event.detail === `${escalation.id}: decision ${escalation.decisionId}`);
    if (!linked) continue;
    const waitEvent = events.findLast(event => event.kind === 'planner_escalation_wait'
      && event.detail.startsWith(`${escalation.id}:`)
      && !events.some(sup => sup.kind === 'planner_escalation_wait_superseded' && sup.id > event.id && sup.detail.startsWith(`${escalation.id}:`)));
    const anchorId = waitEvent?.id ?? linked.id;
    if (events.some(event => event.id > anchorId && event.kind === 'operator_control' && event.detail !== 'note')) continue;
    let stored: Decision;
    try { stored = ladder.store.decision(escalation.decisionId); } catch { continue; }
    if (stored.status !== 'open' || !isPlaceholderDecisionRecord(stored)) continue;
    returnEscalationToPlanner(
      ladder,
      t,
      escalation.id,
      'Legacy placeholder operator decision had no concrete choices',
      'legacy',
      { authority: 'bare_classification' },
    );
  }
}

/** Classify one escalation: concrete choices reach the operator; bare classifications return to the planner. */
export function classifyEscalationToOperator(
  ladder: Ladder,
  t: Task,
  id: string,
  reason: string,
  who: string,
  handoff?: OperatorEscalationHandoff,
): void {
  if (!hasConcreteOperatorChoices(handoff)) {
    returnEscalationToPlanner(ladder, t, id, reason, who, handoff);
    return;
  }
  const write = () => {
    const store = ladder.store;
    if (operatorDecisionApplied(ladder, t.id, id)) return;
    const current = store.task(t.id);
    const events = store.eventsAll(t.id);
    let classification = events.findLast(event => event.kind === 'planner_escalation_decision' && event.detail.startsWith(`${id}:`));
    if (!classification) {
      store.event(t.id, 'planner_escalation_decision', `${id}: the ${who} said it cannot decide: ${reason.slice(0, 300)}`.slice(0, 4000));
      classification = store.eventsAll(t.id).at(-1);
    }
    const prior = events.findLast(event => event.detail.startsWith(`${id}:`)
      && (event.kind === 'planner_escalation_decision_linked' || event.kind === 'planner_escalation_returned'));
    const linkedId = prior?.kind === 'planner_escalation_decision_linked'
      ? prior.detail.match(/decision ([0-9a-f-]{36})/)?.[1]
      : undefined;
    const decisionId = escalationDecisionId(t.id, id, prior?.id ?? 0);
    const existing = (linkedId && readOperatorDecision(ladder, t.id, linkedId))
      || readOperatorDecision(ladder, t.id, decisionId);
    let target = existing?.id;
    if (!target) {
      const payloadEvent = events.find(event => event.kind === 'planner_escalation_payload' && event.detail.startsWith(`${id}:`));
      let question = handoff?.question ?? `The blocker escalation ${id} on "${current.title}" needs the operator.`;
      try { if (!handoff?.question && payloadEvent) question = (JSON.parse(payloadEvent.detail.slice(payloadEvent.detail.indexOf(':') + 1)) as { question?: string }).question ?? question; } catch { /* unreadable payload keeps the plain question */ }
      const choices = handoff!.choices!.map(choice => ({ label: choice.label.trim(), consequence: choice.consequence.trim() }));
      const recommended = handoff?.recommended?.trim() || choices[0]!.label;
      target = new Decisions(store).add({
        question: clipDecisionQuestion(question),
        headline: handoff?.headline ?? `Blocker escalation on ${current.reference ?? current.id} needs the operator`,
        choices,
        options: choices.map(choice => choice.label),
        recommended,
        details: handoff?.details ?? null,
        context: (handoff?.context ?? `The blocker ladder's escalation ${id} was classified as the operator's by the ${who}. Its one-line reason: ${reason}`).slice(0, 4000),
        askedBy: current.agentId ?? 'nucleus',
        project: { origin: normalizeRepositoryOrigin(current.repository ?? '') ?? current.repoPath, path: current.repoPath },
        tasks: [current.id],
        by: 'nucleus',
      }, decisionId).id;
    }
    if (linkedId !== target)
      store.event(t.id, 'planner_escalation_decision_linked', `${id}: decision ${target}`);
    if (!establishEscalationWait(ladder, t.id, id, operatorWait(id, target), classification?.id ?? 0))
      throw Error(`Escalation ${id} could not establish its operator decision wait`);
  };
  if (ladder.store.db.isTransaction) write();
  else ladder.store.transaction(write);
}
