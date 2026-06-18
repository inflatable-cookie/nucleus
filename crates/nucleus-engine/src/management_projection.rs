//! Repo-backed management projection planning and validation.
//!
//! This module describes shared project-management projection files without
//! performing filesystem writes, SCM operations, or live-state imports.

mod codec;
mod conflicts;
mod export;
mod policy;
mod types;
mod validation;

pub use codec::{
    decode_management_projection_file_document, encode_management_projection_file_document,
    projection_file_document_from_entry,
};
pub use conflicts::{
    ManagementProjectionConflictClass, ManagementProjectionConflictReport,
    ManagementProjectionSchemaConflictKind, ManagementProjectionScmConflictKind,
    ManagementProjectionSemanticConflictKind, ManagementProjectionUnsupportedConflictKind,
};
pub use export::export_project_task_projection;
pub use policy::{
    default_local_only_projection_markers, projection_record_authority_policy,
    ManagementProjectionAuthorityPolicy,
};
pub use types::{
    ManagementProjectionEnvelope, ManagementProjectionExportEntry, ManagementProjectionExportPlan,
    ManagementProjectionFileCodecError, ManagementProjectionFileDocument,
    ManagementProjectionFileFormat, ManagementProjectionFileRef, ManagementProjectionPayload,
    ManagementProjectionRecordId, ManagementProjectionRecordKind, ManagementProjectionRoot,
    ManagementProjectionSchemaVersion, MANAGEMENT_PROJECTION_ROOT, MANAGEMENT_PROJECTION_SCHEMA_V1,
};
pub use validation::{
    validate_projection_envelope, ManagementProjectionExcludedStateMarker,
    ManagementProjectionValidationIssue, ManagementProjectionValidationIssueKind,
    ManagementProjectionValidationReport, ManagementProjectionValidationStatus,
};

#[cfg(test)]
mod tests;
