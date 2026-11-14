import type { ServiceStartupFailure } from "../../../shared/service/discovery";

/**
 * The startup output one spawned service is allowed to keep.
 *
 * A service child's stdout/stderr is unbounded and may carry a credential, so it
 * is captured into a bounded, redacted tail that survives the child's exit. This
 * module owns that mechanism: the environment secrets to redact, the chunked
 * boundary that never splits a secret in half, the byte bound and the failure
 * record the bridge writes when a start never became ready.
 */
export const OUTPUT_TAIL_BYTES = 2_000;

const STARTUP_SENSITIVE_ENV_KEY = /(credential|token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|bearer)/i;
const STARTUP_TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];
const STARTUP_SENSITIVE_NAME = /credential|token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|bearer/i;
const STARTUP_SENSITIVE_ASSIGNMENT = /((?:["']?[\w.-]{0,64}(?:credential|token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|bearer)[\w.-]{0,64}["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const STARTUP_CAPTURE_CARRY_CHARS = 1_024;

export type CapturedStream = { pending: string; tail: Buffer };
export type StartupCapture = {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  spawnError: string | null;
  stdout: CapturedStream;
  stderr: CapturedStream;
  redactions: string[];
  closed: boolean;
  sealed: boolean;
};

export function newStartupCapture(env: NodeJS.ProcessEnv): StartupCapture {
  const redactions = Object.entries(env)
    .filter(([key, value]) => STARTUP_SENSITIVE_ENV_KEY.test(key) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value!);
  return {
    pid: null, exitCode: null, signal: null, spawnError: null,
    stdout: { pending: "", tail: Buffer.alloc(0) }, stderr: { pending: "", tail: Buffer.alloc(0) },
    redactions, closed: false, sealed: false,
  };
}

export function captureStartupChunk(capture: StartupCapture, streamName: "stdout" | "stderr", chunk: Buffer) {
  if (capture.sealed) return;
  const stream = capture[streamName];
  const combined = stream.pending + chunk.toString("utf8");
  const carry = Math.max(STARTUP_CAPTURE_CARRY_CHARS, ...capture.redactions.map(secret => secret.length));
  let cutoff = Math.max(0, combined.length - carry);
  // Keep any secret that straddles the boundary intact so the next chunk can
  // redact it before any of its bytes are committed to the retained tail.
  let moved = true;
  while (moved && cutoff > 0) {
    moved = false;
    for (const secret of capture.redactions) {
      let index = combined.indexOf(secret, Math.max(0, cutoff - secret.length + 1));
      while (index >= 0 && index < cutoff) {
        if (index + secret.length > cutoff) { cutoff = index; moved = true; }
        index = combined.indexOf(secret, index + 1);
      }
    }
  }
  stream.pending = combined.slice(cutoff);
  if (cutoff > 0) stream.tail = appendBoundedTail(stream.tail, redactStartupText(combined.slice(0, cutoff), capture.redactions));
}

export function sealStartupCapture(capture: StartupCapture) {
  if (capture.sealed) return;
  for (const name of ["stdout", "stderr"] as const) {
    const stream = capture[name];
    if (stream.pending) stream.tail = appendBoundedTail(stream.tail, redactStartupText(stream.pending, capture.redactions));
    stream.pending = "";
  }
  capture.sealed = true;
}

function appendBoundedTail(previous: Buffer, text: string): Buffer {
  const joined = Buffer.concat([previous, Buffer.from(text)]);
  return joined.subarray(Math.max(0, joined.length - OUTPUT_TAIL_BYTES));
}

export function redactStartupText(text: string, secrets: readonly string[]): string {
  let output = STARTUP_SENSITIVE_NAME.test(text) ? text.replace(STARTUP_SENSITIVE_ASSIGNMENT, "$1[redacted]") : text;
  for (const pattern of STARTUP_TOKEN_PATTERNS) output = output.replace(pattern, "[redacted]");
  for (const secret of secrets) output = output.split(secret).join("[redacted]");
  return output;
}

/** A spawn failure's errno code, or a stable phrase when the error carries none. */
export function safeSpawnErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_-]{1,32}$/.test(code) ? code : "spawn failure";
}

/** The durable record of a start that never became ready, from the capture it kept. */
export function startupFailureRecord(capture: StartupCapture | null, reason: string): ServiceStartupFailure | null {
  if (!capture) return null;
  const output = [
    capture.stdout.tail.length ? `stdout: ${capture.stdout.tail.toString("utf8")}` : "",
    capture.stderr.tail.length ? `stderr: ${capture.stderr.tail.toString("utf8")}` : "",
  ].filter(Boolean).join(" ");
  const boundedOutput = Buffer.from(output).subarray(-OUTPUT_TAIL_BYTES).toString("utf8");
  return {
    at: new Date().toISOString(), reason: reason.slice(0, 256), pid: capture.pid,
    exitCode: capture.exitCode, signal: capture.signal, spawnError: capture.spawnError,
    output: boundedOutput,
  };
}

export function startupFailureSummary(failure: ServiceStartupFailure): string {
  const context = failure.spawnError
    ? `spawn error ${failure.spawnError}`
    : failure.exitCode !== null
      ? `child exited with code ${failure.exitCode}`
      : failure.signal
        ? `child terminated by ${failure.signal}`
        : failure.pid ? `child pid ${failure.pid} did not exit before readiness timed out` : "child did not start";
  return failure.output ? `${context}; ${failure.output}` : context;
}
