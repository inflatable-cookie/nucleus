import type { Task } from "../../shared/contracts";
import type { Resolution } from "../resolution";

export type MergePhaseContext = Pick<Resolution, "store" | "update">;

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
