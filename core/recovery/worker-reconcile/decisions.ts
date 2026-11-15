import { isTransientProviderError } from '../exhaustion';
import type { Adapter } from '../host/adapter';
import type { Task } from '../../../shared/contracts';

/**
 * The initial worker's pure decisions: what an observation means, how a branch
 * lookup classifies, and which return action the already-read facts select.
 * Each one takes facts and answers; none of them reads the store or the host.
 */

/** Spec 051: the visible reasons while an interactive task's worker is in its operator session. */
export const INTERACTIVE_RUNNING_REASON = "Interactive session: the worker is running";
export const INTERACTIVE_WAIT_REASON = "Interactive session: waiting for the operator in the worker's thread";

/** The statuses a worker observation may have before the pass releases its workspace. */
export const STOPPED_WORKER_STATUSES: readonly string[] = ['idle', 'error', 'closed'];

/** Classify an observed branch lookup without treating a failed read as absence. */
export function branchPrLookupOutcome(error: unknown, count: number): 'unverified' | 'ambiguous' | 'found' | 'empty' {
  if (error !== null) return 'unverified';
  if (count > 1) return 'ambiguous';
  return count === 1 ? 'found' : 'empty';
}

/** A task parked with a fault and no completion, callback or escalation is still recoverable by a live worker. */
const parkedByOutage = (task: Task) => task.phase === 'needs_attention' && !task.completion && !task.resolution.currentRunId
  && !task.resolution.attention && !task.resolution.recovery?.runId && task.resolution.recovery?.status !== 'escalated';

/** Classify an observation using the task snapshot held by the reconcile pass. */
export function classifyWorkerObservation(task: Task, state: Awaited<ReturnType<Adapter['observe']>>): 'live_recover' | 'live' | 'transient' | 'stopped' {
  if (state.active || ['running', 'initializing'].includes(state.status) || state.permissions) {
    return parkedByOutage(task) ? 'live_recover' : 'live';
  }
  const retry = task.transientProviderRetry;
  const retryForThisRun = retry?.runId === task.runId
    && (['waiting', 'intent', 'uncertain', 'exhausted'].includes(retry.status)
      || retry.status === 'sent' && isTransientProviderError(state.error));
  if (retryForThisRun) return 'transient';
  // Not live above: the worker is stopped with no retry pending on this run.
  return 'stopped';
}

/** Choose the next blocked-return action from the already-read facts. */
export function blockedReturnDecision(facts: {
  unfinished: boolean; providerFailureWithoutImpediment: boolean; unfinishedPushed: boolean;
  firstNonDelivery: boolean; nonDeliveryPushed: boolean;
}): 'unfinished' | 'non_delivery' | 'continue' {
  if (facts.unfinished && !facts.providerFailureWithoutImpediment && !facts.unfinishedPushed) return 'unfinished';
  if (facts.firstNonDelivery && !facts.nonDeliveryPushed) return 'non_delivery';
  return 'continue';
}

/**
 * True only when a task's own completion actually reported a pull request.
 *
 * A blocked or error completion is a report of a blocker, not of a PR - it may even name one in
 * its summary, as a live task did while its prUrl stayed null. Treating any completion as PR
 * identity meant the branch-PR reconciliation skipped exactly the tasks whose worker had pushed
 * a PR and then reported a blocker, so the open PR was never bound to the task that owned it.
 */
export const completionReportsPr = (task: Task) => task.completion?.status === "ready_for_review";
