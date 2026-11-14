import type { Completion, Run, Task } from '../../shared/contracts';
import { isDispositionActive, isDispositionComplete } from '../../shared/contracts';
import { reviewPublicationBody } from '../forge/index';
import { recordLateCallbackEvidence } from '../verbs/disposition';
import { proofExecutions, proofExecutionRecord, proofWaitApplies, recordProofExecution } from '../qa/proof-execution';
import { releaseRunFromRecordedCompletion } from '../recovery/fence-settlement';
import type { Resolution } from '../resolution';
import { assertReviewRunSource } from '../review/ordinary-review';
import { assertReviewResponsibility } from '../review/review-verdicts';
import { digest, now } from '../store/store';
import { recordSupersededRunRefusal, supersededResumeRefusal } from '../recovery/superseded-resume';
import { coordinative } from '../recovery/task-reasons';
import { consecutiveNonDeliveries, nonDeliveryEvents, nonDeliveryFor, unfinishedContinuationEvents, unfinishedReturnFor } from '../recovery/non-delivery';
import { supersededWorkerResult } from '../recovery/incident';
import { runBuildOutputIntent } from '../hooks/build-output-records';
import { reviewDeliveryReason } from '../review/review-continuation';
import { completionRefusal, sourceApprovalRefusal } from './report-shape';
import { reportReadyRefusal, settleReportReady } from './report-ready';
import { proofResultRefusal, settleProofExecution, type ProofOutcome } from './proof-settlement';
import { threadReleasePendingReason, threadRunningReason } from './thread-waits';

/**
 * Authenticate, validate and record one run report — the resolution side of a
 * callback. Worker intake (`CallbackIntake`) joins Engine's source gates with the
 * checkpoint receipts; this owner applies a run's released result. `store` and
 * `adapter` read the resolution per call: tests replace the adapter.
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
      const refusal = reportReadyRefusal(this.store, task, input);
      if (refusal) throw new Error(refusal);
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
    const sourceRefusal = sourceApprovalRefusal(input, run);
    if (sourceRefusal) throw Error(sourceRefusal);
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
      settleReportReady(this.resolution, task, run, input);
    }
    if (nonDelivery && !nonDeliveryEvents(previousEvents).some(item => item.runId === run.id))
      this.store.event(task.id, 'non_delivery', JSON.stringify({ ...nonDelivery, attempt: consecutiveNonDeliveries(previousEvents).length + 1 }));
    else if (!nonDelivery && ['worker', 'revision'].includes(run.role) && consecutiveNonDeliveries(previousEvents).length > 0)
      this.store.event(task.id, 'non_delivery_reset', `${run.id}: ${input.status}`);
    if (unfinished && !unfinishedContinuationEvents(previousEvents).some(item => item.runId === run.id))
      this.store.event(task.id, 'unfinished_continuation', JSON.stringify(unfinished));
    return response;
  }
  /**
   * Record one proof execution's evidence and terminal exit in the same transaction
   * as its receipt. The settlement rule is `proof-settlement`'s; this method only
   * reads the acceptance-side outcome off the report.
   */
  completeProof(run: Run, task: Task, input: Completion, startEvidence?: string) {
    if (run.role !== 'executor' || !run.proofExecution) return;
    const outcome: ProofOutcome = input.status === 'proof_executed' ? (input.proofResult?.status === 'passed' ? 'passed' : 'failed') : 'unknown';
    settleProofExecution(this.resolution, { task, run, completion: input, outcome,
      evidence: [input.summary, input.proofResult?.evidence].filter(Boolean).join('\n').slice(0, 4000),
      selectorStart: startEvidence ? 'started' : 'unknown', ...(startEvidence ? { selectorStartEvidence: startEvidence } : {}) });
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
    // A late authenticated result reconciles the incident for its run. A stopped
    // thread's missing-callback episode is that same typed incident: the reason text
    // it also wrote is presentation and is never read back here.
    const lateResult = incident?.runId === run.id && incident.status !== 'escalated';
    if(run.role!=='recovery' && (!task.resolution.attention || lateResult)) {
      // An unknown delivery occurrence outlives the result: the reason keeps
      // naming it so the wait has a visible cause and exit, not a generic one.
      const unknownDelivery = run.role === 'reviewer'
        ? (run.reviewDeliveries ?? []).findLast(item => item.status === 'reserved' || item.status === 'uncertain') ?? null : null;
      const releasePendingReason = !run.released && task.reason === threadRunningReason(run.role)
        ? threadReleasePendingReason(run.role) : undefined;
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
    const refusal = proofResultRefusal(input, run);
    if (refusal) throw new Error(refusal);
    const binding = run.proofExecution;
    if (!binding) throw new Error('Executor run is missing its bound proof subject');
    const existing = proofExecutions(task).find(item => item.runId === run.id) ?? null;
    if (existing && existing.status !== 'running' && !(existing.historical && existing.status === 'unknown'))
      throw new Error(`Stale reporting run ${run.id}: its execution record already settled (${existing.status}) and settled history is never rewritten`);
    if (input.status === 'proof_executed' && input.head && input.head !== run.head) throw new Error('Result must name the requested exact head');
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
