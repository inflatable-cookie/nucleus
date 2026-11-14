import { resultApplied, recordResultApplied } from './applied-result';
import { REVISION_BUDGET, awaitingProofRoute, awaitingProofText, awaitingProofTexts, type AwaitingProof, type Completion, type Run, type Task } from '../../shared/contracts';
import {
  plannerEscalations, revisionCapCauseId, revisionCapEscalationQuestion, type LadderEvent,
} from '../questions/blocker-ladder';
import { MERGE_CONFLICT_REASON, isFailedChecksReason, isForgeCheckProofText, taskPrNumber, type PublicationOutcome, type VerifiedPr } from '../forge/index';
import { classifyGitTransientFailure, gitDeliveryUnknown, ReviewPublicationTransientError } from '../forge/forge-health';
import { git } from '../git/index';
import { readGitCheckout } from '../git/git-identity';
import { hookHoldReason } from '../hooks/hooks';
import { automaticRetryForbidden, consecutiveNonDeliveries, continuationInstruction, unfinishedContinuationEvents } from '../recovery/non-delivery';
import { proveReviewRunSource } from '../review/ordinary-review';
import { ProofExecutionRefusal, proofExecutionRecord, proofWorkerRequests, recordProofExecution, verifyProofSource } from '../qa/proof-execution';
import type { Resolution } from '../resolution';
import { retainReviewPublication, reviewVerdictApplied } from '../review/review-publication';
import { reviewRecordFor } from '../review/review-verdicts';
import { digest, now } from '../store/store';
import { coordinative, proofExecutor } from '../recovery/task-reasons';
import { settlementHeld } from '../closeout/queue-drain';
import { reviewInProgress } from '../review/review-continuation';

/** Publication may add an ID after the authenticated callback was received. */
function authenticatedReviewResult(store: ResultApplicationContext['store'], taskId: string, completion: Completion): boolean {
  const receipt = store.db.prepare('SELECT hash,response FROM receipts WHERE id=? AND task=? AND run=?')
    .get(completion.eventId, taskId, completion.runId) as {hash: string; response: string} | undefined;
  const { reviewId: _reviewId, reviewCommentId: _reviewCommentId, ...withoutPublication } = completion;
  return Boolean(receipt && JSON.parse(receipt.response).accepted === true
    && [completion, withoutPublication,
      { ...withoutPublication, ...(completion.reviewId !== undefined ? { reviewId: completion.reviewId } : {}) },
      { ...withoutPublication, ...(completion.reviewCommentId !== undefined ? { reviewCommentId: completion.reviewCommentId } : {}) }]
      .some(value => receipt.hash === digest(JSON.stringify(value))));
}

/** Apply a released result. */
export type ResultApplicationContext = Pick<Resolution, 'adapter' | 'advanceCloseoutResult' | 'attention' | 'hooks' | 'lease' | 'openPlannerEscalation' | 'ordinaryRoundCustody' | 'recordBlockedPrIdentity' | 'responsibleBlockerLadder' | 'responsiblePrReportRefused' | 'reviewerSetting' | 'settleAttentionEpisode' | 'settleAutomaticReplayHold' | 'stopped' | 'store' | 'suppressAutomaticRetry' | 'update' | 'waiting'>;

export class ResultApplication {
  constructor(readonly resolution: ResultApplicationContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  /** Apply an authenticated released reviewer result only from an interrupted review slot. */
  async reapplyPendingReview(t: Task): Promise<'none' | 'applied' | 'blocked'> {
    // An interrupted projection can retain the current round's authenticated
    // result on the task while its run still looks checkpointed. Restore that
    // result to ordinary release and intake; the checkpoint authorizes no send.
    const current = t.resolution.currentRunId ? this.store.run(t.resolution.currentRunId) : null;
    const saved = t.resolution.review;
    if (current && reviewInProgress(current) && saved && saved.taskId === t.id && saved.runId === current.id
      && saved.head === current.head && saved.head === t.prHead && current.agentId === t.resolution.reviewerAgentId
      && ['ready_to_merge', 'changes_required', 'blocked', 'error'].includes(saved.status)
      && authenticatedReviewResult(this.store, t.id, saved)) {
      this.store.putRun({ ...current, completion: saved });
      this.store.event(t.id, 'review_result_restored', current.id);
    }
    const runs = this.store.runs(t.id), events = this.store.eventsAll(t.id);
    const unappliedReview = runs.find(run => {
      if (run.role !== 'reviewer' || !run.released || run.status !== 'finished' || !run.completion
        || !['ready_to_merge', 'changes_required'].includes(run.completion.status)
        || !run.agentId || run.agentId !== t.resolution.reviewerAgentId
        || run.completion.taskId !== t.id || run.completion.runId !== run.id
        || run.completion.head !== t.prHead || run.head !== t.prHead
        || runs.slice(runs.indexOf(run) + 1).some(later => later.role === 'reviewer'
          && later.agentId === run.agentId && later.head === t.prHead)
        || (t.resolution.currentRunId !== null && t.resolution.currentRunId !== run.id)
        || t.resolution.review?.runId === run.id
        || events.some(event => ['review_result_applied', 'review_reapplied'].includes(event.kind) && event.detail === run.id)) return false;
      return true;
    });
    if (!unappliedReview?.completion) return 'none';
    const eligible = (() => {
      const reviewingSlot = t.phase === 'reviewing' && !t.resolution.attention && t.resolution.currentRunId === null;
      const completion = unappliedReview.completion!;
      const publicationId = this.resolution.reviewerSetting(t) ? completion.reviewId : completion.reviewCommentId;
      const publicationEvent = publicationId === undefined ? null : events.find(event => event.kind === 'review_published'
        && event.detail === `${this.resolution.reviewerSetting(t) ? 'PR review' : 'PR comment'} ${publicationId}`);
      const incident = t.resolution.incident;
      const completedEvent = events.find(event => ['run_completion', 'run_completion_corrected'].includes(event.kind)
        && event.detail === `${unappliedReview.role}: ${completion.summary}`);
      const unresolvedPublication = !publicationEvent && Boolean(this.store.getMeta(`reviewPublication:${unappliedReview.id}`));
      const unresolvedEscalation = !publicationEvent && plannerEscalations(events as LadderEvent[])
        // An escalation raised for this same interrupted application is part
        // of its recovery path. A different unanswered planner question still
        // owns the task and must not be bypassed by replaying the verdict.
        .some(escalation => !escalation.answered && !escalation.unknown
          && escalation.cause !== incident?.fingerprint);
      const ownerStoppedRun = events.some(event => event.kind === 'owner_stopped' && Date.parse(event.at) >= Date.parse(unappliedReview.createdAt));
      const interruptedApplication = ['reviewing', 'needs_attention'].includes(t.phase)
        && (t.resolution.currentRunId === null || t.resolution.currentRunId === unappliedReview.id)
        && Boolean(incident?.runId === unappliedReview.id && completedEvent
          && Date.parse(incident.createdAt) >= Date.parse(completedEvent.at)
          && (!publicationEvent || Date.parse(incident.createdAt) >= Date.parse(publicationEvent.at))
          && !unresolvedPublication && !unresolvedEscalation && !ownerStoppedRun);
      return reviewingSlot || interruptedApplication;
    })();
    if (!eligible) return 'blocked';
    // This path can apply a finished callback before the ordinary run
    // reconciler. Keep the same participant lease in front of its transition.
    try {
      // This exact recovery episode was created by the interrupted review
      // application and will be fenced by that application. It no longer owns
      // work in this transition; all other live participants still need proof.
      const incident = t.resolution.incident;
      const recoveryRunId = incident?.runId === unappliedReview.id
        && t.resolution.recovery?.incidentId === incident.id ? t.resolution.recovery.runId : null;
      const leased = await this.resolution.lease(t, undefined, recoveryRunId ?? undefined);
      if (!leased || settlementHeld(this.store, this.resolution.stopped())) return 'blocked';
    } catch (error) {
      this.resolution.attention(this.store.task(t.id), error instanceof Error ? error.message : String(error));
      return 'blocked';
    }
    const completion = unappliedReview.completion;
    if (!authenticatedReviewResult(this.store, t.id, completion)) return 'blocked';
    await this.advanceReviewerResult(t, unappliedReview, completion, true);
    return 'applied';
  }
  async advanceCompletedRun(t:Task, run:Run):Promise<void> {
    if (!run.released || !run.completion || resultApplied(this.store, t.id, run.id)) return;
    let c = run.completion;
    if (run.ordinaryDetached) {
      await this.resolution.ordinaryRoundCustody(t, run, true);
      const branch = readGitCheckout(t.directory!).branch;
      await proveReviewRunSource(t, run.head, branch === '');
      if (!branch) await git(t.directory!, 'checkout', t.branch);
      await proveReviewRunSource(t, run.head, false);
    }
    // A pass that read this reviewer as current before another pass settled it
    // has nothing left to do, and must not clear whichever run is current now.
    if (run.role === 'reviewer' && this.store.task(t.id).resolution.currentRunId !== run.id) return;
    if (run.role === 'reviewer' && t.resolution.pendingRevisionCause === 'continuation')
      t = this.resolution.update(t, { pendingRevisionCause: null });
    if (coordinative(run) && run.generation !== this.store.task(t.id).coordinatorGeneration) {
      this.store.transaction(() => {
        const latest = this.store.task(t.id);
        if (latest.resolution.currentRunId !== run.id || resultApplied(this.store, t.id, run.id)) return;
        this.resolution.update(latest, { currentRunId: null });
        recordResultApplied(this.store, t.id, run.id);
      });
      return;
    }
    if (proofExecutor(run.role)) { await this.advanceProofExecutionResult(t, run, c); return; }
    if (run.role === 'reviewer' && c.sourceApproved && c.awaitingProofs?.length && c.head === t.prHead) {
      // Spec 058 (task 533): a responsible task sends each named proof to whoever can
      // produce it before any operator question: an author proof returns to the
      // author, an environment fault gets one clean retry, and only external proofs
      // park the wait.
      this.store.transaction(() => {
        const current = this.store.task(t.id);
        if (resultApplied(this.store, t.id, run.id) || current.resolution.currentRunId !== run.id) return;
        this.routeAwaitingProofs(current, run, c);
        recordResultApplied(this.store, t.id, run.id);
      });
      return;
    }
    if (c.status === 'blocked' || c.status === 'error') {
      if (run.role === 'revision' && c.prNumber && !t.prUrl && !t.prHead && !t.resumePrNumber)
        t = await this.resolution.recordBlockedPrIdentity(t, c.prNumber, 'Blocked revision report');
      if (resultApplied(this.store, t.id, run.id) || this.store.task(t.id).resolution.currentRunId !== run.id) return;
      // Task 576: an unfinished revision return with new commits continues the same
      // round automatically, even past the revision count: it is progress inside an
      // owner-approved round, not a new review round, so it consumes no budget.
      // Each continuation dispatches a new revision at the new head, so this repeats
      // while every return shows new commits; a return with no progress falls
      // through to the #575 non-delivery path below.
      const unfinished = run.role === 'revision'
        ? unfinishedContinuationEvents(this.store.eventsAll(t.id)).find(item => item.runId === run.id) : undefined;
      if (unfinished) {
        const current = this.store.task(t.id);
        // Task 645: the owner's no-automatic-retry rule suppresses the
        // continuation and hands the kept result to the planner ladder.
        if (automaticRetryForbidden(current, this.store.runs(current.id))) {
          this.store.transaction(() => {
            const latest = this.store.task(t.id);
            if (resultApplied(this.store, t.id, run.id) || latest.resolution.currentRunId !== run.id) return;
            this.resolution.update(latest, { currentRunId: null, integrationTurn: null }, { phase: c.status as 'blocked' | 'error', reason: c.summary });
            this.resolution.suppressAutomaticRetry(this.store.task(t.id), 'unfinished', c.summary, run.id);
            recordResultApplied(this.store, t.id, run.id);
          });
          return;
        }
        const instruction = continuationInstruction(unfinished);
        this.store.transaction(() => {
          const latest = this.store.task(t.id);
          if (resultApplied(this.store, t.id, run.id) || latest.resolution.currentRunId !== run.id) return;
          const resolution = { ...latest.resolution, currentRunId: null, integrationTurn: null, attention: false,
            pendingRevisionCause: 'unfinished' as const, pendingWorkerInstruction: instruction };
          this.resolution.update(latest, resolution, { phase: 'changes_requested', reason: instruction },
            'unfinished_pushback', `${run.id}: same retained worker continues the unfinished round`);
          recordResultApplied(this.store, t.id, run.id);
        });
        return;
      }
      const nonDeliveries = consecutiveNonDeliveries(this.store.eventsAll(t.id));
      const nonDelivery = nonDeliveries.find(item => item.runId === run.id);
      if (nonDelivery && nonDeliveries.length <= 2) {
        const current = this.store.task(t.id);
        // Task 645: the owner's no-automatic-retry rule suppresses the
        // continuation and the provider-routed retry, and hands the kept
        // result to the planner ladder instead.
        if (automaticRetryForbidden(current, this.store.runs(current.id))) {
          this.store.transaction(() => {
            const latest = this.store.task(t.id);
            if (resultApplied(this.store, t.id, run.id) || latest.resolution.currentRunId !== run.id) return;
            this.resolution.update(latest, { currentRunId: null, integrationTurn: null }, { phase: c.status as 'blocked' | 'error', reason: c.summary });
            this.resolution.suppressAutomaticRetry(this.store.task(t.id), 'non_delivery', c.summary, run.id);
            recordResultApplied(this.store, t.id, run.id);
          });
          return;
        }
        const second = nonDeliveries.length === 2;
        const instruction = second
          ? 'Continue the approved task from the retained worktree and existing PR. The prior attempt reported no external blocker and produced no change; this attempt uses another eligible provider at the same capability. Decide within the brief, implement, and record decisions in the PR. Report blocked only for an external cause, naming it.'
          : 'You reported no external blocker and produced no change. Under the ownership rule, decide within the brief and implement; record decisions in the PR. Report blocked only for an external cause, naming it.';
        this.store.transaction(() => {
          const latest = this.store.task(t.id);
          if (resultApplied(this.store, t.id, run.id) || latest.resolution.currentRunId !== run.id) return;
          const resolution = { ...latest.resolution, currentRunId: null, integrationTurn: null, attention: false,
            pendingRevisionCause: 'non_delivery' as const, pendingWorkerInstruction: instruction,
            ...(second ? { nonDeliveryRoutePending: true } : {}) };
          this.resolution.update(latest, resolution, { phase: 'changes_requested', reason: second
            ? 'Second non-delivery: Nucleus is routing the next attempt to another eligible provider at the same capability'
            : 'Non-delivery: returning the retained worker to the brief for one continuation' },
            second ? 'non_delivery_provider_routed' : 'non_delivery_pushback', `${run.id}: ${instruction}`);
          recordResultApplied(this.store, t.id, run.id);
        });
        return;
      }
      // Retain the new non-approval before an awaited notification hook can hold
      // the transition. An older approval must not remain the current review.
      // The original run completion keeps the findings as immutable evidence;
      // the accepted-verdict history is untouched.
      if (run.role === 'reviewer' && (t.resolution.review?.eventId !== c.eventId || t.resolution.review.runId !== run.id))
        t = this.resolution.update(t, { review: c, integrationTurn: null }, {}, 'blocked_review_evidence', run.id);
      const hookState = this.resolution.hooks ? await this.resolution.hooks.emit('task.blocked', t, { event: 'task.blocked', summary: c.summary, delivery: { prUrl: t.prUrl, prNumber: c.prNumber ?? null, head: t.prHead, review: t.resolution.review?.summary ?? null, summary: c.summary } }) : null;
      if (resultApplied(this.store, t.id, run.id) || this.store.task(t.id).resolution.currentRunId !== run.id) return;
      if (hookState?.hold) { this.resolution.attention(this.store.task(t.id), hookHoldReason(hookState)); return; }
      if (hookState) t = this.resolution.settleAutomaticReplayHold(this.store.task(t.id), hookState.records, 'task.blocked');
      // Spec 058 slice 17: past the ownership rungs and with the repository hook
      // settled, a responsible task's blocked revision climbs the ladder instead of
      // parking for the operator: consult, then planner escalation. A provider
      // failure never enters the ladder.
      const applied = this.store.transaction(() => {
        const latest = this.store.task(t.id);
        if (resultApplied(this.store, t.id, run.id) || latest.resolution.currentRunId !== run.id) return false;
        this.resolution.update(latest, { currentRunId: null, integrationTurn: null }, { phase: c.status as 'blocked' | 'error', reason: c.summary });
        recordResultApplied(this.store, t.id, run.id);
        return true;
      });
      if (!applied) return;
      if (t.responsible) await this.resolution.responsibleBlockerLadder(this.store.task(t.id), {
        source: run.role === 'revision' ? 'revision' : run.role === 'reviewer' ? 'reviewer'
          : run.role === 'recovery' ? 'recovery' : run.role === 'closeout' ? 'closeout' : 'worker',
        runId: run.id, completion: c,
      });
      return;
    }
    if (!await this.resolution.lease(t) || settlementHeld(this.store, this.resolution.stopped())) return;
    if (run.role === 'reviewer') {
      await this.advanceReviewerResult(t, run, c);
    } else if (run.role === 'revision') {
      await this.advanceRevisionResult(t, run, c);
    } else if (run.role === 'verification') {
      // The manual verification coordinator is retired (Spec 058 cutover 2); no
      // verification run is launched any more. A stored row that still carries
      // one must not be misread as a closeout: refuse it and let recovery sweep
      // the run.
      throw new Error('The manual verification coordinator is retired; a verification run cannot advance the task');
    } else {
      await this.resolution.advanceCloseoutResult(t, run, c);
    }
    return;
  }
  /**
   * Task 405: settle one proof-only execution. The evidence it produced is
   * recorded whatever happened, and it is never a review, never a pass and never
   * a merge: the task returns to the phase it was activated from so the ordinary
   * independent review still has to run at the same exact head. Source drift
   * marks the evidence stale without erasing it, and a failed or unreadable
   * source never becomes a pass.
   */
  async advanceProofExecutionResult(t: Task, run: Run, c: Completion): Promise<void> {
    const binding = run.proofExecution;
    if (!binding) throw new Error('A proof executor completed without its bound subject');
    const current = this.store.task(t.id);
    const base = proofExecutionRecord({ ...run, agentId: run.agentId, completion: c }, current, binding.authorizedBy, binding.operationId);
    let status: 'passed' | 'failed' | 'stale' | 'unknown' = c.status === 'proof_executed' ? (c.proofResult?.status === 'passed' ? 'passed' : 'failed') : 'unknown';
    let drift = '';
    if (status === 'passed') {
      try {
        const source = await verifyProofSource(current, run.head);
        if (source.tree !== binding.tree) { status = 'stale'; drift = 'the checked-out tree differs from the reserved tree'; }
      } catch (error) {
        // A moved or dirty checkout is drift; an unreadable one is unknown, never a pass.
        status = error instanceof ProofExecutionRefusal && ['source_moved', 'source_branch', 'source_dirty'].includes(error.code) ? 'stale' : 'unknown';
        drift = error instanceof Error ? error.message : String(error);
      }
      if (settlementHeld(this.store, this.resolution.stopped())) return;
    }
    const latest = this.store.task(t.id);
    if (latest.resolution.currentRunId !== run.id) return;
    this.store.transaction(() => {
      if (resultApplied(this.store, t.id, run.id) || this.store.task(t.id).resolution.currentRunId !== run.id) return;
      recordResultApplied(this.store, t.id, run.id);
      const evidence = [c.summary, c.proofResult?.evidence, drift ? `Source proof: ${drift}` : ''].filter(Boolean).join('\n').slice(0, 4000);
      recordProofExecution(this.store, t.id, { ...base, status, exitCode: c.proofResult?.exitCode ?? null, evidence, refusedBeforeSelector: false, selectorStart: c.proofResult ? 'started' : 'unknown', ...(c.proofResult ? { selectorStartEvidence: c.proofResult.evidence || c.summary } : {}) },
        `${run.id}: ${status} for ${binding.selector} at ${run.head}`);
      const reason = status === 'passed'
        ? `Author-side proof execution ${run.id} passed ${binding.selector} at ${run.head}; a distinct independent review is still required`
        : status === 'failed'
          ? `Author-side proof execution ${run.id} did not pass ${binding.selector} at ${run.head}; the execution is recorded and that head's allowance is spent`
          : `Author-side proof execution ${run.id} cannot claim passing evidence for ${binding.selector} at ${run.head} (${status}); the evidence is retained`;
      const latest = this.store.task(t.id);
      if (latest.entrypoint === 'proof') {
        const reason = `Qualification ${run.id} settled ${status} for ${binding.selector} at merged commit ${run.head}; the retained reviewer will judge its receipt`;
        this.resolution.update(latest, { currentRunId: null, integrationTurn: null },
          { phase: 'awaiting_review', reason }, 'proof_only_execution_settled', `${run.id}: ${status} for ${binding.selector} at ${run.head}`);
        return;
      }
      if (status === 'failed') {
        const cases = [c.summary, c.proofResult?.evidence].filter(Boolean).join('\n').slice(0, 3000);
        const instruction = `The settled proof failed at ${run.head}. Revise the task to address these failing cases, then return the PR for the retained reviewer to judge. Proof receipt: task.detail → proofExecutions for run ${run.id} (selector ${binding.selector}, exact head ${run.head}); use its recorded evidence and case failures as the instruction.\n${cases}`.slice(0, 4000);
        this.resolution.update(latest, { currentRunId: null, integrationTurn: null, review: latest.resolution.review,
          pendingWorkerInstruction: instruction, pendingRevisionCause: 'review' },
          { phase: 'changes_requested', reason: `Settled proof ${run.id} failed ${binding.selector} at ${run.head}; the retained worker must address the recorded failures` },
          'proof_failure_returned_to_worker', run.id);
        return;
      }
      this.resolution.update(latest, { currentRunId: null, integrationTurn: null },
        { phase: binding.returnPhase, reason: status === 'passed'
          ? `Settled proof ${run.id} passed ${binding.selector} at ${run.head}; evidence-only review is next`
          : reason }, 'proof_execution_settled');
    });
  }
  /**
   * Spec 058 (task 533): route every proof a source-approving reviewer named to
   * whoever can produce it, before any operator question. The tag picks only the
   * route, never approval, and the retained reviewer still judges the arriving
   * evidence at the exact head (its next turn is the evidence-only round).
   */
  routeAwaitingProofs(t: Task, run: Run, c: Completion): void {
    // The callback refuses an approval with no proofs or at any head but the run's.
    const head = c.head!;
    // Spec 058 (task 539): a bare proof has no tag, so it gets one author round at this
    // head before it can reach the operator. A proof the worker already had at this
    // head is external: the round was spent, and the repeat goes to the operator.
    const sent = proofWorkerRequests(this.store, t.id, head);
    // Papercut c0fb3df9: a forge CI check is never an awaiting proof. Record it
    // as CI and let the merge gate's required-check wait cover it.
    const forgeNoted: string[] = [];
    for (const proof of c.awaitingProofs!) {
      const text = awaitingProofText(proof);
      if (isForgeCheckProofText(text) && !forgeNoted.includes(text)) {
        forgeNoted.push(text);
        this.store.event(t.id, 'proof_forge_check_noted', `${head}: ${text.slice(0, 2000)} — recorded as CI; the merge gate's required-check wait covers it`);
      }
    }
    const remaining = c.awaitingProofs!.filter(proof => !isForgeCheckProofText(awaitingProofText(proof)));
    if (!remaining.length && forgeNoted.length) {
      // Source is approved and the only named proofs are CI checks: no proof
      // question, and the merge gate enforces the checks. Store the approval
      // as ready (with no awaiting proofs) so verification can proceed to the gate.
      // The caller holds the transaction and records the result; mirror the
      // other branches and only update here. awaitingProofs is optional with
      // min 1, so an empty list must be omitted, not stored.
      const { awaitingProofs: _dropped, ...rest } = c;
      const converted = { ...rest, status: 'ready_to_merge' as const };
      this.resolution.update(t, { currentRunId: null, review: converted, integrationTurn: null, proofRetry: null },
        { phase: 'verifying', reason: `Source approved at ${head}; ${forgeNoted.join(', ').slice(0, 2000)} recorded as CI and covered by the merge gate` },
        'source_approved_ci_noted', run.id);
      return;
    }
    const proofs: AwaitingProof[] = remaining.map(proof => {
      const text = awaitingProofText(proof);
      const tagged = typeof proof === 'string' ? 'author' : proof.route;
      return tagged === 'author' && sent.has(text) ? { proof: text, route: 'external' } : { proof: text, route: tagged };
    });
    const route = (kind: 'author' | 'environment' | 'external') => proofs.filter(proof => awaitingProofRoute(proof) === kind);
    const environment = route('environment'), author = route('author'), external = route('external');
    // A check that faulted before any assertion in the reviewer's own run is not a
    // proof about the source: it gets one clean retry at this head, and a repeat is
    // external. A reviewer run already carrying the retry proves the allowance is spent.
    const retried = this.store.runs(t.id).some(item => item.role === 'reviewer' && item.proofRetry?.head === head);
    if (environment.length && !retried && automaticRetryForbidden(t, this.store.runs(t.id))) {
      const named = awaitingProofTexts(environment).join(', ');
      const evidence = `Reviewer ${run.id} completed source approval at ${head}, blocked by environment proof ${named}; verdict: ${c.reviewText?.trim() || c.summary}`;
      this.resolution.update(t, { currentRunId: null, review: c, integrationTurn: null, proofRetry: null },
        { phase: 'blocked', reason: `Automatic reviewer environment retry suppressed by the owner; completed verdict retained at ${head}` },
        'source_awaiting_proof', run.id);
      this.resolution.suppressAutomaticRetry(this.store.task(t.id), 'reviewer_environment', evidence, run.id);
      return;
    }
    // Author-producible evidence is the largest group and costs no operator turn, so
    // it is sent first; the reviewer's next evidence-only turn returns any remaining
    // environment or external proof, and an environment retry still precedes a park.
    if (author.length) {
      const named = awaitingProofTexts(author).join('; ').slice(0, 9000);
      const instruction = `The reviewer approved the source at ${head} but named proofs only you can produce. Produce that evidence, record each proof's exact command and its observed result as author evidence on the PR, and return ready_for_review at ${head} (or at the head you push for it) so the retained reviewer judges it. Change the source only if a proof shows a defect, and never describe an unrun check as passed. Proofs: ${named}`;
      this.resolution.update(t, { currentRunId: null, review: c, integrationTurn: null, proofRetry: null, pendingWorkerInstruction: instruction },
        { phase: 'changes_requested', reason: `Source approved at ${head}; the author must produce the named proofs: ${named.slice(0, 3000)}` },
        'author_proof_requested', run.id);
      for (const text of awaitingProofTexts(author)) this.store.event(t.id, 'proof_worker_requested', `${head}: ${text}`);
      return;
    }
    if (environment.length && !retried) {
      this.resolution.update(t, { currentRunId: null, review: null, integrationTurn: null,
        proofRetry: { runId: run.id, head, proofs: awaitingProofTexts(environment), at: now() } },
        { phase: 'reviewing', reason: `Reviewer checks faulted before any assertion at ${head}; one clean-environment retry, then the operator: ${awaitingProofTexts(environment).join(', ').slice(0, 3000)}` },
        'reviewer_environment_retry', run.id);
      return;
    }
    // Only proofs another system or the operator can produce are left. A spent
    // environment retry is external now, so the park and its question say so.
    const parked: AwaitingProof[] = [...external, ...environment.map(proof => ({ proof: awaitingProofText(proof), route: 'external' as const }))];
    const reason = `Source approved at ${head}; awaiting proof: ${awaitingProofTexts(parked).join(', ').slice(0, 3000)}`;
    this.resolution.update(t, { currentRunId: null, review: { ...c, awaitingProofs: parked }, integrationTurn: null, proofRetry: null },
      { phase: 'blocked', reason }, 'source_awaiting_proof', run.id);
    this.resolution.waiting(this.store.task(t.id), reason, 'awaiting_proof');
  }
  /**
   * One reviewer run's verdict applies once, whatever passes overlap (task 740).
   * The fence is the durable record written in the same transaction as the
   * verdict's state, so it holds across passes, connections and restarts and does
   * not rely on the task lane. A pass that loses to it changes and writes nothing,
   * and a failure it meets on the way is no longer about this task.
   */
  async advanceReviewerResult(t:Task, run:Run, c:Completion, reapplied = false): Promise<void> {
    if (this.verdictApplied(t.id, run.id)) return;
    try { await this.applyReviewerResult(t, run, c, reapplied); }
    catch (error) { if (!this.verdictApplied(t.id, run.id)) throw error; }
  }
  verdictApplied(taskId: string, runId: string): boolean {
    return resultApplied(this.store, taskId, runId) || reviewVerdictApplied(this.store, taskId, runId) || this.store.task(taskId).proofOnlyResult?.reviewerRunId === runId;
  }
  /** Runs inside the transaction that writes the result, so its fence read and that write are one step. */
  closeProofOnlyQualification(t:Task, run:Run, c:Completion): void {
    if (this.verdictApplied(t.id, run.id)) return;
    const current = this.store.task(t.id);
    const receipt = current.proofExecutions.at(-1);
    if (!current.proofOnly || !current.proofExecution || !receipt || receipt.head !== current.proofOnly.commit
      || receipt.selector !== current.proofExecution.selector || receipt.status === 'running'
      || current.resolution.reviewerAgentId !== run.agentId || run.head !== current.proofOnly.commit)
      throw new Error('Proof-only review requires the exact settled receipt and its retained reviewer at the merged commit');
    if (settlementHeld(this.store, this.resolution.stopped())) return;
    // Task 560: historical evidence is never a pass. A receipt recorded from
    // a superseded run's late report (or its timeline alone) can never
    // satisfy proof-only closeout, whatever it claims: a ready_to_merge
    // verdict resting on it alone closes the qualification failed, and the
    // judgment about the evidence stays in the retained history.
    const historical = receipt.historical === true;
    const passed = receipt.status === 'passed' && !historical && c.status === 'ready_to_merge';
    const reviewRecord = reviewRecordFor(run, c, now());
    const reviews = reviewRecord ? [...current.resolution.reviews, reviewRecord] : current.resolution.reviews;
    const evidence = [
      `Qualification result ${passed ? "passed" : "failed"}; executor receipt status ${receipt.status}: ${receipt.selector} at ${receipt.head}; executor run ${receipt.runId}.`,
      ...(historical
        ? [
            `Receipt ${receipt.runId} is historical evidence only (a superseded run's late report or its timeline); it is never a pass and cannot satisfy closeout.`,
          ]
        : []),
      `Reviewer verdict ${c.status}: ${c.reviewText?.trim() || c.summary}`,
      receipt.evidence,
    ].filter(Boolean).join('\n').slice(0, 4000);
    const result = { status: passed ? 'passed' as const : 'failed' as const, commit: current.proofOnly.commit,
      selector: current.proofExecution.selector, executionRunId: receipt.runId, reviewerRunId: run.id, evidence };
    const reason = passed
      ? `Proof-only qualification passed at ${result.commit}; receipt ${receipt.runId} was accepted by retained reviewer ${run.id}`
      : historical
        ? `Proof-only qualification failed at ${result.commit}; receipt ${receipt.runId} is historical evidence only and can never be credited a pass`
        : `Proof-only qualification failed at ${result.commit}; receipt ${receipt.runId} and reviewer findings are retained for the planner`;
    this.resolution.update(current, { currentRunId: null, review: c, integrationTurn: null, reviews,
      pendingReviewReason: null }, { phase: 'done', reason, proofOnlyResult: result }, 'proof_only_qualification_closed',
      JSON.stringify({ ...result, status: result.status }));
    recordResultApplied(this.store, t.id, run.id);
  }
  async applyReviewerResult(t:Task, run:Run, c:Completion, reapplied: boolean): Promise<void> {
    if (t.entrypoint === 'proof') { this.store.transaction(() => this.closeProofOnlyQualification(t, run, c)); return; }
    const reviewer=this.resolution.reviewerSetting(t);
    // Spec 033: a formal review id is its own evidence, never a comment id.
    const publicationId=(completion:Completion)=>reviewer?completion.reviewId:completion.reviewCommentId;
    const publicationRecord = this.store.getMeta(`reviewPublication:${run.id}`);
    if(!publicationId(c) && (reapplied ? !publicationRecord : true)){
      if(!c.reviewText || !this.adapter.publishReview)throw Error('Review publication is unavailable');
      // Task 704: the adapter publishes single-flight per run and reports whether
      // this pass posted. A repeat that reuses a recorded publication is silent:
      // no extra `review_published` event.
      let outcome: number | PublicationOutcome;
      try { outcome=await this.adapter.publishReview(this.store,t,run,c.status,c.reviewText,()=>!settlementHeld(this.store, this.resolution.stopped()),reviewer??undefined); }
      catch (error) {
        if (gitDeliveryUnknown(error) && classifyGitTransientFailure(error) === 'network' && this.store.getMeta(`reviewPublication:${run.id}`))
          throw new ReviewPublicationTransientError(error);
        throw error;
      }
      if (this.verdictApplied(t.id, run.id)) return;
      const id=typeof outcome==='number'?outcome:outcome.id;
      const published=typeof outcome==='number'||outcome.published;
      c=reviewer?{...c,reviewId:id}:{...c,reviewCommentId:id};
      this.store.putRun({...this.store.run(run.id)!,completion:c});
      if(published)this.store.event(t.id,'review_published',`${reviewer?'PR review':'PR comment'} ${id}`);
    }
    const verifiedId=await this.adapter.verifyReview!(t, run, c, reviewer??undefined);
    if (this.verdictApplied(t.id, run.id)) return;
    if(verifiedId&&verifiedId!==publicationId(c)){
      c=reviewer?{...c,reviewId:verifiedId}:{...c,reviewCommentId:verifiedId};
      this.store.putRun({...this.store.run(run.id)!,completion:c});
      this.store.event(t.id,'review_reconciled',`${reviewer?'PR review':'PR comment'} ${verifiedId}`);
    }
    const retainedId = publicationId(c) ?? verifiedId;
    if (retainedId) {
      // Task 704: two reviews with this run's marker settle on the earliest; the
      // completion carries the retained ID so the record and the run agree.
      const settledId = retainReviewPublication(this.store, t, run, c, reviewer, retainedId);
      if (settledId !== publicationId(c)) {
        c = reviewer ? { ...c, reviewId: settledId } : { ...c, reviewCommentId: settledId };
        this.store.putRun({ ...this.store.run(run.id)!, completion: c });
      }
    }
    if (settlementHeld(this.store, this.resolution.stopped())) return;
    this.store.transaction(() => {
      if (this.verdictApplied(t.id, run.id)) return;
      // Replaced is not released (planner ruling, 2026-11-09): this verdict
      // settles the review, so replaced runs that never delivered are released
      // and their credentials revoked unconditionally — after release nothing
      // authenticates.
      for (const replaced of this.store.runs(t.id)) {
        if (replaced.id !== run.id && replaced.replacedAt && !replaced.released && !replaced.completion)
          this.store.putRun({ ...replaced, released: true });
      }
      const current = this.store.task(t.id);
      if (reapplied) {
        const latestRun = this.store.run(run.id);
        if (current.resolution.review?.runId === run.id || current.prHead !== run.head || current.phase !== t.phase
          || current.resolution.reviewerAgentId !== run.agentId
          || (current.resolution.currentRunId !== null && current.resolution.currentRunId !== run.id)
          || !latestRun?.released || latestRun.status !== 'finished' || latestRun.role !== 'reviewer'
          || latestRun.agentId !== run.agentId || latestRun.head !== run.head
          || latestRun.completion?.eventId !== c.eventId || latestRun.completion?.head !== current.prHead) return;
      }
      const recovery = current.resolution.recovery;
      const settlesAttention = Boolean(reapplied && current.resolution.attention && current.resolution.incident?.runId === run.id);
      const recoveryRunId = settlesAttention && recovery?.incidentId === current.resolution.incident?.id ? recovery?.runId : null;
      const recoveryRun = recoveryRunId ? this.store.run(recoveryRunId) : null;
      const supersedeRecovery = Boolean(recoveryRun && !recoveryRun.released);
      const stopFromIncident = Boolean(settlesAttention && current.resolution.stop && current.resolution.incident
        && Date.parse(current.resolution.stop.since) >= Date.parse(current.resolution.incident.createdAt));
      if (supersedeRecovery) this.store.putRun({ ...recoveryRun!, status: 'superseded', released: true });
      // Spec 037: an accepted review with verdicts appends one immutable
      // record. A review without verdicts leaves the task record unchanged.
      const reviewRecord = reviewRecordFor(run, c, now());
      const reviews = reviewRecord ? [...current.resolution.reviews, reviewRecord] : current.resolution.reviews;
      if (c.status === 'changes_required')
        this.store.event(t.id, 'review_revision_classified', `review ${run.id}: semantic review revision`);
      // The lifetime cap counts review rounds (one per changes_required review);
      // author continuations inside a round never counted, and an upgrade does
      // not reset the count.
      // Task 576: the cap is reached only by a new substantive changes_required
      // review beyond the cap. A review that already parked the task (same
      // event id, however it is delivered) never parks it again on its own;
      // the next new review parks again.
      if (c.status === 'changes_required' && current.resolution.revisionRuns >= REVISION_BUDGET
        && current.resolution.capParkedReviewEventId !== c.eventId) {
        // Spec 058 slice 17: the cap park escalates to the project planner as a
        // delegated decision instead of the owner disposition. The final review
        // remains evidence; the planner's answer applies through the ordinary verbs.
        const runs = current.resolution.revisionRuns;
        const cause = revisionCapCauseId(current.id, runs);
        const ladderReason = `Revision budget exhausted after ${runs} review rounds; the project planner decides the next approach`;
        this.resolution.update(current, { currentRunId: null, review: c, integrationTurn: null, reviews, pendingRevisionCause: null, capParkedReviewEventId: c.eventId }, { phase: 'needs_attention', reason: ladderReason }, 'revision_budget_exhausted');
        this.store.event(t.id, 'review_result_applied', run.id);
        recordResultApplied(this.store, t.id, run.id);
        if (reapplied) this.store.event(t.id, 'review_reapplied', run.id);
        const question = revisionCapEscalationQuestion(current, runs, c.summary);
        this.resolution.openPlannerEscalation(this.store.task(t.id), { cause, runId: null,
          question, payload: { cause, runId: null, revisionCap: runs, question } });
        return;
      }
      const sequence = c.status === 'ready_to_merge' ? this.store.nextIntegrationSequence(t.repoPath) : null;
      this.resolution.update(current, { currentRunId: null, review: c, integrationTurn: sequence ? { sequence, acceptedAt: now() } : null, reviews, pendingRevisionCause: null,
        ...(settlesAttention ? { attention: false,
          ...(stopFromIncident ? { stop: null } : {}), recoveryActive: false,
          ...(current.resolution.incident ? { incident: { ...current.resolution.incident, status: 'resolved' as const, detail: 'Accepted review verdict applied after transient failure', updatedAt: now() } } : {}),
          ...(current.resolution.recovery ? { recovery: { ...current.resolution.recovery, status: 'resolved' as const, summary: 'Accepted review verdict applied after transient failure', idleSince: null, action: null } } : {}) } : {}),
        ...(c.status === 'changes_required' ? { pendingWorkerInstruction: c.summary } : {}) },
        { phase: c.status === 'changes_required' ? 'changes_requested' : 'verifying', reason: c.summary,
          ...(supersedeRecovery ? { coordinatorGeneration: current.coordinatorGeneration + 1 } : {}) });
      this.store.event(t.id, 'review_result_applied', run.id);
      recordResultApplied(this.store, t.id, run.id);
      if (reapplied) this.store.event(t.id, 'review_reapplied', run.id);
      if (settlesAttention) this.resolution.settleAttentionEpisode(t.id, 'Accepted review verdict applied after transient failure');
    });
  }
  /** Return an authenticated ready report rejected by checkout/PR verification to its worker. */
  responsiblePrReportRefused(t: Task, runId: string, prNumber: number, error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const identityRefusal = error.message === "PR must be open, ready, and match the task's branch and base";
    const checkoutRefusal = /^(Worker must leave a clean worktree before review|Worker must remain on queue-owned branch )/.test(error.message);
    if (!identityRefusal && !checkoutRefusal) return false;
    const instruction = identityRefusal
      ? `Nucleus refused PR #${prNumber}: ${error.message}. Keep the exact task branch ${t.branch}, close or correct the mismatched PR, open a replacement PR targeting ${t.baseBranch}, then report ready_for_review with its number.`
      : `Nucleus refused ready_for_review because: ${error.message}. Resolve the named checkout condition (remove or ignore metadata files; preserve source files), then report ready_for_review again with the same PR #${prNumber}.`;
    this.resolution.update(t, { currentRunId: null, ...(identityRefusal ? { revisionPrRepair: true } : {}), pendingWorkerInstruction: instruction },
      { phase: 'changes_requested', reason: instruction }, 'responsible_pr_report_refused',
      `${runId}: PR #${prNumber}; returned to the responsible worker`);
    return true;
  }
  async advanceRevisionResult(t:Task, run:Run, c:Completion): Promise<void> {
    if (resultApplied(this.store, t.id, run.id)) return;
    if (c.status === 'report_ready') {
      this.store.transaction(() => {
        const latest = this.store.task(t.id);
        if (resultApplied(this.store, t.id, run.id) || latest.resolution.currentRunId !== run.id) return;
        this.resolution.update(latest, { currentRunId: null, integrationTurn: null }, { phase: 'report_ready', completion: c, reason: c.summary }, 'revision_report_ready');
        recordResultApplied(this.store, t.id, run.id);
      });
      return;
    }
    const establishesFirstPr=!t.resumePrNumber&&!t.completion?.prNumber;
    const effectivePr=t.resolution.revisionPrRepair||establishesFirstPr?c.prNumber!:taskPrNumber(t);
    let pr: VerifiedPr;
    try { pr = await this.adapter.verifyPr(t, effectivePr); }
    catch (error) {
      const handled = this.store.transaction(() => {
        const latest = this.store.task(t.id);
        if (resultApplied(this.store, t.id, run.id) || latest.resolution.currentRunId !== run.id) return true;
        if (!this.resolution.responsiblePrReportRefused(latest, run.id, effectivePr, error)) return false;
        recordResultApplied(this.store, t.id, run.id);
        return true;
      });
      if (handled) return;
      throw error;
    }
    if (settlementHeld(this.store, this.resolution.stopped())) return;
    this.store.transaction(() => {
      const latest = this.store.task(t.id);
      if (resultApplied(this.store, t.id, run.id) || latest.resolution.currentRunId !== run.id) return;
      recordResultApplied(this.store, t.id, run.id);
      // A mechanical conflict return at the identical Git head changes no
      // reviewed bytes. Keep the authentic approval and recheck merge gates,
      // rather than buying another review of the same unresolved conflict.
      const review = latest.resolution.review;
      const approval = review ? this.store.run(review.runId) : null;
      // A revision that returned the identical approved head while the accepted
      // exact-head review and its published approval stand changed no reviewed
      // bytes, whatever refused the merge. Queue #394 covers the failed-check
      // form of that return and the merge conflict's existing form below.
      const unchangedApprovedReturn = Boolean(run.head === pr.head &&
          c.status === 'ready_for_review' && latest.prHead === pr.head &&
          latest.resolution.currentRunId === run.id && review?.status === 'ready_to_merge' &&
          review.head === pr.head && (review.reviewId ?? review.reviewCommentId) &&
          approval?.role === 'reviewer' && approval.status === 'finished' && approval.released &&
          approval.completion?.eventId === review.eventId && approval.completion.head === pr.head);
      if (unchangedApprovedReturn && isFailedChecksReason(run.instruction)) {
        this.resolution.update(latest, { currentRunId: null, mechanicalVerification: null, revisionPrRepair: false,
          integrationTurn: { sequence: this.store.nextIntegrationSequence(latest.repoPath), acceptedAt: now() } },
          { phase: 'verifying', completion: c, prHead: pr.head, prUrl: pr.url,
            reason: `Unchanged reviewed head after a failed required check; rechecking the merge gates without another review. Unmet check: ${run.instruction}` },
          'unchanged_check_revision');
        return;
      }
      if (unchangedApprovedReturn && run.instruction === MERGE_CONFLICT_REASON) {
        this.resolution.update(latest, { currentRunId: null, mechanicalVerification: null, revisionPrRepair: false,
          integrationTurn: { sequence: this.store.nextIntegrationSequence(latest.repoPath), acceptedAt: now() } },
          { phase: 'verifying', completion: c, prHead: pr.head, prUrl: pr.url,
            reason: 'Merge-conflict revision returned unchanged approved head; rechecking merge prerequisites without another review' },
          'unchanged_conflict_revision');
        return;
      }
      this.resolution.update(latest, { currentRunId: null, review: null, revisionPrRepair: false, integrationTurn: null },
        { phase: 'awaiting_review', completion: c, prHead: pr.head, prUrl: pr.url, ...(establishesFirstPr ? { resumePrNumber: effectivePr } : {}), reason: c.summary });
    });
  }
}
