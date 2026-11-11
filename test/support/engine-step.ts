import type { Engine } from '../../core/engine';

/**
 * One sweep with the lifecycle follow-ups it schedules dropped.
 *
 * Since #346, `wake()` drains through lifecycle follow-ups, so one call runs a
 * task from review through merge to closeout. A test that inspects an
 * intermediate phase, or changes the world (a merge gate, review evidence, an
 * agent's state) before the next lifecycle step, uses this causal boundary.
 * The next `stepEngine` or `wake()` picks the task up again from the sweep.
 */
export async function stepEngine(engine: Engine): Promise<void> {
  const lanes = engine as unknown as { scheduleLifecycleFollowUp: (taskId: string) => void };
  lanes.scheduleLifecycleFollowUp = () => {};
  try { await engine.wake(); } finally { delete (lanes as { scheduleLifecycleFollowUp?: unknown }).scheduleLifecycleFollowUp; }
}
