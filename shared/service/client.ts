/**
 * Authenticated client for the local Queue service.
 *
 * Pipelines bounded framed requests over the owner-only socket, validates no
 * schemas itself (both ends validate with the shared contracts) and fails
 * closed: oversize frames, protocol errors and timeouts destroy the
 * connection instead of guessing.
 */
import { waitsForSettlement } from "./settlement-wait";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION, DEFAULT_REQUEST_TIMEOUT_MS, MAX_IN_FLIGHT, REQUEST_ID_PATTERN,
  ProtocolError, createFrameReader, encodeFrame, parseRequest,
  type ServiceErrorCode, type ServiceResponse,
} from "./protocol";

export interface ServiceClientOptions {
  socketPath: string;
  credential: string;
  requestTimeoutMs?: number;
  maxInFlight?: number;
}

export class ServiceRequestError extends Error {
  constructor(readonly code: ServiceErrorCode, message: string) {
    super(`Queue service request failed (${code}): ${message}`);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export class ServiceClient {
  private socket: Socket | null = null;
  private pending = new Map<string, Pending>();
  /** Ids issued by this client; bounded, so a fabricated id fails closed while an expired one is a stray. */
  private issuedIds = new Map<string, true>();
  private readonly options: Required<Pick<ServiceClientOptions, "requestTimeoutMs" | "maxInFlight">> & ServiceClientOptions;
  private connectPromise: Promise<void> | null = null;

  constructor(options: ServiceClientOptions) {
    this.options = { requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS, maxInFlight: MAX_IN_FLIGHT, ...options };
  }

  get connected() { return Boolean(this.socket && !this.socket.destroyed); }
  get inFlight() { return this.pending.size; }

  /** Connect and authenticate once; concurrent callers share one handshake. */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.establish().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private establish(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.teardown();
        reject(error);
      };
      const socket = connect(this.options.socketPath);
      socket.setTimeout(5000, () => { socket.destroy(); fail(new Error("Service socket connect timed out")); });
      socket.on("error", error => fail(new Error(`Service socket connect failed: ${error.message}`)));
      socket.on("connect", () => {
        socket.setTimeout(0);
        const reader = createFrameReader(
          frame => this.onFrame(frame),
          error => this.teardown(new ProtocolError(error.code, error.message)),
        );
        socket.on("data", chunk => reader.feed(chunk));
        socket.on("error", error => this.teardown(new Error(error.message)));
        socket.on("close", () => this.teardown(new Error("Service socket closed")));
        this.socket = socket;
        // First frame is always the credential handshake.
        const id = randomUUID();
        this.send({ v: PROTOCOL_VERSION, id, method: "service.auth", input: { credential: this.options.credential } }, id);
        this.pending.set(id, {
          resolve: () => {
            settled = true;
            resolve();
          },
          reject: (error: Error) => fail(error),
          timer: setTimeout(() => fail(new ServiceRequestError("timeout", "Authentication timed out")), this.options.requestTimeoutMs),
        });
      });
    });
  }

  private onFrame(frame: unknown) {
    if (typeof frame !== "object" || frame === null) { this.teardown(new ProtocolError("invalid_input", "Response is not an object")); return; }
    const candidate = frame as Record<string, unknown>;
    if (candidate.v !== PROTOCOL_VERSION) { this.teardown(new ProtocolError("protocol_version", "Service spoke an unsupported protocol version")); return; }
    const id = typeof candidate.id === "string" && REQUEST_ID_PATTERN.test(candidate.id) ? candidate.id : null;
    if (!id) { this.teardown(new ProtocolError("invalid_input", "Response id is missing or out of bounds")); return; }
    const waiter = this.pending.get(id);
    if (!waiter) {
      // A late response for a request this client actually issued is a stray:
      // ignore it. An id this client never issued means the stream is no longer
      // framed by our own requests; fail closed.
      if (!this.issuedIds.has(id)) this.teardown(new ProtocolError("invalid_input", `Response for unknown request ${id}`));
      return;
    }
    this.pending.delete(id);
    this.issuedIds.delete(id);
    clearTimeout(waiter.timer);
    if (candidate.error) {
      const error = candidate.error as { code?: unknown; message?: unknown };
      waiter.reject(new ServiceRequestError(
        typeof error.code === "string" ? error.code as ServiceErrorCode : "internal",
        typeof error.message === "string" ? error.message : "Service returned a typed error",
      ));
      return;
    }
    waiter.resolve(candidate.result ?? null);
  }

  private send(request: unknown, id?: string) {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Service socket is not connected");
    if (socket.bufferSize > 32 * 1024 * 1024) { this.teardown(new ServiceRequestError("busy", "Socket write buffer exceeded")); return; }
    socket.write(encodeFrame(request));
    if (id) {
      this.issuedIds.set(id, true);
      // Bounded issued-id memory: expired strays beyond this window fail closed.
      while (this.issuedIds.size > 1024) {
        const oldest = this.issuedIds.keys().next().value;
        if (oldest === undefined) break;
        this.issuedIds.delete(oldest);
      }
    }
  }

  /** One bounded request; the same id never carries a different method. */
  async request(method: string, input: unknown, timeoutMs?: number, via?: "paseo", key?: string): Promise<unknown> {
    if (!this.connected) await this.connect();
    if (this.pending.size >= this.options.maxInFlight) throw new ServiceRequestError("busy", `More than ${this.options.maxInFlight} in-flight service requests`);
    const id = randomUUID();
    return await new Promise<unknown>((resolve, reject) => {
      // Explicit settlement calls own no transport deadline. Socket loss still rejects,
      // and the existing durable request/operation reads reconcile uncertain delivery.
      const waitForSettlement = waitsForSettlement(method, input);
      const timer = waitForSettlement ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new ServiceRequestError("timeout", `${method} timed out after ${timeoutMs ?? this.options.requestTimeoutMs} ms`));
      }, timeoutMs ?? this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // `via` is transport provenance, not a caller claim: only the bridge sets it.
      // `key` is the caller's stable identity for one mutating call (request ledger).
      try { this.send({ v: PROTOCOL_VERSION, id, method, input, ...(via ? { via } : {}), ...(key ? { key } : {}) }, id); } catch (error) { clearTimeout(timer); this.pending.delete(id); this.issuedIds.delete(id); reject(error as Error); }
    });
  }

  /** Typed health read; never inferred from a lost response. */
  async health(timeoutMs?: number): Promise<unknown> {
    return this.request("service.health", {}, timeoutMs);
  }

  private teardown(error: Error = new ServiceRequestError("unavailable", "Connection torn down")) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of pending) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.socket?.destroy();
    this.socket = null;
  }

  close() { this.teardown(new ServiceRequestError("unavailable", "Client closed the service connection")); }
}

// Keep the ServiceResponse type referenced for the wire contract documentation.
export type { ServiceResponse };
