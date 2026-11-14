import type { LaunchThreadContext } from '../launch';
import type { Run, Task } from '../../../shared/contracts';
import { dataHome } from '../../../shared/data-home.mjs';
import { wireLabel } from '../../../shared/wire-labels';
import { active, assignedThreadWaitReason } from '../../recovery/task-reasons';
import {
  mcpBindingPathFromHostRecord, mcpBindingPathFromProcessListing, reportBindingReuseDecision,
} from '../../intake/report-binding';
import { unreleasedLaunchFence } from '../../verbs/owner-facts';

/** What the launch does with the retained thread it was about to reuse. */
export type AssignedThread =
  /** The retained thread is idle and resumable in its own workspace. */
  | { kind: 'reuse'; workspaceId: string }
  /** The thread's report binding belongs to another data home: launch a fresh one. */
  | { kind: 'dropped'; workspaceId: string }
  /** The thread already recorded its wait; the launch stops here. */
  | { kind: 'handled' };

/**
 * Observe an assigned thread before reusing it: a run still holding it is the
 * launch fence, a report binding outside the current data home is a fresh
 * launch, a busy or terminal thread is a wait with a named cause, and only an
 * idle thread whose own workspace matches may be resumed. Every refusal is a
 * recorded wait or a fault an owner must clear, never a launch that silently
 * starts nothing.
 */
export async function observeAssignedThread(ctx: LaunchThreadContext, t: Task, role: Run['role'], agentId: string,
  workspaceId: string, threadBusy: (agentId: string) => boolean): Promise<AssignedThread> {
  // A run still holding this thread is the launch fence: name it, the rule
  // keeping it and what releases it, so `next` and the owner's verb reply
  // state the same reason instead of a launch that silently starts nothing.
  if (threadBusy(agentId)) {
    ctx.waiting(t, `Assigned thread is serving another request: ${unreleasedLaunchFence(ctx.store, t, role, agentId) ?? 'its current run has not settled'}`, 'lifecycle');
    return { kind: 'handled' };
  }
  const state = await ctx.host.observe(agentId);
  let bindingPath = state.mcpBindingPath ?? mcpBindingPathFromHostRecord(state);
  const bindingKey = wireLabel(state.labels, 'mcpBinding');
  if (!bindingPath && bindingKey) {
    try {
      bindingPath = mcpBindingPathFromProcessListing(
        await ctx.adapter.hostProcessListing?.() ?? null,
        bindingKey,
      );
    } catch { /* process listing is best-effort; unknown keeps the thread */ }
  }
  let home: string | undefined;
  try { home = dataHome(); } catch { /* unknown home keeps the thread */ }
  if (home && reportBindingReuseDecision({ bindingPath, dataHome: home }) === 'fresh') {
    ctx.store.event(t.id, 'report_binding_relaunch', `Retained ${role} ${agentId} report binding ${bindingPath} lives outside the current data home; launching a fresh thread on the same profile`);
    return { kind: 'dropped', workspaceId };
  }
  const resumable = state.status === 'idle' || state.status === 'closed' && (
    role === 'reviewer' || role === 'revision'
  ) || role === 'revision' && t.resolution.revisionResumeUnpublished && state.status === 'error';
  // A stale pending Nucleus question found at dispatch is resolved, not
  // waited on (papercut ee9fc161): a withdrawn question never stalls
  // dispatch. Anything else pending keeps the ordinary wait below.
  if ((active(state) || !resumable) && (state.permissions || state.pendingRequest)) {
    if (await ctx.resolveWithdrawnPending(t, { agentId, state })) return { kind: 'handled' };
  }
  // No bypass over a pending permission or question here: nothing Queue can
  // observe identifies the pending item as the superseded run's own question,
  // so the resume waits until the thread goes idle. The recorded
  // superseded-run refusal already told the worker to end its turn without asking.
  // A busy thread is a wait; a terminal, non-resumable one is a fault an owner or coordinator must clear.
  if (active(state) || !resumable) {
    ctx.waiting(t, assignedThreadWaitReason(state), active(state) ? 'lifecycle' : 'operator_needed');
    return { kind: 'handled' };
  }
  if (role === 'reviewer' || role === 'revision') {
    if (state.workspaceId !== t.workspaceId!) throw new Error('Retained thread left the worker workspace');
    return { kind: 'reuse', workspaceId };
  }
  const resumedWorkspace = state.workspaceId!;
  if (!resumedWorkspace) throw new Error('Assigned coordinator has no workspace');
  return { kind: 'reuse', workspaceId: resumedWorkspace };
}
