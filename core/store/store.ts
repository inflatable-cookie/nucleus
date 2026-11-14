import {StoreAuth} from "./store-auth";
import {StoreConfig} from "./store-config";
import {digest,now,StoreCore} from "./store-core";
import {StoreHostRuns} from "./store-host-runs";
import {StoreLanes} from "./store-lanes";
import {StorePrerequisites} from "./store-prerequisites";
import {StoreSourcePromotion} from "./store-source-promotion";
import {StoreTaskFunnel} from "./store-task-funnel";
import {StoreTaskNumbers} from "./store-task-numbers";
import {StoreThreadEffects} from "./store-thread-effects";
import {reviewEntryBeforeFirstRun,reviewEntryUnrun,type ReviewEntryFacts} from "./review-entry-eligibility";
import {StoreAdmission} from "./store-admission";
import {StoreMigration} from "./store-migration";
import {ContentFingerprint,StoreFacts,StoreReclaim,type ReclaimResult} from "./store-reclaim";
import {HISTORY_RETENTION_MS,StoreRetention,type RetainedRowPrune} from "./store-retention";
import {StoreOperations} from "./store-operations";
import {buildOutcomeRecord,StoreOutcomes,type TelemetryFactChunk,type VerbOutcome} from "./store-outcomes";
import {StorePlanning} from "./store-planning";
import {StoreProjectQa} from "./store-project-qa";
import {StoreProjects} from "./store-projects";
import {StoreSubmissions,submissionHash} from "./store-submissions";
import {StoreTaskWrites,type StoredTaskParts} from "./store-task-writes";
import {StoreTasks} from "./store-tasks";
export { digest } from "./store-core";
export { CACHE_SIZE_KIB,CURRENT_SCHEMA,JOURNAL_SIZE_LIMIT_BYTES } from "./store-admission";
export { AUTO_VACUUM_INCREMENTAL,AUTO_VACUUM_NONE,ContentFingerprint,STORE_COMPACTION_META_KEY,STORE_MAINTENANCE_META_KEY,StoreFacts,RECLAIM_BUDGET_MS,RECLAIM_CHUNK_PAGES,RECLAIM_DRAIN_BUDGET_MS,RECLAIM_DRAIN_FREE_PAGES,RECLAIM_DRAIN_MAX_PAGES,RECLAIM_MAX_PAGES } from "./store-reclaim";
export { ASSIGNMENT_HISTORY_KEEP,HISTORY_RETENTION_MS,HOST_RUN_KEEP_PER_SELECTOR,PROJECT_QA_KEEP_PER_REPOSITORY,VERB_OUTCOME_RETENTION_MS } from "./store-retention";
export { operationIdForKey,operationInputHash,provedPreSendHistory } from "./store-operations";
export { buildOutcomeRecord,type TelemetryFactChunk,type VerbOutcome } from "./store-outcomes";
export { explicitCriticalFalseSubmissionHash,legacySubmissionHash,submissionHash } from "./store-submissions";


import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import type {Completion,PoolEntry,Submission} from "../../shared/contracts";
import {availabilitySchema,compactLiveTask,decisionSchema,leadSchema,leadVersionMetadataSchema,noticeSchema,type AgentMessageRecord,type BoardLead,type BoardLeadLink,type Decision,type DemandRoleOffsets,type HostRunAccountingRetirement,type HostRunInternalRecord,type HostRunRecord,type Lane,type LaneDocumentPin,type LaneDocumentVersion,type LaneView,type Lead,type LeadVersion,type Notice,type Outcome,type OutcomeSearchInput,type OutcomeSearchResult,type Papercut,type PendingSubmission,type Profile,type Project,type ProjectCloseout,type ProjectManageInput,type ProjectManagementPreview,type ProjectMergeCheck,type ProjectMergeCheckInput,type ProjectMergeInput,type ProjectMergeResult,type ProjectPlan,type ProjectQa,type ProjectQaRun,type ProjectRemovalBlocker,type ProjectRemoveRepositoryInput,type ProjectTombstone,type ProjectUpsertInput,type ProjectValidation,type QaFence,type QaFenceRecord,type QaFenceView,type QaInventoryItem,type RepositoryChecksPolicy,type RepositorySettings,type RoutingGrant,type RoutingPolicy,type Run,type RuntimeRetirement,type SnapshotInput,type Task,type UsageLevel,type UsageSetting,type UsageView} from "../../shared/contracts";
import {type HookRecord} from "../../shared/hooks";
import {type OperationAcceptance,type OperationResult,type QueueOperation} from "../../shared/operations";
import {type LaneRecordActivity} from "../planning/lanes";

import {purgeReleasedRunTicket} from "../intake/reporting-files";

import {type NucleusProfile,type ProfileImportRecord} from "../../shared/profiles";

import {removeRecordedRunScratchDirectory} from "../workspaces/run-scratch";

import {type RepositoryRekeyInput,type RepositoryRekeyPreview,type RepositoryRekeyPreviewInput,type RepositoryRekeyReceipt,type RepositoryRekeyReceiptQuery,type RepositoryRekeyResult} from "../../shared/repository-rekey";
import type {VerifiedEnclosingOperation} from "../planning/enclosing-operation";

import {HOST_RUN_OUTPUT_FAILURE_DUE_PAGE,HOST_RUN_OUTPUT_FAILURE_SUMMARY_EXAMPLES,type HostRunOutputFailure,type HostRunOutputReclassification} from "../host-runs/host-run-output-failures";
import {qualifiedThreadArchiveEffectKey} from "./store-core";
import type {BudgetClock} from "../../shared/task-budget";
/**
 * The store's write funnels are closed for a bounded maintenance window; nothing may
 * start a transaction, and the window itself proves no other connection holds a lock.
 */
export { now,qualifiedThreadArchiveEffectKey,StoreMaintenanceError } from "./store-core";
export { UNRESOLVED_SEED } from "./store-lanes";

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
  /**
   * The store's maintenance seams, one owner per mechanism: opening and migrating a store,
   * the every-open row strips, its retention windows, and its file facts and reclamation. Each
   * is constructed with only the facts it uses.
   */
  private readonly retentionStore = new StoreRetention(this.core, {
    numberedTask: data => this.numberedTask(data),
    runs: taskId => this.runs(taskId),
    hookEvents: taskId => this.hookEvents(taskId),
    notices: taskId => this.notices(taskId),
    deleteCredential: run => this.deleteCredential(run),
    tasksStore: () => this.tasksStore,
    lastEventAtByTask: () => this.lastEventAtByTask,
    cachedTaskCount: () => this.cachedTaskCount,
    setCachedTaskCount: value => { this.cachedTaskCount = value; },
    advanceRevision: () => this.advanceRevision(),
    taskChanged: taskId => this.taskChanged(taskId),
  });
  private readonly migrationStore = new StoreMigration(this.core, {
    retainedArchiveKeys: () => this.retentionStore.retainedArchiveKeys(),
    pruneThreadArchiveKeys: () => this.retentionStore.pruneThreadArchiveKeys(),
  });
  private readonly admissionStore = new StoreAdmission(this.core, {
    storedSchema: (path, integrity) => Store.storedSchema(path, integrity),
    schemaIn: (db, integrity) => Store.schemaIn(db, integrity),
    verifyMigrationSnapshot: (source, snapshot) => Store.verifyMigrationSnapshot(source, snapshot),
    numberedTask: data => this.numberedTask(data),
    taskRow: (task, before) => this.taskRow(task, before),
    storedReviewValue: value => this.storedReviewValue(value),
    migration: this.migrationStore,
    retention: this.retentionStore,
  });
  private readonly reclaimStore = new StoreReclaim(this.core, () => this.path);

  /**
   * The task and run write funnels. The store is their client: a task or run row has exactly
   * one write path, and every service the funnel calls here reads or records, it never starts
   * another write funnel.
   */
  private readonly funnel = (() => {
    const store = this;
    return new StoreTaskFunnel({
      get db() { return store.db; },
      get tasksStore() { return store.tasksStore; },
      transaction: fn => store.transaction(fn),
      task: id => store.task(id),
      event: (taskId, kind, detail) => store.event(taskId, kind, detail),
      advanceRevision: () => store.advanceRevision(),
      taskChanged: taskId => store.taskChanged(taskId),
      taskCountChanged: () => { store.cachedTaskCount = null; },
      taskRow: (task, before) => store.taskRow(task, before),
      syncTaskObservation: (taskId, task) => store.syncTaskObservation(taskId, task),
      resolveReviewRows: rows => store.resolveReviewRows(rows),
      runObservationOnly: run => store.taskWritesStore.runObservationOnly(run),
      run: id => store.run(id),
      queueRunScratchCleanup: directory => { store.pendingRunScratchCleanup.add(directory); },
      queueRunReportingCleanup: (runId, taskId) => { store.pendingRunReportingCleanup.set(runId, taskId); },
      get path() { return store.path; },
      dependencyWait: task => store.dependencyWait(task),
      taskReference: id => store.taskReference(id),
      existing: input => store.existing(input),
      validateDependencies: input => store.validateDependencies(input),
      requireAttachableLanes: (keys, repoPath, origin) => store.requireAttachableLanes(keys, repoPath, origin),
      requireLaneDocuments: (keys, repoPath, origin) => store.requireLaneDocuments(keys, repoPath, origin),
      ensureProject: (repoPath, origin) => store.ensureProject(repoPath, origin),
      assignNumber: (taskId, repository) => store.assignNumber(taskId, repository),
      setCredential: (run, token) => store.setCredential(run, token),
      putNotice: notice => store.putNotice(notice),
      notices: taskId => store.notices(taskId),
      runs: taskId => store.runs(taskId),
      hookEvents: taskId => store.hookEvents(taskId),
      operations: filter => store.operations(filter),
      operation: id => store.operation(id),
      putOutcome: record => store.putOutcome(record),
      completePapercutsForTask: task => store.planningStore.completePapercutsForTask(task),
      noteGrantRun: (task, role) => store.noteGrantRun(task, role),
      receipt: (input, token) => store.receipt(input, token),
      setCompletionReceipt: (id, task, run, hash, response) => store.setCompletionReceipt(id, task, run, hash, response),
      threadArchiveEffect: (agentId, hostId) => store.threadArchiveEffect(agentId, hostId),
    });
  })();

  /** The stored facts the review-entry boundary reads; the rule itself is one shared function. */
  private get reviewEntryFacts(): ReviewEntryFacts {
    return { runsOf: taskId => this.runs(taskId), operation: id => this.operation(id),
      operations: filter => this.operations(filter), hookEvents: taskId => this.hookEvents(taskId) };
  }
  private reviewEntryBeforeFirstRun(task: Task): boolean { return reviewEntryBeforeFirstRun(this.reviewEntryFacts, task); }
  /** The dependency boundary and the prerequisite wait, in their own owner. */
  private readonly prerequisites = new StorePrerequisites({
    ...{} as ReviewEntryFacts,
    runsOf: taskId => this.runs(taskId),
    operation: id => this.operation(id),
    operations: filter => this.operations(filter),
    hookEvents: taskId => this.hookEvents(taskId),
    transaction: fn => this.transaction(fn),
    task: id => this.task(id),
    taskReference: id => this.taskReference(id),
    update: (id, change, kind, detail, expected) => this.update(id, change as Partial<Task> & { attention?: never }, kind, detail, expected),
    dependencyWait: task => this.dependencyWait(task),
    putNotice: notice => this.putNotice(notice),
    notices: taskId => this.notices(taskId),
    reviewEntryBeforeFirstRun: task => this.reviewEntryBeforeFirstRun(task),
  });

  /** Source promotion: a lead or papercut becomes a task here, and only here. */
  private readonly promotion = (() => {
    const store = this;
    return new StoreSourcePromotion({
    get db() { return store.db; },
    transaction: fn => store.transaction(fn),
    lead: id => store.lead(id),
    leadVersionOrNull: (id, version) => store.leadVersionOrNull(id, version),
    leadVersionDigestsBeforeLatest: id => store.leadVersionDigestsBeforeLatest(id),
    papercut: id => store.papercut(id),
    updateLead: lead => store.updateLead(lead),
    updatePapercut: record => store.updatePapercut(record),
    outcome: taskId => store.outcome(taskId),
    numberedTask: data => store.numberedTask(data),
    existing: input => store.existing(input),
    insert: (input, hostId, handoffText, planningBase, initial, _credential, origin) => store.insert(input, hostId, handoffText, planningBase, initial, undefined, origin),
    update: (id, change, kind, detail) => store.update(id, change as Partial<Task> & { attention?: never }, kind, detail),
    validateReviewEntryBrief: (input, githubRepository) => store.validateReviewEntryBrief(input, githubRepository),
    });
  })();

  /** Task numbering: assignment, reference lookup and the per-repository counter. */
  private readonly numbers = (() => {
    const store = this;
    return new StoreTaskNumbers({ get db() { return store.db; }, get numberCache() { return store.tasksStore.numberCache; } });
  })();
  /** A thread's durable archive effect and the recorded leaves that go with it. */
  private readonly threadEffects = (() => {
    const store = this;
    return new StoreThreadEffects({
      get db() { return store.db; },
      getMeta: key => store.getMeta(key), setMeta: (key, value) => store.setMeta(key, value),
      removeRecordedRunScratch: directory => store.runScratchRemover(directory),
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
  routingRetryAllowed(task: Task): boolean { return this.tasksStore.queue.routingRetryAllowed(task); }
  setRoutingEpoch(epoch: string): void { return this.tasksStore.queue.setRoutingEpoch(epoch); }
  markRoutingAttempt(taskId: string): void { return this.tasksStore.queue.markRoutingAttempt(taskId); }
  readyQueueHeads(limit: number, repoPath?: string, startedOnly = false): Task[] { return this.tasksStore.queue.readyQueueHeads(limit, repoPath, startedOnly); }
  boardQueueCounts(): Array<{ repoPath: string; count: number }> { return this.tasksStore.board.boardQueueCounts(); }
  boardQueuePage(repoPath: string, offset: number, limit: number): { tasks: Task[]; nextOffset: number | null } { return this.tasksStore.board.boardQueuePage(repoPath, offset, limit); }
  boardTasks(limit: number): Task[] { return this.tasksStore.board.boardTasks(limit); }
  dueHoldTasks(nowMs = Date.now()): Task[] { return this.tasksStore.board.dueHoldTasks(nowMs); }
  prStateTasks(): Task[] { return this.tasksStore.board.prStateTasks(); }
  activeUiTasks(): Task[] { return this.tasksStore.board.activeUiTasks(); }
  queuedOriginGroups(): Array<{ owner: string; workspaceId: string | null; ids: ReadonlySet<string> }> { return this.tasksStore.board.queuedOriginGroups(); }
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
  static storedSchema(path: string, checkIntegrity = true): number | undefined { return StoreAdmission.storedSchema(path, checkIntegrity); }
  private static schemaIn(db: DatabaseSync, checkIntegrity = true): number { return StoreAdmission.schemaIn(db, checkIntegrity); }
  /** Compare native snapshots by every stored value and meaningful row order. */
  private static verifyMigrationSnapshot(source: DatabaseSync, snapshot: DatabaseSync): void { return StoreAdmission.verifyMigrationSnapshot(source, snapshot); }
  constructor(readonly path: string, backupDir?: string, onMigrationStart?: () => void) { this.admissionStore.initialize(path, backupDir, onMigrationStart); }
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
  beginMaintenanceWindow(): void { return this.admissionStore.beginMaintenanceWindow(); }
  /** Release the window's write funnels; the window's own writes are all committed. */
  endMaintenanceWindow(): void { return this.admissionStore.endMaintenanceWindow(); }
  /** True while a bounded maintenance window holds the write funnels closed. */
  get maintenance(): boolean { return this.maintenanceOpen; }
  /** The store's auto-vacuum mode as SQLite reports it (0 none, 2 incremental). */
  autoVacuumMode(): number { return this.reclaimStore.autoVacuumMode(); }
  /** The store's file and page facts, from one stat and three cheap pragmas. */
  storeFacts(): StoreFacts { return this.reclaimStore.storeFacts(); }
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
  contentFingerprint(): ContentFingerprint { return this.reclaimStore.contentFingerprint(); }
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
  reclaimFreedPages(options: { maxPages?: number; budgetMs?: number } = {}): ReclaimResult { return this.reclaimStore.reclaimFreedPages(options); }
  /** One truncating WAL checkpoint; `busy` reports a reader that kept the WAL in place. */
  checkpointWal(): { busy: number; log: number; checkpointed: number } { return this.reclaimStore.checkpointWal(); }
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
  /**
   * The exact text a lane-document pin names. A pin is resolved from the stored version it
   * was taken from and its digest is checked on every read, so a later document edit cannot
   * change it. A missing version, or bytes that do not match the pin, refuses: the current
   * document is never substituted. A legacy pin that still carries its own text keeps those
   * recorded bytes, which is what every reader saw before the pin was slimmed.
   */
  /** The observation-only fields and the write time that moved them, as one small row. */
  private syncTaskObservation(taskId: string, task: Task) { return this.taskWritesStore.syncTaskObservation(taskId, task); }
  /**
   * A pin as the row stores it: identity only when the lane document's stored version proves
   * the same bytes. A pin whose version cannot be proven keeps its recorded text inline rather
   * than being resolved to content it never named.
   */
  private numberedTask(data: string, parts?: StoredTaskParts): Task { return this.taskWritesStore.numberedTask(data, parts); }
  private resolveReviewRows(rows: Array<{ seq: number; data: string }>): Pick<Task["resolution"], "review" | "reviews"> { return this.taskWritesStore.resolveReviewRows(rows); }
  private storedReviewValue(value: unknown): unknown { return this.taskWritesStore.storedReviewValue(value); }
  /**
   * Writes one detached part's entries that differ from `before` and deletes the
   * ones `after` dropped. An ordinary update carries the same objects, so it
   * writes none.
   */
  /**
   * The task row as stored: everything but its brief versions and reviews (their own tables),
   * its referenced text and its observation-only
   * fields (`task_observations`). Audit B6: the row is the task's state, not its documents.
   */
  private taskRow(task: Task, before: Task | null = null): string { return this.taskWritesStore.taskRow(task, before); }
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
  activeCapacityTasks(): Task[] { return this.tasksStore.queue.activeCapacityTasks(); }
  admissionCandidates(task?: Task): Task[] { return this.tasksStore.queue.admissionCandidates(task); }
  lifecycleTasks(operationalOnly = false): Task[] { return this.tasksStore.lifecycleTasks(operationalOnly); }
  retirementTasks(taskId?: string): Task[] { return this.tasksStore.retirementTasks(taskId); }
  finishedHookTasks(): Task[] { return this.tasksStore.finishedHookTasks(); }
  hostProcessSweepTasks(): Task[] { return this.tasksStore.hostProcessSweepTasks(); }
  originRoutingTasks(operationalOnly = false): Task[] { return this.tasksStore.originRoutingTasks(operationalOnly); }
  originWorkspaces(): Map<string,string> { return this.tasksStore.board.originWorkspaces(); }
  pendingNotices(): Notice[] {
    return this.db.prepare("SELECT data FROM notices WHERE json_extract(data,'$.status') IN ('pending','intent') ORDER BY rowid")
      .all().map(row=>noticeSchema.parse(JSON.parse(String(row.data))));
  }
  /** Bridge lifecycle hints resolve through the task read model's exact identity lookup. */
  taskIdsForIdentities(input: { agentId?: string | null; workspaceId?: string | null; hostId?: string | null }): string[] { return this.tasksStore.taskIdsForIdentities(input); }
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
  promoteQueuedTask(task:Task,actor="operator control"):Task { return this.submissionsStore.promoteQueuedTask(task, actor); }
  dependencyWait(task: Pick<Task,"dependsOn">): string { return this.tasksStore.dependencyWait(task); }
  taskOrNull(id: string): Task | null { return this.tasksStore.taskOrNull(id); }
  purgeOldTasks(at=Date.now(),cleanupFiles?:(taskId:string,runIds:string[])=>void) { return this.retentionStore.purgeOldTasks(at, cleanupFiles); }
  /**
   * Audits B5: the tasks the next purge would delete, so the caller can reap their owned
   * hook checkouts first. This is the same retention fact the purge re-checks inside its
   * transaction; a task that changes in between simply keeps its history for one more pass.
   */
  retentionCandidates(at=Date.now()): Task[] { return this.retentionStore.retentionCandidates(at); }
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
    if (queued && this.tasksStore.board.queuedLaneStatsValid) this.tasksStore.board.indexQueuedLanes(queued);
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
    if (queued && this.tasksStore.board.queuedLaneStatsValid) this.tasksStore.board.indexQueuedLanes(queued);
    this.advanceTelemetryRevision(); this.taskChanged(row.taskId);
  }
  events(taskId: string) { return this.db.prepare("SELECT * FROM events WHERE taskId=? ORDER BY id DESC LIMIT 100").all(taskId) as { id: number; taskId: string; at: string; kind: string; detail: string }[]; }
  eventsAll(taskId: string) { return this.db.prepare("SELECT * FROM events WHERE taskId=? ORDER BY id").all(taskId) as { id: number; taskId: string; at: string; kind: string; detail: string }[]; }
  /**
   * Schema 54 (task 989): stored rows lose their retired fields and the store loses the
   * `workspace_creation_step_*` events, which nothing reads. Runs on every open, idempotently:
   * the one-time backlog (outcomes still carrying `routing.capability`, tasks carrying the
   * retired defaults, runs and QA runs carrying the write-only fields) and any row a
   * rolled-back older build wrote during its window are one rule set. A clean store is
   * scanned and left byte-identical. The old reader functions went with the step: the
   * outcome `routing.capability` → `scope` rewrite above is the last legacy reader.
   */
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
  pruneRetainedHistory(cutoff = new Date(Date.now() - HISTORY_RETENTION_MS).toISOString(), batch = 2000): Promise<{ journal: number }> { return this.retentionStore.pruneRetainedHistory(cutoff, batch); }
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
  pruneRetainedRows(at: number): RetainedRowPrune { return this.retentionStore.pruneRetainedRows(at); }
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
  pendingRuns(): Run[] { return this.tasksStore.pendingRuns(); }
  runsForTasks(taskIds: string[]): Run[] { return this.tasksStore.runsForTasks(taskIds); }
  run(id: string): Run | null { return this.tasksStore.run(id); }
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
  /** Spec 019 revision: one index row per task and lane, rebuilt from the outcome row. */
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
  laneByKey(key: string): Lane | null { return this.lanesStore.laneByKey(key); }
  lanes(): Lane[] { return this.lanesStore.lanes(); }
  requireAttachableLanes(keys: string[], repoPath: string, origin?: string | null): Lane[] { return this.lanesStore.requireAttachableLanes(keys, repoPath, origin); }
  /** The denormalised prompt/detail context for a task's lane list, in membership order. */
  upsertLane(input: { key: string; title: string; aim: string; repositories: Lane["repositories"] }): Lane { return this.lanesStore.upsertLane(input); }
  setLaneStatus(key: string, status: Lane["status"], note = ""): Lane { return this.lanesStore.setLaneStatus(key, status, note); }
  /**
   * Spec 041: keep answers a lane's drain prompt. The required reason ends the episode
   * (and restarts the drain window from now); the keep stays on the lane as the answer.
   */
  keepLane(input: { key: string; reason: string; author: string }): Lane { return this.lanesStore.keepLane(input); }
  /** Writes a lane's drain episode without touching its activity timestamp, so the evaluation never resets its own window. */
  setTaskLanes(task: Task, keys: string[], origin?: string | null): Task { return this.lanesStore.setTaskLanes(task, keys, origin); }
  /** Spec 022: a repository settings row is keyed by the repository identity — origin when known, else the local path. */
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
  putRepository(identity: RepositorySettings["repository"], closeout: ProjectCloseout | null, note: string, validation: ProjectValidation | null = null, reviewer: RepositorySettings["reviewer"] = null, qa: ProjectQa | null = null, checksPolicy: RepositorySettings["checksPolicy"] | undefined = undefined, scratchNamespace?: string | null, hostKind?: import("../../shared/host-kind").HostKind, affectedTests?: RepositorySettings["affectedTests"]): RepositorySettings { return this.projectsStore.putRepository(identity, closeout, note, validation, reviewer, qa, checksPolicy, scratchNamespace, hostKind, affectedTests); }
  /** Patch semantics: only the named fields change; `null` clears one and an absent field keeps its stored value. Returns the full resulting row. */
  patchRepository(identity: RepositorySettings["repository"], patch: { scratchNamespace?: string | null; closeout?: ProjectCloseout | null; validation?: ProjectValidation | null; reviewer?: RepositorySettings["reviewer"]; qa?: ProjectQa | null; affectedTests?: RepositorySettings["affectedTests"]; checksPolicy?: RepositorySettings["checksPolicy"]; hostKind?: import("../../shared/host-kind").HostKind; note?: string }): RepositorySettings { return this.projectsStore.patchRepository(identity, patch); }
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
  projectManagementPreview(input: {key: string; target?: string}): ProjectManagementPreview { return this.projectsStore.projectManagementPreview(input); }
  resetProjectCancellation(input: {key:string;operationId:string;tasks:Array<{taskId:string;version:number}>}) { return this.projectsStore.resetProjectCancellation(input); }
  manageRemoveProject(input: ProjectManageInput): ProjectTombstone { return this.projectsStore.manageRemoveProject(input); }
  removalBlockers(key: string, repository?: string): ProjectRemovalBlocker[] { return this.projectsStore.removalBlockers(key, repository); }
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
  /**
   * nucleus#984: what a move would refuse on, and what it carries along. A move
   * takes every record attached to the moving repositories with them (tasks,
   * leads, papercuts, lanes, drafts, submissions, decisions, QA history), so
   * those are `carried`, not blockers. Only state that can't change projects
   * mid-flight blocks: a queued or running project QA, or an in-flight
   * repository re-key, on a moving repository.
   */
  mergeCheck(input: ProjectMergeCheckInput): ProjectMergeCheck { return this.projectsStore.mergeCheck(input); }
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
  laneViews(query: { status?: Lane["status"]; repository?: string } = {}): LaneView[] { return this.lanesStore.laneViews(query); }
  /**
   * Lane views are derived from lanes, outcomes, live task phases and event times only, so they
   * are rebuilt once per `laneViewRevision()` change and served from cache in between. The value
   * is never stored inside a transaction: a rollback rewinds the rows the views came from.
   */
  /**
   * The newest event time per task, loaded once and maintained by `event()`. A write that
   * bypassed the funnel (a backdated fixture, a repair) moves the `eventRows` clock, and the
   * map is then rebuilt from the rows rather than answered from memory.
   */
  /**
   * Spec 019: one outcome-by-lane index, built once from the permanent rows and extended by
   * `insertOutcomeRow`. A row written outside that funnel moves the `outcomeRows` clock, and
   * the index is then rebuilt from the rows.
   */
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
  /** The task and run write funnels; see `store-task-funnel.ts` for the rules they own. */
  insert(input: Submission, hostId: string, handoffText: string, planningBase: string, initial: Partial<Task> = {}, credential?: {runId:string;token:string;prepare?:(task:Task)=>void}, origin?: string | null): Task { return this.funnel.insert(input, hostId, handoffText, planningBase, initial, credential, origin); }
  update(id: string, change: Partial<Task> & { attention?: never }, kind?: string, detail = "", expected?: number): Task { return this.funnel.update(id, change, kind, detail, expected); }
  putRun(run: Run, options: { usageOnly?: boolean } = {}): void { return this.funnel.putRun(run, options); }
  setRuntimeRetirements(id: string, records: RuntimeRetirement[]) { return this.funnel.setRuntimeRetirements(id, records); }
  setBudgetClock(id: string, budgetClock: BudgetClock): Task { return this.funnel.setBudgetClock(id, budgetClock); }
  updateRunUsage(runId: string, apply: (usage: NonNullable<Run["usage"]>) => NonNullable<Run["usage"]>): boolean { return this.funnel.updateRunUsage(runId, apply); }
  appendProofFiles(taskId: string, records: Task["proofFiles"]): Task { return this.funnel.appendProofFiles(taskId, records); }
  acceptCompletion(input: Completion, token: string, pr: { url: string; head: string } | null, options: { armedReplacement?: boolean } = {}) { return this.funnel.acceptCompletion(input, token, pr, options); }
  /**
   * The same unrun review-entry fact, read by the owner closeout reconciliation (task 408):
   * a queued review-entry task that never dispatched is the one shape whose own PR may have
   * merged outside Queue before any reviewer existed.
   */
  reviewEntryUnrunBeforeFirstRun(task: Task, enclosing?: VerifiedEnclosingOperation): boolean {
    return reviewEntryUnrun(this.reviewEntryFacts, task, enclosing);
  }
  /** The dependency boundary; `store-prerequisites.ts` owns its admission rules. */
  updateDependencies(task: Task, dependsOn: string[], actor = "operator control"): Task { return this.prerequisites.updateDependencies(task, dependsOn, actor); }
  setPrerequisiteWait(task: Task, waitsFor: string[], reason: string, expectedVersion = task.version): Task { return this.prerequisites.setPrerequisiteWait(task, waitsFor, reason, expectedVersion); }
  reconcilePrerequisiteWait(taskId: string): "none" | "waiting" | "released" { return this.prerequisites.reconcilePrerequisiteWait(taskId); }
  /** Resolve only the admitted version, using immutable task/outcome approval, never today's check. */
  sourcePromotionResult(source: { kind: "lead" | "papercut"; id: string }, repository: string,
    version: number | null, sourceDigest: string): OperationResult | null { return this.promotion.sourcePromotionResult(source, repository, version, sourceDigest); }
  /** Source link and task admission commit together; retries resolve the same task. */
  promoteSource(source: { kind: "lead" | "papercut"; id: string }, repository: string, approvedDigest: string, expectedSource: string,
    submission: Submission, hostId: string, planningBase: string, origin: string | null, initial: Partial<Task> = {}): Task | OperationResult {
    return this.promotion.promoteSource(source, repository, approvedDigest, expectedSource, submission, hostId, planningBase, origin, initial); }
  /** A review entry may bind only a Queue-held brief whose exact checked approval still exists. */
  validateReviewEntryBrief(input: Submission, githubRepository: string): void { return this.promotion.validateReviewEntryBrief(input, githubRepository); }
  /** Consume the approved source and link it to the review task in its binding transaction. */
  claimReviewEntryBrief(input: Submission, githubRepository: string, taskId: string): void { return this.promotion.claimReviewEntryBrief(input, githubRepository, taskId); }
  /** Task numbering; `store-task-numbers.ts` owns the counter and the reference lookup. */
  private assignNumber(taskId: string, repository: string): { number: number; reference: string } { return this.numbers.assign(taskId, repository); }
  numberFor(taskId: string): { number: number; reference: string } | null { return this.numbers.numberFor(taskId); }
  taskRepositories(): Array<{ taskId: string; repository: string }> { return this.numbers.repositories(); }
  taskIdByNumber(input: { reference?: string; repository?: string; number?: number }): string { return this.numbers.taskIdByNumber(input); }
  resolveTaskId(identity: string): string { return this.numbers.resolve(identity); }
  /** A thread's durable archive effect; `store-thread-effects.ts` owns the key and its leaves. */
  threadArchiveKey(agentId: string, hostId: string | null | undefined): string | null { return this.threadEffects.archiveKey(agentId, hostId); }
  putThreadArchiveEffect<T extends { status: string; at: string }>(key: string, _agentId: string, effect: T): void { return this.threadEffects.putArchiveEffect(key, effect); }
  threadArchiveEffect(agentId: string, hostId?: string | null): { status?: string } | undefined { return this.threadEffects.archiveEffect(agentId, hostId); }
  retireThreadScratch(taskId: string, agentId: string): number { return this.threadEffects.retireScratch(taskId, agentId); }
  /** Finished tasks on this host whose threads still owe an archive or removal; `store-thread-effects.ts` owns the keys. */
  finishedTasksOwingThreadCleanup(hostId: string, removal: boolean): Task[] { return this.threadEffects.finishedTasksOwingCleanup(hostId, removal); }
}
