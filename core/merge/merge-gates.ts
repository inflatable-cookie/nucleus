import { blockerCauseId, escalationWaitDetail, findOpenPlannerEscalation, plannerEscalationQuestion, type LadderEvent } from '../questions/blocker-ladder';
import { isFailedChecksReason, taskPrNumber } from '../forge/index';
import { GitReadTimeoutError } from '../git/index';
import { hookHoldReason, isStaleIntegrationBaseRefusal, gitRaw, repositoryIsGitCheckout, type HookEmissionResult, type ProspectiveMergeOutcome } from '../hooks/hooks';
import { reviewEntryInputForTask, verifyReviewEntryCanonicalAuthor, ReviewEntryRefusal, type ReviewEntryAdapter } from '../review/review-entry';
import { now } from '../store/store';
import { mergeFenceReason } from '../recovery/task-reasons';
import { CAPACITY_WAIT_PREFIX } from '../../shared/wait-state';
import { mergeFenced, operatorSourceAcceptance, qualifiedOwnerAcceptance, type Completion, type Task } from '../../shared/contracts';
import type { HookRecord } from '../../shared/hooks';
import type { Adapter } from '../host/adapter';
import type { MergeGateResult, Resolution } from '../resolution';

export type MergeGatesContext = Pick<Resolution, 'adapter' | 'applyMergeGateWait' | 'attention' | 'claimIntegrationTurn' | 'executionLease' | 'gateSettingsCurrent' | 'hooks' | 'mergeGateEvidence' | 'openPlannerEscalation' | 'paused' | 'reconcileMergeIntent' | 'refusePreMerge' | 'reviewRequired' | 'store' | 'update' | 'verification' | 'waiting'>;

/**
 * Automatic fast-forwards of a stale integration base inside one prospective-merge
 * gate pass. A base that origin keeps moving past parks for an operator instead of
 * renewing forever.
 */
export const INTEGRATION_BASE_RENEWAL_LIMIT = 3;

/** The exact-head merge gates, and the intent and request that spend their evidence. */
export class MergeGates {
  constructor(readonly resolution: MergeGatesContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

  /**
   * Run every required read-only `task.pre_merge` hook against the accepted
   * exact reviewed head before verification or merge. A confirmed repository
   * refusal, already proved non-mutating by the read-only runner, becomes one
   * ordinary semantic revision finding. Execution uncertainty, malformed
   * transport and identity drift stay operational holds.
   */
  private async reviewedHeadGate(t: Task): Promise<boolean> {
    const review = t.resolution.review;
    // Only an accepted exact-head review, a qualified owner acceptance at the
    // current head, or an explicit operator source acceptance of that head
    // activates the gate. A submission that explicitly skipped PR review keeps
    // its previous merge behavior.
    if (!this.resolution.hooks || !t.prHead) return true;
    const accepted = Boolean(operatorSourceAcceptance(t))
      || Boolean(review && (review.status === 'ready_to_merge' || qualifiedOwnerAcceptance(t)));
    if (!accepted) return true;
    // A stale verdict is history, never this head's review evidence: the payload
    // carries only a review bound to the exact head the gate verifies.
    const reviewAtHead = review && review.head === t.prHead ? review : null;
    const prNumber = taskPrNumber(t);
    const latest = () => this.store.task(t.id);
    let bound;
    try { bound = await this.resolution.hooks.boundHooks(latest(), 'task.pre_merge', t.prHead); }
    catch (error) { this.resolution.attention(latest(), `Repository pre-merge gate could not read the control manifest: ${error instanceof Error ? error.message : String(error)}`); return false; }
    // Repositories without this binding keep their previous verification cost and behavior.
    if (!bound || !bound.hooks.length) return true;
    // The prospective preparation already proved this head before hooks; the
    // fresh merge gate proves it again after all hooks, immediately before intent.
    if (!t.directory) { this.resolution.attention(latest(), 'Repository pre-merge gate requires the retained task workspace'); return false; }
    let outcome: HookEmissionResult;
    try {
      outcome = await this.resolution.hooks.emit('task.pre_merge', latest(), {
        event: 'task.pre_merge', baseCommit: t.prHead,
        delivery: { prUrl: t.prUrl, prNumber, head: t.prHead, review: reviewAtHead?.summary, mergeCommit: null, integrationCommit: null, summary: reviewAtHead?.summary },
      }, hook => hook.target === 'reviewed_head');
    } catch (error) {
      this.resolution.attention(latest(), `Repository pre-merge gate could not run: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!outcome.records.length) return true;
    const refusal = outcome.records.findLast(record => (record.state === 'blocked' || record.state === 'failed') && record.result !== null);
    if (refusal) { this.refuseReviewedHead(latest(), refusal); return false; }
    if (outcome.hold) { this.resolution.attention(latest(), hookHoldReason(outcome)); return false; }
    return true;
  }

  /** Route one confirmed reviewed-head refusal through the ordinary semantic revision budget. */
  private refuseReviewedHead(t: Task, record: HookRecord) {
    const summary = (record.result?.summary || record.summary || 'Repository pre-merge policy refused the reviewed head').slice(0, 2000);
    this.resolution.refusePreMerge(t, `Repository pre-merge refusal at the reviewed head: ${summary}`, `${record.hookId} ${record.eventId}: ${summary}`);
  }

  /**
   * Route one confirmed pre-merge refusal, or a real merge conflict, to the
   * retained worker as a continuation of the open approved round. The accepted
   * review and hook occurrence stay durable evidence, and the changed head
   * requires fresh review. Task 576 (#823 review, finding 1): a refusal neither
   * consumes a review round nor parks at the revision cap — only a new
   * `changes_required` review past the cap can exhaust it.
   */
  refusePreMerge(t: Task, reason: string, eventDetail: string) {
    const events = this.store.eventsAll(t.id);
    const boundary = events.findLastIndex(event => ['worker_resume_requested', 'owner_force_move',
      'owner_restart_instruction_sent', 'revision_head'].includes(event.kind));
    const firstRefusal = events.slice(boundary + 1).find(event => event.kind === 'pre_merge_refused');
    // Compare every refusal in this unchanged-head episode, including A/B/A
    // alternation and automatic continuations. Reviewers may replace the task's
    // completion; report fields are not head proof. Owner/review-directed work
    // or an observed head change starts a fresh episode.
    const authors = this.store.runs(t.id).filter(run => run.role === 'revision' &&
      firstRefusal && run.createdAt >= firstRefusal.at);
    const reset = authors.findLastIndex(run => run.head !== t.prHead ||
      !['pre_merge', 'unfinished', 'non_delivery'].includes(run.revisionCause ?? ''));
    const episode = authors.slice(reset + 1);
    const work = episode.findLast(run => run.revisionCause === 'pre_merge' && run.instruction === reason);
    if (t.prHead && work && episode.slice(episode.indexOf(work)).every(run =>
        run.released && run.status === 'finished' && run.head === t.prHead)) {
      const failedCheck = isFailedChecksReason(reason);
      const detail = failedCheck
        ? `Required check failure is unchanged at the reviewed head ${t.prHead}: ${reason}.`
        : `Pre-merge refusal is unchanged at the reviewed head ${t.prHead}: ${reason}.`;
      const summary = `${detail} The author returned that head without a source change, so another automatic revision would repeat this failure. The refusal still blocks merge; the accepted exact-head review and revision history are preserved. Use move to=merge to recheck the gates or move to=work with an instruction for further work.`;
      const completion: Completion = { taskId: t.id, runId: work.id, eventId: `unchanged-refusal:${work.id}`,
        status: 'blocked', summary, head: t.prHead };
      const cause = blockerCauseId(t.id, completion);
      const question = plannerEscalationQuestion(t, completion, null);
      this.store.event(t.id, failedCheck ? 'unchanged_check_revision_refused' : 'unchanged_pre_merge_revision_refused', summary);
      const existing = findOpenPlannerEscalation(this.store.eventsAll(t.id) as LadderEvent[], cause);
      if (existing) this.resolution.waiting(t, escalationWaitDetail.planner(existing.id), 'escalated');
      else this.resolution.openPlannerEscalation(t, { cause, runId: work.id, question,
        payload: { cause, runId: work.id, source: 'revision', question } });
      return;
    }
    this.store.event(t.id, 'pre_merge_refused', eventDetail);
    // The accepted review and the hook occurrence stay durable evidence. The
    // revision run carries the pre-merge cause so the refusal returns the same
    // task, retained worker, workspace, branch and PR to work without
    // overwriting either fact.
    this.resolution.update(t, {
      currentRunId: null, mechanicalVerification: null, integrationTurn: null, attention: false,
      pendingRevisionCause: 'pre_merge', pendingWorkerInstruction: reason,
    }, { phase: 'changes_requested', reason }, 'revision_requested');
  }

  /**
   * Task 993: the first other unfinished task of the same repository whose
   * recorded head has commits outside the integration base that also appear in
   * this PR's base..head range, a `'held'` marker when an ancestry read cannot
   * prove absence, or null. Nucleus worktrees share one object store, so every
   * recorded head is locally readable and no fetch is made. A head already on
   * the base carries nothing; a partial carry counts like a full one.
   */
  private async crossTaskCarry(t: Task, base: string): Promise<{ other: Task } | 'held' | null> {
    if (!t.prHead || !repositoryIsGitCheckout(t.repoPath)) return null;
    const others = this.store.tasks().filter(candidate => candidate.id !== t.id && !candidate.removedAt
      && !['done', 'cancelled'].includes(candidate.phase)
      && candidate.repoPath === t.repoPath && candidate.prHead && candidate.prHead !== t.prHead);
    const ancestor = async (candidate: string, of: string): Promise<boolean> => {
      const result = await gitRaw(t.repoPath, ['merge-base', '--is-ancestor', candidate, of]);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new Error(`git merge-base --is-ancestor ${candidate} ${of} exited with code ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`);
    };
    const count = async (...args: string[]): Promise<number> => {
      const result = await gitRaw(t.repoPath, ['rev-list', '--count', ...args]);
      if (result.code !== 0) throw new Error(`git rev-list --count ${args.join(' ')} exited with code ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`);
      return Number(result.stdout.toString('utf8').trim());
    };
    for (const other of others) {
      const head = other.prHead!;
      try {
        if (await ancestor(head, base)) continue;
        if (await ancestor(head, t.prHead)) return { other };
        const carried = await count(head, '--not', base);
        const outside = await count(head, '--not', base, t.prHead);
        if (Number.isFinite(carried) && Number.isFinite(outside) && carried > outside) return { other };
      } catch (error) {
        // An unreadable ancestry proves no absence. A timed-out read waits like
        // the other local gate reads; any other failure parks visibly instead
        // of merging on unknown history.
        if (error instanceof GitReadTimeoutError) this.resolution.waiting(this.store.task(t.id), error.message, 'external_unavailable');
        else this.resolution.attention(this.store.task(t.id), `Merge gate could not read ${other.reference ?? other.id} ancestry against the integration base: ${error instanceof Error ? error.message : String(error)}`);
        return 'held';
      }
    }
    return null;
  }
  /** Route one confirmed cross-task carry through the ordinary pre-merge revision, naming the carrying task. */
  private refuseCarriedCommits(t: Task, other: Task) {
    const named = other.reference ?? (other.number ? `#${String(other.number).padStart(3, '0')}` : other.id);
    const reason = `The PR carries commits from unfinished task ${named} ("${other.title}"): its recorded head ${other.prHead!.slice(0, 12)} has commits outside ${t.baseBranch} that also appear in this PR's ${t.baseBranch}..${t.prHead!.slice(0, 12)} range, so they would enter main under this task's review without that task's exact-head review. Rebase onto ${t.baseBranch} without them, or the planner orders the tasks.`;
    this.resolution.refusePreMerge(t, reason, `cross-task carry: commits of ${named} recorded head ${other.prHead} ride this PR outside base ${t.baseBranch}`);
  }

  /**
   * Run every required read-only `prospective_merge` `task.pre_merge` hook
   * against the exact normal merge candidate before verification or merge. The
   * candidate is Queue-owned and disposable; base movement is operational
   * staleness without a semantic revision, while a real conflict uses the
   * ordinary worker-update path before any hook process starts. A local base
   * that origin has moved past is fast-forwarded and the gate runs again, at most
   * `INTEGRATION_BASE_RENEWAL_LIMIT` times, before it parks for an operator.
   */
  private async prospectiveMergeGate(t: Task, refresh = 0, renewals = 0): Promise<{ ok: boolean; base: string | null }> {
    const review = t.resolution.review;
    // Only an accepted exact-head review, a qualified owner acceptance at the
    // current head, or an explicit operator source acceptance of that head
    // activates the gate. A submission that explicitly skipped PR review keeps
    // its previous merge behavior.
    if (!this.resolution.hooks || !t.prHead) return { ok: true, base: null };
    if (!Boolean(operatorSourceAcceptance(t)) && !(review && (review.status === 'ready_to_merge' || qualifiedOwnerAcceptance(t)))) return { ok: true, base: null };
    const reviewedHead = t.prHead;
    const prNumber = taskPrNumber(t);
    const latest = () => this.store.task(t.id);
    const verifyPrHead = async (): Promise<string | null> => {
      try {
        const pr = await this.adapter.verifyPr(latest(), prNumber);
        if (pr.head !== reviewedHead || latest().prHead !== reviewedHead) return 'the open PR no longer matches the accepted reviewed head';
        return null;
      } catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    const baseline = await verifyPrHead();
    if (baseline) { this.resolution.attention(latest(), `Repository prospective merge gate could not prove the reviewed head: ${baseline}`); return { ok: false, base: null }; }
    // A stale verdict is history, never this head's review evidence.
    const reviewAtHead = review && review.head === reviewedHead ? review : null;
    let outcome: ProspectiveMergeOutcome;
    try {
      outcome = await this.resolution.hooks.prospectiveMergeGate(latest(), {
        prUrl: t.prUrl, prNumber, head: reviewedHead, review: reviewAtHead?.summary, summary: reviewAtHead?.summary,
      });
    } catch (error) {
      if (error instanceof GitReadTimeoutError) {
        this.resolution.waiting(latest(), error.message, 'external_unavailable');
        return { ok: false, base: null };
      }
      this.resolution.attention(latest(), `Repository prospective merge gate could not run: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, base: null };
    }
    const validation = this.store.canonicalRepository(t.repoPath, t.repository)?.validation;
    if (outcome.kind === 'none' && !validation) return { ok: true, base: null };
    if (outcome.kind === 'refused') {
      const refusal = outcome.records.findLast(record => (record.state === 'blocked' || record.state === 'failed') && record.result !== null);
      const summary = (refusal?.result?.summary || refusal?.summary || 'Repository pre-merge policy refused the prospective merge').slice(0, 2000);
      this.resolution.refusePreMerge(latest(), `Repository pre-merge refusal at the prospective merge: ${summary}`, `${refusal?.hookId ?? 'prospective-merge'} ${refusal?.eventId ?? ''}: ${summary}`);
      return { ok: false, base: null };
    }
    if (outcome.kind === 'conflict') {
      this.resolution.refusePreMerge(latest(), `Repository pre-merge refusal at the prospective merge: ${outcome.detail.slice(0, 2000)}`, `prospective merge conflict at base ${outcome.base}: ${outcome.detail.slice(0, 1000)}`);
      return { ok: false, base: null };
    }
    if (outcome.kind === 'hold') {
      if (isStaleIntegrationBaseRefusal(outcome.detail) && renewals < INTEGRATION_BASE_RENEWAL_LIMIT && await this.renewIntegrationBase(latest(), renewals + 1))
        return this.prospectiveMergeGate(latest(), refresh, renewals + 1);
      this.resolution.attention(latest(), outcome.detail); return { ok: false, base: null };
    }
    if (validation) {
      const result = await this.resolution.hooks.startProjectValidation(latest(), reviewedHead, validation);
      // A background validation holds no lane slot; the task yields in place and
      // its completion wakes this same gate. Reaching attention would be wrong
      // for ordinary progress.
      if (result.kind === 'deferred') {
        this.resolution.waiting(latest(), 'Project validation is running as a background execution', 'validation');
        return { ok: false, base: null };
      }
      if (result.kind === 'conflict') {
        this.resolution.refusePreMerge(latest(), `Prospective merge conflict: ${result.detail.slice(0, 2000)}`, result.detail.slice(0, 1000));
        return { ok: false, base: null };
      }
      if (result.kind === 'refused') {
        this.resolution.refusePreMerge(latest(), `Project validation refused the prospective merge: ${result.detail.slice(0, 2000)}`, result.detail.slice(0, 1000));
        return { ok: false, base: null };
      }
      if (result.kind === 'hold') { this.resolution.attention(latest(), result.detail); return { ok: false, base: null }; }
      if (result.kind === 'ok') {
        if (outcome.kind === 'ok' && outcome.base !== result.base) {
          this.store.event(t.id, 'pre_merge_candidate_stale', `project validation moved from hook base ${outcome.base} to ${result.base}`);
          if (refresh >= 1) { this.resolution.attention(latest(), 'The prospective merge base kept moving between the repository hook and project validation'); return { ok: false, base: null }; }
          return this.prospectiveMergeGate(latest(), refresh + 1, renewals);
        }
        return { ok: true, base: result.base };
      }
    }
    return { ok: true, base: outcome.kind === 'ok' ? outcome.base : null };
  }

  /**
   * One automatic fast-forward of the integration base for a stale-base hold.
   * Returns false, with the refusal recorded, when the base cannot be renewed:
   * the gate then parks on the original stale-base detail as before.
   */
  private async renewIntegrationBase(t: Task, renewal: number): Promise<boolean> {
    const bound = `${renewal} of ${INTEGRATION_BASE_RENEWAL_LIMIT}`;
    try {
      const base = await this.resolution.hooks!.renewIntegrationBase(t, () => !this.resolution.paused());
      this.store.event(t.id, 'integration_base_renewed', `${base} at renewal ${bound}`);
      return true;
    } catch (error) {
      this.store.event(t.id, 'integration_base_renewal_refused', `renewal ${bound}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Post-review verification. Queue-owned mechanical gates over durable
   * evidence — no verification agent is created.
   */
  async verification(t: Task, prepareHooks = true) {
    // Slots count live agents (Tom, 2026-11-03), and verification creates none:
    // waiting for a project slot here held every merge behind live agents.
    // Revoke the parked classification synchronously before taking the turn or
    // awaiting any hook: a stale capacity reason must never mask active verification.
    if (t.reason.startsWith(CAPACITY_WAIT_PREFIX) || t.reason.startsWith('Waiting for repository integration turn')) {
      this.resolution.waiting(t, 'Reacquiring repository integration turn after capacity admission', 'lifecycle');
      t = this.store.task(t.id);
    }
    if (!this.resolution.claimIntegrationTurn(t)) return;
    t = this.store.task(t.id);
    if (this.resolution.paused()) return;
    // The merge gate must prove the same integration base the prospective-merge
    // hook observed. External base movement between the hook and that proof
    // discards the candidate result and rebuilds one current candidate instead
    // of converting a stale result into a merge.
    let refreshed = false;
    for (;;) {
      const prospectiveStarted = Date.now();
      const prospective = prepareHooks ? await this.prospectiveMergeGate(t) : { ok: true, base: null };
      this.store.event(t.id, 'merge_prospective_duration', `${Date.now() - prospectiveStarted}ms`);
      if (!prospective.ok) return;
      t = this.store.task(t.id);
      if (this.resolution.paused()) return;
      // A prospective hook on current integration main supersedes the older
      // reviewed-head form still present on a stale PR branch. Repositories
      // without a prospective binding retain reviewed-head behavior.
      const reviewedStarted = Date.now();
      const reviewed = !prepareHooks || prospective.base !== null || await this.reviewedHeadGate(t);
      this.store.event(t.id, 'merge_reviewed_head_duration', `${Date.now() - reviewedStarted}ms`);
      if (!reviewed) return;
      t = this.store.task(t.id);
      if (this.resolution.paused()) return;
      // Merge evidence: an accepted exact-head review, a qualified owner
      // acceptance bound to the authentic review at the current head, or an
      // explicit operator source acceptance of that head (2026-10-20). The first
      // two carry published review identity the merge gate re-verifies at the
      // forge; the third records the accepted missing evidence instead of
      // inventing review identity.
      if (this.resolution.reviewRequired(t)) {
        const review = t.resolution.review;
        const evidence = Boolean(review && (review.reviewId ?? review.reviewCommentId));
        const approved = review?.status === 'ready_to_merge' && evidence;
        const ownerAccepted = (evidence && Boolean(qualifiedOwnerAcceptance(t))) || Boolean(operatorSourceAcceptance(t));
        if (!approved && !ownerAccepted) throw new Error('Accepted exact-head review evidence is missing');
      }
      const gateStarted = Date.now();
      const gate = await this.resolution.mergeGateEvidence(t);
      this.store.event(t.id, 'merge_gate_duration', `${Date.now() - gateStarted}ms`);
      if (this.resolution.paused()) return;
      if (gate.pendingCheck && this.resolution.reviewRequired(t) && t.phase === 'merging') t = this.resolution.update(t, {}, { phase: 'verifying' });
      if (await this.resolution.applyMergeGateWait(t, gate)) return;
      if (gate.head !== t.prHead) throw new Error('Head changed after review');
      if (prospective.base && gate.base !== prospective.base) {
        if (refreshed) { this.resolution.attention(t, 'The prospective merge candidate did not settle before the merge gate; operator inspection required'); return; }
        refreshed = true;
        this.store.event(t.id, 'pre_merge_candidate_stale', `the integration base changed from ${prospective.base} to ${gate.base} between the prospective merge hook and the merge gate`);
        continue;
      }
      // Task 993 (papercut 4ec34bc2): a merge counts only for the task whose
      // head was reviewed. The gate refuses a PR whose base..head range carries
      // commits from another unfinished task's recorded head that are not on
      // the base; those commits would enter main under this task's review
      // without that task's exact-head review.
      const carried = gate.base ? await this.crossTaskCarry(t, gate.base) : null;
      if (carried === 'held') return;
      if (carried) { this.refuseCarriedCommits(this.store.task(t.id), carried.other); return; }
      // A plain handover keeps the accepted exact source current through
      // mechanical verification, independent of the reviewer's placement.
      const sourceStarted = Date.now();
      const viewRun = t.resolution.review ? this.store.run(t.resolution.review.runId) : null;
      if (t.reviewEntry && viewRun?.role === 'reviewer') {
        try { await verifyReviewEntryCanonicalAuthor(reviewEntryInputForTask(t), this.adapter as Adapter & ReviewEntryAdapter); }
        catch (error) {
          if (error instanceof ReviewEntryRefusal && error.transient) { this.resolution.waiting(t, error.message, 'external_unavailable'); return; }
          this.resolution.update(t, { review: null, mechanicalVerification: null, integrationTurn: null },
            { phase: 'needs_attention', reason: `The review-entry review is no longer current for the canonical pull request: ${error instanceof Error ? error.message : String(error)}` }, 'handover_view_canonical_changed');
          return;
        }
      }
      this.store.event(t.id, 'merge_source_duration', `${Date.now() - sourceStarted}ms`);
      t = this.resolution.update(t, { mechanicalVerification: { at: now(), head: gate.head, base: gate.base }, mergeBase: gate.base }, { phase: 'merging', reason: 'Mechanical verification satisfied the merge gates' });
      await this.requestMerge(t, gate);
      return;
    }
  }

  async advanceMerging(t:Task): Promise<void> {
    if (!this.resolution.claimIntegrationTurn(t)) return;
    t = this.store.task(t.id);
    if ((t.resolution.mergedCommit || t.resolution.mergeIntent) && !await this.resolution.executionLease(t) || this.resolution.paused()) return;
    if (t.resolution.mergedCommit && !t.resolution.syncedCommit) {
      this.resolution.update(t, { currentRunId: null, attention: false }, { phase: 'syncing', coordinatorGeneration: t.coordinatorGeneration + 1, reason: 'External merge verified; synchronizing main before coordinator closeout' }, 'external_merge_observed');
      return;
    }
    if (t.resolution.mergeIntent) {
      const mergeCheckStarted = Date.now();
      await this.resolution.reconcileMergeIntent(t);
      this.store.event(t.id, 'merge_verify_duration', `${Date.now() - mergeCheckStarted}ms`);
      return;
    }
    if (this.resolution.reviewRequired(t) && !t.resolution.review && !operatorSourceAcceptance(t)) throw new Error('Current independent review is required');
    // Stored mechanical verification is history, never permission after a roll.
    // Rebuild the prospective candidate and prove the gate in this attempt.
    await this.resolution.verification(t, this.resolution.reviewRequired(t));
  }
  private async requestMerge(t: Task, gate: MergeGateResult): Promise<void> {
    const leaseStarted = Date.now();
    const leased = await this.resolution.executionLease(t);
    this.store.event(t.id, 'merge_lease_duration', `${Date.now() - leaseStarted}ms`);
    if (!leased || this.resolution.paused()) return;
    if (this.store.task(t.id).coordinatorGeneration !== t.coordinatorGeneration) return;
    // The last fence before the request: re-read after every await in the gate, so
    // a stop recorded while the gate was being read is seen before the intent that
    // authorises the merge (Queue #531, effigy#524).
    t = this.store.task(t.id);
    if (mergeFenced(t)) { this.resolution.waiting(t, mergeFenceReason(t), 'held'); return; }
    // The gate evidence is bound to the settings revision it read. Any write
    // since (a policy flip, say) makes it stale, so it never authorises intent.
    if (!this.resolution.gateSettingsCurrent(t, gate)) {
      this.store.event(t.id, 'merge_gate_settings_changed', `Repository settings changed after the merge gate at ${gate.head}; the result cannot authorise merge intent and the gates are re-observed`);
      this.resolution.waiting(t, 'Repository settings changed after the merge gate; re-observing the exact-head gates before merge intent', 'classify');
      return;
    }
    t = this.resolution.update(t, { mergeIntent: true, mergeHead: gate.head, mergeBase: gate.base, mergeRequestedAt: now(),
      mergeResponseOutcome: 'pending', mergeProofSince: null, mergeRetryAt: null, mergeRetryOutcome: null, mergeAutoRetryExhausted: false },
      { reason: 'Merge requested for the reviewed head' }, 'merge_intent');
    const mergeStarted = Date.now();
    let withdrawn = false;
    try {
      await this.adapter.merge!(t, () => {
        if (this.resolution.paused() || this.store.task(t.id).coordinatorGeneration !== t.coordinatorGeneration) return false;
        // The final permission boundary: a settings write after the gate
        // withdraws permission before the request is sent.
        if (!this.resolution.gateSettingsCurrent(this.store.task(t.id), gate)) { withdrawn = true; return false; }
        return true;
      });
    } catch (error) {
      if (withdrawn) {
        const current = this.store.task(t.id);
        this.store.event(t.id, 'merge_gate_settings_changed', `Repository settings changed after the merge gate at ${gate.head}; the merge request was not sent and the recorded intent is reconciled under current policy`);
        this.resolution.waiting(current, 'Repository settings changed after the merge gate; the merge was not sent and the exact-head gates are re-observed', 'classify');
        return;
      }
      throw error;
    }
    this.store.event(t.id, 'merge_request_duration', `${Date.now() - mergeStarted}ms`);
    t = this.store.task(t.id);
    this.resolution.update(t, { mergeResponseOutcome: 'accepted' }, {}, 'merge_response_accepted', `GitHub accepted the guarded merge for ${t.resolution.mergeHead}`);
  }
}
