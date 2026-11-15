import type { AgentObservation } from '../host/adapter';

/**
 * The statuses a caller may treat as settled. `closed` and `error` are both
 * inactive wherever a caller names either: an errored agent with no live turn
 * and no pending permission cannot write, so it never blocks a run that does
 * not need it. Callers still name the statuses they accept; they never re-list
 * the error equivalence.
 */
export function settledAgentStatuses(statuses: readonly string[] = ['idle', 'closed', 'error']): readonly string[] {
  return statuses.includes('closed') && !statuses.includes('error') ? [...statuses, 'error'] : statuses;
}

/**
 * The one settled-thread predicate: no live turn, no pending permission, and a
 * status the caller accepts. Every launch, lease, reap and archive proof reads
 * this instead of re-spelling the status list, so they cannot disagree about
 * whether an observed thread may be treated as finished.
 */
export function agentSettled(state: Pick<AgentObservation, 'active' | 'permissions' | 'status'>,
  statuses: readonly string[] = ['idle', 'closed', 'error']): boolean {
  return !state.active && !state.permissions && settledAgentStatuses(statuses).includes(state.status);
}
