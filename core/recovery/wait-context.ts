import type { Task } from "../../shared/contracts";
import type { WaitStateContext } from "../../shared/wait-state";
import {
  boardDispatchHoldApplies,
  BOARD_DISPATCH_HOLD_REASON,
} from "../../shared/board-dispatch-hold";
import { holdsOf } from "../../shared/contracts";
import {
  DISPATCH_WAIT_REASON,
  routeUnavailableStop,
  taskStopRecord,
} from "../../shared/task-stop";
import { TASK_PROGRESSING_REASON } from "../../shared/task-detail-summary";
import {
  DISPATCH_HELD_REASON,
  projectInFlightWaitReason,
  queuedSlotObservationPending,
  slotRequestFenced,
} from "../dispatch/capacity";
import type { Store } from "../store/store";
import { hostOutageIntervals } from "../scheduling/host-outage";
import { HOST_WAIT_PRESERVED_STOPS } from "../../shared/host-outage";

/** The typed stop identifies the recorded occurrence. Its detail is historical. */
export function recordedSlotWait(task: Task): boolean {
  return task.resolution.stop?.reason === "capacity";
}

/** Read current Queue facts for the derived wait projection. */
export function taskWaitStateContext(
  store: Store,
  task: Task,
  decisionId: string | null,
  slotAdmissionReason: (task: Task) => string = () => "",
): WaitStateContext {
  const waitsFor =
    task.prerequisiteWait && !task.prerequisiteWait.releasedAt
      ? task.prerequisiteWait.waitsFor
      : task.phase === "queued"
        ? task.dependsOn
        : [];
  const dependencyWait = waitsFor.length
    ? store.dependencyWait({ dependsOn: waitsFor })
    : "";
  const unfinished = waitsFor.filter((id) => {
    try {
      return store.taskReference(id).phase !== "done";
    } catch {
      return true;
    }
  });
  const slotApplies =
    !slotRequestFenced(task) &&
    !queuedSlotObservationPending(task) &&
    (task.phase === "queued" ||
      (recordedSlotWait(task) &&
        !["verifying", "done", "cancelled"].includes(task.phase)));
  const slotWait = slotApplies ? slotAdmissionReason(task) : "";
  return {
    // A finished task's budget is never read.
    hostOutages:
      task.phase === "done" || task.phase === "cancelled"
        ? []
        : hostOutageIntervals(store, task.hostId),
    decisionId,
    dependencyWait,
    prerequisiteOwner: unfinished.join(", ") || null,
    prerequisiteReason:
      task.prerequisiteWait && !task.prerequisiteWait.releasedAt
        ? task.prerequisiteWait.reason
        : null,
    slotAdmissionReason:
      slotWait ||
      (slotApplies && task.phase === "queued"
        ? projectInFlightWaitReason(
            task,
            store.activeCapacityTasks(),
            store.projectKeyResolver(),
            (candidate) => store.projectInFlightLimitFor(candidate),
          )
        : "") ||
      null,
  };
}

/** Older reason-only rows remain readable. Their text supplies no scheduling fact. */
function legacySlotText(task: Task): boolean {
  return !task.resolution.stop && task.reasonFact?.code === "slot_capacity";
}

/**
 * A queued task's host wait as the admission read words it (Spec 069 §1): the
 * outage sentence or the named host, which read as a `host_unavailable` stop, and
 * the target-host, identity and review-origin waits, which are reason text only. A queued row
 * that still stores one of these sentences from an older pass is never believed;
 * the current read replaces it.
 */
const QUEUED_HOST_STOP_TEXT = /^(?:Waiting on .+ since (\S+)|Waiting for host \S.*)$/;
const QUEUED_HOST_WAIT_TEXT =
  /^(?:Waiting on .+ since \S+|Waiting for host \S.*|Waiting for a proven host identity|Waiting for consistent run host identity|Waiting for a proven origin host|Waiting for origin host \S.*|Waiting for (?:repository|operator default) host .+|(?:Repository|Operator default) host .+ is not registered; waiting for its configuration|Waiting for .+(?: to connect after the service start|: its calls are not answering, so it takes one launch at a time))$/;
/** A started task's outage wait (`hostUnavailableDetail`), with the outage's start. */
const STARTED_HOST_WAIT_TEXT = /^Waiting on .+ since (\S+)$/;
export const isQueuedHostWait = (text: string): boolean =>
  QUEUED_HOST_WAIT_TEXT.test(text);
/** Stops a queued task's dispatch waits record; a current host wait replaces them. */
const QUEUED_DISPATCH_WAITS = new Set<string>([
  "host_unavailable",
  "capacity",
  "prerequisite",
  "route_unavailable",
  "lifecycle",
]);

/** Wait text is a projection of present facts. */
export function queuedReason(
  store: Store,
  task: Task,
  context: WaitStateContext,
  externalWait: (task: Task) => string = () => "",
): string {
  if (task.phase !== "queued") {
    if (recordedSlotWait(task) || legacySlotText(task))
      return (
        context.dependencyWait ||
        context.slotAdmissionReason ||
        TASK_PROGRESSING_REASON
      );
    return task.reason;
  }
  if (context.dependencyWait) return context.dependencyWait;
  if (holdsOf(task).dispatch) return DISPATCH_HELD_REASON;
  if (
    !store.getMeta<boolean>("paused") &&
    store.getMeta<boolean>("dispatchHeld") &&
    boardDispatchHoldApplies(task)
  )
    return BOARD_DISPATCH_HOLD_REASON;
  // A task that cannot reach a host cannot use a slot, so its host wait names it.
  const external = externalWait(task);
  if (isQueuedHostWait(external)) return external;
  if (context.slotAdmissionReason) return context.slotAdmissionReason;
  if (routeUnavailableStop(task))
    return store.routingRetryAllowed(task) ? DISPATCH_WAIT_REASON : task.reason;
  if (
    task.reason &&
    task.reasonFact?.code !== "dispatch" &&
    !recordedSlotWait(task) &&
    task.reasonFact?.code !== "prerequisite" && task.reasonFact?.code !== "qa_capacity" && task.reasonFact?.code !== "slot_capacity" &&
    task.reasonFact?.code !== "dispatch_hold" &&
    !isQueuedHostWait(task.reason) &&
    task.resolution.stop?.reason !== "host_unavailable"
  )
    return task.reason;
  return external || DISPATCH_WAIT_REASON;
}

/** Detail, board and next show the same stop and wording from the current read. */
export function taskWithCurrentWait(
  store: Store,
  task: Task,
  context: WaitStateContext,
  externalWait?: (task: Task) => string,
): Task {
  const reason = queuedReason(store, task, context, externalWait);
  const stored = task.resolution.stop;
  const currentSlot =
    context.slotAdmissionReason && reason === context.slotAdmissionReason;
  // Spec 069 §1: a queued task's host wait is read from its host now, never
  // from a stop or wait an older pass stored on the row.
  const queuedHost =
    task.phase === "queued" ? QUEUED_HOST_STOP_TEXT.exec(reason) : null;
  let stop = stored;
  let hostWait = task.resolution.hostWait;
  if (queuedHost) {
    // An owner-facing stop keeps its answer; the host wait still shows beside it.
    const since = queuedHost[1] ?? hostWait?.since ?? task.updatedAt;
    if (
      !stored ||
      (QUEUED_DISPATCH_WAITS.has(stored.reason) &&
        (stored.reason !== "host_unavailable" || stored.detail !== reason))
    )
      stop = taskStopRecord("host_unavailable", reason, null, since);
    if (queuedHost[1] && task.hostId)
      hostWait = { hostId: task.hostId, since: queuedHost[1] };
  } else if (
    currentSlot &&
    (recordedSlotWait(task) ||
      !stored ||
      ["prerequisite", "route_unavailable"].includes(stored.reason))
  )
    stop = taskStopRecord("capacity", reason, stored, task.updatedAt);
  else if (
    recordedSlotWait(task) ||
    (task.phase === "queued" &&
      stored &&
      (stored.reason === "prerequisite" ||
        stored.reason === "host_unavailable" ||
        (stored.reason === "route_unavailable" &&
          store.routingRetryAllowed(task))))
  )
    stop = null;
  if (task.phase === "queued" && !queuedHost) hostWait = null;
  let shown = reason;
  // Spec 069 §3: a started task's host wait is worked out from its host's health
  // when read (`Engine.currentExternalWait`), never stored per task. A read with
  // no host reading keeps the row as stored.
  if (task.phase !== "queued" && externalWait && task.hostId) {
    const external = externalWait(task);
    const outage = STARTED_HOST_WAIT_TEXT.exec(external);
    if (outage) {
      hostWait = { hostId: task.hostId, since: outage[1]! };
      // An owner-facing stop keeps its answer and question; the wait shows beside it.
      if (
        !stop ||
        !(HOST_WAIT_PRESERVED_STOPS as readonly string[]).includes(stop.reason)
      ) {
        if (stop?.reason !== "host_unavailable" || stop.detail !== external)
          stop = taskStopRecord("host_unavailable", external, null, outage[1]!);
        shown = external;
      }
    } else {
      // The host is not down now: an outage wait an older version stored on the
      // row is history, never the current wait. A transport deferral's own stop
      // stays until the visit that sees its host answer settles it.
      hostWait = null;
      if (
        stop?.reason === "host_unavailable" &&
        STARTED_HOST_WAIT_TEXT.test(stop.detail)
      ) {
        if (shown === stop.detail || STARTED_HOST_WAIT_TEXT.test(shown))
          shown = TASK_PROGRESSING_REASON;
        stop = null;
      }
    }
  }
  return {
    ...task,
    reason: shown,
    resolution:
      stop === stored && hostWait === task.resolution.hostWait
        ? task.resolution
        : { ...task.resolution, stop, hostWait },
  };
}
