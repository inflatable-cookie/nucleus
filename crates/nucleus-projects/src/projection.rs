//! Project and resource membership projection records.

use nucleus_core::ProjectionRecordEnvelope;

use crate::{
    GitRemoteMetadata, ImportanceBaseline, ProjectId, ProjectResourceId, ProjectResourceKind,
    ProjectResourceRole, ProjectStatus, ResourceLocationStatus, ResourceLocatorRecord,
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
    pub management_resource_id: Option<ProjectResourceId>,
    pub shared_documentation_refs: Vec<String>,
}

/// Committable resource membership record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectResourceProjectionRecord {
    pub envelope: ProjectionRecordEnvelope,
    pub resource_id: ProjectResourceId,
    pub project_id: ProjectId,
    pub display_name: String,
    pub kind: ProjectResourceKind,
    pub role: ProjectResourceRole,
    pub authority_host_ref: String,
    pub git: Option<GitRemoteMetadata>,
    pub default_branch: Option<String>,
    pub current_locator_hint: Option<String>,
    pub locator_history: Vec<ResourceLocatorRecord>,
    pub location_status: ResourceLocationStatus,
    pub repair_notes: Vec<String>,
}
