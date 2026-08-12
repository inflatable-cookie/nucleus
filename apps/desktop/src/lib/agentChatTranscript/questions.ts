import type { TranscriptItem } from "@inflatable-cookie/poodle-svelte";

import type {
  AgentChatPlanDecision,
  AgentChatQuestionExchange,
} from "../control/agentChat";

export function decidedPlanIdentities(decisions: AgentChatPlanDecision[]): Set<string> {
  return new Set(
    decisions.map(
      (decision) => `${decision.runtime_operation_id}\u0000${decision.activity_id}`,
    ),
  );
}

export function decidedPlanItems(
  turnId: string,
  decisions: AgentChatPlanDecision[],
): TranscriptItem[] {
  return decisions
    .filter(
      (decision): decision is AgentChatPlanDecision & { status: "accepted" | "revised" | "dismissed" } =>
        decision.status !== "pending",
    )
    .map((decision) => ({
      kind: "decided-plan",
      id: `${turnId}:${decision.runtime_operation_id}:${decision.activity_id}:decided`,
      plan: decision.plan,
      status: decision.status,
      decidedAt:
        decision.decided_at_unix_ms === null
          ? undefined
          : new Date(decision.decided_at_unix_ms).toLocaleString(),
    }));
}

export function settledQuestionItems(
  turnId: string,
  exchanges: AgentChatQuestionExchange[],
): TranscriptItem[] {
  return exchanges
    .filter(
      (exchange) =>
        exchange.turn_id === turnId &&
        exchange.status !== "pending" &&
        exchange.status !== "answered",
    )
    .sort((left, right) => left.event_sequence - right.event_sequence)
    .map((exchange) => ({
      kind: "activity",
      id: `${turnId}:${exchange.callback_id}:settled`,
      label:
        exchange.status === "timed_out"
          ? "Question timed out"
          : exchange.status === "cancelled"
            ? "Question cancelled"
            : exchange.status === "abandoned"
              ? "Question expired after restart"
              : "Question failed",
    }));
}

export function answeredQuestionItems(
  turnId: string,
  exchanges: AgentChatQuestionExchange[],
): TranscriptItem[] {
  return exchanges
    .filter((exchange) => exchange.turn_id === turnId && exchange.status === "answered")
    .sort((left, right) => left.event_sequence - right.event_sequence)
    .flatMap((exchange) =>
      exchange.questions.flatMap((question): TranscriptItem[] => {
        const answer = exchange.answers.find(
          (candidate) => candidate.question_id === question.question_id,
        );
        if (!answer) return [];
        return [
          {
            kind: "answered-question",
            id: `${turnId}:${exchange.callback_id}:${question.question_id}`,
            question: {
              id: question.question_id,
              header: question.header || undefined,
              prompt: question.prompt,
              options: question.options.map((option) => ({
                value: option.value,
                label: option.label,
                description: option.description ?? undefined,
              })),
              allowMultiple: question.kind === "multiple_choice",
            },
            answer: {
              questionId: question.question_id,
              outcome: answer.skipped
                ? "declined"
                : answer.text !== null || answer.redacted
                  ? "override"
                  : "selected",
              values: answer.selected_option_ids,
              text: answer.redacted ? "Answer hidden" : answer.text ?? "",
            },
          },
        ];
      }),
    );
}

/**
 * Display-only cleanup for streamed text: models sometimes emit a list
 * marker on its own line, a blank line, then the item text ("7.\n\n  List…"),
 * which parses as an empty item plus a detached paragraph. Joining the marker
 * back onto its text changes presentation only; the stored content is
 * untouched.
 */
export function joinOrphanListMarkers(markdown: string): string {
  return markdown.replace(
    /(^|\n)([ \t]*(?:\d+\.|[-*+]))[ \t]*\n+[ \t]*(?=\S)/g,
    "$1$2 ",
  );
}
