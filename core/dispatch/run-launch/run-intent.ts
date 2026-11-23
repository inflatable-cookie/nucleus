import type { LaunchReserveContext } from '../launch';
import type { LaunchMachinePorts } from './machine';
import type { Run, Task } from '../../../shared/contracts';
import { currentBrief } from '../../planning/brief';
import { taskPrNumber, type ReviewerSetting } from '../../forge/index';
import { now, type Store } from '../../store/store';
import { proofExecutor } from '../../recovery/task-reasons';
import type { ReservationSource } from './reservation-source';

/**
 * How one reviewer run delivers its verdict: the review reason it consumes, the
 * publication form the repository's policy requires, and whether its report must
 * carry review responsibility. Every path that creates a reviewer run records
 * these from here, so a reviewer started by an explicit command is told to
 * publish the same way the policy later demands at application.
 */
export function reviewerRunDelivery(
  store: Pick<Store, 'runs'>,
  t: Task,
  reviewer: ReviewerSetting | null,
  agentId: string | null,
): Pick<Run, 'reviewReason' | 'formalReview' | 'reviewResponsibilityRequired'> {
  return {
    reviewReason: t.resolution.pendingReviewReason,
    formalReview: Boolean(reviewer),
    // sendRun only rotates a binding, not a retained agent's MCP catalog.
    // Require the field only for a fresh bridge or its proven retained lineage.
    reviewResponsibilityRequired: !agentId
      || store.runs(t.id).some(prior => prior.agentId === agentId && prior.reviewResponsibilityRequired === true),
  };
}

/**
 * The run intent one reservation records: the review round or proof it
 * continues, the source head it binds, the instruction it consumes, and the
 * thread and profile it is delivered to. Each group is a named part of the one
 * intent, so a reader sees which fact came from the task and which from this
 * launch.
 */
export function runIntent(input: { task: Task; role: Run['role']; resolution: LaunchReserveContext; source: ReservationSource }): Run {
  const { task: t, role, resolution } = input;
  const machine: LaunchMachinePorts = resolution.adapter;
  const s = input.source;
  const brief = currentBrief(t);
  const proofExecution = proofExecutor(role) && s.proofTree ? {
    selector: t.proofExecution!.selector, inputs: t.proofExecution!.inputs,
    prNumber: t.proofOnly ? null : taskPrNumber(t), tree: s.proofTree, operationId: s.options.proof?.operationId ?? null,
    briefVersion: brief?.version ?? null, briefDigest: brief?.digest ?? null,
    ...(s.options.proof?.goEvidence ? { goEvidence: s.options.proof.goEvidence } : {}),
    returnPhase: t.phase, authorizedBy: s.options.proof?.authorizedBy ?? { role: 'queue_dispatch' as const, caller: null, note: null },
  } : null;
  // This run's own scratch, and the two source intents a reservation may consume from the task.
  const scratch = machine.runTemporaryDirectory ? { temporaryDirectory: machine.runTemporaryDirectory(s.runId, t) } : {};
  const proofOnly = s.proofOnlyReview ? { proofOnly: true as const, reviewDelta: s.proofOnlyInstruction } : {};
  const consumedSource = {
    ...(s.source.resumingUnpublished ? { identityConfirmation: true as const } : {}),
    ...(role === 'reviewer' && s.authorEvidence ? { authorEvidence: s.authorEvidence } : {}),
    ...(role === 'reviewer' && t.resolution.proofRetry?.head === t.prHead
      ? { proofRetry: { forRunId: t.resolution.proofRetry.runId, head: t.resolution.proofRetry.head, proofs: t.resolution.proofRetry.proofs } } : {}),
  };
  // The exact source this run binds: a closeout the synced commit, a resumed pre-PR worker its
  // retained head, a proof the merged commit, anything else the published head or planning base.
  const head = role === 'closeout' ? t.resolution.syncedCommit! : s.prePrWorkerResume ? s.retainedPrePrHead! : s.source.continuedPr?.head ?? t.proofOnly?.commit ?? t.prHead ?? t.planningBase;
  const base = s.prePrWorkerResume ? t.planningBase : role === 'reviewer' ? s.roundBase : t.resolution.mergeBase ?? t.planningBase;
  // A reviewer's reason, publication form and responsibility requirement belong to that role alone.
  const reviewDelivery = role === 'reviewer'
    ? reviewerRunDelivery(resolution.store, t, resolution.reviewerSetting(t), s.selection.agentId) : {};
  const profileGroup = s.selection.group
    ?? resolution.store.runs(t.id).findLast(run => run.agentId === s.selection.agentId && run.profileGroup)?.profileGroup
    ?? (s.selection.profile ? resolution.store.pool().find(entry => entry.profileId === s.selection.profile!.id)?.group ?? null : null);
  const previousReader = role === 'reviewer' && s.selection.agentId
    ? resolution.store.runs(t.id).findLast(run => run.role === 'reviewer' && run.agentId === s.selection.agentId && !run.releasedBeforeSend) : null;
  const reportRecovery = previousReader?.released && !previousReader.completion && previousReader.head === head
    ? { reviewReportRecovery: previousReader.id } : {};
  return {
    ...s.round,
    ...reportRecovery,
    ...scratch,
    ...proofOnly,
    briefVersion: brief?.version ?? null,
    id: s.runId,
    ...consumedSource,
    taskId: t.id,
    role,
    generation: t.coordinatorGeneration,
    head,
    base,
    siblings: t.siblingPins,
    ...(proofExecution ? { proofExecution } : {}),
    instruction: s.proofOnlyInstruction ?? s.instruction,
    ...(s.retryContext ? { retryContext: s.retryContext } : {}),
    revisionCause: s.revisionCause,
    ...reviewDelivery,
    agentId: s.selection.agentId,
    workspaceId: s.selection.workspaceId,
    profile: s.selection.profile,
    profileGroup,
    status: 'intent',
    createdAt: now(),
    lastObservedAt: null,
    active: null,
    idleSince: null,
    completion: null,
    released: false,
  };
}
