import { AsyncLocalStorage } from "node:async_hooks";
import { LANE_PRIORITY_CONTROL } from "./lane-priorities";

interface LaneItem { priority: number; run: () => Promise<void>; settle: () => void; fail: (error: unknown) => void }

/**
 * Exclusive per-key quanta, quiesce and shutdown. Same-name `Engine` methods
 * delegate here. The arrows read the engine per call: tests stop it, seed a bare
 * engine and replace `cleanContext`.
 */
export class LaneScheduler {
  constructor(
    private readonly isStopped: () => boolean,
    private readonly busyExtra: () => boolean,
    private readonly cleanContext: <T>(work: () => T) => T,
  ) {}
  private get stopped() { return this.isStopped(); }
  private lanes = new Map<string, LaneItem[]>();
  activeLanes = new Set<string>();
  /**
   * Lane key currently executing in this async context. Nested work for a key
   * the current lane already holds runs inline instead of queueing a second
   * quantum, so a command lane can never exhaust the concurrency slots waiting
   * for its own task lane.
   */
  private readonly laneKey = new AsyncLocalStorage<string>();
  private dispatchScheduled = false;
  private quiesceWaiters: { resolve: () => void; ignoreKey?: string }[] = [];
  /** wake() calls still in their prelude: accepted, but with no lane to show for it yet. */
  wakePreludes = 0;
  /** Schedule one bounded quantum on an exclusive lane key. Same-key work is FIFO. */
  scheduleLane(key: string, priority: number, work: () => Promise<void> | void): Promise<void> {
    // Inline when the current lane already holds this key: a command that
    // performs its task-scoped effect must not queue a second quantum behind
    // itself. After `stop()` nothing new is queued either, so a durable command
    // that only needs one short transaction (a disposition fence or an accepted
    // receipt) still completes inline and an effect quantum is never parked
    // forever holding a slot.
    if (this.stopped || this.laneKey.getStore() === key) return Promise.resolve().then(work).then(() => undefined);
    return new Promise<void>((resolve, reject) => {
      const queue = this.lanes.get(key) ?? [];
      queue.push({ priority, run: async () => { await work(); }, settle: resolve, fail: reject });
      this.lanes.set(key, queue);
      this.dispatchLanes();
    });
  }
  /**
   * Resolves once currently scheduled lane work and already-accepted lifecycle
   * follow-ups have finished, including follow-ups those quanta legitimately
   * schedule. This is the completed Queue lane-and-follow-up set: not a global
   * writer lock, not a guarantee against future external callbacks, and not
   * proof of external run settlement. Title and cleanup projections stay on
   * their own drain (`wake()`). A call from inside a lane ignores that lane so
   * the current quantum cannot deadlock waiting for itself.
   */
  quiesce(exclude?: "audit"): Promise<void> {
    // `wake()` excludes the audit lane: trailing safety-tick windows on it are
    // not the drain's work, and under continuous ticks it is never idle.
    const ignoreKey = exclude ?? this.laneKey.getStore();
    if (!this.engineBusy(ignoreKey)) return Promise.resolve();
    return new Promise<void>(resolve => { this.quiesceWaiters.push({ resolve, ignoreKey }); });
  }
  /**
   * True while a quantum is active or queued, a dispatch turn is scheduled, or a
   * lifecycle follow-up has been accepted but has not yet enqueued its lane.
   * `ignoreKey` is the caller's current lane when quiesce runs from inside a
   * quantum.
   */
  engineBusy(ignoreKey?: string): boolean {
    if (this.busyExtra()) return true;
    if (this.dispatchScheduled) return true;
    if (this.wakePreludes && !this.stopped) return true;
    for (const key of this.activeLanes) if (key !== ignoreKey) return true;
    for (const [key, queue] of this.lanes) {
      if (key === ignoreKey || !queue.length) continue;
      return true;
    }
    return false;
  }
  pickLaneKey(): string | null {
    let best: string | null = null, bestPriority = Number.POSITIVE_INFINITY;
    for (const [key, queue] of this.lanes) {
      if (!queue.length || this.activeLanes.has(key)) continue;
      if (queue[0].priority < bestPriority) { best = key; bestPriority = queue[0].priority; }
    }
    return best;
  }
  /**
   * Queue no longer caps lanes globally (Spec 012, Tom 2026-09-27): a blanket cap
   * starves unrelated work, and waiting on an ordered lane queue costs nothing.
   * One active quantum per key still holds, because that is what prevents a task
   * or repository from racing itself. The real resources are bounded where they
   * are used: concurrent Paseo daemon calls by the admission controller and
   * concurrently spawned processes by the spawn gate. One key is started per
   * event-loop turn so a burst of starts never blocks timers or operator reads.
   */
  private settledQuanta = 0;
  /** A count that rises whenever a lane quantum finishes: evidence a long pass is still making progress. */
  progressMark(): number { return this.settledQuanta; }
  dispatchLanes(): void {
    if (this.stopped) return;
    const key = this.pickLaneKey();
    if (!key) return;
    const queue = this.lanes.get(key)!;
    const item = queue.shift()!;
    if (queue.length) this.lanes.set(key, queue); else this.lanes.delete(key);
    this.activeLanes.add(key);
    void this.cleanContext(() => this.laneKey.run(key, () => item.run()))
      .then(() => item.settle(), error => item.fail(error))
      // Re-dispatch on the next macrotask so a burst of synchronous quanta
      // cannot starve timers, sockets and operator reads.
      .finally(() => { this.activeLanes.delete(key); this.settledQuanta++; this.scheduleDispatch(); });
    // More independent keys are eligible: start the next one next turn.
    if (this.pickLaneKey() !== null) this.scheduleDispatch();
  }
  scheduleDispatch(): void {
    if (this.dispatchScheduled) return;
    this.dispatchScheduled = true;
    setImmediate(() => {
      this.dispatchScheduled = false;
      this.dispatchLanes();
      this.settleQuiesce();
    });
  }
  settleQuiesce(): void {
    if (this.stopped) this.discardQueuedLanes();
    const waiters = this.quiesceWaiters;
    this.quiesceWaiters = [];
    const remaining: { resolve: () => void; ignoreKey?: string }[] = [];
    for (const waiter of waiters) {
      if (this.engineBusy(waiter.ignoreKey)) remaining.push(waiter);
      else waiter.resolve();
    }
    this.quiesceWaiters.push(...remaining);
  }
  /**
   * Fail every queued lane quantum so shutdown can complete. A command that
   * never ran keeps its durable identity: an unfinished operation stays
   * `pending` and is reconciled on the next start rather than hanging `stop()`
   * and skipping the process-lease release.
   */
  discardQueuedLanes(): void {
    if (!this.lanes.size) return;
    const queued: LaneItem[] = [];
    for (const queue of this.lanes.values()) queued.push(...queue);
    this.lanes.clear();
    for (const item of queued) item.fail(new Error("Nucleus engine stopped before this quantum ran"));
  }
  async control<T>(operation: () => Promise<T> | T, key: string): Promise<T> {
    let result!: T;
    await this.scheduleLane(key, LANE_PRIORITY_CONTROL, async () => { result = await operation(); });
    return result;
  }
}
