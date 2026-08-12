//! Domain-to-storage record conversions.
//!
//! Split from the storage_codec god file; behavior unchanged.

use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{
    GitRemoteMetadataStorageRecord, ManagementProjectionStorageRecord,
    ProjectResourceLocatorStorageRecord, ProjectResourceStorageKind,
    ProjectResourceStorageLocationStatus, ProjectResourceStorageRecord,
    ProjectResourceStorageRole, ProjectRetentionStorage, ProjectStorageImportanceLevel,
    ProjectStorageRecord, ProjectStorageStatus, WorkingResourceStorageRecord,
};
use crate::{
    ImportanceLevel, ManagementProjectionTarget, Project, ProjectResource, ProjectResourceKind,
    ProjectResourceRole, ProjectRetention, ProjectStatus, ResourceLocationStatus,
    WorkingResourceTarget,
};

impl From<&Project> for ProjectStorageRecord {
    fn from(project: &Project) -> Self {
        Self {
            schema_version: super::types::PROJECT_STORAGE_SCHEMA_VERSION,
            project_id: project.id.0.clone(),
            display_name: project.display_name.clone(),
            authority_host_ref: project.authority_host_ref.clone(),
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

fn system_time_to_unix_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}
