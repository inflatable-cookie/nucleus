//! Legacy v1 project record migration.
//!
//! Split from the storage_codec god file; behavior unchanged.

use serde::Deserialize;

use super::types::{
    default_project_authority_host_ref, ProjectResourceStorageKind,
    ProjectResourceStorageLocationStatus, ProjectResourceStorageRecord,
    ProjectResourceStorageRole, ProjectRetentionStorage, ProjectStorageImportanceLevel,
    ProjectStorageRecord, ProjectStorageStatus, WorkingResourceStorageRecord,
    PROJECT_STORAGE_SCHEMA_VERSION,
};

/// Legacy v1 record. It is decoded only to migrate existing local state.
#[derive(Deserialize)]
pub(super) struct LegacyProjectStorageRecord {
    project_id: String,
    display_name: String,
    status: ProjectStorageStatus,
    importance_level: ProjectStorageImportanceLevel,
    #[serde(default)]
    repo_count: usize,
    #[serde(default)]
    primary_location: Option<String>,
    #[serde(default)]
    location_status: LegacyLocationStatus,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum LegacyLocationStatus {
    #[default]
    NotRecorded,
    Present,
    Missing,
    MovedCandidate,
    RepairRequired,
    Mixed,
}

impl LegacyProjectStorageRecord {
    pub(super) fn migrate(self) -> ProjectStorageRecord {
        let mut resources = Vec::new();
        for index in 0..self
            .repo_count
            .max(usize::from(self.primary_location.is_some()))
        {
            let current_locator = (index == 0)
                .then(|| self.primary_location.clone())
                .flatten();
            resources.push(ProjectResourceStorageRecord {
                resource_id: format!("resource:legacy:{}:{}", self.project_id, index + 1),
                project_id: self.project_id.clone(),
                display_name: if index == 0 {
                    self.display_name.clone()
                } else {
                    format!("{} repository {}", self.display_name, index + 1)
                },
                kind: ProjectResourceStorageKind::GitRepository,
                role: ProjectResourceStorageRole::Working,
                authority_host_ref: "host:local".to_owned(),
                current_locator,
                locator_history: Vec::new(),
                git: None,
                default_branch: None,
                location_status: migrate_legacy_location(&self.location_status),
                repair_notes: vec!["migrated from project storage schema v1".to_owned()],
            });
        }
        let default_working_resource =
            resources
                .first()
                .map(|resource| WorkingResourceStorageRecord {
                    resource_id: resource.resource_id.clone(),
                    relative_working_directory: None,
                });
        ProjectStorageRecord {
            schema_version: PROJECT_STORAGE_SCHEMA_VERSION,
            project_id: self.project_id,
            display_name: self.display_name,
            authority_host_ref: default_project_authority_host_ref(),
            status: self.status,
            retention: ProjectRetentionStorage::Durable,
            importance_level: self.importance_level,
            resources,
            default_working_resource,
            management_projection: None,
        }
    }
}

fn migrate_legacy_location(
    status: &LegacyLocationStatus,
) -> ProjectResourceStorageLocationStatus {
    match status {
        LegacyLocationStatus::Present => ProjectResourceStorageLocationStatus::Present,
        LegacyLocationStatus::Missing | LegacyLocationStatus::NotRecorded => {
            ProjectResourceStorageLocationStatus::Missing
        }
        LegacyLocationStatus::MovedCandidate => {
            ProjectResourceStorageLocationStatus::RepairRequired
        }
        LegacyLocationStatus::RepairRequired | LegacyLocationStatus::Mixed => {
            ProjectResourceStorageLocationStatus::RepairRequired
        }
    }
}
