import { clipDecisionQuestion, type DecisionView, type Task } from '../../shared/contracts';
import { normalizeRepositoryOrigin } from '../../shared/lanes';
import type { TaskStopVerb } from '../../shared/task-stop';
import { escalationOutlived } from '../recovery/task-reasons';
import { Decisions } from '../planning/decisions';
import type { Resolution } from '../resolution';
import { digest } from '../store/store';
import { collectOwnerVerbFacts, ownerVerbViews } from '../verbs/owner-verbs';
import { escalationWaitDetail, escalationVerbChoices, findOpenPlannerEscalation, parseEscalationReply, plannerEscalationChoicesFor,
  plannerEscalations, reviewContinuationCauseId, reviewContinuationEscalationQuestion, type EscalationVerbChoice, type LadderEvent } from './blocker-ladder';
import { DelegatedHostUnavailable } from './delegation';
import { decisionLinkedExactly, escalationFacts, type EscalationFacts } from './escalation-events';
import { delegateQuestion } from './planner-delegation';
import { DELEGATED_ANSWER_TIMEOUT_MS, nativeDelegationPrompt } from './question-delegation';

/**
 * Owns one escalation's route: the rung it is asked on, the answer it takes, the
 * refusal that reopens it, and the operator classification when no rung can decide.
 * Every durable record it reads is decoded once by `escalation-events.ts`; the task
 * wait an answer establishes belongs to `escalation-waits.ts`.
 */
export class EscalationRouting {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  /** Spec 058 slice 17: the escalation sends this process is driving, so a rerun never double-sends. */
  readonly routingEscalations = new Set<string>();
  /** One escalation's decoded facts, or null when this task never recorded it. */
  private facts(events: LadderEvent[], id: string): EscalationFacts | null {
    return escalationFacts(events, id);
  }
  /**
   * Spec 058 cutover 5 (follow-up A): a reviewer-checkpoint stop — budget exhausted or the
   * reviewer's agent observed closed — escalates through the planner ladder instead of an owner
   * disposition. At most one escalation per cause: the recovery sweep re-reports the same stop
   * every pass, so an existing escalation is never opened again for the same episode —
   * an ordinary verb that disposes of the task changes the stop and opens a fresh cause. Returns
   * the cause id.
   */
  openReviewContinuationEscalation(t: Task, state: 'exhausted' | 'closed'): string {
    const cause = reviewContinuationCauseId(t.id, state);
    if (plannerEscalations(this.store.eventsAll(t.id) as LadderEvent[]).some(escalation => escalation.cause === cause)) return cause;
    const question = reviewContinuationEscalationQuestion(t, state);
    this.resolution.openPlannerEscalation(t, { cause, runId: null, question, payload: { cause, runId: null, reviewContinuation: state, question } });
    return cause;
  }
  /** A second refused coordinator choice reaches the existing planner ladder. */
  escalateRefusedCoordinator(t: Task, reason: string): void {
    const cause = digest(`coordinator-refused:${t.id}:${t.resolution.recovery?.id ?? ''}`);
    if (findOpenPlannerEscalation(this.store.eventsAll(t.id) as LadderEvent[], cause)) return;
    const question = `${reason} Decide which owner verb should continue this task.`;
    this.resolution.openPlannerEscalation(t, { cause, runId: t.resolution.recovery?.runId ?? null, question, payload: { cause, reason, question } });
  }
  /** Record the durable escalation intent, park the task with the planner, then route the delegate. */
  openPlannerEscalation(t: Task, input: { cause: string; runId: string | null; question: string; payload: object; suggestedVerbs?: TaskStopVerb[]; causeDetail?: string }): void {
    const events = this.store.eventsAll(t.id);
    const occurrence = plannerEscalations(events as LadderEvent[]).filter(escalation => escalation.cause === input.cause).length;
    const id = digest(['planner-escalation', t.id, input.cause, String(occurrence)].join(':'));
    const write = () => {
      this.store.event(t.id, 'planner_escalation', `${id}: cause ${input.cause}; run ${input.runId ?? 'worker'}; question ${digest(input.question)} (${input.question.length} chars); options ${plannerEscalationChoicesFor(t).join(' | ')}`);
      this.store.event(t.id, 'planner_escalation_question', `${id}: ${input.question}`.slice(0, 12000));
      this.store.event(t.id, 'planner_escalation_payload', `${id}: ${JSON.stringify({ ...input.payload, id, runId: input.runId })}`);
    };
    // A caller inside an open transaction (the review application) joins it.
    if (this.store.db.isTransaction) write(); else this.store.transaction(write);
    const waitDetail = `${escalationWaitDetail.planner(id)}${input.causeDetail ? `; reported cause: ${input.causeDetail.slice(0, 2000)}` : ''}`;
    this.resolution.waiting(this.store.task(t.id), waitDetail, 'escalated', input.suggestedVerbs);
    // The in-flight guard is synchronous, so the maintenance sweep can never start a
    // second drive; the launch itself waits for any open transaction to commit, so a
    // rollback never leaves a routing promise running against rolled-back intents.
    if (this.routingEscalations.has(id)) return;
    this.routingEscalations.add(id);
    queueMicrotask(() => {
      if (this.resolution.stopped()) { this.routingEscalations.delete(id); return; }
      void this.resolution.routePlannerEscalation(this.store.task(t.id), id, input.question)
        .catch(error => {
          if (this.resolution.stopped()) return;
          this.store.event(t.id, 'planner_escalation_unknown', `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
          this.resolution.waiting(this.store.task(t.id), escalationWaitDetail.unknown(id), 'escalated');
        })
        .finally(() => this.routingEscalations.delete(id));
    });
  }
  /** Route one recorded escalation to the project planner, then a decider; only an explicit operator classification reaches Tom. */
  async routePlannerEscalation(t: Task, id: string, question: string): Promise<void> {
    const events = () => this.store.eventsAll(t.id) as LadderEvent[];
    if (this.facts(events(), id)?.noAnswerMissed) return;
    const recoverable = this.resolution.recoverableDelegation([`ns-escalation-${id}`, `ns-decider-${id}`]);
    const observing = this.resolution.recoverableDelegation([`ns-escalation-${id}`, `ns-decider-${id}`], false);
    const recorded = this.facts(events(), id);
    if (recorded?.actionUncertain) return;
    if (recorded && (recorded.answeredRecorded || (!observing && recorded.escalation.unknown))) return;
    if (!recoverable && recorded?.sent) {
      this.store.event(t.id, 'planner_escalation_unknown', `${id}: a previous delegate delivery could not be observed; Nucleus never re-asks it`);
      this.resolution.waiting(this.store.task(t.id), escalationWaitDetail.unknown(id), 'escalated');
      return;
    }
    if (!recoverable) this.store.event(t.id, 'planner_escalation_sent', `${id}: sent`);
    const context = this.resolution.decisionContext(t);
    if (recorded?.unreadable.offered) throw Error(`Escalation ${id}: the recorded offer is not readable`);
    const offered: EscalationVerbChoice[] = recorded?.offered
      ?? escalationVerbChoices(ownerVerbViews(collectOwnerVerbFacts(this.store, this.store.task(t.id))));
    if (!recorded?.offered) this.store.event(t.id, 'planner_escalation_offered', `${id}: ${JSON.stringify(offered)}`);
    const choices = [...plannerEscalationChoicesFor(t), ...offered.map(item => item.label)];
    if (recorded?.unreadable.payload) throw Error(`Escalation ${id}: the recorded payload is not readable`);
    const runId = recorded?.payload?.runId ?? undefined;
    const sourceAgentId = runId ? this.store.run(runId)?.agentId ?? t.agentId ?? undefined : t.agentId ?? undefined;
    let pending = false;
    // Task 1109: the task's own planner first, then the project planner, then the decider.
    const rungs = (await this.resolution.plannerRungsFor(t)).rungs;
    const delegated = await delegateQuestion(this.resolution, t, {
      planners: rungs.map(item => ({ ...item, messageId: `ns-escalation-${id}${item.rung === 'project' ? '-project' : ''}` })), decisionId: id,
      context: { question, choices, context }, signal: new AbortController().signal, sourceAgentId,
      parse: text => parseEscalationReply(text, choices), retainDecider: true,
      current: () => !plannerEscalations(events()).find(item => item.id === id)?.answered,
      canAdvance: () => !escalationOutlived(this.store.task(t.id)),
      onIntent: (role, agentId, rung) => {
        if (role === 'planner') this.resolution.waiting(this.store.task(t.id), `Waiting with the planner or task owner ${agentId}: blocker escalation ${id} (${rung === 'task' ? 'task planner' : 'project planner'} rung) is open`, 'escalated');
        this.store.event(t.id, 'planner_escalation_delegated', `${id}: ${role === 'planner' ? `${rung === 'task' ? 'task planner' : 'project planner'} ${agentId}; asked` : 'decider requested'}`);
      },
      onSkip: (rung, agentId, detail) => this.store.event(t.id, 'planner_escalation_delegation_skipped', `${id}: ${rung} planner ${agentId} skipped: ${detail}`.slice(0, 4000)),
      onMiss: detail => this.store.event(t.id, 'planner_escalation_missed', `${id}: ${detail}`),
      onUnknown: (role, agentId, error) => {
        pending = true;
        if (plannerEscalations(events()).find(item => item.id === id)?.answered) return;
        this.store.event(t.id, 'planner_escalation_unknown', `${id}: ${role}${agentId ? ` ${agentId}` : ''}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        this.resolution.waiting(this.store.task(t.id), escalationWaitDetail.unknown(id), 'escalated');
      },
    }).catch(error => { if (!(error instanceof DelegatedHostUnavailable)) throw error; pending = true; return null; });
    if (pending || this.resolution.stopped()) return;
    const reply = delegated?.reply ?? null;
    const who = delegated ? `${delegated.role} ${delegated.agentId}` : null;
    const archiveDecider = async () => {
      if (delegated?.role !== 'decider') return;
      try { await this.resolution.host.archiveAgent(delegated.agentId); }
      catch (error) {
        this.store.event(t.id, 'planner_escalation_archive_failed', `${id}: decider ${delegated.agentId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
      }
    };
    if (!reply && escalationOutlived(this.store.task(t.id))) {
      this.store.event(t.id, 'planner_escalation_answered', `${id}: answered by ordinary progress: the task merged or ended first`);
      return;
    }
    if (plannerEscalations(events()).find(item => item.id === id)?.answered) return;
    if (!reply || !who) {
      this.store.event(t.id, 'planner_escalation_missed', `${id}: no delegated answer was produced; the escalation stays open for the planner`);
      return;
    }
    if (reply.kind === 'operator') {
      await archiveDecider();
      this.resolution.classifyEscalationToOperator(this.store.task(t.id), id, reply.reason, who);
      return;
    }
    const answer = reply.kind === 'choice' ? `${reply.choice} — ${reply.reason}`.trim() : reply.answer;
    const initialQuestionId = delegated?.role === 'decider'
      ? `ns-decider-${id}`
      : delegated?.rung === 'project' ? `ns-escalation-${id}-project` : `ns-escalation-${id}`;
    let refusal = this.facts(events(), id)?.lastRefusal
      ?? await this.resolution.escalationSettlement.settlePlannerEscalation(this.store.task(t.id), id, answer, who, offered, initialQuestionId, delegated!);
    if (refusal) {
      if (this.facts(events(), id)?.unreadable.followup) throw Error(`Escalation ${id}: the recorded follow-up offer is not readable`);
      const followup = this.facts(events(), id)?.followup ?? null;
      const followupQuestionId = followup?.questionId ?? `ns-escalation-refusal-${id}`;
      const currentOffers = followup?.ownerChoices ?? escalationVerbChoices(ownerVerbViews(collectOwnerVerbFacts(this.store, this.store.task(t.id))));
      const retryChoices = followup?.choices ?? [...plannerEscalationChoicesFor(this.store.task(t.id)), ...currentOffers.map(item => item.label)];
      if (!followup) this.store.event(t.id, 'planner_escalation_followup_offered', `${id}: ${JSON.stringify({ questionId: followupQuestionId, choices: retryChoices, ownerChoices: currentOffers })}`);
      if (!this.facts(events(), id)?.refusalSent)
        this.store.event(t.id, 'planner_escalation_refusal_sent', `${id}: ${refusal}`.slice(0, 4000));
      try {
        const recipient = delegated!.agentId;
        const followupReply = await this.resolution.askBound(this.store.task(t.id), recipient, {
          prompt: nativeDelegationPrompt('planner', { question: `Your choice was refused: ${refusal}. Choose again for the same escalation.`, choices: retryChoices, context }),
          signal: new AbortController().signal, timeoutMs: DELEGATED_ANSWER_TIMEOUT_MS,
          messageId: followupQuestionId, sourceAgentId,
        }, 'planner');
        if (plannerEscalations(events()).find(item => item.id === id)?.answered) return;
        const next = parseEscalationReply(followupReply, retryChoices);
        if (next?.kind === 'operator') this.resolution.classifyEscalationToOperator(this.store.task(t.id), id, next.reason, who);
        else if (next) {
          const nextAnswer = next.kind === 'choice' ? `${next.choice} — ${next.reason}` : next.answer;
          refusal = await this.resolution.escalationSettlement.settlePlannerEscalation(this.store.task(t.id), id, nextAnswer, who, currentOffers, followupQuestionId, delegated!);
        }
      } catch (error) {
        this.store.event(t.id, 'planner_escalation_unknown', `${id}: refusal follow-up delivery: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
      }
    }
    await archiveDecider();
  }
  /** A planner or decider that explicitly says it cannot decide reaches the operator: one Spec 032 decision. */
  operatorDecisionApplied(taskId: string, id: string): boolean {
    const events = this.store.eventsAll(taskId) as LadderEvent[];
    const link = this.facts(events, id)?.decisionLink ?? null;
    if (!link) return false;
    const stopDetail = escalationWaitDetail.operator(id, link.decisionId);
    const appliedWait = (this.facts(events, id)?.waits ?? []).findLast(record => record.eventId > link.eventId
      && record.wait?.kind === 'decision' && record.wait.target === link.decisionId && record.wait.stopDetail === stopDetail);
    if (!appliedWait) return false;
    const stop = this.store.task(taskId).resolution.stop;
    if (stop?.reason !== 'escalated' || stop.detail !== stopDetail) return false;
    try { return new Decisions(this.store).get({ id: link.decisionId }).links.tasks.includes(taskId); }
    catch { return false; }
  }
  classifyEscalationToOperator(t: Task, id: string, reason: string, who: string): void {
    if (this.operatorDecisionApplied(t.id, id)) return;
    const current = this.store.task(t.id);
    let events = this.store.eventsAll(t.id) as LadderEvent[];
    if (this.operatorDecisionApplied(t.id, id)) return;
    const recorded = this.facts(events, id);
    if (recorded?.decidedEventId == null)
      this.store.event(t.id, 'planner_escalation_decision', `${id}: the ${who} said it cannot decide: ${reason.slice(0, 300)}`.slice(0, 4000));
    const classification = this.facts(this.store.eventsAll(t.id) as LadderEvent[], id)?.decidedEventId ?? null;
    const question = clipDecisionQuestion(recorded?.payload?.question
      ?? `The blocker escalation ${id} on "${current.title}" needs the operator.`);
    const decisions = new Decisions(this.store);
    const linkedId = recorded?.decisionLink?.decisionId ?? null;
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
    events = this.store.eventsAll(t.id) as LadderEvent[];
    if (!decisionLinkedExactly(events, id, decision.id))
      this.store.event(t.id, 'planner_escalation_decision_linked', `${id}: decision ${decision.id}`);
    const wait = { kind: 'decision' as const, target: decision.id, stopDetail: escalationWaitDetail.operator(id, decision.id), stopReason: 'escalated' as const };
    if (!this.resolution.escalationWaits.establishEscalationWait(t.id, id, wait, classification ?? 0))
      throw Error(`Escalation ${id} could not establish its operator decision wait`);
  }
}
