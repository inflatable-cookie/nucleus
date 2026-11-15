import type { Task } from '../../../shared/contracts';
import { wireLabel } from '../../../shared/wire-labels';
import { reportingIdentityMismatch } from '../../intake/reporting-identity';
import { clearLiveEvidence, liveEvidenceEpisode, recordLiveEvidenceFailure } from '../../machine/live-evidence';
import type { Adapter } from '../../host/adapter';
import type { WorkerReconcileContext } from './context';

/**
 * A stopped initial worker whose retained reporting binding names another run
 * cannot authenticate anything (Contract 003). The repair is the retained
 * revision path, so this reconciles only a confirmed split, once per grace
 * window, and never turns a stale projection into an escalation.
 */

/** Whether the reporting-binding confirmation may run again: one gated read per grace window. */
export function reportingBindingRecheckDue(engine: WorkerReconcileContext, task: Task): boolean {
  const last = engine.store.events(task.id).find(event => event.kind === 'reporting_binding_recheck');
  return !last || Date.now() - Date.parse(last.at) >= engine.idleGraceMs;
}

/** A split reporting binding: re-read it live once per grace window, then escalate only a confirmed split. */
export async function reconcileReportingBinding(
  engine: WorkerReconcileContext,
  current: Task,
  mismatch: NonNullable<ReturnType<typeof reportingIdentityMismatch>>,
): Promise<void> {
  const { store, resolution, admission } = engine;
  const reason = `Worker reporting binding names run ${mismatch.bindingRunId} but the task holds ${mismatch.runId}; the worker cannot authenticate a report until the binding follows the task run`;
  // Already escalated for this exact mismatch: the confirmation read is
  // spent, so no further live read until the projection changes.
  if (current.phase === 'needs_attention' && current.resolution.attention && current.reason === reason) return;
  // An escalation already owns the lane: reconcile neither overwrites
  // its reason nor spends another live read re-proving it. The lane
  // awaits its human or operator control.
  if (current.resolution.recovery?.status === 'escalated') return;
  // One confirmation read per grace window: a provider whose projection
  // flaps must not spend a re-read on every pass without an escalation.
  if (!reportingBindingRecheckDue(engine, current)) return;
  // Rule 4 gap: a stale mismatch projection must not force an
  // escalation. Re-read the retained worker's current binding and stopped
  // state live before escalating. The re-read goes through the existing
  // admission classes; the settled-idle cache is dropped first so it
  // cannot answer from the observation above.
  let fresh: Awaited<ReturnType<Adapter['observe']>> | null = null;
  let confirmError: unknown = null;
  try {
    admission?.invalidate(current.agentId!);
    store.event(current.id, 'reporting_binding_recheck', 'Re-reading the retained worker binding and stopped state before a mismatch escalation');
    fresh = await engine.onTaskHost(current, () => engine.host.observe(current.agentId!));
  } catch (error) { confirmError = error; }
  if (engine.stopped) return;
  if (confirmError !== null) {
    const hold = recordLiveEvidenceFailure(store, current.id, 'reporting-binding', confirmError, engine.idleGraceMs);
    if (hold === 'notice') {
      const summary = `Worker reporting binding is unverified (${liveEvidenceEpisode(store, current.id, 'reporting-binding')?.error}); holding for retry rather than treating the binding as split`;
      resolution.attention(current, summary);
      resolution.recovery.escalate(store.task(current.id), summary);
    }
    return;
  }
  const latest = store.task(current.id);
  const still = reportingIdentityMismatch(latest, wireLabel(fresh!.labels, 'mcpBinding'));
  const stopped = !fresh!.active && !fresh!.permissions && ['idle', 'error', 'closed'].includes(fresh!.status);
  // The projection moved under the escalation: the binding now follows
  // the task run, the worker resumed, or the lane otherwise left the
  // mismatch window. No escalation; the next pass observes from fresh state.
  if (!still || !stopped || fresh!.workspaceId !== latest.workspaceId) {
    clearLiveEvidence(store, current.id, 'reporting-binding');
    store.event(current.id, 'reporting_binding_reverified', 'Retained binding re-read before a mismatch escalation no longer shows a split; no escalation');
    return;
  }
  clearLiveEvidence(store, current.id, 'reporting-binding');
  resolution.attention(current, reason);
}
