import type { Run, Task } from "../../shared/contracts";
import type { Engine } from "../engine";
import {
  hostFailureRefusalDetail,
  ProvenPreSendRefusalError,
} from "../host/errors";
import { runsUnchangedSince } from "../recovery/observation-advance";
import { taskPrNumber } from "../forge";
import { ordinaryReviewSource } from "../review/ordinary-review";

/** Observe the canonical PR without reattaching an ordinary detached review checkout. */
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
  await ordinaryReviewSource(task, run.head, true);
  const pr = await engine.adapter.verifyPrIdentity(task, number);
  await ordinaryReviewSource(task, run.head, true);
  if (pr.url !== task.prUrl || (requireRunHead && pr.head !== run.head))
    throw Error("Open PR, task and reviewer heads do not match");
  return pr;
}

/** A fresh reader may replace only a proven gone or non-independent binding. */
export async function requireReviewerReplacement(
  engine: Engine,
  task: Task,
  version: number,
): Promise<void> {
  const runs = engine.store.runs(task.id);
  const current = runs.find(
    (run) =>
      run.id === task.resolution.currentRunId &&
      run.role === "reviewer" &&
      !run.released,
  );
  const agentId = task.resolution.reviewerAgentId ?? current?.agentId;
  if (!agentId || engine.resolution.authorAgentIds(task).has(agentId)) return;
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
        return;
      // Missing or unreadable identity is not proof of a model collision.
    }
  }
  const state = await engine.onTaskHost(task, () =>
    engine.host.observe(agentId),
  );
  let archived = state.status === "closed";
  if (!archived && !state.active && !state.activeTurnId && !state.permissions) {
    try {
      const origin = await engine.onTaskHost(task, () =>
        engine.host.originAgent(agentId),
      );
      archived = !origin || origin.archived === true;
    } catch {
      /* An unreadable archive is not proof of absence. */
    }
  }
  engine.requireOwnerControlCurrent(
    engine.store.task(task.id),
    version,
    "Task changed during reviewer observation; refresh before retrying",
  );
  if (!runsUnchangedSince(runs, engine.store.runs(task.id)))
    throw Error("Task or run changed; refresh before retrying");
  if (
    state.id !== agentId ||
    state.workspaceId !== (prior?.workspaceId ?? task.workspaceId) ||
    !archived ||
    state.active ||
    state.activeTurnId ||
    state.permissions
  )
    throw Error(
      "The retained reviewer is still live or its absence is unproven; continue that reviewer instead",
    );
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

export function reviewerReportRequestRefusal(
  run: Run,
  events: readonly { kind: string; detail: string }[],
): string | null {
  if (
    run.reviewDeliveries?.some(
      (delivery) =>
        delivery.status === "reserved" || delivery.status === "uncertain",
    ) ||
    (run.reviewContinuation && run.reviewContinuation.status !== "delivered")
  )
    return "The retained reviewer has an unresolved checkpoint delivery; wait for observation before requesting its report";
  const prior = events.findLast(
    (event) =>
      [
        "reviewer_report_request_sent",
        "reviewer_report_request_intent",
        "reviewer_report_request_refused",
      ].includes(event.kind) && event.detail.startsWith(`${run.id}:`),
  );
  if (prior?.kind === "reviewer_report_request_sent")
    return "The retained reviewer was already asked to resend its report; wait for that report";
  if (prior?.kind === "reviewer_report_request_intent")
    return "The retained reviewer report request has unknown delivery; inspect it before retrying";
  return null;
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
  const messageId = `ns-reviewer-report-${run.id}`;
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
