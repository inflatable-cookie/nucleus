import { stopClearedPatch } from "../shared/task-stop";
import { recordedLegacyPaseoHost } from "./host/host-registry";
import { enginePorts, portsContext } from "./port-context";
import {
  settleWorkspaceCreation,
  type WorkspaceSettlement,
} from "./recovery/workspace-lookup";
import { onOwnerHost } from "./host/host-ports";
import { TaskControlLifecycle } from "./verbs/task-control-lifecycle";
import { recordAcceptedRevisionRound } from "./verbs/author-revision-cap";
import { EngineStop } from "./recovery/engine-stop";
import { ProjectLifecycle } from "./planning/project-lifecycle";

import { PrerequisiteReleases } from "./scheduling/prerequisites";
import {
  QUANTUM_TOTAL_READ_BUDGET_MS,
  runInTaskQuantumScope,
} from "./scheduling/pass-snapshot";
import { TaskQuantum } from "./scheduling/task-quantum";

import { unavailableGroupNames } from "../shared/pool";

import { Dispatch } from "./dispatch/dispatch";
import { combineWorkerHostProfiles } from "./dispatch/first-host-selection";
import { independentReviewRoutingConflict } from "./dispatch/routing";
import { taskNeverDispatched } from "./task-decision-rules";
import { hostUnavailableDetail } from "../shared/host-outage";
import type { GitTransientEpisode } from "./git/git-transient-backoff";

import { type WorkspaceDiscard } from "./workspaces/orphan-worktree";
import {
  HOST_KIND_LABELS,
  effectiveDefaultHostKind,
  hostKindOf,
  type HostKind,
  type IdentitySource,
} from "../shared/host-kind";
import { RecoverySettlement } from "./recovery/coordinator-settlement";
import { settleResponsibleFault } from "./recovery/responsible-fault";
import {
  deadParticipantProof,
  releaseDeadParticipant,
  retireGoneRetainedWorker,
} from "./recovery/dead-participant";
import { Decisions } from "./planning/decisions";
import type { RepositoryRekeyInput } from "../shared/repository-rekey";


import { z } from "zod";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import type { AcpSessionSurface } from "../shared/acp/surface";
import type {
  Task,
  Profile,
  Completion,
  CheckpointResult,
  Run,
  RecoveryActionBinding,
  BulkDisposition,
  BulkDispositionRequest,
  ReparentInput,
  OwnerInventory,
  OwnerInventoryInput,
  WorkspaceArchiveRetry,
} from "../shared/contracts";
import { isTransportFailure } from "../shared/transport";

import { type TaskStopReason, type TaskStopVerb } from "../shared/task-stop";
export { capacityFor, occupiesSlot } from "./dispatch/capacity";
import { capacityFor, occupiesSlot } from "./dispatch/capacity";
export { isTransportFailure };
import {
  DEFAULT_UNCERTAIN_MERGE_RETRY_MS,
  ownerCandidateKind,
} from "../shared/contracts";
import { buildProjectSettings } from "./planning/project-settings";

import { DispatchAdmission } from "./dispatch/admission";
import { Store, digest, now } from "./store/store";
import type { Adapter, AgentObservation } from "./host/adapter";
import { routeHostAdapter } from "./host/adapter-routing";
import { HostFacade } from "./host/host-facade";
import { taskIdFromLaneKey } from "./host/lane-host";
import { ProfileCatalogs } from "./host/profile-catalogs";

import type { TaskControlInput, TaskControlRequest } from "../shared/contracts";
import type { TaskControlTask } from "../shared/contracts";
import { Dispositions, type DispositionRequest } from "./verbs/disposition";

import type {
  OperationAcceptance,
  OperationResult,
  QueueOperation,
} from "../shared/operations";

import { stopThreads } from "../shared/contracts";
import type { Submission } from "../shared/contracts";

import { controlHasExternalEffect } from "./verbs/control-decisions";
export { controlHasExternalEffect } from "./verbs/control-decisions";
export { workspaceAdmissionGapMs } from "./workspaces/admission-decisions";
export { queuedDispatchOrder } from "./dispatch/queue-order";
export { PROFILE_CATALOG_LOADING_REFUSAL, PROFILE_CATALOG_PENDING_REASON };
// Moved to operations.ts; re-exported because engine.ts exported it.
export { SOURCE_PROMOTION_NOT_DELIVERED };
export { ExternalMergeRefusal };
/**
 * Bounded lane scheduler bounds (Spec 012). Independent keys may await remote
 * effects concurrently, but one key holds exactly one active quantum so a task
 * or operation never races itself. Acceptance never waits for a running pass.
 */
// Queue reads do not use these lanes and remain responsive while unrelated
// remote effects are in flight. The outbound budget lives on the resources
// themselves (admission for Paseo calls, a spawn gate for processes).
/** Lane keys started per event-loop turn. There is no concurrency cap; this only bounds how much synchronous start work one turn performs. */
// Created at module initialization, before any engine quantum or control exists.
// Every detached boundary and newly dispatched quantum starts from this scope,
// so even context owned outside Engine cannot leak into unrelated work.
const cleanLaneScope = new AsyncResource("nucleus-lane-root");

export { chooseProfile } from "./dispatch/routing";
import { chooseProfile, type RoutingPreflightInput } from "./dispatch/routing";
import { Lifecycle } from "./closeout/workspace-lifecycle";

import { ControlContext } from "./verbs/control-context";
import { LaneScheduler } from "./scheduling/lane-scheduler";
import { VerbFences } from "./verbs/verb-fences";
import { AgentControls } from "./verbs/agent-controls";
import { BriefControls } from "./verbs/brief";
import { ExternalMergeRefusal, MoveControls } from "./verbs/moves";
import { RestartControls } from "./verbs/restart";
import { WorkerRestarts } from "./verbs/restart-worker";
import { ReviewRestarts } from "./verbs/restart-review";
import { StalledTurnStops } from "./verbs/stalled-turn-stop";
import { RetryEffectControls } from "./verbs/retry-effect";
import { ArchiveEffectRetries } from "./verbs/retry-effect-archive";
import { OrdinaryEffectRetries } from "./verbs/retry-effect-ordinary";
import { CallbackIntake } from "./intake/callback-intake";
import {
  WorkerReconcile,
  completionReportsPr,
  INTERACTIVE_RUNNING_REASON,
  INTERACTIVE_WAIT_REASON,
} from "./recovery/worker-reconcile";
import { WorkerFailover } from "./dispatch/worker-failover";
import {
  RetiredObservations,
  RETIRED_OBSERVATION_INTERVAL_MS,
  RETIRED_OBSERVATION_STALE_MS,
} from "./recovery/retired-observation";
import { replacementCeilingRefusal } from "./recovery/worker-replacement";
import { archiveRetiredErroredAgents } from "./workspaces/retired-agent-archive";
import {
  Operations,
  SOURCE_PROMOTION_NOT_DELIVERED,
} from "./planning/operations";
// Moved to worker-failover.ts; re-exported because engine.ts exported them.
export { RETIRED_OBSERVATION_INTERVAL_MS, RETIRED_OBSERVATION_STALE_MS };
// Moved to worker-reconcile.ts; re-exported because engine.ts exported them.
export {
  completionReportsPr,
  INTERACTIVE_RUNNING_REASON,
  INTERACTIVE_WAIT_REASON,
};
import { TaskControlDispatcher } from "./verbs/dispatcher";

import { ReviewerControls } from "./verbs/reviewer";
import type { ExhaustedReviewerReplacement } from "./verbs/reviewer-report";
import { TaskCompletion } from "./verbs/complete";
import { SettingsControls } from "./verbs/settings";
import { ForceVerbs } from "./verbs/force";
import { OwnerStop } from "./verbs/owner-stop";
import { DeferredOwnerVerbs } from "./verbs/deferred-verbs";
import { BriefAmendmentDelivery } from "./verbs/brief-amendment";
import { ReviewerAutoContinue } from "./verbs/reviewer-auto-continue";
import type { RestartRequest } from "./verbs/owner-shared";
import { PausedStops } from "./verbs/paused-stops";
import { ProofControls } from "./verbs/proof";
import { RouteControls } from "./verbs/route";
import { TaskRemoval } from "./verbs/removal";
import { WorkerLauncher } from "./dispatch/worker-launcher";
import { WorkspaceProvisioning } from "./workspaces/workspace-provisioning";
import { CleanupLane } from "./closeout/cleanup-lane";
import { RetirementLane } from "./runtime/retirement-lane";
import {
  ProjectionOccurrences,
  drainProjectionCut,
} from "./scheduling/projection-occurrences";
import { WorkspaceTitleProjection } from "./workspaces/workspace-title-projection";
import { Resolution } from "./resolution";
import {
  PROFILE_CATALOG_LOADING_REFUSAL,
  PROFILE_CATALOG_PENDING_REASON,
} from "./recovery/task-reasons";
import { reportingIdentityMismatch } from "./intake/reporting-identity";
import {
  RepositoryHooks,
  hookHoldReason,
  type HookEmissionResult,
} from "./hooks/hooks";
/** Pre-dispatch gates re-run automatically after main fast-forwarded under them; beyond this a human decides. */
export const PRE_DISPATCH_BASE_ADVANCE_LIMIT = 3;
import { RuntimeRetirementService } from "./runtime/runtime-retirement";
import { admissionOf } from "./host/admission";

import type { ReconciliationSweep } from "../shared/telemetry";

import {
  type OwnerEffect,
  type RouteRole,
  type RestartRole,
} from "./verbs/owner-verbs";
import { RunRelease } from "./recovery/fence-settlement";
import { Sweep } from "./scheduling/sweep";
import { HostOutages } from "./scheduling/host-outage";
import { HostHealth, healthWait } from "./scheduling/host-health";
import { TaskWakes } from "./scheduling/task-wakes";
import { CompletionFollowUps } from "./closeout/completion-follow-ups";
import { DecisionNoticeDelivery } from "./questions/decision-notices";

import { TerminalWorkspaceRetirement } from "./closeout/terminal-workspace-retirement";
import { createStoreWorkspaceAllocationBridge } from "./workspaces/workspace-allocation-bridge";
import { verifyBargeLeaseAndCustody } from "./workspaces/barge-allocator";

export const STOPPED_BEFORE_DRAIN = () =>
  new Error(
    "Nucleus engine stopped before the requested reconciliation drain covered the fleet",
  );

export class Engine {
  /** Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): the durable host-outage record. */
  readonly hostOutages: HostOutages;
  /** Spec 069 §2: each host's health, read from its connection alone. */
  readonly hostHealth: HostHealth;
  /**
   * Spec 065: the ACP session surface. The runtime attaches it once the callback
   * socket exists (an ACP binding points the agent at that socket); a process
   * without one refuses `acp.bind` rather than minting a binding nothing answers.
   */
  acp: AcpSessionSurface | null = null;
  readonly taskControlLifecycle = new TaskControlLifecycle(
    portsContext(this, [
      "store",
      "resolveTaskControl",
      "hostAvailable",
      "withHost",
      "taskControlDispatcher",
      "resolution",
      "forceCallerAuthorized",
      "selfForceRole",
    ]),
  );

  readonly engineStop = new EngineStop(
    portsContext(this, ["resolution", "store"]),
  );

  readonly projectLifecycle = new ProjectLifecycle(
    portsContext(this, [
      "adapter",
      "activeHostId",
      "host",
      "store",
      "plannerTicketPending",
      "resolution",
    ]),
  );

  readonly prerequisiteReleases = new PrerequisiteReleases(
    portsContext(this, [
      "cleanContext",
      "pendingPrerequisiteReleases",
      "prerequisiteReleaseWork",
      "refreshCheckoutSiblings",
      "scheduleLane",
      "stopped",
      "store",
      "wakeRepository",
      "wakeTask",
    ]),
  );

  readonly taskQuantumOwner = new TaskQuantum(
    enginePorts(
      this,
      [
        "acceptWorkerResult",
        "adapter",
        "cleanContext",
        "enqueueCleanup",
        "enqueueTitle",
        "hooks",
        "hostAvailable",
        "launchAgent",
        "launchProofOnly",
        "moveToReview",
        "moveToWork",
        "note",
        "noteStepFailure",
        "observeOwnerStop",
        "preferredHostKindsForTask",
        "prerequisiteWaitYieldsToLiveWork",
        "profileCatalogKnown",
        "profileCatalogKnownFor",
        "profiles",
        "profilesFor",
        "quantumFinish",
        "quantumSteps",
        "reconcile",
        "reconcileClosedRetainedReviewer",
        "recoverExistingWorkspace",
        "settleWorkspaceCreation",
        "scheduleLane",
        "settleFinishedRuns",
        "settleHistoricalProofExecutions",
        "settleRunBuildOutputs",
        "settleSupersededIdleRuns",
        "routingDecisions",
        "stopped",
        "store",
        "wakeRepository",
        "workerHostCatalogPending",
        "workerHostCatalogs",
        "workerRoutingProfiles",
      ],
      [
        "adapter",
        "advance",
        "beginValidationScanPass",
        "graceMs",
        "hostAvailable",
        "onTaskHost",
        "store",
        "holdProofOnlyGoWait",
        "owns",
        "quantumReadBudgetMs",
        "quantumReadTimeoutMs",
        "raiseOperatorQuestions",
        "reconcileHoldUntil",
        "recordStop",
        "recoverExternalMerge",
        "recovery",
        "resumeClearedAttention",
        "resumeRoundTells",
        "settleBudgetClock",
        "settleSettledWaitStop",
        "slotAdmissionReason",
        "update",
        "waiting",
      ],
    ),
  );

  private readonly hostContext = new AsyncLocalStorage<string>();
  get activeHostId(): string | undefined {
    return this.hostContext.getStore();
  }
  resolveHostAdapter: (id: string) => Adapter | undefined = () => undefined;
  inventoryHostMatches: (id: string) => boolean = () => true;
  retiredObservationKey: (id: string) => string = () => "retiredObservations";
  canReuseUnqualifiedOriginWorkspace: () => boolean = () => true;
  identifyOriginHost: (
    agentId: string,
    identitySource?: IdentitySource,
  ) => Promise<string | undefined> = async () =>
    this.activeHostId ?? this.selectIngressHost();
  withHost<T>(id: string, fn: () => T): T {
    return this.hostContext.run(id, fn);
  }
  /**
   * Every host call that names a task's or a run's own agent runs on that
   * owner's host (#1154), read from one rule shared with `Resolution`
   * (`core/host/host-ports.ts`). A stored agent id is native, so a call made in no
   * host context unwraps it against the default host — the class #1128 and
   * #1130 fixed for identity and origin lookups. Reads the owner's recorded
   * `hostId`, never a caller's claim; an owner with no proven host keeps the
   * ambient context.
   */
  onTaskHost<T>(
    owner: { hostId?: string | null } | null | undefined,
    work: () => T,
  ): T {
    return onOwnerHost(this, owner, work);
  }
  /**
   * The host a lane quantum's transport belongs to. A lane runs outside the
   * caller's async context (`cleanContext`), so the ambient host would be lost
   * and every agent-naming call inside it would go to the default host. A
   * task-keyed lane names its task's host outright; any other lane keeps the
   * host the scheduling call ran on.
   */
  private laneHost(key: string): string | undefined {
    const taskId = taskIdFromLaneKey(key);
    if (taskId) {
      const hostId = this.store.taskOrNull(taskId)?.hostId;
      if (hostId) return hostId;
    }
    return this.activeHostId;
  }
  /** Registered and connected, independent of the ambient host context; the identity-routing read. */
  hostOnline(id: string): boolean {
    return Boolean(this.resolveHostAdapter(id));
  }
  /** The recorded legacy Paseo primary, never a guess from the caller's ID. */
  legacyPaseoHostId: () => string | undefined = () =>
    recordedLegacyPaseoHost(this.store);
  /** Runtime supplies the authenticated live-host selection at acceptance. */
  selectIngressHost: (
    explicit?: string,
    repoPath?: string,
    origin?: string | null,
    plannerHostId?: string,
  ) => string | undefined = (explicit) =>
    explicit ?? this.store.getMeta<string>("hostId") ?? undefined;
  selectIngressSelection: (
    explicit?: string,
    repoPath?: string,
    origin?: string | null,
    plannerHostId?: string,
  ) => import("../shared/host-selection").HostSelection | undefined = () =>
    undefined;
  hostAvailable: (id: string) => boolean = () => true;
  /** Diagnostic tripwire for a host port read with no host context (`routeHostAdapter`). */
  unboundPortRead?: (port: string) => void;
  /** Registered, online host suitable for authenticated ingress; may not be a work host. */
  hostIngressAvailable: (id: string) => boolean = () => true;
  /**
   * Spec 069 §2: the wait a never-started task shows while its host admits no new
   * first dispatch (down or unknown, or degraded with a launch already in flight),
   * or null when it may launch. The rule itself is HostHealth's.
   */
  hostLaunchWait(hostId: string, taskId?: string): string | null {
    return this.hostHealth.launchWait(hostId, taskId);
  }
  /**
   * The runtime tick's reading of every registered host, made even when no host
   * is connected and the sweep does not run: `unknown` becomes `down` on time and a
   * long outage raises its planner notice. Nothing is sent to any host.
   */
  observeHostHealth(): void {
    for (const id of this.hostIds()) this.hostHealth.read(id);
    this.hostOutages.raiseNotices();
  }

  taskHostAvailable(task: Task): boolean {
    return Boolean(
      task.hostId &&
        (!this.activeHostId || this.activeHostId === task.hostId) &&
        this.hostAvailable(task.hostId) &&
        this.store
          .runs(task.id)
          .every(
            (run) =>
              run.hostId === task.hostId ||
              (run.released && Boolean(run.hostId)),
          ),
    );
  }
  /**
   * Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait). The sweep visit's
   * reading of one task's host (Spec 069 §2, §3). It reads the host's health, the
   * one place a host's state moves, and writes nothing for an outage:
   *
   * - A `down` host returns the outage's wait. Nothing is recorded on the task:
   *   the card, `next`, detail and budget all work the wait out from the host's
   *   own outage record when they are read (`inFlightHostWait`,
   *   `hostOutageIntervals`), so an outage costs one write, not one per task.
   * - A host that is `unknown` (not yet read since the service started) returns
   *   its wait and writes nothing: the task keeps its state, unvisited.
   * - A connected host (`up` or `degraded`) settles any host-scoped wait the task
   *   still stores, a transport deferral or a wait an older version recorded
   *   (`clearHostWait`, which writes only when there is one), and returns null. The
   *   ordinary observation pass then re-proves every retained thread before the
   *   task sends anything again.
   *
   * Returns the detail while waiting, or null when the task's host is connected
   * (or it has no host identity, which is a different, existing wait).
   */
  hostWait(task: Task): string | null {
    const hostId = task.hostId;
    if (!hostId || task.phase === "done" || task.phase === "cancelled")
      return null;
    if (this.unboundOnOtherHost(task)) {
      this.resolution.clearHostWait(task);
      return null;
    }
    const health = this.hostHealth.read(hostId);
    if (health.state === "unknown") return healthWait(hostId, health);
    if (health.state !== "down") {
      this.resolution.clearHostWait(task);
      return null;
    }
    return this.outageDetail(hostId, health.since);
  }
  /**
   * Spec 069 §3: a started task's host wait, worked out when the board, `next`,
   * task detail or a notice is read. It never writes and never moves the host's
   * state (`peek`): the wait exists while the task's host is `down`, dated from
   * the host's own outage record. A queued task's waits are the admission read's
   * (`queuedExternalWait`); an `unknown` host shows no wait, so a service start
   * never parks a task.
   */
  inFlightHostWait(
    task: Task,
  ): { hostId: string; since: string; detail: string } | null {
    const hostId = task.hostId;
    if (
      !hostId ||
      task.phase === "queued" ||
      task.phase === "done" ||
      task.phase === "cancelled" ||
      this.unboundOnOtherHost(task)
    )
      return null;
    const health = this.hostHealth.peek(hostId);
    if (health.state !== "down") return null;
    const since = this.hostOutages.current(hostId)?.since ?? health.since;
    return { hostId, since, detail: hostUnavailableDetail(hostId, since) };
  }
  /** A never-dispatched worker has only a host preference; an offline one cannot fence another online host. */
  private unboundOnOtherHost(task: Task): boolean {
    const hostId = task.hostId;
    return (
      this.firstWorkerUnbound(task) &&
      this.hostIds().some((id) => id !== hostId && this.workerHostReady(id))
    );
  }
  /** HostHealth opened the outage on its transition; its start dates the wait. */
  private outageDetail(hostId: string, fallbackSince: string): string {
    const since = this.hostOutages.current(hostId)?.since ?? fallbackSince;
    return hostUnavailableDetail(hostId, since);
  }
  private sweepOwner?: Sweep;
  private get sweep(): Sweep {
    return (this.sweepOwner ??= new Sweep(
      enginePorts(
        this,
        [
          "adapter",
          "applyDeferredOwnerVerbs",
          "deliverPendingBriefAmendments",
          "archiveRetiredErroredAgents",
          "auditPass",
          "clearRetiredInvalidations",
          "continueAwaitingReviewers",
          "dispatchQueued",
          "dispositionDeps",
          "drainProjections",
          "drainWaiters",
          "enqueueTitle",
          "ensureSweep",
          "flushPrerequisiteReleases",
          "host",
          "hostAvailable",
          "hostHealth",
          "hostIds",
          "hostOutages",
          "hostWait",
          "inventoryHostMatches",
          "lifecycle",
          "maxSweepWindows",
          "migrateProjectOwnersToPlanners",
          "noteStepFailure",
          "observeRetiredWorkers",
          "quiesce",
          "reconcile",
          "recoverExhaustedWorkers",
          "removeSiblings",
          "replaceExhaustedReviewers",
          "resumePausedStops",
          "retiredObservationKey",
          "retiredObservationPlan",
          "scheduleLane",
          "scheduleLifecycleFollowUp",
          "scheduleTaskQuantum",
          "settleQuiesce",
          "startSweepChain",
          "stopped",
          "store",
          "sweepChain",
          "sweepCursor",
          "sweepMode",
          "sweepOrder",
          "sweepPending",
          "sweepStats",
          "taskHostAvailable",
          "wakeCapacityWaiter",
          "wakePreludes",
          "withHost",
        ],
        [
          "beginPassSnapshot",
          "checkpoints",
          "delegateNativeQuestions",
          "delegation",
          "deliverDrainNotices",
          "deliverHoldNotices",
          "deliverHostOutageNotices",
          "deliverNotices",
          "deliverRowHiddenNotices",
          "deliverQueuedMessages",
          "endPassSnapshot",
          "hostPassWarmBudgetMs",
          "markPassTimelineBudgetExhausted",
          "takePassProofs",
          "observationTargets",
          "observe",
          "origins",
          "primePassProcesses",
          "primePassTimeline",
          "primePassTimelinePage",
          "raiseOperatorQuestions",
          "recordPassHostInventory",
          "recordPassHostObservation",
          "sealPassHost",
          "storePassTimelinePage",
          "recovery",
          "resumeAskQuestions",
          "resumeResponsibleAnsweredQuestions",
          "refreshResponsibleThreads",
          "settleBudgetClock",
        ],
      ),
    ));
  }
  readonly dispatchOwner = new Dispatch(this);
  private readonly dispatchAdmission = new DispatchAdmission({
    store: () => this.store,
    adapter: () => this.adapter,
    admission: () => this.admission,
    profileCatalogKnown: () => this.profileCatalogKnown(),
    withHost: (id, fn) => this.withHost(id, fn),
    hostAvailable: (id) => this.hostAvailable(id),
    workspacePressureWait: (task) => this.workspacePressureWait(task),
    hostIds: () => this.hostIds(),
    hostOutageSince: (id) => this.hostOutages.current(id)?.since ?? null,
    firstWorkerUnbound: (task) => this.firstWorkerUnbound(task),
    taskHostAvailable: (task) => this.taskHostAvailable(task),
    originHostAvailable: (id) => this.resolution.originHostAvailable(id),
    targetHostWait: (task) => this.targetHostWait(task),
    workerHostIds: (task) =>
      this.workerHostCatalogs(task).map((host) => host.hostId),
    // Board reads only: they peek, so a read never moves a host or writes its outage.
    hostHealthState: (id) => this.hostHealth.peek(id).state,
    hostLaunching: (id) => this.hostHealth.launching(id),
    hostLaunchWait: (id, taskId) => this.hostLaunchWait(id, taskId),
  });
  private profilesValue: Profile[] = [];
  get profiles(): Profile[] {
    return this.profilesValue;
  }
  set profiles(value: Profile[]) {
    this.profilesValue = value;
    this.catalogs?.overrideProfiles(value);
  }
  stopped = false;
  /**
   * Spec 027: Queue data directory for sibling worktrees
   * (`siblings/<taskId>/<repository name>`). Set by the runtime owner; null
   * skips sibling creation (tests and adapters without a data directory).
   */
  siblingDataDir: string | null = null;
  private readonly controlContext = new ControlContext();
  // Tests and `verbs/agent-controls.ts` reach these by name; these go with the delegates in F2.
  get selfForceRunId() {
    return this.controlContext.selfForceRunId;
  }
  get coordinatorActionRunId() {
    return this.controlContext.coordinatorActionRunId;
  }
  get revisionCapAcceptance() {
    return this.controlContext.revisionCapAcceptance;
  }
  get replayingDeferredVerb() {
    return this.controlContext.replayingDeferredVerb;
  }
  // Test-facing state remains accessible through Engine until delegates are removed.
  get lastHookCleanupAt() {
    return this.sweep.lastHookCleanupAt;
  }
  set lastHookCleanupAt(value: number) {
    this.sweep.lastHookCleanupAt = value;
  }
  get sweepCursor() {
    return this.sweep.sweepCursor;
  }
  set sweepCursor(value: string | null) {
    this.sweep.sweepCursor = value;
  }
  get sweepChain() {
    return this.sweep.sweepChain;
  }
  set sweepChain(value: Promise<void> | null) {
    this.sweep.sweepChain = value;
  }
  get sweepMode() {
    return this.sweep.sweepMode;
  }
  set sweepMode(value: "window" | "drain" | null) {
    this.sweep.sweepMode = value;
  }
  get sweepPending() {
    return this.sweep.sweepPending;
  }
  set sweepPending(value: "window" | "drain" | null) {
    this.sweep.sweepPending = value;
  }
  get drainWaiters() {
    return this.sweep.drainWaiters;
  }
  get maxSweepWindows() {
    return this.sweep.maxSweepWindows;
  }
  set maxSweepWindows(value: number) {
    this.sweep.maxSweepWindows = value;
  }
  get sweepStats() {
    return this.sweep.sweepStats;
  }
  private laneSchedulerOwner?: LaneScheduler;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private taskWakesOwner?: TaskWakes;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get taskWakes(): TaskWakes {
    return (this.taskWakesOwner ??= new TaskWakes(
      portsContext(this, [
        "adapter",
        "host",
        "resolution",
        "admission",
        "applyDeferredOwnerVerbs",
        "armGitTransient",
        "cleanContext",
        "completionFollowUps",
        "deferGitTransient",
        "dispatchQueued",
        "dispatchTask",
        "gitTransientWaiting",
        "note",
        "scheduleDispatch",
        "scheduleLane",
        "scheduleLifecycleFollowUp",
        "scheduleOperation",
        "scheduleTaskQuantum",
        "stopped",
        "store",
        "taskHostAvailable",
        "taskQuantum",
        "terminalThreadsPending",
        "transientKey",
        "wakeRepository",
        "wakeTask",
        "withHost",
      ]),
    ));
  }
  private terminalWorkspaceRetirementOwner?: TerminalWorkspaceRetirement;
  private completionFollowUpsOwner?: CompletionFollowUps;
  get completionFollowUps(): CompletionFollowUps {
    const engine = this;
    return (this.completionFollowUpsOwner ??= new CompletionFollowUps({
      get cleanContext() {
        return engine.cleanContext.bind(engine);
      },
      get enqueueCleanup() {
        return (...args: Parameters<Engine["enqueueCleanup"]>) =>
          engine.enqueueCleanup(...args);
      },
      get scheduleCompletionFollowUp() {
        return (...args: Parameters<Engine["scheduleCompletionFollowUp"]>) =>
          engine.scheduleCompletionFollowUp(...args);
      },
      get scheduleLifecycleFollowUp() {
        return (...args: Parameters<Engine["scheduleLifecycleFollowUp"]>) =>
          engine.scheduleLifecycleFollowUp(...args);
      },
      get scheduleRunBuildOutputs() {
        return (...args: Parameters<Engine["scheduleRunBuildOutputs"]>) =>
          engine.scheduleRunBuildOutputs(...args);
      },
      get scheduleTerminalArchiveRetry() {
        return (...args: Parameters<Engine["scheduleTerminalArchiveRetry"]>) =>
          engine.scheduleTerminalArchiveRetry(...args);
      },
      get stopped() {
        return engine.stopped;
      },
      get store() {
        return engine.store;
      },
      get terminalThreadsPending() {
        return (...args: Parameters<Engine["terminalThreadsPending"]>) =>
          engine.terminalThreadsPending(...args);
      },
      get transientKey() {
        return (...args: Parameters<Engine["transientKey"]>) =>
          engine.transientKey(...args);
      },
      get wakeCapacityWaiter() {
        return (...args: Parameters<Engine["wakeCapacityWaiter"]>) =>
          engine.wakeCapacityWaiter(...args);
      },
      get wakeIntegrationSuccessor() {
        return (...args: Parameters<Engine["wakeIntegrationSuccessor"]>) =>
          engine.wakeIntegrationSuccessor(...args);
      },
      get wakeTask() {
        return (...args: Parameters<Engine["wakeTask"]>) =>
          engine.wakeTask(...args);
      },
      get resolution() {
        return portsContext(engine.resolution, [
          "holdsIntegrationTurn",
          "integrationActive",
        ]);
      },
    }));
  }
  /** Replaceable by tests; forwards to the completion owner, which reads it at call time. */
  get completionFollowUpDelays(): number[] {
    return this.completionFollowUps.completionFollowUpDelays;
  }
  set completionFollowUpDelays(value: number[]) {
    this.completionFollowUps.completionFollowUpDelays = value;
  }
  private get laneScheduler(): LaneScheduler {
    return (this.laneSchedulerOwner ??= new LaneScheduler(
      () => this.stopped,
      () => this.taskWakes.lifecycleFollowUps.size > 0,
      (work) => this.cleanContext(work),
    ));
  }
  // Tests seed and read this state on a bare engine; these go with the delegates in F2.
  private get activeLanes(): Set<string> {
    return this.laneScheduler.activeLanes;
  }
  private set activeLanes(value: Set<string>) {
    this.laneScheduler.activeLanes = value;
  }
  get wakePreludes(): number {
    return this.laneScheduler.wakePreludes;
  }
  set wakePreludes(value: number) {
    this.laneScheduler.wakePreludes = value;
  }
  private occurrencesOwner?: ProjectionOccurrences;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get occurrences(): ProjectionOccurrences {
    return (this.occurrencesOwner ??= new ProjectionOccurrences());
  }
  private titleProjectionOwner?: WorkspaceTitleProjection;
  private get titles(): WorkspaceTitleProjection {
    return (this.titleProjectionOwner ??= new WorkspaceTitleProjection(
      this,
      this.occurrences,
    ));
  }
  private cleanupLaneOwner?: CleanupLane;
  private get cleanups(): CleanupLane {
    return (this.cleanupLaneOwner ??= new CleanupLane(this, this.occurrences));
  }
  private retirementLaneOwner?: RetirementLane;
  private get retirementLane(): RetirementLane {
    return (this.retirementLaneOwner ??= new RetirementLane(this));
  }
  // Tests seed and read this state on a bare engine; these go with the delegates in F2.
  get titleQueue(): Set<string> {
    return this.titles.queue;
  }
  set titleQueue(value: Set<string>) {
    this.titles.queue = value;
  }
  get projectionEnqueued(): Map<string, number> {
    return this.occurrences.enqueued;
  }
  set projectionEnqueued(value: Map<string, number>) {
    this.occurrences.enqueued = value;
  }
  get projectionDone(): Map<string, number> {
    return this.occurrences.done;
  }
  set projectionDone(value: Map<string, number>) {
    this.occurrences.done = value;
  }
  get projectionWaiters(): (() => void)[] {
    return this.occurrences.waiters;
  }
  set projectionWaiters(value: (() => void)[]) {
    this.occurrences.waiters = value;
  }
  get projectionInFlight(): Set<string> {
    return this.occurrences.inFlight;
  }
  set projectionInFlight(value: Set<string>) {
    this.occurrences.inFlight = value;
  }
  get titleDraining(): Promise<void> | null {
    return this.titles.draining;
  }
  set titleDraining(value: Promise<void> | null) {
    this.titles.draining = value;
  }
  get cleanupQueue(): Array<{ taskId: string; retryWorkspaceId?: string }> {
    return this.cleanups.queue;
  }
  set cleanupQueue(
    value: Array<{ taskId: string; retryWorkspaceId?: string }>,
  ) {
    this.cleanups.queue = value;
  }
  get cleanupDraining(): Promise<void> | null {
    return this.cleanups.draining;
  }
  set cleanupDraining(value: Promise<void> | null) {
    this.cleanups.draining = value;
  }
  readonly resolution: Resolution;
  readonly hooks: RepositoryHooks;
  readonly retirement: RuntimeRetirementService;
  private readonly operations: Operations;
  readonly lifecycle: Lifecycle;
  private readonly agentControls: AgentControls;
  private dispositionsOwner?: Dispositions;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get dispositions(): Dispositions {
    return (this.dispositionsOwner ??= new Dispositions(this));
  }
  private verbFencesOwner?: VerbFences;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get verbFences(): VerbFences {
    return (this.verbFencesOwner ??= new VerbFences(this));
  }
  private runReleaseOwner?: RunRelease;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get runRelease(): RunRelease {
    return (this.runReleaseOwner ??= new RunRelease(this));
  }
  private readonly taskRemoval: TaskRemoval;
  private readonly workspaceProvisioning: WorkspaceProvisioning;
  private readonly workerLauncher: WorkerLauncher;
  private readonly briefControls: BriefControls;
  private readonly settingsControls: SettingsControls;
  readonly ownerStop: OwnerStop;
  private readonly deferredVerbs: DeferredOwnerVerbs;
  private readonly reviewerAutoContinue: ReviewerAutoContinue;
  private readonly briefAmendmentDelivery: BriefAmendmentDelivery;
  readonly decisionNotices: DecisionNoticeDelivery;
  private readonly reviewerControls: ReviewerControls;
  readonly moveControls: MoveControls;
  readonly restartControls: RestartControls;
  readonly workerRestarts: WorkerRestarts;
  private readonly reviewRestarts: ReviewRestarts;
  private readonly stalledTurnStops: StalledTurnStops;
  private readonly retryEffectControls: RetryEffectControls;
  private readonly archiveEffectRetries: ArchiveEffectRetries;
  private readonly ordinaryEffectRetries: OrdinaryEffectRetries;
  private readonly workerReconcile: WorkerReconcile;
  private readonly callbackIntake: CallbackIntake;
  private readonly workerFailover: WorkerFailover;
  private readonly retiredObservations: RetiredObservations;
  readonly taskControlDispatcher: TaskControlDispatcher;
  private readonly recoverySettlement: RecoverySettlement;
  private readonly pausedStops: PausedStops;
  private readonly routeControls: RouteControls;
  private readonly taskCompletion: TaskCompletion;
  readonly proofControls: ProofControls;
  readonly forceVerbs: ForceVerbs;
  private readonly unsubscribePrerequisites: () => void;
  /** Decisions for the Low submission gate and unavailable required profiles. */
  readonly routingDecisions: Decisions;
  /** The Host contract over this engine's adapter, read at each call (`core/host/host-facade.ts`). */
  get host(): HostFacade {
    return new HostFacade(this);
  }
  constructor(
    readonly store: Store,
    readonly adapter: Adapter,
    readonly idleGraceMs = 60000,
    readonly submissionReady: () => boolean = () => true,
    retirement?: RuntimeRetirementService,
    readonly uncertainMergeRetryMs = DEFAULT_UNCERTAIN_MERGE_RETRY_MS,
    hostRunStateDir?: string,
  ) {
    this.hostOutages = new HostOutages(store);
    this.hostHealth = new HostHealth((id) => {
      // A host whose context cannot even be bound has no live connection.
      try {
        return this.withHost(id, () => this.hostAvailable(id));
      } catch {
        return false;
      }
    }, this.hostOutages);
    this.primaryAdapter = adapter;
    if (!adapter.workspaceAllocationBridge) {
      adapter.workspaceAllocationBridge =
        createStoreWorkspaceAllocationBridge(store);
    }
    this.resolveHostAdapter = () => adapter;
    this.adapter = routeHostAdapter(this, adapter);
    this.catalogs = new ProfileCatalogs(this);
    // Lean store 4 (task 989): the `workspace_creation_step_*` events went — nothing read
    // them. The dispatching task's reason line stays: it is the board-visible progress.
    this.adapter.workspaceCreationProgress = (taskId, step, status) => {
      try {
        const current = this.store.task(taskId);
        const reason = `Creating workspace: ${step.replaceAll("_", " ")}`;
        // Spec 069 §3: the same step reported again writes nothing.
        if (
          status === "started" &&
          current.phase === "dispatching" &&
          current.reason !== reason
        )
          this.store.update(taskId, {
            reason,
            ...stopClearedPatch(current, reason),
          });
      } catch {
        /* Progress reporting must not change workspace creation behavior. */
      }
    };
    this.hooks = new RepositoryHooks(store, {
      wakeTask: (taskId) => {
        void this.cleanContext(() => this.wakeTask(taskId));
      },
      retentionGateSettled: (taskId, worktree) =>
        this.lifecycle.retentionReconciledAt(taskId, worktree),
      hostRunStateDir,
    });
    this.resolution = new Resolution(
      store,
      this.adapter,
      () => this.profilesFor(this.activeHostId),
      () => this.stopped,
      idleGraceMs,
      this.hooks,
      uncertainMergeRetryMs,
    );
    // The registry's answers, wired as one set (`core/host/host-ports.ts`): every
    // host question this root asks is answered here or nowhere, so no question
    // stays on the ambient default because its own assignment was forgotten.
    this.store.responsibleRecipient = (key) =>
      this.resolution.cachedResponsible(key);
    this.resolution.hostPorts = {
      taskAvailable: (task, run) =>
        this.taskHostAvailable(task) && (!run || run.hostId === task.hostId),
      outage: (id) => this.hostOutages.current(id),
      launchWait: (id, taskId) => this.hostLaunchWait(id, taskId),
      workerProviderUnavailable: (task) => this.workerProviderUnavailable(task),
      withHost: (id, fn) => this.withHost(id, fn),
      online: (id) => this.hostOnline(id),
      ids: () => this.hostIds(),
      inventoryMatches: (id) => this.inventoryHostMatches(id),
      originAvailable: (id) => this.hostAvailable(id),
      // A host-dependent call arriving just after a roll waits out the runtime's
      // own bridge connection instead of refusing as unavailable (roll-recovery
      // contract): the poll is bounded and ends at once once the bridge answers.
      awaitBridge: async (waitMs) => {
        const deadline = Date.now() + waitMs;
        while (!this.submissionReady()) {
          if (Date.now() >= deadline || this.stopped) return false;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return true;
      },
      bridgeWaitMs: this.resolution.hostBridgeWaitMs,
      canReuseUnqualifiedOriginWorkspace: () =>
        this.canReuseUnqualifiedOriginWorkspace(),
      identifyOriginHost: (id, identitySource) =>
        this.identifyOriginHost(id, identitySource),
      catalogKnown: () => this.profileCatalogKnownFor(this.activeHostId),
      workerCatalogs: (task) => this.workerHostCatalogs(task),
      preferredHostKinds: (task) => this.preferredHostKindsForTask(task),
    };
    this.resolution.gitTransientFailure = (task, error) =>
      this.deferGitTransient(task.id, error);
    this.resolution.hostReadTransientFailure = (task, error, step) =>
      this.deferHostReadTransient(task.id, error, false, step);
    this.resolution.clearHostReadTransient = (id, scope) =>
      this.clearHostReadTransient(id, scope);
    this.resolution.armHostReadTransient = (id, retryAt, scope) =>
      this.taskWakes.armHostReadTransient(id, retryAt, scope);
    this.resolution.gitTransientRecovered = (task, source) => {
      const key = this.transientKey(task.id);
      const episode = this.store.getMeta<GitTransientEpisode | null>(key);
      if (episode && episode.retryAt <= Date.now() && episode.source === source)
        this.store.deleteMeta(key);
    };
    this.resolution.turnReleased = (repoPath) =>
      this.wakeIntegrationSuccessor(repoPath);
    // Spec 058 (task 523): an operator's answer to Queue's own question applies
    // through the ordinary owner controls, with that answer as the authority.
    this.resolution.applyOperatorControl = (input) =>
      this.performTaskControl(input);
    this.resolution.wakeDeferredDirection = (taskId) => {
      void this.cleanContext(() => this.wakeTask(taskId));
    };
    this.routingDecisions = new Decisions(store);
    this.resolution.recovery.setCoordinatorActionHandler((task, run, action) =>
      this.applyCoordinatorAction(task, run, action),
    );
    this.resolution.recovery.setResponsibleFaultHandler((task) =>
      this.settleResponsibleFault(task),
    );
    // Spec 068 §3: proof that a participant's agent is dead releases its run
    // through the ordinary `run.release` plan (nucleus#1552, extended to thread
    // facts), and a gone retained worker is retired before a revision launch.
    this.resolution.releaseDeadParticipant = (task, run) =>
      releaseDeadParticipant(this, task, run);
    this.resolution.retireGoneRetainedWorker = (task) =>
      retireGoneRetainedWorker(this, task);
    this.resolution.participantGoneProof = (task, run) =>
      deadParticipantProof(this, task, run);
    this.retirement = retirement ?? new RuntimeRetirementService(store);
    this.lifecycle = new Lifecycle(
      enginePorts(
        this,
        [
          "adapter",
          "drainCleanup",
          "enqueueCleanup",
          "hooks",
          "host",
          "hostAvailable",
          "onTaskHost",
          "removeSiblings",
          "retirement",
          "scheduleRetirement",
          "scheduleRunBuildOutputs",
          "settleObservedIdleRuns",
          "settleTerminalIntentRuns",
          "settleTerminalRecoveryEpisode",
          "stopped",
          "store",
          "taskHostAvailable",
          "wakeTask",
          "withHost",
        ],
        [
          "adapter",
          "closeoutAuthority",
          "hasEarlierIntegrationTurn",
          "lease",
          "attention",
          "environmentDeferred",
          "transportDeferred",
          "update",
        ],
      ),
    );
    this.agentControls = new AgentControls(this);
    this.taskRemoval = new TaskRemoval(this);
    this.workspaceProvisioning = new WorkspaceProvisioning(this);
    this.workerLauncher = new WorkerLauncher(this);
    this.briefControls = new BriefControls(this);
    this.settingsControls = new SettingsControls(this);
    this.ownerStop = new OwnerStop(this);
    this.deferredVerbs = new DeferredOwnerVerbs(this);
    this.reviewerAutoContinue = new ReviewerAutoContinue(this);
    this.briefAmendmentDelivery = new BriefAmendmentDelivery(this);
    this.decisionNotices = new DecisionNoticeDelivery(
      enginePorts(
        this,
        ["adapter", "cleanContext", "scheduleLane", "stopped", "store"],
        [
          "host",
          "identifyOriginHost",
          "originHostAvailable",
          "paused",
          "sendDurably",
          "withHost",
        ],
      ),
    );
    this.resolution.scheduleDecisionDelivery = () =>
      this.decisionNotices.schedule();
    this.reviewerControls = new ReviewerControls(this);
    this.moveControls = new MoveControls(this);
    this.restartControls = new RestartControls(this);
    this.workerRestarts = new WorkerRestarts(this);
    this.reviewRestarts = new ReviewRestarts(this);
    this.stalledTurnStops = new StalledTurnStops(this);
    this.retryEffectControls = new RetryEffectControls(this);
    this.archiveEffectRetries = new ArchiveEffectRetries(this);
    this.ordinaryEffectRetries = new OrdinaryEffectRetries(this);
    this.workerReconcile = new WorkerReconcile(
      enginePorts(
        this,
        [
          "adapter",
          "admission",
          "compareSiblings",
          "hooks",
          "host",
          "idleGraceMs",
          "note",
          "onTaskHost",
          "stopped",
          "store",
          "updateAfterOperatorRemap",
        ],
        [
          "adoptReplacementPr",
          "attention",
          "extendCallbackReminder",
          "heavyRunAlive",
          "identifyOriginHost",
          "plannerRungsFor",
          "quantumReadTimeoutMs",
          "responsibleThreads",
          "withHost",
          "reconcileStalledTurnStop",
          "recovery",
          "releaseDeadParticipant",
          "remindStoppedWorker",
          "resolveIncident",
          "responsiblePrReportRefused",
          "settleAutomaticReplayHold",
          "stalls",
          "suppressAutomaticRetry",
          "update",
          "waiting",
        ],
      ),
    );
    const engine = this;
    this.callbackIntake = new CallbackIntake({
      get adapter() {
        return engine.adapter;
      },
      get cleanContext() {
        return engine.cleanContext.bind(engine);
      },
      get completeCheckpoint() {
        return engine.completeCheckpoint.bind(engine);
      },
      get completeReviewProgress() {
        return engine.completeReviewProgress.bind(engine);
      },
      get control() {
        return engine.control.bind(engine);
      },
      get host() {
        return engine.host;
      },
      get rejectCheckpoint() {
        return engine.rejectCheckpoint.bind(engine);
      },
      get rejectReviewProgress() {
        return engine.rejectReviewProgress.bind(engine);
      },
      get reviewerContinuationInFlight() {
        return engine.reviewerContinuationInFlight.bind(engine);
      },
      get reviewContinuationLimit() {
        return engine.reviewContinuationLimit.bind(engine);
      },
      get onTaskHost() {
        return engine.onTaskHost.bind(engine);
      },
      get stopped() {
        return engine.stopped;
      },
      get store() {
        return engine.store;
      },
      get wake() {
        return engine.wake.bind(engine);
      },
      get wakeTask() {
        return engine.wakeTask.bind(engine);
      },
      get withHost() {
        return engine.withHost.bind(engine);
      },
      get resolution() {
        return portsContext(engine.resolution, [
          "attention",
          "complete",
          "settleCompletedExecutorBlocker",
        ]);
      },
    });
    this.workerFailover = new WorkerFailover(
      enginePorts(
        this,
        [
          "activeHostId",
          "adapter",
          "cleanContext",
          "control",
          "enqueueCleanup",
          "host",
          "launchAgent",
          "note",
          "preferredHostKindsForTask",
          "profileCatalogKnown",
          "profileCatalogKnownFor",
          "profiles",
          "profilesFor",
          "stopped",
          "store",
          "taskHostAvailable",
          "wakeTask",
          "withHost",
          "workerHostCatalogs",
          "workerProviderUnavailable",
        ],
        [
          "clearTransportWait",
          "graceMs",
          "recordStop",
          "releaseDeadParticipant",
          "resumeTransientProviderThread",
          "resumeTransientWorker",
          "retainedWorkerProfileIssue",
          "retireGoneRetainedWorker",
          "suppressAutomaticRetry",
          "transportDeferred",
          "waiting",
        ],
      ),
    );
    this.retiredObservations = new RetiredObservations(
      portsContext(this, [
        "activeHostId",
        "host",
        "retiredObservationKey",
        "store",
        "taskHostAvailable",
      ]),
    );
    this.taskControlDispatcher = new TaskControlDispatcher(this);
    this.recoverySettlement = new RecoverySettlement(
      enginePorts(
        this,
        [
          "coordinatorActionRunId",
          "selfForceRunId",
          "host",
          "onTaskHost",
          "performTaskControl",
          "store",
        ],
        ["attention", "openPlannerEscalation", "recovery", "update"],
      ),
    );
    this.pausedStops = new PausedStops(this);
    this.routeControls = new RouteControls(this);
    this.taskCompletion = new TaskCompletion(this);
    this.proofControls = new ProofControls(this);
    this.forceVerbs = new ForceVerbs(this);
    this.operations = new Operations(this);
    this.unsubscribePrerequisites = store.onPrerequisitesSettled((ids) => {
      for (const id of ids) this.pendingPrerequisiteReleases.add(id);
      void this.flushPrerequisiteReleases();
    });
  }
  get pendingPrerequisiteReleases(): Set<string> {
    return this.prerequisiteReleases.pendingPrerequisiteReleases;
  }
  get prerequisiteReleaseWork() {
    return this.prerequisiteReleases.prerequisiteReleaseWork;
  }
  set prerequisiteReleaseWork(value: Promise<void> | null) {
    this.prerequisiteReleases.prerequisiteReleaseWork = value;
  }
  /** Refresh affected dependents once, then wake each repository once per batch. */
  flushPrerequisiteReleases(): Promise<void> {
    return this.prerequisiteReleases.flushPrerequisiteReleases();
  }
  /** Registered secondary host ids; the service wires this to the host registry. */
  hostIds: () => readonly string[] = () => [];
  readonly primaryAdapter: Adapter;
  private readonly catalogs: ProfileCatalogs;
  /** Admission evidence attached to this engine's Paseo adapter, when admitted. */
  get admission() {
    return admissionOf(this.adapter);
  }
  setSourcePromotionHandler(
    handler: (
      payload: unknown,
      hostId?: string,
      selection?: import("../shared/operations").QueueOperation["hostSelection"],
    ) => Promise<OperationResult>,
  ): void {
    this.operations.setSourcePromotionHandler(handler);
  }
  setLeadCheckHandler(
    handler: (
      payload: unknown,
      operationId: string,
    ) => Promise<OperationResult>,
  ): void {
    this.operations.setLeadCheckHandler(handler);
  }
  setRepositoryRekeyHandler(
    handler: (
      input: RepositoryRekeyInput,
    ) => OperationResult | Promise<OperationResult>,
  ): void {
    this.operations.setRepositoryRekeyHandler(handler);
  }
  /** Tests seed a primary catalog snapshot without a host round-trip. */
  get hostCatalogs() {
    return this.catalogs.hostCatalogs;
  }
  refresh(): Promise<void> {
    return this.catalogs.refresh();
  }
  vocabularyFor(id: string | undefined) {
    return this.catalogs.vocabularyFor(id);
  }
  rebuildProfiles(): void {
    this.catalogs.rebuildProfiles();
  }
  secondaryCanonicalCatalogs() {
    return this.catalogs.secondaryCanonicalCatalogs();
  }
  profileCompatibility() {
    return this.catalogs.profileCompatibility();
  }
  profileCatalogKnown(): boolean {
    return this.catalogs.profileCatalogKnown();
  }
  workerProviderUnavailable(task: Task): boolean {
    return this.catalogs.workerProviderUnavailable(task);
  }
  profilesFor(hostId?: string | null): Profile[] {
    return this.catalogs.profilesFor(hostId);
  }
  profileCatalogKnownFor(hostId?: string | null): boolean {
    return this.catalogs.profileCatalogKnownFor(hostId);
  }
  /** A queued first worker has a preference, not a workspace host yet. */
  firstWorkerUnbound(task: Task): boolean {
    return (
      task.entrypoint !== "review" &&
      task.entrypoint !== "proof" &&
      task.phase === "queued" &&
      task.hostSelection?.basis !== "worker_profile" &&
      !task.profile &&
      taskNeverDispatched(task, this.store.runs(task.id))
    );
  }
  workerHostCatalogs(task: { hostId?: string | null }) {
    const ids = [
      ...new Set([...this.hostIds(), ...(task.hostId ? [task.hostId] : [])]),
    ];
    return ids
      .filter((id) => this.workerHostReady(id))
      .map((hostId) => ({ hostId, profiles: this.profilesFor(hostId) }));
  }
  /**
   * Connected (up or degraded) with its catalog read: the host can answer for
   * profiles. Degraded affects only first-dispatch admission (Spec 069 §2), which
   * reads `hostLaunchWait` after selection.
   */
  private workerHostReady(id: string): boolean {
    return this.hostHealth.connectedNow(id) && this.profileCatalogKnownFor(id);
  }
  /**
   * The host kind a first worker dispatch must reach: the repository's explicit
   * hostKind, else the operator default. Null means automatic dispatch.
   */
  firstDispatchTarget(
    task: Pick<Task, "repoPath">,
  ): { kind: HostKind; source: "repository" | "operator_default" } | null {
    const repository = this.store.repositoryFor(task.repoPath)?.hostKind;
    if (repository) return { kind: repository, source: "repository" };
    const kind = effectiveDefaultHostKind(
      this.store.getMeta<HostKind | null>("operatorDefaultHostKind"),
    );
    return kind ? { kind, source: "operator_default" } : null;
  }
  /**
   * nucleus#1416 (Tom), extended 2026-11-20 (Tom): the first worker dispatch's
   * target kind is a requirement, not a preference. While no host of that kind is
   * online with a read catalog, the unbound task keeps this named wait, with no
   * workspace, profile charge or slot. A repository hostKind wins over the
   * operator default. A kind with no registered host is a visible configuration
   * wait. Only with neither configured does dispatch stay automatic.
   */
  targetHostWait(task: Pick<Task, "repoPath" | "hostId">): string | null {
    const target = this.firstDispatchTarget(task);
    if (!target) return null;
    const label = HOST_KIND_LABELS[target.kind];
    const prefix =
      target.source === "repository"
        ? "Repository host"
        : "Operator default host";
    const registered = [
      ...new Set([...this.hostIds(), ...(task.hostId ? [task.hostId] : [])]),
    ].filter((id) => hostKindOf(id) === target.kind);
    if (!registered.length)
      return `${prefix} ${label} is not registered; waiting for its configuration`;
    return registered.some((id) => this.workerHostReady(id))
      ? null
      : `Waiting for ${prefix.toLowerCase()} ${label}`;
  }
  preferredHostKindsForTask(
    task: Pick<Task, "repoPath">,
  ): (import("../shared/host-kind").HostKind | null | undefined)[] {
    return [
      this.store.repositoryFor(task.repoPath)?.hostKind,
      effectiveDefaultHostKind(
        this.store.getMeta<HostKind | null>("operatorDefaultHostKind"),
      ),
    ];
  }
  /**
   * The online hosts whose own profile catalog has not been read yet: the absent
   * evidence a worker decision waits on, never a profile's absence. One rule for
   * dispatch and for the owner controls that read the same eligible catalogs
   * (nucleus#1500).
   */
  workerCatalogWaitHostIds(task: { hostId?: string | null }): string[] {
    const ids = [
      ...new Set([...this.hostIds(), ...(task.hostId ? [task.hostId] : [])]),
    ];
    return ids.filter(
      (id) =>
        this.hostHealth.connectedNow(id) && !this.profileCatalogKnownFor(id),
    );
  }
  workerHostCatalogPending(task: { hostId?: string | null }): boolean {
    return this.workerCatalogWaitHostIds(task).length > 0;
  }
  /**
   * The retryable refusal when one host's profile catalog is not loaded yet, or
   * null when it is (nucleus#1500). The legacy primary keeps its one wording; a
   * named host says which catalog the caller needs, so an owner control explains
   * the evidence it actually reads instead of the primary's snapshot.
   */
  profileCatalogWaitRefusal(hostId?: string | null): string | null {
    return this.catalogs.profileCatalogWaitRefusal(hostId);
  }
  workerRoutingProfiles(task: Task): Profile[] {
    const catalogs = this.workerHostCatalogs(task);
    if (catalogs.length > 0) return combineWorkerHostProfiles(catalogs);
    return this.profilesFor(task.hostId);
  }
  submissionRoutingRefusal(
    submission: import("../shared/contracts").Submission,
  ): string | null {
    const catalogs = this.workerHostCatalogs({ hostId: submission.hostId });
    if (!catalogs.length)
      return this.independentReviewRoutingRefusal(submission);
    return independentReviewRoutingConflict(
      { ...submission, usage: this.store.usageLevel() },
      combineWorkerHostProfiles(catalogs),
      this.store.pool(),
    );
  }
  routingHostViews(task: Task) {
    const ids = [
      ...new Set([...this.hostIds(), ...(task.hostId ? [task.hostId] : [])]),
    ];
    const named = [
      ...new Set(
        [
          task.preferredProfileId,
          task.profile?.id,
          ...Object.values(task.profileRequests ?? {}).map(
            (request) => request?.profileId,
          ),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    return ids.map((hostId) => {
      const online = this.hostHealth.connectedNow(hostId);
      const known = this.profileCatalogKnownFor(hostId);
      const profiles = this.profilesFor(hostId);
      return {
        hostId,
        online,
        profiles: named.map((profileId) => {
          const profile = profiles.find(
            (candidate) => candidate.id === profileId,
          );
          const thinking =
            task.profileRequests?.worker?.profileId === profileId
              ? task.profileRequests.worker.thinkingOptionId ||
                task.thinkingOptionId
              : task.preferredProfileId === profileId
                ? task.thinkingOptionId
                : task.profile?.id === profileId
                  ? task.profile.thinkingOptionId
                  : "";
          const reason = !online
            ? "Host offline"
            : !known
              ? "Host catalog not yet read"
              : !profile
                ? "Profile absent from host catalog"
                : !profile.available
                  ? profile.problem || "Profile unavailable on host"
                  : thinking && !profile.supportedThinking.includes(thinking)
                    ? `Thinking option ${thinking} unsupported`
                    : "Available on host";
          return {
            profileId,
            eligible: reason === "Available on host",
            reason,
          };
        }),
      };
    });
  }

  requireProfileCatalog(): void {
    if (!this.profileCatalogKnown())
      throw new Error(PROFILE_CATALOG_LOADING_REFUSAL);
  }
  /** Run detached work without inheriting the caller's async context. */
  cleanContext<T>(work: () => T): T {
    return cleanLaneScope.runInAsyncScope(() => {
      const scope = new AsyncResource("nucleus-lane-quantum");
      try {
        return scope.runInAsyncScope(work);
      } finally {
        scope.emitDestroy();
      }
    });
  }
  /** Schedule one bounded quantum on an exclusive lane key. Same-key work runs at its priority. */
  scheduleLane(
    key: string,
    priority: number,
    work: () => Promise<void> | void,
    options: { coalesce?: string } = {},
  ): Promise<void> {
    const hostId = this.laneHost(key);
    // Spec 068 §6: every quantum scheduled onto an exclusive `task:<id>` lane
    // carries the task quantum deadline scope, whoever scheduled it (audit
    // branch-PR recovery, wake follow-up, dispatch, or full taskQuantum).
    const scoped = key.startsWith("task:")
      ? () =>
          runInTaskQuantumScope(
            this.resolution.quantumReadBudgetMs ?? QUANTUM_TOTAL_READ_BUDGET_MS,
            () => Promise.resolve(work()),
          )
      : work;
    return this.laneScheduler.scheduleLane(
      key,
      priority,
      hostId ? () => this.withHost(hostId, scoped) : scoped,
      options,
    );
  }
  quiesce(exclude?: "audit"): Promise<void> {
    return this.laneScheduler.quiesce(exclude);
  }
  private engineBusy(ignoreKey?: string): boolean {
    return this.laneScheduler.engineBusy(ignoreKey);
  }
  private pickLaneKey(): string | null {
    return this.laneScheduler.pickLaneKey();
  }
  /** A count that rises whenever a lane quantum finishes: evidence a long pass is still making progress. */
  progressMark(): number {
    return this.laneScheduler.progressMark();
  }
  private dispatchLanes(): void {
    this.laneScheduler.dispatchLanes();
  }
  scheduleDispatch(): void {
    this.laneScheduler.scheduleDispatch();
  }
  settleQuiesce(): void {
    this.laneScheduler.settleQuiesce();
  }
  private discardQueuedLanes(): void {
    this.laneScheduler.discardQueuedLanes();
  }

  transientKey(id: string): string {
    return this.taskWakes.transientKey(id);
  }
  armGitTransient(id: string, retryAt: number, operation = false): void {
    this.taskWakes.armGitTransient(id, retryAt, operation);
  }
  deferGitTransient(id: string, error: unknown, operation = false): boolean {
    return this.taskWakes.deferGitTransient(id, error, operation);
  }
  gitTransientWaiting(id: string, operation = false): boolean {
    return this.taskWakes.gitTransientWaiting(id, operation);
  }
  clearHostReadTransient(
    id: string,
    scope: "task" | "op" | "question" = "task",
  ): void {
    this.taskWakes.clearHostReadTransient(id, scope);
  }
  resumeHostReadTransients(): void {
    this.taskWakes.resumeHostReadTransients();
  }
  deferHostReadTransient(
    id: string,
    error: unknown,
    operation = false,
    step = "Host check",
  ): "wait" | "exhausted" {
    return this.taskWakes.deferHostReadTransient(id, error, operation, step);
  }
  noteStepFailure(taskId: string, error: unknown): void {
    this.taskWakes.noteStepFailure(taskId, error);
  }
  neverDispatched(task: Task): boolean {
    return this.taskControlDispatcher.neverDispatched(task);
  }
  scheduleTaskQuantum(
    taskId: string,
    passSnapshot?: import("./scheduling/pass-snapshot").PassSnapshot,
  ): Promise<void> {
    return this.taskWakes.scheduleTaskQuantum(taskId, passSnapshot);
  }
  wakeIntegrationSuccessor(repoPath: string): void {
    this.taskWakes.wakeIntegrationSuccessor(repoPath);
  }
  wakeCapacityWaiter(releasingTaskId: string): void {
    this.taskWakes.wakeCapacityWaiter(releasingTaskId);
  }
  scheduleCompletionFollowUp(task: Task, runs: Run[]): void {
    this.completionFollowUps.scheduleCompletionFollowUp(task, runs);
  }
  terminalThreadsPending(task: Task, runs: Run[]): boolean {
    return this.completionFollowUps.terminalThreadsPending(task, runs);
  }
  scheduleTerminalArchiveRetry(task: Task, runs: Run[]): void {
    this.completionFollowUps.scheduleTerminalArchiveRetry(task, runs);
  }
  scheduleLifecycleFollowUp(taskId: string): boolean {
    return this.taskWakes.scheduleLifecycleFollowUp(taskId);
  }
  wakeTask(taskId: string): Promise<void> {
    return this.taskWakes.wakeTask(taskId);
  }
  wakeRepository(repoPath: string | null | undefined): Promise<void> {
    return this.taskWakes.wakeRepository(repoPath);
  }
  /**
   * One bounded safety-sweep window: the restart and missed-event net. It
   * reconciles at most one cursor page, yields between quanta and is pre-empted
   * by any control, operation or read that arrives during it.
   */
  sweepOnce(): Promise<void> {
    return this.sweep.sweepOnce();
  }
  /**
   * Explicit reconciliation: bounded cursor windows until the sweep has covered
   * the fleet once, then the queued title projection. Callbacks and task
   * controls do not use this; bootstrap, refresh and operator configuration do.
   */
  wake(): Promise<void> {
    return this.sweep.wake();
  }
  /** Durable cursor evidence for service health and telemetry. */
  reconciliationSnapshot(): ReconciliationSweep {
    return this.sweep.reconciliationSnapshot();
  }
  /**
   * Coalesce sweep requests: a running drain already covers every window, so a
   * concurrent drain is redundant while a single-window request still queues one
   * more bounded page behind a running window.
   */
  ensureSweep(mode: "window" | "drain"): Promise<void> {
    return this.sweep.ensureSweep(mode);
  }
  startSweepChain(mode: "window" | "drain"): void {
    return this.sweep.startSweepChain(mode);
  }
  /**
   * Ordered fleet snapshot for one pass. It is materialized once per pass and
   * kept in memory; each task's live state is re-read by its own quantum, so a
   * multi-page drain never re-parses the whole fleet for every page.
   */
  sweepOrder(): Task[] {
    return this.sweep.sweepOrder();
  }
  control<T>(operation: () => Promise<T> | T, key: string): Promise<T> {
    const hostId = this.laneHost(key);
    // A lane runs its work in a clean async context. An authorized author round
    // at the revision cap carries its acceptance into its own commit, so that one
    // value is handed across explicitly, to this operation only.
    const acceptance = this.revisionCapAcceptance.getStore();
    const carried = acceptance
      ? () => this.revisionCapAcceptance.run(acceptance, operation)
      : operation;
    return this.laneScheduler.control(
      hostId ? () => this.withHost(hostId, carried) : carried,
      key,
    );
  }
  startOperation(input: {
    key: string;
    kind: QueueOperation["kind"];
    payload: unknown;
    taskId?: string;
    expectedVersion?: number;
    repoPath?: string;
    submissionId?: string;
    hostId?: string;
    deferSchedule?: boolean;
  }): Promise<OperationAcceptance> {
    return this.operations.startOperation(input);
  }
  scheduleAcceptedOperation(operationId: string): void {
    this.operations.scheduleAcceptedOperation(operationId);
  }
  startSubmission(
    submission: Submission,
    requirePushedPlanning = false,
  ): Promise<OperationAcceptance> {
    return this.operations.startSubmission(submission, requirePushedPlanning);
  }
  resumeSubmissions(): void {
    this.operations.resumeSubmissions();
  }
  operationStatus(operationId: string): QueueOperation {
    return this.operations.operationStatus(operationId);
  }
  awaitOperation(
    operationId: string,
    timeoutMs?: number,
  ): Promise<QueueOperation> {
    return this.operations.awaitOperation(operationId, timeoutMs);
  }
  resumeOperations(reconcileInterrupted = true): void {
    this.operations.resumeOperations(reconcileInterrupted);
  }
  reconcileSourcePromotion(operation: QueueOperation): void {
    this.operations.reconcileSourcePromotion(operation);
  }
  scheduleOperation(id: string): void {
    this.operations.scheduleOperation(id);
  }
  runOperation(id: string): Promise<void> {
    return this.operations.runOperation(id);
  }
  ownerSettledOperation(taskId: string | null, id: string): boolean {
    return this.operations.ownerSettledOperation(taskId, id);
  }
  effectIntentFor(operation: QueueOperation): QueueOperation["effect"] {
    return this.operations.effectIntentFor(operation);
  }
  rerecordPlanningBase(input: {
    taskId: string;
    version: number;
  }): Promise<Task> {
    return this.operations.rerecordPlanningBase(input);
  }
  retryValidation(input: {
    taskId: string;
    version: number;
    rebindWorkspaceId?: string;
    removeOrphanWorkspace?: boolean;
    parentRestart?: {
      before: () => Promise<boolean>;
      commit: (task: Task, restored: boolean) => Task;
    };
    settleFences?: {
      detail: string;
      runIds: string[];
      displacedRunIds?: string[];
    };
  }): Promise<Task> {
    return this.operations.retryValidation(input);
  }
  performOperation(
    operation: QueueOperation,
    payload: unknown,
  ): Promise<OperationResult> {
    return this.operations.performOperation(operation, payload);
  }
  submitPlanningSource(
    submission: Submission,
    source: {
      kind: "lead" | "papercut";
      id: string;
      repository: string;
      digest: string;
      expectedSource: string;
    },
    initial?: Partial<Task>,
    hostId?: string,
    identitySource?: IdentitySource,
  ): Promise<OperationResult> {
    return this.operations.submitPlanningSource(
      submission,
      source,
      initial,
      hostId,
      identitySource,
    );
  }
  performSubmit(
    submission: Submission,
    requirePushedPlanning?: boolean,
    promotion?: {
      source: {
        kind: "lead" | "papercut";
        id: string;
        repository: string;
        digest: string;
        expectedSource: string;
      };
      initial?: Partial<Task>;
      identitySource?: IdentitySource;
    },
    hostId?: string,
    selection?: import("../shared/operations").QueueOperation["hostSelection"],
  ): Promise<OperationResult> {
    return this.operations.performSubmit(
      submission,
      requirePushedPlanning,
      promotion,
      hostId,
      selection,
    );
  }

  applyCoordinatorAction(
    task: Task,
    run: Run,
    binding: RecoveryActionBinding,
  ): Promise<void> {
    return this.recoverySettlement.applyCoordinatorAction(task, run, binding);
  }
  settleResponsibleFault(task: Task): Promise<boolean> {
    return settleResponsibleFault(this.recoverySettlement.engine, task);
  }

  completeTask(
    input: TaskControlInput,
    operationId?: string,
  ): Promise<{ task: Task; idempotent: boolean }> {
    return this.taskCompletion.completeTask(input, operationId);
  }
  // async: an unknown task rejects like every other refusal instead of throwing before the promise exists.
  resolveTaskControl(input: TaskControlRequest): TaskControlInput {
    return this.taskControlLifecycle.resolveTaskControl(input);
  }
  performTaskControl(
    request: TaskControlRequest,
    operationId?: string,
  ): Promise<TaskControlTask> {
    return this.taskControlLifecycle.performTaskControl(request, operationId);
  }
  recordNoAutomaticRetryRule(input: TaskControlInput, result: Task): Task {
    return this.taskControlDispatcher.recordNoAutomaticRetryRule(input, result);
  }

  settleLadderControl(
    before: Task,
    after: Task,
    action: TaskControlInput["action"],
  ): void {
    return this.resolution.ladder.settleLadderControl(before, after, action);
  }

  appliedWithVersionHint(
    input: TaskControlInput,
    operationId?: string,
  ): Promise<Task> {
    return this.taskControlDispatcher.appliedWithVersionHint(
      input,
      operationId,
    );
  }
  performTaskControlApplied(
    input: TaskControlInput,
    operationId?: string,
  ): Promise<Task> {
    return this.taskControlDispatcher.performTaskControlApplied(
      input,
      operationId,
    );
  }
  forceCallerAuthorized(
    task: Task,
    caller: string | undefined,
  ): Promise<boolean> {
    return this.forceVerbs.forceCallerAuthorized(task, caller);
  }
  selfForceRole(task: Task): "worker" | "reviewer" | "recovery" | null {
    return this.forceVerbs.selfForceRole(task);
  }
  forcePlannerMatches(task: Task, caller: string): Promise<boolean> {
    return this.forceVerbs.forcePlannerMatches(task, caller);
  }
  forceMove(
    task: Task,
    input: TaskControlInput,
    operationId?: string,
  ): Promise<Task> {
    return this.forceVerbs.forceMove(task, input, operationId);
  }
  applyTaskControlComplete(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    return this.taskControlDispatcher.applyTaskControlComplete(
      input,
      operated,
      operationId,
    );
  }
  applyTaskControlDispose(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Promise<Task> {
    return this.taskControlDispatcher.applyTaskControlDispose(input, operated);
  }
  applyTaskControlWithdrawCancellation(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Promise<Task> {
    return this.taskControlDispatcher.applyTaskControlWithdrawCancellation(
      input,
      operated,
    );
  }
  applyTaskControlRoute(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    return this.taskControlDispatcher.applyTaskControlRoute(
      input,
      operated,
      operationId,
    );
  }
  applyTaskControlRestart(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    return this.taskControlDispatcher.applyTaskControlRestart(
      input,
      operated,
      operationId,
    );
  }
  applyTaskControlReplacementPr(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Promise<Task> {
    return this.taskControlDispatcher.applyTaskControlReplacementPr(
      input,
      operated,
    );
  }
  applyTaskControlMove(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    return this.moveControls.applyTaskControlMove(input, operated, operationId);
  }
  applyTaskControlProof(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    return this.proofControls.applyTaskControlProof(
      input,
      operated,
      operationId,
    );
  }

  applyTaskControlRetryEffect(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    operationId?: string,
  ): Promise<Task> {
    return this.taskControlDispatcher.applyTaskControlRetryEffect(
      input,
      operated,
      operationId,
    );
  }
  applyTaskControlRepinInstruction(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Promise<Task> {
    return this.taskControlDispatcher.applyTaskControlRepinInstruction(
      input,
      operated,
    );
  }
  applyTaskControlAmendBrief(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Task {
    return this.taskControlDispatcher.applyTaskControlAmendBrief(
      input,
      operated,
    );
  }
  applyTaskControlSetLane(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Promise<Task> {
    return this.settingsControls.applyTaskControlSetLane(input, operated);
  }
  applyTaskControlSetRouting(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
    planner = false,
  ): Task {
    return this.settingsControls.applyTaskControlSetRouting(
      input,
      operated,
      planner,
    );
  }
  applyTaskControlExcludeWorker(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Task {
    return this.settingsControls.applyTaskControlExcludeWorker(input, operated);
  }
  applyTaskControlLocal(
    input: TaskControlInput,
    operated: <T>(result: T) => T,
  ): Task {
    return this.settingsControls.applyTaskControlLocal(input, operated);
  }
  restartParkedStep(
    task: Task,
    instruction: string | undefined,
    reviewerInstruction: string | undefined,
  ): Task {
    return this.workerRestarts.restartParkedStep(
      task,
      instruction,
      reviewerInstruction,
    );
  }
  applyTaskControlHold(input: TaskControlInput, task: Task): Task {
    return this.settingsControls.applyTaskControlHold(input, task);
  }
  removeTask(id: string, version: number): Promise<Task> {
    return this.taskRemoval.removeTask(id, version);
  }
  /** The store facts a removal refuses on before it waits for an offline host (#927). */
  removalRefusal(id: string, version: number): string | null {
    return this.taskRemoval.localRefusal(id, version);
  }
  retryRuntimeRetirement(taskId: string, version: number): Promise<Task> {
    return this.taskRemoval.retryRuntimeRetirement(taskId, version);
  }
  retryBuildOutputCleanup(taskId: string, version: number): Promise<Task> {
    return this.taskRemoval.retryBuildOutputCleanup(taskId, version);
  }
  settleRunBuildOutputs(taskId: string): Promise<void> {
    return this.taskRemoval.settleRunBuildOutputs(taskId);
  }
  scheduleRunBuildOutputs(taskId: string): Promise<void> {
    return this.taskRemoval.scheduleRunBuildOutputs(taskId);
  }
  runBuildOutputHold(
    task: Task,
    record: Task["resolution"]["buildOutputCleanups"][number],
  ): Promise<string | null> {
    return this.taskRemoval.runBuildOutputHold(task, record);
  }
  unreleasedRunIn(workspaceId: string): string | null {
    return this.taskRemoval.unreleasedRunIn(workspaceId);
  }
  workspaceParticipantsIdle(
    task: Task,
    workspaceId: string,
  ): Promise<ReadonlySet<string>> {
    return this.taskRemoval.workspaceParticipantsIdle(task, workspaceId);
  }
  settleWorkspaceRetirement(taskId: string): Promise<Task> {
    return (this.terminalWorkspaceRetirementOwner ??=
      new TerminalWorkspaceRetirement(
        portsContext(this, [
          "adapter",
          "retirement",
          "retentionHold",
          "stopped",
          "store",
          "workspaceParticipantsIdle",
        ]),
      )).settleWorkspaceRetirement(taskId);
  }
  recordRunBuildOutputState(
    taskId: string,
    record: Task["resolution"]["buildOutputCleanups"][number],
    state: "intent" | "complete" | "skipped" | "uncertain",
    detail: string,
  ) {
    return this.taskRemoval.recordRunBuildOutputState(
      taskId,
      record,
      state,
      detail,
    );
  }
  dispositionDeps() {
    return this.dispositions.dispositionDeps();
  }
  continueWithdrawnWorker(task: Task): Promise<void> {
    return this.dispositions.continueWithdrawnWorker(task);
  }
  disposeTask(input: DispositionRequest): Promise<Task> {
    return this.dispositions.disposeTask(input);
  }
  bulkDispositionDetail(operationId: string): BulkDisposition {
    return this.dispositions.bulkDispositionDetail(operationId);
  }
  startBulkDisposition(
    input: BulkDispositionRequest,
    requestedBy?: string,
  ): Promise<BulkDisposition> {
    return this.dispositions.startBulkDisposition(input, requestedBy);
  }
  retryBulkDisposition(operationId: string): Promise<BulkDisposition> {
    return this.dispositions.retryBulkDisposition(operationId);
  }
  resumeBulkDispositions(): void {
    this.dispositions.resumeBulkDispositions();
  }
  scheduleBulk(operationId: string): void {
    this.dispositions.scheduleBulk(operationId);
  }
  dispositionDetail(taskId: string) {
    return this.dispositions.dispositionDetail(taskId);
  }
  disposeTaskFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: DispositionRequest,
  ): Promise<Task> {
    return this.agentControls.disposeTaskFromAgent(caller, input);
  }
  withdrawCancellationFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: { taskId: string; version: number; reason: string },
  ): Promise<Task> {
    return this.agentControls.withdrawCancellationFromAgent(caller, input);
  }
  bulkDispositionDetailFromAgent(
    caller: { taskId: string; runId: string; token: string },
    operationId: string,
  ): BulkDisposition {
    return this.agentControls.bulkDispositionDetailFromAgent(
      caller,
      operationId,
    );
  }
  startBulkDispositionFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: BulkDispositionRequest,
  ): Promise<BulkDisposition> {
    return this.agentControls.startBulkDispositionFromAgent(caller, input);
  }
  retryBulkDispositionFromAgent(
    caller: { taskId: string; runId: string; token: string },
    operationId: string,
  ): Promise<BulkDisposition> {
    return this.agentControls.retryBulkDispositionFromAgent(
      caller,
      operationId,
    );
  }
  rejectFenced(task: Task, action: string): void {
    this.verbFences.rejectFenced(task, action);
  }
  completionSubscription(input: {
    taskId: string;
    version: number;
    agentId: string;
    action: "subscribe" | "unsubscribe";
  }): Promise<Task> {
    return this.settingsControls.completionSubscription(input);
  }
  reparent(input: ReparentInput) {
    return this.settingsControls.reparent(input);
  }
  ownerInventory(input: OwnerInventoryInput): Promise<OwnerInventory> {
    return this.resolution.origins.ownerInventory(input);
  }
  taskControlFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: TaskControlRequest,
  ) {
    return this.agentControls.taskControlFromAgent(caller, input);
  }
  authenticateAgentControl(taskId: string, runId: string, token: string) {
    return this.agentControls.authenticateAgentControl(taskId, runId, token);
  }
  dependencyDetail(
    caller: { taskId: string; runId: string; token: string },
    targetTaskId: string,
  ) {
    return this.agentControls.dependencyDetail(caller, targetTaskId);
  }
  authenticatedDispositionDetail(
    caller: { taskId: string; runId: string; token: string },
    taskId: string,
  ) {
    return this.agentControls.authenticatedDispositionDetail(caller, taskId);
  }
  recoveryTaskNextFromAgent(caller: {
    taskId: string;
    runId: string;
    token: string;
  }) {
    return this.agentControls.recoveryTaskNextFromAgent(caller);
  }
  updateDependenciesFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: { taskId: string; version: number; dependsOn: string[] },
  ) {
    return this.agentControls.updateDependenciesFromAgent(caller, input);
  }
  projectQueueDetail(
    caller: { taskId: string; runId: string; token: string },
    targetTaskId: string,
  ) {
    return this.agentControls.projectQueueDetail(caller, targetTaskId);
  }
  promoteTaskFromAgent(
    caller: { taskId: string; runId: string; token: string },
    input: { taskId: string; version: number },
  ) {
    return this.agentControls.promoteTaskFromAgent(caller, input);
  }
  prepareWorkerResume(input: {
    taskId: string;
    version: number;
    instruction: string;
    record?: (task: Task) => Task;
    settleFences?: {
      detail: string;
      runIds: string[];
      displacedRunIds?: string[];
    };
  }): Promise<Task | (() => Task)> {
    return this.workerRestarts.prepareWorkerResume(input);
  }
  repinInstruction(input: { taskId: string; version: number }): Promise<Task> {
    return this.briefControls.repinInstruction(input);
  }
  amendBrief(input: {
    taskId: string;
    version: number;
    brief: string;
    reason: string;
    overtakes?: string[];
  }): Task {
    return this.briefControls.amendBrief(input);
  }

  requireAvailableGroup(profileId: string): void {
    this.routeControls.requireAvailableGroup(profileId);
  }
  /** The named-profile control's own per-host catalog evidence (nucleus#1500). */
  profileCatalogRefusal(
    task: Task,
    roles: readonly RouteRole[],
  ): string | null {
    return this.routeControls.profileCatalogRefusal(task, roles);
  }
  briefStageProfileRefusal(text: string, _scope: Task["scope"]): string | null {
    return this.briefControls.briefStageProfileRefusal(text, _scope);
  }
  independentReviewRoutingRefusal(
    routing: RoutingPreflightInput,
    hostId?: string | null,
  ): string | null {
    return this.routeControls.independentReviewRoutingRefusal(routing, hostId);
  }
  moveToReview(
    input: {
      taskId: string;
      version: number;
      reason: string;
      reviewer?: { profileId: string; reason: string };
      caller?: string;
      prNumber?: number;
      fresh?: boolean;
    },
    operationId?: string,
  ): Promise<Task> {
    return this.moveControls.moveToReview(input, operationId);
  }
  resumeReleasedPrerequisiteWait(taskId: string): void {
    return this.moveControls.resumeReleasedPrerequisiteWait(taskId);
  }
  moveToWork(input: {
    taskId: string;
    version: number;
    reason: string;
    instruction?: string;
    caller?: string;
    parentRestart?: {
      before: () => Promise<boolean>;
      commit: (task: Task, restored: boolean) => Task;
      restoreRetained?: boolean;
    };
    restart?: {
      afterSettlement: (settled: Task) => Task;
      afterRevision: (revised: Task) => Task;
    };
  }): Promise<Task> {
    return this.moveControls.moveToWork(input);
  }
  moveToMerge(input: {
    taskId: string;
    version: number;
    reason: string;
    caller?: string;
    qualification?: string;
    head?: string;
    relayed?: boolean;
    delegated?: boolean;
    relayNote?: string;
  }): Promise<Task> {
    return this.moveControls.moveToMerge(input);
  }

  assertDelegatedAuthority(
    caller: string | undefined,
    relayNote: string | undefined,
    purpose: string,
  ): { role: "delegated"; kind: "delegated"; note: string } {
    return this.taskControlDispatcher.assertDelegatedAuthority(
      caller,
      relayNote,
      purpose,
    );
  }
  assertOwnerAuthority(
    caller: string | undefined,
    relayed: boolean | undefined,
    relayNote: string | undefined,
    purpose?: string,
  ): {
    role: "operator" | "authorized_relay";
    kind: "operator" | "relayed_note";
    note: string | null;
  } {
    return this.taskControlDispatcher.assertOwnerAuthority(
      caller,
      relayed,
      relayNote,
      purpose,
    );
  }
  recordWorkspaceDiscard(
    task: Task,
    workspaceId: string,
    directory: string,
    input: TaskControlInput,
    authority: { kind: "operator" | "relayed_note"; note: string | null },
  ): WorkspaceDiscard {
    return this.moveControls.recordWorkspaceDiscard(
      task,
      workspaceId,
      directory,
      input,
      authority,
    );
  }
  moveToCloseout(input: {
    taskId: string;
    version: number;
    reason: string;
    caller?: string;
    qualification?: string;
    head?: string;
    relayed?: boolean;
    relayNote?: string;
    operationId?: string;
  }): Promise<Task> {
    return this.moveControls.moveToCloseout(input);
  }
  reconcileRetainedExternalMerge(input: {
    task: Task;
    reason: string;
    caller?: string;
    qualification: string;
    head?: string;
    relayed?: boolean;
    relayNote?: string;
    operationId?: string;
  }): Promise<Task> {
    return this.moveControls.reconcileRetainedExternalMerge(input);
  }
  reconcileReviewEntryExternalMerge(input: {
    task: Task;
    reason: string;
    caller?: string;
    qualification?: string;
    head?: string;
    relayed?: boolean;
    relayNote?: string;
    operationId?: string;
  }): Promise<Task> {
    return this.moveControls.reconcileReviewEntryExternalMerge(input);
  }
  retryEffect(input: TaskControlInput, operationId?: string): Promise<Task> {
    return this.retryEffectControls.retryEffect(input, operationId);
  }
  retryEffectBeforeSettlement(
    task: Task,
    input: TaskControlInput,
  ): Promise<Task> | null {
    return this.ordinaryEffectRetries.retryEffectBeforeSettlement(task, input);
  }
  retryPublicationBeforeSettlement(
    task: Task,
    input: TaskControlInput,
    publication: OwnerEffect,
  ): Promise<Task> {
    return this.ordinaryEffectRetries.retryPublicationBeforeSettlement(
      task,
      input,
      publication,
    );
  }
  retryCancelledWorkspaceRetirement(
    task: Task,
    input: TaskControlInput,
  ): Promise<Task> {
    return this.archiveEffectRetries.retryCancelledWorkspaceRetirement(
      task,
      input,
    );
  }
  retryTerminalArchive(
    task: Task,
    input: TaskControlInput,
    archiveWorkspaceId: string,
    directory: string | null | undefined,
  ): Promise<Task> {
    return this.archiveEffectRetries.retryTerminalArchive(
      task,
      input,
      archiveWorkspaceId,
      directory,
    );
  }
  retrySupersededReviewView(
    task: Task,
    input: TaskControlInput,
    intentWorkspaceId: string,
  ): Promise<Task> {
    return this.archiveEffectRetries.retrySupersededReviewView(
      task,
      input,
      intentWorkspaceId,
    );
  }
  retryOrdinaryEffect(
    task: Task,
    input: TaskControlInput,
    found: OwnerEffect,
    current: Task,
    expected: number,
  ): Promise<Task> {
    return this.ordinaryEffectRetries.retryOrdinaryEffect(
      task,
      input,
      found,
      current,
      expected,
    );
  }
  heldArchiveRetryReason(
    task: Task,
    workspaceId: string,
    recorded: WorkspaceArchiveRetry | null,
    discard: WorkspaceDiscard | null,
    discardedNow: boolean,
  ): string {
    return this.archiveEffectRetries.heldArchiveRetryReason(
      task,
      workspaceId,
      recorded,
      discard,
      discardedNow,
    );
  }
  ownerStopHold(task: Task): boolean {
    return this.ownerStop.ownerStopHold(task);
  }
  ownerStopNamesRun(task: Task, runId: string | null | undefined): boolean {
    return this.ownerStop.ownerStopNamesRun(task, runId);
  }

  /** Round 4: a direct owner call — not a coordinator report and not a deferred replay. */
  isOwnerCall(): boolean {
    return this.controlContext.isOwnerCall();
  }

  deferredRestartSupersedesOwnerStop(task: Task): boolean {
    return this.deferredVerbs.deferredRestartSupersedesOwnerStop(task);
  }
  dispatchWaitsFor(
    task: Task,
    ownerStopYields?: boolean,
    inFlight?: boolean,
  ): "paused" | "held" | null {
    return this.ownerStop.dispatchWaitsFor(task, ownerStopYields, inFlight);
  }
  releaseOwnerStopHold(taskId: string, allowDeferredReplay?: boolean): boolean {
    return this.ownerStop.releaseOwnerStopHold(taskId, allowDeferredReplay);
  }
  deferOwnerVerb(
    task: Task,
    input: TaskControlInput,
    why: "paused" | "held",
    target: { runId: string; checkpointOrdinal?: number; head?: string } | null,
  ): Task {
    return this.deferredVerbs.deferOwnerVerb(task, input, why, target);
  }
  continueAwaitingReviewers(tasks: Task[]): Promise<void> {
    return this.reviewerAutoContinue.continueAwaitingReviewers(tasks);
  }
  /** An exhausted reader is replaced fresh (or escalated) on the pass that observes it idle. */
  replaceExhaustedReviewers(tasks: Task[]): Promise<void> {
    return this.reviewerAutoContinue.replaceExhaustedReviewers(tasks);
  }
  applyDeferredOwnerVerbs(): Promise<void> {
    return this.deferredVerbs.applyDeferredOwnerVerbs();
  }
  dropDeferredOwnerVerb(
    taskId: string,
    at: string,
    kind: string,
    detail: string,
  ): void {
    this.deferredVerbs.dropDeferredVerb(taskId, at, kind, detail);
  }
  /** Deliver every recorded brief-amendment intent that never reached its host. */
  deliverPendingBriefAmendments(): Promise<void> {
    return this.briefAmendmentDelivery.deliverPending();
  }
  /** Schedule coalesced, bounded decision-notice delivery independently of the fleet sweep. */
  scheduleDecisionNotices(): Promise<void> {
    return this.decisionNotices.schedule();
  }
  stopTask(input: TaskControlInput, operationId?: string): Promise<Task> {
    return this.ownerStop.stopTask(input, operationId);
  }
  resumeOwnerStop(input: TaskControlInput, operationId: string): Promise<Task> {
    return this.ownerStop.resumeOwnerStop(input, operationId);
  }
  observeOwnerStop(taskId: string): Promise<Task | null> {
    return this.ownerStop.observeOwnerStop(taskId);
  }

  stopActiveThreads(
    input: { caller?: string } = {},
  ): Promise<z.infer<typeof stopThreads.output>> {
    return this.pausedStops.stopActiveThreads(input);
  }

  resumePausedStops(): Promise<void> {
    return this.pausedStops.resumePausedStops();
  }

  routeTask(input: TaskControlInput, operationId?: string): Promise<Task> {
    return this.routeControls.routeTask(input, operationId);
  }
  restartParked(
    input: TaskControlInput,
    task: Task,
    role: RestartRole,
    reason: string,
    operationId?: string,
  ): Promise<Task> {
    return this.restartControls.restartParked(
      input,
      task,
      role,
      reason,
      operationId,
    );
  }
  reviewerInstructionHeadProof(
    task: Task,
    version: number,
    commit: () => Task,
  ): Promise<Task> | null {
    return this.restartControls.reviewerInstructionHeadProof(
      task,
      version,
      commit,
    );
  }
  async executeEpisodeRestart(
    taskId: string,
    displacement: { runIds: string[]; cancel: () => Promise<void> },
    admit: () => Promise<Task | (() => Task | Promise<Task>)>,
  ): Promise<Task> {
    const { version } = this.store.task(taskId);
    const apply = await admit();
    if (typeof apply !== "function") return apply;
    const current = () => this.requireOwnerControlCurrent(
      this.store.task(taskId), version, "Task changed during restart",
    );
    current();
    await displacement.cancel();
    current();
    return apply();
  }
  workerRestartArm(
    task: Task,
    input: {
      reason: string;
      instruction?: string;
      caller?: string;
      relayed?: boolean;
      note?: string;
      fresh?: boolean;
      observedWorker?: AgentObservation;
      supersedeNonDelivery?: boolean;
    },
  ): {
    afterSettlement: (settled: Task) => Task;
    afterRevision: (revised: Task) => Task;
  } {
    return this.workerRestarts.workerRestartArm(task, input);
  }
  restartTask(input: TaskControlInput, operationId?: string): Promise<Task> {
    return this.restartControls.restartTask(input, operationId);
  }
  restartWorker(request: RestartRequest): Promise<Task> {
    return this.workerRestarts.restartWorker(request);
  }
  restartReviewer(request: RestartRequest): Promise<Task> {
    return this.reviewRestarts.restartReviewer(request);
  }
  continueRetainedReviewer(
    task: Task,
    options: {
      version: number;
      reason: string;
      instruction: string;
      ownerStopYields: boolean;
      deferrable: TaskControlInput;
      verb: "restart" | "move";
    },
    operationId?: string,
  ): Promise<Task> {
    return this.reviewerControls.continueRetainedReviewer(
      task,
      options,
      operationId,
    );
  }
  preserveRetainedReviewer(
    input: { taskId: string; version: number; reason: string; caller?: string },
    task: Task,
    reader: Run,
    pr: { url: string; head: string },
    finished: { settleable: Run[] },
    state: string,
  ): Promise<Task> {
    return this.reviewerControls.preserveRetainedReviewer(
      input,
      task,
      reader,
      pr,
      finished,
      state,
    );
  }
  restartReview(
    taskId: string,
    reason: string,
    instruction: string,
    fresh = true,
    replacement?: ExhaustedReviewerReplacement,
  ): Promise<Task> {
    return this.reviewerControls.restartReview(
      taskId,
      reason,
      instruction,
      fresh,
      replacement,
    );
  }

  private routeLiveRun(
    task: Task,
    role: RouteRole,
  ): { run: Run | null } | null {
    return this.routeControls.routeLiveRun(task, role);
  }

  private stopRouteRun(
    task: Task,
    role: RouteRole,
    run: Run | null,
    operationId?: string,
  ): Promise<boolean> {
    return this.routeControls.stopRouteRun(task, role, run, operationId);
  }

  private assertRouteGroupAvailable(profileId: string, role: RouteRole): void {
    this.routeControls.assertRouteGroupAvailable(profileId, role);
  }
  stopStalledTurn(input: {
    taskId: string;
    version: number;
    runId: string;
  }): Promise<Task> {
    return this.stalledTurnStops.stopStalledTurn(input);
  }
  async stop() {
    this.stopped = true;
    this.unsubscribePrerequisites();
    this.taskWakes.stop();
    this.decisionNotices.stop();
    this.cleanups.stop();
    this.dispatchOwner.stop();
    // A native decision this process observes is left unknown rather than resent.
    this.resolution.abortResponsibleQuestions();
    // Stop is bounded: active quanta finish, queued quanta are failed rather
    // than parked, and accepted lifecycle follow-ups no-op instead of starting
    // new work, so unload always releases the process lease.
    this.discardQueuedLanes();
    await this.quiesce();
  }
  /**
   * A pre-dispatch hold applies only to a task that is still waiting to dispatch.
   * The hook runs outside any disposition fence, so a cancellation can complete
   * while it runs; the task read before the hook must not reopen that terminal task.
   */
  notePreDispatchHold(id: string, emission: HookEmissionResult) {
    return this.dispatchOwner.notePreDispatchHold(id, emission);
  }
  /**
   * The consumer-owned retention gate as an archive caller consumes it: emit
   * `task.pre_archive` for the retained worktree and report a hold with the
   * hook's evidence. A repository with no bound hook reports no hold.
   */
  async retentionHold(
    taskId: string,
    target: { directory: string; head: string },
    reason: string,
  ): Promise<{ hold: boolean; detail: string }> {
    const outcome = await this.hooks.retentionGate(this.store.task(taskId), {
      ...target,
      reason,
    });
    return outcome.hold
      ? { hold: true, detail: hookHoldReason(outcome) }
      : { hold: false, detail: "" };
  }
  /**
   * Record a stop or wait from the engine. Callers name the stop reason;
   * `classify` is for exception or agent error text Queue did not author.
   */
  note(
    id: string,
    reason: string,
    stop: TaskStopReason | "classify",
    phase?: Task["phase"],
    suggestedVerbs?: TaskStopVerb[],
  ): void {
    return this.engineStop.note(id, reason, stop, phase, suggestedVerbs);
  }
  enqueueTitle(taskId: string): void {
    this.titles.enqueue(taskId);
  }
  drainTitles(): Promise<void> {
    return this.titles.drain();
  }
  scheduleRetirement(taskId: string): void {
    this.retirementLane.schedule(taskId);
  }
  enqueueCleanup(taskId: string, retryWorkspaceId?: string): void {
    this.cleanups.enqueue(taskId, retryWorkspaceId);
  }
  drainCleanup(): Promise<void> {
    return this.cleanups.drain();
  }
  scheduleCleanupRetry(taskId: string): void {
    this.cleanups.scheduleRetry(taskId);
  }
  /** True until the engine stops or the store pauses: every projection wait ends then. */
  private projectionsWaiting(): boolean {
    return !this.stopped && this.store.getMeta("paused") !== true;
  }
  awaitProjectionOccurrence(
    key: string,
    drain: () => Promise<void>,
  ): Promise<void> {
    return this.occurrences.awaitOccurrence(key, drain, () =>
      this.projectionsWaiting(),
    );
  }
  drainProjections(options: { cleanup?: boolean } = {}): Promise<void> {
    return drainProjectionCut({
      occurrences: this.occurrences,
      titles: { queue: this.titles.queue, drain: () => this.drainTitles() },
      cleanups: {
        queue: this.cleanups.queue,
        drain: () => this.drainCleanup(),
      },
      awaitCleanup: options.cleanup !== false,
      keepWaiting: () => this.projectionsWaiting(),
    });
  }
  syncWorkspaceTitle(task: Task): Promise<void> {
    return this.titles.sync(task);
  }
  /** Live Paseo threads the planner picker offers, each with a kind so task threads can be left out. */
  projectOwnerCandidates(): Promise<
    {
      id: string;
      title: string;
      workspaceId: string | null;
      kind: ReturnType<typeof ownerCandidateKind>;
    }[]
  > {
    return this.projectLifecycle.projectOwnerCandidates();
  }
  /** Planner participant tickets still pending; the board's project entry says so. */
  plannerTicketPending: () => ReadonlySet<string> = () => new Set();
  /**
   * Settings → Projects: saved projects, repository rows, slots and QA. A named
   * `project` also gets its live planner, agent and responsible-thread state.
   */
  projectSettings(
    input: { project?: string } = {},
  ): Promise<ReturnType<typeof buildProjectSettings>> {
    return this.projectLifecycle.projectSettings(input);
  }
  /** Task 1110: one project's named agents with their live state and fallback marker. */
  projectAgents(
    projectKey: string,
  ): Promise<import("../shared/contracts").ProjectAgentView[]> {
    return this.projectLifecycle.projectAgents(projectKey);
  }
  /**
   * Spec 058 cutover 5, one-time migration: a project with an owner thread and no planner gets
   * that thread as its planner when the thread is live (observed, not archived); an archived or
   * missing owner is dropped. Each change is recorded through the store with `setBy` Queue and a
   * reason; the database is never edited by hand. A read that fails leaves its project for the
   * next start, so the marker lands only after every project has resolved.
   */
  migrateProjectOwnersToPlanners(): Promise<void> {
    return this.projectLifecycle.migrateProjectOwnersToPlanners();
  }
  noteLifecycleSignal(input: {
    agentId?: string | null;
    workspaceId?: string | null;
    hostId?: string | null;
  }): void {
    this.retiredObservations.noteLifecycleSignal(input);
  }
  retiredObservationPlan(): {
    persisted: Record<string, { active: boolean; at: string }>;
    keep: Record<string, { active: boolean; at: string }>;
    due: string[];
  } {
    return this.retiredObservations.retiredObservationPlan();
  }
  observeRetiredWorkers(
    plan: {
      persisted: Record<string, { active: boolean; at: string }>;
      keep: Record<string, { active: boolean; at: string }>;
      due: string[];
    },
    inventory: ReadonlyMap<string, AgentObservation> | null,
  ): Promise<{
    observations: Record<string, { active: boolean; at: string }>;
    changed: boolean;
  }> {
    return this.retiredObservations.observeRetiredWorkers(plan, inventory);
  }
  clearRetiredInvalidations(): void {
    this.retiredObservations.clearRetiredInvalidations();
  }
  /**
   * One audit pass. It resolves with its recorded fault (also kept as
   * `engineError`), or null, and whether a drain reached every task once.
   */
  auditPass(
    drain: boolean,
    visited: Set<string> = new Set(),
  ): Promise<{ fault: Error | null; covered: boolean; visited: Set<string> }> {
    return this.sweep.auditPass(drain, visited);
  }
  /**
   * Bounded dispatch pass over the queued order. With `repoPath`, only that
   * repository's lanes are considered. Capacity, dependency, availability and
   * hook gates are unchanged; workspace creation consults the bounded Queue
   * admission budget before any durable creation intent is recorded.
   */
  dispatchQueued(repoPath?: string): Promise<void> {
    return this.dispatchOwner.dispatchQueued(repoPath);
  }
  queuedWaitSignature(): string {
    return this.dispatchAdmission.queuedWaitSignature();
  }
  /** Present-time wait that needs no durable queued-task update. */
  queuedExternalWait(task: Task): string {
    return this.dispatchAdmission.queuedExternalWait(task);
  }
  /**
   * Spec 069 §1 and §3: every task's present-time wait the read boundary works
   * out (`taskWithCurrentWait`): a queued task's admission wait, or a started
   * task's host wait while its host is down. Never a write.
   */
  currentExternalWait(task: Task): string {
    if (task.phase === "queued") return this.queuedExternalWait(task);
    return this.inFlightHostWait(task)?.detail ?? "";
  }
  /** Under host pressure, admit bounded progress instead of waiting for unrelated load to disappear. */
  workspacePressureWait(
    task: Task,
    host?: Parameters<Dispatch["workspacePressureWait"]>[1],
  ): string {
    return this.dispatchOwner.workspacePressureWait(task, host);
  }
  /**
   * Arms one wake at the end of the durable admission gap, so a paced task starts
   * when the gap ends instead of at the next sweep. Idempotent for a given gap end;
   * it never scans tasks itself.
   */
  armWorkspacePressureWake(): void {
    return this.dispatchOwner.armWorkspacePressureWake();
  }
  /** Dispatch shares ownership with task controls and hook reconciliation. */
  dispatchTask(taskId: string, dispatchHeld: boolean): Promise<void> {
    return this.dispatchOwner.dispatchTask(taskId, dispatchHeld);
  }
  /** Proof-only dispatch always enters its executor/release-GO route, never the worker launcher. */
  launchProofOnly(task: Task, selectedProfile?: Profile): Promise<void> {
    return this.dispatchOwner.launchProofOnly(task, selectedProfile);
  }
  dispatchReviewEntry(task: Task): Promise<void> {
    return this.dispatchOwner.dispatchReviewEntry(task);
  }
  performReviewEntryAdmission(task: Task): Promise<void> {
    return this.dispatchOwner.performReviewEntryAdmission(task);
  }
  /**
   * One bounded lifecycle reconciliation quantum for one retained task. Runs on
   * the task's exclusive lane key so same-task controls cannot race it. Every
   * remote effect keeps its persisted intent and reconciliation discipline.
   */
  settleFinishedRuns(task: Task) {
    this.runRelease.settleFinishedRuns(task);
  }
  reconcileClosedRetainedReviewer(taskId: string): Promise<void> {
    return this.runRelease.reconcileClosedRetainedReviewer(taskId);
  }
  settleObservedIdleRuns(taskId: string, detail: string): Promise<number> {
    return this.runRelease.settleObservedIdleRuns(taskId, detail);
  }
  settleTerminalRecoveryEpisode(
    taskId: string,
    cause: string,
    releasedRunIds?: readonly string[],
  ): boolean {
    return this.runRelease.settleTerminalRecoveryEpisode(
      taskId,
      cause,
      releasedRunIds,
    );
  }
  settleTerminalIntentRuns(taskId: string): number {
    return this.runRelease.settleTerminalIntentRuns(taskId);
  }
  settleSupersededIdleRuns(taskId: string, detail: string): Promise<number> {
    return this.runRelease.settleSupersededIdleRuns(taskId, detail);
  }
  settleHistoricalProofExecutions(
    taskId: string,
    detail: string,
  ): Promise<number> {
    return this.runRelease.settleHistoricalProofExecutions(taskId, detail);
  }
  supersededIdleFence(run: Run, deadlineAt?: number): Promise<string | null> {
    return this.runRelease.supersededIdleFence(run, deadlineAt);
  }
  observedRunLiveness(run: Run): Promise<boolean | null> {
    return this.runRelease.observedRunLiveness(run);
  }

  openEpisodeRunId(taskId: string): string | null {
    return this.verbFences.openEpisodeRunId(taskId);
  }
  planEpisodeDisplacement(
    taskId: string,
    version: number,
    verb: string,
  ): Promise<{ runIds: string[]; cancel: () => Promise<void> }> {
    return this.verbFences.planEpisodeDisplacement(taskId, version, verb);
  }
  collectVerbFinishedRuns(
    taskId: string,
    isSubject: (run: Run) => boolean,
    options?: { displace?: boolean; settlesEpisode?: boolean },
  ): Promise<{
    settleable: Run[];
    fenced: { run: Run; why: string }[];
    live: Run[];
    observations: Map<string, Awaited<ReturnType<Adapter["observe"]>>>;
  }> {
    return this.verbFences.collectVerbFinishedRuns(taskId, isSubject, options);
  }
  runDurableFence(task: Task, run: Run): string | null {
    return this.verbFences.runDurableFence(task, run);
  }
  ownerCancelledRun(taskId: string, runId: string): boolean {
    return this.verbFences.ownerCancelledRun(taskId, runId);
  }
  requireOwnerControlCurrent(
    task: Task,
    version: number,
    refusal: string,
  ): void {
    this.verbFences.requireOwnerControlCurrent(task, version, refusal);
  }
  assertUnchangedBeforeCancel(
    taskId: string,
    version: number,
    runs: readonly Run[],
  ): void {
    this.verbFences.assertUnchangedBeforeCancel(taskId, version, runs);
  }
  observeRunDisposition(run: Run) {
    return this.verbFences.observeRunDisposition(run);
  }
  runDisposition(run: Run): Promise<"settle" | "cancel" | { refusal: string }> {
    return this.verbFences.runDisposition(run);
  }
  displacedRunObservation(run: Run) {
    return this.verbFences.displacedRunObservation(run);
  }
  displacedRunBusy(run: Run): Promise<boolean> {
    return this.verbFences.displacedRunBusy(run);
  }
  cancelDisplacedTurns(
    taskId: string,
    runs: Array<
      Pick<Run, "id" | "taskId" | "agentId" | "workspaceId"> & {
        role: Run["role"] | "worker";
      }
    >,
    verb: string,
  ): Promise<void> {
    return this.verbFences.cancelDisplacedTurns(taskId, runs, verb);
  }
  verbRunFenceRefusal(entry: { run: Run; why: string }): string {
    return this.verbFences.verbRunFenceRefusal(entry);
  }
  displaceRefusal(entry: { run: Run; why: string }): string {
    return this.verbFences.displaceRefusal(entry);
  }
  settleVerbFences(
    taskId: string,
    settle: {
      detail: string;
      runIds: string[];
      preserveEpisode?: boolean;
      displacedRunIds?: string[];
    },
  ): void {
    this.verbFences.settleVerbFences(taskId, settle);
    // The commit boundary of every author-round verb that settles fences (move
    // to=work, restart role=worker): an accepted round past the revision cap is
    // recorded here, in the verb's own transaction, so only an applied verb grants it.
    recordAcceptedRevisionRound(this, taskId);
  }
  releaseDisplacedRunsInTx(
    taskId: string,
    runIds: string[],
    detail: string,
  ): void {
    this.verbFences.releaseDisplacedRunsInTx(taskId, runIds, detail);
  }
  private releaseVerbFinishedRunIds(
    taskId: string,
    runIds: string[],
    notAppliedReason: string,
  ): void {
    this.verbFences.releaseVerbFinishedRunIds(taskId, runIds, notAppliedReason);
  }
  releaseVerbFinishedRuns(
    taskId: string,
    runs: Run[],
    notAppliedReason: string,
  ): void {
    this.verbFences.releaseVerbFinishedRuns(taskId, runs, notAppliedReason);
  }

  /**
   * A recorded wait must not interrupt live work: observe the current run, apply
   * its result, then take effect before the next dispatch. Yield while a run is
   * unreleased, its completion is still unprocessed, the retained agent is live,
   * or recovery is active.
   */
  prerequisiteWaitYieldsToLiveWork(task: Task): boolean {
    return this.taskQuantumOwner.prerequisiteWaitYieldsToLiveWork(task);
  }

  taskQuantum(taskId: string): Promise<void> {
    return this.taskQuantumOwner.taskQuantum(taskId);
  }
  /**
   * The lifecycle steps of one quantum. A recorded wait for a prerequisite marks
   * `quantum` so the finish step is skipped, as it was before the split.
   */
  quantumSteps(
    taskId: string,
    task: Task,
    quantum: { pausedForPrerequisiteWait: boolean },
  ): Promise<void> {
    return this.taskQuantumOwner.quantumSteps(taskId, task, quantum);
  }
  /** Closing reconciliation, thread archive and title projection for one quantum. */
  quantumFinish(taskId: string): Promise<void> {
    return this.taskQuantumOwner.quantumFinish(taskId);
  }
  unavailableGroups(): Set<string> {
    return unavailableGroupNames(this.store.availability());
  }
  replacementCeilingRefusal(task: Task): string {
    return replacementCeilingRefusal(task);
  }
  archiveRetiredErroredAgents(): Promise<void> {
    return archiveRetiredErroredAgents(this);
  }
  recoverExhaustedWorkers(): Promise<void> {
    return this.workerFailover.recoverExhaustedWorkers();
  }
  recoverExistingWorkspace(task: Task): Promise<boolean> {
    return this.workspaceProvisioning.recoverExistingWorkspace(task);
  }
  /** Spec 068 batch A: settle an uncertain first workspace creation by lookup. */
  settleWorkspaceCreation(task: Task): Promise<WorkspaceSettlement> {
    return settleWorkspaceCreation(this, task);
  }
  ensureSiblings(task: Task): Promise<Task> {
    return this.workspaceProvisioning.ensureSiblings(task);
  }
  removeSiblings(taskId: string): Promise<void> {
    return this.workspaceProvisioning.removeSiblings(taskId);
  }
  compareSiblings(task: Task, eventId: string): Promise<Task> {
    return this.workspaceProvisioning.compareSiblings(task, eventId);
  }
  refreshCheckoutSiblings(
    task: Task,
    cause: "worker_creation" | "prerequisite_release",
  ): Promise<Task> {
    return this.workspaceProvisioning.refreshCheckoutSiblings(task, cause);
  }
  prepareWorktreeLinks(
    task: Task,
  ): Promise<{ task: Task; recordFailure: string | null }> {
    return this.workspaceProvisioning.prepareWorktreeLinks(task);
  }
  ensureSharedSiblingCheckouts(task: Task) {
    return this.workspaceProvisioning.ensureSharedSiblingCheckouts(task);
  }
  readStash(directory: string) {
    return this.workspaceProvisioning.readStash(directory);
  }
  launchAgent(task: Task): Promise<void> {
    return this.workerLauncher.launchAgent(task);
  }
  launchAgentOnce(task: Task): Promise<void> {
    return this.workerLauncher.launchAgentOnce(task);
  }
  continuationOwnsReturn(taskId: string): boolean {
    return this.workerReconcile.continuationOwnsReturn(taskId);
  }
  async reconcileBargeCustodyForTask(task: Task): Promise<void> {
    const fresh = this.store.taskOrNull(task.id);
    if (
      !fresh ||
      fresh.workspaceAllocation?.provider !== "barge" ||
      fresh.workspaceAllocation.state !== "leased"
    )
      return;
    const bridge = this.adapter.workspaceAllocationBridge;
    try {
      await verifyBargeLeaseAndCustody({
        allocation: fresh.workspaceAllocation,
        saveAllocation: bridge
          ? (updated) => bridge.saveWorkspaceAllocation(fresh.id, updated)
          : undefined,
        cliOptions: bridge?.bargeCliOptions,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.store.event(fresh.id, "barge_custody_lost", reason);
      if (!["done", "cancelled"].includes(fresh.phase) && !fresh.removedAt) {
        this.note(
          fresh.id,
          `Barge lease custody lost (return fenced): ${reason}`,
          "operator_needed",
          "needs_attention",
        );
      }
    }
  }
  async reconcileBargeCustodians(): Promise<void> {
    for (const task of this.store.tasks()) {
      if (
        task.workspaceAllocation?.provider === "barge" &&
        task.workspaceAllocation.state === "leased" &&
        !task.removedAt
      ) {
        await this.reconcileBargeCustodyForTask(task);
      }
    }
  }
  async reconcile(task: Task): Promise<void> {
    if (
      task.workspaceAllocation?.provider === "barge" &&
      task.workspaceAllocation.state === "leased"
    ) {
      await this.reconcileBargeCustodyForTask(task);
    }
    return this.workerReconcile.reconcile(task);
  }
  reconcileObservation(task: Task) {
    return this.workerReconcile.reconcileObservation(task);
  }
  reconcileBranchPr(current: Task): Promise<boolean> {
    return this.workerReconcile.reconcileBranchPr(current);
  }
  reconcileReportingBinding(
    current: Task,
    mismatch: NonNullable<ReturnType<typeof reportingIdentityMismatch>>,
  ): Promise<void> {
    return this.workerReconcile.reconcileReportingBinding(current, mismatch);
  }
  reconcileBlockedReturn(
    task: Task,
    current: Task,
    state: Awaited<ReturnType<Adapter["observe"]>>,
  ): boolean {
    return this.workerReconcile.reconcileBlockedReturn(task, current, state);
  }
  acceptWorkerResult(task: Task, current: Task): Promise<void> {
    return this.workerReconcile.acceptWorkerResult(task, current);
  }
  branchPrLookupDue(task: Task): boolean {
    return this.workerReconcile.branchPrLookupDue(task);
  }
  reportingBindingRecheckDue(task: Task): boolean {
    return this.workerReconcile.reportingBindingRecheckDue(task);
  }
  updateAfterOperatorRemap(task: Task) {
    return this.callbackIntake.updateAfterOperatorRemap(task);
  }
  reviewerContinuationInFlight(taskId: string, runId: string): boolean {
    return this.callbackIntake.reviewerContinuationInFlight(taskId, runId);
  }
  complete(input: Completion, token: string, credentialRunId?: string) {
    return this.callbackIntake.complete(input, token, credentialRunId);
  }
  completeCheckpoint(
    input: Completion,
    token: string,
  ): Promise<CheckpointResult> {
    return this.callbackIntake.completeCheckpoint(input, token);
  }
  rejectCheckpoint(
    task: Task,
    input: Completion,
    reason: string,
  ): CheckpointResult {
    return this.callbackIntake.rejectCheckpoint(task, input, reason);
  }
  completeReviewProgress(
    input: Completion,
    token: string,
  ): Promise<CheckpointResult> {
    return this.callbackIntake.completeReviewProgress(input, token);
  }
  rejectReviewProgress(
    task: Task,
    run: Run,
    input: Completion,
    limit: number,
    reason: string,
  ): CheckpointResult {
    return this.callbackIntake.rejectReviewProgress(
      task,
      run,
      input,
      limit,
      reason,
    );
  }
  /** Per-task continuation budget, a Queue setting with a fixed default. */
  reviewContinuationLimit(): number {
    return this.dispatchAdmission.reviewContinuationLimit();
  }
  recordObservation(
    task: Task,
    state: Awaited<ReturnType<Adapter["observe"]>>,
  ): void {
    return this.workerReconcile.recordObservation(task, state);
  }
  observeOnly(task: Task): Promise<void> {
    return this.workerReconcile.observeOnly(task);
  }
}
