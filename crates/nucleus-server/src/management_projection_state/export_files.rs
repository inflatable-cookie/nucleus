use nucleus_engine::projection_file_document_from_entry;
use nucleus_local_store::{LocalStoreError, LocalStoreResult};

use super::helpers::{io_error, scoped_projection_path, write_projection_document};
use super::types::{
    ManagementProjectionExportFileReport, ManagementProjectionExportFileRequest,
    ManagementProjectionExportFileWrite,
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
