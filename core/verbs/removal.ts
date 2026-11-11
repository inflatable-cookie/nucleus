import { REMOVED_TASK_REFUSAL } from './control-refusals';
import { isDeepStrictEqual } from "node:util";
import type { Run, Task } from "../../shared/contracts";
import { isDispositionActive } from "../../shared/contracts";
import { cleanupReasonFor, recordRunBuildOutput } from "../hooks/build-output-records";
import { progressDisposition } from "./disposition";
import type { Engine } from "../engine";
import { LANE_PRIORITY_TASK } from "../scheduling/lane-priorities";
import { blockingRecoveryEffectsRefusal } from "../recovery/recovery-effects";
import { digest, hostRunHoldReason, now } from "../store/store";
import { canRetireCancelledWorkspace } from "../workspaces/terminal-workspace-retirement";
import { archiveUnusedWorkspace } from "../workspaces/unused-workspace";
import { buildOutputCheckoutMismatch, removeBuildOutput, type BuildOutputCleanupResult } from "../workspaces/worktree-cleanup";

/**
 * Taking a task off the board and clearing what a finished run leaves in its
 * workspace: operator removal, the runtime-retirement and build-output retries,
 * and run-bound build output settlement. Same-name `Engine` methods delegate here.
 */
export class TaskRemoval {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  /**
   * The refusals a removal owes from stored facts, before it observes any host
   * (#927). `null` means the removal may proceed; an already-removed task is
   * answered by its own record, so it is not a refusal.
   */
  localRefusal(id: string, version: number): string | null {
    let task: Task;
    try { task = this.store.task(id); } catch { return null; }
    if (task.removedAt) return null;
    try { this.assertRemovable(task, version); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  /** The same gates the handler makes before its first host observation. */
  private assertRemovable(task: Task, version: number): void {
    this.engine.requireOwnerControlCurrent(task, version, "Task changed; refresh before retrying");
    if (!["queued", "blocked", "error", "needs_attention", "cancelled", "done"].includes(task.phase)) throw new Error("Wait for the task to stop before removing it");
    if (task.reviewEntry) throw new Error("Review-entry workspaces are preserved; resolve and close out this task, then let history retention remove it");
    const runs = this.store.runs(task.id);
    if (task.workspaceIntent && !task.workspaceId || task.agentIntent && !task.agentId || runs.some(r => !r.released) || task.resolution.mergeIntent && !task.resolution.mergedCommit)
      throw new Error("Resolve uncertain creation, retained runs or merge state before removing this task");
  }
  async removeTask(id: string, version: number): Promise<Task> {
    // Serialize operator removal with dispatch, reconciliation and notice delivery.
    return this.engine.control(async () => {
      const task = this.store.task(id);
      // Removal is terminal: an already-removed task returns as removed whatever
      // version the caller holds, so replaying a removal is always idempotent.
      if (task.removedAt) return task;
      this.assertRemovable(task, version);
      const runs = this.store.runs(id);
      const ids = new Set([task.agentId, task.coordinatorAgentId, task.resolution.reviewerAgentId,
        ...task.retiredWorkers.map(w => w.agentId), ...runs.map(r => r.agentId)].filter((x): x is string => Boolean(x)));
      for (const agentId of ids) {
        try {
          const state = await this.engine.host.observe(agentId);
          if (state.active || state.permissions || !["idle", "error", "closed"].includes(state.status)) throw new Error("A task thread is still active; let it stop before removing the task");
        } catch (error) {
          // The adapter distinguishes a deleted thread from a connection failure.
          if (!(error instanceof Error) || error.message !== "Agent was not found") throw error;
        }
      }
      for (const agentId of ids) await this.engine.host.archiveAgent(agentId);
      await this.engine.removeSiblings(id);
      if (task.workspaceId && task.directory) {
        if (!this.engine.adapter.archiveTaskWorkspace) throw new Error("Workspace cleanup is unavailable; task remains visible");
        const shared = () => this.store.tasks().some(other => other.id !== task.id && other.workspaceId === task.workspaceId);
        if (shared()) throw new Error("Workspace is referenced by another task");
        await this.engine.retirement.capture(id, task.workspaceId, task.directory);
        const archived = await this.engine.adapter.archiveTaskWorkspace(task, task.workspaceId, task.directory, "", () => {
          if (shared()) return false;
          this.engine.resolution.update(this.store.task(id), { archiveIntentWorkspaceId: task.workspaceId, archiveIntentHead: null }, {}, "workspace_archive_intent");
          return true;
        }, false, true, ids);
        if (!archived) throw new Error("Workspace became shared before archive; task remains visible");
        await this.engine.retirement.archived(id, task.workspaceId);
      }
      return this.store.transaction(() => {
        const removed = this.store.update(id, { removedAt: now() }, "removed", "Removed from queue by operator; history retained", this.store.task(id).version);
        for (const runId of [task.runId, ...task.retiredWorkers.map(w => w.runId), ...runs.map(r => r.id)].filter(Boolean)) this.store.deleteCredential(runId!);
        for (const notice of this.store.notices(id)) if (notice.status === "pending") this.store.putNotice({ ...notice, status: "superseded" });
        return removed;
      });
    }, `task:${id}`);
  }
  /**
   * Operator request: retry a failed Effigy runtime retirement now with the same
   * `effigy container retire --scope <token> --yes`. An unfinished filesystem
   * effect retries its recorded archive path first, even with a captured scope.
   */
  async retryRuntimeRetirement(taskId: string, version: number): Promise<Task> {
    const task = this.store.task(taskId);
    if (task.removedAt) throw new Error(REMOVED_TASK_REFUSAL);
    this.engine.requireOwnerControlCurrent(task, version, "Task changed; refresh before retrying");
    if (!task.resolution.runtimeRetirements.some(record => record.state === "failed"))
      throw new Error("This task has no failed runtime retirement to retry");
    // A scope proof cannot stand in for an unfinished filesystem effect.
    // Finish archive first; that path proves the captured scope after teardown.
    let retryTaskArchive = false;
    const failedArchives = task.resolution.runtimeRetirements.filter(record => record.state === "failed" &&
      !task.resolution.archivedWorkspaceIds.includes(record.workspaceId) &&
      !(task.disposition?.workspaceArchived && task.workspaceId === record.workspaceId) &&
      this.store.getMeta<{ status?: string }>(`unusedWorkspaceArchive:${taskId}:${record.workspaceId}`)?.status !== "archived");
    for (const record of task.resolution.runtimeRetirements) {
      if (record.state === "failed" && !failedArchives.some(archive => archive.workspaceId === record.workspaceId))
        await this.engine.retirement.archived(taskId, record.workspaceId);
    }
    for (const record of failedArchives) {
      const current = this.store.task(taskId);
      if (current.resolution.archivedWorkspaceIds.includes(record.workspaceId)) continue;
      const unusedArchive = this.store.getMeta<{ status?: string }>(`unusedWorkspaceArchive:${taskId}:${record.workspaceId}`);
      if (unusedArchive?.status === "intent") {
        await archiveUnusedWorkspace(this.store, this.engine.adapter, {
          taskId, version: current.version, unusedWorkspaceId: record.workspaceId,
        }, () => !this.engine.stopped, this.engine.retirement, target => this.engine.retentionHold(taskId, target, "Unused workspace cleanup"));
      } else if (current.resolution.workspaceRetirement?.workspaceId === record.workspaceId && canRetireCancelledWorkspace(current)) {
        await this.engine.settleWorkspaceRetirement(taskId);
      } else {
        // An explicit owner retry outranks the automatic archive backoff (commit
        // 01f949e0): the failure that flagged this runtime retirement also left a
        // `workspaceArchiveRetries` record whose next attempt may be an hour away, so
        // without this an operator `retry_effect` would silently do nothing. This is
        // the same clearing the merged-task retention retry applies.
        this.engine.lifecycle.retentionReconciled(taskId, record.workspaceId);
        retryTaskArchive = true;
      }
    }
    if (retryTaskArchive) {
      this.engine.enqueueCleanup(taskId);
      await this.engine.drainCleanup();
    }
    return this.store.task(taskId);
  }
  /** Reopen a cancelled disposition only to retry a previously skipped, proven-empty workspace cleanup. */
  async retryBuildOutputCleanup(taskId: string, version: number): Promise<Task> {
    let task = this.store.task(taskId);
    if (task.removedAt) throw new Error(REMOVED_TASK_REFUSAL);
    const retryMarkers = task.disposition?.effects.filter(effect => effect.kind === "retry_build_output_cleanup" && effect.target === task.workspaceId) ?? [];
    const pendingRetry = retryMarkers.at(-1)?.result === null;
    if (task.version !== version && !pendingRetry) {
      if (retryMarkers.length) return task;
      throw new Error("Task changed; refresh before retrying");
    }
    if (!pendingRetry) {
      if (task.phase !== "cancelled" || task.disposition?.status !== "complete" || task.disposition.workDisposition !== "archive_if_empty" || task.disposition.workspaceArchived || !task.workspaceId)
        throw new Error("Build output cleanup retry requires a cancelled task with an unarchived archive-if-empty workspace");
      const cleanup = task.resolution.buildOutputCleanups.find(record => record.workspaceId === task.workspaceId && !record.runId);
      if (cleanup?.state !== "skipped") throw new Error("This task has no skipped build output cleanup to retry");
      const effects = [...task.disposition!.effects, { kind: "retry_build_output_cleanup", target: task.workspaceId, intentAt: now(), result: null, resultAt: null, uncertain: false }];
      task = this.store.update(task.id, { disposition: { ...task.disposition, status: "preserving", completedAt: null, attention: "", effects } }, "build_output_cleanup_retry_requested", "Operator requested a fresh clean, published-head, idle-thread proof before retrying the skipped workspace cleanup");
    }
    if (task.disposition?.status !== "complete") task = await progressDisposition(this.store, this.engine.dispositionDeps(), task.id);
    const current = this.store.task(task.id);
    const index = current.disposition?.effects.findLastIndex(effect => effect.kind === "retry_build_output_cleanup" && effect.target === current.workspaceId && effect.result === null) ?? -1;
    if (index < 0 || !current.disposition) return current;
    const resultCleanup = current.resolution.buildOutputCleanups.find(record => record.workspaceId === current.workspaceId && !record.runId);
    const complete = current.disposition.workspaceArchived || resultCleanup?.state === "complete";
    const reason = current.disposition.status === "needs_attention"
      ? current.disposition.attention || "workspace cleanup needs attention"
      : resultCleanup?.state === "skipped" ? resultCleanup.detail : current.disposition.workspaceEvidence;
    const effects = [...current.disposition.effects];
    effects[index] = { ...effects[index], result: complete ? "Workspace cleanup retry completed" : `Workspace cleanup retry did not remove the output: ${reason}`, resultAt: now(), uncertain: current.disposition.status === "needs_attention" || resultCleanup?.state === "uncertain" };
    return this.store.update(current.id, { disposition: { ...current.disposition, effects } }, "build_output_cleanup_retry_result", effects[index].result!);
  }
  /**
   * Queue #342: a finished run's task-local Cargo output is removed once its
   * result is recorded, its agent is observably settled and no later run in the
   * workspace is unreleased. Installed node_modules stay for the next continuation.
   * Runs in the task lane before any run launches, so the next actor cannot
   * write while a removal is in progress. A held or
   * unsafe root keeps its record and reason; source, history and receipts are
   * never touched.
   */
  async settleRunBuildOutputs(taskId: string): Promise<void> {
    for (const pending of this.store.task(taskId).resolution.buildOutputCleanups) {
      if (!pending.runId || pending.state !== "intent" && pending.state !== "uncertain") continue;
      if (this.engine.stopped || this.store.getMeta("paused")) return;
      const task = this.store.task(taskId);
      if (task.removedAt || isDispositionActive(task)) return;
      const record = task.resolution.buildOutputCleanups.find(item => item.runId === pending.runId && item.workspaceId === pending.workspaceId);
      if (!record || record.state !== "intent" && record.state !== "uncertain") continue;
      let hold: string | null;
      try { hold = await this.engine.runBuildOutputHold(task, record); }
      // A failed observation leaves the record as it is; the next pass observes again.
      catch { continue; }
      if (hold) { this.engine.recordRunBuildOutputState(taskId, record, record.state, hold); continue; }
      if (this.engine.stopped || this.store.getMeta('paused')) return;
      // The hold's observations await; a host run admitted meanwhile still owns the
      // checkout, so recheck synchronously at the removal boundary (review #564).
      const lateHostRun = this.store.hostRunHoldingWorkspace(record.directory);
      if (lateHostRun) { this.engine.recordRunBuildOutputState(taskId, record, record.state, hostRunHoldReason(lateHostRun)); continue; }
      let result: BuildOutputCleanupResult;
      // Queue #342 (node_modules superseded, 2026-10-20): run-bound settlement never removes installed dependencies; terminal cleanup does.
      try { result = await removeBuildOutput(record.directory, { keepDependencies: true }); }
      catch (error) {
        this.engine.recordRunBuildOutputState(taskId, record, "uncertain", `Build output cleanup is uncertain: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      this.engine.recordRunBuildOutputState(taskId, record, result.safe ? "complete" : "skipped", result.detail);
    }
  }
  /** Task-lane entry for a terminal task whose run-bound records still owe a settlement; one pending pass per task. */
  scheduleRunBuildOutputs(taskId: string): Promise<void> {
    const pending = this.runBuildOutputQueued.get(taskId);
    if (pending) return pending;
    const work = this.engine.scheduleLane(`task:${taskId}`, LANE_PRIORITY_TASK, async () => {
      const task = this.store.task(taskId);
      if (!task.hostId) return;
      await this.engine.withHost(task.hostId, async () => {
        if (!this.engine.taskHostAvailable(task)) return;
        await this.engine.settleRunBuildOutputs(taskId);
        const retirement = this.store.task(taskId).resolution.workspaceRetirement;
        if (retirement && ['authorized', 'intent', 'uncertain'].includes(retirement.state)) await this.engine.settleWorkspaceRetirement(taskId);
      });
    });
    this.runBuildOutputQueued.set(taskId, work);
    void work.finally(() => { if (this.runBuildOutputQueued.get(taskId) === work) this.runBuildOutputQueued.delete(taskId); }).catch(() => {});
    return work;
  }
  private readonly runBuildOutputQueued = new Map<string, Promise<void>>();
  /**
   * Why a run-bound record must stay put, or null when its output is settled.
   * Every observation happens before the final synchronous unreleased-run check,
   * so nothing can launch between that check and the removal that follows.
   */
  async runBuildOutputHold(task: Task, record: Task["resolution"]["buildOutputCleanups"][number]): Promise<string | null> {
    const runId = record.runId!;
    const run = this.store.run(runId);
    if (run) {
      if (!run.released) return `run ${runId} is not released yet`;
    } else {
      // An author's result has no run record: it settles once applied, or once a newer task run has superseded it.
      const applied = task.completion?.runId === runId && !["queued", "dispatching", "working", "needs_attention"].includes(task.phase);
      const superseded = task.runId !== runId && !task.agentIntent && !["queued", "dispatching", "working"].includes(task.phase);
      const completion = task.completion;
      const revision = completion && completion.runId !== runId ? this.store.run(completion.runId) : null;
      const receipt = completion ? this.store.db.prepare('SELECT rowid AS sequence, hash FROM receipts WHERE id=? AND task=? AND run=?')
        .get(completion.eventId, task.id, completion.runId) as { sequence: number; hash: string } | undefined : undefined;
      const authorReceipt = this.store.db.prepare('SELECT rowid AS sequence FROM receipts WHERE task=? AND run=? ORDER BY rowid LIMIT 1')
        .get(task.id, runId) as { sequence: number } | undefined;
      const terminal = task.phase === 'done' || task.phase === 'cancelled' && task.disposition?.status === 'complete';
      const laterApplied = terminal && revision?.taskId === task.id && revision.role === 'revision' && revision.released
        && revision.status === 'finished' && revision.workspaceId === record.workspaceId
        && authorReceipt && receipt && receipt.sequence > authorReceipt.sequence && completion?.status === 'ready_for_review'
        && isDeepStrictEqual(revision.completion, completion) && receipt?.hash === digest(JSON.stringify(completion));
      if (!applied && !superseded && !laterApplied) return `author result ${runId} is not applied yet`;
    }
    const busy = this.engine.unreleasedRunIn(record.workspaceId);
    if (busy) return busy;
    const hostRun = this.store.hostRunHoldingWorkspace(record.directory);
    if (hostRun) return hostRunHoldReason(hostRun);
    const agentId = run?.agentId ?? record.agentId ?? null;
    if (!agentId) return "no agent is bound to the run";
    const identity = await buildOutputCheckoutMismatch(task.repoPath, record.directory);
    if (identity) return identity;
    const fence = await this.engine.supersededIdleFence({ id: runId, taskId: task.id, agentId, workspaceId: record.workspaceId } as Run);
    if (fence) return fence;
    try { await this.engine.workspaceParticipantsIdle(task, record.workspaceId); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    if (this.store.workspaceUsedByOtherTaskRun(task.id, record.workspaceId) || this.store.tasks().some(other => other.id !== task.id
      && (other.workspaceId === record.workspaceId || other.directory === record.directory
        || other.resolution.coordinatorWorkspaceId === record.workspaceId || other.resolution.closeoutWorkspaceId === record.workspaceId)))
      return 'workspace is referenced by another task';
    const lateHostRun = this.store.hostRunHoldingWorkspace(record.directory);
    if (lateHostRun) return hostRunHoldReason(lateHostRun);
    return this.engine.unreleasedRunIn(record.workspaceId);
  }
  unreleasedRunIn(workspaceId: string): string | null {
    const row = this.store.db.prepare(`SELECT runs.data FROM runs JOIN tasks ON tasks.id=runs.taskId
      WHERE json_extract(tasks.data,'$.removedAt') IS NULL AND json_extract(runs.data,'$.workspaceId')=?
      AND COALESCE(json_extract(runs.data,'$.released'),0)=0 LIMIT 1`).get(workspaceId);
    const run = row ? JSON.parse(String(row.data)) as Run : null;
    return run ? `run ${run.id} is unreleased in this workspace` : null;
  }
  async workspaceParticipantsIdle(task: Task, workspaceId: string): Promise<ReadonlySet<string>> {
    if (task.agentIntent && !task.agentId) throw Error('Worker creation is unresolved');
    const participants = new Map<string, string>();
    const runs = this.store.runs(task.id);
    for (const run of runs.filter(run => run.workspaceId === workspaceId)) {
      if (!run.agentId) throw Error(`Run ${run.id} has no observable participant`);
      // One retained agent can own several runs; an older unknown effect
      // must not disappear when the participant map keeps its newer run ID.
      const refusal = blockingRecoveryEffectsRefusal(this.store, task, { runId: run.id });
      if (refusal) throw Error(refusal);
      participants.set(run.agentId, run.id);
    }
    if (task.workspaceId === workspaceId) {
      if (task.agentId) participants.set(task.agentId, task.runId ?? '');
      for (const worker of task.retiredWorkers) participants.set(worker.agentId, worker.runId);
      // The retained reviewer can live in a pinned review view. Its run binds
      // that workspace; the legacy fallback applies only without a run binding.
      if (task.resolution.reviewerAgentId && !participants.has(task.resolution.reviewerAgentId)
        && !runs.some(run => run.agentId === task.resolution.reviewerAgentId))
        participants.set(task.resolution.reviewerAgentId, '');
    }
    if (task.coordinatorAgentId && task.resolution.coordinatorWorkspaceId === workspaceId && !participants.has(task.coordinatorAgentId)) participants.set(task.coordinatorAgentId, '');
    for (const [agentId, id] of participants) {
      const fence = await this.engine.supersededIdleFence({ id, taskId: task.id, agentId, workspaceId } as Run);
      if (fence) throw Error(`Participant ${agentId}: ${fence}`);
    }
    const busy = this.engine.unreleasedRunIn(workspaceId);
    if (busy) throw Error(busy);
    return new Set(participants.keys());
  }
  recordRunBuildOutputState(taskId: string, record: Task["resolution"]["buildOutputCleanups"][number], state: "intent" | "complete" | "skipped" | "uncertain", detail: string) {
    const task = this.store.task(taskId);
    const current = task.resolution.buildOutputCleanups.find(item => item.runId === record.runId && item.workspaceId === record.workspaceId);
    if (current?.state === state && current.detail === detail) return;
    const cleanups = recordRunBuildOutput(task.resolution.buildOutputCleanups, record.runId!, record.workspaceId, state, detail, now());
    this.store.update(taskId, { resolution: { ...task.resolution, buildOutputCleanups: cleanups, cleanupReason: cleanupReasonFor(task.resolution.cleanupReason, cleanups) } }, `run_build_output_${state}`, `Run ${record.runId}: ${detail}`);
  }
}
