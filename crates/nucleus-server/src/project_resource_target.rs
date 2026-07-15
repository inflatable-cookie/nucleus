use std::fs;
use std::path::{Path, PathBuf};

use nucleus_core::PersistenceRecordId;
use nucleus_local_store::LocalStoreBackend;
use nucleus_projects::{
    decode_project_storage_record, ProjectResourceStorageLocationStatus,
    ProjectResourceStorageRecord, ProjectResourceStorageRole, ProjectStorageRecord,
};

use crate::ServerStateService;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedProjectResourceTarget {
    pub resource_id: String,
    pub authority_host_ref: String,
    pub root: PathBuf,
}

pub(crate) fn resolve_project_resource_target<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    explicit_resource_id: Option<&str>,
) -> Result<ResolvedProjectResourceTarget, String>
where
    B: LocalStoreBackend,
{
    resolve_optional_project_resource_target(state, project_id, explicit_resource_id)?.ok_or_else(
        || {
            "project has no compatible working resource; attach a folder or Git repository to use this action"
                .to_owned()
        },
    )
}

pub(crate) fn resolve_optional_project_resource_target<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    explicit_resource_id: Option<&str>,
) -> Result<Option<ResolvedProjectResourceTarget>, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .projects()
        .get(&PersistenceRecordId(project_id.to_owned()))
        .map_err(|error| format!("project lookup failed: {error:?}"))?
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    let project = decode_project_storage_record(&record.payload.bytes)
        .map_err(|error| format!("project record decode failed: {}", error.reason))?;
    resolve_record_target(&project, explicit_resource_id)
}

fn resolve_record_target(
    project: &ProjectStorageRecord,
    explicit_resource_id: Option<&str>,
) -> Result<Option<ResolvedProjectResourceTarget>, String> {
    if let Some(resource_id) = explicit_resource_id.filter(|value| !value.trim().is_empty()) {
        let resource = project
            .resource(resource_id)
            .ok_or_else(|| format!("project resource target not found: {resource_id}"))?;
        return resolve_resource(resource, None).map(Some);
    }

    if let Some(default) = project.default_working_resource.as_ref() {
        let resource = project
            .resource(&default.resource_id)
            .ok_or_else(|| "project default working resource is not attached".to_owned())?;
        return resolve_resource(resource, default.relative_working_directory.as_deref()).map(Some);
    }

    let candidates = project
        .resources
        .iter()
        .filter(|resource| resource.role == ProjectResourceStorageRole::Working)
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [] => Ok(None),
        [resource] => resolve_resource(resource, None).map(Some),
        _ => Err(
            "project has multiple working resources and no target; choose a resource for this panel or task"
                .to_owned(),
        ),
    }
}

fn resolve_resource(
    resource: &ProjectResourceStorageRecord,
    relative_working_directory: Option<&str>,
) -> Result<ResolvedProjectResourceTarget, String> {
    if resource.role != ProjectResourceStorageRole::Working {
        return Err(format!(
            "project resource is not compatible with working-directory actions: {}",
            resource.resource_id
        ));
    }
    if resource.location_status != ProjectResourceStorageLocationStatus::Present {
        return Err(format!(
            "project resource requires location repair before use: {}",
            resource.resource_id
        ));
    }
    let locator = resource.current_locator.as_deref().ok_or_else(|| {
        format!(
            "project resource has no available locator: {}",
            resource.resource_id
        )
    })?;
    let resource_root = canonical_directory(locator, &resource.resource_id)?;
    let root = match relative_working_directory.filter(|value| !value.trim().is_empty()) {
        Some(relative) => resolve_relative_root(&resource_root, relative, &resource.resource_id)?,
        None => resource_root,
    };
    Ok(ResolvedProjectResourceTarget {
        resource_id: resource.resource_id.clone(),
        authority_host_ref: resource.authority_host_ref.clone(),
        root,
    })
}

fn canonical_directory(locator: &str, resource_id: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(locator)
        .map_err(|error| format!("project resource is unavailable ({resource_id}): {error}"))?;
    if !path.is_dir() {
        return Err(format!(
            "project resource is not a directory: {resource_id}"
        ));
    }
    Ok(path)
}

fn resolve_relative_root(
    resource_root: &Path,
    relative: &str,
    resource_id: &str,
) -> Result<PathBuf, String> {
    let root = fs::canonicalize(resource_root.join(relative)).map_err(|error| {
        format!("project resource working directory is unavailable ({resource_id}): {error}")
    })?;
    if root != resource_root && !root.starts_with(resource_root) {
        return Err(format!(
            "project resource working directory escapes its resource: {resource_id}"
        ));
    }
    if !root.is_dir() {
        return Err(format!(
            "project resource working directory is not a directory: {resource_id}"
        ));
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use nucleus_projects::{
        ProjectResourceStorageKind, ProjectRetentionStorage, ProjectStorageImportanceLevel,
        ProjectStorageStatus, WorkingResourceStorageRecord, PROJECT_STORAGE_SCHEMA_VERSION,
    };

    use super::*;

    fn project(resources: Vec<ProjectResourceStorageRecord>) -> ProjectStorageRecord {
        ProjectStorageRecord {
            schema_version: PROJECT_STORAGE_SCHEMA_VERSION,
            project_id: "project:test".to_owned(),
            display_name: "Test".to_owned(),
            authority_host_ref: "host:test".to_owned(),
            status: ProjectStorageStatus::Active,
            retention: ProjectRetentionStorage::Durable,
            importance_level: ProjectStorageImportanceLevel::Normal,
            resources,
            default_working_resource: None,
            management_projection: None,
        }
    }

    fn working_resource(id: &str, root: &Path) -> ProjectResourceStorageRecord {
        ProjectResourceStorageRecord {
            resource_id: id.to_owned(),
            project_id: "project:test".to_owned(),
            display_name: id.to_owned(),
            kind: ProjectResourceStorageKind::FilesystemFolder,
            role: ProjectResourceStorageRole::Working,
            authority_host_ref: "host:test".to_owned(),
            current_locator: Some(root.to_string_lossy().into_owned()),
            locator_history: Vec::new(),
            git: None,
            default_branch: None,
            location_status: ProjectResourceStorageLocationStatus::Present,
            repair_notes: Vec::new(),
        }
    }

    #[test]
    fn zero_resources_has_no_implicit_target() {
        assert_eq!(resolve_record_target(&project(Vec::new()), None), Ok(None));
    }

    #[test]
    fn sole_working_resource_is_the_quiet_default() {
        let root = tempfile::tempdir().expect("tempdir");
        let record = project(vec![working_resource("resource:one", root.path())]);

        let resolved = resolve_record_target(&record, None)
            .expect("resolve")
            .expect("target");

        assert_eq!(resolved.resource_id, "resource:one");
        assert_eq!(
            resolved.root,
            root.path().canonicalize().expect("canonical")
        );
    }

    #[test]
    fn multiple_resources_require_an_explicit_or_configured_target() {
        let first = tempfile::tempdir().expect("first");
        let second = tempfile::tempdir().expect("second");
        let record = project(vec![
            working_resource("resource:first", first.path()),
            working_resource("resource:second", second.path()),
        ]);

        assert!(resolve_record_target(&record, None)
            .expect_err("ambiguous")
            .contains("multiple working resources"));
        assert_eq!(
            resolve_record_target(&record, Some("resource:second"))
                .expect("resolve")
                .expect("target")
                .resource_id,
            "resource:second"
        );
    }

    #[test]
    fn configured_default_applies_its_relative_directory() {
        let root = tempfile::tempdir().expect("root");
        let nested = root.path().join("packages/app");
        std::fs::create_dir_all(&nested).expect("nested");
        let mut record = project(vec![working_resource("resource:one", root.path())]);
        record.default_working_resource = Some(WorkingResourceStorageRecord {
            resource_id: "resource:one".to_owned(),
            relative_working_directory: Some("packages/app".to_owned()),
        });

        assert_eq!(
            resolve_record_target(&record, None)
                .expect("resolve")
                .expect("target")
                .root,
            nested.canonicalize().expect("canonical")
        );
    }

    #[test]
    fn unavailable_default_requires_repair_without_falling_back() {
        let fallback = tempfile::tempdir().expect("fallback");
        let missing = fallback.path().join("moved-away");
        let mut unavailable = working_resource("resource:missing", &missing);
        unavailable.location_status = ProjectResourceStorageLocationStatus::RepairRequired;
        let mut record = project(vec![
            unavailable,
            working_resource("resource:available", fallback.path()),
        ]);
        record.default_working_resource = Some(WorkingResourceStorageRecord {
            resource_id: "resource:missing".to_owned(),
            relative_working_directory: None,
        });

        let error = resolve_record_target(&record, None).expect_err("repair required");

        assert!(error.contains("requires location repair"));
        assert_eq!(record.resources.len(), 2);
        assert_eq!(
            record
                .default_working_resource
                .as_ref()
                .map(|target| target.resource_id.as_str()),
            Some("resource:missing")
        );
    }

    #[test]
    fn moved_locator_fails_truthfully_and_preserves_remote_authority() {
        let root = tempfile::tempdir().expect("root");
        let mut remote = working_resource("resource:remote", root.path());
        remote.authority_host_ref = "host:remote-builder".to_owned();
        let record = project(vec![remote]);

        let resolved = resolve_record_target(&record, None)
            .expect("resolve")
            .expect("target");
        assert_eq!(resolved.authority_host_ref, "host:remote-builder");

        let missing_locator = root.path().join("moved");
        let mut moved = record.clone();
        moved.resources[0].current_locator = Some(missing_locator.to_string_lossy().into_owned());
        let error = resolve_record_target(&moved, None).expect_err("moved locator");

        assert!(error.contains("project resource is unavailable"));
        assert_eq!(moved.resources[0].resource_id, "resource:remote");
        assert_eq!(moved.resources[0].authority_host_ref, "host:remote-builder");
    }

    #[test]
    fn reference_resources_do_not_become_working_defaults() {
        let root = tempfile::tempdir().expect("root");
        let mut reference = working_resource("resource:reference", root.path());
        reference.role = ProjectResourceStorageRole::Reference;

        assert_eq!(
            resolve_record_target(&project(vec![reference]), None),
            Ok(None)
        );
    }
}
