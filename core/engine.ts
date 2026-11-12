import { TaskControlLifecycle } from './verbs/task-control-lifecycle';
import { HookRetention } from './hooks/retention';
import { EngineStop } from './recovery/engine-stop';
import { ProjectLifecycle } from './planning/project-lifecycle';
import { schedulingContext } from './scheduling/context';
import { PrerequisiteReleases } from './scheduling/prerequisites';
import { TaskQuantum } from './scheduling/task-quantum';
import { schedulingEngineContext } from './scheduling/context';
import { recoveryContext, recoveryEngineContext } from './recovery/context';
import { PlannerGrantCleanup } from './questions/planner-grants';
import { intakeContext } from './intake/context';

import { Dispatch } from "./dispatch/dispatch";
import { HOST_KIND_LABELS, profileCompatibility, routingProfiles } from "../shared/profiles";
import { hostKindOf } from "../shared/host-kind";
import type { HostCatalog } from "../shared/host";
import type { ProfileCompatibilityHost, ProfileCompatibilityRow } from "../shared/rpc/settings";
import { CreationRecovery } from "./recovery/creation-recovery";
import type { GitTransientEpisode } from './git/git-transient-backoff';

import { type WorkspaceDiscard } from './workspaces/orphan-worktree';
import type { IdentitySource } from '../shared/host-kind';
import { RecoverySettlement } from "./recovery/recovery";
import { Decisions } from "./planning/decisions";
import type { RepositoryRekeyInput } from "../shared/repository-rekey";

import { type VerifiedEnclosingOperation } from './planning/enclosing-operation';

import { z } from "zod";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import type { Task, Profile, Completion, CheckpointResult, Run, RecoveryActionBinding, BulkDisposition, BulkDispositionRequest, ReparentInput, ReviewEntryInput, WorkspaceArchiveRetry } from "../shared/contracts";
import { isTransportFailure } from "../shared/transport";

import { type TaskStopReason } from "../shared/task-stop";
export { capacityFor, occupiesSlot, recoveryCapacityFor } from "./dispatch/capacity";
import { capacityFor, occupiesSlot, recoveryCapacityFor } from "./dispatch/capacity";
export { isTransportFailure };
import { DEFAULT_UNCERTAIN_MERGE_RETRY_MS, ownerCandidateKind } from "../shared/contracts";
import { buildProjectSettings } from "./planning/project-settings";

import { DispatchAdmission } from "./dispatch/admission";
import { Store, digest, now } from "./store/store";
import type { Adapter, AgentObservation } from "./host/adapter";
import { HostFacade } from "./host/host-facade";
import { callerNativeId, foreignIdentityRefusal, parseAgentId } from '../shared/agent-identity';

import type { TaskControlInput, TaskControlRequest } from "../shared/contracts";
import type { TaskControlTask } from "../shared/contracts";
import { Dispositions, type DispositionRequest } from "./verbs/disposition";

import type { OperationAcceptance, OperationResult, QueueOperation } from "../shared/operations";

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
import { RetryEffectControls } from "./verbs/retry-effect";
import { CallbackIntake } from "./intake/callback-intake";
import { WorkerReconcile, completionReportsPr, INTERACTIVE_RUNNING_REASON, INTERACTIVE_WAIT_REASON } from "./recovery/worker-reconcile";
import { WorkerFailover, RETIRED_OBSERVATION_INTERVAL_MS, RETIRED_OBSERVATION_STALE_MS } from "./recovery/worker-failover";
import { Operations, SOURCE_PROMOTION_NOT_DELIVERED } from "./planning/operations";
// Moved to worker-failover.ts; re-exported because engine.ts exported them.
export { RETIRED_OBSERVATION_INTERVAL_MS, RETIRED_OBSERVATION_STALE_MS };
// Moved to worker-reconcile.ts; re-exported because engine.ts exported them.
export { completionReportsPr, INTERACTIVE_RUNNING_REASON, INTERACTIVE_WAIT_REASON };
import { TaskControlDispatcher } from "./verbs/dispatcher";

import { ReviewerControls } from "./verbs/reviewer";
import { TaskCompletion } from "./verbs/complete";
import { SettingsControls } from "./verbs/settings";
import { ForceVerbs } from "./verbs/force";
import { OwnerStop } from "./verbs/owner-stop";
import { PausedStops } from "./verbs/paused-stops";
import { ProofControls } from "./verbs/proof";
import { RouteControls } from "./verbs/route";
import { TaskRemoval } from "./verbs/removal";
import { WorkerLauncher } from "./dispatch/worker-launcher";
import { WorkspaceProvisioning } from "./workspaces/workspace-provisioning";
import { Projections } from "./store/projections";
import { Resolution } from "./resolution";
import { PROFILE_CATALOG_LOADING_REFUSAL, PROFILE_CATALOG_PENDING_REASON } from "./recovery/task-reasons";
import { reportingIdentityMismatch } from "./intake/reporting-identity";
import { RepositoryHooks, type HookEmissionResult } from "./hooks/hooks";
/** Pre-dispatch gates re-run automatically after main fast-forwarded under them; beyond this a human decides. */
export const PRE_DISPATCH_BASE_ADVANCE_LIMIT = 3;
import { RuntimeRetirementService } from './runtime/runtime-retirement';
import { admissionOf } from './host/admission';

import type { ReconciliationSweep } from '../shared/telemetry';

import { ownerPendingEffects, type OwnerEffect, type RouteRole, type RestartRole } from './verbs/owner-verbs';
import { RunRelease } from './recovery/fence-settlement';
import { Sweep } from "./scheduling/sweep";
import { TaskWakes } from './scheduling/task-wakes';
import { CompletionFollowUps } from './closeout/completion-follow-ups';
import { closeoutContext } from './closeout/context';
import { TerminalWorkspaceRetirement } from './closeout/terminal-workspace-retirement';
/** The primary host's catalog key, before (or without) a registered id for it. */
const PRIMARY_CATALOG = "\u0000primary";

export const STOPPED_BEFORE_DRAIN = () => new Error("Nucleus engine stopped before the requested reconciliation drain covered the fleet");

export class Engine {
  readonly taskControlLifecycle = new TaskControlLifecycle(schedulingContext(this, ['store', 'resolveTaskControl', 'hostAvailable', 'withHost', 'taskControlDispatcher', 'resolution', 'forceCallerAuthorized', 'selfForceRole']));

  readonly hookRetention = new HookRetention(schedulingContext(this, ['hooks', 'store']));

  readonly engineStop = new EngineStop(schedulingContext(this, ['resolution', 'store']));

  readonly projectLifecycle = new ProjectLifecycle(schedulingContext(this, ['adapter', 'activeHostId', 'host', 'store', 'plannerTicketPending']));

  readonly prerequisiteReleases = new PrerequisiteReleases(schedulingContext(this, ['cleanContext', 'pendingPrerequisiteReleases', 'prerequisiteReleaseWork', 'refreshCheckoutSiblings', 'scheduleLane', 'stopped', 'store', 'wakeRepository', 'wakeTask']));

  readonly taskQuantumOwner = new TaskQuantum(schedulingEngineContext(this, ['adapter', 'cleanContext', 'enqueueTitle', 'hooks', 'launchAgent', 'launchProofOnly', 'note', 'noteStepFailure', 'prerequisiteWaitYieldsToLiveWork', 'profileCatalogKnown', 'profiles', 'quantumFinish', 'quantumSteps', 'reconcile', 'reconcileClosedRetainedReviewer', 'recover', 'routeTask', 'settleFinishedRuns', 'settleHistoricalProofExecutions', 'settleRunBuildOutputs', 'settleSupersededIdleRuns', 'signoffDecisions', 'stopped', 'store', 'wakeRepository'], ['advance', 'beginValidationScanPass', 'holdProofOnlyGoWait', 'ownedToolHold', 'owns', 'raiseOperatorQuestions', 'reconcileHoldUntil', 'recordStop', 'recoverExternalMerge', 'recovery', 'resumeClearedAttention', 'settleBudgetClock']));

  readonly plannerGrantCleanup = new PlannerGrantCleanup(recoveryContext(this, ['adapter', 'host', 'signoffDecisions', 'store', 'withHost', 'hostAvailable']));

  private readonly hostContext = new AsyncLocalStorage<string>();
  get activeHostId(): string | undefined { return this.hostContext.getStore(); }
  resolveHostAdapter: (id: string) => Adapter | undefined = () => undefined;
  inventoryHostMatches: (id: string) => boolean = () => true;
  retiredObservationKey: (id: string) => string = () => 'retiredObservations';
  canReuseUnqualifiedOriginWorkspace: () => boolean = () => true;
  identifyOriginHost: (agentId: string, identitySource?: IdentitySource) => Promise<string | undefined> = async () => this.activeHostId ?? this.selectIngressHost();
  withHost<T>(id: string, fn: () => T): T { return this.hostContext.run(id, fn); }
  /** Registered and connected, independent of the ambient host context; the identity-routing read. */
  hostOnline(id: string): boolean { return Boolean(this.resolveHostAdapter(id)); }
  /** Runtime supplies the authenticated live-host selection at acceptance. */
  selectIngressHost: (explicit?: string, _repoPath?: string, _origin?: string | null) => string | undefined = explicit => explicit ?? this.store.getMeta<string>("hostId") ?? undefined;
  hostAvailable: (id: string) => boolean = () => true;
  taskHostAvailable(task: Task): boolean {
    return Boolean(task.hostId && (!this.activeHostId || this.activeHostId === task.hostId) && this.hostAvailable(task.hostId)
      && this.store.runs(task.id).every(run => run.hostId === task.hostId));
  }
  private sweepOwner?: Sweep;
  private get sweep(): Sweep { return this.sweepOwner ??= new Sweep(schedulingEngineContext(this, ['adapter', 'applyDeferredOwnerVerbs', 'archivePlannerGrants', 'archiveRetiredErroredAgents', 'auditPass', 'clearRetiredInvalidations', 'continueAwaitingReviewers', 'dispatchQueued', 'dispositionDeps', 'drainProjections', 'drainWaiters', 'enqueueTitle', 'ensureSweep', 'flushPrerequisiteReleases', 'host', 'hostAvailable', 'hostIds', 'inventoryHostMatches', 'lastHookCleanupAt', 'lifecycle', 'maxSweepWindows', 'migrateProjectOwnersToPlanners', 'noteStepFailure', 'observeRetiredWorkers', 'quiesce', 'reconcile', 'recoverExhaustedWorkers', 'removeSiblings', 'resumePausedStops', 'retiredObservationKey', 'retiredObservationPlan', 'scheduleLane', 'scheduleLifecycleFollowUp', 'scheduleTaskQuantum', 'settleQuiesce', 'startSweepChain', 'stopped', 'store', 'sweepChain', 'sweepCursor', 'sweepDeferred', 'sweepDeferredCursor', 'sweepMode', 'sweepOrder', 'sweepPending', 'sweepStats', 'sweepTicks', 'taskHostAvailable', 'wakeCapacityWaiter', 'wakePreludes', 'withHost'], ['checkpoints', 'delegateNativeQuestions', 'deliverDecisionNotices', 'deliverDrainNotices', 'deliverHoldNotices', 'deliverNotices', 'deliverQueuedMessages', 'observationTargets', 'observe', 'origins', 'raiseOperatorQuestions', 'recovery', 'resumeAskQuestions', 'resumeResponsibleAnsweredQuestions', 'settleBudgetClock'])); }
  readonly dispatchOwner = new Dispatch(this);
  private readonly dispatchAdmission = new DispatchAdmission({
    store: () => this.store,
    adapter: () => this.adapter,
    admission: () => this.admission,
    profileCatalogKnown: () => this.profileCatalogKnown(),
    withHost: (id, fn) => this.withHost(id, fn),
    hostAvailable: id => this.hostAvailable(id),
    workspacePressureWait: task => this.workspacePressureWait(task),
  });
  profiles: Profile[] = [];
  stopped = false;
  /**
   * Spec 027: Queue data directory for sibling worktrees
   * (`siblings/<taskId>/<repository name>`). Set by the runtime owner; null
   * skips sibling creation (tests and adapters without a data directory).
   */
  siblingDataDir: string | null = null;
  private readonly controlContext = new ControlContext();
  // Tests and `verbs/agent-controls.ts` reach these by name; these go with the delegates in F2.
  get selfForceRunId() { return this.controlContext.selfForceRunId; }
  get coordinatorActionRunId() { return this.controlContext.coordinatorActionRunId; }
  get replayingDeferredVerb() { return this.controlContext.replayingDeferredVerb; }
  // Test-facing state remains accessible through Engine until delegates are removed.
  get lastHookCleanupAt() { return this.sweep.lastHookCleanupAt; }
  set lastHookCleanupAt(value: number) { this.sweep.lastHookCleanupAt = value; }
  get sweepCursor() { return this.sweep.sweepCursor; }
  set sweepCursor(value: string | null) { this.sweep.sweepCursor = value; }
  get sweepDeferred() { return this.sweep.sweepDeferred; }
  set sweepDeferred(value: Task[]) { this.sweep.sweepDeferred = value; }
  get sweepDeferredCursor() { return this.sweep.sweepDeferredCursor; }
  set sweepDeferredCursor(value: string | null) { this.sweep.sweepDeferredCursor = value; }
  get sweepTicks() { return this.sweep.sweepTicks; }
  set sweepTicks(value: number) { this.sweep.sweepTicks = value; }
  get sweepChain() { return this.sweep.sweepChain; }
  set sweepChain(value: Promise<void> | null) { this.sweep.sweepChain = value; }
  get sweepMode() { return this.sweep.sweepMode; }
  set sweepMode(value: "window" | "drain" | null) { this.sweep.sweepMode = value; }
  get sweepPending() { return this.sweep.sweepPending; }
  set sweepPending(value: "window" | "drain" | null) { this.sweep.sweepPending = value; }
  get drainWaiters() { return this.sweep.drainWaiters; }
  get maxSweepWindows() { return this.sweep.maxSweepWindows; }
  set maxSweepWindows(value: number) { this.sweep.maxSweepWindows = value; }
  get sweepStats() { return this.sweep.sweepStats; }
  private laneSchedulerOwner?: LaneScheduler;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private taskWakesOwner?: TaskWakes;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get taskWakes(): TaskWakes { return this.taskWakesOwner ??= new TaskWakes(schedulingContext(this, ['resolution', 'admission', 'armGitTransient', 'cleanContext', 'completionFollowUps', 'deferGitTransient', 'dispatchQueued', 'dispatchTask', 'gitTransientWaiting', 'note', 'scheduleDispatch', 'scheduleLane', 'scheduleLifecycleFollowUp', 'scheduleOperation', 'scheduleTaskQuantum', 'stopped', 'store', 'taskHostAvailable', 'taskQuantum', 'terminalThreadsPending', 'transientKey', 'wakeTask', 'withHost'])); }
  private terminalWorkspaceRetirementOwner?: TerminalWorkspaceRetirement;
  private completionFollowUpsOwner?: CompletionFollowUps;
  get completionFollowUps(): CompletionFollowUps {
    const engine = this;
    return this.completionFollowUpsOwner ??= new CompletionFollowUps({
      get cleanContext() { return engine.cleanContext.bind(engine); },
      get enqueueCleanup() { return (...args: Parameters<Engine["enqueueCleanup"]>) => engine.enqueueCleanup(...args); },
      get scheduleCompletionFollowUp() { return (...args: Parameters<Engine["scheduleCompletionFollowUp"]>) => engine.scheduleCompletionFollowUp(...args); },
      get scheduleLifecycleFollowUp() { return (...args: Parameters<Engine["scheduleLifecycleFollowUp"]>) => engine.scheduleLifecycleFollowUp(...args); },
      get scheduleRunBuildOutputs() { return (...args: Parameters<Engine["scheduleRunBuildOutputs"]>) => engine.scheduleRunBuildOutputs(...args); },
      get scheduleTerminalArchiveRetry() { return (...args: Parameters<Engine["scheduleTerminalArchiveRetry"]>) => engine.scheduleTerminalArchiveRetry(...args); },
      get stopped() { return engine.stopped; },
      get store() { return engine.store; },
      get terminalThreadsPending() { return (...args: Parameters<Engine["terminalThreadsPending"]>) => engine.terminalThreadsPending(...args); },
      get transientKey() { return (...args: Parameters<Engine["transientKey"]>) => engine.transientKey(...args); },
      get wakeCapacityWaiter() { return (...args: Parameters<Engine["wakeCapacityWaiter"]>) => engine.wakeCapacityWaiter(...args); },
      get wakeIntegrationSuccessor() { return (...args: Parameters<Engine["wakeIntegrationSuccessor"]>) => engine.wakeIntegrationSuccessor(...args); },
      get wakeTask() { return (...args: Parameters<Engine["wakeTask"]>) => engine.wakeTask(...args); },
      get resolution() { return closeoutContext(engine.resolution, ['holdsIntegrationTurn', 'integrationActive']); },
    });
  }
  /** Replaceable by tests; forwards to the completion owner, which reads it at call time. */
  get completionFollowUpDelays(): number[] { return this.completionFollowUps.completionFollowUpDelays; }
  set completionFollowUpDelays(value: number[]) { this.completionFollowUps.completionFollowUpDelays = value; }
  private get laneScheduler(): LaneScheduler {
    return this.laneSchedulerOwner ??= new LaneScheduler(() => this.stopped, () => this.taskWakes.lifecycleFollowUps.size > 0, work => this.cleanContext(work));
  }
  // Tests seed and read this state on a bare engine; these go with the delegates in F2.
  private get activeLanes(): Set<string> { return this.laneScheduler.activeLanes; }
  private set activeLanes(value: Set<string>) { this.laneScheduler.activeLanes = value; }
  get wakePreludes(): number { return this.laneScheduler.wakePreludes; }
  set wakePreludes(value: number) { this.laneScheduler.wakePreludes = value; }
  private projectionsOwner?: Projections;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get projections(): Projections { return this.projectionsOwner ??= new Projections(this); }
  // Tests seed and read this state on a bare engine; these go with the delegates in F2.
  get titleQueue(): Set<string> { return this.projections.titleQueue; }
  set titleQueue(value: Set<string>) { this.projections.titleQueue = value; }
  get projectionEnqueued(): Map<string, number> { return this.projections.projectionEnqueued; }
  set projectionEnqueued(value: Map<string, number>) { this.projections.projectionEnqueued = value; }
  get projectionDone(): Map<string, number> { return this.projections.projectionDone; }
  set projectionDone(value: Map<string, number>) { this.projections.projectionDone = value; }
  get projectionWaiters(): (() => void)[] { return this.projections.projectionWaiters; }
  set projectionWaiters(value: (() => void)[]) { this.projections.projectionWaiters = value; }
  get projectionInFlight(): Set<string> { return this.projections.projectionInFlight; }
  set projectionInFlight(value: Set<string>) { this.projections.projectionInFlight = value; }
  get titleDraining(): Promise<void> | null { return this.projections.titleDraining; }
  set titleDraining(value: Promise<void> | null) { this.projections.titleDraining = value; }
  get cleanupQueue(): Array<{taskId:string;retryWorkspaceId?:string}> { return this.projections.cleanupQueue; }
  set cleanupQueue(value: Array<{taskId:string;retryWorkspaceId?:string}>) { this.projections.cleanupQueue = value; }
  get cleanupDraining(): Promise<void> | null { return this.projections.cleanupDraining; }
  set cleanupDraining(value: Promise<void> | null) { this.projections.cleanupDraining = value; }
  readonly resolution: Resolution;
  readonly hooks: RepositoryHooks;
  readonly retirement: RuntimeRetirementService;
  currentServiceBuildId: () => string = () => { throw new Error("Service build identity is not configured"); };
  private readonly operations: Operations;
  readonly lifecycle: Lifecycle;
  private readonly agentControls: AgentControls;
  private dispositionsOwner?: Dispositions;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get dispositions(): Dispositions { return this.dispositionsOwner ??= new Dispositions(this); }
  private verbFencesOwner?: VerbFences;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get verbFences(): VerbFences { return this.verbFencesOwner ??= new VerbFences(this); }
  private runReleaseOwner?: RunRelease;
  /** Built on first use: tests reach the delegates on an `Object.create(Engine.prototype)` engine. */
  private get runRelease(): RunRelease { return this.runReleaseOwner ??= new RunRelease(this); }
  private readonly taskRemoval: TaskRemoval;
  private readonly workspaceProvisioning: WorkspaceProvisioning;
  private readonly workerLauncher: WorkerLauncher;
  private readonly creationRecovery: CreationRecovery;
  private readonly briefControls: BriefControls;
  private readonly settingsControls: SettingsControls;
  readonly ownerStop: OwnerStop;
  private readonly reviewerControls: ReviewerControls;
  readonly moveControls: MoveControls;
  readonly restartControls: RestartControls;
  private readonly retryEffectControls: RetryEffectControls;
  private readonly workerReconcile: WorkerReconcile;
  private readonly callbackIntake: CallbackIntake;
  private readonly workerFailover: WorkerFailover;
  readonly taskControlDispatcher: TaskControlDispatcher;
  private readonly recoverySettlement: RecoverySettlement;
  private readonly pausedStops: PausedStops;
  private readonly routeControls: RouteControls;
  private readonly taskCompletion: TaskCompletion;
  readonly proofControls: ProofControls;
  readonly forceVerbs: ForceVerbs;
  private readonly unsubscribePrerequisites: () => void;
  /** Spec 052 routing sign-off asks the operator through the decisions surface. */
  readonly signoffDecisions: Decisions;
  /** The Host contract over this engine's adapter, read at each call (`core/host/host-facade.ts`). */
  get host(): HostFacade { return new HostFacade(this); }
  constructor(readonly store: Store, readonly adapter: Adapter, readonly idleGraceMs = 60000, readonly submissionReady: () => boolean = () => true, retirement?: RuntimeRetirementService, readonly uncertainMergeRetryMs = DEFAULT_UNCERTAIN_MERGE_RETRY_MS, hostRunStateDir?: string) {
    this.primaryAdapter = adapter;
    this.resolveHostAdapter = () => adapter;
    this.adapter = new Proxy(adapter, {
      get: (fallback, property) => {
        const id = this.hostContext.getStore();
        const selected = id ? this.resolveHostAdapter(id) : fallback;
        if (!selected) throw new Error(`Transport not connected: host ${id} is unavailable`);
        const value = Reflect.get(selected, property, selected);
        if (property === 'inspectReviewEntry' && typeof value === 'function') {
          return async (input: ReviewEntryInput, taskId?: string, suppliedProof?: { origin: import('./host/adapter').OriginAgent; state: AgentObservation }) => {
            if (suppliedProof || !taskId) return value.call(selected, input, taskId, suppliedProof);
            const task = this.store.task(taskId), originHost = task.originHostId;
            if (!originHost) throw new Error('Transport not connected: review-entry origin host is unknown');
            if (originHost === task.hostId) return value.call(selected, input, taskId);
            if (!this.withHost(originHost, () => this.hostAvailable(originHost))) throw new Error(`Transport not connected: waiting for origin host ${originHost}`);
            const proof = await this.withHost(originHost, async () => {
              const origin = await this.host.originAgent(input.submission.originAgentId);
              if (!origin || origin.archived || !origin.workspaceId) throw new Error('Review entry requires a live originating thread');
              return { origin, state: await this.host.observe(origin.id) };
            });
            return value.call(selected, input, taskId, proof);
          };
        }
        if (typeof value !== 'function') return value;
        // Some older call sites still use adapter methods directly instead of
        // HostFacade. Keep that compatibility safe at the transport boundary:
        // qualified IDs are unwrapped only for the selected host, for every
        // host method whose arguments identify an agent, and a call that names
        // an agent on another registered host is routed there — the agent's own
        // transport serves it, never an unwrap against the wrong host.
        const native = (agentId: unknown): unknown => typeof agentId === 'string'
          ? callerNativeId(agentId, id ?? (selected as Adapter & { hostId?: string }).hostId)
          : agentId;
        const agentArgs: Record<string, number[]> = {
          originAgent: [0], observe: [0], archiveAgent: [0], stopAgentTurn: [0],
          agentTimeline: [0], agentTimelinePage: [0], pendingQuestions: [0],
          answeredQuestions: [0], dismissNativeQuestion: [0], answerNativeQuestion: [0],
          answerNativePermission: [0], subscribeRunUsage: [0],
          notify: [0, 3], enqueueMessage: [0, 3], interruptAndContinue: [0],
          askPlanner: [0], askReviewer: [0],
        };
        const positions = agentArgs[String(property)];
        const bound = id ?? (selected as Adapter & { hostId?: string }).hostId;
        return (...args: unknown[]) => {
          // The recipient (position 0 of an agent-naming method) decides the
          // route: a call that names an agent on another registered host
          // re-enters this proxy inside that host's context, so the agent's own
          // transport serves it. A secondary identity on yet another host rides
          // out, the way the delegated ask route drops it; an unknown or offline
          // host refuses, named.
          const primary = positions?.[0] === 0 && typeof args[0] === 'string' ? parseAgentId(args[0]) : null;
          if (primary && primary.hostId !== bound) {
            if (!this.hostOnline(primary.hostId)) throw new Error(foreignIdentityRefusal(primary.hostId));
            const rideAlong = args.slice();
            for (const position of (positions ?? []).slice(1)) {
              const parsed = typeof rideAlong[position] === 'string' ? parseAgentId(rideAlong[position] as string) : null;
              if (parsed && parsed.hostId !== primary.hostId) rideAlong[position] = undefined;
            }
            const sourceInput = rideAlong[1];
            if ((property === 'askPlanner' || property === 'askReviewer') && sourceInput
              && typeof sourceInput === 'object' && 'sourceAgentId' in sourceInput) {
              const input = sourceInput as { sourceAgentId?: unknown };
              const parsed = typeof input.sourceAgentId === 'string' ? parseAgentId(input.sourceAgentId) : null;
              rideAlong[1] = { ...input, ...(parsed && parsed.hostId !== primary.hostId ? { sourceAgentId: undefined } : {}) };
            }
            return this.withHost(primary.hostId, () =>
              (this.adapter as unknown as Record<string, (...callArgs: unknown[]) => unknown>)[String(property)](...rideAlong));
          }
          const normalized = args.slice();
          for (const position of positions ?? []) if (normalized[position] !== undefined)
            normalized[position] = native(normalized[position]);
          if ((property === 'askPlanner' || property === 'askReviewer') && normalized[1]
            && typeof normalized[1] === 'object' && 'sourceAgentId' in normalized[1]) {
            const input = normalized[1] as { sourceAgentId?: unknown };
            normalized[1] = { ...input, ...(input.sourceAgentId === undefined ? {} : { sourceAgentId: native(input.sourceAgentId) }) };
          }
          if (property === 'observationInventory' && Array.isArray(normalized[0]))
            normalized[0] = (normalized[0] as unknown[]).map(native);
          return value.apply(selected, normalized);
        };
      },
      set: (fallback, property, value) => Reflect.set(fallback, property, value, fallback),
    });
    // Lean store 4 (task 989): the `workspace_creation_step_*` events went — nothing read
    // them. The dispatching task's reason line stays: it is the board-visible progress.
    this.adapter.workspaceCreationProgress = (taskId, step, status) => {
      try {
        if (status === "started" && this.store.task(taskId).phase === "dispatching")
          this.store.update(taskId, { reason: `Creating workspace: ${step.replaceAll("_", " ")}` });
      } catch { /* Progress reporting must not change workspace creation behavior. */ }
    };
    this.hooks = new RepositoryHooks(store, { wakeTask: taskId => { void this.cleanContext(() => this.wakeTask(taskId)); },
      retentionGateSettled: (taskId, worktree) => this.lifecycle.retentionReconciledAt(taskId, worktree),
      hostRunStateDir });
    this.resolution = new Resolution(store, this.adapter, () => this.profilesFor(this.activeHostId), () => this.stopped, idleGraceMs, this.hooks, uncertainMergeRetryMs);
    this.resolution.hostAvailable = (task, run) => this.taskHostAvailable(task) && (!run || run.hostId === task.hostId);
    this.resolution.withHost = (id, fn) => this.withHost(id, fn);
    this.resolution.hostOnline = id => this.hostOnline(id);
    this.resolution.inventoryHostMatches = id => this.inventoryHostMatches(id);
    this.resolution.originHostAvailable = id => this.hostAvailable(id);
    // A host-dependent call arriving just after a roll waits out the runtime's
    // own bridge connection instead of refusing as unavailable (roll-recovery
    // contract): the poll is bounded and ends at once once the bridge answers.
    this.resolution.awaitHostBridge = async waitMs => {
      const deadline = Date.now() + waitMs;
      while (!this.submissionReady()) {
        if (Date.now() >= deadline || this.stopped) return false;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return true;
    };
    this.resolution.canReuseUnqualifiedOriginWorkspace = () => this.canReuseUnqualifiedOriginWorkspace();
    this.resolution.identifyOriginHost = (id, identitySource) => this.identifyOriginHost(id, identitySource);
    this.resolution.gitTransientFailure = (task, error) => this.deferGitTransient(task.id, error);
    this.resolution.gitTransientRecovered = (task, source) => {
      const key = this.transientKey(task.id);
      const episode = this.store.getMeta<GitTransientEpisode | null>(key);
      if (episode && episode.retryAt <= Date.now() && episode.source === source) this.store.deleteMeta(key);
    };
    this.resolution.turnReleased = repoPath => this.wakeIntegrationSuccessor(repoPath);
    this.resolution.catalogKnown = () => this.profileCatalogKnownFor(this.activeHostId);
    // Spec 058 (task 523): an operator's answer to Queue's own question applies
    // through the ordinary owner controls, with that answer as the authority.
    this.resolution.applyOperatorControl = (input) =>
      this.performTaskControl(input);
    this.signoffDecisions = new Decisions(store);
    this.resolution.recovery.setCoordinatorActionHandler((task, run, action) => this.applyCoordinatorAction(task, run, action));
    this.resolution.recovery.setResponsibleFaultHandler((task) => this.settleResponsibleFault(task));
    this.retirement = retirement ?? new RuntimeRetirementService(store);
    this.lifecycle = new Lifecycle(schedulingEngineContext(this, ['adapter', 'drainCleanup', 'enqueueCleanup', 'hooks', 'host', 'removeSiblings', 'retirement', 'scheduleRetirement', 'scheduleRunBuildOutputs', 'settleObservedIdleRuns', 'settleTerminalIntentRuns', 'settleTerminalRecoveryEpisode', 'stopped', 'store', 'taskHostAvailable', 'withHost'], ['adapter', 'closeoutAuthority', 'hasEarlierIntegrationTurn', 'lease', 'attention', 'environmentDeferred', 'transportDeferred', 'update']));
    this.agentControls = new AgentControls(this);
    this.taskRemoval = new TaskRemoval(this);
    this.workspaceProvisioning = new WorkspaceProvisioning(this);
    this.workerLauncher = new WorkerLauncher(this);
    this.creationRecovery = new CreationRecovery(recoveryEngineContext(this, ['adapter', 'idleGraceMs', 'launchAgent', 'launchProofOnly', 'note', 'reconcileAbsentWorker', 'recoverProofOnlyDispatch', 'stopped', 'store'], ['ensureIncident', 'resolveIncident', 'resumeAbsentWorker', 'returnToDispatch', 'saveIncident']));
    this.briefControls = new BriefControls(this);
    this.settingsControls = new SettingsControls(this);
    this.ownerStop = new OwnerStop(this);
    this.reviewerControls = new ReviewerControls(this);
    this.moveControls = new MoveControls(this);
    this.restartControls = new RestartControls(this);
    this.retryEffectControls = new RetryEffectControls(this);
    this.workerReconcile = new WorkerReconcile(recoveryEngineContext(this, ['acceptWorkerResult', 'adapter', 'admission', 'branchPrLookupDue', 'compareSiblings', 'continuationOwnsReturn', 'hooks', 'host', 'idleGraceMs', 'note', 'reconcileBlockedReturn', 'reconcileBranchPr', 'reconcileObservation', 'reconcileReportingBinding', 'recordObservation', 'reportingBindingRecheckDue', 'stopped', 'store', 'updateAfterOperatorRemap'], ['adoptReplacementPr', 'attention', 'extendCallbackReminder', 'heavyRunAlive', 'identifyOriginHost', 'withHost', 'reconcileStalledTurnStop', 'recovery', 'remindStoppedWorker', 'resolveIncident', 'responsiblePrReportRefused', 'settleAutomaticReplayHold', 'stalls', 'suppressAutomaticRetry', 'update', 'waiting']));
    const engine = this;
    this.callbackIntake = new CallbackIntake({
      get adapter() { return engine.adapter; },
      get cleanContext() { return engine.cleanContext.bind(engine); },
      get completeCheckpoint() { return engine.completeCheckpoint.bind(engine); },
      get completeReviewProgress() { return engine.completeReviewProgress.bind(engine); },
      get control() { return engine.control.bind(engine); },
      get host() { return engine.host; },
      get rejectCheckpoint() { return engine.rejectCheckpoint.bind(engine); },
      get rejectReviewProgress() { return engine.rejectReviewProgress.bind(engine); },
      get reviewerContinuationInFlight() { return engine.reviewerContinuationInFlight.bind(engine); },
      get reviewContinuationLimit() { return engine.reviewContinuationLimit.bind(engine); },
      get stopped() { return engine.stopped; },
      get store() { return engine.store; },
      get wake() { return engine.wake.bind(engine); },
      get wakeTask() { return engine.wakeTask.bind(engine); },
      get withHost() { return engine.withHost.bind(engine); },
      get resolution() { return intakeContext(engine.resolution, ['attention', 'complete', 'settleCompletedExecutorBlocker']); },
    });
    this.workerFailover = new WorkerFailover(recoveryEngineContext(this, ['activeHostId', 'adapter', 'host', 'launchAgent', 'note', 'profileCatalogKnown', 'profiles', 'replacementCeilingRefusal', 'retiredObservationKey', 'stopped', 'store', 'taskHostAvailable', 'unavailableGroups', 'withHost'], ['recordStop', 'resumeTransientProviderThread', 'resumeTransientWorker', 'retainedWorkerProfileIssue', 'suppressAutomaticRetry', 'transportDeferred', 'waiting']));
    this.taskControlDispatcher = new TaskControlDispatcher(this);
    this.recoverySettlement = new RecoverySettlement(recoveryEngineContext(this, ['coordinatorActionRunId', 'host', 'performTaskControl', 'store'], ['attention', 'recovery', 'update']));
    this.pausedStops = new PausedStops(this);
    this.routeControls = new RouteControls(this);
    this.taskCompletion = new TaskCompletion(this);
    this.proofControls = new ProofControls(this);
    this.forceVerbs = new ForceVerbs(this);
    this.operations = new Operations(this);
    this.unsubscribePrerequisites = store.onPrerequisitesSettled(ids => {
      for (const id of ids) this.pendingPrerequisiteReleases.add(id);
      void this.flushPrerequisiteReleases();
    });
  }
  get pendingPrerequisiteReleases(): Set<string> { return this.prerequisiteReleases.pendingPrerequisiteReleases; }
  get prerequisiteReleaseWork() { return this.prerequisiteReleases.prerequisiteReleaseWork; }
  set prerequisiteReleaseWork(value: Promise<void> | null) { this.prerequisiteReleases.prerequisiteReleaseWork = value; }
  /** Refresh affected dependents once, then wake each repository once per batch. */
  flushPrerequisiteReleases(): Promise<void> { return this.prerequisiteReleases.flushPrerequisiteReleases(); }
  /** Registered secondary host ids; the service wires this to the host registry. */
  hostIds: () => readonly string[] = () => [];
  /** One routing-profile snapshot per secondary host, built from that host's own catalog (nucleus#1139). */
  private readonly hostProfiles = new Map<string, Profile[]>();
  private readonly hostCatalogRefreshed = new Set<string>();
  private readonly primaryAdapter: Adapter;
  /** Admission evidence attached to this engine's Paseo adapter, when admitted. */
  get admission() { return admissionOf(this.adapter); }
  setSourcePromotionHandler(handler: (payload: unknown, hostId?: string, selection?: import('../shared/operations').QueueOperation['hostSelection']) => Promise<OperationResult>): void { this.operations.setSourcePromotionHandler(handler); }
  setLeadCheckHandler(handler: (payload: unknown, operationId: string) => Promise<OperationResult>): void { this.operations.setLeadCheckHandler(handler); }
  setRepositoryRekeyHandler(handler: (input: RepositoryRekeyInput) => OperationResult | Promise<OperationResult>): void { this.operations.setRepositoryRekeyHandler(handler); }
  async refresh() {
    if (!this.adapter.catalog) throw new Error("Host profile catalog is unavailable");
    const catalog = await this.adapter.catalog();
    this.hostCatalogs.set(PRIMARY_CATALOG, { catalog, readAt: new Date().toISOString() });
    this.profileCatalogRefreshed = true;
    // Each secondary host's availability is its own catalog's answer: a profile
    // whose thinking level or feature values that host does not report stays
    // ineligible there, so selection never sends a launch the host must refuse
    // (nucleus#1139). A failed read keeps the previous snapshot.
    for (const id of this.hostIds()) {
      const selected = this.resolveHostAdapter(id);
      if (!selected || !selected.catalog) continue;
      // The primary host's catalog is the profile set read above; only a
      // secondary host reads its own.
      if (selected === this.primaryAdapter) { this.primaryHostId = id; this.hostCatalogRefreshed.add(id); continue; }
      try { this.hostCatalogs.set(id, { catalog: await selected.catalog(), readAt: new Date().toISOString() }); this.hostCatalogRefreshed.add(id); }
      catch { /* keep any previous snapshot; dispatch waits through its own gates */ }
    }
    this.rebuildProfiles();
  }
  /**
   * The routing snapshots from the catalogs last read and the stored profiles,
   * with each host kind's mapping and exclusions applied (nucleus#1151). A
   * Settings edit calls this so selection follows it at once; no host is read.
   */
  rebuildProfiles(): void {
    const profiles = this.store.profiles(), providerMap = this.store.providerMap();
    const primary = this.hostCatalogs.get(PRIMARY_CATALOG);
    if (primary) this.profiles = routingProfiles(profiles, primary.catalog, providerMap, hostKindOf(this.primaryHostId));
    for (const [id, read] of this.hostCatalogs)
      if (id !== PRIMARY_CATALOG) this.hostProfiles.set(id, routingProfiles(profiles, read.catalog, providerMap, hostKindOf(id)));
  }
  /**
   * Each stored profile on each known host (nucleus#1151): computed on read from
   * the catalog Nucleus last read from that host, so a catalog change or a
   * Settings edit shows at once. A host never read answers `unknown`.
   */
  profileCompatibility(): { hosts: ProfileCompatibilityHost[]; rows: ProfileCompatibilityRow[] } {
    const profiles = this.store.profiles(), providerMap = this.store.providerMap();
    const ids = [...new Set([...(this.primaryHostId ? [this.primaryHostId] : []), ...this.hostIds()])];
    const hosts: ProfileCompatibilityHost[] = [], rows: ProfileCompatibilityRow[] = [];
    for (const id of ids) {
      const selected = this.resolveHostAdapter(id);
      const primary = id === this.primaryHostId || (selected !== undefined && selected === this.primaryAdapter);
      const read = this.hostCatalogs.get(primary ? PRIMARY_CATALOG : id) ?? null;
      const kind = hostKindOf(id);
      hosts.push({ hostId: id, kind, label: HOST_KIND_LABELS[kind], online: this.hostOnline(id), readAt: read?.readAt ?? null, catalog: read?.catalog ?? null });
      for (const profile of profiles) {
        if (!read) { rows.push({ profileId: profile.id, hostId: id, status: "unknown", reason: `${HOST_KIND_LABELS[kind]}'s catalog has not been read yet`, mapped: [], launch: null }); continue; }
        const answer = profileCompatibility(profile, read.catalog, providerMap, kind);
        rows.push({ profileId: profile.id, hostId: id, status: answer.status, reason: answer.reason, mapped: answer.mapped, launch: answer.launch });
      }
    }
    return { hosts, rows };
  }
  /** The last catalog read per host; the primary host's under its own key until its id is known. */
  private readonly hostCatalogs = new Map<string, { catalog: HostCatalog; readAt: string }>();
  private primaryHostId: string | undefined;
  private profileCatalogRefreshed = false;
  /**
   * Whether the daemon profile catalog is known. A service starts with an empty
   * catalog until its first refresh; until then a profile's availability is
   * unknown, not unavailable, so launches, dispatch and named-profile controls
   * wait instead of parking or refusing (consumer #660: a restart processed 1.4 s
   * after a roll parked "profile Sol oracle is unavailable").
   */
  profileCatalogKnown(): boolean { return this.profileCatalogRefreshed || this.profiles.length > 0; }
  /** The routing profiles a task's own host reports; a host without a snapshot reads the primary set. */
  profilesFor(hostId?: string | null): Profile[] { return hostId ? this.hostProfiles.get(hostId) ?? this.profiles : this.profiles; }
  /**
   * Dispatch waits until the task's host's catalog is known, not only the primary's.
   * The primary host's catalog is the primary profile set; only a secondary host
   * with its own adapter waits for its own snapshot.
   */
  profileCatalogKnownFor(hostId?: string | null): boolean {
    if (!hostId) return this.profileCatalogKnown();
    const selected = this.resolveHostAdapter(hostId);
    if (!selected || selected === this.primaryAdapter) return this.profileCatalogKnown();
    return this.hostCatalogRefreshed.has(hostId);
  }
  requireProfileCatalog(): void {
    if (!this.profileCatalogKnown()) throw new Error(PROFILE_CATALOG_LOADING_REFUSAL);
  }
  /** Run detached work without inheriting the caller's async context. */
  cleanContext<T>(work: () => T): T {
    return cleanLaneScope.runInAsyncScope(() => {
      const scope = new AsyncResource("nucleus-lane-quantum");
      try { return scope.runInAsyncScope(work); }
      finally { scope.emitDestroy(); }
    });
  }
  /** Schedule one bounded quantum on an exclusive lane key. Same-key work is FIFO. */
  scheduleLane(key: string, priority: number, work: () => Promise<void> | void): Promise<void> { return this.laneScheduler.scheduleLane(key, priority, work); }
  quiesce(exclude?: "audit"): Promise<void> { return this.laneScheduler.quiesce(exclude); }
  private engineBusy(ignoreKey?: string): boolean { return this.laneScheduler.engineBusy(ignoreKey); }
  private pickLaneKey(): string | null { return this.laneScheduler.pickLaneKey(); }
  /** A count that rises whenever a lane quantum finishes: evidence a long pass is still making progress. */
  progressMark(): number { return this.laneScheduler.progressMark(); }
  private dispatchLanes(): void { this.laneScheduler.dispatchLanes(); }
  scheduleDispatch(): void { this.laneScheduler.scheduleDispatch(); }
  settleQuiesce(): void { this.laneScheduler.settleQuiesce(); }
  private discardQueuedLanes(): void { this.laneScheduler.discardQueuedLanes(); }

  transientKey(id: string): string { return this.taskWakes.transientKey(id); }
  armGitTransient(id: string, retryAt: number, operation = false): void { this.taskWakes.armGitTransient(id, retryAt, operation); }
  deferGitTransient(id: string, error: unknown, operation = false): boolean { return this.taskWakes.deferGitTransient(id, error, operation); }
  gitTransientWaiting(id: string, operation = false): boolean { return this.taskWakes.gitTransientWaiting(id, operation); }
  noteStepFailure(taskId: string, error: unknown): void { this.taskWakes.noteStepFailure(taskId, error); }
  neverDispatched(task: Task): boolean { return this.taskControlDispatcher.neverDispatched(task); }
  scheduleTaskQuantum(taskId: string): Promise<void> { return this.taskWakes.scheduleTaskQuantum(taskId); }
  wakeIntegrationSuccessor(repoPath: string): void { this.taskWakes.wakeIntegrationSuccessor(repoPath); }
  wakeCapacityWaiter(releasingTaskId: string): void { this.taskWakes.wakeCapacityWaiter(releasingTaskId); }
  scheduleCompletionFollowUp(task: Task, runs: Run[]): void { this.completionFollowUps.scheduleCompletionFollowUp(task, runs); }
  terminalThreadsPending(task: Task, runs: Run[]): boolean { return this.completionFollowUps.terminalThreadsPending(task, runs); }
  scheduleTerminalArchiveRetry(task: Task, runs: Run[]): void { this.completionFollowUps.scheduleTerminalArchiveRetry(task, runs); }
  scheduleLifecycleFollowUp(taskId: string): boolean { return this.taskWakes.scheduleLifecycleFollowUp(taskId); }
  wakeTask(taskId: string): Promise<void> { return this.taskWakes.wakeTask(taskId); }
  wakeRepository(repoPath: string | null | undefined): Promise<void> { return this.taskWakes.wakeRepository(repoPath); }
  /**
   * One bounded safety-sweep window: the restart and missed-event net. It
   * reconciles at most one cursor page, yields between quanta and is pre-empted
   * by any control, operation or read that arrives during it.
   */
  sweepOnce(): Promise<void> { return this.sweep.sweepOnce(); }
  /**
   * Explicit reconciliation: bounded cursor windows until the sweep has covered
   * the fleet once, then the queued title projection. Callbacks and task
   * controls do not use this; bootstrap, refresh and operator configuration do.
   */
  wake(): Promise<void> { return this.sweep.wake(); }
  /** Spec 052: an archived planner thread ends its grant. A failed inventory leaves grants standing. */
  archivePlannerGrants(): Promise<void> { return this.plannerGrantCleanup.archivePlannerGrants(); }
  /** Durable cursor evidence for service health and telemetry. */
  reconciliationSnapshot(): ReconciliationSweep { return this.sweep.reconciliationSnapshot(); }
  /**
   * Coalesce sweep requests: a running drain already covers every window, so a
   * concurrent drain is redundant while a single-window request still queues one
   * more bounded page behind a running window.
   */
  ensureSweep(mode: "window" | "drain"): Promise<void> { return this.sweep.ensureSweep(mode); }
  startSweepChain(mode: "window" | "drain"): void { return this.sweep.startSweepChain(mode); }
  /**
   * Ordered fleet snapshot for one pass. It is materialized once per pass and
   * kept in memory; each task's live state is re-read by its own quantum, so a
   * multi-page drain never re-parses the whole fleet for every page.
   */
  sweepOrder(includeDeferred: boolean): Task[] { return this.sweep.sweepOrder(includeDeferred); }
  control<T>(operation: () => Promise<T> | T, key: string): Promise<T> { return this.laneScheduler.control(operation, key); }
  startOperation(input: { key: string; kind: QueueOperation["kind"]; payload: unknown; taskId?: string; expectedVersion?: number; repoPath?: string; submissionId?: string; hostId?: string; deferSchedule?: boolean }): Promise<OperationAcceptance> { return this.operations.startOperation(input); }
  scheduleAcceptedOperation(operationId: string): void { this.operations.scheduleAcceptedOperation(operationId); }
  startSubmission(submission: Submission, requirePushedPlanning = false): Promise<OperationAcceptance> { return this.operations.startSubmission(submission, requirePushedPlanning); }
  resumeSubmissions(): void { this.operations.resumeSubmissions(); }
  operationStatus(operationId: string): QueueOperation { return this.operations.operationStatus(operationId); }
  awaitOperation(operationId: string, timeoutMs?: number): Promise<QueueOperation> { return this.operations.awaitOperation(operationId, timeoutMs); }
  resumeOperations(reconcileInterrupted = true): void { this.operations.resumeOperations(reconcileInterrupted); }
  reconcileSourcePromotion(operation: QueueOperation): void { this.operations.reconcileSourcePromotion(operation); }
  scheduleOperation(id: string): void { this.operations.scheduleOperation(id); }
  runOperation(id: string): Promise<void> { return this.operations.runOperation(id); }
  ownerSettledOperation(taskId: string | null, id: string): boolean { return this.operations.ownerSettledOperation(taskId, id); }
  effectIntentFor(operation: QueueOperation): QueueOperation["effect"] { return this.operations.effectIntentFor(operation); }
  rerecordPlanningBase(input: { taskId: string; version: number }): Promise<Task> { return this.operations.rerecordPlanningBase(input); }
  retryValidation(input: { taskId: string; version: number; rebindWorkspaceId?: string; removeOrphanWorkspace?: boolean; settleFences?: { detail: string; runIds: string[]; displacedRunIds?: string[] } }): Promise<Task> { return this.operations.retryValidation(input); }
  performOperation(operation: QueueOperation, payload: unknown): Promise<OperationResult> { return this.operations.performOperation(operation, payload); }
  submitPlanningSource(submission: Submission, source: { kind:"lead"|"papercut"; id:string; repository:string; digest:string; expectedSource:string }, initial?: Partial<Task>, hostId?: string, identitySource?: IdentitySource): Promise<OperationResult> { return this.operations.submitPlanningSource(submission, source, initial, hostId, identitySource); }
  performSubmit(submission: Submission, requirePushedPlanning?: boolean, promotion?: {source:{kind:"lead"|"papercut";id:string;repository:string;digest:string;expectedSource:string}; initial?: Partial<Task>; identitySource?: IdentitySource}, hostId?: string, selection?: import('../shared/operations').QueueOperation['hostSelection']): Promise<OperationResult> { return this.operations.performSubmit(submission, requirePushedPlanning, promotion, hostId, selection); }

  applyCoordinatorAction(task: Task, run: Run, binding: RecoveryActionBinding): Promise<void> { return this.recoverySettlement.applyCoordinatorAction(task, run, binding); }
  settleResponsibleFault(task: Task): Promise<boolean> { return this.recoverySettlement.settleResponsibleFault(task); }

  completeTask(input: TaskControlInput, operationId?: string): Promise<{ task: Task; idempotent: boolean }> {
    return this.taskCompletion.completeTask(input, operationId);
  }
  // async: an unknown task rejects like every other refusal instead of throwing before the promise exists.
  resolveTaskControl(input: TaskControlRequest): TaskControlInput { return this.taskControlLifecycle.resolveTaskControl(input); }
  performTaskControl(request: TaskControlRequest, operationId?: string): Promise<TaskControlTask> { return this.taskControlLifecycle.performTaskControl(request, operationId); }
  recordNoAutomaticRetryRule(input: TaskControlInput, result: Task): Task { return this.taskControlDispatcher.recordNoAutomaticRetryRule(input, result); }

  settleLadderControl(before: Task, after: Task, action: TaskControlInput["action"]): void { return this.resolution.ladder.settleLadderControl(before, after, action); }

  appliedWithVersionHint(input: TaskControlInput, operationId?: string): Promise<Task> { return this.taskControlDispatcher.appliedWithVersionHint(input, operationId); }
  performTaskControlApplied(input: TaskControlInput, operationId?: string): Promise<Task> { return this.taskControlDispatcher.performTaskControlApplied(input, operationId); }
  forceSettleEffect(task: Task, input: TaskControlInput): Task { return this.forceVerbs.forceSettleEffect(task, input); }
  forceSettlementRecord(task: Task, selected: ReturnType<typeof ownerPendingEffects>[number], input: TaskControlInput) { return this.forceVerbs.forceSettlementRecord(task, selected, input); }
  forceCallerAuthorized(task: Task, caller: string | undefined): boolean { return this.forceVerbs.forceCallerAuthorized(task, caller); }
  selfForceRole(task: Task): 'worker' | 'reviewer' | 'recovery' | null { return this.forceVerbs.selfForceRole(task); }
  forcePlanners(task: Task): Array<string | undefined> { return this.forceVerbs.forcePlanners(task); }
  forceCallerSource(task: Task, caller: string): 'operator_board' | 'project_planner' | 'queue_planner' | 'task_worker' | 'task_reviewer' | 'task_recovery' { return this.forceVerbs.forceCallerSource(task, caller); }
  forceMove(task: Task, input: TaskControlInput, operationId?: string): Promise<Task> { return this.forceVerbs.forceMove(task, input, operationId); }
  applyTaskControlComplete(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> { return this.taskControlDispatcher.applyTaskControlComplete(input, operated, operationId); }
  applyTaskControlDispose(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> { return this.taskControlDispatcher.applyTaskControlDispose(input, operated); }
  applyTaskControlWithdrawCancellation(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> { return this.taskControlDispatcher.applyTaskControlWithdrawCancellation(input, operated); }
  applyTaskControlRoute(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> { return this.taskControlDispatcher.applyTaskControlRoute(input, operated, operationId); }
  applyTaskControlRestart(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> { return this.taskControlDispatcher.applyTaskControlRestart(input, operated, operationId); }
  applyTaskControlReplacementPr(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> { return this.taskControlDispatcher.applyTaskControlReplacementPr(input, operated); }
  moveEnclosingInvocation(input: TaskControlInput,operationId?: string): () => VerifiedEnclosingOperation | undefined { return this.moveControls.moveEnclosingInvocation(input, operationId); }
  applyTaskControlMove(input: TaskControlInput,operated: <T>(result: T) => T,operationId?: string): Promise<Task> { return this.moveControls.applyTaskControlMove(input, operated, operationId); }
  applyTaskControlProof(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> {
    return this.proofControls.applyTaskControlProof(input, operated, operationId);
  }

  applyTaskControlRetryEffect(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> { return this.taskControlDispatcher.applyTaskControlRetryEffect(input, operated, operationId); }
  applyTaskControlRepinInstruction(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> { return this.taskControlDispatcher.applyTaskControlRepinInstruction(input, operated); }
  applyTaskControlAmendBrief(input: TaskControlInput, operated: <T>(result: T) => T): Task { return this.taskControlDispatcher.applyTaskControlAmendBrief(input, operated); }
  applyTaskControlSetLane(input: TaskControlInput, operated: <T>(result: T) => T): Promise<Task> { return this.settingsControls.applyTaskControlSetLane(input, operated); }
  applyTaskControlSetRouting(input: TaskControlInput, operated: <T>(result: T) => T): Task { return this.settingsControls.applyTaskControlSetRouting(input, operated); }
  applyTaskControlExcludeWorker(input: TaskControlInput, operated: <T>(result: T) => T): Task { return this.settingsControls.applyTaskControlExcludeWorker(input, operated); }
  applyTaskControlLocal(input: TaskControlInput, operated: <T>(result: T) => T): Task { return this.settingsControls.applyTaskControlLocal(input, operated); }
  restartParkedStep(task: Task, instruction: string | undefined, reviewerInstruction: string | undefined): Task { return this.restartControls.restartParkedStep(task, instruction, reviewerInstruction); }
  applyTaskControlHold(input: TaskControlInput, task: Task): Task { return this.settingsControls.applyTaskControlHold(input, task); }
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
  runBuildOutputHold(task: Task, record: Task["resolution"]["buildOutputCleanups"][number]): Promise<string | null> {
    return this.taskRemoval.runBuildOutputHold(task, record);
  }
  unreleasedRunIn(workspaceId: string): string | null {
    return this.taskRemoval.unreleasedRunIn(workspaceId);
  }
  workspaceParticipantsIdle(task: Task, workspaceId: string): Promise<ReadonlySet<string>> {
    return this.taskRemoval.workspaceParticipantsIdle(task, workspaceId);
  }
  settleWorkspaceRetirement(taskId: string): Promise<Task> {
    return (this.terminalWorkspaceRetirementOwner ??= new TerminalWorkspaceRetirement(closeoutContext(this, ['adapter', 'retirement', 'retentionHold', 'stopped', 'store', 'workspaceParticipantsIdle']))).settleWorkspaceRetirement(taskId);
  }
  recordRunBuildOutputState(taskId: string, record: Task["resolution"]["buildOutputCleanups"][number], state: "intent" | "complete" | "skipped" | "uncertain", detail: string) {
    return this.taskRemoval.recordRunBuildOutputState(taskId, record, state, detail);
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
  startBulkDisposition(input: BulkDispositionRequest, requestedBy?: string): Promise<BulkDisposition> {
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
  disposeTaskFromAgent(caller: { taskId: string; runId: string; token: string }, input: DispositionRequest): Promise<Task> {
    return this.agentControls.disposeTaskFromAgent(caller, input);
  }
  withdrawCancellationFromAgent(caller: { taskId: string; runId: string; token: string }, input: { taskId: string; version: number; reason: string }): Promise<Task> {
    return this.agentControls.withdrawCancellationFromAgent(caller, input);
  }
  bulkDispositionDetailFromAgent(caller: { taskId: string; runId: string; token: string }, operationId: string): BulkDisposition {
    return this.agentControls.bulkDispositionDetailFromAgent(caller, operationId);
  }
  startBulkDispositionFromAgent(caller: { taskId: string; runId: string; token: string }, input: BulkDispositionRequest): Promise<BulkDisposition> {
    return this.agentControls.startBulkDispositionFromAgent(caller, input);
  }
  retryBulkDispositionFromAgent(caller: { taskId: string; runId: string; token: string }, operationId: string): Promise<BulkDisposition> {
    return this.agentControls.retryBulkDispositionFromAgent(caller, operationId);
  }
  rejectFenced(task: Task, action: string): void { this.verbFences.rejectFenced(task, action); }
  completionSubscription(input:{taskId:string;version:number;agentId:string;action:"subscribe"|"unsubscribe"}):Promise<Task>{ return this.settingsControls.completionSubscription(input); }
  reparent(input:ReparentInput){ return this.settingsControls.reparent(input); }
  taskControlFromAgent(caller: {taskId: string; runId: string; token: string}, input: TaskControlRequest) {
    return this.agentControls.taskControlFromAgent(caller, input);
  }
  authenticateAgentControl(taskId:string,runId:string,token:string) {
    return this.agentControls.authenticateAgentControl(taskId,runId,token);
  }
  dependencyDetail(caller:{taskId:string;runId:string;token:string},targetTaskId:string) {
    return this.agentControls.dependencyDetail(caller,targetTaskId);
  }
  authenticatedDispositionDetail(caller: { taskId: string; runId: string; token: string }, taskId: string) {
    return this.agentControls.authenticatedDispositionDetail(caller, taskId);
  }
  recoveryTaskNextFromAgent(caller: { taskId: string; runId: string; token: string }) {
    return this.agentControls.recoveryTaskNextFromAgent(caller);
  }
  updateDependenciesFromAgent(caller:{taskId:string;runId:string;token:string},input:{taskId:string;version:number;dependsOn:string[]}) {
    return this.agentControls.updateDependenciesFromAgent(caller,input);
  }
  projectQueueDetail(caller:{taskId:string;runId:string;token:string},targetTaskId:string) {
    return this.agentControls.projectQueueDetail(caller,targetTaskId);
  }
  promoteTaskFromAgent(caller:{taskId:string;runId:string;token:string},input:{taskId:string;version:number}) {
    return this.agentControls.promoteTaskFromAgent(caller,input);
  }
  prepareWorkerResume(input:{taskId:string;version:number;instruction:string;settleFences?:{detail:string;runIds:string[];displacedRunIds?:string[]}}): Promise<() => Task> { return this.restartControls.prepareWorkerResume(input); }
  repinInstruction(input:{taskId:string;version:number}):Promise<Task>{
    return this.briefControls.repinInstruction(input);
  }
  amendBrief(input:{taskId:string;version:number;brief:string;reason:string;overtakes?:string[]}):Task{
    return this.briefControls.amendBrief(input);
  }

  requireAvailableGroup(profileId:string):void{
    this.routeControls.requireAvailableGroup(profileId);
  }
  briefStageProfileRefusal(text:string,_scope:Task["scope"]):string|null{
    return this.briefControls.briefStageProfileRefusal(text,_scope);
  }
  independentReviewRoutingRefusal(routing:RoutingPreflightInput, hostId?: string | null):string|null{
    return this.routeControls.independentReviewRoutingRefusal(routing, hostId);
  }
  moveToReview(input:{taskId:string;version:number;reason:string;reviewer?:{profileId:string;reason:string};caller?:string;prNumber?:number;fresh?:boolean},operationId?:string): Promise<Task> { return this.moveControls.moveToReview(input, operationId); }
  resumeReleasedPrerequisiteWait(taskId:string): void { return this.moveControls.resumeReleasedPrerequisiteWait(taskId); }
  moveToWork(input:{taskId:string;version:number;reason:string;instruction?:string;caller?:string;restart?:{afterSettlement:(settled:Task)=>Task;afterRevision:(revised:Task)=>Task}}): Promise<Task> { return this.moveControls.moveToWork(input); }
  moveToMerge(input:{taskId:string;version:number;reason:string;caller?:string;qualification?:string;head?:string;relayed?:boolean;delegated?:boolean;relayNote?:string}): Promise<Task> { return this.moveControls.moveToMerge(input); }

  assertDelegatedAuthority(caller:string|undefined,relayNote:string|undefined,purpose:string):{role:'delegated';kind:'delegated';note:string}{ return this.taskControlDispatcher.assertDelegatedAuthority(caller,relayNote,purpose); }
  assertOwnerAuthority(caller:string|undefined,relayed:boolean|undefined,relayNote:string|undefined,purpose?:string):{role:'operator'|'authorized_relay';kind:'operator'|'relayed_note';note:string|null}{ return this.taskControlDispatcher.assertOwnerAuthority(caller,relayed,relayNote,purpose); }
  recordWorkspaceDiscard(task:Task,workspaceId:string,directory:string,input:TaskControlInput,authority:{kind:'operator'|'relayed_note';note:string|null}): WorkspaceDiscard { return this.moveControls.recordWorkspaceDiscard(task, workspaceId, directory, input, authority); }
  moveToCloseout(input:{taskId:string;version:number;reason:string;caller?:string;qualification?:string;head?:string;
    relayed?:boolean;relayNote?:string;enclosing?:()=>VerifiedEnclosingOperation|undefined}): Promise<Task> { return this.moveControls.moveToCloseout(input); }
  reconcileRetainedExternalMerge(input:{task:Task;reason:string;caller?:string;qualification:string;head?:string;
    relayed?:boolean;relayNote?:string;enclosing:()=>VerifiedEnclosingOperation|undefined}): Promise<Task> { return this.moveControls.reconcileRetainedExternalMerge(input); }
  reconcileReviewEntryExternalMerge(input:{task:Task;reason:string;caller?:string;qualification?:string;head?:string;
    relayed?:boolean;relayNote?:string;enclosing:()=>VerifiedEnclosingOperation|undefined}): Promise<Task> { return this.moveControls.reconcileReviewEntryExternalMerge(input); }
  retryEffect(input:TaskControlInput,operationId?:string):Promise<Task>{ return this.retryEffectControls.retryEffect(input,operationId); }
  retryEffectBeforeSettlement(task:Task,input:TaskControlInput):Promise<Task>|null{ return this.retryEffectControls.retryEffectBeforeSettlement(task,input); }
  retryPublicationBeforeSettlement(task:Task,input:TaskControlInput,publication:OwnerEffect):Promise<Task>{ return this.retryEffectControls.retryPublicationBeforeSettlement(task,input,publication); }
  retryOwnedToolHold(task:Task,ownedTool:OwnerEffect):Promise<Task>{ return this.retryEffectControls.retryOwnedToolHold(task,ownedTool); }
  retryCancelledWorkspaceRetirement(task:Task,input:TaskControlInput):Promise<Task>{ return this.retryEffectControls.retryCancelledWorkspaceRetirement(task,input); }
  retryTerminalArchive(task:Task,input:TaskControlInput,archiveWorkspaceId:string,directory:string|null|undefined):Promise<Task>{ return this.retryEffectControls.retryTerminalArchive(task,input,archiveWorkspaceId,directory); }
  retrySupersededReviewView(task:Task,input:TaskControlInput,intentWorkspaceId:string):Promise<Task>{ return this.retryEffectControls.retrySupersededReviewView(task,input,intentWorkspaceId); }
  retryHookEffect(input:TaskControlInput,current:Task,eventId:string):Promise<Task>{ return this.retryEffectControls.retryHookEffect(input,current,eventId); }
  reconcilePublicationEffect(input:TaskControlInput,current:Task,runId:string):Promise<Task>{ return this.retryEffectControls.reconcilePublicationEffect(input,current,runId); }
  retryRecoveryEffect(task:Task,input:TaskControlInput,found:OwnerEffect):Promise<Task>{ return this.retryEffectControls.retryRecoveryEffect(task,input,found); }
  retryTaskControlOperation(task:Task,found:OwnerEffect):Promise<Task>{ return this.retryEffectControls.retryTaskControlOperation(task,found); }
  retryOrdinaryEffect(task:Task,input:TaskControlInput,found:{effect:string;kind:Exclude<OwnerEffect['kind'],'recovery_effect'|'task_control_operation'>},current:Task,expected:number):Promise<Task>{ return this.retryEffectControls.retryOrdinaryEffect(task,input,found,current,expected); }
  heldArchiveRetryReason(task: Task, workspaceId: string, recorded: WorkspaceArchiveRetry | null, discard: WorkspaceDiscard | null, discardedNow: boolean): string { return this.retryEffectControls.heldArchiveRetryReason(task, workspaceId, recorded, discard, discardedNow); }
  ownerStopHold(task: Task): boolean { return this.ownerStop.ownerStopHold(task); }
  ownerStopNamesRun(task: Task, runId: string | null | undefined): boolean { return this.ownerStop.ownerStopNamesRun(task, runId); }

  /** Round 4: a direct owner call — not a coordinator report and not a deferred replay. */
  isOwnerCall(): boolean { return this.controlContext.isOwnerCall(); }

  deferredRestartSupersedesOwnerStop(task: Task): boolean { return this.ownerStop.deferredRestartSupersedesOwnerStop(task); }
  dispatchWaitsFor(task: Task, ownerStopYields?: boolean, inFlight?: boolean): "paused" | "held" | null { return this.ownerStop.dispatchWaitsFor(task, ownerStopYields, inFlight); }
  releaseOwnerStopHold(taskId: string, allowDeferredReplay?: boolean): boolean { return this.ownerStop.releaseOwnerStopHold(taskId, allowDeferredReplay); }
  deferOwnerVerb(task: Task, input: TaskControlInput, why: "paused" | "held", target: { runId: string; checkpointOrdinal?: number; head?: string } | null): Task { return this.ownerStop.deferOwnerVerb(task, input, why, target); }
  continueAwaitingReviewers(tasks: Task[]): Promise<void> { return this.ownerStop.continueAwaitingReviewers(tasks); }
  applyDeferredOwnerVerbs(): Promise<void> { return this.ownerStop.applyDeferredOwnerVerbs(); }
  stopTask(input: TaskControlInput): Promise<Task> { return this.ownerStop.stopTask(input); }

  stopActiveThreads(input: { caller?: string } = {}): Promise<z.infer<typeof stopThreads.output>> {
    return this.pausedStops.stopActiveThreads(input);
  }

  resumePausedStops(): Promise<void> {
    return this.pausedStops.resumePausedStops();
  }

  routeTask(input: TaskControlInput, operationId?: string): Promise<Task> {
    return this.routeControls.routeTask(input, operationId);
  }
  restartParked(input: TaskControlInput, task: Task, role: RestartRole, reason: string, operationId?: string): Promise<Task> { return this.restartControls.restartParked(input, task, role, reason, operationId); }
  reviewerInstructionHeadProof(task: Task, version: number, commit: () => Task): Promise<Task> | null { return this.restartControls.reviewerInstructionHeadProof(task, version, commit); }
  executeEpisodeRestart(taskId: string, displacement: { runIds: string[]; cancel: () => Promise<void> }, admit: () => Promise<Task | (() => Task | Promise<Task>)>, runIds?: string[]): Promise<Task> { return this.restartControls.executeEpisodeRestart(taskId, displacement, admit, runIds); }
  workerRestartArm(task: Task, input: { reason: string; instruction?: string; caller?: string; relayed?: boolean; note?: string;
    fresh?: boolean; observedWorker?: AgentObservation; supersedeNonDelivery?: boolean }): { afterSettlement: (settled: Task) => Task; afterRevision: (revised: Task) => Task } { return this.restartControls.workerRestartArm(task, input); }
  restartTask(input: TaskControlInput, operationId?: string): Promise<Task> { return this.restartControls.restartTask(input, operationId); }

  continueRetainedReviewer(task: Task, options: {
    version: number; reason: string; instruction: string; ownerStopYields: boolean;
    deferrable: TaskControlInput; verb: "restart" | "move";
  }, operationId?: string): Promise<Task> { return this.reviewerControls.continueRetainedReviewer(task, options, operationId); }
  preserveRetainedReviewer(input: { taskId: string; version: number; reason: string; caller?: string }, task: Task, reader: Run,
    pr: { url: string; head: string }, finished: { settleable: Run[] }, state: string): Promise<Task> { return this.reviewerControls.preserveRetainedReviewer(input, task, reader, pr, finished, state); }
  restartReview(taskId: string, reason: string, instruction: string, fresh = true): Promise<Task> { return this.reviewerControls.restartReview(taskId, reason, instruction, fresh); }

  private routeLiveRun(task: Task, role: RouteRole): { run: Run | null } | null { return this.routeControls.routeLiveRun(task, role); }

  private stopRouteRun(task: Task, role: RouteRole, run: Run | null, operationId?: string): Promise<boolean> { return this.routeControls.stopRouteRun(task, role, run, operationId); }

  private assertRouteGroupAvailable(profileId: string, role: RouteRole): void { this.routeControls.assertRouteGroupAvailable(profileId, role); }
  stopStalledTurn(input:{taskId:string;version:number;runId:string}): Promise<Task> { return this.restartControls.stopStalledTurn(input); }
  prepareAbsentResolution(input:{taskId:string;version:number;settleFences?:{detail:string;runIds:string[];displacedRunIds?:string[]}}, restart?:{input:TaskControlInput;instruction:string}): Promise<Task | (()=>Task | Promise<Task>)> { return this.restartControls.prepareAbsentResolution(input, restart); }
  async stop() {
    this.stopped = true;
    this.unsubscribePrerequisites();
    this.taskWakes.stop();
    this.projections.stop();
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
  notePreDispatchHold(id: string, emission: HookEmissionResult) { return this.dispatchOwner.notePreDispatchHold(id, emission); }
  /**
   * The consumer-owned retention gate as an archive caller consumes it: emit
   * `task.pre_archive` for the retained worktree and report a hold with the
   * hook's evidence. A repository with no bound hook reports no hold.
   */
  retentionHold(taskId: string, target: { directory: string; head: string }, reason: string): Promise<{ hold: boolean; detail: string }> { return this.hookRetention.retentionHold(taskId, target, reason); }
  /**
   * Record a stop or wait from the engine. Callers name the stop reason;
   * `classify` is for exception or agent error text Queue did not author.
   */
  note(id: string, reason: string, stop: TaskStopReason | "classify", phase?: Task["phase"]): void { return this.engineStop.note(id, reason, stop, phase); }
  enqueueTitle(taskId: string): void {
    this.projections.enqueueTitle(taskId);
  }
  drainTitles(): Promise<void> {
    return this.projections.drainTitles();
  }
  scheduleRetirement(taskId: string): void {
    this.projections.scheduleRetirement(taskId);
  }
  enqueueCleanup(taskId: string, retryWorkspaceId?:string): void {
    this.projections.enqueueCleanup(taskId, retryWorkspaceId);
  }
  drainCleanup(): Promise<void> {
    return this.projections.drainCleanup();
  }
  scheduleCleanupRetry(taskId: string): void {
    this.projections.scheduleCleanupRetry(taskId);
  }
  awaitProjectionOccurrence(key: string, drain: () => Promise<void>): Promise<void> {
    return this.projections.awaitProjectionOccurrence(key, drain);
  }
  replayedArchiveOutcome(task: Task, input: TaskControlInput, operationId?: string): Task | null { return this.retryEffectControls.replayedArchiveOutcome(task, input, operationId); }
  replayedCatalogArchiveOutcome(task: Task, input: TaskControlInput, operationId?: string): Task | null { return this.retryEffectControls.replayedCatalogArchiveOutcome(task, input, operationId); }
  replayedDispositionWorkspaceOutcome(task: Task, input: TaskControlInput, operationId?: string): Task | null { return this.retryEffectControls.replayedDispositionWorkspaceOutcome(task, input, operationId); }
  drainProjections(options: { cleanup?: boolean } = {}): Promise<void> {
    return this.projections.drainProjections(options);
  }
  syncWorkspaceTitle(task: Task): Promise<void> {
    return this.projections.syncWorkspaceTitle(task);
  }
  /** Live Paseo threads the planner picker offers, each with a kind so task threads can be left out. */
  projectOwnerCandidates(): Promise<{ id: string; title: string; workspaceId: string | null; kind: ReturnType<typeof ownerCandidateKind> }[]> { return this.projectLifecycle.projectOwnerCandidates(); }
  /** Planner participant tickets still pending; the board's project entry says so. */
  plannerTicketPending: () => ReadonlySet<string> = () => new Set();
  /** Settings → Projects: one read of projects, repository rows, slots, planner liveness and QA. */
  projectSettings(): Promise<ReturnType<typeof buildProjectSettings>> { return this.projectLifecycle.projectSettings(); }
  /** Task 1110: one project's named agents with their live state and fallback marker. */
  projectAgents(projectKey: string): Promise<import('../shared/contracts').ProjectAgentView[]> { return this.projectLifecycle.projectAgents(projectKey); }
  /**
   * Spec 058 cutover 5, one-time migration: a project with an owner thread and no planner gets
   * that thread as its planner when the thread is live (observed, not archived); an archived or
   * missing owner is dropped. Each change is recorded through the store with `setBy` Queue and a
   * reason; the database is never edited by hand. A read that fails leaves its project for the
   * next start, so the marker lands only after every project has resolved.
   */
  migrateProjectOwnersToPlanners(): Promise<void> { return this.projectLifecycle.migrateProjectOwnersToPlanners(); }
  noteLifecycleSignal(input: { agentId?: string | null; workspaceId?: string | null; hostId?: string | null }): void { return this.workerFailover.noteLifecycleSignal(input); }
  retiredObservationPlan(): { persisted: Record<string,{active:boolean;at:string}>; keep: Record<string,{active:boolean;at:string}>; due: string[] } { return this.workerFailover.retiredObservationPlan(); }
  observeRetiredWorkers(plan: { persisted: Record<string,{active:boolean;at:string}>; keep: Record<string,{active:boolean;at:string}>; due: string[] }, inventory: ReadonlyMap<string, AgentObservation> | null): Promise<{ observations: Record<string,{active:boolean;at:string}>; changed: boolean }> { return this.workerFailover.observeRetiredWorkers(plan, inventory); }
  clearRetiredInvalidations(): void { this.workerFailover.clearRetiredInvalidations(); }
  /**
   * One audit pass. It resolves with its recorded fault (also kept as
   * `engineError`), or null, and whether a drain reached every task once.
   */
  auditPass(drain: boolean, visited: Set<string> = new Set()): Promise<{ fault: Error | null; covered: boolean; visited: Set<string> }> { return this.sweep.auditPass(drain, visited); }
  /**
   * Bounded dispatch pass over the queued order. With `repoPath`, only that
   * repository's lanes are considered. Capacity, dependency, availability and
   * hook gates are unchanged; workspace creation consults the bounded Queue
   * admission budget before any durable creation intent is recorded.
   */
  dispatchQueued(repoPath?: string): Promise<void> { return this.dispatchOwner.dispatchQueued(repoPath); }
  queuedWaitSignature(): string { return this.dispatchAdmission.queuedWaitSignature(); }
  /** Present-time wait that needs no durable queued-task update. */
  queuedExternalWait(task: Task): string { return this.dispatchAdmission.queuedExternalWait(task); }
  /** Under host pressure, admit bounded progress instead of waiting for unrelated load to disappear. */
  workspacePressureWait(task: Task, host?: Parameters<Dispatch["workspacePressureWait"]>[1]): string { return this.dispatchOwner.workspacePressureWait(task, host); }
  /**
   * Arms one wake at the end of the durable admission gap, so a paced task starts
   * when the gap ends instead of at the next sweep. Idempotent for a given gap end;
   * it never scans tasks itself.
   */
  armWorkspacePressureWake(): void { return this.dispatchOwner.armWorkspacePressureWake(); }
  /** Dispatch shares ownership with task controls and hook reconciliation. */
  dispatchTask(taskId: string, dispatchHeld: boolean): Promise<void> { return this.dispatchOwner.dispatchTask(taskId, dispatchHeld); }
  /** Proof-only dispatch always enters its executor/release-GO route, never the worker launcher. */
  launchProofOnly(task: Task, selectedProfile?: Profile): Promise<void> { return this.dispatchOwner.launchProofOnly(task, selectedProfile); }
  dispatchReviewEntry(task:Task):Promise<void>{ return this.dispatchOwner.dispatchReviewEntry(task); }
  performReviewEntryAdmission(task:Task):Promise<void>{ return this.dispatchOwner.performReviewEntryAdmission(task); }
  /**
   * One bounded lifecycle reconciliation quantum for one retained task. Runs on
   * the task's exclusive lane key so same-task controls cannot race it. Every
   * remote effect keeps its persisted intent and reconciliation discipline.
   */
  settleFinishedRuns(task: Task) { this.runRelease.settleFinishedRuns(task); }
  reconcileClosedRetainedReviewer(taskId: string): Promise<void> { return this.runRelease.reconcileClosedRetainedReviewer(taskId); }
  settleObservedIdleRuns(taskId: string, detail: string): Promise<number> { return this.runRelease.settleObservedIdleRuns(taskId, detail); }
  settleTerminalRecoveryEpisode(taskId: string, cause: string, releasedRunIds?: readonly string[]): boolean { return this.runRelease.settleTerminalRecoveryEpisode(taskId, cause, releasedRunIds); }
  settleTerminalIntentRuns(taskId: string): number { return this.runRelease.settleTerminalIntentRuns(taskId); }
  settleSupersededIdleRuns(taskId: string, detail: string): Promise<number> { return this.runRelease.settleSupersededIdleRuns(taskId, detail); }
  settleHistoricalProofExecutions(taskId: string, detail: string): Promise<number> { return this.runRelease.settleHistoricalProofExecutions(taskId, detail); }
  supersededIdleFence(run: Run): Promise<string | null> { return this.runRelease.supersededIdleFence(run); }
  ownedToolHold(agentId: string, runId?: string, taskId?: string): Promise<string | null> { return this.runRelease.ownedToolHold(agentId, runId, taskId); }
  observedRunLiveness(run: Run): Promise<boolean | null> { return this.runRelease.observedRunLiveness(run); }

  openEpisodeRunId(taskId: string): string | null { return this.verbFences.openEpisodeRunId(taskId); }
  planEpisodeDisplacement(taskId: string, version: number, verb: string): Promise<{ runIds: string[]; cancel: () => Promise<void> }> { return this.verbFences.planEpisodeDisplacement(taskId, version, verb); }
  collectVerbFinishedRuns(taskId: string, isSubject: (run: Run) => boolean, options?: { displace?: boolean; settlesEpisode?: boolean }): Promise<{ settleable: Run[]; fenced: { run: Run; why: string }[]; live: Run[] }> { return this.verbFences.collectVerbFinishedRuns(taskId, isSubject, options); }
  runDurableFence(task: Task, run: Run): string | null { return this.verbFences.runDurableFence(task, run); }
  ownerCancelledRun(taskId: string, runId: string): boolean { return this.verbFences.ownerCancelledRun(taskId, runId); }
  requireOwnerControlCurrent(task: Task, version: number, refusal: string): void { this.verbFences.requireOwnerControlCurrent(task, version, refusal); }
  assertUnchangedBeforeCancel(taskId: string, version: number, runs: readonly Run[]): void { this.verbFences.assertUnchangedBeforeCancel(taskId, version, runs); }
  runDisposition(run: Run): Promise<'settle' | 'cancel' | { refusal: string }> { return this.verbFences.runDisposition(run); }
  displacedRunBusy(run: Run): Promise<boolean> { return this.verbFences.displacedRunBusy(run); }
  cancelDisplacedTurns(taskId: string, runs: Array<Pick<Run, "id" | "taskId" | "agentId" | "workspaceId"> & { role: Run["role"] | "worker" }>, verb: string): Promise<void> { return this.verbFences.cancelDisplacedTurns(taskId, runs, verb); }
  verbRunFenceRefusal(entry: { run: Run; why: string }): string { return this.verbFences.verbRunFenceRefusal(entry); }
  displaceRefusal(entry: { run: Run; why: string }): string { return this.verbFences.displaceRefusal(entry); }
  settleVerbFences(taskId: string, settle: { detail: string; runIds: string[]; preserveEpisode?: boolean; displacedRunIds?: string[] }): void { this.verbFences.settleVerbFences(taskId, settle); }
  releaseDisplacedRunsInTx(taskId: string, runIds: string[], detail: string): void { this.verbFences.releaseDisplacedRunsInTx(taskId, runIds, detail); }
  private releaseVerbFinishedRunIds(taskId: string, runIds: string[], notAppliedReason: string): void { this.verbFences.releaseVerbFinishedRunIds(taskId, runIds, notAppliedReason); }
  releaseVerbFinishedRuns(taskId: string, runs: Run[], notAppliedReason: string): void { this.verbFences.releaseVerbFinishedRuns(taskId, runs, notAppliedReason); }

  /**
   * A recorded wait must not interrupt live work: observe the current run, apply
   * its result, then take effect before the next dispatch. Yield while a run is
   * unreleased, its completion is still unprocessed, the retained agent is live,
   * or recovery is active.
   */
  prerequisiteWaitYieldsToLiveWork(task: Task): boolean { return this.taskQuantumOwner.prerequisiteWaitYieldsToLiveWork(task); }

  taskQuantum(taskId: string): Promise<void> { return this.taskQuantumOwner.taskQuantum(taskId); }
  /**
   * The lifecycle steps of one quantum. A recorded wait for a prerequisite marks
   * `quantum` so the finish step is skipped, as it was before the split.
   */
  quantumSteps(taskId: string, task: Task, quantum: { pausedForPrerequisiteWait: boolean }): Promise<void> { return this.taskQuantumOwner.quantumSteps(taskId, task, quantum); }
  /** Closing reconciliation, thread archive and title projection for one quantum. */
  quantumFinish(taskId: string): Promise<void> { return this.taskQuantumOwner.quantumFinish(taskId); }
  unavailableGroups(): Set<string> { return this.workerFailover.unavailableGroups(); }
  replacementCeilingRefusal(task: Task): string { return this.workerFailover.replacementCeilingRefusal(task); }
  archiveRetiredErroredAgents(): Promise<void> { return this.workerFailover.archiveRetiredErroredAgents(); }
  recoverExhaustedWorkers(): Promise<void> { return this.workerFailover.recoverExhaustedWorkers(); }
  recover(task: Task) { return this.creationRecovery.recover(task); }
  recoverProofOnlyDispatch(task: Task): Promise<void> { return this.creationRecovery.recoverProofOnlyDispatch(task); }
  reconcileAbsentWorker(t: Task, matches: number) { return this.creationRecovery.reconcileAbsentWorker(t, matches); }
  ensureSiblings(task: Task): Promise<Task> {
    return this.workspaceProvisioning.ensureSiblings(task);
  }
  removeSiblings(taskId: string): Promise<void> {
    return this.workspaceProvisioning.removeSiblings(taskId);
  }
  compareSiblings(task: Task, eventId: string): Promise<Task> {
    return this.workspaceProvisioning.compareSiblings(task, eventId);
  }
  refreshCheckoutSiblings(task: Task, cause: "worker_creation" | "prerequisite_release"): Promise<Task> {
    return this.workspaceProvisioning.refreshCheckoutSiblings(task, cause);
  }
  prepareWorktreeLinks(task: Task): Promise<{ task: Task; recordFailure: string | null }> {
    return this.workspaceProvisioning.prepareWorktreeLinks(task);
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
  continuationOwnsReturn(taskId: string): boolean { return this.workerReconcile.continuationOwnsReturn(taskId); }
  reconcile(task: Task): Promise<void> { return this.workerReconcile.reconcile(task); }
  reconcileObservation(task: Task): Promise<{ state: Awaited<ReturnType<Adapter["observe"]>>; current: Task } | null> { return this.workerReconcile.reconcileObservation(task); }
  reconcileBranchPr(current: Task): Promise<boolean> { return this.workerReconcile.reconcileBranchPr(current); }
  reconcileReportingBinding(current: Task, mismatch: NonNullable<ReturnType<typeof reportingIdentityMismatch>>): Promise<void> { return this.workerReconcile.reconcileReportingBinding(current, mismatch); }
  reconcileBlockedReturn(task: Task, current: Task, state: Awaited<ReturnType<Adapter["observe"]>>): boolean { return this.workerReconcile.reconcileBlockedReturn(task, current, state); }
  acceptWorkerResult(task: Task, current: Task): Promise<void> { return this.workerReconcile.acceptWorkerResult(task, current); }
  branchPrLookupDue(task: Task): boolean { return this.workerReconcile.branchPrLookupDue(task); }
  reportingBindingRecheckDue(task: Task): boolean { return this.workerReconcile.reportingBindingRecheckDue(task); }
  updateAfterOperatorRemap(task: Task) { return this.callbackIntake.updateAfterOperatorRemap(task); }
  reviewerContinuationInFlight(taskId: string, runId: string): boolean { return this.callbackIntake.reviewerContinuationInFlight(taskId, runId); }
  complete(input: Completion, token: string) { return this.callbackIntake.complete(input, token); }
  completeCheckpoint(input: Completion, token: string): Promise<CheckpointResult> { return this.callbackIntake.completeCheckpoint(input, token); }
  rejectCheckpoint(task: Task, input: Completion, reason: string): CheckpointResult { return this.callbackIntake.rejectCheckpoint(task, input, reason); }
  completeReviewProgress(input: Completion, token: string): Promise<CheckpointResult> { return this.callbackIntake.completeReviewProgress(input, token); }
  rejectReviewProgress(task: Task, run: Run, input: Completion, limit: number, reason: string): CheckpointResult { return this.callbackIntake.rejectReviewProgress(task, run, input, limit, reason); }
  /** Per-task continuation budget, a Queue setting with a fixed default. */
  reviewContinuationLimit(): number { return this.dispatchAdmission.reviewContinuationLimit(); }
  recordObservation(task: Task, state: Awaited<ReturnType<Adapter["observe"]>>): void { return this.workerReconcile.recordObservation(task, state); }
  observeOnly(task: Task): Promise<void> { return this.workerReconcile.observeOnly(task); }
}
