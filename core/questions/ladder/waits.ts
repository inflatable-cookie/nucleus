import type { PlannerEscalation } from './records';

/**
 * The waits the ladder holds: the stop detail the board names for each seat, the
 * unknown-delivery stall rule, and the attention text that rule surfaces. These are
 * the words the ladder writes and reads back, so they live in one owner.
 */

/** The stop detail for an escalation's seat, so the board names who the task waits with. */
export const escalationWaitDetail = {
  reviewer: (id: string) =>
    `Waiting with the retained reviewer: consult ${id} is out for a second opinion; the same worker continues with the advice`,
  planner: (id: string) =>
    `Waiting with the planner: blocker escalation ${id} is open; the task gets no worker turn until the planner acts`,
  returned: (id: string) =>
    `Waiting with the planner: blocker escalation ${id} was returned to the planner for a recommendation; the task gets no worker turn until the planner acts`,
  returnedNoPlanner: (id: string) =>
    `Waiting with the planner: blocker escalation ${id} was returned to the planner and stays parked until a planner or owner authorizes the next step`,
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
