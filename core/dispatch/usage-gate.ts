/**
 * Spec 052 (Tom, 2026-11-17): at the Low usage level a high or very-high
 * complexity submission needs the operator's permission before it runs. Nucleus
 * opens one decision on the board and holds the task with a dispatch fence until
 * that decision is approved; nothing else in the level waits for a sign-off.
 *
 * The gate is decided at admission: `store.insert` records `usageGate` only when
 * the level in force then is Low and the complexity qualifies, so work already
 * running when the level changes is never gated. The record lives on the task,
 * so the board reads the gate with the task. One per-task pass opens the
 * question, applies the answer and clears only the fence it placed, and it is
 * idempotent.
 */
import type { CapabilityLevel, Profile, Task, UsageLevel } from "../../shared/contracts";
import { holdsOf, OPERATOR_BOARD_CALLER, taskOwner } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { submissionNeedsPermission } from "../../shared/pool";
import type { Decisions } from "../planning/decisions";
import type { Store } from "../store/store";
import { now } from "../store/store";

/** The visible reason a gated queued task waits under. */
export const USAGE_GATE_WAIT = "Waiting for the operator: the Low usage level needs permission for this high-complexity task";
export const USAGE_GATE_APPROVE = "Approve: run this task at the Low usage level";
export const USAGE_GATE_DECLINE = "Decline: keep it held";
/** The fence reason for the operator; it names the level and complexity. */
export const usageGateHoldReason = (complexity: CapabilityLevel) =>
  `Low usage level: a ${complexity.replaceAll("_", "-")} complexity task needs the operator's approval before it runs (Spec 052)`;

/**
 * Whether this task's submission still needs the operator's permission before a
 * run. Only a task admitted under the gate carries the record; the level and the
 * complexity decide whether it is still in force.
 */
export function usageGateBlocked(task: Pick<Task, "complexity" | "usageGate">, level: UsageLevel): boolean {
  return Boolean(task.usageGate) && task.usageGate!.status !== "approved" && submissionNeedsPermission(level, task.complexity);
}

/** Withdraw an open gate question; a closed one is left as it is. */
function withdraw(decisions: Decisions, decisionId: string | null | undefined, reason: string): void {
  if (!decisionId) return;
  try {
    const decision = decisions.get({ id: decisionId });
    if (decision.status === "open") decisions.withdraw({ id: decision.id, version: decision.version, reason, withdrawnBy: "queue" });
  } catch { /* an unreadable question has nothing left to withdraw */ }
}

/**
 * Place the gate's dispatch fence only when the task carries none. An existing
 * board or planner hold is left exactly as it is: the gate opens its question
 * beside it and later clears only a fence it placed itself.
 */
function placeHold(existing: ReturnType<typeof holdsOf>["dispatch"], complexity: CapabilityLevel, at: string) {
  if (existing) return null;
  return { at, fence: { owner: OPERATOR_BOARD_CALLER, reason: usageGateHoldReason(complexity), at, generation: 1, until: null } };
}

/** Drop only the fence this gate placed; an operator's own later hold is never cleared. */
function clearHold(task: Task): Pick<Task, "holds"> | null {
  const holds = holdsOf(task);
  const fence = holds.dispatch;
  if (!fence || fence.owner !== OPERATOR_BOARD_CALLER || fence.at !== task.usageGate?.holdAt) return null;
  const { dispatch: _dispatch, ...rest } = holds;
  return { holds: rest };
}

/**
 * One pass over a task's Low-level submission gate. Idempotent: a task whose
 * gate is settled and whose fence is already clear is not written.
 */
export function reconcileUsageGate(store: Store, decisions: Decisions, taskId: string, _profiles: readonly Profile[] = []): void {
  let task: Task;
  try { task = store.task(taskId); } catch { return; }
  if (task.removedAt) return;
  const level = store.usageLevel();
  const gate = task.usageGate;
  // No admission record: the task was submitted under a level that did not gate
  // it. A later level change never retroactively holds work already accepted.
  if (!gate) return;
  const needed = submissionNeedsPermission(level, task.complexity);

  // The level or the complexity moved away: withdraw a question nobody owes an
  // answer to, clear the fence this gate placed, and forget the record.
  if (!needed) {
    if (gate?.status === "pending") withdraw(decisions, gate.decisionId, `The ${level} usage level no longer needs permission for this task`);
    const cleared = clearHold(task);
    if (gate || cleared) store.update(task.id, { ...(cleared ?? {}), usageGate: null, ...(task.reason === USAGE_GATE_WAIT ? { reason: "Waiting for dispatch" } : {}) }, "usage_gate_cleared",
      JSON.stringify({ level, complexity: task.complexity }));
    return;
  }
  if (task.phase === "done" || task.phase === "cancelled") {
    if (gate?.status === "pending") withdraw(decisions, gate.decisionId, "The task finished; the Low usage level permission no longer applies");
    return;
  }
  if (gate?.status === "approved") return;
  if (gate?.status === "declined") return; // Held until the level or the complexity changes.

  // A question already asked: read its answer. Only a board answer counts.
  if (gate?.decisionId) {
    let decision: ReturnType<Decisions["get"]> | null = null;
    try { decision = decisions.get({ id: gate.decisionId }); } catch { decision = null; }
    if (decision?.status === "open") return;
    const answer = decision?.status === "answered" ? decision.answer : null;
    const approved = Boolean(answer && !answer.relayed && answer.answeredBy === OPERATOR_BOARD_CALLER && answer.text.trim() === USAGE_GATE_APPROVE);
    const at = now();
    if (approved) {
      const cleared = clearHold(task);
      store.update(task.id, { ...(cleared ?? {}), usageGate: { ...gate, status: "approved", at, note: "" },
        ...(task.reason === USAGE_GATE_WAIT ? { reason: "Waiting for dispatch" } : {}) }, "usage_gate_approved",
        JSON.stringify({ decisionId: gate.decisionId, level, complexity: task.complexity }));
      return;
    }
    const note = !decision ? "The permission decision is gone" : !answer ? `The permission decision was ${decision.status}`
      : answer.relayed ? "A relayed answer does not grant permission; answer on the board" : (answer.text.trim() || "Declined");
    store.update(task.id, { usageGate: { ...gate, status: "declined", at, note: note.slice(0, 400) } }, "usage_gate_declined",
      JSON.stringify({ decisionId: gate.decisionId, level, complexity: task.complexity, note: note.slice(0, 400) }));
    return;
  }

  // A question Nucleus could not place leaves the fence standing with its reason
  // recorded; the owner's exit is the same (lower the complexity or raise the level).
  if (!gate.decisionId && gate.note) return;
  // Nothing asked yet: one decision on the board and one dispatch fence on the task.
  const origin = normalizeRepositoryOrigin(task.repository ?? "");
  const complexity = task.complexity ?? "medium";
  let decision: ReturnType<Decisions["add"]>;
  try { decision = decisions.add({
    askedBy: taskOwner(task),
    project: origin ? { origin, path: task.repoPath } : null,
    tasks: [task.id],
    question: `${task.reference ?? task.id}: run this ${complexity.replaceAll("_", "-")} complexity task at the Low usage level?`,
    context: [`Task: ${task.title}`, "",
      "The Low usage level needs permission for high and very-high complexity work before it runs.",
      "Approve to dispatch it one tier below its complexity; it can climb back to its requested tier after review changes.",
      "Decline to keep it held: lower its complexity or raise the usage level to release it."].join("\n").slice(0, 20000),
    options: [USAGE_GATE_APPROVE, USAGE_GATE_DECLINE],
    recommendation: USAGE_GATE_APPROVE,
  }); } catch (error) {
    const at = now();
    const note = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    const holds = holdsOf(task);
    const placed = placeHold(holds.dispatch, complexity, at);
    store.update(task.id, {
      ...(placed ? { holds: { ...holds, dispatch: placed.fence } } : {}),
      usageGate: { decisionId: null, status: "pending", level, complexity, holdAt: placed?.at ?? null, at, note },
      ...(placed ? { reason: USAGE_GATE_WAIT } : {}),
    }, "usage_gate_unplaceable", JSON.stringify({ level, complexity, note }));
    return;
  }
  const at = now();
  const holds = holdsOf(task);
  const placed = placeHold(holds.dispatch, complexity, at);
  store.update(task.id, {
    ...(placed ? { holds: { ...holds, dispatch: placed.fence } } : {}),
    usageGate: { decisionId: decision.id, status: "pending", level, complexity, holdAt: placed?.at ?? null, at, note: "" },
    ...(placed ? { reason: USAGE_GATE_WAIT } : {}),
  }, "usage_gate_requested", JSON.stringify({ decisionId: decision.id, level, complexity, held: Boolean(placed) }));
}
