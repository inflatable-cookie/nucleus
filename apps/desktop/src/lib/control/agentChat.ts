import { invoke } from "@tauri-apps/api/core";

export type AgentChatHarnessMode = "normal" | "plan";

export type AgentChatRequest = {
  conversation_id: string;
  project_id: string;
  resource_id: string | null;
  message: string;
  active_task_id: string | null;
  active_goal_id: string | null;
  provider_instance_id: string | null;
  provider_instance_revision: string | null;
  protocol_facade_id: string | null;
  provider_id: string | null;
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
  provider_id: string | null;
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

export type AgentChatCredentialPosture = {
  profile_id: string;
  mechanism: string;
  credential_state: string;
  entitlement_metering: string;
  entitlement_state: string;
  endpoint_authorization: string;
  runtime_readiness: string;
  support_authority: string;
  evidence_provenance: string;
};

export type AgentChatProviderInstance = {
  provider_instance_id: string;
  instance_revision: string;
  runtime_adapter_id: string;
  driver_id: string;
  integration_family: string;
  transport_family: string;
  protocol_facade_id: string;
  display_name: string;
  harness_name: string;
  ownership: string;
  selection_readiness: "ready" | "not_ready";
  credential_posture: AgentChatCredentialPosture;
  credential: AgentChatCredentialSummary | null;
  model_catalogue_state: "available" | "unavailable";
  model_catalogue_diagnostic: string | null;
  models: AgentChatModelOption[];
};

export type AgentChatProviderCatalogue = {
  instances: AgentChatProviderInstance[];
};

export type AgentChatCredentialAction = "setup" | "repair" | "revoke";

export type AgentChatCredentialSummary = {
  access_profile_ref: string;
  credential_ref: string | null;
  mechanism:
    | "interactive_oauth"
    | "device_oauth"
    | "api_key"
    | "automation_token"
    | "workload_identity"
    | "cloud_provider_identity"
    | "gateway_helper"
    | "unauthenticated"
    | "local_unauthenticated"
    | "provider_specific";
  entitlement_metering:
    | "subscription_allowance"
    | "prepaid_credits"
    | "bundled_credits"
    | "pay_as_you_go"
    | "cloud_account_billing"
    | "local_compute"
    | "unknown"
    | "provider_specific";
  ownership: "nucleus_host" | "provider_managed" | "external_manager";
  status:
    | "unknown"
    | "ready"
    | "missing"
    | "expired"
    | "revoked"
    | "permission_denied"
    | "requires_user_action"
    | "unsupported";
  evidence_posture: "caller_asserted" | "host_observed" | "provider_observed" | "unknown";
  actions: Array<{
    action: AgentChatCredentialAction;
    availability: "available" | "unavailable";
    unavailable_reason:
      | "provider_managed_lifecycle"
      | "missing_credential_reference"
      | "unsupported"
      | null;
  }>;
};

export type AgentChatCredentialActionRequest = {
  request_id: string;
  provider_instance_id: string;
  credential_ref: string | null;
  action: AgentChatCredentialAction;
};

export type AgentChatCredentialActionReceipt = {
  request_id: string | null;
  provider_instance_id: string;
  credential_ref: string | null;
  action: AgentChatCredentialAction;
  outcome: "completed" | "unavailable" | "rejected";
  code:
    | "provider_managed_lifecycle"
    | "missing_credential_reference"
    | "provider_mismatch"
    | "credential_reference_mismatch"
    | "invalid_request";
  changed: boolean;
};

export type AgentChatReply = {
  session_id: string;
  thread_id: string;
  turn_id: string;
  timeline_turn_id: string;
  provider_instance_id: string;
  provider_instance_revision: string;
  protocol_facade_id: string;
  provider_id: string | null;
  model: string;
  reasoning_effort: string | null;
  harness_mode: AgentChatHarnessMode;
  /** Null when a plan-terminal turn completed with no final assistant message. */
  assistant_message: string | null;
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
  failure_reason: string | null;
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

export type AgentChatSubagent = AgentChatActivity["subagents"][number];

export type AgentChatSubagentDirectory = {
  project_id: string;
  conversation_id: string;
  turn_id: string;
  turn_ordinal: number;
  runtime_operation_id: string;
  first_sequence: number;
  last_sequence: number;
  subagents: AgentChatSubagent[];
};

export type AgentChatActorSelectionKind = "all" | "primary" | "subagent";

export type AgentChatActorSelection = {
  project_id: string;
  conversation_id: string;
  kind: AgentChatActorSelectionKind;
  runtime_operation_id: string | null;
  actor_id: string | null;
};

export type AgentChatActorSelectionRequest = AgentChatActorSelection;

export type AgentChatPlanDecisionStatus = "pending" | "accepted" | "revised" | "dismissed";

export type AgentChatPlanDecision = {
  conversation_id: string;
  project_id: string;
  turn_id: string;
  turn_ordinal: number;
  runtime_operation_id: string;
  activity_id: string;
  plan: string;
  status: AgentChatPlanDecisionStatus;
  decided_at_unix_ms: number | null;
  accept_turn_id: string | null;
};

export type AgentChatPlanDecisionRequest = {
  project_id: string;
  conversation_id: string;
  turn_id: string;
  runtime_operation_id: string;
  activity_id: string;
  decision: "accepted" | "revised" | "dismissed";
};

export type AgentChatPlanDecisionReply = {
  decision: AgentChatPlanDecision;
  follow_up: AgentChatReply | null;
};

export type AgentChatHistory = {
  conversation_id: string;
  project_id: string;
  session_id: string | null;
  thread_id: string | null;
  provider_instance_id: string | null;
  provider_instance_revision: string | null;
  protocol_facade_id: string | null;
  provider_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  harness_mode: AgentChatHarnessMode | null;
  turns: AgentChatHistoryTurn[];
  messages: AgentChatHistoryMessage[];
  activities: AgentChatActivity[];
  questions: AgentChatQuestionExchange[];
  plan_decisions: AgentChatPlanDecision[];
  subagent_directories: AgentChatSubagentDirectory[];
  actor_selection: AgentChatActorSelection;
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

export function decideAgentChatPlan(
  request: AgentChatPlanDecisionRequest,
): Promise<AgentChatPlanDecisionReply> {
  return invoke<AgentChatPlanDecisionReply>("decide_agent_chat_plan", { request });
}

export function selectAgentChatActor(
  request: AgentChatActorSelectionRequest,
): Promise<AgentChatActorSelection> {
  return invoke<AgentChatActorSelection>("select_agent_chat_actor", { request });
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

export function deleteAgentChatThread(
  projectId: string,
  conversationId: string,
): Promise<number> {
  return invoke<number>("delete_agent_chat_thread", {
    projectId,
    conversationId,
  });
}

export function loadAgentChatProviderCatalogue(): Promise<AgentChatProviderCatalogue> {
  return invoke<AgentChatProviderCatalogue>("agent_chat_provider_catalogue");
}

export function requestAgentChatCredentialAction(
  request: AgentChatCredentialActionRequest,
): Promise<AgentChatCredentialActionReceipt> {
  return invoke<AgentChatCredentialActionReceipt>("agent_chat_credential_action", { request });
}
