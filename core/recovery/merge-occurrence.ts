import type { Task } from "../../shared/contracts";
import type { Store } from "../store/store";

/** Identify an overtaken run. Clearing a stop needs its own occurrence proof. */
export function recoveryOvertakenByMerge(
  store: Pick<Store, "eventsAll" | "run">,
  task: Task,
): boolean {
  const { recovery, mergeHead, mergedCommit } = task.resolution;
  const number = task.reviewEntry?.prNumber ?? task.resumePrNumber ?? task.completion?.prNumber;
  if (!recovery || recovery.status === "resolved" || !recovery.runId || !number || !mergeHead || !mergedCommit)
    return false;
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
  return launches.length === 1 && launches[0]!.id < merges[0]!.id;
}
