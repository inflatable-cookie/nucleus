import { clipDecisionQuestion, type Run, type Task } from '../../shared/contracts';
import { boundInlineReport } from '../review/ordinary-review';
import type { Resolution } from '../resolution';
import { digest } from '../store/store';
import { RESPONSIBLE_QUESTION_WAIT } from '../recovery/task-reasons';
import { supportsNativeQuestions } from './native-decision';
import { questionRoute } from './question-route';

/** The operator question raised when three review rounds do not converge. */
export class JointReviewQuestion {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
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
}
