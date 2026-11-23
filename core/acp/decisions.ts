/** Decide which operator decisions belong to an authenticated ACP session. */
import type { Decision } from "../../shared/contracts";
import type { AcpCaller, AcpElicitation } from "../../shared/acp/surface";
import type { Store } from "../store/store";
import { hostKindOf } from "../../shared/host-kind";
import { clipText } from "../../shared/task-detail-summary";
import { createHash } from "node:crypto";

/** Spec 032: every operator decision belongs to one host's pinned Inbox (nucleus#1538). */
export type DecisionScope = { kind: "inbox"; hostId: string };

const ownerKey = (id: string, version: number) =>
  `acpOwner:${createHash("sha256")
    .update(JSON.stringify([id, version]))
    .digest("hex")}`;
/** The Inbox binding one version recorded, if it recorded one. */
export function boundOwner(
  store: Store,
  decision: Pick<Decision, "id" | "version">,
): DecisionScope | undefined {
  const stored = store.getMeta<unknown>(
    ownerKey(decision.id, decision.version),
  );
  // A version bound before nucleus#1538 to a task thread has no owner any more: only
  // an Inbox binding owns a decision, so the next offer records the Inbox instead.
  return stored &&
    typeof stored === "object" &&
    (stored as { kind?: unknown }).kind === "inbox"
    ? (stored as DecisionScope)
    : undefined;
}
export function bindOwner(
  store: Store,
  decision: Pick<Decision, "id" | "version">,
  scope: DecisionScope,
): DecisionScope {
  return store.transaction(() => {
    const existing = boundOwner(store, decision);
    if (existing) return existing;
    store.setMeta(ownerKey(decision.id, decision.version), scope);
    return scope;
  });
}

/**
 * The Inbox a decision belongs to: a linked T3 task's host picks it, so a planner
 * sign-off reaches the host that owns the task, and a decision that links no such task
 * belongs to the host whose Inbox is offering it (Spec 032, Tom 2026-11-22).
 */
export function proposedOwner(
  store: Store,
  decision: Decision,
  connectedHost: string,
): DecisionScope {
  for (const id of decision.links.tasks) {
    const task = store.taskOrNull(id);
    if (
      !task ||
      task.removedAt ||
      !task.hostId ||
      hostKindOf(task.hostId) !== "t3code"
    )
      continue;
    return { kind: "inbox", hostId: task.hostId };
  }
  return { kind: "inbox", hostId: connectedHost };
}
/** A decision is offered to, and answerable from, the Inbox that owns it — never a task. */
export function matchesOwner(owner: DecisionScope, caller: AcpCaller): boolean {
  return caller.kind === "inbox" && caller.hostId === owner.hostId;
}
/**
 * The card one inbox shows. A decision linked to a task is named by that task's
 * reference and title, as the board's task link is, so the operator can tell which
 * task is asking (nucleus#1538).
 */
export function acpElicitation(
  decision: Decision,
  linkedTask: { reference: string | null; title: string } | null = null,
): AcpElicitation {
  const taskLine = linkedTask
    ? [linkedTask.reference, linkedTask.title].filter(Boolean).join(" · ")
    : "";
  return {
    id: decision.id,
    version: decision.version,
    headline: clipText(
      taskLine || decision.headline || decision.question.slice(0, 140),
      140,
    ),
    question: decision.question,
    choices:
      decision.choices ??
      decision.options.map((label) => ({ label, consequence: "" })),
  };
}
