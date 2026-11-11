import type { Task } from "../../shared/contracts";
import { dispatchBlocked, fairSlotRequestOrder } from "./capacity";

/** Tasks reconciled before the audit hands the event loop back to acceptance and reads. */



export function queuedDispatchOrder(tasksNewestFirst:Task[]) {
  return fairSlotRequestOrder(tasksNewestFirst, task => task.phase === "queued" && !dispatchBlocked(task));
}

