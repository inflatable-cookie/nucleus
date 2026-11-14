import { readToolTimeline } from '../recovery/stall';
import { timelineSelectorEvidence, verifyProofSource } from '../qa/proof-execution';
import type { CheckpointResult, Completion, Run, Task } from '../../shared/contracts';
import { CHECKPOINT_BUDGET, isDispositionActive } from '../../shared/contracts';
import { briefDigest, currentBrief } from '../planning/brief';
import { recordLateCallbackEvidence } from '../verbs/disposition';
import type { Engine } from '../engine';
import { assertCanonicalPrSource, taskPrNumber } from '../forge/index';
import { git } from '../git/index';
import { interactiveSessionOpen } from '../dispatch/interactive';
import { consecutiveNonDeliveries, nonDeliveryEvents, nonDeliveryFor, unfinishedContinuationEvents, unfinishedReturnFor } from '../recovery/non-delivery';
import { assertOrdinaryReviewIdentity, ordinaryReviewSource } from '../review/ordinary-review';
import type { Adapter } from '../host/adapter';
import type { Resolution } from '../resolution';
import { REVIEW_AUTHORIZATION_REQUIRED, REVIEW_BUDGET_EXHAUSTED, reviewCheckpointPathFor, writeReviewCheckpoint } from '../review/review-continuation';
import { assertReviewEntryExecutionSource, reviewEntryInputForTask, type ReviewEntryAdapter, verifyReviewEntryCanonicalAuthor } from '../review/review-entry';
import { assertReviewResponsibility } from '../review/review-verdicts';
import { digest, now } from '../store/store';
import { recordProofFiles } from './proof-files';
import { recordSupersededRunRefusal, supersededByPendingResume, supersededResumeRefusal } from '../recovery/superseded-resume';
import { ownerArmedRetainedWorker } from '../recovery/task-reasons';
import { completionRoute, sourceApprovalRefusal } from './report-shape';
import { reportReadyRefusal } from './report-ready';
import { proofResultRefusal } from './proof-settlement';

/**
 * A report's receipt hash is the accepted completion's own bytes, so the local
 * proof-file request is removed before both the receipt lookup and acceptance.
 * The copies and their hashes are recorded on the task before either write, and
 * an identical retry resolves to the first receipt instead of a hash conflict.
 */
function proofFilesRemoved(input: Completion): Completion {
  if (!input.proofFiles) return input;
  const { proofFiles: _proofFiles, ...rest } = input;
  return rest as Completion;
}

/**
 * Authenticate, validate and record one worker report. Joins Engine's source
 * gates with the checkpoint and review-progress receipts. Same-name `Engine`
 * methods delegate here. `store`, `adapter` and `resolution` read the engine
 * per call: tests replace the adapter.
 *
 * A run report is applied by `RunCallbackIntake`, not here: this owner decides
 * whether a report may be accepted at all, and that owner decides what an
 * accepted run's result settles.
 */
export type CallbackIntakeContext = Pick<Engine, 'adapter' | 'cleanContext' | 'completeCheckpoint' | 'completeReviewProgress' | 'control' | 'host' | 'rejectCheckpoint' | 'rejectReviewProgress' | 'reviewContinuationLimit' | 'reviewerContinuationInFlight' | 'onTaskHost' | 'stopped' | 'store' | 'wake' | 'wakeTask' | 'withHost'> & { readonly resolution: Pick<Resolution, 'attention' | 'complete' | 'settleCompletedExecutorBlocker'> };

export class CallbackIntake {
  constructor(readonly engine: CallbackIntakeContext) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  updateAfterOperatorRemap(task:Task){
    return this.store.update(task.id,{resolution:{...task.resolution,recoveryActive:false,recoveryAttempts:0,recovery:null}},'worker_remap_recovered','Replacement worker is running; stale recovery budget cleared');
  }
  reviewerContinuationInFlight(taskId: string, runId: string): boolean {
    const run = this.store.run(runId);
    if (!run || run.taskId !== taskId || run.role !== 'reviewer') return false;
    return Boolean(run.reviewDeliveries?.some(delivery => delivery.status === 'reserved' || delivery.status === 'uncertain'));
  }
  /**
   * Settle the worker's own thread once its handover is accepted (Tom,
   * 2026-11-12): the receipt is durable first, the effect runs on the worker's
   * host, and a refusal or unknown outcome changes nothing — the thread keeps its
   * state until a message wakes it or its next handover settles it again. Only
   * the worker's own handover settles: a reviewer, coordinator or executor
   * thread has its own lifecycle.
   */
  private async settleHandedOverWorker(taskId: string, sourceRun: Run | null | undefined, status: Completion['status']): Promise<void> {
    if (status !== 'ready_for_review' && status !== 'report_ready') return;
    if (sourceRun && sourceRun.role !== 'revision') return;
    let task: Task;
    try { task = this.store.task(taskId); } catch { return; }
    const agentId = sourceRun?.agentId ?? task.agentId;
    const runId = sourceRun?.id ?? task.runId;
    const hostId = sourceRun?.hostId ?? task.hostId;
    if (!agentId || !runId || !hostId) return;
    try {
      // The presence check reads the adapter the task's own host serves: the
      // default host's adapter never names this thread.
      await this.engine.onTaskHost({ hostId }, async () => {
        const settle = this.adapter.settleWorkerThread;
        if (settle) await settle.call(this.adapter, agentId, runId);
      });
    } catch { /* presentation only; the thread keeps its state and its next handover settles again */ }
  }
  async complete(input: Completion, token: string) {
    const sourceRun=this.store.run(input.runId);
    this.store.authenticate(input.runId, token);
    const identityTask = this.store.task(input.taskId);
    if (sourceRun ? sourceRun.taskId !== identityTask.id : identityTask.runId !== input.runId)
      throw new Error('Stale report: task and run identity do not match');
    const priorReceipt = this.store.receipt(proofFilesRemoved(input), token);
    if (priorReceipt) { await this.settleHandedOverWorker(input.taskId, sourceRun, input.status); await this.settleReportedThread(sourceRun); return priorReceipt; }
    let verifiedPr: { url: string; head: string } | null = null;
    // A worker report's PR is bound to this task by typed identity: the canonical
    // source, the task branch, the base branch and the exact head. Nothing is read
    // out of the report's prose.
    if (!sourceRun || sourceRun.role === 'revision') {
      if (input.prNumber) {
        const pr = this.adapter.verifyPrIdentity
          ? await this.adapter.verifyPrIdentity(identityTask, input.prNumber, {allowDraft: input.status !== 'ready_for_review'})
          : await this.adapter.verifyPr(identityTask, input.prNumber);
        assertCanonicalPrSource(pr, input.prNumber);
        verifiedPr = { url: pr.url, head: pr.head };
      }
    }
    // nucleus#1142: author-side proof files are copied into Nucleus's own
    // per-head evidence directory before the result is accepted, and the copied
    // records are what the retained reviewer's prompt lists. The report's local
    // source paths never enter the stored completion; only the copies, their
    // hashes and their labels do. A refused path copies nothing.
    if (input.proofFiles?.length) {
      const authorReport = !sourceRun || sourceRun.role === 'revision';
      const executorProof = sourceRun?.role === 'executor' && input.status === 'proof_executed';
      if (!authorReport && !executorProof)
        throw new Error('proofFiles is only accepted on a worker or revision report, or an executor proof_executed report');
      // nucleus#1180: the reported head binds against the forge, never against
      // Nucleus's recorded PR head. A report-carried PR number verifies as
      // before; otherwise the task branch's open PR head is read from the forge
      // (a missing or stale recording is not compared), and a report with no PR
      // yet binds against the pushed branch head read with `git ls-remote`.
      // Nothing already recorded is relabelled: the observed head only gates
      // this report's files.
      const observed = verifiedPr ? { kind: 'PR' as const, head: verifiedPr.head } : await this.proofFilesForgeHead(identityTask);
      if (!input.head || !observed.head || input.head !== observed.head)
        throw new Error(`The reported head for proofFiles must match the pushed ${observed.kind} head (reported ${JSON.stringify(input.head ?? null)}; ${observed.kind} ${JSON.stringify(observed.head ?? null)})`);
      const head = input.head;
      const records = recordProofFiles({ task: identityTask, run: sourceRun, files: input.proofFiles, head, eventId: input.eventId });
      this.store.appendProofFiles(identityTask.id, records);
      input = proofFilesRemoved(input);
    }
    const acceptRunCompletion = async () => {
      let startEvidence: string | undefined;
      if (sourceRun?.role === 'executor' && sourceRun.taskId === input.taskId && sourceRun.proofExecution) {
        this.store.authenticate(input.runId, token);
        const duplicate = this.store.receipt(input, token); if (duplicate) return duplicate;
        if (input.proofResult) startEvidence = `Executor reported ${input.proofResult.selector}: ${input.proofResult.evidence ?? input.summary}`.slice(0, 4000);
        if (!startEvidence && sourceRun.agentId) {
          const read = await readToolTimeline(this.engine.host, sourceRun.agentId);
          const found = 'entries' in read ? timelineSelectorEvidence(read.entries, sourceRun.proofExecution.selector, true) : null;
          if (found && Date.parse(found.at) >= Date.parse(sourceRun.createdAt)) startEvidence = `Tool timeline: declared selector invoked at ${found.at}`;
        }
        if (!startEvidence) {
          const task = this.store.task(input.taskId);
          const selector = sourceRun.proofExecution.selector.replace(/^effigy\s+/, '');
          const record = this.store.hostRuns(10000).find(row => row.caller === 'queue:effigy-admission'
            && row.repository.path === task.directory && row.selector === selector
            && Date.parse(row.launchedAt ?? row.admittedAt ?? '') >= Date.parse(sourceRun.createdAt)
            && Date.parse(row.launchedAt ?? row.admittedAt ?? '') <= Date.now());
          if (record) startEvidence = `Effigy admission ${record.id} at ${record.launchedAt ?? record.admittedAt}`;
        }
      }
      const receipt = this.resolution.complete(input, token, startEvidence);
      await this.settleHandedOverWorker(input.taskId, sourceRun, input.status);
      await this.settleReportedThread(sourceRun);
      await this.resolution.settleCompletedExecutorBlocker(input);
      void this.engine.cleanContext(() => this.engine.wakeTask(input.taskId));
      return receipt;
    };
    // Task 560: a superseded executor run's late report is historical
    // evidence, recorded by the resolution path below. Route it there before
    // the current-head source gate: a moved or dirty checkout must not refuse
    // conservative evidence from a run that already executed.
    if (sourceRun?.role === 'executor' && sourceRun.taskId === input.taskId && (sourceRun.released || this.store.task(input.taskId).resolution.currentRunId !== sourceRun.id)) {
      return acceptRunCompletion();
    }
    // Queue #691: a report from a run under way when its task finished is evidence only, so it
    // skips the live source gates (PR identity, workspace binding) that would refuse it.
    if (sourceRun && sourceRun.taskId === input.taskId && sourceRun.role !== 'executor' && ['done', 'cancelled'].includes(this.store.task(input.taskId).phase)) {
      const receipt = this.resolution.complete(input, token);
      await this.settleReportedThread(sourceRun);
      return receipt;
    }
    // Spec 037/1090: a source approval is one exact shape, refused before any
    // proof routing or reviewer evidence is recorded.
    const sourceRefusal = sourceApprovalRefusal(input, sourceRun);
    if (sourceRefusal) throw Error(sourceRefusal);
    // Handover reviews use the task workspace.
    if(sourceRun?.role==='reviewer'){
      const duplicate=this.store.receipt(input,token);if(duplicate)return duplicate;
      const sourceTask=this.store.task(input.taskId);
      if(sourceTask.reviewEntry){
        if(sourceRun.workspaceId!==sourceTask.workspaceId||sourceRun.head!==sourceTask.prHead)
          throw Error('Review-entry reviewer callback is not bound to the task workspace and current exact head');
        const pr=this.adapter.verifyPrIdentity
          ? await this.adapter.verifyPrIdentity(sourceTask,taskPrNumber(sourceTask))
          : await this.adapter.verifyPr(sourceTask,taskPrNumber(sourceTask));
        if(pr.head!==sourceRun.head||pr.url!==sourceTask.prUrl)throw Error('Review-entry PR identity changed before callback acceptance');
        await verifyReviewEntryCanonicalAuthor(reviewEntryInputForTask(sourceTask),this.adapter as Adapter&ReviewEntryAdapter);
        const observed=await this.engine.host.observe(sourceRun.agentId!);
        if(observed.id!==sourceRun.agentId||observed.workspaceId!==sourceRun.workspaceId)throw Error('Reviewer callback workspace binding changed');
        await assertReviewEntryExecutionSource(this.store.task(input.taskId));
      }
    }
    // Task 405: a passing proof execution is re-checked against the exact published
    // source before it is recorded. A moved, dirty or unreadable checkout refuses the
    // pass, so the role can never claim source-immutable proof after mutating source.
    // A blocked or error result is always recordable: conservative evidence is not a pass.
    if (sourceRun?.role === 'executor' && input.status === 'proof_executed') {
      this.store.authenticate(input.runId, token);
      const duplicate = this.store.receipt(input, token); if (duplicate) return duplicate;
      const refusal = proofResultRefusal(input, sourceRun);
      if (refusal) throw new Error(refusal);
      const task = this.store.task(input.taskId);
      const source = await verifyProofSource(task, sourceRun.head);
      if (source.tree !== sourceRun.proofExecution?.tree) throw new Error('Canonical source tree changed since the proof execution was reserved');
    }
    const initialRoute = completionRoute(input.status, null);
    if (initialRoute === 'checkpoint') return this.engine.completeCheckpoint(input, token);
    if (initialRoute === 'review_progress') {
      const apply = () => this.engine.completeReviewProgress(input, token);
      return this.engine.reviewerContinuationInFlight(input.taskId, input.runId) ? this.engine.control(apply, `task:${input.taskId}`) : apply();
    }
    if (sourceRun?.ordinaryDetached) await ordinaryReviewSource(this.store.task(input.taskId), sourceRun.head, true);
    else if (input.sourceApproved && sourceRun) await ordinaryReviewSource(this.store.task(input.taskId), sourceRun.head, false);
    const runRoute = completionRoute(input.status, this.store.run(input.runId) ?? null);
    if (runRoute === 'run' || runRoute === 'reviewer') {
      if (isDispositionActive(this.store.task(input.taskId))) {
        const receipt = recordLateCallbackEvidence(this.store, input, token);
        await this.settleReportedThread(sourceRun);
        return receipt;
      }
      if (completionRoute(input.status, this.store.run(input.runId) ?? null) === 'reviewer') {
        const apply = acceptRunCompletion;
        return this.engine.reviewerContinuationInFlight(input.taskId, input.runId) ? this.engine.control(apply, `task:${input.taskId}`) : apply();
      }
      return acceptRunCompletion();
    }
    const duplicate = this.store.receipt(input, token); if (duplicate) return duplicate;
    if (!["ready_for_review", "report_ready", "blocked", "error"].includes(input.status)) throw new Error("Invalid worker result");
    const task = this.store.task(input.taskId);
    if (isDispositionActive(task)) return recordLateCallbackEvidence(this.store, input, token);
    if (task.runId !== input.runId || task.completion) {
      if (supersededByPendingResume(task, input.runId)) {
        recordSupersededRunRefusal(this.store, task.id, input.runId);
        throw new Error(supersededResumeRefusal(input.runId));
      }
      throw new Error("Stale worker run");
    }
    if (input.status === "ready_for_review" && task.resumePrNumber && input.prNumber !== task.resumePrNumber) throw new Error("Replacement worker must use the existing PR");
    if (input.providerUnavailable && !["blocked","error"].includes(input.status)) throw new Error("Provider unavailability requires blocked/error status");
    if (input.status === "ready_for_review" && !input.prNumber) throw new Error("Ready for review requires a PR number");
    if (input.status === 'report_ready') {
      const refusal = reportReadyRefusal(this.store, task, input);
      if (refusal) throw new Error(refusal);
    } else if (input.artifact) throw new Error('An artifact is only valid for report_ready');
    // Receipt acknowledges durable storage. External verification and phase advancement happen on resume.
    // One truthful derivation of the retained worker's pending-replacement binding,
    // shared with the authenticated report bridge (Spec 050).
    const response = this.store.acceptCompletion(input, token, null, { armedReplacement: ownerArmedRetainedWorker(task, this.store.runs(task.id)) });
    const events = this.store.eventsAll(task.id);
    const nonDelivery = input.status === 'report_ready' ? null : nonDeliveryFor(task, this.store.run(input.runId) ?? null, input, events);
    // Task 576: a worker unfinished return with new commits is not a non-delivery.
    const unfinished = !nonDelivery && input.status !== 'report_ready' ? unfinishedReturnFor(task, this.store.run(input.runId) ?? null, input, events) : null;
    if (nonDelivery && !nonDeliveryEvents(events).some(item => item.runId === input.runId))
      this.store.event(task.id, 'non_delivery', JSON.stringify({ ...nonDelivery, attempt: consecutiveNonDeliveries(events).length + 1 }));
    else if (!nonDelivery && consecutiveNonDeliveries(events).length > 0 && ['ready_for_review', 'report_ready', 'blocked', 'error'].includes(input.status))
      this.store.event(task.id, 'non_delivery_reset', `${input.runId}: ${input.status}`);
    if (unfinished && !unfinishedContinuationEvents(events).some(item => item.runId === input.runId))
      this.store.event(task.id, 'unfinished_continuation', JSON.stringify(unfinished));
    await this.settleHandedOverWorker(input.taskId, this.store.run(input.runId) ?? null, input.status);
    void this.engine.cleanContext(() => this.engine.wakeTask(input.taskId)); return response;
  }
  /**
   * nucleus#1180: the forge head a report's proof files bind to when the report
   * carries no PR number. The task branch's open PR head comes first — the same
   * branch-PR observation recovery and the board already use — so a missing or
   * stale recorded PR head never refuses files the forge already shows pushed.
   * Only an empty lookup proves no PR exists: a failed lookup refuses as
   * unverified (review 5891487030) instead of falling through to the branch
   * head, so an unobserved PR head can never pass as a proven absence. With no
   * PR yet the pushed branch head read with `git ls-remote` proves the head is
   * published. A null head refuses below naming the observed side; a failing
   * branch read propagates its own cause instead of binding evidence to an
   * unproved head.
   */
  private async proofFilesForgeHead(task: Task): Promise<{ kind: 'PR' | 'branch'; head: string | null }> {
    if (this.adapter.findOpenBranchPr) {
      let matches: { number: number; url: string; head: string }[];
      try { matches = await this.adapter.findOpenBranchPr(task); }
      catch (error) {
        const cause = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        throw new Error(`The proof-files head check cannot verify the task branch PR head: the open-PR lookup for ${task.branch} failed (${cause}); retry the report once the forge is reachable`);
      }
      const first = matches[0];
      if (first && /^[a-f0-9]{40}$/.test(first.head)) return { kind: 'PR', head: first.head };
    }
    const advertised = await git(task.repoPath, 'ls-remote', 'origin', `refs/heads/${task.branch}`);
    const remote = advertised.split(/\s+/)[0] ?? '';
    return { kind: 'branch', head: /^[a-f0-9]{40}$/.test(remote) ? remote : null };
  }
  /** The accepted receipt is durable before the best-effort host presentation effect. */
  private async settleReportedThread(run: Run | null | undefined): Promise<void> {
    if (!run || run.role === 'revision' || !run.agentId || !run.hostId) return;
    try {
      await this.engine.withHost(run.hostId, async () => {
        await this.adapter.settleReportedThread?.(run.agentId!, run.id);
      });
    }
    catch { /* T3 records the uncertain intent; a later host sweep retries it. */ }
  }
  /**
   * Bounded worker checkpoint. Identity, cleanliness, pushed-head and budget
   * gates are re-checked after the external worktree proof before one durable
   * receipt, ordinal and continuation intent are persisted. The continuation
   * itself is delivered by the checkpoint reconciliation from that intent.
   *
   * The reporting run is the initial worker (which has no Run row) or the task's
   * current revision run: a long revision run reaches the same bounded stop, and
   * both share the task-level budget.
   */
  async completeCheckpoint(input: Completion, token: string): Promise<CheckpointResult> {
    const reporting = this.store.run(input.runId);
    if (reporting && reporting.role !== 'revision') throw new Error('A progress checkpoint is only valid for the task worker or its current revision run. This refusal is not a blocker and needs no report: keep working in this turn, push your commits, and report when the work is done');
    this.store.authenticate(input.runId, token);
    const duplicate = this.store.receipt(input, token); if (duplicate) return duplicate as CheckpointResult;
    if (!input.head) throw new Error('A progress checkpoint requires the exact local head');
    const gate = () => {
      const task = this.store.task(input.taskId);
      if (isDispositionActive(task)) throw new Error('A disposition fence is active; progress checkpoints are not accepted');
      if (reporting) {
        // A revision run reports on its own row; only the task's current, unreleased
        // revision in the retained worker and workspace can checkpoint.
        const run = this.store.run(input.runId);
        if (!run || run.released || run.completion || task.resolution.currentRunId !== input.runId
          || run.agentId !== task.agentId || run.workspaceId !== task.workspaceId || task.phase !== 'changes_requested')
          throw new Error('Stale worker run');
      } else {
        if (task.runId !== input.runId || task.completion) {
          if (supersededByPendingResume(task, input.runId)) {
            recordSupersededRunRefusal(this.store, task.id, input.runId);
            throw new Error(supersededResumeRefusal(input.runId));
          }
          throw new Error('Stale worker run');
        }
        if (task.prUrl || task.prHead || task.resumePrNumber || task.resolution.currentRunId) throw new Error('A progress checkpoint is only valid before an accepted PR');
      }
      if (interactiveSessionOpen(task, this.store.runs(task.id))) throw new Error('This task is interactive: during the session tell the operator in the thread; report ready_for_review only when the operator says submit (Spec 051)');
      if (!task.agentId || !task.workspaceId || !task.directory || !task.profile) throw new Error('A progress checkpoint requires the retained worker, workspace and branch');
      return task;
    };
    const task = gate();
    if (task.checkpoints.records.length >= CHECKPOINT_BUDGET)
      return this.engine.rejectCheckpoint(task, input, `Worker reported progress_checkpoint ${task.checkpoints.records.length + 1} beyond the bounded budget of ${CHECKPOINT_BUDGET}; coordinator attention is required for another continuation`);
    const pending = task.checkpoints.intent;
    if (pending && pending.status !== 'delivered') throw new Error('The previous checkpoint continuation has not been delivered; wait for the retained worker to resume');
    const last = task.checkpoints.records.at(-1);
    if (last && last.head === input.head && last.summary === input.summary.trim()) throw new Error('This checkpoint receipt was already accepted; its continuation closed the turn');
    if (!this.adapter.verifyCheckpoint) throw new Error('Bounded checkpoint verification is unavailable; complete the work or report blocked');
    await this.adapter.verifyCheckpoint(task, input.head);
    if (this.engine.stopped || this.store.getMeta('paused')) throw new Error('Nucleus paused during checkpoint verification');
    const response = this.store.transaction(() => {
      const current = gate();
      // Observations may advance the version during the external proof; only a
      // concurrent change to the checkpoint state invalidates this acceptance.
      if (current.checkpoints.records.length !== task.checkpoints.records.length || current.checkpoints.intent?.status !== task.checkpoints.intent?.status) throw new Error('Checkpoint state changed during verification');
      if (current.checkpoints.records.length >= CHECKPOINT_BUDGET) throw new Error('The bounded checkpoint budget was reached during verification');
      const ordinal = current.checkpoints.records.length + 1, createdAt = now();
      const record = { ordinal, summary: input.summary.trim().slice(0, 4000), head: input.head!, at: createdAt, runId: input.runId };
      const intent = { id: digest(`${current.id}:${ordinal}:${input.eventId}`), ordinal, summary: record.summary, head: record.head, runId: input.runId, eventId: input.eventId, status: 'pending' as const, createdAt, deliveredAt: null, attempts: 0, error: '' };
      const receipt = { accepted: true as const, eventId: input.eventId, checkpoint: { ordinal, budget: CHECKPOINT_BUDGET, continued: true } };
      this.store.update(current.id, { checkpoints: { records: [...current.checkpoints.records, record], intent }, reason: `Checkpoint ${ordinal}/${CHECKPOINT_BUDGET} accepted; continuing the retained worker` }, 'progress_checkpoint', `${record.summary} @ ${record.head}`);
      this.store.setCompletionReceipt(input.eventId, current.id, input.runId, digest(JSON.stringify(input)), JSON.stringify(receipt));
      return receipt;
    });
    void this.engine.wake().catch(() => { /* a failed drain is recorded as engineError */ });
    return response;
  }
  /** The durable receipt acknowledges a fourth checkpoint as evidence without continuing the worker. */
  rejectCheckpoint(task: Task, input: Completion, reason: string): CheckpointResult {
    const response = this.store.transaction(() => {
      const current = this.store.task(task.id);
      const receipt = { accepted: true as const, eventId: input.eventId, checkpoint: { ordinal: current.checkpoints.records.length, budget: CHECKPOINT_BUDGET, continued: false, attention: reason } };
      this.store.event(current.id, 'checkpoint_rejected', `${input.summary} @ ${input.head}: ${reason}`);
      this.store.setCompletionReceipt(input.eventId, current.id, input.runId, digest(JSON.stringify(input)), JSON.stringify(receipt));
      return receipt;
    });
    this.resolution.attention(this.store.task(task.id), reason);
    void this.engine.wake().catch(() => { /* a failed drain is recorded as engineError */ });
    return response;
  }
  /**
   * Spec 044: bounded reviewer progress. A `review_in_progress` report records an
   * immutable checkpoint on the reviewer run. No continuation intent is created.
   * It is never a verdict: no completion, no review record, no merge. The task coordinator or owner continues it with restart role=reviewer.
   */
  async completeReviewProgress(input: Completion, token: string): Promise<CheckpointResult> {
    if (!this.store.run(input.runId)) throw new Error('A review progress report requires a reviewer run');
    this.store.authenticate(input.runId, token);
    const duplicate = this.store.receipt(input, token); if (duplicate) return duplicate as CheckpointResult;
    const progressRun = this.store.run(input.runId);
    if (progressRun?.ordinaryDetached) await ordinaryReviewSource(this.store.task(input.taskId), progressRun.head, true);
    const gate = () => {
      const task = this.store.task(input.taskId);
      if (isDispositionActive(task)) throw new Error('A disposition fence is active; review progress is not accepted');
      const run = this.store.run(input.runId);
      if(run?.ordinaryDetached) assertOrdinaryReviewIdentity(task, run.head, true);
      if (!run || run.taskId !== task.id || run.role !== 'reviewer') throw new Error('A review progress report requires a reviewer run');
      // Replaced is not released (planner ruling, 2026-11-09): a still-working
      // replaced reviewer's checkpoint still applies as saved progress while its
      // exact-head verdict can still readopt it; the replacement owns any
      // continuation delivery. Every other non-current, settled or released
      // reviewer run is stale.
      const replacedClaim = run.replacedAt !== undefined && !run.released && run.status === 'superseded' && !run.completion;
      if (!replacedClaim && (task.resolution.currentRunId !== run.id || run.completion || run.released)) throw new Error('Stale reviewer run');
      assertReviewResponsibility(input, run);
      if (input.head !== run.head) throw new Error('Review progress must name the reviewer run exact head');
      if (!input.checkpoint) throw new Error('A review progress report requires a checkpoint naming the covered and remaining items');
      if (input.verdicts?.length) throw new Error('A review progress report carries no verdicts; report review_in_progress with a checkpoint only');
      return { task, run };
    };
    const { task, run } = gate();
    const limit = this.engine.reviewContinuationLimit();
    const records = run.reviewCheckpoints ?? [];
    if (records.length >= limit)
      return this.engine.rejectReviewProgress(task, run, input, limit, 'review exceeded continuation limit');
    const response = this.store.transaction(() => {
      const current = gate();
      const ordinal = (current.run.reviewCheckpoints ?? []).length + 1, createdAt = now();
      if (ordinal > limit) throw new Error('The reviewer continuation limit was reached during verification');
      const path = reviewCheckpointPathFor(this.store, current.task.id, current.run.id, ordinal);
      // The checkpoint is stamped with the brief this reviewer run holds, not the task's
      // current brief: a reviewer still on an older version has not read an amendment.
      const runBrief = current.run.briefVersion ?? null;
      const currentBriefVersion = runBrief === null ? currentBrief(current.task) : current.task.briefVersions.find(version => version.version === runBrief) ?? null;
      const checkpointDigest = digest(JSON.stringify(input.checkpoint!));
      const record = { ordinal, checkpoint: input.checkpoint!, head: current.run.head, at: createdAt, runId: current.run.id, path,
        eventId: input.eventId, callbackDigest: digest(JSON.stringify(input)), checkpointDigest, briefVersion: currentBriefVersion?.version ?? null,
        briefDigest: currentBriefVersion ? briefDigest(currentBriefVersion.text) : null };
      const receipt = { accepted: true as const, eventId: input.eventId, checkpoint: { ordinal, budget: limit, continued: false, attention: REVIEW_AUTHORIZATION_REQUIRED, checkpointDigest } };
      writeReviewCheckpoint(this.store, current.task.id, record);
      // A checkpoint is saved progress, never proof of WHICH unknown send reached
      // the reader: its ordinal is assigned when Queue receives it, so a delayed
      // earlier checkpoint can arrive after a later continuation and must not
      // settle that continuation. Deliveries stay exactly as recorded; only their
      // own exact timeline message settles an occurrence.
      this.store.putRun({ ...current.run, reviewCheckpoints: [...(current.run.reviewCheckpoints ?? []), record] });
      // A replaced run's checkpoint is saved progress only: the replacement owns
      // any continuation delivery, so the task's authorization reason is left to
      // the current run's own checkpoints.
      if (current.task.resolution.currentRunId === current.run.id) this.store.update(current.task.id, { reason: REVIEW_AUTHORIZATION_REQUIRED });
      this.store.event(current.task.id, 'review_checkpoint', `${ordinal}/${limit} ${input.eventId} run ${current.run.id} at ${current.run.head}`);
      this.store.setCompletionReceipt(input.eventId, current.task.id, current.run.id, digest(JSON.stringify(input)), JSON.stringify(receipt));
      return receipt;
    });
    void this.engine.wake().catch(() => { /* a failed drain is recorded as engineError */ });
    return response;
  }
  /** The durable receipt records the exhausted continuation budget as evidence and leaves the verdict to the reviewer. */
  rejectReviewProgress(task: Task, run: Run, input: Completion, limit: number, reason: string): CheckpointResult {
    const response = this.store.transaction(() => {
      const current = this.store.task(task.id);
      const currentRun = this.store.run(run.id);
      const receipt = { accepted: true as const, eventId: input.eventId, checkpoint: { ordinal: (currentRun?.reviewCheckpoints ?? []).length, budget: limit, continued: false, attention: reason } };
      this.store.event(current.id, 'review_checkpoint_rejected', `${input.summary} at ${input.head}: ${reason} (${(currentRun?.reviewCheckpoints ?? []).length}/${limit})`);
      // The reading is kept on the run as evidence, never as a checkpoint: it
      // grants no continuation, and the owner or the next reader can read it.
      const reading = { eventId: input.eventId, head: run.head, at: now(), checkpoint: input.checkpoint!, reason };
      if (currentRun) this.store.putRun({ ...currentRun, ...(currentRun.reviewBudgetExhaustedAt ? {} : { reviewBudgetExhaustedAt: now() }),
        reviewRejectedReadings: [...(currentRun.reviewRejectedReadings ?? []), reading] });
      this.store.setCompletionReceipt(input.eventId, current.id, run.id, digest(JSON.stringify(input)), JSON.stringify(receipt));
      return receipt;
    });
    // Replaced is not released (planner ruling, 2026-11-09): an exhausted claim
    // holder's evidence stays on its run, and only a current run's exhaustion
    // moves the task's reason — the replacement owns the task's continuation.
    if (task.resolution.currentRunId === run.id) this.store.update(task.id, { reason: REVIEW_BUDGET_EXHAUSTED });
    void this.engine.wake().catch(() => { /* a failed drain is recorded as engineError */ });
    return response;
  }
}
