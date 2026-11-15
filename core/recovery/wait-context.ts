import type { Task } from "../../shared/contracts";
import type { WaitStateContext } from "../../shared/wait-state";
import { boardDispatchHoldApplies, BOARD_DISPATCH_HOLD_REASON } from '../../shared/board-dispatch-hold';
import { holdsOf } from '../../shared/contracts';
import { DISPATCH_WAIT_REASON, routeUnavailableStop } from '../../shared/task-stop';
import { waitReasonFor } from '../../shared/wait-state';
import { DISPATCH_HELD_REASON, projectInFlightWaitReason } from '../dispatch/capacity';
import type { Store } from "../store/store";

/** Read current Queue facts for the derived wait projection. */
export function taskWaitStateContext(
  store: Store,
  task: Task,
  decisionId: string | null,
  slotAdmissionReason: (task: Task) => string = () => "",
): WaitStateContext {
  const waitsFor = task.prerequisiteWait && !task.prerequisiteWait.releasedAt
    ? task.prerequisiteWait.waitsFor : task.phase === "queued" ? task.dependsOn : [];
  const dependencyWait = waitsFor.length ? store.dependencyWait({ dependsOn: waitsFor }) : "";
  const unfinished = waitsFor.filter(id => {
    try { return store.taskReference(id).phase !== "done"; }
    catch { return true; }
  });
  return {
    decisionId,
    dependencyWait,
    prerequisiteOwner: unfinished.join(", ") || null,
    prerequisiteReason: task.prerequisiteWait && !task.prerequisiteWait.releasedAt ? task.prerequisiteWait.reason : null,
    slotAdmissionReason: slotAdmissionReason(task) || (task.phase === 'queued' ? projectInFlightWaitReason(task, store.activeCapacityTasks(), store.projectKeyResolver(), candidate => store.projectInFlightLimitFor(candidate)) : '') || null,
  };
}

/** Wait text for a queued task is a projection of present facts, never a write. */
export function queuedReason(store: Store, task: Task, context: WaitStateContext, externalWait: (task: Task) => string = () => ''): string {
  if (task.phase !== 'queued') return task.reason;
  if (context.dependencyWait) return context.dependencyWait;
  if (holdsOf(task).dispatch) return DISPATCH_HELD_REASON;
  if (!store.getMeta<boolean>('paused') && store.getMeta<boolean>('dispatchHeld') && boardDispatchHoldApplies(task)) return BOARD_DISPATCH_HOLD_REASON;
  if (context.slotAdmissionReason) return context.slotAdmissionReason;
  if (routeUnavailableStop(task))
    return store.routingRetryAllowed(task) ? DISPATCH_WAIT_REASON : task.reason;
  // A reason that is one of Queue's own declared waits (the owner of that list is
  // `shared/wait-state`) is the wait projection already; free text is the task's
  // own progress detail and stands. Never re-read a wait out of reason prose.
  if (task.reason && task.reason !== DISPATCH_WAIT_REASON && !waitReasonFor(task.reason)) return task.reason;
  return externalWait(task) || DISPATCH_WAIT_REASON;
}
