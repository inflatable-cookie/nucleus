import type { Completion, Task } from "../../../shared/contracts";
import {
  clipDecisionQuestion,
  isDispositionActive,
  taskControlInputSchema,
} from "../../../shared/contracts";
import { automaticRetryForbidden } from "../../../shared/automatic-retry";
import { digest } from "../../store/store";
import { openProofOnlyGo } from "../../qa/proof-only-go";
import { proofWaitApplies } from "../../qa/proof-wait";
import {
  consecutiveNonDeliveries,
  reportsExternalCause,
  unfinishedContinuationEvents,
} from "../../recovery/non-delivery";
import { blockingRecoveryEffects } from "../../recovery/recovery-effects";
import { readyReviewAtHead } from "../../recovery/task-reasons";
import {
  collectOwnerVerbFacts,
  latestAuthorResult,
  ownerVerbViews,
} from "../../verbs/owner-verbs";
import { resultApplied } from "../../intake/applied-result";
import {
  blockerCauseId,
  isProviderFailure,
  reviewContinuationCauseId,
} from "./causes";
import type { Ladder } from "./ladder";
import {
  plannerEscalationOwnerSuffix,
  plannerEscalationSuggestedVerbs,
} from "./proof";
import {
  plannerEscalationQuestion,
  reviewContinuationEscalationQuestion,
} from "./questions";
import {
  findOpenPlannerEscalation,
  plannerEscalations,
  reviewerConsults,
  type LadderEvent,
} from "./records";
import { escalationWaitDetail } from "./waits";
import { blockerLadderStep } from "./pass";

/**
 * The ladder's park: what a stuck responsible task does when a run ends blocked or
 * errored, and the stops that reuse an ordinary verb instead of opening a question.
 * Everything here decides where a completed result goes; the routing of the
 * question it opens belongs to `routing.ts`.
 */

/** One rung of the ladder: which report raised it and the run that saw it. */
export type BlockerLadderInput = {
  source:
    | "worker"
    | "revision"
    | "executor"
    | "reviewer"
    | "recovery"
    | "closeout";
  runId: string | null;
  completion: Completion;
};

/** Publish the accepted receipt without doing the run's release or result application. */
export function publishBlockerReceipt(
  ladder: Ladder,
  t: Task,
  onReceipt = false,
): void {
  if (
    t.removedAt ||
    ["done", "cancelled"].includes(t.phase) ||
    t.entrypoint === "proof" ||
    isDispositionActive(t) ||
    ladder.resolution.paused() ||
    proofWaitApplies(t)
  )
    return;

  const run = t.resolution.currentRunId
    ? ladder.store.run(t.resolution.currentRunId)
    : null;
  const parked =
    ["blocked", "error"].includes(t.phase) &&
    !run &&
    !t.resolution.recoveryActive;
  const initial =
    !run &&
    ["working", "dispatching", "needs_attention"].includes(t.phase) &&
    t.completion?.runId === t.runId;
  const source =
    run?.role === "revision" ||
    run?.role === "reviewer" ||
    run?.role === "closeout"
      ? run.role
      : initial || parked
        ? "worker"
        : null;
  const completion =
    run?.completion ??
    (initial
      ? t.completion
      : parked
        ? latestAuthorResult(t, ladder.store.runs(t.id))
        : null);
  if (
    !source ||
    !completion ||
    isProviderFailure(completion) ||
    run?.mergeRetirement ||
    (!parked && resultApplied(ladder.store, t.id, completion.runId))
  )
    return;

  if (!["blocked", "error"].includes(completion.status)) {
    if (run)
      ladder.resolution.escalationSettlement.retireCorrectedBlocker(t, run.id);
    return;
  }
  if (completion.sourceApproved || (run && !t.responsible)) return;

  const events = ladder.store.eventsAll(t.id);
  const cause = blockerCauseId(t.id, completion);
  const classified = events.some(
    (event) =>
      event.kind === "blocker_ladder_classified" &&
      event.detail.startsWith(`${completion.eventId}:`),
  );
  if (restoreReceiptRung(ladder, t, completion, cause, events)) return;

  // A parked legacy receipt is eligible only when the old classification
  // has no rung. The normal settlement path handles unclassified parked work.
  if (
    !classified &&
    (!onReceipt ||
      parked ||
      !ladder.store.receiptHash(completion.eventId, t.id, completion.runId))
  )
    return;
  if (
    t.resolution.stop?.reason === "responsible_question" ||
    t.resolution.ownerStop ||
    (t.resolution.attention && t.resolution.mergeIntent)
  )
    return;
  if (!parked && (source === "worker" || source === "revision")) {
    const nonDeliveries = consecutiveNonDeliveries(events);
    if (
      unfinishedContinuationEvents(events).some(
        (item) => item.runId === completion.runId,
      ) ||
      (nonDeliveries.length <= (source === "worker" ? 1 : 2) &&
        nonDeliveries.some((item) => item.runId === completion.runId))
    )
      return;
  }
  if (holdProofOnlyGoWait(ladder, t)) return;

  const publish = () => {
    routeBlocker(
      ladder,
      t,
      { source, runId: completion.runId, completion },
      events,
      cause,
    );
    if (!classified)
      ladder.store.event(
        t.id,
        "blocker_ladder_classified",
        `${completion.eventId}: ${cause}`,
      );
  };
  if (ladder.store.db.isTransaction) publish();
  else ladder.store.transaction(publish);
}

/** A routed answer can arrive while its authenticated blocker still owns execution. */
export async function waitForBlockerSettlement(
  ladder: Ladder,
  taskId: string,
  escalationId: string,
): Promise<void> {
  const events = ladder.store.eventsAll(taskId);
  const escalation = plannerEscalations(events).find(
    (item) => item.id === escalationId,
  );
  if (
    !escalation?.runId ||
    escalation.answered ||
    !events.some(
      (event) =>
        event.kind === "blocker_ladder_classified" &&
        event.detail.endsWith(`: ${escalation.cause}`),
    )
  )
    return;
  const runId = escalation.runId;

  const stillSettling = () => {
    if (ladder.resolution.stopped()) return false;
    const task = ladder.store.taskOrNull(taskId);
    if (
      !task ||
      isDispositionActive(task) ||
      ["done", "cancelled"].includes(task.phase)
    )
      return false;
    const run = ladder.store.run(runId);
    const completion = run?.completion ?? task.completion;
    if (
      completion?.runId !== runId ||
      blockerCauseId(taskId, completion) !== escalation.cause
    )
      return false;
    if (run ? task.resolution.currentRunId !== runId : task.runId !== runId)
      return false;
    return !resultApplied(ladder.store, taskId, runId);
  };
  if (!stillSettling()) return;
  await new Promise<void>((resolve) => {
    const settle = () => {
      if (stillSettling()) return;
      unsubscribe();
      clearInterval(shutdown);
      resolve();
    };
    const unsubscribe = ladder.store.onTaskChange((id) => {
      if (id === taskId) queueMicrotask(settle);
    });
    const shutdown = setInterval(settle, 1000);
    shutdown.unref();
  });
}

/** Reuse a receipt's durable rung when observations or settlement change the task reason. */
function restoreReceiptRung(
  ladder: Ladder,
  t: Task,
  completion: Completion,
  cause: string,
  events: LadderEvent[],
): boolean {
  const escalations = plannerEscalations(events).filter(
    (item) =>
      item.cause === cause &&
      (item.runId === completion.runId ||
        events.some(
          (event) =>
            event.kind === "planner_escalation_attached" &&
            event.detail ===
              `${item.id}: attach run ${completion.runId}; ${cause}`,
        )),
  );
  const consults = reviewerConsults(events).filter(
    (item) =>
      item.cause === cause &&
      item.runId === completion.runId &&
      !item.answered &&
      !item.unknown,
  );
  if (!escalations.length && !consults.length) return false;
  const stop = t.resolution.stop;
  if (!stop || ["lifecycle", "validation"].includes(stop.reason)) {
    const next = blockerLadderStep({
      classified: true,
      completion,
      escalations,
      consults,
    });
    if (next.kind === "wait")
      ladder.resolution.waiting(t, next.detail, "escalated", {
        fact: next.fact,
        holderAgentId: next.holderAgentId,
      });
  }
  return true;
}

/**
 * Spec 058 slice 17 (task 584): the blocker ladder for a stuck responsible task.
 * A worker or revision run that ended blocked/error — anything but a provider
 * failure, which the ordinary replacement settles — climbs: one reviewer consult
 * per cause whose advice continues the same worker; then one planner escalation
 * per cause as a delegated decision, which the task waits on with no further
 * worker turns; a repeated blocker on the same cause attaches to the open
 * escalation instead of starting another turn or ask. Returns true when the
 * ladder owns the park, so the caller writes no ordinary blocked stop.
 */
export async function responsibleBlockerLadder(
  ladder: Ladder,
  parked: Task,
  input: BlockerLadderInput,
): Promise<boolean> {
  let t = parked;
  // Queue #691: a finished task has no ladder. Returning true tells the caller the park is
  // not its to write, so a late blocked report never moves a done task to blocked.
  if (["done", "cancelled"].includes(t.phase)) return true;
  if (isDispositionActive(t) || ladder.resolution.paused()) return false;
  const completion = input.completion;
  // A provider failure is never a ladder blocker: the failover sweep and the
  // non-delivery replacement path keep their own handling (Slices 2 and 14).
  if (isProviderFailure(completion)) return false;
  // A source-approved proof round's blocked return is the proof wait's own
  // episode (Spec 058 slice 9): the retained reviewer named those proofs, the
  // ordinary re-park applies, and the ladder stands down.
  if (proofWaitApplies(t)) return false;
  // A recovery report about an otherwise ready lifecycle step is not a
  // planning question. Reuse the ordinary move only when the current view
  // offers it, and never step over an uncertain delivery or merge response.
  if (
    input.source === "recovery" &&
    ladder.resolution.applyOperatorControl &&
    t.completion?.status === "ready_for_review" &&
    t.prHead &&
    !t.resolution.mergeIntent &&
    !t.resolution.mergedCommit &&
    !blockingRecoveryEffects(ladder.store, t, { noticeKinds: "all" }).length
  ) {
    const runs = ladder.store.runs(t.id);
    const reader = runs.some((run) => run.role === "reviewer" && !run.released);
    const target = readyReviewAtHead(t)
      ? "merge"
      : t.phase === "awaiting_review" && !reader && !t.resolution.review
        ? "review"
        : null;
    const available =
      target &&
      ownerVerbViews(
        collectOwnerVerbFacts(ladder.store, t, null, input.runId),
      ).some(
        (view) =>
          view.verb === "move" &&
          view.available &&
          view.args?.to === target &&
          !(view.fill ?? []).includes("qualification"),
      );
    if (target && available) {
      try {
        await ladder.resolution.applyOperatorControl(
          taskControlInputSchema.parse({
            taskId: t.id,
            version: t.version,
            action: "move",
            to: target,
            reason: `Resume the already-ready ${target} step after recovery`,
          }),
        );
        ladder.store.event(
          t.id,
          "planner_escalation_avoided",
          `Recovery found the ${target} step ready; its ordinary gates remain in force`,
        );
        return true;
      } catch (error) {
        ladder.store.event(
          t.id,
          "planner_escalation_automatic_refused",
          `${target}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4000,
          ),
        );
        t = ladder.store.task(t.id);
      }
    }
  }
  const events = ladder.store.eventsAll(t.id);
  const cause = blockerCauseId(t.id, completion);
  if (restoreReceiptRung(ladder, t, completion, cause, events)) return true;
  // The lane reads honestly while the ladder holds it, and the completed run's
  // lease ends here: without clearing it, every later pass would replay this
  // completion into a second consult or escalation.
  if (
    (completion.status === "blocked" || completion.status === "error") &&
    (t.phase !== completion.status ||
      t.resolution.currentRunId ||
      t.resolution.attention)
  )
    t = ladder.resolution.update(
      t,
      { currentRunId: null, integrationTurn: null, attention: false },
      { phase: completion.status, reason: completion.summary.slice(0, 4000) },
      "blocker_ladder_park",
      completion.summary.slice(0, 2000),
    );
  // effigy#697: a GO-gate reviewer's blocked report is the release GO's wait, not a
  // planning question. No consult, escalation or route offer applies; only the answer.
  if (holdProofOnlyGoWait(ladder, t)) return true;
  return routeBlocker(ladder, t, input, events, cause);
}

function routeBlocker(
  ladder: Ladder,
  t: Task,
  input: BlockerLadderInput,
  events: LadderEvent[],
  cause: string,
): boolean {
  const { completion } = input;
  const open = findOpenPlannerEscalation(events as LadderEvent[], cause);
  if (open) {
    const attach = `${open.id}: attach run ${input.runId ?? "worker"}; ${cause}`;
    if (
      !events.some(
        (event) =>
          event.kind === "planner_escalation_attached" &&
          event.detail === attach,
      )
    )
      ladder.store.event(t.id, "planner_escalation_attached", attach);
    ladder.resolution.waiting(
      ladder.store.task(t.id),
      `${escalationWaitDetail.attached(open.id)}; reported cause: ${completion.summary.slice(0, 2000)}`,
      "escalated",
      { suggestedVerbs: plannerEscalationSuggestedVerbs(t) },
    );
    return true;
  }
  const consults = reviewerConsults(events as LadderEvent[]);
  const continuation = input.runId
    ? ladder.store.run(input.runId)?.revisionCause === "consult"
    : false;
  const consulted =
    consults.find((consult) => consult.cause === cause) ??
    (continuation
      ? consults.findLast((consult) => consult.answered)
      : undefined);
  // A cause genuinely outside the task never needs a second opinion: it goes
  // straight to the planner. A consulted cause skips the second ask too.
  const secondOpinionMakesSense =
    input.source === "worker" || input.source === "revision";
  if (
    secondOpinionMakesSense &&
    !consulted &&
    !automaticRetryForbidden(t, ladder.store.runs(t.id)) &&
    !reportsExternalCause(completion, events, input.runId ?? "worker")
  ) {
    const reviewer = t.resolution.reviewerAgentId;
    if (
      (reviewer && ladder.adapter.askReviewer) ||
      (!reviewer &&
        ladder.adapter.createConsultReviewer &&
        ladder.adapter.askReviewer)
    ) {
      ladder.resolution.openReviewerConsult(ladder.store.task(t.id), {
        cause,
        runId: input.runId,
        completion,
        reviewer,
      });
      return true;
    }
    ladder.store.event(
      t.id,
      "reviewer_consult_unavailable",
      `${cause}: reviewer consult adapter unavailable; planner must decide the next step`,
    );
  }
  const advice =
    consulted?.advice ??
    (consulted
      ? "The retained reviewer was consulted for this cause but gave no usable advice in time."
      : null);
  const question = `${plannerEscalationQuestion(t, completion, advice)}${plannerEscalationOwnerSuffix(t)}`;
  ladder.resolution.openPlannerEscalation(ladder.store.task(t.id), {
    cause,
    runId: input.runId,
    question,
    payload: {
      cause,
      runId: input.runId ?? null,
      source: input.source,
      question,
    },
    causeDetail: completion.summary,
    suggestedVerbs: plannerEscalationSuggestedVerbs(t),
  });
  return true;
}

/**
 * effigy#697: while a proof-only release GO is open the task waits on the operator.
 * The wait is read from that fact, not kept from an earlier write: the reviewer's first
 * idle observation rewrites the task reason, and a reason change clears a stop that was
 * not written explicitly, so each quantum re-asserts it.
 */
export function holdProofOnlyGoWait(ladder: Ladder, t: Task): boolean {
  // Every quantum calls this, so the task's own fields gate the run and event reads.
  if (!t.requiresOperatorGo || t.phase !== "blocked") return false;
  const question = openProofOnlyGo(
    t,
    ladder.store.runs(t.id),
    ladder.store.eventsAll(t.id),
  );
  if (!question) return false;
  ladder.resolution.waiting(
    ladder.store.task(t.id),
    escalationWaitDetail.proofGo(
      t.proofOnly?.commit ?? "the merged commit",
      question,
    ),
    "escalated",
  );
  return true;
}

/** Run the executor rung after its completion transaction commits. */
export async function settleCompletedExecutorBlocker(
  ladder: Ladder,
  input: Completion,
): Promise<void> {
  if (!["blocked", "error"].includes(input.status)) return;
  const run = ladder.store.run(input.runId);
  if (
    !run ||
    run.role !== "executor" ||
    run.taskId !== input.taskId ||
    run.completion?.eventId !== input.eventId
  )
    return;
  const task = ladder.store.task(input.taskId);
  // Only escalate when settlement left this responsible task parked on the
  // reported result. A proof run returned to its worker or review lane has an
  // actionable owner and does not need planner intervention.
  if (
    task.responsible !== true ||
    task.phase !== input.status ||
    task.reason !== input.summary ||
    task.resolution.currentRunId
  )
    return;
  await ladder.resolution.responsibleBlockerLadder(task, {
    source: "executor",
    runId: run.id,
    completion: input,
  });
}

/** Keep a completed result and hand a forbidden automatic relaunch to the planner. */
export function suppressAutomaticRetry(
  ladder: Ladder,
  t: Task,
  site: string,
  evidence: string,
  runId: string | null = null,
): boolean {
  if (!automaticRetryForbidden(t, ladder.store.runs(t.id))) return false;
  const cause = `automatic-retry-suppressed:${site}:${runId ?? "task"}`;
  const events = ladder.store.eventsAll(t.id);
  if (
    events.some(
      (event) =>
        event.kind === "automatic_retry_suppressed" &&
        event.detail.startsWith(`${cause}:`),
    )
  )
    return true;
  const kept = evidence.slice(0, 3000);
  ladder.store.event(
    t.id,
    "automatic_retry_suppressed",
    `${cause}: kept evidence: ${kept}`,
  );
  const question = clipDecisionQuestion(
    `The owner forbids automatic retry at ${site}. Preserve the completed result and decide the next existing owner action. Evidence: ${kept}`,
  );
  ladder.resolution.openPlannerEscalation(ladder.store.task(t.id), {
    cause,
    runId,
    question,
    payload: { cause, runId, site, evidence: kept, question },
  });
  return true;
}

/**
 * Spec 058 cutover 5 (follow-up A): a reviewer-checkpoint stop — budget exhausted or the
 * reviewer's agent observed closed — escalates through the planner ladder instead of an owner
 * disposition. At most one escalation per cause: the recovery sweep re-reports the same stop
 * every pass, so an existing escalation is never opened again for the same reader. The reader
 * is the episode, so a reviewer that later exhausts after a replacement is a fresh cause and
 * never sits under the answered escalation for the reader before it (nucleus#1372). Returns
 * the cause id; `detail` names on the wait why an automatic exit could not be taken.
 */
export function openReviewContinuationEscalation(
  ladder: Ladder,
  t: Task,
  state: "exhausted" | "closed",
  detail = "",
): string {
  const reader = t.resolution.currentRunId ?? null;
  const cause = reviewContinuationCauseId(t.id, state, reader);
  if (
    plannerEscalations(ladder.store.eventsAll(t.id) as LadderEvent[]).some(
      (escalation) => escalation.cause === cause,
    )
  )
    return cause;
  const question = reviewContinuationEscalationQuestion(t, state);
  ladder.resolution.openPlannerEscalation(t, {
    cause,
    runId: null,
    question,
    payload: {
      cause,
      runId: null,
      reviewContinuation: state,
      reader,
      question,
    },
    ...(detail ? { causeDetail: detail } : {}),
  });
  return cause;
}

/** A second refused coordinator choice reaches the existing planner ladder. */
export function escalateRefusedCoordinator(
  ladder: Ladder,
  t: Task,
  reason: string,
): void {
  const cause = digest(
    `coordinator-refused:${t.id}:${t.resolution.recovery?.id ?? ""}`,
  );
  if (
    findOpenPlannerEscalation(
      ladder.store.eventsAll(t.id) as LadderEvent[],
      cause,
    )
  )
    return;
  const question = `${reason} Decide which owner verb should continue this task.`;
  ladder.resolution.openPlannerEscalation(t, {
    cause,
    runId: t.resolution.recovery?.runId ?? null,
    question,
    payload: { cause, reason, question },
  });
}
