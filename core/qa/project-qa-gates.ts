/**
 * The in-process state one runner keeps about the runs it is itself driving.
 *
 * The durable supervision file is the cross-process fence; these maps only stop
 * one process reconciling away a run it is driving itself (`qaLaunchGates`),
 * share one attach watcher between concurrent readers (`qaAttachments`), and
 * share one recovery step per repository key (`qaRecoveries`). Nothing here is
 * durable and nothing outlives the process.
 */
export class QaInFlightMap {
  private readonly entries = new Map<string, Promise<unknown>>();
  has(key: string): boolean { return this.entries.has(key); }
  get(key: string): Promise<unknown> | undefined { return this.entries.get(key); }
  set(key: string, promise: Promise<unknown>): void { this.entries.set(key, promise); }
  delete(key: string): void { this.entries.delete(key); }
}

/** The launch pipeline for a run that has not been handed to a detached supervisor, by repository key. */
export const qaLaunchGates = new QaInFlightMap();
/** Attached watchers by run id, so concurrent reads share one. */
export const qaAttachments = new QaInFlightMap();
/** The recovery step in flight for one repository key. */
export const qaRecoveries = new QaInFlightMap();
