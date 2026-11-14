import { RETAINED_PREREQUISITE_REFUSAL, restartTerminalRefusal } from './verb-refusal-text';
import { DISPOSITION_CONTROL_REFUSAL, REMOVED_TASK_REFUSAL, parkedRestartRefusal } from './control-refusals';
import { restartResumeChoice } from '../task-decision-rules';
import { COORDINATOR_LOOP_LIMIT, unproductiveCoordinatorRuns } from '../recovery/recovery-bound';
import { unreportedExecutorRun } from '../qa/proof-execution';
import type { Run, Task, TaskControlInput } from "../../shared/contracts";
import { DEFAULT_GLOBAL_LIMIT, OPERATOR_BOARD_CALLER, WORKER_REPLACEMENT_CEILING, isDispositionActive } from "../../shared/contracts";
import { groupIsUnavailable } from "../../shared/pool";
import { dispatchBlocked, occupiesSlot, recoveryCapacityFor } from "../dispatch/capacity";
import { taskHasPr, taskPrNumber } from "../forge/index";
import { runsUnchangedSince } from "../recovery/observation-advance";
import type { RestartRole } from "./owner-verbs";
import { RestartRefusal, collectOwnerVerbFacts, currentRouteProfile, deriveRestartRole, parkedRestart, plainHandoverFreshRestart, restartShape, restartTakesParkedStep, unservedParkedStep, workerRestartRefusal } from "./owner-verbs";
import type { AgentObservation } from "../host/adapter";
import { hostFailureRefusalDetail } from "../host/errors";
import { coordinatorReportMatches } from "../recovery/recovery";
import { isBlockingRecoveryEffect, recoveryEffects, recoveryEffectsRefusal } from "../recovery/recovery-effects";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { digest, now } from "../store/store";
import { OPERATOR_WORKER_REMAP_REASON } from "../recovery/task-reasons";
import { decideWorkerReplacement, isWorkerRouteApproved, retainedWorkerFailureCause } from "../recovery/worker-replacement";
import type { Engine } from "../engine";

/** Raised after read-only verification or the parked transaction has refused. */
class ParkedRestartPreSendRefusal extends Error {
  constructor(message: string, readonly taskEvidenceHash: string, readonly runEvidenceHash: string) { super(message); }
}
export { ParkedRestartPreSendRefusal };

/**
 * The owner's `restart` verb: the run shapes it continues or replaces, the parked
 * step and escalation answer it falls back to, the stalled-turn stop and
 * absent-run recovery it drives. Same-name `Engine` methods delegate here.
 * `store`, `adapter` and `resolution` read the engine per call: tests replace the
 * adapter.
 */
export class RestartControls {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  /** Re-run a parked step for restart's parked fallback; runs inside the caller's transaction. */
  restartParkedStep(task: Task, instruction: string | undefined, reviewerInstruction: string | undefined): Task {
    if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt) throw Error(RETAINED_PREREQUISITE_REFUSAL);
    const resumable = task.prerequisiteWait?.releasedAt
      ? this.store.update(task.id, { prerequisiteWait: null }, "prerequisite_wait_resumed", "Operator explicitly resumed the task after the prerequisite notice")
      : task;
    // A never-dispatched task parked in attention by a dispatch refusal returns
    // to queued through the ordinary operator-return episode closure, so an
    // escalated recovery, its incident, the attention flag and any pending
    // attention notices are settled before dispatch validation re-runs.
    if (resumable.phase === "needs_attention" && this.engine.neverDispatched(resumable)) {
      this.engine.rejectFenced(resumable, "pre-dispatch retry");
      return this.resolution.returnToDispatch(resumable, false, "Pre-dispatch retry requested; validating current state", "pre_dispatch_retry_requested");
    }
    // Closeout resynchronization finishes merged work without admitting a worker.
    // Finishing already-merged work must remain possible at full capacity.
    // The ruling applies whatever the project's occupancy: an operator decision is not a
    // resource request, and refusing it left the lane blocked with the decision made and
    // nothing to show for it. The revision dispatch waits for a slot instead - see the
    // changes_requested branch in the resolution.
    // The instruction is a retained-worker remap override; retry() refuses it
    // anywhere else.
    const reportingRun = this.engine.coordinatorActionRunId.getStore();
    return this.resolution.prepareRetry(resumable, false, instruction, true, false, false, undefined, reviewerInstruction, reportingRun ? [reportingRun] : [])();
  }

  /** Handler-owned admission for restart displacement. */
  async prepareWorkerResume(input:{taskId:string;version:number;instruction:string;settleFences?:{detail:string;runIds:string[];displacedRunIds?:string[]}}):Promise<() => Task>{
    const task=this.store.task(input.taskId), runs=this.store.runs(task.id);
    const check=()=>{
      const current=this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(current,input.version,'Task changed during absent-worker verification');
      if(!runsUnchangedSince(runs,this.store.runs(task.id)))throw Error('Task changed during absent-worker verification');
      this.engine.rejectFenced(current, 'worker recovery');
      return current;
    };
    check();
    const settling=input.settleFences?[...input.settleFences.runIds,...(input.settleFences.displacedRunIds??[])]:[];
    const absent=task.agentIntent&&!task.agentId;
    if(absent){
      this.resolution.admitAbsentWorker(task,input.instruction,true,settling);
      const found=await this.adapter.findAgents(task);
      if(found.length)throw Error('Worker creation is no longer proven absent; inspect the matching agent before retrying');
      await this.adapter.verifyWorkspace(task,task.directory!);
      check();
      this.resolution.admitAbsentWorker(this.store.task(task.id),input.instruction,true,settling);
    }else this.resolution.prepareResumeWorker(task,input.instruction,true,settling);
    return ()=>{
      const current=check();
      // Actual guards re-run at the boundary, accounting only for the settlement
      // this transaction owns. No observation is retained for deferred replay.
      if(absent)this.resolution.admitAbsentWorker(current,input.instruction,true,settling);
      else this.resolution.prepareResumeWorker(current,input.instruction,true,settling);
      if(absent)this.adapter.purgeReportingFiles?.(task.id,[task.runId!]);
      return this.store.transaction(()=>{
        if(input.settleFences)this.engine.settleVerbFences(task.id,input.settleFences);
        return absent?this.resolution.resumeAbsentWorker(this.store.task(task.id),input.instruction,true)
          :this.resolution.resumeWorker(this.store.task(task.id),input.instruction,true);
      });
    };
  }

  /**
   * Round 4 (Tom, 2026-10-19): `restart` where no run of the role needs one
   * (`parkedRestart` decides, as `next` does). It re-runs a parked step, or
   * answers an escalation with the restart's reason, which stays the owner's:
   * a coordinator's restart never answers one.
   */
  async restartParked(input: TaskControlInput, task: Task, role: RestartRole, reason: string, operationId?: string): Promise<Task> {
    const parked = parkedRestart(collectOwnerVerbFacts(this.store, task, operationId, this.engine.coordinatorActionRunId.getStore()));
    // A parked refusal is decided from store reads before any binding or send, so
    // it is a definite pre-send refusal: the durable operation settles as refused
    // instead of leaving an unresolved effect that fences the next owner verb.
    if ("refusal" in parked)
      throw new RestartRefusal(parkedRestartRefusal(role, parked.refusal));
    if (parked.kind === "answer") {
      if (!this.engine.isOwnerCall()) throw Error("Answering an escalation is the owner's decision; a coordinator's restart cannot answer it");
      this.engine.rejectFenced(task, "escalation answer");
      return this.resolution.resolveEscalation(task, reason, true);
    }
    if (operationId) {
      const operation = this.store.operation(operationId);
      if (!operation || operation.state !== 'running' || operation.taskId !== task.id || operation.kind !== 'task_control')
        throw Error('The task-control operation changed before its parked boundary');
      this.store.putOperation({ ...operation, preSendBoundaryStartedAt: now() });
    }
    // A reviewer instruction routes a blocked, reviewed task back to review;
    // GitHub's PR head must still be the head that instruction is about.
    const reviewerInstruction = role === "reviewer" ? input.instruction : undefined;
    // The commit runs in the same continuation as the head proof, with no yield
    // between the proof's version recheck and the transaction.
    const commit = () => this.store.transaction(() => {
      const current = this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(current, input.version, "Task changed; refresh before restarting");
      const restarted = this.engine.restartParkedStep(current, role === "reviewer" ? undefined : input.instruction, reviewerInstruction);
      if (role === 'reviewer' && input.fresh === true && restarted.phase === 'awaiting_review')
        return this.store.update(restarted.id, { resolution: { ...restarted.resolution, reviewerAgentId: null, reviewerProfile: null } }, 'restart_review_fresh', reason);
      return restarted;
    });
    try {
      return await ((reviewerInstruction ? this.engine.reviewerInstructionHeadProof(task, input.version, commit) : null) ?? commit());
    } catch (error) {
      // Verification is read-only and all local writes are rolled back; neither
      // route can authorize or send a continuation before it returns.
      throw new ParkedRestartPreSendRefusal(error instanceof Error ? error.message : String(error),
        digest(JSON.stringify(this.store.task(task.id))), digest(JSON.stringify(this.store.runs(task.id))));
    }
  }

  /** The GitHub PR-head proof a reviewer instruction needs, then `commit`; null when no proof applies (no await, no yield). */
  reviewerInstructionHeadProof(task: Task, version: number, commit: () => Task): Promise<Task> | null {
    const peek = this.store.task(task.id);
    if (peek.removedAt || peek.version !== version || !['blocked', 'error'].includes(peek.phase)) return null;
    const review = this.resolution.acceptedReviewAtUnchangedHead(peek);
    const advanced = review?.head ? null : this.resolution.retainedWorkerAdvancedReviewHead(peek);
    const executor = this.store.runs(peek.id).at(-1);
    const proof = executor?.role === 'executor' && peek.resolution.reviewerAgentId
      ? (peek.proofExecutions ?? []).find(item => item.runId === executor.id && item.head === executor.head && item.settledAt)
      : undefined;
    if (!review?.head && !advanced && !proof) return null;
    return (async () => {
      const expected = proof?.head ?? review?.head ?? advanced?.head;
      const pr = await this.adapter.verifyPr(peek, taskPrNumber(peek));
      if (pr.head !== expected) {
        const source = proof ? 'settled proof' : review?.head ? 'accepted review' : "retained worker's latest pushed head";
        throw new Error(`The current PR head ${pr.head} differs from the ${source} head ${expected}; a reviewer instruction requires that head to be unchanged`);
      }
      this.engine.requireOwnerControlCurrent(this.store.task(peek.id), version, 'Task changed during PR head verification; refresh before retrying');
      return commit();
    })();
  }

  /** Admission is complete before remote displacement; apply rechecks fresh bindings/effects. */
  async executeEpisodeRestart(taskId: string, displacement: { runIds: string[]; cancel: () => Promise<void> },
    admit: () => Promise<Task | (() => Task | Promise<Task>)>, runIds: string[] = []): Promise<Task> {
    const before = this.store.task(taskId), runs = this.store.runs(taskId);
    const apply = await admit();
    if (typeof apply !== 'function') return apply; // deferred work re-enters admission later
    const recheck = () => {
      const task = this.store.task(taskId);
      for (const id of [...runIds, ...displacement.runIds]) {
        const run = this.store.run(id);
        const why = run && !run.released ? this.engine.runDurableFence(task, run) : null;
        if (why) throw new DurableFenceRefusal(this.engine.displaceRefusal({ run: run!, why }));
      }
      this.engine.assertUnchangedBeforeCancel(taskId, before.version, runs);
      if (this.engine.coordinatorActionRunId.getStore() && !coordinatorReportMatches(task))
        throw Error('The task moved on since the coordinator was asked');
    };
    recheck();
    await displacement.cancel();
    recheck();
    return apply();
  }

  /**
   * What `restart role=worker` adds to the move-to-work transition: both steps run
   * inside `moveToWork`'s transaction, one before it binds the PR and revises, one
   * after. `move` passes neither, because its schema refuses `fresh`.
   */
  workerRestartArm(task: Task, input: { reason: string; instruction?: string; caller?: string; relayed?: boolean; note?: string;
    fresh?: boolean; observedWorker?: AgentObservation; supersedeNonDelivery?: boolean }): { afterSettlement: (settled: Task) => Task; afterRevision: (revised: Task) => Task } {
    const instruction=input.instruction?.trim()
      ||'Continue the existing task under its current approved instruction source and within its approved scope.';
    return {
      afterSettlement: (settledTask) => {
        if(input.supersedeNonDelivery&&settledTask.resolution.nonDeliveryRoutePending){
          this.resolution.update(settledTask,{nonDeliveryRoutePending:false,pendingRevisionCause:null},{},'non_delivery_replacement_superseded',`Owner restart worker: ${input.reason}`);
          settledTask=this.store.task(task.id);
        }
        return settledTask;
      },
      afterRevision: (revised) => {
        // A fresh worker restart (explicit role worker) takes the revision on the
        // worker route through the existing replacement fields, set inside the
        // same accepted transition, so a refusal above leaves them untouched.
        const observedFailure = input.observedWorker ? retainedWorkerFailureCause({ task: revised,
          observedStatus: input.observedWorker.status, observedError: input.observedWorker.error,
          observedActive: input.observedWorker.active || Boolean(input.observedWorker.activeTurnId),
          observedPermissions: input.observedWorker.permissions, observedWorkspaceId: input.observedWorker.workspaceId }) : null;
        if(!input.fresh && observedFailure?.kind !== "agent_errored")return revised;
        // Spec 058 task 577: one worker thread. A fresh restart replaces only
        // on failure, on an approved route to a different model, or with an
        // explicit operator-relayed reason; otherwise the retained worker
        // continues the revision and the refusal names its rule.
        const moveRoute = currentRouteProfile(revised,'worker')??revised.profile!.id;
        const moveGroup = revised.profileGroup ?? this.store.pool().find(entry => entry.profileId === revised.profile?.id)?.group ?? null;
        const moveAvailabilityRow = moveGroup
          ? this.store.db.prepare("SELECT data FROM availability WHERE group_id=?").get(moveGroup)
          : null;
        const moveAvailability = moveAvailabilityRow ? JSON.parse(String((moveAvailabilityRow as { data: string }).data)) : null;
        const moveDecision = decideWorkerReplacement({
          task: revised,
          requestedProfileId: moveRoute,
          requestedModel: this.engine.profiles.find(candidate => candidate.id === moveRoute)?.model ?? revised.profile?.model ?? null,
          currentModel: revised.profile?.model ?? null,
          approved: isWorkerRouteApproved(revised, moveRoute, this.store.pool(), this.store.usageLevel()),
          failure: retainedWorkerFailureCause({
            task: revised,
            observedStatus: input.observedWorker?.status,
            observedError: input.observedWorker?.error,
            observedActive: input.observedWorker ? input.observedWorker.active || Boolean(input.observedWorker.activeTurnId) : undefined,
            observedPermissions: input.observedWorker?.permissions,
            observedWorkspaceId: input.observedWorker?.workspaceId,
            groupUnavailable: moveAvailability && groupIsUnavailable(moveAvailability)
              ? { group: moveGroup!, reason: String(moveAvailability.reason ?? "") } : null,
          }),
          // The explicit operator relay is the reason this fresh
          // replacement can proceed without a failure or model change.
          explicitOperatorRelay: input.caller === OPERATOR_BOARD_CALLER || (input.relayed === true && Boolean(input.note?.trim())),
          freshRestart: true,
        });
        if(!moveDecision.allowed){
          this.store.event(task.id, "worker_replacement_refused", `${moveDecision.rule}: ${moveDecision.detail}`);
          return revised;
        }
        const moveCallerRelay = input.caller === OPERATOR_BOARD_CALLER || (input.relayed === true && Boolean(input.note?.trim()));
        return this.store.update(revised.id,{
          failoverReason:`${OPERATOR_WORKER_REMAP_REASON}. Continue the existing task: ${instruction}`.slice(0,2000),
          replacementProfile:observedFailure?.kind === "agent_errored" ? null : {profileId:moveRoute,reason:input.reason.slice(0,4000),
            // Spec 058 task 577: the explicit operator relay travels with the arm.
            ...(moveCallerRelay ? { operatorRelayed: true as const } : {})},
        },'restart_worker_requested');
      },
    };
  }

  /**
   * nucleus#1195: one bounded re-report request to the live proof executor whose
   * result never arrived. The same run, agent and credential stay: nothing is
   * relaunched, the selector is never re-run and the one allowance stays spent.
   * The send is recorded once as a durable intent before the delivery and its
   * outcome after it, so a repeat never asks and an unknown delivery refuses.
   */
  private async resendExecutorReport(input: TaskControlInput, task: Task, reason: string): Promise<Task> {
    if (input.fresh === true) throw new RestartRefusal("A proof executor's re-report request continues the same run; fresh is unsupported because it would spend another execution");
    const run = unreportedExecutorRun(this.store.runs(task.id));
    if (!run) throw new RestartRefusal("No unreleased proof executor is waiting on a report; nothing was asked");
    if (!this.adapter.notify) throw new RestartRefusal("This host cannot deliver the re-report request; use tell role=executor from a host with a message channel");
    const events = this.store.eventsAll(task.id);
    if (events.some(event => event.kind === "executor_report_request_sent" && event.detail.startsWith(`${run.id}:`)))
      throw new RestartRefusal(`The re-report request for proof executor run ${run.id} was already sent; its result is still outstanding. Inspect the executor's thread, or use tell role=executor`);
    if (events.some(event => event.kind === "executor_report_request_intent" && event.detail.startsWith(`${run.id}:`)))
      throw new RestartRefusal(`The re-report request for proof executor run ${run.id} has an unknown delivery; inspect the executor's thread before deciding anything else`);
    let observed: AgentObservation;
    try { observed = await this.engine.onTaskHost(task, () => this.engine.host.observe(run.agentId!)); }
    catch (error) { throw new RestartRefusal(`The proof executor cannot be observed (${hostFailureRefusalDetail(error)}); no re-report was asked`); }
    this.engine.requireOwnerControlCurrent(this.store.task(task.id), input.version, "Task changed during restart verification; read next again before restarting");
    const latest = unreportedExecutorRun(this.store.runs(task.id));
    if (!latest || latest.id !== run.id) throw new RestartRefusal("The proof executor changed during verification; read next again before restarting");
    if (observed.id !== run.agentId || observed.workspaceId !== run.workspaceId)
      throw new RestartRefusal("The observed executor agent or workspace differs from the recorded run; no re-report was asked");
    if (observed.status === "closed")
      throw new RestartRefusal("The proof executor's thread is closed, so it cannot resend a report; inspect its evidence and decide the next owner action");
    if (observed.active || observed.activeTurnId || observed.permissions || !["idle", "error"].includes(observed.status))
      throw new RestartRefusal("The proof executor is not positively idle; its own turn owns the report until it ends");
    const messageId = `ns-executor-report-${run.id}`;
    const request = `Nucleus re-requests your report for proof executor run ${run.id} (task ${task.reference ?? task.id}). Your last turn ended without a recorded result, and the task's one proof allowance stays spent. Do not run the selector again and do not change source. Resend the authenticated report for this same run with its existing credential and the evidence you already produced: proof_executed with proofResult {selector, status, exitCode, evidence}, and the same proofFiles when you copied them. If you never produced a result, report blocked or error with the concrete condition. This is one bounded re-report request. Reason: ${reason}`.slice(0, 4000);
    const text = `${request}${this.adapter.reportingFallback ? ` ${this.adapter.reportingFallback(run)}` : ""}`.slice(0, 6000);
    this.store.event(task.id, "executor_report_request_intent", `${run.id}: ${JSON.stringify({ runId: run.id, agentId: run.agentId, messageId })}`);
    try {
      await this.engine.onTaskHost(task, () => this.adapter.notify!(run.agentId!, messageId, text));
    } catch (error) {
      throw new RestartRefusal(`The re-report request to proof executor run ${run.id} could not be delivered (${error instanceof Error ? error.message : String(error)}); its delivery is unknown, so nothing was retried`);
    }
    this.store.event(task.id, "executor_report_request_sent", `${run.id}: ${JSON.stringify({ runId: run.id, agentId: run.agentId, messageId })}`);
    this.resolution.waiting(this.store.task(task.id),
      `The proof executor ${run.id} was asked to resend its report; the selector is not re-run and no new run starts`, "lifecycle");
    return this.store.task(task.id);
  }

  /**
   * Spec 050 `restart`: get a stopped, stalled or checkpointed run going again.
   * The role is derived from the phase when omitted. Queue settles the fences
   * the restart supersedes, releases or stops the old run and starts the next
   * one through the existing internals: a continuation on the same agent by
   * default, or a fresh agent on the role's current route when `fresh` is set.
   * Every identity is derived here; the caller supplies only a reason and,
   * optionally, an instruction.
   */
  async restartTask(input: TaskControlInput, operationId?: string): Promise<Task> {
    const reason = (input.reason ?? "").trim();
    if (!reason) throw Error("restart requires a reason");
    const fresh = input.fresh === true;
    let task = this.store.task(input.taskId);
    if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(task, input.version, "Task changed; refresh before restarting");
    if (isDispositionActive(task)) throw Error(DISPOSITION_CONTROL_REFUSAL);
    // Round 4: a restart applies while paused; what it would start waits (deferOwnerVerb).
    const role = (input.role as RestartRole | undefined) ?? deriveRestartRole(task, this.store.runs(task.id));
    if (["done", "cancelled"].includes(task.phase) || task.resolution.mergedCommit) {
      // A finished task restarts nothing, but an escalation left on it is still the owner's to answer.
      // A finished or merged task restarts no run; a merged one still re-runs its
      // parked step (a closeout resynchronization), and either answers an escalation.
      const parked = parkedRestart(collectOwnerVerbFacts(this.store, task, operationId, this.engine.coordinatorActionRunId.getStore()));
      if ("kind" in parked && (parked.kind === "answer" || task.resolution.mergedCommit && !["done", "cancelled"].includes(task.phase)))
        return this.engine.restartParked(input, task, role, reason, operationId);
      throw Error(restartTerminalRefusal(task, "refusal" in parked ? parked.refusal : undefined));
    }
    const shape = restartShape(task, this.store.runs(task.id), role, this.store.eventsAll(task.id));
    // nucleus#1195: the proof executor's one continuation is a re-report request,
    // never a relaunch, a fresh agent or a selector re-run.
    if (shape === "unreported_executor") return await this.resendExecutorReport(input, task, reason);
    // A worker continuation whose recorded workspace is gone re-creates the
    // worktree from the branch on origin through the move-to-work transition, so
    // the task, PR and approval stay and the role starts on a fresh thread
    // (nucleus#974). A parked step that never needed the worker keeps its shape.
    const workerShape = shape !== null && ["blocked_worker", "retained_worker", "blocked_with_pr", "stopped_revision", "owner_stopped_worker"].includes(shape);
    if (role === "worker" && workerShape && task.workspaceId && this.adapter.workspaceAvailable
      && !await this.adapter.workspaceAvailable(task.workspaceId)) {
      if (!this.adapter.recoverTaskWorkspace)
        throw new RestartRefusal("The recorded task workspace is gone and this host cannot re-create a worktree; restore the workspace before restarting");
      return this.engine.moveToWork({ taskId: task.id, version: task.version, reason, instruction: input.instruction, caller: input.caller });
    }
    if (restartTakesParkedStep(task, shape, collectOwnerVerbFacts(this.store, task, operationId, this.engine.coordinatorActionRunId.getStore()),
      { explicitRole: input.role !== undefined })) return this.engine.restartParked(input, task, role, reason, operationId);
    // A role shape the task cannot serve has no path of its own; the parked step's
    // refusal is the truthful answer (and is a definite pre-send refusal).
    if (unservedParkedStep(task, shape)) {
      const parked = parkedRestart(collectOwnerVerbFacts(this.store, task, operationId, this.engine.coordinatorActionRunId.getStore()));
      if ("refusal" in parked)
        throw new RestartRefusal(parkedRestartRefusal(role, parked.refusal));
    }
    const targetRunId = shape === "owner_stopped_worker" ? task.runId : role === "reviewer" ? task.resolution.currentRunId
      : shape === "stopped_revision" ? this.store.runs(task.id).findLast(run => run.role === "revision" && !run.released && run.agentId === task.agentId)?.id
      : null;
    if (this.engine.ownerStopHold(task) && targetRunId && this.engine.ownerStopNamesRun(task, targetRunId)) {
      if (shape === "stopped_reviewer") {
        // A held reviewer restart may be deferred, but the hold cannot hide an
        // unrelated durable run fence that would refuse the same restart.
        const finished = await this.engine.collectVerbFinishedRuns(task.id,
          run => run.role === "reviewer" || run.id === this.engine.openEpisodeRunId(task.id));
        if (finished.fenced.length) throw new DurableFenceRefusal(this.engine.verbRunFenceRefusal(finished.fenced[0]!));
        return this.engine.deferOwnerVerb(task, input, "held", { runId: targetRunId });
      }
      if (["owner_stopped_worker", "stopped_revision"].includes(shape ?? ""))
        return this.engine.deferOwnerVerb(task, input, "held", { runId: targetRunId });
    }
    // The ceiling remains the automatic loop breaker. Only a deliberate
    // operator-relayed fresh worker restart can pass it.
    const workerReplacementShape = shape !== null && ["blocked_worker", "retained_worker", "blocked_with_pr", "stopped_revision"].includes(shape);
    const armsReplacement = fresh && role === "worker" && workerReplacementShape;
    const operatorRelayed = input.caller === OPERATOR_BOARD_CALLER || (input.relayed === true && Boolean(input.note?.trim()));
    if (armsReplacement && task.retiredWorkers.length >= WORKER_REPLACEMENT_CEILING && !operatorRelayed) {
      throw new RestartRefusal(this.engine.replacementCeilingRefusal(task));
    }
    // Tom, 2026-10-23 ("Worker continues"): an explicitly named worker restart
    // on a blocked or errored task with a PR continues the retained worker on
    // that PR through the move-to-work transition (author revision on the same
    // workspace, branch and PR). project-a #1655 keeps resume_worker and the pre-PR
    // resume closed to this shape; a restart without a role still resumes into
    // review below. The worker refusals run first with a fresh observation.
    if (shape === "blocked_with_pr" && input.role === "worker") {
      const unobserved = workerRestartRefusal(collectOwnerVerbFacts(this.store, task), shape);
      if (unobserved) throw new RestartRefusal(unobserved);
      let observed: AgentObservation;
      try { observed = await this.engine.onTaskHost(task, () => this.engine.host.observe(task.agentId!)); }
      catch (error) { throw new RestartRefusal(`The retained worker cannot be observed (${hostFailureRefusalDetail(error)}); restore observation before restarting. No continuation was sent`); }
      const latest = this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(latest, task.version, "Task changed during restart verification; read next again before restarting");
      const refusal = workerRestartRefusal(collectOwnerVerbFacts(this.store, latest), shape, observed);
      if (refusal) throw new RestartRefusal(refusal);
      return this.engine.moveToWork({ taskId: task.id, version: task.version, reason, instruction: input.instruction, caller: input.caller,
        restart: this.engine.workerRestartArm(task, { reason, instruction: input.instruction, caller: input.caller,
          relayed: input.relayed, note: input.note, fresh, observedWorker: observed,
          supersedeNonDelivery: !fresh && task.resolution.nonDeliveryRoutePending }) });
    }
    if (shape === "coordinator" && fresh)
      throw Error("Coordinator restart retries the existing resolution; fresh is unsupported here. Use route role=coordinator with now to replace its agent");
    const instruction = input.instruction?.trim()
      || "Continue the existing task under its current approved instruction source and within its approved scope.";

    // A stalled live run is stopped through the existing durable targeted stop.
    // The stall incident is that stop's own evidence, so it is not settled first.
    if (shape === "stalled_run") {
      const runId = task.resolution.incident?.runId ?? task.resolution.currentRunId ?? task.runId;
      if (!runId) throw Error("The stalled run has no recorded identity to stop");
      const stopped = await this.engine.stopStalledTurn({ taskId: task.id, version: task.version, runId });
      const stop = stopped.resolution.stalledTurnStop;
      // The stop is asynchronous: the continuation is recorded with the stop so
      // the reconciliation that observes inactivity releases the run and starts
      // the continuation instead of parking. When inactivity is already
      // confirmed, continue now through the ordinary shapes.
      if (stop && stop.status !== "stopped" && stop.status !== "completed") {
        return this.store.update(stopped.id, {
          resolution: { ...stopped.resolution, stalledTurnStop: { ...stop, restartInstruction: instruction, restartFresh: fresh } },
        }, "stalled_turn_restart_requested", instruction.slice(0, 600));
      }
      if (stop?.status === "stopped") return this.engine.restartTask({ ...input, version: stopped.version }, operationId);
      return stopped;
    }

    // Spec 050 atomic verbs: every restart shape settles the fences it retires
    // inside the transaction that applies its action, so a refused restart
    // changes nothing. A coordinator restart preserves its own recovery episode
    // while settling other finished runs: the retry path needs the episode
    // intact. A stalled live run settles nothing: the stall incident is
    // that stop's own evidence.
    task = this.store.task(task.id);
    let version = task.version;

    switch (shape) {
      case "owner_stopped_worker": {
        if (fresh) throw new RestartRefusal("An owner-stopped initial worker resumes only on its retained thread");
        if (!task.runId || !task.agentId || !task.workspaceId || !this.engine.ownerStopNamesRun(task, task.runId))
          throw new RestartRefusal("The owner stop no longer names the retained initial worker run");
        if (!this.adapter.notify) throw new RestartRefusal("Retained-thread instruction delivery is unavailable");
        let observed: AgentObservation;
        try { observed = await this.engine.onTaskHost(task, () => this.engine.host.observe(task.agentId!)); }
        catch (error) { throw new RestartRefusal(`The retained worker cannot be observed (${hostFailureRefusalDetail(error)}); restore observation before restarting`); }
        if (observed.id !== task.agentId || observed.workspaceId !== task.workspaceId || observed.permissions
          || observed.active || observed.activeTurnId || !["idle", "error", "closed"].includes(observed.status))
          throw new RestartRefusal("The retained worker is no longer positively idle in its workspace; no instruction was delivered");
        const messageId = `ns-owner-restart-${digest(`${task.id}:${task.runId}:${digest(instruction || reason)}`).slice(0, 32)}`;
        const events = this.store.eventsAll(task.id);
        const alreadySent = events.some(event => event.kind === "owner_restart_instruction_sent" && event.detail.includes(messageId));
        const priorIntent = events.some(event => {
          if (event.kind !== "owner_restart_instruction_intent") return false;
          try { return JSON.parse(event.detail).messageId === messageId; } catch { return false; }
        });
        if (!alreadySent && priorIntent)
          throw new RestartRefusal("Owner restart instruction delivery is unknown; inspect the retained worker before deciding what to do next");
        if (!alreadySent) {
          this.store.event(task.id, "owner_restart_instruction_intent", JSON.stringify({ runId: task.runId, agentId: task.agentId, messageId }));
          await this.adapter.notify(task.agentId, messageId,
            `Owner restart instruction for the existing task run ${task.runId}: ${instruction || `Continue the existing task. Reason: ${reason}`}`);
          this.store.event(task.id, "owner_restart_instruction_sent", JSON.stringify({ runId: task.runId, agentId: task.agentId, messageId }));
        }
        return this.store.task(task.id);
      }
      case "pre_dispatch": {
        // An owner move can leave a pre-PR task in changes_requested without
        // an author thread. Resume it through the ordinary move-to-work
        // replacement path so the retained workspace, branch and route are
        // reused; validation retry is reserved for tasks that have not entered
        // that author lifecycle.
        if (!task.agentId && (task.runId || task.phase === "changes_requested")
          && (task.profile || currentRouteProfile(task, "worker")))
          return this.engine.moveToWork({ taskId: task.id, version, reason, instruction: input.instruction, caller: input.caller });
        // An initial pre-dispatch task replays admission through the existing
        // validation retry, which verifies any retained workspace. A review
        // entry re-admits from `queued` whatever its attention flag said.
        if (task.entrypoint !== "review" && (task.workspaceIntent || task.workspaceId))
          return this.engine.retryValidation({ taskId: task.id, version, rebindWorkspaceId: input.rebindWorkspaceId, settleFences: { detail: `restart ${role}: ${reason}`, runIds: [] } });
        const retained = Boolean(task.workspaceIntent);
        return this.engine.control(() => this.store.transaction(() => {
          this.engine.settleVerbFences(task.id, { detail: `restart ${role}: ${reason}`, runIds: [] });
          return this.resolution.returnToDispatch(this.store.task(task.id), retained, `Restart requested: ${reason}`, "restart_requested");
        }),
          `task:${task.id}`);
      }
      case "absent_worker": {
        // The worker run is the task's own, not a Run row, so every Run row here
        // is another role: settle the finished ones with the restart, and the
        // episode's own reporting run with it.
        const finished = await this.engine.collectVerbFinishedRuns(task.id, run => run.id === this.engine.openEpisodeRunId(task.id));
        if (finished.fenced.length) throw new DurableFenceRefusal(this.engine.verbRunFenceRefusal(finished.fenced[0]!));
        const displacement = await this.engine.planEpisodeDisplacement(task.id, version, `restart ${role}`);
        return this.engine.control(() => this.engine.executeEpisodeRestart(task.id, displacement, () => this.engine.prepareWorkerResume({
          taskId: task.id, version, instruction,
          settleFences: { detail: `restart ${role}: ${reason}`, runIds: finished.settleable.map(item => item.id), displacedRunIds: displacement.runIds },
        }), finished.settleable.map(run => run.id)), `task:${task.id}`);
      }
      case "blocked_worker":
      case "retained_worker":
      case "blocked_with_pr":
      case "stopped_revision": {
        // Spec 050 (#3569): finished runs of other roles settle by observation
        // before the continuation; a run that cannot settle keeps fencing the
        // ordinary paths and is left alone here.
        const runsBefore = this.store.runs(task.id);
        const subject = shape === "stopped_revision" ? runsBefore.findLast(run => run.role === "revision" && !run.released
          && !run.completion && run.agentId === task.agentId && run.workspaceId === task.workspaceId) : undefined;
        const finished = await this.engine.collectVerbFinishedRuns(task.id, run => run.id === subject?.id || run.id === this.engine.openEpisodeRunId(task.id));
        if (finished.fenced.length) throw new RestartRefusal(this.engine.verbRunFenceRefusal(finished.fenced[0]!));
        // The coordinator episode this stop waits on settles with the same
        // continuation, so its reporting run never fences the restart. It is
        // planned here and cancelled only after every refusal check below, so a
        // refused continuation leaves the coordinator's work untouched.
        const displacement = await this.engine.planEpisodeDisplacement(task.id, version, `restart ${role}`);
        return this.engine.control(() => this.engine.executeEpisodeRestart(task.id, displacement, async () => {
          const current = this.store.task(task.id);
          this.engine.requireOwnerControlCurrent(current, version, "Task changed; read next again before restarting");
          if (!current.agentId || !current.profile) throw new RestartRefusal("Worker restart requires the retained worker and route");
          if (fresh) {
            if (!this.adapter.verifyResume) throw new RestartRefusal("Continuation worktree verification is unavailable");
            await this.adapter.verifyResume(current);
          }
          let observed: AgentObservation;
          try { observed = await this.engine.onTaskHost(current, () => this.engine.host.observe(current.agentId!)); }
          catch (error) { throw new RestartRefusal(`The retained worker cannot be observed (${hostFailureRefusalDetail(error)}); restore observation before restarting. No continuation was sent`); }
          // Run rows and effect records can change without a task-version bump.
          // Recheck them after all awaits, before any settlement or authorization.
          const latest = this.store.task(task.id);
          this.engine.requireOwnerControlCurrent(latest, version, "Task changed during restart verification; read next again before restarting");
          if (!runsUnchangedSince(runsBefore, this.store.runs(task.id)))
            throw new RestartRefusal("A run changed during restart verification; read next again before restarting");
          const refusal = workerRestartRefusal(collectOwnerVerbFacts(this.store, latest), shape, observed);
          if (refusal) throw new RestartRefusal(refusal);
          const pending = recoveryEffects(this.store, latest).filter(effect => finished.settleable.some(run => run.id === effect.runId)
            && isBlockingRecoveryEffect(effect));
          if (pending.length) throw new RestartRefusal(recoveryEffectsRefusal(pending)!);
          // Spec 050 atomic verbs: the fences settle with the continuation's
          // own writes. Stopped-revision recovery owns its transaction, so its
          // settlement commits alone before the delegated recovery.
          const settleFences = { detail: `restart ${role}: ${reason}`, runIds: finished.settleable.map(item => item.id), displacedRunIds: displacement.runIds };
          const settling = [...settleFences.runIds, ...settleFences.displacedRunIds];
          const hasPr = taskHasPr(current);
          // An ordinary owner restart resumes the retained worker. It supersedes
          // a queued non-delivery replacement in the same transaction, so a
          // later dispatch cannot route away from that retained thread.
          const supersedingReplacement = !fresh && current.resolution.nonDeliveryRoutePending;
          const resumeTask = supersedingReplacement
            ? this.resolution.update(current, { nonDeliveryRoutePending: false, pendingRevisionCause: null }, {},
              'non_delivery_replacement_superseded', `Owner restart ${role}: ${reason}`)
            : current;
          const resumeChoice = restartResumeChoice(current, shape);
          if (resumeChoice === "worker") this.resolution.prepareResumeWorker(resumeTask, instruction, true, settling);
          else if (resumeChoice === "revision") this.resolution.admitStoppedRevision(resumeTask, instruction, !hasPr, settling);
          else this.resolution.prepareRetry(resumeTask, resumeChoice !== "review", resumeChoice === "review" ? undefined : instruction, true, false, !hasPr, undefined, undefined, settling);
          return async () => {
            if (fresh) await this.adapter.verifyResume!(this.store.task(task.id));
            const afterCancel = await this.engine.onTaskHost(current, () => this.engine.host.observe(current.agentId!));
            this.engine.assertUnchangedBeforeCancel(task.id, version, runsBefore);
            const afterRefusal = workerRestartRefusal(collectOwnerVerbFacts(this.store, this.store.task(task.id)), shape, afterCancel);
            if (afterRefusal) throw new RestartRefusal(afterRefusal);
            const settle = () => this.engine.settleVerbFences(task.id, settleFences);
            const continueWorker = () => {
              const hasPr = taskHasPr(current);
              // Spec 058 task 577: one worker thread. A fresh restart replaces
              // the retained worker only on provider failure, quota exhaustion,
              // a closed agent or an unrecoverable session, on an approved route
              // to a different model, or with an explicit operator-relayed
              // reason. Otherwise the refusal names its rule and the retained
              // worker continues on the same thread.
              const observedFailure = retainedWorkerFailureCause({
                task: this.store.task(task.id), observedStatus: afterCancel.status, observedError: afterCancel.error,
                observedActive: afterCancel.active || Boolean(afterCancel.activeTurnId), observedPermissions: afterCancel.permissions,
                observedWorkspaceId: afterCancel.workspaceId,
              });
              // An errored retained thread gets one continuation attempt first;
              // error status alone must not arm replacement during restart.
              let effectiveFresh = fresh && observedFailure?.kind !== "agent_errored";
              if (effectiveFresh) {
                const latestTask = this.store.task(task.id);
                const restartRoute = currentRouteProfile(latestTask, "worker") ?? latestTask.profile!.id;
                const routeGroup = latestTask.profileGroup ?? this.store.pool().find(entry => entry.profileId === latestTask.profile?.id)?.group ?? null;
                const routeAvailabilityRow = routeGroup
                  ? this.store.db.prepare("SELECT data FROM availability WHERE group_id=?").get(routeGroup)
                  : null;
                const routeAvailability = routeAvailabilityRow ? JSON.parse(String((routeAvailabilityRow as { data: string }).data)) : null;
                const decision = decideWorkerReplacement({
                  task: latestTask,
                  requestedProfileId: restartRoute,
                  requestedModel: this.engine.profiles.find(candidate => candidate.id === restartRoute)?.model ?? latestTask.profile?.model ?? null,
                  currentModel: latestTask.profile?.model ?? null,
                  approved: isWorkerRouteApproved(latestTask, restartRoute, this.store.pool(), this.store.usageLevel()),
                  failure: retainedWorkerFailureCause({
                    task: latestTask,
                    observedStatus: afterCancel.status,
                    observedError: afterCancel.error,
                    observedActive: afterCancel.active || Boolean(afterCancel.activeTurnId),
                    observedPermissions: afterCancel.permissions,
                    observedWorkspaceId: afterCancel.workspaceId,
                    groupUnavailable: routeAvailability && groupIsUnavailable(routeAvailability)
                      ? { group: routeGroup!, reason: String(routeAvailability.reason ?? "") } : null,
                  }),
                  explicitOperatorRelay: input.caller === OPERATOR_BOARD_CALLER || (input.relayed === true && Boolean(input.note?.trim())),
                  freshRestart: true,
                });
                if (!decision.allowed) {
                  effectiveFresh = false;
                  this.store.event(task.id, "worker_replacement_refused", `${decision.rule}: ${decision.detail}`);
                }
              }
              // A pre-PR continuation parked behind a released prerequisite wait
              // re-arms through the worker resume, which keeps its blocked evidence.
              const continued = resumeChoice === "worker"
                ? this.resolution.resumeWorker(current, instruction, true)
                : resumeChoice === "revision"
                  ? this.resolution.restartStoppedRevision(current, instruction, !hasPr, settleFences)
                  : (this.engine.resumeReleasedPrerequisiteWait(current.id), resumeChoice === "review"
                    ? this.resolution.retry(this.store.task(current.id), false, undefined, true)
                    : this.resolution.retry(this.store.task(current.id), true, instruction, true, false, !hasPr));
              const callerRelay = input.caller === OPERATOR_BOARD_CALLER || (input.relayed === true && Boolean(input.note?.trim()));
              return this.store.update(continued.id, {
                // Replacement uses the existing durable failover machinery, but
                // pins the worker route (an owner's required request wins over
                // the profile that last ran) rather than choosing a higher profile.
                failoverReason: effectiveFresh ? `${OPERATOR_WORKER_REMAP_REASON}. Continue the existing task: ${instruction}`.slice(0, 2000) : "",
                replacementProfile: effectiveFresh ? (observedFailure?.kind === "agent_errored" ? null : { profileId: currentRouteProfile(current, "worker") ?? current.profile!.id, reason,
                  // Spec 058 task 577: the explicit operator relay travels with
                  // the arm so the sweep can retire on it.
                  ...(callerRelay ? { operatorRelayed: true as const } : {}) }) : null,
                // An owner's instruction is the continuation; without one, the
                // continuation keeps what it resumed (a pending or one-shot scoped
                // instruction), never the generic default over it.
                resolution: { ...continued.resolution, pendingWorkerInstruction: input.instruction?.trim() ? instruction : continued.resolution.pendingWorkerInstruction ?? null },
              }, "restart_worker_requested");
            };
            if (shape === "stopped_revision") {
              // Stopped-revision recovery owns its transaction and settles inside
              // it; calling it here would nest a transaction.
              return continueWorker();
            }
            return this.store.transaction(() => {
              settle();
              return continueWorker();
            });
          };
        }, finished.settleable.map(run => run.id)), `task:${task.id}`);
      }
      case "checkpoint_reviewer": {
        const run = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
        const checkpoint = run?.reviewCheckpoints?.at(-1);
        if (!run || run.role !== "reviewer" || !checkpoint) throw Error("The reviewer checkpoint is no longer current");
        if (fresh) return this.engine.restartReview(task.id, reason, instruction);
        return this.engine.continueRetainedReviewer(task, { version, reason, instruction,
          ownerStopYields: this.engine.isOwnerCall() || Boolean(this.engine.replayingDeferredVerb.getStore() && this.engine.deferredRestartSupersedesOwnerStop(task)),
          deferrable: input, verb: "restart" }, operationId);
      }
      case "stopped_reviewer":
        if(!fresh){const refusal=plainHandoverFreshRestart(task,this.store.runs(task.id));if(refusal)throw new RestartRefusal(refusal);}
        return this.engine.restartReview(task.id, reason, instruction, fresh);
      case "absent_resolution": {
        // Spec 050 (#3569): the delegated handlers ignore unreleased recovery
        // runs, so a finished one settles with the restart instead of riding
        // along unreleased. The inventory lookup refuses before anything is
        // written, and the settlement lands inside the action's transaction.
        const absent = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
        const finished = await this.engine.collectVerbFinishedRuns(task.id, run => run.id === absent?.id || run.id === this.engine.openEpisodeRunId(task.id));
        if (finished.fenced.length) throw new DurableFenceRefusal(this.engine.verbRunFenceRefusal(finished.fenced[0]!));
        // The episode's own run settles with the restart unless it is the absent
        // run this shape is binding again. It is cancelled only after the
        // inventory lookups below have had their say.
        const displacement = task.resolution.recovery?.runId && task.resolution.recovery.runId !== absent?.id
          ? await this.engine.planEpisodeDisplacement(task.id, version, `restart ${role}`) : { runIds: [] as string[], cancel: async () => {} };
        const settleFences = { detail: `restart ${role}: ${reason}`, runIds: finished.settleable.map(item => item.id), displacedRunIds: displacement.runIds };
        return this.engine.control(() => this.engine.executeEpisodeRestart(task.id, displacement, () => this.engine.prepareAbsentResolution({ taskId: task.id, version, settleFences }, { input, instruction }), finished.settleable.map(run => run.id)), `task:${task.id}`);
      }
      case "coordinator": {
        const absentRecovery = this.resolution.recovery.absentRun(task);
        if (absentRecovery) {
          if (!this.resolution.adapter.findRunAgents) throw Error('Run identity lookup is unavailable');
          const found = await this.resolution.adapter.findRunAgents(absentRecovery);
          if (found.length) throw Error('Recovery run creation is no longer proven absent; inspect the matching agent before retrying');
          return this.engine.control(() => this.store.transaction(() => {
            const current = this.store.task(task.id);
            this.engine.requireOwnerControlCurrent(current, version, 'Task changed during absent recovery-run verification');
            if (this.resolution.recovery.absentRun(current)?.id !== absentRecovery.id)
              throw Error('Task changed during absent recovery-run verification');
            const others = this.store.runs(task.id).filter(run => !run.released && run.id !== absentRecovery.id);
            if (others.length) throw Error('Resolve the other retained runs before restarting coordinator recovery');
            this.adapter.purgeReportingFiles?.(task.id, [absentRecovery.id]);
            const released = this.resolution.recovery.releaseAbsent(current, absentRecovery.id, 'Exact task/run label lookup found no recovery agent');
            return this.resolution.operatorReturn(released, { recoveryActive: false, recovery: null, recoveryAttempts: 0 },
              {}, 'coordinator_rearmed', `Owner restarted coordinator recovery: ${reason}`);
          }), `task:${task.id}`);
        }
        const episodeRunId = task.resolution.recovery?.runId;
        // The ordinary fence stands: the episode's own run is this restart's
        // subject, and every other unreleased run — including the task's current
        // worker or reviewer — must settle by observation or fence the restart.
        // A retained run with an unresolved delivery is exactly what
        // `resolution.retry` refuses, and that refusal is never reclassified as
        // a successful re-arm (review 5673847000).
        const finished = await this.engine.collectVerbFinishedRuns(task.id, run => run.id === episodeRunId);
        if (finished.fenced.length) throw new DurableFenceRefusal(this.engine.verbRunFenceRefusal(finished.fenced[0]!));
        // Only the owner's deliberate coordinator restart re-arms the bounded
        // recovery loop. An authenticated coordinator report goes through this
        // same shared plan, but it must never buy its own recovery allowance.
        const ownerRearm = !this.engine.coordinatorActionRunId.getStore();
        const exhaustedBound = () => {
          const current = this.store.task(task.id);
          return current.resolution.recovery?.status === "escalated"
            && unproductiveCoordinatorRuns(this.store, current.id) >= COORDINATOR_LOOP_LIMIT;
        };
        return this.engine.control(() => this.store.transaction(() => {
          this.engine.requireOwnerControlCurrent(this.store.task(task.id), version, "Task changed; refresh before restarting");
          this.engine.settleVerbFences(task.id, {
            detail: `restart coordinator: ${reason}`, runIds: finished.settleable.map(item => item.id), preserveEpisode: true,
          });
          const rearm = () => {
            // Tom, 2026-10-27: an exhausted-bound episode the loop itself stopped
            // closes with its history kept, so the ordinary pass opens a fresh one
            // under the owner's deliberate re-arm.
            const current = this.store.task(task.id), recovery = current.resolution.recovery;
            return this.store.update(current.id, {
              resolution: { ...current.resolution, recoveryActive: false,
                ...(recovery && recovery.status !== "resolved"
                  ? { recovery: { ...recovery, status: "resolved" as const, summary: `Owner re-armed coordinator recovery: ${reason}; original: ${recovery.summary}`.slice(0, 4000) } }
                  : {}) },
            }, "coordinator_rearmed", reason);
          };
          try {
            const applied = this.resolution.retry(this.store.task(task.id), false, undefined, true);
            return applied;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // The proven case only: an owner restarting an episode the three-launch
            // bound stopped. Every other refusal — a retained run, a durable
            // effect, an ordinary no-action state, a coordinator's own report —
            // keeps its ownership and evidence and rolls the settlement back.
            if (!ownerRearm || message !== "No resolution action needs retry" || !exhaustedBound()) throw error;
            const applied = rearm();
            // The re-arm's durable identity belongs to the successful transition,
            // not to the best-effort owner_control audit line: one ordinary event
            // in this transaction, structured and length-bounded, is what the
            // recovery bound reads (review 5673077554).
            this.store.event(task.id, "coordinator_rearm", JSON.stringify({ verb: "restart", role: "coordinator",
              caller: input.caller ?? null, at: now(), reason: reason.slice(0, 2000) }));
            return applied;
          }
        }), `task:${task.id}`);
      }
      default: throw Error(`restart does not support the ${shape} state`);
    }
  }

  /**
   * Operator-authorized exit for one detected hung worker/reviewer turn. The
   * task and run identity are checked before and after the live observation;
   * the stop intent and stable effect ID are durable before cancellation.
   * Unknown delivery is observed before one explicitly requested retry.
   */
  async stopStalledTurn(input:{taskId:string;version:number;runId:string}):Promise<Task>{
    return this.engine.control(async()=>{
      let task=this.store.task(input.taskId);
      if(task.removedAt)throw Error(REMOVED_TASK_REFUSAL);
      if(this.engine.stopped||this.store.getMeta('paused'))throw Error('Nucleus is paused; stalled-turn stop is deferred');
      if(dispatchBlocked(task))throw Error('A dispatch hold is active; stalled-turn stop is deferred');
      this.engine.requireOwnerControlCurrent(task,input.version,'Task changed; refresh before stopping its retained turn');
      this.engine.rejectFenced(task,'stalled-turn stop');
      if(!this.adapter.stopAgentTurn)throw Error('Paseo active-turn cancellation is unavailable');

      const target=(current:Task)=>{
        const incident=current.resolution.incident;
        if(!current.resolution.attention||incident?.cause!=='stalled_turn'||incident.runId!==input.runId||incident.status==='resolved')
          throw Error('This task has no current stalled-turn incident for that exact run');
      if(!incident.turnId)throw Error('The stall incident has no recorded active turn ID; Nucleus cannot prove which turn to interrupt');
      if(current.resolution.mergeIntent||current.resolution.mergedCommit||['done','cancelled'].includes(current.phase))
        throw Error('A stalled-turn stop requires live, unmerged task work');
      const targetRun=this.store.run(input.runId);
      const assignedAgent=current.runId===input.runId&&!current.resolution.currentRunId?current.agentId:targetRun?.agentId;
      const otherRun=this.store.unreleasedRunsForAgent(assignedAgent??'',current.hostId)
        .find(candidate=>candidate.taskId!==current.id);
      if(otherRun)throw Error(`Agent ${otherRun.agentId} also owns unreleased ${otherRun.role} run ${otherRun.id} on task ${otherRun.taskId}; no turn was stopped`);
      const otherWorker=assignedAgent?this.store.activeCapacityTasks().find(candidate=>candidate.id!==current.id&&(!candidate.hostId||!current.hostId||candidate.hostId===current.hostId)&&candidate.agentId===assignedAgent
        &&['working','dispatching','needs_attention','blocked','error'].includes(candidate.phase)&&!candidate.resolution.currentRunId):undefined;
      if(otherWorker)throw Error(`Agent ${assignedAgent} is also assigned to task ${otherWorker.id}; no turn was stopped`);
      if(current.runId===input.runId&&current.agentId&&current.workspaceId&&!current.completion&&!current.resolution.currentRunId
          &&['working','needs_attention'].includes(current.phase)){
          if(current.prUrl||current.prHead||current.resumePrNumber)throw Error('The initial worker turn has accepted PR identity; use its retained resolution controls');
          if(this.store.runs(current.id).some(run=>!run.released))throw Error('Another retained run owns this task; stop is refused');
          return {role:'worker' as const,agentId:current.agentId,workspaceId:current.workspaceId,run:null as Run|null};
        }
        const run=this.store.run(input.runId);
        if(!run||run.taskId!==current.id||run.released||run.completion||!run.agentId)
          throw Error('The exact stalled run is no longer active; refresh task and run identity');
        if(current.resolution.currentRunId!==run.id||(run.role==='reviewer'&&run.agentId!==current.resolution.reviewerAgentId))
          throw Error('The exact stalled run is no longer the task’s assigned run');
        if((run.role!=='revision'&&run.role!=='reviewer')||run.workspaceId!==current.workspaceId||(run.role==='revision'&&run.agentId!==current.agentId))
          throw Error('Only the retained revision or reviewer run in this task workspace can be stopped');
        if(run.role==='reviewer'&&(!current.prUrl||!current.prHead||run.head!==current.prHead))
          throw Error('The reviewer is not bound to the task’s current exact PR head');
        if(run.role==='revision'&&(!current.prHead||run.head!==current.prHead))
          throw Error('The revision is not bound to the task’s current exact PR head');
        if(this.store.runs(current.id).some(candidate=>!candidate.released&&candidate.id!==run.id))
          throw Error('Another retained run owns this task; stop is refused');
        return {role:run.role,agentId:run.agentId,workspaceId:run.workspaceId,run};
      };

      let assigned=target(task);
      const previous=task.resolution.stalledTurnStop;
      if(previous&&previous.runId!==input.runId)throw Error('A different stalled-turn stop is still recorded; settle it before targeting another run');
      if(previous&&['stopped','completed'].includes(previous.status))throw Error(`This stalled run is already ${previous.status}; no second stop will be sent`);
      const observed=await this.engine.onTaskHost(task, () => this.engine.host.observe(assigned.agentId));
      if(this.engine.stopped||this.store.getMeta('paused'))throw Error('Nucleus paused during stalled-turn observation; no stop was sent');
      task=this.store.task(input.taskId);
      this.engine.requireOwnerControlCurrent(task,input.version,'Task changed during stalled-turn observation; no stop was sent');
      assigned=target(task);
      if(observed.id!==assigned.agentId||observed.workspaceId!==assigned.workspaceId)
        throw Error('The assigned agent or workspace changed during stalled-turn proof; no stop was sent');
      if(dispatchBlocked(task))throw Error('A dispatch hold became active during stalled-turn observation; no stop was sent');
      if(observed.permissions){
        const reason=`The stalled ${assigned.role} run ${input.runId} now has an active permission request. Stop was refused; resolve or inspect that request before deciding again.`;
        this.store.update(task.id,{reason},'stalled_turn_stop_refused',reason);
        throw Error(reason);
      }
      const observedBusy=observed.active||['running','initializing'].includes(observed.status);
      if(!observedBusy){
        if(previous&&['intent','uncertain','sent'].includes(previous.status)&&['idle','error','closed'].includes(observed.status)){
          this.resolution.reconcileStalledTurnStop(task,assigned.run,observed);
          return this.store.task(task.id);
        }
        throw Error('The exact turn is no longer active; no stop was sent. Let normal stopped-run reconciliation inspect it');
      }
      if(!observed.activeTurnId)throw Error('Paseo did not expose the active turn ID; Nucleus cannot prove which turn would be interrupted');
      if(task.resolution.incident?.turnId!==observed.activeTurnId)
        throw Error(`The stalled turn changed from ${task.resolution.incident?.turnId ?? 'unknown'} to ${observed.activeTurnId}; no interruption was sent`);
      if(previous&&previous.turnId!==observed.activeTurnId)
        throw Error(`The assigned agent is on a different active turn (${observed.activeTurnId}); no interruption was sent`);
      if(previous?.status==='sent')return task;
      if(previous&&previous.attempts>=2)throw Error('Stop delivery remains uncertain after one reconciled retry; inspect the retained thread before any further action');

      const effectId=previous?.effectId??`ns-stalled-stop-${digest(`${task.id}:${input.runId}:${assigned.agentId}:${observed.activeTurnId}`).slice(0,32)}`;
      const intent={
        runId:input.runId,role:assigned.role,agentId:assigned.agentId,workspaceId:assigned.workspaceId,
        turnId:observed.activeTurnId,effectId,status:'intent' as const,attempts:previous?previous.attempts+1:1,
        requestedAt:previous?.requestedAt??now(),observedInactiveAt:null,
        detail:previous?`Retry authorized after a fresh observation of the same active turn ${observed.activeTurnId}`:`Operator authorized stopping detected stalled turn ${observed.activeTurnId}`,
      };
      task=this.store.transaction(()=>{
        const current=this.store.task(input.taskId);
        if(current.version!==input.version||this.store.getMeta('paused')||dispatchBlocked(current))
          throw Error('Task version, pause or dispatch fence changed before stop intent; no interruption was sent');
        const fresh=target(current);
        if(fresh.agentId!==assigned.agentId||fresh.workspaceId!==assigned.workspaceId||fresh.run?.id!==assigned.run?.id)
          throw Error('The assigned run changed before stop intent; no interruption was sent');
        return this.store.update(current.id,{resolution:{...current.resolution,stalledTurnStop:intent},
          reason:`Operator stop requested for stalled ${assigned.role} run ${input.runId} turn ${intent.turnId}; waiting for observed inactivity. No replacement turn will start automatically`},
          'stalled_turn_stop_intent',JSON.stringify(intent));
      });
      const abandonUnsent=(reason:string):never=>{
        const latest=this.store.task(input.taskId),currentStop=latest.resolution.stalledTurnStop;
        if(currentStop?.effectId===intent.effectId&&currentStop.status==='intent'){
          const visible=`No stop was sent for stalled ${assigned.role} run ${input.runId}: ${reason}. The original incident and run lease remain for owner inspection`;
          this.store.update(latest.id,{resolution:{...latest.resolution,stalledTurnStop:null},reason:visible},'stalled_turn_stop_refused',visible);
        }
        throw Error(reason);
      };
      const beforeStop=await this.engine.onTaskHost(task, () => this.engine.host.observe(assigned.agentId));
      if(this.engine.stopped||this.store.getMeta('paused'))throw Error('Nucleus paused during final stalled-turn proof; no stop was sent');
      const latestBeforeStop=this.store.task(input.taskId);
      if(latestBeforeStop.version!==task.version||dispatchBlocked(latestBeforeStop))
        throw Error('Task version or dispatch fence changed during final stalled-turn proof; no stop was sent');
      let finalTarget:ReturnType<typeof target>;
      try{finalTarget=target(latestBeforeStop)}catch(error){return abandonUnsent(error instanceof Error?error.message:String(error))}
      if(beforeStop.id!==assigned.agentId||beforeStop.workspaceId!==assigned.workspaceId||finalTarget.run?.id!==assigned.run?.id)
        return abandonUnsent('assigned agent, workspace or run changed during final stalled-turn proof');
      if(beforeStop.permissions)return abandonUnsent('a permission request appeared during final stalled-turn proof');
      if(!beforeStop.active||!['running','initializing'].includes(beforeStop.status)){
        if(['idle','error','closed'].includes(beforeStop.status)){
          this.resolution.reconcileStalledTurnStop(latestBeforeStop,assigned.run,beforeStop);
          return this.store.task(input.taskId);
        }
        return abandonUnsent(`the final live status is ${beforeStop.status}, so inactivity is unproved`);
      }
      if(beforeStop.activeTurnId!==intent.turnId)
        return abandonUnsent(`active turn changed from ${intent.turnId} to ${beforeStop.activeTurnId??'unknown'}`);
      try{
        await this.engine.onTaskHost(task, () => this.engine.host.stopAgentTurn(assigned.agentId));
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        const latest=this.store.task(input.taskId),latestRun=assigned.run?this.store.run(assigned.run.id):null;
        const authenticCompletion=assigned.role==='worker'?latest.completion?.runId===input.runId:latestRun?.completion?.runId===input.runId;
        if(authenticCompletion&&latest.resolution.stalledTurnStop?.runId===input.runId){
          const stop={...latest.resolution.stalledTurnStop,status:'completed' as const,detail:'Authentic authenticated completion arrived while stop delivery was uncertain; it was retained'};
          return this.store.update(latest.id,{resolution:{...latest.resolution,stalledTurnStop:stop}},'stalled_turn_completion_preserved',input.runId);
        }
        if(latest.resolution.stalledTurnStop?.runId===input.runId&&latest.resolution.stalledTurnStop.status==='intent'){
          const stop={...latest.resolution.stalledTurnStop,status:'uncertain' as const,detail:`Stop delivery is uncertain: ${message}`.slice(0,2000)};
          const reason=`Stop delivery for stalled ${assigned.role} run ${input.runId} turn ${intent.turnId} is uncertain. Inspect the same retained turn before retrying; no duplicate stop was sent.`;
          this.store.update(latest.id,{resolution:{...latest.resolution,stalledTurnStop:stop},reason},'stalled_turn_stop_uncertain',stop.detail);
        }
        throw Error(`Stalled-turn stop delivery is uncertain: ${message}`);
      }

      const latest=this.store.task(input.taskId),latestRun=assigned.run?this.store.run(assigned.run.id):null;
      const authenticCompletion=assigned.role==='worker'?latest.completion?.runId===input.runId:latestRun?.completion?.runId===input.runId;
      if(authenticCompletion&&latest.resolution.stalledTurnStop?.runId===input.runId){
        const stop={...latest.resolution.stalledTurnStop,status:'completed' as const,detail:'Authentic authenticated completion arrived while the stop was being delivered; it was retained'};
        return this.store.update(latest.id,{resolution:{...latest.resolution,stalledTurnStop:stop}},'stalled_turn_completion_preserved',input.runId);
      }
      if(latest.resolution.stalledTurnStop?.runId!==input.runId||latest.resolution.stalledTurnStop.status!=='intent'){
        this.store.event(latest.id,'stalled_turn_stop_delivery_reconciled',`${input.runId}/${intent.turnId}: interruption acknowledged after the task stop binding changed; current identities were retained`);
        throw Error('Task stop binding changed while the interruption was delivered; inspect the recorded run event before any further action');
      }
      const statusReason=`Stop request sent for stalled ${assigned.role} run ${input.runId} turn ${intent.turnId}; waiting for Nucleus to observe inactivity. No replacement turn will start automatically`;
      return this.store.update(latest.id,{resolution:{...latest.resolution,stalledTurnStop:{...latest.resolution.stalledTurnStop,status:'sent',detail:'Paseo acknowledged the active-turn cancellation request'}},
        reason:statusReason},'stalled_turn_stop_sent',`${input.runId}/${intent.turnId}/${effectId}`);
    },`task:${input.taskId}`);
  }

  async prepareAbsentResolution(input:{taskId:string;version:number;settleFences?:{detail:string;runIds:string[];displacedRunIds?:string[]}}, restart?:{input:TaskControlInput;instruction:string}):Promise<Task | (()=>Task | Promise<Task>)>{
    const task=this.store.task(input.taskId),runs=this.store.runs(task.id);
    const check=()=>{
      const current=this.store.task(task.id);
      if(current.removedAt)throw Error(REMOVED_TASK_REFUSAL);
      this.engine.rejectFenced(current, 'absent resolution recovery');
      this.engine.requireOwnerControlCurrent(current,input.version,'Task changed during absent resolution-run verification');
      if(!runsUnchangedSince(runs,this.store.runs(task.id)))throw Error('Task changed during absent resolution-run verification');
      return current;
    };
    check();
    const settling=input.settleFences?[...input.settleFences.runIds,...(input.settleFences.displacedRunIds??[])]:[];
    const admitLocal=()=>{
      const current=check();
      if(!occupiesSlot(current, this.store.runs(task.id))){
        const capacity=recoveryCapacityFor(current,this.store.activeCapacityTasks(),this.store.getMeta<number>('globalLimit')??DEFAULT_GLOBAL_LIMIT,this.store.projectDispatchLimitFor(current),this.store.papercutDispatchPolicy());
        if(capacity)throw Error(capacity);
      }
      const run=this.resolution.absentResolutionRun(current);
      if(!run)throw Error('Absent resolution-run recovery requires an uncertain reviewer, coordinator or escalated recovery creation with no agent');
      if(this.resolution.recovery.busy(current)&&!settling.includes(current.resolution.recovery?.runId??''))throw Error('Wait for coordinator recovery to finish before replacing the absent run');
      return this.resolution.admitAbsentResolution(current,run.id,settling);
    };
    const run=admitLocal();
    if(this.adapter.workspaceAvailable&&!await this.adapter.workspaceAvailable(task.workspaceId!))throw Error('Absent resolution-run recovery requires the retained task workspace');
    if(!this.resolution.adapter.findRunAgents)throw Error('Run identity lookup is unavailable');
    const found=await this.resolution.adapter.findRunAgents(run);
    if(restart&&!found.length){
      const latest=this.store.task(task.id), wait=this.engine.dispatchWaitsFor(latest);
      // A newly placed hold defers intent, never carries this inventory read
      // forward as authority. Replay derives the subject and admits it afresh.
      if(wait)return this.engine.deferOwnerVerb(latest,restart.input,wait,{runId:run.id});
    }
    if(!restart&&found.length)throw Error('Resolution run creation is no longer proven absent; inspect the matching agent before retrying');
    if(found.length>1)throw Error(`Run creation lookup is ambiguous (${found.length} matching agents); no restart`);
    if(found.length===1&&found[0]!.workspaceId!==run.workspaceId)
      throw Error(`Run creation lookup found agent ${found[0]!.id} outside the retained workspace ${run.workspaceId}; inspect it before restarting so no second agent is created for the same run`);
    if(run.role==='closeout'){
      if(!this.adapter.verifyCleanQueueWorktree)throw Error('Workspace verification is unavailable');
      await this.adapter.verifyCleanQueueWorktree(task);
    }else{
      const pr=await this.adapter.verifyPr(task,taskPrNumber(task));
      if(pr.url!==task.prUrl||pr.head!==task.prHead||pr.head!==run.head)throw Error('PR head changed; inspect it before replacing the absent run');
    }
    admitLocal();
    if(restart&&!found.length){
      const wait=this.engine.dispatchWaitsFor(check());
      if(wait)return this.engine.deferOwnerVerb(check(),restart.input,wait,{runId:run.id});
      await this.resolution.admitUncertainRunRestart(check(),run.id,settling);
      admitLocal();
    }
    return async()=>{
      const current=check();
      admitLocal();
      if(restart&&found.length){
        return this.store.transaction(()=>{
          if(input.settleFences)this.engine.settleVerbFences(task.id,input.settleFences);
          const latest=this.store.run(run.id)!,settledTask=this.store.task(task.id),agentId=found[0]!.id;
          this.store.putRun({...latest,agentId,status:'running'});
          const patch:Partial<Task>={};
          if(latest.role==='reviewer')patch.resolution={...settledTask.resolution,reviewerAgentId:agentId,reviewerProfile:latest.profile,attention:false};
          if(['recovery','closeout'].includes(latest.role)&&settledTask.coordinatorGeneration===latest.generation&&!settledTask.coordinatorAgentId)patch.coordinatorAgentId=agentId;
          this.store.event(task.id,'absent_creation_bound',`Exact lookup bound ${latest.role} run ${latest.id} to agent ${agentId} on restart`);
          return this.store.update(task.id,patch,'restart_creation_bound');
        });
      }
      if(restart){
        const wait=this.engine.dispatchWaitsFor(current);
        if(wait)return this.engine.deferOwnerVerb(current,restart.input,wait,{runId:run.id});
        return this.resolution.restartUncertainRun(current,run.id,restart.instruction,input.settleFences);
      }
      throw Error('Restart authorization is required');
    };
  }
}
