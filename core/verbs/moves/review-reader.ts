import { taskControlInputSchema, type Run, type Task, type TaskControlInput } from "../../../shared/contracts";
import type { Engine } from "../../engine";
import type { AgentObservation } from "../../host/adapter";
import { hostFailureRefusalDetail } from "../../host/errors";
import { REVIEW_FRESH_REPLACEMENT_EXIT, reviewContinuationState, reviewContinuationWait, reviewInProgress, reviewResultFencesRun, stoppedDeliveryResume, retainedReaderStateDecision, retainedReaderStoredRefusal, retainedReaderUnavailableRefusal } from "../../review/review-continuation";
import { plainHandoverFreshRestart, RestartRefusal } from "../owner-verbs";
import type { FinishedRuns, ReviewMoveInput, VerifiedPr } from "./types";
import { requestReviewerReport, reviewerReportRequestRefusal, unreportedReviewer } from '../reviewer-report';

/** Decide how an observed retained reader is treated, without sending a turn. */
export function retainedReaderDecision(input: {
  reader: boolean; state: ReturnType<typeof reviewContinuationState>; busy: boolean;
  status: string; waitReason: string; agentId: string | null; runId: string;
}): { kind: 'preserve' | 'continue' | 'fallthrough' } | { kind: 'refuse'; message: string } {
  const { reader, state, busy, status, waitReason, agentId, runId } = input;
  if (!reader) return { kind: busy ? 'preserve' : 'fallthrough' };
  const stored = retainedReaderStateDecision(state);
  const refusal = retainedReaderStoredRefusal(state, waitReason);
  if (refusal) return { kind: 'refuse', message: refusal };
  if (status === 'closed') return { kind: 'refuse', message: retainedReaderUnavailableRefusal() };
  if (state === 'continuing' || busy) return { kind: 'preserve' };
  if (stored === 'awaiting' && status === 'idle') return { kind: 'continue' };
  return { kind: 'refuse', message: `The retained reviewer (agent ${agentId}, run ${runId}) is ${status} with an awaiting checkpoint, so move to review cannot continue it. ${REVIEW_FRESH_REPLACEMENT_EXIT}` };
}

/**
 * Tom, 2026-10-27 ("Preserve the reader for everyone", decision 029a631e): a
 * valid reader already reviewing this exact head is preserved and continued, not
 * replaced. The state comes from the durable checkpoint and delivery records, and
 * the reader is freshly observed before either decision. Only a genuinely
 * awaiting checkpoint whose reviewer is idle continues through the ordinary
 * retained-restart path; reading, reserved, uncertain or already-delivered work
 * sends no new turn. An idle plain-handover reader without a checkpoint cannot
 * carry its view to a new run, so it requires an explicit fresh restart.
 *
 * Returns the task when the reader decided the move, or `null` when the ordinary
 * move path goes on.
 */
export async function moveRetainedReader(engine: Engine, input: ReviewMoveInput, task: Task, pr: VerifiedPr,
  finished: FinishedRuns, reading: Run, operationId?: string): Promise<Task | null> {
  const store = engine.store;
  const reader = reviewInProgress(reading) ? reading : null;
  const readerTask = store.task(input.taskId);
  const state = reader ? reviewContinuationState(readerTask, store) : null;
  const wait = reviewContinuationWait(readerTask, store);
  let observed: AgentObservation;
  try { observed = await engine.host.observe(reading.agentId!); }
  catch (error) { throw Error(`Move to review cannot observe the retained reviewer (${hostFailureRefusalDetail(error)}); restore observation before moving, and no review turn was sent`); }
  const latestTask = store.task(input.taskId);
  engine.requireOwnerControlCurrent(latestTask, input.version, 'Task changed; refresh before retrying');
  const latestReader = store.run(reading.id);
  if (!latestReader || latestReader.released || latestReader.completion || latestReader.head !== pr.head
    || latestReader.agentId !== reading.agentId || latestTask.resolution.currentRunId !== reading.id)
    throw Error('The retained reviewer changed during the move; refresh before retrying');
  // A failed, ambiguous or relocated observation never stands in for a
  // preserved reader: unknown is not absent.
  if (observed.id !== reading.agentId || observed.workspaceId !== reading.workspaceId)
    throw Error('Move to review cannot prove the retained reviewer in its workspace; no review turn was sent');
  const busy = observed.active || Boolean(observed.activeTurnId) || observed.permissions;
  const delivery = reading.reviewDeliveries?.findLast(item => item.checkpointOrdinal === reading.reviewCheckpoints?.at(-1)?.ordinal && item.status === 'delivered');
  const stoppedAfterDelivery = state === 'continuing' && reading.active === false && reading.lastObservedAt != null && delivery?.observedAt != null
    && Date.parse(reading.lastObservedAt) > Date.parse(delivery.observedAt)
    && delivery && stoppedDeliveryResume(store, latestTask, reading, delivery).kind === 'none';
  if (!busy && (!reader || stoppedAfterDelivery || state === 'exhausted' || state === 'awaiting' && reviewResultFencesRun(store, latestTask, reading))
    && unreportedReviewer(latestTask, store.runs(task.id))?.id === reading.id) {
    const wait = engine.dispatchWaitsFor(latestTask, engine.isOwnerCall(), true);
    if (wait) return engine.deferOwnerVerb(latestTask, taskControlInputSchema.parse({ ...input, action: 'move', to: 'review' }), wait, { runId: reading.id, head: reading.head });
    return requestReviewerReport(engine, latestTask, reading, input.version, input.reason);
  }
  if (state === 'exhausted' && busy && reader) {
    const refusal = reviewerReportRequestRefusal(reading, store.eventsAll(task.id));
    if (refusal) throw new RestartRefusal(refusal);
    return engine.preserveRetainedReviewer(input, readerTask, reader, pr, finished, state);
  }
  const decision = retainedReaderDecision({ reader: Boolean(reader), state, busy: Boolean(busy), status: observed.status,
    waitReason: wait.reason, agentId: reading.agentId, runId: reading.id });
  if (decision.kind === 'refuse') throw Error(decision.message);
  if (decision.kind === 'preserve')
    return engine.preserveRetainedReviewer(input, readerTask, reader ?? reading, pr, finished, reader ? state ?? 'reading' : 'reading');
  if (decision.kind === 'continue')
    return engine.continueRetainedReviewer(readerTask, {
      version: input.version, reason: input.reason,
      instruction: 'Continue the existing task under its current approved instruction source and within its approved scope.',
      ownerStopYields: engine.isOwnerCall(), verb: 'move',
      deferrable: taskControlInputSchema.parse({ taskId: input.taskId, version: task.version, action: 'move', to: 'review', reason: input.reason,
        ...(input.caller ? { caller: input.caller } : {}), ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}) }) as TaskControlInput,
    }, operationId);
  const refusal = plainHandoverFreshRestart(latestTask, store.runs(input.taskId));
  if (refusal) throw new RestartRefusal(`Move to review preserves the retained reader. ${refusal}`);
  return null;
}
