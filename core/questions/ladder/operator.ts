import type { DecisionView, Task } from '../../../shared/contracts';
import { clipDecisionQuestion } from '../../../shared/contracts';
import { normalizeRepositoryOrigin } from '../../../shared/lanes';
import { Decisions } from '../../planning/decisions';
import { establishEscalationWait } from './hold';
import type { Ladder } from './ladder';
import { escalationWaitDetail } from './waits';

/**
 * The ladder's last rung: a planner or decider that explicitly says it cannot
 * decide reaches the operator as one Spec 032 decision, and the task waits on that
 * decision instead of on a planner. Nothing else opens an operator decision.
 */

/** A planner or decider that explicitly says it cannot decide reaches the operator: one Spec 032 decision. */
export function operatorDecisionApplied(ladder: Ladder, taskId: string, id: string): boolean {
  const events = ladder.store.eventsAll(taskId);
  const linked = events.findLast(event => event.kind === 'planner_escalation_decision_linked' && event.detail.startsWith(`${id}:`));
  const decisionId = linked?.detail.match(/decision ([0-9a-f-]{36})/)?.[1];
  if (!linked || !decisionId) return false;
  const waitEvent = events.findLast(event => event.kind === 'planner_escalation_wait' && event.detail.startsWith(`${id}:`) && event.id > linked.id && (() => {
    try {
      const wait = JSON.parse(event.detail.slice(id.length + 2)) as { kind?: string; target?: string; stopDetail?: string };
      return wait.kind === 'decision' && wait.target === decisionId && wait.stopDetail === escalationWaitDetail.operator(id, decisionId);
    } catch { return false; }
  })());
  if (!waitEvent) return false;
  const stopDetail = escalationWaitDetail.operator(id, decisionId);
  const stop = ladder.store.task(taskId).resolution.stop;
  if (stop?.reason !== 'escalated' || stop.detail !== stopDetail) return false;
  try { return new Decisions(ladder.store).get({ id: decisionId }).links.tasks.includes(taskId); }
  catch { return false; }
}

/** Classify one escalation as the operator's: record the decision, link it and hold its wait. */
export function classifyEscalationToOperator(ladder: Ladder, t: Task, id: string, reason: string, who: string): void {
  if (operatorDecisionApplied(ladder, t.id, id)) return;
  const current = ladder.store.task(t.id);
  let events = ladder.store.eventsAll(t.id);
  if (!events.some(event => event.kind === 'planner_escalation_decision' && event.detail.startsWith(`${id}:`)))
    ladder.store.event(t.id, 'planner_escalation_decision', `${id}: the ${who} said it cannot decide: ${reason.slice(0, 300)}`.slice(0, 4000));
  const classification = ladder.store.eventsAll(t.id).findLast(event => event.kind === 'planner_escalation_decision' && event.detail.startsWith(`${id}:`));
  const payloadEvent = events.find(event => event.kind === 'planner_escalation_payload' && event.detail.startsWith(`${id}:`));
  let question = `The blocker escalation ${id} on "${current.title}" needs the operator.`;
  try { if (payloadEvent) question = (JSON.parse(payloadEvent.detail.slice(payloadEvent.detail.indexOf(':') + 1)) as { question?: string }).question ?? question; } catch { /* unreadable payload keeps the plain question */ }
  question = clipDecisionQuestion(question);
  const decisions = new Decisions(ladder.store);
  const linkedEvent = events.findLast(event => event.kind === 'planner_escalation_decision_linked' && event.detail.startsWith(`${id}:`));
  const linkedId = linkedEvent?.detail.match(/decision ([0-9a-f-]{36})/)?.[1];
  let decision: DecisionView | null = null;
  if (linkedId) {
    try {
      const candidate = decisions.get({ id: linkedId });
      if (candidate.links.tasks.includes(t.id)) decision = candidate;
    } catch { /* a lost target is repaired with a fresh linked decision below */ }
  }
  // A previous implementation could commit the decision row before recording
  // its link. Reuse that exact escalation decision if it is still present.
  if (!decision) decision = decisions.list({ task: t.id }).find(candidate => candidate.links.tasks.includes(t.id)
    && Boolean(candidate.context?.includes(`escalation ${id} was classified as the operator's`))) ?? null;
  if (!decision) decision = decisions.add({
    question, headline: `Blocker escalation on ${current.reference ?? current.id} needs the operator`,
    context: `The blocker ladder's escalation ${id} was classified as the operator's by the ${who}. Its one-line reason: ${reason}`.slice(0, 4000),
    askedBy: current.agentId ?? 'nucleus', project: { origin: normalizeRepositoryOrigin(current.repository ?? '') ?? current.repoPath, path: current.repoPath },
    tasks: [current.id], by: 'nucleus',
  });
  events = ladder.store.eventsAll(t.id);
  if (!events.some(event => event.kind === 'planner_escalation_decision_linked' && event.detail === `${id}: decision ${decision!.id}`))
    ladder.store.event(t.id, 'planner_escalation_decision_linked', `${id}: decision ${decision.id}`);
  const wait = { kind: 'decision' as const, target: decision.id, stopDetail: escalationWaitDetail.operator(id, decision.id), stopReason: 'escalated' as const };
  if (!establishEscalationWait(ladder, t.id, id, wait, classification?.id ?? 0))
    throw Error(`Escalation ${id} could not establish its operator decision wait`);
}
