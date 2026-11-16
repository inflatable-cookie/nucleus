/**
 * The framed wire codec the Nucleus service socket speaks (Contract 007), kept
 * inside the plugin package on purpose.
 *
 * A BB plugin is installed as a directory and built by BB from that directory
 * alone, so it cannot import `shared/service/protocol.ts` across a copy. This file
 * is a deliberate, pinned copy of the two directions the channel uses: the plugin
 * writes one framed answer and reads framed requests. `test/bb-plugin-protocol.test.ts`
 * compares this implementation against the shared owner byte for byte, so a drift
 * fails the affected run instead of corrupting a live socket.
 */
import type { Socket } from "node:net";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(readonly code: "invalid_input" | "oversize" | "protocol_version", message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface ServiceRequest {
  v: number;
  id: string;
  method: string;
  input: unknown;
}

export interface ServiceResponse {
  v: number;
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new ProtocolError("oversize", `Frame of ${body.length} bytes exceeds the ${MAX_FRAME_BYTES} byte protocol bound`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export function createFrameReader(onFrame: (frame: unknown) => void, onFail: (error: ProtocolError) => void, maxBytes = MAX_FRAME_BYTES) {
  let buffer: Buffer = Buffer.alloc(0);
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

/** Narrow one decoded frame to a request the plugin can answer, or null. */
export function asServiceRequest(frame: unknown): ServiceRequest | null {
  if (typeof frame !== "object" || frame === null) return null;
  const candidate = frame as Record<string, unknown>;
  if (candidate.v !== PROTOCOL_VERSION) return null;
  if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 121) return null;
  if (typeof candidate.method !== "string" || candidate.method.length === 0 || candidate.method.length > 121) return null;
  return { v: PROTOCOL_VERSION, id: candidate.id, method: candidate.method, input: candidate.input ?? null };
}

/** Write one framed value, refusing instead of growing an unbounded socket buffer. */
export function writeFrame(socket: Socket, value: unknown): void {
  if (socket.destroyed || socket.writableEnded) throw new Error("The service socket is closed");
  socket.write(encodeFrame(value));
}
