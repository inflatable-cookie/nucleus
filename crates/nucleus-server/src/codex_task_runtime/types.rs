use nucleus_agent_protocol::{AdapterIdentity, AgentSessionId};
use nucleus_command_policy::CommandRequestId;
use nucleus_engine::{
    EngineRuntimeReceiptStatus, EngineTaskAgentWorkUnitSourceId, EngineTaskWorkItemId,
};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::ids::ServerEventId;
use crate::scheduler::RuntimeSchedulerAdmissionDecision;

/// Task-scoped request to admit Codex runtime work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeRequestRecord {
    pub request_id: CodexTaskRuntimeRequestId,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub source_id: EngineTaskAgentWorkUnitSourceId,
    pub adapter: AdapterIdentity,
    pub command_request_id: CommandRequestId,
    pub event_id: ServerEventId,
    pub nucleus_session_id: AgentSessionId,
    pub codex_refs: CodexTaskRuntimeProviderRefs,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexTaskRuntimeRequestId(pub String);

/// Codex-native refs preserved outside the generic work-unit model.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CodexTaskRuntimeProviderRefs {
    pub provider_session_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub provider_item_id: Option<String>,
    pub provider_request_id: Option<String>,
}

/// Admission result for a task-scoped Codex runtime request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeAdmission {
    pub request_id: CodexTaskRuntimeRequestId,
    pub decision: RuntimeSchedulerAdmissionDecision,
    pub provider_execution_started: bool,
}

/// Link between a Codex wait state and the owning task work unit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeWaitLink {
    pub wait_id: String,
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub nucleus_session_id: AgentSessionId,
    pub provider_request_id: Option<String>,
    pub evidence_event_id: String,
    pub approval_is_automatic: bool,
}

/// Recovery gate for task-scoped Codex work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeRecoveryGate {
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub state: CodexTaskRuntimeRecoveryState,
    pub evidence_refs: Vec<String>,
    pub retry_execution_allowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexTaskRuntimeRecoveryState {
    NotNeeded,
    CancellationRecorded,
    ResumeBlocked(String),
    RecoveryRequired(String),
}

/// Task progress fact derived from a Codex runtime observation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeProgressEvent {
    pub progress_id: String,
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub kind: CodexTaskRuntimeProgressKind,
    pub evidence_ref: String,
    pub summary: String,
    pub terminal: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexTaskRuntimeProgressKind {
    Session,
    Turn,
    Message,
    ToolCall,
    CommandExecution,
    PermissionWait,
    UserInputWait,
    Warning,
    Error,
    Unsupported,
    RuntimeReceipt,
}

/// Link between a work unit and a sanitized runtime receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeReceiptLink {
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub receipt_id: String,
    pub status: EngineRuntimeReceiptStatus,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub summary: Option<String>,
}

/// Error classification metadata. It never triggers retry execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexTaskRuntimeErrorClassification {
    pub request_id: CodexTaskRuntimeRequestId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub class: CodexTaskRuntimeErrorClass,
    pub evidence_ref: String,
    pub retry_eligible: bool,
    pub recovery_required: bool,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexTaskRuntimeErrorClass {
    UnsupportedObservation,
    ProviderRuntimeError,
    PermissionDenied,
    RecoveryRequired,
    Unknown,
}
