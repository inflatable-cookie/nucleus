use nucleus_agent_protocol::{AgentSessionId, AgentTurnId};
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActionType, TaskId};

use crate::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    EngineTaskTimelineEntryId,
};

/// Stable id for one task-owned work item.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineTaskWorkItemId(pub String);

/// Portable work item record owned by a task.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemRecord {
    pub work_item_id: EngineTaskWorkItemId,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub title: String,
    pub intent: TaskActionType,
    pub assignment: EngineTaskWorkItemAssignment,
    pub runtime: EngineTaskWorkItemRuntimeState,
    pub review: EngineTaskWorkItemReviewState,
    pub refs: EngineTaskWorkItemRefs,
    pub summary: Option<String>,
}

/// Assignment target selected for one work item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemAssignment {
    Operator(String),
    AdapterInstance {
        adapter_id: String,
        provider_instance_id: String,
    },
    Mixed(Vec<String>),
    Unassigned,
}

/// Runtime state is separate from review and task acceptance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemRuntimeState {
    Draft,
    Ready,
    Scheduled,
    Running,
    WaitingForApproval,
    WaitingForUserInput,
    Completed,
    Cancelled,
    Failed(String),
    RecoveryRequired(String),
}

/// Operator review state is separate from provider completion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemReviewState {
    NotReady,
    AwaitingReview,
    Accepted,
    Rejected(String),
    NeedsChanges(String),
    Abandoned(String),
}

/// References from a work item to runtime evidence.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EngineTaskWorkItemRefs {
    pub session_id: Option<AgentSessionId>,
    pub turn_ids: Vec<AgentTurnId>,
    pub receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    pub checkpoint_ids: Vec<EngineCheckpointRecordId>,
    pub diff_summary_ids: Vec<EngineDiffSummaryRecordId>,
    pub timeline_entry_ids: Vec<EngineTaskTimelineEntryId>,
    pub validation_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
}

/// Task-scoped grouping of work items.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemSet {
    pub task_id: TaskId,
    pub work_items: Vec<EngineTaskWorkItemRecord>,
}

/// Deterministic projection of one work item's linked runtime evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemRuntimeProjection {
    pub work_item_id: EngineTaskWorkItemId,
    pub task_id: TaskId,
    pub state: EngineTaskWorkItemRuntimeLinkState,
    pub entries: Vec<EngineTaskWorkItemRuntimeProjectionEntry>,
    pub summary: String,
}

/// Runtime linkage health for a work item projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemRuntimeLinkState {
    Linked,
    Partial,
    RepairRequired(String),
}

/// Sanitized projection entry derived from a linked runtime ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemRuntimeProjectionEntry {
    pub entry_id: String,
    pub kind: EngineTaskWorkItemRuntimeProjectionEntryKind,
    pub source_ref: String,
    pub summary: String,
}

/// Supported projection entry classes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemRuntimeProjectionEntryKind {
    Session,
    Turn,
    Receipt,
    Checkpoint,
    DiffSummary,
    Timeline,
    Validation,
    Artifact,
}

/// Operator review decision applied to a work item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemReviewDecision {
    pub reviewer_ref: String,
    pub outcome: EngineTaskWorkItemReviewOutcome,
    pub validation_refs: Vec<String>,
    pub checkpoint_ids: Vec<EngineCheckpointRecordId>,
    pub note: Option<String>,
}

/// Review outcomes that do not directly mutate task completion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemReviewOutcome {
    Accept,
    Reject { reason: String },
    NeedsChanges { reason: String },
    Abandon { reason: String },
}

/// Result of applying a review decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskWorkItemReviewTransition {
    pub work_item: EngineTaskWorkItemRecord,
    pub from: EngineTaskWorkItemReviewState,
    pub to: EngineTaskWorkItemReviewState,
    pub reviewer_ref: String,
    pub validation_refs: Vec<String>,
    pub checkpoint_ids: Vec<EngineCheckpointRecordId>,
    pub task_completion_allowed: bool,
}

/// Review transition failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskWorkItemReviewError {
    EmptyReviewer,
    RuntimeNotComplete,
    MissingReviewEvidence,
    EmptyReason,
}
