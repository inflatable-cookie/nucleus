import type { Resolution } from '../resolution';
import { dirname } from "node:path";
import type { Engine } from "../engine";
import { STOPPED_BEFORE_DRAIN } from "../engine";
import type { Task } from "../../shared/contracts";
import { isDispositionActive } from "../../shared/contracts";
import type { ReconciliationSweep } from "../../shared/telemetry";
import type { AgentObservation } from "../host/adapter";
import { reapHookCheckouts } from "../hooks/hook-cleanup";
import { removeTaskProofFiles } from "../intake/proof-files";
import { pruneLiveDataHomeBackupCopies } from "../store/data-home-retention";
import { resumeDispositions } from "../verbs/disposition";
import { completionReportsPr } from "../recovery/worker-reconcile";
import { LANE_PRIORITY_AUDIT, LANE_PRIORITY_TASK } from "./lane-priorities";
import { TASK_QUANTUM_BOUND_MS, boundQuantum } from "./quantum-bound";
import { startsNoRuns } from "../closeout/queue-drain";
import { now, RECLAIM_DRAIN_BUDGET_MS, RECLAIM_DRAIN_FREE_PAGES, RECLAIM_DRAIN_MAX_PAGES } from "../store/store";

/**
 * Tasks reconciled per bounded safety-sweep window (Spec 013). The minute sweep
 * advances one page and yields; it never walks the fleet in a single pass. An
 * explicit reconciliation drains pages until the durable cursor wraps once.
 */
const SWEEP_WINDOW = 25;
/** Minute sweeps between rotations of the capacity-blocked queue. */
const DEFERRED_SWEEP_EVERY = 5;
/** Upper bound on pages drained by one explicit reconciliation request. */
const MAX_SWEEP_WINDOWS = 400;
type DrainWaiter = { resolve: () => void; reject: (error: Error) => void };

export type SweepContext = Pick<Engine, 'adapter' | 'applyDeferredOwnerVerbs' | 'archivePlannerGrants' | 'archiveRetiredErroredAgents' | 'auditPass' | 'clearRetiredInvalidations' | 'continueAwaitingReviewers' | 'dispatchQueued' | 'dispositionDeps' | 'drainProjections' | 'drainWaiters' | 'enqueueTitle' | 'ensureSweep' | 'flushPrerequisiteReleases' | 'host' | 'hostAvailable' | 'hostIds' | 'inventoryHostMatches' | 'lastHookCleanupAt' | 'lifecycle' | 'maxSweepWindows' | 'migrateProjectOwnersToPlanners' | 'noteStepFailure' | 'observeRetiredWorkers' | 'quiesce' | 'reconcile' | 'recoverExhaustedWorkers' | 'removeSiblings' | 'resumePausedStops' | 'retiredObservationKey' | 'retiredObservationPlan' | 'scheduleLane' | 'scheduleLifecycleFollowUp' | 'scheduleTaskQuantum' | 'settleQuiesce' | 'startSweepChain' | 'stopped' | 'store' | 'sweepChain' | 'sweepCursor' | 'sweepDeferred' | 'sweepDeferredCursor' | 'sweepMode' | 'sweepOrder' | 'sweepPending' | 'sweepStats' | 'sweepTicks' | 'taskHostAvailable' | 'wakeCapacityWaiter' | 'wakePreludes' | 'withHost'> & { readonly resolution: Pick<Resolution, 'checkpoints' | 'delegateNativeQuestions' | 'deliverDecisionNotices' | 'deliverDrainNotices' | 'deliverHoldNotices' | 'deliverNotices' | 'deliverQueuedMessages' | 'observationTargets' | 'observe' | 'origins' | 'raiseOperatorQuestions' | 'recovery' | 'resumeAskQuestions' | 'resumeResponsibleAnsweredQuestions' | 'settleBudgetClock'> };

export class Sweep {
  /**
   * A task quantum that outlived its bound is that task's observation outage: the
   * sweep moved on, the task's lane stays held by the running quantum, and the
   * next sweep queues behind it. Recorded as a task event, not a phase change.
   */
  recordQuantumOutage(taskId: string): void {
    this.engine.store.event(taskId, 'observation_outage', `Task quantum did not return within ${TASK_QUANTUM_BOUND_MS / 1000} s; the sweep moved on and this task's lane stays held until it returns`);
  }
  lastHookCleanupAt = 0;
  /** Durable cursor for the bounded safety sweep: the last task identity reconciled. */
  sweepCursor: string | null = null;
  /** Capacity-blocked and held tasks, swept on a slower rotation than active work. */
  sweepDeferred: Task[] = [];
  sweepDeferredCursor: string | null = null;
  sweepTicks = 0;
  sweepChain: Promise<void> | null = null;
  sweepMode: "window" | "drain" | null = null;
  sweepPending: "window" | "drain" | null = null;
  /**
   * Drain requests not yet covered. Each is settled by the first full drain
   * pass that STARTED after it, never by the whole chain: safety-tick windows
   * may keep extending the chain indefinitely (a pass longer than the tick
   * re-queues one behind itself), and a drain caller must not wait on them.
   */
  drainWaiters: DrainWaiter[] = [];
  /** Windows one audit pass may run; a drain past it continues in the next pass. Replaceable only by tests. */
  maxSweepWindows = MAX_SWEEP_WINDOWS;
  readonly sweepStats = { windows: 0, swept: 0, tasks: 0, lastPassAt: null as string | null };
  constructor(readonly engine: SweepContext) {}
  sweepOnce(): Promise<void> {
    if (this.engine.stopped) return Promise.resolve();
    void this.engine.flushPrerequisiteReleases().catch(() => {});
    return this.engine.ensureSweep("window");
  }

  wake(): Promise<void> {
    if (this.engine.stopped) return Promise.resolve();
    // The bounded drain cut: the drain this call requested has covered the
    // fleet, the lane work it scheduled has settled, and the titles have
    // drained. Window passes the safety tick queues after it are not awaited.
    // Cleanup is kicked but not awaited: a workspace archive legitimately runs
    // for minutes, and the board's reconciliation diagnostic must not wait on
    // one (Tom, 2026-11-05).
    // The prelude yields before the drain has a lane, and a callback's fire-and-forget
    // wake is accepted work: quiesce() must not answer in that gap (nucleus #752).
    this.engine.wakePreludes++;
    const started = () => { this.engine.wakePreludes--; this.engine.settleQuiesce(); };
    return this.engine.flushPrerequisiteReleases().then(() => this.engine.archivePlannerGrants())
      .then(() => { const drain = this.engine.ensureSweep("drain"); started(); return drain; }, error => { started(); throw error; })
      .then(() => this.engine.quiesce("audit")).then(() => this.engine.drainProjections({ cleanup: false }));
  }

  reconciliationSnapshot(): ReconciliationSweep {
    return {
      cursor: this.engine.sweepCursor, swept: this.engine.sweepStats.swept, tasks: this.engine.sweepStats.tasks,
      dirty: this.engine.sweepPending !== null || this.engine.sweepChain !== null, passes: this.engine.sweepStats.windows, lastPassAt: this.engine.sweepStats.lastPassAt,
    };
  }

  ensureSweep(mode: "window" | "drain"): Promise<void> {
    // A drain caller gets its own completion: the first full drain pass that
    // starts after this request, even while window passes keep the chain alive.
    const requested = mode === "drain"
      ? new Promise<void>((resolve, reject) => { this.engine.drainWaiters.push({ resolve, reject }); })
      : null;
    if (this.engine.sweepChain) {
      // A running drain started before this request, so it cannot credit it:
      // another drain pass follows. A window request is covered by a drain.
      if (mode === "drain") { this.engine.sweepPending = "drain"; return requested!; }
      if (this.engine.sweepMode === "drain") return this.engine.sweepChain;
      if (this.engine.sweepPending !== "drain") this.engine.sweepPending = "window";
      return this.engine.sweepChain;
    }
    this.engine.startSweepChain(mode);
    return requested ?? this.engine.sweepChain!;
  }

  startSweepChain(mode: "window" | "drain"): void {
    this.engine.sweepMode = mode;
    const chain = this.engine.scheduleLane("audit", LANE_PRIORITY_AUDIT, async () => {
      let current: "window" | "drain" = mode;
      // A drain capped before it reached every task continues in the next pass
      // with the coverage it carries; requests arriving meanwhile wait for a
      // fresh drain of their own after it.
      let carried: { waiters: DrainWaiter[]; visited: Set<string> } | null = null;
      for (;;) {
        this.engine.sweepMode = current;
        const credited: DrainWaiter[] = current !== "drain" ? [] : carried ? carried.waiters : this.engine.drainWaiters.splice(0);
        const pass = await this.engine.auditPass(current === "drain", carried?.visited ?? new Set());
        carried = null;
        // A failed or stopped pass credits nothing: its waiters reject.
        const settled = pass.fault ?? (this.engine.stopped ? STOPPED_BEFORE_DRAIN() : null);
        if (settled) for (const waiter of credited) waiter.reject(settled);
        else if (pass.covered) for (const waiter of credited) waiter.resolve();
        else if (current === "drain") carried = { waiters: credited, visited: pass.visited };
        if (this.engine.stopped) break;
        const next = carried || this.engine.drainWaiters.length ? "drain" : this.engine.sweepPending;
        this.engine.sweepPending = null;
        if (!next) break;
        current = next;
      }
    }).catch(() => { /* the pass records its own fault on the store */ });
    this.engine.sweepChain = chain.finally(() => {
      this.engine.sweepChain = null; this.engine.sweepMode = null;
      const pending = this.engine.sweepPending;
      this.engine.sweepPending = null;
      // A request that arrived while the chain was ending still runs: a new
      // chain covers it. Only a stopped engine rejects the uncovered drains.
      if (this.engine.stopped) { for (const waiter of this.engine.drainWaiters.splice(0)) waiter.reject(STOPPED_BEFORE_DRAIN()); return; }
      if (this.engine.drainWaiters.length || pending) this.engine.startSweepChain(this.engine.drainWaiters.length ? "drain" : pending!);
    });
  }

  sweepOrder(_includeDeferred: boolean): Task[] {
    // Never-started queued work is driven by dispatch and dependency wakes. A
    // queued task with a retained workspace, agent, or intent still has lifecycle
    // work and remains in the safety sweep.
    const byId = new Map(this.engine.store.activeCapacityTasks().map(task => [task.id, task]));
    for (const task of this.engine.store.dueHoldTasks()) byId.set(task.id, task);
    const order = [...byId.values()].reverse();
    this.engine.sweepStats.tasks = order.length;
    this.engine.sweepDeferred = [];
    return order;
  }

  async auditPass(drain: boolean, visited: Set<string> = new Set()): Promise<{ fault: Error | null; covered: boolean; visited: Set<string> }> {
    try {
      this.engine.store.setMeta("engineError", "");
      let covered = false;
      if (Date.now() - this.engine.lastHookCleanupAt >= 3600000) {
        this.engine.lastHookCleanupAt = Date.now();
        await reapHookCheckouts(this.engine.store);
        try {
          const removed = pruneLiveDataHomeBackupCopies(dirname(this.engine.store.path));
          if (removed.length) this.engine.store.setMeta("dataHomeRetention", { checkedAt: new Date().toISOString(), removed });
        } catch (error) { this.engine.store.setMeta("dataHomeRetentionError", String(error)); }
      }
      if(!this.engine.store.getMeta('paused') && Date.now()-(this.engine.store.getMeta<number>('lastRetentionAt')??0)>=86400000){try{
        // Audit B5: a hook record is the only proof of an isolated checkout's ownership,
        // so the task's owned checkouts are reaped before its hook rows go. A task that
        // still owns an existing checkout keeps its whole history for the next pass.
        const candidates=this.engine.store.retentionCandidates(Date.now());
        if(candidates.length)await reapHookCheckouts(this.engine.store,{taskIds:new Set(candidates.map(task=>task.id))});
        this.engine.store.purgeOldTasks(Date.now(),(taskId,runIds)=>{this.engine.adapter.purgeReportingFiles?.(taskId,runIds);void this.engine.removeSiblings(taskId);try{removeTaskProofFiles(this.engine.store.task(taskId));}catch{/* Evidence whose recorded paths cannot be proved is left in place. */}});
        // Lean store 2 (task 987): the same windows the schema-52 migration applied, so rows that
        // outlive their task or run are pruned as they age out, not only once.
        this.engine.store.transaction(()=>this.engine.store.pruneRetainedRows(Date.now()));
        this.engine.store.setMeta('retentionError','');}catch(error){this.engine.store.setMeta('retentionError',String(error));this.engine.store.setMeta('lastRetentionAt',Date.now());}}
      // Lean store 4 (task 989): freed pages are released on every maintenance tick, not only
      // after a prune, while free pages exceed the drain threshold — one bounded pass per tick
      // at the drain bounds, so a freelist the size of a prune's backlog clears in minutes
      // instead of the days the hourly-only passes took (about 6 pages a minute after task 987
      // rolled). At or below the threshold this tick releases nothing: the passes after the
      // hourly and daily prunes are the only releases, so a steady store is not touched every
      // sweep. One chunk is one short write transaction, so the writer is never held for the
      // whole budget at once.
      if(!this.engine.store.getMeta('paused') && this.engine.store.storeFacts().freePages>RECLAIM_DRAIN_FREE_PAGES){try{
        this.engine.store.reclaimFreedPages({maxPages:RECLAIM_DRAIN_MAX_PAGES,budgetMs:RECLAIM_DRAIN_BUDGET_MS});}
        catch{ /* the pass records its own fault on the store */ }}
      // Spec 019: idle lanes close themselves; an hourly, bounded store pass that touches no task.
      if(!this.engine.store.getMeta('paused') && Date.now()-(this.engine.store.getMeta<number>('lastLaneIdleAt')??0)>=3600000){this.engine.store.setMeta('lastLaneIdleAt',Date.now());try{this.engine.store.closeIdleLanes();this.engine.store.setMeta('laneIdleError','');}catch(error){this.engine.store.setMeta('laneIdleError',String(error));}}
      // Spec 058 cutover 5: the one-time owner→planner migration runs before the drain
      // pass below, so notice routing never reads the retired owner machinery.
      if(!this.engine.store.getMeta('paused')){try{await this.engine.migrateProjectOwnersToPlanners();this.engine.store.setMeta('projectOwnerError','');}catch(error){this.engine.store.setMeta('projectOwnerError',String(error));}}
      // Spec 041: drained lanes and boards prompt their plan owner and escalate; hourly, bounded, no task touched.
      if(!this.engine.store.getMeta('paused') && Date.now()-(this.engine.store.getMeta<number>('lastLaneDrainAt')??0)>=3600000){this.engine.store.setMeta('lastLaneDrainAt',Date.now());try{this.engine.store.evaluateLaneDrains();this.engine.store.setMeta('laneDrainError','');}catch(error){this.engine.store.setMeta('laneDrainError',String(error));}}
      // Audit A6: one bounded labelled inventory answers every identity this
      // pass observes, and retired workers are re-read on their own slow cadence.
      // A list that cannot be walked to its end answers nothing, so every
      // identity falls back to the narrow read and no inactivity is inferred.
      let inventory: ReadonlyMap<string, AgentObservation> | null = null;
      const hosts = new Set([...this.engine.hostIds(), ...this.engine.store.activeCapacityTasks().flatMap(task => task.hostId ? [task.hostId] : [])]);
      for (const host of hosts) await this.engine.withHost(host, async () => {
        if (!this.engine.hostAvailable(host)) return;
        try { await this.engine.adapter.reconcileReportedSettlements?.(); } catch { /* durable host intents remain for the next sweep */ }
        const retiredPlan = this.engine.retiredObservationPlan();
        const inventoryIds = [...new Set([...retiredPlan.due, ...this.engine.resolution.observationTargets()])];
        let observed: ReadonlyMap<string, AgentObservation> | null = null;
        if (inventoryIds.length && this.engine.adapter.observationInventory) {
          try { observed = await this.engine.host.observationInventory(inventoryIds); }
          catch { observed = null; }
        }
        const retired = await this.engine.observeRetiredWorkers(retiredPlan, observed);
        if (retired.changed) this.engine.store.setMeta(this.engine.retiredObservationKey(host), retired.observations);
        if (this.engine.inventoryHostMatches(host)) inventory = observed;
      });
      this.engine.clearRetiredInvalidations();
      // Engine restart scans incomplete dispositions before normal task
      // resolution. The fence persists across restarts; retry reconciles the
      // same persisted effects and never launches general recovery. The sync
      // pre-check keeps passes without a fence on their exact previous timing.
      const preflight=this.engine.store.maintenanceTasks(true);
      if (!this.engine.stopped && preflight.some((task) => isDispositionActive(task)))
        await resumeDispositions(this.engine.store, this.engine.dispositionDeps());
      // Queue #650: unresolved paused-stop markers resume in their own threads
      // before recovery reads the same threads, so a fresh resume never races
      // an armed failover.
      if (!startsNoRuns(this.engine.store, this.engine.stopped)) await this.engine.resumePausedStops();
      if (!startsNoRuns(this.engine.store, this.engine.stopped)) await this.engine.recoverExhaustedWorkers();
      // Retired-errored archive is not drain settlement: it waits for unpause
      // (same as main). Running it under pause doubled the A6 retired-worker
      // observe. It does not hold `drained`.
      if (!startsNoRuns(this.engine.store, this.engine.stopped)) await this.engine.archiveRetiredErroredAgents();
      // Round 4: owner verbs recorded while paused or held apply once that clears.
      try { await this.engine.applyDeferredOwnerVerbs(); } catch { /* one task's replay never stalls the wake */ }
      if(this.engine.adapter.originAgent)await this.engine.resolution.origins.pass();
      // Keep the ordinary pass timing unchanged: only reach for the checkpoint
      // reconciler when a persisted continuation intent actually awaits delivery.
      if (preflight.some(task => task.checkpoints.intent && task.checkpoints.intent.status !== 'delivered')) await this.engine.resolution.checkpoints.pass();
      await this.engine.continueAwaitingReviewers(preflight);
      await this.engine.lifecycle.enqueuePass();
      const releasedTasks = new Set<string>();
      await this.engine.resolution.observe(inventory, undefined, taskId => {
        if (this.engine.scheduleLifecycleFollowUp(taskId)) releasedTasks.add(taskId);
        this.engine.wakeCapacityWaiter(taskId);
      });
      // A callback-free worker may still have completed and pushed the one
      // queue-owned branch PR. Reconcile that exact identity before recovery
      // spends a coordinator run. The retained worker still owes an
      // authenticated ready_for_review callback on a newly minted run.
      for (const task of (this.engine.adapter.findOpenBranchPr ? this.engine.store.activeCapacityTasks() : []).filter(task => this.engine.taskHostAvailable(task) && task.agentId && !completionReportsPr(task) && !task.prUrl && !task.prHead
        && !task.resumePrNumber && !this.engine.resolution.recovery.busy(task)
        && ["working", "blocked", "error", "needs_attention"].includes(task.phase))) {
        await boundQuantum(this.engine.scheduleLane(`task:${task.id}`, LANE_PRIORITY_TASK, async () => {
          try { await this.engine.reconcile(this.engine.store.task(task.id)); }
          catch (error) { this.engine.noteStepFailure(task.id, error); }
        // The quantum records its own faults; a lane-level failure here means
        // shutdown discarded the queued quantum, so the audit simply stops.
        }).catch(() => {}), () => this.recordQuantumOutage(task.id));
      }
      // One lifecycle quantum per task on an exclusive key. A control or
      // operation for the same task queues behind this quantum instead of
      // racing it, while unrelated keys keep awaiting remote effects
      // concurrently. The audit yields to the event loop between bounded
      // chunks so acceptance and reads stay responsive.
      const reconciled = new Set<string>();
      const order = this.engine.sweepOrder(drain);
      const cursorAt = this.engine.sweepCursor ? order.findIndex(task => task.id === this.engine.sweepCursor) : -1;
      const resume = cursorAt + 1 >= order.length ? 0 : cursorAt + 1;
      // A window reconciles one page from the cursor. A drain walks, from the
      // cursor round to the fleet's start, every task it has not yet visited:
      // the visited set carries across capped passes, so a task that finishes or
      // leaves the order never stands in for one that is still live.
      const sequence = drain
        ? [...order.slice(resume), ...order.slice(0, resume)].filter(task => !visited.has(task.id))
        : order;
      let index = drain ? 0 : resume;
      let windows = 0;
      for (;;) {
        if (index >= sequence.length) break;
        const window = sequence.slice(index, index + SWEEP_WINDOW);
        const pending: Promise<void>[] = [];
        for (const candidate of window) {
          if (this.engine.stopped) return { fault: null, covered: false, visited };
          visited.add(candidate.id);
          const task = this.engine.store.task(candidate.id);
          if (["done", "cancelled"].includes(task.phase)) continue;
          // Spec 058 budgets (nucleus#1153): the wall clock pauses while the host, a
          // workspace or a dispatch hold keeps the task from progress — including a
          // task whose quantum this sweep cannot start at all.
          this.engine.resolution.settleBudgetClock(task);
          reconciled.add(task.id);
          if (releasedTasks.has(task.id)) continue; // The release already queued this task.
          pending.push(boundQuantum(this.engine.scheduleTaskQuantum(task.id), () => this.recordQuantumOutage(task.id)));
          // Independent lanes may await concurrently. Paseo and process
          // admission still bound the actual resources; same-task lanes stay FIFO.
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        await Promise.all(pending);
        index += window.length;
        const wrapped = !drain && index >= sequence.length;
        // The durable cursor resumes the next pass where this one stopped and
        // resets once a window wraps or a drain has covered the fleet.
        this.engine.sweepCursor = wrapped ? null : window.at(-1)?.id ?? null;
        this.engine.sweepStats.windows++;
        this.engine.sweepStats.swept += window.length;
        this.engine.sweepStats.lastPassAt = now();
        windows++;
        // One bounded page per window. An explicit drain keeps going until it has
        // visited every task once, or its window cap continues it in the next pass;
        // a safety-tick window reconciles one page and yields to every other lane.
        if (this.engine.stopped || !drain || windows >= this.engine.maxSweepWindows) break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      // Coverage is judged against this pass's fleet: every task in it visited.
      covered = !drain || order.every(task => visited.has(task.id));
      if (drain && covered) this.engine.sweepCursor = null;
      // The capacity-blocked queue is advanced by dispatch wakes when a slot frees,
      // so a minute sweep rotates one window of it on a slower cadence instead of
      // letting it set the lap time for active work. A drain has already covered it.
      if (!drain && this.engine.sweepDeferred.length && this.engine.sweepTicks++ % DEFERRED_SWEEP_EVERY === 0) {
        const deferred = this.engine.sweepDeferred;
        const at = this.engine.sweepDeferredCursor ? deferred.findIndex(task => task.id === this.engine.sweepDeferredCursor) : -1;
        const start = at + 1 >= deferred.length ? 0 : at + 1;
        const window = deferred.slice(start, start + SWEEP_WINDOW);
        for (const candidate of window) {
          if (this.engine.stopped) return { fault: null, covered: false, visited };
          const task = this.engine.store.task(candidate.id);
          if (["done", "cancelled"].includes(task.phase)) continue;
          this.engine.resolution.settleBudgetClock(task);
          reconciled.add(task.id);
          if (!releasedTasks.has(task.id)) await boundQuantum(this.engine.scheduleTaskQuantum(task.id), () => this.recordQuantumOutage(task.id));
        }
        this.engine.sweepDeferredCursor = start + window.length >= deferred.length ? null : window.at(-1)?.id ?? null;
      }
      await this.engine.resolution.deliverNotices();
      await this.engine.resolution.deliverQueuedMessages();
      await this.engine.resolution.resumeAskQuestions();
      await this.engine.resolution.raiseOperatorQuestions();
      await this.engine.resolution.delegateNativeQuestions();
      await this.engine.resolution.resumeResponsibleAnsweredQuestions();
      await this.engine.resolution.deliverHoldNotices();
      await this.engine.resolution.deliverDecisionNotices();
      await this.engine.resolution.deliverDrainNotices();
      if(this.engine.stopped)return { fault: null, covered: false, visited };
      if(startsNoRuns(this.engine.store, this.engine.stopped)){for(const id of reconciled)this.engine.enqueueTitle(id);return { fault: null, covered, visited };}
      await this.engine.dispatchQueued();
      for(const id of reconciled)this.engine.enqueueTitle(id);
      return { fault: null, covered, visited };
    } catch (error) { this.engine.store.setMeta("engineError", String(error)); return { fault: error instanceof Error ? error : new Error(String(error)), covered: false, visited }; }
  }
}
