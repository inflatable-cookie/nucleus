/**
 * The occurrence ledger the projection lanes share with their waiters: how many
 * occurrences were enqueued per key, how many finished, and which are in flight.
 * A queued occurrence absorbs a re-enqueue (it reads the latest state), so only a
 * new queue entry counts; an entry queued behind one in flight is a second
 * occurrence. `wake()` waits until every occurrence at its cut is processed, not
 * until the queue drains, so a later arrival never extends an earlier wait.
 */
export class ProjectionOccurrences {
  enqueued = new Map<string, number>();
  done = new Map<string, number>();
  inFlight = new Set<string>();
  waiters: (() => void)[] = [];

  /** Count one new occurrence for `key`, before its queue entry exists. */
  enqueue(key: string): void { this.enqueued.set(key, (this.enqueued.get(key) ?? 0) + 1); }
  /** Mark the occurrence `key` as being processed now. */
  begin(key: string): void { this.inFlight.add(key); }
  /** The occurrence `key` finished: count it and wake every waiter. */
  end(key: string): void {
    this.inFlight.delete(key);
    this.done.set(key, (this.done.get(key) ?? 0) + 1);
    this.wake();
  }
  /** A drain ended without an occurrence to count (a stop, a pause, or an empty queue): wake waiters only. */
  settle(): void { this.wake(); }
  /** In-flight occurrences whose key starts with `prefix`, for the lanes' cuts. */
  inFlightKeys(prefix: string): string[] { return [...this.inFlight].filter(key => key.startsWith(prefix)); }
  /** Every named key's occurrence count at this instant: the cut a wait is taken at. */
  cut(keys: string[]): Map<string, number> { return new Map(keys.map(key => [key, this.enqueued.get(key) ?? 0])); }
  /**
   * Wait until every occurrence counted at `pending` has been processed, kicking
   * `drain` after each wake. `keepWaiting` ends the wait once the engine stops or the
   * store pauses, so a waiter never holds a stopped process open.
   */
  async awaitCut(pending: Map<string, number>, drain: () => Promise<void>, keepWaiting: () => boolean): Promise<void> {
    const outstanding = () => [...pending].some(([key, target]) => (this.done.get(key) ?? 0) < target);
    void drain();
    while (keepWaiting() && outstanding()) {
      await new Promise<void>(resolve => { this.waiters.push(resolve); });
      void drain();
    }
  }
  /** Wait for the occurrence of one key enqueued so far, not for an older same-key completion. */
  awaitOccurrence(key: string, drain: () => Promise<void>, keepWaiting: () => boolean): Promise<void> {
    return this.awaitCut(this.cut([key]), drain, keepWaiting);
  }
  private wake(): void { for (const resolve of this.waiters.splice(0)) resolve(); }
}

/** The occurrence key of one task's title projection. */
export const titleOccurrenceKey = (taskId: string): string => `title:${taskId}`;

/** The occurrence key of one task's cleanup projection, retry workspace included. */
export const cleanupOccurrenceKey = (taskId: string, retryWorkspaceId?: string): string => `cleanup:${taskId}:${retryWorkspaceId ?? ""}`;

/**
 * Await the title and cleanup projections queued at this cut (explicit
 * reconciliation only): titles, then cleanup. An item counts once it has been
 * processed after the cut; items a later window queues are not awaited, so a
 * continuing window cannot extend this wait. A reconciliation wake asks for
 * titles only: it kicks the cleanup lane and leaves it to its own durable
 * progress, so one slow workspace archive cannot hold the board's diagnostic.
 */
export async function drainProjectionCut(input: {
  occurrences: ProjectionOccurrences;
  titles: { queue: Iterable<string>; drain(): Promise<void> };
  cleanups: { queue: Iterable<{ taskId: string; retryWorkspaceId?: string }>; drain(): Promise<void> };
  /** False for a wake that leaves cleanup to its own durable progress. */
  awaitCleanup: boolean;
  keepWaiting(): boolean;
}): Promise<void> {
  const { occurrences } = input;
  // Both cuts are taken now, including items already in flight.
  const titles = occurrences.cut([...[...input.titles.queue].map(titleOccurrenceKey), ...occurrences.inFlightKeys("title:")]);
  const cleanups = !input.awaitCleanup ? null
    : occurrences.cut([...[...input.cleanups.queue].map(entry => cleanupOccurrenceKey(entry.taskId, entry.retryWorkspaceId)), ...occurrences.inFlightKeys("cleanup:")]);
  await occurrences.awaitCut(titles, () => input.titles.drain(), input.keepWaiting);
  if (!cleanups) { void input.cleanups.drain(); return; }
  await occurrences.awaitCut(cleanups, () => input.cleanups.drain(), input.keepWaiting);
}
