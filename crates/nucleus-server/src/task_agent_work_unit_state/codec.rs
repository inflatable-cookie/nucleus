use serde::{Deserialize, Serialize};

use nucleus_agent_protocol::{AgentSessionId, AgentTurnId};
use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskAgentWorkUnitSourceCursor, EngineTaskAgentWorkUnitSourceId,
    EngineTaskAgentWorkUnitSourceRecord, EngineTaskTimelineEntryId, EngineTaskWorkItemId,
    EngineTaskWorkItemRefs,
};
use nucleus_local_store::{LocalStoreError, LocalStoreResult};
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

pub(super) fn encode_source_record(
    record: EngineTaskAgentWorkUnitSourceRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&TaskAgentWorkUnitSourceRecordDto::from(record)).map_err(json_error)
}

pub(super) fn decode_source_record(
    bytes: &[u8],
) -> LocalStoreResult<EngineTaskAgentWorkUnitSourceRecord> {
    serde_json::from_slice::<TaskAgentWorkUnitSourceRecordDto>(bytes)
        .map(EngineTaskAgentWorkUnitSourceRecord::from)
        .map_err(json_error)
}

fn json_error(error: serde_json::Error) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: format!("invalid task-agent source record json: {error}"),
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct TaskAgentWorkUnitSourceRecordDto {
    source_id: String,
    source_cursor: String,
    work_item_id: String,
    project_id: String,
    task_id: String,
    command_id: String,
    actor_ref: String,
    adapter_id: String,
    provider_instance_id: String,
    idempotency_key: String,
    task_revision: Option<String>,
    runtime: RuntimeStatusDto,
    review: ReviewStatusDto,
    refs: WorkItemRefsDto,
    previous_source_id: Option<String>,
    summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "detail", rename_all = "snake_case")]
enum RuntimeStatusDto {
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "detail", rename_all = "snake_case")]
enum ReviewStatusDto {
    NotReady,
    AwaitingReview,
    Accepted,
    Rejected(String),
    NeedsChanges(String),
    Abandoned(String),
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
struct WorkItemRefsDto {
    session_id: Option<String>,
    turn_ids: Vec<String>,
    receipt_ids: Vec<String>,
    checkpoint_ids: Vec<String>,
    diff_summary_ids: Vec<String>,
    timeline_entry_ids: Vec<String>,
    validation_refs: Vec<String>,
    artifact_refs: Vec<String>,
}

impl From<EngineTaskAgentWorkUnitSourceRecord> for TaskAgentWorkUnitSourceRecordDto {
    fn from(record: EngineTaskAgentWorkUnitSourceRecord) -> Self {
        Self {
            source_id: record.source_id.0,
            source_cursor: record.source_cursor.0,
            work_item_id: record.work_item_id.0,
            project_id: record.project_id.0,
            task_id: record.task_id.0,
            command_id: record.command_id,
            actor_ref: record.actor_ref,
            adapter_id: record.adapter_id,
            provider_instance_id: record.provider_instance_id,
            idempotency_key: record.idempotency_key,
            task_revision: record.task_revision.map(|id| id.0),
            runtime: RuntimeStatusDto::from(record.runtime),
            review: ReviewStatusDto::from(record.review),
            refs: WorkItemRefsDto::from(record.refs),
            previous_source_id: record.previous_source_id.map(|id| id.0),
            summary: record.summary,
        }
    }
}

impl From<TaskAgentWorkUnitSourceRecordDto> for EngineTaskAgentWorkUnitSourceRecord {
    fn from(dto: TaskAgentWorkUnitSourceRecordDto) -> Self {
        Self {
            source_id: EngineTaskAgentWorkUnitSourceId(dto.source_id),
            source_cursor: EngineTaskAgentWorkUnitSourceCursor(dto.source_cursor),
            work_item_id: EngineTaskWorkItemId(dto.work_item_id),
            project_id: ProjectId(dto.project_id),
            task_id: TaskId(dto.task_id),
            command_id: dto.command_id,
            actor_ref: dto.actor_ref,
            adapter_id: dto.adapter_id,
            provider_instance_id: dto.provider_instance_id,
            idempotency_key: dto.idempotency_key,
            task_revision: dto.task_revision.map(RevisionId),
            runtime: EngineTaskAgentWorkUnitRuntimeStatus::from(dto.runtime),
            review: EngineTaskAgentWorkUnitReviewStatus::from(dto.review),
            refs: EngineTaskWorkItemRefs::from(dto.refs),
            previous_source_id: dto.previous_source_id.map(EngineTaskAgentWorkUnitSourceId),
            summary: dto.summary,
        }
    }
}

impl From<EngineTaskAgentWorkUnitRuntimeStatus> for RuntimeStatusDto {
    fn from(status: EngineTaskAgentWorkUnitRuntimeStatus) -> Self {
        match status {
            EngineTaskAgentWorkUnitRuntimeStatus::Draft => Self::Draft,
            EngineTaskAgentWorkUnitRuntimeStatus::Ready => Self::Ready,
            EngineTaskAgentWorkUnitRuntimeStatus::Scheduled => Self::Scheduled,
            EngineTaskAgentWorkUnitRuntimeStatus::Running => Self::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval => Self::WaitingForApproval,
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput => Self::WaitingForUserInput,
            EngineTaskAgentWorkUnitRuntimeStatus::Completed => Self::Completed,
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(reason) => Self::Failed(reason),
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled => Self::Cancelled,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(reason) => {
                Self::RecoveryRequired(reason)
            }
        }
    }
}

impl From<RuntimeStatusDto> for EngineTaskAgentWorkUnitRuntimeStatus {
    fn from(status: RuntimeStatusDto) -> Self {
        match status {
            RuntimeStatusDto::Draft => Self::Draft,
            RuntimeStatusDto::Ready => Self::Ready,
            RuntimeStatusDto::Scheduled => Self::Scheduled,
            RuntimeStatusDto::Running => Self::Running,
            RuntimeStatusDto::WaitingForApproval => Self::WaitingForApproval,
            RuntimeStatusDto::WaitingForUserInput => Self::WaitingForUserInput,
            RuntimeStatusDto::Completed => Self::Completed,
            RuntimeStatusDto::Failed(reason) => Self::Failed(reason),
            RuntimeStatusDto::Cancelled => Self::Cancelled,
            RuntimeStatusDto::RecoveryRequired(reason) => Self::RecoveryRequired(reason),
        }
    }
}

impl From<EngineTaskAgentWorkUnitReviewStatus> for ReviewStatusDto {
    fn from(status: EngineTaskAgentWorkUnitReviewStatus) -> Self {
        match status {
            EngineTaskAgentWorkUnitReviewStatus::NotReady => Self::NotReady,
            EngineTaskAgentWorkUnitReviewStatus::AwaitingReview => Self::AwaitingReview,
            EngineTaskAgentWorkUnitReviewStatus::Accepted => Self::Accepted,
            EngineTaskAgentWorkUnitReviewStatus::Rejected(reason) => Self::Rejected(reason),
            EngineTaskAgentWorkUnitReviewStatus::NeedsChanges(reason) => Self::NeedsChanges(reason),
            EngineTaskAgentWorkUnitReviewStatus::Abandoned(reason) => Self::Abandoned(reason),
        }
    }
}

impl From<ReviewStatusDto> for EngineTaskAgentWorkUnitReviewStatus {
    fn from(status: ReviewStatusDto) -> Self {
        match status {
            ReviewStatusDto::NotReady => Self::NotReady,
            ReviewStatusDto::AwaitingReview => Self::AwaitingReview,
            ReviewStatusDto::Accepted => Self::Accepted,
            ReviewStatusDto::Rejected(reason) => Self::Rejected(reason),
            ReviewStatusDto::NeedsChanges(reason) => Self::NeedsChanges(reason),
            ReviewStatusDto::Abandoned(reason) => Self::Abandoned(reason),
        }
    }
}

impl From<EngineTaskWorkItemRefs> for WorkItemRefsDto {
    fn from(refs: EngineTaskWorkItemRefs) -> Self {
        Self {
            session_id: refs.session_id.map(|id| id.0),
            turn_ids: refs.turn_ids.into_iter().map(|id| id.0).collect(),
            receipt_ids: refs.receipt_ids.into_iter().map(|id| id.0).collect(),
            checkpoint_ids: refs.checkpoint_ids.into_iter().map(|id| id.0).collect(),
            diff_summary_ids: refs.diff_summary_ids.into_iter().map(|id| id.0).collect(),
            timeline_entry_ids: refs.timeline_entry_ids.into_iter().map(|id| id.0).collect(),
            validation_refs: refs.validation_refs,
            artifact_refs: refs.artifact_refs,
        }
    }
}

impl From<WorkItemRefsDto> for EngineTaskWorkItemRefs {
    fn from(refs: WorkItemRefsDto) -> Self {
        Self {
            session_id: refs.session_id.map(AgentSessionId),
            turn_ids: refs.turn_ids.into_iter().map(AgentTurnId).collect(),
            receipt_ids: refs
                .receipt_ids
                .into_iter()
                .map(EngineRuntimeReceiptRecordId)
                .collect(),
            checkpoint_ids: refs
                .checkpoint_ids
                .into_iter()
                .map(EngineCheckpointRecordId)
                .collect(),
            diff_summary_ids: refs
                .diff_summary_ids
                .into_iter()
                .map(EngineDiffSummaryRecordId)
                .collect(),
            timeline_entry_ids: refs
                .timeline_entry_ids
                .into_iter()
                .map(EngineTaskTimelineEntryId)
                .collect(),
            validation_refs: refs.validation_refs,
            artifact_refs: refs.artifact_refs,
        }
    }
}
