import type { Engine } from '../../core/engine';

/** Hold automatic follow-ups while a test inspects an intermediate transition.
 * Releasing queues the real follow-ups; production scheduling is unchanged. */
export function holdLifecycleFollowUps(engine: Engine, shouldHold: () => boolean = () => true): () => void {
  const target = engine as unknown as { scheduleLifecycleFollowUp(taskId: string): boolean };
  const original = target.scheduleLifecycleFollowUp;
  const pending = new Set<string>();
  target.scheduleLifecycleFollowUp = (taskId) => {
    if (!shouldHold()) return original.call(engine, taskId);
    pending.add(taskId); return true;
  };
  return () => {
    target.scheduleLifecycleFollowUp = original;
    for (const taskId of pending) original.call(engine, taskId);
  };
}
