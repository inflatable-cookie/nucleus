import { MOVE_WORK_AUTHOR_REFUSAL, MOVE_WORK_REPLACEMENT_REFUSAL, MOVE_REVIEW_WORKSPACE_REFUSAL, MOVE_MERGE_ACCEPTANCE_REFUSAL } from "./control-refusals";
import { RETAINED_PREREQUISITE_REFUSAL } from "./verb-refusal-text";
import { readyReviewAtHead } from "../recovery/task-reasons";
import { moveStateRefusal } from "./control-refusals";
import { DISPOSITION_CONTROL_REFUSAL, REMOVED_TASK_REFUSAL, MOVE_REVIEW_PR_REFUSAL } from "./control-refusals";
import { groupIsUnavailable } from "../../shared/pool";
import { proofOnlyReceiptAwaitingReview } from "../qa/proof-execution";
import { z } from "zod";
import { isDispositionActive, taskControlInputSchema, taskNextVerbSchema, type Run, type Task, type TaskControlInput, type TaskNextVerb } from "../../shared/contracts";
import { operatorReplacementPending, revisionPhases } from "../recovery/task-reasons";
import { blockingRecoveryEffectsRefusal } from "../recovery/recovery-effects";
import { reviewInProgress, reviewerIdentityAtHead, reviewContinuationState, retainedReaderStateDecision, retainedReaderStoredRefusal, retainedReaderUnavailableRefusal, reviewContinuationWait, keepRetainedReviewer } from "../review/review-continuation";
import { durableRunFence, currentReadyPrEvidence, prIdentity } from './owner-facts';
import type { OwnerVerbFacts } from './owner-facts';
import { verbInput } from './owner-shared';
import type { OwnerVerbApplicability, OwnerVerb } from './owner-shared';
import { retainedContinuationPlan, plainHandoverFreshRestart } from './owner-restart';

export const moveTargets = ["work", "review", "merge", "closeout"] as const;

type MoveTarget = typeof moveTargets[number];

/**
 * The exact qualified owner-acceptance eligibility rule (2026-10-17, generalized
 * 2026-10-20), shared by `next` and the applied `move to=merge`. A `reviewed`
 * acceptance needs an authentic released reviewer verdict at the current PR head
 * whose publication evidence exists, so the acceptance binds review identity
 * Queue can re-verify at the forge. When that evidence is missing — no verdict,
 * an interrupted reviewer, an unpublished verdict, or a head a docs-only
 * resolution moved after the verdict — an explicit `operator_source` acceptance
 * is available instead: it binds only the exact published source head and
 * records what is missing. It is never fabricated review credit: a ready
 * current-head approval keeps the ordinary path, and a missing PR head refuses.
 */
type AcceptanceEligibility =
  | { available: false; refusal: string }
  | { available: true; acceptance: "reviewed"; args: Record<string, unknown> }
  | { available: true; acceptance: "operator_source"; missingEvidence: string; args: Record<string, unknown> };

export function qualifiedAcceptanceEligibility(task: Task, runs: Run[]): AcceptanceEligibility {
  if (task.removedAt) return { available: false, refusal: REMOVED_TASK_REFUSAL };
  if (isDispositionActive(task)) return { available: false, refusal: DISPOSITION_CONTROL_REFUSAL };
  if (["done", "cancelled"].includes(task.phase) || task.resolution.mergedCommit || task.resolution.mergeIntent)
    return { available: false, refusal: `The task is ${task.phase} or merging; acceptance applies to an unmerged task` };
  if (!task.prHead)
    return { available: false, refusal: "Moving to merge requires an accepted review at the current PR head" };
  const review = task.resolution.review;
  if (review && review.status === "ready_to_merge")
    return review.head === task.prHead
      ? { available: false, refusal: MOVE_MERGE_ACCEPTANCE_REFUSAL }
      : { available: true, acceptance: "operator_source", missingEvidence: `The recorded ready_to_merge approval is at head ${review.head?.slice(0, 12) ?? "no head"}, not the current PR head`, args: {} };
  const source = (missingEvidence: string): AcceptanceEligibility =>
    ({ available: true, acceptance: "operator_source", missingEvidence, args: {} });
  if (!review)
    return source("No reviewer verdict exists at the current PR head");
  if (review.head !== task.prHead)
    return source(`The recorded ${review.status} review is at head ${review.head?.slice(0, 12) ?? "no head"}, not the current PR head`);
  if (!(review.reviewId ?? review.reviewCommentId))
    return source("The recorded review verdict has no published evidence to verify at the forge");
  const run = runs.find(candidate => candidate.id === review.runId);
  if (!run || run.role !== "reviewer" || run.taskId !== task.id || !run.released || run.status !== "finished"
    || run.completion?.eventId !== review.eventId || run.completion.status !== review.status || run.completion.head !== review.head)
    return source("No finished released reviewer run carries the recorded verdict");
  return { available: true, acceptance: "reviewed", args: {} };
}

function moveViews(facts: OwnerVerbFacts): TaskNextVerb[] {
  const { task, runs } = facts;
  const identity = { taskId: task.id, version: task.version };
  const view = (to: MoveTarget, outcome: (OwnerVerbApplicability & { note?: string; acceptance?: string; missingEvidence?: string }), fill: string[], qualifyingFill: string[] = []): TaskNextVerb =>
    outcome.available
      ? taskNextVerbSchema.parse({ verb: "move", action: "move", available: true,
        args: { action: "move", to, ...identity, ...outcome.args }, fill,
        ...(qualifyingFill.length ? { qualifyingFill } : {}),
        // An operator source acceptance is available, not free: `next` names the
        // review evidence it lacks beside the disposition it records.
        ...(outcome.acceptance === "operator_source" && outcome.missingEvidence
          ? { note: `No review evidence binds the current head: ${outcome.missingEvidence}. An explicit operator source acceptance records that accepted risk and enters ordinary verification; any source change needs a fresh disposition.` }
          : outcome.note ? { note: outcome.note } : {}) })
      // A refused view carries no args, so the refusal names its target: the
      // four views are told apart by the target their refusal speaks about.
      : taskNextVerbSchema.parse({ verb: "move", action: "move", available: false, refusal: `move ${to}: ${outcome.refusal}. A planner or operator can use force with a reason` });
  const gate = (to: MoveTarget): OwnerVerbApplicability | null => {
    const refusal = moveStateRefusal(task, to);
    if (refusal) return { available: false, refusal };
    return null;
  };
  const live = runs.find(item => !item.released);
  // Round 4 (Tom, 2026-10-19): the move displaces the runs in its way — it
  // cancels a busy turn and settles the run — so only a durable side effect
  // fences, exactly as in the handler's displace mode.
  const liveGate = (_to: string, _yieldToMove = false): OwnerVerbApplicability => {
    const fence = durableRunFence(facts);
    return fence ? { available: false, refusal: fence } : { available: true, args: {},
      note: "Nucleus freshly observes the bound participants before moving; current identity, activity, permissions, tools and durable effects determine whether the move can settle or displace them." };
  };
  const work = ((): OwnerVerbApplicability => {
    const shared = gate("work"); if (shared) return shared;
    if (task.entrypoint === "proof" && task.proofOnly)
      return { available: false, refusal: "A proof-only qualification has no worker; review the settled receipt with move to=review" };
    const running = liveGate("work", true); if (!running.available) return running;
    // A pending replacement is the route `move to=work` must consume when no
    // author is present. Only a launch already in progress fences the move.
    if (operatorReplacementPending(task) && task.phase === "dispatching" && !task.agentId && task.agentIntent)
      return { available: false, refusal: MOVE_WORK_REPLACEMENT_REFUSAL };
    if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt)
      return { available: false, refusal: RETAINED_PREREQUISITE_REFUSAL };
    // The retained author takes the revision path, which needs a revision phase.
    if (task.agentId) return revisionPhases.includes(task.phase) ? running : { available: false, refusal: `Returning to the worker is not valid from phase ${task.phase}` };
    if (task.agentIntent) return { available: false, refusal: "The worker creation is still uncertain; restart re-creates it under the same run" };
    if (task.profile && task.workspaceId) return running;
    return { available: false, refusal: MOVE_WORK_AUTHOR_REFUSAL };
  })();
  const freshReview: OwnerVerbApplicability[] = [];
  const review = ((): OwnerVerbApplicability => {
    const shared = gate("review"); if (shared) return shared;
    if (proofOnlyReceiptAwaitingReview(task)) {
      const reviewGate = liveGate("review", true);
      if (!reviewGate.available) return reviewGate;
      return { available: true, args: {}, note: `Move to review starts a receipt reviewer at merged commit ${task.proofOnly!.commit}; the receipt is the subject and no PR is needed.` };
    }
    const evidence = currentReadyPrEvidence(task, runs);
    if (!task.prUrl && !task.resumePrNumber && !evidence) return { available: false, refusal: MOVE_REVIEW_PR_REFUSAL };
    if (!task.prUrl && (task.resumePrNumber || evidence)) {
      if (!task.agentId || !task.workspaceId || !task.directory || !task.profile || operatorReplacementPending(task))
        return { available: false, refusal: MOVE_REVIEW_WORKSPACE_REFUSAL };
      const refusal = blockingRecoveryEffectsRefusal(facts.store, task, { kinds: ['run-delivery', 'publication', 'review-delivery', 'merge-response'] });
      if (refusal) return { available: false, refusal };
    }
    // Tom, 2026-10-27 ("Preserve the reader for everyone"): a valid retained
    // reader at this exact head is preserved and continued by the move. The view
    // shares the applied rule: a reading or delivered turn sends no new message,
    // an awaiting checkpoint delegates the ordinary retained-restart
    // continuation, an unsettled delivery refuses, and a reader that cannot
    // continue names the deliberate replacement instead of being replaced.
    // One identity result from current facts, shared with the applying control:
    // an existing unfinished reviewer whose source or participant binding cannot
    // be proved is refused here, never read as absent and replaced (review
    // 5673604194).
    const identity = reviewerIdentityAtHead(task, facts.store, task.prHead ?? "");
    if (identity.kind === 'refused') return { available: false, refusal: identity.refusal };
    if (runs.some(run => run.role === 'reviewer' && !run.released && !run.completion && run.reviewCheckpoints?.length)) {
      const freshGate = liveGate("review", true);
      if (freshGate.available) freshReview.push({ available: true, args: { fresh: true },
        note: "Start a fresh reviewer at the current PR head; the displaced round and its checkpoints remain history. Nucleus observes participants and settles their runs before moving." });
    }
    const reader = identity.kind === 'valid' && reviewInProgress(identity.run) ? identity.run : null;
    if (reader) {
      const state = reviewContinuationState(task, facts.store);
      const readerDecision = retainedReaderStateDecision(state);
      const storedRefusal = retainedReaderStoredRefusal(state, reviewContinuationWait(task, facts.store).reason);
      if (storedRefusal) return { available: false, refusal: storedRefusal };
      // An awaiting checkpoint is the one case where the move delegates a
      // delivery, so its offer is derived from the same plan `restart
      // role=reviewer` reads — the local gate, the other-run settlement and the
      // held deferral — and refuses exactly where that restart would
      // (review 5672912042).
      if (readerDecision === 'awaiting') {
        const plan = retainedContinuationPlan(facts);
        if (plan?.kind === 'refused') return { available: false, refusal: plan.refusal };
        if (plan?.kind === 'fresh_only') return { available: false, refusal: retainedReaderUnavailableRefusal() };
        if (plan?.kind === 'ready')
          return { available: true, args: {}, note: `This preserves the valid reader on run ${reader.id} (agent ${reader.agentId}) at ${task.prHead} and continues checkpoint ${plan.checkpoint.ordinal} through the ordinary retained-restart delivery${plan.deferred ? ', recorded now and delivered once the task is unheld' : ' once the reviewer is idle'}. restart role=reviewer fresh or route role=reviewer with now replaces it deliberately.${plan.note ? ` ${plan.note}` : ''}` };
        return { available: false, refusal: `the saved checkpoint on run ${reader.id} is no longer the reviewer's latest; read next again before moving` };
      }
      return { available: true, args: {}, note: `This preserves the valid reader on run ${reader.id} (agent ${reader.agentId}) at ${task.prHead} and sends no new review turn; restart role=reviewer fresh or route role=reviewer with now replaces it deliberately.` };
    }
    if(identity.kind==='valid'){
      const freshOnly=plainHandoverFreshRestart(task,runs);
      if(freshOnly)return {available:true,args:{},note:`Nucleus observes the retained reader: a live turn is preserved; an idle reader cannot be silently replaced. ${freshOnly}`};
    }
    // Spec 057 (task 553): on a responsible task the move keeps the retained
    // reviewer for the delta review at the new head unless fresh is asked for
    // or the retained reviewer is closed or unavailable, so the one-reviewer
    // rule holds by default. `next` names which reviewer the move will use.
    const reviewGate = liveGate("review", true);
    if (!reviewGate.available) return reviewGate;
    if (task.resolution.reviewerAgentId) {
      const retainedId = task.resolution.reviewerAgentId;
      const lastReviewer = [...runs].reverse().find(run => run.role === 'reviewer' && run.agentId === retainedId);
      const closed = Boolean(lastReviewer?.retainedAgentClosedAt || lastReviewer?.reviewBudgetExhaustedAt);
      const profile = task.resolution.reviewerProfile;
      const entry = profile ? facts.store.pool().find(item => item.profileId === profile.id) : null;
      let unavailable: string | null = null;
      if (!profile) unavailable = 'its recorded profile is missing';
      else if (!entry?.enabled) unavailable = `pool profile ${profile.name || profile.id} is disabled`;
      else {
        try {
          const availability = facts.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get(entry.group) as { data?: unknown } | undefined;
          if (availability && groupIsUnavailable(JSON.parse(String(availability.data)))) unavailable = `subscription group ${entry.group} is unavailable`;
        } catch { /* an unreadable availability row is not proof of unavailability */ }
      }
      if (!unavailable) {
        const authors = new Set([task.agentId, ...(task.retiredWorkers ?? []).map(worker => worker.agentId),
          ...runs.filter(run => run.role === 'revision' && run.agentId).map(run => run.agentId!)].filter((id): id is string => Boolean(id)));
        if (authors.has(retainedId)) unavailable = 'it authored task work since';
      }
      const keep = keepRetainedReviewer(false, closed, Boolean(unavailable));
      const reviewerNote = closed
        ? `Move to review starts a fresh reviewer: the retained reviewer ${retainedId} cannot continue (its agent was observed closed or its checkpoint budget is spent).`
        : !keep
          ? `Move to review starts a fresh reviewer: the retained reviewer ${retainedId} is unavailable (${unavailable}).`
          : `Move to review continues the retained reviewer ${retainedId} at the new head; add fresh: true to start a fresh reviewer instead.`;
      return { available: true, args: {}, note: [reviewerNote, reviewGate.note].filter(Boolean).join(' ') };
    }
    return reviewGate;
  })();
  const ordinaryMergeReady = readyReviewAtHead(task);
  const merge = ((): OwnerVerbApplicability => {
    const shared = gate("merge"); if (shared) return shared;
    const running = liveGate("merge"); if (!running.available) return running;
    // The ordinary gate stays exact-head `ready_to_merge`. Qualified owner
    // acceptance (2026-10-17) and explicit operator source acceptance
    // (2026-10-20) are the additional exact-head dispositions, under the same
    // shared eligibility rule the applied control re-checks.
    if (ordinaryMergeReady) return running;
    return qualifiedAcceptanceEligibility(task, runs);
  })();
  const mergeFill = ordinaryMergeReady || !merge.available ? ["reason"] : ["reason", "qualification"];
  // Task 408: a queued review-entry task that never dispatched is the one
  // unfinished shape whose own PR can merge before any reviewer existed. The
  // store-only fact is the one the dependency correction reads; the applied
  // move still proves the merge, the descendant heads, the
  // accepting authority and fresh inactivity.
  const neverDispatchedReviewEntry = task.phase === "queued" && Boolean(task.reviewEntry) && facts.store.reviewEntryUnrunBeforeFirstRun(task);
  const closeout = ((): (OwnerVerbApplicability & { note?: string }) => {
    const shared = gate("closeout"); if (shared) return shared;
    if ((!neverDispatchedReviewEntry && ["queued", "dispatching"].includes(task.phase)) || !prIdentity(task))
      return { available: false, refusal: "Moving to closeout requires a dispatched task with a PR" };
    if (neverDispatchedReviewEntry)
      return { available: true, args: {},
        note: "This task never dispatched and its PR merged outside Nucleus: no reviewer, review, verification or proof exists at the merged head, and the merge is an observed fact, never acceptance. move closeout observes the merged head, branch and merge commit at the forge, proves the merged head descends from the intake and recorded source heads, and records your explicit operator source acceptance (qualification) of that exact head with the missing evidence; without it the task stays held." };
    if (live && ["intent", "uncertain"].includes(live.status))
      return { available: false, refusal: `Run ${live.id} delivery is unknown; reconcile it before accepting the external merge` };
    const fence=durableRunFence(facts);
    const effects=blockingRecoveryEffectsRefusal(facts.store,task,{noticeKinds:'all'});
    const descendantRefusal=[fence,effects].filter((refusal):refusal is string=>Boolean(refusal)).join('; ')||null;
    return { available: true, args: {}, note: `Nucleus freshly observes the retained participants before accepting the external merge. A merge at the recorded head needs only the reason. A PR merged at a descendant final head, while the original checkout remains at the recorded source, needs qualification and that exact final head together: Nucleus proves both at the forge and records operator source acceptance separately. The head is never inferred from the recorded head. Activity, permissions, unknown tools or effects, and an unobservable or changed source refuse it.${descendantRefusal?` Descendant acceptance currently refuses: ${descendantRefusal}`:''}` };
  })();
  return [
    view("work", work, ["reason", "instruction"]),
    view("review", review, ["reason"]),
    ...(!review.available && freshReview.length ? [view("review", freshReview[0]!, ["reason"])] : []),
    view("merge", merge, mergeFill),
    // A never-dispatched review-entry closeout always needs its acceptance; a
    // dispatched one offers the descendant pair, and the ordinary reason-only
    // closeout stays available beside it.
    view("closeout", closeout, neverDispatchedReviewEntry ? ["reason", "qualification"] : ["reason"],
      neverDispatchedReviewEntry ? [] : ["qualification", "head"]),
  ];
}

/**
 * `move` (Spec 050): send the task to one step. Every identity is derived from
 * the task's recorded facts; the owner names the target and a reason. The
 * engine performs the phase checks and the bookkeeping in the task-control
 * transaction.
 */
export const move: OwnerVerb = {
  verb: "move",
  action: "move",
  input: verbInput({
    to: z.enum(moveTargets),
    reason: z.string().trim().min(1).max(4000),
    instruction: z.string().trim().min(1).max(12000).optional(),
    prNumber: z.number().int().positive().optional(),
    fresh: z.boolean().optional(),
    force: z.boolean().optional(),
  }),
  applicable: facts => {
    const available = moveViews(facts).find(entry => entry.available && entry.args);
    return available?.args
      ? { available: true, args: available.args as Record<string, unknown> }
      : { available: false, refusal: "No move target applies to this task now" };
  },
  apply: (call, args) => call(taskControlInputSchema.parse({ action: "move", ...args }) as TaskControlInput),
  views: moveViews,
};

