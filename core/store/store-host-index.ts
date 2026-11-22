import type { Task } from "../../shared/contracts";

/**
 * Where one projected row sits in the pass-facing sets: its host and whether it is
 * live or finished. A removed row is in no set.
 */
type Membership = { host: string; finished: boolean };

/** The host key a task without a host is filed under; no host pass reads it. */
const NO_HOST = "";

/** Whether a projected row is finished history: a terminal phase. */
const finishedPhase = (task: Task) =>
  task.phase === "done" || task.phase === "cancelled";

/** The facts the host index needs from the projection owner. */
export interface HostIndexHooks {
  projection: () => Map<string, Task>;
  sequence: (id: string) => number;
  ensureProjection: () => void;
}

/**
 * The pass-facing indexes over the task projection (Spec 069 §4): live tasks per
 * host, finished tasks per host in identity order for the slow catch-up cursor,
 * the tasks that left the live set since a host pass last took them, and the tasks
 * that carry an owner stop. A pass reads these instead of copying every retained
 * row; `index(task)` is the only write path, so a finished task leaves the live set
 * on the write that finishes it, and a rebuild re-indexes every row.
 */
export class StoreHostIndex {
  constructor(private readonly hooks: HostIndexHooks) {}

  private membership = new Map<string, Membership>();
  private live = new Map<string, Set<string>>();
  /** Finished identities per host, sorted ascending: the slow cursor pages them. */
  private finished = new Map<string, string[]>();
  /**
   * Identities that went from live to finished, per host, until a host pass takes
   * them. It survives a projection rebuild: an entry is only a hint, re-read
   * against the projection when it is taken.
   */
  private recent = new Map<string, Set<string>>();
  private ownerStops = new Set<string>();

  private get projection() {
    return this.hooks.projection();
  }

  /** Re-index one projected row; the single write path for every set here. */
  index(task: Task): void {
    const previous = this.membership.get(task.id);
    const next: Membership | null =
      task.removedAt == null
        ? { host: task.hostId ?? NO_HOST, finished: finishedPhase(task) }
        : null;
    if (task.removedAt == null && task.resolution.ownerStop)
      this.ownerStops.add(task.id);
    else this.ownerStops.delete(task.id);
    if (
      previous &&
      next &&
      previous.host === next.host &&
      previous.finished === next.finished
    )
      return;
    if (previous) this.unfile(task.id, previous);
    if (!next) {
      this.membership.delete(task.id);
      return;
    }
    this.membership.set(task.id, next);
    if (next.finished) {
      let ids = this.finished.get(next.host);
      if (!ids) this.finished.set(next.host, (ids = []));
      ids.splice(lowerBound(ids, task.id), 0, task.id);
      // Only an observed transition is recent: a rebuild sees no previous state.
      if (previous && !previous.finished && next.host !== NO_HOST) {
        let recent = this.recent.get(next.host);
        if (!recent) this.recent.set(next.host, (recent = new Set()));
        recent.add(task.id);
      }
    } else {
      let ids = this.live.get(next.host);
      if (!ids) this.live.set(next.host, (ids = new Set()));
      ids.add(task.id);
    }
  }

  private unfile(id: string, membership: Membership): void {
    if (membership.finished) {
      const ids = this.finished.get(membership.host);
      if (!ids) return;
      const at = lowerBound(ids, id);
      if (ids[at] === id) ids.splice(at, 1);
      if (!ids.length) this.finished.delete(membership.host);
    } else {
      const ids = this.live.get(membership.host);
      ids?.delete(id);
      if (ids && !ids.size) this.live.delete(membership.host);
    }
  }

  /** Drop every set before a rebuild; the recent hints are re-checked when taken. */
  reset(): void {
    this.membership.clear();
    this.live.clear();
    this.finished.clear();
    this.ownerStops.clear();
  }

  private copies(ids: Iterable<string>): Task[] {
    const out: Task[] = [];
    for (const id of ids) {
      const task = this.projection.get(id);
      if (task) out.push(task);
    }
    return out
      .sort((a, b) => this.hooks.sequence(b.id) - this.hooks.sequence(a.id))
      .map((task) => ({ ...task }));
  }

  /** Every host a retained task names, live or finished. */
  hostIds(): string[] {
    this.hooks.ensureProjection();
    const hosts = new Set([...this.live.keys(), ...this.finished.keys()]);
    hosts.delete(NO_HOST);
    return [...hosts];
  }

  /** One host's live (nonterminal, retained) tasks, newest first. */
  liveTasks(hostId: string): Task[] {
    this.hooks.ensureProjection();
    return this.copies(this.live.get(hostId) ?? []);
  }

  /** Retained tasks carrying an owner stop, newest first. */
  ownerStopTasks(): Task[] {
    this.hooks.ensureProjection();
    return this.copies(this.ownerStops);
  }

  /**
   * One page of a host's finished tasks after `after`, in identity order, and the
   * cursor the next page starts from: `null` once the page reached the end, so the
   * next page wraps to the start.
   */
  finishedPage(
    hostId: string,
    after: string | null,
    limit: number,
  ): { tasks: Task[]; next: string | null } {
    this.hooks.ensureProjection();
    const ids = this.finished.get(hostId) ?? [];
    const start = after ? upperBound(ids, after) : 0;
    const page = ids.slice(start, start + limit);
    const next =
      start + limit < ids.length && page.length ? page.at(-1)! : null;
    return {
      tasks: page.flatMap((id) => {
        const task = this.projection.get(id);
        return task ? [{ ...task }] : [];
      }),
      next,
    };
  }

  /**
   * Take up to `limit` of a host's tasks that finished since the last take, oldest
   * hint first. A hint whose row is no longer a retained finished task on this host
   * is dropped; the rest stay for the next take.
   */
  takeRecentlyFinished(hostId: string, limit: number): Task[] {
    this.hooks.ensureProjection();
    const recent = this.recent.get(hostId);
    if (!recent) return [];
    const out: Task[] = [];
    for (const id of recent) {
      if (out.length >= limit) break;
      recent.delete(id);
      const task = this.projection.get(id);
      if (
        task &&
        task.removedAt == null &&
        finishedPhase(task) &&
        task.hostId === hostId
      )
        out.push({ ...task });
    }
    if (!recent.size) this.recent.delete(hostId);
    return out;
  }
}

function lowerBound(ids: readonly string[], id: string): number {
  let low = 0,
    high = ids.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ids[mid]! < id) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(ids: readonly string[], id: string): number {
  let low = 0,
    high = ids.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ids[mid]! <= id) low = mid + 1;
    else high = mid;
  }
  return low;
}
