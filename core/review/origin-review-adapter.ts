import type { ReviewEntryInput } from '../../shared/contracts';
import type { Adapter, AgentObservation, OriginAgent } from '../host/adapter';
import type { ReviewEntryAdapter } from './review-entry';

export type OriginReviewProof = { origin: OriginAgent; state: AgentObservation };

/** The host ports origin-proof wrapping reads: the originating thread and its observation. */
export type OriginReviewHost = {
  originAgent(id: string): Promise<OriginAgent | null>;
  observe(id: string): Promise<AgentObservation>;
};

/**
 * One origin-thread proof, read on `originHostId`. The originating thread and its
 * state live on that host; inspection never proves a foreign host's thread against
 * the local catalog.
 */
export async function originReviewProof(
  host: OriginReviewHost,
  withHost: <T>(id: string, fn: () => T) => T,
  originHostId: string,
  originAgentId: string,
): Promise<OriginReviewProof> {
  return withHost(originHostId, async () => {
    const origin = await host.originAgent(originAgentId);
    if (!origin || origin.archived || !origin.workspaceId) throw new Error('Review entry requires a live originating thread');
    return { origin, state: await host.observe(origin.id) };
  });
}

/**
 * Adapter whose `inspectReviewEntry` is the supplied inspect. Every other property
 * forwards to `adapter`, so a caller that already fetched a proof (or that fetches
 * one inside inspect) still presents the same ReviewEntryAdapter surface.
 */
export function withOriginReviewAdapter<T extends ReviewEntryAdapter>(adapter: T, inspect: T['inspectReviewEntry']): T {
  return new Proxy(adapter, {
    get: (target, property, receiver) => property === 'inspectReviewEntry'
      ? inspect
      : Reflect.get(target, property, receiver),
  });
}

/** The engine and host facts an admission uses to prove the origin on another host. */
export type OriginHostReviewContext = {
  host: OriginReviewHost;
  withHost<T>(id: string, fn: () => T): T;
};

/**
 * The review adapter an admission uses when the task's origin host is not the
 * host running this admission: the originating thread and its state are read on
 * the origin host, and the inspection runs there, so acceptance never proves a
 * foreign host's thread against the local catalog.
 */
export function originHostReviewAdapter(
  context: OriginHostReviewContext,
  adapter: Adapter & ReviewEntryAdapter,
  originHostId: string,
  reviewInput: ReviewEntryInput,
): ReviewEntryAdapter {
  return {
    hostId: adapter.hostId,
    originAgent: id => context.host.originAgent(id),
    ...(adapter.reviewEntryGithubCommand ? { reviewEntryGithubCommand: adapter.reviewEntryGithubCommand.bind(adapter) } : {}),
    inspectReviewEntry: async (input, taskId) => {
      const proof = await originReviewProof(context.host, context.withHost, originHostId, reviewInput.submission.originAgentId);
      return adapter.inspectReviewEntry(input, taskId, proof);
    },
  };
}
