import type { Task } from '../../shared/contracts';
import type { QueueOperation } from '../../shared/operations';
import { BLOCKED_EFFECT_ATTENTION_PREFIX } from '../../shared/task-stop';
import { now, type Store } from '../store/store';
import { blockingRecoveryEffects, observedHostEffectEvidence, recoveryEffectsRefusal, reviewEffectWait } from './recovery-effects';

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
  for (const operation of store.operations({ taskId, states: ['needs_attention'], limit: 1000 })) {
    if (!operation.taskId || operation.taskId !== taskId) continue;
    const task = store.task(taskId);
    const evidence = observedHostEffectEvidence(store, task, operation);
    if (!evidence) continue;
    const at = now();
    const record = evidence.slice(0, 2000);
    settled.push(store.putOperation({ ...operation, state: 'succeeded', settledAt: at, diagnostic: '',
      result: { taskId: task.id, taskVersion: task.version, phase: task.phase, number: task.number ?? null, reference: task.reference ?? null },
      effect: operation.effect ? { ...operation.effect, status: 'reconciled', result: record, resultAt: at } : null }));
    store.event(taskId, 'operation_settled_by_evidence', `${operation.id}: ${record}`);
  }
  return settled;
}

/** True while the task's own recorded stop is this blocked-effect attention. */
export function blockedEffectAttentionRecorded(task: Task): boolean {
  const stop = task.resolution.stop;
  return stop?.reason === 'operator_needed' && stop.detail.startsWith(BLOCKED_EFFECT_ATTENTION_PREFIX);
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
