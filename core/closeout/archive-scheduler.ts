import type { Engine } from '../engine';
import type { Resolution } from '../resolution';
import type { Task } from '../../shared/contracts';
import { isDispositionActive } from '../../shared/contracts';
import { hostProcessSweepIntent } from '../machine/host-process-reap';
import { archiveIntentOutstanding, archiveIntentUnreadable } from '../workspaces/archive-intent';
import { isTransportFailure } from '../../shared/transport';
import { isLoginSessionFault, LoginSessionFaultError } from '../../shared/session-fault';
import { runFinishedHook, runTerminalHooks } from './terminal-hooks';

/** The engine, resolution and closeout-recovery facts one lifecycle sweep reads. */
export type ArchiveSchedulerContext = Pick<Engine,
  'adapter' | 'drainCleanup' | 'enqueueCleanup' | 'hooks' | 'scheduleRetirement' | 'scheduleRunBuildOutputs'
  | 'settleTerminalIntentRuns' | 'stopped' | 'store' | 'taskHostAvailable' | 'withHost'> & {
    readonly resolution: Pick<Resolution, 'attention' | 'environmentDeferred' | 'transportDeferred' | 'update'>;
    /** The nonterminal recovery pass this owner queues on the same sweep. */
    readonly closeout: {
      renewStaleCloseoutBase(task: Task): Promise<void>;
      renewConsumerBlockedCloseout(task: Task): Promise<void>;
      recover(task: Task): Promise<void>;
    };
  };

/**
 * The lifecycle sweep: which retained tasks owe a pass on this host, the durable
 * intents that keep terminal work ticking across restarts, and the bounded
 * cleanup lane the archive itself runs on. It schedules work; the archive proof
 * pipeline owns what the work proves.
 */
export class ArchiveScheduler {
  constructor(readonly context: ArchiveSchedulerContext) {}
  private get store() { return this.context.store; }
  private paused() { return this.context.stopped || this.store.getMeta('paused') === true; }
  /**
   * A completed disposition is final. If a stale write reopened the task, restore the
   * terminal phase; the store writes the task's permanent outcome row on that transition.
   */
  private restoreDisposedTerminal(task: Task): boolean {
    if (task.removedAt || task.disposition?.status !== 'complete' || ['done', 'cancelled'].includes(task.phase)) return false;
    this.context.resolution.update(task, { attention: false, currentRunId: null, hostProcessSweep: task.resolution.hostProcessSweep ?? hostProcessSweepIntent('cancelled') }, { phase: 'cancelled', reason: task.disposition.reason || 'Cancelled' }, 'terminal_phase_restored');
    return true;
  }
  /**
   * Reconcile recoverable nonterminal tasks and queue terminal archive work on
   * the engine's bounded cleanup lane. Archive work is durable through
   * `archiveIntentWorkspaceId`, so a restart resumes it without reopening or
   * repeating any delivery.
   */
  async enqueuePass(scopedHost?: string): Promise<void> {
    if (!scopedHost) {
      const tasks = [...this.store.lifecycleTasks(true), ...this.store.retirementTasks(), ...this.store.finishedHookTasks(), ...this.store.hostProcessSweepTasks()];
      for (const host of new Set(tasks.flatMap(task => task.hostId ? [task.hostId] : [])))
        await this.context.withHost(host, () => this.enqueuePass(host));
      return;
    }
    for (const task of this.store.lifecycleTasks(true)) {
      if (task.hostId !== scopedHost) continue;
      if (!this.context.taskHostAvailable(task)) continue;
      if (this.restoreDisposedTerminal(task)) continue;
      if (isDispositionActive(task)) continue;
      if (['done', 'cancelled'].includes(task.phase)) this.context.settleTerminalIntentRuns(task.id);
      if (this.paused()) return;
      // Queue #342: a terminal task's run-bound records settle in its task lane, never beside its archive lane.
      if (['done', 'cancelled'].includes(task.phase) && (task.resolution.buildOutputCleanups.some(record => record.runId && (record.state === 'intent' || record.state === 'uncertain'))
        || task.resolution.workspaceRetirement && ['authorized', 'intent', 'uncertain'].includes(task.resolution.workspaceRetirement.state)))
        void this.context.scheduleRunBuildOutputs(task.id).catch(error => this.store.event(task.id, 'run_build_output_warning', `Run build output settlement could not run: ${error instanceof Error ? error.message : String(error)}`));
      if (task.phase === 'done') this.context.enqueueCleanup(task.id);
      else {
        // A recorded intent keeps the ordinary lane schedule until it is observed.
        // Its own retry interval decides whether this pass is due, so an unchanged
        // refusal is not re-proved on every sweep.
        const runs = this.store.runs(task.id);
        const unreadable = archiveIntentUnreadable(task, runs);
        const unreadableRetry = unreadable ? task.resolution.workspaceArchiveRetries.find(record => record.workspaceId === unreadable) : undefined;
        const outstanding = archiveIntentOutstanding(task)
          ? task.resolution.workspaceArchiveRetries.find(record => record.workspaceId === task.resolution.archiveIntentWorkspaceId) : undefined;
        const observationDue = archiveIntentOutstanding(task) && !(outstanding && Date.parse(outstanding.nextAttemptAt) > Date.now());
        // A cancelled task's stale episode is settled on the ordinary cleanup lane, so
        // the settlement needs no run and the pass that closes it ends the schedule.
        const staleEpisode = task.phase === 'cancelled' && task.resolution.recoveryActive && !runs.some(run => run.role === 'recovery' && !run.released);
        if (staleEpisode || observationDue
          || Boolean(unreadable && !(unreadableRetry && Date.parse(unreadableRetry.nextAttemptAt) > Date.now()))) this.context.enqueueCleanup(task.id);
        try {
          await this.context.closeout.renewStaleCloseoutBase(task);
          await this.context.closeout.renewConsumerBlockedCloseout(task);
          await this.context.closeout.recover(task);
        } catch (error) {
          if (isTransportFailure(error)) this.context.resolution.transportDeferred(task, error);
          else if (error instanceof LoginSessionFaultError || isLoginSessionFault(error)) this.context.resolution.environmentDeferred(task, error);
          else this.context.resolution.attention(task, error instanceof Error ? error.message : String(error));
        }
      }
    }
    // Runtime retirement proofs are owed by tasks whose workspaces are already
    // archived, so they are no longer lifecycle candidates. Drive the durable
    // backoff retry on its own lane; the record itself is the restart authority.
    for (const task of this.store.retirementTasks()) if (task.hostId === scopedHost && this.context.taskHostAvailable(task)) this.context.scheduleRetirement(task.id);
    // A completed cancellation is excluded from `lifecycleTasks`, so its
    // advisory finished-task stop is driven from its own durable intent: a crash
    // after the terminal transition resumes the same evaluation and reconciles a
    // running occurrence rather than leaving it forever.
    if (this.paused()) return;
    for (const task of this.store.finishedHookTasks()) {
      if (task.hostId !== scopedHost) continue;
      if (!this.context.taskHostAvailable(task)) continue;
      await runFinishedHook(this.context, task);
    }
    for (const task of this.store.hostProcessSweepTasks()) {
      if (task.hostId !== scopedHost) continue;
      if (!this.context.taskHostAvailable(task)) continue;
      await runTerminalHooks(this.context, task);
    }
  }
  /** Direct pass: reconcile recoverable tasks, then await the serial cleanup drain. */
  async pass(): Promise<void> {
    await this.enqueuePass();
    await this.context.drainCleanup();
  }
}
