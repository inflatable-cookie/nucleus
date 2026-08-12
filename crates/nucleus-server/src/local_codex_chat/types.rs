//! Local Codex chat wire types: request, reply, harness mode, plan decision,
//! and provider model catalogue records.
//!
//! Split from the local_codex_chat god file; behavior unchanged.

use serde::{Deserialize, Serialize};

use nucleus_agent_protocol::AgentHarnessMode;

use super::persistence::StoredChatPlanDecision;
use super::task_authoring::TaskAuthoringReceipt;
use super::task_workflow::TaskWorkflowReceipt;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatRequest {
    pub conversation_id: String,
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub message: String,
    #[serde(default)]
    pub active_task_id: Option<String>,
    #[serde(default)]
    pub active_goal_id: Option<String>,
    #[serde(default)]
    pub provider_instance_id: Option<String>,
    #[serde(default)]
    pub provider_instance_revision: Option<String>,
    #[serde(default)]
    pub protocol_facade_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub harness_mode: LocalCodexChatHarnessMode,
    /// Whether the chat session may fold AGENTS.md idioms (defaults on).
    #[serde(default = "idioms_enabled_default")]
    pub idioms_enabled: bool,
}

fn idioms_enabled_default() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexChatHarnessMode {
    #[default]
    Normal,
    Plan,
}

impl LocalCodexChatHarnessMode {
    pub(super) fn agent_mode(self) -> AgentHarnessMode {
        match self {
            Self::Normal => AgentHarnessMode::Normal,
            Self::Plan => AgentHarnessMode::Plan,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexChatPlanDecisionKind {
    Accepted,
    Revised,
    Dismissed,
}

impl LocalCodexChatPlanDecisionKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Revised => "revised",
            Self::Dismissed => "dismissed",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatPlanDecisionRequest {
    pub project_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub runtime_operation_id: String,
    pub activity_id: String,
    pub decision: LocalCodexChatPlanDecisionKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatPlanDecisionReply {
    pub decision: StoredChatPlanDecision,
    pub follow_up: Option<LocalCodexChatReply>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatModelOption {
    pub provider_id: Option<String>,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<LocalCodexChatReasoningOption>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatReasoningOption {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatReply {
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub timeline_turn_id: String,
    pub provider_instance_id: String,
    pub provider_instance_revision: String,
    pub protocol_facade_id: String,
    pub provider_id: Option<String>,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub harness_mode: LocalCodexChatHarnessMode,
    /// Absent when a plan-terminal turn completed with no final assistant
    /// message; the pending plan record carries the outcome instead.
    pub assistant_message: Option<String>,
    pub task_receipts: Vec<TaskAuthoringReceipt>,
    pub workflow_receipts: Vec<TaskWorkflowReceipt>,
}
