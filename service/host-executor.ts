/**
 * The service's side of the reverse host-operation channel (Spec 062, phase 0).
 *
 * A declared `service.host-executor` connection holds one `HostExecutorLink`. On
 * that link the service writes bounded `host.op` requests and the plugin answers
 * them; this file owns the envelope, the deadline and the fault rules, and nothing
 * about BB or the host registry. Phase 0 registers no host, adds no host kind and
 * cannot dispatch a task: the link is a transport, and an adapter that wants host
 * behaviour is a later phase.
 *
 * Fault rules (Spec 062, "Faults"):
 *
 * - one operation's fault settles that operation, never the connection;
 * - a malformed answer, a missing field or a passed deadline is unknown delivery,
 *   because the write may have landed before the answer went wrong;
 * - only a refusal the plugin proved *before* its write is a definite answer
 *   (`invalid_input`, `refused`); `unavailable` and `internal` are reported after a
 *   call that may already have committed, so they are unknown delivery too — a
 *   `threads.spawn` whose environment never arrived is exactly that case, and
 *   resending it would duplicate the thread;
 * - a dropped connection settles every in-flight operation as unknown delivery and
 *   never replays one.
 */
import { randomUUID } from "node:crypto";
import {
  HOST_OPERATION_DEADLINE_MS,
  HOST_OPERATION_METHOD,
  isHostOperationNonDelivery,
  type HostExecutorDeclaration,
  type HostOperationFailure,
  type HostOperationName,
  type HostOperationOutcome,
} from "../shared/host-operation";
import {
  parseHostOperationFailure,
  parseHostOperationOutcome,
  parseHostOperationRequest,
  type Parsed,
} from "../shared/service/host-channel";
import {
  PROTOCOL_VERSION,
  type ServiceRequest,
} from "../shared/service/protocol";

/** A request the plugin answered with a bounded refusal: the write could not have landed. */
export class HostOperationRefusedError extends Error {
  constructor(
    readonly op: HostOperationName,
    readonly failure: HostOperationFailure,
  ) {
    super(`Host operation ${op} refused (${failure.code}): ${failure.message}`);
    this.name = "HostOperationRefusedError";
  }
}

/**
 * The operation may or may not have run. A caller must adopt by observation; it may
 * never resend on the strength of this error (Spec 062, decision 6).
 */
export class HostOperationUnknownDeliveryError extends Error {
  constructor(
    readonly op: HostOperationName,
    reason: string,
  ) {
    super(`Host operation ${op} has unknown delivery: ${reason}`);
    this.name = "HostOperationUnknownDeliveryError";
  }
}

/** The caller's deadline elapsed; the original request still owns its reply. */
export class HostOperationTimeoutError extends HostOperationUnknownDeliveryError {
  constructor(
    op: HostOperationName,
    deadlineMs: number,
    readonly late: Promise<HostOperationOutcome>,
  ) {
    super(op, `no answer within ${deadlineMs} ms; delivery remains unknown`);
    this.name = "HostOperationTimeoutError";
  }
}

/** No executor connection is holding this host's role right now. */
export class HostExecutorUnavailableError extends Error {
  constructor(readonly hostId: string) {
    super(`No host executor is connected for ${hostId}`);
    this.name = "HostExecutorUnavailableError";
  }
}

// Reads have no durable effect to reconcile after the caller stops waiting.
const HOST_READS = new Set<HostOperationName>([
  "identity.probe",
  "workspace.inspect",
  "thread.observe",
  "thread.cascade",
  "thread.inventory",
  "thread.read",
  "thread.metadata",
  "thread.interactions",
  "thread.timeline",
  "provider.catalog",
  "environment.list",
  "terminal.list",
  "call.counters",
]);

interface PendingOperation {
  op: HostOperationName;
  resolve: (outcome: HostOperationOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  timedOut: boolean;
  resolveLate: (outcome: HostOperationOutcome) => void;
  rejectLate: (error: Error) => void;
}

export interface HostExecutorLinkOptions {
  hostId: string;
  declaration: HostExecutorDeclaration;
  /** Write one frame on the connection. Throws when the connection is gone. */
  write: (frame: unknown) => void;
  deadlineMs?: number;
  now?: () => number;
}

/**
 * One host executor connection. The link owns its own in-flight operations, so a
 * fault settles exactly the operation it names and the connection stays usable for
 * the next one.
 */
export class HostExecutorLink {
  readonly hostId: string;
  readonly declaration: HostExecutorDeclaration;
  readonly connectedAt = new Date().toISOString();
  private readonly pending = new Map<string, PendingOperation>();
  private readonly expiredReads = new Map<string, HostOperationName>();
  private readonly write: (frame: unknown) => void;
  private readonly deadlineMs: number;
  private closed = false;

  constructor(options: HostExecutorLinkOptions) {
    this.hostId = options.hostId;
    this.declaration = options.declaration;
    this.write = options.write;
    this.deadlineMs = options.deadlineMs ?? HOST_OPERATION_DEADLINE_MS;
  }

  get inFlight(): number {
    return this.pending.size;
  }
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Write one operation and await its bounded answer. The input is validated before
   * anything is written, so a malformed request is refused here and never becomes an
   * uncertain write on the host.
   */
  request(
    op: HostOperationName,
    input: unknown,
  ): Promise<HostOperationOutcome> {
    const parsed: Parsed<{ op: HostOperationName; input: unknown }> =
      parseHostOperationRequest({ op, input });
    if (!parsed.ok)
      return Promise.reject(new HostOperationRefusedError(op, parsed.failure));
    // Keep correlation bounded. Capacity exhaustion refuses before another write;
    // it never turns an unresolved operation into a reason to resend it.
    const retained = [...this.pending.values()].filter(
      (pending) => pending.timedOut,
    ).length;
    const active = this.pending.size - retained;
    if (
      this.closed ||
      active >= 1024 ||
      (!HOST_READS.has(op) && retained >= 1024)
    )
      return Promise.reject(new HostExecutorUnavailableError(this.hostId));
    const id = `host-op-${randomUUID()}`;
    let resolveLate!: (outcome: HostOperationOutcome) => void;
    let rejectLate!: (error: Error) => void;
    const late = new Promise<HostOperationOutcome>((resolve, reject) => {
      resolveLate = resolve;
      rejectLate = reject;
    });
    // A caller may choose observation rather than consume the late answer.
    void late.catch(() => {});
    return new Promise<HostOperationOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.timedOut = true;
        if (HOST_READS.has(op)) {
          this.pending.delete(id);
          this.expiredReads.set(id, op);
          if (this.expiredReads.size > 1024)
            this.expiredReads.delete(this.expiredReads.keys().next().value!);
          rejectLate(
            new HostOperationUnknownDeliveryError(
              op,
              "late read results are discarded",
            ),
          );
        }
        reject(new HostOperationTimeoutError(op, this.deadlineMs, late));
      }, this.deadlineMs);
      timer.unref?.();
      this.pending.set(id, {
        op,
        resolve,
        reject,
        timer,
        timedOut: false,
        resolveLate,
        rejectLate,
      });
      const frame: ServiceRequest = {
        v: PROTOCOL_VERSION,
        id,
        method: HOST_OPERATION_METHOD,
        input: parsed.value,
      };
      try {
        this.write(frame);
      } catch {
        this.settleOperation(
          id,
          "the connection failed before the request was written",
        );
      }
    });
  }

  /**
   * Settle one in-flight operation from an answer frame. Returns false when the frame
   * names no operation this link is waiting for, so the caller can treat it as a
   * protocol fault instead of guessing.
   */
  settle(frame: unknown): boolean {
    if (typeof frame !== "object" || frame === null) return false;
    const answer = frame as {
      v?: unknown;
      id?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (answer.v !== PROTOCOL_VERSION || typeof answer.id !== "string")
      return false;
    const pending = this.pending.get(answer.id);
    if (!pending) {
      const op = this.expiredReads.get(answer.id);
      if (!op) return false;
      // An expired read is still a response to this exact request. Do not let an
      // arbitrary or malformed frame consume its correlation or pass as a reply.
      const valid = answer.error !== undefined
        ? answer.result === undefined && parseHostOperationFailure(answer.error) !== null
        : answer.result !== undefined && parseHostOperationOutcome(op, answer.result).ok;
      if (!valid) return false;
      this.expiredReads.delete(answer.id);
      return true;
    }
    if (answer.error !== undefined) {
      const failure = parseHostOperationFailure(answer.error);
      if (!failure) {
        this.settleOperation(answer.id, "the answer's refusal was malformed");
        return true;
      }
      // A definite refusal is only the one the plugin proved before its write. An
      // `unavailable` or `internal` answer comes from a call that may have
      // committed, so it must never read as permission to send the work again.
      if (isHostOperationNonDelivery(failure.code)) {
        this.settleOperation(
          answer.id,
          null,
          new HostOperationRefusedError(pending.op, failure),
        );
      } else {
        this.settleOperation(
          answer.id,
          `the host answered ${failure.code} after the request was written: ${failure.message}`,
        );
      }
      return true;
    }
    const parsed = parseHostOperationOutcome(pending.op, answer.result);
    if (!parsed.ok) {
      this.settleOperation(answer.id, parsed.failure.message);
      return true;
    }
    this.settleOperation(answer.id, null, null, parsed.value);
    return true;
  }

  /** The connection went away: every in-flight operation is unknown delivery. */
  close(reason = "the connection closed"): void {
    this.closed = true;
    this.expiredReads.clear();
    for (const [id] of this.pending) this.settleOperation(id, reason);
  }

  private settleOperation(
    id: string,
    unknownReason: string | null,
    error?: Error | null,
    outcome?: HostOperationOutcome,
  ) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const failure =
      error ??
      (unknownReason !== null
        ? new HostOperationUnknownDeliveryError(pending.op, unknownReason)
        : outcome
          ? null
          : new HostOperationUnknownDeliveryError(
              pending.op,
              "the answer carried neither a result nor a refusal",
            ));
    if (failure) {
      pending.reject(failure);
      pending.rejectLate(failure);
    } else if (outcome) {
      pending.resolve(outcome);
      pending.resolveLate(outcome);
    }
  }
}
