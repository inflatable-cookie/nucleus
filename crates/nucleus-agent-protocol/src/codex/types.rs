//! Codex app-server identity, fixture, and receipt types.

use crate::capabilities::CapabilitySupport;
use crate::events::{ApprovalScope, MessageRole, UserInputPromptKind};
use crate::sessions::{
    AgentSessionId, AgentSessionRecoveryState, AgentTurnId, SessionLifecycleAction,
};
use crate::traits::AdapterRuntimeEvent;

/// Provider-native Codex app-server refs retained beside Nucleus ids.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerProviderRefs {
    pub thread_id: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub request_id: Option<String>,
}

/// Source for one Codex id mapping.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexIdSource {
    Provider,
    Nucleus,
    SyntheticMarked,
    Unavailable,
}

/// Snapshot binding one Nucleus session to Codex app-server identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSessionBinding {
    pub nucleus_session_id: AgentSessionId,
    pub nucleus_turn_id: Option<AgentTurnId>,
    pub provider_refs: CodexAppServerProviderRefs,
    pub thread_id_source: CodexIdSource,
    pub turn_id_source: CodexIdSource,
    pub request_id_source: CodexIdSource,
    pub recovery_state: AgentSessionRecoveryState,
}

/// Mapping from a Nucleus lifecycle action to a Codex app-server method.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexLifecycleActionMapping {
    pub action: SessionLifecycleAction,
    pub provider_method: String,
    pub support: CapabilitySupport,
    pub requires_thread_id: bool,
    pub requires_turn_id: bool,
    pub notes: Option<String>,
}

/// Explicit recovery fallback when Codex resume cannot preserve a thread.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRecoveryFallback {
    pub nucleus_session_id: AgentSessionId,
    pub requested_thread_id: Option<String>,
    pub replacement_thread_id: Option<String>,
    pub reason: String,
    pub recovery_state: AgentSessionRecoveryState,
}

/// Static Codex-shaped event fixture used before live app-server streaming.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerEventFixture {
    pub method: String,
    pub provider_instance_id: String,
    pub nucleus_session_id: AgentSessionId,
    pub provider_refs: CodexAppServerProviderRefs,
    pub sequence: u64,
    pub payload: CodexAppServerFixturePayload,
    pub raw_payload: Option<String>,
}

/// Fixture payloads from the verified Codex app-server method subset.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerFixturePayload {
    ThreadStarted {
        title: Option<String>,
    },
    ThreadResumed,
    TurnStarted,
    TurnCompleted {
        status_detail: Option<String>,
    },
    ItemStarted {
        role: MessageRole,
        text: Option<String>,
    },
    AgentMessageDelta {
        delta: String,
        accumulated: Option<String>,
    },
    ToolCallStarted {
        tool_name: String,
        arguments: Option<String>,
    },
    ApprovalRequest {
        prompt: String,
        scope: ApprovalScope,
        options: Vec<String>,
    },
    UserInputRequest {
        prompt: String,
        kind: UserInputPromptKind,
        options: Vec<String>,
    },
    InterruptionReceipt {
        summary: String,
    },
    Warning {
        message: String,
    },
    Error {
        message: String,
    },
}

/// Result of projecting a static Codex fixture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerFixtureProjection {
    Event(AdapterRuntimeEvent),
    RuntimeReceipt(CodexRuntimeReceiptFixture),
}

/// Server-owned wait state created by a Codex app-server callback.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexServerOwnedWaitState {
    Approval,
    UserInput,
}

/// Receipt fixture for Codex runtime effects that do not become messages.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeReceiptFixture {
    pub receipt_id: String,
    pub provider_instance_id: String,
    pub nucleus_session_id: AgentSessionId,
    pub provider_refs: CodexAppServerProviderRefs,
    pub status: CodexRuntimeReceiptStatus,
    pub evidence_event_id: Option<String>,
    pub summary: String,
}

/// Provider-runtime receipt status vocabulary needed by Codex fixtures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRuntimeReceiptStatus {
    WaitingForApproval,
    WaitingForUserInput,
    Cancelled,
    Completed,
    Failed,
}

/// Explicit fixture mapping failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexFixtureMappingError {
    pub method: String,
    pub reason: String,
}
