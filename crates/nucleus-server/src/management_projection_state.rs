//! Server-owned management projection planning and file export helpers.

mod apply_import;
mod export_files;
mod helpers;
mod import_staging;
mod plan;
mod types;

pub use apply_import::apply_management_projection_import;
pub use export_files::write_management_projection_export_files;
pub use import_staging::stage_management_projection_import_files;
pub use plan::build_management_projection_export_plan;
pub use types::{
    ManagementProjectionAppliedRecord, ManagementProjectionApplyBlock,
    ManagementProjectionApplyBlockKind, ManagementProjectionApplyTarget,
    ManagementProjectionExportFileReport, ManagementProjectionExportFileRequest,
    ManagementProjectionExportFileWrite, ManagementProjectionImportApplyReport,
    ManagementProjectionImportApplyRequest, ManagementProjectionImportStagingReport,
    ManagementProjectionImportStagingRequest, ManagementProjectionStagedFile,
    ManagementProjectionStagingIssue,
};

#[cfg(test)]
mod tests;
