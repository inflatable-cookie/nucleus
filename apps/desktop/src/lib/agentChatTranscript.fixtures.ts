import type {
  AgentChatActivity,
  AgentChatPlanDecision,
  AgentChatSubagentDirectory,
} from "./control/agentChat";
import type { AgentTranscriptMessage } from "./agentChatTranscript";

export const user: AgentTranscriptMessage = {
  id: "message:turn:1:user",
  turnId: "turn:1",
  sequence: 0,
  role: "user",
  text: "Do the work",
};

export function activity(
  overrides: Partial<AgentChatActivity> = {},
): AgentChatActivity {
  return {
    conversation_id: "conversation:1",
    turn_id: "turn:1",
    turn_ordinal: 1,
    runtime_operation_id: "turn:runtime:1",
    activity_id: "activity:1",
    sequence: 1,
    kind: "command_execution",
    kind_namespace: null,
    lifecycle: "updated",
    status: "in_progress",
    assistant_phase: null,
    disclosure: "provider_display_content",
    label: null,
    correlation_kind: null,
    correlation_id: null,
    content_change: "delta",
    content_stream: "command_output",
    content: null,
    actor_kind: "primary",
    actor_id: null,
    task_list: null,
    subagents: [],
    ...overrides,
  };
}

export function subagentDirectory(
  overrides: Partial<AgentChatSubagentDirectory> = {},
): AgentChatSubagentDirectory {
  return {
    project_id: "project:1",
    conversation_id: "conversation:1",
    turn_id: "turn:1",
    turn_ordinal: 1,
    runtime_operation_id: "turn:runtime:1",
    first_sequence: 2,
    last_sequence: 4,
    subagents: [
      {
        subagent_id: "child-1",
        parent_kind: "operation",
        parent_id: null,
        status: "running",
        label: "Analyst",
        description: null,
        model: null,
        reasoning: null,
        background: null,
        originating_activity_ref: null,
      },
    ],
    ...overrides,
  };
}

export function planDecision(
  overrides: Partial<AgentChatPlanDecision> = {},
): AgentChatPlanDecision {
  return {
    conversation_id: "conversation:1",
    project_id: "project:1",
    turn_id: "turn:1",
    turn_ordinal: 1,
    runtime_operation_id: "turn:runtime:1",
    activity_id: "activity:1",
    plan: "# Plan\n\n1. Do the work",
    status: "accepted",
    decided_at_unix_ms: 1000,
    accept_turn_id: "turn:2",
    ...overrides,
  };
}
