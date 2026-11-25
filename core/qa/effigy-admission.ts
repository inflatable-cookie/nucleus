import { createHash } from "node:crypto";
import { z } from "zod";

export const EFFIGY_ADMISSION_REQUEST_SCHEMA = "effigy.admission-request.v1";
export const ADMISSION_CALLER = "queue:effigy-admission";
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
