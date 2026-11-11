import type { Task } from "../../../shared/contracts";
import type { HookRecord } from "../../../shared/hooks";
import type { Store } from "../../store/store";

function hookRefusals(record: HookRecord): string[] {
  return [...new Set([record.error, record.summary, record.result?.summary ?? ""]
    .map(value => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

/** A pre-workspace admission refusal is durable proof that no task delivery began. */
function preWorkspaceAdmissionRefusals(store: Store, task: Task): HookRecord[] {
  if (task.workspaceIntent || task.agentIntent || task.workspaceId || task.agentId || task.completion || task.prUrl || task.prHead || task.resolution.currentRunId) return [];
  return store.hookEvents(task.id).filter(record => record.event === "task.pre_dispatch" &&
    (record.state === "blocked" || record.state === "failed" && record.delivery === "required"));
}

/**
 * An operator disposition can settle a refused task before Queue created any
 * delivery. Preserve the cancellation occurrence as evidence when its durable
 * hook result repeats the admission refusal, even when a later retry replaced
 * the top-level error with an integration preflight failure.
 */
export function settlesPreWorkspaceDispositionHook(store: Store, task: Task, cancellationRecords: unknown[]): boolean {
  const admissions = preWorkspaceAdmissionRefusals(store, task);
  if (!admissions.length) return false;
  const cancellations = cancellationRecords.filter((record): record is HookRecord =>
    typeof record === "object" && record !== null && "event" in record && (record as HookRecord).event === "task.cancelled");
  return cancellations.some(cancelled => {
    if (!(cancelled.state === "blocked" || cancelled.state === "failed" && cancelled.delivery === "required")) return false;
    const refusalSet = new Set(hookRefusals(cancelled));
    return admissions.some(admission => hookRefusals(admission).some(refusal => refusalSet.has(refusal)));
  });
}

/**
 * Early legacy tasks may predate committed instruction artifacts. Cancellation
 * can preserve that legacy evidence when the same required repository hook has
 * already refused the task's blocked transition for exactly that reason.
 */
export function settlesLegacyInstructionlessDispositionHook(store: Store, task: Task, cancellationRecords: unknown[]): boolean {
  if (task.instruction || !task.completion || !["blocked", "error"].includes(task.completion.status)) return false;
  if (task.disposition?.workDisposition !== "preserve") return false;
  const blocked = store.hookEvents(task.id).filter(record => record.event === "task.blocked" &&
    record.delivery === "required" && (record.state === "blocked" || record.state === "failed"));
  if (!blocked.length) return false;
  const cancellations = cancellationRecords.filter((record): record is HookRecord =>
    typeof record === "object" && record !== null && "event" in record &&
    (record as HookRecord).event === "task.cancelled" && (record as HookRecord).delivery === "required");
  return cancellations.some(cancelled => blocked.some(previous => {
    if (cancelled.hookId !== previous.hookId || cancelled.mode !== previous.mode) return false;
    const repeated = hookRefusals(cancelled).filter(refusal => /no committed instruction artifact/i.test(refusal));
    return repeated.some(refusal => hookRefusals(previous).includes(refusal));
  }));
}
