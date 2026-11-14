import type { LaunchThreadContext } from '../launch';
import { type Run, type Task } from '../../../shared/contracts';
import type { HostObservation } from '../../../shared/host';
import { proofExecutor } from '../../recovery/task-reasons';
import { decideWorkerReplacement, isWorkerRouteApproved, retainedWorkerFailureCause } from '../../recovery/worker-replacement';
import { modelKey } from '../routing';
import { groupForProfile, type LaunchOptions, type ThreadBinding } from './thread-binding';
import { executorThreadDecision } from './thread-decisions';

/**
 * Task 405: a proof executor is always a fresh agent in the task checkout; it
 * never resumes the author, a reviewer or a coordinator. Task 582 reconciles
 * that rule with one executor thread per task: consecutive proof heads continue
 * the task's retained executor thread — an agent recorded only by this task's
 * own executor runs, never another role's binding — and every turn stays a
 * fresh, source-immutable assignment for its exact head. The shared worker
 * replacement decision replaces the retained thread for provider failure, an
 * unrecoverable session, or an approved route to a different model. The decision
 * runs here, where the reset used to null the binding unconditionally, so
 * retention and the Task 405 rule cannot disagree about the same launch.
 */
export async function reconcileExecutorThread(ctx: LaunchThreadContext, t: Task, role: Run['role'],
  options: LaunchOptions, binding: ThreadBinding): Promise<ThreadBinding> {
  if (!proofExecutor(role)) return binding;
  let { agentId, profile, group } = binding;
  const priorExecutor = binding.priorExecutor;
  if (executorThreadDecision({ stage: 'collision', collided: Boolean(agentId && [t.agentId, t.resolution.reviewerAgentId, t.coordinatorAgentId].includes(agentId)) }) === 'fresh') agentId = null;
  if (agentId && priorExecutor) {
    let state: HostObservation | null = null;
    try { state = await ctx.host.observe(agentId); } catch { /* an unreadable observation proves nothing */ }
    const currentModel = priorExecutor.profile?.model ?? null;
    let failure = state ? retainedWorkerFailureCause({
      task: { ...t, completion: priorExecutor.completion ?? t.completion },
      observedStatus: state.status,
      observedError: state.error,
      observedWorkspaceId: state.workspaceId,
    }) : null;
    if (state && !failure && t.workspaceId && state.workspaceId !== t.workspaceId)
      failure = { kind: 'session_unrecoverable', detail: 'the retained executor no longer reports the task workspace' };
    if (state && !failure && currentModel && state.model && modelKey(currentModel) !== modelKey(state.model))
      failure = { kind: 'session_unrecoverable', detail: `the retained executor session is running ${state.model}, not ${currentModel}` };
    const replacement = decideWorkerReplacement({
      task: t,
      requestedProfileId: options.profile?.id ?? null,
      requestedModel: profile?.model ?? null,
      currentModel,
      approved: options.profile ? isWorkerRouteApproved(t, options.profile.id, ctx.store.pool(), ctx.store.usageLevel()) : false,
      failure,
      explicitOperatorRelay: false,
    });
    const replacementDecision = executorThreadDecision({
      stage: 'replacement',
      allowed: replacement.allowed,
      profileMismatch: Boolean(priorExecutor.profile && profile?.id !== priorExecutor.profile.id),
    });
    if (replacementDecision === 'fresh') agentId = null;
    else if (replacementDecision === 'reselect') {
      // A same-model selection or a route still waiting on sign-off keeps
      // the existing binding and its pinned profile together.
      profile = priorExecutor.profile;
      group = groupForProfile(ctx, profile);
    }
  }
  if (!agentId && executorThreadDecision({ stage: 'unbound' }) === 'fresh') {
    // A fresh executor pins only an explicitly selected profile; otherwise
    // the selection below chooses one.
    profile = options.profile ?? null;
    group = groupForProfile(ctx, profile);
  }
  return { agentId, profile, group, priorExecutor };
}
