//! JSON storage codec for first project records.

use serde::{Deserialize, Serialize};

use crate::{ImportanceLevel, Project, ProjectStatus};

/// Display-ready project record stored as server-owned JSON payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProjectStorageRecord {
    pub project_id: String,
    pub display_name: String,
    pub status: ProjectStorageStatus,
    pub importance_level: ProjectStorageImportanceLevel,
}

/// Serializable project lifecycle state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStorageStatus {
    Active,
    Parked,
    Archived,
}

/// Serializable project importance baseline.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStorageImportanceLevel {
    Low,
    Normal,
    High,
    Critical,
}

/// Project record codec error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectRecordCodecError {
    pub reason: String,
}

impl From<&Project> for ProjectStorageRecord {
    fn from(project: &Project) -> Self {
        Self {
            project_id: project.id.0.clone(),
            display_name: project.display_name.clone(),
            status: ProjectStorageStatus::from(&project.status),
            importance_level: ProjectStorageImportanceLevel::from(
                &project.importance_baseline.level,
            ),
        }
    }
}

impl From<&ProjectStatus> for ProjectStorageStatus {
    fn from(status: &ProjectStatus) -> Self {
        match status {
            ProjectStatus::Active => Self::Active,
            ProjectStatus::Parked => Self::Parked,
            ProjectStatus::Archived => Self::Archived,
        }
    }
}

impl From<&ImportanceLevel> for ProjectStorageImportanceLevel {
    fn from(level: &ImportanceLevel) -> Self {
        match level {
            ImportanceLevel::Low => Self::Low,
            ImportanceLevel::Normal => Self::Normal,
            ImportanceLevel::High => Self::High,
            ImportanceLevel::Critical => Self::Critical,
        }
    }
}

/// Encode a project into the first JSON storage payload.
pub fn encode_project_storage_record(
    project: &Project,
) -> Result<Vec<u8>, ProjectRecordCodecError> {
    serde_json::to_vec(&ProjectStorageRecord::from(project)).map_err(codec_error)
}

/// Encode an already decoded project storage record.
pub fn encode_project_storage_payload(
    record: &ProjectStorageRecord,
) -> Result<Vec<u8>, ProjectRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode the first JSON storage payload into a display-ready record.
pub fn decode_project_storage_record(
    bytes: &[u8],
) -> Result<ProjectStorageRecord, ProjectRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

fn codec_error(error: serde_json::Error) -> ProjectRecordCodecError {
    ProjectRecordCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        ImportanceBaseline, ImportanceLevel, Project, ProjectActivity, ProjectId, ProjectStatus,
    };

    use super::*;

    #[test]
    fn project_storage_codec_preserves_display_fields() {
        let project = Project {
            id: ProjectId("project:nucleus".to_owned()),
            display_name: "Nucleus".to_owned(),
            status: ProjectStatus::Active,
            importance_baseline: ImportanceBaseline {
                level: ImportanceLevel::High,
                notes: Some("foundation".to_owned()),
            },
            repos: Vec::new(),
            task_ids: Vec::new(),
            workspace_layout_refs: Vec::new(),
            activity: ProjectActivity {
                created_at: None,
                last_focused_at: None,
                last_agent_activity_at: None,
                last_task_activity_at: None,
            },
        };

        let bytes = encode_project_storage_record(&project).expect("encode project");
        let decoded = decode_project_storage_record(&bytes).expect("decode project");

        assert_eq!(decoded.project_id, "project:nucleus");
        assert_eq!(decoded.display_name, "Nucleus");
        assert_eq!(decoded.status, ProjectStorageStatus::Active);
        assert_eq!(
            decoded.importance_level,
            ProjectStorageImportanceLevel::High
        );
    }
}
