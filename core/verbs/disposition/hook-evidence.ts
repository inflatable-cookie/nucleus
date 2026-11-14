import type { Task } from "../../../shared/contracts";
import { hookRecordSchema, type HookRecord } from "../../../shared/hooks";
import type { Store } from "../../store/store";

/**
 * Whether one recorded occurrence refused the transition it guarded: blocked, or
 * failed on a required delivery. One rule, read by every settlement below.
 */
const refusedTransition = (record: HookRecord): boolean =>
  record.state === "blocked" || record.state === "failed" && record.delivery === "required";

/**
 * The emitted occurrences, decoded once as the durable records they are. A
 * value the schema does not accept is not evidence, so it settles nothing.
 */
function emittedHookRecords(records: readonly unknown[]): HookRecord[] {
  return records.flatMap(value => {
    const parsed = hookRecordSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Every refusal line one occurrence carries, whitespace-normalised and de-duplicated. */
function refusalLines(record: HookRecord): string[] {
  return [...new Set([record.error, record.summary, record.result?.summary ?? ""]
    .map(value => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

/** One occurrence repeated a refusal line another occurrence recorded. */
function repeatsRefusal(record: HookRecord, previous: HookRecord): boolean {
  const lines = new Set(refusalLines(record));
  return refusalLines(previous).some(line => lines.has(line));
}

const cancellationOccurrences = (records: readonly unknown[]): HookRecord[] =>
  emittedHookRecords(records).filter(record => record.event === "task.cancelled");

/**
 * A pre-workspace admission refusal is durable proof that no task delivery began:
 * no workspace, agent, run, completion or PR identity was ever recorded when the
 * task's own admission hook refused it.
 */
function preWorkspaceAdmissionRefusals(store: Store, task: Task): HookRecord[] {
  if (task.workspaceIntent || task.agentIntent || task.workspaceId || task.agentId || task.completion || task.prUrl || task.prHead || task.resolution.currentRunId) return [];
  return store.hookEvents(task.id).filter(record => record.event === "task.pre_dispatch" && refusedTransition(record));
}

/**
 * An operator disposition can settle a refused task before Queue created any
 * delivery. Preserve the cancellation occurrence as evidence when its durable
 * hook result repeats the admission refusal, even when a later retry replaced
 * the top-level error with an integration preflight failure.
 */
export function settlesPreWorkspaceDispositionHook(store: Store, task: Task, cancellationRecords: readonly unknown[]): boolean {
  const admissions = preWorkspaceAdmissionRefusals(store, task);
  if (!admissions.length) return false;
  return cancellationOccurrences(cancellationRecords).some(cancelled =>
    refusedTransition(cancelled) && admissions.some(admission => repeatsRefusal(cancelled, admission)));
}

/**
 * Early legacy tasks may predate committed instruction artifacts. Cancellation
 * can preserve that legacy evidence when the same required repository hook has
 * already refused the task's blocked transition for exactly that reason: both
 * occurrences carry no instruction artifact, the same hook and mode, and the
 * same refusal line.
 */
export function settlesLegacyInstructionlessDispositionHook(store: Store, task: Task, cancellationRecords: readonly unknown[]): boolean {
  if (task.instruction || !task.completion || !["blocked", "error"].includes(task.completion.status)) return false;
  if (task.disposition?.workDisposition !== "preserve") return false;
  const blocked = store.hookEvents(task.id).filter(record => record.event === "task.blocked"
    && record.delivery === "required" && refusedTransition(record));
  if (!blocked.length) return false;
  return cancellationOccurrences(cancellationRecords).some(cancelled =>
    cancelled.delivery === "required" && cancelled.instruction === null && blocked.some(previous =>
      previous.instruction === null && cancelled.hookId === previous.hookId && cancelled.mode === previous.mode
      && repeatsRefusal(cancelled, previous)));
}
