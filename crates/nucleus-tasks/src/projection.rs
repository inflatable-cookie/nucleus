//! Task projection records.

use nucleus_core::ProjectionRecordEnvelope;

use crate::{
    AcceptanceCriterion, AgentReadiness, TaskActionType, TaskActivityState, TaskHistoryEntryId,
    TaskId, TaskImportance,
};
use nucleus_projects::ProjectId;

/// Committable task record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskProjectionRecord {
    pub envelope: ProjectionRecordEnvelope,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub title: String,
    pub description: Option<String>,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub importance: TaskImportance,
    pub action_type: TaskActionType,
    pub activity: TaskActivityState,
    pub assignment_intent: Option<String>,
    pub agent_readiness: AgentReadiness,
    pub validation_summary_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub history_summaries: Vec<TaskProjectionHistorySummary>,
}

/// Low-volume task history summary safe for projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskProjectionHistorySummary {
    pub history_entry_id: Option<TaskHistoryEntryId>,
    pub actor_ref: Option<String>,
    pub event_label: String,
    pub summary: Option<String>,
    pub evidence_refs: Vec<String>,
}
