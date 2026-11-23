import type { Run, Task } from "../../shared/contracts";
import type { AgentObservation } from "../host/adapter";
import { ProvenPreSendRefusalError } from "../host/errors";
import { isQuantumDeadlineExceeded } from "../scheduling/pass-snapshot";
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
/** How long a confirmed decline has to leave the host's pending list before the request reads as unanswered. */
export const PERMISSION_REPORT_WINDOW_MS = 60_000;

export function permissionDenialMessage(kind: string): string {
  return `Nucleus declined your ${kind} permission request: nobody approves prompts in a task run. Carry on without that permission, using another approach if there is one. If the task cannot be done without it, report it as a blocker and name the permission you need.`;
}

type PermissionContext = Pick<Resolution, "adapter" | "onTaskHost" | "store">;

/** Decline one pending permission on a task run. True while that decline settles the request; false hands it to stall detection. */
export async function denyPendingPermission(
  context: PermissionContext,
  task: Task,
  run: Run | null,
  state: AgentObservation,
): Promise<boolean> {
  const pending = state.pendingRequest;
  if (!state.permissions || !pending || pending.kind === "question")
    return false;
  if (task.interactive && !run) return false;
  const answer = context.adapter.answerNativePermission;
  if (!answer) return false;
  const runId = run?.id ?? task.runId;
  const workspaceId = state.workspaceId || run?.workspaceId || task.workspaceId;
  if (!runId || !workspaceId) return false;
  const store = context.store;
  const intentId = `ns-permission-deny-${runId}-${pending.id}`.slice(0, 500);
  let denials = 0,
    settledDenialAt = 0,
    intents = 0,
    refusals = 0;
  for (const event of store.eventsAll(task.id)) {
    if (!event.detail.startsWith(`${intentId}:`)) continue;
    if (event.kind === PERMISSION_DENIED)
      settledDenialAt = Date.parse(event.at) || 0;
    if (
      event.kind === PERMISSION_DENIED ||
      event.kind === PERMISSION_DENIAL_UNKNOWN
    )
      denials++;
    if (event.kind === PERMISSION_DENIAL_INTENT) intents++;
    if (event.kind === PERMISSION_DENIAL_REFUSED) refusals++;
  }
  // The request still listed is the settling lookup. A decline the host
  // confirmed gets one report window to leave the list. A decline with an
  // unknown outcome, or an intent no proven refusal settled, is never resent:
  // the request is left to ordinary stall detection, which names it.
  if (
    settledDenialAt &&
    Date.now() - settledDenialAt < PERMISSION_REPORT_WINDOW_MS
  )
    return true;
  if (denials || intents > refusals) return false;
  const detail = (extra: Record<string, unknown> = {}) =>
    `${intentId}: ${JSON.stringify({ runId, agentId: state.id, requestId: pending.id, kind: pending.kind, ...extra })}`.slice(
      0,
      4000,
    );
  const message = permissionDenialMessage(pending.kind);
  store.event(task.id, PERMISSION_DENIAL_INTENT, detail());
  try {
    await context.onTaskHost(task, () =>
      answer.call(
        context.adapter,
        state.id,
        workspaceId,
        pending.id,
        "decline",
        intentId,
        message,
      ),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const preSend =
      error instanceof ProvenPreSendRefusalError ||
      (isQuantumDeadlineExceeded(error) && error.preSend);
    store.event(
      task.id,
      preSend ? PERMISSION_DENIAL_REFUSED : PERMISSION_DENIAL_UNKNOWN,
      detail({ reason }),
    );
    return false;
  }
  // A host that steers into the live turn gets the message there; a host whose
  // decline carries it (Paseo) has no steer, so the agent is told once.
  const send = context.adapter.steerOrNotify;
  let delivered = "carried by the host's decline";
  if (send)
    try {
      await context.onTaskHost(task, () =>
        send.call(context.adapter, state.id, `${intentId}-message`, message),
      );
      delivered = "delivered";
    } catch (error) {
      delivered =
        `unknown: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          1000,
        );
    }
  store.event(task.id, PERMISSION_DENIED, detail({ message: delivered }));
  return true;
}
