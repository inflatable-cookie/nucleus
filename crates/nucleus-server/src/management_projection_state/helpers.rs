use std::path::{Component, Path, PathBuf};

use nucleus_core::PersistenceRecordKind;
use nucleus_engine::{
    encode_management_projection_file_document, ManagementProjectionFileDocument,
    ManagementProjectionFileRef, ManagementProjectionValidationReport,
};
use nucleus_local_store::{LocalStoreBackend, LocalStoreError, LocalStoreResult};
use nucleus_projects::{decode_project_storage_record, ProjectStorageRecord};
use nucleus_tasks::{decode_task_storage_record, TaskStorageRecord};

use crate::state::ServerStateService;

pub(super) fn read_project_projection_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProjectStorageRecord>>
where
    B: LocalStoreBackend,
{
    state
        .projects()
        .list()?
        .into_iter()
        .filter(|record| record.kind == PersistenceRecordKind::Project)
        .map(|record| {
            decode_project_storage_record(&record.payload.bytes).map_err(|error| {
                LocalStoreError::InvalidRecord {
                    reason: error.reason,
                }
            })
        })
        .collect()
}

pub(super) fn scoped_projection_path(
    repo_root: &Path,
    file_ref: &ManagementProjectionFileRef,
) -> LocalStoreResult<PathBuf> {
    let relative = Path::new(&file_ref.0);
    if relative.is_absolute() {
        return Err(LocalStoreError::InvalidRecord {
            reason: "management projection file ref must be relative".to_owned(),
        });
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(LocalStoreError::InvalidRecord {
            reason: "management projection file ref must stay under repo root".to_owned(),
        });
    }
    if !file_ref.0.starts_with("nucleus/") {
        return Err(LocalStoreError::InvalidRecord {
            reason: "management projection file ref must stay under nucleus/".to_owned(),
        });
    }

    Ok(repo_root.join(relative))
}

pub(super) fn write_projection_document(
    document: &ManagementProjectionFileDocument,
    path: &Path,
) -> LocalStoreResult<()> {
    let bytes = encode_management_projection_file_document(document).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.reason,
        }
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io_error)?;
    }
    std::fs::write(path, bytes).map_err(io_error)
}

pub(super) fn io_error(error: std::io::Error) -> LocalStoreError {
    LocalStoreError::Unavailable {
        reason: error.to_string(),
    }
}

pub(super) fn validation_summary(report: &ManagementProjectionValidationReport) -> String {
    report
        .issues
        .iter()
        .map(|issue| issue.summary.clone())
        .collect::<Vec<_>>()
        .join("; ")
}

pub(super) fn read_task_projection_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<TaskStorageRecord>>
where
    B: LocalStoreBackend,
{
    state
        .tasks()
        .list()?
        .into_iter()
        .filter(|record| record.kind == PersistenceRecordKind::Task)
        .map(|record| {
            decode_task_storage_record(&record.payload.bytes).map_err(|error| {
                LocalStoreError::InvalidRecord {
                    reason: error.reason,
                }
            })
        })
        .collect()
}
