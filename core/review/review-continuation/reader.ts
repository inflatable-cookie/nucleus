/**
 * What the task's current reviewer run is, and what a checkpointed review waits
 * on. Everything here is derived from the run, the checkpoint state and the
 * typed stop facts; the view, the wait and the owner verbs read this one answer,
 * so none of them advertises a continuation the gate refuses.
 */
import {
  REVIEW_CONTINUATION_LIMIT,
  type Run,
  type Task,
} from "../../../shared/contracts";
import type { Store } from "../../store/store";
import { reviewDeliveryReason, stoppedDeliveryResume } from "./delivery";

/** Shared stored-state part of the retained-reader rule. The move additionally observes the agent. */
export function retainedReaderStateDecision(
  state: ReturnType<typeof reviewContinuationState>,
): "unsettled" | "exhausted" | "closed" | "awaiting" | "reading" {
  if (state === "reserved" || state === "uncertain") return "unsettled";
  if (state === "exhausted" || state === "closed" || state === "awaiting")
    return state;
  return "reading";
}

/** Whether a retained reviewer remains bound when a move starts a new review. */
export function keepRetainedReviewer(
  freshAsked: boolean,
  retainedClosed: boolean,
  retainedUnavailable: boolean,
): boolean {
  return !freshAsked && !retainedClosed && !retainedUnavailable;
}

/** The per-task reviewer checkpoint allowance, a Queue setting with a fixed default. */
export function reviewContinuationLimit(store: Pick<Store, "getMeta">): number {
  const value = store.getMeta<number>("reviewContinuationLimit");
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : REVIEW_CONTINUATION_LIMIT;
}

export const REVIEW_BUDGET_EXHAUSTED =
  "The reviewer spent its checkpoint budget and stopped; restart role=reviewer or move to=review observes the retained reviewer and asks it to finish or redeliver its report at the same head.";
export const REVIEW_READER_EXHAUSTED =
  "The retained reviewer cannot finish the remaining reading; restart role=reviewer fresh replaces it once it is observed idle at the same exact head.";

export function reviewerCannotFinish(run: Run): boolean {
  return Boolean(
    run.role === "reviewer" &&
      run.reviewBudgetExhaustedAt &&
      run.reviewRejectedReadings?.some(
        (reading) =>
          reading.head === run.head && reading.checkpoint.remaining.length > 0,
      ),
  );
}

export const REVIEW_AUTHORIZATION_REQUIRED =
  "The reviewer saved a checkpoint; Queue continues the same reviewer from it once its turn ends. Checkpoints are preserved, not approval.";
/**
 * The reviewer's own agent was positively observed closed with its checkpoint
 * preserved. A closed Paseo session cannot receive a same-run continuation, so
 * the supported recovery is the existing fresh-review paths; the lease, the
 * checkpoints and the eventual verdict stay with the original run.
 */
export const REVIEW_AGENT_CLOSED =
  "The reviewer's agent was observed closed in its workspace with the checkpoint preserved; the same-agent continuation is impossible. The project planner decides through the blocker ladder (Spec 058), and restart role=reviewer fresh replaces the retained reviewer deliberately at the same head (move to=review preserves the reader it can continue, so it refuses this one).";
/**
 * The reviewer's own agent was observed errored with no active turn and no
 * pending permission. A dead provider session cannot receive a same-run
 * continuation, like a closed one, so it takes the same fresh-review exit
 * with its own reason.
 */
export const REVIEW_AGENT_ERRORED =
  "The reviewer's agent was observed errored in its workspace with no active turn and no pending permission; the same-agent continuation is impossible. The project planner decides through the blocker ladder (Spec 058), and restart role=reviewer fresh replaces the retained reviewer deliberately at the same head (move to=review preserves the reader it can continue, so it refuses this one).";
/** The exits named when a delivered review turn cannot be resumed from the recorded facts. */
export const REVIEW_FRESH_REPLACEMENT_EXIT =
  "restart role=reviewer fresh may replace the reviewer only when it is proven gone or ineligible; otherwise continue the retained reviewer";

/** Old publication continuations and unfinished reviewer checkpoints cannot auto-resume.
 * The wait is derived from a current, unreleased reviewer run (nucleus#1106): a
 * superseded or released named run cannot be continued, so a recorded cause alone
 * never holds the authorization and the task proceeds to its next step. */
export function reviewAuthorizationRequired(
  task: Task,
  store: Pick<Store, "run">,
): boolean {
  const run = task.resolution.currentRunId
    ? store.run(task.resolution.currentRunId)
    : null;
  // A result ends checkpoint reading, including tasks carrying an older
  // publication-continuation cause. Ordinary intake owns release and application.
  if (run?.role === "reviewer" && run.completion) return false;
  if (run && !run.released && reviewerCannotFinish(run)) return true;
  if (
    task.resolution.pendingRevisionCause === "continuation" &&
    !reviewInProgress(run)
  )
    return false;
  return (
    reviewInProgress(run) ||
    Boolean(
      run &&
        run.role === "revision" &&
        run.revisionCause === "continuation" &&
        !run.completion &&
        !run.released,
    )
  );
}

/**
 * Where the current reviewer checkpoint stands: `awaiting` a continuation,
 * `reserved` (Queue is sending one), `continuing` (one was delivered for this
 * checkpoint and the reviewer is working), `uncertain` (a send's outcome is
 * unknown), `exhausted` (the budget is spent) or `closed` (the run's own agent
 * was positively observed closed, so no same-run continuation can land). Null
 * when no reviewer checkpoint is current, for example the older
 * publication-continuation revision fence.
 */
export function reviewContinuationState(
  task: Task,
  store: Pick<Store, "run">,
):
  | "awaiting"
  | "reserved"
  | "continuing"
  | "uncertain"
  | "exhausted"
  | "closed"
  | null {
  const run = task.resolution.currentRunId
    ? store.run(task.resolution.currentRunId)
    : null;
  if (run && !run.released && !run.completion && reviewerCannotFinish(run))
    return "exhausted";
  if (!reviewInProgress(run) || !run) return null;
  // A checkpoint rejected past the budget leaves the reviewer stopped, whatever its last delivery said.
  if (run.reviewBudgetExhaustedAt) return "exhausted";
  // A positively closed agent can never receive the retained-run continuation.
  if (run.retainedAgentClosedAt) return "closed";
  const ordinal = run.reviewCheckpoints?.at(-1)?.ordinal;
  if (ordinal === undefined) return null;
  const status = run.reviewDeliveries?.findLast(
    (item) => item.checkpointOrdinal === ordinal && item.status !== "refused",
  )?.status;
  return status === "delivered"
    ? "continuing"
    : status === "reserved" || status === "uncertain"
      ? status
      : "awaiting";
}

/**
 * The wait a checkpointed review records. A delivered or reserved continuation
 * is the reviewer or Queue at work, and so is an awaiting checkpoint: Queue
 * continues it by itself (Tom, 2026-10-31). An uncertain send needs a person to
 * inspect it.
 */
export function reviewContinuationWait(
  task: Task,
  store: Pick<Store, "run" | "eventsAll">,
): { reason: string; stop: "lifecycle" | "operator_needed" } {
  const run = task.resolution.currentRunId
    ? store.run(task.resolution.currentRunId)
    : null;
  const state = reviewContinuationState(task, store);
  const delivery = run?.reviewDeliveries?.findLast(
    (item) =>
      item.checkpointOrdinal === run.reviewCheckpoints?.at(-1)?.ordinal &&
      item.status !== "refused",
  );
  if (state === "continuing") {
    // Saved inactivity only describes this delivered turn after a matching
    // observation started later than its delivery was proven. Pre-send idle
    // state and an observation concurrent with delivery prove no stop.
    const observed =
      run?.active === false &&
      run.lastObservedAt != null &&
      delivery?.observedAt != null &&
      Date.parse(run.lastObservedAt) > Date.parse(delivery.observedAt);
    if (!observed)
      return {
        reason: `Reviewer continuing from checkpoint ${delivery!.checkpointOrdinal}`,
        stop: "lifecycle",
      };
    // Tom, 2026-10-27: a positively confirmed owner stop of that delivered turn
    // is the one thing that lets the same reader continue it once, through the
    // ordinary retained restart. Say that instead of only naming replacement.
    const stopped =
      run && delivery
        ? stoppedDeliveryResume(store, task, run, delivery)
        : { kind: "none" as const };
    if (stopped.kind === "resume")
      return {
        reason: `The reviewer's delivered continuation for checkpoint ${delivery!.checkpointOrdinal} on run ${run!.id} (agent ${run!.agentId}) was stopped by the owner at ${stopped.at} and has no verdict or new checkpoint; restart role=reviewer resumes that one turn on the same reader, and ${REVIEW_FRESH_REPLACEMENT_EXIT}`,
        stop: "operator_needed",
      };
    if (stopped.kind === "refused")
      return { reason: stopped.reason, stop: "operator_needed" };
    return {
      reason: `The reviewer's delivered continuation for checkpoint ${delivery!.checkpointOrdinal} on run ${run!.id} (agent ${run!.agentId}) stopped without a verdict or a new checkpoint; move to=review observes the retained reviewer and asks for its report`,
      stop: "operator_needed",
    };
  }
  if (state === "reserved")
    return {
      reason: reviewDeliveryReason(delivery!.deliveryId, "reserved"),
      stop: "lifecycle",
    };
  if (state === "uncertain")
    return {
      reason: reviewDeliveryReason(delivery!.deliveryId, "uncertain"),
      stop: "operator_needed",
    };
  if (state === "awaiting")
    return { reason: REVIEW_AUTHORIZATION_REQUIRED, stop: "lifecycle" };
  if (state === "exhausted") {
    const unsettled = run?.reviewDeliveries?.find(
      (item) => item.status === "reserved" || item.status === "uncertain",
    );
    if (unsettled)
      return {
        reason: reviewDeliveryReason(
          unsettled.deliveryId,
          unsettled.status as "reserved" | "uncertain",
        ),
        stop: "operator_needed",
      };
    return {
      reason:
        run && reviewerCannotFinish(run)
          ? REVIEW_READER_EXHAUSTED
          : REVIEW_BUDGET_EXHAUSTED,
      stop: "operator_needed",
    };
  }
  if (state === "closed")
    return {
      reason: `${REVIEW_AGENT_CLOSED} (run ${run!.id}, agent ${run!.agentId}, checkpoint ${run!.reviewCheckpoints?.at(-1)?.ordinal ?? "none"} at ${run!.head})`,
      stop: "operator_needed",
    };
  // No checkpoint continuation stands on the named run (nucleus#1106): a
  // superseded or released named run cannot be continued, so this states the
  // facts instead of claiming a continuation that can never happen.
  return {
    reason: run
      ? `Reviewer run ${run.id} is ${run.released ? `released (${run.status})` : "current"} with no checkpoint continuation to deliver; the task proceeds to its next step`
      : "No current reviewer run holds a checkpoint continuation; the task proceeds to its next step",
    stop: "lifecycle",
  };
}

/** True when a task's current reviewer run holds a durable progress checkpoint. */
export function reviewInProgress(run: Run | null): boolean {
  return Boolean(
    run &&
      run.role === "reviewer" &&
      !run.completion &&
      !run.released &&
      (run.reviewCheckpoints?.length ?? 0) > 0,
  );
}

/**
 * What the task's current reviewer run is at one exact head, resolved once from
 * current facts: `absent` (no unfinished current reviewer, or one that belongs to
 * another source head), `valid` (the recorded reviewer, at this head, with its
 * source and participant binding proved), or `refused` (an existing unfinished
 * reviewer whose binding cannot be proved). `refused` is never read as `absent`:
 * an unprovable binding must not silently send the caller down the fresh-review
 * fallback and abandon the retained reader's coverage (Tom, 2026-10-27; review
 * 5673604194). The same derivation feeds the `move to=review` view and its
 * applying control.
 */
export type ReviewerIdentity =
  | { kind: "absent" }
  | { kind: "valid"; run: Run }
  | { kind: "refused"; run: Run; refusal: string };

export function reviewerIdentityAtHead(
  task: Task,
  store: Pick<Store, "run">,
  head: string,
): ReviewerIdentity {
  const run = task.resolution.currentRunId
    ? store.run(task.resolution.currentRunId)
    : null;
  if (
    !run ||
    run.taskId !== task.id ||
    run.role !== "reviewer" ||
    run.released ||
    run.completion
  )
    return { kind: "absent" };
  // A reader that is not at this head belongs to another source state: moving to
  // review at this head is the deliberate fresh review of a changed source.
  if (!task.prHead || task.prHead !== head || run.head !== head)
    return { kind: "absent" };
  if (
    !run.agentId ||
    (task.resolution.reviewerAgentId &&
      task.resolution.reviewerAgentId !== run.agentId)
  )
    return {
      kind: "refused",
      run,
      refusal: `the task records reviewer agent ${task.resolution.reviewerAgentId ?? "none"}, not the current reviewer run ${run.id} (agent ${run.agentId ?? "unknown"}), so the participant identity cannot be proven and Nucleus cannot tell which reviewer is reading; it does not replace that reader — restart role=reviewer fresh or route role=reviewer with now replaces it deliberately`,
    };
  if (task.workspaceId !== run.workspaceId)
    return {
      kind: "refused",
      run,
      refusal: `the retained reviewer ${run.id} is bound to workspace ${run.workspaceId}, which its recorded source no longer names; Nucleus does not replace a retained reader it cannot prove — restart role=reviewer fresh or route role=reviewer with now replaces it deliberately`,
    };
  return { kind: "valid", run };
}

/** The proven current reviewer at this head, or null. */
export function currentReviewerAtHead(
  task: Task,
  store: Pick<Store, "run">,
  head: string,
): Run | null {
  const identity = reviewerIdentityAtHead(task, store, head);
  return identity.kind === "valid" ? identity.run : null;
}

/** The same reader once it holds durable, continuable review coverage. */
export function retainedReviewerAtHead(
  task: Task,
  store: Pick<Store, "run">,
  head: string,
): Run | null {
  const run = currentReviewerAtHead(task, store, head);
  return run && reviewInProgress(run) ? run : null;
}

/** Whether the review fence keeps coordinators away. An awaiting checkpoint is Queue's to continue, not a coordinator's. */
export function reviewFenceHoldsCoordinators(
  task: Task,
  store: Pick<Store, "run">,
): boolean {
  return (
    task.resolution.stop?.reason === "awaiting_proof" ||
    reviewAuthorizationRequired(task, store)
  );
}

/** Stored reader fences use the same message before and after host observation. */
export function retainedReaderStoredRefusal(
  state: ReturnType<typeof reviewContinuationState>,
  waitReason: string,
): string | null {
  const stored = retainedReaderStateDecision(state);
  if (stored === "unsettled")
    return `Move to review cannot act while a reviewer delivery is unsettled: ${waitReason}. Inspect the retained reviewer thread; no review turn was sent`;
  if (stored === "exhausted")
    return retainedReaderUnavailableRefusal(REVIEW_BUDGET_EXHAUSTED);
  if (stored === "closed")
    return retainedReaderUnavailableRefusal(REVIEW_AGENT_CLOSED);
  return null;
}
export function retainedReaderUnavailableRefusal(
  reason = REVIEW_AGENT_CLOSED,
): string {
  return `Move to review preserves a reader it can continue, and this one cannot: ${reason} ${REVIEW_FRESH_REPLACEMENT_EXIT}`;
}
