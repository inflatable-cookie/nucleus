import { HostReadRefusalError } from "../host/errors";

/** Durable episode state for a bounded pre-send host-read transient wait. */
export interface HostReadTransientEpisode {
  startedAt: number;
  attempts: number;
  retryAt: number;
  detail: string;
}

export const HOST_READ_TRANSIENT_LIMIT_MS = 10 * 60_000;
export const HOST_READ_TRANSIENT_MIN_ATTEMPTS = 5;
export const HOST_READ_TRANSIENT_MAX_ATTEMPTS = 20;
const INITIAL_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;

const countedErrors = new WeakSet<object>();

/** Metadata key for one task, operation, or delegated-question transient wait. */
export function hostReadTransientKey(
  scope: "task" | "op" | "question",
  id: string,
): string {
  return `hostReadTransient:${scope}:${id}`;
}

/** True when `error` is a proved transient host-read refusal rather than a send/identity failure. */
export function isPreSendTransientReadError(
  error: unknown,
): error is HostReadRefusalError {
  return error instanceof HostReadRefusalError;
}

/** Record an error instance once so nested catch handlers do not double-count one attempt. */
export function claimHostReadTransientError(error: unknown): boolean {
  if (!isPreSendTransientReadError(error)) return false;
  if (countedErrors.has(error)) return false;
  countedErrors.add(error);
  return true;
}

/** Advance or exhaust the bounded wait window for repeated pre-send read failures. */
export function nextHostReadTransientAttempt(
  previous: HostReadTransientEpisode | null | undefined,
  detail: string,
  nowMs: number,
  limits?: {
    limitMs?: number | null;
    minAttempts?: number | null;
    maxAttempts?: number | null;
  },
): HostReadTransientEpisode | null {
  const limitMs =
    typeof limits?.limitMs === "number" && limits.limitMs > 0
      ? limits.limitMs
      : HOST_READ_TRANSIENT_LIMIT_MS;
  const minAttempts =
    typeof limits?.minAttempts === "number" && limits.minAttempts > 0
      ? limits.minAttempts
      : HOST_READ_TRANSIENT_MIN_ATTEMPTS;
  const maxAttempts =
    typeof limits?.maxAttempts === "number" && limits.maxAttempts > 0
      ? limits.maxAttempts
      : HOST_READ_TRANSIENT_MAX_ATTEMPTS;
  const startedAt = previous?.startedAt ?? nowMs;
  const attempts = (previous?.attempts ?? 0) + 1;
  const elapsedMs = nowMs - startedAt;
  if (
    attempts > maxAttempts ||
    (attempts > minAttempts && elapsedMs >= limitMs)
  )
    return null;
  const delay = Math.min(
    MAX_DELAY_MS,
    INITIAL_DELAY_MS * 2 ** Math.min(attempts - 1, 10),
  );
  const deadline = startedAt + limitMs;
  return {
    startedAt,
    attempts,
    retryAt: Math.max(nowMs, Math.min(deadline, nowMs + delay)),
    detail: detail.slice(0, 1000),
  };
}

/** Format the one actionable escalation when a pre-send host read remains unavailable past its bound. */
export function hostReadTransientEscalationReason(
  step: string,
  episode: HostReadTransientEpisode | null | undefined,
  detail: string,
  nowMs = Date.now(),
): string {
  const attempts = episode ? episode.attempts + 1 : 1;
  const elapsedSeconds = episode
    ? Math.max(1, Math.round((nowMs - episode.startedAt) / 1000))
    : 0;
  return `${step} could not read host state after ${attempts} attempts${elapsedSeconds ? ` over ${elapsedSeconds}s` : ""}: ${detail}. Inspect the host service/inventory and retry with an owner control (restart or move).`.slice(
    0,
    2000,
  );
}
