import type { Resolution } from '../resolution';
import { holdsOf, runtimeRetirementFailure, type Task } from '../../shared/contracts';
import { OWNER_STOP_HOLD_PREFIX, releasePatch } from '../merge/merge-hold';
import type { Engine } from '../engine';
import { CloseoutRecovery } from './recovery';
import { closeoutContext } from './context';
import { externalWorkspaceArchiveDue, settleExternalWorkspaceArchive } from '../workspaces/external-workspace-archive';
import { archiveIntentUnreadable, archiveSettledByOwner } from '../workspaces/archive-intent';
import { archiveRetryWaiting, recordArchiveRetry, terminalArchiveSource, terminalArchiveWorkspaces, workspaceArchiveFailureReason, type WorkspaceArchiveRetry } from './terminal-archive';
import { ArchiveProof, type LifecycleAdapter } from './archive-proof';
import { ArchiveScheduler } from './archive-scheduler';
import { runTerminalHooks } from './terminal-hooks';
import { missingOriginHasPlanner } from '../questions/origin';
import { admissionOf } from '../host/admission';

export type LifecycleContext = Pick<Engine, 'adapter' | 'drainCleanup' | 'enqueueCleanup' | 'hooks' | 'host' | 'onTaskHost' | 'removeSiblings' | 'retirement' | 'scheduleRetirement' | 'scheduleRunBuildOutputs' | 'settleObservedIdleRuns' | 'settleTerminalIntentRuns' | 'settleTerminalRecoveryEpisode' | 'stopped' | 'store' | 'taskHostAvailable' | 'withHost'> & { readonly resolution: Pick<Resolution, 'adapter' | 'closeoutAuthority' | 'hasEarlierIntegrationTurn' | 'lease' | 'attention' | 'environmentDeferred' | 'transportDeferred' | 'update'> };

/**
 * The lifecycle owner for a task's terminal workspace: which workspaces are due,
 * what this pass owes before proving them, and the bounded archive pass itself.
 * The per-workspace archive proof lives in `ArchiveProof` and the sweep that
 * finds the work lives in `ArchiveScheduler`; this class only sequences them.
 */
export class Lifecycle {
  private readonly closeoutRecovery: CloseoutRecovery;
  private readonly proof: ArchiveProof;
  private readonly scheduler: ArchiveScheduler;
  constructor(readonly engine: LifecycleContext) {
    this.closeoutRecovery = new CloseoutRecovery({
      get adapter() { return engine.adapter; },
      get host() { return engine.host; },
      get onTaskHost() { return engine.onTaskHost.bind(engine); },
      get resolution() { return closeoutContext(engine.resolution, ['adapter', 'closeoutAuthority', 'hasEarlierIntegrationTurn', 'lease', 'update']); },
      get stopped() { return engine.stopped; },
      get store() { return engine.store; },
    });
    this.proof = new ArchiveProof({
      adapter: engine.adapter, hooks: engine.hooks, retirement: engine.retirement, stopped: engine.stopped,
      store: engine.store, resolution: { update: engine.resolution.update.bind(engine.resolution) },
    });
    this.scheduler = new ArchiveScheduler({
      adapter: engine.adapter, drainCleanup: () => engine.drainCleanup(), enqueueCleanup: (taskId, retryWorkspaceId) => engine.enqueueCleanup(taskId, retryWorkspaceId),
      hooks: engine.hooks, scheduleRetirement: taskId => engine.scheduleRetirement(taskId),
      scheduleRunBuildOutputs: taskId => engine.scheduleRunBuildOutputs(taskId),
      settleTerminalIntentRuns: taskId => engine.settleTerminalIntentRuns(taskId),
      stopped: engine.stopped, store: engine.store, taskHostAvailable: task => engine.taskHostAvailable(task),
      withHost: (id, fn) => engine.withHost(id, fn),
      resolution: { attention: (...args) => engine.resolution.attention(...args), environmentDeferred: (...args) => engine.resolution.environmentDeferred(...args), transportDeferred: (...args) => engine.resolution.transportDeferred(...args), update: (...args) => engine.resolution.update(...args) },
      closeout: {
        renewStaleCloseoutBase: task => this.renewStaleCloseoutBase(task),
        renewConsumerBlockedCloseout: task => this.renewConsumerBlockedCloseout(task),
        recover: task => this.recover(task),
      },
    });
  }
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter as Engine['adapter'] & Partial<LifecycleAdapter>; }
  paused() { return this.engine.stopped || this.store.getMeta('paused') === true; }
  recover(task: Task) { return this.closeoutRecovery.recover(task); }
  private renewStaleCloseoutBase(task: Task) { return this.closeoutRecovery.renewStaleCloseoutBase(task); }
  get consumerBlockFetchMs() { return this.closeoutRecovery.consumerBlockFetchMs; }
  set consumerBlockFetchMs(value: number) { this.closeoutRecovery.consumerBlockFetchMs = value; }
  private renewConsumerBlockedCloseout(task: Task) { return this.closeoutRecovery.renewConsumerBlockedCloseout(task); }
  /** A passed retention reconciliation makes the retained workspace ready for immediate cleanup. */
  retentionReconciled(taskId: string, workspaceId: string | null) {
    const current = this.store.task(taskId);
    if (workspaceId) {
      const retries = current.resolution.workspaceArchiveRetries;
      const workspaceArchiveRetries = retries.filter(record => record.workspaceId !== workspaceId);
      if (workspaceArchiveRetries.length !== retries.length) {
        const archiveFailure = workspaceArchiveFailureReason(retries);
        const cleanupReason = current.resolution.cleanupReason === archiveFailure
          ? runtimeRetirementFailure(current) || workspaceArchiveFailureReason(workspaceArchiveRetries)
          : current.resolution.cleanupReason;
        this.engine.resolution.update(current, { workspaceArchiveRetries, cleanupReason }, {}, 'workspace_archive_retry_cleared', workspaceId);
      }
    }
    this.engine.enqueueCleanup(taskId);
  }
  /**
   * One pass over the preserved external workspace's catalog archive. The
   * module owns the record, the at-most-once identity and the bounded retry;
   * this method only gives it the engine's adapter, pause fence and the
   * versioned resolution write.
   */
  private async settlePreservedCatalogArchive(task: Task, retryWorkspaceId?: string): Promise<Task> {
    try {
      return await settleExternalWorkspaceArchive({
        store: this.store, adapter: this.adapter, paused: () => this.paused(),
        resolution: this.engine.resolution,
      }, task.id, retryWorkspaceId);
    } catch (error) {
      this.store.event(task.id, 'external_workspace_archive_warning', error instanceof Error ? error.message : String(error));
      return this.store.task(task.id);
    }
  }
  /**
   * Settle a passed pre-archive gate. The gate names the retained worktree it ran in,
   * not a workspace identity, so map that directory to the owned workspace it belongs
   * to (primary, closeout or a reviewer source view) before clearing only that
   * workspace's archive backoff. An unknown directory settles nothing.
   */
  retentionReconciledAt(taskId: string, worktree: string | null) {
    if (!worktree) return;
    const task = this.store.task(taskId);
    const runs = this.store.runs(taskId);
    const owned = [
      { id: task.workspaceId, directory: task.directory },
      { id: task.resolution.closeoutWorkspaceId, directory: task.resolution.closeoutDirectory },
      ...runs.filter(run => run.reviewSourceView?.directory).map(run => ({ id: run.workspaceId, directory: run.reviewSourceView!.directory })),
    ];
    const match = owned.find(workspace => workspace.id && workspace.directory === worktree);
    if (match?.id) this.retentionReconciled(taskId, match.id);
  }
  /**
   * Whether this pass owes any archive effect. A workspace archive that already
   * succeeded, or whose recorded bounded retry is not due yet, owes nothing: its
   * finished hook, its manifest discovery and its host-process sweep were owed by
   * the terminal transition, whose own durable intents (`finishedHook`,
   * `hostProcessSweep`) are the restart authority and are still honoured here.
   * A pause, ownership or content proof only ever refuses an attempt after this
   * point, so gating on due work changes no gate - it only stops re-proving them
   * on passes that cannot act.
   */
  private archiveWorkDue(task: Task, retryWorkspaceId?: string): boolean {
    if (task.resolution.finishedHook || task.resolution.hostProcessSweep) return true;
    if (externalWorkspaceArchiveDue(task, retryWorkspaceId)) return true;
    const runs = this.store.runs(task.id);
    return terminalArchiveWorkspaces(task, runs).some(workspace => {
      if (!workspace.id || !workspace.directory || !workspace.head) return false;
      if (retryWorkspaceId !== workspace.id && archiveSettledByOwner(task, workspace.id)) return false;
      if (task.resolution.archivedWorkspaceIds.includes(workspace.id)) return false;
      if (retryWorkspaceId) return retryWorkspaceId === workspace.id;
      return !archiveRetryWaiting(task.resolution.workspaceArchiveRetries.find(record => record.workspaceId === workspace.id));
    });
  }
  /** A finished task's owner-stop dispatch hold is released; it has no work left to stop. */
  private releaseFinishedStopHold(task: Task): Task {
    const hold = holdsOf(task).dispatch;
    if (task.phase !== 'done' || !hold || !hold.reason.startsWith(OWNER_STOP_HOLD_PREFIX)) return task;
    return this.store.update(task.id, releasePatch(task, 'dispatch'), 'hold_released',
      `Dispatch hold released: the task finished, so its owner stop (${hold.reason.slice(0, 300)}) has no work left to stop`);
  }
  /**
   * A nonterminal task owes no archive of its own. One durable
   * `archiveIntentWorkspaceId` can still outlive a task removal whose native reply
   * was lost, so an intent naming no reviewer run is reported with whatever the
   * catalog still answers. An unknown outcome is observed, never re-sent.
   */
  private async observeUnreadableArchiveIntent(task: Task, retryWorkspaceId?: string) {
    const archiveTaskWorkspace = this.adapter.archiveTaskWorkspace;
    if (!archiveTaskWorkspace) return;
    const runs = this.store.runs(task.id);
    const unreadable = archiveIntentUnreadable(task, runs, retryWorkspaceId);
    if (unreadable) {
      // The same interval governs an unreadable intent's catalog observation, so a
      // recorded backoff is not re-read on every sweep; an owner retry still runs.
      const unreadableRetry = this.store.task(task.id).resolution.workspaceArchiveRetries.find(record => record.workspaceId === unreadable);
      if (retryWorkspaceId !== unreadable && unreadableRetry && Date.parse(unreadableRetry.nextAttemptAt) > Date.now()) return;
      if (!this.paused()) {
        let observation = '';
        if (this.adapter.taskWorkspaceArchived) {
          // `taskWorkspaceArchived` answers true when the entry is gone from the
          // catalog: read it that way round, never backwards.
          try {
            observation = await this.adapter.taskWorkspaceArchived(unreadable)
              ? '; the catalog no longer lists that workspace entry' : '; the catalog still lists that workspace entry';
          } catch { observation = '; the catalog observation was unavailable'; }
        }
        // Every due observation is one bounded occurrence: recording it advances the
        // deadline even when the answer is unchanged, so the next sweep inside the
        // new interval reads nothing.
        recordArchiveRetry({ store: this.store, update: this.engine.resolution.update.bind(this.engine.resolution) }, task.id, unreadable,
          `The recorded review view archive intent no longer matches a reviewer run, so its checkout and publication cannot be re-proved${observation}. Inspect that workspace entry before retrying`, false);
      }
      return;
    }
  }
  async archive(task: Task, retryWorkspaceId?: string) {
    // A terminal task's stale recovery episode settles before any gate below can
    // return: a cancelled task never reaches the done-only archive, and a done task
    // without a recorded merge stops at the merge guard. The settlement is store-only.
    if (['done', 'cancelled'].includes(task.phase) && task.resolution.recoveryActive) {
      this.engine.settleTerminalRecoveryEpisode(task.id, 'end-of-task cleanup');
      task = this.store.task(task.id);
    }
    if (task.phase !== 'done' && (task.originError && !missingOriginHasPlanner(this.store, task) || task.originLookupError || this.paused() || !this.adapter.archiveTaskWorkspace)) return;
    if (task.phase !== 'done') return this.observeUnreadableArchiveIntent(task, retryWorkspaceId);
    const { reportOnly, proofOnlyDone } = terminalArchiveSource(task);
    if (task.originError && !missingOriginHasPlanner(this.store, task) || task.originLookupError || this.paused() || task.phase !== 'done'
      || (!reportOnly && !proofOnlyDone && (!task.resolution.mergedCommit || !task.resolution.syncedCommit)) || !this.adapter.archiveTaskWorkspace) return;
    // Degraded admission defers archive work as it defers titles: no attempt is
    // made or recorded, and the next healthy pass finds the same work due. An
    // owner retry still runs, so its refusal is reported rather than swallowed.
    if (!retryWorkspaceId && admissionOf(this.adapter)?.degradedNow) return;
    // An owner stop pauses work; a finished task has none left, so its stop hold
    // stops nothing and would only refuse the archive for good (#456, Effigy #377,
    // Tom 2026-10-26: "It keeps happening!"). Release it, recorded, before archiving.
    // Any other dispatch hold is a deliberate preservation and still keeps the workspace.
    task = this.releaseFinishedStopHold(task);
    // Spec 050 terminal-cleanup liveness (papercut b87375b0): a never-reporting
    // run whose agent is observed idle, with no active turn and no pending
    // permission, is released with history kept before the archive waits on it.
    // This runs before the recoveryActive gate because such a run is exactly
    // what keeps the recovery episode reading active.
    if (task.resolution.recoveryActive || this.store.runs(task.id).some(run => !run.released)) {
      await this.engine.settleObservedIdleRuns(task.id, 'End-of-task cleanup released an idle run with no live turn');
      task = this.store.task(task.id);
    }
    if (task.resolution.recoveryActive) return;
    // The advisory finished-task runtime stop and the terminal host-process
    // sweep are expensive (three to five Git spawns, `ps` and `lsof`) and only
    // owed once per terminal transition, so they run on a pass that is actually
    // due - a due owned-workspace archive, a due preserved catalog archive or
    // the durable terminal-transition intents - never on every pass of a
    // workspace whose retry is still backed off.
    if (this.archiveWorkDue(task, retryWorkspaceId)) await runTerminalHooks({ store: this.store, hooks: this.engine.hooks }, task);
    // Spec 027: sibling worktrees leave with the task's own workspaces.
    if (task.siblingPins.length) await this.engine.removeSiblings(task.id);
    // Spec 017: a merged review-entry task's preserved external workspace keeps
    // its folder; only Paseo's sidebar entry is archived, and only behind the
    // adapter's source-backed placement proof. It runs before the owned-workspace
    // loop so a held owned archive never delays it, and it never throws into that
    // loop: its own durable record and events are the visible state.
    task = await this.settlePreservedCatalogArchive(task, retryWorkspaceId);
    const runs = this.store.runs(task.id);
    const attachedAgentIds = new Set([task.agentId, task.coordinatorAgentId, task.resolution.reviewerAgentId,
      ...task.retiredWorkers.map(worker => worker.agentId), ...runs.map(run => run.agentId)].filter((id): id is string => Boolean(id)).filter(id => {
        // Terminal deletion is already confirmed by the host and recorded in
        // the thread lane. Such a thread has no projection left to observe.
        // Pending/unknown effects and live runs keep the participant proof.
        const key = this.store.threadArchiveKey(id, task.hostId);
        const effect = key ? this.store.getMeta<{ status: string; op?: string }>(key) : undefined;
        return effect?.status !== 'archived' || effect.op !== 'delete' || runs.some(run => run.agentId === id && !run.released);
      }));
    for (const workspace of terminalArchiveWorkspaces(task, runs)) {
      if (!workspace.id || !workspace.directory || !workspace.head || task.resolution.archivedWorkspaceIds.includes(workspace.id)) continue;
      const id = workspace.id;
      if (retryWorkspaceId !== id && archiveSettledByOwner(this.store.task(task.id), id)) continue;
      if (retryWorkspaceId && retryWorkspaceId !== id) continue;
      const retry: WorkspaceArchiveRetry | undefined = this.store.task(task.id).resolution.workspaceArchiveRetries.find(record => record.workspaceId === id);
      // An owner retries this workspace now without erasing its failed attempts
      // or uncertain intent. All ordinary archive proofs apply.
      if (!retryWorkspaceId && archiveRetryWaiting(retry)) continue;
      await this.proof.archiveWorkspace(task, workspace, { runs, attachedAgentIds });
      task = this.store.task(task.id);
    }
  }
  async enqueuePass(scopedHost?: string): Promise<void> { return this.scheduler.enqueuePass(scopedHost); }
  /** Direct pass: reconcile recoverable tasks, then await the serial cleanup drain. */
  async pass(): Promise<void> { return this.scheduler.pass(); }
}
