import { isQuantumDeadlineExceeded } from "../scheduling/pass-snapshot";
import type { Task } from "../../shared/contracts";
import type { Resolution } from "../resolution";
import { now, type Store } from "../store/store";

export type MergePhaseContext = Pick<Resolution, "store" | "update">;

/** Strictly increasing timestamp token used to bind each guarded merge PUT. */
export function nextMergeRequestAt(
  previous: string | null | undefined,
): string {
  let requestedAt = now();
  if (previous && requestedAt <= previous) {
    const prevMs = Date.parse(previous);
    requestedAt = Number.isFinite(prevMs)
      ? new Date(prevMs + 1).toISOString()
      : `${requestedAt}-next`;
  }
  return requestedAt;
}

export type GuardedMergeSendParams = {
  store: Store;
  taskId: string;
  head: string;
  send: (task: Task, allowed: () => boolean) => Promise<void>;
  /**
   * Atomically compare-and-set the durable merge request id before sending.
   * Return `{ task, matchesCurrent }` when reserved, or `null` to stop without
   * sending (e.g. a superseded retry or an already-active merge intent).
   */
  reserve: () => {
    task: Task;
    matchesCurrent: (candidate: Task) => boolean;
  } | null;
  /** Additional pre-send permission guard (e.g. pause / settings revision). */
  extraAllowed?: (latest: Task) => boolean;
  /** Called if `matchesCurrent` still holds on success. */
  onAccepted: (latest: Task) => void;
  /** Called if `matchesCurrent` no longer holds when a late success arrives. */
  onLateAccepted?: (latest: Task) => void;
  /** Called if `send` throws; receives whether `matchesCurrent` still holds. */
  onError: (latest: Task, error: unknown, isCurrent: boolean) => void;
};

/**
 * The single guarded merge sender shared by ordinary verification, automatic
 * uncertain-merge re-issue, and explicit `merge.now`. Compare-and-sets the
 * durable request identity in the same transaction that reserves the send, and
 * binds both the pre-send permission check and response settlement to that
 * exact request occurrence.
 */
export async function sendGuardedMerge(
  params: GuardedMergeSendParams,
): Promise<"superseded" | "accepted" | "error"> {
  const reserve = () => {
    const before = params.store.task(params.taskId);
    const reservation = params.reserve();
    return reservation && { ...reservation, before };
  };
  const reservation = params.store.db.isTransaction
    ? reserve()
    : params.store.transaction(reserve);
  if (!reservation) return "superseded";
  const { task, matchesCurrent, before } = reservation;
  try {
    await params.send(task, () => {
      const latest = params.store.task(params.taskId);
      if (!matchesCurrent(latest)) return false;
      return params.extraAllowed ? params.extraAllowed(latest) : true;
    });
  } catch (error) {
    const latest = params.store.task(params.taskId);
    if (isQuantumDeadlineExceeded(error)) {
      // Restore only a reservation made by this call, while it still holds
      // the exact task version. Older or potentially sent intents stay bound.
      if (error.preSend && before.version !== task.version &&
          latest.version === task.version && matchesCurrent(latest))
        params.store.update(task.id, {
          resolution: before.resolution,
          reason: before.reason,
          reasonFact: before.reasonFact,
        });
      throw error;
    }
    params.onError(latest, error, matchesCurrent(latest));
    return "error";
  }
  const latest = params.store.task(params.taskId);
  if (matchesCurrent(latest)) {
    params.onAccepted(latest);
  } else {
    params.onLateAccepted?.(latest);
  }
  return "accepted";
}

/** Restore the merging phase when a durable merge intent outlives its phase. */
export class MergePhase {
  constructor(readonly context: MergePhaseContext) {}
  private update(...args: Parameters<MergePhaseContext["update"]>) {
    return this.context.update(...args);
  }

  /** Advance step: a recorded, unmerged merge intent restores the merging phase. */
  restoreRecordedMergePhase(t: Task): Task {
    // A recorded, unmerged merge intent means the task is merging. A pre-merge
    // phase over it is stale (a legacy reconcile reset it on project-a#3618):
    // restore merging so the intent is observed against the PR, never reissued.
    // An accepted explicit merge from a parked phase also restores merging so
    // the scheduler reconciles the merge without a second owner action.
    const preMerge = ["awaiting_review", "reviewing", "verifying"].includes(
      t.phase,
    );
    const parkedAccepted =
      t.resolution.mergeResponseOutcome === "accepted" &&
      ["needs_attention", "blocked", "changes_requested", "working"].includes(
        t.phase,
      );
    if (
      t.resolution.mergeIntent &&
      !t.resolution.mergedCommit &&
      (preMerge || parkedAccepted)
    ) {
      t = this.update(
        t,
        parkedAccepted ? { attention: false } : {},
        {
          phase: "merging",
          reason: "Recorded merge intent: reconciling the merge against the PR",
        },
        "merge_intent_phase_restored",
        t.phase,
      );
    }
    return t;
  }
}
