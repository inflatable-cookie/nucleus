use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_projects::{
    ManagementProjectionStorageRecord, ManagementProjectionSyncPolicy, ProjectResourceStorageKind,
    ProjectResourceStorageLocationStatus, ProjectResourceStorageRecord, ProjectResourceStorageRole,
    WorkingResourceStorageRecord,
};

use crate::commands::ProjectResourceCommand;
use crate::control_api::ServerControlError;

pub(super) fn attach_resource(
    project: &mut nucleus_projects::ProjectStorageRecord,
    command: &ProjectResourceCommand,
    locator: &Path,
) -> Result<(), ServerControlError> {
    let detected = detect_resource(locator)?;
    let locator_text = path_text(&detected.locator);
    if project
        .resources
        .iter()
        .any(|resource| resource.current_locator.as_deref() == Some(&locator_text))
    {
        return Err(ServerControlError::Conflict {
            reason: "project already contains this resource location".to_owned(),
        });
    }
    let resource_id = resource_id_for(
        &project.project_id,
        &command.authority_host_ref,
        &locator_text,
    );
    project.resources.push(ProjectResourceStorageRecord {
        resource_id: resource_id.clone(),
        project_id: project.project_id.clone(),
        display_name: resource_display_name(&detected.locator),
        kind: detected.kind,
        role: ProjectResourceStorageRole::Working,
        authority_host_ref: command.authority_host_ref.clone(),
        current_locator: Some(locator_text.clone()),
        locator_history: vec![nucleus_projects::ProjectResourceLocatorStorageRecord {
            locator: locator_text,
            observed_at_unix_ms: now_unix_ms(),
            note: Some("resource attached".to_owned()),
        }],
        git: None,
        default_branch: None,
        location_status: ProjectResourceStorageLocationStatus::Present,
        repair_notes: Vec::new(),
    });
    if project.default_working_resource.is_none() {
        project.default_working_resource = Some(WorkingResourceStorageRecord {
            resource_id,
            relative_working_directory: None,
        });
    }
    Ok(())
}

pub(super) fn update_resource(
    project: &mut nucleus_projects::ProjectStorageRecord,
    resource_id: &str,
    display_name: Option<&str>,
    role: Option<&nucleus_projects::ProjectResourceRole>,
    set_as_default: Option<bool>,
) -> Result<(), ServerControlError> {
    if display_name.is_none() && role.is_none() && set_as_default.is_none() {
        return Err(invalid("project resource update contains no changes"));
    }
    let resource = project
        .resources
        .iter_mut()
        .find(|resource| resource.resource_id == resource_id)
        .ok_or_else(resource_not_found)?;
    if let Some(display_name) = display_name {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err(invalid("project resource name must not be empty"));
        }
        resource.display_name = display_name.to_owned();
    }
    if let Some(role) = role {
        resource.role = storage_role(role);
    }
    let working_role = resource.role == ProjectResourceStorageRole::Working;
    if project
        .default_working_resource
        .as_ref()
        .is_some_and(|target| target.resource_id == resource_id)
        && !working_role
    {
        project.default_working_resource = None;
    }
    match set_as_default {
        Some(true) if !working_role => {
            return Err(invalid("only a working resource can be the default"));
        }
        Some(true) => {
            project.default_working_resource = Some(WorkingResourceStorageRecord {
                resource_id: resource_id.to_owned(),
                relative_working_directory: None,
            });
        }
        Some(false)
            if project
                .default_working_resource
                .as_ref()
                .is_some_and(|target| target.resource_id == resource_id) =>
        {
            project.default_working_resource = None;
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn repair_resource(
    project: &mut nucleus_projects::ProjectStorageRecord,
    resource_id: &str,
    locator: &Path,
) -> Result<(), ServerControlError> {
    let resource_host = project
        .resources
        .iter()
        .find(|resource| resource.resource_id == resource_id)
        .map(|resource| resource.authority_host_ref.as_str())
        .ok_or_else(resource_not_found)?;
    if resource_host != project.authority_host_ref {
        return Err(ServerControlError::Unauthorized {
            reason: format!("resource location is authoritative on {resource_host}"),
        });
    }
    let detected = detect_resource(locator)?;
    let locator_text = path_text(&detected.locator);
    if project.resources.iter().any(|resource| {
        resource.resource_id != resource_id
            && resource.current_locator.as_deref() == Some(&locator_text)
    }) {
        return Err(ServerControlError::Conflict {
            reason: "another project resource already uses this location".to_owned(),
        });
    }
    let resource = project
        .resources
        .iter_mut()
        .find(|resource| resource.resource_id == resource_id)
        .ok_or_else(resource_not_found)?;
    if resource.kind != detected.kind {
        return Err(invalid(
            "replacement location does not match the resource kind",
        ));
    }
    if let Some(previous) = resource.current_locator.replace(locator_text.clone()) {
        resource
            .locator_history
            .push(nucleus_projects::ProjectResourceLocatorStorageRecord {
                locator: previous,
                observed_at_unix_ms: now_unix_ms(),
                note: Some("previous locator before repair".to_owned()),
            });
    }
    resource
        .locator_history
        .push(nucleus_projects::ProjectResourceLocatorStorageRecord {
            locator: locator_text,
            observed_at_unix_ms: now_unix_ms(),
            note: Some("resource locator repaired".to_owned()),
        });
    resource.location_status = ProjectResourceStorageLocationStatus::Present;
    resource.repair_notes.push("locator repaired".to_owned());
    Ok(())
}

pub(super) fn remove_resource(
    project: &mut nucleus_projects::ProjectStorageRecord,
    resource_id: &str,
) -> Result<(), ServerControlError> {
    if project
        .management_projection
        .as_ref()
        .is_some_and(|target| target.resource_id == resource_id)
    {
        return Err(invalid(
            "detach shared project files before removing this resource",
        ));
    }
    let before = project.resources.len();
    project
        .resources
        .retain(|resource| resource.resource_id != resource_id);
    if project.resources.len() == before {
        return Err(resource_not_found());
    }
    if project
        .default_working_resource
        .as_ref()
        .is_some_and(|target| target.resource_id == resource_id)
    {
        project.default_working_resource = None;
    }
    Ok(())
}

pub(super) fn set_management_projection(
    project: &mut nucleus_projects::ProjectStorageRecord,
    resource_id: &str,
    sync_policy: ManagementProjectionSyncPolicy,
) -> Result<(), ServerControlError> {
    let resource = project
        .resources
        .iter()
        .find(|resource| resource.resource_id == resource_id)
        .ok_or_else(resource_not_found)?;
    if resource.kind != ProjectResourceStorageKind::GitRepository {
        return Err(invalid(
            "shared project files require an explicitly selected Git resource",
        ));
    }
    if resource.authority_host_ref != project.authority_host_ref {
        return Err(ServerControlError::Unauthorized {
            reason: format!(
                "shared project files resource is authoritative on {}",
                resource.authority_host_ref
            ),
        });
    }
    project.management_projection = Some(ManagementProjectionStorageRecord {
        resource_id: resource_id.to_owned(),
        sync_policy_ref: Some(sync_policy.as_str().to_owned()),
    });
    Ok(())
}

pub(super) fn clear_management_projection(
    project: &mut nucleus_projects::ProjectStorageRecord,
) -> Result<(), ServerControlError> {
    if project.management_projection.take().is_none() {
        return Err(invalid("shared project files are not configured"));
    }
    Ok(())
}

struct DetectedResource {
    locator: PathBuf,
    kind: ProjectResourceStorageKind,
}

fn detect_resource(locator: &Path) -> Result<DetectedResource, ServerControlError> {
    let canonical = std::fs::canonicalize(locator).map_err(|error| {
        invalid(&format!(
            "project resource location is unavailable: {error}"
        ))
    })?;
    if !canonical.is_dir() {
        return Err(invalid("project resources must be directories"));
    }
    if let Some(repository_root) = canonical
        .ancestors()
        .find(|path| path.join(".git").exists())
    {
        return Ok(DetectedResource {
            locator: repository_root.to_path_buf(),
            kind: ProjectResourceStorageKind::GitRepository,
        });
    }
    Ok(DetectedResource {
        locator: canonical,
        kind: ProjectResourceStorageKind::FilesystemFolder,
    })
}

fn storage_role(role: &nucleus_projects::ProjectResourceRole) -> ProjectResourceStorageRole {
    match role {
        nucleus_projects::ProjectResourceRole::Working => ProjectResourceStorageRole::Working,
        nucleus_projects::ProjectResourceRole::Management => ProjectResourceStorageRole::Management,
        nucleus_projects::ProjectResourceRole::Reference => ProjectResourceStorageRole::Reference,
    }
}

fn resource_id_for(project_id: &str, host: &str, locator: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in [project_id, host, locator] {
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    format!("resource:{}", &hasher.finalize().to_hex()[..24])
}

fn resource_display_name(locator: &Path) -> String {
    locator
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| locator.display().to_string())
}

fn now_unix_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn resource_not_found() -> ServerControlError {
    ServerControlError::NotFound {
        reason: "project resource was not found".to_owned(),
    }
}

fn invalid(reason: &str) -> ServerControlError {
    ServerControlError::InvalidRequest {
        reason: reason.to_owned(),
    }
}
