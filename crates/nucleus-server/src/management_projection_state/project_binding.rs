use std::path::PathBuf;

use nucleus_core::{PersistenceRecordId, PersistenceRecordKind};
use nucleus_engine::ManagementProjectionFileRef;
use nucleus_local_store::{LocalStoreBackend, LocalStoreError, LocalStoreResult};
use nucleus_projects::{
    decode_project_storage_record, ProjectResourceStorageKind, ProjectResourceStorageLocationStatus,
};

use crate::state::ServerStateService;

use super::{
    build_project_management_projection_export_plan, stage_management_projection_import_files,
    write_management_projection_export_files, ManagementProjectionExportFileReport,
    ManagementProjectionExportFileRequest, ManagementProjectionImportStagingReport,
    ManagementProjectionImportStagingRequest,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedManagementProjectionTarget {
    pub project_id: String,
    pub resource_id: String,
    pub repo_root: PathBuf,
    pub sync_policy: String,
}

pub fn resolve_management_projection_target<B>(
    state: &ServerStateService<B>,
    project_id: &str,
) -> Result<ResolvedManagementProjectionTarget, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .projects()
        .get(&PersistenceRecordId(project_id.to_owned()))
        .map_err(|error| format!("project lookup failed: {error:?}"))?
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    if record.kind != PersistenceRecordKind::Project {
        return Err("management projection target is not a project record".to_owned());
    }
    let project = decode_project_storage_record(&record.payload.bytes)
        .map_err(|error| format!("project record decode failed: {}", error.reason))?;
    let target = project
        .management_projection
        .as_ref()
        .ok_or_else(|| "shared project files are not configured".to_owned())?;
    let resource = project
        .resource(&target.resource_id)
        .ok_or_else(|| "shared project files resource requires repair".to_owned())?;
    if resource.kind != ProjectResourceStorageKind::GitRepository {
        return Err("shared project files target is not a Git resource".to_owned());
    }
    if resource.authority_host_ref != project.authority_host_ref {
        return Err(format!(
            "shared project files resource is authoritative on {}",
            resource.authority_host_ref
        ));
    }
    if resource.location_status != ProjectResourceStorageLocationStatus::Present {
        return Err("shared project files resource requires location repair".to_owned());
    }
    let locator = resource
        .current_locator
        .as_deref()
        .ok_or_else(|| "shared project files resource has no available locator".to_owned())?;
    let repo_root = std::fs::canonicalize(locator)
        .map_err(|error| format!("shared project files resource is unavailable: {error}"))?;
    if !repo_root.is_dir() || !repo_root.join(".git").exists() {
        return Err("shared project files resource requires Git repository repair".to_owned());
    }
    let sync_policy = target
        .sync_policy_ref
        .as_deref()
        .filter(|policy| matches!(*policy, "manual" | "assisted" | "automatic" | "reviewed"))
        .ok_or_else(|| "shared project files sync policy requires repair".to_owned())?;

    Ok(ResolvedManagementProjectionTarget {
        project_id: project.project_id.clone(),
        resource_id: resource.resource_id.clone(),
        repo_root,
        sync_policy: sync_policy.to_owned(),
    })
}

pub fn write_project_management_projection_export_files<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    overwrite_existing: bool,
) -> LocalStoreResult<ManagementProjectionExportFileReport>
where
    B: LocalStoreBackend,
{
    let target = resolve_management_projection_target(state, project_id).map_err(binding_error)?;
    let plan = build_project_management_projection_export_plan(state, project_id)?;
    write_management_projection_export_files(ManagementProjectionExportFileRequest {
        repo_root: target.repo_root,
        plan,
        overwrite_existing,
    })
}

pub fn stage_project_management_projection_import_files<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    file_refs: Vec<ManagementProjectionFileRef>,
) -> LocalStoreResult<ManagementProjectionImportStagingReport>
where
    B: LocalStoreBackend,
{
    let target = resolve_management_projection_target(state, project_id).map_err(binding_error)?;
    stage_management_projection_import_files(ManagementProjectionImportStagingRequest {
        repo_root: target.repo_root,
        file_refs,
    })
}

fn binding_error(reason: String) -> LocalStoreError {
    LocalStoreError::TransactionRejected { reason }
}
