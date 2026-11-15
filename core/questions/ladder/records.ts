/**
 * What the ladder's durable records say. The ladder writes each intent twice in
 * one transaction: a readable line, and a typed payload beside it. An episode's
 * cause is its line, always: the escalation id is derived from that cause, and a
 * caller's payload may carry only a category label (`recovery-pending`), so the
 * payload never renames an episode. The run, question and refusal class are the
 * payload's, with the line as the fallback for records written before it existed.
 *
 * The caller decides from the decoded record; nothing here reads a task, a host
 * or an event kind's wording beyond the record it is decoding.
 */

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

export interface PlannerEscalation {
  /** The escalation id, stable per cause occurrence. */
  id: string;
  cause: string;
  runId: string | null;
  /** The escalation question, from the durable payload. */
  question: string | null;
  /**
   * The refusal class this escalation answers, from the durable payload, when the
   * raiser recorded one. A reader matches this, never the refusal text.
   */
  refusal: 'failed_checks' | 'pre_merge' | null;
  answered: boolean;
  unknown: boolean;
  /** When the last unknown-delivery record was written; the stall threshold reads it. */
  unknownAt?: string | null;
  /** A send that landed but produced no usable answer; the escalation stays open. */
  missed: boolean;
  /** The Spec 032 decision that carries it to the operator, when one was classified. */
  decisionId: string | null;
}

const eventsOf = (events: readonly LadderEvent[], kind: string): LadderEvent[] =>
  events.filter((event) => event.kind === kind);

/** The typed payload recorded beside one intent, or null when it is absent or unreadable. */
const payloadOf = (
  events: readonly LadderEvent[],
  kind: string,
  id: string,
): Record<string, unknown> | null => {
  const event = eventsOf(events, kind).find((candidate) =>
    candidate.detail.startsWith(`${id}:`),
  );
  if (!event) return null;
  try {
    const decoded: unknown = JSON.parse(
      event.detail.slice(event.detail.indexOf(":") + 1),
    );
    return decoded && typeof decoded === "object"
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    // An unreadable payload proves nothing; the decoded fields stay unknown.
    return null;
  }
};

/**
 * The cause one intent names. The intent line is the identity record: the
 * escalation id is derived from this cause, and a caller's payload may carry a
 * category label instead (`recovery-pending` from the recovery pass, or
 * `recovery_rerun`), so the payload never renames an episode.
 */
const lineCause = (line: string): string =>
  line.match(/cause ([0-9a-f]{64})/)?.[1] ?? "";

/** The run an intent names on its line; the pre-payload fallback for the payload's run. */
const lineRun = (line: string): string | null =>
  line.match(/run (\S+?);/)?.[1] ?? null;

/**
 * The run one intent names: the typed payload's own field, with the intent line as
 * the pre-payload fallback. A run named `worker` is no run at all, which is how the
 * ladder records a cause raised by the task rather than a run.
 */
const intentRun = (
  payload: Record<string, unknown> | null,
  line: string,
): string | null => {
  const run =
    payload && "runId" in payload
      ? typeof payload.runId === "string"
        ? payload.runId
        : null
      : lineRun(line);
  return run && run !== "worker" ? run : null;
};

/** One string field of a decoded payload. */
const payloadText = (
  payload: Record<string, unknown> | null,
  key: string,
): string | null =>
  typeof payload?.[key] === "string" ? (payload[key] as string) : null;

/** The reviewer consults recorded on a task, in order. */
export function reviewerConsults(events: LadderEvent[]): ReviewerConsult[] {
  return eventsOf(events, "reviewer_consult").map((intent) => {
    const id = intent.detail.split(":", 1)[0]!;
    const payload = payloadOf(events, "reviewer_consult_payload", id);
    const answered = eventsOf(events, "reviewer_consult_answered").find(
      (event) => event.detail.startsWith(`${id}:`),
    );
    return {
      id,
      cause: lineCause(intent.detail),
      runId: intentRun(payload, intent.detail),
      reviewer:
        eventsOf(events, "reviewer_consult_reviewer")
          .find((event) => event.detail.startsWith(`${id}:`))
          ?.detail.slice(id.length + 2) ?? payloadText(payload, "reviewer"),
      question: payloadText(payload, "question"),
      answered: Boolean(answered),
      unknown:
        eventsOf(events, "reviewer_consult_unknown").some((event) =>
          event.detail.startsWith(`${id}:`),
        ) ||
        eventsOf(events, "reviewer_consult_missed").some((event) =>
          event.detail.startsWith(`${id}:`),
        ),
      advice: answered ? parseAnsweredText(answered.detail) : null,
    };
  });
}

/** The planner escalations recorded on a task, in order. */
export function plannerEscalations(events: LadderEvent[]): PlannerEscalation[] {
  return eventsOf(events, "planner_escalation").map((intent) => {
    const id = intent.detail.split(":", 1)[0]!;
    const payload = payloadOf(events, "planner_escalation_payload", id);
    const refusal = payloadText(payload, "refusal");
    const answered = eventsOf(events, "planner_escalation_answered").findLast(
      (event) => event.detail.startsWith(`${id}:`),
    );
    const resolved = eventsOf(events, "planner_escalation_resolved").some(
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
    const unknownEvents = eventsOf(events, "planner_escalation_unknown").filter(
      (event) => event.detail.startsWith(`${id}:`),
    );
    const decision = eventsOf(
      events,
      "planner_escalation_decision_linked",
    ).find((event) => event.detail.startsWith(`${id}:`));
    return {
      id,
      cause: lineCause(intent.detail),
      runId: intentRun(payload, intent.detail),
      question: payloadText(payload, "question"),
      refusal:
        refusal === "failed_checks" || refusal === "pre_merge"
          ? refusal
          : null,
      answered:
        resolved ||
        (Boolean(answered) &&
          (pendingAt === 0 ||
            appliedAt > pendingAt ||
            eventsOf(events, "planner_escalation_answered").some(
              (event) =>
                event.id > pendingAt &&
                event.detail.startsWith(`${id}: answered by ordinary `),
            ))),
      unknown: unknownEvents.length > 0,
      unknownAt: unknownEvents.at(-1)?.at ?? null,
      missed: eventsOf(events, "planner_escalation_missed").some((event) =>
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

/** The answer text of a settle event's detail, without its who marker. */
export function parseAnsweredText(detail: string): string {
  const body = detail.slice(detail.indexOf(":") + 1).trim();
  return body.replace(/^answered by .+?:\s*/, "").trim();
}
