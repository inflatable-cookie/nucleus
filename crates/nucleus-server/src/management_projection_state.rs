//! Server-owned management projection planning and file export helpers.

use std::path::{Component, Path, PathBuf};

use nucleus_engine::{
    decode_management_projection_file_document, encode_management_projection_file_document,
    export_project_task_projection, projection_file_document_from_entry,
    validate_projection_envelope, ManagementProjectionExportPlan, ManagementProjectionFileDocument,
    ManagementProjectionFileRef, ManagementProjectionValidationReport,
    ManagementProjectionValidationStatus,
};
use nucleus_local_store::{LocalStoreBackend, LocalStoreError, LocalStoreResult};
use nucleus_projects::{decode_project_storage_record, ProjectStorageRecord};
use nucleus_tasks::{decode_task_storage_record, TaskStorageRecord};

use crate::state::ServerStateService;

pub fn build_management_projection_export_plan<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<ManagementProjectionExportPlan>
where
    B: LocalStoreBackend,
{
    let projects = read_project_projection_records(state)?;
    let tasks = read_task_projection_records(state)?;

    Ok(export_project_task_projection(&projects, &tasks))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionExportFileRequest {
    pub repo_root: PathBuf,
    pub plan: ManagementProjectionExportPlan,
    pub overwrite_existing: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionExportFileReport {
    pub repo_root: PathBuf,
    pub writes: Vec<ManagementProjectionExportFileWrite>,
    pub scm_mutation_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionExportFileWrite {
    pub file_ref: ManagementProjectionFileRef,
    pub path: PathBuf,
    pub bytes_written: usize,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionImportStagingRequest {
    pub repo_root: PathBuf,
    pub file_refs: Vec<ManagementProjectionFileRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionImportStagingReport {
    pub repo_root: PathBuf,
    pub staged: Vec<ManagementProjectionStagedFile>,
    pub invalid: Vec<ManagementProjectionStagingIssue>,
    pub unsupported: Vec<ManagementProjectionStagingIssue>,
    pub authoritative_state_mutated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionStagedFile {
    pub file_ref: ManagementProjectionFileRef,
    pub path: PathBuf,
    pub document: ManagementProjectionFileDocument,
    pub validation: ManagementProjectionValidationReport,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionStagingIssue {
    pub file_ref: ManagementProjectionFileRef,
    pub path: PathBuf,
    pub summary: String,
}

pub fn write_management_projection_export_files(
    request: ManagementProjectionExportFileRequest,
) -> LocalStoreResult<ManagementProjectionExportFileReport> {
    let mut writes = Vec::new();

    for entry in request.plan.entries {
        let document = projection_file_document_from_entry(entry);
        let path = scoped_projection_path(&request.repo_root, &document.envelope.file_ref)?;
        if path.exists() && !request.overwrite_existing {
            return Err(LocalStoreError::TransactionRejected {
                reason: format!("management projection file exists: {}", path.display()),
            });
        }
        write_projection_document(&document, &path)?;
        let bytes_written = path
            .metadata()
            .map_err(io_error)?
            .len()
            .try_into()
            .unwrap_or(usize::MAX);
        writes.push(ManagementProjectionExportFileWrite {
            file_ref: document.envelope.file_ref,
            path,
            bytes_written,
            summary: "wrote management projection file without SCM mutation".to_owned(),
        });
    }

    Ok(ManagementProjectionExportFileReport {
        repo_root: request.repo_root,
        writes,
        scm_mutation_performed: false,
    })
}

pub fn stage_management_projection_import_files(
    request: ManagementProjectionImportStagingRequest,
) -> LocalStoreResult<ManagementProjectionImportStagingReport> {
    let mut staged = Vec::new();
    let mut invalid = Vec::new();
    let mut unsupported = Vec::new();

    for file_ref in request.file_refs {
        let path = scoped_projection_path(&request.repo_root, &file_ref)?;
        let bytes = std::fs::read(&path).map_err(io_error)?;
        let document = match decode_management_projection_file_document(&bytes) {
            Ok(document) => document,
            Err(error) => {
                invalid.push(ManagementProjectionStagingIssue {
                    file_ref,
                    path,
                    summary: format!("decode failed: {}", error.reason),
                });
                continue;
            }
        };
        let validation = validate_projection_envelope(&document.envelope, &[]);
        match validation.status {
            ManagementProjectionValidationStatus::Valid
            | ManagementProjectionValidationStatus::ValidWithWarnings => {
                staged.push(ManagementProjectionStagedFile {
                    file_ref,
                    path,
                    document,
                    validation,
                });
            }
            ManagementProjectionValidationStatus::Invalid => {
                invalid.push(ManagementProjectionStagingIssue {
                    file_ref,
                    path,
                    summary: validation_summary(&validation),
                });
            }
            ManagementProjectionValidationStatus::UnsupportedSchema => {
                unsupported.push(ManagementProjectionStagingIssue {
                    file_ref,
                    path,
                    summary: validation_summary(&validation),
                });
            }
        }
    }

    Ok(ManagementProjectionImportStagingReport {
        repo_root: request.repo_root,
        staged,
        invalid,
        unsupported,
        authoritative_state_mutated: false,
    })
}

fn read_project_projection_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProjectStorageRecord>>
where
    B: LocalStoreBackend,
{
    state
        .projects()
        .list()?
        .iter()
        .map(|record| {
            decode_project_storage_record(&record.payload.bytes).map_err(|error| {
                LocalStoreError::InvalidRecord {
                    reason: error.reason,
                }
            })
        })
        .collect()
}

fn scoped_projection_path(
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

fn write_projection_document(
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

fn io_error(error: std::io::Error) -> LocalStoreError {
    LocalStoreError::Unavailable {
        reason: error.to_string(),
    }
}

fn validation_summary(report: &ManagementProjectionValidationReport) -> String {
    report
        .issues
        .iter()
        .map(|issue| issue.summary.clone())
        .collect::<Vec<_>>()
        .join("; ")
}

fn read_task_projection_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<TaskStorageRecord>>
where
    B: LocalStoreBackend,
{
    state
        .tasks()
        .list()?
        .iter()
        .map(|record| {
            decode_task_storage_record(&record.payload.bytes).map_err(|error| {
                LocalStoreError::InvalidRecord {
                    reason: error.reason,
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_seed::{seed_local_project, LocalProjectSeed};
    use crate::state::ServerStateService;
    use crate::task_seed::{seed_local_task, LocalTaskSeed};
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::ImportanceLevel;
    use nucleus_tasks::{TaskActionType, TaskImportance};

    #[test]
    fn management_projection_export_plan_reads_project_and_task_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        seed_local_project(
            &state,
            LocalProjectSeed {
                project_id: "project:nucleus".to_owned(),
                display_name: "Nucleus".to_owned(),
                importance_level: ImportanceLevel::High,
            },
        )
        .expect("seed project");
        seed_local_task(
            &state,
            LocalTaskSeed {
                task_id: "task:projection".to_owned(),
                project_id: "project:nucleus".to_owned(),
                title: "Export projection".to_owned(),
                action_type: TaskActionType::Execute,
                importance: TaskImportance::High,
            },
        )
        .expect("seed task");

        let plan = build_management_projection_export_plan(&state).expect("export plan");
        let json = serde_json::to_string(&plan).expect("plan json");

        assert_eq!(plan.root.relative_path, "nucleus");
        assert_eq!(plan.entries.len(), 2);
        assert!(json.contains("nucleus/project.toml"));
        assert!(json.contains("nucleus/tasks/task:projection.toml"));
        for forbidden in [
            "raw_stdout",
            "terminal_stream",
            "provider_auth",
            "global_display_window_surface",
            "per_project_panel",
            "secret",
        ] {
            assert!(!json.contains(forbidden), "projection leaked {forbidden}");
        }
    }

    #[test]
    fn management_projection_export_writes_scoped_project_and_task_files_without_scm_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        seed_local_project(
            &state,
            LocalProjectSeed {
                project_id: "project:nucleus".to_owned(),
                display_name: "Nucleus".to_owned(),
                importance_level: ImportanceLevel::High,
            },
        )
        .expect("seed project");
        seed_local_task(
            &state,
            LocalTaskSeed {
                task_id: "task:projection".to_owned(),
                project_id: "project:nucleus".to_owned(),
                title: "Export projection".to_owned(),
                action_type: TaskActionType::Execute,
                importance: TaskImportance::High,
            },
        )
        .expect("seed task");
        let plan = build_management_projection_export_plan(&state).expect("export plan");
        let repo_root = temp_dir.path().join("repo");

        let report =
            write_management_projection_export_files(ManagementProjectionExportFileRequest {
                repo_root: repo_root.clone(),
                plan,
                overwrite_existing: false,
            })
            .expect("write files");

        assert!(!report.scm_mutation_performed);
        assert_eq!(report.writes.len(), 2);
        assert!(repo_root.join("nucleus/project.toml").exists());
        assert!(repo_root
            .join("nucleus/tasks/task:projection.toml")
            .exists());
        let task_file =
            std::fs::read_to_string(repo_root.join("nucleus/tasks/task:projection.toml"))
                .expect("task file");
        assert!(task_file.contains("schema_version"));
        assert!(task_file.contains("Export projection"));
        for forbidden in [
            "provider_auth",
            "terminal_stream",
            "secret",
            "client_layout",
        ] {
            assert!(
                !task_file.contains(forbidden),
                "projection leaked {forbidden}"
            );
        }
    }

    #[test]
    fn management_projection_export_rejects_unscoped_file_refs() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut plan = ManagementProjectionExportPlan {
            root: nucleus_engine::ManagementProjectionRoot::default(),
            entries: Vec::new(),
        };
        plan.entries
            .push(nucleus_engine::ManagementProjectionExportEntry {
                envelope: nucleus_engine::ManagementProjectionEnvelope {
                    schema_version: nucleus_engine::ManagementProjectionSchemaVersion::current(),
                    record_id: nucleus_engine::ManagementProjectionRecordId("task:bad".to_owned()),
                    record_kind: nucleus_engine::ManagementProjectionRecordKind::Task,
                    file_ref: ManagementProjectionFileRef("../outside.toml".to_owned()),
                },
                payload: nucleus_engine::ManagementProjectionPayload::Unsupported {
                    payload_kind: "bad".to_owned(),
                    retained_payload: "{}".to_owned(),
                },
            });

        let error =
            write_management_projection_export_files(ManagementProjectionExportFileRequest {
                repo_root: temp_dir.path().join("repo"),
                plan,
                overwrite_existing: false,
            })
            .expect_err("reject unscoped ref");

        assert!(matches!(
            error,
            LocalStoreError::InvalidRecord { reason }
                if reason == "management projection file ref must stay under repo root"
        ));
    }

    #[test]
    fn management_projection_import_stages_exported_files_without_mutating_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        seed_local_project(
            &state,
            LocalProjectSeed {
                project_id: "project:nucleus".to_owned(),
                display_name: "Nucleus".to_owned(),
                importance_level: ImportanceLevel::High,
            },
        )
        .expect("seed project");
        seed_local_task(
            &state,
            LocalTaskSeed {
                task_id: "task:projection".to_owned(),
                project_id: "project:nucleus".to_owned(),
                title: "Export projection".to_owned(),
                action_type: TaskActionType::Execute,
                importance: TaskImportance::High,
            },
        )
        .expect("seed task");
        let plan = build_management_projection_export_plan(&state).expect("export plan");
        let file_refs = plan
            .entries
            .iter()
            .map(|entry| entry.envelope.file_ref.clone())
            .collect::<Vec<_>>();
        let repo_root = temp_dir.path().join("repo");
        write_management_projection_export_files(ManagementProjectionExportFileRequest {
            repo_root: repo_root.clone(),
            plan,
            overwrite_existing: false,
        })
        .expect("write projection files");

        let report =
            stage_management_projection_import_files(ManagementProjectionImportStagingRequest {
                repo_root,
                file_refs,
            })
            .expect("stage import");

        assert!(!report.authoritative_state_mutated);
        assert_eq!(report.staged.len(), 2);
        assert!(report.invalid.is_empty());
        assert!(report.unsupported.is_empty());
        assert!(report.staged.iter().any(|staged| {
            staged.file_ref == ManagementProjectionFileRef::task("task:projection")
                && staged.validation.status == ManagementProjectionValidationStatus::Valid
        }));
    }

    #[test]
    fn management_projection_import_reports_invalid_and_unsupported_files_separately() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let repo_root = temp_dir.path().join("repo");
        let invalid_ref = ManagementProjectionFileRef("nucleus/tasks/invalid.toml".to_owned());
        let unsupported_ref =
            ManagementProjectionFileRef("nucleus/tasks/unsupported.toml".to_owned());
        let invalid_path = scoped_projection_path(&repo_root, &invalid_ref).expect("invalid path");
        let unsupported_path =
            scoped_projection_path(&repo_root, &unsupported_ref).expect("unsupported path");
        std::fs::create_dir_all(invalid_path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&invalid_path, b"not = [valid").expect("write invalid");
        write_projection_document(
            &ManagementProjectionFileDocument {
                envelope: nucleus_engine::ManagementProjectionEnvelope {
                    schema_version: nucleus_engine::ManagementProjectionSchemaVersion(
                        "future".to_owned(),
                    ),
                    record_id: nucleus_engine::ManagementProjectionRecordId(
                        "task:future".to_owned(),
                    ),
                    record_kind: nucleus_engine::ManagementProjectionRecordKind::Task,
                    file_ref: unsupported_ref.clone(),
                },
                payload: nucleus_engine::ManagementProjectionPayload::Unsupported {
                    payload_kind: "task".to_owned(),
                    retained_payload: "{}".to_owned(),
                },
            },
            &unsupported_path,
        )
        .expect("write unsupported");

        let report =
            stage_management_projection_import_files(ManagementProjectionImportStagingRequest {
                repo_root,
                file_refs: vec![invalid_ref.clone(), unsupported_ref.clone()],
            })
            .expect("stage import");

        assert!(report.staged.is_empty());
        assert_eq!(report.invalid.len(), 1);
        assert_eq!(report.unsupported.len(), 1);
        assert_eq!(report.invalid[0].file_ref, invalid_ref);
        assert_eq!(report.unsupported[0].file_ref, unsupported_ref);
        assert!(!report.authoritative_state_mutated);
    }
}
