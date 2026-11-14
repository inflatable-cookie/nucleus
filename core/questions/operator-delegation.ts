import { normalizeRepositoryOrigin } from '../../shared/lanes';
import { holdsOf, type Task } from '../../shared/contracts';
import { Decisions } from '../planning/decisions';
import type { Resolution } from '../resolution';
import { digest } from '../store/store';
import { delegateQuestion } from './planner-delegation';
import { DelegatedHostUnavailable } from './delegation';
import { isDelegableQuestionKind, operatorQuestionFor, type OperatorQuestionKind } from './operator-question';
import { DELEGATED_ANSWER_TIMEOUT_MS, applyBinaryApproval, delegatedDecisionText, nativeDelegationPrompt, parseDelegatedAnswer, parseNativeDelegatedReply, type DelegatedAnswer } from './question-delegation';

/** Delegates operator questions and handles a newly registered planner. */
export class OperatorDelegation {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  async delegateDecision(taskId: string, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; fullQuestion?: string | null },
    request: { requestId: string; header: string } | null, signal: AbortSignal,
    deliver: (task: Task, answer: string) => Promise<void>): Promise<boolean> {
    // Nothing raises an operator-only kind through here today. If something ever does, it stays with the operator.
    if (!isDelegableQuestionKind(decision.kind) || this.resolution.stopped() || signal.aborted || !this.resolution.queueBudgetQuestionCurrent(taskId, decision)) return false;
    // The planner and decider prompts carry the producer's full text when it
    // kept one; the bounded surfaces keep the short canonical question.
    const prompt = decision.fullQuestion ?? decision.question;
    const answered = () => this.store.eventsAll(taskId).some(event =>
      (event.kind === 'operator_question_answered' || event.kind === 'operator_question_stale_answered') && event.detail.startsWith(`${decision.id}:`));
    if (answered()) return false;
    const task = this.store.task(taskId);
    if (!this.store.eventsAll(taskId).some(event => event.kind === 'delegated_decision_route' && JSON.parse(event.detail).decision.id === decision.id))
      this.store.event(taskId, 'delegated_decision_route', JSON.stringify({ decision, request }));
    const budgetQuestion = decision.kind === 'budget' ? operatorQuestionFor(this.store, task) : null;
    const recordDelegatedChoice = (parsed: { choice: string; reason: string; overtakes?: string[] }) => {
      const approved = applyBinaryApproval(prompt, decision.options, parsed.choice, parsed.reason);
      const extendsBudget = budgetQuestion?.id === decision.id
        && budgetQuestion.choices.some(choice => choice.label === parsed.choice && choice.extendBudget);
      return extendsBudget ? { ...parsed, budgetAuthority: 'approve_by_default' as const, reason: `approve by default, Tom 2026-11-03 — ${parsed.reason}` }
        : approved ? { ...parsed, reason: approved.reason } : parsed;
    };
    const ask = { question: prompt, choices: decision.options, context: this.resolution.decisionContext(task) };
    let answer: DelegatedAnswer | null = null;
    // Task 1109: the task's own planner first, then the project's, then the decider.
    const { rungs, projectFailed } = await this.resolution.plannerRungsFor(task);
    const planners = rungs.map(item => ({ ...item, messageId: `queue-delegate-${decision.id}${item.rung === 'project' ? '-project' : ''}` }));
    let unknown = false;
    let result;
    try {
      result = await delegateQuestion(this.resolution, task, {
        planners, decisionId: decision.id,
        context: ask, signal,
        current: () => !answered(),
        canAdvance: () => this.resolution.queueBudgetQuestionCurrent(taskId, decision),
        parse: text => {
          const classification = parseNativeDelegatedReply(text);
          if (classification?.kind === 'operator') return classification;
          const parsed = parseDelegatedAnswer(text, decision.options);
          return parsed ? { kind: 'choice' as const, ...parsed } : null;
        },
        onIntent: (role, agentId, rung) => this.store.event(taskId, 'operator_question_delegated', `${decision.id}: ${role === 'planner' ? `${rung === 'task' ? 'task planner' : 'project planner'} ${agentId}; asked` : 'decider requested'}`),
        onSkip: (rung, agentId, detail) => this.store.event(taskId, 'operator_question_delegation_skipped', `${decision.id}: ${rung} planner ${agentId} skipped: ${detail}`.slice(0, 4000)),
        onMiss: detail => this.store.event(taskId, 'operator_question_delegation_missed', `${decision.id}: ${detail}`),
        onUnknown: (role, agentId, error) => {
          unknown = true;
          this.store.event(taskId, 'operator_question_delegation_unknown', `${decision.id}: ${role}${agentId ? ` ${agentId}` : ''}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        },
        onUnavailable: planner => {
          this.resolution.ensureQueueRaiseDecision(task, decision, `the planner ladder ran out because selected planner ${planner} cannot be asked on its host`);
        },
      });
    } catch (error) {
      if (error instanceof DelegatedHostUnavailable) return false;
      throw error;
    }
    if (this.resolution.stopped() || unknown) return false;
    if (result?.reply.kind === 'operator') {
      this.resolution.ensureQueueRaiseDecision(task, decision, `${result.role === 'planner' ? 'Planner' : 'Decider'} forwarded it: ${result.reply.reason}`);
      return false;
    }
    if (result?.reply.kind === 'choice') {
      if (result.role === 'decider' && projectFailed && result.reply.choice === 'Leave held for the planner')
        this.store.event(taskId, 'operator_question_delegation_missed', `${decision.id}: decider ${result.agentId} could not decide because the planner just failed; the question remains with the Nucleus planner`);
      else answer = { role: result.role, agentId: result.agentId, ...recordDelegatedChoice(result.reply), ...(result.role === 'decider' ? { overtakes: undefined } : {}) };
    }
    if (answered()) return false;
    if (!answer) {
      this.store.event(taskId, 'operator_question_delegation_missed', `${decision.id}: no delegated answer was produced; the question stays on its existing surface`);
      return false;
    }
    if (!this.resolution.queueBudgetQuestionCurrent(taskId, decision)) {
      const who = `delegated ${answer.role} ${answer.agentId}`;
      this.store.event(taskId, 'operator_question_stale_answered', `${decision.id}: ${answer.choice} — answered by ${who}; no effect because the question was superseded`);
      this.resolution.notifyStaleQuestionAnswer(taskId, decision.id, who);
      return false;
    }
    if (signal.aborted) return false;
    this.resolution.delegatedAnswers.set(decision.id, answer);
    this.store.event(taskId, 'operator_question_decided', `${decision.id}: ${delegatedDecisionText(answer)}; agent ${answer.agentId}`.slice(0, 4000));
    try {
      await deliver(task, answer.choice);
    } catch (error) {
      this.resolution.delegatedAnswers.delete(decision.id);
      this.store.event(taskId, 'operator_question_delegation_unknown', `${decision.id}: answer not delivered: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
      return false;
    }
    if (answer.role === 'planner' && answer.overtakes?.length) this.store.transaction(() => {
      const decisions = new Decisions(this.store);
      const reference = { kind: 'planner_answer' as const, id: taskId, sourceId: decision.id,
        label: `Planner answer to Nucleus question ${decision.id}: ${answer.choice}`.slice(0, 240), at: new Date().toISOString() };
      for (const id of [...new Set(answer.overtakes!)].slice(0, 100)) {
        try {
          decisions.markOvertaken(id, reference);
          this.store.event(taskId, 'operator_question_overtakes', `${decision.id}: ${id}`);
        } catch (error) {
          this.store.event(taskId, 'operator_question_overtakes_refused', `${decision.id}: ${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
        }
      }
    });
    return true;
  }
  async projectPlannerRegistered(projectKey: string, plannerId: string, scopedHost?: string): Promise<void> {
    if (!scopedHost) {
      const host = await this.resolution.identifyOriginHost(plannerId);
      if (!host) return;
      return this.resolution.withHost(host, () => this.projectPlannerRegistered(projectKey, plannerId, host));
    }
    if (!this.resolution.originHostAvailable(scopedHost)) return;
    if (!this.adapter.originAgent || !this.adapter.askPlanner || !this.resolution.applyOperatorControl) return;
    try {
      const registered = await this.resolution.host.originAgent(plannerId);
      if (!registered || registered.archived) return;
      const observation = await this.resolution.host.observe(plannerId);
      if (observation.id !== plannerId || observation.status === 'closed') return;
    } catch { return; }
    const project = this.store.projectByKey(projectKey);
    if (!project || project.planner?.agentId !== plannerId) return;
    for (const task of this.store.tasks()) {
      if (this.store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? ''))?.key !== projectKey
        || !holdsOf(task).merge || task.resolution.stop?.reason !== 'awaiting_proof') continue;
      const events = this.store.eventsAll(task.id);
      const heldAnswer = events.findLast(event => event.kind === 'operator_question_applied' && event.detail.includes('Leave held for the planner'));
      if (!heldAnswer) continue;
      const requestId = digest(`${task.id}:${heldAnswer.detail}:${plannerId}`);
      if (events.some(event => event.kind === 'operator_question_reasked' && event.detail.startsWith(`${requestId}:`))) continue;
      const { merge: _merge, ...otherHolds } = task.holds ?? {};
      const question = operatorQuestionFor(this.store, { ...task, held: false, mergeHold: false, holds: otherHolds });
      if (!question) continue;
      this.store.event(task.id, 'operator_question_reasked', `${requestId}: asking newly registered planner ${plannerId}`);
      const ask = { question: question.question, choices: question.choices.map(choice => choice.label), context: this.resolution.decisionContext(task) };
      let text: string | null = null;
      try {
        text = await this.resolution.askBound(task, plannerId, { prompt: nativeDelegationPrompt('planner', ask), signal: new AbortController().signal,
          timeoutMs: DELEGATED_ANSWER_TIMEOUT_MS, messageId: `queue-planner-reask-${requestId}` }, 'planner');
      } catch (error) {
        this.store.event(task.id, 'operator_question_reasked_missed', `${requestId}: planner ${plannerId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        continue;
      }
      const answer = parseDelegatedAnswer(text, ask.choices);
      if (!answer) {
        this.store.event(task.id, 'operator_question_reasked_missed', `${requestId}: planner ${plannerId} gave no usable answer`);
        continue;
      }
      const current = this.store.task(task.id);
      // The operator settled the parked question during the window: that answer wins.
      if (!holdsOf(current).merge || current.resolution.stop?.reason !== 'awaiting_proof') {
        this.store.event(task.id, 'operator_question_stale_answered', `${question.id}: ${answer.choice} — answered by delegated planner ${plannerId}; no effect because the question was already settled`.slice(0, 4000));
        this.resolution.notifyStaleQuestionAnswer(task.id, question.id, `delegated planner ${plannerId}`);
        continue;
      }
      const choice = question.choices.find(item => item.label === answer.choice);
      if (!choice || !choice.control) continue;
      const delegated = { role: 'planner' as const, agentId: plannerId, ...answer };
      this.store.event(task.id, 'operator_question_reasked_answered', `${requestId}: ${answer.choice} — ${answer.reason}`.slice(0, 4000));
      try { await this.resolution.applyOperatorControl(this.resolution.operatorAnswerControl(current, question, choice, answer.choice, delegated)); }
      catch (error) { this.store.event(task.id, 'operator_question_reasked_apply_failed', `${requestId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000)); }
    }
  }
}
