use std::path::PathBuf;

use nucleus_engine::{
    ManagementProjectionExportPlan, ManagementProjectionFileDocument, ManagementProjectionFileRef,
    ManagementProjectionValidationReport,
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
