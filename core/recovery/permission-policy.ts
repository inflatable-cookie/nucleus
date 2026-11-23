import type { Run, Task } from "../../shared/contracts";
import type { AgentObservation } from "../host/adapter";
import { ProvenPreSendRefusalError } from "../host/errors";
import type { Resolution } from "../resolution";

/**
 * Spec 068 §4 and Decision 4: a permission prompt in a task run has nobody to
 * answer it. Nucleus declines it at once through the host's own permission
 * answer, tells the agent to carry on without it, and records the event.
 *
 * A native question (`kind: "question"`) is not a permission and keeps its own
 * route. An interactive task's worker is the operator's session and is never
 * answered for them. A host that cannot answer a permission request launches
 * task runs in its non-interactive approval mode instead (see each host adapter),
 * so it never raises one here.
 *
 * Delivery follows the durable-intent rule: the intent event is written before
 * the send, a proven pre-send refusal may be retried, and any other failure is
 * unknown and is never resent.
 */
export const PERMISSION_DENIAL_INTENT = "permission_denial_intent";
export const PERMISSION_DENIED = "permission_denied";
export const PERMISSION_DENIAL_REFUSED = "permission_denial_refused";
export const PERMISSION_DENIAL_UNKNOWN = "permission_denial_unknown";

export function permissionDenialMessage(kind: string): string {
  return `Nucleus declined your ${kind} permission request: nobody approves prompts in a task run. Carry on without that permission, using another approach if there is one. If the task cannot be done without it, report it as a blocker and name the permission you need.`;
}

type PermissionContext = Pick<Resolution, "adapter" | "onTaskHost" | "store">;

/** Decline one pending permission on a task run. Returns whether a pending permission was answered or already is. */
export async function denyPendingPermission(
  context: PermissionContext,
  task: Task,
  run: Run | null,
  state: AgentObservation,
): Promise<boolean> {
  const pending = state.pendingRequest;
  if (!state.permissions || !pending || pending.kind === "question") return false;
  if (task.interactive && !run) return false;
  const answer = context.adapter.answerNativePermission;
  if (!answer) return false;
  const runId = run?.id ?? task.runId;
  const workspaceId = state.workspaceId || run?.workspaceId || task.workspaceId;
  if (!runId || !workspaceId) return false;
  const store = context.store;
  const intentId = `ns-permission-deny-${runId}-${pending.id}`.slice(0, 500);
  const recorded = new Map<string, number>();
  for (const event of store.eventsAll(task.id))
    if (event.detail.startsWith(`${intentId}:`)) recorded.set(event.kind, (recorded.get(event.kind) ?? 0) + 1);
  // Sent, sent with an unknown outcome, or an intent no proven refusal settled:
  // never again. The next observation no longer lists an answered request.
  if (recorded.has(PERMISSION_DENIED) || recorded.has(PERMISSION_DENIAL_UNKNOWN)) return true;
  if ((recorded.get(PERMISSION_DENIAL_INTENT) ?? 0) > (recorded.get(PERMISSION_DENIAL_REFUSED) ?? 0)) return true;
  const detail = (extra: Record<string, unknown> = {}) =>
    `${intentId}: ${JSON.stringify({ runId, agentId: state.id, requestId: pending.id, kind: pending.kind, ...extra })}`.slice(0, 4000);
  store.event(task.id, PERMISSION_DENIAL_INTENT, detail());
  try {
    await context.onTaskHost(task, () =>
      answer.call(context.adapter, state.id, workspaceId, pending.id, "decline", intentId),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    store.event(task.id, error instanceof ProvenPreSendRefusalError ? PERMISSION_DENIAL_REFUSED : PERMISSION_DENIAL_UNKNOWN, detail({ reason }));
    return false;
  }
  const message = permissionDenialMessage(pending.kind);
  const send = context.adapter.steerOrNotify ?? context.adapter.enqueueMessage;
  let delivered = "not sent: this host has no message route";
  if (send)
    try {
      await context.onTaskHost(task, () => send.call(context.adapter, state.id, `${intentId}-message`, message));
      delivered = "delivered";
    } catch (error) {
      delivered = `unknown: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
    }
  store.event(task.id, PERMISSION_DENIED, detail({ message: delivered }));
  return true;
}
