//! Live agent runtime boundary.
//!
//! The first executable adapter contract: hosts start sessions and send
//! turns through these traits without knowing which provider is behind
//! them. Tool-call semantics stay host-side via the callback; providers
//! own process, transport, and wire protocol.

use serde_json::Value;

/// Request to start (or resume) a provider-backed agent session.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentSessionStartRequest {
    pub working_directory: String,
    pub model: String,
    pub reasoning_effort: String,
    pub developer_instructions: String,
    pub dynamic_tools: Vec<Value>,
    pub resume_provider_thread_id: Option<String>,
}

/// Provider-assigned identity and effective settings of a started session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentStartedSessionInfo {
    pub provider_thread_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
}

/// One turn sent into a live session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTurnRequest {
    pub message: String,
    pub model: String,
    pub reasoning_effort: String,
}

/// Completed turn output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTurnReply {
    pub turn_id: String,
    pub assistant_message: String,
}

/// A provider-surfaced dynamic tool call awaiting a host response.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentToolCall {
    pub tool: String,
    pub turn_id: String,
    pub call_id: String,
    pub arguments: Value,
}

/// Host handler for dynamic tool calls: returns the text result shown to
/// the provider, or an error text. Side effects and receipts are the
/// host's business.
pub type AgentToolCallHandler<'a> = dyn FnMut(AgentToolCall) -> Result<String, String> + 'a;

/// One model option a provider offers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentModelOption {
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<AgentReasoningOption>,
}

/// One reasoning-effort option for a model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentReasoningOption {
    pub reasoning_effort: String,
    pub description: String,
}

/// A live provider-backed session.
pub trait AgentLiveSession {
    fn info(&self) -> &AgentStartedSessionInfo;

    fn send_turn(
        &mut self,
        request: AgentTurnRequest,
        on_tool_call: &mut AgentToolCallHandler<'_>,
    ) -> Result<AgentTurnReply, String>;
}

/// A provider runtime that can start sessions and list models.
pub trait AgentSessionRuntime {
    fn adapter_id(&self) -> &str;

    fn start_session(
        &self,
        request: AgentSessionStartRequest,
    ) -> Result<Box<dyn AgentLiveSession + Send>, String>;

    fn model_catalog(&self) -> Result<Vec<AgentModelOption>, String>;
}
