import type { Engine } from "../engine";
import { LANE_PRIORITY_TASK } from "../scheduling/lane-priorities";

/**
 * Schedule one owed runtime-retirement proof on its own lane, so a slow Effigy CLI never
 * holds the audit pass. Duplicate sweeps coalesce onto the same key; the durable backoff
 * and record state decide whether work is due, so a lane fault loses nothing. Cross-owner
 * calls go through the same-name `Engine` methods, so an instance override still fires.
 */
export class RetirementLane {
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  constructor(readonly engine: Engine) {}

  schedule(taskId: string): void {
    if (this.engine.stopped || this.queued.has(taskId) || this.running.has(taskId)) return;
    this.queued.add(taskId);
    void this.engine.scheduleLane(`runtime-retirement:${taskId}`, LANE_PRIORITY_TASK, async () => {
      this.queued.delete(taskId);
      this.running.add(taskId);
      try {
        const task = this.engine.store.task(taskId);
        if (task.hostId) await this.engine.withHost(task.hostId, async () => {
          if (this.engine.taskHostAvailable(task)) await this.engine.retirement.retryDue(taskId);
        });
      }
      finally { this.running.delete(taskId); }
    // The retirement record and its backoff are the restart authority, so a lane the
    // engine refused has nothing else to record here.
    }).catch(() => {});
  }
}
