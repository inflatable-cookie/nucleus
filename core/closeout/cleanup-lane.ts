import type { Task } from "../../shared/contracts";
import type { Engine } from "../engine";
import { CLEANUP_CONCURRENCY } from "../host/admission";
import { ProjectionOccurrences, cleanupOccurrenceKey } from "../scheduling/projection-occurrences";

/** One queued cleanup: the task whose workspace is due, and the retry workspace it names. */
export type CleanupEntry = { taskId: string; retryWorkspaceId?: string };

/**
 * The restart-safe cleanup lane: terminal archive work for one task, never two entries
 * for the same task at once, and the durable retry follow-ups that wake it. It schedules
 * only; `Lifecycle.archive` owns what an archive pass proves and records. Cross-owner
 * calls go through the same-name `Engine` methods, so an instance override still fires.
 */
export class CleanupLane {
  queue: CleanupEntry[] = [];
  draining: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly retryFollowUps = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  constructor(readonly engine: Engine, private readonly occurrences: ProjectionOccurrences) {}
  private get store() { return this.engine.store; }
  private get stopped() { return this.engine.stopped; }
  private get completionFollowUpDelays() { return this.engine.completionFollowUpDelays; }

  /** Disarm the archive retry timers; called from `Engine.stop`. */
  stop(): void {
    for (const follow of this.retryFollowUps.values()) if (follow.timer) clearTimeout(follow.timer);
    this.retryFollowUps.clear();
  }

  /** Restart-safe cleanup lane; entries for the same task never overlap. */
  enqueue(taskId: string, retryWorkspaceId?: string): void {
    if (this.stopped) return;
    if (this.queue.some(entry => entry.taskId === taskId && entry.retryWorkspaceId === retryWorkspaceId)) {
      void this.engine.drainCleanup();
      return;
    }
    this.occurrences.enqueue(cleanupOccurrenceKey(taskId, retryWorkspaceId));
    this.queue.push({ taskId, retryWorkspaceId });
    this.wake?.();
    void this.engine.drainCleanup();
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      const running = new Map<string, Promise<void>>();
      while (running.size || (!this.stopped && !this.store.getMeta("paused") && this.queue.length)) {
        while (!this.stopped && !this.store.getMeta("paused") && running.size < CLEANUP_CONCURRENCY) {
          const index = this.queue.findIndex(entry => !running.has(entry.taskId));
          if (index < 0) break;
          const { taskId, retryWorkspaceId } = this.queue.splice(index, 1)[0];
          const key = cleanupOccurrenceKey(taskId, retryWorkspaceId);
          this.occurrences.begin(key);
          const work = Promise.resolve().then(async () => {
            try {
              const task = this.store.task(taskId);
              const hasDisplaced =
                task.resolution.displacedHostWorkspaces?.some(
                  (entry) => entry.state !== "archived",
                ) ?? false;
              if (task.hostId) await this.engine.withHost(task.hostId, async () => {
                if (this.engine.taskHostAvailable(task) || hasDisplaced) await this.engine.lifecycle.archive(task, retryWorkspaceId);
              });
              else if (hasDisplaced) {
                await this.engine.lifecycle.archive(task, retryWorkspaceId);
              }
            }
            // The archive records its own refusal and retry on the task, which is what a
            // later sweep reads; a fault outside the archive names nothing to record here.
            catch { /* cleanup failure stays visible through the recorded cleanupReason */ }
            finally {
              this.engine.scheduleCleanupRetry(taskId);
              this.occurrences.end(key);
              running.delete(taskId);
            }
          });
          running.set(taskId, work);
        }
        if (running.size) {
          const wake = new Promise<void>(resolve => { this.wake = resolve; });
          await Promise.race([...running.values(), wake]);
          this.wake = null;
        }
        else break;
      }
    })().finally(() => {
      this.draining = null;
      this.occurrences.settle();
      if (!this.stopped && !this.store.getMeta("paused") && this.queue.length) void this.engine.drainCleanup();
    });
    return this.draining;
  }

  /** Respect each durable archive backoff while waking only this task. */
  scheduleRetry(taskId: string): void {
    // A cleanup finishing while the service drains must not read a closed store.
    // The durable archive retry stays on the task, so the next start resumes it.
    let task: Task;
    try { task = this.store.task(taskId); }
    catch {
      const follow = this.retryFollowUps.get(taskId);
      if (follow?.timer) clearTimeout(follow.timer);
      this.retryFollowUps.delete(taskId);
      return;
    }
    const due = task.phase === "done" && !task.removedAt
      ? task.resolution.workspaceArchiveRetries.map(retry => Date.parse(retry.nextAttemptAt)).filter(Number.isFinite)
      : [];
    let follow = this.retryFollowUps.get(taskId);
    if (!due.length || this.stopped) {
      if (follow?.timer) clearTimeout(follow.timer);
      this.retryFollowUps.delete(taskId);
      return;
    }
    if (!follow) { follow = { attempts: 0 }; this.retryFollowUps.set(taskId, follow); }
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
}
