use std::path::{Component, Path};

use nucleus_engine::{
    encode_management_projection_file_document, projection_file_document_from_entry,
    ManagementProjectionExportIssueKind, ManagementProjectionExportPlan,
    ManagementProjectionFileRef, ManagementProjectionPayload, ManagementProjectionRecordKind,
};
use nucleus_local_store::{LocalStoreError, LocalStoreResult};

use super::helpers::{io_error, scoped_projection_path, write_projection_document};
use super::types::{
    ManagementProjectionExportFileReport, ManagementProjectionExportFileRequest,
    ManagementProjectionExportFileWrite, PlanningProjectionFileWriteDiagnosticIssue,
    PlanningProjectionFileWriteDiagnosticIssueClass, PlanningProjectionFileWriteDiagnostics,
};

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

pub fn write_planning_management_projection_export_files(
    request: ManagementProjectionExportFileRequest,
) -> LocalStoreResult<ManagementProjectionExportFileReport> {
    validate_planning_projection_export_plan(&request.plan)?;
    write_management_projection_export_files(request)
}

pub fn planning_projection_file_write_diagnostics(
    plan: &ManagementProjectionExportPlan,
    report: Option<&ManagementProjectionExportFileReport>,
) -> PlanningProjectionFileWriteDiagnostics {
    let mut diagnostics = PlanningProjectionFileWriteDiagnostics {
        materialized_planning_artifact_files: 0,
        materialized_planning_task_seed_files: 0,
        invalid_ref_count: 0,
        unsupported_record_count: 0,
        encode_failure_count: 0,
        skipped_write_count: 0,
        issues: Vec::new(),
        import_or_apply_authority: false,
        scm_mutation_authority: false,
    };

    if let Some(report) = report {
        for write in &report.writes {
            if is_planning_task_seed_ref(&write.file_ref) {
                diagnostics.materialized_planning_task_seed_files += 1;
            } else if is_planning_artifact_ref(&write.file_ref) {
                diagnostics.materialized_planning_artifact_files += 1;
            }
        }
    }

    for issue in &plan.issues {
        let class = match issue.kind {
            ManagementProjectionExportIssueKind::InvalidFileRef => {
                diagnostics.invalid_ref_count += 1;
                PlanningProjectionFileWriteDiagnosticIssueClass::InvalidRef
            }
            ManagementProjectionExportIssueKind::DecodeFailed => {
                diagnostics.encode_failure_count += 1;
                PlanningProjectionFileWriteDiagnosticIssueClass::EncodeFailed
            }
            ManagementProjectionExportIssueKind::UnsupportedRecord
            | ManagementProjectionExportIssueKind::Custom(_) => {
                diagnostics.unsupported_record_count += 1;
                PlanningProjectionFileWriteDiagnosticIssueClass::UnsupportedRecord
            }
        };
        diagnostics
            .issues
            .push(PlanningProjectionFileWriteDiagnosticIssue {
                file_ref: None,
                class,
                summary: issue.summary.clone(),
            });
    }

    for entry in &plan.entries {
        match entry.envelope.record_kind {
            ManagementProjectionRecordKind::PlanningArtifact => {
                if !is_planning_artifact_ref(&entry.envelope.file_ref)
                    || !is_safe_relative_projection_ref(&entry.envelope.file_ref)
                {
                    diagnostics.invalid_ref_count += 1;
                    diagnostics.skipped_write_count += 1;
                    diagnostics.issues.push(diagnostic_issue(
                        &entry.envelope.file_ref,
                        PlanningProjectionFileWriteDiagnosticIssueClass::InvalidRef,
                        "planning artifact projection file ref is outside nucleus/planning/",
                    ));
                    continue;
                }
            }
            ManagementProjectionRecordKind::PlanningTaskSeed => {
                if !is_planning_task_seed_ref(&entry.envelope.file_ref)
                    || !is_safe_relative_projection_ref(&entry.envelope.file_ref)
                {
                    diagnostics.invalid_ref_count += 1;
                    diagnostics.skipped_write_count += 1;
                    diagnostics.issues.push(diagnostic_issue(
                        &entry.envelope.file_ref,
                        PlanningProjectionFileWriteDiagnosticIssueClass::InvalidRef,
                        "planning task seed projection file ref is outside nucleus/planning/task-seeds/",
                    ));
                    continue;
                }
            }
            _ => {
                diagnostics.unsupported_record_count += 1;
                diagnostics.skipped_write_count += 1;
                diagnostics.issues.push(diagnostic_issue(
                    &entry.envelope.file_ref,
                    PlanningProjectionFileWriteDiagnosticIssueClass::UnsupportedRecord,
                    "planning projection export accepts only planning artifact and planning task seed records",
                ));
                continue;
            }
        }

        let document = projection_file_document_from_entry(entry.clone());
        if encode_management_projection_file_document(&document).is_err()
            || matches!(
                document.payload,
                ManagementProjectionPayload::Unsupported { .. }
            )
        {
            diagnostics.encode_failure_count += 1;
            diagnostics.skipped_write_count += 1;
            diagnostics.issues.push(diagnostic_issue(
                &document.envelope.file_ref,
                PlanningProjectionFileWriteDiagnosticIssueClass::EncodeFailed,
                "planning projection file document could not be encoded",
            ));
        }
    }

    diagnostics
}

fn validate_planning_projection_export_plan(
    plan: &ManagementProjectionExportPlan,
) -> LocalStoreResult<()> {
    if !plan.issues.is_empty() {
        return Err(LocalStoreError::TransactionRejected {
            reason: format!(
                "planning projection export has unresolved issues: {}",
                plan.issues.len()
            ),
        });
    }

    for entry in &plan.entries {
        match entry.envelope.record_kind {
            ManagementProjectionRecordKind::PlanningArtifact => {
                if !entry.envelope.file_ref.0.starts_with("nucleus/planning/")
                    || entry
                        .envelope
                        .file_ref
                        .0
                        .starts_with("nucleus/planning/task-seeds/")
                {
                    return Err(LocalStoreError::InvalidRecord {
                        reason:
                            "planning artifact projection files must live under nucleus/planning/"
                                .to_owned(),
                    });
                }
            }
            ManagementProjectionRecordKind::PlanningTaskSeed => {
                if !entry
                    .envelope
                    .file_ref
                    .0
                    .starts_with("nucleus/planning/task-seeds/")
                {
                    return Err(LocalStoreError::InvalidRecord {
                        reason: "planning task seed projection files must live under nucleus/planning/task-seeds/"
                            .to_owned(),
                    });
                }
            }
            _ => {
                return Err(LocalStoreError::UnsupportedRecordKind {
                    reason: "planning projection export accepts only planning artifact and planning task seed records"
                        .to_owned(),
                });
            }
        }
    }

    Ok(())
}

fn diagnostic_issue(
    file_ref: &ManagementProjectionFileRef,
    class: PlanningProjectionFileWriteDiagnosticIssueClass,
    summary: &str,
) -> PlanningProjectionFileWriteDiagnosticIssue {
    PlanningProjectionFileWriteDiagnosticIssue {
        file_ref: Some(file_ref.clone()),
        class,
        summary: summary.to_owned(),
    }
}

fn is_planning_artifact_ref(file_ref: &ManagementProjectionFileRef) -> bool {
    file_ref.0.starts_with("nucleus/planning/")
        && !file_ref.0.starts_with("nucleus/planning/task-seeds/")
}

fn is_planning_task_seed_ref(file_ref: &ManagementProjectionFileRef) -> bool {
    file_ref.0.starts_with("nucleus/planning/task-seeds/")
}

fn is_safe_relative_projection_ref(file_ref: &ManagementProjectionFileRef) -> bool {
    let relative = Path::new(&file_ref.0);
    !relative.is_absolute()
        && relative.components().all(|component| {
            !matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}
