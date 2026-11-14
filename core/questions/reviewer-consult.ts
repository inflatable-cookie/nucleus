import type { Completion, Task } from '../../shared/contracts';
import type { TaskStopVerb } from '../../shared/task-stop';
import { proofOnlyReceiptAwaitingReview } from '../qa/proof-execution';
import type { Resolution } from '../resolution';
import { digest } from '../store/store';
import { latestAuthorResult } from '../verbs/owner-verbs';
import { DelegatedHostUnavailable } from './delegation';
import { parseNativeDelegatedReply, taskContextLines } from './question-delegation';
import { REVIEWER_CONSULT_TIMEOUT_MS, consultContinuationInstruction, escalationWaitDetail, findOpenPlannerEscalation, plannerEscalationQuestion, reviewerConsultQuestion, reviewerConsults, type LadderEvent } from './blocker-ladder';

/** Owner-verb suffix on a proof-only escalation: receipt review when that is the wait, else proof. */
export function plannerEscalationOwnerSuffix(t: Task): string {
  if (proofOnlyReceiptAwaitingReview(t))
    return ' Available owner verb: move to=review (starts a receipt reviewer at the same commit; the receipt is the subject).';
  if (t.entrypoint === 'proof')
    return ' Available owner verb: proof (activate the qualification when authorization evidence is complete).';
  return '';
}

export function plannerEscalationSuggestedVerbs(t: Task): TaskStopVerb[] | undefined {
  if (proofOnlyReceiptAwaitingReview(t)) return ['move'];
  if (t.entrypoint === 'proof') return ['proof'];
  return undefined;
}

/** Owns the retained reviewer consult and its escalation. */
export class ReviewerConsult {
  readonly routingConsults = new Set<string>();
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  openReviewerConsult(t: Task, input: { cause: string; runId: string | null; completion: Completion; reviewer: string | null }): void {
    const events = this.store.eventsAll(t.id);
    const occurrence = reviewerConsults(events as LadderEvent[]).filter(consult => consult.cause === input.cause).length;
    const id = digest(['reviewer-consult', t.id, input.cause, String(occurrence)].join(':'));
    const question = reviewerConsultQuestion(t, input.completion);
    const write = () => {
      this.store.event(t.id, 'reviewer_consult', `${id}: cause ${input.cause}; run ${input.runId ?? 'worker'}; question ${digest(question)} (${question.length} chars)`);
      this.store.event(t.id, 'reviewer_consult_payload', `${id}: ${JSON.stringify({ id, cause: input.cause, runId: input.runId, reviewer: input.reviewer, question,
        completion: { status: input.completion.status, summary: input.completion.summary, head: input.completion.head ?? null } })}`);
    };
    // A caller inside an open transaction (the review application) joins it.
    if (this.store.db.isTransaction) write(); else this.store.transaction(write);
    this.resolution.waiting(this.store.task(t.id), escalationWaitDetail.reviewer(id), 'escalated');
    // The in-flight guard is synchronous, so the maintenance sweep can never start a
    // second drive; the launch itself waits for any open transaction to commit, so a
    // rollback never leaves a routing promise running against rolled-back intents.
    if (this.routingConsults.has(id)) return;
    this.routingConsults.add(id);
    queueMicrotask(() => {
      if (this.resolution.stopped()) { this.routingConsults.delete(id); return; }
      void this.resolution.runReviewerConsult(this.store.task(t.id), { id, reviewer: input.reviewer, question })
        .catch(error => {
          if (this.resolution.stopped() || !this.resolution.consultStillOwnsWait(t.id, id)) return;
          if (error instanceof DelegatedHostUnavailable) return;
          this.store.event(t.id, 'reviewer_consult_unknown', `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
          this.resolution.escalateConsultedBlocker(this.store.task(t.id), { id });
        })
        .finally(() => this.routingConsults.delete(id));
    });
  }
  consultStillOwnsWait(taskId: string, id: string): boolean {
    const current = this.store.task(taskId);
    const events = this.store.eventsAll(taskId);
    const opened = events.find(event => event.kind === 'reviewer_consult' && event.detail.startsWith(`${id}:`));
    return !!opened && current.phase !== 'done' && current.phase !== 'cancelled'
      && current.resolution.stop?.reason === 'escalated'
      && current.resolution.stop.detail === escalationWaitDetail.reviewer(id)
      && !events.some(event => event.id > opened.id && event.kind === 'operator_control' && event.detail !== 'note');
  }
  /** Drive one recorded consult: send once, settle the advice into the same worker, or fall through. */
  async runReviewerConsult(t: Task, input: { id: string; reviewer: string | null; question: string }): Promise<void> {
    if (!t.hostId || !this.resolution.withHost(t.hostId, () => this.resolution.originHostAvailable(t.hostId)))
      throw new DelegatedHostUnavailable('Reviewer host is unavailable or unknown');
    return this.resolution.withHost(t.hostId, () => this.runReviewerConsultOnHost(t, input));
  }
  private async runReviewerConsultOnHost(t: Task, input: { id: string; reviewer: string | null; question: string }): Promise<void> {
    if (!this.resolution.consultStillOwnsWait(t.id, input.id)) return;
    const events = () => this.store.eventsAll(t.id);
    const recoverable = this.resolution.recoverableDelegation([`ns-reviewer-consult-${input.id}`]);
    const retainedEvent = events().findLast(event => event.kind === 'reviewer_consult_reviewer' && event.detail.startsWith(`${input.id}: `));
    const retainedReviewer = retainedEvent?.detail.slice(input.id.length + 2) || null;
    if (events().some(event => (event.kind === 'reviewer_consult_answered' || (!recoverable && event.kind === 'reviewer_consult_unknown')) && event.detail.startsWith(`${input.id}:`))) return;
    if (!recoverable && events().some(event => event.kind === 'reviewer_consult_sent' && event.detail.startsWith(`${input.id}:`)
      && (!retainedReviewer || !event.detail.endsWith('reviewer creation requested')))) {
      // A recorded send whose outcome nobody observed is never repeated.
      this.store.event(t.id, 'reviewer_consult_unknown', `${input.id}: a previous consult delivery could not be observed; Nucleus never repeats it`);
      this.resolution.escalateConsultedBlocker(t, { id: input.id });
      return;
    }
    let reviewer = this.resolution.delegatedDelivery(`ns-reviewer-consult-${input.id}`)?.recipient ?? input.reviewer ?? retainedReviewer;
    const consultPrompt = [input.question, ...taskContextLines(this.resolution.decisionContext(t))].join('\n');
    let text: string | null;
    if (!reviewer) {
      const selected = this.resolution.select(t, 'reviewer');
      if (!selected || !this.adapter.createConsultReviewer || !this.adapter.askReviewer || !t.workspaceId) {
        this.store.event(t.id, 'reviewer_consult_missed', `${input.id}: no eligible reviewer profile or consult launch available`);
        this.resolution.escalateConsultedBlocker(t, { id: input.id });
        return;
      }
      this.store.event(t.id, 'reviewer_consult_sent', `${input.id}: reviewer creation requested`);
      const created = await this.adapter.createConsultReviewer(t, { profile: selected.profile, id: input.id });
      if (created.workspaceId !== t.workspaceId) throw Error('Created reviewer is in the wrong workspace');
      reviewer = created.id;
      this.store.transaction(() => {
        const current = this.store.task(t.id);
        if (current.resolution.stop?.reason !== 'escalated' || !current.resolution.stop.detail.includes(input.id)
          || current.resolution.reviewerAgentId || current.workspaceId !== t.workspaceId)
          throw Error('Task changed while the reviewer consult was being created');
        this.store.event(t.id, 'reviewer_consult_reviewer', `${input.id}: ${reviewer}`);
        const retained = this.resolution.update(current, { reviewerAgentId: reviewer, reviewerProfile: selected.profile }, {}, 'reviewer_consult_retained', reviewer!);
        this.resolution.recordCriticalReviewFallback(retained, selected.profile);
      });
      const deliveryId = `ns-reviewer-consult-${input.id}`;
      if (!this.resolution.originHostAvailable(t.hostId)) throw new DelegatedHostUnavailable('Reviewer host is offline');
      this.resolution.openDelegatedQuestion(t, deliveryId, reviewer!, consultPrompt, REVIEWER_CONSULT_TIMEOUT_MS, 'reviewer', t.hostId);
      await this.adapter.askReviewer!(reviewer!, { prompt: this.resolution.delegatePrompt(t, deliveryId, consultPrompt, reviewer, t.hostId), messageId: deliveryId, timeoutMs: REVIEWER_CONSULT_TIMEOUT_MS, signal: new AbortController().signal });
      const command = await this.resolution.waitDelegatedAnswer(deliveryId, new AbortController().signal);
      const reply = parseNativeDelegatedReply(command);
      text = reply?.kind === 'answer' ? reply.answer : null;
    } else {
      text = await this.resolution.askBound(t, reviewer, { prompt: consultPrompt, signal: new AbortController().signal, timeoutMs: REVIEWER_CONSULT_TIMEOUT_MS, messageId: `ns-reviewer-consult-${input.id}`,
        onIntent: () => this.store.event(t.id, 'reviewer_consult_sent', `${input.id}: sent to reviewer ${reviewer}`) }, 'reviewer');
    }
    if (!this.resolution.consultStillOwnsWait(t.id, input.id)) return;
    const advice = text?.trim();
    if (!advice) {
      this.store.event(t.id, 'reviewer_consult_missed', `${input.id}: reviewer ${reviewer} gave no usable advice in time`);
      this.resolution.escalateConsultedBlocker(t, { id: input.id });
      return;
    }
    this.store.event(t.id, 'reviewer_consult_answered', `${input.id}: answered by reviewer ${reviewer}: ${advice.slice(0, 4000)}`);
    this.resolution.continueWorkerAfterLadder(this.store.task(t.id), {
      instruction: consultContinuationInstruction(input.id, advice), event: 'reviewer_consult_continued',
      reason: `The retained reviewer's consult advice returns the same worker (consult ${input.id})`, detail: input.id });
  }
  /** Open the planner escalation a concluded consult leaves behind, carrying the consult's outcome. */
  escalateConsultedBlocker(t: Task, input: { id: string }): void {
    const events = this.store.eventsAll(t.id);
    const consult = reviewerConsults(events as LadderEvent[]).find(candidate => candidate.id === input.id);
    if (!consult) return;
    if (findOpenPlannerEscalation(events as LadderEvent[], consult.cause)) return;
    const payloadEvent = events.find(event => event.kind === 'reviewer_consult_payload' && event.detail.startsWith(`${input.id}:`));
    let completion: Completion = { status: 'blocked', summary: 'The earlier blocked report' } as Completion;
    try { if (payloadEvent) completion = { ...completion, ...(JSON.parse(payloadEvent.detail.slice(payloadEvent.detail.indexOf(':') + 1)) as { completion?: Pick<Completion, 'status' | 'summary' | 'head'> }).completion }; } catch { /* unreadable payload keeps the plain text */ }
    completion = latestAuthorResult(t, this.store.runs(t.id)) ?? completion;
    const failed = events.findLast(event => ['reviewer_consult_missed', 'reviewer_consult_unknown'].includes(event.kind) && event.detail.startsWith(`${input.id}:`));
    const advice = consult.advice ?? `The reviewer consult did not produce usable advice: ${failed?.detail.slice(input.id.length + 2) ?? 'outcome unavailable'}`;
    const question = `${plannerEscalationQuestion(t, completion, advice)}${plannerEscalationOwnerSuffix(t)}`;
    this.resolution.openPlannerEscalation(t, { cause: consult.cause, runId: consult.runId,
      question, payload: { cause: consult.cause, runId: consult.runId, consult: input.id, question },
      suggestedVerbs: plannerEscalationSuggestedVerbs(t) });
  }
}
