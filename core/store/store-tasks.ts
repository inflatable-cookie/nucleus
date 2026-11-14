import { StoreCore, now, deepFreeze } from "./store-core";
import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { PREREQUISITE_WAIT_PREFIX } from "../../shared/wait-state";
import { taskSchema, externalWorkspaceArchivesSettled, taskReferenceSchema, compactTaskVerdicts, compactLiveTask, SNAPSHOT_DEFAULT_LIMIT, formatTaskNumber, runSchema, type Task, type Run, type Notice, type Project, type SnapshotInput, type BriefVersion } from "../../shared/contracts";
import { holdsOf } from "../../shared/holds";
import { boardVisible, StoreBoardIndex } from "./store-board-index";
import { StoreQueueIndex } from "./store-queue-index";

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
/** Nonterminal phases: the live band every list filter reads. */
const isLivePhase = (task: Task) => task.phase !== "done" && task.phase !== "cancelled";

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

/**
 * The task projection and the task read models. One owner per mechanism:
 *
 * - this module builds and maintains the parsed, frozen task rows and the run state the
 *   filters read, and answers every task read from them;
 * - `StoreQueueIndex` owns the dispatch-facing indexes (ready queues, routing epochs,
 *   operational visits, capacity);
 * - `StoreBoardIndex` owns the board-facing indexes (board queues, queued lanes, hold wake
 *   timers, PR state, origin threads).
 *
 * The projection is built once with a single scan, then updated on `insert`/`update`/`putRun`/
 * purge instead of invalidated: an event, notice, hook or outcome write touches no task row
 * and leaves every projected list exactly as it was. A write that bypasses the funnels moves
 * the `writes` clock, and the next read rebuilds.
 */
export class StoreTasks {
  constructor(private readonly core: StoreCore, private readonly hooks: StoreTasksHooks) {
    this.queue = new StoreQueueIndex(this.core, {
      projection: () => this.taskProjection ?? new Map(),
      sequence: id => this.taskSequence.get(id) ?? 0,
      ensureProjection: () => this.ensureTaskProjection(),
      dependencyWait: task => this.dependencyWait(task),
      pendingRuns: () => this.pendingRuns(),
      unreleasedCount: taskId => this.unreleasedByTask?.get(taskId) ?? 0,
    });
    this.board = new StoreBoardIndex({
      projection: () => this.taskProjection ?? new Map(),
      sequence: id => this.taskSequence.get(id) ?? 0,
      ensureProjection: () => this.ensureTaskProjection(),
      task: id => this.task(id),
      activeCapacityTasks: () => this.queue.activeCapacityTasks(),
      lastEventAtByTask: () => this.hooks.lastEventAtByTask(),
    });
  }
  private get db() { return this.core.db; }
  /** The dispatch-facing indexes over this projection. */
  readonly queue: StoreQueueIndex;
  /** The board-facing indexes over this projection. */
  readonly board: StoreBoardIndex;

  taskProjection: Map<string, Task> | null = null;
  /** Task ids newest first, matching the historical `ORDER BY rowid DESC` lists. */
  taskProjectionOrder: string[] = [];
  private taskSequence = new Map<string, number>();
  newestSequence = 0;
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
    this.taskProjection = null; this.taskProjectionOrder = []; this.integrationTaskIndex = null; this.dependentIndex.clear(); this.taskSequence.clear(); this.newestSequence = 0;
    this.queue.reset(); this.board.reset();
    this.runState = null; this.unreleasedByTask = null; this.pendingRunProjection = null; this.pendingRunRowid = null;
    // A rolled-back `assignNumber` leaves no task_numbers row behind, so cached
    // numbers go with the projection; misses re-read the table below.
    this.numberCache.clear();
  }
  /**
   * One projected row changed: record it for a rollback, update the sequence, and re-index
   * every derived index. This is the single write path for the projection.
   */
  setProjectedTask(task: Task): void {
    const previous = this.taskProjection?.get(task.id);
    const undo = this.projectionUndo;
    if (undo && undo.projection === this.taskProjection && !undo.tasks.has(task.id))
      undo.tasks.set(task.id, { task: previous, attempt: this.queue.attemptedEpoch(task.id) });
    // A task control can change its route request without changing global routing
    // inputs. That changed task deserves a fresh selection attempt as well.
    if (previous && previous.version !== task.version && previous.reason === task.reason)
      this.queue.setAttemptedEpoch(task.id, undefined);
    if (previous) this.indexDependencies(previous, false);
    else this.taskSequence.set(task.id, ++this.newestSequence);
    this.taskProjection!.set(task.id, task);
    this.indexDependencies(task, true);
    this.queue.index(task);
    this.board.index(task);
    if (!previous || previous.phase !== task.phase || previous.resolution.goalUnmet !== task.resolution.goalUnmet || previous.removedAt !== task.removedAt) {
      for (const dependent of this.dependentIndex.get(task.id) ?? []) {
        const candidate = this.taskProjection!.get(dependent);
        if (candidate) {
          this.queue.index(candidate); this.board.index(candidate);
          if (previous && task.phase === 'done' && previous.phase !== 'done') this.hooks.settledDependents.add(dependent);
        }
      }
    }
  }
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
        this.taskProjection!.delete(id); this.taskSequence.delete(id);
        const at = this.taskProjectionOrder.indexOf(id);
        if (at >= 0) this.taskProjectionOrder.splice(at, 1);
      }
      this.queue.setAttemptedEpoch(id, entry.attempt);
      const restored = this.taskProjection!.get(id);
      if (restored) this.queue.index(restored);
    }
    // A dependent can have been visited before its prerequisite was restored.
    for (const id of undo.tasks.keys()) for (const dependent of this.dependentIndex.get(id) ?? []) {
      const task = this.taskProjection!.get(dependent);
      if (task) { this.queue.index(task); this.board.index(task); }
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
    this.integrationTaskIndex = null; this.board.queuedLaneStatsValid = false;
    this.projectionClock = undo.clock;
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
    for (const task of tasks.values()) {
      this.indexDependencies(task, true);
      this.queue.index(task); this.board.index(task);
    }
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
        if (!isLivePhase(task) && !(resolution.mergeIntent && !resolution.mergedCommit)) continue;
        const tasks = index.get(task.repoPath);
        if (tasks) tasks.push(task); else index.set(task.repoPath, [task]);
      }
      this.integrationTaskIndex = index;
    }
    return this.integrationTaskIndex.get(repoPath) ?? [];
  }
  /** Live work only; retained terminal history is never parsed for dispatch. */
  liveTasks(): Task[] {
    return this.projectedTasksWhere(task => task.removedAt == null && isLivePhase(task));
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
    const select = operationalOnly ? this.queue.operationalTasksWhere.bind(this.queue) : this.projectedTasksWhere.bind(this);
    return select(task => {
      if (task.removedAt != null) return false;
      if (isLivePhase(task)) return true;
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
  activeCapacityTasks(): Task[] { return this.queue.activeCapacityTasks(); }
  /** All active work and only the queue heads that could reserve the free slots. */
  admissionCandidates(task?: Task): Task[] { return this.queue.admissionCandidates(task); }
  /** Ready dispatch requests in priority order. */
  readyQueueHeads(limit: number, repoPath?: string, startedOnly = false): Task[] { return this.queue.readyQueueHeads(limit, repoPath, startedOnly); }
  /** Terminal tasks with unlaunched run intents, unarchived workspaces, or runtime retirement proofs. */
  lifecycleTasks(operationalOnly = false): Task[] {
    const terminalIntentTasks = new Set(this.pendingRuns()
      .filter(run => run.status === "intent" && run.agentId == null && ["done", "cancelled"].includes(this.task(run.taskId).phase))
      .map(run => run.taskId));
    const select = operationalOnly ? this.queue.operationalTasksWhere.bind(this.queue) : this.projectedTasksWhere.bind(this);
    return select(task => {
      if (task.removedAt != null) return false;
      if (terminalIntentTasks.has(task.id)) return true;
      if (isLivePhase(task)) return true;
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
    const select = operationalOnly ? this.queue.operationalTasksWhere.bind(this.queue) : this.projectedTasksWhere.bind(this);
    return select(task => {
      if (task.removedAt != null) return false;
      if (isLivePhase(task)) return true;
      if (task.originError || task.originLookupError) return true;
      if (task.phase !== "done") return false;
      if (!task.completionNotificationCohort?.some(member => member.originEntry)) return false;
      return !this.hooks.notices(task.id).some(notice =>
        notice.kind === "completion" && notice.originEntry && notice.status === "delivered");
    });
  }
  /**
   * Bounded task set needed by the native board and its global activity strip.
   * Terminal history carries most of the database weight and is available from
   * task detail/telemetry; it must not be materialized for every four-second UI
   * poll. A terminal task is retained here only while it still has an unsettled
   * Queue-owned side effect or an origin-routing fault that the board exposes.
   */
  uiTasks(): Task[] {
    return this.projectedTasksWhere(task => boardVisible(task)).map(compactTaskVerdicts);
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
  /**
   * Bounded exact identity lookup for bridge lifecycle hints (Contract 007). It matches only
   * Queue identities the service already knows, materializes no fleet history and returns an
   * empty list for an unknown identity, so an unknown event schedules nothing.
   */
  taskIdsForIdentities(input: { agentId?: string | null; workspaceId?: string | null; hostId?: string | null }): string[] {
    const ids = new Set<string>();
    const runHosts = new Map<string, Set<string | null>>();
    const addRun = (row: Record<string, unknown>) => {
      const id = String(row.taskId), host = typeof row.hostId === 'string' && row.hostId ? row.hostId : null;
      ids.add(id);
      const hosts = runHosts.get(id) ?? new Set<string | null>(); hosts.add(host); runHosts.set(id, hosts);
    };
    const agentId = input.agentId ?? "";
    const workspaceId = input.workspaceId ?? "";
    // Separate branches keep the retired-worker fallback from defeating scalar index searches.
    if (agentId) {
      for (const row of this.db.prepare(`SELECT id FROM tasks WHERE rowid IN (
        SELECT rowid FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.agentId')=?
        UNION SELECT rowid FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.coordinatorAgentId')=?
        UNION SELECT rowid FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.resolution.reviewerAgentId')=?
        UNION SELECT rowid FROM tasks INDEXED BY tasks_retired_identity
          WHERE json_extract(data,'$.removedAt') IS NULL AND json_array_length(data,'$.retiredWorkers')>0
          AND EXISTS (SELECT 1 FROM json_each(json_extract(data,'$.retiredWorkers')) WHERE json_extract(value,'$.agentId')=?)
        ) ORDER BY rowid`).all(agentId, agentId, agentId, agentId)) ids.add(String(row.id));
      for (const row of this.db.prepare(`SELECT r.taskId AS taskId, json_extract(r.data,'$.hostId') AS hostId FROM runs r JOIN tasks t ON t.id=r.taskId
        WHERE json_extract(t.data,'$.removedAt') IS NULL AND json_extract(r.data,'$.agentId')=? ORDER BY r.rowid`).all(agentId)) addRun(row);
    }
    if (workspaceId) {
      for (const row of this.db.prepare(`SELECT id FROM tasks WHERE rowid IN (
        SELECT rowid FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.workspaceId')=?
        UNION SELECT rowid FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.resolution.coordinatorWorkspaceId')=?
        UNION SELECT rowid FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.resolution.closeoutWorkspaceId')=?
        ) ORDER BY rowid`).all(workspaceId, workspaceId, workspaceId)) ids.add(String(row.id));
      for (const row of this.db.prepare(`SELECT r.taskId AS taskId, json_extract(r.data,'$.hostId') AS hostId FROM runs r JOIN tasks t ON t.id=r.taskId
        WHERE json_extract(t.data,'$.removedAt') IS NULL AND json_extract(r.data,'$.workspaceId')=? ORDER BY r.rowid`).all(workspaceId)) addRun(row);
    }
    const matches = [...ids];
    const readHost = this.db.prepare("SELECT json_extract(data,'$.hostId') AS hostId FROM tasks WHERE id=?");
    const hostOf = (id: string) => {
      const host = readHost.get(id)?.hostId;
      return typeof host === 'string' && host ? host : null;
    };
    if (input.hostId) return matches.filter(id => hostOf(id) === input.hostId && [...(runHosts.get(id) ?? [])].every(host => host === input.hostId));
    // An unqualified bridge identity is useful only when all matches prove the
    // same host. Unknown provenance or matches spanning hosts are ambiguous.
    const hosts = new Set(matches.map(hostOf));
    for (const values of runHosts.values()) for (const host of values) hosts.add(host);
    return hosts.size > 1 || hosts.has(null) ? [] : matches;
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
