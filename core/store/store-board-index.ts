import { compactTaskVerdicts, isOperatorOrigin, taskOwner, type Task } from "../../shared/contracts";
import { holdsOf } from "../../shared/holds";
import { taskNeedsOperationalVisit } from "./store-queue-index";

/** Nonterminal phases: the board's live band. */
const isLivePhase = (task: Task) => task.phase !== "done" && task.phase !== "cancelled";

/**
 * The board's visible set: live work, plus a finished row only while it still exposes an
 * unfinished Queue-owned side effect or an origin-routing fault. This is one rule, read by
 * `uiTasks` and by the board's queue index.
 */
export function boardVisible(task: Task): boolean {
  if (task.removedAt != null) return false;
  if (isLivePhase(task)) return true;
  if ((task.originError ?? "") !== "" || (task.originLookupError ?? "") !== "") return true;
  const resolution = task.resolution;
  return Boolean(resolution?.mergeIntent && resolution?.mergedCommit == null || resolution?.archiveIntentWorkspaceId != null
    || (resolution?.cleanupReason ?? "") !== "" || resolution?.workspaceRetirement && resolution.workspaceRetirement.state !== 'archived'
    || (resolution?.buildOutputCleanups ?? []).some(record => ['intent', 'skipped', 'uncertain'].includes(record.state))
    || (resolution?.runtimeRetirements ?? []).some(record => ['pending', 'failed'].includes(record.state))
    || resolution?.closeoutWorkspaceIntent && resolution?.closeoutWorkspaceId == null);
}

/** The facts the board indexes and their read models need from the projection owner. */
export interface BoardIndexHooks {
  projection: () => Map<string, Task>;
  sequence: (id: string) => number;
  ensureProjection: () => void;
  task: (id: string) => Task;
  activeCapacityTasks: () => Task[];
  lastEventAtByTask: () => Map<string, string> | null;
}

/**
 * The board-facing indexes over the task projection: the ordered queue per repository, the
 * non-queued band, queued-lane statistics, the hold wake timers, the PR-state set and the
 * origin-thread groups. `index(task)` is the only write path; each read is answered from the
 * maps, newest first, exactly as the SQL scans this replaced did.
 */
export class StoreBoardIndex {
  constructor(private readonly hooks: BoardIndexHooks) {}

  /** Board identities: all active/obligated work and an ordered queue per repository. */
  private boardOtherIds = new Set<string>();
  private boardQueues = new Map<string, string[]>();
  private boardQueueRepository = new Map<string, string>();
  private queuedLaneEntries = new Map<string, { repo: string; lanes: string[]; at: string }>();
  queuedLaneStats = new Map<string, { count: number; repos: Map<string, number>; activity: Array<{ id: string; at: string }> }>();
  queuedLaneStatsValid = false;
  private holdWakeTargets = new Set<string>();
  private holdTimers: Array<{ id: string; at: number }> = [];
  private prStateIds = new Set<string>();
  private originWorkspaceIds = new Map<string, string[]>();
  private originWorkspaceOwners = new Map<string, string>();
  private queuedOriginIndex = new Map<string, { owner: string; workspaceId: string | null; ids: Set<string> }>();
  private queuedOriginKeys = new Map<string, string>();

  private get projection() { return this.hooks.projection(); }
  private sequence(id: string): number { return this.hooks.sequence(id); }
  private task(id: string): Task | undefined { return this.projection.get(id); }

  /** Re-index one projected row; the single write path for every index here. */
  index(task: Task): void {
    this.indexBoard(task);
    this.indexPrState(task);
    this.indexHoldWake(task);
    this.indexOrigin(task);
  }

  reset(): void {
    this.boardOtherIds.clear();
    this.boardQueues.clear();
    this.boardQueueRepository.clear();
    this.queuedLaneEntries.clear();
    this.queuedLaneStats.clear();
    this.queuedLaneStatsValid = false;
    this.prStateIds.clear();
    this.originWorkspaceIds.clear();
    this.originWorkspaceOwners.clear();
    this.queuedOriginIndex.clear();
    this.queuedOriginKeys.clear();
    this.holdWakeTargets.clear();
    this.holdTimers = [];
  }

  private unindexQueuedLanes(id: string): void {
    const old = this.queuedLaneEntries.get(id);
    if (!old) return;
    for (const lane of old.lanes) {
      const stat = this.queuedLaneStats.get(lane)!;
      stat.count--;
      const count = (stat.repos.get(old.repo) ?? 1) - 1;
      if (count) stat.repos.set(old.repo, count); else stat.repos.delete(old.repo);
      const at = stat.activity.findIndex(entry => entry.id === id);
      if (at >= 0) stat.activity.splice(at, 1);
      if (!stat.count) this.queuedLaneStats.delete(lane);
    }
    this.queuedLaneEntries.delete(id);
  }
  indexQueuedLanes(task: Task): void {
    this.unindexQueuedLanes(task.id);
    if (!this.queuedLaneStatsValid || task.phase !== 'queued' || task.removedAt != null) return;
    const entry = { repo: task.repoPath, lanes: [...new Set(task.lanes)], at: this.hooks.lastEventAtByTask()?.get(task.id) ?? task.updatedAt };
    this.queuedLaneEntries.set(task.id, entry);
    for (const lane of entry.lanes) {
      let stat = this.queuedLaneStats.get(lane);
      if (!stat) this.queuedLaneStats.set(lane, stat = { count: 0, repos: new Map(), activity: [] });
      stat.count++;
      stat.repos.set(entry.repo, (stat.repos.get(entry.repo) ?? 0) + 1);
      let low = 0, high = stat.activity.length;
      while (low < high) { const mid = (low + high) >>> 1; if (stat.activity[mid].at < entry.at) low = mid + 1; else high = mid; }
      stat.activity.splice(low, 0, { id: task.id, at: entry.at });
    }
  }
  ensureQueuedLaneStats(): void {
    if (this.queuedLaneStatsValid) return;
    this.queuedLaneStats.clear(); this.queuedLaneEntries.clear(); this.queuedLaneStatsValid = true;
    for (const ids of this.boardQueues.values()) for (const id of ids) this.indexQueuedLanes(this.task(id)!);
  }

  private indexBoard(task: Task): void {
    this.indexQueuedLanes(task);
    this.boardOtherIds.delete(task.id);
    const previous = this.boardQueueRepository.get(task.id);
    if (previous !== undefined) {
      const ids = this.boardQueues.get(previous)!;
      const at = ids.indexOf(task.id);
      if (at >= 0) ids.splice(at, 1);
      if (!ids.length) this.boardQueues.delete(previous);
      this.boardQueueRepository.delete(task.id);
    }
    if (!boardVisible(task)) return;
    if (task.phase !== 'queued') { this.boardOtherIds.add(task.id); return; }
    let ids = this.boardQueues.get(task.repoPath);
    if (!ids) this.boardQueues.set(task.repoPath, ids = []);
    let low = 0, high = ids.length;
    const seq = this.sequence(task.id);
    while (low < high) {
      const mid = (low + high) >>> 1, other = this.task(ids[mid])!;
      if (other.queuePriority > task.queuePriority || other.queuePriority === task.queuePriority && this.sequence(other.id) < seq) low = mid + 1;
      else high = mid;
    }
    ids.splice(low, 0, task.id);
    this.boardQueueRepository.set(task.id, task.repoPath);
  }
  /** The non-queued board band's rows, newest first: live and obligated tasks. */
  activeTasks(): Task[] {
    this.hooks.ensureProjection();
    return [...this.boardOtherIds].map(id => this.task(id)!);
  }
  boardQueueCounts(): Array<{ repoPath: string; count: number }> {
    this.hooks.ensureProjection();
    return [...this.boardQueues].map(([repoPath, ids]) => ({ repoPath, count: ids.length }));
  }
  boardQueuePage(repoPath: string, offset: number, limit: number): { tasks: Task[]; nextOffset: number | null } {
    this.hooks.ensureProjection();
    const ids = this.boardQueues.get(repoPath) ?? [];
    const page = ids.slice(offset, offset + limit);
    return { tasks: page.map(id => compactTaskVerdicts({ ...this.task(id)! })), nextOffset: offset + page.length < ids.length ? offset + page.length : null };
  }
  boardTasks(limit: number): Task[] {
    this.hooks.ensureProjection();
    const ids = new Set(this.boardOtherIds);
    for (const task of this.hooks.activeCapacityTasks()) if (task.phase === 'queued') ids.add(task.id);
    for (const queue of this.boardQueues.values()) for (const id of queue.slice(0, limit)) ids.add(id);
    return [...ids].sort((a, b) => this.sequence(b) - this.sequence(a))
      .map(id => compactTaskVerdicts({ ...this.task(id)! }));
  }
  activeUiTasks(): Task[] {
    this.hooks.ensureProjection();
    const ids = new Set(this.boardOtherIds);
    for (const task of this.hooks.activeCapacityTasks()) ids.add(task.id);
    return [...ids].map(id => compactTaskVerdicts({ ...this.task(id)! }));
  }

  private indexHoldWake(task: Task): void {
    this.holdWakeTargets.delete(task.id);
    this.holdTimers = this.holdTimers.filter(timer => timer.id !== task.id);
    if (task.removedAt != null || ['done', 'cancelled'].includes(task.phase)) return;
    const untils = [task.holdUntil, ...Object.values(holdsOf(task)).map(fence => fence?.until)];
    const times = new Set<number>();
    for (const until of untils) {
      if (!until) continue;
      if (until.kind === 'time') times.add(Date.parse(until.at));
      else {
        try { const target = this.hooks.task(until.taskId); if (target.phase === 'done' || target.phase === 'cancelled' || target.removedAt) this.holdWakeTargets.add(task.id); }
        catch { this.holdWakeTargets.add(task.id); }
      }
    }
    for (const at of times) {
      let low = 0, high = this.holdTimers.length;
      while (low < high) { const mid = (low + high) >>> 1; if (this.holdTimers[mid].at < at) low = mid + 1; else high = mid; }
      this.holdTimers.splice(low, 0, { id: task.id, at });
    }
  }
  dueHoldTasks(nowMs = Date.now()): Task[] {
    this.hooks.ensureProjection();
    const ids = new Set(this.holdWakeTargets);
    for (const timer of this.holdTimers) { if (timer.at > nowMs) break; ids.add(timer.id); }
    return [...ids].flatMap(id => { const task = this.task(id); return task ? [{ ...task }] : []; });
  }

  private indexPrState(task: Task): void {
    if (task.removedAt == null && isLivePhase(task) && task.prUrl && !task.resolution.mergedCommit) this.prStateIds.add(task.id);
    else this.prStateIds.delete(task.id);
  }
  prStateTasks(): Task[] {
    this.hooks.ensureProjection();
    return [...this.prStateIds].map(id => ({ ...this.task(id)! }));
  }

  private indexOrigin(task: Task): void {
    const previousOwner = this.originWorkspaceOwners.get(task.id);
    if (previousOwner !== undefined) {
      const ids = this.originWorkspaceIds.get(previousOwner)!;
      const at = ids.indexOf(task.id);
      if (at >= 0) ids.splice(at, 1);
      if (!ids.length) this.originWorkspaceIds.delete(previousOwner);
      this.originWorkspaceOwners.delete(task.id);
    }
    const previousKey = this.queuedOriginKeys.get(task.id);
    if (previousKey !== undefined) {
      const group = this.queuedOriginIndex.get(previousKey)!;
      group.ids.delete(task.id);
      if (!group.ids.size) this.queuedOriginIndex.delete(previousKey);
      this.queuedOriginKeys.delete(task.id);
    }
    const owner = taskOwner(task);
    if (task.removedAt != null || isOperatorOrigin(owner)) return;
    if (task.originWorkspaceId) {
      let ids = this.originWorkspaceIds.get(owner);
      if (!ids) this.originWorkspaceIds.set(owner, ids = []);
      const sequence = this.sequence(task.id);
      let low = 0, high = ids.length;
      while (low < high) { const mid = (low + high) >>> 1; if (this.sequence(ids[mid]) > sequence) low = mid + 1; else high = mid; }
      ids.splice(low, 0, task.id);
      this.originWorkspaceOwners.set(task.id, owner);
    }
    if (task.phase !== 'queued' || taskNeedsOperationalVisit(task)) return;
    const key = JSON.stringify([owner, task.originWorkspaceId]);
    let group = this.queuedOriginIndex.get(key);
    if (!group) this.queuedOriginIndex.set(key, group = { owner, workspaceId: task.originWorkspaceId, ids: new Set() });
    group.ids.add(task.id);
    this.queuedOriginKeys.set(task.id, key);
  }
  queuedOriginGroups(): Array<{ owner: string; workspaceId: string | null; ids: ReadonlySet<string> }> {
    this.hooks.ensureProjection();
    return [...this.queuedOriginIndex.values()];
  }
  /** Newest recorded workspace fallback per origin thread, from the projection. */
  originWorkspaces(): Map<string, string> {
    this.hooks.ensureProjection();
    const result = new Map<string, string>();
    for (const [owner, ids] of this.originWorkspaceIds) {
      const workspace = this.task(ids[0])?.originWorkspaceId;
      if (workspace) result.set(owner, workspace);
    }
    return result;
  }
}
