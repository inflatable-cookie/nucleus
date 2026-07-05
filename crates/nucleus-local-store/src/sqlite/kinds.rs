use nucleus_core::PersistenceRecordKind;

use crate::{LocalStoreError, LocalStoreResult};

pub(super) fn kind_to_text(kind: &PersistenceRecordKind) -> Option<&'static str> {
    match kind {
        PersistenceRecordKind::Project => Some("project"),
        PersistenceRecordKind::RepoMembership => Some("repo_membership"),
        PersistenceRecordKind::Task => Some("task"),
        PersistenceRecordKind::TaskHistoryEntry => Some("task_history_entry"),
        PersistenceRecordKind::SharedMemoryRecord => Some("shared_memory_record"),
        PersistenceRecordKind::PlanningSession => Some("planning_session"),
        PersistenceRecordKind::PlanningArtifact => Some("planning_artifact"),
        PersistenceRecordKind::PlanningImportApplyPlan => Some("planning_import_apply_plan"),
        PersistenceRecordKind::PlanningImportActiveApplyAdmission => {
            Some("planning_import_active_apply_admission")
        }
        PersistenceRecordKind::TaskSeed => Some("task_seed"),
        PersistenceRecordKind::ResearchRun => Some("research_run"),
        PersistenceRecordKind::WorkspaceLayout => Some("workspace_layout"),
        PersistenceRecordKind::AdapterInstance => Some("adapter_instance"),
        PersistenceRecordKind::AgentSession => Some("agent_session"),
        PersistenceRecordKind::ModelRoute => Some("model_route"),
        PersistenceRecordKind::Event => Some("event"),
        PersistenceRecordKind::CommandEvidence => Some("command_evidence"),
        PersistenceRecordKind::ArtifactMetadata => Some("artifact_metadata"),
        PersistenceRecordKind::RuntimeEffect => Some("runtime_effect"),
        _ => None,
    }
}

pub(super) fn kind_from_text(value: &str) -> LocalStoreResult<PersistenceRecordKind> {
    match value {
        "project" => Ok(PersistenceRecordKind::Project),
        "repo_membership" => Ok(PersistenceRecordKind::RepoMembership),
        "task" => Ok(PersistenceRecordKind::Task),
        "task_history_entry" => Ok(PersistenceRecordKind::TaskHistoryEntry),
        "shared_memory_record" => Ok(PersistenceRecordKind::SharedMemoryRecord),
        "planning_session" => Ok(PersistenceRecordKind::PlanningSession),
        "planning_artifact" => Ok(PersistenceRecordKind::PlanningArtifact),
        "planning_import_apply_plan" => Ok(PersistenceRecordKind::PlanningImportApplyPlan),
        "planning_import_active_apply_admission" => {
            Ok(PersistenceRecordKind::PlanningImportActiveApplyAdmission)
        }
        "task_seed" => Ok(PersistenceRecordKind::TaskSeed),
        "research_run" => Ok(PersistenceRecordKind::ResearchRun),
        "workspace_layout" => Ok(PersistenceRecordKind::WorkspaceLayout),
        "adapter_instance" => Ok(PersistenceRecordKind::AdapterInstance),
        "agent_session" => Ok(PersistenceRecordKind::AgentSession),
        "model_route" => Ok(PersistenceRecordKind::ModelRoute),
        "event" => Ok(PersistenceRecordKind::Event),
        "command_evidence" => Ok(PersistenceRecordKind::CommandEvidence),
        "artifact_metadata" => Ok(PersistenceRecordKind::ArtifactMetadata),
        "runtime_effect" => Ok(PersistenceRecordKind::RuntimeEffect),
        other => Err(LocalStoreError::UnsupportedRecordKind {
            reason: format!("unsupported SQLite record kind in row: {other}"),
        }),
    }
}
