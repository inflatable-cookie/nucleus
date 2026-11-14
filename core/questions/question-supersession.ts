import type { Task } from '../../shared/contracts';
import { taskBudget } from '../../shared/task-budget';
import { Decisions } from '../planning/decisions';
import type { Resolution } from '../resolution';

/** The recorded budget questions a task carries: their ids, in event order. */
function budgetQuestionIds(events: Array<{ kind: string; detail: string }>): string[] {
  return [...new Set(events
    .filter(event => event.kind === 'operator_question' && event.detail.includes('kind budget'))
    .map(event => event.detail.split(':', 1)[0]!)
    .filter(Boolean))];
}

/** Owns supersession and dismissal of stale task questions. */
export class QuestionSupersession {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  extendTaskBudget(taskId: string, detail: string, by = 'The operator'): Task | null {
    const current = this.store.task(taskId);
    const events = this.store.eventsAll(taskId);
    if (!taskBudget(current, this.store.runs(taskId), Date.now(), events,
      this.store.canonicalRepository(current.repoPath, current.repository)).exhausted) return null;
    const wasBudgetPause = current.resolution.stop?.reason === 'budget';
    // Papercut 7cb34906 (2026-11-10): a budget extended through a verb left
    // Nucleus's own budget questions pending on the worker thread; launches then
    // declined ("retained worker still owns its turn: pending question") until a
    // person answered them by hand. Every recorded budget question belongs to the
    // budget stop this extension clears — including one already answered at the
    // board whose native prompt is still pending on the thread — so all of them
    // are superseded and dismissed through the host, the same supersession #975
    // applies to asks.
    const updated = this.store.transaction(() => {
      const next = this.resolution.update(current, { ...(wasBudgetPause ? { stop: null } : {}), budgetExtensions: current.resolution.budgetExtensions + 1 },
        wasBudgetPause ? { reason: `${by} extended the budget by one default increment; the next run may start` }
          : {}, 'budget_extended', detail);
      this.supersedeBudgetQuestionsInTransaction(taskId, 'The exhausted budget was extended.');
      return next;
    });
    this.settleSupersededBudgetQuestions(taskId);
    return updated;
  }
  /**
   * Every recorded budget question the task still carries, superseded with its
   * native prompt dismissed and any linked board decision withdrawn, so nobody
   * answers a pause that no longer exists and no answer can change the task. The
   * pause is gone two ways: an extension lifted it, or the measured budget stopped
   * showing it (nucleus#1187).
   */
  supersedeBudgetQuestions(taskId: string, reason: string): string[] {
    const marks = () => this.supersedeBudgetQuestionsInTransaction(taskId, reason);
    if (this.store.db.isTransaction) marks(); else this.store.transaction(marks);
    return this.settleSupersededBudgetQuestions(taskId);
  }
  private supersedeBudgetQuestionsInTransaction(taskId: string, reason: string): void {
    const events = this.store.eventsAll(taskId);
    const marked = (kind: string, id: string) => events.some(event => event.kind === kind && event.detail.startsWith(`${id}:`));
    for (const questionId of budgetQuestionIds(events)) {
      if (!marked('operator_question_superseded', questionId))
        this.store.event(taskId, 'operator_question_superseded', `${questionId}: ${reason}`);
      if (!marked('native_question_dismiss_intent', questionId))
        this.store.event(taskId, 'native_question_dismiss_intent', `${questionId}: ${reason}`);
      const decisionLink = events.find(event => event.kind === 'operator_question_decision'
        && event.detail.startsWith(`${questionId}: decision `));
      const decisionId = decisionLink?.detail.match(/decision ([^;\s]+)/)?.[1];
      if (decisionId) {
        const decision = this.store.decision(decisionId);
        if (decision.status === 'open') new Decisions(this.store).withdrawInTransaction({ id: decisionId, version: decision.version,
          reason, withdrawnBy: 'nucleus' });
      }
    }
  }
  /**
   * Abort the in-turn waits and dismiss the native prompts of the recorded budget
   * questions. Runs after the write that superseded them: a host call belongs
   * outside the transaction that records the intent.
   */
  private settleSupersededBudgetQuestions(taskId: string): string[] {
    const ids = budgetQuestionIds(this.store.eventsAll(taskId));
    for (const questionId of ids) this.resolution.responsibleQuestions.get(questionId)?.abort();
    this.dismissSupersededNativeQuestions(taskId, ids);
    return ids;
  }
  supersedeOpenOwnerQuestions(taskId: string, reason: string): void {
    const events = this.store.eventsAll(taskId);
    const settled = (kind: string, id: string) => events.some(event => event.kind === kind && event.detail.startsWith(`${id}:`));
    const supersededIds: string[] = [];
    const supersede = (questionKind: 'operator_question' | 'responsible_question', markerKind: 'operator_question_superseded' | 'responsible_question_superseded') => {
      const answeredKind = questionKind === 'operator_question' ? 'operator_question_answered' : 'responsible_question_answered';
      for (const event of events.filter(item => item.kind === questionKind)) {
        const id = event.detail.split(':', 1)[0]!;
        if (!id || settled(answeredKind, id) || settled(markerKind, id)) continue;
        this.store.event(taskId, markerKind, `${id}: ${reason}`.slice(0, 2000));
        this.resolution.responsibleQuestions.get(id)?.abort();
        supersededIds.push(id);
        if (questionKind === 'operator_question') {
          const link = events.find(item => item.kind === 'operator_question_decision' && item.detail.startsWith(`${id}: decision `));
          const decisionId = link?.detail.match(/decision ([^;\s]+)/)?.[1];
          if (decisionId) {
            const decision = this.store.decision(decisionId);
            if (decision.status === 'open') new Decisions(this.store).withdrawInTransaction({ id: decisionId, version: decision.version,
              reason, withdrawnBy: 'nucleus' });
          }
          const askRaise = this.resolution.queueAskRaises.get(id);
          if (askRaise) { this.resolution.queueAskRaises.delete(id); this.resolution.queueAskRaiseAnsweredBy.delete(id); askRaise.reject(Error('Question superseded by an applied owner control')); }
          this.resolution.delegatedAnswers.delete(id);
        }
      }
    };
    this.store.transaction(() => {
      supersede('operator_question', 'operator_question_superseded');
      supersede('responsible_question', 'responsible_question_superseded');
      for (const event of events.filter(item => item.kind === 'agent_ask')) {
        const id = event.detail.split(':', 1)[0]!;
        if (!id || settled('agent_ask_answered', id) || settled('agent_ask_superseded', id)) continue;
        this.store.event(taskId, 'agent_ask_superseded', `${id}: ${reason}`.slice(0, 2000));
        const link = events.find(item => item.kind === 'agent_ask_decision' && item.detail.startsWith(`${id}: decision `));
        const decisionId = link?.detail.match(/decision ([^;\s]+)/)?.[1];
        if (decisionId) {
          const decision = this.store.decision(decisionId);
          if (decision.status === 'open') new Decisions(this.store).withdrawInTransaction({ id: decisionId, version: decision.version,
            reason, withdrawnBy: 'nucleus' });
        }
      }
      for (const id of supersededIds) {
        if (events.some(item => item.kind === 'native_question_dismiss_intent' && item.detail.startsWith(`${id}:`))) continue;
        this.store.event(taskId, 'native_question_dismiss_intent', `${id}: ${reason}`.slice(0, 2000));
      }
    });
    this.dismissSupersededNativeQuestions(taskId, supersededIds);
  }
  /** Host-dismiss Nucleus-raised native questions whose observer was aborted. Tool and bash permissions stay. */
  private dismissSupersededNativeQuestions(taskId: string, ids: string[]): void {
    if (!ids.length) return;
    const task = this.store.task(taskId);
    if (!task.hostId) return;
    if (!this.resolution.withHost(task.hostId, () => this.resolution.originHostAvailable(task.hostId!)
      && Boolean(this.adapter.pendingQuestions) && Boolean(this.adapter.dismissNativeQuestion))) return;
    const agents = this.nativeQuestionAgents(task);
    // Recorded native requestIds from the raise (durable) plus the text-prefix
    // fallback for questions raised before the link was recorded.
    const recorded = new Map<string, string[]>();
    for (const event of this.store.eventsAll(taskId)) {
      if (event.kind !== 'operator_question_native_request') continue;
      const id = event.detail.split(':')[0]!;
      if (!ids.includes(id)) continue;
      const requestId = event.detail.match(/request (\S+)/)?.[1];
      if (requestId) recorded.set(requestId, [...(recorded.get(requestId) ?? []), id]);
    }
    void this.resolution.withHost(task.hostId, async () => {
      for (const agent of agents) {
        let pending: Array<{ requestId: string; questions: Array<{ header: string; question: string; options: string[] }> }>;
        try { pending = await this.adapter.pendingQuestions!(agent.agentId); }
        catch (error) {
          this.store.event(taskId, 'native_question_pending_unknown', `${agent.agentId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
          continue;
        }
        for (const request of pending) {
          const byRecorded = recorded.get(request.requestId);
          const match = byRecorded?.find(id => ids.includes(id))
            ?? ids.find(id => request.questions.some(question => question.question.startsWith(`[Queue decision ${id}]`)));
          if (!match) continue;
          try {
            await this.adapter.dismissNativeQuestion!(agent.agentId, agent.workspaceId, request.requestId);
            if (!this.store.eventsAll(taskId).some(item => item.kind === 'native_question_dismissed' && item.detail.startsWith(`${match}:`)))
              this.store.event(taskId, 'native_question_dismissed', `${match}: request ${request.requestId} on ${agent.agentId}`);
          } catch (error) {
            this.store.event(taskId, 'native_question_dismiss_unknown', `${match}: request ${request.requestId} on ${agent.agentId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
          }
        }
      }
    });
  }
  private nativeQuestionAgents(task: Task): Array<{ agentId: string; workspaceId: string }> {
    const out = new Map<string, string>();
    const add = (agentId: string | null | undefined, workspaceId: string | null | undefined) => {
      if (!agentId || !workspaceId) return;
      if (!out.has(agentId)) out.set(agentId, workspaceId);
    };
    add(task.agentId, task.workspaceId);
    const runs = this.store.runs(task.id);
    const current = task.resolution.currentRunId ? runs.find(run => run.id === task.resolution.currentRunId) : null;
    add(current?.agentId, current?.workspaceId ?? task.workspaceId);
    add(task.resolution.reviewerAgentId, runs.find(run => run.role === 'reviewer' && run.agentId === task.resolution.reviewerAgentId)?.workspaceId ?? task.workspaceId);
    return [...out].map(([agentId, workspaceId]) => ({ agentId, workspaceId }));
  }
}
