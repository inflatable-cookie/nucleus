import type { Run, Task } from '../shared/contracts';

/** No evidence of any dispatched work or PR, including unfinished creation intents. */
export function taskNeverDispatched(task: Task, runs: Run[]): boolean {
  return !task.workspaceIntent && !task.workspaceId && !task.directory && !task.agentIntent && !task.agentId && !task.runId
    && !task.completion && !task.prUrl && !task.prHead && !task.resumePrNumber && !task.retiredWorkers.length
    && !task.resolution.currentRunId && !runs.length;
}

/** A reported run is history even while publication or release still owns its result. */
export function liveRun(run: Run | null | undefined): run is Run {
  return Boolean(run && !run.released && !run.completion);
}

export function liveRunForRole(task: Task, runs: Run[], role: 'worker' | 'reviewer' | 'coordinator'): { run: Run | null } | null {
  const current = task.resolution.currentRunId ? runs.find(run => run.id === task.resolution.currentRunId) : null;
  const runRole = role === 'worker' ? ['revision'] : role === 'coordinator' ? ['recovery', 'closeout'] : ['reviewer'];
  if (liveRun(current) && runRole.includes(current.role)) return { run: current };
  if (role === 'worker' && !current && task.agentId && task.runId && task.workspaceId && task.profile && !task.completion) return { run: null };
  return null;
}

/** The same continuation choice is used before admission and after cancellation. */
export function restartResumeChoice(task: Task, shape: string | null): 'worker' | 'revision' | 'review' | 'retry' {
  const parkedPrePr = shape === 'retained_worker' && Boolean(task.prerequisiteWait?.releasedAt && task.resolution.prePrResumeInstruction);
  return shape === 'blocked_worker' || parkedPrePr ? 'worker' : shape === 'stopped_revision' ? 'revision' : shape === 'blocked_with_pr' ? 'review' : 'retry';
}
