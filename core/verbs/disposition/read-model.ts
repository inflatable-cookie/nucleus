import type { Store } from "../../store/store";

/** Stored detail for operator controls; board and next policy stays in shared/disposition. */
export function dispositionDetail(store: Store, taskId: string) {
  const task = store.task(taskId);
  return { taskId: task.id, version: task.version, phase: task.phase, disposition: task.disposition };
}
