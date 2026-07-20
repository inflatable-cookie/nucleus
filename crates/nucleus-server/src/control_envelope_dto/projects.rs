use serde::{Deserialize, Serialize};

use nucleus_core::{PersistenceDomain, PersistenceRecordKind, RevisionId};
use nucleus_local_store::LocalStoreRecord;
use nucleus_projects::{
    decode_project_storage_record, ProjectId, ProjectResourceId, ProjectResourceStorageKind,
    ProjectResourceStorageLocationStatus, ProjectResourceStorageRecord, ProjectResourceStorageRole,
    ProjectRetentionStorage, ProjectStorageImportanceLevel, ProjectStorageLocationStatus,
    ProjectStorageStatus,
};

use crate::project_resource_control::ProjectResourceMutationCandidate;

use super::ControlApiCodecError;

/// Sanitized project read model for control-plane clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProjectRecordDto {
    pub project_id: String,
    pub display_name: String,
    pub authority_host_ref: String,
    pub status: String,
    pub retention: String,
    pub importance_level: String,
    pub revision_id: String,
    #[ts(as = "u32")]
    pub resource_count: usize,
    #[ts(as = "u32")]
    pub repository_count: usize,
    pub default_working_resource_id: Option<String>,
    pub management_resource_id: Option<String>,
    pub management_sync_policy: Option<String>,
    pub management_projection_status: Option<String>,
    pub location_status: String,
    pub resources: Vec<ControlProjectResourceRecordDto>,
}

/// Resource identity and host health without host-local locator material.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProjectResourceRecordDto {
    pub resource_id: String,
    pub display_name: String,
    pub kind: String,
    pub role: String,
    pub authority_host_ref: String,
    pub location_status: String,
    pub locator_available: bool,
    pub default_branch: Option<String>,
    pub is_default_working_resource: bool,
    pub is_management_resource: bool,
}

/// Typed wire candidate. Unknown resource kinds fail during decoding.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProjectResourceMutationCandidateDto {
    pub project_id: String,
    pub resource_id: Option<String>,
    pub resource_kind: ControlProjectResourceKindDto,
    pub expected_revision: String,
    pub actor_ref: String,
    pub authority_host_ref: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlProjectResourceKindDto {
    FilesystemFolder,
    GitRepository,
}

impl TryFrom<&LocalStoreRecord> for ControlProjectRecordDto {
    type Error = ControlApiCodecError;

    fn try_from(record: &LocalStoreRecord) -> Result<Self, Self::Error> {
        if record.domain != PersistenceDomain::Projects
            || record.kind != PersistenceRecordKind::Project
        {
            return Err(ControlApiCodecError::unsupported(
                "project display DTO requires project records",
            ));
        }

        let decoded = decode_project_storage_record(&record.payload.bytes).map_err(|error| {
            ControlApiCodecError::malformed(format!(
                "project storage payload could not be decoded: {}",
                error.reason
            ))
        })?;
        let default_working_resource_id = decoded
            .default_working_resource
            .as_ref()
            .map(|target| target.resource_id.clone());
        let management_resource_id = decoded
            .management_projection
            .as_ref()
            .map(|target| target.resource_id.clone());
        let management_sync_policy = decoded
            .management_projection
            .as_ref()
            .and_then(|target| target.sync_policy_ref.as_deref())
            .and_then(sanitized_sync_policy);
        let management_projection_status = decoded
            .management_projection
            .as_ref()
            .map(|target| management_projection_status(&decoded, &target.resource_id));
        let resource_count = decoded.resources.len();
        let repository_count = decoded.repo_count();
        let location_status = project_location_status_dto(&decoded.location_status());
        let resources = decoded
            .resources
            .iter()
            .map(|resource| {
                project_resource_dto(
                    resource,
                    default_working_resource_id.as_deref(),
                    management_resource_id.as_deref(),
                )
            })
            .collect();

        Ok(Self {
            project_id: decoded.project_id,
            display_name: decoded.display_name,
            authority_host_ref: decoded.authority_host_ref,
            status: project_status_dto(&decoded.status),
            retention: project_retention_dto(&decoded.retention),
            importance_level: project_importance_dto(&decoded.importance_level),
            revision_id: record.revision_id.0.clone(),
            resource_count,
            repository_count,
            default_working_resource_id,
            management_resource_id,
            management_sync_policy,
            management_projection_status,
            location_status,
            resources,
        })
    }
}

fn management_projection_status(
    project: &nucleus_projects::ProjectStorageRecord,
    resource_id: &str,
) -> String {
    let Some(resource) = project.resource(resource_id) else {
        return "repair_required".to_owned();
    };
    if resource.kind != ProjectResourceStorageKind::GitRepository {
        return "repair_required".to_owned();
    }
    match resource.location_status {
        ProjectResourceStorageLocationStatus::Missing => "missing",
        ProjectResourceStorageLocationStatus::MovedCandidate { .. } => "moved_candidate",
        ProjectResourceStorageLocationStatus::RepairRequired => "repair_required",
        ProjectResourceStorageLocationStatus::Present => {
            if resource
                .current_locator
                .as_deref()
                .is_some_and(|locator| std::path::Path::new(locator).is_dir())
            {
                "ready"
            } else {
                "missing"
            }
        }
    }
    .to_owned()
}

fn sanitized_sync_policy(value: &str) -> Option<String> {
    matches!(value, "manual" | "assisted" | "automatic" | "reviewed").then(|| value.to_owned())
}

impl From<ControlProjectResourceMutationCandidateDto> for ProjectResourceMutationCandidate {
    fn from(candidate: ControlProjectResourceMutationCandidateDto) -> Self {
        Self {
            project_id: ProjectId(candidate.project_id),
            resource_id: candidate.resource_id.map(ProjectResourceId),
            resource_kind: match candidate.resource_kind {
                ControlProjectResourceKindDto::FilesystemFolder => {
                    nucleus_projects::ProjectResourceKind::FilesystemFolder
                }
                ControlProjectResourceKindDto::GitRepository => {
                    nucleus_projects::ProjectResourceKind::GitRepository
                }
            },
            expected_revision: RevisionId(candidate.expected_revision),
            actor_ref: candidate.actor_ref,
            authority_host_ref: candidate.authority_host_ref,
        }
    }
}

fn project_resource_dto(
    resource: &ProjectResourceStorageRecord,
    default_working_resource_id: Option<&str>,
    management_resource_id: Option<&str>,
) -> ControlProjectResourceRecordDto {
    ControlProjectResourceRecordDto {
        resource_id: resource.resource_id.clone(),
        display_name: resource.display_name.clone(),
        kind: project_resource_kind_dto(&resource.kind),
        role: project_resource_role_dto(&resource.role),
        authority_host_ref: resource.authority_host_ref.clone(),
        location_status: project_resource_location_status_dto(&resource.location_status),
        locator_available: resource.current_locator.is_some(),
        default_branch: resource.default_branch.clone(),
        is_default_working_resource: default_working_resource_id == Some(&resource.resource_id),
        is_management_resource: management_resource_id == Some(&resource.resource_id),
    }
}

fn project_status_dto(status: &ProjectStorageStatus) -> String {
    match status {
        ProjectStorageStatus::Active => "active",
        ProjectStorageStatus::Parked => "parked",
        ProjectStorageStatus::Archived => "archived",
    }
    .to_owned()
}

fn project_retention_dto(retention: &ProjectRetentionStorage) -> String {
    match retention {
        ProjectRetentionStorage::Transient => "transient",
        ProjectRetentionStorage::Durable => "durable",
    }
    .to_owned()
}

fn project_resource_kind_dto(kind: &ProjectResourceStorageKind) -> String {
    match kind {
        ProjectResourceStorageKind::FilesystemFolder => "filesystem_folder",
        ProjectResourceStorageKind::GitRepository => "git_repository",
    }
    .to_owned()
}

fn project_resource_role_dto(role: &ProjectResourceStorageRole) -> String {
    match role {
        ProjectResourceStorageRole::Working => "working",
        ProjectResourceStorageRole::Management => "management",
        ProjectResourceStorageRole::Reference => "reference",
    }
    .to_owned()
}

fn project_resource_location_status_dto(status: &ProjectResourceStorageLocationStatus) -> String {
    match status {
        ProjectResourceStorageLocationStatus::Present => "present",
        ProjectResourceStorageLocationStatus::Missing => "missing",
        ProjectResourceStorageLocationStatus::MovedCandidate { .. } => "moved_candidate",
        ProjectResourceStorageLocationStatus::RepairRequired => "repair_required",
    }
    .to_owned()
}

fn project_location_status_dto(status: &ProjectStorageLocationStatus) -> String {
    match status {
        ProjectStorageLocationStatus::NotRecorded => "not_recorded",
        ProjectStorageLocationStatus::Present => "present",
        ProjectStorageLocationStatus::Missing => "missing",
        ProjectStorageLocationStatus::MovedCandidate => "moved_candidate",
        ProjectStorageLocationStatus::RepairRequired => "repair_required",
        ProjectStorageLocationStatus::Mixed => "mixed",
    }
    .to_owned()
}

fn project_importance_dto(level: &ProjectStorageImportanceLevel) -> String {
    match level {
        ProjectStorageImportanceLevel::Low => "low",
        ProjectStorageImportanceLevel::Normal => "normal",
        ProjectStorageImportanceLevel::High => "high",
        ProjectStorageImportanceLevel::Critical => "critical",
    }
    .to_owned()
}
