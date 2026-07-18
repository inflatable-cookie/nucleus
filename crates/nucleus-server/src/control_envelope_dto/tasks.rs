use serde::{Deserialize, Serialize};

use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
use nucleus_local_store::LocalStoreRecord;
use nucleus_tasks::{
    decode_task_storage_record, TaskStorageActionType, TaskStorageActivityState,
    TaskStorageImportance,
};

use super::ControlApiCodecError;

/// Display-ready task record DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskRecordDto {
    pub task_id: String,
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    pub acceptance_criteria: Vec<ControlTaskAcceptanceCriterionDto>,
    pub importance: String,
    pub action_type: String,
    pub activity: String,
    pub assignment_intent: Option<String>,
    pub agent_ready: bool,
    pub required_context_refs: Vec<String>,
    pub allowed_actions: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub validation_commands: Vec<String>,
    pub blocked_reason: Option<String>,
    pub revision_id: String,
}

/// Display-ready task acceptance criterion.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlTaskAcceptanceCriterionDto {
    pub text: String,
    pub required: bool,
}

impl TryFrom<&LocalStoreRecord> for ControlTaskRecordDto {
    type Error = ControlApiCodecError;

    fn try_from(record: &LocalStoreRecord) -> Result<Self, Self::Error> {
        if record.domain != PersistenceDomain::Tasks || record.kind != PersistenceRecordKind::Task {
            return Err(ControlApiCodecError::unsupported(
                "task display DTO requires task records",
            ));
        }

        let decoded = decode_task_storage_record(&record.payload.bytes).map_err(|error| {
            ControlApiCodecError::malformed(format!(
                "task storage payload could not be decoded: {}",
                error.reason
            ))
        })?;

        Ok(Self {
            task_id: decoded.task_id,
            project_id: decoded.project_id,
            title: decoded.title,
            description: decoded.description,
            acceptance_criteria: decoded
                .acceptance_criteria
                .into_iter()
                .map(|criterion| ControlTaskAcceptanceCriterionDto {
                    text: criterion.text,
                    required: criterion.required,
                })
                .collect(),
            importance: task_importance_dto(&decoded.importance),
            action_type: task_action_type_dto(&decoded.action_type),
            activity: task_activity_dto(&decoded.activity),
            assignment_intent: decoded.assignment_intent,
            agent_ready: decoded.agent_ready,
            required_context_refs: decoded.required_context_refs,
            allowed_actions: decoded
                .allowed_actions
                .iter()
                .map(task_action_type_dto)
                .collect(),
            stop_conditions: decoded.stop_conditions,
            validation_commands: decoded.validation_commands,
            blocked_reason: match decoded.activity {
                TaskStorageActivityState::Blocked { reason } => Some(reason),
                _ => None,
            },
            revision_id: record.revision_id.0.clone(),
        })
    }
}

fn task_importance_dto(importance: &TaskStorageImportance) -> String {
    match importance {
        TaskStorageImportance::Low => "low",
        TaskStorageImportance::Normal => "normal",
        TaskStorageImportance::High => "high",
        TaskStorageImportance::Critical => "critical",
    }
    .to_owned()
}

fn task_action_type_dto(action_type: &TaskStorageActionType) -> String {
    match action_type {
        TaskStorageActionType::Research => "research",
        TaskStorageActionType::Plan => "plan",
        TaskStorageActionType::Execute => "execute",
        TaskStorageActionType::Test => "test",
        TaskStorageActionType::Check => "check",
        TaskStorageActionType::Review => "review",
    }
    .to_owned()
}

fn task_activity_dto(activity: &TaskStorageActivityState) -> String {
    match activity {
        TaskStorageActivityState::Proposed => "proposed",
        TaskStorageActivityState::Ready => "ready",
        TaskStorageActivityState::Active => "active",
        TaskStorageActivityState::Blocked { .. } => "blocked",
        TaskStorageActivityState::Done => "done",
        TaskStorageActivityState::Archived => "archived",
    }
    .to_owned()
}
