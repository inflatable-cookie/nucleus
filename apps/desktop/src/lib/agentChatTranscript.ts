import type { TranscriptItem } from "@poodle/svelte";

import type {
  AgentChatActivity,
  AgentChatActorSelection,
  AgentChatQuestionExchange,
} from "./control/agentChat";

export type AgentTranscriptMessage = {
  id: string;
  turnId: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
};

export type AgentTranscriptTurn = {
  turnId: string;
  status: "started" | "completed" | "cancelled" | "timed_out" | "failed";
};

export function filterAgentChatActivities(
  observations: AgentChatActivity[],
  selection: AgentChatActorSelection,
): AgentChatActivity[] {
  if (selection.kind === "all") {
    return observations;
  }
  if (selection.kind === "primary") {
    return observations.filter((activity) => activity.actor_kind === "primary");
  }
  return observations.filter(
    (activity) =>
      activity.actor_kind === "subagent" &&
      activity.runtime_operation_id === selection.runtime_operation_id &&
      activity.actor_id === selection.actor_id,
  );
}

export function assembleAgentTranscript(
  chatMessages: AgentTranscriptMessage[],
  observations: AgentChatActivity[],
  turns: AgentTranscriptTurn[],
  activityLabel: string | null,
  conversationId: string,
  questionExchanges: AgentChatQuestionExchange[] = [],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const sortedMessages = [...chatMessages].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const messagesByTurn = new Map<string, AgentTranscriptMessage[]>();
  const activitiesByTurn = new Map<string, AgentChatActivity[]>();
  const turnStatusById = new Map(turns.map((turn) => [turn.turnId, turn.status]));

  for (const message of sortedMessages) {
    const held = messagesByTurn.get(message.turnId) ?? [];
    held.push(message);
    messagesByTurn.set(message.turnId, held);
  }
  for (const activity of [...observations].sort(
    (left, right) =>
      left.turn_ordinal - right.turn_ordinal || left.sequence - right.sequence,
  )) {
    const held = activitiesByTurn.get(activity.turn_id) ?? [];
    held.push(activity);
    activitiesByTurn.set(activity.turn_id, held);
  }

  const emittedTurns = new Set<string>();
  for (const message of sortedMessages) {
    if (message.role === "user") {
      items.push({
        kind: "message",
        id: message.id,
        role: "user",
        markdown: message.text,
      });
      items.push(
        ...assembleTurnActivity(
          message.turnId,
          activitiesByTurn.get(message.turnId) ?? [],
          (messagesByTurn.get(message.turnId) ?? []).some(
            (candidate) => candidate.role === "assistant",
          ),
          turnStatusById.get(message.turnId),
        ),
      );
      items.push(...answeredQuestionItems(message.turnId, questionExchanges));
      items.push(...settledQuestionItems(message.turnId, questionExchanges));
      emittedTurns.add(message.turnId);
    } else {
      items.push({
        kind: "message",
        id: message.id,
        role: "assistant",
        markdown: message.text,
      });
    }
  }

  for (const [turnId, turnActivity] of activitiesByTurn) {
    if (!emittedTurns.has(turnId)) {
      items.push(
        ...assembleTurnActivity(
          turnId,
          turnActivity,
          false,
          turnStatusById.get(turnId),
        ),
      );
    }
  }
  if (activityLabel) {
    items.push({
      kind: "activity",
      id: `working:${conversationId}`,
      label: activityLabel,
    });
  }
  return items;
}

function settledQuestionItems(
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

function answeredQuestionItems(
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

function assembleTurnActivity(
  turnId: string,
  observations: AgentChatActivity[],
  hasCanonicalAssistantMessage: boolean,
  turnStatus: AgentTranscriptTurn["status"] | undefined,
): TranscriptItem[] {
  type HeldActivity = {
    firstSequence: number;
    latest: AgentChatActivity;
    content: string;
    taskList: AgentChatActivity["task_list"];
  };
  const heldById = new Map<string, HeldActivity>();

  for (const observation of observations) {
    const identity = `${observation.runtime_operation_id}\u0000${observation.activity_id}`;
    const held = heldById.get(identity);
    const nextContent =
      observation.content === null
        ? held?.content ?? ""
        : observation.content_change === "replacement_snapshot"
          ? observation.content
          : `${held?.content ?? ""}${observation.content}`;
    heldById.set(identity, {
      firstSequence: held?.firstSequence ?? observation.sequence,
      latest: observation,
      content: nextContent,
      taskList:
        observation.task_list === null
          ? held?.taskList ?? null
          : observation.task_list,
    });
  }

  const activityItems = [...heldById.values()]
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .flatMap(({ latest, content, taskList }): TranscriptItem[] => {
      const id = `${turnId}:${latest.runtime_operation_id}:${latest.activity_id}`;
      const status = terminalActivityStatus(latest.status, turnStatus);
      if (latest.kind === "assistant_message") {
        const isExplicitFinal =
          latest.assistant_phase === "final" ||
          latest.content_stream === "final_answer_text";
        if (!content || (hasCanonicalAssistantMessage && isExplicitFinal)) {
          return [];
        }
        return [
          {
            kind: "message",
            id,
            role: "assistant",
            markdown: content,
            isStreaming: status === "pending" || status === "in_progress",
          },
        ];
      }

      if (taskList !== null) {
        return [
          {
            kind: "message",
            id,
            role: "assistant",
            markdown: providerTaskListMarkdown(latest, taskList),
            isStreaming: status === "pending" || status === "in_progress",
          },
        ];
      }

      if (latest.kind === "plan" && content) {
        return [
          {
            kind: "message",
            id,
            role: "assistant",
            markdown: `${activityActorPrefix(latest)}${content}`,
            isStreaming: status === "pending" || status === "in_progress",
          },
        ];
      }

      return [
        {
          kind: "tool-call",
          id,
          label: latest.label ?? defaultActivityLabel(latest.kind),
          detail: compactActivityDetail(content),
          status: activityToolStatus(status),
          output: content || undefined,
        },
      ];
    });
  const terminalItem = terminalTurnItem(turnId, turnStatus);
  return terminalItem ? [...activityItems, terminalItem] : activityItems;
}

function providerTaskListMarkdown(
  activity: AgentChatActivity,
  items: NonNullable<AgentChatActivity["task_list"]>,
): string {
  const title = activity.label ?? (activity.kind === "plan" ? "Plan" : "Provider tasks");
  const lines = items.map((item) => {
    const status =
      item.status === "completed"
        ? "Completed"
        : item.status === "in_progress"
          ? "In progress"
          : "Pending";
    const priority = item.priority ? ` · ${item.priority} priority` : "";
    return `- **${status}**${priority} — ${item.content}`;
  });
  const body = lines.length > 0 ? lines.join("\n") : "_Checklist cleared._";
  return `${activityActorPrefix(activity)}**${title}**\n\n${body}`;
}

function activityActorPrefix(activity: AgentChatActivity): string {
  return activity.actor_kind === "subagent"
    ? `**Child work${activity.actor_id ? ` · ${activity.actor_id}` : ""}**\n\n`
    : "";
}

function terminalActivityStatus(
  activityStatus: AgentChatActivity["status"],
  turnStatus: AgentTranscriptTurn["status"] | undefined,
): AgentChatActivity["status"] {
  if (activityStatus !== "pending" && activityStatus !== "in_progress") {
    return activityStatus;
  }
  if (turnStatus === "cancelled") {
    return "cancelled";
  }
  if (turnStatus === "failed" || turnStatus === "timed_out") {
    return "failed";
  }
  return activityStatus;
}

function terminalTurnItem(
  turnId: string,
  turnStatus: AgentTranscriptTurn["status"] | undefined,
): TranscriptItem | null {
  const label =
    turnStatus === "cancelled"
      ? "Turn cancelled"
      : turnStatus === "timed_out"
        ? "Turn timed out"
        : turnStatus === "failed"
          ? "Turn failed"
          : null;
  return label
    ? {
        kind: "activity",
        id: `terminal:${turnId}`,
        label,
      }
    : null;
}

function defaultActivityLabel(kind: AgentChatActivity["kind"]): string {
  const labels: Record<AgentChatActivity["kind"], string> = {
    assistant_message: "Assistant message",
    reasoning_summary: "Reasoning summary",
    plan: "Plan",
    command_execution: "Command execution",
    file_change: "File change",
    provider_owned_tool: "Tool call",
    consumer_owned_tool: "Nucleus tool",
    external_search: "Search",
    image_view: "Image view",
    subagent_or_collaboration: "Agent collaboration",
    review_transition: "Review",
    context_compaction: "Context compaction",
    task: "Task",
    hook: "Hook",
    warning_or_error: "Problem",
    unknown: "Activity",
  };
  return labels[kind];
}

function compactActivityDetail(content: string): string | undefined {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
}

function activityToolStatus(
  status: AgentChatActivity["status"],
): "running" | "success" | "error" {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed" || status === "cancelled") {
    return "error";
  }
  return "running";
}
