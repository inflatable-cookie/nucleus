import type { Task, TaskStopVerb } from '../../../shared/contracts';
import { digest } from '../../store/store';
import { DELEGATED_ANSWER_TIMEOUT_MS, nativeDelegationPrompt } from '../question-delegation';
import { delegateQuestion } from '../planner-delegation';
import { DelegatedHostUnavailable } from '../delegation';
import { escalationOutlived } from '../../recovery/task-reasons';
import { collectOwnerVerbFacts, ownerVerbViews } from '../../verbs/owner-verbs';
import type { Ladder } from './ladder';
import { escalationVerbChoices, plannerEscalationChoicesFor, type EscalationVerbChoice } from './questions';
import { plannerEscalations, type LadderEvent } from './records';
import { parseEscalationReply } from './replies';
import { escalationWaitDetail } from './waits';
import { closeEscalationFollowups } from './continuation';

/**
 * Routing one recorded escalation: the durable intent and wait the caller records,
 * then the rungs it travels — the task's own planner, the project's planner, the
 * decider — and the refusal follow-up. A send whose outcome nobody observed is
 * fenced here; it is never re-asked.
 */

/** What the caller records before any send: the cause, the question and its payload. */
export type OpenEscalationInput = {
  cause: string;
  runId: string | null;
  question: string;
  payload: object;
  suggestedVerbs?: TaskStopVerb[];
  causeDetail?: string;
};

/** Record the durable escalation intent, park the task with the planner, then route the delegate. */
export function openPlannerEscalation(ladder: Ladder, t: Task, input: OpenEscalationInput): void {
  const events = ladder.store.eventsAll(t.id);
  const occurrence = plannerEscalations(events as LadderEvent[]).filter(escalation => escalation.cause === input.cause).length;
  const id = digest(['planner-escalation', t.id, input.cause, String(occurrence)].join(':'));
  const write = () => {
    ladder.store.event(t.id, 'planner_escalation', `${id}: cause ${input.cause}; run ${input.runId ?? 'worker'}; question ${digest(input.question)} (${input.question.length} chars); options ${plannerEscalationChoicesFor(t).join(' | ')}`);
    ladder.store.event(t.id, 'planner_escalation_question', `${id}: ${input.question}`.slice(0, 12000));
    ladder.store.event(t.id, 'planner_escalation_payload', `${id}: ${JSON.stringify({ ...input.payload, id, runId: input.runId })}`);
  };
  // A caller inside an open transaction (the review application) joins it.
  if (ladder.store.db.isTransaction) write(); else ladder.store.transaction(write);
  const waitDetail = `${escalationWaitDetail.planner(id)}${input.causeDetail ? `; reported cause: ${input.causeDetail.slice(0, 2000)}` : ''}`;
  ladder.resolution.waiting(ladder.store.task(t.id), waitDetail, 'escalated', { suggestedVerbs: input.suggestedVerbs });
  // The in-flight guard is synchronous, so the maintenance sweep can never start a
  // second drive; the launch itself waits for any open transaction to commit, so a
  // rollback never leaves a routing promise running against rolled-back intents.
  if (ladder.routingEscalations.has(id)) return;
  ladder.routingEscalations.add(id);
  queueMicrotask(() => {
    if (ladder.resolution.stopped()) { ladder.routingEscalations.delete(id); return; }
    void ladder.resolution.routePlannerEscalation(ladder.store.task(t.id), id, input.question)
      .catch(error => {
        if (ladder.resolution.stopped()) return;
        ladder.store.event(t.id, 'planner_escalation_unknown', `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        ladder.resolution.waiting(ladder.store.task(t.id), escalationWaitDetail.unknown(id), 'escalated');
      })
      .finally(() => ladder.routingEscalations.delete(id));
  });
}

/** Route one recorded escalation to the project planner, then a decider; only an explicit operator classification reaches Tom. */
export async function routePlannerEscalation(ladder: Ladder, t: Task, id: string, question: string): Promise<void> {
  const events = () => ladder.store.eventsAll(t.id);
  if (events().some(event => event.kind === 'planner_escalation_missed' && event.detail.startsWith(`${id}: no delegated answer was produced;`))) return;
  const recoverable = ladder.resolution.recoverableDelegation([`ns-escalation-${id}`, `ns-decider-${id}`]);
  const observing = ladder.resolution.recoverableDelegation([`ns-escalation-${id}`, `ns-decider-${id}`], false);
  if (events().some(event => event.kind === 'planner_escalation_action_uncertain' && event.detail.startsWith(`${id}:`))) return;
  if (events().some(event => (['planner_escalation_answered', 'planner_escalation_resolved'].includes(event.kind) || (!observing && event.kind === 'planner_escalation_unknown')) && event.detail.startsWith(`${id}:`))) return;
  if (!recoverable && events().some(event => event.kind === 'planner_escalation_sent' && event.detail.startsWith(`${id}:`))) {
    ladder.store.event(t.id, 'planner_escalation_unknown', `${id}: a previous delegate delivery could not be observed; Nucleus never re-asks it`);
    ladder.resolution.waiting(ladder.store.task(t.id), escalationWaitDetail.unknown(id), 'escalated');
    return;
  }
  if (!recoverable) ladder.store.event(t.id, 'planner_escalation_sent', `${id}: sent`);
  const context = ladder.resolution.decisionContext(t);
  const offerEvent = events().find(event => event.kind === 'planner_escalation_offered' && event.detail.startsWith(`${id}: `));
  const offered: EscalationVerbChoice[] = offerEvent
    ? JSON.parse(offerEvent.detail.slice(id.length + 2)) as EscalationVerbChoice[]
    : escalationVerbChoices(ownerVerbViews(collectOwnerVerbFacts(ladder.store, ladder.store.task(t.id))));
  if (!offerEvent) ladder.store.event(t.id, 'planner_escalation_offered', `${id}: ${JSON.stringify(offered)}`);
  const choices = [...plannerEscalationChoicesFor(t), ...offered.map(item => item.label)];
  const payload = events().find(event => event.kind === 'planner_escalation_payload'  && event.detail.startsWith(`${id}: `));
  const runId = payload ? (JSON.parse(payload.detail.slice(id.length + 2)) as { runId?: string }).runId : undefined;
  const sourceAgentId = runId ? ladder.store.run(runId)?.agentId ?? t.agentId ?? undefined : t.agentId ?? undefined;
  let pending = false;
  // Task 1109: the task's own planner first, then the project planner, then the decider.
  const rungs = (await ladder.resolution.plannerRungsFor(t)).rungs;
  const delegated = await delegateQuestion(ladder.resolution, t, {
    planners: rungs.map(item => ({ ...item, messageId: `ns-escalation-${id}${item.rung === 'project' ? '-project' : ''}` })), decisionId: id,
    context: { question, choices, context }, signal: new AbortController().signal, sourceAgentId,
    parse: text => parseEscalationReply(text, choices), retainDecider: true,
    current: () => !plannerEscalations(events() as LadderEvent[]).find(item => item.id === id)?.answered,
    canAdvance: () => !escalationOutlived(ladder.store.task(t.id)),
    onIntent: (role, agentId, rung) => {
      if (role === 'planner') ladder.resolution.waiting(ladder.store.task(t.id), `Waiting with the planner or task owner ${agentId}: blocker escalation ${id} (${rung === 'task' ? 'task planner' : 'project planner'} rung) is open`, 'escalated', { holderAgentId: agentId });
      ladder.store.event(t.id, 'planner_escalation_delegated', `${id}: ${role === 'planner' ? `${rung === 'task' ? 'task planner' : 'project planner'} ${agentId}; asked` : 'decider requested'}`);
    },
    onSkip: (rung, agentId, detail) => ladder.store.event(t.id, 'planner_escalation_delegation_skipped', `${id}: ${rung} planner ${agentId} skipped: ${detail}`.slice(0, 4000)),
    onMiss: detail => ladder.store.event(t.id, 'planner_escalation_missed', `${id}: ${detail}`),
    onUnknown: (role, agentId, error) => {
      pending = true;
      if (plannerEscalations(events() as LadderEvent[]).find(item => item.id === id)?.answered) return;
      ladder.store.event(t.id, 'planner_escalation_unknown', `${id}: ${role}${agentId ? ` ${agentId}` : ''}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
      ladder.resolution.waiting(ladder.store.task(t.id), escalationWaitDetail.unknown(id), 'escalated');
    },
  }).catch(error => { if (!(error instanceof DelegatedHostUnavailable)) throw error; pending = true; return null; });
  if (pending || ladder.resolution.stopped()) return;
  const reply = delegated?.reply ?? null;
  const who = delegated ? `${delegated.role} ${delegated.agentId}` : null;
  const archiveDecider = async () => {
    if (delegated?.role !== 'decider') return;
    try { await ladder.resolution.host.archiveAgent(delegated.agentId); }
    catch (error) {
      ladder.store.event(t.id, 'planner_escalation_archive_failed', `${id}: decider ${delegated.agentId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
    }
  };
  if (!reply && escalationOutlived(ladder.store.task(t.id))) {
    ladder.store.event(t.id, 'planner_escalation_answered', `${id}: answered by ordinary progress: the task merged or ended first`);
    closeEscalationFollowups(ladder.store, t.id, id);
    return;
  }
  if (plannerEscalations(events() as LadderEvent[]).find(item => item.id === id)?.answered) return;
  if (!reply || !who) {
    ladder.store.event(t.id, 'planner_escalation_missed', `${id}: no delegated answer was produced; the escalation stays open for the planner`);
    return;
  }
  if (reply.kind === 'operator') {
    await archiveDecider();
    ladder.resolution.classifyEscalationToOperator(ladder.store.task(t.id), id, reply.reason, who);
    return;
  }
  const answer = reply.kind === 'choice' ? `${reply.choice} — ${reply.reason}`.trim() : reply.answer;
  const recordedRefusal = events().findLast(event => event.kind === 'planner_escalation_answer_refused' && event.detail.startsWith(`${id}:`));
  const initialQuestionId = delegated?.role === 'decider'
    ? `ns-decider-${id}`
    : delegated?.rung === 'project' ? `ns-escalation-${id}-project` : `ns-escalation-${id}`;
  let refusal = recordedRefusal
    ? recordedRefusal.detail.slice(`${id}:`.length).trim()
    : await ladder.resolution.escalationSettlement.settlePlannerEscalation(ladder.store.task(t.id), id, answer, who, offered, initialQuestionId, delegated!);
  if (refusal) {
    const priorFollowup = events().findLast(event => event.kind === 'planner_escalation_followup_offered' && event.detail.startsWith(`${id}: `));
    const followupOffer = priorFollowup
      ? JSON.parse(priorFollowup.detail.slice(id.length + 2)) as { questionId: string; choices: string[]; ownerChoices: EscalationVerbChoice[] }
      : null;
    const followupQuestionId = followupOffer?.questionId ?? `ns-escalation-refusal-${id}`;
    const currentOffers = followupOffer?.ownerChoices ?? escalationVerbChoices(ownerVerbViews(collectOwnerVerbFacts(ladder.store, ladder.store.task(t.id))));
    const retryChoices = followupOffer?.choices ?? [...plannerEscalationChoicesFor(ladder.store.task(t.id)), ...currentOffers.map(item => item.label)];
    if (!followupOffer) ladder.store.event(t.id, 'planner_escalation_followup_offered', `${id}: ${JSON.stringify({ questionId: followupQuestionId, choices: retryChoices, ownerChoices: currentOffers })}`);
    if (!events().some(event => event.kind === 'planner_escalation_refusal_sent' && event.detail.startsWith(`${id}:`)))
      ladder.store.event(t.id, 'planner_escalation_refusal_sent', `${id}: ${refusal}`.slice(0, 4000));
    try {
      const recipient = delegated!.agentId;
      const followup = await ladder.resolution.askBound(ladder.store.task(t.id), recipient, {
        prompt: nativeDelegationPrompt('planner', { question: `Your choice was refused: ${refusal}. Choose again for the same escalation.`, choices: retryChoices, context }),
        signal: new AbortController().signal, timeoutMs: DELEGATED_ANSWER_TIMEOUT_MS,
        messageId: followupQuestionId, sourceAgentId,
      }, 'planner');
      if (plannerEscalations(events() as LadderEvent[]).find(item => item.id === id)?.answered) return;
      const next = parseEscalationReply(followup, retryChoices);
      if (next?.kind === 'operator') ladder.resolution.classifyEscalationToOperator(ladder.store.task(t.id), id, next.reason, who);
      else if (next) {
        const nextAnswer = next.kind === 'choice' ? `${next.choice} — ${next.reason}` : next.answer;
        refusal = await ladder.resolution.escalationSettlement.settlePlannerEscalation(ladder.store.task(t.id), id, nextAnswer, who, currentOffers, followupQuestionId, delegated!);
      }
    } catch (error) {
      ladder.store.event(t.id, 'planner_escalation_unknown', `${id}: refusal follow-up delivery: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
    }
  }
  await archiveDecider();
}
