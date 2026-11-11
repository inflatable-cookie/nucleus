/**
 * Bounded framed JSON protocol for the local Queue service boundary
 * (Contract 007 / Spec 013).
 *
 * Every frame is a single JSON document preceded by a 4-byte big-endian length.
 * Frames are length-bounded and fail closed: an oversized, malformed or
 * wrong-version frame tears the connection down instead of being guessed at.
 * Requests carry protocol version, request id, method and bounded input;
 * responses carry the same id and exactly one validated result or typed error.
 */
import { createHash } from "node:crypto";

/** Bumped only when the wire shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;
/** Hard frame ceiling for both directions; larger frames fail closed. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const MAX_CONNECTIONS = 8;
export const MAX_IN_FLIGHT = 32;

export type ServiceErrorCode =
  | "unauthenticated"
  | "protocol_version"
  | "method_unknown"
  | "invalid_input"
  | "invalid_output"
  | "oversize"
  | "timeout"
  | "busy"
  | "draining"
  | "unavailable"
  | "internal"
  /**
   * A served method refused this request by policy. The service is healthy and
   * the answer is final: the bridge must not treat it as a transport failure.
   * `queue.capacity` is the first such refusal (the Settings-only capacity
   * rule); its typed answer says who owns the setting and that a retry is futile.
   */
  | "refused";

export interface ServiceRequest {
  v: typeof PROTOCOL_VERSION;
  id: string;
  method: string;
  input: unknown;
  /**
   * The caller's stable identity for one mutating call, when it named one.
   * Anything else on the wire fails closed.
   */
  key?: string;
  /**
   * Which surface forwarded this request, when one can say so. Only the Paseo
   * plugin bridge sets it (`ServiceBridge.forward`), which is how the operator's
   * Settings screen reaches the service; a local client (the CLI, a task shell, a
   * contract-010 caller) sends no `via` at all. It is transport provenance for the
   * Settings-only capacity rule, never an authorization claim from the body, and
   * a same-uid process that speaks this frame deliberately is indistinguishable
   * from the bridge — accepted as accident prevention, not authentication.
   */
  via?: "paseo";
}

export interface ServiceError {
  code: ServiceErrorCode;
  message: string;
}

export interface ServiceResponse {
  v: typeof PROTOCOL_VERSION;
  id: string;
  result?: unknown;
  error?: ServiceError;
}

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;
export const METHOD_PATTERN = /^[a-z][a-z0-9._-]{0,120}$/;
/**
 * A client-minted request key on a mutating call (service-boundary contract,
 * "Rolls: calls wait out the replacement"). The client keeps it stable across
 * the recovery of one logical call, and the service records the request's
 * received and settled state under it, so a replacement can answer what
 * happened when the response was lost mid-roll. It rides only on the frame;
 * durable operations keep their own keys inside the input.
 */
export const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;

export class ProtocolError extends Error {
  constructor(readonly code: ServiceErrorCode, message: string, readonly frameBytes?: number) {
    super(message);
  }
}

/** Encode one framed message; throws instead of producing an oversized frame. */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new ProtocolError("oversize", `Frame of ${body.length} bytes exceeds the ${MAX_FRAME_BYTES} byte protocol bound`, body.length);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Incremental frame reader. Returns a feed function for socket chunks and an
 * abort function that fails the connection; oversized or malformed frames fail
 * closed and stop the stream.
 */
export function createFrameReader(onFrame: (frame: unknown) => void, onFail: (error: ProtocolError) => void, maxBytes = MAX_FRAME_BYTES) {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let failed = false;
  const fail = (error: ProtocolError) => {
    if (failed) return;
    failed = true;
    buffer = Buffer.alloc(0);
    onFail(error);
  };
  return {
    feed(chunk: Buffer) {
      if (failed) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (true) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length > maxBytes) { fail(new ProtocolError("oversize", `Frame of ${length} bytes exceeds the ${maxBytes} byte protocol bound`)); return; }
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let frame: unknown;
        try { frame = JSON.parse(body.toString("utf8")); } catch (error) {
          fail(new ProtocolError("invalid_input", `Frame is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        try { onFrame(frame); } catch (error) { fail(new ProtocolError("invalid_input", `Frame handler failed: ${error instanceof Error ? error.message : String(error)}`)); return; }
      }
    },
    get failed() { return failed; },
    fail,
  };
}

/** Stable build identity: generation, protocol, served methods and backend source. */
export function buildIdentity(generation: string, methodNames: readonly string[], sourceDigest: string): string {
  return createHash("sha256").update(JSON.stringify([generation, PROTOCOL_VERSION, [...methodNames].sort(), sourceDigest])).digest("hex").slice(0, 16);
}

/** Parse and validate a request envelope; returns a typed protocol error instead of throwing. */
export function parseRequest(frame: unknown): { ok: true; request: ServiceRequest } | { ok: false; error: ProtocolError } {
  if (typeof frame !== "object" || frame === null) return { ok: false, error: new ProtocolError("invalid_input", "Request is not an object") };
  const candidate = frame as Record<string, unknown>;
  if (candidate.v !== PROTOCOL_VERSION) return { ok: false, error: new ProtocolError("protocol_version", `Unsupported protocol version ${JSON.stringify(candidate.v)}`) };
  if (typeof candidate.id !== "string" || !REQUEST_ID_PATTERN.test(candidate.id)) return { ok: false, error: new ProtocolError("invalid_input", "Request id is missing or out of bounds") };
  if (typeof candidate.method !== "string" || !METHOD_PATTERN.test(candidate.method)) return { ok: false, error: new ProtocolError("invalid_input", "Request method is missing or out of bounds") };
  // One optional bounded field; any other surface value fails closed rather than
  // being guessed at.
  const via = candidate.via;
  if (via !== undefined && via !== "paseo") return { ok: false, error: new ProtocolError("invalid_input", "Request surface `via` is not a known surface") };
  const key = candidate.key;
  if (key !== undefined && (typeof key !== "string" || !REQUEST_KEY_PATTERN.test(key))) return { ok: false, error: new ProtocolError("invalid_input", "Request key is missing or out of bounds") };
  return { ok: true, request: { v: PROTOCOL_VERSION, id: candidate.id, method: candidate.method, input: candidate.input ?? null, ...(via ? { via } : {}), ...(typeof key === "string" ? { key } : {}) } };
}
