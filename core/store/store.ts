import { StoreAuth } from "./store-auth";
import { StoreConfig } from "./store-config";
import { digest,now,StoreCore } from "./store-core";
import { StoreHostRuns } from "./store-host-runs";
import { StoreLanes } from "./store-lanes";
import type { ReclaimResult,RetainedRowPrune } from "./store-maintenance";
import { StoreMaintenance } from "./store-maintenance";
import { StoreOperations } from "./store-operations";
import { buildOutcomeRecord,StoreOutcomes,type TelemetryFactChunk,type VerbOutcome } from "./store-outcomes";
import { StorePlanning } from "./store-planning";
import { StoreProjectQa } from "./store-project-qa";
import { StoreProjects } from "./store-projects";
import { StoreSubmissions,submissionHash } from "./store-submissions";
import { STORED_OBSERVATION_FIELDS,StoreTaskWrites,type DetachedEntries,type StoredTaskParts } from "./store-task-writes";
import { repositoryIdentity,StoreTasks,taskNumberReference } from "./store-tasks";
export { digest } from "./store-core";
export { ASSIGNMENT_HISTORY_KEEP,AUTO_VACUUM_INCREMENTAL,AUTO_VACUUM_NONE,CACHE_SIZE_KIB,CURRENT_SCHEMA,HOST_RUN_KEEP_PER_SELECTOR,JOURNAL_SIZE_LIMIT_BYTES,PROJECT_QA_KEEP_PER_REPOSITORY,RECLAIM_BUDGET_MS,RECLAIM_CHUNK_PAGES,RECLAIM_DRAIN_BUDGET_MS,RECLAIM_DRAIN_FREE_PAGES,RECLAIM_DRAIN_MAX_PAGES,RECLAIM_MAX_PAGES,STORE_COMPACTION_META_KEY,STORE_MAINTENANCE_META_KEY,VERB_OUTCOME_RETENTION_MS } from "./store-maintenance";
export { operationIdForKey,operationInputHash,provedPreSendHistory } from "./store-operations";
export { buildOutcomeRecord,type TelemetryFactChunk,type VerbOutcome } from "./store-outcomes";
export { explicitCriticalFalseSubmissionHash,legacySubmissionHash,submissionHash } from "./store-submissions";


import { randomUUID } from "node:crypto";
import { basename,dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { BriefVersion,Completion,PoolEntry,Submission } from "../../shared/contracts";
import { availabilitySchema,compactLiveTask,completionMembership,decisionSchema,DISPATCH_WAIT_REASON,holdsOf,isOperatorOrigin,leadSchema,leadVersionMetadataSchema,noticeSchema,resolutionSchema,runtimeRetirementFailure,syncHoldProjection,TASK_OWNER_HOLD,taskOwner,taskStopClassification,type AgentMessageRecord,type BoardLead,type BoardLeadLink,type Decision,type DemandRoleOffsets,type HostRunAccountingRetirement,type HostRunInternalRecord,type HostRunRecord,type Lane,type LaneDocumentPin,type LaneDocumentVersion,type LaneView,type Lead,type LeadVersion,type Notice,type Outcome,type OutcomeSearchInput,type OutcomeSearchResult,type Papercut,type PendingSubmission,type Profile,type Project,type ProjectCloseout,type ProjectManageInput,type ProjectManagementPreview,type ProjectMergeCheck,type ProjectMergeCheckInput,type ProjectMergeInput,type ProjectMergeResult,type ProjectPlan,type ProjectQa,type ProjectQaRun,type ProjectRemovalBlocker,type ProjectRemoveRepositoryInput,type ProjectTombstone,type ProjectUpsertInput,type ProjectValidation,type QaFence,type QaFenceRecord,type QaFenceView,type QaInventoryItem,type RepositoryChecksPolicy,type RepositorySettings,type RoutingGrant,type RoutingPolicy,type Run,type RuntimeRetirement,type SnapshotInput,type Task,type TaskHolds,type UsageLevel,type UsageSetting,type UsageView } from "../../shared/contracts";
import { hookStateIsTerminal,type HookRecord } from "../../shared/hooks";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { operationIsSettled,type OperationAcceptance,type OperationResult,type QueueOperation } from "../../shared/operations";
import { telemetryStageForTask } from "../../shared/telemetry";
import { briefDigest,initialBriefVersion } from "../planning/brief";
import { laneSnapshot,type LaneRecordActivity } from "../planning/lanes";
import { plainProfileRequest,workerThinkingConflict } from "../dispatch/routing";
import { EMPTY_RUN_USAGE } from "../telemetry/run-usage";

import { papercutFromLead } from "../../shared/papercut-lead";
import { purgeReleasedRunTicket } from "../intake/reporting-files";

import { type NucleusProfile,type ProfileImportRecord } from "../../shared/profiles";

import { runBuildOutputIntent } from "../hooks/build-output-records";
import { removeRecordedRunScratchDirectory } from "../workspaces/run-scratch";

import { type RepositoryRekeyInput,type RepositoryRekeyPreview,type RepositoryRekeyPreviewInput,type RepositoryRekeyReceipt,type RepositoryRekeyReceiptQuery,type RepositoryRekeyResult } from "../../shared/repository-rekey";
import type { VerifiedEnclosingOperation } from "../planning/enclosing-operation";
import { STEPS_RETIRED_REASON } from "../recovery/retired-steps";
import { stageDeclarationFromBrief } from "../stages";

import { HOST_RUN_OUTPUT_FAILURE_DUE_PAGE,HOST_RUN_OUTPUT_FAILURE_SUMMARY_EXAMPLES,type HostRunOutputFailure,type HostRunOutputReclassification } from "../host-runs/host-run-output-failures";
import { qualifiedThreadArchiveEffectKey } from "./store-core";
import { ContentFingerprint,HISTORY_RETENTION_MS,StoreFacts } from "./store-maintenance";
/**
 * The store's write funnels are closed for a bounded maintenance window; nothing may
 * start a transaction, and the window itself proves no other connection holds a lock.
 */
export { now,qualifiedThreadArchiveEffectKey,StoreMaintenanceError } from "./store-core";
export { UNRESOLVED_SEED } from "./store-lanes";
export { ContentFingerprint,HISTORY_RETENTION_MS,StoreFacts } from "./store-maintenance";

/** Latest accepted non-recovery run completion by run creation, optionally limited to statuses. */
export const latestRunCompletion = (runs: Run[], statuses?: string[]) =>
  runs.filter(r => r.role !== "recovery" && r.completion && (!statuses || statuses.includes(r.completion.status)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.completion ?? null;

/** How long a settled host-run journal and its internal meta are kept (Tom, 2026-10-16: 14 days; 2026-10-20: 4 days, to cut store size and backup writes). Retired producer rows are not a retention target. */
/** The hold reason a host run that still owns a workspace gives its cleanup or archive. */
export const hostRunHoldReason = (run: { id: string; state: string }) =>
  `host run ${run.id} (${run.state === "settled" ? "settled, capacity still reserved" : run.state}) holds this workspace`;

export class Store {
  private readonly pendingRunScratchCleanup = new Set<string>();
  /**
   * The recorded-leaf remover. Production proves the recorded mount and removes
   * one proved real directory; a private fixture substitutes its own proved
   * mount, never a different policy.
   */
  private runScratchRemover: (directory: string) => boolean = directory => removeRecordedRunScratchDirectory(directory);
  private readonly core = new StoreCore({
    transaction: () => this.transactionHooks(),
    revisionAdvanced: () => { this.tasksStore.projectionClock = this.tasksStore.readProjectionClock(); },
    eventWritten: (taskId, at) => this.eventWritten(taskId, at),
    taskChanged: taskId => this.taskChanged(taskId),
  });
  private readonly maintenanceStore = (() => {
    const store = this;
    return new StoreMaintenance(this.core, {
      storedSchema: (path, integrity) => Store.storedSchema(path, integrity),
      schemaIn: (db, integrity) => Store.schemaIn(db, integrity),
      verifyMigrationSnapshot: (source, snapshot) => Store.verifyMigrationSnapshot(source, snapshot),
      get db() { return store.db; },
      setMeta: this.setMeta.bind(this),
      numberedTask: this.numberedTask.bind(this),
      taskRow: this.taskRow.bind(this),
      storedReviewValue: this.storedReviewValue.bind(this),
      getMeta: this.getMeta.bind(this),
      deleteMeta: this.deleteMeta.bind(this),
      transaction: this.transaction.bind(this),
      get maintenanceOpen() { return store.maintenanceOpen; },
      get path() { return store.path; },
      runs: this.runs.bind(this),
      hookEvents: this.hookEvents.bind(this),
      deleteCredential: this.deleteCredential.bind(this),
      get lastEventAtByTask() { return store.lastEventAtByTask; },
      set lastEventAtByTask(value) { store.lastEventAtByTask = value; },
      get tasksStore() { return store.tasksStore; },
      get cachedTaskCount() { return store.cachedTaskCount; },
      set cachedTaskCount(value) { store.cachedTaskCount = value; },
      advanceRevision: this.advanceRevision.bind(this),
      taskChanged: this.taskChanged.bind(this),
      notices: this.notices.bind(this),
    });
  })();

  private readonly lanesStore = (() => {
    const store = this;
    return new StoreLanes(this.core, {
      readClock: this.readClock.bind(this),
      get db() { return store.db; },
      uiTasks: this.uiTasks.bind(this),
      ensureProject: this.ensureProject.bind(this),
      update: this.update.bind(this),
      advanceRevision: this.advanceRevision.bind(this),
      transaction: this.transaction.bind(this),
      get laneViewsCache() { return store.laneViewsCache; },
      set laneViewsCache(value) { store.laneViewsCache = value; },
      get tasksStore() { return store.tasksStore; },
      get lastEventAtByTask() { return store.lastEventAtByTask; },
      set lastEventAtByTask(value) { store.lastEventAtByTask = value; },
      get eventTimesClock() { return store.eventTimesClock; },
      set eventTimesClock(value) { store.eventTimesClock = value; },
      get laneOutcomeIndex() { return store.laneOutcomeIndex; },
      set laneOutcomeIndex(value) { store.laneOutcomeIndex = value; },
      get outcomeRowsClock() { return store.outcomeRowsClock; },
      set outcomeRowsClock(value) { store.outcomeRowsClock = value; },
      outcomes: this.outcomes.bind(this),
      get laneActivity() { return store.laneActivity; },
      set laneActivity(value) { store.laneActivity = value; },
      ensureLeadLaneIndex: this.ensureLeadLaneIndex.bind(this),
      projects: this.projects.bind(this),
      projectKeyResolver: this.projectKeyResolver.bind(this),
      openLeads: this.openLeads.bind(this),
      task: this.task.bind(this),
      plan: this.plan.bind(this),
      projectPlannerRecipient: this.projectPlannerRecipient.bind(this),
      getMeta: this.getMeta.bind(this),
      projectByKey: this.projectByKey.bind(this),
      notices: this.notices.bind(this),
      putNotice: this.putNotice.bind(this),
    });
  })();

  private readonly pendingRunReportingCleanup = new Map<string, string>();
  private readonly authStore = new StoreAuth(this.core);
  private readonly projectsStore = new StoreProjects(this.core, {
    rekeyed: () => {
      this.tasksStore.invalidateProjections(); this.laneActivity = null;
      this.planningStore.clearHistoryCache(); this.lanesStore.clearHistoryCache();
      this.advanceLeadRevision(); this.advanceRevision(); this.taskChanged(null);
    },
    allTasks: () => this.allTasks(),
    leads: () => this.leads(),
    lanes: () => this.lanes(),
    listDecisions: (query) => this.listDecisions(query),
    outcomes: () => this.outcomes(),
    taskRepositories: () => this.taskRepositories(),
    pendingSubmissions: () => this.pendingSubmissions(),
    numberedOperation: (data) => this.numberedOperation(data),
    operationPayload: (id) => this.operationPayload(id),
    plan: (input) => this.plan(input),
    runs: (taskId) => this.runs(taskId),
    updateLead: (lead) => this.updateLead(lead),
    setLaneStatus: (key, status, note) => this.setLaneStatus(key, status, note),
    updateDecision: (decision) => this.updateDecision(decision),
    storedPlan: (project, version) => this.storedPlan(project, version),
  });
  private readonly hostRunStore = new StoreHostRuns(this.core);
  private readonly projectQaStore = new StoreProjectQa(this.core);
  private readonly planningStore = new StorePlanning(this.core, {
    requireLaneDocuments: (keys, repoPath, origin) => this.lanesStore.requireLaneDocuments(keys, repoPath, origin),
    laneDocumentPinsFor: task => this.lanesStore.laneDocumentPinsFor(task),
    laneDocument: (key, version) => this.lanesStore.laneDocument(key, version),
    editLaneDocument: input => this.lanesStore.editLaneDocument(input),
    laneByKey: (key) => this.laneByKey(key),
    requireAttachableLanes: (keys, repoPath, origin) => this.requireAttachableLanes(keys, repoPath, origin),
    projectByKey: (key) => this.projectByKey(key),
    projectFor: (repoPath, origin) => this.projectFor(repoPath, origin),
    projects: () => this.projects(),
    ensureProject: (repoPath, origin) => this.ensureProject(repoPath, origin),
    invalidateLaneActivity: () => { this.laneActivity = null; },
  });
  private readonly operationsStore = new StoreOperations(this.core, {
    taskChanged: (taskId) => this.taskChanged(taskId),
    numberForCached: (taskId) => this.tasksStore.numberForCached(taskId),
    runs: (taskId) => this.runs(taskId),
    task: (id) => this.task(id),
    canonicalRepository: (repoPath, origin) => this.canonicalRepository(repoPath, origin),
  });
  get db(): DatabaseSync { return this.core.db; }
  /** True while a bounded service-owned maintenance window holds the write funnels closed. */
  private get maintenanceOpen() { return this.core.maintenanceOpen; }
  private set maintenanceOpen(value: boolean) { this.core.maintenanceOpen = value; }
  private cachedTaskCount: number | null = null;
  private readonly taskChangeListeners = new Set<(taskId: string | null) => void>();
  private readonly prerequisiteListeners = new Set<(taskIds: readonly string[]) => void>();
  private readonly settledDependents = new Set<string>();
  private readonly tasksStore = new StoreTasks(this.core, {
    lastEventAtByTask: () => this.lastEventAtByTask,
    settledDependents: this.settledDependents,
    numberedTask: (data, parts) => this.numberedTask(data, parts),
    resolveReviewRows: rows => this.resolveReviewRows(rows),
    numberFor: taskId => this.numberFor(taskId),
    notices: taskId => this.notices(taskId),
    projectByKey: key => this.projectByKey(key),
  });
  private readonly configStore = new StoreConfig(this.core, {
    availability: () => this.availability(),
  });
  private readonly outcomesStore = (() => {
    const owner = this;
    return new StoreOutcomes(this.core, {
      tasksStore: this.tasksStore,
      numberFor: taskId => this.numberFor(taskId),
      settledDependents: this.settledDependents,
      repositorySettingsFor: repository => this.repositorySettingsFor(repository),
      get laneOutcomeIndex() { return owner.laneOutcomeIndex; },
      set laneOutcomeIndex(value) { owner.laneOutcomeIndex = value; },
      get outcomeRowsClock() { return owner.outcomeRowsClock; },
      set outcomeRowsClock(value) { owner.outcomeRowsClock = value; },
    });
  })();
  private readonly submissionsStore = new StoreSubmissions(this.core, {
    numberedTask: data => this.numberedTask(data),
    taskReference: id => this.taskReference(id),
    runs: taskId => this.runs(taskId),
    tasks: () => this.tasks(),
    update: (id, change, kind, detail, expected) => this.update(id, change, kind, detail, expected),
  });
  private readonly taskWritesStore = new StoreTaskWrites(this.core, {
    tasksStore: this.tasksStore,
    laneDocument: (key, version) => this.laneDocument(key, version),
  });

  onPrerequisitesSettled(listener: (taskIds: readonly string[]) => void) {
    this.prerequisiteListeners.add(listener);
    return () => { this.prerequisiteListeners.delete(listener); };
  }
  onTaskChange(listener: (taskId: string | null) => void) {
    this.taskChangeListeners.add(listener);
    return () => { this.taskChangeListeners.delete(listener); };
  }
  private taskChanged(taskId: string | null) { for (const listener of this.taskChangeListeners) listener(taskId); }
  routingRetryAllowed(task: Task): boolean { return this.tasksStore.routingRetryAllowed(task); }
  setRoutingEpoch(epoch: string): void { return this.tasksStore.setRoutingEpoch(epoch); }
  markRoutingAttempt(taskId: string): void { return this.tasksStore.markRoutingAttempt(taskId); }
  readyQueueHeads(limit: number, repoPath?: string, startedOnly = false): Task[] { return this.tasksStore.readyQueueHeads(limit, repoPath, startedOnly); }
  boardQueueCounts(): Array<{ repoPath: string; count: number }> { return this.tasksStore.boardQueueCounts(); }
  boardQueuePage(repoPath: string, offset: number, limit: number): { tasks: Task[]; nextOffset: number | null } { return this.tasksStore.boardQueuePage(repoPath, offset, limit); }
  boardTasks(limit: number): Task[] { return this.tasksStore.boardTasks(limit); }
  dueHoldTasks(nowMs = Date.now()): Task[] { return this.tasksStore.dueHoldTasks(nowMs); }
  prStateTasks(): Task[] { return this.tasksStore.prStateTasks(); }
  activeUiTasks(): Task[] { return this.tasksStore.activeUiTasks(); }
  queuedOriginGroups(): Array<{ owner: string; workspaceId: string | null; ids: ReadonlySet<string> }> { return this.tasksStore.queuedOriginGroups(); }
  /**
   * Lane views read the newest event time per task and every outcome. Both are
   * append-only in practice, and recomputing them cost most of a board rebuild
   * (audit A1: 31 ms of 48 ms at 240 lanes over 6,792 outcomes). The event map is
   * maintained by `event()` and the purge, the outcome-by-lane index is built once
   * and updated by `insertOutcomeRow`, and the finished views are cached against
   * `laneViewRevision()`: a task, lane, outcome, event, lead or draft write
   * advances it, while a run, notice, project, operation or configuration write
   * leaves the views alone. A rollback drops all three, and a cache is never
   * populated inside a transaction.
   */
  private lastEventAtByTask: Map<string, string> | null = null;
  private eventTimesClock = -1;
  private laneOutcomeIndex: Map<string, Outcome[]> | null = null;
  private outcomeRowsClock = -1;
  private laneActivity: Map<string, LaneRecordActivity> | null = null;
  private laneViewsCache: { clock: number; value: LaneView[] } | null = null;
  /**
   * The clock the cached lane views were built at. SQLite triggers advance it on every write
   * to a table a lane view derives from — tasks, lanes, events, outcomes, leads and brief
   * drafts, the actual lane and outcome revisions — so a write that bypasses the store's
   * funnels (a fixture backdating rows, a repair script) rebuilds the views instead of
   * serving them stale, and a run, notice, project or configuration write, which no view
   * derives from, leaves them alone. Each read is one row.
   */
  laneViewRevision(): number { return this.lanesStore.laneViewRevision(); }

  private readClock(name: string): number { return this.core.readClock(name); }
  /** Read the schema under SQLite's native snapshot, including committed WAL. */
  static storedSchema(path: string, checkIntegrity = true): number | undefined { return StoreMaintenance.storedSchema(path, checkIntegrity); }
  private static schemaIn(db: DatabaseSync, checkIntegrity = true): number { return StoreMaintenance.schemaIn(db, checkIntegrity); }
  /** Compare native snapshots by every stored value and meaningful row order. */
  private static verifyMigrationSnapshot(source: DatabaseSync, snapshot: DatabaseSync): void { return StoreMaintenance.verifyMigrationSnapshot(source, snapshot); }
  constructor(readonly path: string, backupDir?: string, onMigrationStart?: () => void) { this.maintenanceStore.initialize(path, backupDir, onMigrationStart); }
  /** External content keeps searchable text only in the permanent outcome row. */
  private createOutcomeSearchIndex(): void { return this.maintenanceStore.createOutcomeSearchIndex(); }
  /** Resolve the current body from its version unless it has independent bytes. */
  private createLeadReadView(): void { return this.maintenanceStore.createLeadReadView(); }
  close() { this.taskChanged(null); this.taskChangeListeners.clear(); this.prerequisiteListeners.clear(); this.db.close(); }
  /**
   * Spec 028 revision "Store compaction" (audit B9): the store's write funnels are
   * closed for one bounded maintenance window. This is service-local: it never writes
   * the operator's `paused` key and never changes dispatch policy, so pausing Queue is
   * still the operator's own action and a maintenance window neither sets nor clears it.
   *
   * The window is entered only by service code that has already drained its own work and
   * that performs the conversion in one synchronous turn, so no caller can be writing at
   * the moment it opens. The funnels below refuse a new write anyway, and the conversion
   * itself proves no other connection holds a lock (an exclusive lock probe) before it
   * touches the file: a busy store fails before anything is changed.
   */
  beginMaintenanceWindow(): void { return this.maintenanceStore.beginMaintenanceWindow(); }
  /** Release the window's write funnels; the window's own writes are all committed. */
  endMaintenanceWindow(): void { return this.maintenanceStore.endMaintenanceWindow(); }
  /** True while a bounded maintenance window holds the write funnels closed. */
  get maintenance(): boolean { return this.maintenanceStore.maintenance; }
  /** The store's auto-vacuum mode as SQLite reports it (0 none, 2 incremental). */
  autoVacuumMode(): number { return this.maintenanceStore.autoVacuumMode(); }
  /** True when the file holds no table yet: the only moment SQLite accepts an auto-vacuum mode. */
  /** The store's file and page facts, from one stat and three cheap pragmas. */
  storeFacts(): StoreFacts { return this.maintenanceStore.storeFacts(); }
  /**
   * Spec 028 revision "truthful preservation": the canonical content digest of the store's
   * authoritative logical rows and settings.
   *
   * Every column value of every row of every authoritative table is hashed from its exact
   * stored bytes, and one table's rows are combined order-independently, so a digest is a
   * function of the stored content alone: a rewrite that moves pages, changes rowids or
   * reorders rows leaves it identical, and a same-length edit inside a value changes it. The
   * per-table combination is a count plus the sum and xor of the row hashes (64-bit), so
   * duplicate rows still count and the read needs no sort, no temp file and bounded memory.
   *
   * Excluded, with the reason: SQLite's own `sqlite_*` bookkeeping (`sqlite_sequence` holds an
   * AUTOINCREMENT high-water mark derived from the rows, and the other `sqlite_*` names are
   * internal); FTS5's shadow tables (`<fts>_data`, `_idx`, `_content`, `_docsize`, `_config`),
   * whose page and segment layout is the index's representation of the text the virtual table
   * itself returns, so the virtual table's own logical rows are hashed instead; and this
   * module's own two maintenance records in `meta`, which change around the window by design.
   * Every other table, and every other `meta` row (pause, limits, pool, availability, usage,
   * retention marks, every Queue-internal fact), is hashed exactly.
   */
  contentFingerprint(): ContentFingerprint { return this.maintenanceStore.contentFingerprint(); }
  /**
   * Spec 028: return freed pages after a prune pass, bounded rather than a full rewrite.
   *
   * Incremental auto-vacuum keeps deleted pages on the store's freelist; this asks SQLite to
   * release at most `maxPages` of them, in chunks, and stops after `budgetMs`, so an hourly or
   * daily prune pays one short write pass instead of an unbounded writer stall. `pages` is what
   * the file actually gave back (a truncation can take a few pages more than the chunk it was
   * asked for). The WAL is then checkpointed to `journal_size_limit`. A pass that finds nothing
   * to reclaim writes nothing, so an idle store is not rewritten every hour.
   */
  reclaimFreedPages(options: { maxPages?: number; budgetMs?: number } = {}): ReclaimResult { return this.maintenanceStore.reclaimFreedPages(options); }
  /** One truncating WAL checkpoint; `busy` reports a reader that kept the WAL in place. */
  checkpointWal(): { busy: number; log: number; checkpointed: number } { return this.maintenanceStore.checkpointWal(); }
  transaction<T>(fn: () => T): T { return this.core.transaction(fn); }
  private transactionHooks() {
    const undo = this.tasksStore.projectionUndo = { projection: this.tasksStore.taskProjection, clock: this.tasksStore.projectionClock, sequence: this.tasksStore.newestSequence,
      tasks: new Map(), runs: new Map(), counts: new Map() };
    let restorable = false;
    return {
      committed: () => {
        this.tasksStore.projectionUndo = null;
        for (const [runId, taskId] of this.pendingRunReportingCleanup) {
          try {
            purgeReleasedRunTicket(dirname(this.path), taskId, runId);
            this.pendingRunReportingCleanup.delete(runId);
          } catch { /* The credential row is already revoked; a later transaction retries file cleanup. */ }
        }
        for (const directory of this.pendingRunScratchCleanup)
          this.runScratchRemover(directory);
        this.pendingRunScratchCleanup.clear();
        const dependents = [...this.settledDependents];
        this.settledDependents.clear();
        if (dependents.length) for (const listener of this.prerequisiteListeners) {
          try { listener(dependents); } catch { /* A wake is advisory; the safety sweep remains. */ }
        }
      },
      beforeRollback: () => {
        restorable = undo.projection !== null && undo.projection === this.tasksStore.taskProjection
          && this.tasksStore.readProjectionClock() === this.tasksStore.projectionClock;
      },
      rolledBack: () => {
        this.projectsStore.clearCache();
        this.tasksStore.projectionUndo = null;
        if (restorable && undo.clock === this.tasksStore.readProjectionClock()) this.tasksStore.restoreProjection(undo);
        this.pendingRunScratchCleanup.clear();
        this.pendingRunReportingCleanup.clear();
        this.settledDependents.clear();
        // Audit B7: a rollback used to throw away every projection, so the next read re-parsed
        // about 62 MB of task, brief-version and review rows for one refused write. The caches
        // keyed on a `projection_clock` row revalidate themselves: a rollback rewinds those rows,
        // so a cache built or updated before the transaction still matches its clock and one
        // built or updated inside it no longer does. The project cache is also cleared to prevent clock reuse after rollback.
        // The caches without a clock are reset here: a cached task number can name a rolled-back assignment, and the lane
        // activity map is rebuilt from committed rows rather than trusted.
        this.tasksStore.numberCache.clear();
        this.laneActivity = null;
        this.taskChanged(null);
      },
    };
  }

  getMeta<T>(key: string): T | undefined { return this.core.getMeta(key); }
  deleteMeta(key: string) { return this.core.deleteMeta(key); }
  setMeta(key: string, value: unknown) { return this.core.setMeta(key, value); }

  observeHostRunAuthority(observer: ((previous: unknown, value: unknown) => void) | null) { return this.core.observeHostRunAuthority(observer); }


  telemetryRevision(): number { return this.core.telemetryRevision(); }
  boardRevision(): number { return this.core.boardRevision(); }
  private advanceTelemetryRevision() { return this.core.advanceTelemetryRevision(); }
  advanceRevision() { return this.core.advanceRevision(); }
  leadRevision(): number { return this.core.leadRevision(); }
  /**
   * The board's per-domain read keys: `lead.board` follows `leadRevision()`, open decisions
   * their table's trigger clock, and `plans` the clock its plan, lane and project rows
   * advance. A run, event, observation or telemetry write moves none of them, so the
   * board refetches a list only when that list's own records changed (task 1030).
   */
  planningRevisions(): { leads: number; decisions: number; plans: number } {
    return { leads: this.leadRevision(), decisions: this.readClock("decisionRows"), plans: this.readClock("planInputs") };
  }
  private advanceLeadRevision() { return this.core.advanceLeadRevision(); }
  /**
   * Fresh observation times for the board's 45 s unsettled counters. The counters must not read
   * the cached board projection: an observation-only write intentionally leaves that projection
   * in place, and elapsed time crosses the boundary with no write at all. Point reads of one
   * extracted field per id keep this far cheaper than re-projecting the whole board.
   */
  observationTimes(kind: "task" | "run", ids: Iterable<string>): Map<string, string | null> { return this.taskWritesStore.observationTimes(kind, ids); }
  private assignNumber(taskId: string, repository: string): { number: number; reference: string } {
    const existing = this.numberFor(taskId);
    if (existing) return existing;
    const row = this.db.prepare("SELECT next_number FROM task_number_counters WHERE repository=?").get(repository);
    const number = Number(row?.next_number ?? 1);
    this.db.prepare("INSERT INTO task_numbers(task_id,repository,number) VALUES(?,?,?)").run(taskId, repository, number);
    this.db.prepare("INSERT INTO task_number_counters(repository,next_number) VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET next_number=excluded.next_number").run(repository, number + 1);
    const assigned = { number, reference: taskNumberReference(repository, number) };
    this.tasksStore.numberCache.set(taskId, assigned);
    return assigned;
  }
  numberFor(taskId: string): { number: number; reference: string } | null {
    const row = this.db.prepare("SELECT repository,number FROM task_numbers WHERE task_id=?").get(taskId);
    return row ? { number: Number(row.number), reference: taskNumberReference(String(row.repository), Number(row.number)) } : null;
  }
  /** Every numbered task's numbering repository; the row survives a task's purge, so it resolves a decision's link. */
  taskRepositories(): Array<{ taskId: string; repository: string }> {
    return this.db.prepare("SELECT task_id,repository FROM task_numbers").all()
      .map(row => ({ taskId: String(row.task_id), repository: String(row.repository) }));
  }
  taskIdByNumber(input: { reference?: string; repository?: string; number?: number }): string {
    const match = input.reference?.match(/^([^#]+)#0*([1-9][0-9]*)$/);
    const rows = input.repository && input.number
      ? this.db.prepare("SELECT task_id FROM task_numbers WHERE repository=? AND number=?").all(repositoryIdentity(input.repository, input.repository), input.number)
      : match ? this.db.prepare("SELECT task_id,repository FROM task_numbers WHERE number=?").all(Number(match[2])).filter(row =>
        match[1]!.includes('/') ? String(row.repository) === repositoryIdentity(match[1]!, match[1]!) : basename(String(row.repository)) === match[1]) : [];
    if (rows.length !== 1) throw new Error(rows.length ? "Ambiguous task reference; use repository and number" : "Task reference not found");
    return String(rows[0].task_id);
  }
  /** Resolve human task references at the API boundary; stored identities stay UUIDs. */
  resolveTaskId(identity: string): string {
    return identity.includes('#') ? this.taskIdByNumber({ reference: identity }) : identity;
  }
  addPapercut(record: Omit<Papercut, "lanes" | "draftId" | "version"> & { lanes?: string[]; draftId?: string | null }): Papercut { return this.planningStore.addPapercut(record); }
  papercut(id: string): Papercut { return this.planningStore.papercut(id); }
  listPapercuts(query: { repository?: string; state?: Papercut["state"] } = {}): Papercut[] { return this.planningStore.listPapercuts(query); }
  updatePapercut(record: Papercut): Papercut { return this.planningStore.updatePapercut(record); }
  /**
   * One task's stored parts. Brief versions and reviews come from their own tables; the
   * referenced text comes from brief versions, and the observation-only fields
   * from `task_observations`. A bulk reader supplies those two side stores for its page so
   * a projection build looks none of them up per task.
   */
  private resolveStoredTask(raw: Record<string, unknown>, parts?: StoredTaskParts): Task { return this.taskWritesStore.resolveStoredTask(raw, parts); }
  /**
   * The exact text a lane-document pin names. A pin is resolved from the stored version it
   * was taken from and its digest is checked on every read, so a later document edit cannot
   * change it. A missing version, or bytes that do not match the pin, refuses: the current
   * document is never substituted. A legacy pin that still carries its own text keeps those
   * recorded bytes, which is what every reader saw before the pin was slimmed.
   */
  private resolvedPin(taskId: string, value: unknown): LaneDocumentPin { return this.taskWritesStore.resolvedPin(taskId, value); }
  private storedObservationRow(taskId: string): string | null { return this.taskWritesStore.storedObservationRow(taskId); }
  /** The observation-only fields and the write time that moved them, as one small row. */
  private syncTaskObservation(taskId: string, task: Task) { return this.taskWritesStore.syncTaskObservation(taskId, task); }
  /**
   * A pin as the row stores it: identity only when the lane document's stored version proves
   * the same bytes. A pin whose version cannot be proven keeps its recorded text inline rather
   * than being resolved to content it never named.
   */
  private storablePin(pin: LaneDocumentPin): LaneDocumentPin | Omit<LaneDocumentPin, "text"> { return this.taskWritesStore.storablePin(pin); }
  private numberedTask(data: string, parts?: StoredTaskParts): Task { return this.taskWritesStore.numberedTask(data, parts); }
  private storedBriefVersions(taskId: string): BriefVersion[] { return this.taskWritesStore.storedBriefVersions(taskId); }
  private storedReviews(taskId: string): Pick<Task["resolution"], "review" | "reviews"> { return this.taskWritesStore.storedReviews(taskId); }
  private resolveReviewRows(rows: Array<{ seq: number; data: string }>): Pick<Task["resolution"], "review" | "reviews"> { return this.taskWritesStore.resolveReviewRows(rows); }
  private storedReviewValue(value: unknown): unknown { return this.taskWritesStore.storedReviewValue(value); }
  /**
   * Writes one detached part's entries that differ from `before` and deletes the
   * ones `after` dropped. An ordinary update carries the same objects, so it
   * writes none.
   */
  private syncDetached(table: "task_brief_versions" | "task_reviews", column: "version" | "seq", taskId: string, before: DetachedEntries, after: DetachedEntries) { return this.taskWritesStore.syncDetached(table, column, taskId, before, after); }
  /**
   * The task row as stored: everything but its brief versions and reviews (their own tables),
   * its referenced text and its observation-only
   * fields (`task_observations`). Audit B6: the row is the task's state, not its documents.
   */
  private taskRow(task: Task, before: Task | null = null): string { return this.taskWritesStore.taskRow(task, before); }
  private numberedOutcome(data: string): Outcome { return this.outcomesStore.numberedOutcome(data); }
  /**
   * Bounded bulk reads for the shared telemetry base. Each yielded chunk is one page so a
   * caller can hand the event loop back between pages instead of monopolising it.
   */
  telemetryFactChunks(page = 500): Generator<TelemetryFactChunk> { return this.outcomesStore.telemetryFactChunks(page); }
  telemetryFacts(page = 500) { return this.outcomesStore.telemetryFacts(page); }
  tasks(): Task[] { return this.tasksStore.tasks(); }
  allTasks(): Task[] { return this.tasksStore.allTasks(); }
  integrationTasks(repoPath: string): readonly Task[]{ return this.tasksStore.integrationTasks(repoPath); }
  liveTasks(): Task[] { return this.tasksStore.liveTasks(); }
  laneTaskPage(lane: string, offset: number, limit: number): { tasks: Task[]; total: number; nextOffset: number | null } { return this.tasksStore.laneTaskPage(lane, offset, limit); }
  maintenanceTasks(operationalOnly = false): Task[] { return this.tasksStore.maintenanceTasks(operationalOnly); }
  activeCapacityTasks(): Task[] { return this.tasksStore.activeCapacityTasks(); }
  admissionCandidates(task?: Task): Task[] { return this.tasksStore.admissionCandidates(task); }
  lifecycleTasks(operationalOnly = false): Task[] { return this.tasksStore.lifecycleTasks(operationalOnly); }
  retirementTasks(taskId?: string): Task[] { return this.tasksStore.retirementTasks(taskId); }
  finishedHookTasks(): Task[] { return this.tasksStore.finishedHookTasks(); }
  hostProcessSweepTasks(): Task[] { return this.tasksStore.hostProcessSweepTasks(); }
  originRoutingTasks(operationalOnly = false): Task[] { return this.tasksStore.originRoutingTasks(operationalOnly); }
  originWorkspaces(): Map<string,string> { return this.tasksStore.originWorkspaces(); }
  pendingNotices(): Notice[] {
    return this.db.prepare("SELECT data FROM notices WHERE json_extract(data,'$.status') IN ('pending','intent') ORDER BY rowid")
      .all().map(row=>noticeSchema.parse(JSON.parse(String(row.data))));
  }
  /**
   * Bounded exact identity lookup for bridge lifecycle hints (Contract 007).
   * It matches only Queue identities the service already knows, materializes no
   * fleet history and returns an empty list for an unknown identity, so an
   * unknown event schedules nothing.
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
  /** Cheap durable identity count for service health; no task payloads are parsed. */
  countTasks(): number {
    if (!this.db.isTransaction && this.cachedTaskCount !== null) return this.cachedTaskCount;
    const count=Number(this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE json_extract(data, '$.removedAt') IS NULL").get()!.n);
    if (!this.db.isTransaction) this.cachedTaskCount=count;
    return count;
  }
  uiTasks(): Task[] { return this.tasksStore.uiTasks(); }
  liveSnapshot(input: SnapshotInput = {}): { tasks: ReturnType<typeof compactLiveTask>[]; cursor: string | null; hasMore: boolean } { return this.tasksStore.liveSnapshot(input); }
  task(id: string): Task { return this.tasksStore.task(id); }
  existing(input: Submission): Task | null { return this.submissionsStore.existing(input); }
  taskReference(id:string) { return this.tasksStore.taskReference(id); }
  validateDependencies(input: Submission) { return this.submissionsStore.validateDependencies(input); }
  /**
   * The structural fact behind the pre-dispatch dependency and closeout
   * boundaries: a queued
   * review-entry task bound to its external workspace at intake,
   * with no run of any role ever (released, superseded and cancelled history
   * included), no execution participant and nothing execution-, review- or
   * delivery-shaped recorded. Intake's settled operation and bound workspace
   * are provenance, never dispatch. Every other shape of ambiguity refuses.
   *
   * `enclosing` (task 404) is the one internally authenticated durable
   * invocation executing `move to=closeout`, proved by
   * `verifyEnclosingOperation`: Queue persists that operation before the engine
   * performs it, so it is the admitted control itself, not a competing writer.
   * Nothing else is exempt — a stale, foreign, settled or changed invocation
   * excludes nothing, and the 401 dependency boundary never passes one.
   */
  private reviewEntryUnrun(task: Task, enclosing?: VerifiedEnclosingOperation): boolean {
    const entry = task.reviewEntry;
    if (!entry || task.entrypoint !== "review" || task.phase !== "queued" || task.removedAt) return false;
    // The bound workspace is the external one recorded at intake, and no review
    // admission has dispatched a reader yet (admission records `dispatchBase`).
    if (!task.workspaceId || task.workspaceId !== entry.workspaceId || !task.directory || entry.dispatchBase !== null) return false;
    if (entry.directory && task.directory !== entry.directory) return false;
    // No run of any role ever existed, released or superseded history included.
    if (this.runs(task.id).length) return false;
    // The settled intake operation is the provenance that created this task; a
    // still-running intake or any other unfinished operation is work in flight.
    const intake = this.operation(entry.operationId);
    if (intake && !operationIsSettled(intake.state)) return false;
    if (this.operations({ taskId: task.id, states: ["pending", "running", "needs_attention"] })
      .some(operation => operation.id !== enclosing?.operationId)) return false;
    // No hook delivery is outstanding.
    if (this.hookEvents(task.id).some(hook => !hookStateIsTerminal(hook.state))) return false;
    const resolution = task.resolution;
    // No current or prior execution participant or pending agent intent.
    if (task.agentId || task.runId || task.agentIntent || task.lastAgentStatus || task.workerModel || task.workerModels.length
      || task.retiredWorkers.length || resolution.currentRunId || resolution.reviewerAgentId || resolution.reviewerProfile) return false;
    // No completion, checkpoint, merge intent or accepted review/owner credit.
    // (A source pin and its pending review reason are not credit; each boundary
    // below reads them separately.)
    if (task.completion || task.checkpoints.records.length || task.checkpoints.intent) return false;
    if (resolution.review || resolution.reviews.length || resolution.reviewSupersessions.length
      || resolution.ownerAcceptances.length || resolution.mechanicalVerification) return false;
    if (resolution.mergeIntent || resolution.mergeHead || resolution.mergeBase || resolution.mergeRequestedAt
      || resolution.mergedCommit || resolution.syncedCommit) return false;
    // No unknown delivery or durable side effect.
    if (resolution.workspaceRetirement || resolution.closeoutWorkspaceIntent || resolution.archiveIntentWorkspaceId
      || resolution.workspaceArchiveRetries.length || resolution.runtimeRetirements.length || resolution.buildOutputCleanups.length
      || resolution.finishedHook || resolution.hostProcessSweep || resolution.mergeResponseOutcome === "uncertain") return false;
    // No attention, recovery or recorded work instruction is outstanding.
    if (resolution.incident || resolution.recovery || resolution.recoveryActive || resolution.stalledTurnStop
      || resolution.attention || resolution.deferredVerb || resolution.pendingWorkerInstruction
      || resolution.revisionInstruction || resolution.prePrResumeInstruction) return false;
    return true;
  }
  /**
   * A queued review-entry task binds an existing external workspace at intake,
   * so its `workspaceId` is provenance rather than a dispatch (task 401). The
   * pre-dispatch dependency correction stays available until anything about
   * this task has run, been dispatched or is still pending. A legacy owner-head
   * receipt and its pending review reason remain recorded source decisions, so
   * the dependency boundary still refuses them. Current controls cannot create
   * either; no supplied input overrides proof of no dispatch.
   */
  private reviewEntryBeforeFirstRun(task: Task): boolean {
    if (!this.reviewEntryUnrun(task)) return false;
    const resolution = task.resolution;
    return !(resolution.externalOwnerRevisions?.length || resolution.pendingReviewReason);
  }
  /**
   * The same unrun review-entry fact, read by the owner closeout
   * reconciliation (task 408): a queued review-entry task that never dispatched
   * is the one shape whose own PR may have merged outside Queue before any
   * reviewer existed. The dependency correction and external-merge
   * reconciliation both read `reviewEntryUnrun`, so no second
   * boundary can drift from them. `enclosing` is the authenticated
   * durable invocation executing this control (task 404).
   */
  reviewEntryUnrunBeforeFirstRun(task: Task, enclosing?: VerifiedEnclosingOperation): boolean {
    return this.reviewEntryUnrun(task, enclosing);
  }
  updateDependencies(task: Task, dependsOn: string[], actor = "operator control"): Task {
    const beforeDispatch = task.phase === "queued" && !task.workspaceIntent && !task.agentIntent && !task.workspaceId
      && !task.agentId && !task.completion && !task.resolution.currentRunId;
    if (!beforeDispatch && !this.reviewEntryBeforeFirstRun(task))
      throw new Error("Dependencies can only change before dispatch begins");
    for (const id of dependsOn) {
      if (id === task.id) throw new Error("A task cannot depend on itself");
      let dependency: ReturnType<Store["taskReference"]>;
      try { dependency = this.taskReference(id); } catch { throw new Error(`Prerequisite task does not exist: ${id}. Submit prerequisites first.`); }
      if (dependency.removedAt && dependency.phase !== "done") throw new Error(`Prerequisite was removed before completion: ${dependency.title} (${id})`);
      const pending = [id], visited = new Set<string>();
      while (pending.length) {
        const candidate = pending.pop()!;
        if (candidate === task.id) throw new Error(`Dependency change would create a cycle through ${id}`);
        if (visited.has(candidate)) continue;
        visited.add(candidate);
        try { pending.push(...this.task(candidate).dependsOn); } catch { /* Purged completed history cannot point back to this live task. */ }
      }
    }
    const normalized = [...dependsOn].sort();
    if (JSON.stringify(normalized) === JSON.stringify(task.dependsOn)) return task;
    const reason = this.dependencyWait({ dependsOn: normalized }) || DISPATCH_WAIT_REASON;
    return this.update(task.id, { dependsOn: normalized, reason }, "dependencies_changed", `${task.dependsOn.join(", ") || "none"} → ${normalized.join(", ") || "none"}; requested by ${actor}`, task.version);
  }
  setPrerequisiteWait(task: Task, waitsFor: string[], reason: string, expectedVersion = task.version): Task {
    if (task.version !== expectedVersion) throw new Error("Task changed; refresh before setting a prerequisite wait");
    if (["queued", "dispatching", "merging", "syncing", "closing", "done", "cancelled"].includes(task.phase))
      throw new Error("Prerequisite waits require a dispatched, unmerged task before merge intent");
    if (task.resolution.mergeIntent || task.resolution.mergedCommit)
      throw new Error("Prerequisite waits cannot be changed after merge intent or merge");
    const dispatched = Boolean(task.agentId || task.runId || task.completion || task.prUrl || task.prHead
      || task.resumePrNumber || task.resolution.currentRunId);
    if (!dispatched) throw new Error("Prerequisite waits require a dispatched task");
    const normalized = [...waitsFor].sort();
    for (const id of normalized) {
      if (id === task.id) throw new Error("A task cannot wait for itself");
      let prerequisite: ReturnType<Store["taskReference"]>;
      try { prerequisite = this.taskReference(id); }
      catch { throw new Error(`Prerequisite task does not exist: ${id}`); }
      if (prerequisite.removedAt && prerequisite.phase !== "done")
        throw new Error(`Prerequisite was removed before completion: ${prerequisite.title} (${id})`);
    }
    if (!normalized.length) {
      if (!task.prerequisiteWait) return task;
      return this.update(task.id, { prerequisiteWait: null }, "prerequisite_wait_cleared",
        `${task.prerequisiteWait.waitsFor.join(", ")}; requested by ${reason}`, expectedVersion);
    }
    if (!task.prerequisiteWait?.releasedAt && task.prerequisiteWait?.reason === reason && JSON.stringify(task.prerequisiteWait.waitsFor) === JSON.stringify(normalized))
      return task;
    const wait = { id: randomUUID(), waitsFor: normalized, reason: reason.trim(), releasedAt: null };
    return this.update(task.id, { prerequisiteWait: wait }, "prerequisite_wait_set",
      `${normalized.join(", ")}; ${reason.trim()}`, expectedVersion);
  }
  /** Release one retained prerequisite wait and create its owner notice atomically. */
  reconcilePrerequisiteWait(taskId: string): "none" | "waiting" | "released" {
    return this.transaction(() => {
      const task = this.task(taskId), wait = task.prerequisiteWait;
      if (!wait || wait.releasedAt) return "none";
      if (this.dependencyWait({ dependsOn: wait.waitsFor })) return "waiting";
      const id = `prerequisite-wait:${wait.id}`;
      if (!this.notices(task.id).some(notice => notice.id === id)) {
        const owner = taskOwner(task);
        this.putNotice({ id, taskId: task.id, agentId: owner, recipientAgentId: owner,
          workspaceId: task.originWorkspaceId, sources: [], originEntry: true, kind: "prerequisite",
          status: "pending", error: "",
          text: `Nucleus prerequisite wait cleared\nTask: ${task.title} (${task.id})\nReason: ${wait.reason}\nPrerequisites complete: ${wait.waitsFor.join(", ")}\nThe task is back in normal handling. Nucleus will not revise it automatically.`,
        });
      }
      // The release is the producer's clear: its prerequisite stop goes with it.
      const stop = task.resolution.stop?.reason === "prerequisite" ? { resolution: { ...task.resolution, stop: null } } : {};
      this.update(task.id, { prerequisiteWait: { ...wait, releasedAt: now() }, ...stop }, "prerequisite_wait_released",
        JSON.stringify({ waitId: wait.id, waitsFor: wait.waitsFor, reason: wait.reason }));
      return "released";
    });
  }
  promoteQueuedTask(task:Task,actor="operator control"):Task { return this.submissionsStore.promoteQueuedTask(task, actor); }
  dependencyWait(task: Pick<Task,"dependsOn">): string { return this.tasksStore.dependencyWait(task); }
  insert(input: Submission, hostId: string, handoffText: string, planningBase: string, initial: Partial<Task> = {}, credential?: {runId:string;token:string;prepare?:(task:Task)=>void}, origin?: string | null): Task {
    const insert = () => {
      this.tasksStore.syncProjectionForWrite();
      if (input.proofOnly && !input.proofExecution) throw new Error('queue.proofOnly requires queue.proofExecution');
      if (input.requiresOperatorGo && !input.proofOnly) throw new Error('queue.requiresOperatorGo is only valid with queue.proofOnly');
      const existing = this.existing(input); if (existing) return existing;
      this.validateDependencies(input);
      // Every task row is created here, so no intake path can create a staged task (Spec 043);
      // a replay of an existing historical submission still returns its task above.
      if (input.brief && stageDeclarationFromBrief(input.brief.text)) throw new Error(STEPS_RETIRED_REASON);
      // Spec 058: a responsible task merges on reviewer approval plus Queue's
      // mechanical gates. The manual evidence-only oracle is a verification
      // coordinator, so it cannot select a different lifecycle.
      if (input.manualVerification === true)
        throw new Error('queue.manualVerification is no longer available; every task runs the responsible lifecycle');
      // Spec 058 cutover 2: a brief states its outcome and acceptance in prose;
      // the structured verdict opt-in and pass gate are retired. The optional
      // persisted fields stay readable for stored rows.
      if (input.reviewVerdicts !== undefined || input.reviewPassGate !== undefined)
        throw new Error('reviewVerdicts and reviewPassGate are no longer available; state the outcome and acceptance in prose in the brief, and use mergeHold for a needed hold');
      // Every new task runs the responsible lifecycle.
      const responsible = input.responsible ?? true;
      // Task 1109: a task's planner is a thread that answers its planning questions;
      // the operator answers no delegated question, so a named planner cannot be it.
      if (input.plannerAgentId && isOperatorOrigin(input.plannerAgentId))
        throw new Error('The operator is not a thread; name a planner thread or leave the task to its owner');
      const thinkingConflict = workerThinkingConflict(input.thinkingOptionId, input.profileRequests?.worker);
      if (thinkingConflict) throw new Error(thinkingConflict);
      const id = randomUUID();
      if (initial.hostSelection && initial.hostSelection.hostId !== hostId) throw new Error('Task host selection does not match host');
      const pinnedAt = now();
      const briefVersions = initialBriefVersion(input, pinnedAt);
      const attached = input.lanes.length ? this.requireAttachableLanes(input.lanes, input.repoPath, origin) : [];
      if (input.laneDocuments?.length) this.requireLaneDocuments(input.laneDocuments, input.repoPath, origin);
      const repository = repositoryIdentity(input.repoPath, origin);
      this.ensureProject(input.repoPath, normalizeRepositoryOrigin(origin ?? repository));
      const assigned = this.assignNumber(id, repository);
      const task: Task = { ...input, critical: input.critical ?? false, ...(responsible === undefined ? {} : { responsible }), repository, ...assigned, brief: input.brief ? { ...input.brief, digest: briefVersions[0].digest } : null, id, createdAt: now(), updatedAt: now(), version: 1,
        papercutTask: input.planningSource?.kind === "papercut",
        entrypoint:input.proofOnly?"proof":"worker",reviewEntry:null,originWorkspaceId:null,notificationAgentId:isOperatorOrigin(input.originAgentId)?null:input.originAgentId,originError:"",originLookupError:"",
        creatorCompletionRecipients:[],completionSubscriptionOverrides:[],completionNotificationCohort:null,
        removedAt: null, finishedAt: null, queuePriority:0, prerequisiteWait: null, phase: "queued", reason: DISPATCH_WAIT_REASON,
        held: false, mergeHold: false, budgetSince: null, holdOwner: null, holdReason: null, holdAt: null, holdGeneration: 0, holdBlocking: null, holdUntil: null, holds: {},
        lastSubstantiveVersion: 1, handoffText, planningBase, proofExecutions: [], proofFiles: [], proofExecutionRetired: false, proofOnlyResult: null, proofReceiptAcceptance: null,
        workspaceId: null, directory: null, branch: input.proofOnly ? "" : `ns-${id}`, agentId: null, runId: null,
        profile: null, profileGroup: null, failoverReason: "", replacementProfile:null, workerExclusions: [], resumePrNumber: null, retiredWorkers: [], workspaceIntent: false, agentIntent: false, lastAgentStatus: null,
        idleSince: null, completion: null, agentActive: null, lastObservedAt: null, prUrl: null, prHead: null, coordinatorGeneration: 1, resolution: resolutionSchema.parse({}), checkpoints: { records: [], intent: null }, workerModel: null, workerModels: [], briefVersions, briefRuns: [], siblingPins: [], siblingFindings: [], siblingIntent: false, checkoutSiblingFindings: [], stashBaseline: null,
        ...laneSnapshot(attached), ...initial, hostId,
        ...(hostId ? { hostSelection: initial.hostSelection ?? { hostId, basis: input.hostId === hostId ? 'explicit' : 'sole_online_host' } } : {}),
        originHostId: Object.prototype.hasOwnProperty.call(initial, "originHostId") ? initial.originHostId : hostId || undefined,
        disposition: initial.disposition ?? null, prLookup: initial.prLookup ?? null };
      // Spec 050: the `ownerRoute` marker is route-only. A submission never
      // carries it, so strip it here rather than trusting the input record.
      // Spec 052: Queue writes `signoff`, never a submission; the request is the origin's.
      for (const role of ["worker", "reviewer", "coordinator"] as const) {
        if (task.profileRequests?.[role])
          task.profileRequests = { ...task.profileRequests, [role]: { ...plainProfileRequest(task.profileRequests[role]!), requestedBy: input.originAgentId } };
      }
      const composedHolds: TaskHolds = { ...(initial.holds ?? {}) };
      if (input.mergeHold === true && !composedHolds.merge) {
        composedHolds.merge = { owner: TASK_OWNER_HOLD, reason: input.mergeHoldReason ?? "not recorded", at: now(), generation: 1, until: null };
      }
      Object.assign(task, syncHoldProjection(composedHolds));
      if(credential){credential.prepare?.(task);this.setCredential(credential.runId,credential.token);}
      const validated = this.tasksStore.validatedTask(task);
      this.db.prepare("INSERT INTO tasks VALUES(?,?,?,?)").run(id, input.submissionId, submissionHash(input), this.taskRow(task));
      if (this.tasksStore.taskProjection) {
        this.tasksStore.setProjectedTask(validated);
      this.tasksStore.integrationTaskIndex = null;
        this.tasksStore.taskProjectionOrder.unshift(id);
      }
      this.cachedTaskCount=null; this.advanceRevision();
      this.event(id, "submitted", `Origin: ${input.originAgentId}; planning ${input.planningCommit}; PR review: ${input.skipPRReview ? "skipped by submission" : "required"}${briefVersions.length ? `; Queue-held brief v1 ${briefVersions[0].digest}` : ""}${attached.length ? `; lanes ${attached.map(lane => lane.key).join(", ")}` : ""}`);
      this.event(id, "telemetry_stage", telemetryStageForTask(task)); return task;
    };
    return this.db.isTransaction ? insert() : this.transaction(insert);
  }
  update(id: string, change: Partial<Task> & { attention?: never }, kind?: string, detail = "", expected?: number): Task {
    if (!this.db.isTransaction) return this.transaction(() => this.update(id, change, kind, detail, expected));
    this.tasksStore.syncProjectionForWrite();
    const task = this.task(id);
    if (expected !== undefined && task.version !== expected) throw new Error("Task changed; refresh before retrying");
    if (change.hostId !== undefined && change.hostId !== task.hostId)
      throw new Error("Task host cannot be changed by an update");
    if (change.hostSelection !== undefined && JSON.stringify(change.hostSelection) !== JSON.stringify(task.hostSelection))
      throw new Error("Task host selection cannot be changed by an update");
    // The existing row already carries this immutable field. Remove even an
    // explicitly undefined key so observation-only writes remain observations.
    const { hostSelection: _selection, ...remainingChange } = change;
    change = remainingChange;
    if (change.originHostId !== undefined && change.originHostId !== task.originHostId && kind !== 'owner_changed')
      throw new Error("Origin host cannot be changed by an ordinary update");
    const lifecycleChanged = change.reason !== undefined && change.reason !== task.reason
      || change.phase !== undefined && change.phase !== task.phase;
    const hasExplicitStop = change.resolution !== undefined && Object.prototype.hasOwnProperty.call(change.resolution, "stop");
    const stopRepeatsCurrent = hasExplicitStop
      && JSON.stringify(change.resolution!.stop) === JSON.stringify(task.resolution.stop);
    if (lifecycleChanged && (!hasExplicitStop || stopRepeatsCurrent)) {
      change = { ...change, resolution: { ...task.resolution, ...(change.resolution ?? {}), stop: null } };
    }
    const terminal = ['done', 'cancelled'].includes(change.phase ?? task.phase);
    const finishedAt=change.phase && change.phase!==task.phase ? terminal ? now() : null : task.finishedAt;
    const observationFields = new Set<string>(STORED_OBSERVATION_FIELDS);
    const observationStateFields = new Set<string>(["agentActive", "lastAgentStatus", "idleSince"]);
    const changedFields = Object.keys(change);
    const observationOnly = changedFields.length > 0 && changedFields.every(field => observationFields.has(field));
    const observationStateChanged = observationOnly && changedFields.some(field => observationStateFields.has(field) && !Object.is(task[field as keyof Task], change[field as keyof Task]));
    const bumpVersion = !observationOnly || observationStateChanged;
    let next = { ...task, ...change, ...(terminal ? { queuePriority: 0 } : {}), finishedAt, id: task.id,
      originAgentId: task.originAgentId, notifyOriginOnCloseout: task.notifyOriginOnCloseout,
      completionNotificationAgentIds: task.completionNotificationAgentIds,
      creatorCompletionRecipients: task.creatorCompletionRecipients,
      version: task.version + (bumpVersion ? 1 : 0),
      lastSubstantiveVersion: observationOnly ? task.lastSubstantiveVersion ?? task.version : task.version + 1,
      updatedAt: now() };
    // Audit B6: an observation that changes no board fact writes only `task_observations`.
    // The task row, its version, its substantive-version marker and the board revision all
    // stay where they were, and every reader still sees the values the parent write produced:
    // the moved observation time, the moved write time and the same hold projection.
    if (observationOnly && !observationStateChanged) {
      // The substantive-version marker stays exactly as the row holds it, so the row this
      // write does not touch and the projected copy a reader gets stay the same record.
      const observed = { ...next, lastSubstantiveVersion: task.lastSubstantiveVersion };
      const validated = this.tasksStore.validatedTask(observed);
      this.syncTaskObservation(id, observed);
      if (this.tasksStore.taskProjection) {
        this.tasksStore.setProjectedTask(validated);
      this.tasksStore.integrationTaskIndex = null;
        // The observation row write advanced the projection's `writes` clock. The maps
        // already hold this write, so acknowledge that clock here — after they are
        // consistent and before any synchronous observer below reads the task. An
        // unacknowledged clock makes that read discard the warm projection and re-parse
        // every task row, which is the audit's observation hot path. This is the same
        // ordering as this funnel's substantive branch and `putRun()`.
        this.tasksStore.projectionClock = this.tasksStore.readProjectionClock();
      }
      const previousStage = telemetryStageForTask(task), observedStage = telemetryStageForTask(observed);
      const hasStage = Boolean(this.db.prepare("SELECT 1 FROM events WHERE taskId=? AND kind='telemetry_stage' LIMIT 1").get(id));
      if (!hasStage || previousStage !== observedStage) this.event(id, "telemetry_stage", observedStage);
      this.tasksStore.projectionClock = this.tasksStore.readProjectionClock();
      this.taskChanged(id); return observed;
    }
    if (change.holds) Object.assign(next, syncHoldProjection(change.holds));
    else if (change.held === false && change.holds === undefined) Object.assign(next, syncHoldProjection({}));
    else if (change.holds === undefined) {
      const fences: TaskHolds = { ...(next.holds ?? {}) };
      const primary = fences.merge ? "merge" as const : fences.dispatch ? "dispatch" as const : null;
      const holdFieldChanged = change.holdUntil !== undefined || change.holdOwner !== undefined || change.holdReason !== undefined
        || change.holdAt !== undefined || change.holdGeneration !== undefined || change.holdBlocking !== undefined;
      if (primary && holdFieldChanged) {
        const fence = fences[primary]!;
        fences[primary] = {
          ...fence,
          ...(change.holdUntil !== undefined ? { until: change.holdUntil } : {}),
          ...(change.holdOwner ? { owner: change.holdOwner } : {}),
          ...(change.holdReason ? { reason: change.holdReason } : {}),
          ...(change.holdAt ? { at: change.holdAt } : {}),
          ...(change.holdGeneration !== undefined ? { generation: change.holdGeneration } : {}),
        };
        if (change.holdBlocking !== undefined && fences.merge)
          fences.merge = { ...fences.merge, blocking: change.holdBlocking };
        Object.assign(next, syncHoldProjection(fences));
      }
    }
    // A hold's stop belongs to its fences: the write that removes the last one
    // retires it, so the read is true at once, paused or terminal, rather than
    // after the next quantum. A queued task's hold text goes with it.
    // Likewise a stop recorded from Queue's origin error goes when that error clears.
    if (task.originError && !next.originError && next.resolution.stop?.detail === task.originError)
      next = { ...next, resolution: { ...next.resolution, stop: null } };
    const fenced = (fields: Task) => { const holds = holdsOf(fields); return Boolean(holds.dispatch || holds.merge); };
    if (fenced(task) && !fenced(next)) {
      if (next.resolution.stop?.reason === "held") next = { ...next, resolution: { ...next.resolution, stop: null } };
      if (next.phase === "queued" && change.reason === undefined && taskStopClassification(next.reason).reason === "held")
        next = { ...next, reason: this.dependencyWait(next) || DISPATCH_WAIT_REASON };
    }
    const freezesCompletion = change.phase === "done" && task.phase !== "done";
    if (freezesCompletion) {
      // The membership a done transition freezes is one derived fact (shared with
      // the recovery preflight and the completion receipt), never restated here.
      const cohort=completionMembership(task);
      next={...next,completionNotificationCohort:cohort};
      const completedAt=finishedAt??now();
      for(const member of cohort){
        const notice:Notice={id:digest(`${task.id}:completion:${member.agentId}`),taskId:task.id,agentId:member.agentId,recipientAgentId:member.agentId,
          workspaceId:member.workspaceId,sources:member.sources,originEntry:member.originEntry,kind:"completion",status:"pending",error:"",
          text:`Nucleus completion\nTask: ${task.title} (${task.id})\nRepository: ${task.repoPath}\nState: done\nCompleted: ${completedAt}\nPR: ${next.prUrl??"none"}${next.reportAcceptance ? `\n${next.reportAcceptance.artifact ? `Owner accepted report: ${next.reportAcceptance.artifact.key} v${next.reportAcceptance.artifact.version} (${next.reportAcceptance.artifact.digest})` : "Owner completed this task with no PR"}\nAccepted by: ${next.reportAcceptance.acceptedBy}\nReason: ${next.reportAcceptance.reason}` : ""}\nInspect queue detail for full state. Completion membership grants no task authority.`};
        if(!this.notices(task.id).some(existing=>existing.id===notice.id))this.putNotice(notice);
      }
    }
    const previousTelemetryStage = telemetryStageForTask(task), nextTelemetryStage = telemetryStageForTask(next);
    const hasTelemetry = Boolean(this.db.prepare("SELECT 1 FROM events WHERE taskId=? AND kind='telemetry_stage' LIMIT 1").get(id));
    const validated = this.tasksStore.validatedTask(next);
    this.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(this.taskRow(next, task), id);
    // Terminal cleanup takes every leaf this task's threads were launched with,
    // once, on the transition; a live task's retained threads keep theirs (task
    // 681). The task row's own leaf goes when its worker run identity changes.
    if ((terminal && task.phase !== next.phase) || (!task.removedAt && Boolean(next.removedAt)))
      for (const run of this.runs(id)) if (run.temporaryDirectory) this.pendingRunScratchCleanup.add(run.temporaryDirectory);
    if (task.temporaryDirectory && task.runId && (task.runId !== next.runId || terminal))
      this.pendingRunScratchCleanup.add(task.temporaryDirectory);
    if (this.tasksStore.taskProjection) {
      this.tasksStore.setProjectedTask(validated);
      this.tasksStore.integrationTaskIndex = null;
      // A removed task keeps its run rows but leaves every retained-task list.
      if ((task.removedAt == null) !== (next.removedAt == null)) this.tasksStore.refreshPendingRunsForTask(id, next.removedAt != null);
      // Synchronous observers may read before advanceRevision below. The maps
      // already include this write; acknowledge its trigger clock before those
      // reads so they do not discard the completed incremental update.
      this.tasksStore.projectionClock = this.tasksStore.readProjectionClock();
    }
    if (!hasTelemetry || previousTelemetryStage !== nextTelemetryStage) this.event(id, "telemetry_stage", nextTelemetryStage);
    if (task.removedAt !== next.removedAt) this.cachedTaskCount=null;
    if (kind) this.event(id, kind, detail);
    const becameTerminal = Boolean(terminal && task.phase !== next.phase);
    const becameRemovedFinished = !task.removedAt && Boolean(next.removedAt) && ["done", "cancelled"].includes(next.phase);
    if (becameTerminal || becameRemovedFinished) this.putOutcome(buildOutcomeRecord(next, this.runs(id), this.hookEvents(id), false));
    if (next.phase === "done" && next.prUrl && next.resolution.mergedCommit) {
      const linked = this.db.prepare(`SELECT data FROM lead_read AS leads WHERE state='promoted'
        AND EXISTS (SELECT 1 FROM json_each(leads.data,'$.targets')
          WHERE json_extract(value,'$.kind')='task' AND json_extract(value,'$.reference')=?)`).all(id);
      for (const row of linked) {
        const lead = leadSchema.parse(JSON.parse(String(row.data)));
        if (!lead.tags.includes("papercut") || !lead.papercut) continue;
        const cut = papercutFromLead(lead);
        if (cut.taskId !== id) continue;
        const closedAt = next.finishedAt ?? next.updatedAt;
        this.updateLead({ ...lead, state: "closed", closedAt, updatedAt: next.updatedAt,
          closure: { reason: "completed", at: closedAt,
            note: `Completed by ${next.prUrl}; merge commit ${next.resolution.mergedCommit}.` } });
        this.event(id, "papercut_completed", cut.id);
      }
    }
    // Every other write is a board fact, observation state included: a status change
    // still spends a version so a hold or control holding the old one sees it as stale.
    this.advanceRevision();
    this.taskChanged(id); return next;
  }
  /**
   * Durable runtime-retirement records are a Queue-owned side effect, not a
   * versioned operator control: write them without advancing the task's
   * optimistic version, so an archive's `allowed` fence that compares the
   * version stays valid. The board still revision-refreshes.
   */
  setRuntimeRetirements(id: string, records: RuntimeRetirement[]) {
    return this.transaction(() => {
      this.tasksStore.syncProjectionForWrite();
      const task = this.task(id);
      const resolution = { ...task.resolution, runtimeRetirements: records, cleanupReason: runtimeRetirementFailure({ resolution: { ...task.resolution, runtimeRetirements: records } }) };
      const next = { ...task, resolution, updatedAt: now() };
      const validated = this.tasksStore.validatedTask(next);
      this.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(this.taskRow(next, task), id);
      if (this.tasksStore.taskProjection) { this.tasksStore.setProjectedTask(validated); this.tasksStore.integrationTaskIndex = null; }
      this.advanceRevision(); this.taskChanged(id); return next;
    });
  }
  taskOrNull(id: string): Task | null { return this.tasksStore.taskOrNull(id); }
  purgeOldTasks(at=Date.now(),cleanupFiles?:(taskId:string,runIds:string[])=>void) { return this.maintenanceStore.purgeOldTasks(at, cleanupFiles); }
  /**
   * Audits B5: the tasks the next purge would delete, so the caller can reap their owned
   * hook checkouts first. This is the same retention fact the purge re-checks inside its
   * transaction; a task that changes in between simply keeps its history for one more pass.
   */
  retentionCandidates(at=Date.now()): Task[] { return this.maintenanceStore.retentionCandidates(at); }
  /** Shared settled-history rule; purge additionally waits for hook cleanup, which candidates feed. */
  private retentionEligible(task: Task, runs: Run[], cutoff: number): boolean { return this.maintenanceStore.retentionEligible(task, runs, cutoff); }
  /**
   * Round 4: one applied or refused task control, for telemetry only. Owner
   * controls are recorded by the control path, coordinator actions once when
   * their report settles. A `key` (the durable operation, or the coordinator
   * report) records an outcome at most once, so a replay never counts twice.
   * Outcomes never touch the task's history, so they live outside `events`;
   * rows older than 30 days are pruned on write.
   */
  recordVerbOutcome(taskId: string, action: string, outcome: VerbOutcome["outcome"], source: VerbOutcome["source"], detail: Record<string, unknown>, key: string | null = null): void { return this.outcomesStore.recordVerbOutcome(taskId, action, outcome, source, detail, key); }

  /** Task control outcomes since `since` (ISO time), oldest first. */
  verbOutcomes(since: string): VerbOutcome[] { return this.outcomesStore.verbOutcomes(since); }
  event(taskId: string, kind: string, detail: string) { return this.core.event(taskId, kind, detail); }
  private eventWritten(taskId: string, at: string) {
    if (this.lastEventAtByTask) {
      if (at > (this.lastEventAtByTask.get(taskId) ?? "")) this.lastEventAtByTask.set(taskId, at);
      this.eventTimesClock = this.readClock("eventRows");
    }
    const queued = this.tasksStore.taskProjection?.get(taskId);
    if (queued && this.tasksStore.queuedLaneStatsValid) this.tasksStore.indexQueuedLanes(queued);
  }
  /** Move an existing event's clock forward. Used to extend a callback reminder while validation is still running. */
  touchEvent(id: number) {
    const row = this.db.prepare("SELECT taskId FROM events WHERE id=?").get(id) as { taskId: string } | undefined;
    if (!row) return;
    const at = now();
    this.db.prepare("UPDATE events SET at=? WHERE id=?").run(at, id);
    if (this.lastEventAtByTask) {
      if (at > (this.lastEventAtByTask.get(row.taskId) ?? "")) this.lastEventAtByTask.set(row.taskId, at);
      this.eventTimesClock = this.readClock("eventRows");
    }
    const queued = this.tasksStore.taskProjection?.get(row.taskId);
    if (queued && this.tasksStore.queuedLaneStatsValid) this.tasksStore.indexQueuedLanes(queued);
    this.advanceTelemetryRevision(); this.taskChanged(row.taskId);
  }
  events(taskId: string) { return this.db.prepare("SELECT * FROM events WHERE taskId=? ORDER BY id DESC LIMIT 100").all(taskId) as { id: number; taskId: string; at: string; kind: string; detail: string }[]; }
  eventsAll(taskId: string) { return this.db.prepare("SELECT * FROM events WHERE taskId=? ORDER BY id").all(taskId) as { id: number; taskId: string; at: string; kind: string; detail: string }[]; }
  /** Task 1002: rewrite the stored pool without retired fields; a no-op once clean. */
  private stripRetiredPoolFields(): void { return this.maintenanceStore.stripRetiredPoolFields(); }
  /**
   * Schema 54 (task 989): stored rows lose their retired fields and the store loses the
   * `workspace_creation_step_*` events, which nothing reads. Runs on every open, idempotently:
   * the one-time backlog (outcomes still carrying `routing.capability`, tasks carrying the
   * retired defaults, runs and QA runs carrying the write-only fields) and any row a
   * rolled-back older build wrote during its window are one rule set. A clean store is
   * scanned and left byte-identical. The old reader functions went with the step: the
   * outcome `routing.capability` → `scope` rewrite above is the last legacy reader.
   */
  private stripRetiredRowFields(): void { return this.maintenanceStore.stripRetiredRowFields(); }
  pool(): PoolEntry[] { return this.configStore.pool(); }
  /**
   * Nucleus-owned profile records (Tom, 2026-11-07). The host's own profile list
   * was copied once into these records. Selection uses this stored list and
   * availability from the host catalog (Spec 052).
   */
  profiles(): NucleusProfile[] { return this.configStore.profiles(); }
  setProfiles(profiles: readonly NucleusProfile[]) { return this.configStore.setProfiles(profiles); }
  /** The durable record that the one-time host-profile import ran. */
  profileImportRecord(): ProfileImportRecord | null { return this.configStore.profileImportRecord(); }
  recordProfileImport(record: ProfileImportRecord) { return this.configStore.recordProfileImport(record); }
  /** Each host's provider key to the normalised key a profile names; identity when absent. */
  counts(): Record<string, number> { return this.configStore.counts(); }
  recentCounts(limit=50):Record<string,number>{ return this.configStore.recentCounts(limit); }
  chargeAssignment(group:string,profileId:string){ return this.configStore.chargeAssignment(group, profileId); }
  nextIntegrationSequence(repoPath: string) { return this.configStore.nextIntegrationSequence(repoPath); }
  /** A re-issued credential (restart, continuation, recovery) replaces the hash and lifts any revocation. */
  setCredential(run: string, token: string) { return this.authStore.setCredential(run, token); }
  deleteCredential(run: string): void { return this.authStore.deleteCredential(run); }
  /** Store already-encoded availability without changing the caller's cooldown semantics. */
  setAvailability(group: string, data: string): void { return this.authStore.setAvailability(group, data); }
  deleteAvailability(group: string): boolean { return this.authStore.deleteAvailability(group); }
  /** Completion writes preserve any report intent/response already attached to the same receipt. */
  setCompletionReceipt(id: string, task: string, run: string, hash: string, response: string): void { return this.authStore.setCompletionReceipt(id, task, run, hash, response); }
  setReportIntent(id: string, task: string, run: string, hash: string): void { return this.authStore.setReportIntent(id, task, run, hash); }
  setReportResponse(id: string, hash: string, response: unknown): void { return this.authStore.setReportResponse(id, hash, response); }
  authenticate(run: string, token: string) { return this.authStore.authenticate(run, token); }
  credentialRunForToken(token: string): string | null { return this.authStore.credentialRunForToken(token); }
  runs(taskId?: string): Run[] { return this.tasksStore.runs(taskId); }
  /**
   * Unreleased runs of one agent on tasks that are not removed: the same rows as
   * `runs().filter(r => r.agentId === agentId && !r.released)`, without loading and
   * parsing every run. Thread archival asked that per released run on every pass and
   * stalled the runtime thread for up to 14 s on 7,134 runs (2026-10-03).
   */
  /**
   * Retention (Tom, 2026-10-16; 4 days since 2026-10-20): a settled host run's journal,
   * its internal CPU reason (meta `hostRunCpuCoverage:<runId>`) and its internal
   * admission identity (meta `hostRunIdentity:<runId>`) are kept
   * `HISTORY_RETENTION_MS`. Journal fact rows (`nested`, `override`,
   * `container_report`) stay regardless, because endpoint reconciliation and
   * container-report dedupe look them up by fact id. Bounded batches, yielding between
   * them so request handling interleaves.
   *
   */
  pruneRetainedHistory(cutoff = new Date(Date.now() - HISTORY_RETENTION_MS).toISOString(), batch = 2000): Promise<{ journal: number }> { return this.maintenanceStore.pruneRetainedHistory(cutoff, batch); }
  /**
   * Lean store 2 (task 987): the retention windows for rows that outlive their task, run or
   * request. The caller owns the transaction (the schema-52 migration and the daily sweep both
   * run it inside one), and every rule is idempotent, so the one-time backlog and the steady
   * state are one rule set. Each rule names what it keeps:
   *
   * - finished (succeeded or failed) operations whose task is gone, 30 days after they settled;
   *   pending, running and needs-attention operations always stay;
   * - per-task meta (`checkPolicyObservation:<task>`) whose task is gone;
   * - settled (delivered or superseded) project and lane notices and project and lane events,
   *   30 days after they were made (a notice's time is the ISO stamp its id ends with);
   * - QA schedule merges only for repositories that have a schedule, so the backlog of an
   *   unscheduled repository is deleted and never refused by the 1,000-row guard;
   * - the latest 50 settled host runs per selector, except a run whose accounting retirement is
   *   still inside the history retention; a pruned run takes its identity, CPU and disposition
   *   sidecars and its retained-output failure with it;
   * - the latest 50 QA runs per repository, except active runs, the run a status row names, and
   *   the latest passing main run of each repository (the schedule's green reading);
   * - the assignment history the profile picker reads.
   */
  pruneRetainedRows(at: number): RetainedRowPrune { return this.maintenanceStore.pruneRetainedRows(at); }
  /** Subscription group availability rows as stored. */
  availability(): Array<z.infer<typeof availabilitySchema>> { return this.authStore.availability(); }
  /** Spec 052 diagnostics: the usage policy for the profiles this task's routing names, from fresh usage. */
  routingPolicy(task: Task, at = Date.now(), profiles: readonly Profile[] = []): RoutingPolicy { return this.configStore.routingPolicy(task, at, profiles); }
  prerequisiteReleaseRefreshed(taskId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM events WHERE taskId=? AND kind='prerequisite_release_refreshed' LIMIT 1").get(taskId));
  }
  /** Spec 053: the host-wide role offsets, defaulting to worker 0, reviewer 0, coordinator −2. */
  demandRoleOffsets(): DemandRoleOffsets { return this.configStore.demandRoleOffsets(); }
  /** Spec 052: the stored usage setting, if the operator set one. */
  usageSetting(): UsageSetting | null { return this.configStore.usageSetting(); }
  /** The usage level in force: the stored level until its `until` passes, else `normal`. */
  usageLevel(at = Date.now()): UsageLevel { return this.configStore.usageLevel(at); }
  usageView(at = Date.now()): UsageView { return this.configStore.usageView(at); }
  /** Spec 052 planner grants stored in meta, like usage. */
  routingGrants(): RoutingGrant[] { return this.configStore.routingGrants(); }
  /**
   * Same mapping OwnerStop.stopTask uses: reviewer stays reviewer, revision is
   * worker, recovery/verification/closeout/executor are the coordinator route.
   */
  private routeRoleForRun(role: Run["role"]): "worker" | "reviewer" | "coordinator" {
    return role === "reviewer" ? "reviewer" : role === "revision" ? "worker" : "coordinator";
  }
  noteGrantRun(task: Task, role: "worker" | "reviewer" | "coordinator"): void { return this.configStore.noteGrantRun(task, role); }
  qaFenceRecord(): QaFenceRecord { return this.hostRunStore.qaFenceRecord(); }
  qaFenceInForce(at = Date.now()): QaFence | null { return this.hostRunStore.qaFenceInForce(at); }
  qaFenceView(at = Date.now()): QaFenceView { return this.hostRunStore.qaFenceView(at); }
  writeQaFence(record: QaFenceRecord): void { return this.hostRunStore.writeQaFence(record); }
  qaUnsettledInventory(): QaInventoryItem[] { return this.hostRunStore.qaUnsettledInventory(); }
  /** Whether a run of another unremoved task names this workspace: one query, not a per-task run read. */
  workspaceUsedByOtherTaskRun(taskId: string, workspaceId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM runs JOIN tasks ON tasks.id=runs.taskId
      WHERE runs.taskId<>? AND json_extract(runs.data,'$.workspaceId')=? AND json_extract(tasks.data,'$.removedAt') IS NULL LIMIT 1`).get(taskId, workspaceId));
  }
  unreleasedRunsForAgent(agentId: string, hostId?: string | null): Run[] {
    return this.db.prepare(`SELECT runs.data FROM runs JOIN tasks ON tasks.id=runs.taskId
      WHERE json_extract(tasks.data,'$.removedAt') IS NULL
        AND json_extract(runs.data,'$.agentId')=?
        AND COALESCE(json_extract(runs.data,'$.released'),0)=0
      ORDER BY runs.rowid`).all(agentId).map(row => JSON.parse(String(row.data)) as Run)
      // Unknown provenance cannot prove independence, so it remains a conflict.
      .filter(run => !hostId || !run.hostId || run.hostId === hostId);
  }
  /**
   * Spec 058 slice 1: persist one run's observed usage. Writes only that field and never
   * restamps the run's dispatch-time pins; a no-op write touches nothing.
   */
  updateRunUsage(runId: string, apply: (usage: NonNullable<Run["usage"]>) => NonNullable<Run["usage"]>): boolean {
    const run = this.run(runId);
    if (!run) return false;
    const next = apply(run.usage ?? EMPTY_RUN_USAGE);
    if (JSON.stringify(next) === JSON.stringify(run.usage ?? null)) return false;
    this.putRun({ ...run, usage: next }, { usageOnly: true });
    return true;
  }
  pendingRuns(): Run[] { return this.tasksStore.pendingRuns(); }
  runsForTasks(taskIds: string[]): Run[] { return this.tasksStore.runsForTasks(taskIds); }
  run(id: string): Run | null { return this.tasksStore.run(id); }
  /** Collect host-qualified identities still represented by a retained task or run. */
  private retainedArchiveKeys(): Set<string> { return this.maintenanceStore.retainedArchiveKeys(); }
  private pruneThreadArchiveKeys(): void { return this.maintenanceStore.pruneThreadArchiveKeys(); }
  private migrateRevocableCredentials(): void { return this.maintenanceStore.migrateRevocableCredentials(); }
  private migrateLeanReceiptsAndArchives(): void { return this.maintenanceStore.migrateLeanReceiptsAndArchives(); }
  /**
   * Look up the thread archive effect. `archived` is the durable proof that a
   * thread Queue launched can never take another turn.
   */
  threadArchiveKey(agentId: string, hostId: string | null | undefined): string | null {
    if (!hostId) return null;
    return qualifiedThreadArchiveEffectKey(hostId, agentId);
  }
  putThreadArchiveEffect<T extends { status: string; at: string }>(key: string, _agentId: string, effect: T): void {
    this.setMeta(key, effect);
  }
  threadArchiveEffect(agentId: string, hostId?: string | null): { status?: string } | undefined {
    const key = this.threadArchiveKey(agentId, hostId);
    return key ? this.getMeta(key) : undefined;
  }
  /**
   * Remove every recorded run leaf a retired thread's tools were launched with,
   * through the same recorded-leaf path release uses. A retained thread's later
   * runs each start with their own leaf, so all of them go when the thread can
   * take no further turn (task 681).
   */
  retireThreadScratch(taskId: string, agentId: string): number {
    let removed = 0;
    const host = this.db.prepare("SELECT json_extract(data,'$.hostId') AS host FROM tasks WHERE id=?").get(taskId)?.host;
    if (typeof host !== 'string' || !host) return 0;
    for (const row of this.db.prepare("SELECT json_extract(data,'$.temporaryDirectory') AS leaf FROM runs WHERE taskId=? AND json_extract(data,'$.agentId')=? AND json_extract(data,'$.hostId')=?").all(taskId, agentId, host))
      if (typeof row.leaf === "string" && row.leaf && this.runScratchRemover(row.leaf)) removed++;
    return removed;
  }
  /**
   * True once no later turn can reuse the run's thread, so the leaf its tools
   * started with is no longer needed: an unlaunched run, an archived thread, or
   * a task that is terminal or removed. A retained thread keeps its leaf until
   * then, because its MCP children started with that environment and a live
   * thread outlives the run that launched it (task 681: project-e#280).
   */
  private threadRetired(run: Run): boolean {
    if (!run.agentId) return true;
    if (run.hostId && this.threadArchiveEffect(run.agentId, run.hostId)?.status === "archived") return true;
    const row = this.db.prepare("SELECT json_extract(data,'$.phase') AS phase, json_extract(data,'$.removedAt') AS removedAt FROM tasks WHERE id=?").get(run.taskId);
    if (!row) return true;
    return ["done", "cancelled"].includes(String(row.phase)) || row.removedAt != null;
  }
  putRun(run: Run, options: { usageOnly?: boolean } = {}): void {
    // A release and its credential revocation are one durable state change.
    // Callers that already own a transaction keep their larger atomic boundary.
    if (!this.db.isTransaction) {
      this.transaction(() => this.putRun(run, options));
      return;
    }
    this.tasksStore.syncProjectionForWrite();
    const reviewRow = this.db.prepare("SELECT data FROM task_reviews WHERE taskId=? AND seq=0 AND json_extract(data,'$.runId')=? AND json_type(data,'$.reviewTextDigest')='text'").get(run.taskId, run.id);
    if (reviewRow) {
      const resolved = this.resolveReviewRows([{ seq: 0, data: String(reviewRow.data) }]).review;
      if (resolved?.reviewText !== run.completion?.reviewText)
        this.db.prepare("UPDATE task_reviews SET data=? WHERE taskId=? AND seq=0").run(JSON.stringify(resolved), run.taskId);
    }
    const existing = this.db.prepare("SELECT data FROM runs WHERE id=?").get(run.id);
    const existed = Boolean(existing);
    const prior = existing ? JSON.parse(String(existing.data)) as { taskId: string; hostId?: unknown; hostSelection?: Run['hostSelection'] } : undefined;
    if (prior && prior.taskId !== run.taskId) throw new Error("Run task cannot be changed");
    const recordedHost = prior?.hostId;
    if (prior?.hostSelection) run = { ...run, hostSelection: prior.hostSelection };
    else if (prior && run.hostSelection) throw new Error('Run host selection cannot be assigned by an ordinary update');
    if (typeof recordedHost === "string" && recordedHost && run.hostId !== recordedHost) run = { ...run, hostId: recordedHost };
    // Stamp only new runs. An existing legacy run must not acquire a host from
    // a later task state merely because an observation updated it.
    if (!existed) {
      const row = this.db.prepare("SELECT json_extract(data,'$.hostId') AS hostId, json_extract(data,'$.hostSelection') AS selection FROM tasks WHERE id=?").get(run.taskId);
      const taskHost = typeof row?.hostId === "string" && row.hostId ? row.hostId : undefined;
      if (run.hostId !== undefined && run.hostId !== taskHost) throw new Error("Run host does not match task host");
      if (taskHost) run = { ...run, hostId: taskHost, hostSelection: row?.selection ? JSON.parse(String(row.selection)) : { hostId: taskHost, basis: 'migrated', reason: 'Inherited from recorded task host' } };
    } else if (!recordedHost && run.hostId !== undefined) {
      const row = this.db.prepare("SELECT json_extract(data,'$.hostId') AS hostId FROM tasks WHERE id=?").get(run.taskId);
      if (!row?.hostId || row.hostId !== run.hostId) throw new Error("Run host is not proved by its task");
    }
    // Each run records the brief version it was given; the stamp is taken once, at creation.
    // A usage-only write never stamps, so an older run keeps the pins it was dispatched with.
    if (run.briefVersion === undefined && !options.usageOnly) {
      const row = this.db.prepare("SELECT MAX(version) AS version FROM task_brief_versions WHERE taskId=?").get(run.taskId);
      if (typeof row?.version === "number") run = { ...run, briefVersion: row.version };
    }
    // Spec 026: likewise the lane document versions pinned at dispatch.
    if (run.laneDocuments === undefined && !options.usageOnly) {
      const row = this.db.prepare("SELECT json_extract(data,'$.laneDocumentPins') AS pins FROM tasks WHERE id=?").get(run.taskId);
      const pins = row?.pins ? JSON.parse(String(row.pins)) as Array<{ key: string; version: number; digest: string }> : [];
      if (pins.length) run = { ...run, laneDocuments: pins.map(({ key, version, digest }) => ({ key, version, digest })) };
    }
    // A lifecycle observation that only moves `lastObservedAt` records no new board
    // fact: the run's status, activity, release and completion are unchanged. The
    // board's unsettled counters read the observation time fresh from this row.
    const observationOnly = this.runObservationOnly(run);
    this.db.prepare("INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(run.id, run.taskId, JSON.stringify(run));
    // A release revokes the run's callback credential: the released credential
    // authenticates nothing — no exceptions (task 1005, review 5833000688) —
    // and its ticket files go with it. The stored hash is kept, so re-binding
    // the same run identity (a run re-bound after a restart) restores the same
    // credential instead of minting one, and a re-issued credential (restart,
    // continuation, recovery) replaces the hash and lifts any revocation.
    if (run.released) {
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE run=?").run(run.id);
      if (this.path !== ":memory:") {
        if (this.db.isTransaction) this.pendingRunReportingCleanup.set(run.id, run.taskId);
        else purgeReleasedRunTicket(dirname(this.path), run.taskId, run.id);
      }
    }
    if (!run.released) this.db.prepare("UPDATE credentials SET revoked=0 WHERE run=?").run(run.id);
    if (run.released && run.temporaryDirectory && this.threadRetired(run)) this.pendingRunScratchCleanup.add(run.temporaryDirectory);
    if (this.tasksStore.taskProjection) {
      this.tasksStore.rememberProjectedRun(run.id, run.taskId);
      const states = this.tasksStore.runState!;
      const unreleased = this.tasksStore.unreleasedByTask!;
      const pending = this.tasksStore.pendingRunProjection!;
      const rowids = this.tasksStore.pendingRunRowid!;
      const released = Boolean(run.released ?? false);
      const previous = states.get(run.id);
      if (previous && !previous.released && (released || previous.taskId !== run.taskId)) {
        const key = previous.taskId;
        unreleased.set(key, Math.max(0, (unreleased.get(key) ?? 1) - 1));
      }
      if (!released && (!previous || previous.released || previous.taskId !== run.taskId))
        unreleased.set(run.taskId, (unreleased.get(run.taskId) ?? 0) + 1);
      states.set(run.id, { taskId: run.taskId, released });
      // A removed task keeps its run rows but leaves every retained-task list.
      const retained = this.tasksStore.taskProjection?.get(run.taskId)?.removedAt == null;
      if ((!released || run.status === "superseded") && retained) {
        pending.set(run.id, Object.freeze({ ...run }) as Run);
        rowids.set(run.id, Number(this.db.prepare("SELECT rowid AS rid FROM runs WHERE id=?").get(run.id)?.rid));
      } else { pending.delete(run.id); rowids.delete(run.id); }
    }
    // The run write fired the `writes` trigger the in-memory projection keys on. A
    // substantive write acknowledges it through `advanceRevision`; an observation-only
    // write must acknowledge it here exactly as `update()` does, or the next task or run
    // read discards the whole projection and rebuilds it from every row — the audit's
    // observation hot path, where a lifecycle pass observes a still-busy run.
    if (observationOnly) { this.tasksStore.projectionClock = this.tasksStore.readProjectionClock(); }
    else this.advanceRevision();
    // After the clock is acknowledged: a task read before that discards the whole projection.
    if (!existed && !options.usageOnly) {
      try { this.noteGrantRun(this.task(run.taskId), this.routeRoleForRun(run.role)); } catch { /* a missing task cannot increment a grant */ }
    }
    this.taskChanged(run.taskId); }
  /**
   * True when the write differs from the stored row only in `lastObservedAt`, so no
   * board fact moves and the projection need not rebuild (audit A1: observations were
   * about 0.93 of the rebuilds a second). Nested values compare by serialized bytes
   * because every read hands back freshly parsed objects.
   */
  private runObservationOnly(run: Run): boolean { return this.taskWritesStore.runObservationOnly(run); }
  notices(taskId?: string): Notice[] { return this.operationsStore.notices(taskId); }
  unsettledNoticeCount(): number { return this.operationsStore.unsettledNoticeCount(); }
  putNotice(n: Notice) { return this.operationsStore.putNotice(n); }
  messages(taskId: string): AgentMessageRecord[] { return this.operationsStore.messages(taskId); }
  queuedMessages(): AgentMessageRecord[] { return this.operationsStore.queuedMessages(); }
  message(id: string): AgentMessageRecord | null { return this.operationsStore.message(id); }
  putMessage(record: AgentMessageRecord) { return this.operationsStore.putMessage(record); }
  hookEventsPage(afterRowid: number, limit: number, throughRowid = Number.MAX_SAFE_INTEGER): { records: HookRecord[]; lastRowid: number } { return this.operationsStore.hookEventsPage(afterRowid, limit, throughRowid); }
  hookEvents(taskId?: string): HookRecord[] { return this.operationsStore.hookEvents(taskId); }
  /** Permanent outcome row; never rewritten or purged. */
  putOutcome(record: Outcome): Outcome { return this.outcomesStore.putOutcome(record); }
  private insertOutcomeRow(parsed: Outcome): void { return this.outcomesStore.insertOutcomeRow(parsed); }
  /** Searchable projection of one outcome row; never read for anything but search. */
  private indexOutcome(parsed: Outcome): void { return this.outcomesStore.indexOutcome(parsed); }
  /** Spec 019 revision: one index row per task and lane, rebuilt from the outcome row. */
  private indexOutcomeLanes(parsed: Outcome): void { return this.outcomesStore.indexOutcomeLanes(parsed); }
  /**
   * The projection is rebuildable from the rows, which stay the source of truth.
   * Returns the number of indexed outcome rows.
   */
  rebuildOutcomeSearchIndex(): number { return this.outcomesStore.rebuildOutcomeSearchIndex(); }
  /**
   * Spec 025 outcome search: read-only, AND-combined optional filters, newest
   * first, bounded page with a stable (finishedAt, taskId) cursor. Brief text
   * never leaves the store outside a text-search excerpt.
   */
  searchOutcomes(input: OutcomeSearchInput): OutcomeSearchResult { return this.outcomesStore.searchOutcomes(input); }
  outcome(taskId: string): Outcome | null { return this.outcomesStore.outcome(taskId); }
  outcomeBySubmission(submissionId: string): Outcome | null { return this.outcomesStore.outcomeBySubmission(submissionId); }
  outcomes(): Outcome[] { return this.outcomesStore.outcomes(); }
  requireRecordLanes(keys: string[], repositories: Array<{ origin: string | null; path: string }>): Lane[] { return this.planningStore.requireRecordLanes(keys, repositories); }
  requireLaneDocuments(keys: string[], repoPath: string, origin?: string | null): void { return this.lanesStore.requireLaneDocuments(keys, repoPath, origin); }
  requireSubmissionLanes(submission: Pick<Submission, "lanes" | "laneDocuments" | "repoPath">, origin?: string | null): void { return this.planningStore.requireSubmissionLanes(submission, origin); }
  laneDocumentPinsFor(task: Pick<Task, "laneDocuments" | "laneDocumentPins">): LaneDocumentPin[] | null { return this.lanesStore.laneDocumentPinsFor(task); }
  laneDocument(key: string, version?: number): LaneDocumentVersion | null { return this.lanesStore.laneDocument(key, version); }
  editLaneDocument(input: { key: string; version: number; digest?: string; text: string; author: string }): LaneDocumentVersion { return this.lanesStore.editLaneDocument(input); }
  planProject(input: { project?: string; repository?: string }): Project { return this.planningStore.planProject(input); }
  plan(input: { project?: string; repository?: string; version?: number }): ProjectPlan { return this.planningStore.plan(input); }
  plans() { return this.planningStore.plans(); }
  findLeadSubmission(title: string, repository: { origin: string; path: string }) { return this.planningStore.findLeadSubmission(title, repository); }
  setPlan(input: { project?: string; repository?: string; version: number; entries: Array<{ lane: string; note?: string; horizon?: "now" | "next" | "later"; doneWhen?: string }>; author: string; idle?: string }): ProjectPlan { return this.planningStore.setPlan(input); }
  addLead(lead: z.input<typeof leadSchema>, author: string): Lead { return this.planningStore.addLead(lead, author); }
  private storedPlan(project: string, version?: number): ProjectPlan | null { return this.planningStore.storedPlan(project, version); }
  private numberedOperation(data: string): QueueOperation { return this.operationsStore.numberedOperation(data); }
  private ensureLeadLaneIndex(): void { return this.planningStore.ensureLeadLaneIndex(); }
  lead(id: string): Lead { return this.planningStore.lead(id); }
  leadByContentKey(key: string): Lead | null { return this.planningStore.leadByContentKey(key); }
  leadVersions(id: string): LeadVersion[] { return this.planningStore.leadVersions(id); }
  leadVersion(id: string, version: number): LeadVersion { return this.planningStore.leadVersion(id, version); }
  leadVersionOrNull(id: string, version: number): LeadVersion | null { return this.planningStore.leadVersionOrNull(id, version); }
  leadVersionHistory(id: string, currentVersion: number): Array<LeadVersion | z.infer<typeof leadVersionMetadataSchema>> { return this.planningStore.leadVersionHistory(id, currentVersion); }
  leadVersionDigestsBeforeLatest(id: string): string[] { return this.planningStore.leadVersionDigestsBeforeLatest(id); }
  preservePapercutVersion(lead: Lead, body: string): void { return this.planningStore.preservePapercutVersion(lead, body); }
  listLeads(query: { repository?: string; lane?: string; state: Lead["state"]; pageSize?: number; before?: { createdAt: string; id: string } }): Lead[] { return this.planningStore.listLeads(query); }
  listBoardLeads(): { cards: BoardLead[]; links: BoardLeadLink[] } { return this.planningStore.listBoardLeads(); }
  leads(): Lead[] { return this.planningStore.leads(); }
  openLeads(): Lead[] { return this.planningStore.openLeads(); }
  updateLead(lead: Lead, author?: string): Lead { return this.planningStore.updateLead(lead, author); }
  markLeadCheckPending(id: string, version: number, expectedDigest: string, operationId: string): Lead { return this.planningStore.markLeadCheckPending(id, version, expectedDigest, operationId); }
  recordLeadCheck(id: string, version: number, check: Lead["check"], operationId?: string): Lead { return this.planningStore.recordLeadCheck(id, version, check, operationId); }
  recordLeadApproval(id: string, version: number, approval: NonNullable<Lead["approval"]>): void { return this.planningStore.recordLeadApproval(id, version, approval); }
  addDecision(record: z.input<typeof decisionSchema>): Decision { return this.planningStore.addDecision(record); }
  decision(id: string): Decision { return this.planningStore.decision(id); }
  updateDecision(record: Decision): Decision { return this.planningStore.updateDecision(record); }
  updateDecisionDelivery(id: string, delivery: Decision["delivery"]): Decision { return this.planningStore.updateDecisionDelivery(id, delivery); }
  listDecisions(query: { status?: Decision["status"]; asker?: string; project?: string; task?: string; lead?: string; papercut?: string } = {}): Decision[] { return this.planningStore.listDecisions(query); }
  pendingDecisionDeliveries(): Decision[] { return this.planningStore.pendingDecisionDeliveries(); }
  /** Resolve only the admitted version, using immutable task/outcome approval, never today's check. */
  sourcePromotionResult(source: { kind: "lead" | "papercut"; id: string }, repository: string,
    version: number | null, sourceDigest: string): OperationResult | null {
    const lead = this.lead(source.id);
    const targets = lead.targets.filter(target => target.kind === "task" && target.repository === repository);
    let selected: OperationResult | null = null;
    for (const target of targets) {
      const outcome = this.outcome(target.reference);
      const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(target.reference);
      const task = row ? this.numberedTask(String(row.data)) : null;
      const ambiguous = () => new Error(`Cannot establish admitted lead version for task ${target.reference}; promotion refused`);
      if (!task && !outcome) throw ambiguous();
      // Papercuts have one task identity even when their metadata changes or the lead API reads them.
      if (source.kind === "lead" && !lead.papercut) {
        const provenance = task?.leadProvenance;
        const approval = provenance?.approval ?? outcome?.brief.approval;
        const recordSource = task?.planningSource ?? outcome?.planningSource;
        const recordRepository = task?.repository ?? outcome?.repository.origin;
        const recordPath = task?.repoPath ?? outcome?.repository.path;
        const member = lead.repositories.find(repo => repo.origin === repository);
        if (!approval || recordSource?.kind !== "lead" || recordSource.id !== source.id
          || (recordRepository !== repository && recordPath !== member?.path)
          || (provenance && provenance.version !== approval.version)) throw ambiguous();
        const saved = this.leadVersionOrNull(source.id, approval.version);
        if (!saved || briefDigest(saved.body) !== approval.digest
          || (outcome?.brief.approval && JSON.stringify(outcome.brief.approval) !== JSON.stringify(approval))) throw ambiguous();
        if (approval.version !== version) continue;
        if (digest(JSON.stringify([approval.version, approval.digest])) !== sourceDigest) throw ambiguous();
      }
      const result: OperationResult = outcome
        ? { taskId: outcome.taskId, number: outcome.number, reference: outcome.reference, taskVersion: null, phase: null }
        : { taskId: task!.id, number: task!.number, reference: task!.reference, taskVersion: task!.version, phase: task!.phase };
      if (!result.reference || (selected && selected.taskId !== result.taskId)) throw ambiguous();
      selected = result;
    }
    return selected;
  }
  /** Source link and task admission commit together; retries resolve the same task. */
  promoteSource(source: { kind: "lead" | "papercut"; id: string }, repository: string, approvedDigest: string, expectedSource: string,
    submission: Submission, hostId: string, planningBase: string, origin: string | null, initial: Partial<Task> = {}): Task | OperationResult {
    return this.transaction(() => {
      const provenance = submission.leadProvenance;
      const existing = this.sourcePromotionResult(source, repository, provenance?.version ?? null,
        digest(JSON.stringify([provenance?.version, approvedDigest])));
      if (existing) return existing;
      if (submission.planningSource?.kind !== source.kind || submission.planningSource.id !== source.id
        || !submission.brief || briefDigest(submission.brief.text) !== approvedDigest)
        throw new Error("Promotion submission does not match its source brief");
      if (this.existing(submission)) throw new Error("Promotion submission already exists without its source binding");
      if (source.kind === "lead") {
        const lead = this.lead(source.id);
        if (digest(JSON.stringify(lead)) !== expectedSource) throw new Error("Lead changed during promotion; reload");
        const approvalBaseBranch = lead.approval?.baseBranch ?? (lead.baseBranch === "main" ? "main" : null);
        const approvalHead = lead.approval?.planningCommit ?? (lead.baseBranch === "main" ? lead.check?.planningCommit : null);
        if (lead.state === "dropped" || !lead.repositories.some(repo => repo.origin === repository)
          || !provenance || provenance.version !== lead.version
          || JSON.stringify(provenance.approval) !== JSON.stringify(lead.approval)
          || submission.planningSource?.kind !== source.kind || submission.planningSource.id !== source.id
          || !lead.approval || lead.approval.version !== lead.version || lead.approval.digest !== approvedDigest
          || `sha256:${digest(lead.body)}` !== approvedDigest || !lead.check?.ok
          || lead.baseBranch !== submission.baseBranch || lead.check.baseBranch !== submission.baseBranch
          || lead.check.planningCommit !== submission.planningCommit
          || approvalBaseBranch !== submission.baseBranch || approvalHead !== submission.planningCommit)
          throw new Error("Lead approval or check changed before promotion");
        const task = this.insert(submission, hostId, lead.body, planningBase, { ...initial, papercutTask: lead.tags.includes("papercut") }, undefined, origin);
        const stamp = now();
        this.updateLead({ ...lead, state: "promoted", targets: [...lead.targets,
          { kind: "task", repository, reference: task.id, at: stamp }], updatedAt: stamp, closedAt: lead.closedAt ?? stamp });
        return task;
      }
      const cut = this.papercut(source.id);
      if (digest(JSON.stringify(cut)) !== expectedSource) throw new Error("Papercut changed during promotion; reload");
      if (cut.state !== "open" || `sha256:${digest(submission.brief!.text)}` !== approvedDigest)
        throw new Error("Papercut changed before promotion");
      const task = this.insert(submission, hostId, submission.brief!.text, planningBase, initial, undefined, origin);
      this.updatePapercut({ ...cut, state: "promoted", taskId: task.id, draftId: null });
      return task;
    });
  }
  /** A review entry may bind only a Queue-held brief whose exact checked approval still exists. */
  validateReviewEntryBrief(input: Submission, githubRepository: string): void {
    if (!input.brief) return;
    if (stageDeclarationFromBrief(input.brief.text)) throw new Error(STEPS_RETIRED_REASON);
    const expectedDigest = briefDigest(input.brief.text);
    if (input.brief.digest && input.brief.digest !== expectedDigest) throw new Error("Queue-held brief digest changed");
    const expectedOrigin = normalizeRepositoryOrigin(`https://github.com/${githubRepository}`);
    const matchesRepository = (repository: {origin:string|null;path:string}) => repository.path === input.repoPath
      && Boolean(repository.origin && normalizeRepositoryOrigin(repository.origin) === expectedOrigin);
    // The retired draft record can only refuse. It never authorizes review entry.
    if (input.draftProvenance) {
      if (input.leadProvenance) throw new Error("Queue-held brief has conflicting approval records");
      throw new Error("Queue-held brief draft approval, check or planning identity changed");
    }
    const source = input.planningSource, provenance = input.leadProvenance;
    if (!source || source.kind !== "lead" || !provenance) throw new Error("Review entry requires a checked Queue-held brief approval");
    const lead = this.lead(source.id), earlierDigests = this.leadVersionDigestsBeforeLatest(source.id);
    const approvalBaseBranch = lead.approval?.baseBranch ?? (lead.baseBranch === "main" ? "main" : null);
    const approvalHead = lead.approval?.planningCommit ?? (lead.baseBranch === "main" ? lead.check?.planningCommit : null);
    if (lead.state !== "open" || !lead.approval || !lead.check?.ok || !lead.repositories.some(matchesRepository)
      || lead.baseBranch !== input.baseBranch || (lead.originAgentId && lead.originAgentId !== input.originAgentId)
      || approvalBaseBranch !== input.baseBranch || approvalHead !== input.planningCommit
      || lead.version !== provenance.version || lead.approval.version !== provenance.version
      || lead.approval.digest !== expectedDigest || lead.digest !== expectedDigest || lead.body !== input.brief.text
      || JSON.stringify(lead.approval) !== JSON.stringify(provenance.approval)
      || JSON.stringify(earlierDigests) !== JSON.stringify(provenance.earlierDigests)
      || lead.check.planningCommit !== input.planningCommit)
      throw new Error("Queue-held brief lead approval, check or planning identity changed");
  }
  /** Consume the approved source and link it to the review task in its binding transaction. */
  claimReviewEntryBrief(input: Submission, githubRepository: string, taskId: string): void {
    if (!input.brief) return;
    this.validateReviewEntryBrief(input, githubRepository);
    // Validation above admits only a lead source.
    if (this.lead(input.planningSource!.id).tags.includes("papercut"))
      this.update(taskId, { papercutTask: true }, "papercut_source_claimed", input.planningSource!.id);
    const source = input.planningSource!, lead = this.lead(source.id), stamp = now();
    const repository = lead.repositories.find(matches => matches.path === input.repoPath)!.origin;
    this.updateLead({ ...lead, state:"promoted", targets:[...lead.targets,
      {kind:"task",repository,reference:taskId,at:stamp}], updatedAt:stamp, closedAt:lead.closedAt ?? stamp });
  }
  laneByKey(key: string): Lane | null { return this.lanesStore.laneByKey(key); }
  lanes(): Lane[] { return this.lanesStore.lanes(); }
  requireAttachableLanes(keys: string[], repoPath: string, origin?: string | null): Lane[] { return this.lanesStore.requireAttachableLanes(keys, repoPath, origin); }
  /** The denormalised prompt/detail context for a task's lane list, in membership order. */
  private laneContextFor(keys: string[]): Array<{ key: string; title: string; aim: string }> { return this.lanesStore.laneContextFor(keys); }
  upsertLane(input: { key: string; title: string; aim: string; repositories: Lane["repositories"] }): Lane { return this.lanesStore.upsertLane(input); }
  setLaneStatus(key: string, status: Lane["status"], note = ""): Lane { return this.lanesStore.setLaneStatus(key, status, note); }
  /**
   * Spec 041: keep answers a lane's drain prompt. The required reason ends the episode
   * (and restarts the drain window from now); the keep stays on the lane as the answer.
   */
  keepLane(input: { key: string; reason: string; author: string }): Lane { return this.lanesStore.keepLane(input); }
  /** Writes a lane's drain episode without touching its activity timestamp, so the evaluation never resets its own window. */
  private setLaneDrain(key: string, drain: Lane["drain"]): void { return this.lanesStore.setLaneDrain(key, drain); }
  setTaskLanes(task: Task, keys: string[], origin?: string | null): Task { return this.lanesStore.setTaskLanes(task, keys, origin); }
  /** Spec 022: a repository settings row is keyed by the repository identity — origin when known, else the local path. */
  private repositoryKey(identity: RepositorySettings["repository"]): string { return this.projectsStore.repositoryKey(identity); }
  repositoryByKey(key: string): RepositorySettings | null { return this.projectsStore.repositoryByKey(key); }
  repositories(): RepositorySettings[] { return this.projectsStore.repositories(); }
  /**
   * Spec 056: what a fresh re-key would do, read-only. It never applies later
   * drifted input: apply re-checks every one of these facts in its transaction.
   */
  previewRepositoryRekey(input: RepositoryRekeyPreviewInput): RepositoryRekeyPreview { return this.projectsStore.previewRepositoryRekey(input); }
  /**
   * Spec 056: one repository namespace re-key, one transaction, one durable
   * idempotent receipt. A lost reply reads the receipt written by this step;
   * repeating the same key with the same input returns it unchanged, and the
   * same key with different input refuses before any write.
   */
  rekeyRepository(input: RepositoryRekeyInput): RepositoryRekeyResult { return this.projectsStore.rekeyRepository(input); }
  /** The durable receipt of one applied re-key, read by its caller key or by its id. */
  repositoryRekeyReceipt(query: RepositoryRekeyReceiptQuery): RepositoryRekeyReceipt | null { return this.projectsStore.repositoryRekeyReceipt(query); }
  /** Every applied re-key receipt, oldest first; operator evidence, never rewritten. */
  repositoryRekeys(): RepositoryRekeyReceipt[] { return this.projectsStore.repositoryRekeys(); }
  /** Match a repository settings row by exact origin slug or exact local path, so a caller may name either. */
  repositoryFor(repository: string): RepositorySettings | null { return this.projectsStore.repositoryFor(repository); }
  /** The row a patch or set by this identity reads before it writes: its own key first, then a path-only predecessor it re-keys. */
  repositorySettingsFor(identity: RepositorySettings["repository"]): RepositorySettings | null { return this.projectsStore.repositorySettingsFor(identity); }
  /**
   * Fill a repository identity that arrived as an origin string. A provided path
   * is kept; an unrecognized origin falls back to that resolved path, as lead
   * and papercut writes did. With no path, the registered checkout is the one
   * `papercut.list` would resolve.
   */
  resolveRepositoryIdentity(input: { origin: string; path: string }): { origin: string; path: string } { return this.projectsStore.resolveRepositoryIdentity(input); }
  /** Monotonic write ordinal for repository settings rows, allocated inside the caller's transaction: durable latest-setting order independent of clock resolution. */
  private nextRepositoryRevision(): number { return this.projectsStore.nextRepositoryRevision(); }
  putRepository(identity: RepositorySettings["repository"], closeout: ProjectCloseout | null, note: string, validation: ProjectValidation | null = null, reviewer: RepositorySettings["reviewer"] = null, qa: ProjectQa | null = null, checksPolicy: RepositorySettings["checksPolicy"] | undefined = undefined, scratchNamespace?: string | null, hostKind?: import("../../shared/host-kind").HostKind): RepositorySettings { return this.projectsStore.putRepository(identity, closeout, note, validation, reviewer, qa, checksPolicy, scratchNamespace, hostKind); }
  /** Patch semantics: only the named fields change; `null` clears one and an absent field keeps its stored value. Returns the full resulting row. */
  patchRepository(identity: RepositorySettings["repository"], patch: { scratchNamespace?: string | null; closeout?: ProjectCloseout | null; validation?: ProjectValidation | null; reviewer?: RepositorySettings["reviewer"]; qa?: ProjectQa | null; checksPolicy?: RepositorySettings["checksPolicy"]; hostKind?: import("../../shared/host-kind").HostKind; note?: string }): RepositorySettings { return this.projectsStore.patchRepository(identity, patch); }
  scratchNamespaceFor(task: Pick<Task, "repoPath" | "repository">): string { return this.projectsStore.scratchNamespaceFor(task); }
  /** Task 382: the effective hosted-check policy for a task's repository. An absent or null setting keeps every check blocking, so existing repositories never gain advisory behaviour implicitly. */
  checksPolicyFor(task: Pick<Task, "repoPath" | "repository">): RepositoryChecksPolicy { return this.projectsStore.checksPolicyFor(task); }
  /** The canonical row a repository's settings resolve to: specificity first (origin identity over path hint), then the monotonic write revision — the same row closeout authority reads. */
  canonicalRepository(repoPath: string, origin?: string | null): RepositorySettings | null { return this.projectsStore.canonicalRepository(repoPath, origin); }
  /** Spec 022: the closeout override for a repository with no manifest, when a repository settings row sets it. The canonical row binds tightest — origin identity over path hint — and among equally specific rows the highest monotonic write revision carries the operator's latest intent, whatever the clock did. */
  repositoryCloseoutOverride(repoPath: string, origin?: string | null): ProjectCloseout | null { return this.projectsStore.repositoryCloseoutOverride(repoPath, origin); }
  qaRequestRecords(input: { requestId: string } | { repository: string; since: string; expectedHead: string }): unknown[] { return this.projectQaStore.qaRequestRecords(input); }
  qaHistoryForRequest(input: { repository: string; since: string; expectedHead: string }): ProjectQaRun[] { return this.projectQaStore.qaHistoryForRequest(input); }
  putQaRun(run: ProjectQaRun): ProjectQaRun { return this.projectQaStore.putQaRun(run); }
  qaRun(id: string): ProjectQaRun | null { return this.projectQaStore.qaRun(id); }
  latestQaRun(key: string): ProjectQaRun | null { return this.projectQaStore.latestQaRun(key); }
  latestQaRuns(limit = 250): ProjectQaRun[] { return this.projectQaStore.latestQaRuns(limit); }
  latestQaRunsFor(keys: readonly string[]): ProjectQaRun[] { return this.projectQaStore.latestQaRunsFor(keys); }
  qaBoardRuns(passedSince: string): ProjectQaRun[] { return this.projectQaStore.qaBoardRuns(passedSince); }
  qaScheduleMerges(key: string): Array<{ taskId: string; title: string; mergeCommit: string; prUrl: string | null; finishedAt: string; attemptedRun: string | null; checkedGreenRun: string | null }> { return this.projectQaStore.qaScheduleMerges(key); }
  markQaScheduleMerges(taskIds: string[], runId: string, passed: boolean): void { return this.projectQaStore.markQaScheduleMerges(taskIds, runId, passed); }
  checkQaScheduleGreen(taskIds: string[], runId: string): void { return this.projectQaStore.checkQaScheduleGreen(taskIds, runId); }
  qaScheduleRuns(key: string): { latest: ProjectQaRun | null; green: ProjectQaRun | null; active: ProjectQaRun | null } { return this.projectQaStore.qaScheduleRuns(key); }
  putHostRun(run: HostRunRecord | HostRunInternalRecord): HostRunInternalRecord { return this.hostRunStore.putHostRun(run); }
  hostRun(id: string): HostRunInternalRecord | null { return this.hostRunStore.hostRun(id); }
  hostRunAccountingDispositionRaw(id: string): unknown { return this.hostRunStore.hostRunAccountingDispositionRaw(id); }
  hostRunAccountingRetirement(record: HostRunInternalRecord): HostRunAccountingRetirement | undefined { return this.hostRunStore.hostRunAccountingRetirement(record); }
  hostRuns(limit = 250): HostRunInternalRecord[] { return this.hostRunStore.hostRuns(limit); }
  hostRunHoldingWorkspace(directory: string): HostRunInternalRecord | null { return this.hostRunStore.hostRunHoldingWorkspace(directory); }
  hostRunCapacityCandidates(): HostRunInternalRecord[] { return this.hostRunStore.hostRunCapacityCandidates(); }
  hostRunServedLaunches(): Array<{ origin: string | null; path: string | null; launchedAt: string }> { return this.hostRunStore.hostRunServedLaunches(); }
  hostRunIdsAmong(ids: readonly string[]): Set<string> { return this.hostRunStore.hostRunIdsAmong(ids); }
  hostRunSettledSweepPage(afterRowid: number, limit: number): { rows: HostRunInternalRecord[]; lastRowid: number; complete: boolean } { return this.hostRunStore.hostRunSettledSweepPage(afterRowid, limit); }
  hostRunOutputFailure(runId: string): HostRunOutputFailure | null { return this.hostRunStore.hostRunOutputFailure(runId); }
  hostRunOutputFailures(limit = HOST_RUN_OUTPUT_FAILURE_SUMMARY_EXAMPLES): HostRunOutputFailure[] { return this.hostRunStore.hostRunOutputFailures(limit); }
  hostRunOutputFailuresDue(at: string, limit = HOST_RUN_OUTPUT_FAILURE_DUE_PAGE): HostRunOutputFailure[] { return this.hostRunStore.hostRunOutputFailuresDue(at, limit); }
  hostRunOutputFailureTotals(): { count: number; firstSeen: string | null; lastSeen: string | null } { return this.hostRunStore.hostRunOutputFailureTotals(); }
  putHostRunOutputFailure(failure: HostRunOutputFailure): void { return this.hostRunStore.putHostRunOutputFailure(failure); }
  deleteHostRunOutputFailure(runId: string): void { return this.hostRunStore.deleteHostRunOutputFailure(runId); }
  recordHostRunOutputReclassification(entry: HostRunOutputReclassification): void { return this.hostRunStore.recordHostRunOutputReclassification(entry); }
  projectValidationRecordsRun(taskId: string, runId: string, epoch: number, head: string): boolean { return this.hostRunStore.projectValidationRecordsRun(taskId, runId, epoch, head); }
  hostRunSubmittedByQueue(runId: string): boolean { return this.hostRunStore.hostRunSubmittedByQueue(runId); }
  hostRunOutputReclassifications(): { total: number; recent: HostRunOutputReclassification[] } { return this.hostRunStore.hostRunOutputReclassifications(); }
  hostRunsAwaitingEscapedDescendants(): HostRunInternalRecord[] { return this.hostRunStore.hostRunsAwaitingEscapedDescendants(); }
  hostRunSelectorSamples(repositoryKeys: readonly string[], selector: string): HostRunInternalRecord[] { return this.hostRunStore.hostRunSelectorSamples(repositoryKeys, selector); }
  hostRunsByStates(states: HostRunInternalRecord["state"][]): HostRunInternalRecord[] { return this.hostRunStore.hostRunsByStates(states); }
  appendHostRunJournal(runId: string, event: string, data: unknown, at = now()): number { return this.hostRunStore.appendHostRunJournal(runId, event, data, at); }
  hostRunJournal(runId: string): Array<{ event: string; at: string; data: unknown }> { return this.hostRunStore.hostRunJournal(runId); }
  private defaultProject(repo: Project["repositories"][number]): Project { return this.projectsStore.defaultProject(repo); }
  private isDefaultProject(project: Project): boolean { return this.projectsStore.isDefaultProject(project); }
  private insertDefaultProject(repo: Project["repositories"][number]) { return this.projectsStore.insertDefaultProject(repo); }
  projects(): Project[] { return this.projectsStore.projects(); }
  projectByKey(key: string): Project | null { return this.projectsStore.projectByKey(key); }
  /** The project that holds this repository's origin, whatever its stored key is. */
  queueProject(): Project | null { return this.projectsStore.queueProject(); }
  setProjectVisibility(input: { key: string; version: number }, visibility: Project["visibility"]): Project { return this.projectsStore.setProjectVisibility(input, visibility); }
  /**
   * Spec 058 (task 540): names the planner thread that answers delegated questions for a project.
   * It is a plain project field, not ownership: it grants no verb, hold or notice.
   */
  setProjectPlanner(input: { key: string; agentId: string | null; setBy: string; note?: string }, at = now()): Project { return this.projectsStore.setProjectPlanner(input, at); }
  /** Task 1110: the project's named, non-task threads, registered and revoked one at a time. */
  registerProjectAgent(input: { key: string; name: string; purpose: string; agentId: string; hostId: string; registeredBy: string; note?: string }, at = now()): Project { return this.projectsStore.registerProjectAgent(input, at); }
  unregisterProjectAgent(input: { key: string; name: string; unregisteredBy: string; note?: string }, at = now()): Project { return this.projectsStore.unregisterProjectAgent(input, at); }
  ensureProjectFallbackAgent(input: { key: string; hostId?: string | null; previousPlannerId?: string | null }, at = now()): Project { return this.projectsStore.ensureProjectFallbackAgent(input, at); }
  /**
   * Spec 058 cutover 5: the one-time owner→planner migration drops a project's archived or
   * missing owner record. The live-owner case keeps its owner field as readable history and
   * gains the thread as planner instead; only a dead owner is dropped here.
   */
  retireProjectOwner(key: string, reason: string, at = now()): Project | null { return this.projectsStore.retireProjectOwner(key, reason, at); }
  /**
   * Spec 058 cutover 5: the project-level notice recipient — the project's planner, else the
   * Queue planner (the project that holds origin `inflatable-cookie/paseo-northstar-queue`),
   * else null. The retired owner field is never read.
   */
  projectPlannerRecipient(project: Pick<Project, "planner"> | null | undefined): string | null { return this.projectsStore.projectPlannerRecipient(project); }
  /** One read of the project table for many lookups; `projectFor` re-reads it per call. */
  projectKeyResolver(projects = this.projects()): (task: Pick<Task, "repoPath" | "repository">) => string | null { return this.projectsStore.projectKeyResolver(projects); }
  projectFor(repoPath: string, origin?: string | null): Project | null { return this.projectsStore.projectFor(repoPath, origin); }
  projectDispatchLimitOverrides(): Record<string, number> { return this.projectsStore.projectDispatchLimitOverrides(); }
  setProjectDispatchLimitOverride(projectKey: string, limit: number | null) { return this.projectsStore.setProjectDispatchLimitOverride(projectKey, limit); }
  /**
   * A project's in-flight cap: always twice its effective slot limit (Tom, 2026-11-08).
   * A value an older build stored under `projectInFlightLimitOverrides` is ignored.
   */
  projectInFlightLimitFor(task: Pick<Task, "repoPath" | "repository">): number { return this.projectsStore.projectInFlightLimitFor(task); }
  projectDispatchLimitResolver(): (task: Pick<Task, "repoPath" | "repository">) => number { return this.projectsStore.projectDispatchLimitResolver(); }
  papercutDispatchPolicy() { return this.projectsStore.papercutDispatchPolicy(); }
  projectDispatchLimitFor(task: Pick<Task, "repoPath" | "repository">): number { return this.projectsStore.projectDispatchLimitFor(task); }
  ensureProject(repoPath: string, origin?: string | null): Project { return this.projectsStore.ensureProject(repoPath, origin); }
  upsertProject(input: ProjectUpsertInput): Project { return this.projectsStore.upsertProject(input); }
  projectTombstones(): ProjectTombstone[] { return this.projectsStore.projectTombstones(); }
  /**
   * Spec 027: the blockers a removal refusal would name, read by the board so its
   * confirmation never recomputes them from a filtered view.
   */
  /** Confirmation identity excludes task progress, but includes every task ID and complete planning records. */
  private managementRecords(key: string) { return this.projectsStore.managementRecords(key); }
  projectManagementPreview(input: {key: string; target?: string}): ProjectManagementPreview { return this.projectsStore.projectManagementPreview(input); }
  resetProjectCancellation(input: {key:string;operationId:string;tasks:Array<{taskId:string;version:number}>}) { return this.projectsStore.resetProjectCancellation(input); }
  manageRemoveProject(input: ProjectManageInput): ProjectTombstone { return this.projectsStore.manageRemoveProject(input); }
  removalBlockers(key: string, repository?: string): ProjectRemovalBlocker[] { return this.projectsStore.removalBlockers(key, repository); }
  private projectMember(project: Project, repository: string): Project["repositories"][number] { return this.projectsStore.projectMember(project, repository); }
  /**
   * nucleus#967: take a member out of a project and delete the one-repository
   * project it becomes, as one write. A blocker, a stale version or the primary
   * refuses the whole step, so the repository never ends up split off but not removed.
   */
  removeProjectRepository(input: ProjectRemoveRepositoryInput): { project: Project; tombstone: ProjectTombstone } { return this.projectsStore.removeProjectRepository(input); }
  /**
   * Spec 027: delete a project record. Anything still using it blocks the delete
   * and is named; a durable tombstone keeps an export or import from resurrecting
   * it, and a repository settings row shared with another project stays.
   */
  removeProject(input: { key: string; version: number; reason: string }): ProjectTombstone { return this.projectsStore.removeProject(input); }
  /**
   * The record side of a removal, inside the caller's transaction: the row, its
   * plan, its slot override and any settings row no remaining project uses go,
   * and a tombstone keeps an export or import from resurrecting it.
   */
  private retireProject(project: Project, reason: string): ProjectTombstone { return this.projectsStore.retireProject(project, reason); }
  /**
   * nucleus#984: what a move would refuse on, and what it carries along. A move
   * takes every record attached to the moving repositories with them (tasks,
   * leads, papercuts, lanes, drafts, submissions, decisions, QA history), so
   * those are `carried`, not blockers. Only state that can't change projects
   * mid-flight blocks: a queued or running project QA, or an in-flight
   * repository re-key, on a moving repository.
   */
  mergeCheck(input: ProjectMergeCheckInput): ProjectMergeCheck { return this.projectsStore.mergeCheck(input); }
  private mergeBlockers(moving: Project): ProjectRemovalBlocker[] { return this.projectsStore.mergeBlockers(moving); }
  /**
   * nucleus#969: move a project, or one of its members, into another project as
   * one write. The target keeps its name, planner, slots and primary. Records
   * attached to the moving repositories follow them unchanged (nucleus#984); a
   * source left empty is removed, its saved plan entries join the end of the
   * target's plan and its slot override goes. Only `mergeBlockers` refuse. A
   * repository is never in two projects.
   */
  mergeProject(input: ProjectMergeInput): ProjectMergeResult { return this.projectsStore.mergeProject(input); }
  /**
   * nucleus#984: a removed source's saved plan order joins the end of the
   * target's, skipping lanes the target already orders, as one new target plan
   * version. The target's idle mark stays only while no now or next lane joins.
   */
  private mergePlanInto(source: string, target: string): void { return this.projectsStore.mergePlanInto(source, target); }
  laneViews(query: { status?: Lane["status"]; repository?: string } = {}): LaneView[] { return this.lanesStore.laneViews(query); }
  /**
   * Lane views are derived from lanes, outcomes, live task phases and event times only, so they
   * are rebuilt once per `laneViewRevision()` change and served from cache in between. The value
   * is never stored inside a transaction: a rollback rewinds the rows the views came from.
   */
  private cachedLaneViews(): LaneView[] { return this.lanesStore.cachedLaneViews(); }
  /**
   * The newest event time per task, loaded once and maintained by `event()`. A write that
   * bypassed the funnel (a backdated fixture, a repair) moves the `eventRows` clock, and the
   * map is then rebuilt from the rows rather than answered from memory.
   */
  private eventTimes(): Map<string, string> { return this.lanesStore.eventTimes(); }
  /**
   * Spec 019: one outcome-by-lane index, built once from the permanent rows and extended by
   * `insertOutcomeRow`. A row written outside that funnel moves the `outcomeRows` clock, and
   * the index is then rebuilt from the rows.
   */
  private outcomesByLane(): Map<string, Outcome[]> { return this.lanesStore.outcomesByLane(); }
  /** Spec 019: lead (including papercut-tagged lead) activity per lane. */
  laneRecordActivity(): Map<string, LaneRecordActivity> { return this.lanesStore.laneRecordActivity(); }
  /**
   * Spec 019 revision (2026-09-27): close active lanes idle for 14 days. Closing is
   * `done` with the automatic note, never deletion, and touches no task or record.
   * Returns the closed keys.
   */
  closeIdleLanes(at = Date.now()): string[] { return this.lanesStore.closeIdleLanes(at); }
  /**
   * Spec 041: one drain pass over the active projects' saved plans. Parked projects
   * and plans nobody saved start no episode; a stored episode still escalates by its
   * timer. Episodes and notices land in one transaction, so a pass never leaves a
   * started episode without its prompt.
   */
  evaluateLaneDrains(at = Date.now()): void { return this.lanesStore.evaluateLaneDrains(at); }
  hookEvent(id: string): HookRecord | null { return this.operationsStore.hookEvent(id); }
  deleteHookEvents(ids: readonly string[], batch = 500): number { return this.operationsStore.deleteHookEvents(ids, batch); }
  putHookEvent(record: HookRecord) { return this.operationsStore.putHookEvent(record); }
  operationForKey(key: string): QueueOperation | null { return this.operationsStore.operationForKey(key); }
  operation(id: string): QueueOperation | null { return this.operationsStore.operation(id); }
  operationPayload(id: string): unknown { return this.operationsStore.operationPayload(id); }
  reconcileTaskControlPreSend(id: string, inputHash: string): QueueOperation { return this.operationsStore.reconcileTaskControlPreSend(id, inputHash); }
  operations(filter: { states?: QueueOperation["state"][]; taskId?: string; limit?: number } = {}): QueueOperation[] { return this.operationsStore.operations(filter); }
  unfinishedSourcePromotion(source: { kind: "lead" | "papercut"; id: string; repository: string; version: number | null; digest: string }): QueueOperation | null { return this.operationsStore.unfinishedSourcePromotion(source); }
  sourcePromotionsForReconciliation(): QueueOperation[] { return this.operationsStore.sourcePromotionsForReconciliation(); }
  operationsForAbsenceProof(submissionId: string): QueueOperation[] { return this.operationsStore.operationsForAbsenceProof(submissionId); }
  operationBacklog(): number { return this.operationsStore.operationBacklog(); }
  pendingSubmissions(): PendingSubmission[] { return this.operationsStore.pendingSubmissions(); }
  configuredOperationLimit(): number { return this.operationsStore.configuredOperationLimit(); }
  configuredPaseoCallLimit(): number { return this.operationsStore.configuredPaseoCallLimit(); }
  putOperation(operation: QueueOperation, payload?: unknown): QueueOperation { return this.operationsStore.putOperation(operation, payload); }
  acceptOperation(input: { key: string; kind: QueueOperation["kind"]; inputHash: string; taskId?: string | null; expectedVersion?: number | null; repoPath?: string | null; submissionId?: string | null; hostId?: string; hostSelection?: QueueOperation['hostSelection']; payload: unknown }, at = now()): OperationAcceptance { return this.operationsStore.acceptOperation(input, at); }
  receipt(input: Completion, token: string): { accepted: true; eventId: string } | null { return this.authStore.receipt(input, token); }
  appendProofFiles(taskId: string, records: Task["proofFiles"]): Task {
    if (!records.length) return this.task(taskId);
    const task = this.task(taskId);
    // A retried report (a fresh event ID for the same bytes) is the same evidence.
    const key = (record: Task["proofFiles"][number]) => `${record.head}\0${record.label}\0${record.sha256}\0${record.bytes}\0${record.runId}`;
    const seen = new Set(task.proofFiles.map(key));
    const fresh = records.filter(record => !seen.has(key(record)));
    if (!fresh.length) return task;
    return this.update(taskId, { proofFiles: [...task.proofFiles, ...fresh] }, "proof_files",
      fresh.map(record => `${record.label} ${record.sha256.slice(0, 12)} @ ${record.head}`).join("; "));
  }
  acceptCompletion(input: Completion, token: string, pr: { url: string; head: string } | null, options: { armedReplacement?: boolean } = {}) {
    return this.transaction(() => {
      const duplicate = this.receipt(input, token); if (duplicate) return duplicate;
      const task = this.task(input.taskId);
      // Spec 050 (task 483, review 5695764296 finding 1): an owner's armed worker
      // replacement that has not retired the worker yet does not make that
      // worker's own authenticated result stale. The result wins the race, the
      // armed replacement is abandoned in the same accepted write, and any extra
      // authorization stays unspent. The caller proves the armed state is the
      // owner's own replacement, never an automatic fault.
      const armed = options.armedReplacement === true && task.phase === "changes_requested"
        && Boolean(task.agentId) && Boolean(task.failoverReason) && Boolean(task.replacementProfile);
      if (task.runId !== input.runId || task.completion
        || !(armed || ["working", "dispatching", "needs_attention"].includes(task.phase))) throw new Error("Stale worker run");
      const response = { accepted: true as const, eventId: input.eventId };
      const stalledTurnStop = task.resolution.stalledTurnStop?.runId === input.runId
        ? { ...task.resolution.stalledTurnStop, status: "completed" as const, detail: "Authenticated completion received; stop reconciliation will retain the result" }
        : task.resolution.stalledTurnStop;
      const settled = task.resolution.pendingWorkerInstruction || stalledTurnStop !== task.resolution.stalledTurnStop
        ? { ...task.resolution, pendingWorkerInstruction: null, stalledTurnStop } : task.resolution;
      // Queue #342: the author's accepted result makes its own build output a settlement candidate.
      const queueOwnedWorkspace = task.reviewEntry?.preserveWorkspace !== true;
      const buildOutputCleanups = task.workspaceId && task.directory && queueOwnedWorkspace
        ? runBuildOutputIntent(settled.buildOutputCleanups, { id: input.runId, workspaceId: task.workspaceId, agentId: task.agentId }, task.directory, new Date().toISOString())
        : settled.buildOutputCleanups;
      this.update(task.id, { completion: input, prUrl: pr?.url ?? null, prHead: pr?.head ?? null,
        resolution: { ...settled, buildOutputCleanups, ...(armed ? { attention: false } : {}) },
        // The retained worker's own result ends the pending replacement: the
        // worker keeps running its accepted result and no new agent is created.
        ...(armed ? { phase: "working" as const, failoverReason: "", replacementProfile: null } : {}),
        reason: armed
          ? "Completion received; the retained worker's own result superseded the pending replacement"
          : "Completion received; waiting for the worker to release the workspace" }, "completion_received", input.summary);
      this.setCompletionReceipt(input.eventId, task.id, input.runId, digest(JSON.stringify(input)), JSON.stringify(response));
      return response;
    });
  }
}
