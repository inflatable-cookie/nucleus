//! Adapter runtime ownership and stream semantics.
//!
//! These types describe ownership and stream state only. They do not start
//! processes, open sockets, or implement async behavior.

/// Runtime ownership metadata for one adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterRuntimeOwnership {
    pub mode: AdapterRuntimeOwnershipMode,
    pub process_owner: RuntimeProcessOwner,
    pub endpoint_label: Option<String>,
    pub command_stream: CommandStreamSemantics,
    pub event_stream: EventStreamSemantics,
    pub recovery_policy: RuntimeRecoveryPolicy,
}

/// How nucleus reaches or owns a provider runtime.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterRuntimeOwnershipMode {
    ExternalServer,
    NucleusOwnedLocalServer,
    SdkSidecar,
    AcpStdioProcess,
    WireStdioProcess,
    RpcStdioProcess,
    PtyProcess,
    UnavailableUnknown,
}

/// Who owns lifecycle of the underlying process or server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeProcessOwner {
    External,
    Nucleus,
    SidecarHost,
    Unknown,
}

/// Command stream semantics for an adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandStreamSemantics {
    pub acknowledgement: CommandAcknowledgementSemantics,
    pub completion: CommandCompletionSemantics,
    pub backpressure: BackpressurePolicy,
}

/// Command acknowledgement means a provider accepted or rejected the command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandAcknowledgementSemantics {
    SynchronousAcceptedRejected,
    ProviderRequestId,
    EventualEvent,
    Unsupported,
    Unknown,
}

/// Command completion is reported separately from command acknowledgement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandCompletionSemantics {
    RuntimeEvent,
    ProviderResponse,
    TranscriptProjection,
    Unsupported,
    Unknown,
}

/// Event stream semantics for an adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventStreamSemantics {
    pub ordering: EventOrderingSemantics,
    pub disconnect: DisconnectSemantics,
    pub backpressure: BackpressurePolicy,
}

/// Ordering guarantees for emitted events.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventOrderingSemantics {
    TotalPerSession,
    TotalPerRuntimeProcess,
    PartialProviderOrder,
    ProjectionOnly,
    Unknown,
}

/// How disconnects are represented before recovery begins.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisconnectSemantics {
    ExplicitEvent,
    ProcessExitStatus,
    TransportError,
    ExternalHealthProbe,
    Unknown,
}

/// Backpressure policy for command or event streams.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackpressurePolicy {
    pub bounded_capacity: Option<u64>,
    pub overflow: BackpressureOverflow,
}

/// Overflow behavior when a stream cannot keep up.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackpressureOverflow {
    RejectNewCommands,
    PauseProviderRead,
    DropDiagnosticsOnly,
    DisconnectAndRecover,
    Unknown,
}

/// Recovery policy for runtime disconnects and restarts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeRecoveryPolicy {
    pub on_disconnect: RecoveryAction,
    pub on_restart: RecoveryAction,
}

/// Recovery action available to an adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryAction {
    ReconnectExternal,
    RespawnOwnedRuntime,
    ReattachSession,
    RequireManualRecovery,
    Unsupported,
    Unknown,
}

/// Current command stream state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterCommandStreamState {
    Idle,
    Accepting,
    Backpressured,
    Draining,
    Closed,
    Failed(String),
}

/// Current event stream state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterEventStreamState {
    NotStarted,
    Connecting,
    Open,
    Backpressured,
    Disconnected,
    Restarting,
    Closed,
    Failed(String),
}

/// Command state after it enters an adapter runtime boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterCommandState {
    Pending,
    Accepted,
    Rejected(String),
    Running,
    Completed,
    Failed(String),
    Cancelled,
    Unsupported(String),
}
