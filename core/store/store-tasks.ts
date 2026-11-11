import { StoreCore, now, deepFreeze } from "./store-core";
import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { boardDispatchHoldApplies } from "../../shared/board-dispatch-hold";
import { isPapercutTask, slotRequestFenced } from "../dispatch/capacity";
import { PREREQUISITE_WAIT_PREFIX } from "../../shared/wait-state";
import { taskSchema, taskOwner, holdsOf, isOperatorOrigin, taskHasUnreleasedRun, runHoldsSlot, externalWorkspaceArchivesSettled, taskReferenceSchema, compactTaskVerdicts, compactLiveTask, SNAPSHOT_DEFAULT_LIMIT, DEFAULT_GLOBAL_LIMIT, runSchema, formatTaskNumber, type Task, type Run, type Notice, type Project, type SnapshotInput, type BriefVersion } from "../../shared/contracts";

/** One stored task's detached parts; a bulk read supplies the side stores for its page. */
interface StoredTaskParts {
  briefVersions?: BriefVersion[];
  reviews?: Pick<Task["resolution"], "review" | "reviews">;
  /** The stored observation row, or null when the task has none; absent means look it up. */
  observation?: string | null;
}

export function repositoryIdentity(path: string, origin?: string | null): string {
  let remote = origin;
  if (!remote) {
    try { remote = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { /* A local repository has no origin. */ }
  }
  if (remote) {
    const normalized = normalizeRepositoryOrigin(remote);
    if (normalized) return normalized;
  }
  try { return realpathSync(path); } catch { return path; }
}
export const taskNumberReference = (repository: string, number: number) => `${basename(repository)}#${formatTaskNumber(number)}`;

/**
 * A projected row is shared by every read, so it is frozen, its detached parts
 * (brief versions and reviews) deeply: `taskRow` compares a write against the
 * prior row's parts, and an in-place edit of a shared part would hide the change
 * from storage.
 */
function frozenTask(task: Task): Task {
  deepFreeze(task.briefVersions);
  deepFreeze(task.resolution.review);
  deepFreeze(task.resolution.reviews);
  return Object.freeze(task) as Task;
}

/** Stable live-snapshot cursor on (rowid, id); opaque to callers. */
const encodeSnapshotCursor = (cursor: { rowid: number; id: string }) =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
function decodeSnapshotCursor(value: string): { rowid: number; id: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("Invalid snapshot cursor"); }
  const cursor = parsed as { rowid?: unknown; id?: unknown } | null;
  if (!cursor || typeof cursor !== "object" || typeof cursor.rowid !== "number" || !Number.isInteger(cursor.rowid) || cursor.rowid < 1 || typeof cursor.id !== "string" || !cursor.id)
    throw new Error("Invalid snapshot cursor");
  return { rowid: cursor.rowid, id: cursor.id };
}
export function repositoryMatchClause(identities: string[]): { sql: string; params: string[] } {
  const placeholders = identities.map(() => "?").join(",");
  return {
    sql: `(json_extract(data,'$.repository') IN (${placeholders}) OR json_extract(data,'$.repoPath') IN (${placeholders}))`,
    params: [...identities, ...identities],
  };
}

interface StoreTasksHooks {
  lastEventAtByTask: () => Map<string, string> | null;
  settledDependents: Set<string>;
  numberedTask: (data: string, parts?: StoredTaskParts) => Task;
  resolveReviewRows: (rows: Array<{ seq: number; data: string }>) => Pick<Task["resolution"], "review" | "reviews">;
  numberFor: (taskId: string) => { number: number; reference: string } | null;
  notices: (taskId?: string) => Notice[];
  projectByKey: (key: string) => Project | null;
}

/** Task projection and read models; depends on the core and explicit access callbacks. */
export class StoreTasks {
  constructor(private readonly core: StoreCore, private readonly hooks: StoreTasksHooks) {}
  private get db() { return this.core.db; }

  /**
   * Incremental task projection (task 160): parsed, frozen task rows keyed by id,
   * plus the run-derived state the list filters need. Whole-table rescans on every
   * write stalled the runtime thread for seconds at live size: each write bumped a
   * version that dropped every memoised list, and the next audit pass re-read and
   * re-parsed every task blob (about 60 ms each) before answering. The projection
   * is built once with a single scan, then updated on `insert`/`update`/`putRun`/
   * purge instead of invalidated: an event, notice, hook or outcome write touches
   * no task row and leaves every projected list exactly as it was. A rollback
   * drops the projection (the database rewinds; the maps cannot) and it rebuilds
   * lazily on the next read. Number lookups are cached alongside, so hot reads do
   * no per-id query and no per-row zod parse: rows were validated at write.
   * Callers receive shallow copies; the frozen rows never escape.
   */
  taskProjection: Map<string, Task> | null = null;
  /** Task ids newest first, matching the historical `ORDER BY rowid DESC` lists. */
  taskProjectionOrder: string[] = [];
  /** Nonterminal retained task identities, newest first, for slot accounting. */
  private activeCapacityIds = new Set<string>();
  /** Queued rows with lifecycle obligations; ordinary waiting rows are inert. */
  private operationalIds = new Set<string>();
  private indexOperational(task: Task): void {
    const stop = task.resolution.stop?.reason;
    const needed = task.phase !== 'queued' || Boolean(task.removedAt == null && (
      task.workspaceId || task.workspaceIntent || task.agentId || task.agentIntent || task.coordinatorAgentId || task.resolution.reviewerAgentId
      || task.pausedStop || task.retiredWorkers.length || task.reviewEntry?.workspaceId || task.entrypoint === 'proof' && task.requiresOperatorGo
      || Object.keys(holdsOf(task)).length || task.disposition || task.originError || task.originLookupError
      || task.checkpoints.intent || task.prerequisiteWait || task.resolution.attention || task.resolution.recoveryActive
      || task.resolution.recovery || task.resolution.incident || task.resolution.currentRunId
      || stop && !['capacity', 'prerequisite', 'held', 'route_unavailable', 'lifecycle'].includes(stop)));
    if (needed) this.operationalIds.add(task.id); else this.operationalIds.delete(task.id);
  }
  private operationalTasksWhere(predicate: (task: Task) => boolean): Task[] {
    this.ensureTaskProjection();
    const ids = new Set(this.operationalIds);
    for (const run of this.pendingRuns()) ids.add(run.taskId);
    return [...ids].map(id => this.taskProjection!.get(id)).filter((task): task is Task => Boolean(task && predicate(task)))
      .sort((a, b) => this.taskSequence.get(b.id)! - this.taskSequence.get(a.id)!).map(task => ({ ...task }));
  }

  private taskSequence = new Map<string, number>();
  newestSequence = 0;
  private capacityEligible(task: Task): boolean {
    return task.removedAt == null && task.phase !== "done" && task.phase !== "cancelled";
  }
  private updateCapacityIndex(task: Task, _previous?: Task): void {
    if (this.capacityEligible(task) && (task.phase !== "queued" || task.workspaceId || task.workspaceIntent
      || task.agentId || task.agentIntent || task.agentActive || task.coordinatorAgentId || task.resolution.reviewerAgentId || task.pausedStop || task.interactive || task.retiredWorkers.length || task.proofExecutions.length || task.reviewEntry?.workspaceId))
      this.activeCapacityIds.add(task.id);
    else this.activeCapacityIds.delete(task.id);

  }
  /** Ready requests in priority order per repository; dependency changes update only their dependents. */
  private readyQueues = new Map<string, string[]>();
  private readyRepository = new Map<string, string>();
  private readyStartedQueues = new Map<string, string[]>();
  private readyNormalQueues = new Map<string, string[]>();
  private readyPapercutQueues = new Map<string, string[]>();
  private readyStartedNormalQueues = new Map<string, string[]>();
  private readyStartedPapercutQueues = new Map<string, string[]>();
  private readyOldest = new Map<string, string[]>();
  private readyStartedOldest = new Map<string, string[]>();
  private unavailableQueueIds = new Set<string>();
  private attemptedRoutingEpoch = new Map<string, string>();
  private routingEpoch = "";
  private routeUnavailable(task: Task): boolean {
    return /no eligible|configure.*profile|profile.*unavailable/i.test(task.reason);
  }
  routingRetryAllowed(task: Task): boolean {
    return task.phase === "queued" && this.routeUnavailable(task) && this.attemptedRoutingEpoch.get(task.id) !== this.routingEpoch;
  }
  setRoutingEpoch(epoch: string): void {
    this.ensureTaskProjection();
    if (this.routingEpoch === epoch) return;
    this.routingEpoch = epoch;
    for (const id of this.unavailableQueueIds) {
      const task = this.taskProjection!.get(id);
      if (task) this.indexReady(task);
    }
  }
  markRoutingAttempt(taskId: string): void {
    this.ensureTaskProjection();
    this.attemptedRoutingEpoch.set(taskId, this.routingEpoch);
    const task = this.taskProjection!.get(taskId);
    if (task) this.indexReady(task);
  }
  private unindexReady(id: string): void {
    const repository = this.readyRepository.get(id);
    if (repository === undefined) return;
    const queue = this.readyQueues.get(repository)!;
    const at = queue.indexOf(id);
    if (at >= 0) queue.splice(at, 1);
    if (!queue.length) this.readyQueues.delete(repository);
    for (const index of [this.readyStartedQueues, this.readyNormalQueues, this.readyPapercutQueues, this.readyStartedNormalQueues, this.readyStartedPapercutQueues, this.readyOldest, this.readyStartedOldest]) {
      const entries = index.get(repository);
      if (!entries) continue;
      const position = entries.indexOf(id);
      if (position >= 0) entries.splice(position, 1);
      if (!entries.length) index.delete(repository);
    }
    this.readyRepository.delete(id);
  }
  private indexReady(task: Task): void {
    this.unindexReady(task.id);
    const unavailable = task.phase === "queued" && task.removedAt == null && this.routeUnavailable(task);
    if (unavailable) this.unavailableQueueIds.add(task.id);
    else { this.unavailableQueueIds.delete(task.id); this.attemptedRoutingEpoch.delete(task.id); }
    if (task.removedAt != null || task.phase !== "queued" || slotRequestFenced(task)
      || unavailable && !this.routingRetryAllowed(task)
      || (task.dependsOn.length && this.dependencyWait(task))) return;
    let queue = this.readyQueues.get(task.repoPath);
    if (!queue) this.readyQueues.set(task.repoPath, queue = []);
    const sequence = this.taskSequence.get(task.id)!;
    let low = 0, high = queue.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const other = this.taskProjection!.get(queue[mid])!;
      if (other.queuePriority > task.queuePriority || other.queuePriority === task.queuePriority && this.taskSequence.get(other.id)! < sequence) low = mid + 1;
      else high = mid;
    }
    queue.splice(low, 0, task.id);
    const insertByPriority = (index: Map<string, string[]>) => {
      let entries = index.get(task.repoPath);
      if (!entries) index.set(task.repoPath, entries = []);
      let left = 0, right = entries.length;
      while (left < right) {
        const mid = (left + right) >>> 1, other = this.taskProjection!.get(entries[mid])!;
        if (other.queuePriority > task.queuePriority || other.queuePriority === task.queuePriority && this.taskSequence.get(other.id)! < sequence) left = mid + 1;
        else right = mid;
      }
      entries.splice(left, 0, task.id);
    };
    insertByPriority(isPapercutTask(task) ? this.readyPapercutQueues : this.readyNormalQueues);
    const insertByAge = (index: Map<string, string[]>) => {
      let entries = index.get(task.repoPath);
      if (!entries) index.set(task.repoPath, entries = []);
      let left = 0, right = entries.length;
      while (left < right) {
        const mid = (left + right) >>> 1;
        if (this.taskSequence.get(entries[mid])! < sequence) left = mid + 1;
        else right = mid;
      }
      entries.splice(left, 0, task.id);
    };
    insertByAge(this.readyOldest);
    if (!boardDispatchHoldApplies(task)) {
      let entries = this.readyStartedQueues.get(task.repoPath);
      if (!entries) this.readyStartedQueues.set(task.repoPath, entries = []);
      let left = 0, right = entries.length;
      while (left < right) {
        const mid = (left + right) >>> 1;
        const other = this.taskProjection!.get(entries[mid])!;
        if (other.queuePriority > task.queuePriority || other.queuePriority === task.queuePriority && this.taskSequence.get(other.id)! < sequence) left = mid + 1;
        else right = mid;
      }
      entries.splice(left, 0, task.id);
      insertByPriority(isPapercutTask(task) ? this.readyStartedPapercutQueues : this.readyStartedNormalQueues);
      insertByAge(this.readyStartedOldest);
    }
    this.readyRepository.set(task.id, task.repoPath);
  }
  /** At most limit candidates per repository, oldest first on equal priority. */
  readyQueueHeads(limit: number, repoPath?: string, startedOnly = false): Task[] {
    this.ensureTaskProjection();
    if (limit <= 0) return [];
    const result: Task[] = [];
    const queues = startedOnly ? this.readyStartedQueues : this.readyQueues;
    const ages = startedOnly ? this.readyStartedOldest : this.readyOldest;
    const normal = startedOnly ? this.readyStartedNormalQueues : this.readyNormalQueues;
    const papercuts = startedOnly ? this.readyStartedPapercutQueues : this.readyPapercutQueues;
    for (const [repo] of queues) {
      if (repoPath && repo !== repoPath) continue;
      const selected = [...(normal.get(repo) ?? []).slice(0, limit), ...(papercuts.get(repo) ?? []).slice(0, limit)];
      // Fair rotation starts with the repository whose oldest eligible request
      // came first, even when that request has a lower priority than the heads.
      const oldest = ages.get(repo)?.[0];
      if (oldest && !selected.includes(oldest)) selected.push(oldest);
      for (const id of selected) result.push({ ...this.taskProjection!.get(id)! });
    }
    // The fair-order helper expects newest first and determines repository rotation
    // from the oldest eligible request, independently of priority sorting.
    return result.sort((a, b) => this.taskSequence.get(b.id)! - this.taskSequence.get(a.id)!);
  }
  /** Board identities: all active/obligated work and an ordered queue per repository. */
  boardOtherIds = new Set<string>();
  private boardQueues = new Map<string, string[]>();
  private boardQueueRepository = new Map<string, string>();
  private queuedLaneEntries = new Map<string, { repo: string; lanes: string[]; at: string }>();
  queuedLaneStats = new Map<string, { count: number; repos: Map<string, number>; activity: Array<{ id: string; at: string }> }>();
  queuedLaneStatsValid = false;
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
    for (const ids of this.boardQueues.values()) for (const id of ids) this.indexQueuedLanes(this.taskProjection!.get(id)!);
  }

  private boardVisible(task: Task): boolean {
    if (task.removedAt != null) return false;
    if (StoreTasks.isLivePhase(task)) return true;
    if ((task.originError ?? "") !== "" || (task.originLookupError ?? "") !== "") return true;
    const resolution = task.resolution;
    return Boolean(resolution?.mergeIntent && resolution?.mergedCommit == null || resolution?.archiveIntentWorkspaceId != null
      || (resolution?.cleanupReason ?? "") !== "" || resolution?.workspaceRetirement && resolution.workspaceRetirement.state !== 'archived'
      || (resolution?.buildOutputCleanups ?? []).some(record => ['intent', 'skipped', 'uncertain'].includes(record.state))
      || (resolution?.runtimeRetirements ?? []).some(record => ['pending', 'failed'].includes(record.state))
      || resolution?.closeoutWorkspaceIntent && resolution?.closeoutWorkspaceId == null);
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
    if (!this.boardVisible(task)) return;
    if (task.phase !== 'queued') { this.boardOtherIds.add(task.id); return; }
    let ids = this.boardQueues.get(task.repoPath);
    if (!ids) this.boardQueues.set(task.repoPath, ids = []);
    let low = 0, high = ids.length;
    const seq = this.taskSequence.get(task.id)!;
    while (low < high) {
      const mid = (low + high) >>> 1, other = this.taskProjection!.get(ids[mid])!;
      if (other.queuePriority > task.queuePriority || other.queuePriority === task.queuePriority && this.taskSequence.get(other.id)! < seq) low = mid + 1;
      else high = mid;
    }
    ids.splice(low, 0, task.id);
    this.boardQueueRepository.set(task.id, task.repoPath);
  }
  boardQueueCounts(): Array<{ repoPath: string; count: number }> {
    this.ensureTaskProjection();
    return [...this.boardQueues].map(([repoPath, ids]) => ({ repoPath, count: ids.length }));
  }
  boardQueuePage(repoPath: string, offset: number, limit: number): { tasks: Task[]; nextOffset: number | null } {
    this.ensureTaskProjection();
    const ids = this.boardQueues.get(repoPath) ?? [];
    const page = ids.slice(offset, offset + limit);
    return { tasks: page.map(id => compactTaskVerdicts({ ...this.taskProjection!.get(id)! })), nextOffset: offset + page.length < ids.length ? offset + page.length : null };
  }
  boardTasks(limit: number): Task[] {
    this.ensureTaskProjection();
    const ids = new Set(this.boardOtherIds);
    for (const task of this.activeCapacityTasks()) if (task.phase === 'queued') ids.add(task.id);
    for (const queue of this.boardQueues.values()) for (const id of queue.slice(0, limit)) ids.add(id);
    return [...ids].sort((a, b) => this.taskSequence.get(b)! - this.taskSequence.get(a)!)
      .map(id => compactTaskVerdicts({ ...this.taskProjection!.get(id)! }));
  }
  private holdWakeTargets = new Set<string>();
  private holdTimers: Array<{ id: string; at: number }> = [];
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
        try { const target = this.taskReference(until.taskId); if (target.phase === 'done' || target.phase === 'cancelled' || target.removedAt) this.holdWakeTargets.add(task.id); }
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
    this.ensureTaskProjection();
    const ids = new Set(this.holdWakeTargets);
    for (const timer of this.holdTimers) { if (timer.at > nowMs) break; ids.add(timer.id); }
    return [...ids].flatMap(id => { const task = this.taskProjection!.get(id); return task ? [{ ...task }] : []; });
  }
  private prStateIds = new Set<string>();
  private indexPrState(task: Task): void {
    if (task.removedAt == null && StoreTasks.isLivePhase(task) && task.prUrl && !task.resolution.mergedCommit) this.prStateIds.add(task.id);
    else this.prStateIds.delete(task.id);
  }
  prStateTasks(): Task[] {
    this.ensureTaskProjection();
    return [...this.prStateIds].map(id => ({ ...this.taskProjection!.get(id)! }));
  }
  activeUiTasks(): Task[] {
    this.ensureTaskProjection();
    const ids = new Set(this.boardOtherIds);
    for (const task of this.activeCapacityTasks()) ids.add(task.id);
    return [...ids].map(id => compactTaskVerdicts({ ...this.taskProjection!.get(id)! }));
  }
  private originWorkspaceIds = new Map<string, string[]>();
  private originWorkspaceOwners = new Map<string, string>();
  private queuedOriginIndex = new Map<string, { owner: string; workspaceId: string | null; ids: Set<string> }>();
  private queuedOriginKeys = new Map<string, string>();
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
      const sequence = this.taskSequence.get(task.id)!;
      let low = 0, high = ids.length;
      while (low < high) { const mid = (low + high) >>> 1; if (this.taskSequence.get(ids[mid])! > sequence) low = mid + 1; else high = mid; }
      ids.splice(low, 0, task.id);
      this.originWorkspaceOwners.set(task.id, owner);
    }
    if (task.phase !== 'queued' || this.operationalIds.has(task.id)) return;
    const key = JSON.stringify([owner, task.originWorkspaceId]);
    let group = this.queuedOriginIndex.get(key);
    if (!group) this.queuedOriginIndex.set(key, group = { owner, workspaceId: task.originWorkspaceId, ids: new Set() });
    group.ids.add(task.id);
    this.queuedOriginKeys.set(task.id, key);
  }
  queuedOriginGroups(): Array<{ owner: string; workspaceId: string | null; ids: ReadonlySet<string> }> {
    this.ensureTaskProjection();
    return [...this.queuedOriginIndex.values()];
  }
  /** Reverse prerequisite edges, maintained alongside the task projection. */
  dependentIndex = new Map<string, Set<string>>();
  private indexDependencies(task: Task, add: boolean): void {
    const untils = [task.holdUntil, ...Object.values(holdsOf(task)).map(fence => fence?.until)].filter(until => until?.kind === 'task');
    const dependencies = new Set([...task.dependsOn, ...(task.prerequisiteWait?.waitsFor ?? []), ...untils.map(until => until!.taskId)]);
    for (const dependency of dependencies) {
      if (add) {
        let dependents = this.dependentIndex.get(dependency);
        if (!dependents) this.dependentIndex.set(dependency, dependents = new Set());
        dependents.add(task.id);
      } else {
        const dependents = this.dependentIndex.get(dependency);
        dependents?.delete(task.id);
        if (dependents?.size === 0) this.dependentIndex.delete(dependency);
      }
    }
  }
  projectionUndo: {
    projection: Map<string, Task> | null;
    clock: number;
    sequence: number;
    tasks: Map<string, { task: Task | undefined; attempt: string | undefined }>;
    runs: Map<string, { state: { taskId: string; released: boolean } | undefined; pending: Run | undefined; rowid: number | undefined }>;
    counts: Map<string, number | undefined>;
  } | null = null;
  rememberProjectedRun(id: string, taskId: string): void {
    const undo = this.projectionUndo;
    if (!undo || undo.projection !== this.taskProjection) return;
    if (!undo.runs.has(id)) undo.runs.set(id, { state: this.runState?.get(id), pending: this.pendingRunProjection?.get(id), rowid: this.pendingRunRowid?.get(id) });
    if (!undo.counts.has(taskId)) undo.counts.set(taskId, this.unreleasedByTask?.get(taskId));
  }
  restoreProjection(undo: NonNullable<StoreTasks["projectionUndo"]>): void {
    for (const [id, entry] of undo.tasks) {
      const current = this.taskProjection!.get(id);
      if (entry.task) this.setProjectedTask(entry.task);
      else if (current) {
        // Remove the inserted identity from each incremental index before dropping it.
        this.setProjectedTask({ ...current, phase: "cancelled", removedAt: now() });
        this.indexDependencies(current, false);
        this.taskProjection!.delete(id); this.taskSequence.delete(id); this.operationalIds.delete(id);
        const at = this.taskProjectionOrder.indexOf(id);
        if (at >= 0) this.taskProjectionOrder.splice(at, 1);
      }
      if (entry.attempt === undefined) this.attemptedRoutingEpoch.delete(id);
      else this.attemptedRoutingEpoch.set(id, entry.attempt);
      const restored = this.taskProjection!.get(id);
      if (restored) this.indexReady(restored);
    }
    // A dependent can have been visited before its prerequisite was restored.
    for (const id of undo.tasks.keys()) for (const dependent of this.dependentIndex.get(id) ?? []) {
      const task = this.taskProjection!.get(dependent);
      if (task) { this.indexReady(task); this.indexHoldWake(task); }
    }
    for (const [id, entry] of undo.runs) {
      if (entry.state) this.runState!.set(id, entry.state); else this.runState!.delete(id);
      if (entry.pending) this.pendingRunProjection!.set(id, entry.pending); else this.pendingRunProjection!.delete(id);
      if (entry.rowid !== undefined) this.pendingRunRowid!.set(id, entry.rowid); else this.pendingRunRowid!.delete(id);
    }
    for (const [id, count] of undo.counts) {
      if (count !== undefined) this.unreleasedByTask!.set(id, count); else this.unreleasedByTask!.delete(id);
    }
    this.newestSequence = undo.sequence;
    this.integrationTaskIndex = null; this.queuedLaneStatsValid = false;
    this.projectionClock = undo.clock;
  }
  setProjectedTask(task: Task): void {
    const previous = this.taskProjection?.get(task.id);
    const undo = this.projectionUndo;
    if (undo && undo.projection === this.taskProjection && !undo.tasks.has(task.id))
      undo.tasks.set(task.id, { task: previous, attempt: this.attemptedRoutingEpoch.get(task.id) });
    // A task control can change its route request without changing global routing
    // inputs. That changed task deserves a fresh selection attempt as well.
    if (previous && previous.version !== task.version && previous.reason === task.reason)
      this.attemptedRoutingEpoch.delete(task.id);
    if (previous) this.indexDependencies(previous, false);
    else this.taskSequence.set(task.id, ++this.newestSequence);
    this.updateCapacityIndex(task, previous);
    this.taskProjection!.set(task.id, task);
    this.indexDependencies(task, true);
    this.indexReady(task);
    this.indexBoard(task);
    this.indexOperational(task);
    this.indexOrigin(task);
    this.indexPrState(task);
    this.indexHoldWake(task);
    if (!previous || previous.phase !== task.phase || previous.resolution.goalUnmet !== task.resolution.goalUnmet || previous.removedAt !== task.removedAt) {
      for (const dependent of this.dependentIndex.get(task.id) ?? []) {
        const candidate = this.taskProjection!.get(dependent);
        if (candidate) { this.indexReady(candidate); this.indexHoldWake(candidate); if (previous && task.phase === 'done' && previous.phase !== 'done') this.hooks.settledDependents.add(dependent); }
      }
    }
  }
  readonly numberCache = new Map<string, { number: number; reference: string }>();
  /** Every run's owning task and release flag; missing `released` reads as unreleased. */
  runState: Map<string, { taskId: string; released: boolean }> | null = null;
  unreleasedByTask: Map<string, number> | null = null;
  /** Unreleased or superseded runs on retained tasks, in rowid order: `pendingRuns`. */
  pendingRunProjection: Map<string, Run> | null = null;
  pendingRunRowid: Map<string, number> | null = null;
  /**
   * Write clock for the projection above. Triggers bump it on every tasks or
   * runs write, including ones that bypass the insert/update/putRun funnels
   * (test fixtures backdate rows that way; production never does). The funnels
   * keep the maps current and record the clock; any other mismatch rebuilds on
   * the next read, so a projected list always equals a fresh scan.
   */
  projectionClock = -1;
  readProjectionClock(): number { return this.core.readClock("writes"); }
  /**
   * Write-side projection sync, called at funnel ENTRY before the funnel's own
   * task/run writes. When a write bypassed the funnels since the last read or
   * write, drop the maps instead of updating them: the next read rebuilds from
   * the tables. (Checking after the funnel's own write would always mismatch,
   * since the funnel's own trigger bump is already in the clock.)
   */
  syncProjectionForWrite(): boolean {
    if (!this.taskProjection || !this.runState || !this.unreleasedByTask || !this.pendingRunProjection || !this.pendingRunRowid) return false;
    if (this.readProjectionClock() !== this.projectionClock) { this.invalidateProjections(); return false; }
    return true;
  }
  invalidateProjections() {
    this.taskProjection = null; this.taskProjectionOrder = []; this.integrationTaskIndex = null; this.dependentIndex.clear(); this.activeCapacityIds.clear(); this.operationalIds.clear(); this.taskSequence.clear(); this.newestSequence = 0; this.readyQueues.clear(); this.readyRepository.clear(); this.readyStartedQueues.clear(); this.readyNormalQueues.clear(); this.readyPapercutQueues.clear(); this.readyStartedNormalQueues.clear(); this.readyStartedPapercutQueues.clear(); this.readyOldest.clear(); this.readyStartedOldest.clear(); this.unavailableQueueIds.clear(); this.attemptedRoutingEpoch.clear(); this.boardOtherIds.clear(); this.boardQueues.clear(); this.boardQueueRepository.clear(); this.queuedLaneEntries.clear(); this.queuedLaneStats.clear(); this.queuedLaneStatsValid = false; this.prStateIds.clear(); this.originWorkspaceIds.clear(); this.originWorkspaceOwners.clear(); this.queuedOriginIndex.clear(); this.queuedOriginKeys.clear(); this.holdWakeTargets.clear(); this.holdTimers = [];
    this.runState = null; this.unreleasedByTask = null; this.pendingRunProjection = null; this.pendingRunRowid = null;
    // A rolled-back `assignNumber` leaves no task_numbers row behind, so cached
    // numbers go with the projection; misses re-read the table below.
    this.numberCache.clear();
  }
  ensureTaskProjection(): void {
    const clock = this.readProjectionClock();
    if (this.projectionClock === clock && this.taskProjection && this.runState && this.unreleasedByTask && this.pendingRunProjection && this.pendingRunRowid) return;
    this.invalidateProjections();
    for (const row of this.db.prepare("SELECT task_id,repository,number FROM task_numbers").all())
      this.numberCache.set(String(row.task_id), { number: Number(row.number), reference: taskNumberReference(String(row.repository), Number(row.number)) });
    const tasks = new Map<string, Task>();
    const order: string[] = [];
    const briefVersions = new Map<string, BriefVersion[]>();
    for (const row of this.db.prepare("SELECT taskId,data FROM task_brief_versions ORDER BY taskId,version").all()) {
      const list = briefVersions.get(String(row.taskId)) ?? [];
      list.push(JSON.parse(String(row.data)));
      briefVersions.set(String(row.taskId), list);
    }
    const reviews = new Map<string, Array<{ seq: number; data: string }>>();
    for (const row of this.db.prepare("SELECT taskId,seq,data FROM task_reviews ORDER BY taskId,seq").all()) {
      const list = reviews.get(String(row.taskId)) ?? [];
      list.push({ seq: Number(row.seq), data: String(row.data) });
      reviews.set(String(row.taskId), list);
    }
    const observations = new Map<string, string>();
    for (const row of this.db.prepare("SELECT taskId,data FROM task_observations").all())
      observations.set(String(row.taskId), String(row.data));
    for (const row of this.db.prepare("SELECT id,data FROM tasks ORDER BY rowid DESC").all()) {
      const id = String(row.id);
      const task = this.hooks.numberedTask(String(row.data), { briefVersions: briefVersions.get(id) ?? [], reviews: this.hooks.resolveReviewRows(reviews.get(id) ?? []),
        observation: observations.get(id) ?? null });
      tasks.set(task.id, frozenTask(task));
      this.taskSequence.set(task.id, -order.length);
      this.updateCapacityIndex(task);
      this.indexDependencies(task, true);
      order.push(task.id);
    }
    // Scalar run state only: no blob is transferred or parsed for the filters.
    const runState = new Map<string, { taskId: string; released: boolean }>();
    const unreleased = new Map<string, number>();
    for (const row of this.db.prepare("SELECT id,taskId,COALESCE(json_extract(data,'$.released'),0) AS released FROM runs").all()) {
      const released = Number(row.released) !== 0;
      runState.set(String(row.id), { taskId: String(row.taskId), released });
      if (!released) unreleased.set(String(row.taskId), (unreleased.get(String(row.taskId)) ?? 0) + 1);
    }
    const pending = new Map<string, Run>();
    const pendingRowid = new Map<string, number>();
    for (const row of this.db.prepare(`SELECT runs.rowid AS rid, runs.data FROM runs JOIN tasks ON tasks.id=runs.taskId
      WHERE json_extract(tasks.data,'$.removedAt') IS NULL
        AND (COALESCE(json_extract(runs.data,'$.released'),0)=0 OR json_extract(runs.data,'$.status')='superseded')
      ORDER BY runs.rowid`).all()) {
      const run = JSON.parse(String(row.data)) as Run;
      pending.set(run.id, Object.freeze(run) as Run);
      pendingRowid.set(run.id, Number(row.rid));
    }
    this.taskProjection = tasks; this.taskProjectionOrder = order; this.integrationTaskIndex = null;
    this.runState = runState; this.unreleasedByTask = unreleased; this.pendingRunProjection = pending;
    this.pendingRunRowid = pendingRowid;
    this.projectionClock = clock;
    for (const task of tasks.values()) { this.indexReady(task); this.indexBoard(task); this.indexOperational(task); this.indexOrigin(task); this.indexPrState(task); this.indexHoldWake(task); }
  }
  /** A caller-owned copy of one projected row; null when the id names no task. */
  projectedTask(id: string): Task | null {
    this.ensureTaskProjection();
    const hit = this.taskProjection!.get(id);
    return hit ? { ...hit } : null;
  }
  /**
   * The atomic write boundary for task records: the complete resultant task must
   * satisfy taskSchema before its row, events, notices or credential commit. A
   * refusal throws inside the caller's transaction, so the whole write rolls back
   * and no unreadable record can reach a cold read. The parsed copy is the frozen
   * projected row, so every hot read skips its own zod parse and equals a fresh
   * parse of the stored JSON, defaults included. Stored JSON keeps the record as
   * written; the parse only validates and projects it.
   */
  validatedTask(task: Task): Task {
    // A warmed projection must be representation-identical to one rebuilt from the
    // row: JSON storage drops undefined-valued keys, so the cached parse drops them
    // too. Otherwise a deepEqual across a projection rebuild sees phantom keys.
    return frozenTask(taskSchema.parse(JSON.parse(JSON.stringify(task))));
  }
  private projectedTasksWhere(predicate: (task: Task) => boolean): Task[] {
    this.ensureTaskProjection();
    const out: Task[] = [];
    for (const id of this.taskProjectionOrder) {
      const task = this.taskProjection!.get(id)!;
      if (predicate(task)) out.push({ ...task });
    }
    return out;
  }
  private static readonly isLivePhase = (task: Task) => task.phase !== "done" && task.phase !== "cancelled";
  numberForCached(taskId: string): { number: number; reference: string } | null {
    const hit = this.numberCache.get(taskId);
    if (hit) return hit;
    const loaded = this.hooks.numberFor(taskId);
    if (loaded) this.numberCache.set(taskId, loaded);
    return loaded;
  }
  tasks(): Task[] {
    return this.projectedTasksWhere(task => task.removedAt == null);
  }
  /** Every task row, removed included, for the Spec 027 removal blocker scan: a removed non-terminal task still owns the project. */
  allTasks(): Task[] {
    this.ensureTaskProjection();
    return this.taskProjectionOrder.map(id => ({ ...this.taskProjection!.get(id)! }));
  }
  /**
   * The tasks of one repository that can hold its integration turn, read on every slot
   * admission. Scanning all retained history for each verifying candidate of each queued
   * task saturated the executor (live profile, 2026-11-04: 76% in `tasks()`), so this is
   * indexed once per task write. Rows are the frozen projection: read them, don't keep them.
   */
  integrationTaskIndex: Map<string, Task[]> | null = null;
  integrationTasks(repoPath: string): readonly Task[] {
    this.ensureTaskProjection();
    if (!this.integrationTaskIndex) {
      const index = new Map<string, Task[]>();
      for (const id of this.taskProjectionOrder) {
        const task = this.taskProjection!.get(id)!;
        const resolution = task.resolution;
        if (task.removedAt != null || !resolution.integrationTurn) continue;
        if (!StoreTasks.isLivePhase(task) && !(resolution.mergeIntent && !resolution.mergedCommit)) continue;
        const tasks = index.get(task.repoPath);
        if (tasks) tasks.push(task); else index.set(task.repoPath, [task]);
      }
      this.integrationTaskIndex = index;
    }
    return this.integrationTaskIndex.get(repoPath) ?? [];
  }
  /** Live work only; retained terminal history is never parsed for dispatch. */
  liveTasks(): Task[] {
    return this.projectedTasksWhere(task => task.removedAt == null && StoreTasks.isLivePhase(task));
  }
  laneTaskPage(lane: string, offset: number, limit: number): { tasks: Task[]; total: number; nextOffset: number | null } {
    const tasks = this.liveTasks().filter(task => task.lanes.includes(lane)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const page = tasks.slice(offset, offset + limit);
    return { tasks: page, total: tasks.length, nextOffset: offset + page.length < tasks.length ? offset + page.length : null };
  }
  /**
   * Audit candidates include terminal obligations; settled history needs no preflight.
   * The predicate mirrors the retired SQL row-for-row (nulls included: a missing
   * scalar never satisfies a comparison, exactly like SQLite's three-valued logic).
   */
  maintenanceTasks(operationalOnly = false): Task[] {
    this.ensureTaskProjection();
    const runs = this.runState!;
    const select = operationalOnly ? this.operationalTasksWhere.bind(this) : this.projectedTasksWhere.bind(this);
    return select(task => {
      if (task.removedAt != null) return false;
      if (StoreTasks.isLivePhase(task)) return true;
      if ((task.originError ?? "") !== "") return true;
      const resolution = task.resolution;
      if (resolution?.attention === true) return true;
      if ((resolution?.roleReplacements ?? 0) !== 0 && (task.reason ?? "").slice(0, 11) === "No eligible") return true;
      if (resolution?.recoveryActive === true) return true;
      const disposition = task.disposition;
      if (disposition != null && disposition.status != null && disposition.status !== "complete") return true;
      const intent = task.checkpoints?.intent;
      if (intent != null && intent.status != null && intent.status !== "delivered") return true;
      const recoveryRunId = resolution?.recovery?.runId;
      if (recoveryRunId != null && runs.get(recoveryRunId)?.released === false) return true;
      return false;
    });
  }
  /** Active capacity facts plus live run owners; never visits the waiting queue. */
  activeCapacityTasks(): Task[] {
    this.ensureTaskProjection();
    const ids = new Set(this.activeCapacityIds);
    const liveRuns = new Set<string>();
    for (const run of this.pendingRuns()) { ids.add(run.taskId); if (runHoldsSlot(run)) liveRuns.add(run.taskId); }
    return [...ids].map(id => this.taskProjection!.get(id)).filter((task): task is Task => Boolean(task && this.capacityEligible(task)))
      .sort((a, b) => this.taskSequence.get(b.id)! - this.taskSequence.get(a.id)!)
      .map(task => ({ ...task, hasUnreleasedRun: taskHasUnreleasedRun(task, (this.unreleasedByTask!.get(task.id) ?? 0) > 0), hasLiveRun: liveRuns.has(task.id) }));
  }
  /** All active work and only the queue heads that could reserve the free slots. */
  admissionCandidates(task?: Task): Task[] {
    const limit = this.core.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT;
    const byId = new Map(this.activeCapacityTasks().map(candidate => [candidate.id, candidate]));
    for (const candidate of this.readyQueueHeads(Math.max(1, limit + 2))) if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
    if (task && !byId.has(task.id)) byId.set(task.id, task);
    return [...byId.values()].sort((a, b) => (this.taskSequence.get(b.id) ?? 0) - (this.taskSequence.get(a.id) ?? 0));
  }
  /** Terminal tasks with unlaunched run intents, unarchived workspaces, or runtime retirement proofs. */
  lifecycleTasks(operationalOnly = false): Task[] {
    const terminalIntentTasks = new Set(this.pendingRuns()
      .filter(run => run.status === "intent" && run.agentId == null && ["done", "cancelled"].includes(this.task(run.taskId).phase))
      .map(run => run.taskId));
    const select = operationalOnly ? this.operationalTasksWhere.bind(this) : this.projectedTasksWhere.bind(this);
    return select(task => {
      if (task.removedAt != null) return false;
      if (terminalIntentTasks.has(task.id)) return true;
      if (StoreTasks.isLivePhase(task)) return true;
      if (task.resolution?.buildOutputCleanups?.some(record => record.runId && ['intent', 'uncertain'].includes(record.state))) return true;
      if (task.resolution?.workspaceRetirement && ['authorized', 'intent', 'uncertain'].includes(task.resolution.workspaceRetirement.state)) return true;
      // A cancelled task's stale recovery episode owes a sweep once no recovery run of its own is unreleased (Queue #680).
      if (task.phase === "cancelled" && task.resolution?.recoveryActive) return !this.runs(task.id).some(run => run.role === "recovery" && !run.released);
      if (task.phase !== "done") return false;
      // Spec 017: a merged review-entry task's preserved external workspace owes
      // its catalog archive pass until every registration the last complete
      // inventory observed is settled. It is not a Queue-owned workspace archive,
      // so it never enters `archivedWorkspaceIds` and never frees this scan.
      if (task.reviewEntry?.preserveWorkspace === true && task.workspaceId != null
        && !externalWorkspaceArchivesSettled(task)) return true;
      const archived = task.resolution?.archivedWorkspaceIds ?? [];
      if ((task.reviewEntry == null || task.reviewEntry.preserveWorkspace === false)
        && task.workspaceId != null && !archived.includes(task.workspaceId)) return true;
      const closeoutWorkspaceId = task.resolution?.closeoutWorkspaceId;
      return closeoutWorkspaceId != null && !archived.includes(closeoutWorkspaceId);
    });
  }
  /**
   * Tasks with an owed runtime retirement proof (Effigy contract 005): the
   * archive confirmed a captured scope and `effigy container retire` has not
   * yet returned 0. Tokenless teardown failures retry through lifecycle archive
   * work instead. Retirement records also survive task retention.
   */
  retirementTasks(taskId?: string): Task[] {
    const owed = (task: Task) => task.removedAt == null
      && (task.resolution?.runtimeRetirements ?? []).some(record =>
        record.state === "pending" || (record.state === "failed" && Boolean(record.scope)));
    if (taskId) {
      const task = this.projectedTask(taskId);
      return task && owed(task) ? [task] : [];
    }
    return this.projectedTasksWhere(owed);
  }
  /**
   * Terminal tasks still owing an advisory finished-task runtime stop. The
   * durable intent on the task is the restart authority: a completed
   * cancellation is excluded from `lifecycleTasks`, so without this scan a
   * crash after its terminal transition would leave the stop unrun or a running
   * occurrence unreconciled forever.
   */
  finishedHookTasks(): Task[] {
    return this.projectedTasksWhere(task => task.removedAt == null && task.resolution?.finishedHook != null
      && (task.phase === "done" || task.phase === "cancelled"));
  }
  /**
   * Terminal tasks still owing the host-process sweep. Cancelled tasks drop out
   * of `lifecycleTasks`, so this scan is the restart authority for a crash after
   * the terminal transition and before leftovers were signalled.
   */
  hostProcessSweepTasks(): Task[] {
    return this.projectedTasksWhere(task => task.removedAt == null && task.resolution?.hostProcessSweep != null
      && (task.phase === "done" || task.phase === "cancelled"));
  }
  /**
   * Tasks an origin pass must visit: live tasks, a finished task that still owes
   * its origin a completion notice, and a finished task still carrying origin
   * error state (visited once so the pass can clear it).
   *
   * The task half is a filter over the in-memory projection, in the same newest
   * first order the previous SQL scan used. The one thing the projection cannot
   * answer is whether a delivered origin completion notice exists, so that is
   * read for the few finished candidates that owe a notice instead of being a
   * correlated subquery over every task row.
   */
  originRoutingTasks(operationalOnly = false): Task[] {
    const select = operationalOnly ? this.operationalTasksWhere.bind(this) : this.projectedTasksWhere.bind(this);
    return select(task => {
      if (task.removedAt != null) return false;
      if (StoreTasks.isLivePhase(task)) return true;
      if (task.originError || task.originLookupError) return true;
      if (task.phase !== "done") return false;
      if (!task.completionNotificationCohort?.some(member => member.originEntry)) return false;
      return !this.hooks.notices(task.id).some(notice =>
        notice.kind === "completion" && notice.originEntry && notice.status === "delivered");
    });
  }
  /**
   * Newest recorded workspace fallback per origin thread, from the projection:
   * the newest task's recorded workspace wins, and a thread whose newest task
   * recorded none inherits nothing.
   */
  originWorkspaces(): Map<string,string> {
    this.ensureTaskProjection();
    const result = new Map<string, string>();
    for (const [owner, ids] of this.originWorkspaceIds) {
      const workspace = this.taskProjection!.get(ids[0])?.originWorkspaceId;
      if (workspace) result.set(owner, workspace);
    }
    return result;
  }
  /**
   * Bounded task set needed by the native board and its global activity strip.
   * Terminal history carries most of the database weight and is available from
   * task detail/telemetry; it must not be materialized for every four-second UI
   * poll. A terminal task is retained here only while it still has an unsettled
   * Queue-owned side effect or an origin-routing fault that the board exposes.
   */
  uiTasks(): Task[] {
    return this.projectedTasksWhere(task => this.boardVisible(task)).map(compactTaskVerdicts);
  }
  /**
   * Compact live-fleet page for `queue.snapshot`. Event history stays in the
   * events table and is never selected here; terminal rows stay in detail and
   * outcome-search.
   */
  liveSnapshot(input: SnapshotInput = {}): { tasks: ReturnType<typeof compactLiveTask>[]; cursor: string | null; hasMore: boolean } {
    const filters = [
      "json_extract(data, '$.removedAt') IS NULL",
      "json_extract(data, '$.phase') NOT IN ('done','cancelled')",
    ];
    const params: (string | number)[] = [];
    if (input.project) {
      const project = this.hooks.projectByKey(input.project);
      if (!project) throw new Error(`Unknown project: ${input.project}`);
      const identities = this.snapshotIdentities(project.repositories.map(repo => repo.origin || repo.path).filter(Boolean));
      if (!identities.length) filters.push("0");
      else {
        const match = repositoryMatchClause(identities);
        filters.push(match.sql);
        params.push(...match.params);
      }
    }
    if (input.repository) {
      const match = repositoryMatchClause(this.snapshotIdentities([input.repository]));
      filters.push(match.sql);
      params.push(...match.params);
    }
    const cursor = input.cursor !== undefined ? decodeSnapshotCursor(input.cursor) : null;
    if (cursor) {
      filters.push("(rowid < ? OR (rowid = ? AND id < ?))");
      params.push(cursor.rowid, cursor.rowid, cursor.id);
    }
    const limit = input.limit ?? SNAPSHOT_DEFAULT_LIMIT;
    const rows = this.db.prepare(`SELECT rowid AS k, id FROM tasks WHERE ${filters.join(" AND ")} ORDER BY rowid DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1) as { k: number; id: string }[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      tasks: page.map(row => compactLiveTask(this.snapshotTask(String(row.id)))),
      cursor: hasMore && last ? encodeSnapshotCursor({ rowid: Number(last.k), id: String(last.id) }) : null,
      hasMore,
    };
  }
  /** One projected row for snapshot hydration, with a direct read only for a row the projection never saw. */
  snapshotTask(id: string): Task {
    const hit = this.projectedTask(id);
    if (hit) return hit;
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
    if (!row) throw new Error("Task not found");
    return this.hooks.numberedTask(String(row.data));
  }
  private snapshotIdentities(values: string[]): string[] {
    const identities = new Set<string>();
    for (const value of values) {
      identities.add(value);
      identities.add(normalizeRepositoryOrigin(value) ?? repositoryIdentity(value));
      try { identities.add(realpathSync(value)); } catch { /* A checkout path that is absent here still matches origin or the raw value. */ }
    }
    return [...identities];
  }
  task(id: string): Task {
    const hit = this.projectedTask(id);
    if (hit) return hit;
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
    if (!row) throw new Error(this.db.prepare("SELECT id FROM tombstones WHERE id=?").get(id)?"Task history was purged after 4 days":"Task not found");
    return this.hooks.numberedTask(String(row.data));
  }
  taskReference(id:string) {
    const row=this.db.prepare("SELECT data FROM tasks WHERE id=? UNION ALL SELECT data FROM tombstones WHERE id=? LIMIT 1").get(id,id);
    if(!row)throw Error('Task not found');return taskReferenceSchema.parse(JSON.parse(String(row.data)));
  }
  dependencyWait(task: Pick<Task,"dependsOn">): string {
    const waiting = task.dependsOn.flatMap(id => {
      try {
        const dependency = this.taskReference(id);
        // Spec 043 (c) goal gate: a done task whose declared goal is unmet is not
        // satisfaction. Dependents stay waiting_prerequisite until a task that
        // does meet the goal is named as their prerequisite. The live task's
        // resolution carries the fact; once retention purges it, the tombstone
        // written at purge carries it instead, so the wait survives the retention purge.
        const goal = this.db.prepare("SELECT json_extract(data,'$.resolution.goalUnmet') AS goalUnmet FROM tasks WHERE id=? UNION ALL SELECT json_extract(data,'$.goalUnmet') AS goalUnmet FROM tombstones WHERE id=? LIMIT 1").get(id,id) as { goalUnmet: string | null } | undefined;
        const goalUnmet = dependency.phase === "done" && goal?.goalUnmet ? "goal unmet" : null;
        return dependency.phase === "done" && !goalUnmet ? [] : [`${dependency.title} (${id}): ${dependency.removedAt ? "removed before completion" : goalUnmet ?? dependency.phase}`];
      } catch { return [`${id}: missing`]; }
    });
    return waiting.length ? `${PREREQUISITE_WAIT_PREFIX} ${waiting.join("; ")}` : "";
  }
  /**
   * One task by id, or null when no row holds it (a purged or unknown identity). The
   * lookup never throws, so a caller sweeping history for thousands of occurrences does
   * not build an Error (and its stack) to learn a task is gone.
   */
  taskOrNull(id: string): Task | null {
    const hit = this.projectedTask(id);
    if (hit) return hit;
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
    return row ? this.hooks.numberedTask(String(row.data)) : null;
  }
  runs(taskId?: string): Run[] { return (taskId ? this.db.prepare("SELECT data FROM runs WHERE taskId=? ORDER BY rowid").all(taskId) : this.db.prepare("SELECT runs.data FROM runs JOIN tasks ON tasks.id=runs.taskId WHERE json_extract(tasks.data, '$.removedAt') IS NULL ORDER BY runs.rowid").all()).map(r => JSON.parse(String(r.data))); }
  /** Candidate leases only; callers retain role, generation and task-stage gates. */
  pendingRuns(): Run[] {
    this.ensureTaskProjection();
    const rows = this.pendingRunProjection!;
    const rowids = this.pendingRunRowid!;
    return [...rows.keys()].sort((a, b) => rowids.get(a)! - rowids.get(b)!).map(id => ({ ...rows.get(id)! }));
  }
  /** Reconcile one task's pending runs after its removal state flips. */
  refreshPendingRunsForTask(taskId: string, removed: boolean): void {
    if (!this.pendingRunProjection || !this.pendingRunRowid) return;
    if (removed) {
      for (const [runId, run] of this.pendingRunProjection) if (run.taskId === taskId) { this.rememberProjectedRun(runId, taskId); this.pendingRunProjection.delete(runId); this.pendingRunRowid.delete(runId); }
      return;
    }
    for (const row of this.db.prepare("SELECT rowid AS rid, data FROM runs WHERE taskId=?").all(taskId)) {
      const run = JSON.parse(String(row.data)) as Run;
      this.rememberProjectedRun(run.id, taskId);
      if (!run.released || run.status === "superseded") {
        this.pendingRunProjection.set(run.id, Object.freeze(run) as Run);
        this.pendingRunRowid.set(run.id, Number(row.rid));
      } else { this.pendingRunProjection.delete(run.id); this.pendingRunRowid.delete(run.id); }
    }
  }
  runsForTasks(taskIds: string[]): Run[] {
    if (!taskIds.length) return [];
    const placeholders = taskIds.map(() => "?").join(",");
    return this.db.prepare(`SELECT data FROM runs WHERE taskId IN (${placeholders}) ORDER BY rowid`).all(...taskIds).map(row => runSchema.parse(JSON.parse(String(row.data))));
  }
  run(id: string): Run | null { const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id); return row ? JSON.parse(String(row.data)) : null; }
}
