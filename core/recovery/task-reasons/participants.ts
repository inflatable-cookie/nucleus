import { parseAgentId, sameCallerIdentity } from '../../../shared/agent-identity';
import type { Run, Task } from '../../../shared/contracts';
import type { Adapter } from '../../host/adapter';

/**
 * Run roles, thread waits and participant identity: the facts a lifecycle pass
 * needs about *who* is running, kept apart from the reason text and the verdicts
 * those runs record.
 */

/** An observed agent is live while it runs, initializes or waits on a permission. */
export const observedActive = (s: Awaited<ReturnType<Adapter['observe']>>) => s.active || s.permissions || ['running', 'initializing'].includes(s.status);
export const active = observedActive;

export const assignedThreadWaitReason = (state: Awaited<ReturnType<Adapter['observe']>>) => {
  if (state.permissions) {
    const request = state.pendingRequest;
    return request
      ? `Assigned thread has pending ${request.kind === 'question' ? 'question' : 'permission'} ${request.id}${request.firstLine ? `: ${request.firstLine}` : ''}`
      : 'Assigned thread has a pending permission response';
  }
  if (state.active || ['running', 'initializing'].includes(state.status)) {
    return state.activeTurnId
      ? `Assigned thread has active turn ${state.activeTurnId}`
      : `Assigned thread is active (${state.status})`;
  }
  return `Assigned thread is not resumable (${state.status})`;
};

/** The roles a coordinator thread speaks for. */
export const coordinative = (r: Run) => r.role === 'closeout' || r.role === 'recovery';
/** A proof-only executor run is a resolution creation: its own absent-creation recovery uses `restart`. */
export const proofExecutor = (role: Run['role'] | string) => role === 'executor';
/** The roles created as a resolution's own run, with no worker of their own. */
export const resolutionCreationRoles = new Set<Run['role']>(['reviewer', 'closeout', 'executor']);

/** Run identities for a participant can live in run rows or only in task-row bindings. */
export function participantToolRunIds(task: Task, runs: Run[], agentId: string, workspaceId: string): string[] {
  const ids = new Set<string>();
  // Run rows are returned in creation order. Keep the newest ticket first so
  // provider process proof uses the current helper where an older run was
  // superseded but its agent remains the same.
  if (task.agentId === agentId && task.workspaceId === workspaceId && task.runId) ids.add(task.runId);
  for (const run of [...runs].reverse()) if (run.agentId === agentId && run.workspaceId === workspaceId) ids.add(run.id);
  for (const worker of [...task.retiredWorkers].reverse()) {
    if (worker.agentId !== agentId) continue;
    const run = runs.find(item => item.id === worker.runId);
    if ((run?.workspaceId || task.workspaceId) === workspaceId) ids.add(worker.runId);
  }
  return [...ids];
}

/** Queue planner ids are stored as full UUIDs; callers sometimes arrive as the 8-char prefix. */
export function plannerIdMatches(planner: string | undefined, caller: string,
  plannerHostId?: string | null, callerHostId?: string | null): boolean {
  if (!planner) return false;
  if (sameCallerIdentity(planner, caller, plannerHostId, callerHostId)) return true;
  const plannerRef = parseAgentId(planner), callerRef = parseAgentId(caller);
  const plannerHost = plannerRef?.hostId ?? plannerHostId;
  const callerHost = callerRef?.hostId ?? callerHostId;
  if ((plannerHost || callerHost) && (!plannerHost || !callerHost || plannerHost !== callerHost)) return false;
  if (Boolean(plannerRef) !== Boolean(callerRef) && (!plannerHost || !callerHost)) return false;
  planner = plannerRef?.nativeAgentId ?? planner;
  caller = callerRef?.nativeAgentId ?? caller;
  if (!/^[0-9a-f-]+$/i.test(planner) || !/^[0-9a-f-]+$/i.test(caller)) return false;
  const a = planner.replace(/-/g, '').toLowerCase();
  const b = caller.replace(/-/g, '').toLowerCase();
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 8 && longer.startsWith(shorter);
}

/** The last reminder clock for one run: its callback reminder, or its extension when that is later. */
export function reminderClock(events: Array<{ kind: string; detail: string; at: string }>, runId: string): string | null {
  const reminder = events.find(event => event.kind === 'callback_reminder' && event.detail === runId);
  if (!reminder) return null;
  const extended = events.find(event => event.kind === 'callback_reminder_extended' && event.detail === runId);
  if (extended && Date.parse(extended.at) > Date.parse(reminder.at)) return extended.at;
  return reminder.at;
}
