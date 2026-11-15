import type { Task } from "../../shared/contracts";
import { dispatchBlocked, fairSlotRequestOrder } from "./capacity";

export function queuedDispatchOrder(tasksNewestFirst:Task[]) {
  return fairSlotRequestOrder(tasksNewestFirst, task => task.phase === "queued" && !dispatchBlocked(task));
}

