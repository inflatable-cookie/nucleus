import type { Run } from "../../../shared/contracts";
import type { Engine } from "../../engine";
import { DurableFenceRefusal } from "../../intake/run-settlement";
import type { ReviewerDisplacement } from "./types";

/**
 * Observe the reviewer runs a review-side move displaces, before any write. A
 * reviewer whose agent is observed stopped yields to the move; a live turn is
 * cancelled after every check that can refuse. Only a durable side effect or an
 * unexplained run refuses here. The review and work moves read this one way.
 */
export async function observeReviewerDisplacement(engine: Engine, taskId: string): Promise<ReviewerDisplacement> {
  const store = engine.store;
  const finished = await engine.collectVerbFinishedRuns(taskId, run => run.role === "reviewer" && !run.completion, { displace: true });
  if (finished.fenced.length) throw new DurableFenceRefusal(engine.displaceRefusal(finished.fenced[0]!));
  const displaced = [...finished.settleable, ...finished.live];
  const settling = new Set(displaced.map(run => run.id));
  const candidates = store.runs(taskId).filter(run => !run.released && !settling.has(run.id));
  const stoppedReviewers = new Set<string>();
  const liveReviewers: Run[] = [];
  for (const run of candidates) if (run.role === "reviewer" && !run.completion) {
    const why = engine.runDurableFence(store.task(taskId), run);
    if (why) throw new DurableFenceRefusal(engine.displaceRefusal({ run, why }));
    if (await engine.observedRunLiveness(run) === false) stoppedReviewers.add(run.id);
    else liveReviewers.push(run);
  }
  const live = candidates.find(run => !stoppedReviewers.has(run.id) && !liveReviewers.includes(run));
  if (live) throw new DurableFenceRefusal(engine.displaceRefusal({ run: live, why: "its state changed during the move" }));
  return { finished, displaced, stoppedReviewers, liveReviewers };
}

/**
 * Cancel the displaced live turns once the move has passed its checks. A
 * reviewer whose turn was cancelled then counts as stopped, so the settlement
 * supersedes it like any other stopped reviewer.
 */
export async function cancelDisplacedReviewers(engine: Engine, taskId: string, displacement: ReviewerDisplacement, verb: string): Promise<void> {
  await engine.cancelDisplacedTurns(taskId, [...displacement.finished.live, ...displacement.liveReviewers], verb);
  for (const run of displacement.liveReviewers) displacement.stoppedReviewers.add(run.id);
}
