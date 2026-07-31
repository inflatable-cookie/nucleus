import { invoke } from "@tauri-apps/api/core";

export type AgentChatHarnessMode = "normal" | "plan";

export type AgentChatRequest = {
  conversation_id: string;
  project_id: string;
  resource_id: string | null;
  message: string;
  active_task_id: string | null;
  active_goal_id: string | null;
  model: string;
  reasoning_effort: string;
  harness_mode: AgentChatHarnessMode;
};

export type AgentChatQuestionOption = {
  value: string;
  label: string;
  description: string | null;
};

export type AgentChatQuestion = {
  question_id: string;
  header: string;
  prompt: string;
  kind: "single_choice" | "multiple_choice" | "text" | "secret_text";
  allow_other: boolean;
  options: AgentChatQuestionOption[];
};

export type AgentChatQuestionAnswer = {
  question_id: string;
  selected_option_ids: string[];
  text: string | null;
  skipped: boolean;
  redacted: boolean;
};

export type AgentChatQuestionExchange = {
  conversation_id: string;
  turn_id: string;
  callback_id: string;
  runtime_operation_id: string;
  event_sequence: number;
  provider_request_ref: string | null;
  deadline_ticks: number | null;
  auto_resolution_ms: number | null;
  status: "pending" | "answered" | "declined" | "abandoned" | "timed_out" | "cancelled" | "failed";
  questions: AgentChatQuestion[];
  answers: AgentChatQuestionAnswer[];
};

export type AgentChatQuestionAnswerRequest = {
  project_id: string;
  conversation_id: string;
  turn_id: string;
  callback_id: string;
  runtime_operation_id: string;
  event_sequence: number;
  provider_request_ref: string | null;
  answers: Array<{
    question_id: string;
    selected_option_ids: string[];
    text: string | null;
    skipped: boolean;
  }>;
};

export type AgentChatModelOption = {
  model: string;
  display_name: string;
  description: string;
  default_reasoning_effort: string;
  supported_reasoning_efforts: AgentChatReasoningOption[];
};

export type AgentChatReasoningOption = {
  reasoning_effort: string;
  description: string;
};

export type AgentChatReply = {
  session_id: string;
  thread_id: string;
  turn_id: string;
  timeline_turn_id: string;
  model: string;
  reasoning_effort: string | null;
  harness_mode: AgentChatHarnessMode;
  assistant_message: string;
  task_receipts: TaskAuthoringReceipt[];
  workflow_receipts: TaskWorkflowReceipt[];
};

export type TaskCreationReceipt = {
  task_id: string;
  title: string;
  activity: "proposed" | "ready";
};

export type TaskAuthoringReceipt = {
  created: TaskCreationReceipt[];
  updated: TaskCreationReceipt[];
  goals_created: GoalCreationReceipt[];
  goals_updated: GoalCreationReceipt[];
};

export type GoalCreationReceipt = {
  goal_id: string;
  title: string;
  status: "proposed" | "ready" | "active" | "blocked" | "achieved" | "abandoned";
  revision_id: string;
};

export type TaskWorkflowReceipt = {
  status: "review_ready" | "blocked" | "stopped" | "recovery_required";
  scope_kind: "task" | "goal";
  project_id: string;
  goal_id: string | null;
  task_id: string | null;
  title: string;
  current_task_id: string | null;
  current_position: number;
  total_tasks: number;
  summary: string;
  mandate_id: string;
  plan_id: string | null;
  work_item_refs: string[];
  runtime_receipt_refs: string[];
};

export type AgentChatHistoryMessage = {
  message_id: string;
  conversation_id: string;
  turn_id: string;
  role: "user" | "assistant";
  text: string;
  sequence: number;
  task_receipts: TaskAuthoringReceipt[];
  workflow_receipts: TaskWorkflowReceipt[];
};

export type AgentChatHistoryTurn = {
  turn_id: string;
  ordinal: number;
  status: "started" | "completed" | "cancelled" | "timed_out" | "failed";
};

export type AgentChatActivity = {
  conversation_id: string;
  turn_id: string;
  turn_ordinal: number;
  runtime_operation_id: string;
  activity_id: string;
  sequence: number;
  kind:
    | "assistant_message"
    | "reasoning_summary"
    | "plan"
    | "command_execution"
    | "file_change"
    | "provider_owned_tool"
    | "consumer_owned_tool"
    | "external_search"
    | "image_view"
    | "subagent_or_collaboration"
    | "review_transition"
    | "context_compaction"
    | "task"
    | "hook"
    | "warning_or_error"
    | "unknown";
  kind_namespace: string | null;
  lifecycle: "started" | "updated" | "completed";
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  assistant_phase: "provider_unspecified" | "intermediate" | "final" | null;
  disclosure:
    | "provider_display_content"
    | "adapter_normalized_summary"
    | "identity_and_lifecycle_only"
    | "unavailable";
  label: string | null;
  correlation_kind: "callback" | "direct_tool_call" | "provider_request" | null;
  correlation_id: string | null;
  content_change: "delta" | "replacement_snapshot" | null;
  content_stream:
    | "intermediate_assistant_text"
    | "final_answer_text"
    | "reasoning_summary_text"
    | "plan_text"
    | "command_output"
    | "file_change_output"
    | "provider_tool_display"
    | "normalized_summary"
    | null;
  content: string | null;
  actor_kind: "primary" | "subagent";
  actor_id: string | null;
  task_list: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority: "high" | "medium" | "low" | null;
  }> | null;
  subagents: Array<{
    subagent_id: string;
    parent_kind: "operation" | "subagent" | "unknown";
    parent_id: string | null;
    status:
      | "unknown"
      | "pending"
      | "running"
      | "waiting"
      | "completed"
      | "failed"
      | "interrupted"
      | "shutdown";
    label: string | null;
    description: string | null;
    model: string | null;
    reasoning: string | null;
    background: boolean | null;
    originating_activity_ref: string | null;
  }>;
};

export type AgentChatHistory = {
  conversation_id: string;
  project_id: string;
  session_id: string | null;
  thread_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  harness_mode: AgentChatHarnessMode | null;
  turns: AgentChatHistoryTurn[];
  messages: AgentChatHistoryMessage[];
  activities: AgentChatActivity[];
  questions: AgentChatQuestionExchange[];
};

export type AgentChatThreadSummary = {
  conversation_id: string;
  project_id: string;
  session_id: string;
  thread_id: string;
  title: string;
  model: string;
  reasoning_effort: string | null;
  harness_mode: AgentChatHarnessMode;
  turn_count: number;
  status: string;
};

export function sendAgentChatMessage(request: AgentChatRequest): Promise<AgentChatReply> {
  return invoke<AgentChatReply>("send_agent_chat_message", { request });
}

export function cancelAgentChatTurn(
  projectId: string,
  conversationId: string,
): Promise<boolean> {
  return invoke<boolean>("cancel_agent_chat_turn", {
    projectId,
    conversationId,
  });
}

export function answerAgentChatQuestion(
  request: AgentChatQuestionAnswerRequest,
): Promise<AgentChatQuestionExchange> {
  return invoke<AgentChatQuestionExchange>("answer_agent_chat_question", { request });
}

export function loadAgentChatHistory(
  projectId: string,
  conversationId: string,
): Promise<AgentChatHistory> {
  return invoke<AgentChatHistory>("load_agent_chat_history", {
    projectId,
    conversationId,
  });
}

export function listAgentChatThreads(): Promise<AgentChatThreadSummary[]> {
  return invoke<AgentChatThreadSummary[]>("list_agent_chat_threads");
}

export function renameAgentChatThread(
  projectId: string,
  conversationId: string,
  title: string,
): Promise<void> {
  return invoke<void>("rename_agent_chat_thread", {
    projectId,
    conversationId,
    title,
  });
}

export function listAgentChatModels(): Promise<AgentChatModelOption[]> {
  return invoke<AgentChatModelOption[]>("list_agent_chat_models");
}
