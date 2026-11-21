import type { Task } from "../../shared/contracts";
import { HostReadRefusalError } from "../host/errors";

/** Durable episode state for a bounded pre-send host-read transient wait. */
export interface HostReadTransientEpisode {
  startedAt: number;
  attempts: number;
  retryAt: number;
  detail: string;
  step?: string | null;
  hostId?: string | null;
  target?: string | null;
  occurrenceKey?: string | null;
  exhaustedAt?: number | null;
  resumePhase?: Task["phase"] | null;
  movedToAttention?: boolean;
}

/** Binding context for one pre-send or host observation read wait. */
export interface HostReadFailureContext {
  step?: string;
  hostId?: string | null;
  target?: string | null;
  occurrenceKey?: string | null;
  resumePhase?: Task["phase"] | null;
}

export interface HostReadTransientStore {
  getMeta<T = unknown>(key: string): T | undefined;
  eventsAll(taskId: string): Array<{ kind: string; detail: string }>;
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

/** Read a durable host-read transient episode record, if any. */
export function readHostReadTransientEpisode(
  store: Pick<HostReadTransientStore, "getMeta">,
  id: string,
  scope: "task" | "op" | "question" = "task",
): HostReadTransientEpisode | null {
  return (
    store.getMeta<HostReadTransientEpisode | null>(
      hostReadTransientKey(scope, id),
    ) ?? null
  );
}

/** Stable occurrence identity for a task's awaited host observation. */
export function taskHostReadOccurrenceKey(
  task: Pick<
    Task,
    "id" | "workspaceId" | "agentId" | "prHead" | "coordinatorGeneration"
  > & {
    resolution?: Pick<Task["resolution"], "mergeHead" | "review">;
  },
): string {
  const head =
    task.resolution?.review?.head ??
    task.resolution?.mergeHead ??
    task.prHead ??
    "-";
  const target = task.agentId ?? task.workspaceId ?? "-";
  return `${task.id}:${target}:${head}:${task.coordinatorGeneration ?? 0}`;
}

/** Human-readable target label (thread or workspace) for a task's host read. */
export function taskHostReadTarget(
  task: Pick<Task, "agentId" | "workspaceId">,
): string | null {
  if (task.agentId) return `thread ${task.agentId}`;
  if (task.workspaceId) return `workspace ${task.workspaceId}`;
  return null;
}

/** Default observation step name derived from the task's current phase. */
export function taskHostReadStep(task: Pick<Task, "phase">): string {
  if (task.phase === "dispatching") return "Worker admission";
  if (task.phase === "queued") return "Task admission";
  if (task.phase === "awaiting_review" || task.phase === "reviewing")
    return "Reviewer admission";
  if (
    task.phase === "verifying" ||
    task.phase === "merging" ||
    task.phase === "syncing" ||
    task.phase === "closing"
  )
    return `${task.phase} check`;
  return "Host check";
}

/** Build the durable binding context for a task-level host read failure. */
export function taskHostReadContext(
  task: Pick<
    Task,
    | "id"
    | "phase"
    | "hostId"
    | "workspaceId"
    | "agentId"
    | "prHead"
    | "coordinatorGeneration"
  > & { resolution?: Pick<Task["resolution"], "mergeHead" | "review"> },
  step?: string,
  existing?: HostReadTransientEpisode | null,
): HostReadFailureContext {
  const resumePhase =
    task.phase === "needs_attention"
      ? (existing?.resumePhase ?? null)
      : task.phase;
  return {
    step: step && step !== "Host check" ? step : (existing?.step ?? taskHostReadStep(task)),
    hostId: task.hostId ?? existing?.hostId ?? null,
    target: taskHostReadTarget(task) ?? existing?.target ?? null,
    occurrenceKey: taskHostReadOccurrenceKey(task),
    resumePhase,
  };
}

/** Unwrap repeated legacy `No coordinator profile is available for recovery` / `Coordinator recovery unavailable` prefixes. */
export function unwrapCoordinatorRouteWrapper(reason: string): string {
  let current = reason.trim();
  for (;;) {
    const profileMatch = current.match(
      /^No coordinator profile is available for recovery(?:\.[^.]+)?\.\s+([\s\S]+)$/,
    );
    if (profileMatch?.[1]) {
      current = profileMatch[1].trim();
      continue;
    }
    const creationPrefix = "Coordinator recovery unavailable: ";
    if (
      current.startsWith(creationPrefix) &&
      current.length > creationPrefix.length
    ) {
      current = current.slice(creationPrefix.length).trim();
      continue;
    }
    break;
  }
  return current;
}

/** True when `reason` (even after unwrapping coordinator-route wrappers) names a host-read exhaustion notice. */
export function isHostReadExhaustedReason(
  reason: string | null | undefined,
): boolean {
  if (!reason) return false;
  const unwrapped = unwrapCoordinatorRouteWrapper(reason);
  return (
    /could not read host state after \d+ attempts/.test(unwrapped) ||
    unwrapped.includes("Owner: host-read recovery.")
  );
}

/** True when the task recorded `host_read_transient_exhausted` without a subsequent `host_read_transient_recovered`. */
export function hasUnresolvedHostReadExhaustionEvent(
  store: Pick<HostReadTransientStore, "eventsAll">,
  taskId: string,
): boolean {
  let unresolved = false;
  for (const event of store.eventsAll(taskId)) {
    if (event.kind === "host_read_transient_exhausted") unresolved = true;
    else if (event.kind === "host_read_transient_recovered") unresolved = false;
  }
  return unresolved;
}

/** Current host-read recovery hold status for a task, or null when unrelated. */
export function isHostReadRecoveryHeld(
  store: HostReadTransientStore,
  task: Pick<
    Task,
    | "id"
    | "phase"
    | "reason"
    | "workspaceId"
    | "agentId"
    | "prHead"
    | "coordinatorGeneration"
    | "resolution"
  >,
): "waiting" | "exhausted" | null {
  if (["done", "cancelled"].includes(task.phase)) return null;
  const currentOccurrence = taskHostReadOccurrenceKey(task);
  const episode = readHostReadTransientEpisode(store, task.id, "task");
  if (episode) {
    const sameOccurrence =
      !episode.occurrenceKey || episode.occurrenceKey === currentOccurrence;
    if (sameOccurrence) {
      return episode.exhaustedAt != null ? "exhausted" : "waiting";
    }
  }
  if (
    hasUnresolvedHostReadExhaustionEvent(store, task.id) &&
    (isHostReadExhaustedReason(task.reason) ||
      isHostReadExhaustedReason(task.resolution.stop?.detail ?? ""))
  ) {
    return "exhausted";
  }
  return null;
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
  context?: HostReadFailureContext,
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
  const occurrenceMismatch = Boolean(
    previous?.occurrenceKey &&
      context?.occurrenceKey &&
      previous.occurrenceKey !== context.occurrenceKey,
  );
  if (previous?.exhaustedAt != null && !occurrenceMismatch) return null;
  const activePrevious = occurrenceMismatch ? null : previous;
  const startedAt = activePrevious?.startedAt ?? nowMs;
  const attempts = (activePrevious?.attempts ?? 0) + 1;
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
    step: context?.step ?? activePrevious?.step ?? null,
    hostId: context?.hostId ?? activePrevious?.hostId ?? null,
    target: context?.target ?? activePrevious?.target ?? null,
    occurrenceKey: context?.occurrenceKey ?? activePrevious?.occurrenceKey ?? null,
    exhaustedAt: null,
    resumePhase: activePrevious?.resumePhase ?? context?.resumePhase ?? null,
    movedToAttention: activePrevious?.movedToAttention ?? false,
  };
}

/** Format the one actionable escalation when a pre-send host read remains unavailable past its bound. */
export function hostReadTransientEscalationReason(
  step: string,
  episode: HostReadTransientEpisode | null | undefined,
  detail: string,
  nowMs = Date.now(),
  context?: HostReadFailureContext,
): string {
  const resolvedStep = step || episode?.step || context?.step || "Host check";
  const hostId = context?.hostId ?? episode?.hostId ?? null;
  const target = context?.target ?? episode?.target ?? null;
  const scopeParts = [
    hostId ? `host ${hostId}` : null,
    target || null,
  ].filter(Boolean);
  const scopeText = scopeParts.length ? ` (${scopeParts.join(", ")})` : "";
  const attempts = episode ? episode.attempts + 1 : 1;
  const elapsedSeconds = episode
    ? Math.max(1, Math.round((nowMs - episode.startedAt) / 1000))
    : 0;
  return `${resolvedStep} could not read host state after ${attempts} attempts${elapsedSeconds ? ` over ${elapsedSeconds}s` : ""}${scopeText}: ${detail}. Owner: host-read recovery. Inspect the host service/inventory so fresh evidence allows ordinary admission to resume, or clear with an owner control (restart or move).`.slice(
    0,
    2000,
  );
}
