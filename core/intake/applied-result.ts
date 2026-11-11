import type { Store } from "../store/store";

/** The application event and its task transition must share a transaction. */
function hasApplicationEvent(
  store: Store,
  taskId: string,
  runId: string,
): boolean {
  return Boolean(
    store.db
      .prepare(
        "SELECT 1 FROM events WHERE taskId=? AND kind='run_result_applied' AND detail=? LIMIT 1",
      )
      .get(taskId, runId),
  );
}

export function resultApplied(
  store: Store,
  taskId: string,
  runId: string,
): boolean {
  if (hasApplicationEvent(store, taskId, runId)) return true;
  const run = store.run(runId);
  if (!run || run.taskId !== taskId) return false;
  if (run.role === "reviewer") {
    if (store.task(taskId).proofOnlyResult?.reviewerRunId === runId)
      return true;
    return Boolean(
      store.db
        .prepare(
          "SELECT 1 FROM events WHERE taskId=? AND kind IN ('review_result_applied','review_reapplied') AND detail=? LIMIT 1",
        )
        .get(taskId, runId),
    );
  }
  if (run.role === "recovery" && run.completion)
    return Boolean(
      store.db
        .prepare(
          "SELECT 1 FROM events WHERE taskId=? AND kind IN ('coordinator_action_applied','coordinator_action_refused') AND detail=? LIMIT 1",
        )
        .get(taskId, run.completion.eventId),
    );
  return false;
}

export function recordResultApplied(
  store: Store,
  taskId: string,
  runId: string,
): void {
  if (!hasApplicationEvent(store, taskId, runId))
    store.event(taskId, "run_result_applied", runId);
}
