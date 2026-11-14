import { delegateQuestion } from './planner-delegation';
import type { DecisionView } from '../../shared/contracts';
import { clipDecisionQuestion, holdsOf,taskControlInputSchema,type Run,type Task,type TaskControlInput } from '../../shared/contracts';
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { taskBudget } from '../../shared/task-budget';
import { queueAskDeliveryId } from './agent-ask';
import {
plannerEscalations,
type LadderEvent
} from './blocker-ladder';
import { Decisions,decisionHeadline } from '../planning/decisions';
import { supportsNativeQuestions } from './native-decision';
import { questionRoute } from './question-route';
import { isDelegableQuestionKind,operatorQuestionFor,operatorQuestionStep,type OperatorQuestion,type OperatorQuestionChoice,type OperatorQuestionKind } from './operator-question';
import { boundInlineReport } from '../review/ordinary-review';
import { DELEGATED_ANSWER_TIMEOUT_MS,applyBinaryApproval,delegatedAuthorityNote,delegatedDecisionText,nativeDelegationPrompt,parseDelegatedAnswer,parseNativeDelegatedReply,type DelegatedAnswer } from './question-delegation';
import type { Resolution } from '../resolution';
import { DelegatedHostUnavailable } from './delegation';
import { digest } from '../store/store';
import { RESPONSIBLE_QUESTION_WAIT } from '../recovery/task-reasons';

/** The recorded budget questions a task carries: their ids, in event order. */
function budgetQuestionIds(events: Array<{ kind: string; detail: string }>): string[] {
  return [...new Set(events
    .filter(event => event.kind === 'operator_question' && event.detail.includes('kind budget'))
    .map(event => event.detail.split(':', 1)[0]!)
    .filter(Boolean))];
}

export class Questions {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  readonly queueAskRaiseAnsweredBy = new Map<string, string>();
  readonly queueAskRaises = new Map<string, { resolve: (answer: string) => void; reject: (error: Error) => void }>();
  readonly recoveringQueueAsks = new Set<string>();
  readonly delegatedAnswers = new Map<string, DelegatedAnswer>();
  readonly responsibleQuestions = new Map<string, AbortController>();
  async responsibleJointQuestion(t: Task): Promise<boolean> {
    const applied = new Set(this.store.eventsAll(t.id)
      .filter(event => ['review_result_applied', 'review_reapplied'].includes(event.kind)).map(event => event.detail));
    const receipts = this.store.db.prepare('SELECT id,run FROM receipts WHERE task=? ORDER BY rowid').all(t.id) as { id: string; run: string }[];
    const runs = new Map(this.store.runs(t.id).map(run => [run.id, run]));
    let reviews: Run[] = [];
    const seen = new Set<string>();
    for (const receipt of receipts) {
      if (seen.has(receipt.run)) continue;
      const run = runs.get(receipt.run), completion = run?.completion;
      if (!run || !completion || run.role !== 'reviewer' || run.mechanicalReviewProof
        || run.status !== 'finished' || !run.released || completion.eventId !== receipt.id
        || completion.taskId !== t.id || completion.runId !== run.id || !completion.head || completion.head !== run.head
        || !applied.has(run.id)) continue;
      seen.add(run.id);
      if (completion.status === 'ready_to_merge') { reviews = []; continue; }
      if (completion.status === 'changes_required' && (completion.reviewResponsibility === 'author'
        || !run.reviewResponsibilityRequired && completion.reviewResponsibility === undefined)) reviews.push(run);
    }
    if (reviews.length !== 3) return false;
    const latest = reviews.at(-1)!;
    const id = digest(`responsible-question:${t.id}:${latest.id}`);
    const events = this.store.eventsAll(t.id);
    const marked = (kind: string) => events.find(event => event.kind === kind && event.detail.startsWith(`${id}:`));
    if (marked('responsible_question_answered')) return false;
    if (marked('responsible_question_unknown')) return false;
    // An owner control moved past the question, so it no longer holds the task.
    if (marked('responsible_question_superseded')) return false;
    if (marked('responsible_question')) { this.resolution.waiting(this.store.task(t.id), RESPONSIBLE_QUESTION_WAIT, 'responsible_question'); return true; }
    if (!t.agentId) return false;
    if (!this.adapter.raiseTaskDecision && questionRoute(this.adapter) !== 'board') return false;
    const reviewer = latest.completion;
    const worker = this.store.runs(t.id).findLast(run => run.role === 'revision' && run.completion)?.completion;
    // The reviewer's authenticated full finding is reviewText; a summary or an
    // excerpt would not give the operator the disagreement the brief requires,
    // so the complete finding travels in the decision's details. The question
    // itself stays a short readable ask inside the view limit: an over-long
    // question broke the board read (a too_big refusal under the board header).
    // The durable send intent records the exact payload's digest, not a copy.
    const head = reviewer?.head ?? t.prHead ?? 'the recorded head';
    const finding = boundInlineReport(reviewer?.reviewText?.trim() || reviewer?.summary?.trim() || 'not recorded', 'reviewer finding');
    const workerReturn = boundInlineReport(worker?.summary?.trim() || 'not recorded', 'worker return');
    // The full findings travel in the interactive prompts (the native question
    // and the planner/decider delegation), which carry no view limit. The
    // recorded question stays a short readable ask inside the view limit and
    // the full material travels in the decision's details, so no producer
    // breaks a board read with a too_big refusal.
    const fullQuestion = `Three review rounds have not converged on "${t.title}" at ${head}. The reviewer's authenticated findings: ${finding} The worker's latest return: ${workerReturn} How should the next round proceed?`;
    const question = clipDecisionQuestion(`Three review rounds have not converged on "${t.title}" at ${head}. The reviewer's authenticated findings and the worker's latest return are in the decision details. How should the next round proceed?`);
    const details = `Reviewer's authenticated findings:\n${finding}\n\nWorker's latest return:\n${workerReturn}`.slice(0, 48000);
    const options = ['Continue the current approach', 'Change the approach', 'Stop and keep the work'];
    this.store.transaction(() => {
      this.store.event(t.id, 'responsible_question', `${id}: head ${head}; question ${digest(question)} (${question.length} chars); reviewer finding ${digest(finding)} (${finding.length} chars); worker return ${digest(workerReturn)} (${workerReturn.length} chars)`);
      if (!supportsNativeQuestions(t.profile?.provider) && questionRoute(this.adapter, t.profile?.provider) !== 'board')
        this.store.event(t.id, 'queue_ask_payload', JSON.stringify({ id, kind: 'review', question, options, details, fullQuestion }));
    });
    this.resolution.waiting(this.store.task(t.id), RESPONSIBLE_QUESTION_WAIT, 'responsible_question');
    const controller = new AbortController();
    this.resolution.responsibleQuestions.set(id, controller);
    void this.resolution.raiseDecision(this.store.task(t.id), { id, kind: 'review', question, options, details, fullQuestion }, controller.signal)
      .then(answer => {
        this.resolution.settleJointQuestion(t.id, id, answer);
      })
      .catch(error => {
        if (this.resolution.stopped()) return;
        if (this.store.eventsAll(t.id).some(event => event.kind === 'responsible_question_superseded' && event.detail.startsWith(`${id}:`))) return;
        this.store.event(t.id, 'responsible_question_unknown', `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
      })
      .finally(() => this.resolution.responsibleQuestions.delete(id));
    return true;
  }
  settleJointQuestion(taskId: string, id: string, answer: string): void {
    const delegated = this.resolution.delegatedAnswers.get(id); this.resolution.delegatedAnswers.delete(id);
    const boardBy = this.resolution.queueAskRaiseAnsweredBy.get(id); this.resolution.queueAskRaiseAnsweredBy.delete(id);
    if (this.store.eventsAll(taskId).some(event => event.kind === 'responsible_question_superseded' && event.detail.startsWith(`${id}:`))) {
      this.store.event(taskId, 'responsible_question_stale_answered', `${id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : boardBy ?? 'operator'}; no effect because the question was superseded`);
      if (delegated) this.resolution.notifyStaleQuestionAnswer(taskId, id, `${delegated.role} ${delegated.agentId}`);
      return;
    }
    this.store.event(taskId, 'responsible_question_answered', `${id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : boardBy ?? 'operator'}`);
    const current = this.store.task(taskId);
    this.resolution.update(current, { stop: null }, { reason: `${delegated ? `A delegated ${delegated.role} answered` : 'The operator answered'} the joint review question; the next review round continues with that answer` }, 'responsible_question_resumed', answer.slice(0, 2000));
  }
  async raiseOperatorQuestions(scopedTaskId?: string): Promise<void> {
    if (!scopedTaskId) {
      for (const task of this.store.maintenanceTasks(true)) {
        // A task host that is offline (or whose runs carry another host's identity)
        // cannot take a native prompt, but the board can still record the question.
        // Skipping the task here silenced a budget pause for its whole life
        // (nucleus#1153), so the raise always runs and the route decides.
        if (!task.hostId) { await this.raiseOperatorQuestions(task.id); continue; }
        await this.resolution.withHost(task.hostId, () => this.raiseOperatorQuestions(task.id));
      }
      return;
    }
    if (this.resolution.paused()) return;
    if (!this.adapter.raiseTaskDecision && questionRoute(this.adapter) !== 'board') return;
    for (const candidate of [this.store.task(scopedTaskId)]) {
      if (this.resolution.paused()) return;
      const task = this.store.task(candidate.id);
      // Spec 058 (task 540): a runnable proof the brief names runs now; no question is raised for it.
      if (await this.resolution.startRunnableProof(task)) continue;
      // The proof route may have routed the task itself (a docs-only skip parks the
      // old wait); the question reads the task as it stands after that routing.
      const question = operatorQuestionFor(this.store, this.store.task(task.id));
      const events = this.store.eventsAll(task.id);
      const marked = (kind: string, id: string) => events.some(event => event.kind === kind && event.detail.startsWith(`${id}:`));
      const open = events.filter(event => event.kind === 'operator_question')
        .some(event => !marked('operator_question_answered', event.detail.split(':')[0]!)
          && !marked('operator_question_unknown', event.detail.split(':')[0]!)
          && !marked('operator_question_superseded', event.detail.split(':')[0]!));
      const step = operatorQuestionStep({
        question,
        entrypoint: task.entrypoint,
        alreadyMarked: question ? marked('operator_question', question.id) : false,
        decisionMarked: question ? marked('operator_question_decision', question.id) : false,
        openQuestion: open,
      });
      if (step.kind === 'skip' || step.kind === 'skip_marked' || step.kind === 'skip_open') continue;
      // Proof-only release GO is an operator decision, not a question for the
      // retained reviewer or any other agent to relay. Raise it directly on the
      // board, including when recovering an older native-only intent.
      if (step.kind === 'proof_go' && question) {
        if (!marked('operator_question', question.id))
          this.store.event(task.id, 'operator_question', `${question.id}: kind ${question.kind}; stop ${task.resolution.stop?.reason ?? 'none'}; head ${task.prHead ?? 'none'}; question ${digest(question.question)} (${question.question.length} chars); options ${question.choices.map(choice => choice.label).join(' | ') || 'none'}`);
        if (!marked('operator_question_decision', question.id))
          this.resolution.ensureQueueRaiseDecision(task, { id: question.id, kind: question.kind, question: question.question,
            options: question.choices.map(choice => choice.label) }, 'proof-only release GO is an operator decision');
        continue;
      }
      if (!question) continue;
      const options = question.choices.map(choice => choice.label);
      this.store.transaction(() => {
        this.store.event(task.id, 'operator_question', `${question.id}: kind ${question.kind}; stop ${task.resolution.stop?.reason ?? 'none'}; head ${task.prHead ?? 'none'}; question ${digest(question.question)} (${question.question.length} chars); options ${options.join(' | ') || 'none'}`);
        if (!supportsNativeQuestions(task.profile?.provider) && questionRoute(this.adapter, task.profile?.provider) !== 'board')
          this.store.event(task.id, 'queue_ask_payload', JSON.stringify({ id: question.id, kind: question.kind, question: question.question, options }));
      });
      const controller = new AbortController();
      this.resolution.responsibleQuestions.set(question.id, controller);
      // A question is recorded for every phase and every host state; only native
      // delivery needs a reachable host, so an offline host routes the question to
      // the board instead of leaving the pause silent (nucleus#1153). The check is
      // host availability, not the stricter task/run identity: a run that records
      // another host's identity must still be asked.
      const hostReachable = !task.hostId || this.resolution.originHostAvailable(task.hostId);
      void this.resolution.raiseDecision(this.store.task(task.id), { id: question.id, kind: question.kind, question: question.question, options }, controller.signal,
        hostReachable ? {} : { boardOnly: true, why: `the task host ${task.hostId} is offline, so the question waits on the board` })
        .then(answer => this.resolution.settleOperatorQuestion(task.id, question, answer))
        .catch(error => {
          // A stop that interrupted the observation wrote what it could before the
          // store closed; the recorded intent already means this is never resent.
          if (this.resolution.stopped()) return;
          if (this.store.eventsAll(task.id).some(event => event.kind === 'operator_question_superseded' && event.detail.startsWith(`${question.id}:`))) return;
          this.store.event(task.id, 'operator_question_unknown', `${question.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
          // Papercut a1bc9fe5: a native delivery that went unknown used to strand
          // the question with nobody able to answer it. The same question id falls
          // back to the task's planner ladder, whose answer comes through
          // question.answer; a late native answer settles the same question once.
          this.delegateUnknownDeliveryQuestion(task.id, { id: question.id, kind: question.kind, question: question.question, options }, options);
        })
        .finally(() => this.resolution.responsibleQuestions.delete(question.id));
    }
  }
  async resumeBusyProofGoAnswers(): Promise<void> {
    for (const candidate of this.store.maintenanceTasks(true)) {
      if (this.resolution.paused()) return;
      const task = this.store.task(candidate.id);
      if (task.entrypoint !== 'proof' || task.removedAt || !['blocked', 'error', 'needs_attention'].includes(task.phase)) continue;
      if (this.store.runs(task.id).some(run => !run.released)) continue;
      const events = this.store.eventsAll(task.id);
      const intent = events.find(event => event.kind === 'operator_question' && event.detail.includes('kind release'));
      const id = intent?.detail.split(':', 1)[0];
      if (!id || !events.some(event => event.kind === 'operator_question_answered' && event.detail.startsWith(`${id}:`))) continue;
      if (events.some(event => event.kind === 'operator_question_applied' && event.detail.startsWith(`${id}:`))) continue;
      const refusal = events.findLast(event => event.kind === 'operator_question_refused' && event.detail.startsWith(`${id}:`));
      if (!refusal || !/worker running|capacity/i.test(refusal.detail)) continue;
      const link = events.find(event => event.kind === 'operator_question_decision' && event.detail.startsWith(`${id}: decision `));
      const decisionId = link?.detail.match(/decision (\S+)/)?.[1]?.replace(/;$/, '');
      if (!decisionId) continue;
      const decision = new Decisions(this.store).get({ id: decisionId });
      if (decision.status !== 'answered' || !decision.answer) continue;
      const question = operatorQuestionFor(this.store, task);
      if (!question || question.id !== id) continue;
      this.resolution.queueAskRaiseAnsweredBy.set(id, decision.answer.answeredBy);
      try {
        if (task.hostId && this.resolution.hostAvailable(task))
          await this.resolution.withHost(task.hostId, () => this.resolution.settleOperatorQuestion(task.id, question, decision.answer!.text, false));
      }
      finally { this.resolution.queueAskRaiseAnsweredBy.delete(id); }
    }
  }
  extendTaskBudget(taskId: string, detail: string, by = 'The operator'): Task | null {
    const current = this.store.task(taskId);
    const events = this.store.eventsAll(taskId);
    if (!taskBudget(current, this.store.runs(taskId), Date.now(), events).exhausted) return null;
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
    void this.resolution.withHost(task.hostId, async () => {
      for (const agent of agents) {
        let pending: Array<{ requestId: string; questions: Array<{ header: string; question: string; options: string[] }> }>;
        try { pending = await this.adapter.pendingQuestions!(agent.agentId); }
        catch { continue; }
        for (const request of pending) {
          const match = ids.find(id => request.questions.some(question => question.question.startsWith(`[Queue decision ${id}]`)));
          if (!match) continue;
          try {
            await this.adapter.dismissNativeQuestion!(agent.agentId, agent.workspaceId, request.requestId);
            if (!this.store.eventsAll(taskId).some(item => item.kind === 'native_question_dismissed' && item.detail.startsWith(`${match}:`)))
              this.store.event(taskId, 'native_question_dismissed', `${match}: request ${request.requestId} on ${agent.agentId}`);
          } catch { /* delivery is unknown; the intent prevents a resend */ }
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
  /**
   * Papercut a1bc9fe5: a native question whose delivery went unknown never
   * reached the planner, so `question.answer` refused every planner. The same
   * question id is delegated to the task's planner rungs; its answer settles
   * through the ordinary settlement, so a late native answer reconciles with
   * the one question instead of opening a second one.
   */
  delegateUnknownDeliveryQuestion(taskId: string, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[] }, options: string[]): void {
    if (!isDelegableQuestionKind(decision.kind) || this.resolution.stopped()) return;
    const events = this.store.eventsAll(taskId);
    if (events.some(event => ['operator_question_answered', 'operator_question_stale_answered', 'delegated_decision_route'].some(kind =>
      event.kind === kind && event.detail.startsWith(`${decision.id}:`)))) return;
    // The stop may have moved while the delivery failed: a delegate must answer
    // the state its question names, never a later one.
    const current = operatorQuestionFor(this.store, this.store.task(taskId));
    if (current?.id !== decision.id) return;
    if (this.resolution.recoveringQueueAsks.has(decision.id)) return;
    this.resolution.recoveringQueueAsks.add(decision.id);
    this.store.event(taskId, 'operator_question_unknown_delegated', `${decision.id}: native delivery was unknown; the question falls back to the planner ladder`);
    void this.delegateDecision(taskId, { id: decision.id, kind: decision.kind, question: decision.question, options },
      null, new AbortController().signal, async (fresh, answer) => {
        const question = operatorQuestionFor(this.store, fresh);
        if (question?.id === decision.id) await this.resolution.settleOperatorQuestion(taskId, question, answer);
      })
      .catch(error => { if (!this.resolution.stopped()) this.store.event(taskId, 'operator_question_delegation_unknown', `${decision.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000)); })
      .finally(() => this.resolution.recoveringQueueAsks.delete(decision.id));
  }
  async settleOperatorQuestion(taskId: string, question: OperatorQuestion, answer: string, recordAnswer = true): Promise<void> {
    if (this.resolution.stopped()) return;
    if (!this.resolution.queueBudgetQuestionCurrent(taskId, question)) {
      const delegated = this.resolution.delegatedAnswers.get(question.id); this.resolution.delegatedAnswers.delete(question.id);
      const answeredBy = this.resolution.queueAskRaiseAnsweredBy.get(question.id); this.resolution.queueAskRaiseAnsweredBy.delete(question.id);
      this.store.event(taskId, 'operator_question_stale_answered', `${question.id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : answeredBy ?? 'operator'}; no effect because the question was superseded`);
      if (delegated) this.resolution.notifyStaleQuestionAnswer(taskId, question.id, `${delegated.role} ${delegated.agentId}`);
      return;
    }
    // Spec 058 (task 550): the answer is recorded with who answered it — the operator, or the delegated agent.
    const delegated = this.resolution.delegatedAnswers.get(question.id) ?? null;
    this.resolution.delegatedAnswers.delete(question.id);
    const answeredBy = this.resolution.queueAskRaiseAnsweredBy.get(question.id);
    this.resolution.queueAskRaiseAnsweredBy.delete(question.id);
    // The one recorded answer is the question's outcome: a later native answer to
    // a question already settled by the planner ladder is recorded and applied
    // nowhere (papercut a1bc9fe5), never a second question or a second control.
    if (recordAnswer && this.store.eventsAll(taskId).some(event => event.kind === 'operator_question_answered' && event.detail.startsWith(`${question.id}:`))) {
      this.store.event(taskId, 'operator_question_late_answer', `${question.id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : answeredBy ?? 'operator'}; no effect because the question was already answered`);
      return;
    }
    if (recordAnswer && !this.store.eventsAll(taskId).some(event => event.kind === 'operator_question_answered' && event.detail.startsWith(`${question.id}:`)))
      this.store.event(taskId, 'operator_question_answered', `${question.id}: ${answer} — answered by ${delegated ? `delegated ${delegated.role} ${delegated.agentId}` : answeredBy ?? 'operator'}`);
    const text = answer.trim();
    const choice = question.choices.find(item => item.label === text) ?? question.choices.find(item => text.startsWith(item.label));
    // A free-text ruling is the answer: it is recorded for the task's own thread,
    // which asked the question, and Queue has no verb it may invent from it.
    if (!choice) return;
    // Spec 058 (task 540): only a delegated answer carries its recorded agent and note; anything else is the operator's.
    const delegation = delegated;
    if (choice.extendBudget) {
      const detail = `${question.id}: ${choice.label}${delegation ? `; ${delegatedAuthorityNote(question.id, delegation)}` : ''}`;
      this.resolution.extendTaskBudget(taskId, detail.slice(0, 4000), delegation ? `A delegated ${delegation.role}` : 'The operator');
    }
    if (!choice.control) return;
    if (!this.resolution.applyOperatorControl) {
      this.store.event(taskId, 'operator_question_refused', `${question.id}: ${choice.label}: no control applier is bound`);
      return;
    }
    try {
      await this.resolution.applyOperatorControl(this.resolution.operatorAnswerControl(this.store.task(taskId), question, choice, answer, delegation));
      this.store.event(taskId, 'operator_question_applied', `${question.id}: ${choice.label}`.slice(0, 4000));
    } catch (error) {
      this.store.event(taskId, 'operator_question_refused', `${question.id}: ${choice.label}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
    }
  }
  operatorAnswerControl(task: Task, question: OperatorQuestion, choice: OperatorQuestionChoice, answer: string, delegation: DelegatedAnswer | null = null): TaskControlInput {
    const control = choice.control!;
    const relayNote = `The operator answered Nucleus's native question ${question.id} on this task's thread: ${answer}`.slice(0, 4000);
    const answeredBy = delegation ? `A delegated ${delegation.role} (${delegation.agentId}) answered` : 'The operator answered';
    const identity = { taskId: task.id, version: task.version, action: control.action,
      reason: `${answeredBy} Nucleus's question ${question.id}: ${choice.label}`.slice(0, 4000) };
    // Spec 058 (task 540): a delegated answer is authorized by the answering agent and its
    // recorded note, never the board and never a relay. It is recorded as `delegated`.
    const grant = delegation
      ? { caller: delegation.agentId, delegated: true, note: delegatedAuthorityNote(question.id, delegation),
          ...(control.action === 'owner' && control.args.action === 'extend_budget' && delegation.budgetAuthority ? { budgetAuthority: delegation.budgetAuthority } : {}) }
      : { caller: task.agentId ?? undefined, relayed: true, note: relayNote };
    if (control.action === 'owner') return taskControlInputSchema.parse({ ...control.args, taskId: task.id, version: task.version, reason: identity.reason, ...grant });
    if (control.action === 'move' && control.to === 'merge')
      return taskControlInputSchema.parse({ ...identity, to: 'merge', head: control.head,
        qualification: `${delegation ? `The delegated ${delegation.role} ${delegation.agentId}` : 'The operator'} accepted the approved source head ${control.head} and deferred its named proofs in answer to Nucleus's question ${question.id}: ${answer}`.slice(0, 4000),
        ...grant });
    if (control.action === 'move')
      return taskControlInputSchema.parse({ ...identity, to: 'work', instruction: `${control.instruction} ${delegation ? `The ${delegation.role} answered` : "The operator's answer:"} ${answer}`.slice(0, 12000) });
    // Spec 058 (task 539): the merge fence keeps the proof list as its reason; the
    // operator owns it, so no relayed author is recorded.
    if (control.action === 'hold')
      return taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'hold', kind: 'merge', reason: control.reason.slice(0, 4000) });
    // `stop` carries no authorization note: its reason names the answered question.
    if (control.action === 'stop') return taskControlInputSchema.parse(identity);
    return taskControlInputSchema.parse({ ...identity, ...grant });
  }
  queueBudgetQuestionCurrent(taskId: string, decision: { id: string; kind: OperatorQuestionKind }): boolean {
    if (this.store.eventsAll(taskId).some(event => event.kind === 'operator_question_superseded' && event.detail.startsWith(`${decision.id}:`))) return false;
    if (decision.kind !== 'budget') return true;
    const current = operatorQuestionFor(this.store, this.store.task(taskId));
    return current?.id === decision.id && current.kind === decision.kind;
  }
  raiseDecision(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, signal: AbortSignal,
    options: { boardOnly?: boolean; why?: string } = {}): Promise<string> {
    if (!this.resolution.queueBudgetQuestionCurrent(task.id, decision)) return Promise.reject(Error('Budget question no longer matches the current stop'));
    const route = questionRoute(this.adapter, task.profile?.provider);
    if (options.boardOnly || route === 'board') {
      if (isDelegableQuestionKind(decision.kind))
        return this.raiseLadderDecision(task, decision, signal, options.why ?? 'the task host cannot take a native question');
      return this.raiseBoardDecision(task, decision, signal, options.why);
    }
    // The native prompt carries the full text when the producer kept one; the
    // bounded surfaces (the board decision, the ask tool and its exact-text
    // join) carry the short canonical question. Delegation prefers the full
    // text the same way.
    const prompt = decision.fullQuestion ?? decision.question;
    // Spec 058 (task 550): a provider without a native question surface receives the
    // question through `nucleus_ask` instead of a prompt it cannot follow.
    if (route === 'mcp_ask' || !supportsNativeQuestions(task.profile?.provider)) return this.resolution.raiseAskDecision(task, decision, signal);
    return this.adapter.raiseTaskDecision!(task, { id: decision.id, question: prompt, options: decision.options, signal,
      onRequested: request => { void this.resolution.delegateDecision(task.id, decision, request, signal,
        (fresh, answer) => this.adapter.answerTaskDecision!(fresh, { requestId: request.requestId, header: request.header, answer })); } });
  }
  raiseBoardDecision(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, signal: AbortSignal,
    why = 'the task host cannot take a native question'): Promise<string> {
    let resolve!: (answer: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    this.resolution.queueAskRaises.set(decision.id, { resolve, reject });
    signal.addEventListener('abort', () => {
      const raise = this.resolution.queueAskRaises.get(decision.id);
      if (raise) { this.resolution.queueAskRaises.delete(decision.id); this.resolution.queueAskRaiseAnsweredBy.delete(decision.id); raise.reject(Error('Nucleus board question observation cancelled; delivery or answer may be unknown')); }
    }, { once: true });
    this.resolution.ensureQueueRaiseDecision(task, decision, why);
    void this.notifyPlannerOfBoardQuestion(task, decision);
    return promise;
  }
  /** A host without native questions asks the planner ladder before opening a board decision. */
  private raiseLadderDecision(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, signal: AbortSignal,
    why: string): Promise<string> {
    let resolve!: (answer: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    this.resolution.queueAskRaises.set(decision.id, { resolve, reject });
    signal.addEventListener('abort', () => {
      const raise = this.resolution.queueAskRaises.get(decision.id);
      if (raise) { this.resolution.queueAskRaises.delete(decision.id); this.resolution.queueAskRaiseAnsweredBy.delete(decision.id); raise.reject(Error('Nucleus planner question observation cancelled; delivery or answer may be unknown')); }
    }, { once: true });
    void this.delegateDecision(task.id, decision, null, signal, async (_fresh, answer) => {
      this.resolution.resolveQueueRaise(decision.id, answer);
    }).then(delivered => {
      if (delivered || signal.aborted || !this.resolution.queueAskRaises.has(decision.id)) return;
      const events = this.store.eventsAll(task.id);
      // Unknown delivery must stay unknown; only an observed exhausted ladder
      // can turn this into a board decision.
      if (events.some(event => event.kind === 'operator_question_delegation_unknown' && event.detail.startsWith(`${decision.id}:`))) return;
      const existingLink = this.store.eventsAll(task.id).find(event => event.kind === 'operator_question_decision' && event.detail.startsWith(`${decision.id}: decision `));
      const reason = existingLink?.detail.split('; ').slice(1).join('; ') || `${why}; the planner ladder ran out without an answer`;
      this.resolution.ensureQueueRaiseDecision(task, decision, reason);
      this.notifyPlannerOfBoardQuestion(task, decision, reason);
    }).catch(error => {
      if (this.resolution.stopped() || signal.aborted) return;
      this.store.event(task.id, 'operator_question_delegation_unknown', `${decision.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
    });
    return promise;
  }
  private notifyPlannerOfBoardQuestion(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, why = 'the task host cannot take a native question'): void {
    const noticed = () => {
      try { return this.store.eventsAll(task.id).some(event => event.kind === 'operator_question_planner_notice' && event.detail.startsWith(`${decision.id}:`)); }
      catch { return true; }
    };
    if (noticed()) return;
    void (async () => {
      if (noticed()) return;
      // Task 1109: a task's own planner hears about its board question first; the
      // project planner is the fallback rung.
      const own = await this.resolution.taskPlannerFor(task);
      const planner = own?.agentId ?? (await this.resolution.projectPlannerFor(task)).planner;
      if (!planner || noticed()) return;
      const host = await this.resolution.identifyOriginHost(planner);
      if (!host || noticed()) return;
      await this.resolution.withHost(host, async () => {
        if (noticed() || !this.resolution.originHostAvailable(host) || !this.adapter.notify) return;
        const choices = decision.options.length ? ` Choices: ${decision.options.join(' | ')}.` : '';
        const reference = this.store.task(task.id).reference ?? task.title;
        await this.resolution.host.sendMessage(planner, { messageId: `ns-queue-question-${decision.id}`,
          text: `Nucleus raised a question on ${reference} (kind ${decision.kind}) because ${why}. It is on the board for the operator; answer it there. Question: ${decision.question}${choices}` });
        if (!noticed()) this.store.event(task.id, 'operator_question_planner_notice', `${decision.id}: planner ${planner}`);
      });
    })().catch(error => {
      try {
        this.store.event(task.id, 'operator_question_planner_missed', `${decision.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
      } catch { /* store closed after shutdown */ }
    });
  }
  raiseAskDecision(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, signal: AbortSignal): Promise<string> {
    let resolve!: (answer: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    this.resolution.queueAskRaises.set(decision.id, { resolve, reject });
    signal.addEventListener('abort', () => {
      const raise = this.resolution.queueAskRaises.get(decision.id);
      if (raise) { this.resolution.queueAskRaises.delete(decision.id); this.resolution.queueAskRaiseAnsweredBy.delete(decision.id); raise.reject(Error('Nucleus ask observation cancelled; delivery or answer may be unknown')); }
    }, { once: true });
    void this.resolution.deliverQueueAsk(task, decision).catch(() => {
      /* the store or adapter failed after shutdown began; the recorded intent stands */
    });
    void this.resolution.delegateDecision(task.id, decision, null, signal, (fresh, answer) => { this.resolution.resolveQueueRaise(decision.id, answer); return Promise.resolve(); })
      .then(delivered => { if (!delivered && !signal.aborted && this.resolution.queueAskRaises.has(decision.id)) this.resolution.ensureQueueRaiseDecision(task, decision, 'no delegated answer was produced in time'); })
      .catch(() => { /* misses and unknowns are recorded on the events by delegateDecision itself */ });
    return promise;
  }
  async deliverQueueAsk(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, scoped = false): Promise<void> {
    if (!scoped) {
      if (!task.hostId) return;
      return this.resolution.withHost(task.hostId, () => this.deliverQueueAsk(task, decision, true));
    }
    if (!this.resolution.hostAvailable(task)) return;
    if (questionRoute(this.adapter, task.profile?.provider) === 'board') return;
    if (!this.resolution.queueBudgetQuestionCurrent(task.id, decision)) return;
    const deliveryId = queueAskDeliveryId(task.id, decision.question, decision.options);
    if (this.store.eventsAll(task.id).some(event => event.kind === 'queue_ask_delivery' && event.detail.startsWith(`${deliveryId}:`))) return;
    this.store.event(task.id, 'queue_ask_delivery', `${deliveryId}: queue question ${decision.id}`);
    if (!task.agentId || !this.adapter.notify) return;
    const choices = decision.options.length ? ` Choices: ${decision.options.join(' | ')}.` : '';
    const text = `Nucleus asked you one question (kind ${decision.kind}) and is collecting its answer. Call the question MCP tool named in your session's launch instructions once with exactly this question text${decision.options.length ? ' and exactly these choices' : ''}, wait for the answer in the same turn, then continue. Question: ${decision.question}${choices} Do not answer it yourself, and do not raise it as a native question.`;
    try { await this.adapter.notify(task.agentId, `ns-queue-ask-${decision.id}`, text, task.agentId); }
    catch (error) {
      this.store.event(task.id, 'queue_ask_prompt_missed', `${decision.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
    }
  }
  ensureQueueRaiseDecision(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, why: string): void {
    if (!this.resolution.queueBudgetQuestionCurrent(task.id, decision)) return;
    // Every board question stays within the view limit, whatever its producer
    // passed: long material belongs in details, never in a clipped question.
    const question = clipDecisionQuestion(decision.question);
    const events = this.store.eventsAll(task.id);
    if (events.some(event => event.kind === 'operator_question_decision' && event.detail.startsWith(`${decision.id}: decision `))) return;
    this.store.transaction(() => {
      const consequences: Record<string, string> = {
        'GO — run the qualification': 'Runs once on the existing qualification workspace; no install or consumer.',
        'Do not run the qualification': 'Keeps the proof-only task from running this qualification.',
        'Merge now without these proofs (run them after merge)': 'Merges the approved head without these proofs; they run only after merge.',
        'Run the proof now': 'Runs the named proof at the approved head.',
        'Return the task to the worker': 'Returns the task to its worker to produce the proofs it can at this head.',
        'Leave held for the planner': 'Keeps the task held until the planner or operator resolves the missing proofs.',
        'Extend the budget': 'Adds one default budget increment and resumes the current approach.',
        'Change the approach': 'Adds one default budget increment and returns the task to its worker with your direction.',
        'Stop and keep the work': 'Stops the task and retains its current work.',
        'Continue the current approach': 'Starts another worker and reviewer round using the current approach.',
      };
      const taskReference = this.store.task(task.id).reference ?? null;
      const raised = operatorQuestionFor(this.store, task);
      const choices = decision.options.length >= 2
        ? decision.options.slice(0, 3).map(label => ({ label: label.slice(0, 120),
          consequence: (consequences[label] ?? (raised?.id === decision.id ? raised.choices.find(choice => choice.label === label)?.consequence : null)
            ?? `Records the direction “${label}” for the task's thread.`).replace(/\s+/g, ' ').slice(0, 240) })) : undefined;
      const view = new Decisions(this.store).add({
        question,
        headline: decisionHeadline(question, taskReference),
        details: decision.details ?? null,
        choices,
        recommended: choices?.[0]?.label,
        context: `Nucleus-raised question ${decision.id} (kind ${decision.kind}) on this task. ${why}`.slice(0, 4000),
        options: decision.options,
        askedBy: task.agentId ?? 'nucleus',
        project: { origin: normalizeRepositoryOrigin(task.repository ?? '') ?? task.repoPath, path: task.repoPath },
        tasks: [task.id],
        by: 'nucleus',
    });
    this.store.event(task.id, 'operator_question_decision', `${decision.id}: decision ${view.id}; ${why}`.slice(0, 4000));
    });
  }
  resolveQueueRaise(questionId: string, answer: string, answeredBy?: string): void {
    if (answeredBy) this.resolution.queueAskRaiseAnsweredBy.set(questionId, answeredBy);
    const raise = this.resolution.queueAskRaises.get(questionId);
    if (!raise) { this.resolution.queueAskRaiseAnsweredBy.delete(questionId); return; }
    this.resolution.queueAskRaises.delete(questionId);
    raise.resolve(answer);
  }
  operatorDecisionAnswered(view: DecisionView): void {
    if (view.status !== 'answered' || !view.answer) return;
    for (const taskId of view.links.tasks) {
      for (const link of this.store.eventsAll(taskId)) {
        if (!link.detail.includes(`decision ${view.id}`)) continue;
        if (link.kind === 'agent_ask_decision') {
          const askId = link.detail.split(':')[0]!;
          const events = this.store.eventsAll(taskId);
          if (events.some(event => event.kind === 'agent_ask_superseded' && event.detail.startsWith(`${askId}:`))) {
            if (!events.some(event => event.kind === 'agent_ask_stale_answered' && event.detail.startsWith(`${askId}:`)))
              this.store.event(taskId, 'agent_ask_stale_answered', `${askId}: answered by ${view.answer.answeredBy}: ${view.answer.text}; no effect because the question was superseded`);
          } else if (!events.some(event => event.kind === 'agent_ask_answered' && event.detail.startsWith(`${askId}:`))) {
            this.store.event(taskId, 'agent_ask_answered', `${askId}: answered by ${view.answer.answeredBy}: ${view.answer.text}`);
            this.resolution.notifyAskAnswered(taskId, askId, view.answer.text, view.answer.answeredBy);
          }
        }
        // Spec 058 slice 17: the operator answered a ladder escalation the planner
        // classified as the operator's; the same settlement applies its verb.
        if (link.kind === 'planner_escalation_decision_linked') {
          const escalationId = link.detail.split(':')[0]!;
          const open = plannerEscalations(this.store.eventsAll(taskId) as LadderEvent[]).find(item => item.id === escalationId);
          if (open && !open.answered && !this.resolution.settlingOperatorEscalations.has(escalationId)) {
            this.resolution.settlingOperatorEscalations.add(escalationId);
            void this.resolution.settlePlannerEscalation(this.store.task(taskId), escalationId, view.answer.text, view.answer.answeredBy)
              .finally(() => this.resolution.settlingOperatorEscalations.delete(escalationId));
          }
        }
        if (link.kind === 'operator_question_decision') {
          const id = link.detail.split(':')[0]!;
          const events = this.store.eventsAll(taskId);
          if (events.some(event => event.kind === 'operator_question_superseded' && event.detail.startsWith(`${id}:`))) {
            if (!events.some(event => event.kind === 'operator_question_stale_answered' && event.detail.startsWith(`${id}:`)))
              this.store.event(taskId, 'operator_question_stale_answered', `${id}: ${view.answer.text} — answered by ${view.answer.answeredBy}; no effect because the question was superseded`);
          } else if (events.some(event => event.kind === 'operator_question' && event.detail.startsWith(`${id}:`))
            && !events.some(event => event.kind === 'operator_question_answered' && event.detail.startsWith(`${id}:`))) {
            const task = this.store.task(taskId);
            const question = operatorQuestionFor(this.store, task);
            const intent = events.find(event => event.kind === 'operator_question' && event.detail.startsWith(`${id}:`));
            const exactIntent = question?.id === id && intent?.detail.includes(`question ${digest(question.question)} (${question.question.length} chars)`)
              && intent.detail.endsWith(`options ${question.choices.map(choice => choice.label).join(' | ') || 'none'}`);
            this.resolution.queueAskRaiseAnsweredBy.set(id, view.answer.answeredBy);
            if (exactIntent) void this.resolution.settleOperatorQuestion(taskId, question, view.answer.text);
            else {
              this.resolution.queueAskRaiseAnsweredBy.delete(id);
              this.store.event(taskId, 'operator_question_answered', `${id}: ${view.answer.text} — answered by ${view.answer.answeredBy}`);
            }
          } else this.resolution.resolveQueueRaise(id, view.answer.text, view.answer.answeredBy);
        }
      }
    }
  }
  async resumeAskQuestions(scopedTaskId?: string): Promise<void> {
    if (this.resolution.paused()) return;
    if (!scopedTaskId) {
      for (const task of this.store.maintenanceTasks(true))
        if (task.hostId && this.resolution.hostAvailable(task))
          await this.resolution.withHost(task.hostId, () => this.resumeAskQuestions(task.id));
      this.resolution.agentAsks.resumePendingAskAnswers();
      return;
    }
    for (const candidate of [this.store.task(scopedTaskId)]) {
      const task = this.store.task(candidate.id);
      await this.resolution.ladder.resumeEscalationWaits(task);
      this.resolution.agentAsks.resumeAgentAsks(task);
      let events = this.store.eventsAll(task.id);
      this.resolution.ladder.resumeDelegations(task);
      for (const view of new Decisions(this.store).list({ task: task.id, status: 'answered' })) {
        if (!view.answer) continue;
        const activeRaises = new Set(this.resolution.queueAskRaises.keys());
        this.resolution.operatorDecisionAnswered(view);
        // operatorDecisionAnswered records a linked operator question's answer
        // itself, synchronously. Re-read events so the guards below observe that
        // answer and never record the same question answered twice.
        events = this.store.eventsAll(task.id);
        for (const link of events.filter(item => item.kind === 'operator_question_decision' && item.detail.includes(`decision ${view.id}`))) {
          const id = link.detail.split(':')[0]!;
          if (activeRaises.has(id) || this.resolution.recoveringQueueAsks.has(id)) continue;
          const marked = (kind: string) => events.some(item => item.kind === kind && item.detail.startsWith(`${id}:`));
          this.resolution.recoveringQueueAsks.add(id);
          try {
            this.resolution.queueAskRaiseAnsweredBy.set(id, view.answer.answeredBy);
            if (marked('operator_question') && !marked('operator_question_answered')) {
              const question = operatorQuestionFor(this.store, this.store.task(task.id));
              if (question?.id === id) await this.resolution.settleOperatorQuestion(task.id, question, view.answer.text);
              else {
                // The original stop is gone or changed. Record the ruling to close
                // its gate, but never apply its controls to a different state.
                this.store.event(task.id, 'operator_question_answered', `${id}: ${view.answer.text} — answered by ${view.answer.answeredBy}`);
              }
            } else if (marked('responsible_question') && !marked('responsible_question_answered') && !marked('responsible_question_superseded')) {
              this.resolution.settleJointQuestion(task.id, id, view.answer.text);
            }
          } finally { this.resolution.queueAskRaiseAnsweredBy.delete(id); this.resolution.recoveringQueueAsks.delete(id); }
        }
      }
      for (const route of events.filter(event => event.kind === 'delegated_decision_route')) {
        const { decision, request } = JSON.parse(route.detail) as { decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[] }; request: { requestId: string; header: string } | null };
        if (this.resolution.queueAskRaises.has(decision.id) || this.resolution.responsibleQuestions.has(decision.id) || this.resolution.recoveringQueueAsks.has(decision.id)
          || events.some(event => ['operator_question_answered', 'responsible_question_answered', 'operator_question_stale_answered', 'responsible_question_stale_answered'].includes(event.kind) && event.detail.startsWith(`${decision.id}:`))
          || events.some(event => event.kind === 'operator_question_delegation_missed' && event.detail.startsWith(`${decision.id}: no delegated answer was produced;`))
          || (events.some(event => event.kind === 'operator_question_delegation_unknown' && event.detail.startsWith(`${decision.id}:`))
            && !this.resolution.recoverableDelegation([`queue-delegate-${decision.id}`, `queue-delegate-${decision.id}-project`, `ns-decider-${decision.id}`], false))
          || !this.resolution.recoverableDelegation([`queue-delegate-${decision.id}`, `queue-delegate-${decision.id}-project`, `ns-decider-${decision.id}`])) continue;
        if (request && events.some(event => event.kind === 'operator_question_decided' && event.detail.startsWith(`${decision.id}:`))) continue;
        this.resolution.recoveringQueueAsks.add(decision.id);
        void this.resolution.delegateDecision(task.id, decision, request, new AbortController().signal, async (fresh, answer) => {
          if (request) await this.adapter.answerTaskDecision!(fresh, { ...request, answer });
          const question = operatorQuestionFor(this.store, fresh);
          if (question?.id === decision.id) await this.resolution.settleOperatorQuestion(task.id, question, answer);
          else if (events.some(event => event.kind === 'responsible_question' && event.detail.startsWith(`${decision.id}:`))) this.resolution.settleJointQuestion(task.id, decision.id, answer);
        }).catch(error => { if (!this.resolution.stopped()) this.store.event(task.id, 'operator_question_delegation_unknown', `${decision.id}: ${error instanceof Error ? error.message : String(error)}`); })
          .finally(() => this.resolution.recoveringQueueAsks.delete(decision.id));
      }
      // A Queue-originated delegate send may have landed before shutdown. Its
      // established recovery path keeps the linked board question available.
      const board = questionRoute(this.adapter, task.profile?.provider) === 'board';
      for (const event of events.filter(item => item.kind === 'queue_ask_payload')) {
        let question: { id: string; kind: OperatorQuestionKind; question: string; options: string[] };
        try { question = JSON.parse(event.detail) as typeof question; }
        catch { continue; /* Invalid payload cannot authorize recovery. */ }
        const marked = (kind: string) => events.some(item => item.kind === kind && item.detail.startsWith(`${question.id}:`));
        if (board) {
          if (!this.resolution.queueAskRaises.has(question.id) && !this.resolution.recoveringQueueAsks.has(question.id) && !marked('operator_question_decision') &&
              !marked('operator_question_answered') && !marked('responsible_question_answered'))
            this.resolution.ensureQueueRaiseDecision(task, question, 'the task host cannot take a native question');
          this.notifyPlannerOfBoardQuestion(task, question);
          continue;
        }
        if (this.resolution.queueAskRaises.has(question.id) && !marked('operator_question_answered') && !marked('responsible_question_answered'))
          await this.resolution.deliverQueueAsk(this.store.task(task.id), question);
        if (!this.resolution.queueAskRaises.has(question.id) && !this.resolution.recoveringQueueAsks.has(question.id) && !marked('operator_question_decision') &&
            !marked('operator_question_answered') && !marked('responsible_question_answered'))
          this.resolution.ensureQueueRaiseDecision(task, question, 'the previous delivery or answer could not be observed');
      }
      if (board) {
        for (const view of new Decisions(this.store).list({ task: task.id, status: 'open' })) {
          const link = events.find(item => item.kind === 'operator_question_decision' && item.detail.includes(`decision ${view.id}`));
          if (!link) continue;
          const id = link.detail.split(':')[0]!;
          if (['operator_question_answered', 'responsible_question_answered', 'operator_question_superseded']
            .some(kind => events.some(item => item.kind === kind && item.detail.startsWith(`${id}:`)))) continue;
          const current = operatorQuestionFor(this.store, this.store.task(task.id));
          if (current?.id === id) {
            const reason = link.detail.split('; ').slice(1).join('; ') || undefined;
            this.notifyPlannerOfBoardQuestion(task, { id: current.id, kind: current.kind, question: current.question, options: current.choices.map(choice => choice.label) }, reason);
          }
        }
      }
    }
    // Task 562: pending asks collect their joined answers and every recorded
    // answer resumes its asking agent, even when the in-turn wait already left.
  }
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
  abortResponsibleQuestions() {
    for (const controller of this.resolution.responsibleQuestions.values()) controller.abort();
    this.resolution.responsibleQuestions.clear();
    for (const [questionId, raise] of this.resolution.queueAskRaises) {
      this.resolution.queueAskRaises.delete(questionId);
      this.resolution.queueAskRaiseAnsweredBy.delete(questionId);
      raise.reject(Error('Nucleus ask observation cancelled; delivery or answer may be unknown'));
    }
  }
}
