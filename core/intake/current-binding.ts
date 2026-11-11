/**
 * Stale state never fences current work (papercuts 89643af2, 6ff5e903,
 * 4cfb2d35, 4b285a6e, 1792f99d). The shared predicates in `contracts` express
 * the one rule — a record bound to a released run is superseded history — for
 * incidents, notices, deliveries and effects. This module holds the same rule's
 * one review-phase read: a task whose recorded review phase still names a
 * released reviewer.
 */
import type { Task, Run } from "../../shared/contracts";

/**
 * The phase an accepted `changes_required` verdict already decided, when the
 * task is still sitting in a review phase on the finished reviewer that
 * delivered it (papercut 4cfb2d35). A finished reviewer is never the active
 * participant, so the review phase must not survive it: the author's revision is
 * the outstanding work, and the recorded verdict supplies the instruction.
 *
 * This is a phase reconciliation, not a re-application: it publishes, verifies
 * and credits nothing, and it never runs while a live reader, a deliberate fresh
 * review, or a later author result owns the decision. A `ready_to_merge` verdict
 * is left to the ordinary verification and merge gates.
 */
export function staleChangesRequestedPhase(task: Task, runs: Run[]): { reason: string } | null {
  if (!["awaiting_review", "reviewing"].includes(task.phase)) return null;
  const review = task.resolution.review;
  if (!review || review.status !== "changes_required") return null;
  if (!task.prHead || review.head !== task.prHead) return null;
  // A deliberate fresh review awaiting its reader, or any live participant,
  // owns the phase: its own path applies the result.
  if (task.resolution.pendingReviewReason) return null;
  if (task.resolution.currentRunId && !runs.find(run => run.id === task.resolution.currentRunId)?.released) return null;
  if (runs.some(run => run.role === "reviewer" && !run.released)) return null;
  const source = runs.find(run => run.id === review.runId);
  if (!source || !source.released) return null;
  // A later author result at the same head already answered these findings.
  const authorRun = task.completion?.runId ? runs.findIndex(run => run.id === task.completion!.runId) : -1;
  const sourceIndex = runs.findIndex(run => run.id === source.id);
  if (authorRun >= 0 && authorRun > sourceIndex && task.completion!.status === "ready_for_review") return null;
  return { reason: review.summary || "The accepted review returned the task to its author" };
}
