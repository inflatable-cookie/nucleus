import type { Run } from "../../../shared/contracts";
import type { Engine } from "../../engine";

/** The verified PR a review move binds: its URL and the head GitHub reports. */
export type VerifiedPr = Awaited<ReturnType<Engine["adapter"]["verifyPr"]>>;

/** The finished-run read the move's reviewer displacement made, before any write. */
export type FinishedRuns = Awaited<ReturnType<Engine["collectVerbFinishedRuns"]>>;

/**
 * The reviewer runs one move displaces, observed once before anything is
 * written. A stopped reviewer is observed idle with no turn; a live one has a
 * turn the move cancels. Both are superseded by the move, never replaced here.
 */
export type ReviewerDisplacement = {
  finished: FinishedRuns;
  /** Settleable and live runs of the roles the move supersedes. */
  displaced: Run[];
  /** Reviewer run ids observed stopped, including live turns once cancelled. */
  stoppedReviewers: Set<string>;
  /** Reviewer runs with a live turn, which the move cancels. */
  liveReviewers: Run[];
};

/** The owner `move to=review` request, after the verb has parsed it. */
export type ReviewMoveInput = {
  taskId: string;
  version: number;
  reason: string;
  reviewer?: { profileId: string; reason: string };
  caller?: string;
  prNumber?: number;
  fresh?: boolean;
};
