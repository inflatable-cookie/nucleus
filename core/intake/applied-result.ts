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

/**
 * A reviewer verdict the reviewer reported at the task's current head that the
 * lifecycle has not applied yet, or null. A replacement or a superseding reviewer
 * start must not drop it (bovine-accelerator#6863): it is a finished review at the
 * exact head, and the ordinary result path applies it.
 */
export function reportedUnappliedVerdict(
  store: Store,
  task: { id: string; prHead: string | null },
  run: {
    id: string;
    taskId: string;
    role: string;
    head: string;
    completion: { status: string; head?: string | null; runId: string } | null;
  },
): { status: "ready_to_merge" | "changes_required"; head: string } | null {
  const completion = run.completion;
  if (run.role !== "reviewer" || run.taskId !== task.id || !completion) return null;
  if (completion.runId !== run.id) return null;
  if (completion.status !== "ready_to_merge" && completion.status !== "changes_required")
    return null;
  const head = completion.head ?? run.head;
  if (!task.prHead || head !== task.prHead) return null;
  if (resultApplied(store, task.id, run.id)) return null;
  return { status: completion.status, head };
}
