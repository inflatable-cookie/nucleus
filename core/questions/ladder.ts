import { delegateQuestion } from './planner-delegation';
import { escalationOutlived, readyReviewAtHead } from '../recovery/task-reasons';
import { blockingRecoveryEffects } from '../recovery/recovery-effects';
import { normalizeRepositoryOrigin } from '../../shared/lanes';
import { proofOnlyReceiptAwaitingReview, proofWaitApplies } from '../qa/proof-execution';
import { openProofOnlyGo } from '../qa/proof-only-go';
import { clipDecisionQuestion, taskControlInputSchema, taskOwner, type Completion, type DecisionView, type Task, type TaskControlInput, isDispositionActive } from '../../shared/contracts';
import { digest } from '../store/store';
import { taskStopVerbsFor, type TaskStopVerb } from '../../shared/task-stop';
import { Decisions } from '../planning/decisions';
import { DELEGATED_ANSWER_TIMEOUT_MS, nativeDelegationPrompt, parseNativeDelegatedReply, taskContextLines } from './question-delegation';
import { collectOwnerVerbFacts, latestAuthorResult, ownerVerbViews } from '../verbs/owner-verbs';
import { automaticRetryForbidden, reportsExternalCause } from '../recovery/non-delivery';
import { REVIEWER_CONSULT_TIMEOUT_MS, consultRecovery, escalationRecovery, blockerCauseId, consultContinuationInstruction, escalationAnswerControl, escalationContinuationInstruction, escalationWaitDetail, escalationVerbChoices, extractDecisionIdCandidates, extractFirstIsoTimestamp, extractTaskReferenceCandidates, unknownEscalationAttentionDetail, type EscalationVerbChoice, type PlannerEscalation, isProviderFailure, findOpenPlannerEscalation, parseEscalationReply, plannerEscalationChoicesFor, plannerEscalationQuestion, plannerEscalations, reviewerConsultQuestion, reviewerConsults, reviewContinuationCauseId, reviewContinuationEscalationQuestion, type LadderEvent } from './blocker-ladder';
import type { Resolution } from '../resolution';
import { DelegatedHostUnavailable } from './delegation';

/** Owner-verb suffix on a proof-only escalation: receipt review when that is the wait, else proof. */
function plannerEscalationOwnerSuffix(t: Task): string {
  if (proofOnlyReceiptAwaitingReview(t))
    return ' Available owner verb: move to=review (starts a receipt reviewer at the same commit; the receipt is the subject).';
  if (t.entrypoint === 'proof')
    return ' Available owner verb: proof (activate the qualification when authorization evidence is complete).';
  return '';
}

function plannerEscalationSuggestedVerbs(t: Task): TaskStopVerb[] | undefined {
  if (proofOnlyReceiptAwaitingReview(t)) return ['move'];
  if (t.entrypoint === 'proof') return ['proof'];
  return undefined;
}

/** The blocker ladder: worker, reviewer consult, planner, operator. */
export class Ladder {
  private readonly escalationSettlements = new Map<string, Promise<string | null>>();
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  /** Spec 058 slice 17: the ladder sends this process is driving, so a rerun never double-sends. */
  readonly routingEscalations = new Set<string>();
  readonly routingConsults = new Set<string>();
  /** Escalations whose unknown-delivery attention is being delivered now, so a pass cannot double-send. */
  readonly attentioningEscalations = new Set<string>();
  /**
   * Papercut 2ef86450: an escalation whose delivery is unknown is never resent, but
   * once it outlives the stall threshold the task surfaces as visible attention
   * (owner, question, exits) and the project planner hears about it once on the
   * agent channel. The stop is re-asserted each ladder pass; the message is not.
   */
  attentionUnknownEscalation(t: Task, escalation: Pick<PlannerEscalation, 'id' | 'question'>): void {
    const current = this.store.task(t.id);
    const owner = taskOwner(current);
    this.resolution.recordStop(current, 'operator_needed', unknownEscalationAttentionDetail(escalation, owner), taskStopVerbsFor('operator_needed'));
    const events = this.store.eventsAll(t.id);
    if (events.some(event => event.kind === 'planner_escalation_attention' && event.detail.startsWith(`${escalation.id}:`))) return;
    this.store.event(t.id, 'planner_escalation_attention', `${escalation.id}: unknown delivery outlived the stall threshold; surfaced as visible attention with owner ${owner}`.slice(0, 4000));
    void this.notifyUnknownEscalation(this.store.task(t.id), escalation, owner);
  }
  /** One agent-channel message to the project's planner; the recorded intent prevents a resend. */
  private async notifyUnknownEscalation(t: Task, escalation: Pick<PlannerEscalation, 'id' | 'question'>, owner: string): Promise<void> {
    if (this.attentioningEscalations.has(escalation.id)) return;
    if (this.store.eventsAll(t.id).some(event => event.kind === 'planner_escalation_attention_sent' && event.detail.startsWith(`${escalation.id}:`))) return;
    this.attentioningEscalations.add(escalation.id);
    try {
      if (!this.adapter.notify) {
        this.store.event(t.id, 'planner_escalation_attention_missed', `${escalation.id}: no agent-message channel is available`);
        return;
      }
      const recipient = await this.resolution.escalationRecipient(this.store.task(t.id)).catch(() => null);
      if (!recipient) {
        this.store.event(t.id, 'planner_escalation_attention_missed', `${escalation.id}: no project planner or task owner to message`);
        return;
      }
      const fresh = this.store.task(t.id);
      const host = recipient === fresh.originAgentId || recipient === fresh.notificationAgentId
        ? fresh.originHostId ?? fresh.hostId : await this.resolution.identifyOriginHost(recipient);
      if (!host || !this.resolution.withHost(host, () => this.resolution.originHostAvailable(host))) {
        this.store.event(t.id, 'planner_escalation_attention_missed', `${escalation.id}: ${recipient} is not reachable on a live host`);
        return;
      }
      // The durable intent is recorded before the send, so a delivery nobody
      // observed stays unknown and is never repeated.
      this.store.event(t.id, 'planner_escalation_attention_sent', `${escalation.id}: ${recipient} on host ${host}`);
      await this.resolution.withHost(host, () => this.resolution.host.sendMessage(recipient, {
        messageId: `ns-escalation-attention-${escalation.id}`, text: unknownEscalationAttentionDetail(escalation, owner) }));
      this.store.event(t.id, 'planner_escalation_attention_delivered', `${escalation.id}: ${recipient}`);
    } catch (error) {
      this.store.event(t.id, 'planner_escalation_attention_unknown', `${escalation.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
    } finally {
      this.attentioningEscalations.delete(escalation.id);
    }
  }
  resumeDelegations(task: Task): void {
    const events = this.store.eventsAll(task.id);
    // Spec 058 slice 17: durable consult and escalation intents survive a restart.
    // A recorded delivery resumes its original answer window or consumes its receipt.
    // Without that journal evidence, an unobserved send remains unknown and is never
    // repeated. Settled answers and operator classifications remain terminal.
    for (const consult of reviewerConsults(events)) {
      if (consultRecovery({
        answered: consult.answered,
        unknown: consult.unknown,
        recoverable: consult.unknown ? this.resolution.recoverableDelegation([`ns-reviewer-consult-${consult.id}`]) : false,
        question: consult.question,
        hasAdapter: consult.reviewer ? Boolean(this.adapter.askReviewer) : Boolean(this.adapter.createConsultReviewer && this.adapter.askReviewer),
        inFlight: this.routingConsults.has(consult.id),
      }).kind === 'skip' || !consult.question) continue;
      this.routingConsults.add(consult.id);
      void this.runReviewerConsult(task, { id: consult.id, reviewer: consult.reviewer, question: consult.question })
        .catch(error => {
          if (this.resolution.stopped() || !this.consultStillOwnsWait(task.id, consult.id)) return;
          if (error instanceof DelegatedHostUnavailable) return;
          this.store.event(task.id, 'reviewer_consult_unknown', `${consult.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
          this.escalateConsultedBlocker(task, { id: consult.id });
        })
        .finally(() => this.routingConsults.delete(consult.id));
    }
    for (const escalation of plannerEscalations(events)) {
      const windows = [`ns-escalation-${escalation.id}`, `ns-escalation-${escalation.id}-project`, `ns-decider-${escalation.id}`];
      if (escalationRecovery({
        missedNoAnswer: events.some(event => event.kind === 'planner_escalation_missed' && event.detail.startsWith(`${escalation.id}: no delegated answer was produced;`)),
        answered: escalation.answered,
        unknown: escalation.unknown,
        observing: escalation.unknown ? this.resolution.recoverableDelegation(windows, false) : false,
        missed: escalation.missed,
        recoverable: escalation.missed ? this.resolution.recoverableDelegation(windows) : false,
        decisionId: escalation.decisionId,
        question: escalation.question,
        inFlight: this.routingEscalations.has(escalation.id),
      }).kind === 'skip' || !escalation.question) continue;
      this.routingEscalations.add(escalation.id);
      void this.routePlannerEscalation(task, escalation.id, escalation.question)
        .catch(error => {
          if (this.resolution.stopped()) return;
          this.store.event(task.id, 'planner_escalation_unknown', `${escalation.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
          this.resolution.waiting(this.store.task(task.id), escalationWaitDetail.unknown(escalation.id), 'escalated');
        })
        .finally(() => this.routingEscalations.delete(escalation.id));
    }
  }
  private escalationWaitState(id: string, wait: { kind: 'time' | 'decision'; target: string; stopDetail?: string; stopReason?: 'lifecycle' | 'escalated' }) {
    const stopDetail = wait.stopDetail ?? (wait.kind === 'time'
      ? `Escalation ${id}: waiting until ${wait.target}`
      : `Escalation ${id}: waiting for operator decision ${wait.target}`);
    const stopReason = wait.stopReason ?? (wait.kind === 'time' ? 'lifecycle' : 'escalated');
    return { stopDetail, stopReason };
  }
  /** The wait event and the actual task stop are one durable state transition. */
  private establishEscalationWait(taskId: string, id: string, wait: { kind: 'time' | 'decision'; target: string; stopDetail?: string; stopReason?: 'lifecycle' | 'escalated' }, afterEventId = 0): boolean {
    return this.store.transaction(() => {
      const current = this.store.task(taskId);
      if (['done', 'cancelled'].includes(current.phase)) return false;
      const events = this.store.eventsAll(taskId);
      if (afterEventId > 0 && events.some(event => event.id > afterEventId && event.kind === 'operator_control' && event.detail !== 'note')) return false;
      if (wait.kind === 'decision') {
        let decision: DecisionView;
        try { decision = new Decisions(this.store).get({ id: wait.target }); } catch { return false; }
        if (!['open', 'answered'].includes(decision.status)) return false;
      }
      const { stopDetail, stopReason } = this.escalationWaitState(id, wait);
      const expected = this.escalationWaitState(id, wait);
      const recordedWait = events.findLast(event => event.kind === 'planner_escalation_wait' && event.detail.startsWith(`${id}:`)
        && (() => {
          try {
            const value = JSON.parse(event.detail.slice(id.length + 2)) as { kind?: string; target?: string; stopDetail?: string; stopReason?: string };
            const prior = this.escalationWaitState(id, { ...wait, stopDetail: value.stopDetail, stopReason: value.stopReason as 'lifecycle' | 'escalated' | undefined });
            return value.kind === wait.kind && value.target === wait.target
              && prior.stopDetail === expected.stopDetail && prior.stopReason === expected.stopReason;
          } catch { return false; }
        })());
      if (!recordedWait) this.store.event(taskId, 'planner_escalation_wait', `${id}: ${JSON.stringify({ ...wait, stopDetail, stopReason })}`);
      const stop = this.store.task(taskId).resolution.stop;
      if (stop?.reason !== stopReason || stop.detail !== stopDetail)
        this.resolution.waiting(this.store.task(taskId), stopDetail, stopReason);
      const established = this.store.task(taskId).resolution.stop;
      return established?.reason === stopReason && established.detail === stopDetail;
    });
  }
  async resumeEscalationWaits(task: Task): Promise<void> {
    const events = this.store.eventsAll(task.id);
    for (const event of events.filter(item => item.kind === 'planner_escalation_wait')) {
      const id = event.detail.split(':', 1)[0]!;
      if (events.some(item => item.kind === 'planner_escalation_wait_superseded' && item.detail.startsWith(`${id}:`))) continue;
      const intent = events.some(item => item.kind === 'planner_escalation_wake_intent' && item.detail.startsWith(`${id}:`));
      if (intent) {
        const finished = events.some(item => ['planner_escalation_woke', 'planner_escalation_wake_refused'].includes(item.kind) && item.detail.startsWith(`${id}:`));
        if (!finished && !this.resolution.wakingEscalations.has(id)) this.resolution.waiting(this.store.task(task.id), `Escalation ${id} wake outcome is unknown; inspect before retrying`, 'escalated');
        continue;
      }
      const wait = JSON.parse(event.detail.slice(id.length + 2)) as { kind: 'task' | 'time' | 'decision'; target: string; waitId?: string; stopDetail?: string; stopReason?: 'lifecycle' | 'escalated' };
      if (events.some(item => item.id > event.id && item.kind === 'operator_control' && item.detail !== 'note')) {
        this.store.event(task.id, 'planner_escalation_wait_superseded', `${id}: a later owner control changed the task`);
        continue;
      }
      let current = this.store.task(task.id);
      if (wait.kind === 'task' && current.prerequisiteWait && current.prerequisiteWait.id === wait.waitId && !current.prerequisiteWait.releasedAt) {
        this.store.reconcilePrerequisiteWait(current.id);
        current = this.store.task(task.id);
      }
      if (wait.kind === 'task' && current.prerequisiteWait?.id !== wait.waitId) {
        this.store.event(task.id, 'planner_escalation_wait_superseded', `${id}: prerequisite wait changed`);
        continue;
      }
      if (wait.kind !== 'task') {
        const waitControl = { kind: wait.kind as 'time' | 'decision', target: wait.target,
          stopDetail: wait.stopDetail, stopReason: wait.stopReason };
        const expected = this.escalationWaitState(id, waitControl);
        if (current.resolution.stop?.reason !== expected.stopReason || current.resolution.stop.detail !== expected.stopDetail) {
          const pending = events.findLast(item => item.kind === 'planner_escalation_answer_pending' && item.detail.startsWith(`${id}:`)
            && item.id < event.id && (() => {
              try {
                const answer = JSON.parse(item.detail.slice(id.length + 1).trim()) as { control?: { kind?: string; target?: string } };
                return answer.control?.kind === waitControl.kind && answer.control.target === waitControl.target;
              } catch { return false; }
            })());
          const linkedClassification = waitControl.kind === 'decision'
            && expected.stopDetail === escalationWaitDetail.operator(id, waitControl.target)
            && events.some(item => item.kind === 'planner_escalation_decision_linked' && item.detail === `${id}: decision ${waitControl.target}`);
          const repaired = (pending || linkedClassification)
            && this.establishEscalationWait(task.id, id, waitControl, pending?.id ?? 0);
          current = this.store.task(task.id);
          if (!repaired || current.resolution.stop?.reason !== expected.stopReason || current.resolution.stop.detail !== expected.stopDetail) {
            this.store.event(task.id, 'planner_escalation_wait_superseded', `${id}: task stop changed and the recorded wait could not be restored`);
            continue;
          }
        }
      }
      if (wait.kind === 'task' && !current.prerequisiteWait?.releasedAt) continue;
      if (wait.kind === 'time' && Date.parse(wait.target) > Date.now()) continue;
      let decision: DecisionView | null = null;
      if (wait.kind === 'decision') {
        try { decision = new Decisions(this.store).get({ id: wait.target }); } catch { continue; }
        if (decision.status !== 'answered' || !decision.answer) continue;
      }
      this.store.event(task.id, 'planner_escalation_wake_intent', `${id}: ${wait.kind} ${wait.target}`);
      this.resolution.wakingEscalations.add(id);
      if (decision?.answer) {
        const refusal = await this.settlePlannerEscalation(current, id, decision.answer.text, decision.answer.answeredBy);
        if (refusal) this.store.event(task.id, 'planner_escalation_wake_refused', `${id}: ${refusal}`);
        else this.store.event(task.id, 'planner_escalation_woke', `${id}: operator decision ${wait.target} applied`);
        this.resolution.wakingEscalations.delete(id);
        continue;
      }
      try {
        if (!this.resolution.applyOperatorControl) throw Error('No control applier is bound');
        // Restart is the ordinary owner verb for resuming the parked step. It
        // rechecks the saved task and all delivery and exact-head gates.
        await this.resolution.applyOperatorControl(taskControlInputSchema.parse({ taskId: current.id, version: current.version,
          action: 'restart', reason: `Escalation ${id}: ${wait.kind} ${wait.target} settled` }));
        this.store.event(task.id, 'planner_escalation_woke', `${id}: ${wait.kind} ${wait.target} settled; restarted the parked step`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.event(task.id, 'planner_escalation_wake_refused', `${id}: ${message}`.slice(0, 4000));
        this.resolution.waiting(this.store.task(task.id), `Escalation ${id} wake was refused: ${message}`, 'escalated');
      } finally { this.resolution.wakingEscalations.delete(id); }
    }
  }
  /**
   * Spec 058 slice 17 (task 584): the blocker ladder for a stuck responsible task.
   * A worker or revision run that ended blocked/error — anything but a provider
   * failure, which the ordinary replacement settles — climbs: one reviewer consult
   * per cause whose advice continues the same worker; then one planner escalation
   * per cause as a delegated decision, which the task waits on with no further
   * worker turns; a repeated blocker on the same cause attaches to the open
   * escalation instead of starting another turn or ask. Returns true when the
   * ladder owns the park, so the caller writes no ordinary blocked stop.
   */
  async responsibleBlockerLadder(t: Task, input: { source: 'worker' | 'revision' | 'executor' | 'reviewer' | 'recovery' | 'closeout'; runId: string | null; completion: Completion }): Promise<boolean> {
    // Queue #691: a finished task has no ladder. Returning true tells the caller the park is
    // not its to write, so a late blocked report never moves a done task to blocked.
    if (['done', 'cancelled'].includes(t.phase)) return true;
    if (isDispositionActive(t) || this.resolution.paused()) return false;
    const completion = input.completion;
    // A provider failure is never a ladder blocker: the failover sweep and the
    // non-delivery replacement path keep their own handling (Slices 2 and 14).
    if (isProviderFailure(completion)) return false;
    // A source-approved proof round's blocked return is the proof wait's own
    // episode (Spec 058 slice 9): the retained reviewer named those proofs, the
    // ordinary re-park applies, and the ladder stands down.
    if (proofWaitApplies(t)) return false;
    // A recovery report about an otherwise ready lifecycle step is not a
    // planning question. Reuse the ordinary move only when the current view
    // offers it, and never step over an uncertain delivery or merge response.
    if (input.source === 'recovery' && this.resolution.applyOperatorControl && t.completion?.status === 'ready_for_review'
      && t.prHead && !t.resolution.mergeIntent && !t.resolution.mergedCommit
      && !blockingRecoveryEffects(this.store, t, { noticeKinds: 'all' }).length) {
      const runs = this.store.runs(t.id);
      const reader = runs.some(run => run.role === 'reviewer' && !run.released);
      const target = readyReviewAtHead(t)
        ? 'merge' : t.phase === 'awaiting_review' && !reader && !t.resolution.review ? 'review' : null;
      const available = target && ownerVerbViews(collectOwnerVerbFacts(this.store, t, null, input.runId))
        .some(view => view.verb === 'move' && view.available && view.args?.to === target && !(view.fill ?? []).includes('qualification'));
      if (target && available) {
        try {
          await this.resolution.applyOperatorControl(taskControlInputSchema.parse({ taskId: t.id, version: t.version, action: 'move', to: target,
            reason: `Resume the already-ready ${target} step after recovery` }));
          this.store.event(t.id, 'planner_escalation_avoided', `Recovery found the ${target} step ready; its ordinary gates remain in force`);
          return true;
        } catch (error) {
          this.store.event(t.id, 'planner_escalation_automatic_refused', `${target}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
          t = this.store.task(t.id);
        }
      }
    }
    // The lane reads honestly while the ladder holds it, and the completed run's
    // lease ends here: without clearing it, every later pass would replay this
    // completion into a second consult or escalation.
    if ((completion.status === 'blocked' || completion.status === 'error')
      && (t.phase !== completion.status || t.resolution.currentRunId || t.resolution.attention))
      t = this.resolution.update(t, { currentRunId: null, integrationTurn: null, attention: false },
        { phase: completion.status, reason: completion.summary.slice(0, 4000) }, 'blocker_ladder_park', completion.summary.slice(0, 2000));
    // effigy#697: a GO-gate reviewer's blocked report is the release GO's wait, not a
    // planning question. No consult, escalation or route offer applies; only the answer.
    if (this.holdProofOnlyGoWait(t)) return true;
    const events = this.store.eventsAll(t.id);
    const cause = blockerCauseId(t.id, completion);
    const open = findOpenPlannerEscalation(events as LadderEvent[], cause);
    if (open) {
      const attach = `${open.id}: attach run ${input.runId ?? 'worker'}; ${cause}`;
      if (!events.some(event => event.kind === 'planner_escalation_attached' && event.detail === attach))
        this.store.event(t.id, 'planner_escalation_attached', attach);
      this.resolution.waiting(this.store.task(t.id), `${escalationWaitDetail.attached(open.id)}; reported cause: ${completion.summary.slice(0, 2000)}`,
        'escalated', plannerEscalationSuggestedVerbs(t));
      return true;
    }
    const consults = reviewerConsults(events as LadderEvent[]);
    const continuation = input.runId ? this.store.run(input.runId)?.revisionCause === 'consult' : false;
    const consulted = consults.find(consult => consult.cause === cause)
      ?? (continuation ? consults.findLast(consult => consult.answered) : undefined);
    // A cause genuinely outside the task never needs a second opinion: it goes
    // straight to the planner. A consulted cause skips the second ask too.
    const secondOpinionMakesSense = input.source === 'worker' || input.source === 'revision';
    if (secondOpinionMakesSense && !consulted && !automaticRetryForbidden(t, this.store.runs(t.id)) && !reportsExternalCause(completion, events, input.runId ?? 'worker')) {
      const reviewer = t.resolution.reviewerAgentId;
      if ((reviewer && this.adapter.askReviewer) || (!reviewer && this.adapter.createConsultReviewer && this.adapter.askReviewer)) {
        this.resolution.openReviewerConsult(this.store.task(t.id), { cause, runId: input.runId, completion, reviewer });
        return true;
      }
      this.store.event(t.id, 'reviewer_consult_unavailable', `${cause}: reviewer consult adapter unavailable; planner must decide the next step`);
    }
    const advice = consulted?.advice
      ?? (consulted ? 'The retained reviewer was consulted for this cause but gave no usable advice in time.' : null);
    const question = `${plannerEscalationQuestion(t, completion, advice)}${plannerEscalationOwnerSuffix(t)}`;
    this.resolution.openPlannerEscalation(this.store.task(t.id), { cause, runId: input.runId,
      question, payload: { cause, runId: input.runId ?? null, source: input.source, question }, causeDetail: completion.summary,
      suggestedVerbs: plannerEscalationSuggestedVerbs(t) });
    return true;
  }
  /**
   * effigy#697: while a proof-only release GO is open the task waits on the operator.
   * The wait is read from that fact, not kept from an earlier write: the reviewer's first
   * idle observation rewrites the task reason, and a reason change clears a stop that was
   * not written explicitly, so each quantum re-asserts it.
   */
  holdProofOnlyGoWait(t: Task): boolean {
    // Every quantum calls this, so the task's own fields gate the run and event reads.
    if (!t.requiresOperatorGo || t.phase !== 'blocked') return false;
    const question = openProofOnlyGo(t, this.store.runs(t.id), this.store.eventsAll(t.id));
    if (!question) return false;
    this.resolution.waiting(this.store.task(t.id), escalationWaitDetail.proofGo(t.proofOnly?.commit ?? 'the merged commit', question), 'escalated');
    return true;
  }
  /** Run the executor rung after its completion transaction commits. */
  async settleCompletedExecutorBlocker(input: Completion): Promise<void> {
    if (!['blocked', 'error'].includes(input.status)) return;
    const run = this.store.run(input.runId);
    if (!run || run.role !== 'executor' || run.taskId !== input.taskId || run.completion?.eventId !== input.eventId) return;
    const task = this.store.task(input.taskId);
    // Only escalate when settlement left this responsible task parked on the
    // reported result. A proof run returned to its worker or review lane has an
    // actionable owner and does not need planner intervention.
    if (task.responsible !== true || task.phase !== input.status || task.reason !== input.summary || task.resolution.currentRunId) return;
    await this.resolution.responsibleBlockerLadder(task, { source: 'executor', runId: run.id, completion: input });
  }
  /** Keep a completed result and hand a forbidden automatic relaunch to the planner. */
  suppressAutomaticRetry(t: Task, site: string, evidence: string, runId: string | null = null): boolean {
    if (!automaticRetryForbidden(t, this.store.runs(t.id))) return false;
    const cause = `automatic-retry-suppressed:${site}:${runId ?? 'task'}`;
    const events = this.store.eventsAll(t.id);
    if (events.some(event => event.kind === 'automatic_retry_suppressed' && event.detail.startsWith(`${cause}:`))) return true;
    const kept = evidence.slice(0, 3000);
    this.store.event(t.id, 'automatic_retry_suppressed', `${cause}: kept evidence: ${kept}`);
    const question = clipDecisionQuestion(`The owner forbids automatic retry at ${site}. Preserve the completed result and decide the next existing owner action. Evidence: ${kept}`);
    this.resolution.openPlannerEscalation(this.store.task(t.id), { cause, runId, question,
      payload: { cause, runId, site, evidence: kept, question } });
    return true;
  }
  /** Record the durable consult intent, park the task inside the ladder, then drive the consult. */
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
    const events = () => this.store.eventsAll(t.id);
    if (events().some(event => event.kind === 'planner_escalation_missed' && event.detail.startsWith(`${id}: no delegated answer was produced;`))) return;
    const recoverable = this.resolution.recoverableDelegation([`ns-escalation-${id}`, `ns-decider-${id}`]);
    const observing = this.resolution.recoverableDelegation([`ns-escalation-${id}`, `ns-decider-${id}`], false);
    if (events().some(event => event.kind === 'planner_escalation_action_uncertain' && event.detail.startsWith(`${id}:`))) return;
    if (events().some(event => (['planner_escalation_answered', 'planner_escalation_resolved'].includes(event.kind) || (!observing && event.kind === 'planner_escalation_unknown')) && event.detail.startsWith(`${id}:`))) return;
    if (!recoverable && events().some(event => event.kind === 'planner_escalation_sent' && event.detail.startsWith(`${id}:`))) {
      this.store.event(t.id, 'planner_escalation_unknown', `${id}: a previous delegate delivery could not be observed; Nucleus never re-asks it`);
      this.resolution.waiting(this.store.task(t.id), escalationWaitDetail.unknown(id), 'escalated');
      return;
    }
    if (!recoverable) this.store.event(t.id, 'planner_escalation_sent', `${id}: sent`);
    const context = this.resolution.decisionContext(t);
    const offerEvent = events().find(event => event.kind === 'planner_escalation_offered' && event.detail.startsWith(`${id}: `));
    const offered: EscalationVerbChoice[] = offerEvent
      ? JSON.parse(offerEvent.detail.slice(id.length + 2)) as EscalationVerbChoice[]
      : escalationVerbChoices(ownerVerbViews(collectOwnerVerbFacts(this.store, this.store.task(t.id))));
    if (!offerEvent) this.store.event(t.id, 'planner_escalation_offered', `${id}: ${JSON.stringify(offered)}`);
    const choices = [...plannerEscalationChoicesFor(t), ...offered.map(item => item.label)];
    const payload = events().find(event => event.kind === 'planner_escalation_payload'  && event.detail.startsWith(`${id}: `));
    const runId = payload ? (JSON.parse(payload.detail.slice(id.length + 2)) as { runId?: string }).runId : undefined;
    const sourceAgentId = runId ? this.store.run(runId)?.agentId ?? t.agentId ?? undefined : t.agentId ?? undefined;
    let pending = false;
    // Task 1109: the task's own planner first, then the project planner, then the decider.
    const rungs = (await this.resolution.plannerRungsFor(t)).rungs;
    const delegated = await delegateQuestion(this.resolution, t, {
      planners: rungs.map(item => ({ ...item, messageId: `ns-escalation-${id}${item.rung === 'project' ? '-project' : ''}` })), decisionId: id,
      context: { question, choices, context }, signal: new AbortController().signal, sourceAgentId,
      parse: text => parseEscalationReply(text, choices), retainDecider: true,
      current: () => !plannerEscalations(events() as LadderEvent[]).find(item => item.id === id)?.answered,
      canAdvance: () => !escalationOutlived(this.store.task(t.id)),
      onIntent: (role, agentId, rung) => {
        if (role === 'planner') this.resolution.waiting(this.store.task(t.id), `Waiting with the planner or task owner ${agentId}: blocker escalation ${id} (${rung === 'task' ? 'task planner' : 'project planner'} rung) is open`, 'escalated');
        this.store.event(t.id, 'planner_escalation_delegated', `${id}: ${role === 'planner' ? `${rung === 'task' ? 'task planner' : 'project planner'} ${agentId}; asked` : 'decider requested'}`);
      },
      onSkip: (rung, agentId, detail) => this.store.event(t.id, 'planner_escalation_delegation_skipped', `${id}: ${rung} planner ${agentId} skipped: ${detail}`.slice(0, 4000)),
      onMiss: detail => this.store.event(t.id, 'planner_escalation_missed', `${id}: ${detail}`),
      onUnknown: (role, agentId, error) => {
        pending = true;
        if (plannerEscalations(events() as LadderEvent[]).find(item => item.id === id)?.answered) return;
        this.store.event(t.id, 'planner_escalation_unknown', `${id}: ${role}${agentId ? ` ${agentId}` : ''}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
        this.resolution.waiting(this.store.task(t.id), escalationWaitDetail.unknown(id), 'escalated');
      },
    }).catch(error => { if (!(error instanceof DelegatedHostUnavailable)) throw error; pending = true; return null; });
    if (pending || this.resolution.stopped()) return;
    const reply = delegated?.reply ?? null;
    const who = delegated ? `${delegated.role} ${delegated.agentId}` : null;
    if (!reply && escalationOutlived(this.store.task(t.id))) {
      this.store.event(t.id, 'planner_escalation_answered', `${id}: answered by ordinary progress: the task merged or ended first`);
      return;
    }
    if (plannerEscalations(events() as LadderEvent[]).find(item => item.id === id)?.answered) return;
    if (!reply || !who) {
      if (who?.startsWith('decider ')) await this.resolution.host.archiveAgent(who.slice(8)).catch(() => {});
      this.store.event(t.id, 'planner_escalation_missed', `${id}: no delegated answer was produced; the escalation stays open for the planner`);
      return;
    }
    if (reply.kind === 'operator') {
      if (who.startsWith('decider ')) await this.resolution.host.archiveAgent(who.slice(8)).catch(() => {});
      this.resolution.classifyEscalationToOperator(this.store.task(t.id), id, reply.reason, who);
      return;
    }
    const answer = reply.kind === 'choice' ? `${reply.choice} — ${reply.reason}`.trim() : reply.answer;
    const recordedRefusal = events().findLast(event => event.kind === 'planner_escalation_answer_refused' && event.detail.startsWith(`${id}:`));
    const initialQuestionId = who.startsWith('decider ')
      ? `ns-decider-${id}`
      : delegated?.rung === 'project' ? `ns-escalation-${id}-project` : `ns-escalation-${id}`;
    let refusal = recordedRefusal
      ? recordedRefusal.detail.slice(`${id}:`.length).trim()
      : await this.resolution.settlePlannerEscalation(this.store.task(t.id), id, answer, who, offered, initialQuestionId);
    if (refusal) {
      const priorFollowup = events().findLast(event => event.kind === 'planner_escalation_followup_offered' && event.detail.startsWith(`${id}: `));
      const followupOffer = priorFollowup
        ? JSON.parse(priorFollowup.detail.slice(id.length + 2)) as { questionId: string; choices: string[]; ownerChoices: EscalationVerbChoice[] }
        : null;
      const followupQuestionId = followupOffer?.questionId ?? `ns-escalation-refusal-${id}`;
      const currentOffers = followupOffer?.ownerChoices ?? escalationVerbChoices(ownerVerbViews(collectOwnerVerbFacts(this.store, this.store.task(t.id))));
      const retryChoices = followupOffer?.choices ?? [...plannerEscalationChoicesFor(this.store.task(t.id)), ...currentOffers.map(item => item.label)];
      if (!followupOffer) this.store.event(t.id, 'planner_escalation_followup_offered', `${id}: ${JSON.stringify({ questionId: followupQuestionId, choices: retryChoices, ownerChoices: currentOffers })}`);
      if (!events().some(event => event.kind === 'planner_escalation_refusal_sent' && event.detail.startsWith(`${id}:`)))
        this.store.event(t.id, 'planner_escalation_refusal_sent', `${id}: ${refusal}`.slice(0, 4000));
      try {
        const recipient = who.replace(/^(?:planner|decider) /, '');
        const followup = await this.resolution.askBound(this.store.task(t.id), recipient, {
          prompt: nativeDelegationPrompt('planner', { question: `Your choice was refused: ${refusal}. Choose again for the same escalation.`, choices: retryChoices, context }),
          signal: new AbortController().signal, timeoutMs: DELEGATED_ANSWER_TIMEOUT_MS,
          messageId: followupQuestionId, sourceAgentId,
        }, 'planner');
        if (plannerEscalations(events() as LadderEvent[]).find(item => item.id === id)?.answered) return;
        const next = parseEscalationReply(followup, retryChoices);
        if (next?.kind === 'operator') this.resolution.classifyEscalationToOperator(this.store.task(t.id), id, next.reason, who);
        else if (next) {
          const nextAnswer = next.kind === 'choice' ? `${next.choice} — ${next.reason}` : next.answer;
          refusal = await this.resolution.settlePlannerEscalation(this.store.task(t.id), id, nextAnswer, who, currentOffers, followupQuestionId);
        }
      } catch (error) {
        this.store.event(t.id, 'planner_escalation_unknown', `${id}: refusal follow-up delivery: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
      }
    }
    if (who.startsWith('decider ')) await this.resolution.host.archiveAgent(who.slice(8)).catch(() => {});
  }
  /** A planner or decider that explicitly says it cannot decide reaches the operator: one Spec 032 decision. */
  operatorDecisionApplied(taskId: string, id: string): boolean {
    const events = this.store.eventsAll(taskId);
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
    const stop = this.store.task(taskId).resolution.stop;
    if (stop?.reason !== 'escalated' || stop.detail !== stopDetail) return false;
    try { return new Decisions(this.store).get({ id: decisionId }).links.tasks.includes(taskId); }
    catch { return false; }
  }
  classifyEscalationToOperator(t: Task, id: string, reason: string, who: string): void {
    if (this.operatorDecisionApplied(t.id, id)) return;
      const current = this.store.task(t.id);
      let events = this.store.eventsAll(t.id);
      if (this.operatorDecisionApplied(t.id, id)) return;
      if (!events.some(event => event.kind === 'planner_escalation_decision' && event.detail.startsWith(`${id}:`)))
        this.store.event(t.id, 'planner_escalation_decision', `${id}: the ${who} said it cannot decide: ${reason.slice(0, 300)}`.slice(0, 4000));
      const classification = this.store.eventsAll(t.id).findLast(event => event.kind === 'planner_escalation_decision' && event.detail.startsWith(`${id}:`));
      const payloadEvent = events.find(event => event.kind === 'planner_escalation_payload' && event.detail.startsWith(`${id}:`));
      let question = `The blocker escalation ${id} on "${current.title}" needs the operator.`;
      try { if (payloadEvent) question = (JSON.parse(payloadEvent.detail.slice(payloadEvent.detail.indexOf(':') + 1)) as { question?: string }).question ?? question; } catch { /* unreadable payload keeps the plain question */ }
      question = clipDecisionQuestion(question);
      const decisions = new Decisions(this.store);
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
      events = this.store.eventsAll(t.id);
      if (!events.some(event => event.kind === 'planner_escalation_decision_linked' && event.detail === `${id}: decision ${decision!.id}`))
        this.store.event(t.id, 'planner_escalation_decision_linked', `${id}: decision ${decision.id}`);
      const wait = { kind: 'decision' as const, target: decision.id, stopDetail: escalationWaitDetail.operator(id, decision.id), stopReason: 'escalated' as const };
      if (!this.establishEscalationWait(t.id, id, wait, classification?.id ?? 0))
        throw Error(`Escalation ${id} could not establish its operator decision wait`);
  }
  /** Record the answer before applying it; a refusal remains open. */
  settlePlannerEscalation(t: Task, id: string, answer: string, who: string, offered: EscalationVerbChoice[] = [], questionId = `ns-escalation-${id}`): Promise<string | null> {
    const key = `${t.id}:${id}`;
    const existing = this.escalationSettlements.get(key);
    if (existing) return existing;
    const settlement = this.settlePlannerEscalationOnce(t, id, answer, who, offered, questionId);
    this.escalationSettlements.set(key, settlement);
    void settlement.finally(() => { if (this.escalationSettlements.get(key) === settlement) this.escalationSettlements.delete(key); });
    return settlement;
  }
  /** Share a live route settlement with a duplicate receipt observer instead of declaring it uncertain. */
  async awaitDelegatedEscalationSettlement(taskId: string, id: string, questionId: string): Promise<{ status: 'applied' } | { status: 'refused'; reason: string } | null> {
    const settlement = this.escalationSettlements.get(`${taskId}:${id}`);
    if (!settlement) return null;
    const pending = this.store.eventsAll(taskId).findLast(event => event.kind === 'planner_escalation_answer_pending' && event.detail.startsWith(`${id}:`));
    if (!pending) return null;
    try {
      const intent = JSON.parse(pending.detail.slice(id.length + 1).trim()) as { questionId?: string };
      if (intent.questionId !== questionId) return null;
    } catch { return null; }
    const refusal = await settlement;
    return refusal ? { status: 'refused', reason: refusal } : { status: 'applied' };
  }
  private async settlePlannerEscalationOnce(t: Task, id: string, answer: string, who: string, offered: EscalationVerbChoice[], questionId: string): Promise<string | null> {
    const delegatedAnswer = /^(?:planner|decider) /.test(who);
    if (plannerEscalations(this.store.eventsAll(t.id) as LadderEvent[]).find(item => item.id === id)?.answered) {
      if (delegatedAnswer) throw Error(`Escalation ${id} is already settled; read next again`);
      return null;
    }
    if (escalationOutlived(this.store.task(t.id))) {
      this.store.event(t.id, 'planner_escalation_answer_pending', `${id}: ${JSON.stringify({ questionId, who, answer, control: null })}`);
      this.store.event(t.id, 'planner_escalation_answered', `${id}: answered by ${who}: ${answer.slice(0, 4000)}`);
      this.store.event(t.id, 'planner_escalation_applied', `${id}: nothing to apply; the task merged or ended first`);
      return null;
    }
    const control = escalationAnswerControl(answer);
    const choice = offered.find(item => answer === item.label || answer.startsWith(`${item.label} — `));
    const reason = answer.includes(' — ') ? answer.slice(answer.indexOf(' — ') + 3).trim() : answer.trim();
    const current = this.store.task(t.id);
    const grant = delegatedAnswer
      ? { caller: who.split(' ')[1] ?? 'unknown', delegated: true, note: `Delegated answer to escalation ${id} by ${who}: ${answer.slice(0, 1200)}` }
      : { caller: current.agentId ?? undefined, relayed: true, note: `The operator answered escalation ${id}: ${answer}`.slice(0, 4000) };
    try {
      if (!this.resolution.applyOperatorControl) throw Error('No control applier is bound');
      if (choice) {
        // Re-read `next` and match the offered identity, never accepting new fields,
        // force or an operator-only qualification from the delegate.
        const withoutVersion = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'version'));
        const fresh = escalationVerbChoices(ownerVerbViews(collectOwnerVerbFacts(this.store, current)))
          .find(item => item.verb === choice.verb && JSON.stringify(withoutVersion(item.args)) === JSON.stringify(withoutVersion(choice.args)));
        if (!fresh) throw Error(`The selected ${choice.verb} is no longer available; read next again`);
        const controlInput = taskControlInputSchema.parse({ ...fresh.args, taskId: current.id, version: current.version,
          action: fresh.verb, reason, ...grant });
        this.store.event(t.id, 'planner_escalation_answer_pending', `${id}: ${JSON.stringify({ questionId, who, answer, label: fresh.label, control: controlInput })}`);
        await this.resolution.applyOperatorControl(controlInput);
        this.store.event(current.id, 'planner_escalation_answered', `${id}: answered by ${who}: ${answer.slice(0, 4000)}`);
        this.store.event(current.id, 'planner_escalation_applied', `${id}: ${fresh.label}`);
        return null;
      }
      if (answer.startsWith('Wait for a task (')) {
        let prerequisite: Task | null = null;
        try {
          // The reason may carry a note after the reference; the first resolving token is the target.
          const candidates = extractTaskReferenceCandidates(reason);
          let lastError: unknown = null;
          for (const candidate of candidates) {
            try { prerequisite = this.resolution.messageRecipientTask(current, candidate); break; }
            catch (error) { lastError = error; }
          }
          if (!prerequisite) {
            try { prerequisite = this.resolution.messageRecipientTask(current, reason); }
            catch (error) { lastError = error; }
          }
          if (!prerequisite) throw lastError ?? Error(`No task reference in "${reason}"`);
        }
        catch (error) { throw Error(`Wait for a task (put its reference in Reason) could not read target "${reason}": ${error instanceof Error ? error.message : String(error)}`); }
        const controlInput = taskControlInputSchema.parse({ taskId: current.id, version: current.version,
          action: 'set_prerequisite_wait', waitsFor: [prerequisite.id], reason: `Escalation ${id}: waiting for ${prerequisite.reference ?? prerequisite.id}` });
        this.store.event(t.id, 'planner_escalation_answer_pending', `${id}: ${JSON.stringify({ questionId, who, answer, control: controlInput })}`);
        await this.resolution.applyOperatorControl(controlInput);
        const waiting = this.store.task(current.id);
        this.store.event(current.id, 'planner_escalation_wait', `${id}: ${JSON.stringify({ kind: 'task', target: prerequisite.id, waitId: waiting.prerequisiteWait?.id })}`);
        this.resolution.waiting(waiting, `Escalation ${id}: waiting for task ${prerequisite.reference ?? prerequisite.id} to settle`, 'prerequisite');
        this.store.event(current.id, 'planner_escalation_answered', `${id}: answered by ${who}: ${answer.slice(0, 4000)}`);
        this.store.event(current.id, 'planner_escalation_applied', `${id}: waiting for task ${prerequisite.reference ?? prerequisite.id}`);
        return null;
      }
      if (answer.startsWith('Wait until a time (')) {
        // The reason may carry a note after the timestamp; the first ISO timestamp with a timezone is the target.
        const timestamp = extractFirstIsoTimestamp(reason) ?? reason.trim();
        const at = Date.parse(timestamp);
        if (!Number.isFinite(at) || at <= Date.now() || !/(?:Z|[+-]\d\d:?\d\d)$/i.test(timestamp))
          throw Error(`Wait until a time (put an ISO timestamp in Reason) could not read target "${reason}": name a future ISO timestamp with a timezone`);
        const target = new Date(at).toISOString();
        this.store.event(t.id, 'planner_escalation_answer_pending', `${id}: ${JSON.stringify({ questionId, who, answer, control: { kind: 'time', target } })}`);
        if (!this.establishEscalationWait(current.id, id, { kind: 'time', target }))
          throw Error('The time wait could not be established against the current task');
        this.store.event(current.id, 'planner_escalation_answered', `${id}: answered by ${who}: ${answer.slice(0, 4000)}`);
        this.store.event(current.id, 'planner_escalation_applied', `${id}: waiting until ${target}`);
        return null;
      }
      if (answer.startsWith('Wait for an operator decision (')) {
        let decision: DecisionView | null = null;
        try {
          // The reason may carry a note after the ID; the first matching token is the target.
          const candidates = extractDecisionIdCandidates(reason);
          let lastError: unknown = null;
          const decisions = new Decisions(this.store);
          for (const candidate of candidates) {
            try { decision = decisions.get({ id: candidate }); break; }
            catch (error) { lastError = error; }
          }
          if (!decision) {
            try { decision = decisions.get({ id: reason.trim() }); }
            catch (error) { lastError = error; }
          }
          if (!decision) throw lastError ?? Error(`No decision ID in "${reason}"`);
          if (decision.status !== 'open') throw Error('the decision is not open');
        } catch (error) {
          throw Error(`Wait for an operator decision (put its ID in Reason) could not read target "${reason}": ${error instanceof Error ? error.message : String(error)}`);
        }
        this.store.event(t.id, 'planner_escalation_answer_pending', `${id}: ${JSON.stringify({ questionId, who, answer, control: { kind: 'decision', target: decision.id } })}`);
        if (!this.establishEscalationWait(current.id, id, { kind: 'decision', target: decision.id }))
          throw Error('The operator decision wait could not be established against the current task');
        this.store.event(current.id, 'planner_escalation_answered', `${id}: answered by ${who}: ${answer.slice(0, 4000)}`);
        this.store.event(current.id, 'planner_escalation_applied', `${id}: waiting for operator decision ${decision.id}`);
        return null;
      }
      if (control.action === 'wait') throw Error('A wait must name a task, time or operator decision');
      const input = control.action === 'stop'
        ? { taskId: current.id, version: current.version, action: 'stop', reason: `Escalation ${id} settled by ${who}: ${answer}`.slice(0, 4000), ...(delegatedAnswer ? { caller: grant.caller } : {}) }
        : { taskId: current.id, version: current.version, action: 'move', to: 'work',
          instruction: escalationContinuationInstruction(id, who, control.instruction).slice(0, 12000), reason, ...grant };
      const controlInput = taskControlInputSchema.parse(input);
      this.store.event(t.id, 'planner_escalation_answer_pending', `${id}: ${JSON.stringify({ questionId, who, answer, control: controlInput })}`);
      await this.resolution.applyOperatorControl(controlInput);
      this.store.event(current.id, 'planner_escalation_answered', `${id}: answered by ${who}: ${answer.slice(0, 4000)}`);
      this.store.event(current.id, 'planner_escalation_applied', `${id}: ${control.action === 'stop' ? 'stop and keep the work' : 'returned to the worker with the delegated direction'}`);
      if (control.action === 'work') {
        const after = this.store.task(current.id);
        if (!after.resolution.currentRunId && after.phase === 'changes_requested')
          this.resolution.update(after, { pendingRevisionCause: 'consult' as const }, {}, 'planner_escalation_continuation_classified', id);
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.event(current.id, 'planner_escalation_refused', `${id}: ${message}`.slice(0, 4000));
      this.resolution.waiting(this.store.task(current.id), `Escalation ${id} is unresolved: ${message}`, 'escalated');
      return message;
    }
  }
  async applyDelegatedEscalationAnswer(taskId: string, id: string, questionId: string, answer: string, who: string): Promise<string | null> {
    const task = this.store.task(taskId);
    const events = this.store.eventsAll(taskId);
    const followup = questionId.startsWith(`ns-escalation-refusal-${id}`)
      ? events.findLast(event => event.kind === 'planner_escalation_followup_offered'
        && event.detail.startsWith(`${id}: `)
        && (JSON.parse(event.detail.slice(id.length + 2)) as { questionId?: string }).questionId === questionId)
      : undefined;
    if (questionId.startsWith(`ns-escalation-refusal-${id}`) && !followup)
      throw Error(`Escalation ${id} has no recorded offer for this follow-up; read next again`);
    const offer = followup
      ? null
      : events.find(event => event.kind === 'planner_escalation_offered' && event.detail.startsWith(`${id}: `));
    const offered = followup
      ? (JSON.parse(followup.detail.slice(id.length + 2)) as { ownerChoices: EscalationVerbChoice[] }).ownerChoices
      : offer ? JSON.parse(offer.detail.slice(id.length + 2)) as EscalationVerbChoice[] : [];
    return this.settlePlannerEscalation(task, id, answer, who, offered, questionId);
  }

  /** Reconcile a receipt whose action crossed a service roll before its answer marker. */
  reconcileDelegatedEscalationAnswer(taskId: string, id: string, questionId: string, receiptEventId: number): 'applied' | 'unknown' | null {
    const events = this.store.eventsAll(taskId);
    const pending = events.findLast(event => event.kind === 'planner_escalation_answer_pending'
      && event.detail.startsWith(`${id}:`) && event.id > receiptEventId);
    if (!pending) return null;
    let intent: { questionId?: string; who?: string; answer?: string; label?: string;
      control?: TaskControlInput | { kind: 'time' | 'decision'; target: string } | null } = {};
    try { intent = JSON.parse(pending.detail.slice(id.length + 1).trim()); } catch { return 'unknown'; }
    if (intent.questionId !== questionId) return 'unknown';
    const control = intent.control;
    if (!control && escalationOutlived(this.store.task(taskId))) {
      this.store.event(taskId, 'planner_escalation_answered', `${id}: answered by ${intent.who ?? 'delegated planner'}: the task ended before the answer action`);
      this.store.event(taskId, 'planner_escalation_applied', `${id}: nothing to apply; the task merged or ended first`);
      return 'applied';
    }
    if (control && !('action' in control)) {
      const waitControl = control as { kind: 'time' | 'decision'; target: string };
      const waitEvent = events.findLast(event => event.kind === 'planner_escalation_wait' && event.detail.startsWith(`${id}:`) && (() => {
        try {
          const wait = JSON.parse(event.detail.slice(id.length + 2)) as { kind?: string; target?: string };
          return wait.kind === waitControl.kind && wait.target === waitControl.target;
        } catch { return false; }
      })());
      let recordedWait: { stopDetail?: string; stopReason?: 'lifecycle' | 'escalated' } = {};
      try { if (waitEvent) recordedWait = JSON.parse(waitEvent.detail.slice(id.length + 2)) as typeof recordedWait; } catch { return 'unknown'; }
      const established = this.establishEscalationWait(taskId, id, { ...waitControl, ...recordedWait }, pending.id);
      if (!established) return 'unknown';
      if (!events.some(event => event.kind === 'planner_escalation_answered' && event.detail.startsWith(`${id}:`) && event.id > pending.id))
        this.store.event(taskId, 'planner_escalation_answered', `${id}: answered by ${intent.who ?? 'delegated planner'}: recovered ${waitControl.kind} wait ${waitControl.target}`);
      if (!events.some(event => event.kind === 'planner_escalation_applied' && event.detail.startsWith(`${id}:`) && event.id > pending.id))
        this.store.event(taskId, 'planner_escalation_applied', `${id}: waiting for ${waitControl.kind} ${waitControl.target}`);
      return 'applied';
    }
    if (!control || !('action' in control)) return 'unknown';
    const expected = control;
    const recorded = events.find(event => event.kind === 'owner_control' && event.id > pending.id && (() => {
      try {
        const actual = JSON.parse(event.detail) as { verb?: string; caller?: string | null; reason?: string | null; identities?: Record<string, unknown> };
        if (actual.verb !== expected.action || actual.caller !== (expected.caller ?? null)
          || actual.reason !== (expected.reason ?? null)) return false;
        const identities = actual.identities as { taskId?: string; version?: number; move?: { to?: string | null }; restart?: { role?: string | null; fresh?: boolean }; route?: { role?: string | null; profileId?: string | null; now?: boolean }; effect?: string | null } | undefined;
        if (identities?.taskId !== taskId || identities.version !== expected.version) return false;
        if (expected.action === 'move') return identities.move?.to === (expected.to ?? null);
        if (expected.action === 'restart') return identities.restart?.role === (expected.role ?? null) && identities.restart?.fresh === (expected.fresh ?? false);
        if (expected.action === 'route') return identities.route?.role === (expected.role ?? null) && identities.route?.profileId === (expected.profileId ?? null) && identities.route?.now === (expected.now ?? false);
        if (expected.action === 'retry_effect') return identities.effect === (expected.effect ?? null);
        return true;
      } catch { return false; }
    })());
    if (!recorded) return 'unknown';
    if (!events.some(event => event.kind === 'planner_escalation_answered' && event.detail.startsWith(`${id}:`) && event.id > pending.id))
      this.store.event(taskId, 'planner_escalation_answered', `${id}: answered by ${intent.who ?? 'delegated planner'}: reconciled from owner_control event ${recorded.id}`);
    if (!events.some(event => event.kind === 'planner_escalation_applied' && event.detail.startsWith(`${id}:`) && event.id > pending.id))
      this.store.event(taskId, 'planner_escalation_applied', `${id}: ${intent.label ?? expected.action} (recovered from owner_control event ${recorded.id})`);
    return 'applied';
  }
  /** The one continuation shape both ladder exits use: the same retained worker continues with the recorded direction. */
  continueWorkerAfterLadder(t: Task, input: { instruction: string; event: string; reason: string; detail: string }): void {
    const current = this.store.task(t.id);
    this.resolution.update(current, { currentRunId: null, integrationTurn: null, attention: false, stop: null,
      pendingRevisionCause: 'consult' as const, pendingWorkerInstruction: input.instruction.slice(0, 12000) },
      { phase: 'changes_requested', reason: input.reason }, input.event, input.detail);
  }
  settleLadderControl(before: Task, after: Task, action: TaskControlInput["action"]): void {
    if (after.resolution.stop || !["move", "restart", "route", "retry_effect", "complete", "stop"].includes(action)) return;
    for (const escalation of plannerEscalations(this.store.eventsAll(before.id)).filter(item => !item.answered)) {
      this.store.event(before.id, "planner_escalation_answered", `${escalation.id}: answered by ordinary ${action}: task control moved the task`);
    }
  }
}
