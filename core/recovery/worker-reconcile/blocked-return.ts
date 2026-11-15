import type { Task } from '../../../shared/contracts';
import type { Adapter } from '../../host/adapter';
import { recordResultApplied, resultApplied } from '../../intake/applied-result';
import { automaticRetryForbidden } from '../../../shared/automatic-retry';
import {
  consecutiveNonDeliveries, continuationInstruction, NON_DELIVERY_PUSHBACK, recognisedExternalWording, unfinishedContinuationEvents,
} from '../non-delivery';
import type { WorkerReconcileContext } from './context';
import { blockedReturnDecision } from './decisions';

/**
 * A blocked or error return from the initial worker: a same-thread push-back
 * recorded for this return owns it, otherwise the return is taken once — kept
 * for the planner ladder, or continued in the same retained thread.
 */

/**
 * The store records a scoped event as `<id>: <text>` in its detail. This is the
 * one reader of that scope; a caller keeps its own `event.kind` test so the
 * kind census sees the reader it pins.
 */
const scopedTo = (event: { detail: string }, id: string) => event.detail.startsWith(`${id}:`);

/**
 * Task 676 / #575: a same-thread push-back recorded for this return owns it. A pass that
 * was stalled on a read or the blocked hook when the push-back was written must not
 * overwrite changes_requested with blocked/error and start recovery.
 */
export function continuationOwnsReturn(engine: WorkerReconcileContext, taskId: string): boolean {
  const latest = engine.store.task(taskId);
  const runId = latest.completion?.runId;
  if (latest.phase !== 'changes_requested' || !runId) return false;
  return engine.store.eventsAll(taskId).some(event => ['non_delivery_pushback', 'unfinished_pushback'].includes(event.kind)
    && scopedTo(event, runId));
}

/**
 * Task 645: the owner's no-automatic-retry rule keeps the reported result for
 * the planner ladder instead of relaunching. Both push-back kinds share this
 * one transaction shape.
 */
function keepForPlanner(engine: WorkerReconcileContext, current: Task, cause: 'unfinished' | 'non_delivery', runId: string): void {
  engine.store.transaction(() => {
    const fresh = engine.store.task(current.id);
    if (fresh.completion?.eventId !== current.completion?.eventId || resultApplied(engine.store, current.id, runId)) return;
    engine.resolution.update(fresh, {}, { phase: fresh.completion!.status as 'blocked' | 'error', reason: fresh.completion!.summary });
    engine.resolution.suppressAutomaticRetry(engine.store.task(current.id), cause, fresh.completion!.summary, runId);
    recordResultApplied(engine.store, current.id, runId);
  });
}

/** Task 576/676: record one same-thread push-back and spend the return it continues. */
function recordPushback(engine: WorkerReconcileContext, current: Task, pushback: {
  cause: 'unfinished' | 'non_delivery'; instruction: string; event: string; detail: string; runId: string;
}): void {
  engine.store.transaction(() => {
    const fresh = engine.store.task(current.id);
    if (fresh.completion?.eventId !== current.completion?.eventId || resultApplied(engine.store, current.id, pushback.runId)) return;
    engine.resolution.update(fresh, { pendingRevisionCause: pushback.cause, pendingWorkerInstruction: pushback.instruction },
      { phase: 'changes_requested', reason: pushback.instruction }, pushback.event, pushback.detail);
    recordResultApplied(engine.store, current.id, pushback.runId);
  });
}

/** A blocked or error receipt: same-thread push-back, or consumed once. True ends the pass; synchronous on purpose. */
export function reconcileBlockedReturn(
  engine: WorkerReconcileContext,
  task: Task,
  current: Task,
  state: Awaited<ReturnType<Adapter["observe"]>>,
): boolean {
  const { store } = engine;
  if (!current.completion || !['blocked', 'error'].includes(current.completion.status)) return false;
  // A blocked or error receipt is consumed once the lane sits in that phase. The
  // branch-PR audit keeps visiting such lanes to discover a pushed PR (above); it
  // must not re-run the task.blocked hook and rewrite the lane on every pass.
  if (resultApplied(store, current.id, current.completion.runId)) return true;
  const events = store.eventsAll(current.id);
  const nonDeliveries = consecutiveNonDeliveries(events);
  const lastNonDelivery = nonDeliveries.at(-1);
  // Task 576: a worker unfinished return with new commits continues the same
  // round automatically, like the revision path. A return with no progress
  // falls through to the #575 non-delivery handling below.
  const unfinished = unfinishedContinuationEvents(events).find(item => item.runId === current.completion!.runId);
  // Task 676: an observed provider failure keeps its existing failover; the same-thread continuation never takes it.
  const observedProviderFailure = recognisedExternalWording(String(state.error ?? ''));
  const unfinishedForThisReturn = unfinished ? {
    unfinished: true,
    providerFailureWithoutImpediment: observedProviderFailure && unfinished.reason === 'no_impediment',
    unfinishedPushed: !(observedProviderFailure && unfinished.reason === 'no_impediment') && events.some(event => event.kind === 'unfinished_pushback' && scopedTo(event, unfinished.runId)),
    firstNonDelivery: false, nonDeliveryPushed: false,
  } : null;
  if (unfinished && unfinishedForThisReturn && blockedReturnDecision(unfinishedForThisReturn) === 'unfinished') {
    if (automaticRetryForbidden(current, store.runs(current.id))) {
      keepForPlanner(engine, current, 'unfinished', unfinished.runId);
      return true;
    }
    const instruction = continuationInstruction(unfinished);
    recordPushback(engine, current, { cause: 'unfinished', instruction, event: 'unfinished_pushback', runId: unfinished.runId,
      detail: `${unfinished.runId}: same retained worker continues the unfinished round` });
    return true;
  }
  const firstNonDelivery = Boolean(lastNonDelivery) && lastNonDelivery!.runId === current.completion.runId && nonDeliveries.length === 1;
  const nonDeliveryForThisReturn = firstNonDelivery && blockedReturnDecision({ unfinished: false, providerFailureWithoutImpediment: false, unfinishedPushed: false,
    firstNonDelivery: true, nonDeliveryPushed: events.some(event => event.kind === 'non_delivery_pushback' && scopedTo(event, lastNonDelivery!.runId)) }) === 'non_delivery';
  if (firstNonDelivery && nonDeliveryForThisReturn) {
    const runId = lastNonDelivery!.runId;
    if (automaticRetryForbidden(current, store.runs(current.id))) {
      keepForPlanner(engine, current, 'non_delivery', runId);
      return true;
    }
    recordPushback(engine, current, { cause: 'non_delivery', instruction: NON_DELIVERY_PUSHBACK, event: 'non_delivery_pushback', runId,
      detail: `${runId}: same retained worker continues` });
    return true;
  }
  if (current.phase === current.completion.status) return true;
  return continuationOwnsReturn(engine, task.id);
}
