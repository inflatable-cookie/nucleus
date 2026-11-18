import type { Task } from '../../shared/contracts';
import type { QueueOperation } from '../../shared/operations';
import { BLOCKED_EFFECT_ATTENTION_PREFIX } from '../../shared/task-stop';
import type { Store } from '../store/store';
import { authenticatedCompletion, blockingRecoveryEffects, hasRecordedOperationSettlement, observedHostEffectEvidence, releasedRunDeliveryEvidence, recoveryEffectsRefusal, reviewEffectWait } from './recovery-effects';

/**
 * Nucleus#1159: an uncertain side effect answers itself when later evidence
 * shows it landed, and one that still blocks a phase becomes attention instead
 * of a quiet wait.
 *
 * Both halves are Queue's own reconciler work, run on the ordinary pass and
 * never a new gate: the projection in `recovery-effects` already refuses to
 * block on an operation later evidence has answered, and this module records
 * that settlement and raises the attention when the blocked wait outlives its
 * bound. Nothing here resends an unknown delivery.
 */

/**
 * Bound after which a phase blocked on an uncertain side effect is attention.
 * The owner's `retry_effect` is the supported exit and the planner is told, so
 * two hours of silence cannot pass for a wait. Ten minutes matches the shortest
 * ordinary observation interval; tests set `blockedEffectAttentionMs`.
 */
export const BLOCKED_EFFECT_ATTENTION_MS = 10 * 60_000;

/**
 * Settle every uncertain host-effect control of this task whose effect later
 * evidence has answered, recording that evidence on the operation and in the
 * task's timeline. Idempotent: a settled operation is never settled again, and
 * an unanswered one is left exactly as recorded.
 */
export function settleObservedHostEffectOperations(store: Store, taskId: string): QueueOperation[] {
  const settled: QueueOperation[] = [];
  // The observer's own exact-run event can outlive an overwritten run row.
  // Re-read inside the transaction and preserve the event; no send is retried.
  store.transaction(() => {
    for (const candidate of store.runs(taskId)) {
      const run = store.run(candidate.id);
      if (!run || run.taskId !== taskId) continue;
      const evidence = releasedRunDeliveryEvidence(store, run);
      if (!evidence) continue;
      if (run.completion && !authenticatedCompletion(store, run)) {
        // Keep an unverified result untouched; its own intake gate still owns it.
        if (!store.eventsAll(taskId).some(event => event.kind === 'run_delivery_superseded' && event.detail.startsWith(`${run.id}: `)))
          store.event(taskId, 'run_delivery_superseded', `${run.id}: ${evidence}`);
        continue;
      }
      store.putRun({ ...run, status: run.completion ? 'finished' : 'superseded' });
      store.event(taskId, 'run_delivery_superseded', `${run.id}: ${evidence}`);
    }
  });
  store.transaction(() => {
    for (const candidate of store.operations({ taskId, states: ['needs_attention'], limit: 1000 })) {
      const operation = store.operation(candidate.id);
      if (!operation || operation.taskId !== taskId || operation.state !== 'needs_attention') continue;
      const task = store.task(taskId);
      if (hasRecordedOperationSettlement(store, task, operation)) continue;
      const evidence = observedHostEffectEvidence(store, task, operation);
      if (!evidence) continue;
      const record = { id: operation.id, inputHash: operation.inputHash, attempt: operation.attempts,
        intentAt: operation.effect!.intentAt, evidence: evidence.slice(0, 1200) };
      // Leave the uncertain operation intact: failed operations can reopen, and
      // a successful result would claim delivery. The event closes this occurrence.
      store.event(taskId, 'operation_superseded', JSON.stringify(record));
      settled.push(operation);
    }
  });
  return settled;
}

/** True while the task's own recorded stop is this blocked-effect attention. */
export function blockedEffectAttentionRecorded(task: Task): boolean {
  const stop = task.resolution.stop;
  return stop?.reason === 'operator_needed' && stop.suggestedVerbs.length === 1 && stop.suggestedVerbs[0] === 'retry_effect';
}

/**
 * The attention reason for a review phase that has been blocked on an uncertain
 * side effect past its bound, or null while it is still inside the bound, no
 * longer blocked, or not in the blocked wait at all. The blocking set is read
 * fresh, so the reason names what blocks now and a settled effect clears it.
 */
export function blockedEffectAttentionReason(store: Store, task: Task, at = Date.now()): string | null {
  const wait = reviewEffectWait(task);
  const recorded = blockedEffectAttentionRecorded(task);
  if (!wait && !recorded) return null;
  const blocked = blockingRecoveryEffects(store, task, { noticeKinds: 'all' });
  if (!blocked.length) return null;
  const since = wait?.since ?? task.resolution.stop!.since;
  const bound = store.getMeta<number>('blockedEffectAttentionMs') ?? BLOCKED_EFFECT_ATTENTION_MS;
  if (!Number.isFinite(Date.parse(since)) || at - Date.parse(since) < bound) return null;
  return `${BLOCKED_EFFECT_ATTENTION_PREFIX}: ${recoveryEffectsRefusal(blocked)}. Later evidence settles any of these the task has answered, so retry_effect re-proves the effect by observation and never resends an unknown delivery.`;
}
