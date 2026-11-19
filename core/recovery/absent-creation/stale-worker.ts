import {
  isDispositionActive,
  isDispositionComplete,
  type Run,
  type Task,
} from "../../../shared/contracts";
import type { Adapter } from "../../host/adapter";
import type { ResolutionAdapter } from "../../resolution";
import { digest, now, type Store } from "../../store/store";
import {
  creationTermination,
  readCreationAttempt,
} from "../../store/store-task-funnel";
import { hostFailureRefusalDetail } from "../../host/errors";
import { creationLookup } from "./restarts";
import { unsettledControlRefusal } from "../recovery-effects";

export const workerCreationWait =
  "Worker creation remains uncertain; waiting for its recorded producer to stop and the lookup grace period to pass";
const workerLookupUnavailable = "Exact worker creation lookup is unavailable";
const workerLookupPartial =
  "Worker creation lookup is partial or ambiguous; the intent remains owned";

export function workerLookupWait(task: Task): string | null {
  const stop = task.resolution.stop;
  return stop?.reason === "lifecycle" &&
    (stop.detail === workerLookupPartial ||
      stop.detail.startsWith(workerLookupUnavailable))
    ? stop.detail
    : null;
}

/** A current worker creation reservation with no competing source or accepted result. */
export const staleWorkerIntent = (task: Task): boolean =>
  Boolean(
    task.agentIntent &&
      !task.agentId &&
      task.runId &&
      task.hostId &&
      task.workspaceId &&
      task.directory &&
      task.profile &&
      !task.completion &&
      !task.prUrl &&
      !task.prHead &&
      !task.resumePrNumber &&
      !task.resolution.currentRunId &&
      !task.resolution.mergeIntent &&
      !task.resolution.mergedCommit,
  );

const binding = (task: Task) => ({
  id: task.runId!,
  taskId: task.id,
  hostId: task.hostId,
  role: "worker" as const,
  workspaceId: task.workspaceId,
});

export function workerCreationRefusal(
  store: Store,
  task: Task,
  settling: readonly string[] = [],
): string | null {
  if (
    task.removedAt ||
    isDispositionActive(task) ||
    isDispositionComplete(task) ||
    ["done", "cancelled"].includes(task.phase)
  )
    return "Task is no longer available for worker creation recovery";
  if (!staleWorkerIntent(task))
    return "Worker creation recovery requires a retained run, host, workspace and route with no accepted result or PR";
  return (
    unsettledControlRefusal(store, task) ??
    (store
      .runs(task.id)
      .some((run) => !run.released && !settling.includes(run.id))
      ? "Another run still owns this task; settle it before replacing the worker creation"
      : null)
  );
}

export function workerProducerStopped(
  store: Store,
  task: Task,
  graceMs: number,
) {
  return creationTermination(store, binding(task), graceMs);
}

/** A match can bind even while its producer is pending. Only an empty read needs termination proof. */
export async function observeWorkerCreation(
  store: Store,
  adapter: Adapter & Partial<Pick<ResolutionAdapter, "findRunAgents">>,
  task: Task,
  graceMs: number,
) {
  const occurrence = binding(task);
  const attempt = readCreationAttempt(store, occurrence)?.attemptId ?? null;
  const proof = workerProducerStopped(store, task, graceMs);
  if (!adapter.findRunAgents)
    return {
      kind: "wait",
      detail: `${workerLookupUnavailable}; the intent remains owned`,
    } as const;
  try {
    // Host adapters consume only the exact lookup identity for the initial worker.
    const found = await adapter.findRunAgents(occurrence as unknown as Run);
    const lookup = creationLookup(found, task.workspaceId);
    if (lookup.kind === "bound") return { ...lookup, attempt };
    if (lookup.kind === "absent" && proof)
      return { kind: "absent", proof } as const;
    const detail =
      lookup.kind === "unknown" ? workerLookupPartial : workerCreationWait;
    return { kind: "wait", detail } as const;
  } catch (error) {
    return {
      kind: "wait",
      detail: `${workerLookupUnavailable} (${hostFailureRefusalDetail(error)}); the intent remains owned`,
    } as const;
  }
}

export function sameWorkerCreation(
  store: Store,
  task: Task,
  observed: Awaited<ReturnType<typeof observeWorkerCreation>>,
): boolean {
  return (
    observed.kind === "wait" ||
    (readCreationAttempt(store, binding(task))?.attemptId ?? null) ===
      (observed.kind === "bound" ? observed.attempt : observed.proof.attemptId)
  );
}

export function deferredWorkerCreationRestart(task: Task) {
  const deferred = task.resolution.deferredVerb;
  return deferred?.why === "worker_creation" ? deferred : null;
}

export function workerCreationRestartDelivery(
  store: Store,
  task: Task,
  at: string,
) {
  const messageId = `ns-worker-creation-restart-${digest(`${task.id}:${task.runId}:${at}`).slice(0, 32)}`;
  const event = store
    .eventsAll(task.id)
    .findLast(
      (event) =>
        [
          "owner_restart_instruction_intent",
          "owner_restart_instruction_sent",
        ].includes(event.kind) &&
        event.detail.includes(`"messageId":"${messageId}"`),
    );
  return {
    messageId,
    agentId: event
      ? (JSON.parse(event.detail) as { agentId: string }).agentId
      : null,
    state:
      event?.kind === "owner_restart_instruction_sent"
        ? ("sent" as const)
        : event
          ? ("uncertain" as const)
          : ("ready" as const),
  };
}

export function workerCreationRestartWait(
  store: Store,
  task: Task,
): string | null {
  const deferred = deferredWorkerCreationRestart(task);
  if (!deferred || deferred.target?.runId !== task.runId) return null;
  const delivery = workerCreationRestartDelivery(store, task, deferred.at);
  if (delivery.state === "uncertain")
    return "Delivery of the recorded restart instruction is unknown. Nucleus checks the original worker timeline.";
  if (deferred.notificationUnavailable)
    return `Worker notifications are unavailable on host ${task.hostId}. The host operator can restore notification support. Nucleus will recheck the recorded restart automatically.`;
  return task.agentId
    ? "A restart instruction is recorded. Nucleus waits for the retained worker and ordinary admission."
    : `A restart instruction is recorded. ${workerLookupWait(task) ?? workerCreationWait}`;
}

export function recordWorkerCreationRestart(
  store: Store,
  task: Task,
  instruction: string,
): Task {
  return store.update(
    task.id,
    {
      resolution: {
        ...task.resolution,
        deferredVerb: {
          input: { action: "restart", role: "worker", instruction },
          at: now(),
          why: "worker_creation",
          target: {
            runId: task.runId!,
            hostId: task.hostId!,
            workspaceId: task.workspaceId!,
          },
        },
      },
    },
    "worker_creation_restart_recorded",
    task.runId!,
  );
}

/** Bind the original run and credential. Any armed route still applies to future runs. */
export function bindWorkerCreation(
  store: Store,
  task: Task,
  agentId: string,
): Task {
  return store.update(
    task.id,
    {
      agentId,
      phase: "working",
      reason: "Recovered worker identity",
      failoverReason: "",
      replacementProfile: null,
      resolution: {
        ...task.resolution,
        attention: false,
        stop:
          task.resolution.stop?.reason === "lifecycle"
            ? null
            : task.resolution.stop,
      },
    },
    "agent_recovered",
    agentId,
  );
}

/** Release the exact occurrence and return its authorized work to ordinary dispatch. */
export function releaseStaleWorkerIntent(
  store: Store,
  task: Task,
  proof: NonNullable<ReturnType<typeof workerProducerStopped>>,
  instruction?: string,
): Task {
  store.deleteCredential(task.runId!);
  const incident = task.resolution.incident;
  const stop = task.resolution.stop;
  const deferred = deferredWorkerCreationRestart(task);
  const transfers =
    deferred &&
    deferred.target?.runId === task.runId &&
    deferred.target.hostId === task.hostId &&
    deferred.target.workspaceId === task.workspaceId;
  const nextInstruction = transfers
    ? String(deferred.input.instruction)
    : instruction;
  return store.update(
    task.id,
    {
      agentIntent: false,
      runId: null,
      restartRunId: null,
      transientProviderRetry: undefined,
      agentActive: null,
      lastAgentStatus: null,
      lastObservedAt: null,
      idleSince: null,
      failoverReason: "",
      replacementProfile: null,
      phase: "queued",
      reason:
        "Worker creation settled as absent; waiting for ordinary dispatch",
      prerequisiteWait: task.prerequisiteWait?.releasedAt
        ? null
        : task.prerequisiteWait,
      resolution: {
        ...task.resolution,
        attention: false,
        stalledTurnStop: null,
        stop:
          stop?.reason === "lifecycle" || stop?.reason === "operator_needed"
            ? null
            : stop,
        ...(incident && (!incident.runId || incident.runId === task.runId)
          ? {
              incident: {
                ...incident,
                status: "resolved" as const,
                updatedAt: new Date().toISOString(),
              },
            }
          : {}),
        ...(transfers ? { deferredVerb: null } : {}),
        ...(nextInstruction
          ? { pendingWorkerInstruction: nextInstruction }
          : {}),
      },
    },
    "absent_worker_released",
    JSON.stringify({ runId: task.runId, ...proof }),
  );
}
