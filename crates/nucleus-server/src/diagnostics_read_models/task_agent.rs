use serde::{Deserialize, Serialize};

use nucleus_engine::{
    EngineTaskAgentWorkUnitProjection, EngineTaskAgentWorkUnitProjectionIssue,
    EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskAgentWorkUnitSourceRecord,
};

use super::helpers::{source_status, source_summary};

/// Task-agent work-unit diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TaskAgentDiagnosticsDto {
    pub work_units: Vec<TaskAgentWorkUnitDiagnosticDto>,
    pub client_can_mutate_work_units: bool,
    pub provider_execution_available: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TaskAgentWorkUnitDiagnosticDto {
    pub work_item_id: String,
    pub project_id: String,
    pub task_id: String,
    pub runtime: String,
    pub review: String,
    pub last_source_id: String,
    pub last_cursor: String,
    #[ts(as = "u32")]
    pub source_count: usize,
    pub session_id: Option<String>,
    pub turn_ids: Vec<String>,
    pub receipt_ids: Vec<String>,
    pub checkpoint_ids: Vec<String>,
    pub diff_summary_ids: Vec<String>,
    pub timeline_entry_ids: Vec<String>,
    pub validation_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub issues: Vec<TaskAgentWorkUnitIssueDto>,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TaskAgentWorkUnitIssueDto {
    pub code: String,
    pub summary: String,
}

pub fn task_agent_diagnostics(
    records: &[EngineTaskAgentWorkUnitSourceRecord],
) -> TaskAgentDiagnosticsDto {
    let projections = nucleus_engine::project_task_agent_work_units(records);
    TaskAgentDiagnosticsDto {
        work_units: projections
            .iter()
            .map(TaskAgentWorkUnitDiagnosticDto::from)
            .collect(),
        client_can_mutate_work_units: false,
        provider_execution_available: false,
        source_status: source_status(records.len()),
        source_summary: Some(source_summary(
            records.len(),
            "no persisted task-agent work-unit source records",
            "task-agent diagnostics loaded from source records",
        )),
    }
}

impl From<&EngineTaskAgentWorkUnitProjection> for TaskAgentWorkUnitDiagnosticDto {
    fn from(projection: &EngineTaskAgentWorkUnitProjection) -> Self {
        Self {
            work_item_id: projection.work_item_id.0.clone(),
            project_id: projection.project_id.0.clone(),
            task_id: projection.task_id.0.clone(),
            runtime: runtime_status(&projection.runtime),
            review: review_status(&projection.review),
            last_source_id: projection.last_source_id.0.clone(),
            last_cursor: projection.last_cursor.0.clone(),
            source_count: projection.source_count,
            session_id: projection.refs.session_id.as_ref().map(|id| id.0.clone()),
            turn_ids: projection
                .refs
                .turn_ids
                .iter()
                .map(|id| id.0.clone())
                .collect(),
            receipt_ids: projection
                .refs
                .receipt_ids
                .iter()
                .map(|id| id.0.clone())
                .collect(),
            checkpoint_ids: projection
                .refs
                .checkpoint_ids
                .iter()
                .map(|id| id.0.clone())
                .collect(),
            diff_summary_ids: projection
                .refs
                .diff_summary_ids
                .iter()
                .map(|id| id.0.clone())
                .collect(),
            timeline_entry_ids: projection
                .refs
                .timeline_entry_ids
                .iter()
                .map(|id| id.0.clone())
                .collect(),
            validation_refs: projection.refs.validation_refs.clone(),
            artifact_refs: projection.refs.artifact_refs.clone(),
            issues: projection
                .issues
                .iter()
                .map(TaskAgentWorkUnitIssueDto::from)
                .collect(),
            summary: projection.summary.clone(),
        }
    }
}

impl From<&EngineTaskAgentWorkUnitProjectionIssue> for TaskAgentWorkUnitIssueDto {
    fn from(issue: &EngineTaskAgentWorkUnitProjectionIssue) -> Self {
        match issue {
            EngineTaskAgentWorkUnitProjectionIssue::EmptyActorRef => Self {
                code: "empty_actor_ref".to_owned(),
                summary: "work unit source record has no actor ref".to_owned(),
            },
            EngineTaskAgentWorkUnitProjectionIssue::EmptyAdapterRef => Self {
                code: "empty_adapter_ref".to_owned(),
                summary: "work unit source record has no adapter ref".to_owned(),
            },
            EngineTaskAgentWorkUnitProjectionIssue::EmptyProviderInstanceRef => Self {
                code: "empty_provider_instance_ref".to_owned(),
                summary: "work unit source record has no provider instance ref".to_owned(),
            },
            EngineTaskAgentWorkUnitProjectionIssue::ForbiddenSummaryTerm(term) => Self {
                code: "forbidden_summary_term".to_owned(),
                summary: format!("work unit summary contains forbidden term: {term}"),
            },
        }
    }
}

fn runtime_status(status: &EngineTaskAgentWorkUnitRuntimeStatus) -> String {
    match status {
        EngineTaskAgentWorkUnitRuntimeStatus::Draft => "draft",
        EngineTaskAgentWorkUnitRuntimeStatus::Ready => "ready",
        EngineTaskAgentWorkUnitRuntimeStatus::Scheduled => "scheduled",
        EngineTaskAgentWorkUnitRuntimeStatus::Running => "running",
        EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval => "waiting_for_approval",
        EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput => "waiting_for_user_input",
        EngineTaskAgentWorkUnitRuntimeStatus::Completed => "completed",
        EngineTaskAgentWorkUnitRuntimeStatus::Failed(_) => "failed",
        EngineTaskAgentWorkUnitRuntimeStatus::Cancelled => "cancelled",
        EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_) => "recovery_required",
    }
    .to_owned()
}

fn review_status(status: &EngineTaskAgentWorkUnitReviewStatus) -> String {
    match status {
        EngineTaskAgentWorkUnitReviewStatus::NotReady => "not_ready",
        EngineTaskAgentWorkUnitReviewStatus::AwaitingReview => "awaiting_review",
        EngineTaskAgentWorkUnitReviewStatus::Accepted => "accepted",
        EngineTaskAgentWorkUnitReviewStatus::Rejected(_) => "rejected",
        EngineTaskAgentWorkUnitReviewStatus::NeedsChanges(_) => "needs_changes",
        EngineTaskAgentWorkUnitReviewStatus::Abandoned(_) => "abandoned",
    }
    .to_owned()
}
