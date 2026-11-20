import type { Decision, DecisionView, Task } from '../../../shared/contracts';
import { clipDecisionQuestion, isOperatorOrigin, taskOwner, taskPlanner } from '../../../shared/contracts';
import { normalizeRepositoryOrigin } from '../../../shared/lanes';
import { Decisions } from '../../planning/decisions';
import { establishEscalationWait } from './hold';
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
  const waitEvent = events.findLast(event => event.kind === 'planner_escalation_wait' && event.detail.startsWith(`${id}:`) && event.id > linked.id
    && !events.some(superseded => superseded.kind === 'planner_escalation_wait_superseded' && superseded.id > event.id && superseded.detail.startsWith(`${id}:`))
    && (() => {
      try {
        const wait = JSON.parse(event.detail.slice(id.length + 2)) as { kind?: string; target?: string; stopDetail?: string };
        return wait.kind === 'decision' && wait.target === decisionId && wait.stopDetail === escalationWaitDetail.operator(id, decisionId);
      } catch { return false; }
    })());
  if (!waitEvent) return false;
  const stopDetail = escalationWaitDetail.operator(id, decisionId);
  const stop = ladder.store.task(taskId).resolution.stop;
  if (stop?.reason !== 'escalated' || stop.detail !== stopDetail) return false;
  try {
    const stored = ladder.store.decision(decisionId);
    if (stored.status === 'withdrawn' || isPlaceholderDecisionRecord(stored)) return false;
    return stored.links.tasks.includes(taskId);
  } catch { return false; }
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
  if (operatorDecisionApplied(ladder, t.id, id)) return;
  const current = ladder.store.task(t.id);
  let events = ladder.store.eventsAll(t.id);
  if (!events.some(event => event.kind === 'planner_escalation_decision' && event.detail.startsWith(`${id}:`)))
    ladder.store.event(t.id, 'planner_escalation_decision', `${id}: the ${who} said it cannot decide: ${reason.slice(0, 300)}`.slice(0, 4000));
  const classification = ladder.store.eventsAll(t.id).findLast(event => event.kind === 'planner_escalation_decision' && event.detail.startsWith(`${id}:`));
  const payloadEvent = events.find(event => event.kind === 'planner_escalation_payload' && event.detail.startsWith(`${id}:`));
  let question = handoff?.question ?? `The blocker escalation ${id} on "${current.title}" needs the operator.`;
  try { if (!handoff?.question && payloadEvent) question = (JSON.parse(payloadEvent.detail.slice(payloadEvent.detail.indexOf(':') + 1)) as { question?: string }).question ?? question; } catch { /* unreadable payload keeps the plain question */ }
  question = clipDecisionQuestion(question);
  const choices = handoff!.choices!.map(choice => ({ label: choice.label.trim(), consequence: choice.consequence.trim() }));
  const recommended = handoff?.recommended?.trim() || choices[0]!.label;
  const decisions = new Decisions(ladder.store);
  const linkedEvent = events.findLast(event => event.kind === 'planner_escalation_decision_linked' && event.detail.startsWith(`${id}:`));
  const linkedId = linkedEvent?.detail.match(/decision ([0-9a-f-]{36})/)?.[1];
  let decision: DecisionView | null = null;
  if (linkedId) {
    try {
      const candidate = decisions.get({ id: linkedId });
      const stored = ladder.store.decision(linkedId);
      if (candidate.links.tasks.includes(t.id) && stored.status !== 'withdrawn' && !isPlaceholderDecisionRecord(stored)) decision = candidate;
    } catch { /* a lost target is repaired with a fresh linked decision below */ }
  }
  // A previous implementation could commit the decision row before recording
  // its link. Reuse that exact escalation decision if it is still present.
  if (!decision) decision = decisions.list({ task: t.id }).find(candidate => {
    if (!candidate.links.tasks.includes(t.id) || !candidate.context?.includes(`escalation ${id} was classified as the operator's`))
      return false;
    try {
      const stored = ladder.store.decision(candidate.id);
      return stored.status !== 'withdrawn' && !isPlaceholderDecisionRecord(stored);
    } catch { return false; }
  }) ?? null;
  if (!decision) decision = decisions.add({
    question,
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
  });
  events = ladder.store.eventsAll(t.id);
  if (!events.some(event => event.kind === 'planner_escalation_decision_linked' && event.detail === `${id}: decision ${decision!.id}`))
    ladder.store.event(t.id, 'planner_escalation_decision_linked', `${id}: decision ${decision.id}`);
  const wait = { kind: 'decision' as const, target: decision.id, stopDetail: escalationWaitDetail.operator(id, decision.id), stopReason: 'escalated' as const };
  if (!establishEscalationWait(ladder, t.id, id, wait, classification?.id ?? 0))
    throw Error(`Escalation ${id} could not establish its operator decision wait`);
}
