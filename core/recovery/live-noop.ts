import { runHoldsSlot, type Run, type Task } from "../../shared/contracts";
import type { RecoveryContext } from "./coordinator-episode";
import { now } from "../store/store";

/**
 * The durable summary of a settled live no-op. Intake also accepts recovered
 * without an action; blocked reports use the same observed settlement path.
 */
export const LIVE_RECOVERY_NOOP_PREFIX = 'live:';

export function isLiveRecoveryNoop(summary: string | null | undefined): boolean {
  return Boolean(summary && /^live:\s/i.test(summary.trim()));
}

export type LiveParticipant = Pick<Run, "createdAt" | "lastObservedAt"> & {
  role: Run["role"] | "worker";
};

/** The initial worker or unreleased non-recovery participant holding the lane. */
export function liveWorkingParticipant(
  task: Task,
  runs: Run[],
): LiveParticipant | null {
  const currentId = task.resolution.currentRunId;
  const ordered = [
    ...(currentId ? runs.filter(run => run.id === currentId) : []),
    ...runs,
  ];
  const run = ordered.find(
    (run) => run.role !== "recovery" && !run.released && runHoldsSlot(run),
  );
  if (run) return run;
  // The initial worker lives on Task rather than in the resolution run table.
  return task.agentId && !task.completion && task.agentActive === true
    ? {
        role: "worker",
        createdAt: task.createdAt,
        lastObservedAt: task.lastObservedAt,
      }
    : null;
}

export function liveNoopSummary(run: LiveParticipant): string {
  const who = run.role === 'revision' ? 'worker' : run.role;
  return `${LIVE_RECOVERY_NOOP_PREFIX} ${who} is working, last activity ${run.lastObservedAt ?? run.createdAt}`;
}

/**
 * A live no-op resolved the episode so a still-active participant is not
 * recovered again. A stall on that participant is new work: open another episode.
 */
export function reopenLiveNoopAfterStall(task: Task): boolean {
  const recovery = task.resolution.recovery;
  if (!recovery || recovery.status !== 'resolved' || !isLiveRecoveryNoop(recovery.summary)) return false;
  const stall = task.resolution.stalledTurnStop;
  return Boolean(stall && stall.status !== 'stopped' && stall.status !== 'completed');
}

/** Ordinary admission waits are healthy work even when no participant owns a slot. */
export function liveRecoveryWait(
  task: Task,
  waits: { prerequisite: string; slot: string },
): { reason: string; stop: "prerequisite" | "capacity" } | null {
  if (waits.prerequisite)
    return { reason: waits.prerequisite, stop: "prerequisite" };
  if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt)
    return { reason: task.prerequisiteWait.reason, stop: "prerequisite" };
  if (
    ["awaiting_review", "changes_requested", "queued"].includes(task.phase) &&
    waits.slot
  )
    return { reason: waits.slot, stop: "capacity" };
  return null;
}

/** Refresh the participants before settling a report that says recovery cannot act. */
export async function observeRecoveryParticipants(
  resolution: RecoveryContext,
  task: Task,
): Promise<void> {
  const candidates = resolution.store
    .runs(task.id)
    .filter(
      (run) =>
        run.role !== "recovery" &&
        !run.released &&
        !run.completion &&
        run.agentId,
    );
  const observe = async (
    agentId: string,
    workspaceId: string | null,
    previous: string | null,
    owner: Task | Run = task,
  ) => {
    const state = await resolution.onTaskHost(owner, () =>
      resolution.host.observe(agentId),
    );
    if (state.id !== agentId || state.workspaceId !== workspaceId)
      throw Error("Recovery participant identity changed");
    return (
      !["closed", "error"].includes(state.status) &&
      (state.active ||
        Boolean(state.activeTurnId) ||
        Boolean(
          previous &&
            state.updatedAt &&
            Date.parse(state.updatedAt) > Date.parse(previous),
        ))
    );
  };
  for (const run of candidates) {
    const active = await observe(
      run.agentId!,
      run.workspaceId,
      run.lastObservedAt,
      run,
    );
    const latest = resolution.store.run(run.id);
    if (latest && JSON.stringify(latest) === JSON.stringify(run))
      resolution.store.putRun({ ...latest, active, lastObservedAt: now() });
  }
  const current = resolution.store.task(task.id);
  if (
    current.agentId &&
    !current.completion &&
    !candidates.some((run) => run.agentId === current.agentId)
  ) {
    const active = await observe(
      current.agentId,
      current.workspaceId,
      current.lastObservedAt,
    );
    const latest = resolution.store.task(task.id);
    if (latest.version === current.version)
      resolution.store.update(task.id, {
        agentActive: active,
        lastObservedAt: now(),
      });
  }
}
