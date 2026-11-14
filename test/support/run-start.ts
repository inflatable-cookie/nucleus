import type { Store } from "../../core/store/store";

/**
 * The recorded start of a run the store keeps no run row for (nucleus#1187): a
 * task's initial worker lives on the task row (`runId`, `agentId`), so its dispatch
 * intent and its `agent_created` event are the only durable evidence of when its
 * first run began, and the wall-time budget measures from them. The rows are
 * written through the store and then dated, exactly as the real launch wrote them.
 */
export function recordRunStart(store: Store, taskId: string, at: string, runId = "initial", agentId = "worker") {
  store.event(taskId, "agent_intent", runId);
  store.event(taskId, "agent_created", agentId);
  for (const row of store.db.prepare("SELECT id FROM events WHERE taskId=? AND kind IN ('agent_intent','agent_created') ORDER BY id DESC LIMIT 2").all(taskId) as { id: number }[])
    store.db.prepare("UPDATE events SET at=? WHERE id=?").run(at, row.id);
}

/** Forget every recorded run start, so the task reads as never dispatched again. */
export function clearRunStarts(store: Store, taskId: string) {
  store.db.prepare("DELETE FROM events WHERE taskId=? AND kind IN ('agent_intent','agent_created','dispatch_intent','run_intent')").run(taskId);
}
