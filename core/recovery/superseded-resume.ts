import type { Task } from '../../shared/contracts';

/**
 * A worker run superseded by a pending resume/continuation asked a human to
 * rebind it, and that open question then blocked the very resume that would
 * rebind it (2026-10-06: Project-a #2018, Queue #250, consumer-b #398). A refusal
 * in this state must name the superseding resume and instruct the worker to
 * end its turn without asking, so the thread goes idle and the resume can
 * dispatch. It must never suggest resending under a different run id: the
 * worker cannot authenticate as the resume run.
 */
export function supersededResumeRefusal(reportedRunId: string): string {
  return `Run ${reportedRunId} was superseded by a pending resume/continuation for the retained worker on this same thread; the pending resume owns the thread now and this report cannot be accepted. Do not ask a human to rebind this run and do not open a new question about it. End your turn now without further tool calls so the pending resume can dispatch.`;
}

/**
 * True when the reported run is the retained worker run and a pending pre-PR
 * resume/continuation (or a live same-thread revision run carrying it) owns
 * the thread. Ordinary stale reports without a pending resume keep their
 * existing refusal.
 */
export function supersededByPendingResume(task: Task, reportedRunId: string): boolean {
  if (reportedRunId !== task.runId) return false;
  if (task.completion?.prNumber || task.prUrl || task.prHead || task.resumePrNumber) return false;
  return Boolean(task.resolution.prePrResumeInstruction);
}

/**
 * A prior same-thread revision run superseded by a pre-PR resume/continuation:
 * the task holds the pending resume instruction, or a live same-thread
 * revision run already carries it. The reported run must not be the live run
 * itself, so refusals for other reasons (generation, duplicate completion)
 * keep their existing messages.
 */
export function supersededPriorRevisionRun(
  task: Task,
  reported: { id: string; taskId: string; role: string; agentId?: string | null; released: boolean },
  liveRuns: { id: string; role: string; agentId?: string | null; released: boolean; completion: unknown }[],
): boolean {
  if (reported.taskId !== task.id || reported.role !== 'revision') return false;
  if (!reported.agentId || reported.agentId !== task.agentId) return false;
  if (task.resolution.currentRunId === reported.id && !reported.released) return false;
  return Boolean(task.resolution.prePrResumeInstruction) || liveResumeRunSupersedes(liveRuns, reported.agentId, reported.id);
}

/** A live same-thread revision run that already carries the pending resume. */
export function liveResumeRunSupersedes(
  runs: { id: string; role: string; agentId?: string | null; released: boolean; completion: unknown }[],
  reportedAgentId: string | null | undefined,
  reportedRunId: string,
): boolean {
  return runs.some(
    run =>
      run.role === 'revision' &&
      !run.released &&
      !run.completion &&
      run.id !== reportedRunId &&
      Boolean(run.agentId) &&
      run.agentId === reportedAgentId,
  );
}

export const SUPERSEDED_RUN_REFUSED_KIND = 'superseded_run_refused';

interface EventStore {
  event(taskId: string, kind: string, detail: string): void;
  events(taskId: string): { kind: string; detail: string; at: string }[];
}

/**
 * Durably record that Queue told a superseded worker run to end its turn
 * without asking, so operators can see why a task with a pending resume is
 * still waiting on its thread. Recorded once per run.
 */
export function recordSupersededRunRefusal(store: EventStore, taskId: string, runId: string): void {
  if (store.events(taskId).some(entry => entry.kind === SUPERSEDED_RUN_REFUSED_KIND && entry.detail.startsWith(`run ${runId}:`))) return;
  store.event(taskId, SUPERSEDED_RUN_REFUSED_KIND, `run ${runId}: superseded by the pending resume/continuation; worker told to end its turn without asking`);
}

