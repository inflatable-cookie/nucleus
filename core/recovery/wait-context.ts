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
import { CAPACITY_WAIT_PREFIX, waitReasonFor } from "../../shared/wait-state";
import { TASK_PROGRESSING_REASON } from "../../shared/task-detail-summary";
import {
  DISPATCH_HELD_REASON,
  projectInFlightWaitReason,
  queuedSlotObservationPending,
  slotRequestFenced,
} from "../dispatch/capacity";
import type { Store } from "../store/store";

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
  if (context.slotAdmissionReason) return context.slotAdmissionReason;
  if (routeUnavailableStop(task))
    return store.routingRetryAllowed(task) ? DISPATCH_WAIT_REASON : task.reason;
  if (
    task.reason &&
    task.reasonFact?.code !== "dispatch" &&
    !recordedSlotWait(task) &&
    task.reasonFact?.code !== "prerequisite" && task.reasonFact?.code !== "qa_capacity" && task.reasonFact?.code !== "slot_capacity" &&
    task.reasonFact?.code !== "dispatch_hold"
  )
    return task.reason;
  return externalWait(task) || DISPATCH_WAIT_REASON;
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
  let stop = stored;
  if (
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
        (stored.reason === "route_unavailable" &&
          store.routingRetryAllowed(task))))
  )
    stop = null;
  return {
    ...task,
    reason,
    resolution:
      stop === stored ? task.resolution : { ...task.resolution, stop },
  };
}
