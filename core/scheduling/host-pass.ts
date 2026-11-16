import type { Engine } from "../engine";
import type { Resolution } from '../resolution';
import type { Task } from "../../shared/contracts";
import type { AgentObservation } from "../host/adapter";
import { catchUpFinishedTaskThreads, finishedThreadCleanupCatchUp } from '../workspaces/thread-archive';
import { removesThreads } from '../workspaces/thread-archive-effect';
import { sanitizeHostFailureDetail, sanitizeHostFailureReason } from "../host";

const REVIEW_PHASES = new Set(['awaiting_review', 'report_ready', 'reviewing', 'changes_requested', 'verifying', 'merging', 'syncing', 'closing', 'done']);
const SUPPORT_ROLES = new Set(['reviewer', 'recovery', 'coordinator', 'decider', 'executor']);
const ATTENTION_PHASES = ['blocked', 'error', 'needs_attention'];

function threadSettlementFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const record = error as Error & { reason?: unknown; diagnostic?: { reason?: unknown }; field?: unknown };
  const reason = sanitizeHostFailureReason(record.reason ?? record.diagnostic?.reason);
  // A compatibility failure's field names the exact structural mismatch (a
  // snapshot name, a dotted decode path, a connection state); the name alone
  // never did. Every field is an adapter-authored constant, never remote text.
  const detail = sanitizeHostFailureDetail(record.field);
  return `${error.name}${reason ? `: ${reason}` : ''}${detail ? ` (${detail})` : ''}`;
}

export type HostPassContext = Pick<Engine, 'adapter' | 'host' | 'inventoryHostMatches' | 'observeRetiredWorkers'
  | 'retiredObservationKey' | 'retiredObservationPlan' | 'store'> & { readonly resolution: Pick<Resolution, 'observationTargets'> };

/** What one host's pass answers the audit pass that called it. */
export type HostPassResult = {
  /** The one bounded inventory read, when this host could answer for it. */
  inventory: ReadonlyMap<string, AgentObservation> | null;
  /** Finished tasks whose thread cleanup is still owed, for the bounded task window. */
  finishedCatchUp: Map<string, Task>;
};

/**
 * One host's audit steps: settlements and thread presentation, the bounded
 * observation inventory, retired-worker observation, title reconciliation and
 * the finished-thread catch-up selection. They are per-host work, so the sweep
 * owns only the order it visits hosts in.
 *
 * A step that throws is recorded on the store as `hostPassError` and the host's
 * later steps still run: one host's fault never stalls the fleet sweep, and it
 * never disappears with the promise either.
 */
export class HostPass {
  constructor(readonly context: HostPassContext) {}
  private get store() { return this.context.store; }
  private get adapter() { return this.context.adapter; }

  /**
   * Thread settlement is a sweep invariant, not a callback side effect. Reports
   * are only one way a run finishes; recorded-completion release and other
   * owner paths must settle the same retained T3 thread too.
   */
  private async settleFinishedT3Threads(hostId: string): Promise<void> {
    const adapter = this.adapter;
    const settleSupport = adapter.settleReportedThread;
    const settleWorker = adapter.settleWorkerThread;
    if (!settleSupport && !settleWorker) return;
    for (const task of this.store.tasks()) {
      if (task.hostId !== hostId || task.removedAt != null) continue;
      // While attention is active the worker thread stays surfaced: settling
      // it here would only make the attention pass unsettle it again, one
      // settle/unsettle pair per sweep. The ordinary settle resumes when
      // attention clears (nucleus#1181 review).
      const attentionActive = task.resolution.attention || ATTENTION_PHASES.includes(task.phase);
      const runs = this.store.runs(task.id);
      // One row per task (Tom, 2026-11-15): while any of the task's agents is
      // still working, the worker row is the task's one visible row and it stays
      // unsettled. It settles only when the task waits on nothing Nucleus runs.
      const liveWork = runs.some(run => !run.released && !run.completion);
      for (const run of runs) {
        if (run.hostId !== hostId || !run.agentId || (!run.released && !run.completion)) continue;
        // The terminal lane's confirmed effect covers this thread, even when
        // settling it previously needed no native receipt. An unresolved effect
        // still needs observation and settlement on the next pass.
        if (this.store.threadArchiveEffect(run.agentId, hostId)?.status === 'archived') continue;
        const settle = run.role === 'revision' && REVIEW_PHASES.has(task.phase) && !attentionActive && !liveWork
          ? settleWorker : SUPPORT_ROLES.has(run.role) ? settleSupport : undefined;
        if (!settle) continue;
        try { await settle.call(adapter, run.agentId, run.id); }
        catch (error) {
          this.store.event(task.id, 'thread_settlement_warning',
            `${run.role} thread ${run.agentId} settle for run ${run.id} failed: ${threadSettlementFailureReason(error)}`.slice(0, 4000));
        }
      }
      // The initial worker run predates the role run ledger on legacy tasks.
      // The task only reaches these phases after its handover was accepted.
      if (settleWorker && !attentionActive && !liveWork && REVIEW_PHASES.has(task.phase) && task.agentId && task.runId && !runs.some(run => run.id === task.runId)
        && this.store.threadArchiveEffect(task.agentId, hostId)?.status !== 'archived') {
        try { await settleWorker.call(adapter, task.agentId, task.runId); }
        catch (error) {
          this.store.event(task.id, 'thread_settlement_warning',
            `worker thread ${task.agentId} settle for run ${task.runId} failed: ${threadSettlementFailureReason(error)}`.slice(0, 4000));
        }
      }
    }
  }

  /**
   * The worker row surfaces (nucleus#1181, one row per task Tom 2026-11-15): while
   * a T3-bound task is blocked, errored, needs attention or carries an attention
   * flag (planner or operator escalation), or while any of its agents is still
   * working, its worker thread is unsettled so it stays in T3's main list instead
   * of the settled list. Only the worker thread surfaces, never support threads.
   * When the task waits on nothing Nucleus is running the ordinary settlement
   * sweep puts the thread back; this pass sends nothing more. A host without the
   * presentation method (Paseo) keeps its behaviour.
   */
  private async surfaceWorkerRows(hostId: string): Promise<void> {
    const adapter = this.adapter;
    const unsettle = adapter.unsettleWorkerThread;
    if (!unsettle) return;
    for (const task of this.store.tasks()) {
      if (task.hostId !== hostId || task.removedAt != null) continue;
      if (!task.agentId || ['done', 'cancelled'].includes(task.phase)) continue;
      const liveWork = this.store.runs(task.id).some(run => !run.released && !run.completion);
      if (!liveWork && !ATTENTION_PHASES.includes(task.phase) && !task.resolution.attention) continue;
      // The terminal lane owns archived threads; support threads never surface.
      if (this.store.threadArchiveEffect(task.agentId, hostId)?.status === 'archived') continue;
      try { await unsettle.call(adapter, task.agentId, task.id); }
      catch (error) {
        this.store.event(task.id, 'thread_attention_warning',
          `worker thread ${task.agentId} attention surfacing failed: ${threadSettlementFailureReason(error)}`.slice(0, 4000));
      }
    }
  }

  /**
   * One host's steps in the audit pass's order. A step that throws is recorded
   * here, and the host's later steps still run.
   */
  async run(host: string): Promise<HostPassResult> {
    const result: HostPassResult = { inventory: null, finishedCatchUp: new Map() };
    await this.step(host, 'reconcileReportedSettlements', () => this.adapter.reconcileReportedSettlements?.());
    await this.step(host, 'settleFinishedT3Threads', () => this.settleFinishedT3Threads(host));
    await this.step(host, 'surfaceWorkerRows', () => this.surfaceWorkerRows(host));
    await this.step(host, 'reconcileThreadTitles',
      () => this.adapter.reconcileThreadTitles?.(this.store.tasks().filter(task => task.hostId === host)));
    // Audit A6: one bounded labelled inventory answers every identity this
    // pass observes, and retired workers are re-read on their own slow cadence.
    // A list that cannot be walked to its end answers nothing, so every
    // identity falls back to the narrow read and no inactivity is inferred.
    const retiredPlan = this.context.retiredObservationPlan();
    const inventoryIds = [...new Set([...retiredPlan.due, ...this.context.resolution.observationTargets()])];
    let observed: ReadonlyMap<string, AgentObservation> | null = null;
    if (inventoryIds.length && this.adapter.observationInventory) {
      try { observed = await this.context.host.observationInventory(inventoryIds); }
      catch { observed = null; }
    }
    const retired = await this.context.observeRetiredWorkers(retiredPlan, observed);
    if (retired.changed) this.store.setMeta(this.context.retiredObservationKey(host), retired.observations);
    // A handover settle recorded for a thread whose turn was still ending is
    // retried on this host's pass. Presentation only: it never changes a task.
    await this.step(host, 'reconcileSettledThreads', () => this.adapter.reconcileSettledThreads?.());
    // Select directly from finished history, but never await cleanup in the
    // shared host pass. These tasks join the rotating, bounded task window.
    if (!this.store.getMeta('paused') && removesThreads(this.adapter))
      for (const task of finishedThreadCleanupCatchUp(this.store, host, true))
        result.finishedCatchUp.set(task.id, task);
    if (this.context.inventoryHostMatches(host)) result.inventory = observed;
    return result;
  }

  /** One host step: a throw is recorded here and never stops the host's later steps. */
  private async step(host: string, name: string, run: () => Promise<unknown> | unknown): Promise<void> {
    try { await run(); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.store.setMeta('hostPassError', `${host}/${name}: ${detail}`.slice(0, 2000));
    }
  }
}
