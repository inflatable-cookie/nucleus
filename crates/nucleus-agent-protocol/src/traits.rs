//! Planned adapter trait boundary types.
//!
//! These types describe the first split of adapter responsibilities. They do
//! not execute provider work yet.

use crate::capabilities::CapabilitySupport;
use crate::events::{RuntimeEventIdentity, RuntimeEventKind, RuntimeEventPayload};
use crate::identity::AdapterIdentity;
use crate::routes::ModelRoute;
use crate::sessions::{AgentSessionId, AgentTurnId, SessionLifecycleAction};

/// Read-only runtime metadata every adapter instance must expose.
pub trait AdapterRuntimeMetadata {
    fn identity(&self) -> &AdapterIdentity;
    fn capabilities(&self) -> &AdapterTraitCapabilities;
    fn model_routes(&self) -> &[ModelRoute];
    fn event_identity_policy(&self) -> &EventIdentityPolicy;
    fn terminal_fallback_policy(&self) -> &TerminalFallbackPolicy;
}

/// Lifecycle command boundary planned for provider adapters.
pub trait AdapterLifecycleBoundary {
    fn lifecycle_actions(&self) -> &[LifecycleActionSupport];
}

/// Event ingestion boundary planned for provider adapters.
pub trait AdapterEventBoundary {
    fn event_kinds(&self) -> &[RuntimeEventKind];
}

/// Capability grouping used by the first adapter trait split.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterTraitCapabilities {
    pub lifecycle: CapabilitySupport,
    pub event_stream: CapabilitySupport,
    pub approvals: CapabilitySupport,
    pub structured_user_input: CapabilitySupport,
    pub model_routes: CapabilitySupport,
    pub terminal_fallback: CapabilitySupport,
    pub raw_transcript: CapabilitySupport,
    pub extension_commands: CapabilitySupport,
}

/// Provider-specific support for one lifecycle action.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleActionSupport {
    pub action: SessionLifecycleAction,
    pub support: CapabilitySupport,
    pub provider_method: Option<String>,
}

/// Identity policy for events entering nucleus.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventIdentityPolicy {
    pub required_fields: Vec<EventIdentityField>,
    pub synthetic_ids: SyntheticIdPolicy,
    pub live_stream_namespace: IdentityNamespace,
    pub replay_namespace: IdentityNamespace,
}

/// Identity fields adapters must preserve or synthesize.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventIdentityField {
    NucleusEventId,
    ProviderDriverKind,
    ProviderInstanceId,
    ProviderSessionId,
    NucleusSessionId,
    ProviderMessageId,
    NucleusMessageId,
    TurnId,
    ItemId,
    RequestId,
    ProviderTurnId,
    ProviderItemId,
    ProviderRequestId,
    EventSequence,
    ParentEventId,
}

/// How an adapter may synthesize missing ids.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SyntheticIdPolicy {
    NotNeeded,
    MarkedSessionLocalSequence,
    MarkedStreamGenerationSequence,
    Unsupported,
}

/// Separate native identity namespace tracked by an adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentityNamespace {
    pub name: String,
    pub preserved_native_ids: Vec<String>,
    pub synthetic_when_missing: bool,
}

/// Terminal fallback policy for adapters that need a PTY or visual CLI view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalFallbackPolicy {
    pub rendering: CapabilitySupport,
    pub input_injection: CapabilitySupport,
    pub parallel_structured_stream: CapabilitySupport,
}

/// Planned lifecycle command envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterCommandRequest {
    pub session_id: Option<AgentSessionId>,
    pub action: SessionLifecycleAction,
    pub provider_command: Option<String>,
}

/// Planned lifecycle command acceptance envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterCommandAcknowledgement {
    pub accepted: bool,
    pub provider_request_id: Option<String>,
    pub turn_id: Option<AgentTurnId>,
    pub unsupported_reason: Option<String>,
}

/// Planned canonical event envelope emitted by adapters.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterRuntimeEvent {
    pub identity: RuntimeEventIdentity,
    pub kind: RuntimeEventKind,
    pub payload: RuntimeEventPayload,
}
