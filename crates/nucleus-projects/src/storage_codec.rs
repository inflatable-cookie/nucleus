//! Versioned JSON storage for server-owned project records.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::{
    ImportanceLevel, ManagementProjectionTarget, Project, ProjectResource, ProjectResourceKind,
    ProjectResourceRole, ProjectRetention, ProjectStatus, ResourceLocationStatus,
    WorkingResourceTarget,
};

pub const PROJECT_STORAGE_SCHEMA_VERSION: u16 = 2;

/// Complete server-owned project record used by current storage.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProjectStorageRecord {
    pub schema_version: u16,
    pub project_id: String,
    pub display_name: String,
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

impl From<&Project> for ProjectStorageRecord {
    fn from(project: &Project) -> Self {
        Self {
            schema_version: PROJECT_STORAGE_SCHEMA_VERSION,
            project_id: project.id.0.clone(),
            display_name: project.display_name.clone(),
            status: (&project.status).into(),
            retention: (&project.retention).into(),
            importance_level: (&project.importance_baseline.level).into(),
            resources: project.resources.iter().map(Into::into).collect(),
            default_working_resource: project.default_working_resource.as_ref().map(Into::into),
            management_projection: project.management_projection.as_ref().map(Into::into),
        }
    }
}

impl From<&ProjectResource> for ProjectResourceStorageRecord {
    fn from(resource: &ProjectResource) -> Self {
        Self {
            resource_id: resource.id.0.clone(),
            project_id: resource.project_id.0.clone(),
            display_name: resource.display_name.clone(),
            kind: (&resource.kind).into(),
            role: (&resource.role).into(),
            authority_host_ref: resource.authority_host_ref.clone(),
            current_locator: resource
                .current_locator
                .as_ref()
                .map(|locator| locator.to_string_lossy().into_owned()),
            locator_history: resource
                .locator_history
                .iter()
                .map(|record| ProjectResourceLocatorStorageRecord {
                    locator: record.locator.to_string_lossy().into_owned(),
                    observed_at_unix_ms: record.observed_at.and_then(system_time_to_unix_ms),
                    note: record.note.clone(),
                })
                .collect(),
            git: resource
                .git
                .as_ref()
                .map(|git| GitRemoteMetadataStorageRecord {
                    remote_name: git.remote_name.clone(),
                    remote_url: git.remote_url.clone(),
                    repository_id_hint: git.repository_id_hint.clone(),
                }),
            default_branch: resource.default_branch.clone(),
            location_status: (&resource.location_status).into(),
            repair_notes: resource.repair_notes.clone(),
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

impl From<&ProjectRetention> for ProjectRetentionStorage {
    fn from(retention: &ProjectRetention) -> Self {
        match retention {
            ProjectRetention::Transient => Self::Transient,
            ProjectRetention::Durable => Self::Durable,
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

impl From<&ProjectResourceKind> for ProjectResourceStorageKind {
    fn from(kind: &ProjectResourceKind) -> Self {
        match kind {
            ProjectResourceKind::FilesystemFolder => Self::FilesystemFolder,
            ProjectResourceKind::GitRepository => Self::GitRepository,
        }
    }
}

impl From<&ProjectResourceRole> for ProjectResourceStorageRole {
    fn from(role: &ProjectResourceRole) -> Self {
        match role {
            ProjectResourceRole::Working => Self::Working,
            ProjectResourceRole::Management => Self::Management,
            ProjectResourceRole::Reference => Self::Reference,
        }
    }
}

impl From<&ResourceLocationStatus> for ProjectResourceStorageLocationStatus {
    fn from(status: &ResourceLocationStatus) -> Self {
        match status {
            ResourceLocationStatus::Present => Self::Present,
            ResourceLocationStatus::Missing => Self::Missing,
            ResourceLocationStatus::MovedCandidate(locator) => Self::MovedCandidate {
                locator: locator.to_string_lossy().into_owned(),
            },
            ResourceLocationStatus::RepairRequired => Self::RepairRequired,
        }
    }
}

impl From<&WorkingResourceTarget> for WorkingResourceStorageRecord {
    fn from(target: &WorkingResourceTarget) -> Self {
        Self {
            resource_id: target.resource_id.0.clone(),
            relative_working_directory: target
                .relative_working_directory
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
        }
    }
}

impl From<&ManagementProjectionTarget> for ManagementProjectionStorageRecord {
    fn from(target: &ManagementProjectionTarget) -> Self {
        Self {
            resource_id: target.resource_id.0.clone(),
            sync_policy_ref: target.sync_policy_ref.clone(),
        }
    }
}

/// Legacy v1 record. It is decoded only to migrate existing local state.
#[derive(Deserialize)]
struct LegacyProjectStorageRecord {
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
    fn migrate(self) -> ProjectStorageRecord {
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
            status: self.status,
            retention: ProjectRetentionStorage::Durable,
            importance_level: self.importance_level,
            resources,
            default_working_resource,
            management_projection: None,
        }
    }
}

fn migrate_legacy_location(status: &LegacyLocationStatus) -> ProjectResourceStorageLocationStatus {
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

pub fn encode_project_storage_record(
    project: &Project,
) -> Result<Vec<u8>, ProjectRecordCodecError> {
    encode_project_storage_payload(&ProjectStorageRecord::from(project))
}

pub fn encode_project_storage_payload(
    record: &ProjectStorageRecord,
) -> Result<Vec<u8>, ProjectRecordCodecError> {
    if record.schema_version != PROJECT_STORAGE_SCHEMA_VERSION {
        return Err(ProjectRecordCodecError {
            reason: format!(
                "unsupported project storage schema version: {}",
                record.schema_version
            ),
        });
    }
    serde_json::to_vec(record).map_err(codec_error)
}

pub fn decode_project_storage_record(
    bytes: &[u8],
) -> Result<ProjectStorageRecord, ProjectRecordCodecError> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(codec_error)?;
    if let Some(schema_version) = value.get("schema_version") {
        if schema_version.as_u64() != Some(u64::from(PROJECT_STORAGE_SCHEMA_VERSION)) {
            return Err(ProjectRecordCodecError {
                reason: format!(
                    "unsupported project storage schema version: {}",
                    schema_version
                ),
            });
        }
        serde_json::from_value(value).map_err(codec_error)
    } else {
        serde_json::from_value::<LegacyProjectStorageRecord>(value)
            .map(LegacyProjectStorageRecord::migrate)
            .map_err(codec_error)
    }
}

fn system_time_to_unix_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn codec_error(error: serde_json::Error) -> ProjectRecordCodecError {
    ProjectRecordCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use crate::{
        GitRemoteMetadata, ImportanceBaseline, ImportanceLevel, ManagementProjectionTarget,
        Project, ProjectActivity, ProjectId, ProjectResource, ProjectResourceId,
        ProjectResourceKind, ProjectResourceRole, ProjectRetention, ProjectStatus,
        ResourceLocationStatus, ResourceLocatorRecord, WorkingResourceTarget,
    };

    use super::*;

    fn project(resources: Vec<ProjectResource>) -> Project {
        Project {
            id: ProjectId("project:nucleus".to_owned()),
            display_name: "Nucleus".to_owned(),
            status: ProjectStatus::Active,
            retention: ProjectRetention::Durable,
            importance_baseline: ImportanceBaseline {
                level: ImportanceLevel::High,
                notes: Some("foundation".to_owned()),
            },
            default_working_resource: resources.first().map(|resource| WorkingResourceTarget {
                resource_id: resource.id.clone(),
                relative_working_directory: None,
            }),
            management_projection: resources
                .iter()
                .find(|resource| resource.kind == ProjectResourceKind::GitRepository)
                .map(|resource| ManagementProjectionTarget {
                    resource_id: resource.id.clone(),
                    sync_policy_ref: Some("manual".to_owned()),
                }),
            resources,
            task_ids: Vec::new(),
            workspace_layout_refs: Vec::new(),
            activity: ProjectActivity {
                created_at: None,
                last_focused_at: None,
                last_agent_activity_at: None,
                last_task_activity_at: None,
            },
        }
    }

    #[test]
    fn zero_resource_project_round_trips() {
        let bytes = encode_project_storage_record(&project(Vec::new())).expect("encode project");
        let decoded = decode_project_storage_record(&bytes).expect("decode project");

        assert_eq!(decoded.schema_version, PROJECT_STORAGE_SCHEMA_VERSION);
        assert_eq!(decoded.retention, ProjectRetentionStorage::Durable);
        assert!(decoded.resources.is_empty());
        assert_eq!(decoded.primary_location(), None);
        assert_eq!(
            decoded.location_status(),
            ProjectStorageLocationStatus::NotRecorded
        );
    }

    #[test]
    fn resource_metadata_and_defaults_round_trip() {
        let resource = ProjectResource {
            id: ProjectResourceId("resource:nucleus".to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            display_name: "Nucleus repository".to_owned(),
            kind: ProjectResourceKind::GitRepository,
            role: ProjectResourceRole::Working,
            authority_host_ref: "host:local".to_owned(),
            current_locator: Some(PathBuf::from("/tmp/nucleus")),
            locator_history: vec![ResourceLocatorRecord {
                locator: PathBuf::from("/old/nucleus"),
                observed_at: Some(UNIX_EPOCH + Duration::from_secs(10)),
                note: Some("moved".to_owned()),
            }],
            git: Some(GitRemoteMetadata {
                remote_name: Some("origin".to_owned()),
                remote_url: Some("git@example.com:nucleus.git".to_owned()),
                repository_id_hint: Some("nucleus".to_owned()),
            }),
            default_branch: Some("main".to_owned()),
            location_status: ResourceLocationStatus::Present,
            repair_notes: vec!["verified".to_owned()],
        };

        let decoded = decode_project_storage_record(
            &encode_project_storage_record(&project(vec![resource])).expect("encode project"),
        )
        .expect("decode project");

        assert_eq!(decoded.repo_count(), 1);
        assert_eq!(decoded.primary_location(), Some("/tmp/nucleus"));
        assert_eq!(
            decoded.resources[0].locator_history[0].observed_at_unix_ms,
            Some(10_000)
        );
        assert_eq!(decoded.resources[0].repair_notes, vec!["verified"]);
        assert_eq!(
            decoded
                .management_projection
                .as_ref()
                .map(|target| target.resource_id.as_str()),
            Some("resource:nucleus")
        );
    }

    #[test]
    fn folder_and_git_resources_round_trip_without_conflating_repo_count() {
        let folder = ProjectResource {
            id: ProjectResourceId("resource:docs".to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            display_name: "Documentation".to_owned(),
            kind: ProjectResourceKind::FilesystemFolder,
            role: ProjectResourceRole::Working,
            authority_host_ref: "host:remote-build".to_owned(),
            current_locator: Some(PathBuf::from("/srv/docs")),
            locator_history: Vec::new(),
            git: None,
            default_branch: None,
            location_status: ResourceLocationStatus::Present,
            repair_notes: Vec::new(),
        };
        let repository = ProjectResource {
            id: ProjectResourceId("resource:api".to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            display_name: "API".to_owned(),
            kind: ProjectResourceKind::GitRepository,
            role: ProjectResourceRole::Reference,
            authority_host_ref: "host:remote-build".to_owned(),
            current_locator: None,
            locator_history: Vec::new(),
            git: None,
            default_branch: Some("main".to_owned()),
            location_status: ResourceLocationStatus::Missing,
            repair_notes: vec!["checkout not attached".to_owned()],
        };

        let decoded = decode_project_storage_record(
            &encode_project_storage_record(&project(vec![folder, repository]))
                .expect("encode project"),
        )
        .expect("decode project");

        assert_eq!(decoded.resources.len(), 2);
        assert_eq!(decoded.repo_count(), 1);
        assert_eq!(decoded.primary_location(), Some("/srv/docs"));
        assert_eq!(decoded.resources[0].authority_host_ref, "host:remote-build");
        assert_eq!(
            decoded.location_status(),
            ProjectStorageLocationStatus::Mixed
        );
    }

    #[test]
    fn legacy_display_record_migrates_without_changing_project_id() {
        let bytes = br#"{"project_id":"project:legacy","display_name":"Legacy","status":"active","importance_level":"normal","repo_count":1,"primary_location":"/tmp/legacy","location_status":"present"}"#;
        let decoded = decode_project_storage_record(bytes).expect("decode legacy project");

        assert_eq!(decoded.schema_version, PROJECT_STORAGE_SCHEMA_VERSION);
        assert_eq!(decoded.project_id, "project:legacy");
        assert_eq!(decoded.retention, ProjectRetentionStorage::Durable);
        assert_eq!(decoded.repo_count(), 1);
        assert_eq!(decoded.primary_location(), Some("/tmp/legacy"));
    }

    #[test]
    fn future_project_storage_schema_fails_closed() {
        let bytes = br#"{"schema_version":99,"project_id":"project:future"}"#;
        let error = decode_project_storage_record(bytes).expect_err("future schema");

        assert!(error
            .reason
            .contains("unsupported project storage schema version"));
    }
}
