import { onCheckoutVolume } from "../workspaces/checkout-volume";
import { reconcileRoutingSignoffs } from "../dispatch/routing-signoff";
import { archiveFinishedThreads, archiveSupersededWorkers } from '../workspaces/thread-archive';
import type { Task } from "../../shared/contracts";
import { missingOriginHasPlanner } from '../questions/origin';
import { taskStopClassification, taskStopVerbsFor } from "../../shared/task-stop";
import { occupiesSlot, recoveryCapacityFor } from "../dispatch/capacity";
import { DEFAULT_GLOBAL_LIMIT, holdsOf, taskHasUnreleasedRun } from "../../shared/contracts";
import { startsNoRuns } from "../closeout/queue-drain";
import { isDispositionActive } from "../../shared/contracts";
import type { Resolution } from "../resolution";
import { participantToolRunIds } from "../recovery/task-reasons";
import { hookHoldReason } from "../hooks/hooks";
import type { Engine } from '../engine';

export type TaskQuantumContext = Pick<Engine, 'adapter' | 'cleanContext' | 'enqueueTitle' | 'hooks' | 'launchAgent' | 'launchProofOnly' | 'note' | 'noteStepFailure' | 'prerequisiteWaitYieldsToLiveWork' | 'profileCatalogKnown' | 'profiles' | 'quantumFinish' | 'quantumSteps' | 'reconcile' | 'reconcileBlockedEffects' | 'reconcileClosedRetainedReviewer' | 'recover' | 'routeTask' | 'settleFinishedRuns' | 'settleHistoricalProofExecutions' | 'settleRunBuildOutputs' | 'settleSupersededIdleRuns' | 'signoffDecisions' | 'stopped' | 'store' | 'wakeRepository'> & { readonly resolution: Pick<Resolution, 'advance' | 'beginValidationScanPass' | 'holdProofOnlyGoWait' | 'ownedToolHold' | 'owns' | 'raiseOperatorQuestions' | 'reconcileHoldUntil' | 'recordStop' | 'recoverExternalMerge' | 'recovery' | 'resumeClearedAttention' | 'settleBudgetClock'> };

export class TaskQuantum {
  constructor(readonly context: TaskQuantumContext) {}
  private async applyApprovedRoutes(taskId: string): Promise<void> {
    if (!this.context.profileCatalogKnown()) return;
    const routes = reconcileRoutingSignoffs(this.context.store, this.context.signoffDecisions, taskId, this.context.profiles);
    for (const route of routes) {
      const task = this.context.store.task(taskId);
      const run = async (replaceNow: boolean) => this.context.routeTask({ taskId, version: this.context.store.task(taskId).version,
        action: 'route', role: route.role, profileId: route.profileId, reason: route.reason,
        caller: `decision ${route.decisionId}`, ...(replaceNow ? { now: true } : {}) });
      try {
        await run(route.now);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (route.now) {
          this.context.store.event(task.id, 'routing_signoff_live_route_refused', JSON.stringify({ role: route.role,
            profileId: route.profileId, decisionId: route.decisionId, reason: detail }));
          try { await run(false); }
          catch (fallbackError) { this.context.noteStepFailure(taskId, fallbackError); }
        } else this.context.noteStepFailure(taskId, error);
      }
    }
  }
  prerequisiteWaitYieldsToLiveWork(task: Task): boolean {
    if (task.resolution.recoveryActive) return true;
    const runs = this.context.store.runs(task.id);
    if (runs.some(run => !run.released)) return true;
    const current = task.resolution.currentRunId ? this.context.store.run(task.resolution.currentRunId) : null;
    if (current?.completion) return true;
    return taskHasUnreleasedRun(task, false);
  }

  async taskQuantum(taskId: string): Promise<void> {
    let task = this.context.store.task(taskId);
    if (this.context.profileCatalogKnown()) {
      await this.applyApprovedRoutes(taskId);
      try { task = this.context.store.task(taskId); } catch { return; }
    }
    const quantum = { pausedForPrerequisiteWait: false };
    // One pass, one worktree-validation scan: every read this quantum makes for
    // the same task worktree and selector argv shares it, and the next quantum
    // reads again (task 450).
    this.context.resolution.beginValidationScanPass();
    try {
      await this.context.quantumSteps(taskId, task, quantum);
    } finally {
      if (!quantum.pausedForPrerequisiteWait) await this.context.quantumFinish(taskId);
    }
  }

  async quantumSteps(taskId: string, task: Task, quantum: { pausedForPrerequisiteWait: boolean }): Promise<void> {
    try {
      if (task.directory && onCheckoutVolume(task.directory))
        await this.context.adapter.preflightWorkspaceStorage?.(task);
      if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt) {
        const wait = this.context.store.reconcilePrerequisiteWait(task.id);
        if (wait !== "none" && !this.context.prerequisiteWaitYieldsToLiveWork(this.context.store.task(task.id))) {
          quantum.pausedForPrerequisiteWait = true;
          return;
        }
      }
      // Spec 046: a self-lifting hold ends by itself once its condition is met, before
      // anything in this pass acts on the held task. Re-read so the pass sees the release.
      const fences = holdsOf(task);
      if ((fences.dispatch?.until || fences.merge?.until || task.holdUntil) && this.context.resolution.reconcileHoldUntil(task.id) === "auto_released") {
        task = this.context.store.task(taskId);
        if (task.phase === "queued") this.context.cleanContext(() => { void this.context.wakeRepository(task.repoPath); });
      }
      // Settle finished runs before anything that can skip a task, so a recorded completion
      // is never left holding a lane. Pause defers this path so a recovery escalate stays
      // stored. A reported unreleased thread reaches release in Observation (nucleus#937).
      this.context.settleFinishedRuns(task);
      if (isDispositionActive(this.context.store.task(task.id))) return;
      // Queue #342: settle finished runs' regenerable output before any launch below, in the task's serial lane.
      await this.context.settleRunBuildOutputs(task.id);
      const pendingStallStop=this.context.store.task(task.id).resolution.stalledTurnStop;
      if(pendingStallStop&&pendingStallStop.status!=='completed'){
        const stoppedRun=pendingStallStop.role==='worker'?null:this.context.store.run(pendingStallStop.runId);
        const targetComplete=pendingStallStop.role==='worker'
          ? this.context.store.task(task.id).completion?.runId===pendingStallStop.runId
          : stoppedRun?.completion?.runId===pendingStallStop.runId;
        const sameTarget=pendingStallStop.role==='worker'
          ? this.context.store.task(task.id).runId===pendingStallStop.runId
          : this.context.store.task(task.id).resolution.currentRunId===pendingStallStop.runId;
        if(sameTarget&&!targetComplete){
          if(pendingStallStop.role==='worker'&&this.context.store.task(task.id).agentId)await this.context.reconcile(this.context.store.task(task.id));
          return;
        }
        if(!sameTarget&&!targetComplete){
          const reason=`Stalled-turn stop for ${pendingStallStop.role} run ${pendingStallStop.runId} no longer matches the task's assigned run; owner inspection is required`;
          if(this.context.store.task(task.id).reason!==reason)this.context.store.update(task.id,{reason},'stalled_turn_binding_changed',reason);
          return;
        }
      }
      if (task.phase === 'needs_attention' && task.completion?.status === 'ready_for_review' && task.workspaceId &&
        this.context.adapter.workspaceAvailable && !await this.context.adapter.workspaceAvailable(task.workspaceId)) {
        await this.context.resolution.advance(task); return;
      }
      const probeExternalMerge = occupiesSlot(task, this.context.store.runs(task.id)) || !recoveryCapacityFor(task, this.context.store.activeCapacityTasks(), this.context.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT, this.context.store.projectDispatchLimitFor(task),this.context.store.papercutDispatchPolicy());
      if (probeExternalMerge) {
        if (await this.context.resolution.recoverExternalMerge(task)) return;
        // The probe may have restored the pre-attention phase and reason it found on
        // a cleared external-merge-check strand; re-read so this pass advances it.
        task = this.context.store.task(taskId);
      }
      // Project-a #1837: a restart can leave the flag cleared on a recorded pre-attention
      // state. Restore it so the ordinary resolution path advances instead of idling.
      const resumed = this.context.resolution.resumeClearedAttention(task);
      if (resumed) task = resumed;
      if (this.context.resolution.owns(task)) { await this.context.resolution.advance(task); return; }
      const hookState = await this.context.hooks.reconcileTask(this.context.store.task(task.id));
      if (hookState.hold) { this.context.note(task.id, hookHoldReason(hookState), 'operator_needed', "needs_attention"); return; }
      if (task.workspaceIntent && !task.workspaceId || task.agentIntent && !task.agentId) await this.context.recover(task);
      else if (task.agentId && (["working", "needs_attention", "dispatching"].includes(task.phase)
        || !task.completion && ["blocked", "error"].includes(task.phase))) await this.context.reconcile(this.context.store.task(task.id));
      else if (task.workspaceId && !task.agentIntent && (task.phase === "dispatching" || task.phase === "needs_attention" && task.retiredWorkers.length > 0) && !startsNoRuns(this.context.store)) {
        const current = this.context.store.task(task.id);
        if (current.entrypoint === 'proof' && current.proofOnly) await this.context.launchProofOnly(current);
        else await this.context.launchAgent(current);
      }
    } catch (error) {
      this.context.noteStepFailure(task.id, error);
    }
  }

  async quantumFinish(taskId: string): Promise<void> {
    if (!this.context.stopped) {
      try {
        let current = this.context.store.task(taskId);
        // Spec 058 budgets (nucleus#1153): this pass is where every live task is
        // observed, so the wall clock's pause intervals are settled here first —
        // a task held on a Nucleus-side cause must not spend its budget on it.
        current = this.context.resolution.settleBudgetClock(current, { returned: true });
        // A budget stop always asks its question (nucleus#1153). Asking from the
        // task's own pass means a phase that records the stop, a task host that is
        // offline and a support step that failed earlier in the sweep cannot leave
        // the pause silent; the recorded intent still makes the raise idempotent.
        if (current.resolution.stop?.reason === 'budget' && !current.removedAt && !this.context.store.getMeta('paused'))
          await this.context.resolution.raiseOperatorQuestions(taskId);
        current = this.context.store.task(taskId);
        // effigy#697: a release-GO wait is the operator's whatever a later write did to the stop.
        if (!current.removedAt && this.context.resolution.holdProofOnlyGoWait(current)) current = this.context.store.task(taskId);
        if (!this.context.store.getMeta("paused") && !current.resolution.stop && !current.removedAt && (current.originError&&!missingOriginHasPlanner(this.context.store,current) || current.resolution.attention
          || ["blocked", "error", "needs_attention"].includes(current.phase))) {
          // Only Queue's own origin error text is classified. A task reason can
          // be an agent's report, and reading a wait out of it invents one.
          const detail = current.originError || current.reason || "Task needs attention";
          const classification = current.originError ? taskStopClassification(detail) : { reason: "operator_needed" as const, suggestedVerbs: taskStopVerbsFor("operator_needed") };
          current = this.context.resolution.recordStop(current, classification.reason, detail, classification.suggestedVerbs);
        }
        // Spec 052 sign-off: ask, apply or withdraw the operator's routing decisions.
        if (this.context.profileCatalogKnown()) await this.applyApprovedRoutes(taskId);
        // A checkpointed reviewer whose own agent was positively observed
        // closed can never receive its same-run continuation. Record that
        // terminal observation before recovery reads the task, so neither
        // `next` nor the coordinator advertises an impossible continuation.
        await this.context.reconcileClosedRetainedReviewer(taskId);
        // Task 560: a superseded executor's still-running record settles
        // from its own timeline before the release sweep reads it, so
        // history is truthful at rest; a late report still upgrades it.
        await this.context.settleHistoricalProofExecutions(taskId, "reconciler historical proof settlement");
        // Nucleus#1159: later task evidence answers an uncertain host effect, and
        // a phase still blocked on one past its bound becomes attention rather
        // than staying the quiet wait nobody sees.
        this.context.reconcileBlockedEffects(taskId);
        // Superseded idle runs release before recovery observes: a stale
        // run whose episode was cleared must not hold the recovery busy
        // wait or fence the next dispatch. Holds write nothing, so a pass
        // with nothing settleable leaves the task untouched.
        await this.context.settleSupersededIdleRuns(taskId, "reconciler superseded-idle settlement");
        // Recovery.pass records fresh idle observations while paused but
        // gates every action after the observation. The task stop and any
        // coordinator dispatch remain untouched until resume.
        await this.context.resolution.recovery.pass(taskId);
        current = this.context.store.task(taskId);
        if (!this.context.store.getMeta("paused") && !current.removedAt && (current.resolution.stop || current.originError&&!missingOriginHasPlanner(this.context.store,current)))
          await this.context.resolution.recovery.route(current);
      } catch (error) { this.context.noteStepFailure(taskId, error); }
    }
    await archiveFinishedThreads(this.context.store, this.context.adapter, taskId, async (agentId, workspaceId) => {
      const task = this.context.store.task(taskId), runs = this.context.store.runs(taskId);
      const runIds = participantToolRunIds(task, runs, agentId, workspaceId);
      return this.context.resolution.ownedToolHold(agentId, { requireCompleteEvidence: true, runId: runIds[0], runIds, taskId, workspaceId });
    }).catch(error => {
      this.context.store.event(taskId, 'thread_archive_reconcile_error', String(error));
    });
    // A superseded worker is archived straight away (nucleus#1181), not at
    // closeout: its replacement already runs on a new thread, and the old one
    // must leave T3's main list. T3-only; Paseo keeps its existing handling.
    await archiveSupersededWorkers(this.context.store, this.context.adapter, taskId).catch(error => {
      this.context.store.event(taskId, 'thread_archive_reconcile_error', String(error));
    });
    // Title projection is enqueued on its own serial lane: a slow Paseo
    // rename can never hold this task's delivery lane.
    this.context.enqueueTitle(taskId);
  }
}
