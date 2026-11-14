import { visibleTaskSummaries, availabilitySchema, DEFAULT_GLOBAL_LIMIT, DEFAULT_PROJECT_LIMIT, DEFAULT_PAPERCUT_PROJECT_LIMIT, DEFAULT_STALL_THRESHOLD_MINUTES, DEFAULT_HOLD_REMINDER_MINUTES, DEFAULT_HOLD_ESCALATION_MINUTES, DEFAULT_LANE_DRAIN_MINUTES, DEFAULT_LANE_DRAIN_ESCALATION_MINUTES, DEFAULT_HOST_OUTAGE_NOTICE_MINUTES } from "../../shared/contracts";
import type { SnapshotInput, SnapshotState, OutcomeSearchInput, Task, BoundRun, UsageLevel, BackupHealth } from "../../shared/contracts";
import { taskWaitStateContext, queuedReason } from "../recovery/wait-context";
import { occupiesSlot, RETIRED_OBSERVATION_STALE_MS } from "../engine";
import type { Engine } from "../engine";
import type { Store } from "../store/store";
import type { Decisions } from "../planning/decisions";
import type { PrState } from "../forge/pr-status";
import { holdsQueueWorkspace } from "../dispatch/capacity";
import { boundDrainProjection } from "../closeout/queue-drain";
import { summarizeOperation } from "../../shared/operations";
import { activeRoutingGrants, reconcileRoutingGrants } from "../dispatch/routing-grants";
import { collectOwnerVerbFacts, ownerTaskNext } from "../verbs/owner-verbs";
import type { createTaskDetailCache } from "../telemetry/task-detail";
import type { createUiSnapshotFactsCache, UiSnapshotFacts } from "../telemetry/ui-snapshot";

/** Read dependencies and live lifecycle observations used by board projections. */
export interface BoardContext {
  store: Store;
  engine: Pick<Engine, "profiles" | "retiredObservationKey" | "queuedExternalWait"> & Partial<Pick<Engine, "profilesFor">> & {
    resolution: Pick<Engine["resolution"], "slotAdmissionReason" | "slotAdmissionReader">;
  };
  decisions: Decisions;
  cachedTaskDetail: ReturnType<typeof createTaskDetailCache>;
  cachedUiSnapshotFacts: ReturnType<typeof createUiSnapshotFactsCache>;
  markStoreAccess(): void;
  anyHostConnected(): boolean;
  backupHealthProjection(): BackupHealth;
  boardError(): string;
  readonly prStates: Record<string, PrState>;
  readonly hostId: string;
}

/** Board reads retain their projection state without owning runtime lifecycle. */
export class RuntimeBoard {
  /** Spec 052: the usage level the last board projection was built at. */
  private boardUsageLevel: UsageLevel | null = null;
  private boardBackupKey: string | null = null;

  constructor(private readonly context: BoardContext) {}

  /**
   * Queue #650: the board's paused-stop counters. `stoppedThreads` counts live
   * threads (distinct agents) the operator stopped while paused that have not
   * resumed; `resumedThreads` counts threads resumed since the last stop action.
   */
  private pausedStopCounts(facts: UiSnapshotFacts): { stoppedThreads: number; resumedThreads: number } {
    const agents = new Set<string>();
    for (const task of facts.tasks) if (task.pausedStop) agents.add(task.pausedStop.agentId);
    for (const run of facts.runs) if (!run.released && run.pausedStop) agents.add(run.pausedStop.agentId);
    const episodeAt = this.context.store.getMeta<string | null>("pausedStopEpisodeAt") ?? null;
    const resumedThreads = episodeAt
      ? (this.context.store.db.prepare("SELECT COUNT(DISTINCT json_extract(detail,'$.agentId')) AS n FROM events WHERE kind='paused_resume' AND at >= ?").get(episodeAt) as { n: number }).n
      : 0;
    return { stoppedThreads: agents.size, resumedThreads };
  }

  snapshot(input: SnapshotInput = {}): SnapshotState {
    this.context.markStoreAccess();
    const facts = this.context.cachedUiSnapshotFacts();
    const tasks = facts.tasks;
    const page = this.context.store.liveSnapshot(input);
    const paused = this.context.store.getMeta<boolean>("paused") ?? true;
    const connected = this.context.anyHostConnected();
    const owned = facts.capacityTasks.filter(task => occupiesSlot(task));
    const runs = this.context.store.pendingRuns().filter(r => !r.released || r.status === 'superseded' && owned.some(t => t.id === r.taskId));
    const retired = owned.flatMap(t => t.retiredWorkers.map(w => ({ host: t.hostId, id: w.agentId })));
    const observations = new Map<string, Record<string, { active: boolean; at: string }>>();
    const observed = (host: string, id: string) => { if (!observations.has(host)) observations.set(host, this.context.store.getMeta<Record<string, { active: boolean; at: string }>>(this.context.engine.retiredObservationKey(host)) ?? {}); return observations.get(host)?.[id]; };
    const key = (host: string | undefined, id: string | null) => JSON.stringify([host, id]);
    const activeWorkers = new Set([...retired.filter(item => observed(item.host, item.id)?.active).map(item => key(item.host, item.id)), ...owned.filter(t => t.agentId && t.agentActive === true).map(t => key(t.hostId, t.agentId)), ...runs.filter(r => r.agentId && r.active === true).map(r => key(r.hostId, r.agentId))]).size;
    // A retired worker is re-read on its bounded slow cadence (audit A6), so its
    // record is unsettled past that cadence plus the ordinary window, not 45 s.
    const unsettled = retired.filter(item => { const state = observed(item.host, item.id); return !state || Date.now() - Date.parse(state.at) > RETIRED_OBSERVATION_STALE_MS; }).length + runs.filter(r => !r.agentId || !r.lastObservedAt || Date.now() - Date.parse(r.lastObservedAt) > 45000 || r.active === null).length + this.context.store.unsettledNoticeCount() + tasks.filter(t => t.resolution.mergeIntent && !t.resolution.mergedCommit || t.resolution.archiveIntentWorkspaceId || t.resolution.closeoutWorkspaceIntent && !t.resolution.closeoutWorkspaceId || t.resolution.buildOutputCleanups.some(record => record.state !== 'complete') || t.resolution.runtimeRetirements.some(record => record.state === 'pending' || record.state === 'failed')).length + owned.filter(t => t.workspaceIntent && !t.workspaceId || t.agentIntent && !t.agentId || t.agentId && (!t.lastObservedAt || Date.now() - Date.parse(t.lastObservedAt) > 45000 || !["idle", "running", "initializing", "error", "closed"].includes(t.lastAgentStatus ?? ""))).length;
    return { prStates: this.context.prStates, connected: this.context.anyHostConnected(), hostId: this.context.hostId,
      paused, dispatchHeld: this.context.store.getMeta<boolean>("dispatchHeld") ?? false, ...this.drainProjection(), quiet: paused && connected && activeWorkers === 0 && unsettled === 0, activeWorkers, unsettled,
      ...this.pausedStopCounts(facts),
      occupiedSlots: owned.length,
      globalLimit: this.context.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT, projectLimit: this.context.store.getMeta<number>("projectLimit") ?? DEFAULT_PROJECT_LIMIT,
      usage: this.context.store.usageView(),
      routingGrants: activeRoutingGrants(this.context.store),
      qaFence: this.context.store.qaFenceView(),
      demandOffsets: this.context.store.demandRoleOffsets(),
      papercutProjectLimit: this.context.store.getMeta<number>("papercutProjectLimit") ?? DEFAULT_PAPERCUT_PROJECT_LIMIT,
      projectLimitOverrides: this.context.store.projectDispatchLimitOverrides(),
      projectCapacities: this.projectCapacities(facts),
      stallThresholdMinutes: this.context.store.getMeta<number>("stallThresholdMinutes") ?? DEFAULT_STALL_THRESHOLD_MINUTES,
      holdReminderMinutes: this.context.store.getMeta<number>("holdReminderMinutes") ?? DEFAULT_HOLD_REMINDER_MINUTES,
      holdEscalationMinutes: this.context.store.getMeta<number>("holdEscalationMinutes") ?? DEFAULT_HOLD_ESCALATION_MINUTES,
      laneDrainMinutes: this.context.store.getMeta<number>("laneDrainMinutes") ?? DEFAULT_LANE_DRAIN_MINUTES,
      laneDrainEscalationMinutes: this.context.store.getMeta<number>("laneDrainEscalationMinutes") ?? DEFAULT_LANE_DRAIN_ESCALATION_MINUTES,
      hostOutageNoticeMinutes: this.context.store.getMeta<number>("hostOutageNoticeMinutes") ?? DEFAULT_HOST_OUTAGE_NOTICE_MINUTES,
      paseoCallLimit: this.context.store.configuredPaseoCallLimit(),
      operationLimit: this.context.store.configuredOperationLimit(), operationBacklog: this.context.store.operationBacklog(),
      backup: this.context.backupHealthProjection(),
      operations: this.context.store.operations({ states: ["pending", "running", "needs_attention", "failed"], limit: 100 }).map(summarizeOperation),
      error: this.context.boardError(),
      tasks: page.tasks.map(summary => {
        const task = this.context.store.task(summary.id);
        const context = taskWaitStateContext(this.context.store, task, null, candidate => this.context.engine.resolution.slotAdmissionReason(candidate));
        return { ...summary, reason: queuedReason(this.context.store, task, context, candidate => this.context.engine.queuedExternalWait(candidate)) };
      }), cursor: page.cursor, hasMore: page.hasMore, profiles: this.context.engine.profiles, pool: this.context.store.pool(), assignments: this.context.store.counts(), recentAssignments: this.context.store.recentCounts(),
      availability: this.context.store.db.prepare("SELECT data FROM availability").all().map(r => availabilitySchema.parse(JSON.parse(String(r.data)))) };
  }

  /** Board counters derived once from the cached facts; shared by both board responses. */
  private boardCounters(facts: UiSnapshotFacts) {
    const owned = facts.capacityTasks.filter(task => occupiesSlot(task));
    const runs = facts.runs.filter(run => !run.released || run.status === "superseded" && owned.some(task => task.id === run.taskId));
    const retired = owned.flatMap(task => task.retiredWorkers.map(worker => ({ host: task.hostId, id: worker.agentId })));
    const observations = new Map<string, Record<string, { active: boolean; at: string }>>();
    const observed = (host: string, id: string) => { if (!observations.has(host)) observations.set(host, this.context.store.getMeta<Record<string, { active: boolean; at: string }>>(this.context.engine.retiredObservationKey(host)) ?? {}); return observations.get(host)?.[id]; };
    const key = (host: string | undefined, id: string | null) => JSON.stringify([host, id]);
    // The 45 s window is elapsed time over an observation instant, and an
    // observation-only write deliberately leaves the cached board projection as it
    // is. These counters therefore read the observation times from the rows: a
    // boundary is crossed with no write at all, and a fresh observation registers
    // at once instead of waiting for the next substantive board write.
    const observationWatchedTasks = facts.tasks.filter(task => task.agentId);
    const taskObservedAt = this.context.store.observationTimes("task", [...owned.map(task => task.id), ...observationWatchedTasks.map(task => task.id)]);
    const runObservedAt = this.context.store.observationTimes("run", runs.map(run => run.id));
    const stale = (at: string | null | undefined) => !at || Date.now() - Date.parse(at) > 45000;
    const activeWorkers = new Set([
      ...retired.filter(item => observed(item.host, item.id)?.active).map(item => key(item.host, item.id)),
      ...owned.filter(task => task.agentId && task.agentActive === true).map(task => key(task.hostId, task.agentId)),
      ...runs.filter(run => run.agentId && run.active === true).map(run => key(run.hostId, run.agentId)),
    ]).size;
    const unsettled = retired.filter(item => { const state = observed(item.host, item.id); return !state || Date.now() - Date.parse(state.at) > RETIRED_OBSERVATION_STALE_MS; }).length
      + runs.filter(run => !run.agentId || stale(runObservedAt.get(run.id)) || run.active === null).length
      + facts.unsettledNotices
      + facts.tasks.filter(task => task.resolution.mergeIntent && !task.resolution.mergedCommit || task.resolution.archiveIntentWorkspaceId || task.resolution.closeoutWorkspaceIntent && !task.resolution.closeoutWorkspaceId || task.resolution.buildOutputCleanups.some(record => record.state !== 'complete') || task.resolution.runtimeRetirements.some(record => record.state === 'pending' || record.state === 'failed')).length
      + owned.filter(task => task.workspaceIntent && !task.workspaceId || task.agentIntent && !task.agentId || task.agentId && (stale(taskObservedAt.get(task.id)) || !["idle", "running", "initializing", "error", "closed"].includes(task.lastAgentStatus ?? ""))).length;
    const paused = this.context.store.getMeta<boolean>("paused") ?? true;
    const connected = this.context.anyHostConnected();
    return { paused, dispatchHeld: this.context.store.getMeta<boolean>("dispatchHeld") ?? false, ...this.drainProjection(), connected, activeWorkers, unsettled, occupiedSlots: owned.length, quiet: paused && connected && activeWorkers === 0 && unsettled === 0, ...this.pausedStopCounts(facts) };
  }

  /** Live drain wait: no unreleased run, no in-flight operation. True even when not paused. */
  drainProjection(): { drained: boolean; boundRuns: BoundRun[] } {
    return boundDrainProjection(this.context.store);
  }

  private projectCapacities(facts: UiSnapshotFacts) {
    const tasks = facts.capacityTasks;
    // Every board refresh runs this: resolving each task through projectFor re-read and
    // re-parsed the project table per task per project, 67% of service CPU (2026-11-04).
    const projectKey = this.context.store.projectKeyResolver();
    return facts.projects.map(project => {
      const belongs = (task: import("../../shared/contracts").Task) => projectKey(task) === project.key;
      const limitTask = tasks.find(belongs) ?? { repoPath: project.primary.path ?? "", repository: project.primary.origin };
      const slotLimit = this.context.store.projectDispatchLimitFor(limitTask);
      return {
        projectKey: project.key, projectName: project.name,
        occupiedSlots: facts.capacityTasks.filter(task => belongs(task) && occupiesSlot(task)).length,
        slotLimit,
        inFlightTasks: tasks.filter(task => belongs(task) && holdsQueueWorkspace(task)).length,
        inFlightLimit: this.context.store.projectInFlightLimitFor(limitTask),
      };
    });
  }

  /**
   * Revisioned board projection (Contract 007): with the caller's last observed
   * store revision and no durable change, return global counters only;
   * otherwise return the full compact projection tagged with the revision.
   */
  uiSnapshot(input: { revision?: number } = {}): import("../../shared/contracts").UiBoard {
    this.context.markStoreAccess();
    // Spec 052: an expiring usage level changes the board with no durable write.
    // When the level in force flips, advance the revision once so pollers re-project.
    const usage = this.context.store.usageLevel();
    if (this.boardUsageLevel !== null && usage !== this.boardUsageLevel) {
      try { this.context.store.advanceRevision(); } catch { /* a read-only prewarm store re-projects on its first writable read */ }
    }
    this.boardUsageLevel = usage;
    try { reconcileRoutingGrants(this.context.store, this.context.decisions); } catch { /* expiry retries on the next writable pass */ }
    // Spec 028: a snapshot settling, or a location failing, changes the board with no
    // durable write. Advance the revision once when that health changes, so a poller
    // holding a bounded acknowledgement re-projects instead of keeping the old fact.
    const backup = this.context.backupHealthProjection();
    const backupKey = JSON.stringify(backup);
    if (this.boardBackupKey !== null && backupKey !== this.boardBackupKey) {
      try { this.context.store.advanceRevision(); } catch { /* a read-only prewarm store re-projects on its first writable read */ }
    }
    this.boardBackupKey = backupKey;
    const facts = this.context.cachedUiSnapshotFacts();
    const revision = facts.revision;
    const counters = this.boardCounters(facts);
    const error = this.context.boardError();
    if (input.revision !== undefined && input.revision === revision) {
      return { unchanged: true as const, revision, connected: counters.connected, paused: counters.paused, dispatchHeld: counters.dispatchHeld, drained: counters.drained, boundRuns: counters.boundRuns, quiet: counters.quiet, activeWorkers: counters.activeWorkers, unsettled: counters.unsettled, occupiedSlots: counters.occupiedSlots, stoppedThreads: counters.stoppedThreads, resumedThreads: counters.resumedThreads, error };
    }
    return {
      prStates: this.context.prStates, connected: counters.connected, hostId: this.context.hostId,
      paused: counters.paused, dispatchHeld: counters.dispatchHeld, drained: counters.drained, boundRuns: counters.boundRuns, quiet: counters.quiet, activeWorkers: counters.activeWorkers, unsettled: counters.unsettled,
      stoppedThreads: counters.stoppedThreads, resumedThreads: counters.resumedThreads,
      occupiedSlots: counters.occupiedSlots,
      globalLimit: this.context.store.getMeta<number>("globalLimit") ?? DEFAULT_GLOBAL_LIMIT,
      projectLimit: this.context.store.getMeta<number>("projectLimit") ?? DEFAULT_PROJECT_LIMIT,
      usage: this.context.store.usageView(),
      routingGrants: activeRoutingGrants(this.context.store),
      qaFence: this.context.store.qaFenceView(),
      demandOffsets: this.context.store.demandRoleOffsets(),
      papercutProjectLimit: this.context.store.getMeta<number>("papercutProjectLimit") ?? DEFAULT_PAPERCUT_PROJECT_LIMIT,
      projectLimitOverrides: this.context.store.projectDispatchLimitOverrides(),
      projectCapacities: this.projectCapacities(facts),
      stallThresholdMinutes: this.context.store.getMeta<number>("stallThresholdMinutes") ?? DEFAULT_STALL_THRESHOLD_MINUTES,
      holdReminderMinutes: this.context.store.getMeta<number>("holdReminderMinutes") ?? DEFAULT_HOLD_REMINDER_MINUTES,
      holdEscalationMinutes: this.context.store.getMeta<number>("holdEscalationMinutes") ?? DEFAULT_HOLD_ESCALATION_MINUTES,
      laneDrainMinutes: this.context.store.getMeta<number>("laneDrainMinutes") ?? DEFAULT_LANE_DRAIN_MINUTES,
      laneDrainEscalationMinutes: this.context.store.getMeta<number>("laneDrainEscalationMinutes") ?? DEFAULT_LANE_DRAIN_ESCALATION_MINUTES,
      hostOutageNoticeMinutes: this.context.store.getMeta<number>("hostOutageNoticeMinutes") ?? DEFAULT_HOST_OUTAGE_NOTICE_MINUTES,
      paseoCallLimit: this.context.store.configuredPaseoCallLimit(),
      operationLimit: this.context.store.configuredOperationLimit(), operationBacklog: this.context.store.operationBacklog(),
      backup,
      operations: this.context.store.operations({ states: ["pending", "running", "needs_attention", "failed"], limit: 100 }).map(summarizeOperation),
      error,
      tasks: facts.summaries, queuedCounts: facts.queuedCounts, lanes: facts.lanes, projects: facts.projects, qaRuns: facts.qaRuns, pendingSubmissions: this.context.store.pendingSubmissions(), profiles: this.context.engine.profiles, pool: this.context.store.pool(), assignments: this.context.store.counts(), recentAssignments: this.context.store.recentCounts(),
      availability: this.context.store.db.prepare("SELECT data FROM availability").all().map(row => availabilitySchema.parse(JSON.parse(String(row.data)))),
      revision, planning: this.context.store.planningRevisions(),
    };
  }

  queuedPage(input: { repoPath: string; offset: number; limit: number }) {
    this.context.markStoreAccess();
    const page = this.context.store.boardQueuePage(input.repoPath, input.offset, input.limit);
    const runs = this.context.store.runsForTasks(page.tasks.map(task => task.id));
    const pageIds = new Set(page.tasks.map(task => task.id));
    const decisions = new Map<string, string>();
    for (const decision of this.context.store.listDecisions({ status: 'open' })) for (const id of decision.links.tasks)
      if (pageIds.has(id) && !decisions.has(id)) decisions.set(id, decision.id);
    const admission = this.context.engine.resolution.slotAdmissionReader(this.context.store.admissionCandidates(), this.context.store.pendingRuns(), true);
    const contexts = new Map(page.tasks.map(task => [task.id, taskWaitStateContext(this.context.store, task, decisions.get(task.id) ?? null, admission)]));
    const display = page.tasks.map(task => ({ ...task, reason: queuedReason(this.context.store, task, contexts.get(task.id)!, candidate => this.context.engine.queuedExternalWait(candidate)) }));
    const events = new Map(page.tasks.map(task => [task.id, this.context.store.eventsAll(task.id)]));
    const repositorySettings = new Map(display.map(task => [task.id, this.context.store.canonicalRepository(task.repoPath, task.repository)]));
    return { tasks: visibleTaskSummaries(display, this.context.store.projects(), runs, decisions, contexts, this.context.hostId, events, repositorySettings), nextOffset: page.nextOffset };
  }

  laneTaskPage(input: { lane: string; offset: number; limit: number }) {
    this.context.markStoreAccess();
    const page = this.context.store.laneTaskPage(input.lane, input.offset, input.limit);
    const runs = this.context.store.runsForTasks(page.tasks.map(task => task.id));
    const events = new Map(page.tasks.map(task => [task.id, this.context.store.eventsAll(task.id)]));
    const repositorySettings = new Map(page.tasks.map(task => [task.id, this.context.store.canonicalRepository(task.repoPath, task.repository)]));
    return { tasks: visibleTaskSummaries(page.tasks, this.context.store.projects(), runs, new Map(), new Map(), this.context.hostId, events, repositorySettings), total: page.total, nextOffset: page.nextOffset };
  }

  detail(input: { taskId?: string; reference?: string; repository?: string; number?: number }) {
    this.context.markStoreAccess();
    const result = this.context.cachedTaskDetail(input.taskId ? this.context.store.resolveTaskId(input.taskId) : this.context.store.taskIdByNumber(input));
    const heavyRun = this.context.cachedUiSnapshotFacts().summaries.find(task => task.id === result.task.id)?.heavyRun;
    return heavyRun ? { ...result, task: { ...result.task, heavyRun } } : result;
  }

  /** Spec 050 read verb: what an owner reads before steering one stuck task. */
  taskNext(input: { taskId?: string; reference?: string; caller?: "operator (board)" }) {
    this.context.markStoreAccess();
    const taskId = input.taskId ? this.context.store.resolveTaskId(input.taskId) : this.context.store.taskIdByNumber(input);
    const task = this.context.store.task(taskId);
    if (task.removedAt) throw new Error("Task was removed from the queue");
    try {
      // The task host's own snapshot, as queue.detail reads it (nucleus#1151).
      const hostProfiles = this.context.engine.profilesFor?.(task.hostId);
      const facts = { ...this.ownerVerbFacts(task), operatorBoard: input.caller === "operator (board)", ...(hostProfiles ? { hostProfiles } : {}) };
      if (task.phase !== "queued") return ownerTaskNext(facts);
      const context = taskWaitStateContext(this.context.store, task, null, candidate => this.context.engine.resolution.slotAdmissionReason(candidate));
      const projected = queuedReason(this.context.store, task, context);
      const reason = projected === "Waiting for dispatch" ? this.context.engine.queuedExternalWait(task) || projected : projected;
      const stop = task.resolution.stop;
      const resolution = stop && (["capacity", "prerequisite"].includes(stop.reason)
        || stop.reason === "route_unavailable" && this.context.store.routingRetryAllowed(task)) ? { ...task.resolution, stop: null } : task.resolution;
      return ownerTaskNext({ ...facts, task: { ...task, reason, resolution } });
    }
    catch (error) {
      // A read view never fails by design; a programming error names its own
      // source frames so the next occurrence is attributable (papercut a4b0e3a4:
      // "Cannot read properties of undefined (reading 'at')" with no frame).
      if (!(error instanceof TypeError)) throw error;
      const frames = (error.stack ?? "").split("\n").slice(1).filter(line => line.includes("/server/") || line.includes("/shared/")).slice(0, 3).map(line => line.trim()).join(" <- ");
      throw new Error(`task.next failed for ${task.id} at version ${task.version}: ${error.message}${frames ? ` (${frames})` : ""}`);
    }
  }
  /**
   * One task's recorded rows for the owner verbs. `detail` and `task.next` poll side by side,
   * so they share the one evidence read the detail cache already made instead of parsing the
   * task's whole event history twice every four seconds (audit A8). The task row, its version,
   * pause and hold state, retry records and every other authority or side-effect observation
   * stay fresh reads: the shared evidence is used only for this exact version, and every write
   * to the task's row, runs, events, notices or hook records removes it.
   */
  private ownerVerbFacts(task: Task): ReturnType<typeof collectOwnerVerbFacts> {
    const evidence = this.context.cachedTaskDetail.evidence(task.id);
    return evidence.task.version === task.version
      ? { store: this.context.store, task, runs: evidence.runs, events: evidence.events, notices: evidence.notices, hookRecords: evidence.hookRecords }
      : collectOwnerVerbFacts(this.context.store, task);
  }

  outcome(input: { taskId?: string; submissionId?: string; reference?: string; repository?: string; number?: number }) {
    this.context.markStoreAccess();
    const record = input.submissionId ? this.context.store.outcomeBySubmission(input.submissionId)
      : this.context.store.outcome(input.taskId ?? this.context.store.taskIdByNumber(input));
    if (!record) throw new Error("Outcome not found");
    return record;
  }
  outcomeSearch(input: OutcomeSearchInput) {
    this.context.markStoreAccess();
    return this.context.store.searchOutcomes(input);
  }
}
