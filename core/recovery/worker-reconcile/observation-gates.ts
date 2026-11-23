import { workerActivityObservation } from "../../telemetry/task-activity-observation";
import { threadGoneError } from "../dead-participant";
import {
  isDispositionActive,
  isDispositionComplete,
} from "../../../shared/contracts";
import type { Task } from "../../../shared/contracts";
import { interactiveSessionOpen } from "../../dispatch/interactive";
import { startsNoRuns } from "../../closeout/queue-drain";
import type { Adapter } from "../../host/adapter";
import { now } from "../../store/store";
import { OPERATOR_WORKER_REMAP_REASON, observedActive } from "../task-reasons";
import type { WorkerReconcileContext } from "./context";
import { HOST_KIND_LABELS, hostKindOf } from "../../../shared/host-kind";
import {
  INTERACTIVE_RUNNING_REASON,
  INTERACTIVE_WAIT_REASON,
  STOPPED_WORKER_STATUSES,
  classifyWorkerObservation,
} from "./decisions";
import {
  completedTurnCanRelease,
  type CompletionObservation,
} from "../completed-run-observation";
import {
  QUANTUM_READ_DEADLINE_MS,
  boundedRead,
} from "../../scheduling/pass-snapshot";

export type WorkerObservation =
  | {
      kind: "stopped";
      state: Awaited<ReturnType<Adapter["observe"]>>;
      current: Task;
    }
  | {
      kind: "released_completion";
      state: Awaited<ReturnType<Adapter["observe"]>> | null;
      current: Task;
    };

/** The initial worker stores its authenticated completion on the task row. */
function workerCompletionReceivedAt(
  engine: WorkerReconcileContext,
  task: Task,
) {
  const completion = task.completion;
  if (
    !completion ||
    completion.taskId !== task.id ||
    completion.runId !== task.runId ||
    !engine.store.receiptHash(completion.eventId, task.id, completion.runId)
  )
    return undefined;
  const received = engine.store.db
    .prepare(
      "SELECT at FROM events WHERE taskId=? AND kind='completion_received' ORDER BY id DESC LIMIT 1",
    )
    .get(task.id);
  return typeof received?.at === "string" ? received.at : undefined;
}

/**
 * Observation gates: which tasks a pass may observe at all, what an observation
 * settles on its own (interactive session, stalled turn, live worker, heavy run),
 * and the answer the pass continues with once the worker has stopped.
 */

/** A task that finished, was disposed of or was removed is not reconciled: its worker receipt is history. */
const terminal = (t: Task) =>
  Boolean(t.removedAt) ||
  ["done", "cancelled"].includes(t.phase) ||
  isDispositionActive(t) ||
  isDispositionComplete(t);

/** A live worker also resets the branch-PR lookup backoff (papercut fa4a53a7): any empty result predating it is stale. */
function resetLookupBackoff(
  engine: WorkerReconcileContext,
  current: Task,
): void {
  // The last outcome is kept across the reset so an unchanged result after the
  // restart is still coalesced rather than logged twice. The reset is a one-time
  // write: a stamp already at attempts 0 is left alone, so an active worker's
  // sweeps perform no substantive task write.
  const lookupReset = current.prLookup?.attempts
    ? { attempts: 0, lastAt: now(), outcome: current.prLookup.outcome }
    : null;
  if (current.idleSince || lookupReset)
    engine.store.update(current.id, {
      idleSince: null,
      ...(lookupReset ? { prLookup: lookupReset } : {}),
    });
}

/** Observe the worker and settle every live state. Null ends the pass; otherwise the worker has stopped. */

/** The row names the host its worker's question waits on, never another host's name. */
const permissionWait = (hostId: string | null | undefined): string =>
  `Worker is waiting for a permission response in ${HOST_KIND_LABELS[hostKindOf(hostId)]}`;

export async function reconcileObservation(
  engine: WorkerReconcileContext,
  task: Task,
): Promise<WorkerObservation | null> {
  const { store, resolution } = engine;
  // Callers pick lanes from an earlier read. A task that has since finished or been
  // disposed must not be reconciled: re-processing an old worker receipt reopened
  // g05.222 from cancelled to blocked.
  if (terminal(store.task(task.id))) return null;
  const at = now();
  let thread: CompletionObservation;
  try {
    const deadlineMs =
      resolution.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS;
    const read = await boundedRead(
      "worker observation",
      () => engine.onTaskHost(task, () => engine.host.observe(task.agentId!)),
      deadlineMs,
    );
    if (read.state === "unknown") return null;
    thread = { kind: "observed", state: read.value };
  } catch (error) {
    thread = { kind: "unobservable", error };
  }
  if (engine.stopped) return null;
  let current = store.task(task.id);
  if (
    terminal(current) ||
    current.runId !== task.runId ||
    current.agentId !== task.agentId
  )
    return null;
  if (
    current.phase === "working" &&
    !current.resolution.recoveryActive &&
    current.resolution.recovery?.status === "escalated" &&
    current.retiredWorkers
      .at(-1)
      ?.reason.startsWith(OPERATOR_WORKER_REMAP_REASON)
  ) {
    current = engine.updateAfterOperatorRemap(current);
  }
  // A control action or review verdict may move a task into the resolution
  // state machine while this pass still holds the earlier worker snapshot.
  // A ready callback with durable PR identity has already been consumed; do
  // not replay it over a pending revision or retained-profile attention.
  // Worker failover clears PR identity, so its fresh callback still advances.
  const consumedReady =
    current.completion?.status === "ready_for_review" &&
    Boolean(current.prHead && current.prUrl);
  // Once PR identity has been accepted, the worker receipt belongs to history.
  // Review, pre-merge and operator transitions own every later phase. Replaying
  // the same receipt from an idle worker would reset those phases to
  // awaiting_review and can create an unbounded same-head review loop.
  if (consumedReady && current.phase !== "working") return null;
  if (current.phase === "changes_requested") return null;
  if (current.failoverReason) return null;
  const completionReceivedAt = workerCompletionReceivedAt(engine, current);
  const releaseReported = completedTurnCanRelease(
    { ...current, completionReceivedAt },
    thread,
    at,
    engine.idleGraceMs,
  );
  if (thread.kind === "unobservable") {
    if (!completionReceivedAt) {
      // Spec 068 §3: a worker whose thread (or process) is provably gone is
      // released and continued instead of parked on the read failure.
      if (
        threadGoneError(thread.error) &&
        (await resolution.releaseDeadParticipant?.(current, null))
      )
        return null;
      throw thread.error;
    }
    if (
      !releaseReported ||
      (current.checkpoints.intent &&
        current.checkpoints.intent.status !== "delivered")
    )
      return null;
    current = store.update(task.id, { agentActive: false });
    return { kind: "released_completion", state: null, current };
  }
  const { state } = thread;
  if (state.workspaceId !== current.workspaceId)
    throw new Error("Worker placement changed; workspace ownership is unknown");
  recordObservation(engine, current, state);
  // Pause still applies a stored result. Without one, skip classification so
  // pause does not start reminders or replacement.
  if (startsNoRuns(store) && !current.completion) return null;
  // A persisted checkpoint intent owns the pending turn: do not treat the
  // retained worker's deliberate stop as a missing callback.
  if (
    current.checkpoints.intent &&
    current.checkpoints.intent.status !== "delivered"
  )
    return null;
  // Spec 051: until an interactive task's worker reports, its thread is the
  // operator's working session. A live turn shows as running and an idle one
  // waits on the operator: no stall detection, idle grace, callback reminder
  // or coordinator recovery. An errored or closed thread is handled as usual.
  if (
    current.phase === "working" &&
    interactiveSessionOpen(current, store.runs(current.id))
  ) {
    const live =
      state.active ||
      ["running", "initializing"].includes(state.status) ||
      state.permissions;
    if (live || state.status === "idle") {
      if (current.idleSince) store.update(task.id, { idleSince: null });
      if (live)
        engine.note(
          task.id,
          state.permissions
            ? permissionWait(task.hostId)
            : INTERACTIVE_RUNNING_REASON,
          "lifecycle",
        );
      else
        resolution.waiting(
          store.task(task.id),
          INTERACTIVE_WAIT_REASON,
          "interactive",
        );
      return null;
    }
  }
  if (resolution.reconcileStalledTurnStop(current, null, state)) return null;
  if (
    releaseReported &&
    (observedActive(state) ||
      state.activeTurnId ||
      state.archived ||
      !STOPPED_WORKER_STATUSES.includes(state.status))
  ) {
    current = store.update(task.id, { agentActive: false });
    return { kind: "released_completion", state, current };
  }
  const observation = classifyWorkerObservation(current, state);
  if (observation === "live" || observation === "live_recover") {
    resetLookupBackoff(engine, current);
    // A task parked with no callback, no failover and no recovery run whose worker is
    // live again was parked by an outage, not a task fault: resume it rather than
    // leaving it in needs_attention with a pending coordinator (2026-09-29 Paseo restart).
    if (observation === "live_recover") {
      store.update(
        task.id,
        {
          phase: "working",
          reason: "Worker running",
          resolution: {
            ...current.resolution,
            recovery: null,
            recoveryActive: false,
          },
        },
        "worker_live_after_outage",
        "Worker observed running; resuming",
      );
      return null;
    }
    // Mid-turn stall detection for the initial worker: stale activity enters
    // coordinator recovery, while a long shell command shows on the task.
    const shellNotice = await resolution.stalls.check(current, null, state);
    const after = store.task(task.id);
    // An attention reason the stall check (or any other fault) just recorded owns
    // the visible cause; "Worker running" must never overwrite it mid-turn.
    if (after.phase === "needs_attention" || after.resolution.attention)
      return null;
    // The check may have released this worker on proof that it is gone (Spec 068
    // §3): no worker is bound any more, so the observation describes a stale
    // display, not a running turn, and the release's own cause stays.
    if (!after.agentId || after.runId !== current.runId) return null;
    engine.note(
      task.id,
      state.permissions
        ? permissionWait(current.hostId)
        : current.completion
          ? "Completion received; worker is still active"
          : (shellNotice ?? "Worker running"),
      "lifecycle",
    );
    return null;
  }
  if (observation === "transient") return null;
  if (await resolution.heavyRunAlive(current)) {
    // Same one-time reset as the active-worker branch above: a stamp already
    // at attempts 0 is left alone so capacity-wait sweeps write nothing.
    resetLookupBackoff(engine, current);
    if (current.runId)
      resolution.extendCallbackReminder(store.task(task.id), current.runId);
    return null;
  }
  return { kind: "stopped", state, current };
}

/** Record the observation on the task: last status, activity and any model change. */
export function recordObservation(
  engine: WorkerReconcileContext,
  task: Task,
  state: Awaited<ReturnType<Adapter["observe"]>>,
): void {
  const active = observedActive(state);
  const changed =
    task.lastAgentStatus !== state.status || task.agentActive !== active;
  const modelChanged = Boolean(
    state.model &&
      (state.model !== task.workerModel ||
        !task.workerModels.includes(state.model)),
  );
  const at = now();
  const participantActivity = workerActivityObservation(task, state, at);
  engine.store.update(
    task.id,
    {
      lastAgentStatus: state.status,
      agentActive: active,
      lastObservedAt: at,
      lastActivityAt: state.updatedAt || null,
      ...(participantActivity ? { participantActivity } : {}),
      ...(modelChanged
        ? {
            workerModel: state.model,
            workerModels: [...new Set([...task.workerModels, state.model!])],
          }
        : {}),
    },
    changed ? "agent_state" : undefined,
    state.status,
  );
}

/** Observe without settling anything: the caller owns the answer. */
export async function observeOnly(
  engine: WorkerReconcileContext,
  task: Task,
): Promise<void> {
  const state = await engine.onTaskHost(task, () =>
    engine.host.observe(task.agentId!),
  );
  if (engine.stopped) return;
  if (state.workspaceId !== task.workspaceId)
    throw new Error(
      "Worker placement changed; inspect ownership before resuming",
    );
  recordObservation(engine, engine.store.task(task.id), state);
}
