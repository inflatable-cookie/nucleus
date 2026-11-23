import {
  isOperatorOrigin,
  taskOwner,
  taskPlanner,
  type Task,
  type TaskStopVerb,
} from "../../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../../shared/lanes";
import { digest } from "../../store/store";
import {
  DELEGATED_ANSWER_TIMEOUT_MS,
  nativeDelegationPrompt,
} from "../question-delegation";
import { delegateQuestion, plannerWindows } from "../planner-delegation";
import { DelegatedHostUnavailable } from "../delegation";
import type { Ladder } from "./ladder";
import { plannerEscalationSuggestedVerbs } from "./proof";
import {
  plannerEscalationChoicesFor,
  type EscalationVerbChoice,
} from "./questions";
import { plannerEscalations, type LadderEvent } from "./records";
import { parseEscalationReply } from "./replies";
import { escalationWaitDetail } from "./waits";
import { closeEscalationFollowups } from "./continuation";

/**
 * Routing one recorded escalation: the durable intent and wait the caller records,
 * then the rungs it travels — the task's own planner, the project's planner, the
 * decider — and the refusal follow-up. A send whose outcome nobody observed is
 * fenced here; it is never re-asked.
 */

/** What the caller records before any send: the cause, the question and its payload. */
export type OpenEscalationInput = {
  cause: string;
  runId: string | null;
  question: string;
  payload: object;
  suggestedVerbs?: TaskStopVerb[];
  causeDetail?: string;
};

/** Record the durable escalation intent, park the task with the planner, then route the delegate. */
export function openPlannerEscalation(
  ladder: Ladder,
  t: Task,
  input: OpenEscalationInput,
): void {
  const events = ladder.store.eventsAll(t.id);
  const occurrence = plannerEscalations(events as LadderEvent[]).filter(
    (escalation) => escalation.cause === input.cause,
  ).length;
  const id = digest(
    ["planner-escalation", t.id, input.cause, String(occurrence)].join(":"),
  );
  const write = () => {
    ladder.store.event(
      t.id,
      "planner_escalation",
      `${id}: cause ${input.cause}; run ${input.runId ?? "worker"}; question ${digest(input.question)} (${input.question.length} chars); options ${plannerEscalationChoicesFor(t).join(" | ")}`,
    );
    ladder.store.event(
      t.id,
      "planner_escalation_question",
      `${id}: ${input.question}`.slice(0, 12000),
    );
    ladder.store.event(
      t.id,
      "planner_escalation_payload",
      `${id}: ${JSON.stringify({ ...input.payload, id, runId: input.runId })}`,
    );
  };
  // A caller inside an open transaction (the review application) joins it.
  if (ladder.store.db.isTransaction) write();
  else ladder.store.transaction(write);
  const waitDetail = `${escalationWaitDetail.planner(id)}${input.causeDetail ? `; reported cause: ${input.causeDetail.slice(0, 2000)}` : ""}`;
  ladder.resolution.waiting(ladder.store.task(t.id), waitDetail, "escalated", {
    suggestedVerbs: input.suggestedVerbs,
  });
  // The in-flight guard is synchronous, so the maintenance sweep can never start a
  // second drive; the launch itself waits for any open transaction to commit, so a
  // rollback never leaves a routing promise running against rolled-back intents.
  if (ladder.routingEscalations.has(id)) return;
  ladder.routingEscalations.add(id);
  queueMicrotask(() => {
    if (ladder.resolution.stopped()) {
      ladder.routingEscalations.delete(id);
      return;
    }
    void ladder.resolution
      .routePlannerEscalation(ladder.store.task(t.id), id, input.question)
      .catch((error) => {
        if (ladder.resolution.stopped()) return;
        ladder.store.event(
          t.id,
          "planner_escalation_unknown",
          `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4000,
          ),
        );
        ladder.resolution.waiting(
          ladder.store.task(t.id),
          escalationWaitDetail.unknown(id),
          "escalated",
        );
      })
      .finally(() => ladder.routingEscalations.delete(id));
  });
}

function nonOperatorEscalationHolder(
  ladder: Ladder,
  task: Task,
): string | undefined {
  const planner = taskPlanner(task);
  if (planner && !isOperatorOrigin(planner)) return planner;
  const project = ladder.store.projectFor(
    task.repoPath,
    normalizeRepositoryOrigin(task.repository ?? ""),
  );
  if (project?.planner?.agentId && !isOperatorOrigin(project.planner.agentId))
    return project.planner.agentId;
  const owner = taskOwner(task);
  return owner && !isOperatorOrigin(owner) ? owner : undefined;
}

function originalEscalationQuestion(
  events: readonly LadderEvent[],
  id: string,
): string {
  const questionEvent = events.find(
    (event) =>
      event.kind === "planner_escalation_question" &&
      event.detail.startsWith(`${id}: `),
  );
  if (questionEvent) return questionEvent.detail.slice(id.length + 2);
  const payloadEvent = events.find(
    (event) =>
      event.kind === "planner_escalation_payload" &&
      event.detail.startsWith(`${id}:`),
  );
  if (payloadEvent) {
    try {
      const parsed = JSON.parse(
        payloadEvent.detail.slice(payloadEvent.detail.indexOf(":") + 1),
      ) as { question?: string };
      if (parsed.question) return parsed.question;
    } catch {
      /* fallback below */
    }
  }
  return `Blocker escalation ${id} needs a planner recommendation.`;
}

function returnedEscalationQuestion(
  t: Task,
  events: readonly LadderEvent[],
  id: string,
  choices: readonly string[],
): string {
  const original = originalEscalationQuestion(events, id);
  const returned = events.findLast(
    (event) =>
      event.kind === "planner_escalation_returned" &&
      event.detail.startsWith(`${id}:`),
  );
  let who = "a planner";
  let reason = "no concrete operator choices were supplied";
  if (returned) {
    try {
      const parsed = JSON.parse(
        returned.detail.slice(returned.detail.indexOf(":") + 1),
      ) as { who?: string; reason?: string };
      if (parsed.who) who = parsed.who;
      if (parsed.reason) reason = parsed.reason;
    } catch {
      /* keep fallback text */
    }
  }
  return [
    `Blocker escalation ${id} on "${t.title}" was returned to the planner for a recommendation instead of asking the operator.`,
    `${who} classified it without concrete choices (${reason}).`,
    `When the only choices are keeping a task blocked or returning it to the planner with a recommendation, the planner must produce the recommendation without asking the operator.`,
    `Original escalation: ${original}`,
    `Work needed: decide an ordinary next step (${choices.join("; ")}), answer directly with the direction the worker should follow, or file a concrete Spec 032 decision with choices and consequences via decision.add and answer with "Wait for an operator decision (put its ID in Reason)".`,
  ].join(" ");
}

/** Route one recorded escalation to the project planner, then a decider; only concrete operator choices reach Tom. */
export async function routePlannerEscalation(
  ladder: Ladder,
  t: Task,
  id: string,
  question: string,
): Promise<void> {
  const events = ladder.store.eventsAll(t.id) as LadderEvent[];
  const record = plannerEscalations(events).find((item) => item.id === id);
  if (record?.answered) return;
  if (record?.returned) {
    const returnedEvent = events.findLast(
      (event) =>
        event.kind === "planner_escalation_returned" &&
        event.detail.startsWith(`${id}:`),
    );
    return routeEscalationRound(
      ladder,
      t,
      id,
      null,
      "return",
      returnedEvent?.id ?? 0,
    );
  }
  return routeEscalationRound(ladder, t, id, question, "initial", 0);
}

/** Route a returned escalation occurrence back through the planner ladder to produce a recommendation. */
export async function routePlannerEscalationReturn(
  ladder: Ladder,
  t: Task,
  id: string,
): Promise<void> {
  const events = ladder.store.eventsAll(t.id) as LadderEvent[];
  const returnedEvent = events.findLast(
    (event) =>
      event.kind === "planner_escalation_returned" &&
      event.detail.startsWith(`${id}:`),
  );
  return routeEscalationRound(
    ladder,
    t,
    id,
    null,
    "return",
    returnedEvent?.id ?? 0,
  );
}

async function routeEscalationRound(
  ladder: Ladder,
  t: Task,
  id: string,
  initialQuestion: string | null,
  phase: "initial" | "return",
  phaseAfter: number,
): Promise<void> {
  const events = () => ladder.store.eventsAll(t.id) as LadderEvent[];
  const deferred = ladder.store.task(t.id).resolution.deferredVerb?.input
    .__workerAsk as { escalationId?: string } | undefined;
  if (deferred?.escalationId === id) return;
  if (
    phase === "return" &&
    events().some(
      (event) =>
        event.kind === "planner_escalation_return_exhausted" &&
        event.detail.startsWith(`${id}:`) &&
        event.id >= phaseAfter,
    )
  )
    return;
  if (
    events().some(
      (event) =>
        event.kind === "planner_escalation_missed" &&
        event.id > phaseAfter &&
        event.detail.startsWith(`${id}: no delegated answer was produced;`),
    )
  )
    return;
  const baseId =
    phase === "return" ? `ns-escalation-return-${id}` : `ns-escalation-${id}`;
  const windows =
    phase === "return"
      ? [baseId, `${baseId}-project`]
      : [baseId, `${baseId}-project`, `ns-decider-${id}`];
  const refusalBaseId =
    phase === "return"
      ? `ns-escalation-return-refusal-${id}`
      : `ns-escalation-refusal-${id}`;
  const recoverable = ladder.resolution.recoverableDelegation(windows);
  const observing = ladder.resolution.recoverableDelegation(windows, false);
  if (
    events().some(
      (event) =>
        event.kind === "planner_escalation_action_uncertain" &&
        event.detail.startsWith(`${id}:`),
    )
  )
    return;
  if (
    events().some(
      (event) =>
        ([
          "planner_escalation_answered",
          "planner_escalation_resolved",
        ].includes(event.kind) &&
          event.detail.startsWith(`${id}:`)) ||
        (!observing &&
          event.kind === "planner_escalation_unknown" &&
          event.id > phaseAfter &&
          event.detail.startsWith(`${id}:`)),
    )
  )
    return;
  if (
    !recoverable &&
    events().some(
      (event) =>
        (phase === "return"
          ? event.kind === "planner_escalation_return_sent"
          : event.kind === "planner_escalation_sent") &&
        event.detail.startsWith(`${id}:`),
    )
  ) {
    ladder.store.event(
      t.id,
      "planner_escalation_unknown",
      `${id}: a previous delegate delivery could not be observed; Nucleus never re-asks it`,
    );
    ladder.resolution.waiting(
      ladder.store.task(t.id),
      escalationWaitDetail.unknown(id),
      "escalated",
    );
    return;
  }
  const context = ladder.resolution.decisionContext(t);
  const offerEvent = events().find(
    (event) =>
      event.kind === "planner_escalation_offered" &&
      event.detail.startsWith(`${id}: `),
  );
  // Spec 067 batch 4 (round 10): new escalations offer plain choices only;
  // executable owner-verb answers move to a follow-up lead.
  const offered: EscalationVerbChoice[] = offerEvent
    ? (JSON.parse(
        offerEvent.detail.slice(id.length + 2),
      ) as EscalationVerbChoice[])
    : [];
  if (!offerEvent)
    ladder.store.event(
      t.id,
      "planner_escalation_offered",
      `${id}: ${JSON.stringify(offered)}`,
    );
  const choices = [
    ...plannerEscalationChoicesFor(t),
    ...offered.map((item) => item.label),
  ];
  const question =
    phase === "return"
      ? returnedEscalationQuestion(t, events(), id, choices)
      : initialQuestion!;
  const payload = events().find(
    (event) =>
      event.kind === "planner_escalation_payload" &&
      event.detail.startsWith(`${id}: `),
  );
  const runId = payload
    ? (JSON.parse(payload.detail.slice(id.length + 2)) as { runId?: string })
        .runId
    : undefined;
  const sourceAgentId = runId
    ? (ladder.store.run(runId)?.agentId ?? t.agentId ?? undefined)
    : (t.agentId ?? undefined);
  let pending = false;
  // Task 1109: the task's own planner first, then the project planner, then the decider.
  const { rungs, issue } = await ladder.resolution.plannerRungsFor(t);
  const planners = plannerWindows(ladder.resolution, baseId, rungs);
  if (
    ladder.resolution.stopped() ||
    plannerEscalations(events()).find((item) => item.id === id)?.answered
  )
    return;
  const fallbackHolder = nonOperatorEscalationHolder(
    ladder,
    ladder.store.task(t.id),
  );
  const recordRoutingWait = (detail: string, holderAgentId?: string) => {
    const latest = events().findLast(
      (event) =>
        event.kind === "planner_escalation_routing_wait" &&
        event.detail.startsWith(`${id}: `) &&
        event.id > phaseAfter,
    );
    const reason = issue ? `${detail}. ${issue}` : detail;
    const resolvedHolder = holderAgentId ?? fallbackHolder;
    const routed = issue
      ? {
          detail: reason,
          ...(resolvedHolder ? { holderAgentId: resolvedHolder } : {}),
        }
      : null;
    const entry = `${id}: ${JSON.stringify(routed)}`;
    if ((latest || routed) && latest?.detail !== entry)
      ladder.store.event(t.id, "planner_escalation_routing_wait", entry);
    ladder.resolution.waiting(ladder.store.task(t.id), reason, "escalated", {
      ...(resolvedHolder ? { holderAgentId: resolvedHolder } : {}),
    });
  };
  const isTerminalPhase = (task: Task): boolean =>
    task.phase === "done" || task.phase === "cancelled";
  if (
    issue &&
    !planners.length &&
    !recoverable &&
    !isTerminalPhase(ladder.store.task(t.id))
  ) {
    recordRoutingWait(
      phase === "return"
        ? `Blocker escalation ${id} was returned to the planner and is waiting for a routable planner`
        : `Blocker escalation ${id} is waiting for a routable planner`,
      fallbackHolder,
    );
    return;
  }
  const delegated = await delegateQuestion(ladder.resolution, t, {
    planners,
    allowDecider: false,
    decisionId: id,
    context: { question, choices, context },
    signal: new AbortController().signal,
    sourceAgentId,
    parse: (text) => parseEscalationReply(text, choices),
    retainDecider: true,
    current: () =>
      !plannerEscalations(events()).find((item) => item.id === id)?.answered,
    canAdvance: () => !isTerminalPhase(ladder.store.task(t.id)),
    onIntent: (role, agentId, rung) => {
      if (
        !recoverable &&
        !events().some(
          (event) =>
            (phase === "return"
              ? event.kind === "planner_escalation_return_sent"
              : event.kind === "planner_escalation_sent") &&
            event.detail.startsWith(`${id}:`),
        )
      ) {
        if (phase === "return")
          ladder.store.event(
            t.id,
            "planner_escalation_return_sent",
            `${id}: sent`,
          );
        else ladder.store.event(t.id, "planner_escalation_sent", `${id}: sent`);
      }
      if (role === "planner")
        recordRoutingWait(
          `Waiting with the planner or task owner ${agentId}: blocker escalation ${id} (${rung === "task" ? "task planner" : "project planner"} rung) is open`,
          agentId,
        );
      else if (issue)
        recordRoutingWait(
          `Waiting with a decider: blocker escalation ${id} is open`,
        );
      ladder.store.event(
        t.id,
        "planner_escalation_delegated",
        `${id}: ${role === "planner" ? `${rung === "task" ? "task planner" : "project planner"} ${agentId}; asked` : "decider requested"}`,
      );
    },
    onSkip: (rung, agentId, detail) =>
      ladder.store.event(
        t.id,
        "planner_escalation_delegation_skipped",
        `${id}: ${rung} planner ${agentId} skipped: ${detail}`.slice(0, 4000),
      ),
    onMiss: (detail) =>
      ladder.store.event(t.id, "planner_escalation_missed", `${id}: ${detail}`),
    onUnknown: (role, agentId, error) => {
      pending = true;
      if (plannerEscalations(events()).find((item) => item.id === id)?.answered)
        return;
      ladder.store.event(
        t.id,
        "planner_escalation_unknown",
        `${id}: ${role}${agentId ? ` ${agentId}` : ""}: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          4000,
        ),
      );
      recordRoutingWait(escalationWaitDetail.unknown(id));
    },
  }).catch((error) => {
    if (!(error instanceof DelegatedHostUnavailable)) throw error;
    pending = true;
    return null;
  });
  if (pending || ladder.resolution.stopped()) return;
  const reply = delegated?.reply ?? null;
  const who = delegated ? `${delegated.role} ${delegated.agentId}` : null;
  const archiveDecider = async () => {
    if (delegated?.role !== "decider") return;
    try {
      await ladder.resolution.host.archiveAgent(delegated.agentId);
    } catch (error) {
      ladder.store.event(
        t.id,
        "planner_escalation_archive_failed",
        `${id}: decider ${delegated.agentId}: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          4000,
        ),
      );
    }
  };
  if (!reply && isTerminalPhase(ladder.store.task(t.id))) {
    ladder.store.event(
      t.id,
      "planner_escalation_answered",
      `${id}: answered by ordinary progress: the task merged or ended first`,
    );
    closeEscalationFollowups(ladder.store, t.id, id);
    return;
  }
  if (plannerEscalations(events()).find((item) => item.id === id)?.answered)
    return;
  if (!reply || !who) {
    ladder.store.event(
      t.id,
      "planner_escalation_missed",
      phase === "return"
        ? `${id}: no delegated answer was produced; the returned escalation stays open and parked for the planner`
        : `${id}: no delegated answer was produced; the escalation stays open for the planner`,
    );
    if (phase === "return") {
      const current = ladder.store.task(t.id);
      ladder.resolution.waiting(
        current,
        escalationWaitDetail.returnedNoPlanner(id),
        "escalated",
        {
          suggestedVerbs: plannerEscalationSuggestedVerbs(current),
          ...(fallbackHolder ? { holderAgentId: fallbackHolder } : {}),
        },
      );
    }
    return;
  }
  const initialQuestionId =
    delegated?.role === "decider"
      ? `ns-decider-${id}`
      : delegated?.rung === "project"
        ? `${baseId}-project`
        : baseId;
  if (reply.kind === "operator") {
    await archiveDecider();
    ladder.resolution.classifyEscalationToOperator(
      ladder.store.task(t.id),
      id,
      reply.reason,
      who,
      { authority: "bare_classification", sourceQuestionId: initialQuestionId },
    );
    return;
  }
  const answer =
    reply.kind === "choice"
      ? `${reply.choice} — ${reply.reason}`.trim()
      : reply.answer;
  const recordedRefusal = events().findLast(
    (event) =>
      event.kind === "planner_escalation_answer_refused" &&
      event.id > phaseAfter &&
      event.detail.startsWith(`${id}:`),
  );
  // The delegated command may have deferred the direction while this route was
  // awaiting its reply. Do not submit that same direction a second time.
  const pendingDirection = ladder.store.task(t.id).resolution.deferredVerb
    ?.input.__workerAsk as { escalationId?: string } | undefined;
  if (pendingDirection?.escalationId === id) return;
  let refusal = recordedRefusal
    ? recordedRefusal.detail.slice(`${id}:`.length).trim()
    : await ladder.resolution.escalationSettlement.settlePlannerEscalation(
        ladder.store.task(t.id),
        id,
        answer,
        who,
        offered,
        initialQuestionId,
        delegated!,
      );
  if (refusal) {
    const priorFollowup = events().findLast(
      (event) =>
        event.kind === "planner_escalation_followup_offered" &&
        event.detail.startsWith(`${id}: `) &&
        (() => {
          try {
            const parsed = JSON.parse(event.detail.slice(id.length + 2)) as {
              questionId?: string;
            };
            return Boolean(parsed.questionId?.startsWith(refusalBaseId));
          } catch {
            return false;
          }
        })(),
    );
    const followupOffer = priorFollowup
      ? (JSON.parse(priorFollowup.detail.slice(id.length + 2)) as {
          questionId: string;
          choices: string[];
          ownerChoices: EscalationVerbChoice[];
        })
      : null;
    const followupQuestionId = followupOffer?.questionId ?? refusalBaseId;
    const currentOffers: EscalationVerbChoice[] =
      followupOffer?.ownerChoices ?? [];
    const retryChoices = followupOffer?.choices ?? [
      ...plannerEscalationChoicesFor(ladder.store.task(t.id)),
      ...currentOffers.map((item) => item.label),
    ];
    if (!followupOffer)
      ladder.store.event(
        t.id,
        "planner_escalation_followup_offered",
        `${id}: ${JSON.stringify({ questionId: followupQuestionId, choices: retryChoices, ownerChoices: currentOffers })}`,
      );
    if (
      !events().some(
        (event) =>
          event.kind === "planner_escalation_refusal_sent" &&
          event.id > phaseAfter &&
          event.detail.startsWith(`${id}:`),
      )
    )
      ladder.store.event(
        t.id,
        "planner_escalation_refusal_sent",
        `${id}: ${refusal}`.slice(0, 4000),
      );
    try {
      const recipient = delegated!.agentId;
      const followup = await ladder.resolution.askBound(
        ladder.store.task(t.id),
        recipient,
        {
          prompt: nativeDelegationPrompt("planner", {
            question: `Your choice was refused: ${refusal}. Choose again for the same escalation.`,
            choices: retryChoices,
            context: ladder.resolution.decisionContext(ladder.store.task(t.id)),
          }),
          signal: new AbortController().signal,
          timeoutMs: DELEGATED_ANSWER_TIMEOUT_MS,
          messageId: followupQuestionId,
          choices: retryChoices,
          sourceAgentId,
        },
        "planner",
      );
      if (plannerEscalations(events()).find((item) => item.id === id)?.answered)
        return;
      const next = parseEscalationReply(followup, retryChoices);
      if (next?.kind === "operator")
        ladder.resolution.classifyEscalationToOperator(
          ladder.store.task(t.id),
          id,
          next.reason,
          who,
          {
            authority: "bare_classification",
            sourceQuestionId: followupQuestionId,
          },
        );
      else if (next) {
        const nextAnswer =
          next.kind === "choice"
            ? `${next.choice} — ${next.reason}`
            : next.answer;
        refusal =
          await ladder.resolution.escalationSettlement.settlePlannerEscalation(
            ladder.store.task(t.id),
            id,
            nextAnswer,
            who,
            currentOffers,
            followupQuestionId,
            delegated!,
          );
      }
    } catch (error) {
      ladder.store.event(
        t.id,
        "planner_escalation_unknown",
        `${id}: refusal follow-up delivery: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          4000,
        ),
      );
    }
  }
  await archiveDecider();
}
