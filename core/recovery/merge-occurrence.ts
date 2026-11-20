import type { Task } from "../../shared/contracts";
import { digest, type Store } from "../store/store";
import { plannerEscalations } from "../questions/ladder/records";
import { escalationWaitDetail } from "../questions/ladder/waits";

/** Identify an overtaken run. Clearing a stop needs its own occurrence proof. */
export function recoveryOvertakenByMerge(
  store: Pick<Store, "eventsAll" | "run">,
  task: Task,
): boolean {
  const { recovery, mergeHead, mergedCommit } = task.resolution;
  const number = task.reviewEntry?.prNumber ?? task.resumePrNumber ?? task.completion?.prNumber;
  if (!recovery || !recovery.runId || !number || !mergeHead || !mergedCommit)
    return false;
  try {
    const path = new URL(task.prUrl ?? "").pathname;
    if (!new RegExp(`^/[^/]+/[^/]+/pull/${number}/?$`).test(path) || task.prHead !== mergeHead) return false;
  } catch { return false; }
  const run = store.run(recovery.runId);
  if (!run || run.taskId !== task.id || run.role !== "recovery" || run.head !== mergeHead
      || run.generation !== recovery.generation) return false;
  const witness = recovery.mergeWitness;
  if (witness) return witness.episodeId === recovery.id && witness.incidentId === recovery.incidentId
    && witness.stopKey === recovery.key && witness.runId === run.id
    && witness.generation === run.generation && witness.prNumber === number
    && witness.head === mergeHead && witness.mergedCommit === null;

  // Legacy records carry only a digest. The ordered journal must identify this
  // very run before the one recorded verification; a timestamp or digest alone
  // cannot establish what the coordinator was asked to recover.
  const events = store.eventsAll(task.id);
  const merges = events.filter(event => event.kind === "merge_verified");
  if (merges.length !== 1 || !task.resolution.mergeIntent || task.resolution.externalMerge
      || task.prHead !== mergeHead) return false;
  const launches = events.filter(event => {
    if (event.kind !== "telemetry_recovery") return false;
    try { return (JSON.parse(event.detail) as { runId?: unknown }).runId === run.id; }
    catch { return false; }
  });
  const action = recovery.action;
  const accepted = events.find(event => event.kind === "merge_response_accepted"
    && event.detail === `GitHub accepted the guarded merge for ${mergeHead}`);
  const binding = action && events.find(event => event.kind === "recovery_action_bound" && event.detail === action.eventId);
  const applied = events.find(event => event.kind === "run_result_applied" && event.detail === run.id);
  const released = events.find(event => event.kind === "run_released_from_recorded_completion"
    && event.detail === `recovery ${run.id}`);
  if (!accepted || !action || action.runId !== run.id || action.eventId !== run.completion?.eventId
      || action.reportStatus !== run.completion?.status || !binding || launches.length !== 1
      || !(accepted.id < launches[0]!.id && launches[0]!.id < binding.id
        && binding.id < merges[0]!.id)) return false;
  const originalStop = !task.resolution.stop
    || digest(`stop:${task.resolution.stop.reason}:${task.resolution.stop.since}`) === recovery.key;
  if (action.status === "pending") return originalStop;
  if (action.status !== "applied" || !run.released || !released || !applied
      || !(merges[0]!.id < released.id && released.id < applied.id)) return false;
  if (originalStop) return true;
  return legacyRecoveryEscalation(store, task, applied.id) !== null && legacyRecoveryOwnsStop(store, task);
}

/** The one typed escalation this legacy recovery report opened, if its chain is complete. */
export function legacyRecoveryEscalation(store: Pick<Store, "eventsAll">, task: Task, after = 0): string | null {
  const events = store.eventsAll(task.id);
  const runId = task.resolution.recovery?.runId;
  const matches = plannerEscalations(events).filter(item => item.runId === runId).filter(item =>
    events.some(event => {
      if (event.kind !== "planner_escalation_payload" || event.id <= after || !event.detail.startsWith(`${item.id}:`)) return false;
      try {
        const payload = JSON.parse(event.detail.slice(event.detail.indexOf(":") + 1)) as { id?: unknown; runId?: unknown; source?: unknown };
        return payload.id === item.id && payload.runId === runId && payload.source === "recovery";
      } catch { return false; }
    }));
  return matches.length === 1 ? matches[0]!.id : null;
}

/** A ladder wait is this occurrence only when its exact stored stop names its escalation. */
export function legacyRecoveryOwnsStop(store: Pick<Store, "eventsAll">, task: Task): boolean {
  const stop = task.resolution.stop;
  const id = legacyRecoveryEscalation(store, task);
  if (!stop || stop.reason !== "escalated" || !id) return false;
  if (![escalationWaitDetail.planner(id), escalationWaitDetail.unknown(id), escalationWaitDetail.attached(id)]
    .some(detail => stop.detail === detail || stop.detail.startsWith(`${detail};`))) return false;
  const events = store.eventsAll(task.id);
  const payload = events.find(event => event.kind === "planner_escalation_payload" && event.detail.startsWith(`${id}:`));
  const wait = events.findLast(event => event.kind === "task_waiting" || event.kind === "task_stopped");
  if (!payload || !wait || wait.id <= payload.id || wait.kind !== "task_waiting") return false;
  try { return JSON.stringify(JSON.parse(wait.detail)) === JSON.stringify(stop); }
  catch { return false; }
}
