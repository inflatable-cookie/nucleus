import { compiledIdentity, stableInstalledPath } from "../../shared/runtime.mjs";
/**
 * Queue's Effigy v0.15 generic admission adapter (Spec 035).
 *
 * Effigy owns workload execution and hook process-group custody. Queue owns
 * host-wide capacity: this module parses the hook request, correlates a durable
 * reservation to the Effigy run, and decides admit / deny / wait. The hook
 * prints exactly `admit` or `deny <reason>` and holds until TERM; it never
 * spawns the workload.
 *
 * Wait rules (Supervisor relay eadc95f2, corrected by task 447):
 * - unreachable service, Queue error, or unrecognized reservation deny promptly
 *   on first contact (no reservation yet);
 * - a live queued reservation needs a still-queued confirmation every 5 s, and
 *   a received reply for its own reservation is itself the confirmation: it
 *   refreshes `lastConfirmedAtMs` before any staleness decision, so an old
 *   earlier reply can never deny a wait the service is still answering. The
 *   service's answer and the reservation's identity are the only proof used;
 *   send time, an unanswered request and a journalled confirm are not;
 * - missing confirmations beyond 60 s deny before workload, and the window is
 *   always measured from the last received valid confirmation, so a run of
 *   unreachable confirms after one still-queued reply denies from that reply;
 * - mid-wait unreachable counts as a missed confirmation, so a service roll's
 *   brief gap does not abort a genuine wait, and a killed/wedged service denies
 *   within the 60 s window instead of Effigy's one-hour hook timeout;
 * - `EFFIGY_ADMISSION_HOOK_TIMEOUT_MS` stays 3600000 in Queue-owned launch env
 *   for genuine confirmed capacity waits. Admission submissions keep the
 *   scheduler's 30-minute capacity deadline; expiry is a deny with that reason.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const EFFIGY_ADMISSION_REQUEST_SCHEMA = "effigy.admission-request.v1";
export const ADMISSION_CALLER = "queue:effigy-admission";
export const QUEUE_ADMISSION_SOCKET_ENV = "QUEUE_ADMISSION_SOCKET";
export const EFFIGY_ADMISSION_HOOK_ENV = "EFFIGY_ADMISSION_HOOK";
export const EFFIGY_ADMISSION_HOOK_TIMEOUT_ENV = "EFFIGY_ADMISSION_HOOK_TIMEOUT_MS";
/** Queue-owned launch value: Effigy's default one-hour ceiling for confirmed waits. */
export const ADMISSION_HOOK_TIMEOUT_MS = 3_600_000;
/**
 * Fresh still-queued confirmation cadence. Longer than contract 010's 5 s
 * reconnect window so a make-before-break roll does not look like a missed
 * beat, and short enough that a wedged service is noticed well before the
 * one-hour hook timeout.
 */
export const ADMISSION_CONFIRM_INTERVAL_MS = 5_000;
/**
 * Bound on missed confirmations while queued (12 beats). Matches the 60 s
 * never-launched client-left grace. A stalled service must deny inside this
 * window, not after an hour.
 */
export const ADMISSION_LIVENESS_MS = 60_000;
export const ADMISSION_CONNECT_TIMEOUT_MS = 2_000;
/**
 * Reserve binds the workload's own attested Effigy before any capacity
 * decision, which digests real bytes. That wait is bounded separately from a
 * plain connect, and still far inside the liveness window and the one-hour hook
 * timeout: a timeout is a deny, never a workload start.
 */
export const ADMISSION_RESERVE_TIMEOUT_MS = 30_000;

const EFFIGY_RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const effigyAdmissionRequestSchema = z.object({
  schema: z.literal(EFFIGY_ADMISSION_REQUEST_SCHEMA),
  run_id: z.string().regex(EFFIGY_RUN_ID, "run_id must be 1–128 of A–Z a–z 0–9 . _ : -"),
  task: z.string().min(1).max(500),
  class: z.literal("heavy"),
  cwd: z.string().min(1),
  root: z.string().min(1),
}).strict();
export type EffigyAdmissionRequest = z.infer<typeof effigyAdmissionRequestSchema>;

export type AdmissionObservation =
  | { kind: "queued"; position: number | null }
  | { kind: "admitted" }
  | { kind: "running" }
  | { kind: "nested" }
  | { kind: "settled"; reason: string }
  | { kind: "unreachable"; message: string }
  | { kind: "error"; message: string }
  | { kind: "unknown" }
  | { kind: "malformed"; message: string };

export type AdmissionWaitDecision =
  | { action: "admit" }
  | { action: "deny"; reason: string }
  | {
    action: "wait";
    nextConfirmAt: number;
    progress: string;
    /**
     * The instant this reply proves the service answered for this reservation,
     * or null when it proves nothing (a missed confirmation). The hook stores it
     * as `lastConfirmedAtMs`, so credit comes from the reply's own evidence and
     * never from a send time, a local retry or a journalled server-side fact.
     */
    confirmedAtMs: number | null;
  };

export interface AdmissionWaitInput {
  nowMs: number;
  hasReservation: boolean;
  lastConfirmedAtMs: number | null;
  observation: AdmissionObservation;
  confirmIntervalMs?: number;
  livenessMs?: number;
}

/** Durable host-run id for an Effigy kernel run. Hex sha256, 64 chars, well under 160. */
export function admissionReservationId(runId: string): string {
  return createHash("sha256").update(`effigy-admission\0${runId}`).digest("hex");
}

export function parseEffigyAdmissionRequest(raw: string | undefined | null):
  { ok: true; request: EffigyAdmissionRequest } | { ok: false; reason: string } {
  if (raw == null || !raw.trim()) return { ok: false, reason: "missing EFFIGY_ADMISSION_REQUEST" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, reason: "malformed EFFIGY_ADMISSION_REQUEST: not JSON" }; }
  const result = effigyAdmissionRequestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "request";
    return { ok: false, reason: `malformed EFFIGY_ADMISSION_REQUEST: ${path} ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, request: result.data };
}

/**
 * Admit, deny promptly, or wait with a confirmation deadline.
 * First-contact unreachable/error/unknown never waits. A reservation that is
 * already queued treats unreachable as a missed confirmation. A still-queued
 * reply is evaluated as fresh before any staleness decision: it is the service
 * answering this reservation now, so the previous reply's age cannot deny it.
 */
export function evaluateAdmissionWait(input: AdmissionWaitInput): AdmissionWaitDecision {
  const confirmIntervalMs = input.confirmIntervalMs ?? ADMISSION_CONFIRM_INTERVAL_MS;
  const livenessMs = input.livenessMs ?? ADMISSION_LIVENESS_MS;
  const observation = input.observation;
  if (observation.kind === "admitted" || observation.kind === "running" || observation.kind === "nested")
    return { action: "admit" };
  if (observation.kind === "malformed") return { action: "deny", reason: observation.message };
  if (observation.kind === "error") return { action: "deny", reason: observation.message };
  if (observation.kind === "unknown") return { action: "deny", reason: "unrecognized reservation" };
  if (observation.kind === "settled") return { action: "deny", reason: observation.reason };
  if (observation.kind === "unreachable") {
    if (!input.hasReservation)
      return { action: "deny", reason: `Queue admission service unreachable: ${observation.message}` };
    if (livenessExpired(input.nowMs, input.lastConfirmedAtMs, livenessMs))
      return { action: "deny", reason: "queued reservation lost liveness: Queue admission service unreachable" };
    return {
      action: "wait",
      nextConfirmAt: input.nowMs + confirmIntervalMs,
      progress: "Queue admission service unreachable; retrying confirmation",
      confirmedAtMs: null,
    };
  }
  // Task 447: the service just answered with this reservation still queued, so
  // this reply is the fresh confirmation. Crediting it before the staleness
  // decision is the difference between a live wait and a denial computed from
  // the age of a reply the service has already superseded. Only a received,
  // authenticated, correlated reply reaches this branch; a timeout, error,
  // unknown, settled, malformed or foreign reply took an earlier return.
  const position = observation.position;
  const progress = position ? `waiting for Queue capacity, position ${position}` : "waiting for Queue capacity";
  return {
    action: "wait",
    nextConfirmAt: input.nowMs + confirmIntervalMs,
    progress,
    confirmedAtMs: input.nowMs,
  };
}

function livenessExpired(nowMs: number, lastConfirmedAtMs: number | null, livenessMs: number): boolean {
  return lastConfirmedAtMs !== null && nowMs - lastConfirmedAtMs > livenessMs;
}

export function formatAdmissionStdout(decision: "admit" | { deny: string }): string {
  return decision === "admit" ? "admit" : `deny ${decision.deny}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function defaultAdmissionHookPath(): string {
  return fileURLToPath(new URL("../../bin/queue-effigy-admission-hook.mjs", import.meta.url));
}

/** Absolute tsx loader in this Queue checkout. Bare `--import tsx` resolves from Effigy's cwd. */
export function defaultAdmissionTsxLoader(): string {
  const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
  if (!existsSync(loader)) throw new Error(`Queue admission hook requires tsx loader at ${loader}`);
  return loader;
}

/**
 * Node-mode launcher prefix for the hook subprocess (task 413).
 *
 * Queue's service can itself run inside Paseo's Electron helper, where
 * `process.execPath` is that helper binary. Effigy runs the hook command itself
 * (`/bin/sh -c` in the invocation cwd), so the helper becomes the hook's own
 * launcher: without Node mode it starts the desktop argument parser, reports
 * `--import` as an unknown option and prints that banner instead of an
 * admit/deny, and the run is refused for a reason that is not admission's. The
 * same bytes in Node mode are the Node runtime the loader needs.
 *
 * The assignment rides inside the command, so the shell applies it to this one
 * child only: the agent shell, the worker/reviewer environment Queue merges and
 * the Effigy workload never inherit it. Plain Node ignores the variable, so the
 * command is byte-identical whichever runtime Queue runs under, and no path is
 * sniffed or resolved.
 */
export const ADMISSION_HOOK_NODE_MODE_ENV = "ELECTRON_RUN_AS_NODE";
export const ADMISSION_HOOK_NODE_MODE_VALUE = "1";

export function defaultAdmissionHookCommand(execPath = process.execPath, hookPath = defaultAdmissionHookPath()): string {
  if (compiledIdentity) return `${ADMISSION_HOOK_NODE_MODE_ENV}=${ADMISSION_HOOK_NODE_MODE_VALUE} ${shellQuote(stableInstalledPath(execPath))} ${shellQuote(stableInstalledPath(hookPath))}`;
  return `${ADMISSION_HOOK_NODE_MODE_ENV}=${ADMISSION_HOOK_NODE_MODE_VALUE}`
    + ` ${shellQuote(execPath)} --import ${shellQuote(defaultAdmissionTsxLoader())} ${shellQuote(hookPath)}`;
}

/** Environment Queue sets on worker/reviewer launches it owns. Never fabricates EFFIGY_ADMITTED. */
export function queueOwnedAdmissionEnvironment(input: {
  hookCommand: string;
  socketPath: string;
  hookTimeoutMs?: number;
}): Record<string, string> {
  return {
    [EFFIGY_ADMISSION_HOOK_ENV]: input.hookCommand,
    [QUEUE_ADMISSION_SOCKET_ENV]: input.socketPath,
    [EFFIGY_ADMISSION_HOOK_TIMEOUT_ENV]: String(input.hookTimeoutMs ?? ADMISSION_HOOK_TIMEOUT_MS),
  };
}

export function mergeAdmissionLaunchEnv(
  base: Record<string, string>,
  admission: Record<string, string> | null | undefined,
): Record<string, string> {
  return admission && Object.keys(admission).length ? { ...base, ...admission } : { ...base };
}
