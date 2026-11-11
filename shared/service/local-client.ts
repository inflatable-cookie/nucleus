import { dataHome } from "../data-home.mjs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "./protocol";
import { readServiceInfo, readServiceRoll, type ServiceInfo } from "./discovery";
import { ServiceClient } from "./client";
import { RPC_CATALOGUE } from "../rpc-catalogue";
import { rpcContractDigests } from "../rpc-contracts";
import { parseContractValue } from "../schema-refusal";
import { CallNotSentError, callWithRollRecovery, confirmationRead, parseRequestOutcome, rollInProgress, rollWaitWorthy, type RequestOutcome } from "./roll-recovery";
import type { ServiceRoll } from "../service-roll";

export const LOCAL_SERVICE_ROLL_WAIT_MS = 10 * 60_000;
const SERVICE_ROLL_WAIT_POLL_MS = 250;
const SERVICE_ROLL_PROGRESS_MS = 30_000;

export class LocalServiceUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "LocalServiceUnavailable"; }
}

export class LocalServiceContractMismatch extends Error {
  constructor(message: string) { super(message); this.name = "LocalServiceContractMismatch"; }
}

export interface LocalQueueClientOptions {
  compatibilityWaitMs?: number;
  onProgress?: (message: string) => void;
}

function methodMismatch(method: string, roll: ServiceRoll | null): Error {
  if (roll?.status === "failed") {
    return new LocalServiceContractMismatch(`Nucleus service roll failed: ${roll.detail}. The ${method} input/output contract still differs from this CLI.`);
  }
  if (roll?.status && ["deferred", "typechecking", "replacing", "retrying"].includes(roll.status)) {
    return new LocalServiceContractMismatch(`Nucleus ${method} is still incompatible after the service roll stopped reporting progress (${roll.status}${roll.detail ? `: ${roll.detail}` : ""}).`);
  }
  return new LocalServiceContractMismatch(`Nucleus method ${method} is incompatible with the running service: its input/output contract differs or the method is absent, and no service roll is active.`);
}

function rollWaitTimeout(method: string | null, dataDir: string, waitMs: number): Error {
  const roll = readServiceRoll(dataDir);
  if (roll?.status === "failed") return method ? methodMismatch(method, roll) : new Error(`Nucleus service roll failed: ${roll.detail}`);
  const state = roll ? `; latest roll is ${roll.status}${roll.detail ? `: ${roll.detail}` : ""}` : "";
  if (!method && rollInProgress(roll)) {
    const seconds = Math.ceil(waitMs / 1000);
    return new Error(`Nucleus service is still unavailable after ${seconds} second${seconds === 1 ? "" : "s"} while its service roll is in progress${state}`);
  }
  const subject = method ? `Nucleus method ${method} remains incompatible` : "Nucleus service did not answer";
  return new Error(`${subject} after ${Math.ceil(waitMs / 1000)} seconds${state}; inspect the service roll before retrying`);
}

/** Owner-local transport only. It never starts, upgrades or falls back to Paseo. */
export function localQueueClient(
  dataDir = dataHome(),
  options: LocalQueueClientOptions = {},
) {
  const expectedContracts = rpcContractDigests();
  const waitMs = options.compatibilityWaitMs ?? LOCAL_SERVICE_ROLL_WAIT_MS;
  const onProgress = options.onProgress ?? (message => process.stderr.write(`${message}\n`));
  let client: ServiceClient | null = null;
  let clientIdentity = "";
  let lastProgressState = "";
  let lastProgressAt = 0;

  function progress(method: string | null, roll: ServiceRoll | null) {
    const state = roll?.status ?? "waiting for the service socket";
    const detail = roll?.detail ? `: ${roll.detail}` : "";
    const message = `Nucleus service roll ${state}${detail}; waiting${method ? ` to call ${method}` : " for the service to answer"}`;
    const now = Date.now();
    if (state !== lastProgressState || now - lastProgressAt >= SERVICE_ROLL_PROGRESS_MS) {
      onProgress(message);
      lastProgressState = state;
      lastProgressAt = now;
    }
  }

  function validateProtocol(info: ServiceInfo): ServiceInfo {
    validateProtocolVersion(info.protocolVersion);
    return info;
  }

  function validateProtocolVersion(protocolVersion: number) {
    if (protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Nucleus service protocol ${protocolVersion} is incompatible with CLI protocol ${PROTOCOL_VERSION}; reload the Nucleus plugin`);
    }
  }

  function useClient(info: ServiceInfo): ServiceClient {
    const identity = JSON.stringify([info.protocolVersion, info.buildId, info.pid, info.socketPath, info.credential]);
    if (!client || identity !== clientIdentity) {
      client?.close();
      client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
      clientIdentity = identity;
    }
    return client;
  }

  async function connectedClient(method: string | null, budgetMs?: number): Promise<ServiceClient> {
    const deadline = Date.now() + (budgetMs ?? waitMs);
    let sawRoll = false;
    while (true) {
      const roll = readServiceRoll(dataDir);
      const info = readServiceInfo(dataDir);
      if (info) {
        validateProtocol(info);
        const current = useClient(info);
        try {
          await current.connect();
        } catch (error) {
          const latestRoll = readServiceRoll(dataDir);
          if (!rollInProgress(latestRoll) && !sawRoll) throw error;
          sawRoll = true;
          progress(method, latestRoll);
          if (latestRoll?.status === "failed") throw method ? methodMismatch(method, latestRoll) : new Error(`Nucleus service roll failed: ${latestRoll.detail}`);
          if (Date.now() >= deadline) throw rollWaitTimeout(method, dataDir, waitMs);
          await sleep(Math.min(SERVICE_ROLL_WAIT_POLL_MS, deadline - Date.now()));
          continue;
        }
        if (method) {
          const expected = expectedContracts[method];
          if (!expected) throw new Error(`Unknown Queue service method ${method}; bridge-only methods require explicit --via-paseo`);
          let health: { protocolVersion?: unknown; rpcContracts?: Record<string, unknown> };
          try {
            health = await current.health() as { protocolVersion?: unknown; rpcContracts?: Record<string, unknown> };
          } catch (error) {
            const latestRoll = readServiceRoll(dataDir);
            if (!rollInProgress(latestRoll) && !sawRoll) throw error;
            sawRoll = true;
            progress(method, latestRoll);
            if (latestRoll?.status === "failed") throw methodMismatch(method, latestRoll);
            if (Date.now() >= deadline) throw rollWaitTimeout(method, dataDir, waitMs);
            await sleep(Math.min(SERVICE_ROLL_WAIT_POLL_MS, deadline - Date.now()));
            continue;
          }
          if (typeof health.protocolVersion !== "number") throw new Error("Nucleus service health omitted its protocol version");
          validateProtocolVersion(health.protocolVersion);
          if (health.rpcContracts?.[method] !== expected) {
            const latestRoll = readServiceRoll(dataDir);
            if (latestRoll?.status === "failed") throw methodMismatch(method, latestRoll);
            if (!rollInProgress(latestRoll) && !sawRoll) throw methodMismatch(method, latestRoll);
            sawRoll = true;
            progress(method, latestRoll);
            if (Date.now() >= deadline) throw rollWaitTimeout(method, dataDir, waitMs);
            await sleep(Math.min(SERVICE_ROLL_WAIT_POLL_MS, deadline - Date.now()));
            continue;
          }
        }
        return current;
      }

      if (roll?.status === "failed") throw new LocalServiceUnavailable(`Nucleus service roll failed: ${roll.detail}`);
      if (!rollInProgress(roll) && !sawRoll) {
        throw new LocalServiceUnavailable("Nucleus service is unavailable; load the Nucleus plugin before retrying");
      }
      sawRoll = true;
      progress(method, roll);
      if (Date.now() >= deadline) throw rollWaitTimeout(method, dataDir, waitMs);
      await sleep(Math.min(SERVICE_ROLL_WAIT_POLL_MS, deadline - Date.now()));
    }
  }

  return {
    connect: async () => { await connectedClient(null); },
    close: () => { client?.close(); client = null; clientIdentity = ""; },
    async request(method: string, input: unknown) {
      if (method === "service.health") return (await connectedClient(null)).health();
      if (method === "service.profile") return (await connectedClient(null)).request("service.profile", input ?? {}, 90_000);
      // The board link is a service-owned method, not a catalogue call: no contract digest to compare.
      if (method === "service.ui-link") return (await connectedClient(null)).request("service.ui-link", input ?? {}, 30_000);
      // The operator's direct recovery ask after a lost response named its key
      // (request ledger): what did that request's outcome record say?
      if (method === "service.request-outcome") return (await connectedClient(null)).request("service.request-outcome", input ?? {}, 30_000);
      const entry = RPC_CATALOGUE.find(candidate => candidate.name === method);
      if (!entry) throw new Error(`Unknown Queue service method ${method}; bridge-only methods require explicit --via-paseo`);
      const contract = entry.contract as { input: { parse(input: unknown): unknown }; output: { parse(input: unknown): unknown } };
      const parsedInput = parseContractValue(contract.input, input);
      return await callWithRollRecovery({
        method,
        mutating: entry.mutating,
        input: parsedInput,
        waitMs,
        attempt: async key => {
          let activeClient: ServiceClient;
          try { activeClient = await connectedClient(method); }
          catch (error) { throw new CallNotSentError(error); }
          const result = await activeClient.request(method, parsedInput, undefined, undefined, key);
          return parseContractValue(contract.output, result);
        },
        awaitService: remaining => waitThroughRoll(method, remaining),
        askOutcome: async (waited, key) => parseRequestOutcome(await (waited as ServiceClient).request("service.request-outcome", { key }, 30_000)),
        confirmingRead: input2 => confirmationRead(method, input2),
        unknownWhenUnwaited: () => {
          const read = confirmationRead(method, parsedInput);
          const qualifier = read.startsWith("queue.operation-status") ? "" : "read-only ";
          return new Error(`Outcome of ${method} is unknown because its response was lost and Nucleus may have accepted the mutation. Confirm it with the ${qualifier}${read} method before retrying; Nucleus did not retry it.`);
        },
      });
    },
  };

  /**
   * Wait for the replacement when this method can be answered by one: a roll
   * in progress, or a service whose recorded identity no longer matches the
   * connection that just failed. Null keeps today's immediate failure.
   */
  async function waitThroughRoll(method: string | null, budgetMs?: number): Promise<ServiceClient | null> {
    const roll = readServiceRoll(dataDir);
    const info = readServiceInfo(dataDir);
    const identityChanged = Boolean(info && clientIdentity
      && JSON.stringify([info.protocolVersion, info.buildId, info.pid, info.socketPath, info.credential]) !== clientIdentity);
    if (!rollWaitWorthy(dataDir) && roll?.status !== "failed" && !identityChanged) return null;
    return await connectedClient(method, budgetMs);
  }
}

/** Wait for the replacement identity after it disappears during a recorded roll. */
export async function waitForLocalServiceRoll(
  dataDir = dataHome(),
  waitMs = LOCAL_SERVICE_ROLL_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (rollInProgress(readServiceRoll(dataDir))) {
    if (readServiceInfo(dataDir)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw rollWaitTimeout(null, dataDir, waitMs);
    await sleep(Math.min(SERVICE_ROLL_WAIT_POLL_MS, remaining));
  }
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
