import type { LaunchReserveContext } from '../launch';
import type { LaunchMachinePorts } from './machine';
import type { Run, Task } from '../../../shared/contracts';
import { currentBrief } from '../../planning/brief';
import { taskPrNumber } from '../../forge/index';
import { now } from '../../store/store';
import { proofExecutor } from '../../recovery/task-reasons';
import type { ReservationSource } from './reservation-source';

/**
 * The run intent one reservation records: the review round or proof it
 * continues, the source head it binds, the instruction it consumes, and the
 * thread and profile it is delivered to. Each group is a named part of the one
 * intent, so a reader sees which fact came from the task and which from this
 * launch.
 */
export function runIntent(input: { task: Task; role: Run['role']; machine: LaunchMachinePorts; resolution: LaunchReserveContext; source: ReservationSource }): Run {
  const { task: t, role, machine, resolution } = input;
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
  const reviewDelivery = role === 'reviewer' ? {
    reviewReason: t.resolution.pendingReviewReason,
    formalReview: Boolean(resolution.reviewerSetting(t)),
    // sendRun only rotates a binding, not a retained agent's MCP catalog.
    // Require the field only for a fresh bridge or its proven retained lineage.
    reviewResponsibilityRequired: !s.selection.agentId
      || resolution.store.runs(t.id).some(prior => prior.agentId === s.selection.agentId && prior.reviewResponsibilityRequired === true),
  } : {};
  const profileGroup = s.selection.group
    ?? resolution.store.runs(t.id).findLast(run => run.agentId === s.selection.agentId && run.profileGroup)?.profileGroup
    ?? (s.selection.profile ? resolution.store.pool().find(entry => entry.profileId === s.selection.profile!.id)?.group ?? null : null);
  return {
    ...s.round,
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
