use nucleus_agent_protocol::AdapterCommandStreamState;

use crate::provider_service_runtime::{
    ProviderCommandFamily, ProviderCommandLaneId, ProviderReactorReadinessState,
    ProviderRuntimeStreamId, ProviderServiceId,
};

/// Stable id for a provider command reactor.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandReactorId(pub String);

/// Stable id for one provider command request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandId(pub String);

/// Stable id for a provider command admission.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandAdmissionId(pub String);

/// Stable id for a queued provider command.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandQueueEntryId(pub String);

/// Stable id for a provider command dispatch attempt.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandDispatchAttemptId(pub String);

/// Stable id for a provider command reactor outcome.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderCommandReactorOutcomeId(pub String);

/// Command admission input for the provider reactor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandAdmissionInput {
    pub command_id: ProviderCommandId,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub target_ref: Option<String>,
    pub requester: ProviderCommandRequester,
    pub capability: ProviderCommandCapabilityState,
    pub reactor_state: ProviderReactorReadinessState,
    pub command_stream_state: AdapterCommandStreamState,
    pub live_send_requested: bool,
    pub task_mutation_requested: bool,
    pub evidence_refs: Vec<String>,
}

/// Actor requesting provider work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandRequester {
    TaskAgent,
    Steward,
    User,
    System,
}

/// Provider-specific support for one command family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandCapabilityState {
    Supported,
    Unsupported(String),
    Unknown,
}

/// Reactor admission record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandAdmissionRecord {
    pub admission_id: ProviderCommandAdmissionId,
    pub command_id: ProviderCommandId,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub target_ref: Option<String>,
    pub requester: ProviderCommandRequester,
    pub status: ProviderCommandAdmissionStatus,
    pub blockers: Vec<ProviderCommandAdmissionBlocker>,
    pub live_send_permitted: bool,
    pub task_mutation_permitted: bool,
    pub evidence_refs: Vec<String>,
}

/// Admission status before queueing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandAdmissionStatus {
    AcceptedForDryRun,
    Blocked,
    Unsupported,
}

/// Why provider command admission was blocked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandAdmissionBlocker {
    ReactorNotReady,
    CommandLaneNotAccepting,
    ProviderCapabilityUnknown,
    ProviderCapabilityUnsupported(String),
    LiveProviderSendDisabled,
    TaskMutationDisabled,
}

/// Provider command queued by the reactor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderQueuedCommandRecord {
    pub queue_entry_id: ProviderCommandQueueEntryId,
    pub admission_id: ProviderCommandAdmissionId,
    pub command_id: ProviderCommandId,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub state: ProviderCommandQueueState,
    pub live_send_permitted: bool,
    pub task_mutation_permitted: bool,
}

/// Queue state for a provider command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandQueueState {
    QueuedForDryRun,
    Rejected(String),
}

/// Provider dispatch attempt record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandDispatchAttemptRecord {
    pub attempt_id: ProviderCommandDispatchAttemptId,
    pub queue_entry_id: ProviderCommandQueueEntryId,
    pub command_id: ProviderCommandId,
    pub reactor_id: ProviderCommandReactorId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub mode: ProviderCommandDispatchMode,
    pub status: ProviderCommandDispatchAttemptStatus,
    pub live_send_attempted: bool,
    pub task_mutation_attempted: bool,
    pub evidence_refs: Vec<String>,
}

/// Dispatch mode for provider command reactor work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandDispatchMode {
    DryRunOnly,
    LiveSend,
}

/// Dispatch attempt status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandDispatchAttemptStatus {
    DryRunCompleted,
    SkippedLiveSend(String),
    Blocked(String),
}

/// Provider command outcome record from the reactor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandReactorOutcomeRecord {
    pub outcome_id: ProviderCommandReactorOutcomeId,
    pub attempt_id: ProviderCommandDispatchAttemptId,
    pub command_id: ProviderCommandId,
    pub service_id: ProviderServiceId,
    pub command_lane_id: ProviderCommandLaneId,
    pub stream_id: Option<ProviderRuntimeStreamId>,
    pub family: ProviderCommandFamily,
    pub status: ProviderCommandReactorOutcomeStatus,
    pub live_send_attempted: bool,
    pub task_mutation_permitted: bool,
    pub evidence_refs: Vec<String>,
    pub summary: String,
}

/// Provider command outcome status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandReactorOutcomeStatus {
    DryRunCompleted,
    Blocked(String),
    Unsupported(String),
    Failed(String),
}

/// Provider command reactor construction error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommandReactorError {
    AdmissionNotAccepted,
    QueueEntryNotDispatchable,
}
