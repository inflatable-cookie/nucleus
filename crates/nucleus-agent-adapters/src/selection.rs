//! Adapter selection input and outcome records.

use nucleus_agent_protocol::{CapabilitySupport, ModelRoute};

/// Stable id for one configured adapter instance.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AdapterInstanceId(pub String);

/// Selection request assembled before assigning work to an adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterSelectionRequest {
    pub explicit_instance_id: Option<AdapterInstanceId>,
    pub project_ref: Option<String>,
    pub task_ref: Option<String>,
    pub session_ref: Option<String>,
    pub requested_model_route: Option<ModelRoute>,
    pub required_capabilities: Vec<AdapterCapabilityRequirement>,
    pub config_scope_precedence: Vec<AdapterSelectionScope>,
}

/// Capability requirement used during adapter selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterCapabilityRequirement {
    pub key: AdapterCapabilityKey,
    pub minimum: CapabilitySupport,
}

/// Named capability that may participate in selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterCapabilityKey {
    StreamingOutput,
    ToolCallEvents,
    FileEditEvents,
    PermissionPrompts,
    Cancellation,
    Checkpointing,
    Resume,
    TerminalRendering,
    StructuredMessages,
    RawTranscriptAccess,
    ModelSwitch,
    AccountConfigPreflight,
    MultiInstance,
    Rollback,
    ProviderNativeSessionResume,
    ExternalServer,
    ServerSpawn,
}

/// Scope precedence applied while resolving adapter configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterSelectionScope {
    Driver,
    Instance,
    Project(String),
    Session(String),
}

/// Outcome of selecting a configured adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterSelectionOutcome {
    pub selected_instance_id: AdapterInstanceId,
    pub matched_model_route: Option<ModelRoute>,
    pub resolved_config_refs: Vec<ResolvedAdapterConfigRef>,
    pub decision_reasons: Vec<AdapterSelectionReason>,
}

/// Config value reference after scope resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedAdapterConfigRef {
    pub key: String,
    pub scope: AdapterSelectionScope,
    pub value_kind: ResolvedAdapterConfigValueKind,
}

/// Resolved config value kind without carrying secret material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResolvedAdapterConfigValueKind {
    Plain,
    Path,
    SecretRef,
}

/// Reason retained for explaining an adapter selection result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterSelectionReason {
    ExplicitUserChoice,
    ProjectDefault,
    SessionOverride,
    ModelRouteMatch,
    CapabilityMatch,
    ReadinessMatch,
    HealthSnapshotAccepted,
}
