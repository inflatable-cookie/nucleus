/** Decide which operator decisions belong to an authenticated ACP session. */
import type { Decision } from "../../shared/contracts";
import type { AcpCaller, AcpElicitation } from "../../shared/acp/surface";
import type { Store } from "../store/store";
import { hostKindOf } from "../../shared/host-kind";
import { createHash } from "node:crypto";

export type DecisionScope = { kind: "inbox"; hostId: string } | { kind: "task"; taskId: string; hostId: string; sessionId: string };
export type ParentStatus = { state: "parent"; sessionId: string } | { state: "absent" } | { state: "unknown" };
export type ParentLookup = (hostId: string, taskId: string) => ParentStatus;

const ownerKey = (id: string, version: number) => `acpOwner:${createHash("sha256").update(JSON.stringify([id, version])).digest("hex")}`;
export function boundOwner(store: Store, decision: Pick<Decision, "id" | "version">): DecisionScope | undefined {
  return store.getMeta<DecisionScope>(ownerKey(decision.id, decision.version));
}
export function bindOwner(store: Store, decision: Pick<Decision, "id" | "version">, scope: DecisionScope): DecisionScope {
  return store.transaction(() => {
    const existing = boundOwner(store, decision);
    if (existing) return existing;
    store.setMeta(ownerKey(decision.id, decision.version), scope);
    return scope;
  });
}

/** A linked T3 task supplies both the host identity and its recorded parent. */
export function proposedOwner(store: Store, decision: Decision, inboxHost: string, parent: ParentLookup): DecisionScope {
  let fallback: string | null = null;
  for (const id of decision.links.tasks) {
    const task = store.taskOrNull(id);
    if (!task || task.removedAt || !task.hostId || hostKindOf(task.hostId) !== "t3code") continue;
    fallback ??= task.hostId;
    const status = parent(task.hostId, task.id);
    if (status.state === "parent")
      return { kind: "task", taskId: task.id, hostId: task.hostId, sessionId: status.sessionId };
  }
  return { kind: "inbox", hostId: fallback ?? inboxHost };
}
export function matchesOwner(owner: DecisionScope, caller: AcpCaller): boolean {
  return owner.kind === "inbox"
    ? caller.kind === "inbox" && caller.hostId === owner.hostId
    : caller.kind !== "inbox" && caller.taskId === owner.taskId && (!caller.sessionId || caller.sessionId === owner.sessionId);
}
export function acpElicitation(decision: Decision): AcpElicitation {
  return { id: decision.id, version: decision.version, headline: decision.headline ?? decision.question.slice(0, 140),
    question: decision.question, choices: decision.choices ?? decision.options.map(label => ({ label, consequence: "" })) };
}
