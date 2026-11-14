import { CriticalReviewFallback } from './dispatch/critical-review-fallback';
import { ValidationRetry } from './qa/validation-retry';
import { PlannerPresence } from './questions/planner-presence';
import { OrphanRuns } from './recovery/orphan-runs';
import { ProgressContinuation } from './review/progress-continuation';
import { SchedulingLifecycle } from './scheduling/lifecycle';
import { schedulingContext } from './scheduling/context';
import type { ReviewContinuationContext } from './review/review-continuation';
import type { ReviewPublicationContext } from './review/review-publication';
import type { PrAdoptionContext } from './review/pr-adoption';
import type { ReviewLifecycleContext } from './review/lifecycle';
import { ReviewLifecycle, type ContinuedPrBinding } from './review/lifecycle';
import { AcceptedPrWorkspace } from './workspaces/workspace-continuation';
import { recoveryContext } from './recovery/context';
import { RecoveryLifecycle } from './recovery/lifecycle';
import { MergePhase, type MergePhaseContext } from './merge/merge-phase';
import { DispatchLaunch, type DispatchLaunchContext } from './dispatch/launch';

import { intakeContext } from './intake/context';

import { JointReviewQuestion } from './questions/joint-review-question';
import { Questions } from './questions/questions';
import { NativeQuestions } from './questions/native-questions';

import { ProvenPreSendRefusalError, ABSENT_RESOLUTION_REASON, RESPONSIBLE_QUESTION_WAIT, ACCEPTED_PR_RECONCILIATION_REASON, MERGE_HELD_REASON, OPERATOR_WORKER_REMAP_REASON, participantToolRunIds } from './recovery/task-reasons';
import { retainedProgressRun } from './dispatch/retained-work';

import { AsyncLocalStorage } from "node:async_hooks";

import { proofWaitApplies } from './qa/proof-execution';
import { type VerifiedPr, type CheckHistory, type CheckObservation, type ReviewerSetting, type PublicationOutcome } from './forge/index';

import { type Completion, type Incident, type Profile, type RepositoryChecksPolicy, type ReviewDeliveryAuthorization, type ReviewCheckpointRecord, type Run, type Task, type TaskControlInput, type UsageLevel, type OwnerAcceptanceRecord, type AgentMessageRecord } from '../shared/contracts';

import { Store } from './store/store';

import { Holds, type HoldsContext } from './merge/merge-hold';
import type { Adapter, AgentObservation } from './host/adapter';
import { HostFacade } from './host/host-facade';

import { SlotAdmission, type SlotAdmissionView } from './dispatch/capacity';
import { DEFAULT_UNCERTAIN_MERGE_RETRY_MS } from '../shared/contracts';
import { RepositoryHooks, type CloseoutAuthority } from './hooks/hooks';

import type { HookEventName, HookRecord } from '../shared/hooks';
import type { IdentitySource } from '../shared/host-kind';
import { OriginRouting } from './questions/origin';
import { Recovery } from './recovery/recovery';
import { Checkpoints } from './intake/checkpoint';
import { ReviewContinuations, type StoppedDeliveryResume } from './review/review-continuation';

import { Stalls } from './recovery/stall';
import { OwnedTools } from './machine/owned-tool';
import { PrAdoption } from './review/pr-adoption';
import { ProviderRefusals, type ProviderRefusalEvidence } from './recovery/provider-refusal';
import { CallbackReminders } from './intake/callback-reminders';
import { CheckWaits, type CheckWaitsContext } from './merge/check-waits';
import { ParticipantLease } from './dispatch/participant-lease';
import { IntegrationTurns, type IntegrationTurnsContext } from './merge/integration-turns';
import { Notices } from './questions/notices';
import { MergeIntent, type MergeIntentContext } from './merge/merge-intent';
import { RunCallbackIntake } from './intake/callback-intake';
import { MergeGates, type MergeGatesContext } from './merge/merge-gates';
import { RetryRoutes } from './recovery/retry-routes';
import { ExternalMerge, type ExternalMergeContext } from './merge/external-merge';
import { AbsentRestarts } from './recovery/absent-restarts';
import { Delegation } from './questions/delegation';
import type { PlannerRung } from './questions/delegation';
import { Ladder } from './questions/ladder';
import { TransientResume } from './recovery/transient-resume';
import { EffectReconcile } from './recovery/effect-reconcile';
import { ValidationEvidence } from './qa/validation-evidence';
import { RoleSelection, chooseProfile } from './dispatch/routing';

import { TaskStops, type ResolutionChanges } from './recovery/task-stops';
import { ContinuationFences } from './verbs/verb-fences';
import type { IncidentCause } from '../shared/incident';

import type { TaskStopReason, TaskStopVerb } from '../shared/task-stop';
import { type OperatorQuestion, type OperatorQuestionChoice, type OperatorQuestionKind } from './questions/operator-question';

import type { DecisionView } from '../shared/contracts';
import { DELEGATED_ANSWER_TIMEOUT_MS, type DelegatedAnswer } from './questions/question-delegation';
import { type AgentAskReceipt, type AgentAskRequest, type AgentAskShape } from './questions/agent-ask';
import { AgentAsks } from './questions/agent-asks';
import { ProofAutorun } from './qa/proof-autorun';
import { Observation } from './recovery/observation';
import { observedHostIdOf, resolveProjectAgent } from './planning/project-agents';
import { AgentMessages, type AgentMessageReceipt, type AgentMessageRequest, type AgentMessageRole } from './questions/agent-messages';

import { type WorktreeValidationScan } from './workspaces/worktree-validation';
import type { VerifiedEnclosingOperation } from './planning/enclosing-operation';
import type { RecoveryDispatchSnapshot } from './recovery/recovery-context';
import type { OwnerReviewContext } from './review/owner-review-context';
import { ResultApplication } from './intake/result-application';
import { Closeout } from './closeout/closeout';
import { ReviewPublication } from './review/review-publication';
import { closeoutContext } from './closeout/context';

import { type EscalationVerbChoice } from './questions/blocker-ladder';

// Tests still import these from here; row F2 of the simplify map removes the re-exports with the delegates.
export { ABSENT_RESOLUTION_REASON, ABSENT_WORKER_REASON, ACCEPTED_PR_RECONCILIATION_REASON, EXTERNAL_MERGE_CHECK_REASON_PREFIX, EXTERNAL_MERGE_CHECK_RECOVERED_REASON, MERGE_HELD_REASON, OPERATOR_WORKER_REMAP_REASON, PRE_AGENT_LAUNCH_FAILURE_REASON, ProvenPreSendRefusalError, RESPONSIBLE_QUESTION_WAIT, RetainedRunRefusal, VALIDATION_SCAN_PASS_MAX_MS, isAcceptedReview, participantToolRunIds } from './recovery/task-reasons';
export { retainedProgressRun } from './dispatch/retained-work';
export { NO_ORIGIN_THREAD_WAIT, originRecipient } from './questions/origin';
export { docsOnlyProofAutorunSkip, proofAutorunWaitingInputs, proofWaitApplies } from './qa/proof-execution';
export { reviewContinuationLocalRefusal } from './review/review-continuation';

/** Task 382: the check evidence a merge gate reports beside its wait: the effective hosted-check policy, the required and advisory results at the exact head, and the repository settings revision the policy came from. */
export type OverdueCheckEvidence = {key: string; name: string; state: string; elapsedMs: number; jobUrl: string; runnerLabels: string[]};
export type CheckObservationFields = {checksPolicy?: RepositoryChecksPolicy; requirements?: {known: boolean; required: number; reason?: string}; advisory?: CheckObservation[]; requiredEvidence?: CheckObservation[]; settingsRevision?: number | null; overdueCheck?: OverdueCheckEvidence};
export type MergeGateResult = { timings?: Record<string, number>; head: string; base: string; wait: string; needsRebase?: boolean; checksFailed?: boolean; overdue?: boolean; pendingCheck?: boolean; infrastructure?: boolean; infraRunIds?: string[] } & CheckObservationFields;
export type RequiredChecksResult = { head: string; wait: string; needsRebase?: boolean; checksFailed?: boolean; overdue?: boolean; pendingCheck?: boolean; infrastructure?: boolean; infraRunIds?: string[] } & CheckObservationFields;
/** Project-d #117: an evidence-only PR verified for a continuation, and the task facts the accepting transaction re-checks. */
export type { ContinuedPrBinding } from './review/lifecycle';
/**
 * Task 405: the owner authorisation one proof execution was activated with, and
 * the operation that recorded it. `tree` is filled by the source proof just
 * before thread selection and re-checked by the reservation.
 */
export interface ProofActivation {
  authorizedBy: { role: 'project_owner' | 'operator' | 'authorized_relay' | 'delegated' | 'queue_dispatch'; caller: string | null; note: string | null };
  operationId: string | null;
  tree?: string;
  goEvidence?: NonNullable<Run['proofExecution']>['goEvidence'];
}
/**
 * Task 408: the owner closeout reconciliation of a queued review-entry task
 * that never dispatched and whose own PR merged outside Queue. The engine —
 * which owns owner authority and the project-owner identity — supplies the
 * exact-final-head source acceptance and the fresh-inactivity observation; the
 * merge identity, ancestry, workspace and commit proofs stay here, beside the
 * existing external-merge route.
 */
export interface ReviewEntryExternalMerge {
  /** The authenticated durable invocation executing this move (task 404). */
  enclosing: () => VerifiedEnclosingOperation | undefined;
  /**
   * The operator source acceptance for the head observed at the forge. It is
   * derived per observed head from the shared acceptance rule: a caller-supplied
   * head is never accepted as fact.
   */
  acceptanceFor: (head: string) => OwnerAcceptanceRecord;
  /** Fresh inactive ownership; re-run after every await before the commit. */
  assertQuiet: () => Promise<void>;
}
export interface RetainedSourceExternalMerge {
  acceptanceFor: (head: string) => OwnerAcceptanceRecord;
  assertQuiet: () => Promise<void>;
  assertState: () => void;
  settleOperation: (task: Task) => void;
}
export interface ResolutionAdapter {
  /** `context` is a recovery coordinator's launch snapshot, passed to its prompt and never stored. */
  createRun(task: Task, run: Run, token: string, context?: RecoveryDispatchSnapshot | null, ownerContext?: OwnerReviewContext | null,
    guard?: { allowed: () => Promise<boolean>; stillAllowed: () => boolean }, affectedTestsCommand?: string): Promise<{ id: string; workspaceId: string | null }>;
  sendRun(task: Task, run: Run, token: string, context?: RecoveryDispatchSnapshot | null, ownerContext?: OwnerReviewContext | null, guard?: { allowed: () => Promise<boolean>; stillAllowed: () => boolean }, affectedTestsCommand?: string): Promise<void>;
  findRunAgents(run: Run): Promise<{ id: string; workspaceId: string | null }[]>;
  publishReview?(store:Store, task:Task, run:Run, status:string, text:string, allowed?:()=>boolean, reviewer?:ReviewerSetting):Promise<number|PublicationOutcome>;
  reconcileReviewPublication?(store:Store, task:Task, run:Run, reviewer:ReviewerSetting, reason:string, allowed:()=>boolean):Promise<number>;
  verifyReview(task: Task, run: Run, result: Completion, reviewer?: ReviewerSetting): Promise<number | void>;
  externalMerge?(task: Task, acceptHead?: boolean, retainedSource?: boolean): Promise<{head:string;commit:string}|null>;
  mergeGate(task: Task, history?: CheckHistory, reviewer?: ReviewerSetting, checksPolicy?: RepositoryChecksPolicy): Promise<MergeGateResult>;
  requiredChecks?(task: Task, history?: CheckHistory, checksPolicy?: RepositoryChecksPolicy): Promise<RequiredChecksResult>;
  /** Checks and integration base for a subsequent review round, without merge-review admission. */
  coveringEvidence?(task: Task, history?: CheckHistory, checksPolicy?: RepositoryChecksPolicy): Promise<RequiredChecksResult & { base: string }>;
  /** Queue 524: bounded pointer to author evidence posted as PR issue comments (never bodies). Empty when none exist. */
  authorCommentEvidence?(task: Task, priorCommentId?: number | null): Promise<string>;
  rerunFailedWorkflowRuns?(task: Task, runIds: string[]): Promise<string[]>;
  merge(task: Task, allowed?: () => boolean): Promise<void>;
  merged(task: Task): Promise<{ merged: boolean; commit: string | null; head: string; base: string; proof?: { proven: boolean; detail: string } }>;
  syncMain(task: Task, allowed?: () => boolean): Promise<string>;
  verifyCloseout(task: Task, result?:Completion): Promise<string|void>;
  notify(agentId: string, messageId: string, text: string, sourceAgentId?: string): Promise<void>;
}

import { advanceFailureDisposition } from './recovery/resolution-decisions';
export { advanceFailureDisposition, type AdvanceFailureDisposition } from './recovery/resolution-decisions';
import { resolutionAdapter } from './resolution-adapter';

export class Resolution {
  readonly criticalReviewFallback = new CriticalReviewFallback(schedulingContext(this, ['store', 'update']));

  readonly validationRetry = new ValidationRetry(schedulingContext(this, ['store', 'update']));

  readonly plannerPresence = new PlannerPresence(schedulingContext(this, ['adapter', 'host', 'identifyOriginHost', 'originHostAvailable', 'plannerThreadGone', 'projectPlannerFor', 'store', 'taskPlannerFor', 'withHost']));

  readonly orphanRunsOwner = new OrphanRuns(schedulingContext(this, ['store']));

  readonly progressContinuation = new ProgressContinuation(schedulingContext(this, ['adapter', 'host', 'onTaskHost', 'ownedToolHold', 'progressEffectsPending', 'startsNoRuns', 'store']));

  readonly schedulingLifecycle = new SchedulingLifecycle(schedulingContext(this, ['acceptedPrWorkspaceMayApply', 'adapter', 'advanceAttempt', 'advanceChangesRequested', 'advanceClosing', 'advanceCompletedRun', 'advanceMerging', 'advancePhase', 'advanceSkippedReview', 'advanceSyncing', 'attentionReplayApplies', 'attentionUnknownEscalation', 'blockerLadderApplies', 'blockerLadderStep', 'hooks', 'hostAvailable', 'launch', 'operatorReturn', 'pauseForPrerequisiteWait', 'paused', 'reapplyPendingReview', 'reconcileAcceptedPrWorkspace', 'recordStoredResult', 'recovery', 'reobservePendingChecks', 'replayHeldAttention', 'restoreRecordedMergePhase', 'settleAdvanceFailure', 'settleSourceApprovalProof', 'settleUnchangedCheckGate', 'sourceApprovalWaitApplies', 'startsNoRuns', 'stopped', 'store', 'supersedeEarlierRecovery', 'unchangedCheckGateApplies', 'update', 'verification', 'waiting']));

  private reviewLifecycleContext(): ReviewLifecycleContext {
    const resolution = this;
    return {
      get store() { return resolution.store; },
      get adapter() { return resolution.adapter; },
      get host() { return resolution.host; },
      reviewerSetting: (...args: Parameters<Resolution['reviewerSetting']>) => resolution.reviewerSetting(...args),
      continuedPrBinding: (...args: Parameters<Resolution['continuedPrBinding']>) => resolution.continuedPrBinding(...args),
      ordinaryReviewRuns: (...args: Parameters<Resolution['ordinaryReviewRuns']>) => resolution.ordinaryReviewRuns(...args),
      ownedToolHold: (...args: Parameters<Resolution['ownedToolHold']>) => resolution.ownedToolHold(...args),
      startsNoRuns: (...args: Parameters<Resolution['startsNoRuns']>) => resolution.startsNoRuns(...args),
      stopped: (...args: Parameters<Resolution['stopped']>) => resolution.stopped(...args),
      update: (...args: Parameters<Resolution['update']>) => resolution.update(...args),
      waiting: (...args: Parameters<Resolution['waiting']>) => resolution.waiting(...args),
      slotAdmissionReason: (...args: Parameters<Resolution['slotAdmissionReason']>) => resolution.slotAdmissionReason(...args),
      launch: (...args: Parameters<Resolution['launch']>) => resolution.launch(...args),
    };
  }
  private prAdoptionContext(): PrAdoptionContext {
    const resolution = this;
    return {
      get store() { return resolution.store; },
      get adapter() { return resolution.adapter; },
      get host() { return resolution.host; },
      paused: (...args: Parameters<Resolution['paused']>) => resolution.paused(...args),
      recordBlockedPrIdentity: (...args: Parameters<Resolution['recordBlockedPrIdentity']>) => resolution.recordBlockedPrIdentity(...args),
    };
  }
  private reviewPublicationContext(): ReviewPublicationContext {
    const resolution = this;
    return {
      get store() { return resolution.store; },
      get adapter() { return resolution.adapter; },
      reviewerSetting: (...args: Parameters<Resolution['reviewerSetting']>) => resolution.reviewerSetting(...args),
      paused: (...args: Parameters<Resolution['paused']>) => resolution.paused(...args),
      lease: (...args: Parameters<Resolution['lease']>) => resolution.lease(...args),
      operatorReturn: (...args: Parameters<Resolution['operatorReturn']>) => resolution.operatorReturn(...args),
    };
  }
  private reviewContinuationContext(): ReviewContinuationContext {
    const resolution = this;
    return {
      get store() { return resolution.store; },
      get adapter() { return resolution.adapter; },
      get host() { return resolution.host; },
      onTaskHost: <T>(owner: { hostId?: string | null } | null | undefined, work: () => T): T => resolution.onTaskHost(owner, work),
      stopResumeState: (...args: Parameters<Resolution['stopResumeState']>) => resolution.stopResumeState(...args),
      reconcileReviewDelivery: (...args: Parameters<Resolution['reconcileReviewDelivery']>) => resolution.reconcileReviewDelivery(...args),
      reviewContinuationGate: (...args: Parameters<Resolution['reviewContinuationGate']>) => resolution.reviewContinuationGate(...args),
      assertIdleReviewerObservation: (...args: Parameters<Resolution['assertIdleReviewerObservation']>) => resolution.assertIdleReviewerObservation(...args),
      ownedToolHold: (...args: Parameters<Resolution['ownedToolHold']>) => resolution.ownedToolHold(...args),
      inspectReviewContinuation: (...args: Parameters<Resolution['inspectReviewContinuation']>) => resolution.inspectReviewContinuation(...args),
      admitReviewContinuation: (...args: Parameters<Resolution['admitReviewContinuation']>) => resolution.admitReviewContinuation(...args),
      assertReviewCheckpointProvenance: (...args: Parameters<Resolution['assertReviewCheckpointProvenance']>) => resolution.assertReviewCheckpointProvenance(...args),
      settleVerbFences: (...args: Parameters<Resolution['settleVerbFences']>) => resolution.settleVerbFences(...args),
      settleReviewDelivery: (...args: Parameters<Resolution['settleReviewDelivery']>) => resolution.settleReviewDelivery(...args),
      paused: (...args: Parameters<Resolution['paused']>) => resolution.paused(...args),
      assertReviewProfileIndependent: (...args: Parameters<Resolution['assertReviewProfileIndependent']>) => resolution.assertReviewProfileIndependent(...args),
    };
  }
  readonly acceptedPrWorkspace = new AcceptedPrWorkspace(recoveryContext(this, ['adapter', 'attention', 'startsNoRuns', 'store']));
  readonly recoveryLifecycle = new RecoveryLifecycle(Object.assign(
    recoveryContext(this, ['attention', 'attentionUnknownEscalation', 'environmentDeferred', 'gitTransientFailure', 'responsibleBlockerLadder', 'store', 'update', 'waiting']),
    { replayHeldAttention: (t: Task) => this.mergePhase.replayHeldAttention(t) },
  ));

  readonly mergePhase = new MergePhase(((owner: Resolution): MergePhaseContext => ({
    get store() { return owner.store; },
    get hooks() { return owner.hooks; },
    paused: (...args) => owner.paused(...args),
    stopped: (...args) => owner.stopped(...args),
    get graceMs() { return owner.graceMs; },
    update: (...args) => owner.update(...args),
    operatorReturn: (...args) => owner.operatorReturn(...args),
    mergeGateEvidence: (...args) => owner.mergeGateEvidence(...args),
    resolvePassedUnchangedCheckEscalation: (...args) => owner.resolvePassedUnchangedCheckEscalation(...args),
  }))(this));
  readonly origins = new OriginRouting(this);
  readonly recovery = new Recovery(recoveryContext(this, ['adapter', 'attention', 'automaticHookReplayPending', 'ensureIncident', 'escalateRefusedCoordinator', 'extendCallbackReminder', 'graceMs', 'host', 'hostAvailable', 'workerProviderUnavailable', 'idle', 'lease', 'onTaskHost', 'openPlannerEscalation', 'openReviewContinuationEscalation', 'recordStop', 'requiredRouteNote', 'responsibleBlockerLadder', 'resumeTransientProviderThread', 'select', 'slotAdmissionReason', 'startsNoRuns', 'stopped', 'store', 'suppressAutomaticRetry', 'update', 'usageCeilingNote', 'validationEvidence', 'waiting']));
  readonly checkpoints = new Checkpoints(intakeContext(this, ['adapter', 'attention', 'hostAvailable', 'paused', 'store', 'withHost']));
  readonly stalls = new Stalls(recoveryContext(this, ['adapter', 'attention', 'host', 'onTaskHost', 'paused', 'profiles', 'recordStop', 'recovery', 'saveIncident', 'store', 'update', 'waiting']));
  readonly ownedTools = new OwnedTools(this);
  readonly holds = new Holds(((owner: Resolution): HoldsContext => ({
    reviewRequired: (...args) => owner.reviewRequired(...args),
    get store() { return owner.store; },
  }))(this));
  readonly reviewLifecycle = new ReviewLifecycle(this.reviewLifecycleContext());
  readonly prAdoption = new PrAdoption(this.prAdoptionContext());
  readonly selection = new RoleSelection(this);
  readonly providerRefusals = new ProviderRefusals(recoveryContext(this, ['adapter', 'applyReviewerRefusal', 'attention', 'clearUnverifiableRefusalWait', 'host', 'observeStoppedReviewer', 'paused', 'recordRefusalBlocked', 'recordUnverifiableRefusalRead', 'refusalExclusions', 'refusalGap', 'select', 'stopped', 'store', 'unverifiableRefusalReads', 'update', 'usageCeilingNote', 'verifyRefusedRevision', 'waiting']));
  readonly validation = new ValidationEvidence(this);
  readonly callbackReminders = new CallbackReminders(intakeContext(this, ['adapter', 'attention', 'ensureIncident', 'extendCallbackReminder', 'graceMs', 'heavyRunAlive', 'host', 'onTaskHost', 'ownedJobWait', 'saveIncident', 'store', 'validationEvidence', 'waiting']));
  readonly checkWaits = new CheckWaits(((owner: Resolution): CheckWaitsContext => ({
    get adapter() { return owner.adapter; },
    attention: (...args) => owner.attention(...args),
    paused: (...args) => owner.paused(...args),
    recordIncidentEvent: (...args) => owner.recordIncidentEvent(...args),
    refusePreMerge: (...args) => owner.refusePreMerge(...args),
    reviewerSetting: (...args) => owner.reviewerSetting(...args),
    settleAttentionEpisode: (...args) => owner.settleAttentionEpisode(...args),
    get store() { return owner.store; },
    update: (...args) => owner.update(...args),
    waiting: (...args) => owner.waiting(...args),
  }))(this));
  readonly participantLease = new ParticipantLease(this);
  readonly integrationTurns = new IntegrationTurns(((owner: Resolution): IntegrationTurnsContext => ({
    assignIntegrationTurn: (...args) => owner.assignIntegrationTurn(...args),
    hasEarlierIntegrationTurn: (...args) => owner.hasEarlierIntegrationTurn(...args),
    holdLastBlocker: (...args) => owner.holdLastBlocker(...args),
    holdsIntegrationTurn: (...args) => owner.holdsIntegrationTurn(...args),
    integrationActive: (...args) => owner.integrationActive(...args),
    paused: (...args) => owner.paused(...args),
    refreshingCloseoutHook: (...args) => owner.refreshingCloseoutHook(...args),
    requiredCheckPollState: (...args) => owner.requiredCheckPollState(...args),
    slotAdmissionReason: (...args) => owner.slotAdmissionReason(...args),
    get store() { return owner.store; },
    update: (...args) => owner.update(...args),
    waiting: (...args) => owner.waiting(...args),
  }))(this));
  readonly mergeIntent = new MergeIntent(((owner: Resolution): MergeIntentContext => ({
    get adapter() { return owner.adapter; },
    attention: (...args) => owner.attention(...args),
    gateSettingsCurrent: (...args) => owner.gateSettingsCurrent(...args),
    get gitTransientFailure() { return owner.gitTransientFailure?.bind(owner); },
    mergeGateEvidence: (...args) => owner.mergeGateEvidence(...args),
    paused: (...args) => owner.paused(...args),
    get store() { return owner.store; },
    get uncertainMergeRetryMs() { return owner.uncertainMergeRetryMs; },
    update: (...args) => owner.update(...args),
    waiting: (...args) => owner.waiting(...args),
  }))(this));
  readonly mergeGates = new MergeGates(((owner: Resolution): MergeGatesContext => ({
    get adapter() { return owner.adapter; },
    applyMergeGateWait: (...args) => owner.applyMergeGateWait(...args),
    attention: (...args) => owner.attention(...args),
    claimIntegrationTurn: (...args) => owner.claimIntegrationTurn(...args),
    executionLease: (...args) => owner.executionLease(...args),
    gateSettingsCurrent: (...args) => owner.gateSettingsCurrent(...args),
    get hooks() { return owner.hooks; },
    mergeGateEvidence: (...args) => owner.mergeGateEvidence(...args),
    openPlannerEscalation: (...args) => owner.openPlannerEscalation(...args),
    paused: (...args) => owner.paused(...args),
    reconcileMergeIntent: (...args) => owner.reconcileMergeIntent(...args),
    refusePreMerge: (...args) => owner.refusePreMerge(...args),
    reviewRequired: (...args) => owner.reviewRequired(...args),
    get store() { return owner.store; },
    update: (...args) => owner.update(...args),
    verification: (...args) => owner.verification(...args),
    waiting: (...args) => owner.waiting(...args),
  }))(this));
  readonly callbackIntake = new RunCallbackIntake(intakeContext(this, ['adapter', 'completeBookkeeping', 'completeBuildOutput', 'completeProof', 'completeReceipt', 'completeValidate', 'readoptReplacedReviewer', 'reconcileReviewDelivery', 'recordFinishedTaskCompletion', 'recordSupersededProofEvidence', 'resolveIncident', 'store', 'update']));
  readonly retryRoutes = new RetryRoutes(recoveryContext(this, ['adapter', 'operatorReturn', 'retainedWorkerProfileIssue', 'retry', 'reviewContinuationOwner', 'settleVerbFences', 'store', 'update', 'validationAlive']));
  readonly externalMerge = new ExternalMerge(((owner: Resolution): ExternalMergeContext => ({
    get adapter() { return owner.adapter; },
    assignIntegrationTurn: (...args) => owner.assignIntegrationTurn(...args),
    attention: (...args) => owner.attention(...args),
    environmentDeferred: (...args) => owner.environmentDeferred(...args),
    executionLease: (...args) => owner.executionLease(...args),
    get gitTransientFailure() { return owner.gitTransientFailure?.bind(owner); },
    hasEarlierIntegrationTurn: (...args) => owner.hasEarlierIntegrationTurn(...args),
    get host() { return owner.host; },
    openPlannerEscalation: (...args) => owner.openPlannerEscalation(...args),
    paused: (...args) => owner.paused(...args),
    recovery: {
      releaseWithNotAppliedAction: (...args) => owner.recovery.releaseWithNotAppliedAction(...args),
      settledEpisodeChanges: (...args) => owner.recovery.settledEpisodeChanges(...args),
    },
    resolveIncident: (...args) => owner.resolveIncident(...args),
    reviewRequired: (...args) => owner.reviewRequired(...args),
    get store() { return owner.store; },
    transportDeferred: (...args) => owner.transportDeferred(...args),
    update: (...args) => owner.update(...args),
    waiting: (...args) => owner.waiting(...args),
  }))(this));
  readonly absentRestarts = new AbsentRestarts(recoveryContext(this, ['adapter', 'attention', 'ensureIncident', 'graceMs', 'paused', 'recordIncidentEvent', 'resolveIncident', 'resumeWorkerContinuation', 'settleVerbFences', 'store', 'update']));
  readonly observation = new Observation(recoveryContext(this, ['adapter', 'attention', 'environmentDeferred', 'extendCallbackReminder', 'graceMs', 'heavyRunAlive', 'host', 'hostAvailable', 'inventoryHostMatches', 'launchingRuns', 'onTaskHost', 'orphanRuns', 'paused', 'reconcileAbsentCreation', 'reconcileStalledTurnStop', 'recoverRefusedReviewer', 'remindStoppedRun', 'resolveIncident', 'resumeTransientProviderThread', 'retainedProfileIssue', 'stalls', 'stopped', 'store', 'supersedeOrphans', 'transportDeferred', 'update', 'waiting', 'withHost']));
  readonly delegation = new Delegation(this);
  readonly questions = new Questions(this);
  readonly jointReviewQuestion = new JointReviewQuestion(this);
  readonly proofAutorun = new ProofAutorun(this);
  readonly nativeQuestions = new NativeQuestions(this);
  readonly ladder = new Ladder(this);
  readonly effectReconcile = new EffectReconcile(recoveryContext(this, ['adapter', 'deliveryInTimeline', 'host', 'reconcileReviewDelivery', 'reconcileReviewDeliveryOperations', 'settleReviewDelivery', 'store']));
  readonly reviewContinuations = new ReviewContinuations(this.reviewContinuationContext());
  readonly agentMessages = new AgentMessages(this);
  readonly agentAsks = new AgentAsks(this);
  readonly transientResume = new TransientResume(recoveryContext(this, ['adapter', 'attention', 'graceMs', 'host', 'onTaskHost', 'openPlannerEscalation', 'paused', 'profiles', 'store', 'update', 'waiting']));
  readonly notices = new Notices(this);
  readonly slotAdmission = new SlotAdmission(this);
  readonly taskStops = new TaskStops(recoveryContext(this, ['ensureIncident', 'questions', 'recordIncidentEvent', 'saveIncident', 'settleAttentionEpisode', 'stopped', 'store', 'update', 'waiting']));
  readonly continuationFences = new ContinuationFences(this);
  readonly resultApplication = new ResultApplication(intakeContext(this, ['adapter', 'advanceCloseoutResult', 'attention', 'hooks', 'lease', 'openPlannerEscalation', 'ordinaryRoundCustody', 'recordBlockedPrIdentity', 'responsibleBlockerLadder', 'responsiblePrReportRefused', 'reviewerSetting', 'settleAttentionEpisode', 'settleAutomaticReplayHold', 'stopped', 'store', 'suppressAutomaticRetry', 'update', 'waiting']));
  readonly closeout = new Closeout(closeoutContext(this, ['adapter', 'attention', 'claimIntegrationTurn', 'closeoutAuthority', 'closeoutWritten', 'executionLease', 'hookCloseout', 'hooks', 'launch', 'paused', 'queueCloseout', 'settleAutomaticReplayHold', 'stopped', 'store', 'turnReleased', 'update', 'waiting']));
  readonly reviewPublication = new ReviewPublication(this.reviewPublicationContext());
  readonly dispatchLaunch = new DispatchLaunch(((owner: Resolution): DispatchLaunchContext => ({
    get adapter() { return owner.adapter; },
    get advanceAttempt() { return owner.advanceAttempt; },
    assertReviewProfileIndependent: (...args) => owner.assertReviewProfileIndependent(...args),
    attention: (...args) => owner.attention(...args),
    authorAgentIds: (...args) => owner.authorAgentIds(...args),
    bindContinuedPrInTx: (...args) => owner.bindContinuedPrInTx(...args),
    bindReportedHeadForReview: (...args) => owner.bindReportedHeadForReview(...args),
    catalogKnown: (...args) => owner.catalogKnown(...args),
    claimIntegrationTurn: (...args) => owner.claimIntegrationTurn(...args),
    continuedPrBinding: (...args) => owner.continuedPrBinding(...args),
    continuedProgressWait: (...args) => owner.continuedProgressWait(...args),
    deliverLaunchRun: (...args) => owner.deliverLaunchRun(...args),
    ensureIncident: (...args) => owner.ensureIncident(...args),
    get host() { return owner.host; },
    launch: (...args) => owner.launch(...args),
    get launchingRuns() { return owner.launchingRuns; },
    lease: (...args) => owner.lease(...args),
    leaseDeclineText: (...args) => owner.leaseDeclineText(...args),
    openPlannerEscalation: (...args) => owner.openPlannerEscalation(...args),
    ordinaryReviewRuns: (...args) => owner.ordinaryReviewRuns(...args),
    ordinaryRoundCustody: (...args) => owner.ordinaryRoundCustody(...args),
    orphanRuns: (...args) => owner.orphanRuns(...args),
    pauseForPrerequisiteWait: (...args) => owner.pauseForPrerequisiteWait(...args),
    paused: (...args) => owner.paused(...args),
    profiles: (...args) => owner.profiles(...args),
    progressEffectsPending: (...args) => owner.progressEffectsPending(...args),
    recordCriticalReviewFallback: (...args) => owner.recordCriticalReviewFallback(...args),
    requiredRouteNote: (...args) => owner.requiredRouteNote(...args),
    reserveLaunchRun: (...args) => owner.reserveLaunchRun(...args),
    resolveWithdrawnPending: (...args) => owner.resolveWithdrawnPending(...args),
    responsibleJointQuestion: (...args) => owner.responsibleJointQuestion(...args),
    retainedProfileIssue: (...args) => owner.retainedProfileIssue(...args),
    retainedWorkerProfileIssue: (...args) => owner.retainedWorkerProfileIssue(...args),
    retryContext: (...args) => owner.retryContext(...args),
    reviewerSetting: (...args) => owner.reviewerSetting(...args),
    select: (...args) => owner.select(...args),
    selectLaunchThread: (...args) => owner.selectLaunchThread(...args),
    signoffIssue: (...args) => owner.signoffIssue(...args),
    slotAdmissionReason: (...args) => owner.slotAdmissionReason(...args),
    startsNoRuns: (...args) => owner.startsNoRuns(...args),
    get store() { return owner.store; },
    supersedeOrphans: (...args) => owner.supersedeOrphans(...args),
    update: (...args) => owner.update(...args),
    usageCeilingNote: (...args) => owner.usageCeilingNote(...args),
    waiting: (...args) => owner.waiting(...args),
    workerContinuation: (...args) => owner.workerContinuation(...args),
  }))(this));
  readonly adapter: Adapter & Partial<ResolutionAdapter>;
  hostAvailable: (task: Task, run?: Run) => boolean = () => true;
  /** Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): the open outage for a host, when one exists. */
  hostOutage: (hostId: string) => import('../shared/host-outage').HostOutage | null = () => null;
  workerProviderUnavailable: (task: Task) => boolean = () => false;
  withHost: <T>(id: string, fn: () => T) => T = (_id, fn) => fn();
  /** The task-owner host binding every agent-naming call reads (#1154); same rule as `Engine.onTaskHost`. */
  onTaskHost<T>(owner: { hostId?: string | null } | null | undefined, work: () => T): T {
    const hostId = owner?.hostId;
    return hostId ? this.withHost(hostId, work) : work();
  }
  /** Registered and connected, independent of the ambient host context; serves the facade's cross-host routing. */
  hostOnline: (id: string) => boolean = () => true;
  inventoryHostMatches: (id: string) => boolean = () => true;
  originHostAvailable: (id: string) => boolean = () => true;
  /**
   * Wait, bounded, for the plugin bridge (host connection) to become
   * available, the way a just-rolled service needs before host-dependent
   * answers can be verified; null keeps the immediate refusal. Bound and
   * cadence are the runtime's (`hostBridgeWaitMs`); tests override both.
   */
  awaitHostBridge: ((waitMs: number) => Promise<boolean>) | null = null;
  hostBridgeWaitMs = 90_000;
  canReuseUnqualifiedOriginWorkspace: () => boolean = () => true;
  identifyOriginHost: (id: string, identitySource?: IdentitySource) => Promise<string | undefined> = async () => {
    const hostId = (this.adapter as { hostId?: unknown }).hostId;
    return typeof hostId === 'string' && hostId ? hostId : undefined;
  };
  /** The Host contract over this resolution's adapter, read at each call (`core/host/host-facade.ts`). */
  get host(): HostFacade { return new HostFacade(this); }
  get worktreeValidationProbe() { return this.validation.worktreeValidationProbe; }
  set worktreeValidationProbe(probe: (directory: string, extraArgv: string[][]) => WorktreeValidationScan) { this.validation.worktreeValidationProbe = probe; }
  get externalMergeProbeMs() { return this.externalMerge.externalMergeProbeMs; }
  set externalMergeProbeMs(ms: number) { this.externalMerge.externalMergeProbeMs = ms; }
  get validationScanShareMs() { return this.validation.validationScanShareMs; }
  set validationScanShareMs(ms: number) { this.validation.validationScanShareMs = ms; }
  /** The runs the current `advance` attempt reserved, so its failure is attributed to the owner it acted for. */
  readonly advanceAttempt = new AsyncLocalStorage<Set<string>>();
  // A live launch owns its intent through preflight and the native response.
  // After restart, durable unknown intents still use ordinary reconciliation.
  readonly launchingRuns = new Set<string>();
  /** The native decisions this process is observing, so shutdown never leaves one hanging. */
  get responsibleQuestions() { return this.questions.responsibleQuestions; }
  /** Spec 058 (task 540): the delegated answer recorded for one question, read when its answer applies. */
  get delegatedAnswers() { return this.questions.delegatedAnswers; }
  get routingEscalations() { return this.ladder.routingEscalations; }
  readonly wakingEscalations = new Set<string>();
  readonly settlingOperatorEscalations = new Set<string>();
  get routingConsults() { return this.ladder.routingConsults; }
  get recoveringQueueAsks() { return this.questions.recoveringQueueAsks; }
  /**
   * Spec 058 (task 550): the ask-mode raises this process is waiting on, keyed by
   * their Queue question id. A delegate's or board answer resolves the deferred,
   * whose settlement path records the answer and applies the question's controls,
   * exactly as a native question's permission resolution does. Maintenance
   * recovers the durable decision and payload after a restart.
   */
  get queueAskRaises() { return this.questions.queueAskRaises; }
  /** Who answered an ask-mode Queue raise, read by the settlement path that records the answer. */
  get queueAskRaiseAnsweredBy() { return this.questions.queueAskRaiseAnsweredBy; }
  get agentAskWaitMs() { return this.agentAsks.agentAskWaitMs; }
  set agentAskWaitMs(ms: number) { this.agentAsks.agentAskWaitMs = ms; }
  get agentAskPollMs() { return this.agentAsks.agentAskPollMs; }
  set agentAskPollMs(ms: number) { this.agentAsks.agentAskPollMs = ms; }
  private readonly gitFailureSources = new WeakMap<object, string>();
  gitTransientRecovered?: (task: Task, source: string) => void;
  gitFailureSource(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    return this.gitFailureSources.get(error) ?? (error instanceof Error && error.cause !== error ? this.gitFailureSource(error.cause) : undefined);
  }
  constructor(readonly store: Store, adapter: Adapter, readonly profiles: () => Profile[], readonly stopped: () => boolean, readonly graceMs = 60000, readonly hooks?: RepositoryHooks, readonly uncertainMergeRetryMs = DEFAULT_UNCERTAIN_MERGE_RETRY_MS) {
    this.adapter = resolutionAdapter(adapter, this.gitFailureSources, (task, source) => this.gitTransientRecovered?.(task, source));
  }
  /** Command receipts, never conversation output, settle every delegated route. */
  delegatedAnswerWaitMs = DELEGATED_ANSWER_TIMEOUT_MS;
  delegatePrompt(task: Task, id: string, prompt: string, recipient?: string, hostId?: string): string { return this.delegation.delegatePrompt(task, id, prompt, recipient, hostId); }
  openDelegatedQuestion(task: Task, id: string, recipient: string, prompt: string, timeoutMs: number, role: string, hostId?: string, rung?: 'task' | 'project'): void { this.delegation.openDelegatedQuestion(task, id, recipient, prompt, timeoutMs, role, hostId, rung); }
  delegatedDelivery(id: string): { taskId: string; recipient: string; role: string; deadline: number; hostId?: string; rung?: 'task' | 'project' } | null { return this.delegation.delegatedDelivery(id); }
  recoverableDelegation(ids: string[], advance = true): boolean { return this.delegation.recoverableDelegation(ids, advance); }
  answerDelegatedQuestion(input: { questionId: string; answer?: string; choice?: string; reason: string; decision?: 'operator'; overtakes?: string[] }, caller: string) { return this.delegation.answerDelegatedQuestion(input, caller); }
  answerDelegatedQuestionFromTicket(input: { taskId: string; runId: string; questionId: string; answer?: string; choice?: string; reason: string; decision?: 'operator'; overtakes?: string[] }, token: string) { return this.delegation.answerDelegatedQuestionFromTicket(input, token); }
  delegatedQuestionForTask(identity: string, caller: string) { return this.delegation.questionForTask(identity, caller); }
  answerDelegatedQuestionFromHost(input: { questionId: string; answer?: string; choice?: string; reason: string; decision?: 'operator'; overtakes?: string[] }, caller: string, identitySource?: IdentitySource) { return this.delegation.answerFromHost(input, caller, identitySource); }
  waitDelegatedAnswer(id: string, signal: AbortSignal): Promise<string | null> { return this.delegation.waitDelegatedAnswer(id, signal); }
  askBound(task: Task, recipient: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string; onIntent?: () => void; rung?: 'task' | 'project' }, role: 'planner' | 'reviewer'): Promise<string | null> { return this.delegation.askBound(task, recipient, input, role); }
  deciderBound(task: Task, input: { prompt: string; profile: Profile | null; signal: AbortSignal; timeoutMs: number; decisionId: string; sourceAgentId?: string }): Promise<{ agentId: string; text: string | null }> { return this.delegation.deciderBound(task, input); }
  paused() { return this.stopped() || this.store.getMeta('paused') === true; }
  startsNoRuns() { return this.paused(); }
  owns(t: Task): boolean { return this.schedulingLifecycle.owns(t); }
  /**
   * The continuation a replacement worker resumes: a fresh owner instruction,
   * else the latest pending one, the last worker request, the review or the
   * last result (consumer-b #181: a stale pending one never wins over a fresh one).
   */
  workerContinuation(t: Task, instruction?: string): string { return this.retryRoutes.workerContinuation(t, instruction); }
  /**
   * Spec 044 / project-a #1863: an accepted review whose head still equals the task PR head,
   * with no later run completion at a different head. Used to return a blocked revision or
   * recovery to review when the operator supplies a reviewer instruction.
   */
  acceptedReviewAtUnchangedHead(t: Task): Completion | null { return this.retryRoutes.acceptedReviewAtUnchangedHead(t); }
  /**
   * Project-a #1900: with an operator reviewer instruction, a head the retained worker advanced
   * after the accepted review still returns the task to fresh review. The candidate is the latest
   * head reported by a later revision run of the retained worker (same agent and workspace), and
   * every other later run completion must report a head the retained worker also reported, so a
   * recovery restating the same pushed head is not an independent change. The engine verifies
   * GitHub's open PR head equals the candidate before routing, so any other head change refuses.
   */
  retainedWorkerAdvancedReviewHead(t: Task): { review: Completion; head: string } | null { return this.retryRoutes.retainedWorkerAdvancedReviewHead(t); }
  update(t: Task, changes: ResolutionChanges, patch?: Partial<Task>, event?: string, detail?: string) { return this.taskStops.update(t, changes, patch, event, detail); }
  recordStop(task: Task, reason: TaskStopReason, detail: string, suggestedVerbs?: TaskStopVerb[], phase?: Task['phase']): Task { return this.taskStops.recordStop(task, reason, detail, suggestedVerbs, phase); }
  /** Spec 058 budgets (nucleus#1153): open or close the wall-clock pause interval for one task. */
  settleBudgetClock(task: Task, options: { returned?: boolean } = {}): Task { return this.taskStops.settleBudgetClock(task, options); }
  /** Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): clear the host wait when its host is back. */
  clearHostWait(task: Task): Task { return this.taskStops.clearHostWait(task); }
  ensureIncident(task: Task, run: Run | null, reason: string, action?: Incident['action'], cause?: IncidentCause): Incident { return this.taskStops.ensureIncident(task, run, reason, action, cause); }
  recordIncidentEvent(taskId: string, incident: Incident) { return this.taskStops.recordIncidentEvent(taskId, incident); }
  saveIncident(task: Task, patch: Partial<Incident>) { return this.taskStops.saveIncident(task, patch); }
  resolveIncident(task: Task, runId: string | null, detail: string) { return this.taskStops.resolveIncident(task, runId, detail); }
  settleAttentionEpisode(taskId: string, detail: string) { return this.taskStops.settleAttentionEpisode(taskId, detail); }
  operatorReturn(t: Task, changes: ResolutionChanges, patch: Partial<Task>, event: string, detail: string, eventDetail?: string) { return this.taskStops.operatorReturn(t, changes, patch, event, detail, eventDetail); }
  returnToDispatch(t: Task, retainedWorkspace: boolean, reason: string, event?: string): Task { return this.taskStops.returnToDispatch(t, retainedWorkspace, reason, event); }
  private escalationLiveWork(t: Task): string | null { return this.taskStops.escalationLiveWork(t); }
  resolveEscalation(t: Task, reason: string, operator?: boolean): Task { return this.taskStops.resolveEscalation(t, reason, operator); }
  attention(t: Task, reason: string, cause?: IncidentCause) { return this.taskStops.attention(t, reason, cause); }
  waiting(t: Task, reason: string, stop: TaskStopReason | 'classify', suggestedVerbs?: TaskStopVerb[]) { return this.taskStops.waiting(t, reason, stop, suggestedVerbs); }
  private recordDeferredDuringPrerequisiteWait(task: Task, kind: 'transport_deferred' | 'environment_deferred', detail: string): boolean { return this.taskStops.recordDeferredDuringPrerequisiteWait(task, kind, detail); }
  private clearResumedProviderWait(taskId: string): void { this.transientResume.clearResumedProviderWait(taskId); }
  private recordRateLimitCooldown(group: string | null | undefined, error: string): void { this.transientResume.recordRateLimitCooldown(group, error); }
  private selectRateLimitFailover(task: Task) { return this.transientResume.selectRateLimitFailover(task); }
  resumeTransientProviderThread(task: Task, run: Run, state: Awaited<ReturnType<Adapter['observe']>>): Promise<boolean> { return this.transientResume.resumeTransientProviderThread(task, run, state); }
  resumeTransientWorker(task: Task, state: Awaited<ReturnType<Adapter['observe']>>): Promise<boolean> { return this.transientResume.resumeTransientWorker(task, state); }
  applyMergeGateWait(t: Task, gate: { wait: string; needsRebase?: boolean; checksFailed?: boolean; overdue?: boolean; pendingCheck?: boolean; infrastructure?: boolean; infraRunIds?: string[]; overdueCheck?: OverdueCheckEvidence }): Promise<boolean> { return this.checkWaits.applyMergeGateWait(t, gate); }
  private resolvePassedUnchangedCheckEscalation(t: Task): void { return this.checkWaits.resolvePassedUnchangedCheckEscalation(t); }
  requiredCheckPollState(t: Task): { head: string; nextAt: number; incidentId?: string | null } | null { return this.checkWaits.requiredCheckPollState(t); }
  private holdPendingCheck(t: Task, wait: string, overdue: boolean): void { return this.checkWaits.holdPendingCheck(t, wait, overdue); }
  private captureRequiredCheckIncident(t: Task): void { return this.checkWaits.captureRequiredCheckIncident(t); }
  private finishRequiredCheckWait(t: Task, detail: string): void { return this.checkWaits.finishRequiredCheckWait(t, detail); }
  reobservePendingChecks(t: Task): Promise<boolean> { return this.checkWaits.reobservePendingChecks(t); }
  private holdInfrastructureCancellation(t: Task, wait: string, runIds: string[]): Promise<void> { return this.checkWaits.holdInfrastructureCancellation(t, wait, runIds); }
  private repositorySettingsRevision(t: Task): number | null { return this.checkWaits.repositorySettingsRevision(t); }
  gateSettingsCurrent(t: Task, gate: MergeGateResult): boolean { return this.checkWaits.gateSettingsCurrent(t, gate); }
  mergeGateEvidence(t: Task): Promise<MergeGateResult> { return this.checkWaits.mergeGateEvidence(t); }
  private requiredChecksEvidence(t: Task): Promise<RequiredChecksResult> { return this.checkWaits.requiredChecksEvidence(t); }
  private observationLine(check: CheckObservation): string { return this.checkWaits.observationLine(check); }
  private recordCheckObservation(t: Task, gate: {head?: string} & CheckObservationFields): void { return this.checkWaits.recordCheckObservation(t, gate); }
  private mergeProofDetail(result: Awaited<ReturnType<NonNullable<ResolutionAdapter['merged']>>>): string { return this.mergeIntent.mergeProofDetail(result); }
  private resetMergeProof(t: Task, detail: string): Task { return this.mergeIntent.resetMergeProof(t, detail); }
  private mergeElapsed(t: Task): number { return this.mergeIntent.mergeElapsed(t); }
  private escalateUncertainMerge(t: Task, evidence: string): void { return this.mergeIntent.escalateUncertainMerge(t, evidence); }
  reconcileMergeIntent(t: Task): Promise<void> { return this.mergeIntent.reconcileMergeIntent(t); }
  reconcileMergeResponseEffect(taskId: string): Promise<Task> { return this.mergeIntent.reconcileMergeResponseEffect(taskId); }
  /** Resume a held or lost validation through its existing operator retry path. */
  retryProjectValidationEffect(task: Task): Task { return this.validationRetry.retryProjectValidationEffect(task); }
  /** Spec 033: the separate reviewer identity a repository opts into for formal PR reviews, or null for today's comment path. */
  reviewerSetting(t: Task): ReviewerSetting | null { return this.reviewLifecycle.reviewerSetting(t); }
  /** Spec 033: an opted-in repository requires the reviewer's exact-head approval even when the submission skipped review. */
  reviewRequired(t: Task): boolean { return this.reviewLifecycle.reviewRequired(t); }
  transportDeferred(t: Task, error: unknown) { return this.taskStops.transportDeferred(t, error); }
  environmentDeferred(t: Task, error: unknown) { return this.taskStops.environmentDeferred(t, error); }

  /** Queue #705: a written closeout frees the repository's turn at once, so the engine can wake the next holder itself. */
  turnReleased?: (repoPath: string) => void;
  integrationQuantum<T>(taskId: string, work: () => Promise<T>): Promise<T> { return this.integrationTurns.integrationQuantum(taskId, work); }
  integrationActive(t: Task): boolean { return this.integrationTurns.integrationActive(t); }
  /** Hand the turn on at the closeout write instead of at quantum end (Queue #705). */
  closeoutWritten(t: Task) { return this.closeout.closeoutWritten(t); }
  hasEarlierIntegrationTurn(t: Task): boolean { return this.integrationTurns.hasEarlierIntegrationTurn(t); }
  holdsIntegrationTurn(t: Task): boolean { return this.integrationTurns.holdsIntegrationTurn(t); }
  assignIntegrationTurn(t: Task): Task { return this.integrationTurns.assignIntegrationTurn(t); }
  holdLastBlocker(t: Task) {
    return this.holds.holdLastBlocker(t);
  }
  reconcileHoldUntil(taskId: string): 'none' | 'waiting' | 'auto_released' | 'condition_impossible' {
    return this.holds.reconcileHoldUntil(taskId);
  }
  claimIntegrationTurn(t: Task): boolean { return this.integrationTurns.claimIntegrationTurn(t); }
  idle(agentId: string, workspaceId?: string, onBusy?: (state: Awaited<ReturnType<Adapter['observe']>>) => void): Promise<boolean> { return this.participantLease.idle(agentId, workspaceId, onBusy); }
  lease(t: Task, onBusy?: (agentId: string, state: Awaited<ReturnType<Adapter['observe']>>) => void, supersededRunId?: string): Promise<boolean> { return this.participantLease.lease(t, onBusy, supersededRunId); }
  leaseDeclineText(t: Task, agentId: string, state: Awaited<ReturnType<Adapter['observe']>>): string { return this.participantLease.declineText(t, agentId, state); }
  leaseDeclineReason(t: Task): Promise<string | null> { return this.participantLease.declineReason(t); }
  resolveWithdrawnPending(t: Task, hint?: { agentId: string; state: Awaited<ReturnType<Adapter['observe']>> }): Promise<boolean> { return this.participantLease.resolveWithdrawnPending(t, hint); }
  refreshingCloseoutHook(t: Task, syncing: boolean): ReturnType<ParticipantLease['refreshingCloseoutHook']> { return this.participantLease.refreshingCloseoutHook(t, syncing); }
  executionLease(t: Task, enclosing?: VerifiedEnclosingOperation, syncing?: boolean, probe?: boolean): Promise<boolean> { return this.participantLease.executionLease(t, enclosing, syncing, probe); }
  participantToolIssue(taskId: string, agentId: string, workspaceId: string): Promise<string | null> { return this.participantLease.participantToolIssue(taskId, agentId, workspaceId); }
  retry(t: Task, revise = false, instruction?: string, operator = false, resumeUnpublished = false, prePr = false, scopedInstruction?: string, reviewerInstruction?: string) { return this.retryRoutes.retry(t, revise, instruction, operator, resumeUnpublished, prePr, scopedInstruction, reviewerInstruction); }
  prepareRetry(t: Task, revise = false, instruction?: string, operator = false, resumeUnpublished = false, prePr = false, scopedInstruction?: string, reviewerInstruction?: string, settleRunIds: string[] = []): () => Task { return this.retryRoutes.prepareRetry(t, revise, instruction, operator, resumeUnpublished, prePr, scopedInstruction, reviewerInstruction, settleRunIds); }
  resumeWorkerContinuation(t: Task, operator: boolean, continueWorker: (task: Task) => Task): Task { return this.retryRoutes.resumeWorkerContinuation(t, operator, continueWorker); }
  resumeWorker(t: Task, instruction: string, operator = false) { return this.retryRoutes.resumeWorker(t, instruction, operator); }
  prepareResumeWorker(t: Task, instruction: string, operator = false, settleRunIds: string[] = []): () => Task { return this.retryRoutes.prepareResumeWorker(t, instruction, operator, settleRunIds); }
  /**
   * Mint one worker in the retained workspace for a proven-absent creation.
   *
   * `authorized` is the operator path: it also accepts the post-replacement escalation the
   * automatic budget writes, because the state is recoverable and only the automatic path's
   * budget should stop it. Automatic and recovery callers keep the initial reason only, so
   * the one-replacement budget stays exactly one and a later automatic absence still
   * escalates. The event differs, so an operator replacement is visible as such and never
   * counts as the automatic retry.
   */
  admitAbsentWorker(t:Task,instruction:string,authorized=false,settleRunIds:string[]=[]): string { return this.absentRestarts.admitAbsentWorker(t, instruction, authorized, settleRunIds); }
  resumeAbsentWorker(t:Task,instruction:string,authorized=false){ return this.absentRestarts.resumeAbsentWorker(t, instruction, authorized); }
  absentResolutionRun(t:Task){ return this.absentRestarts.absentResolutionRun(t); }
  admitAbsentResolution(t:Task,runId:string,settleRunIds:string[]=[]): Run { return this.absentRestarts.admitAbsentResolution(t, runId, settleRunIds); }
  /**
   * Spec 050 `restart`: recreate one proven-absent resolution run under the SAME
   * run ID. The caller has already completed the inventory lookup; this reserves
   * fresh, valid creation identities for the existing run and calls the launcher
   * once, so no second run is minted.
   */
  admitUncertainRunRestart(t:Task,runId:string,settleRunIds:string[]=[]):Promise<void>{ return this.absentRestarts.admitUncertainRunRestart(t, runId, settleRunIds); }
  restartUncertainRun(t:Task,runId:string,instruction:string|null,settleFences?:{detail:string;runIds:string[];displacedRunIds?:string[]}):Promise<Task>{ return this.absentRestarts.restartUncertainRun(t, runId, instruction, settleFences); }
  recordBlockedPrIdentity(t: Task, prNumber: number, source: string): Promise<Task> {
    return this.prAdoption.recordBlockedPrIdentity(t, prNumber, source);
  }
  adoptReplacementPr(t: Task, prNumber: number) {
    return this.prAdoption.adoptReplacementPr(t, prNumber);
  }
  /**
   * Orphan runs a duplicate dispatch left on one thread: unreleased, never completed,
   * not the task's current run, and a sibling on the same thread from the same or a
   * later dispatch already completed. They own no work and must not hold the thread.
   */
  orphanRuns(taskId: string, agentId: string): Run[] { return this.orphanRunsOwner.orphanRuns(taskId, agentId); }
  /** Release orphan runs with their credentials; call inside a transaction. */
  supersedeOrphans(taskId: string, orphans: Run[]): string[] { return this.orphanRunsOwner.supersedeOrphans(taskId, orphans); }
  observationTargets(): string[] { return this.observation.observationTargets(); }
  observe(inventory?: ReadonlyMap<string, AgentObservation> | null, completedTaskId?: string, onReleased?: (taskId: string) => void) { return this.observation.observe(inventory, completedTaskId, onReleased); }
  recoverRefusedReviewer(task: Task, run: Run): Promise<boolean> {
    return this.providerRefusals.recoverRefusedReviewer(task, run);
  }
  unverifiableRefusalReads(taskId: string, runId: string) {
    return this.providerRefusals.unverifiableRefusalReads(taskId, runId);
  }
  recordUnverifiableRefusalRead(current: Task, run: Run, gap: string): number {
    return this.providerRefusals.recordUnverifiableRefusalRead(current, run, gap);
  }
  clearUnverifiableRefusalWait(current: Task, run: Run): void {
    return this.providerRefusals.clearUnverifiableRefusalWait(current, run);
  }
  applyReviewerRefusal(current: Task, run: Run, group: string, evidence: ProviderRefusalEvidence, expectedVersion: number): Promise<boolean> {
    return this.providerRefusals.applyReviewerRefusal(current, run, group, evidence, expectedVersion);
  }
  refusalExclusions(task: Task): ReadonlySet<string> {
    return this.providerRefusals.refusalExclusions(task);
  }
  recordRefusalBlocked(current: Task, run: Run, group: string, evidence: ProviderRefusalEvidence): void {
    return this.providerRefusals.recordRefusalBlocked(current, run, group, evidence);
  }
  observeStoppedReviewer(current: Task, run: Run, expectedVersion: number): Promise<Task | null> {
    return this.providerRefusals.observeStoppedReviewer(current, run, expectedVersion);
  }
  verifyRefusedRevision(current: Task, run: Run, expectedVersion: number): Promise<boolean> {
    return this.providerRefusals.verifyRefusedRevision(current, run, expectedVersion);
  }
  refusalGap(current: Task, run: Run, expectedVersion?: number): string | null {
    return this.providerRefusals.refusalGap(current, run, expectedVersion);
  }

  /**
   * Zero/one/many reconciliation for one uncertain creation. After the bounded
   * grace: bind one exact match (done by the caller), replace a proven-absent
   * creation exactly once, or hand ambiguity and second failures to the coordinator.
   */
  reconcileAbsentCreation(t: Task, run: Run, found: { id: string; workspaceId: string | null }[]) { return this.absentRestarts.reconcileAbsentCreation(t, run, found); }
  /** Atomically revoke one proven-absent callback and issue exactly one same-role replacement. */
  private replaceAbsentCreation(t: Task, run: Run) { return this.absentRestarts.replaceAbsentCreation(t, run); }
  reconcileStalledTurnStop(task:Task,run:Run|null,state:AgentObservation):boolean{ return this.stalls.reconcileStalledTurnStop(task,run,state); }
  remindStoppedRun(t: Task, run: Run): Promise<void> { return this.callbackReminders.remindStoppedRun(t, run); }
  remindStoppedWorker(t: Task): Promise<void> { return this.callbackReminders.remindStoppedWorker(t); }
  heavyRunAlive(t: Task): Promise<boolean> { return this.validation.heavyRunAlive(t); }
  validationAlive(t: Task): { reason: string } | null { return this.validation.validationAlive(t); }
  validationEvidence(t: Task, options: { fresh?: boolean } = {}): { state: 'alive'; reason: string } | { state: 'unverified'; reason: string } | { state: 'absent' } { return this.validation.validationEvidence(t, options); }
  beginValidationScanPass(): void { this.validation.beginValidationScanPass(); }
  worktreeValidationFor(t: Task, fresh: boolean): WorktreeValidationScan { return this.validation.worktreeValidationFor(t, fresh); }
  /**
   * Spec 050 `restart`: release one retained stopped revision run and hand the
   * same retained worker a continuation, without requiring the escalated
   * missing-callback recovery record the narrow control needed first. The
   * caller has already observed the retained worker stopped.
   */
  admitStoppedRevision(t: Task, instruction: string, prePr: boolean, settleRunIds: string[] = []): Run { return this.retryRoutes.admitStoppedRevision(t, instruction, prePr, settleRunIds); }
  restartStoppedRevision(t: Task, instruction: string, prePr: boolean, settleFences?: { detail: string; runIds: string[]; displacedRunIds?: string[] }): Task { return this.retryRoutes.restartStoppedRevision(t, instruction, prePr, settleFences); }
  extendCallbackReminder(t: Task, runId: string): void { this.callbackReminders.extendCallbackReminder(t, runId); }
  readoptReplacedReviewer(task: Task, run: Run, input: Completion): boolean { return this.callbackIntake.readoptReplacedReviewer(task, run, input); }
  complete(input: Completion, token: string, startEvidence?: string) { return this.callbackIntake.complete(input, token, startEvidence); }
  completeValidate(input: Completion, run: Run, task: Task) { return this.callbackIntake.completeValidate(input, run, task); }
  completeProof(run: Run, task: Task, input: Completion, startEvidence?: string) { return this.callbackIntake.completeProof(run, task, input, startEvidence); }
  completeBuildOutput(run: Run, task: Task) { return this.callbackIntake.completeBuildOutput(run, task); }
  completeBookkeeping(run: Run, task: Task, input: Completion) { return this.callbackIntake.completeBookkeeping(run, task, input); }
  completeReceipt(run: Run, task: Task, input: Completion, correctingBlock: boolean, response: { accepted: true; eventId: string }) { return this.callbackIntake.completeReceipt(run, task, input, correctingBlock, response); }
  recordFinishedTaskCompletion(task: Task, run: Run, input: Completion, token: string) { return this.callbackIntake.recordFinishedTaskCompletion(task, run, input, token); }
  recordSupersededProofEvidence(task: Task, run: Run, input: Completion, startEvidence?: string) { return this.callbackIntake.recordSupersededProofEvidence(task, run, input, startEvidence); }
  authorAgentIds(t: Task): Set<string> {
    return this.selection.authorAgentIds(t);
  }
  recordCriticalReviewFallback(t: Task, profile: Profile): Task { return this.criticalReviewFallback.recordCriticalReviewFallback(t, profile); }
  select(t: Task, role: 'reviewer' | 'coordinator' | 'executor', extraUnavailable?: Iterable<string>, excludedProfiles?: ReadonlySet<string>, usage?: UsageLevel) {
    return this.selection.select(t, role, extraUnavailable, excludedProfiles, usage);
  }
  requiredRouteNote(t: Task, role: 'reviewer' | 'coordinator'): string {
    return this.selection.requiredRouteNote(t, role);
  }
  usageCeilingNote(t: Task, role: 'reviewer' | 'coordinator' | 'worker', extraUnavailable?: Iterable<string>, excludedProfiles?: ReadonlySet<string>, widened?: () => { profile: Profile; entry: { cost?: string | null } } | null): string {
    return this.selection.usageCeilingNote(t, role, extraUnavailable, excludedProfiles, widened);
  }
  retainedProfileIssue(assigned:Profile|null){
    return this.selection.retainedProfileIssue(assigned);
  }
  retainedWorkerProfileIssue(t:Task){
    return this.selection.retainedWorkerProfileIssue(t);
  }
  signoffIssue(t:Task,assigned:Profile|null,role:'reviewer'|'coordinator'):string|null{
    return this.selection.signoffIssue(t, assigned, role);
  }
  reviewContinuationOwner(t: Task): Run | null { return this.reviewContinuations.reviewContinuationOwner(t); }

  settleVerbFences(taskId: string, settle: { detail: string; runIds: string[]; displacedRunIds?: string[] }): void { this.continuationFences.settleContinuationFences(taskId, settle); }

  stopResumeState(input: { taskId: string; runId: string; checkpointOrdinal: number }): StoppedDeliveryResume { return this.reviewContinuations.stopResumeState(input); }
  inspectReviewContinuation(input: { taskId: string; version: number; runId: string; head: string; checkpointOrdinal: number; reason: string; instruction: string }, operationId: string): Promise<Task | null> { return this.reviewContinuations.inspectReviewContinuation(input, operationId); }
  admitReviewContinuation(input: { taskId: string; version: number; runId: string; head: string; checkpointOrdinal: number; reason: string; instruction: string; settleFences?: { runIds: string[]; displacedRunIds?: string[] } }, operationId: string) { return this.reviewContinuations.admitReviewContinuation(input, operationId); }
  continueReview(input: { taskId: string; version: number; runId: string; head: string; checkpointOrdinal: number; reason: string; instruction: string; settleFences?: { detail: string; runIds: string[]; displacedRunIds?: string[] } }, operationId: string): Promise<Task> { return this.reviewContinuations.continueReview(input, operationId); }
  reviewContinuationGate(input: { taskId: string; version: number; runId: string; head: string; checkpointOrdinal: number }, expectedVersion: number, operationId: string, options: { settle?: { runIds: string[]; displacedRunIds?: string[] } } = {}) { return this.reviewContinuations.reviewContinuationGate(input, expectedVersion, operationId, options); }
  assertReviewCheckpointProvenance(task: Task, run: Run, record: ReviewCheckpointRecord): string { return this.reviewContinuations.assertReviewCheckpointProvenance(task, run, record); }

  assertReviewProfileIndependent(task: Task, run: Run) {
    return this.selection.assertReviewProfileIndependent(task, run);
  }

  ownedToolHold(agentId: string, options: { requireCompleteEvidence?: boolean; runId?: string; runIds?: string[]; taskId?: string; workspaceId?: string } = {}): Promise<string | null> {
    return this.ownedTools.ownedToolHold(agentId, options);
  }
  /** Positive evidence that the agent's own detached job is still running, or null. */
  ownedJobWait(agentId: string): Promise<string | null> { return this.ownedTools.ownedJobWait(agentId); }

  assertIdleReviewerObservation(task: Task, run: Run, observed: AgentObservation) { return this.reviewContinuations.assertIdleReviewerObservation(task, run, observed); }

  settleReviewDelivery(runId: string, deliveryId: string, status: ReviewDeliveryAuthorization['status'], evidence: string, receiptProven = false): void { this.effectReconcile.settleReviewDelivery(runId, deliveryId, status, evidence, receiptProven); }
  reconcileArchivedReviewerDispatch(taskId: string, runId: string): Promise<boolean> { return this.effectReconcile.reconcileArchivedReviewerDispatch(taskId, runId); }
  reconcileUncertainRunDelivery(taskId: string, runId: string): Promise<boolean> { return this.effectReconcile.reconcileUncertainRunDelivery(taskId, runId); }
  reconcileReviewDeliveryOperations(taskId: string, runId: string, deliveryId: string, evidence: string): void { this.effectReconcile.reconcileReviewDeliveryOperations(taskId, runId, deliveryId, evidence); }
  deliveryInTimeline(run: Run, deliveryId: string): Promise<boolean> { return this.effectReconcile.deliveryInTimeline(run, deliveryId); }
  reconcileReviewDelivery(run: Run, authorization: ReviewDeliveryAuthorization): Promise<ReviewDeliveryAuthorization> { return this.effectReconcile.reconcileReviewDelivery(run, authorization); }
  reconcileReviewDeliveryEffect(taskId: string, deliveryId: string): Promise<ReviewDeliveryAuthorization> { return this.effectReconcile.reconcileReviewDeliveryEffect(taskId, deliveryId); }
  reconcileAttentionNoticeEffect(taskId: string, noticeId: string): Promise<boolean> { return this.effectReconcile.reconcileAttentionNoticeEffect(taskId, noticeId); }

  /** Latest accepted blocked result relevant to a worker retry, kept separate from action authority. */
  retryContext(t: Task, taskRuns: Run[] = this.store.runs(t.id).filter(run => run.role !== 'recovery')): NonNullable<Run['retryContext']> | undefined {
    const latest = taskRuns.at(-1);
    const revision = latest?.role === 'revision' ? latest : null;
    if (revision?.released && revision.completion && ['blocked', 'error'].includes(revision.completion.status) &&
        revision.completion.taskId === t.id && revision.completion.runId === revision.id) {
      return { source: 'revision', runId: revision.id, status: revision.completion.status as 'blocked' | 'error',
        head: revision.completion.head ?? revision.head, summary: revision.completion.summary };
    }
    const initial = t.completion;
    const workerBlocked = Boolean(initial && ['blocked', 'error'].includes(initial.status) && initial.runId === t.runId &&
      !taskRuns.some(run => run.id === initial.runId));
    if (workerBlocked) return { source: 'worker', runId: initial!.runId, status: initial!.status as 'blocked' | 'error',
      head: initial!.head ?? null, summary: initial!.summary };
    return undefined;
  }
  /**
   * After a live run's result is applied, an open retained wait must land before
   * the next dispatch. A same-pass release still waits for a later pass.
   */
  pauseForPrerequisiteWait(t: Task): boolean { return this.schedulingLifecycle.pauseForPrerequisiteWait(t); }
  withDispatchPass<T>(pass: () => Promise<T>): Promise<T> { return this.slotAdmission.withDispatchPass(pass); }
  passDependencyWait(task: Task): string { return this.slotAdmission.passDependencyWait(task); }
  slotAdmissionReader(tasks: Task[], runs: Run[], includeRecovery?: boolean): (task: Task) => string { return this.slotAdmission.slotAdmissionReader(tasks, runs, includeRecovery); }
  slotAdmissionReason(task: Task, includeRecovery?: boolean, parkedPhases?: readonly string[], view?: SlotAdmissionView): string { return this.slotAdmission.slotAdmissionReason(task, includeRecovery, parkedPhases, view); }
  projectInFlightAdmissionReason(task: Task): string { return this.slotAdmission.projectInFlightAdmissionReason(task); }
  progressEffectsPending(t:Task): boolean { return this.progressContinuation.progressEffectsPending(t); }
  /** Re-prove a newer published head before a retained worker continues it. */
  continuedProgressWait(t:Task, head:string): Promise<string | null> { return this.progressContinuation.continuedProgressWait(t, head); }
  /**
   * Spec 058 slice 2: a responsible task raises one joint planner question
   * after its third substantive review round has not converged. The worker and
   * reviewer state the disagreement in the task's own thread through Paseo's
   * native question surface, so it is answerable in the sidebar or on the board,
   * and the task waits there instead of changing the worker model or opening a
   * coordinator. The durable event is the send intent: an interrupted
   * observation is unknown and never resent.
   *
   * Returns true when the round must not be dispatched now. Other tasks keep
   * their ordinary revision route.
   */
  responsibleJointQuestion(t: Task): Promise<boolean> { return this.jointReviewQuestion.responsibleJointQuestion(t); }
  settleJointQuestion(taskId: string, id: string, answer: string): void { return this.jointReviewQuestion.settleJointQuestion(taskId, id, answer); }
  responsibleBlockerLadder(t: Task, input: { source: 'worker' | 'revision' | 'executor' | 'reviewer' | 'recovery' | 'closeout'; runId: string | null; completion: Completion }): Promise<boolean> { return this.ladder.responsibleBlockerLadder(t, input); }
  holdProofOnlyGoWait(t: Task): boolean { return this.ladder.holdProofOnlyGoWait(t); }
  settleCompletedExecutorBlocker(input: Completion): Promise<void> { return this.ladder.settleCompletedExecutorBlocker(input); }
  suppressAutomaticRetry(t: Task, site: string, evidence: string, runId?: string | null): boolean { return this.ladder.suppressAutomaticRetry(t, site, evidence, runId); }
  openReviewerConsult(t: Task, input: { cause: string; runId: string | null; completion: Completion; reviewer: string | null }): void { return this.ladder.openReviewerConsult(t, input); }
  consultStillOwnsWait(taskId: string, id: string): boolean { return this.ladder.consultStillOwnsWait(taskId, id); }
  runReviewerConsult(t: Task, input: { id: string; reviewer: string | null; question: string }): Promise<void> { return this.ladder.runReviewerConsult(t, input); }
  escalateConsultedBlocker(t: Task, input: { id: string }): void { return this.ladder.escalateConsultedBlocker(t, input); }
  openReviewContinuationEscalation(t: Task, state: 'exhausted' | 'closed'): string { return this.ladder.openReviewContinuationEscalation(t, state); }
  escalateRefusedCoordinator(t: Task, reason: string): void { return this.ladder.escalateRefusedCoordinator(t, reason); }
  attentionUnknownEscalation(t: Task, escalation: { id: string; question: string | null }): void { return this.ladder.attentionUnknownEscalation(t, escalation); }
  openPlannerEscalation(t: Task, input: { cause: string; runId: string | null; question: string; payload: object; suggestedVerbs?: TaskStopVerb[]; causeDetail?: string }): void { return this.ladder.openPlannerEscalation(t, input); }
  routePlannerEscalation(t: Task, id: string, question: string): Promise<void> { return this.ladder.routePlannerEscalation(t, id, question); }
  classifyEscalationToOperator(t: Task, id: string, reason: string, who: string): void { return this.ladder.classifyEscalationToOperator(t, id, reason, who); }
  settlePlannerEscalation(t: Task, id: string, answer: string, who: string, offered?: EscalationVerbChoice[], questionId?: string): Promise<string | null> { return this.ladder.settlePlannerEscalation(t, id, answer, who, offered, questionId); }
  continueWorkerAfterLadder(t: Task, input: { instruction: string; event: string; reason: string; detail: string }): void { return this.ladder.continueWorkerAfterLadder(t, input); }
  /**
   * Spec 058 (task 523): a responsible task parked on a wait only a person can
   * clear asks the operator on its own thread, so the question is answered in
   * the sidebar or as the task's composer pill instead of being found on the
   * board. The durable event is the send intent, recorded before the prompt:
   * at most one question per stop and head, exactly as the joint review
   * question does, and a lost observation is unknown and never resent.
   *
   * Only `operatorQuestionFor` decides which stops ask: a wait the code or the
   * task's own threads settle raises nothing, and tasks that did not opt in
   * keep today's notices exactly.
   */
  raiseOperatorQuestions(scopedTaskId?: string): Promise<void> { return this.questions.raiseOperatorQuestions(scopedTaskId); }
  /**
   * Spec 058 (task 542): a responsible task never stalls after the operator
   * answers its worker's own native question. If the task is stopped because
   * its own worker (or reviewer) reported blocked, and that agent's native
   * question is then answered on its thread, Queue continues the same retained
   * agent with the answers through the ordinary move to=work (worker) or the
   * retained reviewer restart. No owner or planner action is needed. It happens
   * once per answered permission: the answered event is the fence, and a lost
   * observation is recorded as unknown and never resent. Observation uses the
   * existing permission-resolution surface (`answeredQuestions`, read from the
   * agent timeline); a failed read is empty, never evidence.
   */
  delegateNativeQuestions(): Promise<void> { return this.nativeQuestions.delegateNativeQuestions(); }
  answerNativeQuestions(taskId: string, agentId: string, workspaceId: string, id: string,
    request: { requestId: string; questions: Array<{ header: string; question: string; options: string[] }> }, signal: AbortSignal): Promise<void> { return this.nativeQuestions.answerNativeQuestions(taskId, agentId, workspaceId, id, request, signal); }
  resumeResponsibleAnsweredQuestions(): Promise<void> { return this.nativeQuestions.resumeResponsibleAnsweredQuestions(); }
  /** Retry an answered proof-only GO after a busy refusal once all Queue runs settle. */
  resumeBusyProofGoAnswers(): Promise<void> { return this.questions.resumeBusyProofGoAnswers(); }
  /**
   * Spec 058 budgets: an authorized extension adds one default increment while
   * either limit is exhausted. A budget pause is cleared; other lifecycle stops
   * remain in place. A late answer cannot grant an increment after usage falls
   * below the current limit.
   */
  extendTaskBudget(taskId: string, detail: string, by = 'The operator'): Task | null { return this.questions.extendTaskBudget(taskId, detail, by); }
  /**
   * An applied owner control replaces any outstanding question about the
   * task's previous state. Keep the question history, but make later native
   * or delegated answers inert and close any linked board decision.
   */
  supersedeOpenOwnerQuestions(taskId: string, reason: string): void { return this.questions.supersedeOpenOwnerQuestions(taskId, reason); }
  /** Record the answer, then apply the owner verb it names with the operator's authority. */
  settleOperatorQuestion(taskId: string, question: OperatorQuestion, answer: string, recordAnswer = true): Promise<void> { return this.questions.settleOperatorQuestion(taskId, question, answer, recordAnswer); }
  /**
   * The exact owner control an answer names. The operator's authority is the
   * question and its answer, relayed by the task's own thread: that is what the
   * acceptance and proof activation record, never a caller identity Queue guessed.
   */
  operatorAnswerControl(task: Task, question: OperatorQuestion, choice: OperatorQuestionChoice, answer: string, delegation: DelegatedAnswer | null = null): TaskControlInput { return this.questions.operatorAnswerControl(task, question, choice, answer, delegation); }
  /** Budget asks can outlive the stop they describe while a planner response is pending. */
  queueBudgetQuestionCurrent(taskId: string, decision: { id: string; kind: OperatorQuestionKind }): boolean { return this.questions.queueBudgetQuestionCurrent(taskId, decision); }
  /**
   * Spec 058 (task 540): raise one native question on the task's own thread. The project's planner,
   * or a decider, answers once the thread presents the question. Proof-only release GO, the one
   * operator-only kind Nucleus raises, goes straight to the board and never comes here.
   */
  raiseDecision(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, signal: AbortSignal,
    options: { boardOnly?: boolean; why?: string } = {}): Promise<string> { return this.questions.raiseDecision(task, decision, signal, options); }
  /**
   * Spec 058 (task 550): raise one Queue question on a thread with no native
   * question surface. It goes to the planner, then a decider, and a routing miss
   * falls back to a Spec 032 decision (board and composer pill) so the question
   * is never stranded with nobody. The thread is prompted once to join
   * through `nucleus_ask` and collect the answer in turn; that prompt is one
   * best-effort send whose failure is recorded and never retried, because the
   * answer's authority path does not depend on it. The returned promise settles
   * with the answer exactly as a native question's observation does, so the
   * caller's settlement path (the recorded answer and the question's controls)
   * runs unchanged.
   */
  raiseAskDecision(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, signal: AbortSignal): Promise<string> { return this.questions.raiseAskDecision(task, decision, signal); }
  /**
   * The durable join key plus one best-effort prompt, so the task's own thread can
   * collect the answer in turn by calling `nucleus_ask` with the exact content.
   */
  deliverQueueAsk(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }): Promise<void> { return this.questions.deliverQueueAsk(task, decision); }
  /** The Spec 032 decision a Queue-raised ask-mode question answers through; created once, linked durably. */
  ensureQueueRaiseDecision(task: Task, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; details?: string | null; fullQuestion?: string | null }, why: string): void { return this.questions.ensureQueueRaiseDecision(task, decision, why); }
  /** Settle an ask-mode Queue raise with the answer; the caller's own settlement path records and applies it. */
  resolveQueueRaise(questionId: string, answer: string, answeredBy?: string): void { return this.questions.resolveQueueRaise(questionId, answer, answeredBy); }
  /**
   * Spec 058 (task 550): the operator answered a decision on the board or the
   * composer pill. Durable event links say which agent ask or Queue-raised
   * ask-mode question waits behind it, so both keep working after a restart. The
   * answer itself is already recorded on the decision; this records the ask's
   * outcome and settles the raise deferred, whose own path records the answer and
   * applies the question's controls.
   */
  operatorDecisionAnswered(view: DecisionView): void { return this.questions.operatorDecisionAnswered(view); }
  /** A named escalation wait wakes once; a lost or refused effect is never replayed blindly. */
  /** Recover durable ask intents and answered board decisions on each maintenance wake. */
  resumeAskQuestions(): Promise<void> { return this.questions.resumeAskQuestions(); }
  agentAsk(input: AgentAskRequest, token: string): Promise<AgentAskReceipt> { return this.agentAsks.agentAsk(input, token); }
  askBinding(task: Task, runId: string): Pick<Run, 'id' | 'role' | 'agentId'> { return this.agentAsks.askBinding(task, runId); }
  askStale(task: Task, suppliedRunId: string): Error { return this.agentAsks.askStale(task, suppliedRunId); }
  recordedAnswer(taskId: string, askId: string): AgentAskReceipt | null { return this.agentAsks.recordedAnswer(taskId, askId); }
  joinedQuestion(events: ReturnType<Store['eventsAll']>, askId: string): string | null { return this.agentAsks.joinedQuestion(events, askId); }
  recordAndRouteAsk(task: Task, run: Pick<Run, 'id' | 'role' | 'agentId'>, ask: AgentAskShape): string | null { return this.agentAsks.recordAndRouteAsk(task, run, ask); }
  /** Only a positive observation counts: a failed read leaves the thread in place. */
  plannerThreadGone(agentId: string): Promise<boolean> { return this.plannerPresence.plannerThreadGone(agentId); }
  /** Task 1109: the thread that answers this task's questions first — its planner, else its owner. */
  taskPlannerFor(task: Task): Promise<PlannerRung | null> { return this.delegation.taskPlannerFor(task); }
  /** Task 1109: the ordered planner rungs a task's questions climb — its own planner, then the project's. */
  plannerRungsFor(task: Task): Promise<{ rungs: PlannerRung[]; projectFailed: boolean }> { return this.delegation.plannerRungsFor(task); }
  /**
   * Task 1109: issue a planner's participant ticket before a question names it,
   * supplied by the runtime that owns ticket delivery; absent in tests and when no
   * runtime is bound, where the recipient's host identity answers.
   */
  ensurePlannerTicket: ((agentId: string, hostId: string) => Promise<void>) | null = null;
  projectPlannerFor(task: Task): Promise<{ planner: string | null; failed: boolean }> { return this.delegation.projectPlannerFor(task); }
  /** An escalation's rung: the task's own planner, then the project planner, the order task 1109 gives questions. */
  escalationRecipient(task: Task): Promise<string | null> { return this.plannerPresence.escalationRecipient(task); }
  routeAgentAsk(task: Task, ask: AgentAskShape): Promise<void> { return this.agentAsks.routeAgentAsk(task, ask); }
  routeReviewerAsk(task: Task, ask: AgentAskShape): Promise<void> { return this.agentAsks.routeReviewerAsk(task, ask); }
  recordAgentAskAnswer(taskId: string, askId: string, who: string, answer: string, reason: string, overtakes?: string[]): void { this.agentAsks.recordAgentAskAnswer(taskId, askId, who, answer, reason, overtakes); }
  notifyStaleQuestionAnswer(taskId: string, questionId: string, who: string): void { return this.plannerPresence.notifyStaleQuestionAnswer(taskId, questionId, who); }
  notifyAskAnswered(taskId: string, askId: string, answer: string, who: string): void { this.agentAsks.notifyAskAnswered(taskId, askId, answer, who); }
  askOperatorDecision(task: Task, ask: AgentAskShape, why: string): void { this.agentAsks.askOperatorDecision(task, ask, why); }
  awaitAgentAsk(taskId: string, askId: string, joined: string | null): Promise<AgentAskReceipt> { return this.agentAsks.awaitAgentAsk(taskId, askId, joined); }
  agentAskPendingDetail(taskId: string, askId: string): string { return this.agentAsks.agentAskPendingDetail(taskId, askId); }
  agentMessage(input: AgentMessageRequest, token: string): Promise<AgentMessageReceipt> { return this.agentMessages.agentMessage(input, token); }
  messageRecipientTask(from: Task, to: string): Task { return this.agentMessages.messageRecipientTask(from, to); }
  private messageRecipientIdentity(task: Task, role: 'worker' | 'reviewer'): { agentId: string | null; present: boolean; live: boolean; wait: string } { return this.agentMessages.messageRecipientIdentity(task, role); }
  private deliverAgentMessage(recipient: Task, record: AgentMessageRecord): Promise<AgentMessageReceipt> { return this.agentMessages.deliverAgentMessage(recipient, record); }
  private messageReceipt(recipient: Task, role: AgentMessageRole, record: AgentMessageRecord): AgentMessageReceipt { return this.agentMessages.messageReceipt(recipient, role, record); }
  private taskLabel(task: Task): string { return this.agentMessages.taskLabel(task); }
  deliverQueuedMessages(): Promise<void> { return this.agentMessages.deliverQueuedMessages(); }
  /**
   * Spec 058 (task 540): answer a delegable question. The project's planner goes first; with no planner,
   * or no usable answer within about ten minutes, a short-lived decider answers once and is archived.
   * The answer is recorded (with the answering agent and its reason) before the question is answered on
   * its surface — the native permission, or the ask-mode raise — and it applies through the ordinary verbs
   * with `delegated` authority. A lost delegate observation is recorded as unknown and never re-asked.
   * Returns whether a usable answer was produced and delivered.
   */
  delegateDecision(taskId: string, decision: { id: string; kind: OperatorQuestionKind; question: string; options: string[]; fullQuestion?: string | null },
    request: { requestId: string; header: string } | null, signal: AbortSignal,
    deliver: (task: Task, answer: string) => Promise<void>): Promise<boolean> { return this.questions.delegateDecision(taskId, decision, request, signal, deliver); }

  /** A newly live planner gets one fresh chance to settle each proof wait parked for it. */
  projectPlannerRegistered(projectKey: string, plannerId: string): Promise<void> { return this.questions.projectPlannerRegistered(projectKey, plannerId); }
  /**
   * Task 1110: the send-time address of one of a project's registered agents.
   * `name` null is the project's fallback planner, the thread `to: {project}`
   * resolves to. A named thread is observed on its own host first: an archived,
   * gone or unreadable thread refuses with that state, and nothing is sent.
   */
  async resolveProjectAgentTarget(projectKey: string, name: string | null): Promise<{ agentId: string; hostId: string; name: string }> {
    const project = this.store.projectByKey(projectKey);
    if (!project) throw new Error(`Unknown project ${projectKey}`);
    const entry = name === null
      ? (project.agents ?? []).find(agent => agent.agentId === project.planner?.agentId)
      : (project.agents ?? []).find(agent => agent.name === name);
    const current = () => ({ host: this.host, observedHostId: observedHostIdOf(this.adapter) });
    if (entry && entry.hostId !== observedHostIdOf(this.adapter) && this.originHostAvailable(entry.hostId))
      return this.withHost(entry.hostId, () => resolveProjectAgent(current(), this.store.projectByKey(projectKey)!, name));
    return resolveProjectAgent(current(), project, name);
  }
  deciderProfile(task: Task): Profile | null { return this.delegation.deciderProfile(task); }
  decisionContext(task: Task): string[] { return this.delegation.decisionContext(task); }
  startRunnableProof(task: Task): Promise<boolean> { return this.proofAutorun.startRunnableProof(task); }
  /** Stop observing native decisions this process owns; their outcome stays unknown and is never resent. */
  abortResponsibleQuestions() { return this.questions.abortResponsibleQuestions(); }
  /**
   * Project-d #117 (Tom, 2026-10-23): verify a PR the task knows only from a
   * reported completion exactly as the revision continuation verifies it (PR
   * identity with a draft allowed, then the continuation worktree proof; the
   * ready gate without that adapter pair). Null when the task's PR is bound.
   * A failed proof throws before anything is written.
   */
  verifyContinuedPr(t: Task): Promise<ContinuedPrBinding | null> { return this.reviewLifecycle.verifyContinuedPr(t); }
  /**
   * Spec 057 (task 553): a worker `blocked` or `ready_for_review` completion
   * that names a pushed head in its report, while `prHead` is null, has that
   * head resolved against the task's PR and branch before review, so the
   * retained reviewer has a head to review. The reported head must equal the
   * observed open-PR head at the task's PR number from the canonical source,
   * and the report must be authenticated (its stored receipt hash matches).
   * Binds `prUrl`, `prHead` and `resumePrNumber` as identity; grants no
   * readiness beyond what the report already carries. False when nothing
   * authentic names the observed head, leaving the ordinary refusal to fire.
   */
  bindReportedHeadForReview(t: Task, pr: VerifiedPr): boolean { return this.reviewLifecycle.bindReportedHeadForReview(t, pr); }
  continuedPrBinding(t: Task, number: number, pr: VerifiedPr, decided?: ContinuedPrBinding['decided']): ContinuedPrBinding { return this.reviewLifecycle.continuedPrBinding(t, number, pr, decided); }
  /**
   * Inside the transaction that accepts the continuation: the task must still
   * know the PR only from the same report, on the same repository, branch,
   * base, worker, workspace and recorded head, with no merge intent. Then it
   * binds `prUrl`, `resumePrNumber` and `prHead`; otherwise it writes nothing.
   */
  bindContinuedPrInTx(taskId: string, binding: ContinuedPrBinding, via: string): boolean { return this.reviewLifecycle.bindContinuedPrInTx(taskId, binding, via); }
  /** Engine-provided: whether the daemon profile catalog has loaded since start. */
  catalogKnown: () => boolean = () => true;
  /**
   * Engine-provided: apply one owner control for an answer the operator gave to
   * Queue's own native question on the task's thread. Spec 058 (task 523): the
   * answer applies through the existing verbs, never through a new control.
   */
  applyOperatorControl?: (input: TaskControlInput) => Promise<unknown>;
  launch(t: Task, role: Run['role'], options: { profile?: Profile; instruction?: string; proof?: ProofActivation } = {}): Promise<void> { return this.dispatchLaunch.launch(t, role, options); }
  proofExecution(t: Task, activation: ProofActivation, profile?: Profile): Promise<Task> { return this.dispatchLaunch.proofExecution(t, activation, profile); }
  private prepareLaunchSource(t: Task, role: Run['role'], options: { profile?: Profile; instruction?: string; proof?: ProofActivation }): Promise<void> { return this.dispatchLaunch.source.prepareLaunchSource(t, role, options); }
  selectLaunchThread(t: Task, role: Run['role'], options: { profile?: Profile; instruction?: string; proof?: ProofActivation }, source:{firstReviewEntryWorker:boolean;firstWorkerSelection:ReturnType<typeof chooseProfile>|null;prePrWorkerResume:boolean;retainedPrePrHead:string|null;resumingUnpublished:boolean;continuedPr?:ContinuedPrBinding|null}): Promise<void> { return this.dispatchLaunch.thread.selectLaunchThread(t, role, options, source); }
  reserveLaunchRun(t: Task, role: Run['role'], options: { profile?: Profile; instruction?: string; proof?: ProofActivation }, source:{firstReviewEntryWorker:boolean;firstWorkerSelection:ReturnType<typeof chooseProfile>|null;prePrWorkerResume:boolean;retainedPrePrHead:string|null;resumingUnpublished:boolean;continuedPr?:ContinuedPrBinding|null}, selection:{agentId:string|null;profile:Profile|null;group:string|null;workspaceId:string;coordinatorRouteSwitch:string|null;replacingReviewer:boolean;orphanRuns:(id:string)=>Run[];threadBusy:(id:string)=>boolean}): Promise<void> { return this.dispatchLaunch.reserve.reserveLaunchRun(t, role, options, source, selection); }
  /** Finished-run observation timestamps are telemetry, not another custody owner.
   * Keep every identity, result, delivery, release and publication field in the fence. */
  ordinaryReviewRuns(taskId: string): string { return this.reviewLifecycle.ordinaryReviewRuns(taskId); }
  ordinaryRoundCustody(t: Task, run: Run, restoring = false): Promise<void> { return this.reviewLifecycle.ordinaryRoundCustody(t, run, restoring); }
  deliverLaunchRun(t:Task, role:Run['role'], context:{agentId:string|null;profile:Profile|null;group:string|null;workspaceId:string;firstReviewEntryWorker:boolean;nonDeliveryReplacement:boolean;run:Run;token:string}):Promise<void> { return this.dispatchLaunch.deliver.deliverLaunchRun(t, role, context); }
  /** Select one closeout authority from the manifest pinned at this task's synchronized integration commit. */
  closeoutAuthority(t: Task): Promise<CloseoutAuthority> { return this.closeout.closeoutAuthority(t); }
  /** Complete closeout in Queue: no run, workspace, hook occurrence, commit or push. */
  queueCloseout(t: Task): Promise<void> { return this.closeout.queueCloseout(t); }
  /** Complete closeout through the repository's authoritative integration-write hook. No closeout run or workspace is created. */
  hookCloseout(t: Task): Promise<void> { return this.closeout.hookCloseout(t); }
  automaticHookReplayPending(t: Task): boolean { return this.mergePhase.automaticHookReplayPending(t); }
  settleAutomaticReplayHold(t: Task, records: HookRecord[], event: HookEventName): Task { return this.mergePhase.settleAutomaticReplayHold(t, records, event); }
  refusePreMerge(t: Task, reason: string, eventDetail: string) { return this.mergeGates.refusePreMerge(t, reason, eventDetail); }
  verification(t: Task, prepareHooks = true) { return this.mergeGates.verification(t, prepareHooks); }
  reconcileReviewPublication(t: Task, runId: string, reason: string, reportingRunId?: string) { return this.reviewPublication.reconcileReviewPublication(t, runId, reason, reportingRunId); }
  acceptExternalMerge(t: Task, reason: string, settleFences?: string, appliedCoordinatorRunId?: string, reviewEntry?: ReviewEntryExternalMerge, retained?: RetainedSourceExternalMerge, enclosingOperation?:()=>VerifiedEnclosingOperation|undefined) { return this.externalMerge.acceptExternalMerge(t, reason, settleFences, appliedCoordinatorRunId, reviewEntry, retained, enclosingOperation); }
  recoverExternalMerge(t: Task) { return this.externalMerge.recoverExternalMerge(t); }
  resumeClearedAttention(t: Task): Task | null { return this.externalMerge.resumeClearedAttention(t); }
  reapplyPendingReview(t: Task): Promise<'none' | 'applied' | 'blocked'> { return this.resultApplication.reapplyPendingReview(t); }
  gitTransientFailure?: (task: Task, error: unknown) => boolean;
  advance(original: Task): Promise<void> { return this.schedulingLifecycle.advance(original); }
  /** Advance step: supersede an old recovery episode once later progress owns the task. */
  supersedeEarlierRecovery(t: Task): Task { return this.recoveryLifecycle.supersedeEarlierRecovery(t); }
  /** Advance gate: a source approval whose awaited proof is not yet settled waits at its approved head. */
  sourceApprovalWaitApplies(t: Task): boolean { return this.schedulingLifecycle.sourceApprovalWaitApplies(t); }
  /** Advance step: a source-approved PR waits for its awaited proof at the approved head. Null stops the pass. */
  settleSourceApprovalProof(t: Task): Promise<Task | null> { return this.reviewLifecycle.settleSourceApprovalProof(t); }
  restoreRecordedMergePhase(t: Task): Task { return this.mergePhase.restoreRecordedMergePhase(t); }
  /** Advance gate: an accepted PR whose task workspace may be unavailable needs its reconciliation check. */
  acceptedPrWorkspaceMayApply(t: Task): boolean { return this.acceptedPrWorkspace.acceptedPrWorkspaceMayApply(t); }
  /** Advance step: reconcile an accepted PR whose task workspace became unavailable. Null stops the pass. */
  reconcileAcceptedPrWorkspace(t: Task): Promise<Task | null> { return this.acceptedPrWorkspace.reconcileAcceptedPrWorkspace(t); }
  /** Advance step: a stored result or late completion settles the attention it answers, and a required-hook retry clears its attention. */
  recordStoredResult(t: Task): Task { return this.schedulingLifecycle.recordStoredResult(t); }
  unchangedCheckGateApplies(t: Task): boolean { return this.mergePhase.unchangedCheckGateApplies(t); }
  settleUnchangedCheckGate(t: Task): Promise<Task> { return this.mergePhase.settleUnchangedCheckGate(t); }
  /** Advance gate: a parked blocked or errored responsible task climbs the ladder once per receipt. */
  blockerLadderApplies(t: Task): boolean { return this.schedulingLifecycle.blockerLadderApplies(t); }
  /** Advance step: a parked blocked or errored responsible task climbs the ladder once per receipt. Null stops the pass. */
  blockerLadderStep(t: Task): Promise<Task | null> { return this.recoveryLifecycle.blockerLadderStep(t); }
  /** Advance gate: attention that no unmerged merge intent holds may be replayed. */
  attentionReplayApplies(t: Task): boolean { return this.recoveryLifecycle.attentionReplayApplies(t); }
  /** Advance step: redrive a held hook replay, or keep the attention. Null stops the pass. */
  replayHeldAttention(t: Task): Promise<Task | null> { return this.recoveryLifecycle.replayHeldAttention(t); }
  /** Advance step: apply the phase-specific work for one attempt, inside its single-flight reservation. */
  advancePhase(t: Task): Promise<void> { return this.schedulingLifecycle.advancePhase(t); }
  /** Advance step: record a failed attempt as superseded, uncertain, waiting, environmental or attention. */
  settleAdvanceFailure(t: Task, error: unknown, observedRunId: string | null, supersededBy: (current: Task) => string | null): void { return this.recoveryLifecycle.settleAdvanceFailure(t, error, observedRunId, supersededBy); }
  advanceCompletedRun(t:Task, run:Run):Promise<void> { return this.resultApplication.advanceCompletedRun(t, run); }
  private advanceProofExecutionResult(t: Task, run: Run, c: Completion): Promise<void> { return this.resultApplication.advanceProofExecutionResult(t, run, c); }
  private routeAwaitingProofs(t: Task, run: Run, c: Completion): void { return this.resultApplication.routeAwaitingProofs(t, run, c); }
  private advanceReviewerResult(t:Task, run:Run, c:Completion, reapplied = false): Promise<void> { return this.resultApplication.advanceReviewerResult(t, run, c, reapplied); }
  private verdictApplied(taskId: string, runId: string): boolean { return this.resultApplication.verdictApplied(taskId, runId); }
  private closeProofOnlyQualification(t:Task, run:Run, c:Completion): void { return this.resultApplication.closeProofOnlyQualification(t, run, c); }
  private applyReviewerResult(t:Task, run:Run, c:Completion, reapplied: boolean): Promise<void> { return this.resultApplication.applyReviewerResult(t, run, c, reapplied); }
  responsiblePrReportRefused(t: Task, runId: string, prNumber: number, error: unknown): boolean { return this.resultApplication.responsiblePrReportRefused(t, runId, prNumber, error); }
  private advanceRevisionResult(t:Task, run:Run, c:Completion): Promise<void> { return this.resultApplication.advanceRevisionResult(t, run, c); }
  advanceCloseoutResult(t:Task, run:Run, c:Completion): Promise<void> { return this.closeout.advanceCloseoutResult(t, run, c); }
  advanceChangesRequested(t:Task): Promise<void> { return this.reviewLifecycle.advanceChangesRequested(t); }
  advanceClosing(t:Task): Promise<void> { return this.closeout.advanceClosing(t); }
  advanceMerging(t:Task): Promise<void> { return this.mergeGates.advanceMerging(t); }
  advanceSyncing(t:Task): Promise<void> { return this.closeout.advanceSyncing(t); }
  advanceSkippedReview(t:Task): void { return this.reviewLifecycle.advanceSkippedReview(t); }
  private sendDurably(...args: Parameters<Notices['sendDurably']>): Promise<'paused' | 'done'> { return this.notices.sendDurably(...args); }
  deliverDrainNotices(): Promise<void> { return this.notices.deliverDrainNotices(); }
  /** Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): the one long-outage planner notice. */
  deliverHostOutageNotices(): Promise<void> { return this.notices.deliverHostOutageNotices(); }
  deliverNotices(): Promise<void> { return this.notices.deliverNotices(); }
  deliverHoldNotices(): Promise<void> { return this.notices.deliverHoldNotices(); }
  deliverDecisionNotices(): Promise<void> { return this.notices.deliverDecisionNotices(); }
}
