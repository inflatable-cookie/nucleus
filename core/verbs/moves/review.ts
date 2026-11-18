import { isDeepStrictEqual } from "node:util";
import type { Task } from "../../../shared/contracts";
import { requestedReviewerRefusal } from "../../../shared/authors";
import { validateNamedProfile } from "../../dispatch/routing";
import type { Engine } from "../../engine";
import { assertCanonicalPrSource, taskPrNumber } from "../../forge/index";
import { runsUnchangedSince } from "../../recovery/observation-advance";
import { blockingRecoveryEffectsRefusal } from "../../recovery/recovery-effects";
import { operatorReplacementPending } from "../../recovery/task-reasons";
import { reviewerIdentityAtHead } from "../../review/review-continuation";
import { proofOnlyReceiptAwaitingReview } from "../../qa/proof-records";
import { currentReadyPrEvidence } from "../owner-verbs";
import { MOVE_REVIEW_PR_REFUSAL, MOVE_REVIEW_WORKSPACE_REFUSAL, moveStateRefusal, REMOVED_TASK_REFUSAL } from "../control-refusals";
import { cancelDisplacedReviewers, observeReviewerDisplacement } from "./review-displacement";
import { moveRetainedReader } from "./review-reader";
import { commitReviewMove, nameLaunchFence, settleStoppedReviewers } from "./review-settle";
import { moveProofOnlyReceiptToReview } from "./review-proof";
import type { ReviewMoveInput } from "./types";
import { requestReviewerReport, requireReviewerReplacement, verifyReviewerPr } from '../reviewer-report';

/**
 * Spec 050 `move to=review`: a fresh independent review at the current PR
 * head. Prior review credit is superseded and kept as history, and an
 * answered attention episode is settled. A checkpointed or stopped reviewer
 * run yields to the move: it is superseded without a verdict, history kept.
 * A workerless review-entry task with a changed PR head must return to work
 * so a revision worker authors the change in its task workspace first.
 * A retained PR number can restore the binding after routing; source,
 * participant and delivery proofs still precede the atomic settlement.
 */
export async function moveToReview(engine: Engine, input: ReviewMoveInput, operationId?: string): Promise<Task> {
  const store = engine.store;
  const adapter = engine.adapter;
  const task = store.task(input.taskId);
  if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
  engine.requireOwnerControlCurrent(task, input.version, 'Task changed; refresh before retrying');
  const stateRefusal = moveStateRefusal(task, "review");
  if (stateRefusal) throw Error(stateRefusal);
  if (proofOnlyReceiptAwaitingReview(task)) return moveProofOnlyReceiptToReview(engine, input);
  // Project-d #117 (Tom, 2026-10-23): with no bound PR, the PR and exact head
  // the current authenticated ready result names are bound with the review
  // entry, under every retained-PR proof below and the exact-head check.
  const runsBefore = store.runs(task.id);
  const evidence = !task.prUrl && !task.resumePrNumber ? currentReadyPrEvidence(task, runsBefore) : null;
  if (!task.prUrl && !task.resumePrNumber && !evidence) throw Error(MOVE_REVIEW_PR_REFUSAL);
  const prNumber = evidence?.prNumber ?? taskPrNumber(task);
  if (input.prNumber !== undefined && input.prNumber !== prNumber) throw Error(evidence
    ? `Move to review must use PR #${prNumber}, which the current ready result names`
    : `Move to review must use the retained task PR #${prNumber}`);
  if (input.fresh) await requireReviewerReplacement(engine, task, input.version);
  // A refused move must not reattach a checkout still owned by a detached
  // reviewer. Keep this proof read-only even when fresh replacement was asked;
  // the launch path owns any later checkout handoff after admission.
  const currentReader = runsBefore.findLast(run => run.role === 'reviewer' && !run.released && !run.completion && run.ordinaryDetached
    && (run.id === task.resolution.currentRunId || !task.resolution.currentRunId && run.replacedAt && run.agentId === task.resolution.reviewerAgentId));
  const pr = currentReader ? await verifyReviewerPr(engine, task, currentReader, prNumber, input.fresh !== true) : await adapter.verifyPr(task, prNumber);
  if (evidence && pr.head !== evidence.head)
    throw Error(`PR #${prNumber} is at ${pr.head}, not the head ${evidence.head} its current ready result reports; nothing was bound`);
  // Reapply only a verdict pending at the verified current head. A newer PR
  // head supersedes it, and an explicit fresh review owns this transition.
  if (input.fresh !== true && pr.head === task.prHead) {
    const pendingReview = await engine.resolution.reapplyPendingReview(task);
    if (pendingReview === 'applied') return store.task(task.id);
    if (pendingReview === 'blocked') throw Error('A released accepted review is still pending; move to review was refused until its lifecycle result is settled');
  }
  // A previous move may have detached the same still-credentialed reviewer
  // without its report. Rebind that exact run before asking it to redeliver;
  // never start another reader to stand in for missing evidence.
  const detached = input.fresh !== true && !task.resolution.currentRunId && task.resolution.reviewerAgentId
    ? runsBefore.findLast(run => run.role === 'reviewer' && !run.released && !run.completion && run.replacedAt
      && run.agentId === task.resolution.reviewerAgentId && run.head === pr.head) : null;
  if (detached) {
    const wait = engine.dispatchWaitsFor(task, engine.isOwnerCall(), true);
    if (wait) return engine.deferOwnerVerb(task, { ...input, action: 'move', to: 'review' }, wait, null);
    if (runsBefore.some(run => !run.released && run.id !== detached.id))
      throw Error('Another run still owns the task; settle it before requesting the reviewer report');
    const state = await engine.host.observe(detached.agentId!);
    if (state.id !== detached.agentId || state.workspaceId !== detached.workspaceId || state.active || state.activeTurnId || state.permissions || !['idle', 'error'].includes(state.status))
      throw Error('The retained reviewer is not positively idle in its workspace; no report was requested');
    const rebound = store.transaction(() => {
      const current = store.task(task.id);
      engine.requireOwnerControlCurrent(current, task.version, 'Task changed during reviewer observation; refresh before retrying');
      if (!runsUnchangedSince(runsBefore, store.runs(task.id))) throw Error('Reviewer changed during observation; refresh before retrying');
      store.putRun({ ...detached, status: 'running', replacedAt: undefined });
      return engine.resolution.update(current, { currentRunId: detached.id }, { phase: 'reviewing', reason: 'Recovering the retained reviewer report' },
        'reviewer_report_rebound', `${detached.id}: ${input.reason}`);
    });
    return requestReviewerReport(engine, rebound, store.run(detached.id)!, rebound.version, input.reason);
  }
  const retained = !task.prUrl && (Boolean(task.resumePrNumber) || Boolean(evidence));
  const observeRetainedWorkers = async () => {
    if (!retained) return;
    if (!task.agentId || !task.workspaceId || !task.directory || !task.profile || operatorReplacementPending(task))
      throw Error(MOVE_REVIEW_WORKSPACE_REFUSAL);
    for (const agentId of new Set([task.agentId, ...task.retiredWorkers.map(worker => worker.agentId)])) {
      const observed = await engine.host.observe(agentId);
      if (observed.id !== agentId || observed.workspaceId !== task.workspaceId || observed.active || observed.activeTurnId || observed.permissions || !['idle', 'error', 'closed'].includes(observed.status))
        throw Error('Move to review requires the retained workers to be observably inactive in the task workspace');
    }
  };
  const checkRetainedEffects = () => {
    if (!retained) return;
    const refusal = blockingRecoveryEffectsRefusal(store, store.task(task.id), { kinds: ['run-delivery', 'publication', 'review-delivery', 'merge-response'] });
    if (refusal) throw Error(refusal);
  };
  checkRetainedEffects();
  await observeRetainedWorkers();
  // Spec 050 (#3569): finished runs settle by observation before the run
  // fence — including a completed reviewer run, whose verdict the move
  // supersedes as credit; one that cannot settle refuses here, with its own
  // reason and nothing written. Round 4: other roles' runs are displaced (a busy
  // turn is cancelled below, after every check that can refuse); only a durable
  // side effect refuses.
  const reviewRunsBefore = store.runs(task.id);
  const displacement = await observeReviewerDisplacement(engine, task.id);
  if (evidence) assertCanonicalPrSource(pr, prNumber);
  if (retained) {
    if (!adapter.verifyResume || !adapter.verifyInspectedRevisionHead) throw Error('Retained PR source verification is unavailable');
    await adapter.verifyResume(task);
    await adapter.verifyInspectedRevisionHead(task, prNumber, pr.head);
    await observeRetainedWorkers();
  }
  // A valid reader already reviewing this exact head is preserved and continued,
  // not replaced; the reader move decides that, or returns null for the ordinary
  // path. An unprovable reader binding refuses before any displacement.
  const identity = input.fresh === true
    ? { kind: 'absent' as const }
    : reviewerIdentityAtHead(store.task(task.id), store, pr.head);
  if (identity.kind === 'refused') throw Error(identity.refusal);
  const reading = input.fresh !== true && identity.kind === 'valid' ? identity.run : null;
  if (reading) {
    const decided = await moveRetainedReader(engine, input, task, pr, displacement.finished, reading, operationId);
    if (decided) return decided;
  }
  // A workerless review-entry task cannot adopt an externally changed head.
  // Return it to work so Queue's revision worker authors the changes in the
  // task workspace before a fresh review is requested.
  if (task.reviewEntry && !task.agentId && pr.head !== task.prHead)
    throw Error('The review-entry PR head changed; use move to=work to start the revision worker in the task workspace before moving to review');
  // A requested reviewer is preflighted before anything is written: its model
  // must differ from the author's, and neither may be an opaque route.
  if (input.reviewer) {
    engine.requireProfileCatalog();
    const { profile } = validateNamedProfile(input.reviewer.profileId, 'reviewer', task.scope, engine.profiles, store.pool(), input.reviewer.reason.trim(), task.thinkingOptionId);
    engine.requireAvailableGroup(input.reviewer.profileId);
    const author = task.workerModel ?? task.profile?.model;
    const refusal = requestedReviewerRefusal({ profileId: input.reviewer.profileId, reviewerModel: profile.model,
      authorModels: author ? [author] : task.reviewEntry?.authorDeclaration.models ?? [] });
    if (refusal) throw Error(refusal);
  }
  if (displacement.finished.live.length || displacement.liveReviewers.length) engine.assertUnchangedBeforeCancel(task.id, input.version, reviewRunsBefore);
  await cancelDisplacedReviewers(engine, task.id, displacement, 'move review');
  // Project-d #117 review: a binding never rests on an observation made
  // before a remote cancel. After any cancellation, the retained workers are
  // observed again; the published clean source is proven last, on the task
  // lane, immediately before the accepting transaction.
  if (evidence) {
    await observeRetainedWorkers();
    await adapter.verifyResume!(task);
    await observeRetainedWorkers();
  }
  // Spec 057 (task 553): on a responsible task the move keeps the retained
  // reviewer for the delta review at the new head unless fresh is asked for
  // or the retained reviewer is closed or unavailable. The closed check is one
  // observation before the accepting transaction; every other check re-reads
  // the store inside it.
  const freshAsked = input.fresh === true;
  const observedRetained = !freshAsked && task.resolution.reviewerAgentId
    ? await engine.host.observe(task.resolution.reviewerAgentId).catch(() => null)
    : null;
  const retainedClosedAtObserve = Boolean(observedRetained
    && observedRetained.id === task.resolution.reviewerAgentId && observedRetained.status === 'closed');
  return engine.control(async () => {
    if (evidence) await adapter.verifyInspectedRevisionHead!(task, prNumber, pr.head);
    const settled = await engine.control(() => store.transaction(() => {
      const current = store.task(task.id);
      engine.requireOwnerControlCurrent(current, input.version, 'Task changed; refresh before retrying');
      if (retained && !runsUnchangedSince(runsBefore, store.runs(task.id))) throw Error('A run changed during the move; refresh before retrying');
      if (evidence && !isDeepStrictEqual(currentReadyPrEvidence(current, store.runs(task.id)), evidence)) throw Error('The ready result changed during the move; refresh before retrying');
      checkRetainedEffects();
      // Finished runs of other roles release first: a recovery episode's
      // accepted action is recorded as not applied on the resolved episode, and
      // the re-read in the commit carries that record through the move's update.
      engine.releaseDisplacedRunsInTx(task.id, displacement.displaced.map(run => run.id), `move review: ${input.reason}`);
      if (store.runs(current.id).some(run => !run.released && !displacement.stoppedReviewers.has(run.id))) throw Error('A run started during the move; refresh before retrying');
      settleStoppedReviewers(engine, current.id, displacement.stoppedReviewers, input.reason);
      if (evidence) store.event(task.id, 'move_review_pr_bound',
        `PR #${evidence.prNumber} at ${pr.head} from the ready result ${evidence.eventId} of run ${evidence.runId}: ${input.reason}`.slice(0, 2000));
      return commitReviewMove(engine, task.id, current, {
        reason: input.reason, movedTo: pr.head, fallbackHead: settledTask => settledTask.prHead ?? pr.head,
        reviewer: input.reviewer, freshAsked, observedRetained, retainedClosedAtObserve, callerAsked: Boolean(input.caller),
        subject: 'task',
        binding: { prHead: pr.head, prUrl: pr.url, ...(evidence ? { resumePrNumber: evidence.prNumber } : {}) },
        eventDetail: evidence ? { boundPr: evidence } : {},
      });
    }), `task:${task.id}`);
    // A reviewer run the move could not release, or a busy participant the
    // dispatch lease polls, still owns the launch: name it, with the rule
    // keeping it and what releases it, instead of reporting a move to review
    // that started no reader (nucleus#1100).
    await nameLaunchFence(engine, task.id, settled.reason, input.reason);
    return store.task(settled.id);
  }, `task:${task.id}`);
}
