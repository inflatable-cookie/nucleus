import { NO_PENDING_EFFECT_REFUSAL } from './verb-refusal-text';
import { REMOVED_TASK_REFUSAL } from './control-refusals';
import { settleSupersededFences } from '../recovery/fence-settlement';
import type { Task, WorkspaceArchiveRetry, TaskControlInput } from "../../shared/contracts";
import { dispositionWorkPolicy, incidentBindsCurrentWork, taskControlInputSchema } from "../../shared/contracts";
import { archiveIntentUnreadable } from "../workspaces/archive-intent";
import { progressDisposition, reopenDispositionWorkspace } from "./disposition";
import { isRecoveredPreDispatchHookHold } from "../hooks/hooks";
import { terminalArchiveWorkspaces } from "../closeout/terminal-archive";
import type { WorkspaceDiscard } from "../workspaces/orphan-worktree";
import { workspaceDiscardKey } from "../workspaces/orphan-worktree";
import type { OwnerEffect } from "./owner-verbs";
import { ownerPendingEffects, collectOwnerVerbFacts } from "./owner-verbs";
import { blockingRecoveryEffects } from "../recovery/recovery-effects";
import { settleObservedHostEffectOperations } from "../recovery/effect-gates";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { digest, now } from "../store/store";
import { participantToolRunIds } from "../recovery/task-reasons";
import { canRetireCancelledWorkspace, recordWorkspaceRetirement } from "../workspaces/terminal-workspace-retirement";
import { archiveFinishedThreads, exhaustedThreadArchives } from "../workspaces/thread-archive";
import { archiveUnusedWorkspace } from "../workspaces/unused-workspace";
import type { Engine } from "../engine";

/**
 * A workspace's archive retry record is the evidence an attempt ran: a new
 * attempt rewrites its count, cause or deadline, while a held one leaves it
 * exactly as recorded. Its absence before and after is no attempt either.
 */
const archiveRetryRecordChanged = (before: WorkspaceArchiveRetry | null, after: WorkspaceArchiveRetry | null) =>
  before === null || after === null ? before !== after
    : after.attempts !== before.attempts || after.error !== before.error || after.nextAttemptAt !== before.nextAttemptAt;

/**
 * The owner's `retry_effect` verb, by phase: the replayed outcomes, the branches
 * that answer before observed-idle settlement, the recovery effects and uncertain
 * operations, then fence settlement and the ordinary effects. Same-name `Engine`
 * methods delegate here. `store`, `adapter` and `resolution` read the engine per
 * call: tests replace the adapter.
 */
export class RetryEffectControls {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  /**
   * Spec 050 `retry_effect`: observe, then bind or retry once, one recorded
   * failed or uncertain side effect. The pending-effect list is re-derived from
   * the store, so an owner names an effect that is still pending; the named
   * handler observes the remote or local resource first, binds a found-done
   * effect and refuses with what was observed when the outcome stays unknown.
   */
  async retryEffect(input:TaskControlInput,operationId?:string):Promise<Task>{
    const task=this.store.task(input.taskId);
    if(task.removedAt)throw Error(REMOVED_TASK_REFUSAL);
    // A replayed terminal archive retry (service restart) whose own archive has
    // already landed is answered by that recorded outcome, its original
    // decision, not refused as stale: the exact running operation, its expected
    // version, the workspace in archivedWorkspaceIds, and a workspace_archived
    // event recorded after the operation was accepted. Nothing is re-enqueued.
    const archived=this.engine.replayedArchiveOutcome(task,input,operationId);
    if(archived)return archived;
    // The catalog-only archive has its own recorded answer, so a replayed retry
    // whose effect already landed is answered by that record, never re-sent.
    const catalogArchived=this.engine.replayedCatalogArchiveOutcome(task,input,operationId);
    if(catalogArchived)return catalogArchived;
    // A disposition workspace step that already settled is answered by its
    // settled disposition, never re-run from a stale operation.
    const dispositionSettled=this.engine.replayedDispositionWorkspaceOutcome(task,input,operationId);
    if(dispositionSettled)return dispositionSettled;
    this.engine.requireOwnerControlCurrent(task,input.version,'Task changed; refresh before retrying');
    const beforeSettlement=this.engine.retryEffectBeforeSettlement(task,input);
    if(beforeSettlement)return beforeSettlement;
    // An uncertain host-effect control the task has since answered settles by
    // observation, without force: the owner asked for the effect to be observed,
    // and the task's own later record is that observation (nucleus#1159).
    const observed=this.retryEffectByObservation(task,input);
    if(observed)return observed;
    // Spec 050 terminal-cleanup liveness (papercut b87375b0): apply the same
    // observed-liveness settlement the verbs use before deriving the effect, so
    // an idle never-reporting run cannot fence the retry it holds. A live agent
    // or an unobservable one still fences.
    await this.engine.settleObservedIdleRuns(task.id, `retry_effect ${input.effect ?? ''}`.trim());
    const pending=ownerPendingEffects(collectOwnerVerbFacts(this.store,this.store.task(task.id)));
    const matches=input.effect?pending.filter(item=>item.effect===input.effect):pending;
    if(matches.length!==1)throw Error(input.effect
      ?`No recorded side effect ${input.effect} is pending on this task${pending.length?`; pending: ${pending.map(item=>item.effect).join(', ')}`:''}`
      :pending.length>1?`Name one pending effect: ${pending.map(item=>item.effect).join(', ')}`
      :NO_PENDING_EFFECT_REFUSAL);
    const found=matches[0]!;
    if(found.kind==='recovery_effect')return this.engine.retryRecoveryEffect(task,input,found);
    if(found.kind==='task_control_operation')return this.engine.retryTaskControlOperation(task,found);
    // A proof policy belongs only to the disposition workspace step; it is never
    // silently ignored on another effect.
    if(input.workDisposition&&found.kind!=='disposition_workspace')
      throw Error('A work disposition policy is only valid for a disposition workspace retry');
    // Spec 050: both new verbs settle the fences they obsolete. A refused
    // retry changes nothing; an applied one first supersedes the stale incident,
    // recovery, reminders, carry and checkpoint intent with history kept, so a
    // stale episode never survives the retry it was blocking. The settlement is
    // part of this control, so the version-guarded handlers expect the version
    // it produced.
    settleSupersededFences(this.store,task.id,`retry_effect ${found.effect}: ${input.reason??''}`,now(),this.engine.coordinatorActionRunId.getStore());
    const expected=this.store.task(task.id).version;
    const current=this.store.task(task.id);
    return this.engine.retryOrdinaryEffect(task,input,{effect:found.effect,kind:found.kind},current,expected);
  }
  /**
   * The observation half of `retry_effect` for a named task operation: the owner
   * names `operation.<id>`, and a later-evidence settlement is recorded and
   * returned. An unanswered operation keeps its fence with the reason the
   * projection gives, never a resend. Anything not named as an operation is left
   * to the ordinary pending-effect list.
   */
  retryEffectByObservation(task:Task,input:TaskControlInput):Task|null{
    const named=input.effect?.startsWith('operation.')?input.effect.slice('operation.'.length):null;
    const candidate=named?this.store.operation(named):null;
    if(!candidate||candidate.kind!=='task_control'||candidate.taskId!==task.id||candidate.state!=='needs_attention')return null;
    const settled=settleObservedHostEffectOperations(this.store,task.id);
    if(settled.some(operation=>operation.id===candidate.id))return this.store.task(task.id);
    const blocked=blockingRecoveryEffects(this.store,this.store.task(task.id),{noticeKinds:'all'})
      .find(effect=>effect.kind==='operation'&&effect.identity===candidate.id);
    if(!blocked)return this.store.task(task.id);
    throw new DurableFenceRefusal(`operation ${candidate.id} remains ${blocked.state}: ${blocked.reason}; no later task evidence answers its host effect yet`);
  }
  /**
   * The branches that answer before observed-idle settlement, on purpose: a
   * flat handler table would lose this order. Not `async`: the path that falls
   * through reaches settlement in the same synchronous run it always did.
   */
  retryEffectBeforeSettlement(task:Task,input:TaskControlInput):Promise<Task>|null{
    const effects = ownerPendingEffects(collectOwnerVerbFacts(this.store, task));
    const selected = input.effect ?? (effects.length === 1 ? effects[0]!.effect : null);
    // Publication must observe the original result before any fence settlement.
    // A mismatch or unavailable inventory leaves the owner stop and findings
    // untouched; successful reconciliation settles attention in its commit.
    const publication = effects.find(effect => effect.effect === selected && effect.kind === 'review_publication');
    if (publication) return this.engine.retryPublicationBeforeSettlement(task,input,publication);
    const ownedTool = effects.find(effect => effect.effect === selected && effect.kind === 'owned_tool');
    if (ownedTool) return this.engine.retryOwnedToolHold(task,ownedTool);
    // Later archive authority must not rewrite the original disposition or
    // settle unrelated episode history. Check it before any mutation.
    if (canRetireCancelledWorkspace(task) && selected === `workspace_archive.${task.workspaceId}`) return this.engine.retryCancelledWorkspaceRetirement(task,input);
    const terminalWorkspace = terminalArchiveWorkspaces(task, this.store.runs(task.id))
      .find(workspace => selected === `workspace_archive.${workspace.id}`);
    if (terminalWorkspace?.id && effects.some(effect => effect.effect === selected)) return this.engine.retryTerminalArchive(task,input,terminalWorkspace.id,terminalWorkspace.directory);
    // A recorded archive intent outside the terminal archive is an ordinary retry
    // on the cleanup lane. No owner content discard applies.
    const runs = this.store.runs(task.id);
    const viewWorkspaceId = selected?.startsWith('workspace_archive.') ? selected.slice('workspace_archive.'.length) : null;
    // A recorded intent, readable or not, is offered so the owner can ask for the
    // observation and hear what the catalog answers.
    const intentWorkspaceId = viewWorkspaceId && (task.resolution.archiveIntentWorkspaceId === viewWorkspaceId
      || archiveIntentUnreadable(task, runs) === viewWorkspaceId) ? viewWorkspaceId : null;
    if (intentWorkspaceId && effects.some(effect => effect.effect === selected)) return this.engine.retrySupersededReviewView(task,input,intentWorkspaceId);
    return null;
  }
  async retryPublicationBeforeSettlement(task:Task,input:TaskControlInput,publication:OwnerEffect):Promise<Task>{
    // Round 4: publishing is an immediate external effect. While Queue is
    // paused or the task held, the retry is recorded and applied once that
    // clears, rather than refused.
    const wait = this.engine.dispatchWaitsFor(task);
    if (wait && !this.engine.replayingDeferredVerb.getStore()) return this.engine.deferOwnerVerb(task, { ...input, effect: publication.effect }, wait, null);
    this.engine.rejectFenced(task, 'formal review publication reconciliation');
    const result = await this.resolution.reconcileReviewPublication(task, publication.effect.slice('review_publication.'.length), input.reason ?? '', this.engine.coordinatorActionRunId.getStore());
    void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
    return result;
  }
  async retryOwnedToolHold(task:Task,ownedTool:OwnerEffect):Promise<Task>{
    const runId = ownedTool.effect.slice('owned_tool.'.length);
    const runs = this.store.runs(task.id);
    const run = runs.find(item => item.id === runId);
    // The initial worker and retired initial workers live on the task row,
    // without a corresponding Run record. Resolve the effect through every
    // durable participant binding before deciding that its agent is unreadable.
    const retiredWorker = task.retiredWorkers.find(worker => worker.runId === runId);
    const bindings = [
      run?.agentId ? { agentId: run.agentId, workspaceId: run.workspaceId } : null,
      task.runId === runId && task.agentId && task.workspaceId
        ? { agentId: task.agentId, workspaceId: task.workspaceId } : null,
      retiredWorker ? { agentId: retiredWorker.agentId, workspaceId: run?.workspaceId ?? task.workspaceId } : null,
    ].filter((binding): binding is { agentId: string; workspaceId: string } => Boolean(binding?.workspaceId));
    const bindingKeys = new Set(bindings.map(binding => `${binding.agentId}\0${binding.workspaceId}`));
    if (bindingKeys.size > 1) throw Error(`Owned-tool hold ${runId} has conflicting agent bindings`);
    const binding = bindings[0];
    if (!binding) throw Error(`Owned-tool hold ${runId} no longer has a readable agent binding`);
    const hold = await this.engine.ownedToolHold(binding.agentId, runId, task.id);
    if (hold) throw Error(`Owned-tool hold ${runId} remains: ${hold}`);
    await this.engine.settleObservedIdleRuns(task.id, `retry_effect ${ownedTool.effect}`);
    return this.store.task(task.id);
  }
  async retryCancelledWorkspaceRetirement(task:Task,input:TaskControlInput):Promise<Task>{
    const authority = this.engine.assertOwnerAuthority(input.caller, input.relayed, input.note, 'Workspace retirement');
    // Papercut c7643943: an explicit content discard is the same durable owner
    // decision the done-task route records, bound to this exact task, workspace
    // and directory. It is persisted before the retirement preflight, and the
    // preflight and adapter then waive only the content and publication proofs
    // for it. Prose in the reason, a note or an older retirement authorization
    // is never read as authority to lose contents.
    if (input.discard === true) this.engine.recordWorkspaceDiscard(task, task.workspaceId!, task.directory!, input, authority);
    const prior = task.resolution.workspaceRetirement;
    if (!prior || prior.state === 'held') recordWorkspaceRetirement(this.store, task.id, {
      workspaceId: task.workspaceId!, directory: task.directory!, branch: task.branch, head: null,
      authorization: { caller: input.caller!, kind: authority.kind, note: authority.note, reason: input.reason!, at: now() },
      state: 'authorized', detail: 'Owner authorized retirement of the preserved workspace', intentAt: null, archivedAt: null,
    });
    return this.engine.settleWorkspaceRetirement(task.id);
  }
  async retryTerminalArchive(task:Task,input:TaskControlInput,archiveWorkspaceId:string,directory:string|null|undefined):Promise<Task>{
    // Papercut c7643943: `discard` records the owner's durable decision to
    // lose this workspace's unproven contents, bound to the workspace and its
    // directory, before any archive effect. A replay keeps the first record.
    // The archive then waives only its content proofs; every fence stays.
    const priorDiscard = this.store.getMeta<WorkspaceDiscard>(workspaceDiscardKey(task.id, archiveWorkspaceId)) ?? null;
    if (input.discard === true) {
      if (!directory) throw Error('A content discard needs the workspace directory it binds');
      const authority = this.engine.assertOwnerAuthority(input.caller, input.relayed, input.note, 'Workspace content discard');
      this.engine.recordWorkspaceDiscard(task, archiveWorkspaceId, directory, input, authority);
    }
    // The retry record is what an archive attempt writes. Reading it here is
    // the history this call arrived with, never a new observation.
    const recordedBefore = task.resolution.workspaceArchiveRetries.find(record => record.workspaceId === archiveWorkspaceId) ?? null;
    // Spec 050: Queue's pause holds every archive attempt, so a paused retry
    // enqueues no cleanup and runs no adapter, Git or build-output work. It
    // reports that plainly below rather than replaying the stored failure as
    // this call's own (papercut: the 10:01 discard retry reported the 09:10
    // Git error although no attempt ran and the pause still held).
    const paused = this.store.getMeta('paused') === true;
    if (!paused) {
      // The existing workspace retry also reopens exhausted thread archive
      // attempts for that workspace. Every native send still re-proves them.
      const exhausted = exhaustedThreadArchives(this.store, this.store.task(task.id), this.store.runs(task.id), archiveWorkspaceId);
      for (const agentId of exhausted) {
        const key = this.store.threadArchiveKey(agentId, task.hostId);
        if (!key) continue;
        const prior = this.store.getMeta<Record<string, unknown>>(key);
        if (prior) this.store.setMeta(key, { ...prior, retries: 0, nextRetryAt: 0 });
        this.store.event(task.id, 'thread_archive_owner_retry', `${agentId}: owner rearmed exhausted archive retries`);
      }
      if (exhausted.length) {
        await archiveFinishedThreads(this.store, this.adapter, task.id, async (agentId, workspaceId) => {
          const current = this.store.task(task.id), runs = this.store.runs(task.id);
          const runIds = participantToolRunIds(current, runs, agentId, workspaceId);
          return this.resolution.ownedToolHold(agentId, { requireCompleteEvidence: true, runId: runIds[0], runIds, taskId: task.id, workspaceId });
        });
        if (this.engine.terminalThreadsPending(this.store.task(task.id), this.store.runs(task.id)))
          throw Error('Workspace archive still waits for its thread archive; see thread archive wait on the task');
      }
      // Join the automatic cleanup lane, including any archive already in
      // flight. It reads current state, observes unknown delivery and applies
      // the ordinary proofs; terminal cleanup does not reopen task episodes.
      // The verb waits for ITS OWN cleanup occurrence, never for the shared
      // queue to empty: each audit pass re-enqueues every done task, so that
      // queue need never empty and the operation would never settle.
      this.engine.enqueueCleanup(task.id, archiveWorkspaceId);
      await this.engine.awaitProjectionOccurrence(`cleanup:${task.id}:${archiveWorkspaceId}`, () => this.engine.drainCleanup());
    }
    const current = this.store.task(task.id);
    if (current.resolution.archivedWorkspaceIds.includes(archiveWorkspaceId)) return current;
    const recordedAfter = current.resolution.workspaceArchiveRetries.find(record => record.workspaceId === archiveWorkspaceId) ?? null;
    // Only a rewritten record is a failure this retry actually attempted. An
    // unchanged one is history, and an attempt that never ran is reported as
    // held - by a pause that landed even between the check above and the
    // archive's own - instead of as a fresh failure.
    if (!archiveRetryRecordChanged(recordedBefore, recordedAfter))
      throw Error(this.engine.heldArchiveRetryReason(current, archiveWorkspaceId, recordedBefore, this.store.getMeta<WorkspaceDiscard>(workspaceDiscardKey(task.id, archiveWorkspaceId)) ?? null, input.discard === true && !priorDiscard));
    throw Error(recordedAfter
      ? `Workspace archive retry for ${archiveWorkspaceId} attempt ${recordedAfter.attempts} failed: ${recordedAfter.error || current.resolution.cleanupReason || 'no cause was recorded'}`
      : current.resolution.cleanupReason || 'Terminal workspace archive is still held; no archive was confirmed');
  }
  async retrySupersededReviewView(task:Task,input:TaskControlInput,intentWorkspaceId:string):Promise<Task>{
    if (input.discard === true) throw Error('A content discard does not apply to a superseded review view on an active volume');
    if (this.store.getMeta('paused') === true) throw Error('Nucleus is paused; the superseded review view cleanup waits for the pause to clear');
    this.engine.enqueueCleanup(task.id, intentWorkspaceId);
    await this.engine.awaitProjectionOccurrence(`cleanup:${task.id}:${intentWorkspaceId}`, () => this.engine.drainCleanup());
    const settled = this.store.task(task.id);
    if (settled.resolution.archivedWorkspaceIds.includes(intentWorkspaceId)) return settled;
    const retry = settled.resolution.workspaceArchiveRetries.find(record => record.workspaceId === intentWorkspaceId);
    throw Error(retry
      ? `Superseded review view ${intentWorkspaceId} cleanup attempt ${retry.attempts} failed: ${retry.error || 'no cause was recorded'}`
      : 'Superseded review view cleanup is held; no archive was confirmed');
  }
  async retryHookEffect(input:TaskControlInput,current:Task,eventId:string):Promise<Task>{
    const record=this.store.hookEvents(current.id).find(item=>item.eventId===eventId);
    if(!record)throw Error(`Hook occurrence ${eventId} is no longer recorded on this task`);
    const before=blockingRecoveryEffects(this.store,current,{noticeKinds:'all'}).find(effect=>effect.kind==='hook'&&effect.identity===record.id);
    if(!before)return this.store.task(current.id);
    const result=await this.engine.hooks.retry(current,eventId,input.discard===true,false);
    const settled=this.store.task(current.id);
    const next=isRecoveredPreDispatchHookHold(settled,result)
      ?this.store.update(settled.id,{phase:'queued',reason:'Repository pre-dispatch hooks settled after retry'},'hook_retry_recovered')
      :settled;
    const remaining=blockingRecoveryEffects(this.store,this.store.task(current.id),{noticeKinds:'all'}).find(effect=>effect.kind==='hook'&&effect.identity===record.id);
    if(remaining)throw Error(`hook ${eventId} remains ${remaining.state}: ${remaining.reason}`);
    const latest=this.store.task(current.id);
    const stop=latest.resolution.stop, recovery=latest.resolution.recovery;
    const terminal=latest.phase==='done'||latest.phase==='cancelled';
    const blockers=blockingRecoveryEffects(this.store,latest,{noticeKinds:'all'});
    // A successful terminal cleanup can settle the operator stop that was
    // opened for this recovery episode. Keep the stop if any effect remains,
    // and bind the clear to the exact stop key the resolved recovery owned.
    if(terminal&&!blockers.length&&stop?.reason==='operator_needed'&&recovery?.status==='resolved'
      &&recovery.key===digest(`stop:${stop.reason}:${stop.since}`))
      return this.resolution.update(latest,{stop:null},{},'finished_hook_retry_cleared_recovery_stop',eventId);
    return next;
  }
  async reconcilePublicationEffect(input:TaskControlInput,current:Task,runId:string):Promise<Task>{
    const before=blockingRecoveryEffects(this.store,current,{noticeKinds:'all'}).find(effect=>effect.kind==='publication'&&effect.identity===runId);
    if(!before)return this.store.task(current.id);
    this.engine.rejectFenced(current,'formal review publication reconciliation');
    const result=await this.resolution.reconcileReviewPublication(current,runId,input.reason??'',this.engine.coordinatorActionRunId.getStore());
    void this.engine.cleanContext(() => this.engine.wakeTask(current.id));
    const remaining=blockingRecoveryEffects(this.store,this.store.task(current.id),{noticeKinds:'all'}).find(effect=>effect.kind==='publication'&&effect.identity===runId);
    if(remaining)throw Error(`publication ${runId} remains ${remaining.state}: ${remaining.reason}`);
    return result;
  }
  async retryRecoveryEffect(task:Task,input:TaskControlInput,found:OwnerEffect):Promise<Task>{
    const separator=found.effect.indexOf('.'), kind=found.effect.slice(0,separator), identity=found.effect.slice(separator+1);
    if(separator<1||!identity)throw Error('The recovery effect identity is malformed; refresh task detail');
    if(kind==='incident'){
      const settled=this.store.transaction(()=>{
        const current=this.store.task(task.id),incident=current.resolution.incident;
        if(!incident||incident.id!==identity||incident.status!=='reconciling'
          ||!incidentBindsCurrentWork(current,this.store.runs(current.id))
          ||current.resolution.recoveryActive||this.store.runs(current.id).some(run=>run.role==='recovery'&&!run.released))
          throw Error(`Incident ${identity} still has an active reconciliation; refresh task detail`);
        const detail=`Owner re-proved no active recovery run owns this reconciling incident; settled by retry_effect: ${input.reason}`.slice(0,2000);
        this.resolution.update(current,{incident:{...incident,status:'resolved',detail,updatedAt:new Date().toISOString()}}, {},'incident_reproved_settled',identity);
        return this.store.task(current.id);
      });
      void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
      return settled;
    }
    if(kind==='hook')return this.engine.retryHookEffect(input,this.store.task(task.id),identity);
    if(kind==='review_publication')return this.engine.reconcilePublicationEffect(input,this.store.task(task.id),identity);
    if(kind==='review-delivery'){
      const result=await this.resolution.reconcileReviewDeliveryEffect(task.id,identity);
      if(result.status==='delivered')return this.store.task(task.id);
      throw Error(`review-delivery ${identity} is ${result.status}: ${result.evidence||'the exact recipient message was not observed'}`);
    }
    if(kind==='attention-notice'){
      await this.resolution.reconcileAttentionNoticeEffect(task.id,identity);
      const remains=blockingRecoveryEffects(this.store,this.store.task(task.id),{noticeKinds:'all'}).some(effect=>effect.kind===kind&&effect.identity===identity);
      if(!remains)return this.store.task(task.id);
      throw Error(`attention-notice ${identity} remains blocking after its exact timeline observation`);
    }
    if(kind==='run-delivery'){
      if(await this.resolution.reconcileUncertainRunDelivery(task.id,identity))return this.store.task(task.id);
      throw Error(`run-delivery ${identity} is no longer an uncertain creation on this task`);
    }
    if(kind==='merge-response'){
      const observed=await this.resolution.reconcileMergeResponseEffect(task.id);
      const remains=blockingRecoveryEffects(this.store,observed,{noticeKinds:'all'}).some(effect=>effect.kind===kind&&effect.identity===identity);
      if(!remains)return observed;
      throw Error(`merge-response ${identity} remains blocking after the forge observation`);
    }
    if(kind==='project-validation'){
      const current=this.store.task(task.id);
      const resumed=this.resolution.retryProjectValidationEffect(current);
      void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
      return resumed;
    }
    if(kind==='operation'){
      const operation=this.store.operation(identity);
      if(operation?.taskId===task.id&&operation.state==='needs_attention'&&operation.result&&operation.effect?.status==='reconciled'){
        this.store.putOperation({...operation,state:'succeeded',settledAt:now(),diagnostic:''});
        this.store.event(task.id,'operation_reconciled',`${identity}: durable result and reconciled effect observed`);
        return this.store.task(task.id);
      }
    }
    const current=blockingRecoveryEffects(this.store,this.store.task(task.id),{noticeKinds:'all'}).find(effect=>effect.kind===kind&&effect.identity===identity);
    if(!current)return this.store.task(task.id);
    throw new DurableFenceRefusal(`${kind} ${identity} remains ${current.state}: ${current.reason}; no effect-specific observer can yet settle it`);
  }
  async retryTaskControlOperation(task:Task,found:OwnerEffect):Promise<Task>{
    const id=found.effect.slice('task_control_operation.'.length), operation=this.store.operation(id);
    const payload=this.store.operationPayload(id) as {control?:unknown}|null;
    const original=taskControlInputSchema.safeParse(payload?.control);
    if(!operation||operation.kind!=='task_control'||operation.taskId!==task.id||operation.state!=='needs_attention'
      ||!original.success||original.data.action!=='retry_effect'||!original.data.effect)
      throw Error(`Task-control operation ${id} is no longer an uncertain retry_effect; refresh task detail`);
    const pending=ownerPendingEffects(collectOwnerVerbFacts(this.store,task)).filter(item=>item.kind!=='task_control_operation');
    const target=pending.find(item=>item.effect===original.data.effect);
    if(target){
      // Re-run only the original named effect through the ordinary observer.
      // The current owner's explicit retry is the new authorization; no
      // uncertain delivery is replayed without the effect's normal proofs.
      return this.engine.retryEffect({...original.data,taskId:task.id,version:task.version});
    }
    const at=now(), settledTask=this.store.task(task.id);
    this.store.putOperation({...operation,state:'succeeded',settledAt:at,diagnostic:'',
      result:{taskId:task.id,taskVersion:settledTask.version,phase:settledTask.phase,number:settledTask.number??null,reference:settledTask.reference??null},
      effect:operation.effect?{...operation.effect,status:'reconciled',result:`Owner re-proved ${original.data.effect} is no longer pending`,resultAt:at}:null});
    this.store.event(task.id,'task_control_operation_reconciled',`${id}: ${original.data.effect} is no longer pending`);
    return settledTask;
  }
  async retryOrdinaryEffect(task:Task,input:TaskControlInput,found:{effect:string;kind:Exclude<OwnerEffect['kind'],'recovery_effect'|'task_control_operation'>},current:Task,expected:number):Promise<Task>{
    if(found.kind==='disposition_workspace'){
      // Spec 050: one explicit owner retry of a disposition that stopped at its
      // workspace proof or archive. The store derives the effect identity; the
      // original supersession or cancellation keeps its recorded kind,
      // replacement link, reason and every effect result. Selecting the safe
      // archive_if_empty policy is the one owner choice this verb adds, and it
      // is recorded with its authority before any proof or archive runs.
      const workspaceId=found.effect.slice('disposition_workspace.'.length);
      const disposition=current.disposition;
      if(!disposition||disposition.status!=='needs_attention')throw Error('The disposition is not waiting on a workspace step');
      const selected=input.workDisposition??null;
      const by=input.caller??(input.relayed?'relayed owner':'operator control');
      let authority:{kind:string;note:string|null}={kind:'operator',note:null};
      if(selected&&selected!==dispositionWorkPolicy(disposition)){
        if(selected!=='archive_if_empty')throw Error('A disposition workspace recovery can only select the existing archive_if_empty policy');
        const proven=this.engine.assertOwnerAuthority(input.caller,input.relayed,input.note,'Disposition proof policy selection');
        authority={kind:proven.kind,note:proven.note};
      }
      reopenDispositionWorkspace(this.store,{taskId:task.id,version:expected,workspaceId,policy:selected,
        reason:input.reason??'',by,authority});
      const reopenedAt=this.store.task(task.id).version;
      const progressed=await progressDisposition(this.store,this.engine.dispositionDeps(),task.id);
      this.store.event(task.id,'disposition_workspace_retry_result',JSON.stringify({workspaceId,policy:selected??dispositionWorkPolicy(disposition),
        status:progressed.disposition?.status??null,phase:progressed.phase,reopenedAt}));
      return progressed;
    }
    switch(found.kind){
      case 'hook':{
        return this.engine.retryHookEffect(input,current,found.effect.slice('hook.'.length));
      }
      case 'workspace_creation':
        return this.engine.retryValidation({taskId:task.id,version:expected,removeOrphanWorkspace:input.discard===true});
      case 'workspace_archive':
        return archiveUnusedWorkspace(this.store,this.adapter,{taskId:task.id,version:expected,
          unusedWorkspaceId:found.effect.slice('workspace_archive.'.length)},() => !this.engine.stopped,this.engine.retirement,
          target=>this.engine.retentionHold(task.id,target,'Unused workspace cleanup'));
      case 'external_workspace_archive':{
        // Spec 017: one catalog-only retry on the existing cleanup lane. Pause
        // holds it like every other archive; the pass re-proves placement,
        // membership and idleness, observes an unknown prior answer and records
        // the outcome this call reports.
        const workspaceId=found.effect.slice('external_workspace_archive.'.length);
        if(this.store.getMeta('paused')===true)throw Error('Nucleus is paused; the external workspace catalog archive waits for the pause to clear');
        this.engine.enqueueCleanup(task.id,workspaceId);
        await this.engine.awaitProjectionOccurrence(`cleanup:${task.id}:${workspaceId}`,() => this.engine.drainCleanup());
        const settled=this.store.task(task.id);
        const record=settled.resolution.externalWorkspaceArchives.find(item=>item.workspaceId===workspaceId);
        if(record?.state==='archived')return settled;
        throw Error(record
          ? `External workspace catalog archive for ${workspaceId} is ${record.state}: ${record.detail||'no cause was recorded'}`
          : `No catalog archive is pending for workspace ${workspaceId}`);
      }
      case 'runtime_retirement':
        return this.engine.retryRuntimeRetirement(task.id,expected);
      case 'build_output_cleanup':
        return this.engine.retryBuildOutputCleanup(task.id,expected);
      case 'merged_task_retention':{
        const outcome=await this.engine.hooks.retryRetentionAtIntegrationBase(current,input.reason??'');
        let settled=this.store.task(task.id);
        if(!outcome.hold)this.engine.lifecycle.retentionReconciled(settled.id,settled.workspaceId);
        settled=this.store.task(task.id);
        return settled;
      }
      case 'review_publication':{
        return this.engine.reconcilePublicationEffect(input,this.store.task(task.id),found.effect.slice('review_publication.'.length));
      }
      case 'planning_base':
        return this.engine.rerecordPlanningBase({taskId:task.id,version:expected});
      case 'owned_tool':
        throw Error('Owned-tool holds are re-proved before ordinary side-effect recovery');
    }
  }
  /**
   * Papercut: the operational receipt of an owner terminal archive retry whose
   * cleanup pass attempted nothing. It separates the four things a caller must
   * not confuse: whether a content discard authorization is recorded (now or
   * earlier) and durable for a later eligible attempt, that execution is held
   * with no adapter, Git or cleanup call made, and that the stored failure is
   * history with its own time - never this call's observation. It also never
   * claims the discard will succeed once the hold clears. Nothing is written
   * for this receipt: the retry record, the task and the pause are untouched.
   */
  heldArchiveRetryReason(task: Task, workspaceId: string, recorded: WorkspaceArchiveRetry | null, discard: WorkspaceDiscard | null, discardedNow: boolean): string {
    const paused = this.store.getMeta('paused') === true;
    let reason = paused
      ? `Nucleus is paused; this retry ran no archive attempt for workspace ${workspaceId}, and the pause still holds`
      : `This retry ran no archive attempt for workspace ${workspaceId}`;
    if (recorded) {
      const observed = this.store.eventsAll(task.id)
        .findLast(event => event.kind === 'workspace_cleanup_wait' && event.detail.startsWith(`${workspaceId}: `))?.at;
      reason += `. Its recorded failure (attempt ${recorded.attempts}${observed ? `, observed ${observed}` : ''}) remains history, not this call's observation`;
    } else reason += '. No failure record changed and nothing is claimed archived';
    if (discard) reason += discardedNow
      ? '. The operator content discard this call recorded is durable and retained for a later eligible attempt, and it lifts no pause'
      : '. The operator content discard already recorded for this workspace is retained for a later eligible attempt';
    return `${reason}.`;
  }
  replayedArchiveOutcome(task: Task, input: TaskControlInput, operationId?: string): Task | null {
    const workspaceId = input.effect?.startsWith('workspace_archive.') ? input.effect.slice('workspace_archive.'.length) : null;
    if (!operationId || !workspaceId || !task.resolution.archivedWorkspaceIds.includes(workspaceId)) return null;
    // The persisted operation, not the caller, is the identity: a running
    // task_control for this task whose stored control is this exact request.
    const invocation = this.store.operation(operationId);
    if (!invocation || invocation.kind !== 'task_control' || invocation.taskId !== task.id || invocation.state !== 'running' || invocation.expectedVersion !== input.version) return null;
    const stored = taskControlInputSchema.safeParse((this.store.operationPayload(operationId) as { control?: unknown } | null)?.control);
    if (!stored.success || stored.data.taskId !== task.id || stored.data.action !== 'retry_effect' || stored.data.effect !== input.effect
      || stored.data.version !== input.version || stored.data.caller !== input.caller) return null;
    // Chronology alone is not identity: an event strictly after acceptance must
    // name this workspace (its archive, its recorded content discard or its
    // cancelled-retirement archive record), and that workspace's archive must
    // follow it.
    const accepted = Date.parse(invocation.createdAt);
    const after = this.store.eventsAll(task.id).filter(event => Date.parse(event.at) > accepted);
    const recordNames = (event: { kind: string; detail: string }, kind: string) => {
      if (event.kind !== kind) return false;
      try { return (JSON.parse(event.detail) as { workspaceId?: unknown }).workspaceId === workspaceId; } catch { return false; }
    };
    const archived = (event: { kind: string; detail: string }) => event.kind === 'workspace_archived'
      ? event.detail.split('; ').includes(`workspace ${workspaceId}`) : recordNames(event, 'workspace_retirement_archived');
    const names = (event: { kind: string; detail: string }) => archived(event)
      || event.kind === 'workspace_contents_discarded' && recordNames(event, 'workspace_contents_discarded');
    const named = after.findIndex(names);
    if (named < 0) return null;
    return after.slice(named).some(archived) ? task : null;
  }
  /** A replayed `retry_effect` for a catalog archive that already settled is answered by its record (Spec 017). */
  replayedCatalogArchiveOutcome(task: Task, input: TaskControlInput, operationId?: string): Task | null {
    const workspaceId = input.effect?.startsWith('external_workspace_archive.') ? input.effect.slice('external_workspace_archive.'.length) : null;
    if (!operationId || !workspaceId) return null;
    const record = task.resolution.externalWorkspaceArchives.find(item => item.workspaceId === workspaceId);
    if (record?.state !== 'archived') return null;
    const invocation = this.store.operation(operationId);
    if (!invocation || invocation.kind !== 'task_control' || invocation.taskId !== task.id || invocation.state !== 'running' || invocation.expectedVersion !== input.version) return null;
    const stored = taskControlInputSchema.safeParse((this.store.operationPayload(operationId) as { control?: unknown } | null)?.control);
    if (!stored.success || stored.data.taskId !== task.id || stored.data.action !== 'retry_effect' || stored.data.effect !== input.effect
      || stored.data.version !== input.version || stored.data.caller !== input.caller) return null;
    const accepted = Date.parse(invocation.createdAt);
    return this.store.eventsAll(task.id).some(event => {
      if (event.kind !== 'external_workspace_archive_archived' || Date.parse(event.at) <= accepted) return false;
      try { return (JSON.parse(event.detail) as { workspaceId?: string }).workspaceId === workspaceId; } catch { return false; }
    }) ? task : null;
  }
  /**
   * A replayed `retry_effect` for a disposition workspace step that has since
   * settled is answered by the settled disposition, never re-run. The persisted
   * operation, not the caller, is the identity: the stored control must be this
   * exact request (task, effect, expected version, caller and selected policy),
   * and the disposition must have completed after that acceptance. A stale
   * version without that proof still refuses as stale.
   */
  replayedDispositionWorkspaceOutcome(task: Task, input: TaskControlInput, operationId?: string): Task | null {
    if (!operationId || !input.effect?.startsWith('disposition_workspace.')) return null;
    const invocation = this.store.operation(operationId);
    if (!invocation || invocation.kind !== 'task_control' || invocation.taskId !== task.id || invocation.state !== 'running'
      || invocation.expectedVersion !== input.version) return null;
    const stored = taskControlInputSchema.safeParse((this.store.operationPayload(operationId) as { control?: unknown } | null)?.control);
    if (!stored.success || stored.data.taskId !== task.id || stored.data.action !== 'retry_effect'
      || stored.data.effect !== input.effect || stored.data.version !== input.version
      || stored.data.caller !== input.caller || stored.data.workDisposition !== input.workDisposition) return null;
    if (task.disposition?.status !== 'complete') return null;
    const accepted = Date.parse(invocation.createdAt);
    return this.store.eventsAll(task.id).some(event => event.kind === 'disposition_complete' && Date.parse(event.at) > accepted)
      ? task : null;
  }
}
