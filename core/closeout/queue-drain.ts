import { formatTaskNumber, type BoundRun } from "../../shared/contracts";

type DrainMeta = { getMeta(key: string): unknown };

type DrainStore = DrainMeta & {
  pendingRuns(): Array<{
    id: string;
    taskId: string;
    role: string;
    released: boolean;
  }>;
  operations(filter?: { states?: Array<"pending" | "running"> }): unknown[];
  task(id: string): { reference?: string | null; number?: number | null };
};

/** True only when the engine is stopped. Pause still settles in-flight work. */
export function settlementHeld(_store: DrainMeta, stopped = false): boolean {
  return Boolean(stopped);
}

/** No new run starts: paused or stopped. */
export function startsNoRuns(store: DrainMeta, stopped = false): boolean {
  return Boolean(stopped) || store.getMeta("paused") === true;
}

/**
 * Live drain wait: no unreleased run and no in-flight operation.
 * True even when the queue is not paused.
 */
export function boundDrainProjection(store: DrainStore): {
  drained: boolean;
  boundRuns: BoundRun[];
} {
  const boundRuns: BoundRun[] = store
    .pendingRuns()
    .filter((run) => !run.released)
    .map((run) => {
      let reference: string | null = null;
      try {
        const task = store.task(run.taskId);
        reference =
          task.reference ??
          (task.number ? `#${formatTaskNumber(task.number)}` : null);
      } catch {
        /* a run whose task row is gone still counts as bound */
      }
      return { taskId: run.taskId, runId: run.id, role: run.role, reference };
    });
  const inFlight = store.operations({ states: ["pending", "running"] }).length;
  return { drained: boundRuns.length === 0 && inFlight === 0, boundRuns };
}
