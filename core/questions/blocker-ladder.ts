import { parseDelegateReply, taskContextLines } from "./question-delegation";
import { digest } from "../store/store";
import type { Completion, Task, TaskNextVerb } from "../../shared/contracts";

/**
 * Spec 058 slice 17 (task 584): the blocker ladder for a stuck responsible task.
 *
 * Tom, 2026-11-02: "Workers are supposed to handle blockers wherever possible,
 * should use the reviewer thread as a second opinion where needed, escalate to
 * the planner automatically when _really_ stuck and only bother me if all else
 * fails." The ladder is the only path for a stuck responsible task:
 *
 * 1. **Worker.** It owns the blocker (RESPONSIBLE_OWNERSHIP_RULE, Slices 14–15).
 * 2. **Reviewer second opinion.** Before a worker or revision run may end
 *    `blocked` on anything other than a provider failure, it asks the retained
 *    reviewer: mid-turn through `nucleus_ask` with target "reviewer"; when a
 *    run ends `blocked` without having asked, Queue sends the blocker to the
 *    retained reviewer as a short consult turn — no verdict, no review round —
 *    and the advice returns into the same worker thread, which continues.
 * 3. **Planner, automatically.** Still blocked after the consult, or an external
 *    cause, opens one planner escalation as a delegated decision. The task waits
 *    with the planner and gets no more worker turns until the planner acts
 *    through the ordinary verbs. A repeated blocker on the same cause attaches
 *    to the open escalation instead of starting another turn or ask.
 * 4. **Tom, last.** Only operator-only kinds, or a planner that explicitly says
 *    it cannot decide, reach the operator.
 *
 * This module owns the pure parts: cause identity, the consult and escalation
 * questions, the event readers that fence each send, the wait detail per seat
 * and the mapping from an answer to the ordinary verb that applies it. The
 * caller records every durable intent before any send; unknown delivery is
 * never retried.
 */

/** How long one reviewer consult may take before it falls through to the planner. */
export const REVIEWER_CONSULT_TIMEOUT_MS = 5 * 60_000;

/** The concrete options a blocker or revision-cap escalation offers the delegate. */
export const PLANNER_ESCALATION_CHOICES = [
  "Return to the worker with a new approach",
  "Stop and keep the work",
  "Wait for a task (put its reference in Reason)",
  "Wait until a time (put an ISO timestamp in Reason)",
  "Wait for an operator decision (put its ID in Reason)",
] as const;
type PlannerEscalationChoice =
  (typeof PLANNER_ESCALATION_CHOICES)[number];

/** A proof-only task has no worker, so escalation never offers a worker return. */
export function plannerEscalationChoicesFor(
  task: { entrypoint?: Task["entrypoint"] },
): readonly PlannerEscalationChoice[] {
  if (task.entrypoint === "proof")
    return PLANNER_ESCALATION_CHOICES.filter(
      (choice) => choice !== "Return to the worker with a new approach",
    );
  return PLANNER_ESCALATION_CHOICES;
}

/** A copy of a safe ordinary owner-verb offer, without force or source acceptance. */
export type EscalationVerbChoice = {
  label: string;
  verb: string;
  args: Record<string, unknown>;
};
export function escalationVerbChoices(
  views: readonly TaskNextVerb[],
): EscalationVerbChoice[] {
  return views.flatMap((view) => {
    if (
      !view.available ||
      !view.args ||
      !["retry_effect", "move", "restart", "route"].includes(view.verb)
    )
      return [];
    // The reason supplies the only required free text. Work has its own direction
    // choice. Discard, qualification and profile sign-off never come from a reply.
    if (
      (view.fill ?? []).some((field) => field !== "reason") ||
      (view.verb === "move" &&
        ["work", "closeout"].includes(String(view.args.to)))
    )
      return [];
    const {
      taskId: _taskId,
      version: _version,
      action: _action,
      summary,
      ...args
    } = view.args;
    const target =
      view.verb === "retry_effect"
        ? `Retry ${String(args.effect)}: ${String(summary ?? "observe and retry the recorded effect")}`
        : view.verb === "move"
          ? `Move to ${String(args.to)}`
          : view.verb === "restart"
            ? `Restart ${String(args.role ?? "the stopped step")}${args.fresh ? " with a fresh agent" : ""}`
            : `Route ${String(args.role)} to ${String(args.profileId)}`;
    const description = view.note?.replace(/\s+/g, " ").trim().slice(0, 300).trim();
    return [
      {
        label: description ? `${target}: ${description}` : target,
        verb: view.verb,
        args,
      },
    ];
  });
}

/** A provider failure is never a ladder blocker: the ordinary replacement settles it. */
export const isProviderFailure = (
  completion: Pick<Completion, "providerUnavailable">,
): boolean => completion.providerUnavailable === true;

/** One blocker cause, stable across re-reports of the same words. */
const normalizeCause = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 2000);

/** Stable identity of one blocker cause on one task: the same cause joins one escalation. */
export const blockerCauseId = (
  taskId: string,
  completion: Pick<
    Completion,
    "status" | "summary" | "sourceApproved" | "awaitingProofs"
  >,
): string =>
  digest(
    [
      "blocker-cause",
      taskId,
      completion.status,
      normalizeCause(completion.summary),
      completion.sourceApproved ? "source-approved" : "",
      (completion.awaitingProofs ?? []).length,
    ].join(":"),
  );

/** Stable identity of one revision-cap escalation: every cap park is its own episode. */
export const revisionCapCauseId = (
  taskId: string,
  revisionRuns: number,
): string =>
  digest(
    ["blocker-cause", taskId, "revision_cap", String(revisionRuns)].join(":"),
  );

/** Stable identity of one reviewer-checkpoint stop; the same cause joins one escalation. */
export const reviewContinuationCauseId = (
  taskId: string,
  state: "exhausted" | "closed",
): string =>
  digest(["blocker-cause", taskId, "review_continuation", state].join(":"));

/** One event row, shaped like the store's events. */
export type LadderEvent = {
  id: number;
  taskId: string;
  at: string;
  kind: string;
  detail: string;
};

export interface ReviewerConsult {
  /** The consult id, stable per cause occurrence. */
  id: string;
  /** The blocker cause this consult answers. */
  cause: string;
  /** The run whose blocked report raised it, when it had one. */
  runId: string | null;
  /** The retained reviewer the consult reached. */
  reviewer: string | null;
  /** The consult question, from the durable payload. */
  question: string | null;
  answered: boolean;
  unknown: boolean;
  /** The reviewer's advice, when it answered. */
  advice: string | null;
}

const eventDetail = (events: LadderEvent[], kind: string): LadderEvent[] =>
  events.filter((event) => event.kind === kind);

/** The reviewer consults recorded on a task, in order. */
export function reviewerConsults(events: LadderEvent[]): ReviewerConsult[] {
  const intents = eventDetail(events, "reviewer_consult");
  return intents.map((intent) => {
    const id = intent.detail.split(":", 1)[0]!;
    const cause = intent.detail.match(/cause ([0-9a-f]{64})/)?.[1] ?? null;
    const runId = intent.detail.match(/run (\S+?);/)?.[1] ?? null;
    const payload = eventDetail(events, "reviewer_consult_payload").find(
      (event) => event.detail.startsWith(`${id}:`),
    );
    let reviewer: string | null = null;
    let question: string | null = null;
    if (payload) {
      try {
        const parsed = JSON.parse(
          payload.detail.slice(payload.detail.indexOf(":") + 1),
        ) as { reviewer?: string | null; question?: string | null };
        reviewer = parsed.reviewer ?? null;
        question = parsed.question ?? null;
      } catch {
        /* payload stays unread */
      }
    }
    reviewer =
      eventDetail(events, "reviewer_consult_reviewer")
        .find((event) => event.detail.startsWith(`${id}:`))
        ?.detail.slice(id.length + 2) ?? reviewer;
    const answered = eventDetail(events, "reviewer_consult_answered").find(
      (event) => event.detail.startsWith(`${id}:`),
    );
    const unknown = eventDetail(events, "reviewer_consult_unknown").some(
      (event) => event.detail.startsWith(`${id}:`),
    );
    const miss = eventDetail(events, "reviewer_consult_missed").some((event) =>
      event.detail.startsWith(`${id}:`),
    );
    return {
      id,
      cause: cause ?? "",
      runId: runId && runId !== "worker" ? runId : null,
      reviewer,
      question,
      answered: Boolean(answered),
      unknown: unknown || miss,
      advice: answered ? parseAnsweredText(answered.detail) : null,
    };
  });
}

export interface PlannerEscalation {
  /** The escalation id, stable per cause occurrence. */
  id: string;
  cause: string;
  runId: string | null;
  /** The escalation question, from the durable payload. */
  question: string | null;
  answered: boolean;
  unknown: boolean;
  /** When the last unknown-delivery record was written; the stall threshold reads it. */
  unknownAt?: string | null;
  /** A send that landed but produced no usable answer; the escalation stays open. */
  missed: boolean;
  /** The Spec 032 decision that carries it to the operator, when one was classified. */
  decisionId: string | null;
}

/** The planner escalations recorded on a task, in order. */
export function plannerEscalations(events: LadderEvent[]): PlannerEscalation[] {
  return eventDetail(events, "planner_escalation").map((intent) => {
    const id = intent.detail.split(":", 1)[0]!;
    const cause = intent.detail.match(/cause ([0-9a-f]{64})/)?.[1] ?? "";
    const runId = intent.detail.match(/run (\S+?);/)?.[1] ?? null;
    const payload = eventDetail(events, "planner_escalation_payload").find(
      (event) => event.detail.startsWith(`${id}:`),
    );
    let question: string | null = null;
    if (payload) {
      try {
        question =
          (
            JSON.parse(
              payload.detail.slice(payload.detail.indexOf(":") + 1),
            ) as { question?: string | null }
          ).question ?? null;
      } catch {
        /* payload stays unread */
      }
    }
    const answered = eventDetail(
      events,
      "planner_escalation_answered",
    ).findLast((event) => event.detail.startsWith(`${id}:`));
    const resolved = eventDetail(events, "planner_escalation_resolved").some(
      (event) => event.detail.startsWith(`${id}:`),
    );
    const latest = (kinds: string[]) =>
      events
        .filter(
          (event) =>
            kinds.includes(event.kind) && event.detail.startsWith(`${id}:`),
        )
        .at(-1)?.id ?? 0;
    const pendingAt = latest([
      "planner_escalation_answer_pending",
      "planner_escalation_wake_intent",
    ]);
    const appliedAt = latest([
      "planner_escalation_applied",
      "planner_escalation_woke",
    ]);
    const unknown = eventDetail(events, "planner_escalation_unknown").some(
      (event) => event.detail.startsWith(`${id}:`),
    );
    const unknownAt = eventDetail(events, "planner_escalation_unknown")
      .filter((event) => event.detail.startsWith(`${id}:`))
      .at(-1)?.at ?? null;
    const decision = eventDetail(
      events,
      "planner_escalation_decision_linked",
    ).find((event) => event.detail.startsWith(`${id}:`));
    return {
      id,
      cause,
      runId: runId && runId !== "worker" ? runId : null,
      question,
      answered:
        resolved ||
        (Boolean(answered) &&
          (pendingAt === 0 ||
            appliedAt > pendingAt ||
            eventDetail(events, "planner_escalation_answered").some(
              (event) =>
                event.id > pendingAt &&
                event.detail.startsWith(`${id}: answered by ordinary `),
            ))),
      unknown,
      unknownAt,
      missed: eventDetail(events, "planner_escalation_missed").some((event) =>
        event.detail.startsWith(`${id}:`),
      ),
      decisionId:
        decision?.detail.match(/decision ([0-9a-f-]{36})/)?.[1] ?? null,
    };
  });
}

/** The open (unsettled) escalation for one cause, if any: a repeated blocker attaches to it. */
export function findOpenPlannerEscalation(
  events: LadderEvent[],
  cause: string,
): PlannerEscalation | null {
  return (
    plannerEscalations(events)
      .filter(
        (escalation) => escalation.cause === cause && !escalation.answered,
      )
      .at(-1) ?? null
  );
}

/** The old name, kept for `test/blocker-ladder.test.ts`. Server code reads `findOpenPlannerEscalation`. */

/** The answer text of a settle event's detail, without its who marker. */
export function parseAnsweredText(detail: string): string {
  const body = detail.slice(detail.indexOf(":") + 1).trim();
  return body.replace(/^answered by .+?:\s*/, "").trim();
}

/** The question a blocked report asks the retained reviewer: advice, not a verdict. */
export function reviewerConsultQuestion(
  task: Pick<Task, "title">,
  completion: Pick<Completion, "status" | "summary" | "head">,
): string {
  const summary = completion.summary.trim().replace(/\s+/g, " ").slice(0, 3000);
  return `Second opinion (consult, not a review round): the worker for "${task.title}" reported ${completion.status} and cannot proceed. Its report: ${summary} ${completion.head ? `Its head is ${completion.head}. ` : ""}As the retained reviewer, give your second opinion: what the worker should try within the approved outcome to get unstuck, or whether the cause is genuinely outside the task. Do not review the change and do not publish anything; Queue returns your advice to the same worker.`;
}

/** The prompt a mid-turn reviewer-target `nucleus_ask` delivers to the retained reviewer. */
export const reviewerAskPrompt = (question: string, title: string, context: readonly string[] = []): string =>
  `The worker for "${title}" asks you, as its retained reviewer, for a second opinion — a consult, not a review round. If you can name a safe action within the approved outcome, recommend it directly; the worker owns that decision and any bounded diagnostic. Answer with your advice; Nucleus returns it to the worker in turn. Only when this needs a planning ruling, use question.answer with the one-line answer text Decision: planner — <reason>. Do not start a review round or give merge approval.\n\nQuestion: ${[question, ...taskContextLines(context)].join("\n")}`;

/** The escalation question the delegate answers: the task, the blocker, the reviewer's view, the options. */
export function plannerEscalationQuestion(
  task: Pick<Task, "title"> & Partial<Pick<Task, "entrypoint" | "proofOnly">>,
  completion: Pick<Completion, "status" | "summary">,
  advice: string | null,
): string {
  const summary = completion.summary.trim().replace(/\s+/g, " ").slice(0, 3000);
  const reviewer = advice
    ? ` The retained reviewer was already consulted; its advice was: ${advice.trim().replace(/\s+/g, " ").slice(0, 2000)}`
    : " The retained reviewer was not consulted for this cause.";
  const proofOnly = task.entrypoint === "proof";
  const who = proofOnly ? "Its receipt review reported" : "Its worker reported";
  const follow = proofOnly
    ? "You may also answer directly with the direction Queue should follow, including a receipt review."
    : "You may also answer directly with the direction the worker should follow.";
  return `The responsible task "${task.title}" is stuck. ${who} ${completion.status}: ${summary}.${reviewer} Choose how it proceeds: ${plannerEscalationChoicesFor(task).join("; ")}. ${follow}`;
}

/** The revision-cap escalation question: the planner decides the next approach. */
export function revisionCapEscalationQuestion(
  task: Pick<Task, "title">,
  revisionRuns: number,
  findings: string,
): string {
  return `The responsible task "${task.title}" exhausted its revision budget after ${revisionRuns} review rounds without convergence. The latest review findings: ${findings.trim().replace(/\s+/g, " ").slice(0, 3000)} Choose how it proceeds: ${PLANNER_ESCALATION_CHOICES.join("; ")}. You may also answer directly with the direction the worker should follow.`;
}

/** The reviewer-checkpoint stop's escalation question: the planner decides the next approach. */
export function reviewContinuationEscalationQuestion(
  task: Pick<Task, "title">,
  state: "exhausted" | "closed",
): string {
  const stop =
    state === "exhausted"
      ? "spent its checkpoint budget and stopped"
      : "was observed closed with its checkpoint preserved, so the same-agent continuation is impossible";
  return `The responsible task "${task.title}"'s retained reviewer ${stop}. A deliberate fresh reviewer replacement at the same head (restart role=reviewer fresh) is the ordinary exit. Choose how it proceeds: ${PLANNER_ESCALATION_CHOICES.join("; ")}. You may also answer directly with the direction Queue should follow.`;
}

export type EscalationReply =
  | { kind: "choice"; choice: string; reason: string }
  | { kind: "answer"; answer: string; reason: string }
  | { kind: "operator"; reason: string };

/** Reads a delegate's reply in any of its three shapes; the last lines win. */
export function parseEscalationReply(
  text: string | null | undefined,
  choices: readonly string[],
): EscalationReply | null {
  return parseDelegateReply(text, 'escalation', choices);
}

type EscalationControl =
  /** `move to=work` with the answer as the worker's direction. */
  | { action: "work"; instruction: string }
  /** The owner `stop` verb: live work halts, the branch and PR stay. */
  | { action: "stop" }
  /** Reject a legacy bare wait; a named wake is required. */
  | { action: "wait" };

/** Maps an answer onto the ordinary verb that applies it; a free-form answer is a direction. */
export function escalationAnswerControl(answer: string): EscalationControl {
  const text = answer.trim();
  const matched = PLANNER_ESCALATION_CHOICES.find(
    (choice) => text === choice || text.startsWith(choice),
  );
  if (matched === "Stop and keep the work") return { action: "stop" };
  if (/^(?:leave it waiting|wait|keep waiting)(?:\b|$)/i.test(text))
    return { action: "wait" };
  if (matched === "Return to the worker with a new approach") {
    const direction = text
      .slice(matched.length)
      .replace(/^[\s:—-]+/, "")
      .trim();
    return { action: "work", instruction: direction || text };
  }
  return { action: "work", instruction: text };
}

/** The first ISO-8601 timestamp with a timezone in the reason; the rest is a note. */
export function extractFirstIsoTimestamp(text: string): string | null {
  const match = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/);
  return match ? match[0] : null;
}

/** Ordered task-reference candidates in the reason; the first that resolves is the target. */
export function extractTaskReferenceCandidates(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z0-9_.-]+#\d+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|#\d+|\b\d+\b)/g);
  return matches ?? [];
}

/** Ordered decision-ID candidates in the reason; the first that resolves is the target. */
export function extractDecisionIdCandidates(text: string): string[] {
  const uuids = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi);
  if (uuids?.length) return uuids;
  const first = text.trim().split(/\s+/)[0]?.replace(/^[“"'(\[]+|[”"')\].,;]+$/g, '');
  return first ? [first] : [];
}

/** The stop detail for an escalation's seat, so the board names who the task waits with. */
export const escalationWaitDetail = {
  reviewer: (id: string) =>
    `Waiting with the retained reviewer: consult ${id} is out for a second opinion; the same worker continues with the advice`,
  planner: (id: string) =>
    `Waiting with the planner: blocker escalation ${id} is open; the task gets no worker turn until the planner acts`,
  operator: (id: string, decisionId: string) =>
    `Waiting with the operator: escalation ${id} was classified as the operator's (decision ${decisionId})`,
  unknown: (id: string) =>
    `Waiting with the planner: escalation ${id} has an unknown delivery; Nucleus never re-asks it, and the ordinary verbs still dispose of the task`,
  attached: (id: string) =>
    `Waiting with the planner: a repeated blocker on the same cause joined escalation ${id}; Nucleus asks nobody again until it is settled`,
  /** A proof-only qualification parked on its release GO: the operator's decision, never a planner's. */
  proofGo: (commit: string, questionId: string) =>
    `Waiting with the operator: the release GO for the proof-only qualification at ${commit} is open (question ${questionId}); no run starts until the operator answers`,
} as const;

/**
 * Papercut 2ef86450 (2026-11-10): an escalation whose delivery is unknown waited
 * unreported (effigy#862 sat 98+ minutes with owner "queue") until a planner
 * noticed by hand. Nucleus must never resend an unknown send, but after the stall
 * threshold somebody has to hear it: the task surfaces as visible attention and
 * the project planner receives one agent-channel message.
 *
 * The open escalation this reads is still open, unknown-delivered and not yet the
 * operator's; its own recorded unknown timestamp is what has to outlive the
 * threshold. A miss (a send that landed without a usable answer) is a different
 * fact and keeps its ordinary wait.
 */
export function stalledUnknownEscalation(facts: {
  escalations: readonly PlannerEscalation[];
  now: number;
  thresholdMs: number;
}): PlannerEscalation | null {
  const open = facts.escalations
    .filter((escalation) => !escalation.answered && escalation.unknown && !escalation.decisionId)
    .at(-1);
  if (!open?.unknownAt) return null;
  const since = Date.parse(open.unknownAt);
  if (!Number.isFinite(since)) return null;
  return facts.now - since >= Math.max(0, facts.thresholdMs) ? open : null;
}

/** The attention detail: the owner, the question and every exit, with no resend. */
export function unknownEscalationAttentionDetail(
  escalation: Pick<PlannerEscalation, "id" | "question">,
  owner: string,
): string {
  const question = (escalation.question ?? "the escalation question was not recorded")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  return `Blocker escalation ${escalation.id} never reported a delivery, so nobody knows whether it reached anyone; Nucleus never resends it. Owner: ${owner}. The question: ${question} Exits: answer it with question.answer, dispose of the task with an ordinary owner verb (next lists the available ones), or ask again with a fresh question ID once ${owner} or the operator confirms the first question was not seen.`;
}

/** What a parked blocked or errored responsible task does on one advance pass. */
type BlockerLadderStep =
  | { kind: "classify" }
  | { kind: "wait"; detail: string }
  /** An unknown-delivery escalation outlived the stall threshold: surface it, never resend it. */
  | { kind: "attention"; escalation: PlannerEscalation }
  | { kind: "continue" };

/**
 * Classify a fresh blocked receipt, re-assert an open consult or escalation wait,
 * or let the pass continue. Classify takes precedence; after the caller records
 * it and the climb returns, call again on fresh events with `classified: true`.
 */
export function blockerLadderStep(facts: {
  classified: boolean;
  completion: Pick<Completion, "status" | "providerUnavailable"> | null | undefined;
  escalations: readonly PlannerEscalation[];
  consults: readonly ReviewerConsult[];
  /** An open escalation whose unknown delivery outlived the stall threshold, if any. */
  unknownStall?: PlannerEscalation | null;
}): BlockerLadderStep {
  if (
    facts.completion &&
    ["blocked", "error"].includes(facts.completion.status) &&
    !isProviderFailure(facts.completion) &&
    !facts.classified
  )
    return { kind: "classify" };
  if (facts.unknownStall) return { kind: "attention", escalation: facts.unknownStall };
  const openEscalations = facts.escalations.filter(
    (escalation) => !escalation.answered,
  );
  const openConsults = facts.consults.filter(
    (consult) => !consult.answered && !consult.unknown,
  );
  const latest = openEscalations.at(-1);
  const wait = latest
    ? latest.decisionId
      ? escalationWaitDetail.operator(latest.id, latest.decisionId)
      : latest.unknown
        ? escalationWaitDetail.unknown(latest.id)
        : escalationWaitDetail.planner(latest.id)
    : openConsults.length
      ? escalationWaitDetail.reviewer(openConsults.at(-1)!.id)
      : null;
  return wait ? { kind: "wait", detail: wait } : { kind: "continue" };
}

/** Whether a recorded reviewer consult should resume its answer window. */
type ConsultRecovery = { kind: "skip" } | { kind: "run" };

export function consultRecovery(facts: {
  answered: boolean;
  unknown: boolean;
  recoverable: boolean;
  question: string | null;
  hasAdapter: boolean;
  inFlight: boolean;
}): ConsultRecovery {
  if (
    facts.answered ||
    (facts.unknown && !facts.recoverable) ||
    !facts.question ||
    !facts.hasAdapter ||
    facts.inFlight
  )
    return { kind: "skip" };
  return { kind: "run" };
}

/** Whether a recorded planner escalation should resume its answer window. */
type EscalationRecovery = { kind: "skip" } | { kind: "run" };

export function escalationRecovery(facts: {
  missedNoAnswer: boolean;
  answered: boolean;
  unknown: boolean;
  observing: boolean;
  missed: boolean;
  recoverable: boolean;
  decisionId: string | null;
  question: string | null;
  inFlight: boolean;
}): EscalationRecovery {
  if (facts.missedNoAnswer) return { kind: "skip" };
  if (
    facts.answered ||
    (facts.unknown && !facts.observing) ||
    (facts.missed && !facts.recoverable) ||
    facts.decisionId ||
    !facts.question ||
    facts.inFlight
  )
    return { kind: "skip" };
  return { kind: "run" };
}

/** The instruction a consult advice becomes for the same retained worker. */
export const consultContinuationInstruction = (
  id: string,
  advice: string,
): string =>
  `Your blocked report went to the retained reviewer as a second opinion (consult ${id}). The reviewer's advice: ${advice.trim().slice(0, 6000)} Continue the task with this advice under the ownership rule; report blocked again only for an external cause, naming it.`;

/** The instruction a delegated escalation answer becomes for the same retained worker. */
export const escalationContinuationInstruction = (
  id: string,
  who: string,
  answer: string,
): string =>
  `The planner ladder answered your blocker escalation ${id} (${who}). Direction: ${answer.trim().slice(0, 6000)} Continue the task under the ownership rule with this direction; report blocked again only for an external cause, naming it.`;
