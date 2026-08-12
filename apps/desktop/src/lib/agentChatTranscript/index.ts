import type { TranscriptItem } from "@inflatable-cookie/poodle-svelte";

import type {
  AgentChatActivity,
  AgentChatActorSelection,
  AgentChatPlanDecision,
  AgentChatQuestionExchange,
  AgentChatSubagentDirectory,
} from "../control/agentChat";
import {
  answeredQuestionItems,
  decidedPlanIdentities,
  decidedPlanItems,
  settledQuestionItems,
} from "./questions";
import { assembleTurnActivity } from "./turn";

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
  failureReason?: string | null;
};

export function latestFailedTurnNotice(turns: AgentTranscriptTurn[]): string | null {
  return (
    [...turns]
      .reverse()
      .find((turn) => turn.status === "failed" && turn.failureReason)
      ?.failureReason ?? null
  );
}

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
  planDecisions: AgentChatPlanDecision[] = [],
  subagentDirectories: AgentChatSubagentDirectory[] = [],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const sortedMessages = [...chatMessages].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const messagesByTurn = new Map<string, AgentTranscriptMessage[]>();
  const activitiesByTurn = new Map<string, AgentChatActivity[]>();
  const turnStatusById = new Map(turns.map((turn) => [turn.turnId, turn.status]));
  const decisionsByTurn = new Map<string, AgentChatPlanDecision[]>();
  for (const decision of planDecisions) {
    const held = decisionsByTurn.get(decision.turn_id) ?? [];
    held.push(decision);
    decisionsByTurn.set(decision.turn_id, held);
  }

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
          decidedPlanIdentities(decisionsByTurn.get(message.turnId) ?? []),
          subagentDirectories,
        ),
      );
      items.push(...answeredQuestionItems(message.turnId, questionExchanges));
      items.push(...settledQuestionItems(message.turnId, questionExchanges));
      items.push(...decidedPlanItems(message.turnId, decisionsByTurn.get(message.turnId) ?? []));
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
          decidedPlanIdentities(decisionsByTurn.get(turnId) ?? []),
          subagentDirectories,
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
