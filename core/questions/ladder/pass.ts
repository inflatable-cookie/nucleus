import type { Completion } from "../../../shared/contracts";
import { isProviderFailure } from "./causes";
import type { PlannerEscalation, ReviewerConsult } from "./records";
import { escalationWaitDetail } from "./waits";

/**
 * What one advance pass does with a ladder episode: classify a fresh blocked
 * receipt, keep an open consult or escalation wait, surface an unknown delivery
 * that outlived the stall threshold, or continue. The ladder's restart rules are
 * the same decision made about recorded episodes, so both live here.
 */

/** What a parked blocked or errored responsible task does on one advance pass. */
export type BlockerLadderStep =
  | { kind: "classify" }
  | { kind: "wait"; detail: string; holderAgentId?: string }
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
  completion:
    | Pick<Completion, "status" | "providerUnavailable">
    | null
    | undefined;
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
  if (facts.unknownStall)
    return { kind: "attention", escalation: facts.unknownStall };
  const openEscalations = facts.escalations.filter(
    (escalation) => !escalation.answered,
  );
  const openConsults = facts.consults.filter(
    (consult) => !consult.answered && !consult.unknown,
  );
  const latest = openEscalations.at(-1);
  if (latest?.routingWait && !latest.decisionId)
    return { kind: "wait", ...latest.routingWait };
  const wait = latest
    ? latest.decisionId
      ? escalationWaitDetail.operator(latest.id, latest.decisionId)
      : latest.unknown
        ? escalationWaitDetail.unknown(latest.id)
        : latest.returnExhausted || (latest.returned && latest.missed)
          ? escalationWaitDetail.returnedNoPlanner(latest.id)
          : latest.returned
            ? escalationWaitDetail.returned(latest.id)
            : escalationWaitDetail.planner(latest.id)
    : openConsults.length
      ? escalationWaitDetail.reviewer(openConsults.at(-1)!.id)
      : null;
  return wait ? { kind: "wait", detail: wait } : { kind: "continue" };
}

/** Whether a recorded reviewer consult should resume its answer window. */
export type ConsultRecovery = { kind: "skip" } | { kind: "run" };

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
export type EscalationRecovery = { kind: "skip" } | { kind: "run" };

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
  returnExhausted?: boolean;
}): EscalationRecovery {
  if (facts.missedNoAnswer || facts.returnExhausted) return { kind: "skip" };
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
