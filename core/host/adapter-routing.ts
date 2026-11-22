import {
  callerNativeId,
  foreignIdentityRefusal,
  parseAgentId,
} from "../../shared/agent-identity";
import type { ReviewEntryInput, Run, Task } from "../../shared/contracts";
import {
  originReviewProof,
  type OriginReviewHost,
} from "../review/origin-review-adapter";
import type { Adapter, AgentObservation, OriginAgent } from "./adapter";
import type { Engine } from "../engine";
import { isTransportFailure } from "../../shared/transport";
import type { Store } from "../store/store";
import {
  creationProducerId,
  readCreationAttempt,
  settleCreationAttempt,
} from "../store/store-task-funnel";
import { trackHostCreation } from "./admission";
import {
  HostCallAbandonedError,
  HostReadRefusalError,
  ProvenPreSendRefusalError,
} from "./errors";
import { createUnboundAdapter } from "./unbound-adapter";
const faultHosts = new WeakMap<object, string>();
const HOST_CALL_FAILED = Symbol("host-call-failed");

/**
 * Report one failed host call to that host's health owner (Spec 069 §2). The call
 * fails only its own step: a hung or transport-failed call on a connected host is
 * a `degraded` sample, and no call outcome marks a host down or writes a task.
 * Callers holding only the routed adapter reach the engine's HostHealth here.
 */
export function reportHostCallFailure(
  adapter: Adapter,
  hostId: string,
  error: unknown,
): void {
  const report = Reflect.get(adapter, HOST_CALL_FAILED);
  if (typeof report === "function") report(hostId, error);
}

/** A transport failure attributed at the adapter boundary, before host context is lost. */
export class HostTransportFault extends Error {
  constructor(
    readonly hostId: string,
    cause: unknown,
  ) {
    super(
      `Transport not connected: host ${hostId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "HostTransportFault";
  }
}

function attributed(host: string | undefined, error: unknown): unknown {
  if (
    !host ||
    error instanceof HostTransportFault ||
    error instanceof HostReadRefusalError
  )
    return error;
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    if (!faultHosts.has(error as object)) faultHosts.set(error as object, host);
    return error;
  }
  return new HostTransportFault(host, error);
}

/** Host identity captured where the adapter threw, without changing its error type. */
export function hostFaultHost(error: unknown): string | undefined {
  if (error instanceof HostTransportFault) return error.hostId;
  return error !== null &&
    (typeof error === "object" || typeof error === "function")
    ? faultHosts.get(error as object)
    : undefined;
}

/**
 * Direct adapter calls that still name an agent: HostFacade already routes the
 * Host contract; this table is the compatibility path for call sites that still
 * go through `engine.adapter` instead of `engine.host`.
 */
const AGENT_ARGS: Record<string, number[]> = {
  originAgent: [0],
  observe: [0],
  archiveAgent: [0],
  deleteAgent: [0],
  stopAgentTurn: [0],
  agentTimeline: [0],
  agentTimelinePage: [0],
  pendingQuestions: [0],
  answeredQuestions: [0],
  dismissNativeQuestion: [0],
  answerNativeQuestion: [0],
  answerNativePermission: [0],
  subscribeRunUsage: [0],
  notify: [0, 3],
  enqueueMessage: [0, 3],
  steerOrNotify: [0, 3],
  interruptAndContinue: [0],
  askPlanner: [0],
  askReviewer: [0],
};

/** The engine ports host-adapter routing reads at each call. */
export interface HostAdapterRoutingOwner {
  readonly activeHostId: string | undefined;
  resolveHostAdapter: (id: string) => Adapter | undefined;
  store: Pick<Store, "db" | "event" | "transaction"> & {
    task(id: string): { originHostId?: string | null; hostId?: string | null };
  };
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
export function routeHostAdapter(
  owner: HostAdapterRoutingOwner,
  fallback: Adapter = createUnboundAdapter(),
): Adapter {
  const record = attributed;
  const recordCall = (
    host: string | undefined,
    method: PropertyKey,
    error: unknown,
  ) => {
    if (
      host &&
      (method === "validate" || method === "preflightWorkspaceStorage") &&
      !(error instanceof HostTransportFault) &&
      isTransportFailure(error)
    )
      return new HostTransportFault(host, error);
    return record(host, error);
  };
  const creating = new Set<string>();
  const proxy: Adapter = new Proxy(fallback, {
    get: (selectedFallback, property) => {
      if (property === HOST_CALL_FAILED)
        return (hostId: string, error: unknown) =>
          (owner as unknown as Partial<Engine>).hostHealth?.callFailed(
            hostId,
            error,
          );
      const id = owner.activeHostId;
      const selected = id ? owner.resolveHostAdapter(id) : selectedFallback;
      if (!selected)
        throw record(
          id,
          new HostTransportFault(
            id!,
            new Error(`Transport not connected: host ${id} is unavailable`),
          ),
        );
      if (
        !selected.workspaceAllocationBridge &&
        selectedFallback.workspaceAllocationBridge
      ) {
        selected.workspaceAllocationBridge =
          selectedFallback.workspaceAllocationBridge;
      }
      if (
        !selected.workspaceCreationProgress &&
        selectedFallback.workspaceCreationProgress
      ) {
        selected.workspaceCreationProgress =
          selectedFallback.workspaceCreationProgress;
      }
      let value: unknown;
      try {
        value = Reflect.get(selected, property, selected);
      } catch (error) {
        throw record(id, error);
      }
      if (property === "inspectReviewEntry" && typeof value === "function") {
        return async (
          input: ReviewEntryInput,
          taskId?: string,
          suppliedProof?: { origin: OriginAgent; state: AgentObservation },
        ) => {
          try {
            if (suppliedProof || !taskId)
              return await value.call(selected, input, taskId, suppliedProof);
            const task = owner.store.task(taskId),
              originHost = task.originHostId;
            if (!originHost)
              throw new Error(
                "Transport not connected: review-entry origin host is unknown",
              );
            if (originHost === task.hostId)
              return await value.call(selected, input, taskId);
            if (
              !owner.withHost(originHost, () => owner.hostAvailable(originHost))
            )
              throw new Error(
                `Transport not connected: waiting for origin host ${originHost}`,
              );
            // Method-call the port: a class withHost (Engine) reads this.hostContext.
            const proof = await originReviewProof(
              owner.host,
              (id, fn) => owner.withHost(id, fn),
              originHost,
              input.submission.originAgentId,
            );
            return await value.call(selected, input, taskId, proof);
          } catch (error) {
            throw record(id, error);
          }
        };
      }
      if (typeof value !== "function") return value;
      if (property === "createAgent" || property === "createRun") {
        return async (...args: unknown[]) => {
          const task = args[0] as Task;
          const binding =
            property === "createRun"
              ? { ...(args[1] as Run), hostId: task.hostId }
              : {
                  id: task.runId!,
                  taskId: task.id,
                  hostId: task.hostId,
                  workspaceId: task.workspaceId,
                  role: "worker" as const,
                };
          const attempt = readCreationAttempt(owner.store, binding);
          if (!attempt) {
            try {
              return await Reflect.apply(value, selected, args);
            } catch (error) {
              throw recordCall(id, property, error);
            }
          }
          let admitted = false;
          try {
            return await trackHostCreation(
              selected,
              property,
              args,
              async (create) => {
                admitted = true;
                const current = readCreationAttempt(owner.store, binding);
                if (
                  current?.attemptId !== attempt.attemptId ||
                  current.producerId !== creationProducerId ||
                  current.settlement ||
                  creating.has(attempt.attemptId)
                )
                  throw new ProvenPreSendRefusalError(
                    "Agent creation reservation is no longer available",
                  );
                creating.add(attempt.attemptId);
                let outcome: "returned" | "threw" = "threw";
                try {
                  const agent = await create();
                  outcome = "returned";
                  return agent;
                } finally {
                  creating.delete(attempt.attemptId);
                  settleCreationAttempt(owner.store, attempt, outcome);
                }
              },
            );
          } catch (error) {
            // A caller deadline does not stop the native promise. Its own
            // return or throw will record settlement, even after abandonment.
            if (
              !admitted &&
              !(error instanceof HostCallAbandonedError) &&
              attempt.producerId === creationProducerId &&
              !creating.has(attempt.attemptId)
            )
              settleCreationAttempt(owner.store, attempt, "threw");
            throw recordCall(id, property, error);
          }
        };
      }
      // Some older call sites still use adapter methods directly instead of
      // HostFacade. Keep that compatibility safe at the transport boundary:
      // qualified IDs are unwrapped only for the selected host, for every
      // host method whose arguments identify an agent, and a call that names
      // an agent on another registered host is routed there — the agent's own
      // transport serves it, never an unwrap against the wrong host.
      const native = (agentId: unknown): unknown =>
        typeof agentId === "string"
          ? callerNativeId(
              agentId,
              id ?? (selected as Adapter & { hostId?: string }).hostId,
            )
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
        const primary =
          positions?.[0] === 0 && typeof args[0] === "string"
            ? parseAgentId(args[0])
            : null;
        if (primary && primary.hostId !== bound) {
          if (!owner.hostOnline(primary.hostId))
            throw new Error(foreignIdentityRefusal(primary.hostId));
          const rideAlong = args.slice();
          for (const position of (positions ?? []).slice(1)) {
            const parsed =
              typeof rideAlong[position] === "string"
                ? parseAgentId(rideAlong[position] as string)
                : null;
            if (parsed && parsed.hostId !== primary.hostId)
              rideAlong[position] = undefined;
          }
          const sourceInput = rideAlong[1];
          if (
            (property === "askPlanner" || property === "askReviewer") &&
            sourceInput &&
            typeof sourceInput === "object" &&
            "sourceAgentId" in sourceInput
          ) {
            const input = sourceInput as { sourceAgentId?: unknown };
            const parsed =
              typeof input.sourceAgentId === "string"
                ? parseAgentId(input.sourceAgentId)
                : null;
            rideAlong[1] = {
              ...input,
              ...(parsed && parsed.hostId !== primary.hostId
                ? { sourceAgentId: undefined }
                : {}),
            };
          }
          return owner.withHost(primary.hostId, () =>
            (
              proxy as unknown as Record<
                string,
                (...callArgs: unknown[]) => unknown
              >
            )[String(property)](...rideAlong),
          );
        }
        const normalized = args.slice();
        for (const position of positions ?? [])
          if (normalized[position] !== undefined)
            normalized[position] = native(normalized[position]);
        if (
          (property === "askPlanner" || property === "askReviewer") &&
          normalized[1] &&
          typeof normalized[1] === "object" &&
          "sourceAgentId" in normalized[1]
        ) {
          const input = normalized[1] as { sourceAgentId?: unknown };
          normalized[1] = {
            ...input,
            ...(input.sourceAgentId === undefined
              ? {}
              : { sourceAgentId: native(input.sourceAgentId) }),
          };
        }
        if (property === "observationInventory" && Array.isArray(normalized[0]))
          normalized[0] = (normalized[0] as unknown[]).map(native);
        try {
          const result: unknown = value.apply(selected, normalized);
          return result instanceof Promise
            ? result.catch((error) => {
                throw recordCall(id, property, error);
              })
            : result;
        } catch (error) {
          throw recordCall(id, property, error);
        }
      };
    },
    set: (selectedFallback, property, value) =>
      Reflect.set(selectedFallback, property, value, selectedFallback),
  });
  return proxy;
}
