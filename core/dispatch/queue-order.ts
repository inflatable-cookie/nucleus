import type { Task } from "../../shared/contracts";
import { dispatchBlocked, fairSlotRequestOrder } from "./capacity";

export function queuedDispatchOrder(
  tasksNewestFirst: Task[],
  occupied: Task[] = [],
) {
  return fairSlotRequestOrder(
    tasksNewestFirst,
    (task) => task.phase === "queued" && !dispatchBlocked(task),
    occupied,
  );
}
