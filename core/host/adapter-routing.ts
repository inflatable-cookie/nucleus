import { callerNativeId, foreignIdentityRefusal, parseAgentId } from '../../shared/agent-identity';
import type { ReviewEntryInput } from '../../shared/contracts';
import { originReviewProof, type OriginReviewHost } from '../review/origin-review-adapter';
import type { Adapter, AgentObservation, OriginAgent } from './adapter';

/**
 * Direct adapter calls that still name an agent: HostFacade already routes the
 * Host contract; this table is the compatibility path for call sites that still
 * go through `engine.adapter` instead of `engine.host`.
 */
const AGENT_ARGS: Record<string, number[]> = {
  originAgent: [0], observe: [0], archiveAgent: [0], stopAgentTurn: [0],
  agentTimeline: [0], agentTimelinePage: [0], pendingQuestions: [0],
  answeredQuestions: [0], dismissNativeQuestion: [0], answerNativeQuestion: [0],
  answerNativePermission: [0], subscribeRunUsage: [0],
  notify: [0, 3], enqueueMessage: [0, 3], steerOrNotify: [0, 3], interruptAndContinue: [0],
  askPlanner: [0], askReviewer: [0],
};

/** The engine ports host-adapter routing reads at each call. */
export interface HostAdapterRoutingOwner {
  readonly activeHostId: string | undefined;
  resolveHostAdapter: (id: string) => Adapter | undefined;
  store: { task(id: string): { originHostId?: string | null; hostId?: string | null } };
  withHost<T>(id: string, fn: () => T): T;
  hostAvailable: (id: string) => boolean;
  host: OriginReviewHost;
  hostOnline: (id: string) => boolean;
}

/**
 * Adapter that serves the ambient host, unwraps qualified agent ids for that
 * host, and re-enters itself inside a foreign agent's own host context. Direct
 * `inspectReviewEntry` without a supplied proof fetches the origin proof on the
 * task's origin host; a missing or offline origin host refuses, named.
 */
export function routeHostAdapter(owner: HostAdapterRoutingOwner, fallback: Adapter): Adapter {
  const proxy: Adapter = new Proxy(fallback, {
    get: (selectedFallback, property) => {
      const id = owner.activeHostId;
      const selected = id ? owner.resolveHostAdapter(id) : selectedFallback;
      if (!selected) throw new Error(`Transport not connected: host ${id} is unavailable`);
      const value = Reflect.get(selected, property, selected);
      if (property === 'inspectReviewEntry' && typeof value === 'function') {
        return async (input: ReviewEntryInput, taskId?: string, suppliedProof?: { origin: OriginAgent; state: AgentObservation }) => {
          if (suppliedProof || !taskId) return value.call(selected, input, taskId, suppliedProof);
          const task = owner.store.task(taskId), originHost = task.originHostId;
          if (!originHost) throw new Error('Transport not connected: review-entry origin host is unknown');
          if (originHost === task.hostId) return value.call(selected, input, taskId);
          if (!owner.withHost(originHost, () => owner.hostAvailable(originHost)))
            throw new Error(`Transport not connected: waiting for origin host ${originHost}`);
          const proof = await originReviewProof(owner.host, owner.withHost, originHost, input.submission.originAgentId);
          return value.call(selected, input, taskId, proof);
        };
      }
      if (typeof value !== 'function') return value;
      // Some older call sites still use adapter methods directly instead of
      // HostFacade. Keep that compatibility safe at the transport boundary:
      // qualified IDs are unwrapped only for the selected host, for every
      // host method whose arguments identify an agent, and a call that names
      // an agent on another registered host is routed there — the agent's own
      // transport serves it, never an unwrap against the wrong host.
      const native = (agentId: unknown): unknown => typeof agentId === 'string'
        ? callerNativeId(agentId, id ?? (selected as Adapter & { hostId?: string }).hostId)
        : agentId;
      const positions = AGENT_ARGS[String(property)];
      const bound = id ?? (selected as Adapter & { hostId?: string }).hostId;
      return (...args: unknown[]) => {
        // The recipient (position 0 of an agent-naming method) decides the
        // route: a call that names an agent on another registered host
        // re-enters this proxy inside that host's context, so the agent's own
        // transport serves it. A secondary identity on yet another host rides
        // out, the way the delegated ask route drops it; an unknown or offline
        // host refuses, named.
        const primary = positions?.[0] === 0 && typeof args[0] === 'string' ? parseAgentId(args[0]) : null;
        if (primary && primary.hostId !== bound) {
          if (!owner.hostOnline(primary.hostId)) throw new Error(foreignIdentityRefusal(primary.hostId));
          const rideAlong = args.slice();
          for (const position of (positions ?? []).slice(1)) {
            const parsed = typeof rideAlong[position] === 'string' ? parseAgentId(rideAlong[position] as string) : null;
            if (parsed && parsed.hostId !== primary.hostId) rideAlong[position] = undefined;
          }
          const sourceInput = rideAlong[1];
          if ((property === 'askPlanner' || property === 'askReviewer') && sourceInput
            && typeof sourceInput === 'object' && 'sourceAgentId' in sourceInput) {
            const input = sourceInput as { sourceAgentId?: unknown };
            const parsed = typeof input.sourceAgentId === 'string' ? parseAgentId(input.sourceAgentId) : null;
            rideAlong[1] = { ...input, ...(parsed && parsed.hostId !== primary.hostId ? { sourceAgentId: undefined } : {}) };
          }
          return owner.withHost(primary.hostId, () =>
            (proxy as unknown as Record<string, (...callArgs: unknown[]) => unknown>)[String(property)](...rideAlong));
        }
        const normalized = args.slice();
        for (const position of positions ?? []) if (normalized[position] !== undefined)
          normalized[position] = native(normalized[position]);
        if ((property === 'askPlanner' || property === 'askReviewer') && normalized[1]
          && typeof normalized[1] === 'object' && 'sourceAgentId' in normalized[1]) {
          const input = normalized[1] as { sourceAgentId?: unknown };
          normalized[1] = { ...input, ...(input.sourceAgentId === undefined ? {} : { sourceAgentId: native(input.sourceAgentId) }) };
        }
        if (property === 'observationInventory' && Array.isArray(normalized[0]))
          normalized[0] = (normalized[0] as unknown[]).map(native);
        return value.apply(selected, normalized);
      };
    },
    set: (selectedFallback, property, value) => Reflect.set(selectedFallback, property, value, selectedFallback),
  });
  return proxy;
}
