/**
 * One caller-resolution order for every host and thread kind.
 *
 * An explicit ticket is chosen before this module runs. Here the service proves
 * the calling thread on a live host, then names the current run's ticket from
 * that identity (even when the shell environment is stale), then a participant
 * ticket, then the host-verified identity itself. A slow host never times out
 * silently: the caller hears "The host is slow; retry".
 */
import { existsSync } from "node:fs";
import { formatAgentId } from "../../shared/agent-identity";
import { hostKindOf, type HostKind } from "../../shared/host-kind";
import type { Run } from "../../shared/contracts";
import { runTicketPath } from "./agent-creation";

export const HOST_CALLER_OBSERVE_MS = 8_000;
export const HOST_CALLER_RESOLVE_TIMEOUT_MS = 10_000;
export const HOST_SLOW_RETRY = "The host is slow; retry";

export type HostCallerIdentity = {
  caller: string;
  hostId: string;
  source: "host";
  runTicket?: string;
  participantTicket?: string;
};

export type HostCallerObserve = (
  hostId: string,
  nativeAgentId: string,
) => Promise<{ id: string; status: string } | null | undefined>;

export interface HostCallerPorts {
  onlineIds(): string[];
  observe: HostCallerObserve;
  unreleasedRuns?(caller: string, hostId: string): Run[];
  helperPath?: string;
  participantTicket?(caller: string): Promise<string | undefined>;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isSlow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === HOST_SLOW_RETRY || /timed out/i.test(message);
}

async function observeThread(
  observe: HostCallerObserve,
  hostId: string,
  nativeAgentId: string,
): Promise<{ id: string; status: string } | null> {
  try {
    const observation = await withTimeout(
      Promise.resolve(observe(hostId, nativeAgentId)),
      HOST_CALLER_OBSERVE_MS,
      HOST_SLOW_RETRY,
    );
    return observation ?? null;
  } catch (error) {
    if (isSlow(error)) throw new Error(HOST_SLOW_RETRY);
    throw error;
  }
}

function currentRunTicket(
  ports: HostCallerPorts,
  caller: string,
  hostId: string,
): string | undefined {
  if (!ports.unreleasedRuns || !ports.helperPath) return undefined;
  const runs = ports.unreleasedRuns(caller, hostId);
  const current = runs.at(-1);
  if (!current) return undefined;
  const path = runTicketPath({ helperPath: ports.helperPath }, current.id);
  return existsSync(path) ? path : undefined;
}

/**
 * Prove the calling thread on an online host of its kind, then attach the
 * current run ticket and any participant ticket that identity already holds.
 */
export async function resolveHostCallerIdentity(
  ports: HostCallerPorts,
  input: { hostKind: HostKind; nativeAgentId: string; hostScope?: string },
): Promise<HostCallerIdentity> {
  const hosts = ports
    .onlineIds()
    .filter((id) => hostKindOf(id) === input.hostKind);
  let hostId: string;
  if (input.hostKind === "t3code") {
    const owners: string[] = [];
    let slow = false;
    for (const candidate of hosts) {
      try {
        const observation = await observeThread(
          ports.observe,
          candidate,
          input.nativeAgentId,
        );
        if (
          observation?.id === input.nativeAgentId &&
          observation.status !== "gone"
        )
          owners.push(candidate);
      } catch (error) {
        if (isSlow(error)) slow = true;
        /* A host that cannot verify this thread is not an owner. */
      }
    }
    if (owners.length !== 1) {
      if (slow && owners.length === 0) throw new Error(HOST_SLOW_RETRY);
      const online = hosts.length ? hosts.join(", ") : "(none)";
      const reason =
        owners.length > 1 ? "is ambiguous" : "is not owned by any online host";
      throw new Error(
        `T3Code thread ${input.nativeAgentId} ${reason}; online T3 hosts: ${online}`,
      );
    }
    hostId = owners[0]!;
  } else if (input.hostKind === "bb") {
    const owners: string[] = [];
    let slow = false;
    for (const candidate of hosts) {
      try {
        const observation = await observeThread(
          ports.observe,
          candidate,
          input.nativeAgentId,
        );
        if (
          observation?.id === input.nativeAgentId &&
          observation.status !== "gone"
        )
          owners.push(candidate);
      } catch (error) {
        if (isSlow(error)) slow = true;
        /* A host that cannot verify this thread is not an owner. */
      }
    }
    if (owners.length !== 1) {
      if (slow && owners.length === 0) throw new Error(HOST_SLOW_RETRY);
      const online = hosts.length ? hosts.join(", ") : "(none)";
      const reason =
        owners.length > 1 ? "is ambiguous" : "is not owned by any online host";
      throw new Error(
        `BB thread ${input.nativeAgentId} ${reason}; online BB hosts: ${online}`,
      );
    }
    hostId = owners[0]!;
  } else {
    if (hosts.length !== 1)
      throw new Error(
        `Calling host identity is unavailable or ambiguous for ${input.hostKind}`,
      );
    hostId = hosts[0]!;
    try {
      const observation = await observeThread(
        ports.observe,
        hostId,
        input.nativeAgentId,
      );
      if (
        observation &&
        (observation.id !== input.nativeAgentId ||
          observation.status === "gone")
      )
        throw new Error(
          `Calling thread ${input.nativeAgentId} is not owned by any online host`,
        );
    } catch (error) {
      if (isSlow(error)) throw new Error(HOST_SLOW_RETRY);
      const message = error instanceof Error ? error.message : String(error);
      if (/is not owned by any online host/.test(message)) throw error;
      /* A host that cannot observe still owns the sole online identity of this kind. */
    }
  }
  const caller = formatAgentId(hostId, input.nativeAgentId);
  const runTicket = currentRunTicket(ports, caller, hostId);
  const participantTicket = await ports.participantTicket?.(caller);
  return {
    caller,
    hostId,
    source: "host",
    ...(runTicket ? { runTicket } : {}),
    ...(participantTicket ? { participantTicket } : {}),
  };
}
