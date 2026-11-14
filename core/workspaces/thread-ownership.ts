import { historicalWireLabel } from '../../shared/wire-labels';
import type { Run, Task } from '../../shared/contracts';
import type { Store } from '../store/store';

/**
 * Who owns a thread, and what a task owes it.
 *
 * These are the two rules every archive lane asks: does this thread still serve
 * live work of another task, and is it this task's own worker (which stays as
 * archive history) or a support thread (which is removed where the host can
 * remove one). Both are here once; the task lanes and the external workspace
 * archive read the same functions.
 */

/** Whether this task owns the thread: it must carry this task's own label. */
export function ownedByTask(labels: Record<string, string> | undefined, taskId: string): boolean {
  return historicalWireLabel(labels, 'task') === taskId;
}

/** Worker history also includes revision runs whose task pointer has moved on. */
export function workerThreadIds(task: Task, runs: Run[]): Set<string> {
  return new Set([task.agentId, ...task.retiredWorkers.map(worker => worker.agentId),
    ...runs.filter(run => run.hostId === task.hostId && run.role === 'revision').map(run => run.agentId)]
    .filter((agentId): agentId is string => Boolean(agentId)));
}

/** A run of this thread is still unreleased, so the thread still serves it. */
export function threadHasUnreleasedRun(store: Store, task: Task, agentId: string): boolean {
  return store.unreleasedRunsForAgent(agentId, task.hostId).length > 0;
}

/**
 * Another unfinished task on this host binds this thread: its worker, its
 * coordinator or its retained reviewer (a worker remapped as another task's
 * coordinator, review #543).
 */
export function threadBoundToAnotherLiveTask(store: Store, task: Task, agentId: string): boolean {
  return store.tasks().some(other => other.id !== task.id
    && (!other.hostId || !task.hostId || other.hostId === task.hostId) && !['done', 'cancelled'].includes(other.phase) && !other.removedAt
    && [other.agentId, other.coordinatorAgentId, other.resolution.reviewerAgentId].includes(agentId));
}

/** Either live claim above: the thread is not this task's to archive. */
export function threadServesAnotherTask(store: Store, task: Task, agentId: string): boolean {
  return threadHasUnreleasedRun(store, task, agentId) || threadBoundToAnotherLiveTask(store, task, agentId);
}

/**
 * The operation this task owes the thread. The task's own worker threads stay
 * as archive history — the worker's thread is where its work happened — and
 * every other identity is a support thread, removed where the host can remove
 * one. Initial worker threads have no role label, so the task pointer or a
 * revision run supplies that role.
 */
export function threadOperation(agentId: string, labels: Record<string, string> | undefined, workerAgents: ReadonlySet<string>, supportRemoval: boolean): 'archive' | 'delete' {
  const role = historicalWireLabel(labels, 'role');
  const worker = role ? role === 'worker' || role === 'revision' : workerAgents.has(agentId);
  return supportRemoval && !worker ? 'delete' : 'archive';
}
