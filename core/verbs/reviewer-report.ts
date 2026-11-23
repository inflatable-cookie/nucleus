import type { Run, Task } from "../../shared/contracts";
import type { Engine } from "../engine";
import type { Store } from "../store/store";
import {
  DurableFenceRefusal,
  matchingInactiveParticipant,
  runFenceRefusal,
  runSettlementFence,
} from "../intake/run-settlement";
import {
  REVIEW_READER_EXHAUSTED,
  latestDeliveredReviewTurn,
  reviewerCannotFinish,
} from "../review/review-continuation";
import {
  hostFailureRefusalDetail,
  ProvenPreSendRefusalError,
} from "../host/errors";
import { runsUnchangedSince } from "../recovery/observation-advance";
import { taskPrNumber } from "../forge";
import { ordinaryReviewSource } from "../review/ordinary-review";
import { reattachStoredTaskCheckout } from "../git/checkout-reattach";

/**
 * Observe the canonical PR on the attached task branch at the run's exact head.
 * A checkout an earlier round left detached is returned by the one reattach step
 * first, for this run's own round.
 */
export async function verifyReviewerPr(
  engine: Engine,
  task: Task,
  run: Run,
  number: number,
  requireRunHead = true,
) {
  if (!run.ordinaryDetached) return engine.adapter.verifyPr(task, number);
  if (!engine.adapter.verifyPrIdentity)
    throw Error("Ordinary review canonical PR observation unavailable");
  // This run settles the checkout it reads: a checkout an earlier round already
  // left detached returns to its task branch first, moving no commit (Spec 068 §4).
  await reattachStoredTaskCheckout(engine.store, run.taskId, run.id);
  await ordinaryReviewSource(task, run.head);
  const pr = await engine.adapter.verifyPrIdentity(task, number);
  await ordinaryReviewSource(task, run.head);
  if (pr.url !== task.prUrl || (requireRunHead && pr.head !== run.head))
    throw Error("Open PR, task and reviewer heads do not match");
  return pr;
}

export type ExhaustedReviewerReplacement = { run: Run; recheck: () => void };

/** Exhaustion is evidence about one current reader and exact source. */
export function exhaustedReviewer(task: Task, runs: Run[]): Run | null {
  const run = unreportedReviewer(task, runs);
  return run &&
    task.prUrl &&
    task.prHead &&
    task.hostId &&
    run.taskId === task.id &&
    (!run.hostId || run.hostId === task.hostId) &&
    run.workspaceId === task.workspaceId &&
    reviewerCannotFinish(run)
    ? run
    : null;
}

export function exhaustedReviewerRefusal(
  store: Store,
  task: Task,
  run: Run,
): string | null {
  const fence = runSettlementFence({ store, task }, run);
  return fence
    ? runFenceRefusal(run, fence)
    : unresolvedReviewerDelivery(run, store.eventsAll(task.id));
}

/** A fresh reader may replace a proven gone, non-independent or exhausted binding. */
export async function requireReviewerReplacement(
  engine: Engine,
  task: Task,
  version: number,
  allowExhausted = false,
): Promise<ExhaustedReviewerReplacement | null> {
  const runs = engine.store.runs(task.id);
  const exhausted = allowExhausted ? exhaustedReviewer(task, runs) : null;
  const recheck = () => {
    engine.requireOwnerControlCurrent(
      engine.store.task(task.id),
      version,
      "Task changed during reviewer observation; refresh before retrying",
    );
    if (!runsUnchangedSince(runs, engine.store.runs(task.id)))
      throw Error("Task or run changed; refresh before retrying");
    if (exhausted) {
      const refusal = exhaustedReviewerRefusal(engine.store, task, exhausted);
      if (refusal) throw new DurableFenceRefusal(refusal);
    }
  };
  if (exhausted) {
    recheck();
    const pr = await verifyReviewerPr(
      engine,
      task,
      exhausted,
      taskPrNumber(task),
    );
    if (pr.url !== task.prUrl || pr.head !== exhausted.head)
      throw Error("The PR identity or head changed; no reviewer was replaced");
    const state = await engine.onTaskHost(task, () =>
      engine.host.observe(exhausted.agentId!),
    );
    recheck();
    if (!matchingInactiveParticipant(exhausted, state))
      throw Error(
        "The exhausted reviewer is not positively idle in its workspace; no reviewer was replaced",
      );
    return { run: exhausted, recheck };
  }
  const current = runs.find(
    (run) =>
      run.id === task.resolution.currentRunId &&
      run.role === "reviewer" &&
      !run.released,
  );
  const agentId = task.resolution.reviewerAgentId ?? current?.agentId;
  if (!agentId || engine.resolution.authorAgentIds(task).has(agentId))
    return null;
  const prior = runs.findLast(
    (run) => run.role === "reviewer" && run.agentId === agentId,
  );
  if (prior) {
    try {
      engine.resolution.assertReviewProfileIndependent(task, prior);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "Original reviewer model is not independent of actual task authors"
      )
        return null;
    }
  }
  return null;
}

/** A current, bound reviewer whose report has not reached Nucleus. */
export function unreportedReviewer(task: Task, runs: Run[]): Run | null {
  const run = runs.find((item) => item.id === task.resolution.currentRunId);
  return run &&
    run.role === "reviewer" &&
    !run.released &&
    !run.completion &&
    run.agentId &&
    (!task.resolution.reviewerAgentId ||
      run.agentId === task.resolution.reviewerAgentId) &&
    run.workspaceId &&
    run.head === task.prHead &&
    ["running", "finished"].includes(run.status)
    ? run
    : null;
}

/** A recorded result can lead to a report request only on a bound, reportable run. */
export function reviewerReportBindingRefusal(
  task: Task,
  runs: Run[],
  run: Run,
): string | null {
  return unreportedReviewer(task, runs)?.id === run.id
    ? null
    : `The retained reviewer report cannot be requested on run ${run.id} with its current status or binding`;
}

/** The same report-recovery decision is shown by next and applied by restart. */
export function reviewerReportPlan(
  task: Task,
  runs: Run[],
  events: readonly { kind: string; detail: string }[],
): { refusal: string } | { run: Run } | null {
  const run = unreportedReviewer(task, runs);
  if (
    !run ||
    run.retainedAgentClosedAt ||
    (run.reviewCheckpoints?.length && !run.reviewBudgetExhaustedAt)
  )
    return null;
  const refusal = reviewerReportRequestRefusal(run, events);
  return refusal ? { refusal } : { run };
}

type ReviewerReportEvents = readonly { kind: string; detail: string }[];

/** The stable identity of the report request a run can receive exactly once. */
export const reviewerReportMessageId = (runId: string) =>
  `ns-reviewer-report-${runId}`;

/**
 * The positively delivered review occurrence a resend request names. A report
 * resends one occurrence's result, so the dispatch or continuation turn it asks
 * about must be proved to have arrived at this exact run and head. A run whose
 * own dispatch was never delivered can produce no report whatever is asked, and
 * a creation its exact lookup bound without observing the dispatch is not proof
 * that the reviewer ever read it: that fact is inspected, never assumed.
 */
export type ReviewerReportOccurrence =
  | { kind: "delivered"; detail: string }
  | { kind: "unproven"; detail: string }
  | { kind: "missing"; refusal: string };

export function reviewerReportOccurrence(
  run: Run,
  events: ReviewerReportEvents,
): ReviewerReportOccurrence {
  const undelivered = events.findLast(
    (event) =>
      event.kind === "run_delivery_not_delivered" &&
      event.detail.startsWith(`${run.id}:`),
  );
  if (undelivered)
    return {
      kind: "missing",
      refusal: `The review dispatch for run ${run.id} at head ${run.head} was never delivered (${undelivered.detail}), so no report can come from it and none is requested; use run.start reviewer fresh replacing=${run.id}`,
    };
  const turn = latestDeliveredReviewTurn(run);
  if (turn)
    return {
      kind: "delivered",
      detail: `the delivered continuation ${turn.deliveryId} for checkpoint ${turn.checkpointOrdinal} on run ${run.id} at head ${run.head}`,
    };
  const reconciled = events.findLast(
    (event) =>
      event.kind === "run_delivery_reconciled" &&
      event.detail.startsWith(`${run.id}:`),
  );
  if (reconciled)
    return {
      kind: "delivered",
      detail: `the observed dispatch of run ${run.id} at head ${run.head} (${reconciled.detail})`,
    };
  if (
    events.some(
      (event) =>
        event.kind === "run_creation_bound" &&
        event.detail.startsWith(`${run.id}:`),
    )
  )
    return {
      kind: "unproven",
      detail: `the creation of run ${run.id} was bound by an exact lookup, so its dispatch message ${`ns-run-${run.id}`} may never have reached the reviewer`,
    };
  return {
    kind: "delivered",
    detail: `the accepted dispatch of run ${run.id} (agent ${run.agentId}) at head ${run.head}`,
  };
}

function lastReviewerReportRequest(run: Run, events: ReviewerReportEvents) {
  return events.findLast(
    (event) =>
      [
        "reviewer_report_request_sent",
        "reviewer_report_request_intent",
        "reviewer_report_request_refused",
      ].includes(event.kind) && event.detail.startsWith(`${run.id}:`),
  );
}

function unresolvedReviewerDelivery(
  run: Run,
  events: ReviewerReportEvents,
): string | null {
  if (
    run.reviewDeliveries?.some(
      (delivery) =>
        delivery.status === "reserved" || delivery.status === "uncertain",
    ) ||
    (run.reviewContinuation && run.reviewContinuation.status !== "delivered")
  )
    return "The retained reviewer has an unresolved checkpoint delivery; wait for observation before requesting its report";
  return lastReviewerReportRequest(run, events)?.kind ===
    "reviewer_report_request_intent"
    ? "The retained reviewer report request has unknown delivery; inspect it before retrying"
    : null;
}

export function reviewerReportRequestRefusal(
  run: Run,
  events: ReviewerReportEvents,
): string | null {
  if (reviewerCannotFinish(run)) return REVIEW_READER_EXHAUSTED;
  const occurrence = reviewerReportOccurrence(run, events);
  if (occurrence.kind === "missing") return occurrence.refusal;
  if (occurrence.kind === "unproven")
    return `The retained reviewer report cannot be requested yet: ${occurrence.detail}. Nucleus inspects that exact retained dispatch before asking for anything, and no report was requested`;
  return (
    unresolvedReviewerDelivery(run, events) ??
    (lastReviewerReportRequest(run, events)?.kind ===
    "reviewer_report_request_sent"
      ? `The retained reviewer was already asked to resend its report for ${occurrence.detail}; wait for that report`
      : null)
  );
}

/** Ask the retained reviewer to resend its result on the original credential, once. */
export async function requestReviewerReport(
  engine: Engine,
  task: Task,
  run: Run,
  version: number,
  reason: string,
  instruction?: string,
): Promise<Task> {
  const store = engine.store;
  if (!engine.adapter.notify)
    throw Error("This host cannot request the retained reviewer report");
  const pr = await verifyReviewerPr(engine, task, run, taskPrNumber(task));
  if (pr.head !== run.head)
    throw Error(
      "The PR head changed; the retained reviewer cannot report for the current head",
    );
  let state;
  try {
    state = await engine.onTaskHost(task, () =>
      engine.host.observe(run.agentId!),
    );
  } catch (error) {
    throw Error(
      `The retained reviewer cannot be observed (${hostFailureRefusalDetail(error)}); no report was requested`,
    );
  }
  engine.requireOwnerControlCurrent(
    store.task(task.id),
    version,
    "Task changed during reviewer observation; refresh before retrying",
  );
  const latest = unreportedReviewer(store.task(task.id), store.runs(task.id));
  if (
    !latest ||
    latest.id !== run.id ||
    state.id !== run.agentId ||
    state.workspaceId !== run.workspaceId
  )
    throw Error(
      "The retained reviewer binding changed; no report was requested",
    );
  if (
    state.active ||
    state.activeTurnId ||
    state.permissions ||
    !["idle", "error"].includes(state.status)
  )
    throw Error(
      "The retained reviewer is not positively idle; its current turn owns the report",
    );
  if (JSON.stringify(store.run(run.id)) !== JSON.stringify(run))
    throw Error("The reviewer run changed during observation");
  const occurrence = reviewerReportOccurrence(run, store.eventsAll(task.id));
  if (occurrence.kind === "missing")
    throw new ProvenPreSendRefusalError(occurrence.refusal);
  if (engine.dispatchWaitsFor(store.task(task.id), engine.isOwnerCall(), true))
    throw new ProvenPreSendRefusalError(
      "Dispatch is held; no reviewer report request was sent",
    );
  if (!task.resolution.reviewerAgentId) {
    task = store.transaction(() => {
      const current = store.task(task.id);
      engine.requireOwnerControlCurrent(
        current,
        version,
        "Task changed during reviewer observation; refresh before retrying",
      );
      if (unreportedReviewer(current, store.runs(task.id))?.id !== run.id)
        throw Error("The reviewer run changed during observation");
      return engine.resolution.update(
        current,
        { reviewerAgentId: run.agentId, reviewerProfile: run.profile },
        {},
        "reviewer_binding_reconciled",
        `${run.id}: restored the retained reviewer from its current run`,
      );
    });
  }
  // Re-read after every awaited proof so concurrent callers cannot both send.
  const refusal = reviewerReportRequestRefusal(run, store.eventsAll(task.id));
  if (refusal) throw new ProvenPreSendRefusalError(refusal);
  const messageId = reviewerReportMessageId(run.id);
  const text = `Nucleus did not receive your review report for run ${run.id} at head ${run.head}. Resend your existing authenticated report using this same run and credential; do not repeat checks or start another review. If you did not finish, continue the review and report its result.${instruction ? ` Owner direction: ${instruction}` : ""} Reason: ${reason}`;
  store.event(
    task.id,
    "reviewer_report_request_intent",
    `${run.id}: ${JSON.stringify({ agentId: run.agentId, messageId })}`,
  );
  try {
    await engine.onTaskHost(task, () =>
      engine.adapter.notify!(
        run.agentId!,
        messageId,
        `${text}${engine.adapter.reportingFallback ? ` ${engine.adapter.reportingFallback(run)}` : ""}`.slice(
          0,
          6000,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof ProvenPreSendRefusalError) {
      store.event(
        task.id,
        "reviewer_report_request_refused",
        `${run.id}: ${error.message}`,
      );
      throw error;
    }
    throw Error(
      `Reviewer report request delivery is unknown (${error instanceof Error ? error.message : String(error)}); it was not retried`,
    );
  }
  store.event(
    task.id,
    "reviewer_report_request_sent",
    `${run.id}: ${JSON.stringify({ agentId: run.agentId, messageId })}`,
  );
  return store.task(task.id);
}
