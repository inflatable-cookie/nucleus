//! Project and repo membership projection records.

use nucleus_core::ProjectionRecordEnvelope;

use crate::{
    GitRemoteMetadata, ImportanceBaseline, ProjectId, ProjectStatus, RepoLocationStatus,
    RepoMembershipId, RepoPathRecord,
};

/// Committable project metadata record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectProjectionRecord {
    pub envelope: ProjectionRecordEnvelope,
    pub project_id: ProjectId,
    pub display_name: String,
    pub status: ProjectStatus,
    pub importance_baseline: ImportanceBaseline,
    pub sync_policy_ref: Option<String>,
    pub management_repo_marker: Option<String>,
    pub shared_documentation_refs: Vec<String>,
}

/// Committable repo membership record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoMembershipProjectionRecord {
    pub envelope: ProjectionRecordEnvelope,
    pub repo_membership_id: RepoMembershipId,
    pub project_id: ProjectId,
    pub display_name: Option<String>,
    pub git: Option<GitRemoteMetadata>,
    pub default_branch: Option<String>,
    pub role_or_purpose: Option<String>,
    pub current_path_hint: Option<String>,
    pub path_history: Vec<RepoPathRecord>,
    pub location_status: RepoLocationStatus,
    pub repair_notes: Vec<String>,
}
