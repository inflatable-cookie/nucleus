use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{EngineTaskWorkItemId, EngineTaskWorkItemRefs};

/// Stable source-record id for a task-backed agent work-unit fact.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineTaskAgentWorkUnitSourceId(pub String);

/// Rebuild cursor for source-record projections.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineTaskAgentWorkUnitSourceCursor(pub String);

/// Runtime status recorded by task-agent source records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskAgentWorkUnitRuntimeStatus {
    Draft,
    Ready,
    Scheduled,
    Running,
    WaitingForApproval,
    WaitingForUserInput,
    Completed,
    Failed(String),
    Cancelled,
    RecoveryRequired(String),
}

/// Review status recorded by task-agent source records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskAgentWorkUnitReviewStatus {
    NotReady,
    AwaitingReview,
    Accepted,
    Rejected(String),
    NeedsChanges(String),
    Abandoned(String),
}

/// Source fact for one task-backed agent work-unit transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskAgentWorkUnitSourceRecord {
    pub source_id: EngineTaskAgentWorkUnitSourceId,
    pub source_cursor: EngineTaskAgentWorkUnitSourceCursor,
    pub work_item_id: EngineTaskWorkItemId,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub command_id: String,
    pub actor_ref: String,
    pub adapter_id: String,
    pub provider_instance_id: String,
    pub idempotency_key: String,
    pub task_revision: Option<RevisionId>,
    pub runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    pub review: EngineTaskAgentWorkUnitReviewStatus,
    pub refs: EngineTaskWorkItemRefs,
    pub previous_source_id: Option<EngineTaskAgentWorkUnitSourceId>,
    pub summary: String,
}

/// Admission output produced when delegation creates or reuses a work unit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskAgentWorkUnitAdmissionRecord {
    pub source_record: EngineTaskAgentWorkUnitSourceRecord,
    pub provider_execution_deferred: bool,
}
