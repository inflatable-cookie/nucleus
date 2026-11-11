/**
 * Call recovery across a service roll (service-boundary contract, "Rolls:
 * calls wait out the replacement").
 *
 * A call whose transport fails while the service is being replaced is no longer
 * lost: a read waits, bounded, for the replacement and answers from it; a
 * mutation carries a client-minted request key, asks the replacement for that
 * request's recorded outcome (`service.request-outcome`, backed by the request
 * ledger in `core/runtime/request-ledger.ts` and typed in
 * `shared/request-outcome.ts`) and returns the real answer — applied,
 * refused, or proven not received. A resend happens only after a proven
 * non-receipt, never blindly; "unknown" survives only where no service ever
 * recorded anything.
 *
 * The CLI client and the Paseo plugin bridge share this module, so both
 * surfaces answer the same way.
 */
import { randomUUID, createHash } from "node:crypto";
import { ServiceRequestError } from "./client";
import type { ServiceErrorCode } from "./protocol";
import { readServiceRoll } from "./discovery";
import type { ServiceRoll } from "../service-roll";
import type { RequestOutcome } from "../request-outcome";

export type { RequestOutcome };

/** A roll record older than this is not waited on; it is stale. */
const STALE_ROLL_MS = 15 * 60_000;

/** A fresh deferred, typechecking, replacing or retrying roll is worth waiting out. */
export function rollInProgress(roll: ServiceRoll | null): roll is ServiceRoll {
  if (!roll || !["deferred", "typechecking", "replacing", "retrying"].includes(roll.status)) return false;
  const at = Date.parse(roll.at);
  return Number.isFinite(at) && Date.now() - at < STALE_ROLL_MS;
}

/** Whether the recorded roll says a replacement is (still) underway for this data directory. */
export function rollWaitWorthy(dataDir: string): boolean {
  const roll = readServiceRoll(dataDir);
  return rollInProgress(roll) && ["replacing", "retrying"].includes(roll.status);
}

/** `service.request-outcome`'s answer, shaped and bounded; anything else fails closed. */
export function parseRequestOutcome(value: unknown): RequestOutcome {
  const status = (value as { status?: unknown } | null)?.status;
  if (typeof status === "string" && ["applied", "refused", "pending", "not_received"].includes(status)) return value as RequestOutcome;
  throw new Error("service.request-outcome answered an unknown shape");
}

/**
 * Recovery passes: one outcome ask plus, when proven not received, one proven
 * resend each. Three covers a roll that loses two responses in a row; past
 * that the honest answer is unknown, named with the key.
 */
export const ROLL_RECOVERY_PASSES = 3;

export interface RollRecoveryOptions {
  method: string;
  mutating: boolean;
  /**
   * One attempt against whatever service is currently reachable. A mutating
   * attempt carries the recovery key; a read carries none. The closure
   * re-resolves its own connection, so an attempt after the wait lands on the
   * replacement.
   */
  attempt: (key: string | undefined) => Promise<unknown>;
  /**
   * Wait until a service that can answer is available again, and return it.
   * `remainingMs` bounds this wait inside the whole recovery. Returns null
   * when there is nothing worth waiting for (no roll in progress): the caller
   * keeps today's immediate-failure behavior. Throws, with the roll context,
   * when a roll was underway but outlived the bound.
   */
  awaitService: (remainingMs: number) => Promise<unknown>;
  /** Ask one connected service for a request key's recorded outcome. */
  askOutcome: (client: unknown, key: string) => Promise<RequestOutcome>;
  /** The read-only method (or read plus argument hint) that confirms this mutation. */
  confirmingRead: (input: unknown) => string;
  input: unknown;
  /** Bound for the whole recovery; the roll's own readiness window in practice. */
  waitMs: number;
  /**
   * A mutation lost its response with no roll underway: nothing was or can be
   * recorded. The CLI keeps its established wording here; the bridge rethrows
   * the transport failure. Omitting it falls back to the generic unknown.
   */
  unknownWhenUnwaited?: (key: string, attemptError: unknown) => Error;
  now?: () => number;
}

/** The catalogue request was never dispatched; retrying cannot duplicate it. */
export class CallNotSentError extends Error {
  constructor(readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/** A mutation whose response was lost and whose key carries no recorded outcome. */
export class UnknownOutcomeError extends Error {
  constructor(readonly method: string, readonly key: string, readonly confirmingRead: string, detail: string) {
    super(`Outcome of ${method} is unknown: ${detail} The request key is ${key}; ask service.request-outcome with {"key":"${key}"} for the recorded outcome once a service answers. Confirm it with the read-only ${confirmingRead} before any retry; Nucleus resent it only after a proven non-receipt.`);
    this.name = "UnknownOutcomeError";
  }
}

/**
 * Whether this failure is one a replacement can still settle: the connection
 * dropped (or was never answered) while the request may have reached the
 * service, or the service answered `draining` — a refusal before dispatch that
 * names the replacement as the answer's home. Definite answers (a typed
 * refusal, invalid input, backpressure) are final and never recovered over.
 */
export function uncertainTransportFailure(error: unknown): boolean {
  if (error instanceof ServiceRequestError) {
    if (error.code === "draining" || error.code === "unavailable") return true;
    return error.code === "timeout" && /timed out after/.test(error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Service socket closed|ECONNRESET|EPIPE|socket hang up|Connection reset|Connection closed/i.test(message);
}

/**
 * Run one catalogue call with roll recovery. See the module comment: reads
 * wait out the replacement and answer from it; mutations recover their real
 * recorded outcome, resending only what a replacement proves it never
 * received.
 */
export async function callWithRollRecovery(options: RollRecoveryOptions): Promise<unknown> {
  const { method, mutating } = options;
  const now = options.now ?? (() => Date.now());
  const key = mutating ? randomUUID() : undefined;
  const deadline = now() + options.waitMs;
  let attemptError: unknown;
  try {
    return await options.attempt(key);
  } catch (error) {
    if (!(error instanceof CallNotSentError) && !uncertainTransportFailure(error)) throw error;
    attemptError = error;
  }
  let passes = 0;
  let resends = 0;
  while (true) {
    let waited: unknown;
    try {
      waited = await options.awaitService(Math.max(1_000, deadline - now()));
    } catch (error) {
      if (!mutating || attemptError instanceof CallNotSentError) throw error;
      throw new UnknownOutcomeError(method, key!, options.confirmingRead(options.input),
        "its response was lost and no service could answer with its recorded outcome.");
    }
    if (!waited) {
      if (attemptError instanceof CallNotSentError) throw attemptError.failure;
      // Nothing worth waiting for: keep today's behavior exactly.
      if (mutating) {
        if (options.unknownWhenUnwaited) throw options.unknownWhenUnwaited(key!, attemptError);
        throw new UnknownOutcomeError(method, key!, options.confirmingRead(options.input),
          "its response was lost while no service roll was underway, and no recorded outcome answers for it.");
      }
      throw attemptError;
    }
    if (!mutating || attemptError instanceof CallNotSentError) {
      // A read or an undispatched request is safe to re-issue.
      try { return await options.attempt(key); } catch (error) {
        if ((!(error instanceof CallNotSentError) && !uncertainTransportFailure(error)) || now() >= deadline) throw error;
        attemptError = error;
        await sleep(Math.min(250, Math.max(25, deadline - now())));
        continue;
      }
    }
    passes++;
    let outcome: RequestOutcome;
    try {
      outcome = await options.askOutcome(waited, key!);
    } catch {
      if (now() >= deadline) {
        throw new UnknownOutcomeError(method, key!, options.confirmingRead(options.input),
          `its response was lost during a service roll, and no service answered with a recorded outcome within ${Math.round(options.waitMs / 1000)} seconds.`);
      }
      await sleep(Math.min(250, Math.max(25, deadline - now())));
      continue;
    }
    if (outcome.status === "applied") {
      if (outcome.truncated) {
        throw new Error(`Outcome of ${method}: it was applied (request key ${key}), but its result is too large to carry across the service roll. Read it with the read-only ${options.confirmingRead(options.input)} before acting again.`);
      }
      return outcome.result;
    }
    if (outcome.status === "refused") {
      // Exactly the typed answer the lost response carried.
      throw new ServiceRequestError(outcome.code as ServiceErrorCode, outcome.message);
    }
    if (outcome.status === "pending") {
      // The first copy is still being served; its outcome lands in the ledger.
      if (now() >= deadline) {
        throw new UnknownOutcomeError(method, key!, options.confirmingRead(options.input),
          "its request is still recorded as received, with no settled outcome yet.");
      }
      await sleep(Math.min(500, Math.max(50, deadline - now())));
      continue;
    }
    // not_received: the service has no record, so resending is proven safe.
    if (passes >= ROLL_RECOVERY_PASSES || now() >= deadline) {
      throw new UnknownOutcomeError(method, key!, options.confirmingRead(options.input),
        `its response was lost during a service roll; ${resends} resend${resends === 1 ? "" : "s"} each followed a proven non-receipt and never answered.`);
    }
    resends++;
    try {
      return await options.attempt(key);
    } catch (error) {
      if (!(error instanceof CallNotSentError) && !uncertainTransportFailure(error)) throw error;
      attemptError = error;
      await sleep(Math.min(250, Math.max(25, deadline - now())));
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * The read-only method (or read plus argument hint) that confirms one mutating
 * method, for the guidance every unknown outcome names. Both client surfaces
 * share it, so a caller hears the same confirming read everywhere.
 */
export function confirmationRead(method: string, input: unknown): string {
  if (method === "queue.operation-status" && typeof input === "object" && input !== null && "operationId" in input && typeof input.operationId === "string")
    return `queue.operation-status with operationId ${input.operationId}`;
  if (method === "queue.operation-start" && typeof input === "object" && input !== null && "key" in input && typeof input.key === "string") {
    const operationId = createHash("sha256").update(`operation\n${input.key}`).digest("hex");
    return `queue.operation-status with operationId ${operationId}`;
  }
  if (method === "queue.bulk-disposition-retry") return "queue.bulk-disposition-detail";
  if (method.startsWith("papercut.")) return method === "papercut.add" ? "papercut.list" : "papercut.get";
  if (method.startsWith("lead.")) return ["lead.add", "lead.import", "lead.submit"].includes(method) ? "lead.list" : "lead.get";
  if (method.startsWith("decision.")) return ["decision.add", "decision.supersede"].includes(method) ? "decision.list" : "decision.get";
  if (method.startsWith("project.")) return "project.get";
  if (method.startsWith("repository.")) return "repository.get";
  if (method === "lane.document.edit") return "lane.document.get";
  if (method.startsWith("lane.")) return "lanes";
  if (method === "plan.set") return "plan.get";
  if (method === "host.run.capacity.release") return "host.run.list";
  if (method === "host.run.accounting.dispose" && typeof input === "object" && input !== null && "runId" in input && typeof input.runId === "string")
    return `host.run.accounting.status with runId ${input.runId}`;
  if (method.startsWith("backup.")) return "backup.list";
  if (method === "queue.bulk-disposition" || method === "queue.bulk-disposition-retry") return "queue.bulk-disposition-detail";
  if (["queue.task", "queue.remove", "queue.completion-subscription", "queue.reparent"].includes(method)) return "queue.detail";
  if (["queue.pool", "queue.profile", "queue.control", "queue.availability", "queue.refresh", "queue.capacity"].includes(method)) return "queue.ui-snapshot";
  return "queue.snapshot";
}
