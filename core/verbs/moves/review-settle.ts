import { randomUUID } from "node:crypto";
import type { Task } from "../../../shared/contracts";
import type { Engine } from "../../engine";
import type { AgentObservation } from "../../host/adapter";
import { settleSupersededFencesInTx } from "../../recovery/fence-settlement";
import { keepRetainedReviewer } from "../../review/review-continuation";
import { now } from "../../store/store";
import { unreleasedLaunchFence } from "../owner-verbs";

/**
 * The review-side settlement both owner moves to review share: stopped reviewers
 * are superseded, the accepted review and its answered fences are superseded with
 * their history kept, and the retained reviewer is kept or released. The task
 * and proof-only moves differ only in what they bind, so each supplies that and
 * this module writes the one settlement.
 */

/**
 * Supersede the stopped reviewer runs the move observed. A reviewer whose turn an
 * owner verb cancelled is stopped, not replaced: it keeps no credential and no
 * replacement claim. Any other stopped reviewer is released only once it ended.
 */
export function settleStoppedReviewers(engine: Engine, taskId: string, stopped: ReadonlySet<string>, reason: string): void {
  const store = engine.store;
  for (const run of store.runs(taskId).filter(item => item.role === "reviewer" && !item.completion && !item.released && stopped.has(item.id))) {
    if (engine.ownerCancelledRun(taskId, run.id)) {
      store.deleteCredential(run.id);
      store.putRun({ ...run, status: "superseded", released: true, active: false });
      store.event(taskId, "move_review_reviewer_settled", `${run.id} (turn cancelled): ${reason}`.slice(0, 2000));
    } else {
      // `replacedAt` records why the run was released; its credential is revoked
      // with the release like every run's (task 1005).
      const ended = run.retainedAgentClosedAt !== undefined;
      store.putRun({ ...run, status: "superseded", released: ended, active: false, ...(ended ? {} : { replacedAt: now() }) });
      store.event(taskId, "move_review_reviewer_settled", `${run.id}: ${reason}`.slice(0, 2000));
    }
  }
}

/** What a review move commits, besides the shared settlement. */
export type ReviewMoveCommit = {
  reason: string;
  /** The head the move binds; the supersession note and the event name it. */
  movedTo: string;
  /** The head a superseded review carries when it recorded none. */
  fallbackHead: (settled: Task) => string;
  reviewer?: { profileId: string; reason: string };
  freshAsked: boolean;
  observedRetained: AgentObservation | null;
  retainedClosedAtObserve: boolean;
  /** Whether an attributed caller asked, which picks the event kind. */
  callerAsked: boolean;
  /** What the move is for the reader, e.g. "task" or "proof-only receipt". */
  subject: string;
  /** Task fields the move binds: the PR head, URL and resume number. */
  binding: Partial<Pick<Task, "prHead" | "prUrl" | "resumePrNumber">>;
  /** Event detail a binding adds, such as the ready result that bound the PR. */
  eventDetail: Record<string, unknown>;
};

/**
 * Commit an owner move to review inside the caller's transaction: supersede the
 * accepted review and the answered fences, keep or release the retained reviewer,
 * and write the move's one event. Nothing here refuses; the caller has already
 * proved every gate, and a refused move never reaches this.
 */
export function commitReviewMove(engine: Engine, taskId: string, current: Task, move: ReviewMoveCommit): Task {
  const store = engine.store;
  const settledTask = store.task(taskId);
  const review = settledTask.resolution.review;
  const supersession = review ? {
    id: randomUUID(), at: now(), reason: move.reason, reviewRunId: review.runId, reviewId: review.reviewId ?? null,
    reviewCommentId: review.reviewCommentId ?? null, head: review.head ?? move.fallbackHead(settledTask), review, verification: null,
    mechanicalVerification: settledTask.resolution.mechanicalVerification,
  } : null;
  const note = `Superseded by owner move to review at ${move.movedTo}: ${move.reason}`;
  const recovery = settledTask.resolution.recovery && settledTask.resolution.recovery.status !== "resolved"
    ? { ...settledTask.resolution.recovery, status: "resolved" as const, summary: `${note}; original: ${settledTask.resolution.recovery.summary}` }
    : settledTask.resolution.recovery;
  const incident = settledTask.resolution.incident && settledTask.resolution.incident.status !== "resolved"
    ? { ...settledTask.resolution.incident, status: "resolved" as const, detail: `${note}; original: ${settledTask.resolution.incident.detail}`, updatedAt: now() }
    : settledTask.resolution.incident;
  const requests = move.reviewer
    ? { ...settledTask.profileRequests, reviewer: { profileId: move.reviewer.profileId, reason: move.reviewer.reason.trim(), required: true } }
    : settledTask.profileRequests;
  // Spec 057 (task 553): keep the retained reviewer on a responsible task unless
  // fresh was asked for or it is closed or unavailable. A kept binding is still
  // validated at selection, so keeping never forces a reader that cannot continue.
  const retainedAgent = settledTask.resolution.reviewerAgentId;
  const retainedProfile = settledTask.resolution.reviewerProfile;
  const lastRetainedRun = retainedAgent
    ? store.runs(settledTask.id).filter(run => run.role === "reviewer" && run.agentId === retainedAgent).at(-1) ?? null
    : null;
  const retainedClosed = Boolean(lastRetainedRun?.retainedAgentClosedAt || lastRetainedRun?.reviewBudgetExhaustedAt
    || (retainedAgent && move.observedRetained?.id === retainedAgent && move.retainedClosedAtObserve));
  const retainedUnavailable = !retainedAgent || !retainedProfile
    || Boolean(engine.resolution.retainedProfileIssue(retainedProfile))
    || Boolean(engine.resolution.signoffIssue(settledTask, retainedProfile, "reviewer"))
    || engine.resolution.authorAgentIds(settledTask).has(retainedAgent);
  const keepReviewer = keepRetainedReviewer(move.freshAsked, retainedClosed, retainedUnavailable);
  store.update(settledTask.id, {
    ...move.binding, profileRequests: requests, phase: "awaiting_review",
    reason: keepReviewer
      ? `Owner moved the ${move.subject} to review at ${move.movedTo} with the retained reviewer ${retainedAgent}`
      : `Owner moved the ${move.subject} to a fresh review at ${move.movedTo}`,
    resolution: {
      ...settledTask.resolution, currentRunId: null, stop: null,
      ...(keepReviewer ? {} : { reviewerAgentId: null, reviewerProfile: null }),
      review: null, mechanicalVerification: null, integrationTurn: null, pendingReviewReason: move.reason,
      pendingRevisionCause: null, pendingWorkerInstruction: null, attention: false, recoveryActive: false, recovery, incident,
      reviewSupersessions: supersession ? [...settledTask.resolution.reviewSupersessions, supersession] : settledTask.resolution.reviewSupersessions,
    },
  }, move.callerAsked ? "move_review_requested" : "owner_control", JSON.stringify({
    verb: "move", to: "review", head: move.movedTo, phaseBefore: settledTask.phase, reason: move.reason,
    ...(keepReviewer ? { retainedReviewer: retainedAgent } : { fresh: true }),
    incidentId: current.resolution.incident?.id ?? null, recoveryId: current.resolution.recovery?.id ?? null,
    ...move.eventDetail,
  }));
  // The move itself supersedes the accepted review, an answered incident and
  // recovery with their original detail; the registry helper settles what the
  // move does not carry. History kept, settled inside the transaction.
  settleSupersededFencesInTx(store, taskId, `move review: ${move.reason}`, now(), engine.coordinatorActionRunId.getStore());
  return store.task(taskId);
}

/**
 * Say in the reply that the move left the task waiting on a run it could not
 * release, or on a busy participant the dispatch lease polls, and what
 * releases each. `next` reads the same recorded stop, so the owner never sees
 * plain success with no reader launched (nucleus#1100).
 */
export async function nameLaunchFence(engine: Engine, taskId: string, reason: string, why: string): Promise<void> {
  const store = engine.store;
  const current = store.task(taskId);
  const fence = unreleasedLaunchFence(store, current, "reviewer");
  if (fence) {
    engine.resolution.waiting(current, `${reason}, but the launch waits on ${fence}: ${why}`, "lifecycle");
    return;
  }
  // A finished run's recorded completion keeps this read quiet: finished work
  // is not a live participant (nucleus#1100).
  const decline = await engine.resolution.leaseDeclineReason(store.task(taskId));
  if (decline) engine.resolution.waiting(store.task(taskId), `${reason}, but the launch waits on ${decline}: ${why}`, "lifecycle");
}
