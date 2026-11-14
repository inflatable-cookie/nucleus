import type { Task } from "../../shared/contracts";
import { CLEANUP_CONCURRENCY } from "../host/admission";
import { doublingDelay } from "../../shared/backoff";
import type { Engine } from "../engine";
import { LANE_PRIORITY_TASK } from "../scheduling/lane-priorities";
import { terminalArchiveWorkspaces } from "../closeout/terminal-archive";
import { taskWorkspaceTitle } from "../workspaces/workspace-title";

/**
 * Projections outside the delivery lanes: workspace titles, the serial archive
 * drain and its retry timers, runtime-retirement scheduling, and the occurrence
 * counts `wake()` and `retry_effect` wait on. Same-name `Engine` methods delegate
 * here and cross-method calls go through them, so instance overrides still fire.
 * The getters read the engine per call: tests replace the adapter and seed a bare
 * engine.
 */
export class Projections {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get stopped() { return this.engine.stopped; }
  get lifecycle() { return this.engine.lifecycle; }
  get retirement() { return this.engine.retirement; }
  get admission() { return this.engine.admission; }
  get completionFollowUpDelays() { return this.engine.completionFollowUpDelays; }
  /**
   * Title and cleanup projections run outside the delivery lane pool: one
   * latest title intent per task and one serial archive drain. A slow Paseo
   * title or archive therefore never holds a callback, control or turn lane.
   */
  titleQueue = new Set<string>();
  /**
   * Projection occurrences enqueued and processed so far, by key. A queued
   * occurrence absorbs a re-enqueue (it reads the latest state), so only a new
   * queue entry counts; an entry queued behind one in flight is a second
   * occurrence. `wake()` waits until every occurrence at its cut is processed.
   */
  projectionEnqueued = new Map<string, number>();
  projectionDone = new Map<string, number>();
  projectionWaiters: (() => void)[] = [];
  projectionInFlight = new Set<string>();
  titleDraining: Promise<void> | null = null;
  cleanupQueue: Array<{taskId:string;retryWorkspaceId?:string}> = [];
  cleanupDraining: Promise<void> | null = null;
  private cleanupWake: (() => void) | null = null;
  private readonly cleanupRetryFollowUps = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  private readonly retirementQueued = new Set<string>();
  private readonly retirementRunning = new Set<string>();
  /** Disarm the archive retry timers; called from `Engine.stop`. */
  stop(): void {
    for (const follow of this.cleanupRetryFollowUps.values()) if (follow.timer) clearTimeout(follow.timer);
    this.cleanupRetryFollowUps.clear();
  }
  /** One latest title intent per task, projected outside the delivery lanes. */
  enqueueTitle(taskId: string): void {
    if (this.stopped) return;
    if (!this.titleQueue.has(taskId)) this.projectionEnqueued.set(`title:${taskId}`, (this.projectionEnqueued.get(`title:${taskId}`) ?? 0) + 1);
    this.titleQueue.add(taskId);
    void this.engine.drainTitles();
  }
  drainTitles(): Promise<void> {
    if (this.titleDraining) return this.titleDraining;
    this.titleDraining = (async () => {
      while (!this.stopped && this.titleQueue.size) {
        const taskId = this.titleQueue.values().next().value as string;
        this.titleQueue.delete(taskId);
        this.projectionInFlight.add(`title:${taskId}`);
        try {
          const task = this.store.task(taskId);
          if (task.hostId) await this.engine.withHost(task.hostId, async () => {
            if (this.engine.taskHostAvailable(task)) await this.engine.syncWorkspaceTitle(task);
          });
        }
        catch { /* the durable title state records its own failure and backoff */ }
        this.projectionInFlight.delete(`title:${taskId}`);
        this.projectionProcessed(`title:${taskId}`);
      }
    })().finally(() => { this.titleDraining = null; this.projectionProcessed(null); });
    return this.titleDraining;
  }
  /**
   * Schedule one owed runtime-retirement proof on its own lane, so a slow
   * Effigy CLI never holds the audit pass. Duplicate sweeps coalesce onto the
   * same key; the durable backoff and record state decide whether work is due.
   */
  scheduleRetirement(taskId: string): void {
    if (this.stopped || this.retirementQueued.has(taskId) || this.retirementRunning.has(taskId)) return;
    this.retirementQueued.add(taskId);
    void this.engine.scheduleLane(`runtime-retirement:${taskId}`, LANE_PRIORITY_TASK, async () => {
      this.retirementQueued.delete(taskId);
      this.retirementRunning.add(taskId);
      try {
        const task = this.store.task(taskId);
        if (task.hostId) await this.engine.withHost(task.hostId, async () => {
          if (this.engine.taskHostAvailable(task)) await this.retirement.retryDue(taskId);
        });
      }
      finally { this.retirementRunning.delete(taskId); }
    }).catch(() => {});
  }
  /** Restart-safe cleanup lane; entries for the same task never overlap. */
  enqueueCleanup(taskId: string, retryWorkspaceId?:string): void {
    if (this.stopped) return;
    if (this.cleanupQueue.some(entry=>entry.taskId===taskId&&entry.retryWorkspaceId===retryWorkspaceId)) {
      void this.engine.drainCleanup();
      return;
    }
    const key = `cleanup:${taskId}:${retryWorkspaceId ?? ""}`;
    this.projectionEnqueued.set(key, (this.projectionEnqueued.get(key) ?? 0) + 1);
    this.cleanupQueue.push({taskId,retryWorkspaceId});
    this.cleanupWake?.();
    void this.engine.drainCleanup();
  }
  drainCleanup(): Promise<void> {
    if (this.cleanupDraining) return this.cleanupDraining;
    this.cleanupDraining = (async () => {
      const running = new Map<string, Promise<void>>();
      while (running.size || (!this.stopped && !this.store.getMeta("paused") && this.cleanupQueue.length)) {
        while (!this.stopped && !this.store.getMeta("paused") && running.size < CLEANUP_CONCURRENCY) {
          const index = this.cleanupQueue.findIndex(entry => !running.has(entry.taskId));
          if (index < 0) break;
          const {taskId,retryWorkspaceId} = this.cleanupQueue.splice(index, 1)[0];
          const key = `cleanup:${taskId}:${retryWorkspaceId ?? ""}`;
          this.projectionInFlight.add(key);
          const work = Promise.resolve().then(async () => {
            try {
              const task = this.store.task(taskId);
              if (task.hostId) await this.engine.withHost(task.hostId, async () => {
                if (this.engine.taskHostAvailable(task)) await this.lifecycle.archive(task,retryWorkspaceId);
              });
            }
            catch { /* cleanup failure stays visible through the recorded cleanupReason */ }
            finally {
              this.engine.scheduleCleanupRetry(taskId);
              this.projectionInFlight.delete(key);
              this.projectionProcessed(key);
              running.delete(taskId);
            }
          });
          running.set(taskId, work);
        }
        if (running.size) {
          const wake = new Promise<void>(resolve => { this.cleanupWake = resolve; });
          await Promise.race([...running.values(), wake]);
          this.cleanupWake = null;
        }
        else break;
      }
    })().finally(() => {
      this.cleanupDraining = null;
      this.projectionProcessed(null);
      if (!this.stopped && !this.store.getMeta("paused") && this.cleanupQueue.length) void this.engine.drainCleanup();
    });
    return this.cleanupDraining;
  }
  /** Respect each durable archive backoff while waking only this task. */
  scheduleCleanupRetry(taskId: string): void {
    // A cleanup finishing while the service drains must not read a closed store.
    // The durable archive retry stays on the task, so the next start resumes it.
    let task: Task;
    try { task = this.store.task(taskId); }
    catch {
      const follow = this.cleanupRetryFollowUps.get(taskId);
      if (follow?.timer) clearTimeout(follow.timer);
      this.cleanupRetryFollowUps.delete(taskId);
      return;
    }
    const due = task.phase === "done" && !task.removedAt
      ? task.resolution.workspaceArchiveRetries.map(retry => Date.parse(retry.nextAttemptAt)).filter(Number.isFinite)
      : [];
    let follow = this.cleanupRetryFollowUps.get(taskId);
    if (!due.length || this.stopped) {
      if (follow?.timer) clearTimeout(follow.timer);
      this.cleanupRetryFollowUps.delete(taskId);
      return;
    }
    if (!follow) { follow = { attempts: 0 }; this.cleanupRetryFollowUps.set(taskId, follow); }
    if (follow.timer || follow.attempts >= this.completionFollowUpDelays.length) return;
    const delay = Math.max(this.completionFollowUpDelays[follow.attempts++], Math.min(...due) - Date.now());
    follow.timer = setTimeout(() => {
      follow!.timer = undefined;
      if (this.stopped || this.store.getMeta("paused")) return;
      this.engine.cleanContext(() => {
        void this.engine.scheduleRunBuildOutputs(taskId).then(() => this.engine.enqueueCleanup(taskId)).catch(() => {});
      });
    }, delay);
    follow.timer.unref();
  }
  /**
   * Wait until the occurrence of `key` enqueued so far has been processed, not
   * for the queue to empty and not for an older same-key completion. Later
   * arrivals are not awaited.
   */
  async awaitProjectionOccurrence(key: string, drain: () => Promise<void>): Promise<void> {
    const target = this.projectionEnqueued.get(key) ?? 0;
    void drain();
    while (!this.stopped && this.store.getMeta('paused') !== true && (this.projectionDone.get(key) ?? 0) < target) {
      await new Promise<void>(resolve => { this.projectionWaiters.push(resolve); });
      void drain();
    }
  }
  private projectionProcessed(key: string | null): void {
    if (key) this.projectionDone.set(key, (this.projectionDone.get(key) ?? 0) + 1);
    for (const resolve of this.projectionWaiters.splice(0)) resolve();
  }
  /**
   * Await the title and cleanup projections queued at this cut (explicit
   * reconciliation only): titles, then cleanup, as before. An item counts once
   * it has been processed after the cut; items a later window queues are not
   * awaited, so continuing windows cannot extend this wait. A reconciliation
   * wake asks for titles only (`cleanup: false`): it kicks the cleanup lane and
   * leaves it to its own durable progress, so one slow workspace archive cannot
   * hold the board's reconciliation diagnostic.
   */
  async drainProjections(options: { cleanup?: boolean } = {}): Promise<void> {
    // The cut is every occurrence enqueued so far for the keys queued or in flight now.
    const cut = (keys: string[]) => new Map(keys.map(key => [key, this.projectionEnqueued.get(key) ?? 0]));
    const settled = async (pending: Map<string, number>, drain: () => Promise<void>) => {
      void drain();
      while (!this.stopped && this.store.getMeta('paused') !== true && [...pending].some(([key, target]) => (this.projectionDone.get(key) ?? 0) < target)) {
        await new Promise<void>(resolve => { this.projectionWaiters.push(resolve); });
        void drain();
      }
    };
    // Both cuts are taken now, including items already in flight.
    const inFlight = (kind: string) => [...this.projectionInFlight].filter(key => key.startsWith(kind));
    const titles = cut([...[...this.titleQueue].map(id => `title:${id}`), ...inFlight("title:")]);
    const cleanups = options.cleanup === false ? null
      : cut([...this.cleanupQueue.map(entry => `cleanup:${entry.taskId}:${entry.retryWorkspaceId ?? ""}`), ...inFlight("cleanup:")]);
    await settled(titles, () => this.engine.drainTitles());
    if (!cleanups) { void this.engine.drainCleanup(); return; }
    await settled(cleanups, () => this.engine.drainCleanup());
  }
  async syncWorkspaceTitle(task: Task) {
    if(!this.adapter.setTaskWorkspaceTitle)return;
      if(this.stopped)return;
      if(!task.workspaceId||task.resolution.archivedWorkspaceIds.includes(task.workspaceId))return;
      const references=new Map(this.store.tasks().map(candidate=>[candidate.id,candidate.phase==='done'?'':candidate.reference||(candidate.number?`#${String(candidate.number).padStart(3,'0')}`:'')]));
      const hasPendingQuestion=this.store.listDecisions({status:'open',task:task.id}).length>0;
      const desired=taskWorkspaceTitle(hasPendingQuestion?{...task,waitState:{state:'needs_operator_input',owner:'operator'}}:task,references),key=`workspaceTitle:${task.id}`;
      const state=this.store.getMeta<{desired:string;phase?:Task["phase"];held?:boolean;confirmed:string|null;requestId:string;intent:boolean;error:string;failures?:number;retryAt?:number}>(key);
      // Work is emitted only from an actual phase transition: an unchanged,
      // already-confirmed title is not re-sent to Paseo on an ordinary sweep.
      if(state?.confirmed===desired&&!state.intent&&state.phase===task.phase&&state.held===task.held)return;
      if(state?.desired===desired && state.retryAt && Date.now() < state.retryAt)return;
      // Degraded admission defers nonessential workspace mutation. The durable
      // intent is unchanged, so the next healthy sweep retries the same title.
      if(this.admission?.degradedNow)return;
      const uncertain=Boolean(state?.intent&&state.desired===desired);
      const requestId=state?.desired===desired?state.requestId:`ns-title-${task.id}-${task.version}`;
      this.store.setMeta(key,{desired,phase:task.phase,held:task.held,confirmed:state?.confirmed??null,requestId,intent:true,error:'',failures:state?.desired===desired?state.failures??0:0});
      try{
        await this.adapter.setTaskWorkspaceTitle(task,desired,requestId,uncertain);
        this.store.setMeta(key,{desired,phase:task.phase,held:task.held,confirmed:desired,requestId,intent:false,error:'',failures:0});
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        const failures=(state?.desired===desired?state.failures??0:0)+1;
        const retryAt=Date.now()+doublingDelay(5_000,300_000,failures);
        this.store.setMeta(key,{desired,phase:task.phase,held:task.held,confirmed:state?.confirmed??null,requestId,intent:true,error:message,failures,retryAt});
        if(state?.error!==message)this.store.event(task.id,'workspace_title_failed',message);
      }
  }
}
