import { runHoldsSlot, type Run, type Task } from '../../shared/contracts';

/**
 * A recovery coordinator that finds the task live reports this settled no-op
 * instead of blocked. The summary shape is the brief's: `live: <who> is working,
 * last activity <t>`. Intake accepts recovered without coordinatorAction for it.
 */
export const LIVE_RECOVERY_NOOP_PREFIX = 'live:';

export function isLiveRecoveryNoop(summary: string | null | undefined): boolean {
  return Boolean(summary && /^live:\s/i.test(summary.trim()));
}

/** The unreleased non-recovery run that still holds the lane. */
export function liveWorkingParticipant(task: Task, runs: Run[]): Run | null {
  const currentId = task.resolution.currentRunId;
  const ordered = [
    ...(currentId ? runs.filter(run => run.id === currentId) : []),
    ...runs,
  ];
  return ordered.find(run => run.role !== 'recovery' && !run.released && runHoldsSlot(run)) ?? null;
}

export function liveNoopSummary(run: Pick<Run, 'role' | 'lastObservedAt' | 'createdAt'>): string {
  const who = run.role === 'revision' ? 'worker' : run.role;
  return `${LIVE_RECOVERY_NOOP_PREFIX} ${who} is working, last activity ${run.lastObservedAt ?? run.createdAt}`;
}

/**
 * A live no-op resolved the episode so a still-active participant is not
 * recovered again. A stall on that participant is new work: open another episode.
 */
export function reopenLiveNoopAfterStall(task: Task): boolean {
  const recovery = task.resolution.recovery;
  if (!recovery || recovery.status !== 'resolved' || !isLiveRecoveryNoop(recovery.summary)) return false;
  const stall = task.resolution.stalledTurnStop;
  return Boolean(stall && stall.status !== 'stopped' && stall.status !== 'completed');
}
