//! Project storage record types: the schema-versioned record, resource
//! records, enums, and derived accessors.
//!
//! Split from the storage_codec god file; behavior unchanged.

use serde::{Deserialize, Serialize};

pub const PROJECT_STORAGE_SCHEMA_VERSION: u16 = 3;

/// Complete server-owned project record used by current storage.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProjectStorageRecord {
    pub schema_version: u16,
    pub project_id: String,
    pub display_name: String,
    #[serde(default = "default_project_authority_host_ref")]
    pub authority_host_ref: String,
    pub status: ProjectStorageStatus,
    pub retention: ProjectRetentionStorage,
    pub importance_level: ProjectStorageImportanceLevel,
    #[serde(default)]
    pub resources: Vec<ProjectResourceStorageRecord>,
    pub default_working_resource: Option<WorkingResourceStorageRecord>,
    pub management_projection: Option<ManagementProjectionStorageRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProjectResourceStorageRecord {
    pub resource_id: String,
    pub project_id: String,
    pub display_name: String,
    pub kind: ProjectResourceStorageKind,
    pub role: ProjectResourceStorageRole,
    pub authority_host_ref: String,
    pub current_locator: Option<String>,
    #[serde(default)]
    pub locator_history: Vec<ProjectResourceLocatorStorageRecord>,
    pub git: Option<GitRemoteMetadataStorageRecord>,
    pub default_branch: Option<String>,
    pub location_status: ProjectResourceStorageLocationStatus,
    #[serde(default)]
    pub repair_notes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProjectResourceLocatorStorageRecord {
    pub locator: String,
    pub observed_at_unix_ms: Option<u64>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitRemoteMetadataStorageRecord {
    pub remote_name: Option<String>,
    pub remote_url: Option<String>,
    pub repository_id_hint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkingResourceStorageRecord {
    pub resource_id: String,
    pub relative_working_directory: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionStorageRecord {
    pub resource_id: String,
    pub sync_policy_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStorageStatus {
    Active,
    Parked,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRetentionStorage {
    Transient,
    Durable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStorageImportanceLevel {
    Low,
    Normal,
    High,
    Critical,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectResourceStorageKind {
    FilesystemFolder,
    GitRepository,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectResourceStorageRole {
    Working,
    Management,
    Reference,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectResourceStorageLocationStatus {
    Present,
    Missing,
    MovedCandidate { locator: String },
    RepairRequired,
}

/// Derived summary retained for current read-only clients.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectStorageLocationStatus {
    NotRecorded,
    Present,
    Missing,
    MovedCandidate,
    RepairRequired,
    Mixed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectRecordCodecError {
    pub reason: String,
}

impl ProjectStorageRecord {
    pub fn repo_count(&self) -> usize {
        self.resources
            .iter()
            .filter(|resource| resource.kind == ProjectResourceStorageKind::GitRepository)
            .count()
    }

    pub fn primary_location(&self) -> Option<&str> {
        self.default_working_resource
            .as_ref()
            .and_then(|target| self.resource(&target.resource_id))
            .and_then(|resource| resource.current_locator.as_deref())
            .or_else(|| {
                self.resources
                    .iter()
                    .find(|resource| resource.role == ProjectResourceStorageRole::Working)
                    .and_then(|resource| resource.current_locator.as_deref())
            })
    }

    pub fn location_status(&self) -> ProjectStorageLocationStatus {
        let mut statuses = self
            .resources
            .iter()
            .map(|resource| &resource.location_status);
        let Some(first) = statuses.next() else {
            return ProjectStorageLocationStatus::NotRecorded;
        };
        if statuses.any(|status| status != first) {
            return ProjectStorageLocationStatus::Mixed;
        }
        match first {
            ProjectResourceStorageLocationStatus::Present => ProjectStorageLocationStatus::Present,
            ProjectResourceStorageLocationStatus::Missing => ProjectStorageLocationStatus::Missing,
            ProjectResourceStorageLocationStatus::MovedCandidate { .. } => {
                ProjectStorageLocationStatus::MovedCandidate
            }
            ProjectResourceStorageLocationStatus::RepairRequired => {
                ProjectStorageLocationStatus::RepairRequired
            }
        }
    }

    pub fn resource(&self, resource_id: &str) -> Option<&ProjectResourceStorageRecord> {
        self.resources
            .iter()
            .find(|resource| resource.resource_id == resource_id)
    }
}

pub(super) fn default_project_authority_host_ref() -> String {
    "host:local".to_owned()
}
