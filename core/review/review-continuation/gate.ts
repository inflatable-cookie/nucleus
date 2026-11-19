/**
 * The reviewer-continuation gate's local refusal order. One owner for the checks
 * the gate, `next` and the owner verbs read before any turn is sent.
 */
import { holdsOf, isDispositionActive, isDispositionComplete, type ReviewCheckpointRecord, type Run, type Task } from "../../../shared/contracts";
import { briefDigest, currentBrief } from "../../planning/brief";
import { dispatchBlocked } from "../../dispatch/capacity";
import { OWNER_STOP_HOLD_PREFIX } from "../../merge/merge-hold";
import { blockingTaskOperations } from "../../recovery/recovery-effects";
import type { Store } from "../../store/store";
import { stoppedDeliveryResume } from "./delivery";
import { REVIEW_AGENT_CLOSED, REVIEW_BUDGET_EXHAUSTED, REVIEW_READER_EXHAUSTED, reviewerCannotFinish } from "./reader";
import { reviewResultFencesRun } from "./result-fence";

/**
 * The reviewer-continuation gate's locally observable checks, shared by the
 * gate and `next`, so the view never advertises a continuation the gate
 * refuses. Execution adds the version check, checkpoint provenance (through
 * `provenance`) and reviewer-profile independence. Returns the first refusal
 * in the gate's own order, or the latest checkpoint and current brief.
 */
export function reviewContinuationLocalRefusal(store: Store, task: Task, run: Run | null, input: { runId: string; head: string; checkpointOrdinal: number },
  options: { settling?: { runIds: string[] }; paused: boolean; operationId?: string; provenance?: (task: Task, record: ReviewCheckpointRecord) => void; ownerStopYields?: boolean }):
  { refusal: string } | { record: ReviewCheckpointRecord; briefVersion: ReturnType<typeof currentBrief>; resumeStop?: { eventId: number; at: string } } {
  const refuse = (refusal: string) => ({ refusal });
  // Round 4: the owner's own stop hold yields to the owner's own restart.
  const stopHoldYields = options.ownerStopYields === true && Boolean(holdsOf(task).dispatch?.reason.startsWith(OWNER_STOP_HOLD_PREFIX));
  if (task.phase !== 'reviewing' || isDispositionActive(task) || isDispositionComplete(task) || (dispatchBlocked(task) && !stopHoldYields))
    return refuse('Reviewer continuation requires an ordinary reviewing task without pause, dispatch or disposition fences');
  // A recorded creation-delivery outcome can stay `uncertain` after the bound
  // reader demonstrably started: the authenticated checkpoint read below is that
  // same run's own callback, so it proves the creation occurrence reached this
  // exact reader. The continuation authorized here is a *distinct, later*
  // occurrence, never a replay of the creation. An uncertain run with no
  // authenticated checkpoint still sends nothing: its creation is unknown, not
  // absent (Spec 017).
  const knownCreation = run?.status === 'running' || (run?.status === 'uncertain' && (run.reviewCheckpoints?.length ?? 0) > 0);
  if (task.resolution.currentRunId !== input.runId || !run || run.taskId !== task.id || run.role !== 'reviewer' || !knownCreation || run.released || run.completion)
    return refuse('The current reviewer run is completed, released, replaced or unavailable');
  // Both established causes of an impossible retained-agent continuation use the
  // same existing recovery: a fresh reviewer at the same exact head. Refuse the
  // same-run continuation itself, whatever the live observation would say.
  if (run.reviewBudgetExhaustedAt) return refuse(reviewerCannotFinish(run) ? REVIEW_READER_EXHAUSTED : REVIEW_BUDGET_EXHAUSTED);
  if (run.retainedAgentClosedAt) return refuse(REVIEW_AGENT_CLOSED);
  if (reviewResultFencesRun(store, task, run)) return refuse('A reviewer result already exists; checkpoints cannot authorize another review turn');
  // A reader is bound to its own recorded run workspace, which the pre-send
  // observation then proves is still the agent's workspace. A task-workspace
  // substitution is never read into that binding.
  const boundWorkspace = run.workspaceId;
  if (!task.workspaceId || !task.directory || !run.agentId || !boundWorkspace || run.workspaceId !== boundWorkspace || task.resolution.reviewerAgentId !== run.agentId)
    return refuse('Original reviewer agent/workspace identity changed');
  if (!task.prUrl || !task.prHead || task.prHead !== run.head || input.head !== run.head)
    return refuse('Reviewer continuation must remain on the exact recorded PR head');
  // With a settlement armed, the episode fences it will retire (attention,
  // recovery, incident) do not refuse here: the calling verb settles them in
  // the same transaction as its action, so a refused action changes nothing.
  // A stalled-turn stop is not settled by that helper and still fences.
  if (task.resolution.attention || task.resolution.recoveryActive || task.resolution.recovery && task.resolution.recovery.status !== 'resolved' ||
      task.resolution.incident && task.resolution.incident.status !== 'resolved') {
    if (!options.settling) return refuse('An unresolved task incident or recovery fence blocks reviewer continuation');
  }
  if (task.resolution.stalledTurnStop && task.resolution.stalledTurnStop.status !== 'completed')
    return refuse('An unresolved task incident or recovery fence blocks reviewer continuation');
  const settledRuns = options.settling?.runIds ?? [];
  const fencing = store.runs(task.id).filter(item => !item.released && !settledRuns.includes(item.id));
  if (fencing.length !== 1 || fencing[0]!.id !== run.id) return refuse('Another unreleased run or changed run identity fences reviewer continuation');
  const checkpoints = run.reviewCheckpoints ?? [];
  const record = checkpoints.at(-1);
  if (!record || record.ordinal !== input.checkpointOrdinal || record.ordinal !== checkpoints.length || record.runId !== run.id || record.head !== input.head)
    return refuse('The requested checkpoint is stale; only the latest authenticated checkpoint can be continued');
  // A checkpoint whose continuation was already delivered has had its turn: the
  // same intent only replays the recorded delivery and a changed one is refused,
  // so re-sending is never an available action. Name the real exits instead of
  // advertising a continuation nothing can send (review 5668722168 follow-up;
  // project-c #155 checkpoint 3 at 889a6d0).
  //
  // Tom, 2026-10-27: one positively confirmed OWNER STOP of that delivered turn
  // authorizes one new continuation effect on the same reader. The evidence is
  // the individual immutable stop occurrence, never an idle observation and
  // never a `move`/`route` displacement, and the delivery identity carries its
  // event id so a replay reconciles the same effect instead of sending again.
  const delivered = (run.reviewDeliveries ?? []).findLast(item => item.checkpointOrdinal === record.ordinal
    && (item.head ?? run.head) === run.head && item.status === 'delivered');
  let resumeStop: { eventId: number; at: string } | undefined;
  if (delivered) {
    const stopped = stoppedDeliveryResume(store, task, run, delivered);
    if (stopped.kind === 'refused') return refuse(stopped.reason);
    if (stopped.kind === 'none')
      return refuse(`Checkpoint ${record.ordinal} on run ${run.id} already has its delivered continuation (${delivered.deliveryId}); no second turn is sent for it. If it is still reading, wait for its verdict or next checkpoint. If that turn stopped without a verdict, an owner stop of it is what authorizes one resumed continuation on the same reader; route role=reviewer with now replaces the reviewer deliberately, and restart role=reviewer fresh starts a fresh reader at the same head (move to=review preserves the reader it can continue, so it sends nothing here)`);
    resumeStop = { eventId: stopped.eventId, at: stopped.at };
  }
  options.provenance?.(task, record);
  if (run.reviewContinuation && run.reviewContinuation.status !== 'delivered') return refuse('A legacy continuation intent is retained; it cannot authorize a new reviewer delivery');
  // A stale external-merge pre-attention record is part of the fence set the
  // settling verb retires in its own transaction (Spec 050), so an armed
  // settlement tolerates it here; every other merge, publication and
  // validation intent still refuses.
  const externalMergePreAttention = options.settling ? null : task.resolution.externalMergePreAttention;
  if (task.resolution.mergeIntent || task.resolution.mergeHead || task.resolution.mergedCommit || task.resolution.externalMerge || externalMergePreAttention || task.resolution.integrationTurn ||
      task.resolution.mergeResponseOutcome === 'uncertain' || task.resolution.mergeRetryOutcome === 'uncertain' ||
      task.resolution.projectValidation && task.resolution.projectValidation.state !== 'passed' || task.resolution.pendingRevisionCause === 'continuation' ||
      store.getMeta(`reviewPublication:${run.id}`))
    return refuse('Merge, publication or validation intent blocks reviewer continuation');
  const unsettledOperations = blockingTaskOperations(store, task, { excludeId: options.operationId });
  if (unsettledOperations.length) return refuse('Another unresolved task operation fences reviewer continuation');
  if (store.hookEvents(task.id).some(hook => !['result', 'published'].includes(hook.state) || hook.result?.outcome !== 'ok'))
    return refuse('An unresolved repository effect fences reviewer continuation');
  // A brief amended after the checkpoint does not strand the reviewer (Tom,
  // 2026-10-18): the continuation delivers the current brief and re-pins the
  // run to it, so the eventual verdict is bound to the brief it read. An
  // amendment always adds a version; the same version with other text is not one.
  const briefVersion = currentBrief(task), pinned = record.briefVersion ?? null;
  const unchanged = pinned === (briefVersion?.version ?? null) && (record.briefDigest ?? null) === (briefVersion ? briefDigest(briefVersion.text) : null);
  const amended = pinned !== null && briefVersion !== null && briefVersion.version > pinned;
  if (!unchanged && !amended) return refuse('The Nucleus-held brief changed without an amendment after this reviewer checkpoint');
  // Tom, 2026-10-27: continuing an amended brief is the ordinary
  // awaiting-checkpoint authority, and it cannot stretch across a stop. A
  // stop-backed resume is a new effect on a turn that already read one brief, so
  // it is bound to *that delivery's* brief: a further amendment would deliver
  // text the stopped turn never read and silently change the work the owner
  // authorized. The deliberate exit is the fresh reviewer.
  if (resumeStop) {
    const deliveryBrief = delivered!.briefVersion ?? null;
    const deliveryDigest = delivered!.briefDigest ?? null;
    const currentVersion = briefVersion?.version ?? null;
    const currentDigest = briefVersion ? briefDigest(briefVersion.text) : null;
    if (deliveryBrief !== currentVersion || deliveryDigest !== currentDigest)
      return refuse(`The Nucleus-held brief changed after the delivered continuation for checkpoint ${record.ordinal} on run ${run.id} was stopped (that turn read brief ${deliveryBrief ?? 'none'}); a stop-backed resume is bound to the brief it read, so restore that brief or replace the reader with restart role=reviewer fresh`);
  }
  return { record, briefVersion, ...(resumeStop ? { resumeStop } : {}) };
}
