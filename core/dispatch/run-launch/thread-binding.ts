import type { LaunchThreadContext } from '../launch';
import type { Profile, Run, Task } from '../../../shared/contracts';
import type { ContinuedPrBinding, ProofActivation } from '../../resolution';
import type { chooseProfile } from '../routing';

/** What a launch may ask for explicitly, and what the source stage already decided. */
export type LaunchOptions = { profile?: Profile; instruction?: string; proof?: ProofActivation };
export type LaunchSourceFacts = {
  firstReviewEntryWorker: boolean;
  firstWorkerSelection: ReturnType<typeof chooseProfile> | null;
  prePrWorkerResume: boolean;
  retainedPrePrHead: string | null;
  resumingUnpublished: boolean;
  continuedPr?: ContinuedPrBinding | null;
};
/** The thread a launch would reuse: agent, pinned profile, its pool group and the last released executor. */
export type ThreadBinding = { agentId: string | null; profile: Profile | null; group: string | null; priorExecutor: Run | null };

/**
 * The binding a role's launch starts from: the task's retained identity, the
 * last released executor, and the selected first revision worker, before any
 * eligibility rule changes it. The source stage's selection wins over the
 * retained profile, so an explicitly selected first worker is never mixed with
 * another role's binding.
 */
export function retainedThreadBinding(ctx: LaunchThreadContext, t: Task, role: Run['role'], options: LaunchOptions, source: LaunchSourceFacts): ThreadBinding {
  const { firstWorkerSelection } = source;
  const store = ctx.store;
  const priorExecutor = role === 'executor'
    ? store.runs(t.id).findLast(run => run.role === 'executor' && run.released && run.agentId) ?? null : null;
  const agentId = role === 'revision' ? t.agentId : role === 'reviewer' ? (options.profile ? null : t.resolution.reviewerAgentId)
    : role === 'executor' ? priorExecutor?.agentId ?? null : t.coordinatorAgentId || null;
  const profile = options.profile ?? firstWorkerSelection?.profile ?? (role === 'revision' ? t.profile : role === 'reviewer' ? t.resolution.reviewerProfile
    : role === 'executor' ? priorExecutor?.profile ?? null : store.runs(t.id).findLast(run => run.agentId === agentId && run.profile)?.profile ?? null);
  const group = firstWorkerSelection?.entry.group ?? (options.profile ? store.pool().find(entry => entry.profileId === options.profile!.id)?.group ?? null
    : role === 'executor' && priorExecutor?.profile ? store.pool().find(entry => entry.profileId === priorExecutor.profile!.id)?.group ?? null : null);
  return { agentId, profile, group, priorExecutor };
}

/** The pool group a profile belongs to, so a reselected binding carries its group. */
export function groupForProfile(ctx: Pick<LaunchThreadContext, 'store'>, profile: Profile | null | undefined): string | null {
  return profile ? ctx.store.pool().find(entry => entry.profileId === profile.id)?.group ?? null : null;
}
