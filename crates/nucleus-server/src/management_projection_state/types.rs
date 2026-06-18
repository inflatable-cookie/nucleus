use std::path::PathBuf;

use nucleus_core::RevisionId;
use nucleus_engine::{
    ManagementProjectionConflictReport,
    ManagementProjectionExportPlan, ManagementProjectionFileDocument, ManagementProjectionFileRef,
    ManagementProjectionRecordId, ManagementProjectionValidationReport,
};

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionImportApplyRequest {
    pub staged: Vec<ManagementProjectionStagedFile>,
    pub targets: Vec<ManagementProjectionApplyTarget>,
    pub conflicts: Vec<ManagementProjectionConflictReport>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionApplyTarget {
    pub record_id: ManagementProjectionRecordId,
    pub expected_current_revision: Option<RevisionId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionImportApplyReport {
    pub applied: Vec<ManagementProjectionAppliedRecord>,
    pub blocked: Vec<ManagementProjectionApplyBlock>,
    pub authoritative_state_mutated: bool,
    pub scm_mutation_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionAppliedRecord {
    pub record_id: ManagementProjectionRecordId,
    pub file_ref: ManagementProjectionFileRef,
    pub revision_id: RevisionId,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionApplyBlock {
    pub record_id: Option<ManagementProjectionRecordId>,
    pub file_ref: ManagementProjectionFileRef,
    pub kind: ManagementProjectionApplyBlockKind,
    pub summary: String,
    pub conflict: Option<ManagementProjectionConflictReport>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionApplyBlockKind {
    MissingApplyTarget,
    RecordIdMismatch,
    UnsupportedRecordKind,
    UnsupportedPayload,
    InvalidRecord,
    UnsupportedSchema,
    RevisionConflict,
    SemanticConflict,
}
