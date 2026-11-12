import { deciderThreadOwners, terminalThreadCleanup } from '../workspaces/thread-archive';
import type { Run, Task } from '../../shared/contracts';
import type { Engine } from '../engine';
import type { Resolution } from '../resolution';
import type { GitTransientEpisode } from '../git/git-transient-backoff';
import { dispatchBlocked, occupiesSlot } from '../dispatch/capacity';
import { settlementHeld } from './queue-drain';
import { archiveProbeKey } from '../workspaces/thread-archive';

export type CompletionFollowUpsContext = Pick<Engine, 'cleanContext' | 'enqueueCleanup' | 'scheduleCompletionFollowUp' | 'scheduleLifecycleFollowUp' | 'scheduleRunBuildOutputs' | 'scheduleTerminalArchiveRetry' | 'stopped' | 'store' | 'terminalThreadsPending' | 'transientKey' | 'wakeCapacityWaiter' | 'wakeIntegrationSuccessor' | 'wakeTask'> & {
  readonly resolution: Pick<Resolution, 'holdsIntegrationTurn' | 'integrationActive'>;
};

const LIFECYCLE_FOLLOW_UP_PHASES = new Set(['awaiting_review', 'reviewing', 'changes_requested', 'verifying', 'merging', 'syncing', 'closing', 'blocked', 'error']);

/** Named post-quantum follow-ups in the order the quantum performs them. */
export type QuantumFollowUp = 'clear_transient' | 'wake_capacity' | 'completion' | 'terminal_archive' | 'cleanup' | 'lifecycle' | 'wake_integration';

export function quantumFollowUps(facts: {
  transientBefore: GitTransientEpisode | null;
  transientUnchanged: boolean;
  phaseChanged: boolean;
  syncedCommitChanged: boolean;
  currentRunIdChanged: boolean;
  occupiedBefore: boolean;
  occupiedAfter: boolean;
  afterPhase: string;
  threadsPending: boolean;
  beforePhase: string;
  threadWorkBefore: boolean;
  launched: boolean;
  progressChanged: boolean;
  attention: boolean;
  recoveryActive: boolean;
  dispatchBlocked: boolean;
  heldIntegration: boolean;
  hadIntegrationTurn: boolean;
  integrationActiveBefore: boolean;
  holdsIntegrationAfter: boolean;
}): QuantumFollowUp[] {
  const followUps: QuantumFollowUp[] = [];
  if (facts.transientBefore && (facts.phaseChanged || facts.syncedCommitChanged || facts.currentRunIdChanged) && facts.transientUnchanged)
    followUps.push('clear_transient');
  if (facts.occupiedBefore && !facts.occupiedAfter) followUps.push('wake_capacity');
  followUps.push('completion', 'terminal_archive');
  if (facts.afterPhase === 'done' && !facts.threadsPending && (facts.beforePhase !== 'done' || facts.threadWorkBefore))
    followUps.push('cleanup');
  if (!facts.launched && facts.progressChanged && LIFECYCLE_FOLLOW_UP_PHASES.has(facts.afterPhase)
    && !facts.attention && !facts.recoveryActive && !facts.dispatchBlocked)
    followUps.push('lifecycle');
  if ((facts.heldIntegration || facts.hadIntegrationTurn && !facts.integrationActiveBefore) && !facts.holdsIntegrationAfter)
    followUps.push('wake_integration');
  return followUps;
}

/** Terminal follow-through stays synchronous in the task quantum; timers only wake its lane. */
export class CompletionFollowUps {
  constructor(readonly engine: CompletionFollowUpsContext) {}
  get store() { return this.engine.store; }
  get resolution() { return this.engine.resolution; }
  private readonly completionFollowUps = new Map<string, { key: string; attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  /** Replaceable by tests; five follow-ups over 62 seconds, then the safety sweep owns recovery. */
  completionFollowUpDelays = [2000, 4000, 8000, 16000, 32000];
  private readonly terminalArchiveFollowUps = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  finishQuantum(taskId: string, before: Task, beforeRuns: Run[], transientBefore: GitTransientEpisode | null | undefined,
    heldIntegration: boolean, threadWorkBefore: boolean, occupied: boolean): void {
      const after = this.store.task(taskId);
      const afterRuns = this.store.runs(taskId);
      const progress = (task: Task, runs: Run[]) => JSON.stringify([task.phase, task.resolution.currentRunId,
        task.resolution.mergeIntent, task.resolution.mergeResponseOutcome, task.resolution.mergedCommit, task.resolution.syncedCommit,
        task.resolution.buildOutputCleanups.map(item => [item.runId, item.workspaceId, item.state]),
        runs.map(run => [run.id, run.released, run.completion?.reviewId, run.completion?.reviewCommentId])]);
      const launched = afterRuns.some(run => !beforeRuns.some(previous => previous.id === run.id) && !run.released && !run.completion);
      const phaseChanged = after.phase !== before.phase;
      const syncedCommitChanged = after.resolution.syncedCommit !== before.resolution.syncedCommit;
      const currentRunIdChanged = after.resolution.currentRunId !== before.resolution.currentRunId;
      const hadIntegrationTurn = Boolean(before.resolution.integrationTurn);
      const integrationActiveBefore = !heldIntegration && hadIntegrationTurn && this.resolution.integrationActive(before);
      const wakeIntegration = heldIntegration || hadIntegrationTurn && !integrationActiveBefore;
      for (const follow of quantumFollowUps({
        transientBefore: transientBefore ?? null,
        transientUnchanged: !(transientBefore && (phaseChanged || syncedCommitChanged || currentRunIdChanged))
          || JSON.stringify(this.store.getMeta(this.engine.transientKey(taskId))) === JSON.stringify(transientBefore),
        phaseChanged, syncedCommitChanged, currentRunIdChanged,
        occupiedBefore: occupied,
        occupiedAfter: occupiesSlot(after, afterRuns),
        afterPhase: after.phase,
        threadsPending: this.engine.terminalThreadsPending(after, afterRuns),
        beforePhase: before.phase,
        threadWorkBefore,
        launched,
        progressChanged: progress(before, beforeRuns) !== progress(after, afterRuns),
        attention: after.resolution.attention,
        recoveryActive: after.resolution.recoveryActive,
        dispatchBlocked: dispatchBlocked(after),
        heldIntegration,
        hadIntegrationTurn,
        integrationActiveBefore,
        holdsIntegrationAfter: wakeIntegration && this.resolution.holdsIntegrationTurn(after),
      })) {
        switch (follow) {
          case 'clear_transient': this.store.deleteMeta(this.engine.transientKey(taskId)); break;
          case 'wake_capacity': this.engine.wakeCapacityWaiter(taskId); break;
          case 'completion': this.engine.scheduleCompletionFollowUp(after, afterRuns); break;
          case 'terminal_archive': this.engine.scheduleTerminalArchiveRetry(after, afterRuns); break;
          case 'cleanup':
            // Terminal cleanup follows the closeout quantum instead of waiting for a
            // fleet sweep. Queue it outside this lane so run-output settlement keeps
            // its exclusive task-lane fence before workspace cleanup begins.
            this.engine.cleanContext(() => {
              void this.engine.scheduleRunBuildOutputs(taskId).then(() => this.engine.enqueueCleanup(taskId)).catch(error => {
                this.store.event(taskId, "run_build_output_warning", `Run build output settlement could not run: ${error instanceof Error ? error.message : String(error)}`);
              });
            });
            break;
          case 'lifecycle': this.engine.scheduleLifecycleFollowUp(taskId); break;
          case 'wake_integration': this.engine.wakeIntegrationSuccessor(after.repoPath); break;
        }
      }
  }
  /** Bounded fallback for a report whose thread has not yet become idle. A
   * signal can wake the lane sooner; timers never authorize release themselves. */
  scheduleCompletionFollowUp(task: Task, runs: Run[]): void {
    const pending = runs.filter(run => !run.released && run.completion).map(run => JSON.stringify([run.id, run.completion!.eventId]));
    if (task.phase === "working" && task.completion && task.runId === task.completion.runId) pending.push(JSON.stringify([task.runId, task.completion.eventId]));
    const key = pending.length ? JSON.stringify(pending.sort()) : "";
    let follow = this.completionFollowUps.get(task.id);
    if (!key || task.removedAt || dispatchBlocked(task)) {
      if (follow?.timer) clearTimeout(follow.timer);
      this.completionFollowUps.delete(task.id);
      return;
    }
    if (!follow || follow.key !== key) {
      if (follow?.timer) clearTimeout(follow.timer);
      follow = { key, attempts: 0 };
      this.completionFollowUps.set(task.id, follow);
    }
    if (follow.timer || follow.attempts >= this.completionFollowUpDelays.length) return;
    const delay = this.completionFollowUpDelays[follow.attempts++];
    follow.timer = setTimeout(() => {
      follow!.timer = undefined;
      if (!settlementHeld(this.store, this.engine.stopped)) void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
    }, delay);
    follow.timer.unref();
  }

  terminalThreadsPending(task: Task, runs: Run[]): boolean {
    // A merged or completed proof task and a completed cancellation alike owe
    // their threads the terminal cleanup, so each also owes its retry
    // (nucleus#1155 review).
    if (!terminalThreadCleanup(task)) return false;
    // Deciders own no run, so their recorded identities are read from the task.
    const ids = new Set([task.agentId, ...task.retiredWorkers.map(worker => worker.agentId), ...runs.map(run => run.agentId),
      ...deciderThreadOwners(this.store, task)].filter((id): id is string => Boolean(id)));
    return [...ids].some(id => {
      const key = this.store.threadArchiveKey(id, task.hostId);
      return !key || Boolean(this.store.getMeta<string>(archiveProbeKey(this.store, task.id, id)))
        || ["ready", "intent", "uncertain"].includes(this.store.getMeta<{ status: string }>(key)?.status ?? "");
    });
  }

  /** A bounded task-lane wake observes uncertain effects and re-proves safe retries. */
  scheduleTerminalArchiveRetry(task: Task, runs: Run[]): void {
    const pending = this.engine.terminalThreadsPending(task, runs);
    let follow = this.terminalArchiveFollowUps.get(task.id);
    if (!pending || task.removedAt) {
      if (follow?.timer) clearTimeout(follow.timer);
      this.terminalArchiveFollowUps.delete(task.id);
      return;
    }
    if (!follow) { follow = { attempts: 0 }; this.terminalArchiveFollowUps.set(task.id, follow); }
    if (follow.timer || follow.attempts >= this.completionFollowUpDelays.length) return;
    follow.timer = setTimeout(() => {
      follow!.timer = undefined;
      if (!settlementHeld(this.store, this.engine.stopped)) void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
    }, this.completionFollowUpDelays[follow.attempts++]);
    follow.timer.unref();
  }

  stop(): void {
    for (const follow of this.completionFollowUps.values()) if (follow.timer) clearTimeout(follow.timer);
    this.completionFollowUps.clear();
    for (const follow of this.terminalArchiveFollowUps.values()) if (follow.timer) clearTimeout(follow.timer);
    this.terminalArchiveFollowUps.clear();
  }
}
