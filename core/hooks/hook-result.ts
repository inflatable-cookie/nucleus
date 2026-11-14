import { userInfo } from "node:os";
import { EVENT_SCHEMA, RESULT_SCHEMA, hookResultSchema, type HookRecord, type HookResult } from "../../shared/hooks";
import type { ExecutionOutcome } from "../machine/process-exec";

/**
 * The hook result envelope and the evidence a failing execution leaves behind.
 *
 * One owner for the closed result contract and for the bounded, separate facts
 * a failure records: what the wrapper wrote on stdout, its exit status or
 * signal, and the stderr bytes it actually produced. Queue never infers an
 * inner exit code and never claims there was nothing to stop.
 */

/** Bound for a stored stderr excerpt, comfortably inside the record summary limit. */
export const STDERR_EXCERPT_MAX_BYTES = 2000;

/** The existing stored error limit a failing hook's evidence must fit inside. */
export const HOOK_EVIDENCE_MAX_BYTES = 4000;

export function minimalHookEnvironment(eventId: string, schema: string = EVENT_SCHEMA): Record<string, string> {
  // USER is identity metadata needed by host credential discovery, not an
  // arbitrary caller override. Derive it from the launch process's OS identity.
  const username = userInfo().username;
  if (!username) throw new Error("Hook launch user identity is unavailable");
  const env: Record<string, string> = { USER: username, PASEO_QUEUE_EVENT_ID: eventId, PASEO_QUEUE_EVENT_SCHEMA: schema };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const) { const value = process.env[key]; if (value) env[key] = value; }
  return env;
}

export interface ParsedHookResult { result: HookResult }
/** Parse the closed hook result envelope. Any extra stdout bytes are a failure. */
export function parseHookResult(stdout: Buffer, expectedEventId: string): ParsedHookResult | { error: string } {
  const text = stdout.toString("utf8");
  const trimmed = text.trim();
  if (!trimmed) return { error: "Hook produced no result on stdout" };
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return { error: "Hook result is not valid JSON or contains extra bytes" }; }
  const candidate = hookResultSchema.safeParse(parsed);
  if (!candidate.success) return { error: `Hook result is invalid: ${candidate.error.issues.map(issue => issue.message).join("; ")}` };
  if (candidate.data.schema !== RESULT_SCHEMA) return { error: "Hook result schema is unsupported" };
  if (candidate.data.eventId !== expectedEventId) return { error: "Hook result event ID does not match the dispatched event" };
  return { result: candidate.data };
}

/** A bounded UTF-8 stderr excerpt for a failing hook. Never returns unbounded output. */
function boundedStderrExcerpt(stderr: Buffer, maxBytes: number = STDERR_EXCERPT_MAX_BYTES): string {
  const text = stderr.toString("utf8").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // Do not split a UTF-8 sequence: step back over continuation bytes.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}…[truncated]`;
}

/**
 * Task 389: the evidence a hook leaves when its wrapper exited but did not
 * produce an acceptable result. A structured `blocked`/`failed` result, or a
 * result Queue could not parse, used to keep only the summary (or the parse
 * complaint) while a non-zero exit kept its bounded stderr excerpt. The three
 * facts stay separate and none is invented: the wrapper exit status, the result
 * state (or that no usable result came back), and the stderr bytes the program
 * actually wrote. Queue never infers an inner exit code and never claims there
 * was nothing to stop; absent stderr is simply not mentioned.
 */
export function failedResultEvidence(outcome: ExecutionOutcome, detail: string): string {
  const head = `Hook exited with code ${outcome.code ?? "unknown"}${outcome.signal ? ` (${outcome.signal})` : ""} but ${detail}`;
  const separator = "; stderr: ";
  const room = HOOK_EVIDENCE_MAX_BYTES - Buffer.byteLength(head, "utf8") - Buffer.byteLength(separator, "utf8");
  if (room <= 0) return head;
  const excerpt = boundedStderrExcerpt(outcome.stderr, Math.min(STDERR_EXCERPT_MAX_BYTES, room));
  return excerpt ? `${head}${separator}${excerpt}` : head;
}

/** The one description of a failed execution: timeout, output cap, termination and exit. */
export function executionFailure(outcome: ExecutionOutcome, record: HookRecord): string | null {
  const terminationDetail = outcome.terminationError || (outcome.processGroupEmpty === false ? "process group remained after termination" : "");
  if (outcome.timedOut) return `Hook exceeded its ${record.timeoutMs}ms timeout${terminationDetail ? `; ${terminationDetail}` : ""}`;
  if (outcome.stdoutExceeded || outcome.stderrExceeded)
    return `Hook exceeded its ${record.maxOutputBytes}-byte output limit${terminationDetail ? `; ${terminationDetail}` : ""}`;
  if (outcome.terminationError || outcome.processGroupEmpty === false)
    return outcome.terminationError || "Hook process group was not empty after termination";
  if (outcome.code !== 0) {
    const excerpt = boundedStderrExcerpt(outcome.stderr);
    return `Hook exited with code ${outcome.code ?? "unknown"}${outcome.signal ? ` (${outcome.signal})` : ""}${excerpt ? `; stderr: ${excerpt}` : ""}`;
  }
  return null;
}
