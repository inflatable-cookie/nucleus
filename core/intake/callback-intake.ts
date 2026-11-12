import { readToolTimeline } from '../recovery/stall';
import { timelineSelectorEvidence } from '../qa/proof-execution';
import { recordResultApplied } from './applied-result';
import type { CheckpointResult, Completion, Run, Task } from '../../shared/contracts';
import { CHECKPOINT_BUDGET, isDispositionActive, isDispositionComplete } from '../../shared/contracts';
import { briefDigest, currentBrief } from '../planning/brief';
import { runBuildOutputIntent } from '../hooks/build-output-records';
import { recordLateCallbackEvidence } from '../verbs/disposition';
import type { Engine } from '../engine';
import { releaseRunFromRecordedCompletion } from '../recovery/fence-settlement';
import { assertCanonicalPrSource, reviewPublicationBody, taskPrNumber } from '../forge/index';
import { heldBriefQueuePolicy } from '../planning/handoff';
import { supersededWorkerResult } from '../recovery/incident';
import { interactiveSessionOpen } from '../dispatch/interactive';
import { consecutiveNonDeliveries, nonDeliveryEvents, nonDeliveryFor, unfinishedContinuationEvents, unfinishedReturnFor } from '../recovery/non-delivery';
import { assertOrdinaryReviewIdentity, assertReviewRunSource, ordinaryReviewSource } from '../review/ordinary-review';
import type { Adapter } from '../host/adapter';
import { awaitingProofMatchesSelector, declaredProofSelectors, proofExecutionRecord, proofExecutions, proofWaitApplies, recordProofExecution, verifyProofSource } from '../qa/proof-execution';
import type { Resolution } from '../resolution';
import { REVIEW_AUTHORIZATION_REQUIRED, REVIEW_BUDGET_EXHAUSTED, reviewCheckpointPathFor, reviewDeliveryReason, writeReviewCheckpoint } from '../review/review-continuation';
import { assertReviewEntryExecutionSource, reviewEntryInputForTask, type ReviewEntryAdapter, verifyReviewEntryCanonicalAuthor } from '../review/review-entry';
import { assertReviewResponsibility } from '../review/review-verdicts';
import { digest, now } from '../store/store';
import { recordWorkerProofFiles } from './proof-files';
import { recordSupersededRunRefusal, supersededByPendingResume, supersededResumeRefusal } from '../recovery/superseded-resume';
import { coordinatorActionShapeRefusal, coordinative, ownerArmedRetainedWorker } from '../recovery/task-reasons';

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

/** Select the receipt path for a checkpoint or a live resolution run. */
export function completionRoute(status: Completion['status'], run: Run | null): 'checkpoint' | 'review_progress' | 'reviewer' | 'run' | 'worker' {
  if (status === 'progress_checkpoint') return 'checkpoint';
  if (status === 'review_in_progress') return 'review_progress';
  if (run?.role === 'reviewer') return 'reviewer';
  return run ? 'run' : 'worker';
}

/** First role/status refusal after report-only policy has been checked. */
export function completionRefusal(input: Completion, run: Run, task: Task, revisionReportOnly: boolean): string | null {
  const role = run.role;
  const allowed = role === 'recovery' ? ['recovered','escalate','blocked','error'] : role === 'reviewer' ? ['ready_to_merge', 'changes_required', 'blocked', 'error'] : role === 'revision' ? ['ready_for_review', ...(revisionReportOnly ? ['report_ready'] : []), 'blocked', 'error'] : role === 'executor' ? ['proof_executed', 'blocked', 'error'] : ['closed', 'blocked', 'error'];
  if (input.closeoutCommit && (role !== 'closeout' || input.status !== 'closed')) return 'Published closeout commit requires a closed coordinator result';
  if (input.providerUnavailable && !['blocked','error'].includes(input.status)) return 'Provider unavailability requires blocked/error status';
  if (!allowed.includes(input.status)) return 'Result is not valid for this run role';
  if (role === 'recovery' && (input.recoveryAction || input.replacementAgentId)) return 'recoveryAction is retired; report coordinatorAction {verb: restart|route|move|retry_effect|cannot, reason} instead';
  if (role === 'recovery' && input.status === 'recovered' && !input.coordinatorAction) return `Recovery requires a coordinatorAction. ${coordinatorActionShapeRefusal('the report carries none')}`;
  if (role !== 'recovery' && (input.recoveryAction || input.coordinatorAction || input.replacementAgentId)) return 'Recovery action requires coordinator recovery run';
  if (role === 'executor') {
    if (!run.proofExecution) return 'Executor run is missing its bound proof subject';
    if (input.status === 'proof_executed') {
      if (!input.proofResult) return 'A proof execution result must carry proofResult for its declared selector';
      if (input.proofResult.selector !== run.proofExecution.selector) return "Proof execution result must name the run's declared selector";
    }
  } else if (input.proofResult) return 'proofResult is only accepted on a proof execution run';
  if (!['blocked', 'error', 'recovered', 'escalate'].includes(input.status) && !revisionReportOnly) {
    if (role === 'revision') {
      if (!input.prNumber) return 'Revision readiness requires a PR';
      const expectedPr = task.resolution.revisionPrRepair ? null : task.resumePrNumber ?? task.completion?.prNumber;
      if (expectedPr && input.prNumber !== expectedPr) return 'Revision must use the task PR';
    } else if (input.head !== run.head) return 'Result must name the requested exact head';
    if (role === 'reviewer' && !input.reviewCommentId && !input.reviewText) return 'Review requires full reviewText or a durable PR comment ID';
  }
  return null;
}

/**
 * Authenticate, validate and record one worker report. Joins Engine's source
 * gates with the checkpoint and review-progress receipts. Same-name `Engine`
 * methods delegate here. `store`, `adapter` and `resolution` read the engine
 * per call: tests replace the adapter.
 */
export type CallbackIntakeContext = Pick<Engine, 'adapter' | 'cleanContext' | 'completeCheckpoint' | 'completeReviewProgress' | 'control' | 'host' | 'rejectCheckpoint' | 'rejectReviewProgress' | 'reviewContinuationLimit' | 'reviewerContinuationInFlight' | 'stopped' | 'store' | 'wake' | 'wakeTask'> & { readonly resolution: Pick<Resolution, 'attention' | 'complete' | 'settleCompletedExecutorBlocker'> };

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
  async complete(input: Completion, token: string) {
    const sourceRun=this.store.run(input.runId);
    this.store.authenticate(input.runId, token);
    const identityTask = this.store.task(input.taskId);
    if (sourceRun ? sourceRun.taskId !== identityTask.id : identityTask.runId !== input.runId)
      throw new Error('Stale report: task and run identity do not match');
    const priorReceipt = this.store.receipt(proofFilesRemoved(input), token);
    if (priorReceipt) return priorReceipt;
    let verifiedPr: { url: string; head: string } | null = null;
    if (!sourceRun || sourceRun.role === 'revision') {
      const branches = `${input.headline ?? ''} ${input.summary}`.match(/\bns-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? [];
      if (branches.some(branch => branch !== identityTask.branch)) throw new Error('Report names another task branch');
      if (input.prNumber) {
        const pr = this.adapter.verifyPrIdentity
          ? await this.adapter.verifyPrIdentity(identityTask, input.prNumber, {allowDraft: input.status !== 'ready_for_review'})
          : await this.adapter.verifyPr(identityTask, input.prNumber);
        assertCanonicalPrSource(pr, input.prNumber);
        verifiedPr = { url: pr.url, head: pr.head };
      }
    }
    // nucleus#1142: a worker's proof files are copied into Nucleus's own
    // per-head evidence directory before the result is accepted, and the copied
    // records are what the retained reviewer's prompt lists. The report's local
    // source paths never enter the stored completion; only the copies, their
    // hashes and their labels do. A refused path copies nothing.
    if (input.proofFiles?.length) {
      if (sourceRun && sourceRun.role !== 'revision')
        throw new Error('proofFiles is only accepted on a worker or revision report; no other role delivers author evidence');
      const head = sourceRun?.head ?? verifiedPr?.head ?? input.head;
      const records = recordWorkerProofFiles({ task: identityTask, run: sourceRun, files: input.proofFiles, head, eventId: input.eventId });
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
      return acceptRunCompletion();
    }
    if (input.sourceApproved || input.awaitingProofs) {
      if (sourceRun?.role !== 'reviewer' || input.status !== 'blocked' || input.reviewResponsibility !== 'environment'
        || !input.sourceApproved || !input.awaitingProofs?.length || input.head !== sourceRun.head || !input.reviewText)
        throw Error('Source approval requires an exact-head environment blocked review with findings and named awaiting proofs; if only release gates remain, report ready_to_merge');
    }
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
      if (!input.proofResult) throw new Error('A proof execution result must carry proofResult for its declared selector');
      if (input.proofResult.selector !== sourceRun.proofExecution?.selector) throw new Error("Proof execution result must name the run's declared selector");
      this.store.authenticate(input.runId, token);
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
      if (isDispositionActive(this.store.task(input.taskId))) return recordLateCallbackEvidence(this.store, input, token);
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
      const briefText = task.briefVersions.at(-1)?.text ?? task.brief?.text;
      if (!briefText) throw new Error('report_ready requires a Nucleus-held brief with queue.reportOnly: true');
      let policy: ReturnType<typeof heldBriefQueuePolicy>;
      try { policy = heldBriefQueuePolicy(briefText); }
      catch { throw new Error('report_ready requires a valid Nucleus-held brief with queue.reportOnly: true'); }
      if (!policy.reportOnly) throw new Error('report_ready is only allowed when the brief opts into queue.reportOnly: true');
      if (!input.artifact) throw new Error('report_ready requires the exact lane document artifact');
      if (policy.reportLane && input.artifact.key !== policy.reportLane) throw new Error(`report_ready artifact must use the brief's report lane ${policy.reportLane}`);
      if (!task.lanes.includes(input.artifact.key)) throw new Error('report_ready artifact must be a lane attached to this task');
      const exact = this.store.laneDocument(input.artifact.key, input.artifact.version);
      const latest = this.store.laneDocument(input.artifact.key);
      if (!exact || exact.digest !== input.artifact.digest || !latest || latest.version !== input.artifact.version || latest.digest !== input.artifact.digest)
        throw new Error('report_ready artifact must identify the latest exact Nucleus lane document version and digest');
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
    void this.engine.cleanContext(() => this.engine.wakeTask(input.taskId)); return response;
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

/**
 * Authenticate, validate and record one run report. Resolution.complete stays
 * synchronous and in the same transaction. Same-name `Resolution` methods
 * delegate here. `store` and `adapter` read the resolution per call: tests
 * replace the adapter.
 */
export type RunCallbackIntakeContext = Pick<Resolution, 'adapter' | 'completeBookkeeping' | 'completeBuildOutput' | 'completeProof' | 'completeReceipt' | 'completeValidate' | 'readoptReplacedReviewer' | 'reconcileReviewDelivery' | 'recordFinishedTaskCompletion' | 'recordSupersededProofEvidence' | 'resolveIncident' | 'store' | 'update'>;

export class RunCallbackIntake {
  constructor(readonly resolution: RunCallbackIntakeContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }
  /**
   * Re-adopt a replaced reviewer run whose verdict lands first at the exact current
   * head. Replaced is not released (planner ruling, 2026-11-09): the replaced run
   * stays unreleased with a live credential until the review settles. Returns true
   * when the run is current again, so the ordinary path applies it.
   */
  readoptReplacedReviewer(task: Task, run: Run, input: Completion): boolean {
    // Only a reviewer an owner control replaced: provider-refusal and quota replacements stay refused.
    if (run.role !== 'reviewer' || !run.replacedAt || run.released || run.status !== 'superseded' || run.completion || task.resolution.currentRunId === run.id) return false;
    if (!['ready_to_merge', 'changes_required'].includes(input.status)) return false;
    if (!['reviewing', 'awaiting_review'].includes(task.phase) || !task.prHead || run.head !== task.prHead || (input.head ?? run.head) !== task.prHead) return false;
    if (task.resolution.review?.head === task.prHead || task.resolution.mergeIntent || task.resolution.mergedCommit) return false;
    if (isDispositionActive(task) || isDispositionComplete(task)) return false;
    // First verdict wins: a later reviewer's verdict ends this run's claim, even after a fresh-review move clears it.
    const runs = this.store.runs(task.id);
    if (runs.slice(runs.findIndex(other => other.id === run.id) + 1).some(other => other.role === 'reviewer' && ['ready_to_merge', 'changes_required'].includes(other.completion?.status ?? ''))) return false;
    const current = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
    // A replacement still being created or delivered would rebind itself on return.
    if (current && (current.role !== 'reviewer' || current.completion || current.status !== 'running' || !current.agentId)) return false;
    if (current && !current.released) {
      // Settling the replacement releases it, and the release revokes its
      // credential and tickets unconditionally — after release nothing authenticates.
      this.store.putRun({ ...current, status: 'superseded', released: true, active: false });
    }
    this.store.putRun({ ...run, status: 'running', released: false, replacedAt: undefined });
    this.resolution.update(task, { currentRunId: run.id, reviewerAgentId: run.agentId, reviewerProfile: run.profile }, { phase: 'reviewing' }, 'replaced_reviewer_readopted',
      `${run.id} verdict at ${task.prHead}${current && current.id !== run.id ? `; settled ${current.id}` : ''}`);
    return true;
  }
  complete(input: Completion, token: string, startEvidence?: string) {
    const probe = this.store.run(input.runId);
    if (probe && probe.taskId === input.taskId && isDispositionActive(this.store.task(probe.taskId))) return recordLateCallbackEvidence(this.store, input, token);
    // Queue #691: a report from a run that was under way when a task finished is history.
    if (probe && probe.taskId === input.taskId && probe.role !== 'executor' && ['done', 'cancelled'].includes(this.store.task(probe.taskId).phase))
      return this.resolution.recordFinishedTaskCompletion(this.store.task(probe.taskId), probe, input, token);
    return this.store.transaction(() => {
      let run = this.store.run(input.runId); if (!run || run.taskId !== input.taskId) throw new Error('Unknown run');
      this.store.authenticate(run.id, token);
      let task = this.store.task(run.taskId);
      if (coordinative(run)) {
        // A coordinative report is bound to its authenticated run. The run is
        // superseded only when the task moved to a newer generation; an
        // explicitly different generation is stale input. A missing generation
        // binds to the authenticated run's own generation instead of reading
        // as superseded, matching the MCP bridge derivation.
        if (run.generation !== task.coordinatorGeneration) throw new Error('Superseded coordinator assignment');
        if (input.coordinatorGeneration === undefined) input = { ...input, coordinatorGeneration: run.generation };
        if (input.coordinatorGeneration !== run.generation) throw new Error('Superseded coordinator assignment');
      }
      const duplicate = this.store.receipt(input, token); if (duplicate) return duplicate;
      // Replaced is not released (planner ruling, 2026-11-09, reconciling Tom's
      // 2026-10-19 ruling with #1269): a working replaced reviewer's exact-head
      // verdict is accepted while no verdict for that head exists — it becomes
      // the current reviewer again and the replacement is settled. Only verdicts;
      // a replaced run cannot be continued.
      if (this.resolution.readoptReplacedReviewer(task, run, input)) { run = this.store.run(run.id)!; task = this.store.task(task.id); }
      const currentRunId=run.role==='recovery'?task.resolution.recovery?.runId:task.resolution.currentRunId;
      // A retained resolution thread may discover that a reported blocker was
      // transient and finish its assigned work before releasing the lease. Keep
      // the first receipt as audit evidence, but allow one forward correction to
      // the role's successful terminal result. Once released or superseded, the
      // immutable run boundary still rejects late callbacks.
      const correctingBlock=currentRunId===run.id&&!run.released&&run.role!=='recovery'&&
        Boolean(run.completion&&['blocked','error'].includes(run.completion.status)&&!['blocked','error'].includes(input.status));
      if (currentRunId !== run.id || run.completion&&!correctingBlock || run.released) {
        const replacement=currentRunId?this.store.run(currentRunId):null;
        if(replacement&&replacement.id!==run.id&&!replacement.released&&!replacement.completion&&replacement.agentId&&replacement.agentId===run.agentId) {
          recordSupersededRunRefusal(this.store,task.id,run.id);
          throw new Error(supersededResumeRefusal(run.id));
        }
        if(task.resolution.prePrResumeInstruction&&run.agentId&&run.agentId===task.agentId) {
          recordSupersededRunRefusal(this.store,task.id,run.id);
          throw new Error(supersededResumeRefusal(run.id));
        }
        // Task 560: a superseded executor run that actually ran keeps
        // truthful history. Its agent's late report is recorded as historical
        // evidence on its own execution record instead of rejected as stale.
        if (run.role === 'executor' && (run.released || currentRunId !== run.id))
          return this.resolution.recordSupersededProofEvidence(task, run, input, startEvidence);
        throw new Error('Stale run');
      }
      const response = this.resolution.completeValidate(input, run, task);
      this.resolution.completeProof(run, task, input, startEvidence);
      this.resolution.completeBuildOutput(run, task);
      this.resolution.completeBookkeeping(run, task, input);
      this.resolution.completeReceipt(run, task, input, correctingBlock, response);
      return response;
    });
  }
  /** Validate the report, record it on the run, and emit non-delivery or unfinished events. */
  completeValidate(input: Completion, run: Run, task: Task) {
    let revisionReportOnly = false;
    if (run.role === 'revision' && input.status === 'report_ready') {
      const briefText = task.briefVersions.at(-1)?.text ?? task.brief?.text;
      if (!briefText) throw new Error('report_ready requires a Nucleus-held brief with queue.reportOnly: true');
      let policy: ReturnType<typeof heldBriefQueuePolicy>;
      try { policy = heldBriefQueuePolicy(briefText); }
      catch { throw new Error('report_ready requires a valid Nucleus-held brief with queue.reportOnly: true'); }
      if (!policy.reportOnly) throw new Error('report_ready is only allowed when the brief opts into queue.reportOnly: true');
      if (!input.artifact) throw new Error('report_ready requires the exact lane document artifact');
      if (policy.reportLane && input.artifact.key !== policy.reportLane) throw new Error(`report_ready artifact must use the brief's report lane ${policy.reportLane}`);
      if (!task.lanes.includes(input.artifact.key)) throw new Error('report_ready artifact must be a lane attached to this task');
      const exact = this.store.laneDocument(input.artifact.key, input.artifact.version);
      const latest = this.store.laneDocument(input.artifact.key);
      if (!exact || exact.digest !== input.artifact.digest || !latest || latest.version !== input.artifact.version || latest.digest !== input.artifact.digest)
        throw new Error('report_ready artifact must identify the latest exact Nucleus lane document version and digest');
      revisionReportOnly = true;
    } else if (run.role === 'revision' && input.artifact) throw new Error('An artifact is only valid for report_ready');
    const refusal = completionRefusal(input, run, task, revisionReportOnly);
    if (refusal) throw new Error(refusal);
    if (!['blocked', 'error','recovered','escalate'].includes(input.status) && !revisionReportOnly
        && run.role === 'reviewer' && input.reviewText)
      reviewPublicationBody(task,run,input.status,input.reviewText,input.verdicts??[]);
    if (run.role === 'reviewer' && ['blocked', 'error'].includes(input.status)
        && (input.reviewText || input.verdicts?.length) && input.head !== run.head)
      throw Error('Blocked reviewer evidence must name the requested exact head');
    // Spec 037: applies to any reviewer result, including a blocked review that
    // carries structured judgments without a merge verdict.
    if (input.sourceApproved || input.awaitingProofs) {
      if (run.role !== 'reviewer' || input.status !== 'blocked' || input.reviewResponsibility !== 'environment'
        || !input.sourceApproved || !input.awaitingProofs?.length || input.head !== run.head || !input.reviewText)
        throw Error('Source approval requires an exact-head environment blocked review with findings and named awaiting proofs; if only release gates remain, report ready_to_merge');
    }
    if (run.ordinaryDetached) assertReviewRunSource(task, run.head, true);
    else if (input.sourceApproved) assertReviewRunSource(task, run.head, false);
    assertReviewResponsibility(input, run);
    const response = { accepted: true as const, eventId: input.eventId };
    // A completion is that run's own result, never proof of WHICH delivery
    // occurrence produced it. Neither the count of unresolved sends nor the time
    // Queue received the report binds an occurrence: an authentic report from an
    // earlier turn can enter the bridge after a later send. The occurrence stays
    // unknown until its own exact evidence — its exact timeline message or a
    // later authenticated checkpoint — settles it.
    const previousEvents = this.store.eventsAll(task.id);
    // A source-approved proof round's no-change blocked return is the proof
    // wait's own episode (Spec 058 slice 9): the proof reconciliation re-parks
    // it, and it is never a non-delivery or an unfinished return.
    const proofRound = proofWaitApplies(task);
    const nonDelivery = proofRound ? null : nonDeliveryFor(task, run, input, previousEvents);
    // Task 576: an unfinished return with new commits is not a non-delivery.
    // It continues the same round below; the two shapes are mutually exclusive
    // because one requires an unchanged checkout and the other new commits.
    const unfinished = proofRound ? null : unfinishedReturnFor(task, run, input, previousEvents);
    this.store.putRun({ ...run, completion: input });
    // report_ready is a terminal delivery for this revision turn. As with the
    // initial worker callback, release the author before planner acceptance.
    if (revisionReportOnly) {
      releaseRunFromRecordedCompletion(this.store, task.id, { ...run, completion: input });
      this.resolution.update(task, { currentRunId: null, integrationTurn: null },
        { phase: 'report_ready', completion: input, reason: input.summary }, 'revision_report_ready');
      recordResultApplied(this.store, task.id, run.id);
    }
    if (nonDelivery && !nonDeliveryEvents(previousEvents).some(item => item.runId === run.id))
      this.store.event(task.id, 'non_delivery', JSON.stringify({ ...nonDelivery, attempt: consecutiveNonDeliveries(previousEvents).length + 1 }));
    else if (!nonDelivery && ['worker', 'revision'].includes(run.role) && consecutiveNonDeliveries(previousEvents).length > 0)
      this.store.event(task.id, 'non_delivery_reset', `${run.id}: ${input.status}`);
    if (unfinished && !unfinishedContinuationEvents(previousEvents).some(item => item.runId === run.id))
      this.store.event(task.id, 'unfinished_continuation', JSON.stringify(unfinished));
    return response;
  }
  /** Record one proof execution's evidence and terminal exit in the same transaction as its receipt. */
  completeProof(run: Run, task: Task, input: Completion, startEvidence?: string) {
    // Task 405: one proof execution's evidence and terminal exit are recorded in
    // the same transaction as its authenticated receipt. It is never a review and
    // never a pass for another role: the task returns to the phase the owner
    // activated it from, with independent review still required. The source was
    // re-proved before a passing claim was accepted (Engine.complete).
    if (run.role === 'executor' && run.proofExecution) {
      const binding = run.proofExecution;
      recordResultApplied(this.store, task.id, run.id);
      const record = proofExecutionRecord({ ...run, completion: input }, task, binding.authorizedBy, binding.operationId);
      const status = input.status === 'proof_executed' ? (input.proofResult?.status === 'passed' ? 'passed' : 'failed') : 'unknown';
      recordProofExecution(this.store, task.id, { ...record, status, exitCode: input.proofResult?.exitCode ?? null,
        refusedBeforeSelector: false, selectorStart: startEvidence ? 'started' : 'unknown', ...(startEvidence ? { selectorStartEvidence: startEvidence } : {}),
        evidence: [input.summary, input.proofResult?.evidence].filter(Boolean).join('\n').slice(0, 4000) },
        `${run.id}: ${status} for ${binding.selector} at ${run.head}`);
      const reason = status === 'passed'
        ? `Author-side proof execution ${run.id} passed ${binding.selector} at ${run.head}; a distinct independent review is still required`
        : `Author-side proof execution ${run.id} did not pass ${binding.selector} at ${run.head}; the execution is recorded and that head's allowance is spent`;
      const latest = this.store.task(task.id);
      if (latest.entrypoint === 'proof') {
        this.resolution.update(latest, { currentRunId: null, integrationTurn: null },
          { phase: 'awaiting_review', reason: `Qualification ${run.id} settled ${status} for ${binding.selector} at merged commit ${run.head}; the retained reviewer will judge its receipt` },
          'proof_only_execution_settled', `${run.id}: ${status} for ${binding.selector} at ${run.head}`);
      } else if (status === 'failed') {
        const cases = [input.summary, input.proofResult?.evidence].filter(Boolean).join('\n').slice(0, 3000);
        const instruction = `The settled proof failed at ${run.head}. Revise the task to address these failing cases, then return the PR for the retained reviewer to judge. Proof receipt: task.detail → proofExecutions for run ${run.id} (selector ${binding.selector}, exact head ${run.head}); use its recorded evidence and case failures as the instruction.\n${cases}`.slice(0, 4000);
        this.resolution.update(latest, { currentRunId: null, integrationTurn: null, review: latest.resolution.review,
          pendingWorkerInstruction: instruction, pendingRevisionCause: 'review' },
          { phase: 'changes_requested', reason: `Settled proof ${run.id} failed ${binding.selector} at ${run.head}; the retained worker must address the recorded failures` },
          'proof_failure_returned_to_worker', run.id);
      } else {
        const proofReview = status === 'passed' && latest.resolution.review?.sourceApproved
          && latest.resolution.review.head === run.head
          && latest.resolution.review.awaitingProofs?.some(item => awaitingProofMatchesSelector(item, binding.selector, declaredProofSelectors(latest)));
        this.resolution.update(latest, { currentRunId: null, integrationTurn: null },
          { phase: proofReview ? 'awaiting_review' : binding.returnPhase,
            reason: proofReview ? `Settled proof ${run.id} passed ${binding.selector} at ${run.head}; evidence-only review is next` : reason },
          'proof_execution_settled');
      }
    }
  }
  /** A revision or reviewer result makes its own build output a settlement candidate. */
  completeBuildOutput(run: Run, task: Task) {
    // Queue #342: a revision or reviewer result makes its own build output a settlement candidate. The
    // directory is the task checkout when the run shares the task workspace.
    const queueOwnedWorkspace = task.reviewEntry?.preserveWorkspace !== true;
    const outputDirectory = run.workspaceId === task.workspaceId && queueOwnedWorkspace ? task.directory : null;
    if ((run.role === 'revision' || run.role === 'reviewer') && outputDirectory) {
      const current = this.store.task(task.id);
      this.store.update(task.id, { resolution: { ...current.resolution, buildOutputCleanups: runBuildOutputIntent(current.resolution.buildOutputCleanups, { id: run.id, workspaceId: run.workspaceId, agentId: run.agentId }, outputDirectory, now()) } }, 'run_build_output_intent', run.id);
    }
  }
  /** Bind stalled-turn completion, recovery action, attention and superseded-worker incidents. */
  completeBookkeeping(run: Run, task: Task, input: Completion) {
    if (task.resolution.stalledTurnStop?.runId === run.id) {
      this.resolution.update(task, { stalledTurnStop: { ...task.resolution.stalledTurnStop, status: 'completed',
        detail: 'Authenticated completion received; stop reconciliation will retain the result' } }, {}, 'stalled_turn_completion_received', input.eventId);
    }
    if (run.role === 'recovery' && task.resolution.recovery?.runId === run.id &&
      (input.status === 'recovered' || input.status === 'escalate' || input.status === 'blocked' || input.status === 'error')) {
      this.resolution.update(task, { recovery: { ...task.resolution.recovery, action: {
        eventId: input.eventId, runId: run.id, reportStatus: input.status,
        coordinatorAction: input.coordinatorAction ?? null,
        summary: input.summary, status: 'pending',
      }, incidentId: task.resolution.recovery.incidentId
        ?? (task.resolution.incident?.status === 'resolved' ? null : task.resolution.incident?.id ?? null) } }, {}, 'recovery_action_bound', input.eventId);
    }
    const incident = task.resolution.incident;
    // A late authenticated result reconciles the incident for its run; escalated incidents keep their coordinator.
    const lateResult = incident?.runId === run.id && incident.status !== 'escalated';
    if(run.role!=='recovery' && (!task.resolution.attention || task.reason===`The ${run.role} thread stopped without a callback; inspect the thread` || lateResult)) {
      // An unknown delivery occurrence outlives the result: the reason keeps
      // naming it so the wait has a visible cause and exit, not a generic one.
      const unknownDelivery = run.role === 'reviewer'
        ? (run.reviewDeliveries ?? []).findLast(item => item.status === 'reserved' || item.status === 'uncertain') ?? null : null;
      const releasePendingReason = !run.released && task.reason === `${run.role} thread running`
        ? `${run.role} result received; waiting for thread release` : undefined;
      const blockedCauseReason = ['blocked', 'error'].includes(input.status) ? input.summary : undefined;
      const currentForRelease = this.store.task(task.id);
      this.resolution.update(currentForRelease, { attention: false, stop: currentForRelease.resolution.stop?.reason === 'escalated' ? currentForRelease.resolution.stop : null,
        ...(lateResult ? { incident: { ...incident!, status: 'resolved' as const, detail: 'Late authenticated result received', updatedAt: now() } } : {}) },
        blockedCauseReason ? { reason: blockedCauseReason }
          : unknownDelivery ? { reason: reviewDeliveryReason(unknownDelivery.deliveryId, unknownDelivery.status === 'reserved' ? 'reserved' : 'uncertain') }
          : releasePendingReason ? { reason: releasePendingReason } : {});
    }
    // A resumed or revision run of the same retained worker that delivers an
    // accepted result supersedes the initial run's missing result: the
    // initial result can never arrive, so its reminder incident reconciles
    // here instead of expiring into coordinator attention later.
    if (run.role === 'revision' && run.agentId === task.agentId && task.runId && task.runId !== run.id &&
      supersededWorkerResult(task, this.store.runs(task.id))) {
      this.resolution.resolveIncident(task, task.runId, 'Superseded by the accepted revision result from the retained worker');
    }
  }
  /** Write the completion event and receipt, then schedule unknown-delivery reconciliation after this commit. */
  completeReceipt(run: Run, task: Task, input: Completion, correctingBlock: boolean, response: { accepted: true; eventId: string }) {
    this.store.event(task.id, correctingBlock?'run_completion_corrected':'run_completion', `${run.role}: ${input.summary}`);
    this.store.setCompletionReceipt(input.eventId, task.id, run.id, digest(JSON.stringify(input)), JSON.stringify(response));
    // Every unknown occurrence gets its own exact-evidence test after this
    // commit: the reviewer's timeline message, or a later authenticated
    // checkpoint. A callback can never bind one by itself.
    for (const item of run.reviewDeliveries ?? [])
      if (item.status === 'reserved' || item.status === 'uncertain')
        queueMicrotask(() => { void this.resolution.reconcileReviewDelivery(this.store.run(run.id) ?? run, item).catch(() => undefined); });
  }
  /**
   * Queue #691: a completion on a done or cancelled task is evidence, never
   * authority. The report is recorded on its run, the run's lease releases with
   * its history, and one evidence event names it. No phase, blocker ladder,
   * escalation, incident, recovery or owner verb follows from it. A retained
   * coordinator still running gets nothing further; terminal cleanup archives it.
   */
  recordFinishedTaskCompletion(task: Task, run: Run, input: Completion, token: string) {
    return this.store.transaction(() => {
      const duplicate = this.store.receipt(input, token);
      if (duplicate) return duplicate;
      const response = { accepted: true as const, eventId: input.eventId };
      if (!run.released && !run.completion) this.store.putRun({ ...run, completion: input });
      releaseRunFromRecordedCompletion(this.store, task.id, this.store.run(run.id)!);
      this.store.event(task.id, 'late_callback_evidence', `${run.role} ${input.status}: ${input.summary.slice(0, 2000)} (received after ${task.phase}; no authority)`);
      this.store.setCompletionReceipt(input.eventId, task.id, run.id, digest(JSON.stringify(input)), JSON.stringify(response));
      return response;
    });
  }
  /**
   * Task 560: record a superseded executor run's late report as historical
   * evidence. The run actually executed, so its result belongs in history:
   * its own `proofExecutions` record carries the reported status, exit code
   * and evidence instead of staying `running` with no completion. It spends
   * no allowance (the first record already spent it), is never a pass, and
   * changes nothing else: no phase, current run, review, verdict or merge
   * moves. The run row itself keeps no completion, so no proof gate can read
   * this history as a passing claim, and the record carries `historical: true`
   * so closeout can never credit it — a ready_to_merge verdict resting on
   * historical evidence alone closes the qualification failed.
   *
   * History settles once from reports: a record already settled from a report
   * refuses later ones as stale. A record settled from timeline-only evidence
   * (`unknown`) is upgraded by a report — the reported result is strictly
   * better evidence than "it ran".
   */
  recordSupersededProofEvidence(task: Task, run: Run, input: Completion, startEvidence?: string) {
    if (run.taskId !== task.id) throw new Error('Stale run');
    if (!['proof_executed', 'blocked', 'error'].includes(input.status)) throw new Error('Result is not valid for this run role');
    const binding = run.proofExecution;
    if (!binding) throw new Error('Executor run is missing its bound proof subject');
    const existing = proofExecutions(task).find(item => item.runId === run.id) ?? null;
    if (existing && existing.status !== 'running' && !(existing.historical && existing.status === 'unknown'))
      throw new Error(`Stale reporting run ${run.id}: its execution record already settled (${existing.status}) and settled history is never rewritten`);
    if (input.status === 'proof_executed') {
      if (!input.proofResult) throw new Error('A proof execution result must carry proofResult for its declared selector');
      if (input.proofResult.selector !== binding.selector) throw new Error("Proof execution result must name the run's declared selector");
      if (input.head && input.head !== run.head) throw new Error('Result must name the requested exact head');
    }
    const status = input.status === 'proof_executed' ? (input.proofResult?.status === 'passed' ? 'passed' : 'failed') : 'unknown';
    const base = existing ?? proofExecutionRecord({ ...run, agentId: run.agentId, completion: input }, task, binding.authorizedBy, binding.operationId);
    const reported = [input.summary, input.proofResult?.evidence].filter(Boolean).join('\n');
    const evidence = [reported, existing?.historical ? existing.evidence : ''].filter(Boolean).join('\n').slice(0, 4000);
    const upgraded = Boolean(existing?.historical && existing.status === 'unknown');
    recordProofExecution(this.store, task.id, { ...base, status, exitCode: input.proofResult?.exitCode ?? null, evidence, historical: true,
      selectorStart: startEvidence || input.proofResult ? 'started' : base.selectorStart ?? 'unknown',
      ...(startEvidence ? { selectorStartEvidence: startEvidence } : {}) },
      `${run.id}: ${status} for ${binding.selector} at ${run.head} (superseded-run historical evidence${upgraded ? ', upgraded from timeline-only settlement' : ''}; no allowance spent and never a pass)`);
    const response = { accepted: true as const, eventId: input.eventId };
    this.store.event(task.id, 'proof_execution_historical', `${run.id}: ${status} for ${binding.selector} at ${run.head}; a superseded run's late report spends no allowance and is never a pass`);
    this.store.setCompletionReceipt(input.eventId, task.id, run.id, digest(JSON.stringify(input)), JSON.stringify(response));
    return response;
  }
}
