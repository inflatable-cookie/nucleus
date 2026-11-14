import { boardDispatchHoldApplies } from "../../shared/board-dispatch-hold";
import { DEFAULT_GLOBAL_LIMIT, runHoldsSlot, taskHasUnreleasedRun, type Run, type Task } from "../../shared/contracts";
import { holdsOf } from "../../shared/holds";
import { routeUnavailableStop } from "../../shared/task-stop";
import { isPapercutTask, slotRequestFenced } from "../dispatch/capacity";
import type { StoreCore } from "./store-core";

/**
 * The retained rows a slot can account for: every nonterminal, non-removed task. One rule,
 * read by the capacity index, the ready queues and `admissionCandidates`.
 */
export const capacityEligible = (task: Task): boolean =>
  task.removedAt == null && task.phase !== "done" && task.phase !== "cancelled";

/**
 * A queued row needs a lifecycle visit only when this queue could not dispatch it: it holds
 * or owes something (a workspace, a run, a review, a hold, an outstanding instruction),
 * rather than waiting on nothing but dispatch. A non-queued row always needs its visit.
 */
export function taskNeedsOperationalVisit(task: Task): boolean {
  if (task.phase !== "queued") return true;
  if (task.removedAt != null) return false;
  const stop = routeStopReason(task);
  return Boolean(task.workspaceId || task.workspaceIntent || task.agentId || task.agentIntent || task.coordinatorAgentId
    || task.resolution.reviewerAgentId || task.pausedStop || task.retiredWorkers.length || task.reviewEntry?.workspaceId
    || task.entrypoint === "proof" && task.requiresOperatorGo
    || Object.keys(holdsOf(task)).length || task.disposition || task.originError || task.originLookupError
    || task.checkpoints.intent || task.prerequisiteWait || task.resolution.attention || task.resolution.recoveryActive
    || task.resolution.recovery || task.resolution.incident || task.resolution.currentRunId
    || stop && !["capacity", "prerequisite", "held", "route_unavailable", "lifecycle"].includes(stop));
}

/** The typed stop reason this projection reads, never a re-derivation from the task's reason text. */
const routeStopReason = (task: Task) => task.resolution.stop?.reason;

/** The facts the queue indexes and their read models need from the projection owner. */
export interface QueueIndexHooks {
  projection: () => Map<string, Task>;
  sequence: (id: string) => number;
  ensureProjection: () => void;
  dependencyWait: (task: Pick<Task, "dependsOn">) => string;
  pendingRuns: () => Run[];
  unreleasedCount: (taskId: string) => number;
}

/**
 * The dispatch-facing indexes over the task projection: the ready queue per repository and
 * its priority/papercut/fair-rotation views, the routing epoch a route wait is retried on, the
 * operational visit set and the capacity set. One owner per index; `index(task)` is the only
 * write path and every read is answered from the maps, never by rescanning the tables.
 */
export class StoreQueueIndex {
  constructor(private readonly core: StoreCore, private readonly hooks: QueueIndexHooks) {}

  /** Nonterminal retained task identities, newest first, for slot accounting. */
  private activeCapacityIds = new Set<string>();
  /** Queued rows with lifecycle obligations; ordinary waiting rows are inert. */
  private operationalIds = new Set<string>();
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

  private get projection() { return this.hooks.projection(); }
  private sequence(id: string): number { return this.hooks.sequence(id); }
  private task(id: string): Task | undefined { return this.projection.get(id); }

  private updateCapacityIndex(task: Task): void {
    if (capacityEligible(task) && (task.phase !== "queued" || task.workspaceId || task.workspaceIntent
      || task.agentId || task.agentIntent || task.agentActive || task.coordinatorAgentId || task.resolution.reviewerAgentId
      || task.pausedStop || task.interactive || task.retiredWorkers.length || task.proofExecutions.length || task.reviewEntry?.workspaceId))
      this.activeCapacityIds.add(task.id);
    else this.activeCapacityIds.delete(task.id);
  }
  private indexOperational(task: Task): void {
    if (taskNeedsOperationalVisit(task)) this.operationalIds.add(task.id);
    else this.operationalIds.delete(task.id);
  }

  /** Re-index one projected row; the single write path for every index here. */
  index(task: Task): void {
    this.updateCapacityIndex(task);
    this.indexReady(task);
    this.indexOperational(task);
  }

  /** The row's routing retry epoch was rolled back: restore the attempt marker the undo recorded. */
  setAttemptedEpoch(id: string, epoch: string | undefined): void {
    if (epoch === undefined) this.attemptedRoutingEpoch.delete(id);
    else this.attemptedRoutingEpoch.set(id, epoch);
  }
  attemptedEpoch(id: string): string | undefined { return this.attemptedRoutingEpoch.get(id); }

  reset(): void {
    this.activeCapacityIds.clear();
    this.operationalIds.clear();
    this.readyQueues.clear();
    this.readyRepository.clear();
    this.readyStartedQueues.clear();
    this.readyNormalQueues.clear();
    this.readyPapercutQueues.clear();
    this.readyStartedNormalQueues.clear();
    this.readyStartedPapercutQueues.clear();
    this.readyOldest.clear();
    this.readyStartedOldest.clear();
    this.unavailableQueueIds.clear();
    this.attemptedRoutingEpoch.clear();
  }

  /** Routing found no eligible profile for this task; the typed stop is the fact. */
  private routeUnavailable(task: Task): boolean { return routeUnavailableStop(task); }

  routingRetryAllowed(task: Task): boolean {
    return task.phase === "queued" && this.routeUnavailable(task) && this.attemptedRoutingEpoch.get(task.id) !== this.routingEpoch;
  }
  setRoutingEpoch(epoch: string): void {
    this.hooks.ensureProjection();
    if (this.routingEpoch === epoch) return;
    this.routingEpoch = epoch;
    for (const id of this.unavailableQueueIds) {
      const task = this.task(id);
      if (task) this.indexReady(task);
    }
  }
  markRoutingAttempt(taskId: string): void {
    this.hooks.ensureProjection();
    this.attemptedRoutingEpoch.set(taskId, this.routingEpoch);
    const task = this.task(taskId);
    if (task) this.indexReady(task);
  }
  /** The routing epoch a fresh selection attempt is compared against. */
  get epoch(): string { return this.routingEpoch; }

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
      || (task.dependsOn.length && this.hooks.dependencyWait(task))) return;
    let queue = this.readyQueues.get(task.repoPath);
    if (!queue) this.readyQueues.set(task.repoPath, queue = []);
    const sequence = this.sequence(task.id);
    let low = 0, high = queue.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const other = this.task(queue[mid])!;
      if (other.queuePriority > task.queuePriority || other.queuePriority === task.queuePriority && this.sequence(other.id) < sequence) low = mid + 1;
      else high = mid;
    }
    queue.splice(low, 0, task.id);
    const insertByPriority = (index: Map<string, string[]>) => {
      let entries = index.get(task.repoPath);
      if (!entries) index.set(task.repoPath, entries = []);
      let left = 0, right = entries.length;
      while (left < right) {
        const mid = (left + right) >>> 1, other = this.task(entries[mid])!;
        if (other.queuePriority > task.queuePriority || other.queuePriority === task.queuePriority && this.sequence(other.id) < sequence) left = mid + 1;
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
        if (this.sequence(entries[mid]) < sequence) left = mid + 1;
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
        const other = this.task(entries[mid])!;
        if (other.queuePriority > task.queuePriority || other.queuePriority === task.queuePriority && this.sequence(other.id) < sequence) left = mid + 1;
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
    this.hooks.ensureProjection();
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
      for (const id of selected) result.push({ ...this.task(id)! });
    }
    // The fair-order helper expects newest first and determines repository rotation
    // from the oldest eligible request, independently of priority sorting.
    return result.sort((a, b) => this.sequence(b.id) - this.sequence(a.id));
  }

  /** Selected rows in the operational visit set, newest first; pending runs always qualify. */
  operationalTasksWhere(predicate: (task: Task) => boolean): Task[] {
    this.hooks.ensureProjection();
    const ids = new Set(this.operationalIds);
    for (const run of this.hooks.pendingRuns()) ids.add(run.taskId);
    return [...ids].map(id => this.task(id)).filter((task): task is Task => Boolean(task && predicate(task)))
      .sort((a, b) => this.sequence(b.id) - this.sequence(a.id)).map(task => ({ ...task }));
  }
  /** Active capacity facts plus live run owners; never visits the waiting queue. */
  activeCapacityTasks(): Task[] {
    this.hooks.ensureProjection();
    const ids = new Set(this.activeCapacityIds);
    const liveRuns = new Set<string>();
    for (const run of this.hooks.pendingRuns()) { ids.add(run.taskId); if (runHoldsSlot(run)) liveRuns.add(run.taskId); }
    return [...ids].map(id => this.task(id)).filter((task): task is Task => Boolean(task && capacityEligible(task)))
      .sort((a, b) => this.sequence(b.id) - this.sequence(a.id))
      .map(task => ({ ...task, hasUnreleasedRun: taskHasUnreleasedRun(task, this.hooks.unreleasedCount(task.id) > 0), hasLiveRun: liveRuns.has(task.id) }));
  }
  /** All active work and only the queue heads that could reserve the free slots. */
  admissionCandidates(task?: Task): Task[] {
    const limit = this.core.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT;
    const byId = new Map(this.activeCapacityTasks().map(candidate => [candidate.id, candidate]));
    for (const candidate of this.readyQueueHeads(Math.max(1, limit + 2))) if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
    if (task && !byId.has(task.id)) byId.set(task.id, task);
    return [...byId.values()].sort((a, b) => (this.sequence(b.id) || 0) - (this.sequence(a.id) || 0));
  }
}
