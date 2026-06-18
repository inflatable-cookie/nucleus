use nucleus_engine::{
    decode_management_projection_file_document, validate_projection_envelope,
    ManagementProjectionValidationStatus,
};
use nucleus_local_store::LocalStoreResult;

use super::helpers::{io_error, scoped_projection_path, validation_summary};
use super::types::{
    ManagementProjectionImportStagingReport, ManagementProjectionImportStagingRequest,
    ManagementProjectionStagedFile, ManagementProjectionStagingIssue,
};

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
