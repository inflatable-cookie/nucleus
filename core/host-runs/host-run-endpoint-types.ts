import {
  type Socket,
} from "node:net";
import {
  type HostRunInternalRecord,
} from "../../shared/contracts";
import {
  type HostRunRetainedStream as HostRunRetainedStreamShape,
} from "./host-run-output-failures";
import {
  hostRunEnvKeys,
} from "./host-run-redact";
import {
  type HostRunOutputRetention,
  type HostRunSubmitBody,
  type HostRunSupervisorPlan,
} from "./host-run-wire";
export const HOST_RUN_CLIENT_PROTOCOL_VERSION = 1;
/** One NDJSON request line is at most 1 MiB (contract 010, Transport). */
export const HOST_RUN_MAX_REQUEST_BYTES = 1024 * 1024;
/** One `output` event carries at most 64 KiB (contract 010, attach). */
export const HOST_RUN_OUTPUT_CHUNK_BYTES = 64 * 1024;
/** Output is kept for an hour after settlement (contract 010, attach). */
export const HOST_RUN_OUTPUT_RETENTION_MS = 60 * 60 * 1000;
/** A dropped `cancelOnDisconnect` attachment keeps its run for 5 s. */
export const HOST_RUN_RECONNECT_WINDOW_MS = 5_000;
/**
 * Any other never-launched run whose last attachment dropped keeps its place for
 * 60 s, then settles `cancelled` unlaunched (`client_left_before_launch`): its
 * client is gone and nobody would read it (papercut 19676b0f; Tom, 2026-10-21).
 */
export const HOST_RUN_UNLAUNCHED_GRACE_MS = 60_000;
export const HOST_RUN_CLIENT_LEFT_REASON = "client_left_before_launch";
export const HOST_RUN_TERMINATION_GRACE_MS = 30_000;
export const HOST_RUN_TOKEN_GRACE_MS = 30_000;
/** Active output polls at this cadence; unchanged streams back off up to 500 ms. */
export const HOST_RUN_ATTACH_POLL_MS = 40;
/** The endpoint polls the supervisor record and result at this cadence. */
export const HOST_RUN_SUPERVISOR_POLL_MS = 100;
/** A launched run with no supervisor record or result after this long is lost. */
export const HOST_RUN_SUPERVISOR_STATE_GRACE_MS = 30_000;
/**
 * Audit A7: the maintenance sweep walks settled rows in bounded pages behind a
 * durable cursor instead of parsing the whole, growing history table each pass.
 */
export const HOST_RUN_RETENTION_SWEEP_PAGE = 250;
/** The journal owns durable fact identity; this duplicate cache stays bounded. */
export const HOST_RUN_FACT_CACHE_BYTES = 4 * 1024 * 1024;
export const HOST_RUN_FACT_CACHE_ENTRIES = 2_000;
/** Durable restart-safe cursor: the last settled rowid this sweep finished. */
export const HOST_RUN_RETENTION_CURSOR_META = "hostRunOutputSweepCursor";
/** The last retention sweep failure, so a refused or unreadable run output is visible. */
export const HOST_RUN_RETENTION_ERROR_META = "hostRunOutputSweepError";

/** Queued, or admitted with no launch recorded: nothing has started. */
export function neverLaunched(run: HostRunInternalRecord): boolean {
  return (run.state === "queued" || run.state === "admitted") && run.launchedAt == null && run.pid == null;
}

/**
 * One retained stream as the sweep observed it. `size` is a real byte count read
 * through the verified traversal; an absent or unreadable stream carries no
 * number at all, because a missing stream is not a zero-length one. The shape
 * and the failure record live in `host-run-output-failures` (task 444), which
 * the store, the migration and the tests read too.
 */
export type HostRunRetainedStream = HostRunRetainedStreamShape;

/** What one run's expiry attempt could honestly establish (task 443). */
export type RetainedOutputSettlement =
  | { outcome: "expired"; marker: HostRunOutputRetention }
  | { outcome: "nothing_retained"; reason: string }
  | { outcome: "unavailable"; reason: string; streams?: { stdout: HostRunRetainedStream; stderr: HostRunRetainedStream } };

/** One error's text, without a stack or an untrusted object's shape. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How a run is executed. Production spawns the detached supervisor; tests inject a fake. */
export type HostRunSupervisorSpawn = (plan: HostRunSupervisorPlan) => void;

export type HostRunClientErrorCode = "unsupported_version" | "stale_epoch" | "unknown_run" | "conflict" | "not_permitted" | "invalid";

export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
};

/** A durable submission body: env key names only, never values (Spec 035). */
export type StoredSubmissionBody = Omit<HostRunSubmitBody, "env"> & { envKeys: string[] };

export const storedBodyOf = (body: HostRunSubmitBody): StoredSubmissionBody => {
  const { env, ...rest } = body;
  return { ...rest, envKeys: hostRunEnvKeys(env) };
};

export interface StoredSubmission {
  runId: string;
  caller: string;
  clientRequestId: string;
  submittedAt: string;
  epoch: number;
  cancelOnDisconnect: boolean;
  body: StoredSubmissionBody;
}

export interface Attachment {
  runId: string;
  socket: Socket;
  offsets: { stdout: number; stderr: number };
  timer: NodeJS.Timeout;
  idlePollMs: number;
}
