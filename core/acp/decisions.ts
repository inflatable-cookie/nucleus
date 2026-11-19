/** Decide which operator decisions belong to an authenticated ACP session. */
import type { Decision } from "../../shared/contracts";
import type { AcpCaller, AcpElicitation } from "../../shared/acp/surface";
import type { Store } from "../store/store";
import { hostKindOf } from "../../shared/host-kind";

/** The first live T3 task owns the question; a decision is never offered twice. */
function taskOwner(store: Store, decision: Decision): string | null {
  for (const id of decision.links.tasks) {
    const task = store.taskOrNull(id);
    if (task && !task.removedAt && task.hostId && hostKindOf(task.hostId) === "t3code") return task.id;
  }
  return null;
}

export function acpDecisions(store: Store, caller: AcpCaller): Decision[] {
  if (caller.kind !== "inbox") {
    const task = store.taskOrNull(caller.taskId);
    if (!task || task.removedAt || !task.hostId || hostKindOf(task.hostId) !== "t3code") return [];
  }
  return store.listDecisions({ status: "open" }).filter(decision => {
    const task = taskOwner(store, decision);
    return caller.kind === "inbox" ? task === null : task === caller.taskId;
  });
}

export function acpElicitation(decision: Decision): AcpElicitation {
  return { id: decision.id, version: decision.version, headline: decision.headline ?? decision.question.slice(0, 140),
    question: decision.question, choices: decision.choices ?? decision.options.map(label => ({ label, consequence: "" })) };
}
