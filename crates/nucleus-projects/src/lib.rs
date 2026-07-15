//! Durable project identity, lifecycle, and resource membership types.
//!
//! Projects are logical work scopes. Filesystem folders and Git repositories
//! are optional host-owned resources rather than project identity.

use std::path::PathBuf;
use std::time::SystemTime;

pub mod projection;
pub mod storage_codec;

pub use projection::{ProjectProjectionRecord, ProjectResourceProjectionRecord};
pub use storage_codec::{
    decode_project_storage_record, encode_project_storage_payload, encode_project_storage_record,
    GitRemoteMetadataStorageRecord, ManagementProjectionStorageRecord, ProjectRecordCodecError,
    ProjectResourceLocatorStorageRecord, ProjectResourceStorageKind,
    ProjectResourceStorageLocationStatus, ProjectResourceStorageRecord, ProjectResourceStorageRole,
    ProjectRetentionStorage, ProjectStorageImportanceLevel, ProjectStorageLocationStatus,
    ProjectStorageRecord, ProjectStorageStatus, WorkingResourceStorageRecord,
    PROJECT_STORAGE_SCHEMA_VERSION,
};

/// Stable Nucleus project id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectId(pub String);

/// Stable resource membership id within a project.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectResourceId(pub String);

/// Stable task reference owned by another crate.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectTaskId(pub String);

/// Durable project record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Project {
    pub id: ProjectId,
    pub display_name: String,
    pub authority_host_ref: String,
    pub status: ProjectStatus,
    pub retention: ProjectRetention,
    pub importance_baseline: ImportanceBaseline,
    pub resources: Vec<ProjectResource>,
    pub default_working_resource: Option<WorkingResourceTarget>,
    pub management_projection: Option<ManagementProjectionTarget>,
    pub task_ids: Vec<ProjectTaskId>,
    pub workspace_layout_refs: Vec<WorkspaceLayoutRef>,
    pub activity: ProjectActivity,
}

/// Project visibility and lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectStatus {
    Active,
    Parked,
    Archived,
}

/// Host retention policy for a project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectRetention {
    Transient,
    Durable,
}

/// Project-level importance baseline.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportanceBaseline {
    pub level: ImportanceLevel,
    pub notes: Option<String>,
}

/// Coarse importance level before scoring policy exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImportanceLevel {
    Low,
    Normal,
    High,
    Critical,
}

/// Host-owned resource attached to a project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectResource {
    pub id: ProjectResourceId,
    pub project_id: ProjectId,
    pub display_name: String,
    pub kind: ProjectResourceKind,
    pub role: ProjectResourceRole,
    pub authority_host_ref: String,
    pub current_locator: Option<PathBuf>,
    pub locator_history: Vec<ResourceLocatorRecord>,
    pub git: Option<GitRemoteMetadata>,
    pub default_branch: Option<String>,
    pub location_status: ResourceLocationStatus,
    pub repair_notes: Vec<String>,
}

/// Initial resource capabilities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectResourceKind {
    FilesystemFolder,
    GitRepository,
}

/// Portable purpose of a project resource.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectResourceRole {
    Working,
    Management,
    Reference,
}

/// Historical host-local locator for resource movement and repair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceLocatorRecord {
    pub locator: PathBuf,
    pub observed_at: Option<SystemTime>,
    pub note: Option<String>,
}

/// Git metadata captured when available.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRemoteMetadata {
    pub remote_name: Option<String>,
    pub remote_url: Option<String>,
    pub repository_id_hint: Option<String>,
}

/// Resource location health from the authoritative host's point of view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResourceLocationStatus {
    Present,
    Missing,
    MovedCandidate(PathBuf),
    RepairRequired,
}

/// Default target for filesystem-dependent work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkingResourceTarget {
    pub resource_id: ProjectResourceId,
    pub relative_working_directory: Option<PathBuf>,
}

/// Optional portable shared-state projection target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionTarget {
    pub resource_id: ProjectResourceId,
    pub sync_policy_ref: Option<String>,
}

/// Reference to persisted workspace layout state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceLayoutRef {
    pub layout_id: String,
    pub label: Option<String>,
}

/// Project-level activity timestamps.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectActivity {
    pub created_at: Option<SystemTime>,
    pub last_focused_at: Option<SystemTime>,
    pub last_agent_activity_at: Option<SystemTime>,
    pub last_task_activity_at: Option<SystemTime>,
}

/// Repair action requested for a resource membership.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResourceRepairAction {
    LocateMovedResource,
    UpdateCurrentLocator(PathBuf),
    MarkUnresolved,
    AddRepairNote(String),
}
