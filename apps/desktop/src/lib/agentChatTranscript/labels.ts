import type { TranscriptItem } from "@inflatable-cookie/poodle-svelte";

import type { AgentChatActivity } from "../control/agentChat";
import type { AgentChatSubagentDirectory } from "../control/agentChat";
import type { AgentTranscriptTurn } from "./index";

export function childActorKey(runtimeOperationId: string, actorId: string): string {
  return JSON.stringify([runtimeOperationId, actorId]);
}

export function subagentGroupItem(
  turnId: string,
  childKey: string,
  child: AgentChatSubagentDirectory["subagents"][number],
  entries: Array<{
    firstSequence: number;
    latest: AgentChatActivity;
    content: string;
    taskList: AgentChatActivity["task_list"];
  }>,
): TranscriptItem {
  const latestEntry = [...entries].sort(
    (left, right) => left.latest.sequence - right.latest.sequence,
  )[entries.length - 1];
  const latestLine = latestEntry
    ? latestEntry.latest.label?.trim() || compactActivityDetail(latestEntry.content)
    : undefined;
  const detailLines = entries.map(
    ({ latest }) => latest.label?.trim() || defaultActivityLabel(latest.kind),
  );
  const terminal =
    child.status === "completed" ||
    child.status === "failed" ||
    child.status === "interrupted" ||
    child.status === "shutdown";

  return {
    kind: "subagent-group",
    id: `${turnId}:subagent:${childKey}`,
    subagent: {
      id: childKey,
      label: child.label ?? child.subagent_id,
      status: child.status,
      ...(terminal ? { summary: latestLine } : { activityLine: latestLine }),
    },
    detailLines,
  };
}

export function providerTaskListMarkdown(
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

export function activityActorPrefix(activity: AgentChatActivity): string {
  return activity.actor_kind === "subagent"
    ? `**Child work${activity.actor_id ? ` · ${activity.actor_id}` : ""}**\n\n`
    : "";
}

export function terminalActivityStatus(  activityStatus: AgentChatActivity["status"],
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
  if (turnStatus === "completed") {
    // A completed turn has nothing left to stream; providers leave snapshot
    // activities (task lists, plans) without a terminal status.
    return "completed";
  }
  return activityStatus;
}

export function terminalTurnItem(
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
        spinning: false,
      }
    : null;
}

export function defaultActivityLabel(kind: AgentChatActivity["kind"]): string {
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

export function compactActivityDetail(content: string): string | undefined {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
}

export function activityToolStatus(
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
