//! Split from the local_codex_chat persistence god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;

use serde::{Deserialize, Serialize};

use super::super::{
    subagent_directory::StoredChatSubagentDirectory, subagent_selection::StoredChatActorSelection,
    LocalCodexChatHarnessMode, TaskAuthoringReceipt, TaskWorkflowReceipt,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatSession {
    pub conversation_id: String,
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub session_id: String,
    pub provider_thread_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub harness_mode: LocalCodexChatHarnessMode,
    #[serde(default)]
    pub adapter_id: String,
    #[serde(default)]
    pub provider_instance_id: String,
    #[serde(default)]
    pub provider_instance_revision: String,
    #[serde(default)]
    pub protocol_facade_id: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    pub turn_count: u64,
    #[serde(default)]
    pub task_toolset_version: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatTurn {
    pub conversation_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub ordinal: u64,
    pub status: String,
    #[serde(default)]
    pub provider_turn_id: Option<String>,
    #[serde(default)]
    pub failure_reason: Option<String>,
    #[serde(default)]
    pub selected_goal_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatTurnFailureStatus {
    Cancelled,
    TimedOut,
    Failed,
}

impl ChatTurnFailureStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatMessage {
    pub message_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub role: ChatMessageRole,
    pub text: String,
    pub sequence: u64,
    #[serde(default)]
    pub task_receipts: Vec<TaskAuthoringReceipt>,
    #[serde(default)]
    pub workflow_receipts: Vec<TaskWorkflowReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatActivity {
    pub conversation_id: String,
    pub turn_id: String,
    pub turn_ordinal: u64,
    pub runtime_operation_id: String,
    pub activity_id: String,
    pub sequence: u64,
    pub kind: String,
    pub kind_namespace: Option<String>,
    pub lifecycle: String,
    pub status: String,
    pub assistant_phase: Option<String>,
    pub disclosure: String,
    pub label: Option<String>,
    pub correlation_kind: Option<String>,
    pub correlation_id: Option<String>,
    pub content_change: Option<String>,
    pub content_stream: Option<String>,
    pub content: Option<String>,
    #[serde(default = "primary_actor_kind")]
    pub actor_kind: String,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub task_list: Option<Vec<StoredChatTaskListItem>>,
    #[serde(default)]
    pub subagents: Vec<StoredChatSubagent>,
}

fn primary_actor_kind() -> String {
    "primary".to_owned()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatTaskListItem {
    pub content: String,
    pub status: String,
    pub priority: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatSubagent {
    pub subagent_id: String,
    pub parent_kind: String,
    pub parent_id: Option<String>,
    pub status: String,
    pub label: Option<String>,
    pub description: Option<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub background: Option<bool>,
    pub originating_activity_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatQuestionExchange {
    pub conversation_id: String,
    pub turn_id: String,
    pub callback_id: String,
    pub runtime_operation_id: String,
    pub event_sequence: u64,
    pub provider_request_ref: Option<String>,
    pub deadline_ticks: Option<u64>,
    pub auto_resolution_ms: Option<u64>,
    pub status: String,
    pub questions: Vec<StoredChatQuestion>,
    #[serde(default)]
    pub answers: Vec<StoredChatQuestionAnswer>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatQuestion {
    pub question_id: String,
    pub header: String,
    pub prompt: String,
    pub kind: String,
    pub allow_other: bool,
    pub options: Vec<StoredChatQuestionOption>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatQuestionOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatQuestionAnswer {
    pub question_id: String,
    pub selected_option_ids: Vec<String>,
    pub text: Option<String>,
    pub skipped: bool,
    pub redacted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredChatPlanDecision {
    pub conversation_id: String,
    pub project_id: String,
    pub turn_id: String,
    pub turn_ordinal: u64,
    pub runtime_operation_id: String,
    pub activity_id: String,
    pub plan: String,
    pub status: String,
    #[serde(default)]
    pub decided_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub accept_turn_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatHistory {
    pub conversation_id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub provider_instance_id: Option<String>,
    pub provider_instance_revision: Option<String>,
    pub protocol_facade_id: Option<String>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub harness_mode: Option<LocalCodexChatHarnessMode>,
    pub turns: Vec<LocalCodexChatHistoryTurn>,
    pub messages: Vec<StoredChatMessage>,
    pub activities: Vec<StoredChatActivity>,
    pub questions: Vec<StoredChatQuestionExchange>,
    #[serde(default)]
    pub plan_decisions: Vec<StoredChatPlanDecision>,
    pub subagent_directories: Vec<StoredChatSubagentDirectory>,
    pub actor_selection: StoredChatActorSelection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatHistoryTurn {
    pub turn_id: String,
    pub ordinal: u64,
    pub status: String,
    #[serde(default)]
    pub failure_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatThreadSummary {
    pub conversation_id: String,
    pub project_id: String,
    pub session_id: String,
    pub thread_id: String,
    pub title: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub harness_mode: LocalCodexChatHarnessMode,
    pub turn_count: u64,
    pub status: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NativeProofEvidenceSummary {
    pub schema_version: u32,
    pub expected_terminal_classes: Vec<String>,
    pub total_turns: u64,
    pub active_turns: u64,
    pub completed_turns: u64,
    pub cancelled_turns: u64,
    pub timed_out_turns: u64,
    pub failed_turns: u64,
    pub unexpected_turns: u64,
}
