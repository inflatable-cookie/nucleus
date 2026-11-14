import { REMOVED_TASK_REFUSAL } from "./control-refusals";
import { workerStepLabel } from "../../shared/demand";
import { holdOwnerOf } from "../../shared/contracts";
import { holdsOf, taskNextVerbSchema, taskVisibleReason, REVISION_BUDGET, WORKER_REPLACEMENT_CEILING, type Run, type Task, type TaskNext, type TaskNextReviewOutcome, type TaskNextVerb } from "../../shared/contracts";
import { isAcceptedReview } from "../recovery/task-reasons";
import { latestAuthorResult, ownerTaskBudget, retainedCheckpointRun, ownerActiveRun, ownerTaskStop } from './owner-facts';
import type { OwnerVerbFacts } from './owner-facts';
import { DEFAULT_STALL_THRESHOLD_MINUTES } from '../../shared/schema/settings';
import { taskStopVerbs } from '../../shared/task-stop';

/** One reviewer run's own recorded verdict with the publication evidence it carries. */
type RecordedVerdict = {
  status: 'ready_to_merge' | 'changes_required'; head: string | null; runId: string; eventId: string;
  reviewerAgentId: string | null; reviewId: number | null; published: boolean; summary: string | null;
};

const recordedVerdict = (task: Task, run: Run): RecordedVerdict | null => {
  const result = run.completion;
  if (!result || run.role !== 'reviewer' || !isAcceptedReview(result)) return null;
  if (result.taskId !== task.id || result.runId !== run.id) return null;
  const reviewId = result.reviewId ?? result.reviewCommentId ?? null;
  return {
    status: result.status as 'ready_to_merge' | 'changes_required', head: result.head ?? run.head ?? null,
    runId: run.id, eventId: result.eventId, reviewerAgentId: run.agentId ?? null, reviewId,
    published: reviewId !== null, summary: result.summary ?? null,
  };
};

const headLabel = (head: string | null): string => head ? head.slice(0, 12) : 'no recorded head';

/**
 * Papercut 8fffbf59: the newest retained-reviewer swap with the condition that
 * failed (round, participant, runtime, context or error). The same reason is on
 * the swap event; an older prose-only event carries no condition and reads null.
 */
function reviewerSwapView(facts: OwnerVerbFacts): TaskNext['reviewerSwap'] {
  const event = facts.events.findLast(item => item.kind === 'reviewer_fresh_agent' && item.detail.startsWith('{'));
  if (!event) return null;
  try {
    const detail = JSON.parse(event.detail) as { fromAgentId?: unknown; condition?: unknown; detail?: unknown; head?: unknown; at?: unknown };
    if (detail.condition !== 'round' && detail.condition !== 'participant' && detail.condition !== 'runtime'
      && detail.condition !== 'context' && detail.condition !== 'error') return null;
    return {
      fromAgentId: typeof detail.fromAgentId === 'string' ? detail.fromAgentId : null,
      condition: detail.condition,
      detail: typeof detail.detail === 'string' ? detail.detail : '',
      head: typeof detail.head === 'string' ? detail.head : null,
      at: typeof detail.at === 'string' ? detail.at : event.at,
    };
  } catch { return null; }
}

/**
 * The task's current review outcome, its exact source and the decision still
 * outstanding (Queue #477). One derivation from the task's own records, shared
 * by `task.next`, the recovery launch snapshot and an authenticated refresh, so
 * a coordinator reads the same truth from its launch context and its `next`
 * refresh:
 *
 * - `accepted` is the newest verdict Queue applied, proved by that run's own
 *   `review_result_applied` or `review_reapplied` event. A later deliberate transition (a fresh-review
 *   move, an author return, a revision resume) clears the task row's current
 *   accepted slot while the applied history stays: `superseded` says so, and
 *   the verdict then grants no merge authority. A verdict at an earlier head is
 *   history for a changed source and never qualifies it.
 * - `reported` is a reviewer result recorded on a run that was never applied and
 *   that comes after the latest applied verdict — published evidence or an
 *   unpublished report, never the accepted verdict. An earlier applied verdict
 *   is application history, not a pending report.
 * - `reader` is the reviewer run actually holding the current head with no
 *   verdict yet, with retained checkpoint work kept separate from any verdict.
 * - `revision` is the author revision allowance the decision is bounded by. An
 *   exhausted allowance is the owner's disposition, never evidence that another
 *   review is required.
 * - `decision` states what is still outstanding in plain words.
 *
 * The outcome is observation: it grants no review, merge or execution authority.
 */
function currentReviewOutcome(facts: OwnerVerbFacts): TaskNextReviewOutcome {
  const { task, runs, events } = facts;
  const head = task.prHead ?? null;
  // Task 576: the cap counts review rounds, not author returns. While an
  // owner-approved round is still open (an author revision started after the
  // latest cap park), the count is not a fresh owner gate: a worker stopping
  // inside that round is ordinary recovery, and only the next new
  // changes_required parks at the cap again. This is the read-side twin of the
  // engine's parkedAtCap gate, so coordinators and planners are not misled.
  const capAt = events.filter(event => event.kind === 'revision_budget_exhausted').at(-1)?.at;
  const approvedRoundOpen = Boolean(capAt) && runs.some(run => run.role === 'revision' && run.createdAt > capAt!);
  const revision = { runs: task.resolution.revisionRuns, budget: REVISION_BUDGET, exhausted: task.resolution.revisionRuns >= REVISION_BUDGET && !approvedRoundOpen };
  // Every durable application, newest event first: the event is what makes a
  // recorded reviewer result the applied verdict, and it survives the task row's
  // current accepted slot being cleared by a later deliberate transition
  // (Queue #477 review 5675125757, finding 1).
  const applicationEvent = new Map<string, number>();
  for (const event of events) {
    if (!['review_result_applied', 'review_reapplied'].includes(event.kind)) continue;
    const seen = applicationEvent.get(event.detail);
    if (seen === undefined || event.id > seen) applicationEvent.set(event.detail, event.id);
  }
  const verdicts = runs.map((run, index) => ({ index, verdict: recordedVerdict(task, run) }))
    .filter((entry): entry is { index: number; verdict: RecordedVerdict } => entry.verdict !== null);
  const applied = verdicts.filter(entry => applicationEvent.has(entry.verdict.runId))
    .sort((a, b) => applicationEvent.get(b.verdict.runId)! - applicationEvent.get(a.verdict.runId)!);
  const appliedNewest = applied[0] ?? null;
  const appliedIds = new Set(applied.map(entry => entry.verdict.runId));
  const latestAppliedIndex = applied.reduce((latest, entry) => Math.max(latest, entry.index), -1);
  // The author's latest recorded result, and whether it is later than the newest
  // applied verdict (or there is none): a same-head author return makes the
  // applied findings history and puts that result's review in front of the owner
  // (Queue #477 review 5675206214, finding 1).
  const latestAuthor = latestAuthorResult(task, runs);
  const authorResultRun = latestAuthor?.runId ? runs.findIndex(run => run.id === latestAuthor.runId) : -1;
  const authorResult: TaskNextReviewOutcome['authorResult'] = latestAuthor ? {
    runId: latestAuthor.runId ?? null, status: latestAuthor.status,
    head: latestAuthor.head ?? null,
    currentHead: Boolean(head && latestAuthor.head === head),
    afterApplied: appliedNewest === null || authorResultRun > latestAppliedIndex,
    eventId: latestAuthor.eventId, summary: latestAuthor.summary ?? null,
  } : null;
  const accepted: TaskNextReviewOutcome['accepted'] = appliedNewest ? {
    status: appliedNewest.verdict.status, head: appliedNewest.verdict.head,
    currentHead: Boolean(head && appliedNewest.verdict.head === head),
    // The task row's current accepted slot no longer holds this verdict: it is
    // applied history, observation rather than merge authority.
    superseded: task.resolution.review?.runId !== appliedNewest.verdict.runId,
    runId: appliedNewest.verdict.runId, eventId: appliedNewest.verdict.eventId,
    reviewerAgentId: appliedNewest.verdict.reviewerAgentId, reviewId: appliedNewest.verdict.reviewId,
    published: appliedNewest.verdict.published, summary: appliedNewest.verdict.summary,
  } : null;
  // A pending report is never one of the applied verdicts and comes after the
  // latest of them; earlier applied verdicts are history (finding 2).
  const reportedVerdict = head ? verdicts.findLast(entry => entry.verdict.head === head
    && entry.index > latestAppliedIndex && !appliedIds.has(entry.verdict.runId))?.verdict : undefined;
  const reported: TaskNextReviewOutcome['reported'] = reportedVerdict ? {
    status: reportedVerdict.status, head: reportedVerdict.head, runId: reportedVerdict.runId, eventId: reportedVerdict.eventId,
    reviewerAgentId: reportedVerdict.reviewerAgentId, published: reportedVerdict.published, summary: reportedVerdict.summary,
  } : null;
  const impedimentEntries = runs.map((run, index) => ({ run, index })).filter(({ run }) =>
    run.role === 'reviewer' && run.completion?.taskId === task.id && run.completion.runId === run.id
    && (run.completion.status === 'blocked' || run.completion.status === 'error'));
  const impedimentEntry = impedimentEntries.at(-1);
  const impediments: TaskNextReviewOutcome['impediments'] = impedimentEntries.map(({ run }) => ({
    status: run.completion!.status as 'blocked' | 'error', head: run.completion!.head ?? run.head ?? null,
    currentHead: Boolean(head && (run.completion!.head ?? run.head) === head), runId: run.id,
    eventId: run.completion!.eventId, responsibility: run.completion!.reviewResponsibility ?? null,
    summary: run.completion!.summary, reviewText: run.completion!.reviewText ?? null,
    retained: events.some(event => event.kind === 'blocked_review_evidence' && event.detail === run.id),
    current: task.resolution.review?.eventId === run.completion!.eventId && task.resolution.review?.runId === run.id,
  }));
  const impediment = impediments.at(-1) ?? null;
  // The reader is the unfinished reviewer holding the current head: the recorded
  // current run, else the retained checkpoint reviewer. One that belongs to
  // another source head is not reading the current one.
  const current = task.resolution.currentRunId ? runs.find(run => run.id === task.resolution.currentRunId) : undefined;
  const readingRun = current && current.role === 'reviewer' && !current.released && !current.completion
    ? current : retainedCheckpointRun(runs) ?? null;
  const reader: TaskNextReviewOutcome['reader'] = readingRun && (!head || readingRun.head === head) ? {
    runId: readingRun.id, agentId: readingRun.agentId ?? null, head: readingRun.head ?? null,
    checkpoint: readingRun.reviewCheckpoints?.at(-1)?.ordinal ?? null,
  } : null;
  const readerText = (run: NonNullable<TaskNextReviewOutcome['reader']>) => `${run.checkpoint
    ? `Reviewer run ${run.runId}${run.agentId ? ` (agent ${run.agentId})` : ''} holds checkpoint ${run.checkpoint} at ${headLabel(run.head)}`
    : `Reviewer run ${run.runId}${run.agentId ? ` (agent ${run.agentId})` : ''} is the current reader at ${headLabel(run.head)}`}`;
  const reading = reader ? `${readerText(reader)} with no verdict yet; that verdict is the outstanding decision.` : '';
  // A same-head author return after the applied findings: the author already
  // came back, so another author revision is not the outstanding decision.
  const laterAuthor = authorResult && authorResult.afterApplied && authorResult.currentHead && authorResult.status === 'ready_for_review' ? authorResult : null;
  // The outstanding decision is ONE fact from the current lifecycle, with the
  // applied findings and the allowance kept as evidence behind it. A newer
  // reviewer result awaiting publication/application, or the reader actually
  // holding the head, outranks the applied verdict it came after; a live author
  // revision is work in progress, not another request to return the author.
  const runIndex = new Map(runs.map((run, index) => [run.id, index]));
  const acceptedIndex = appliedNewest ? appliedNewest.index : -1;
  const readerIndex = reader ? runIndex.get(reader.runId) ?? -1 : -1;
  const reportedIndex = reported ? runIndex.get(reported.runId) ?? -1 : -1;
  // A reader older than the applied verdict it predates does not override that
  // verdict; a newer one does (a deliberate fresh review, or the reader of a
  // later author result).
  const liveRevision = runs.findLast(run => run.role === 'revision' && !run.released && !run.completion) ?? null;
  const laterWorkIndex = Math.max(laterAuthor ? authorResultRun : -1, liveRevision ? runIndex.get(liveRevision.id) ?? -1 : -1);
  const currentReader = reader && readerIndex > acceptedIndex && readerIndex > laterWorkIndex ? reader : null;
  const currentReported = reported && reportedIndex > laterWorkIndex ? reported : null;
  const newestReviewer: 'reported' | 'reader' | null = currentReported && currentReader
    ? (reportedIndex >= readerIndex ? 'reported' : 'reader') : currentReported ? 'reported' : currentReader ? 'reader' : null;
  const impedimentIndex = impedimentEntry?.index ?? -1;
  const outstandingImpediment = impediment?.currentHead && impedimentIndex > acceptedIndex
    && impedimentIndex > reportedIndex && impedimentIndex > readerIndex && impedimentIndex > authorResultRun
    && (!liveRevision || (runIndex.get(liveRevision.id) ?? -1) < impedimentIndex) ? impediment : null;
  const appliedHistory = accepted ? ` The applied ${accepted.status} findings ${accepted.currentHead
    ? `at the current head ${headLabel(accepted.head)} remain recorded evidence`
    : `at ${headLabel(accepted.head)} are history and cannot qualify the current head`}.` : '';
  const allowanceHistory = revision.exhausted ? ` The automatic author revision allowance is exhausted (${revision.runs} of ${revision.budget}).` : '';
  const decision = ((): string => {
    if (task.resolution.mergedCommit) return `The PR is merged at ${headLabel(task.resolution.mergedCommit)}; no review decision is outstanding.`;
    if (['done', 'cancelled'].includes(task.phase)) return `The task is ${task.phase}; no review decision is outstanding.`;
    if (task.skipPRReview) return 'Independent review is skipped at submission; the outstanding decision is the guarded merge.';
    if (outstandingImpediment)
      return `Reviewer run ${outstandingImpediment.runId} completed ${outstandingImpediment.status} at ${headLabel(outstandingImpediment.head)} (${outstandingImpediment.responsibility ?? 'responsibility not recorded'}). This is recorded impediment evidence, not an approval or applied verdict; its disposition belongs to the responsible owner or ordinary environment recovery, not another review by itself. Report: ${outstandingImpediment.summary}`;
    // A recorded reviewer result awaiting publication and application is the
    // newest review fact; the applied verdict it came after cannot override it.
    if (newestReviewer === 'reported' && reported)
      return `A reviewer reported ${reported.status} on run ${reported.runId} at ${headLabel(reported.head)} ${reported.published ? 'and published it' : 'with no published review evidence'}; Nucleus has not applied it, so the outstanding decision is that result's ordinary publication and application, not an earlier applied verdict; a report is never the accepted verdict.${reader ? ` The older reader run ${reader.runId} has not reported and does not override that result.` : ''}${appliedHistory}`;
    // The reader actually holding the head is the outstanding review, whether a
    // deliberate fresh review or an ordinary one.
    if (newestReviewer === 'reader' && reader) {
      if (accepted?.currentHead && accepted.status === 'changes_required' && accepted.superseded) {
        const allowance = revision.exhausted
          ? ` The exhausted author revision allowance (${revision.runs} of ${revision.budget}) and these findings remain the project planner's disposition through the blocker ladder (Spec 058): the escalation is open and its answer applies through the ordinary verbs.`
          : ' These findings remain the author-revision evidence if that review returns changes_required.';
        return `The applied changes_required verdict at the current head ${headLabel(head)} is history: a fresh review of the same unchanged head is in progress and ${readerText(reader)} with no verdict yet, so the outstanding decision is that reader's verdict, not another author return or another review.${allowance}${reported ? ` A reviewer report on run ${reported.runId} (${reported.status}) is recorded but not applied; this newer reader holds the decision.` : ''}`;
      }
      const stale = reported ? ` A reviewer report on run ${reported.runId} (${reported.status}) is recorded but not applied; this newer reader holds the decision.` : '';
      return `${reading}${appliedHistory}${stale}`;
    }
    // The author already returned at this head: its result is what review follows.
    if (laterAuthor)
      return `The author returned ready_for_review at the current head ${headLabel(head)} (run ${laterAuthor.runId ?? 'no run'}, event ${laterAuthor.eventId}); the outstanding decision is that author result's independent review, not another author return.${appliedHistory}`;
    // A live author revision is work in progress, never a request to return the author again.
    if (liveRevision)
      return `The author revision run ${liveRevision.id}${liveRevision.agentId ? ` (agent ${liveRevision.agentId})` : ''} is in progress at ${headLabel(liveRevision.head)}; its result is the outstanding work, not another request to return the author.${appliedHistory}`;
    if (accepted?.currentHead) {
      if (accepted.superseded) {
        // The owner already returned the author and its revision is not running
        // yet: that return is the outstanding work, not another one.
        if (task.phase === 'changes_requested' && accepted.status === 'changes_required')
          return `The author revision is the outstanding work at the current head ${headLabel(head)}; its result is what review follows, not another request to return the author.${appliedHistory}`;
        // A deliberate fresh review whose reader is not allocated yet stays review.
        if (accepted.status === 'ready_to_merge')
          return `The applied ready_to_merge verdict at the current head ${headLabel(head)} is recorded history: the task row no longer holds it as the current accepted review, so it grants no merge authority; the outstanding decision is the independent review of the current head.${allowanceHistory}`;
        const allowance = revision.exhausted
          ? ` The exhausted author revision allowance (${revision.runs} of ${revision.budget}) and these findings remain the project planner's disposition through the blocker ladder (Spec 058): the escalation is open and its answer applies through the ordinary verbs.`
          : ' These findings remain the author-revision evidence if that review returns changes_required.';
        return `The applied changes_required verdict at the current head ${headLabel(head)} is history: a deliberate fresh review of the same unchanged head is the outstanding decision before its reader is allocated, not another author return or another review.${allowance}`;
      }
      if (accepted.status === 'ready_to_merge')
        return `The accepted review approves the current head ${headLabel(head)}; the outstanding decision is the guarded merge.`;
      if (revision.exhausted)
        return `The accepted review requires changes at the current head ${headLabel(head)}, and the automatic author revision allowance is exhausted (${revision.runs} of ${revision.budget}). The blocker ladder (Spec 058) escalates that to the project planner as a delegated decision: the task waits with the planner, and the planner's answer applies through the ordinary verbs. The owner's own verbs (move to work with these findings, or dispose of the work) still override it. Another review of the same unchanged head is not an exit.`;
      return `The accepted review requires changes at the current head ${headLabel(head)}; the outstanding decision is the author revision (move to work with these findings).`;
    }
    if (accepted)
      return `The accepted ${accepted.status} review is at ${headLabel(accepted.head)}, not the current head ${headLabel(head)}; it is history for the changed source and cannot qualify it. The outstanding decision is an independent review of the current head.`;
    if (!head) return 'No PR head is recorded; no review verdict can bind yet.';
    return `No review verdict is recorded at the current head ${headLabel(head)}; the outstanding decision is an independent review of that head.`;
  })();
  return { accepted, reported, impediment, impediments, reader, authorResult, decision, revision };
}

/** The full `task.next` read view for one task. */
export function assembleOwnerTaskNext(facts: OwnerVerbFacts, ownerVerbViews: (facts: OwnerVerbFacts) => TaskNextVerb[]): TaskNext {
  // This entry point is the shared read plan; the applied control derives the
  // same verbs with its authenticated reporting-run binding instead.
  const planned: OwnerVerbFacts = facts.planning ? facts : { ...facts, planning: true };
  const task = planned.task;
  const fences = holdsOf(task);
  const verbs = [...ownerVerbViews(planned), ...holdViews(task)];
  const stop = ownerTaskStop(facts);
  const reviewerSwap = reviewerSwapView(facts);
  const checkpointWait = stop?.reason === 'lifecycle' && Boolean(retainedCheckpointRun(facts.runs));
  const threshold = (facts.store.getMeta<number>('stallThresholdMinutes') ?? DEFAULT_STALL_THRESHOLD_MINUTES) * 60_000;
  if (stop && stop.suggestedVerbs.length === 0 && stop.kind !== 'hold'
    && (stop.owner === 'queue' || checkpointWait) && Date.now() - Date.parse(stop.since) >= threshold) {
    stop.suggestedVerbs = taskStopVerbs.filter(verb => verbs.some(view => view.verb === verb && view.available));
  }
  return {
    taskId: task.id,
    paused: facts.store.getMeta<boolean>("paused") ?? true,
    dispatchHeld: facts.store.getMeta<boolean>("dispatchHeld") ?? false,
    title: task.title,
    critical: task.critical ?? false,
    criticalReviewFallbacks: task.resolution.criticalReviewFallbacks,
    phase: task.phase,
    version: task.version,
    repository: task.repository,
    number: task.number,
    reference: task.reference,
    attention: task.resolution.attention,
    // Papercut 703b4aa3: the reason is the one the current stop supports, so a
    // budget pause the measured budget no longer shows cannot keep its text.
    reason: taskVisibleReason(task, ownerTaskBudget(facts)),
    activeRun: ownerActiveRun(facts),
    prHead: task.prHead,
    prUrl: task.prUrl,
    branch: task.branch,
    stop,
    outcome: currentReviewOutcome(facts),
    holds: {
      ...(fences.dispatch ? { dispatch: { owner: holdOwnerOf(task, fences.dispatch.owner), reason: fences.dispatch.reason, since: fences.dispatch.at } } : {}),
      ...(fences.merge ? { merge: { owner: holdOwnerOf(task, fences.merge.owner), reason: fences.merge.reason, since: fences.merge.at } } : {}),
    },
    verbs,
    // Task 645: the durable owner no-automatic-retry rule stays visible until an
    // owner control lifts it. Task detail carries the same fields on resolution.
    ...(task.resolution.noAutomaticRetry
      ? { noAutomaticRetry: true as const, noAutomaticRetryProvenance: task.resolution.noAutomaticRetryProvenance }
      : {}),
    ...(reviewerSwap ? { reviewerSwap } : {}),
    routingPolicy: facts.store.routingPolicy(task, Date.now(), facts.hostProfiles ?? []),
    ...(task.workerExclusions.length ? { workerExclusions: task.workerExclusions } : {}),
    workerDemandStep: workerStepLabel(facts.store.usageLevel(), false),
    ...(task.proofExecutionRetired ? { proofExecutionRetired: true as const } : {}),
    // Spec 050: the real retirement count and ceiling, from the same store
    // reads the recovery pass and applying controls use. Observation only.
    ...(task.retiredWorkers.length ? { replacement: taskNextReplacementView(task) } : {}),
    ...(task.hostId ? { host: task.hostId } : {}),
    ...(task.worktreeLinks ? { worktreeLinks: task.worktreeLinks } : {}),
  };
}

/** The retirement count and the fixed per-task replacement ceiling. */
function taskNextReplacementView(task: Task): NonNullable<TaskNext["replacement"]> {
  return {
    retirements: task.retiredWorkers.length,
    ceiling: WORKER_REPLACEMENT_CEILING,
    ceilingReached: task.retiredWorkers.length >= WORKER_REPLACEMENT_CEILING,
  };
}

/**
 * A hold is cleared by its own control, not a verb: `next` lists release and
 * keep_hold for each fence so a held task shows the action that actually
 * clears it (lean audit 2026-10-15). The summary names the holder and its
 * condition; release only once that condition is met.
 */
function holdViews(task: Task): TaskNextVerb[] {
  const fences = holdsOf(task);
  if (task.removedAt) {
    if (!fences.dispatch && !fences.merge) return [];
    return (["release", "keep_hold"] as const).map(verb => taskNextVerbSchema.parse({ verb, action: verb, available: false, refusal: REMOVED_TASK_REFUSAL }));
  }
  // Renewing a hold applies only before the merge is requested; a release
  // always applies, so a hold never strands a merged or terminal task.
  const keepRefusal = task.resolution.mergeIntent || task.resolution.mergedCommit || ["done", "cancelled"].includes(task.phase)
    ? "Holds apply only before the merge is requested" : null;
  return (["dispatch", "merge"] as const).flatMap(kind => {
    const fence = fences[kind];
    if (!fence) return [];
    const summary = `${kind === "merge" ? "Merge" : "Dispatch"} held by ${holdOwnerOf(task, fence.owner)}: ${fence.reason}. Release only once that condition is met.`;
    const args = { taskId: task.id, version: task.version, kind, summary };
    return [
      taskNextVerbSchema.parse({ verb: "release", action: "release", available: true, args: { action: "release", ...args } }),
      keepRefusal
        ? taskNextVerbSchema.parse({ verb: "keep_hold", action: "keep_hold", available: false, refusal: keepRefusal })
        : taskNextVerbSchema.parse({ verb: "keep_hold", action: "keep_hold", available: true, args: { action: "keep_hold", ...args }, fill: ["reason"] }),
    ];
  });
}

