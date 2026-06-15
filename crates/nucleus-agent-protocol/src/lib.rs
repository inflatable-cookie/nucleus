//! Stable protocol types for harness adapters and model routing.
//!
//! This crate names the durable boundary between nucleus and external coding
//! harnesses. It intentionally does not implement provider behavior yet.

pub mod capabilities;
pub mod events;
pub mod identity;
pub mod routes;
pub mod runtime;
pub mod sessions;
pub mod traits;

pub use capabilities::{AdapterCapabilities, CapabilitySupport};
pub use events::{
    ApprovalPayload, ApprovalScope, CommandExecutionPayload, CommandStatus, ContentDeltaPayload,
    DeltaFormat, FileChangeKind, FileChangePayload, MessageItemPayload, MessageRole,
    ProviderExtensionPayload, RawProviderPayload, ReasoningPayload, RuntimeDiagnosticPayload,
    RuntimeEventIdentity, RuntimeEventKind, RuntimeEventPayload, RuntimeEventSource,
    SessionPayload, SessionPayloadKind, Severity, TokenUsagePayload, ToolCallPayload,
    ToolCallStatus, TurnPayload, TurnPayloadKind, UserInputPayload, UserInputPromptKind,
};
pub use identity::{
    AdapterIdentity, AuthenticationPreflight, ProviderDriverKind, TransportFamily, VersionDiscovery,
};
pub use routes::{
    ApiCompatibilityFamily, AuthSource, BillingAccountSource, ModelRoute, ModelRouteCapabilities,
    RouteEndpoint, RoutePolicy,
};
pub use runtime::{
    AdapterCommandState, AdapterCommandStreamState, AdapterEventStreamState,
    AdapterRuntimeOwnership, AdapterRuntimeOwnershipMode, BackpressureOverflow, BackpressurePolicy,
    CommandAcknowledgementSemantics, CommandCompletionSemantics, CommandStreamSemantics,
    DisconnectSemantics, EventOrderingSemantics, EventStreamSemantics, RecoveryAction,
    RuntimeProcessOwner, RuntimeRecoveryPolicy,
};
pub use sessions::{
    AgentSessionId, AgentSessionLifecycleState, AgentSessionRecord, AgentSessionRecoveryState,
    AgentSessionStateChange, AgentTurnId, AgentTurnRecord, AgentTurnStatus, SessionLifecycleAction,
};
pub use traits::{
    AdapterCommandAcknowledgement, AdapterCommandRequest, AdapterEventBoundary,
    AdapterLifecycleBoundary, AdapterRuntimeEvent, AdapterRuntimeMetadata,
    AdapterTraitCapabilities, EventIdentityField, EventIdentityPolicy, IdentityNamespace,
    LifecycleActionSupport, SyntheticIdPolicy, TerminalFallbackPolicy,
};
