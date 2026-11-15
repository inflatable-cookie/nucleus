import { decisionHeadline, Decisions } from '../planning/decisions';
import { clipDecisionQuestion, type Task } from '../../shared/contracts';
import { normalizeRepositoryOrigin } from '../../shared/lanes';
import type { Resolution } from '../resolution';
import { digest } from '../store/store';
import { supportsNativeQuestions } from './native-decision';
import { operatorQuestionFor, operatorQuestionStep, isDelegableQuestionKind,
  type OperatorQuestionKind } from './operator-question';
import { intentOptions, operatorQuestionRecords } from './question-events';
import { questionRoute } from './question-route';
import type { RaisedDecision } from './question-raise-routes';

/**
 * Owns the sweep that decides a question is due: the operator question a task's
 * stop asks, the Queue ask payload behind it, and the delegation an unknown native
 * delivery falls back to. The intent and the decision it opened are read through
 * `question-events.ts`; where the raise goes is `question-raise-routes.ts` and the
 * answer is `question-answers.ts`.
 */
export class QuestionRaises {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
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
      const records = operatorQuestionRecords(this.store.eventsAll(task.id));
      const kinds = (id: string) => records.get(id)?.kinds ?? new Set<string>();
      const open = [...records.values()]
        .some(record => record.kinds.has('operator_question')
          && !record.kinds.has('operator_question_answered')
          && !record.kinds.has('operator_question_unknown')
          && !record.kinds.has('operator_question_superseded'));
      const step = operatorQuestionStep({
        question,
        entrypoint: task.entrypoint,
        alreadyMarked: question ? kinds(question.id).has('operator_question') : false,
        decisionMarked: question ? kinds(question.id).has('operator_question_decision') : false,
        openQuestion: open,
      });
      if (step.kind === 'skip' || step.kind === 'skip_marked' || step.kind === 'skip_open') continue;
      // Proof-only release GO is an operator decision, not a question for the
      // retained reviewer or any other agent to relay. Raise it directly on the
      // board, including when recovering an older native-only intent.
      if (step.kind === 'proof_go' && question) {
        if (!kinds(question.id).has('operator_question'))
          this.store.event(task.id, 'operator_question', this.intentDetail(question, task));
        if (!kinds(question.id).has('operator_question_decision'))
          this.resolution.ensureQueueRaiseDecision(task, { id: question.id, kind: question.kind, question: question.question,
            options: question.choices.map(choice => choice.label) }, 'proof-only release GO is an operator decision');
        continue;
      }
      if (!question) continue;
      const options = question.choices.map(choice => choice.label);
      this.store.transaction(() => {
        this.store.event(task.id, 'operator_question', this.intentDetail(question, task));
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
          const current = operatorQuestionRecords(this.store.eventsAll(task.id)).get(question.id);
          if (current?.kinds.has('operator_question_superseded')) return;
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
  /** The one intent record a raise writes: the kind, the stop it names, and the question's digest. */
  private intentDetail(question: { id: string; kind: OperatorQuestionKind; question: string; choices: readonly { label: string }[] }, task: Task): string {
    const options = question.choices.map(choice => choice.label);
    return `${question.id}: kind ${question.kind}; stop ${task.resolution.stop?.reason ?? 'none'}; head ${task.prHead ?? 'none'}; question ${digest(question.question)} (${question.question.length} chars); options ${intentOptions(options)}`;
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
    const recorded = operatorQuestionRecords(this.store.eventsAll(taskId)).get(decision.id);
    if (recorded?.kinds.has('operator_question_answered') || recorded?.kinds.has('operator_question_stale_answered')
      || recorded?.kinds.has('delegated_decision_route')) return;
    // The stop may have moved while the delivery failed: a delegate must answer
    // the state its question names, never a later one.
    const current = operatorQuestionFor(this.store, this.store.task(taskId));
    if (current?.id !== decision.id) return;
    if (this.resolution.recoveringQueueAsks.has(decision.id)) return;
    this.resolution.recoveringQueueAsks.add(decision.id);
    this.store.event(taskId, 'operator_question_unknown_delegated', `${decision.id}: native delivery was unknown; the question falls back to the planner ladder`);
    void this.resolution.delegateDecision(taskId, { id: decision.id, kind: decision.kind, question: decision.question, options },
      null, new AbortController().signal, async (fresh, answer) => {
        const question = operatorQuestionFor(this.store, fresh);
        if (question?.id === decision.id) await this.resolution.settleOperatorQuestion(taskId, question, answer);
      })
      .catch(error => { if (!this.resolution.stopped()) this.store.event(taskId, 'operator_question_delegation_unknown', `${decision.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000)); })
      .finally(() => this.resolution.recoveringQueueAsks.delete(decision.id));
  }
  ensureQueueRaiseDecision(task: Task, decision: RaisedDecision, why: string): void {
    if (!this.resolution.queueBudgetQuestionCurrent(task.id, decision)) return;
    // Every board question stays within the view limit, whatever its producer
    // passed: long material belongs in details, never in a clipped question.
    const question = clipDecisionQuestion(decision.question);
    const recorded = operatorQuestionRecords(this.store.eventsAll(task.id)).get(decision.id);
    if (recorded?.link) return;
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
}
