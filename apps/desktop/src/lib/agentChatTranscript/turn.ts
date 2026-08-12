import type { TranscriptItem } from "@inflatable-cookie/poodle-svelte";

import type {
  AgentChatActivity,
  AgentChatSubagentDirectory,
} from "../control/agentChat";
import type { AgentTranscriptTurn } from "./index";
import {
  childActorKey,
  defaultActivityLabel,
  activityActorPrefix,
  providerTaskListMarkdown,
  terminalActivityStatus,
  terminalTurnItem,
  subagentGroupItem,
  compactActivityDetail,
  activityToolStatus,
} from "./labels";
import { decidedPlanIdentities, joinOrphanListMarkers } from "./questions";

export function assembleTurnActivity(
  turnId: string,
  observations: AgentChatActivity[],
  hasCanonicalAssistantMessage: boolean,
  turnStatus: AgentTranscriptTurn["status"] | undefined,
  decidedPlans: Set<string>,
  subagentDirectories: AgentChatSubagentDirectory[],
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

  const knownChildren = new Map<
    string,
    AgentChatSubagentDirectory["subagents"][number]
  >();
  for (const directory of subagentDirectories) {
    if (directory.turn_id !== turnId) continue;
    for (const subagent of directory.subagents) {
      knownChildren.set(
        childActorKey(directory.runtime_operation_id, subagent.subagent_id),
        subagent,
      );
    }
  }

  const emittedChildGroups = new Set<string>();
  const activityItems = [...heldById.entries()]
    .sort((left, right) => left[1].firstSequence - right[1].firstSequence)
    .flatMap(([identity, { latest, content, taskList }]): TranscriptItem[] => {
      const childKey =
        latest.actor_kind === "subagent" && latest.actor_id
          ? childActorKey(latest.runtime_operation_id, latest.actor_id)
          : null;
      const child = childKey ? knownChildren.get(childKey) : undefined;
      if (childKey && child) {
        if (emittedChildGroups.has(childKey)) return [];
        emittedChildGroups.add(childKey);
        const childEntries = [...heldById.values()]
          .filter(
            (entry) =>
              entry.latest.actor_kind === "subagent" &&
              entry.latest.actor_id &&
              childActorKey(entry.latest.runtime_operation_id, entry.latest.actor_id) === childKey,
          )
          .sort((left, right) => left.firstSequence - right.firstSequence);
        return [subagentGroupItem(turnId, childKey, child, childEntries)];
      }

      const id = `${turnId}:${latest.runtime_operation_id}:${latest.activity_id}`;
      const status = terminalActivityStatus(latest.status, turnStatus);
      if (
        !content
        && status !== "failed"
        && status !== "cancelled"
        && (latest.kind === "unknown" || latest.kind === "reasoning_summary")
      ) {
        // Empty rows carry no information: unknown kinds are provider identity
        // echoes (e.g. user message items), and Codex sends this client empty
        // reasoning summaries. Failed or cancelled rows stay — their status is
        // the information. A reasoning row that ever gains content shows.
        return [];
      }
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
            markdown: joinOrphanListMarkers(content),
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
        if (decidedPlans.has(identity)) {
          // A decided plan leaves one transcript record, not a flattened
          // markdown message; the live plan stays in the composer.
          return [];
        }
        return [
          {
            kind: "message",
            id,
            role: "assistant",
            markdown: `${activityActorPrefix(latest)}${joinOrphanListMarkers(content)}`,
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
