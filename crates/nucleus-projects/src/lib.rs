//! Durable project identity and repo membership types.
//!
//! This crate names the project boundary only. It does not implement storage,
//! path repair, repository scanning, or task scheduling yet.

use std::path::PathBuf;
use std::time::SystemTime;

pub mod projection;
pub mod storage_codec;

pub use projection::{ProjectProjectionRecord, RepoMembershipProjectionRecord};
pub use storage_codec::{
    decode_project_storage_record, encode_project_storage_payload, encode_project_storage_record,
    ProjectRecordCodecError, ProjectStorageImportanceLevel, ProjectStorageLocationStatus,
    ProjectStorageRecord, ProjectStorageStatus,
};

/// Stable nucleus project id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectId(pub String);

/// Stable repo membership id within a project.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RepoMembershipId(pub String);

/// Stable task reference owned by another crate.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectTaskId(pub String);

/// Durable project record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Project {
    pub id: ProjectId,
    pub display_name: String,
    pub status: ProjectStatus,
    pub importance_baseline: ImportanceBaseline,
    pub repos: Vec<RepoMembership>,
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

/// Repository membership inside a durable project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoMembership {
    pub id: RepoMembershipId,
    pub project_id: ProjectId,
    pub current_path: Option<PathBuf>,
    pub path_history: Vec<RepoPathRecord>,
    pub git: Option<GitRemoteMetadata>,
    pub default_branch: Option<String>,
    pub location_status: RepoLocationStatus,
    pub repair_notes: Vec<String>,
}

/// Historical path record for repo movement and repair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoPathRecord {
    pub path: PathBuf,
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

/// Repo location health from the project's point of view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RepoLocationStatus {
    Present,
    Missing,
    MovedCandidate(PathBuf),
    RepairRequired,
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

/// Repair action requested for a repo membership.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RepoRepairAction {
    LocateMovedRepo,
    UpdateCurrentPath(PathBuf),
    MarkUnresolved,
    AddRepairNote(String),
}
