//! Runtime event identity, category, and payload types.

use crate::identity::ProviderDriverKind;

mod payloads;

pub use payloads::{
    ApprovalPayload, ApprovalScope, CommandExecutionPayload, CommandStatus, ContentDeltaPayload,
    DeltaFormat, FileChangeKind, FileChangePayload, MessageItemPayload, MessageRole,
    ProviderExtensionPayload, RawProviderPayload, ReasoningPayload, RuntimeDiagnosticPayload,
    RuntimeEventPayload, RuntimeEventSource, SessionPayload, SessionPayloadKind, Severity,
    TokenUsagePayload, ToolCallPayload, ToolCallStatus, TurnPayload, TurnPayloadKind,
    UserInputPayload, UserInputPromptKind,
};

/// Stable event identity after provider events enter nucleus.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEventIdentity {
    pub nucleus_event_id: String,
    pub provider_driver_kind: ProviderDriverKind,
    pub provider_instance_id: String,
    pub provider_session_id: Option<String>,
    pub nucleus_session_id: String,
    pub provider_message_id: Option<String>,
    pub nucleus_message_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub request_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub provider_item_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub event_sequence: u64,
    pub parent_event_id: Option<String>,
    pub synthetic: bool,
}

/// Canonical event families emitted by adapters.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEventKind {
    Session,
    Thread,
    Turn,
    MessageItem,
    Reasoning,
    ContentDelta,
    ToolCall,
    CommandExecution,
    FileChange,
    PermissionRequest,
    UserInputRequest,
    TokenUsage,
    RuntimeWarning,
    RuntimeError,
    ProviderExtension(String),
}
