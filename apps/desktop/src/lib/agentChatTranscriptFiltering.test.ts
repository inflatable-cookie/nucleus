import { describe, expect, test } from "bun:test";

import { filterAgentChatActivities } from "./agentChatTranscript";
import type { AgentChatActivity } from "./control/agentChat";

function activity(
  sequence: number,
  actorKind: AgentChatActivity["actor_kind"],
  operationId: string,
): AgentChatActivity {
  return {
    conversation_id: "conversation:1",
    turn_id: "turn:1",
    turn_ordinal: 1,
    runtime_operation_id: operationId,
    activity_id: `activity:${sequence}`,
    sequence,
    kind: "subagent_or_collaboration",
    kind_namespace: null,
    lifecycle: "updated",
    status: "in_progress",
    assistant_phase: null,
    disclosure: "adapter_normalized_summary",
    actor_kind: actorKind,
    actor_id: actorKind === "subagent" ? "child" : null,
    correlation_kind: null,
    correlation_id: null,
    label: null,
    content_stream: null,
    content_change: null,
    content: null,
    task_list: null,
    subagents: [],
  };
}

describe("agent chat actor filtering", () => {
  test("keeps main and operation-local child activity distinct", () => {
    const observations = [
      activity(1, "primary", "turn:runtime:1"),
      activity(2, "subagent", "turn:runtime:1"),
      activity(3, "subagent", "turn:runtime:2"),
    ];

    expect(
      filterAgentChatActivities(observations, {
        project_id: "project:1",
        conversation_id: "conversation:1",
        kind: "primary",
        runtime_operation_id: null,
        actor_id: null,
      }),
    ).toEqual([observations[0]]);
    expect(
      filterAgentChatActivities(observations, {
        project_id: "project:1",
        conversation_id: "conversation:1",
        kind: "subagent",
        runtime_operation_id: "turn:runtime:2",
        actor_id: "child",
      }),
    ).toEqual([observations[2]]);
  });
});
