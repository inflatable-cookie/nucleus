import { invoke } from "@tauri-apps/api/core";

export type AgentChatRequest = {
  conversation_id: string;
  project_id: string;
  message: string;
  active_task_id: string | null;
  active_goal_id: string | null;
  model: string;
  reasoning_effort: string;
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
  model: string;
  reasoning_effort: string | null;
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

export type AgentChatHistory = {
  conversation_id: string;
  project_id: string;
  session_id: string | null;
  thread_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  messages: AgentChatHistoryMessage[];
};

export function sendAgentChatMessage(request: AgentChatRequest): Promise<AgentChatReply> {
  return invoke<AgentChatReply>("send_agent_chat_message", { request });
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

export function listAgentChatModels(): Promise<AgentChatModelOption[]> {
  return invoke<AgentChatModelOption[]>("list_agent_chat_models");
}
