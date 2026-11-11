/**
 * Effigy generic admission hook. Queue sets EFFIGY_ADMISSION_HOOK to this
 * command in worker/reviewer environments it launches. The process prints
 * exactly `admit` or `deny <reason>` on stdout, progress on stderr, and holds
 * until TERM. It never spawns the Effigy workload.
 *
 * Liveness credit (Spec 035, "Admission wait", task 447): the only thing that
 * refreshes the confirmation is a reply this hook received for its own issued
 * reservation. A still-queued reply is credited before the staleness decision,
 * so the previous reply's age never denies a wait the service is answering; a
 * confirm the hook never received (its own 2 s bound, a broken socket) credits
 * nothing, and the window keeps running from the last reply that answered.
 */
import { connect } from "node:net";
import { hostRunOwnStartIdentity } from "../machine/start-identity";
import { admissionAncestry, type EffigyRuntimeAncestor } from "./effigy-runtime";
import {
  ADMISSION_CONFIRM_INTERVAL_MS,
  ADMISSION_CONNECT_TIMEOUT_MS,
  ADMISSION_LIVENESS_MS,
  ADMISSION_RESERVE_TIMEOUT_MS,
  QUEUE_ADMISSION_SOCKET_ENV,
  evaluateAdmissionWait,
  formatAdmissionStdout,
  parseEffigyAdmissionRequest,
  type AdmissionObservation,
} from "./effigy-admission";

export interface AdmissionHookIo {
  env: NodeJS.ProcessEnv;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rpc?: AdmissionRpc;
  pid?: number;
  startIdentity?: string;
  /** Ancestors this hook attests; production walks its own parent chain. */
  ancestry?: EffigyRuntimeAncestor[];
  onHold?: () => Promise<void>;
}

export type AdmissionRpc = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<{
  ok: boolean;
  result?: { reservationId?: string | null; observation?: AdmissionObservation };
  error?: { code?: string; message?: string };
}>;

export async function runEffigyAdmissionHook(io: AdmissionHookIo): Promise<number> {
  const parsed = parseEffigyAdmissionRequest(io.env.EFFIGY_ADMISSION_REQUEST);
  if (!parsed.ok) return deny(io, parsed.reason);
  const socketPath = io.env[QUEUE_ADMISSION_SOCKET_ENV]?.trim();
  if (!socketPath) return deny(io, "missing QUEUE_ADMISSION_SOCKET");
  const confirmIntervalMs = positiveInt(io.env.QUEUE_ADMISSION_CONFIRM_MS, ADMISSION_CONFIRM_INTERVAL_MS);
  const livenessMs = positiveInt(io.env.QUEUE_ADMISSION_LIVENESS_MS, ADMISSION_LIVENESS_MS);
  const rpc = io.rpc ?? ((method, params, timeoutMs) => admissionRpc(socketPath, method, params, timeoutMs));
  const nowMs = () => (io.now ?? Date.now)();
  const sleep = io.sleep ?? defaultSleep;

  let reservationId: string | null = null;
  let lastConfirmedAtMs: number | null = null;
  // Spec 035 "Runtime identity": the hook runs under the Effigy that will run
  // the workload, so it attests that process chain by pid. Queue verifies the
  // images itself; the hook never chooses an executable.
  const ancestry = io.ancestry ?? admissionAncestry();
  const first = await call(rpc, "reserve", { request: parsed.request, ancestry }, ADMISSION_RESERVE_TIMEOUT_MS);
  if (first.reservationId) reservationId = first.reservationId;
  let decision = evaluateAdmissionWait({
    nowMs: nowMs(),
    hasReservation: Boolean(reservationId),
    lastConfirmedAtMs: null,
    observation: first.observation,
    confirmIntervalMs,
    livenessMs,
  });
  if (decision.action === "deny") return deny(io, decision.reason);
  if (decision.action === "admit") return admitAndHold(io, reservationId, rpc);
  // Credit only what this reply proved. A wait that carried no confirmation is
  // a missed beat, and the liveness window keeps running from the last reply
  // that did answer for this reservation, so `null` here must not erase it.
  if (decision.confirmedAtMs !== null) lastConfirmedAtMs = decision.confirmedAtMs;
  if (decision.progress) io.stderr.write(`${decision.progress}\n`);
  if (reservationId) {
    const pid = io.pid ?? process.pid;
    const startIdentity = io.startIdentity ?? hostRunOwnStartIdentity();
    await call(rpc, "bind-hook", { reservationId, pid, startIdentity });
  }

  while (decision.action === "wait") {
    await sleep(Math.max(0, decision.nextConfirmAt - nowMs()));
    const observation = reservationId
      ? await confirmedObservation(rpc, reservationId)
      : { kind: "unreachable" as const, message: "reservation was not issued" };
    decision = evaluateAdmissionWait({
      nowMs: nowMs(),
      hasReservation: Boolean(reservationId),
      lastConfirmedAtMs,
      observation,
      confirmIntervalMs,
      livenessMs,
    });
    if (decision.action === "deny") return deny(io, decision.reason);
    if (decision.action === "admit") return admitAndHold(io, reservationId, rpc);
    if (decision.confirmedAtMs !== null) lastConfirmedAtMs = decision.confirmedAtMs;
    if (decision.progress) io.stderr.write(`${decision.progress}\n`);
  }
  return deny(io, "admission wait ended without a decision");
}

async function admitAndHold(io: AdmissionHookIo, reservationId: string | null, rpc: AdmissionRpc): Promise<number> {
  if (reservationId) {
    const pid = io.pid ?? process.pid;
    const startIdentity = io.startIdentity ?? hostRunOwnStartIdentity();
    await call(rpc, "bind-hook", { reservationId, pid, startIdentity });
  }
  io.stdout.write(`${formatAdmissionStdout("admit")}\n`);
  if (io.onHold) await io.onHold();
  else await holdUntilTerm();
  return 0;
}

function deny(io: AdmissionHookIo, reason: string): number {
  io.stdout.write(`${formatAdmissionStdout({ deny: reason })}\n`);
  return 0;
}

/**
 * One confirmation for the reservation this hook was issued. The reply must
 * name that same reservation: every request here is one fresh socket, one
 * request line and the first reply line on it, so a reply cannot belong to
 * another request, and a reply naming another reservation is refused rather
 * than credited as this wait's confirmation (Task 447).
 */
async function confirmedObservation(rpc: AdmissionRpc, reservationId: string): Promise<AdmissionObservation> {
  const reply = await call(rpc, "confirm", { reservationId });
  // Missed beats and the service's own refusals keep their own meaning; only a
  // reply that would be credited as a still-queued confirmation must name the
  // reservation this hook holds.
  if (reply.observation.kind !== "queued") return reply.observation;
  if (reply.reservationId !== reservationId)
    return { kind: "error", message: "admission confirm reply did not name the reservation this hook holds" };
  return reply.observation;
}

async function call(rpc: AdmissionRpc, method: string, params: Record<string, unknown>,
  timeoutMs = ADMISSION_CONNECT_TIMEOUT_MS): Promise<{
  reservationId: string | null;
  observation: AdmissionObservation;
}> {
  try {
    const response = await rpc(method, params, timeoutMs);
    if (!response.ok)
      return { reservationId: null, observation: { kind: "error", message: response.error?.message ?? "Queue admission error" } };
    const observation = response.result?.observation;
    if (!observation) return { reservationId: response.result?.reservationId ?? null, observation: { kind: "unknown" } };
    return { reservationId: response.result?.reservationId ?? null, observation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reservationId: null, observation: { kind: "unreachable", message } };
  }
}

export function admissionRpc(socketPath: string, method: string, params: Record<string, unknown>, timeoutMs = ADMISSION_CONNECT_TIMEOUT_MS): ReturnType<AdmissionRpc> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`admission ${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try { resolve(JSON.parse(buffer.slice(0, index))); }
      catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: "1", method, params })}\n`);
    });
  });
}

function holdUntilTerm(): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearInterval(timer); resolve(); };
    // Keep the event loop alive until Effigy sends TERM. An unref'd interval
    // lets Node exit 13 (unsettled top-level await) instead of holding the slot.
    const timer = setInterval(() => { /* keep the event loop until TERM */ }, 60_000);
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function runEffigyAdmissionHookMain(): Promise<void> {
  const code = await runEffigyAdmissionHook({ env: process.env, stdout: process.stdout, stderr: process.stderr });
  process.exitCode = code;
}
