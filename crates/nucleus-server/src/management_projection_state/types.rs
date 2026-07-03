use std::path::PathBuf;

use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId, ManagementProjectionConflictReport,
    ManagementProjectionExportPlan, ManagementProjectionFileDocument, ManagementProjectionFileRef,
    ManagementProjectionRecordId, ManagementProjectionRecordKind,
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
pub struct PlanningProjectionFileWriteDiagnostics {
    pub materialized_planning_artifact_files: usize,
    pub materialized_planning_task_seed_files: usize,
    pub invalid_ref_count: usize,
    pub unsupported_record_count: usize,
    pub encode_failure_count: usize,
    pub skipped_write_count: usize,
    pub issues: Vec<PlanningProjectionFileWriteDiagnosticIssue>,
    pub import_or_apply_authority: bool,
    pub scm_mutation_authority: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionFileWriteDiagnosticIssue {
    pub file_ref: Option<ManagementProjectionFileRef>,
    pub class: PlanningProjectionFileWriteDiagnosticIssueClass,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionFileWriteDiagnosticIssueClass {
    InvalidRef,
    UnsupportedRecord,
    EncodeFailed,
    SkippedWrite,
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
pub struct PlanningProjectionImportScanRequest {
    pub repo_root: PathBuf,
    pub file_refs: Vec<ManagementProjectionFileRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportScanReport {
    pub repo_root: PathBuf,
    pub candidates: Vec<PlanningProjectionImportScanCandidate>,
    pub active_planning_mutation_performed: bool,
    pub task_creation_performed: bool,
    pub task_promotion_performed: bool,
    pub agent_scheduling_performed: bool,
    pub provider_execution_performed: bool,
    pub scm_mutation_performed: bool,
    pub forge_mutation_performed: bool,
    pub raw_payload_retained: bool,
    pub ui_apply_triggered: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportScanCandidate {
    pub candidate_id: String,
    pub file_ref: ManagementProjectionFileRef,
    pub path: PathBuf,
    pub record_id: Option<ManagementProjectionRecordId>,
    pub record_kind: Option<ManagementProjectionRecordKind>,
    pub status: PlanningProjectionImportScanCandidateStatus,
    pub blockers: Vec<PlanningProjectionImportScanBlocker>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionImportScanCandidateStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionImportScanBlocker {
    UnsafePath { summary: String },
    UnsupportedSchema { summary: String },
    UnsupportedRecordKind { summary: String },
    ParseFailed { summary: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportAdmissionRequest {
    pub admission_id: String,
    pub candidates: Vec<PlanningProjectionImportScanCandidate>,
    pub reviewed_candidate_ids: Vec<String>,
    pub conflicting_candidate_ids: Vec<String>,
    pub review_evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportAdmissionSet {
    pub admission_id: String,
    pub records: Vec<PlanningProjectionImportAdmissionRecord>,
    pub active_planning_mutation_performed: bool,
    pub task_creation_performed: bool,
    pub task_promotion_performed: bool,
    pub agent_scheduling_performed: bool,
    pub provider_execution_performed: bool,
    pub scm_mutation_performed: bool,
    pub forge_mutation_performed: bool,
    pub raw_payload_retained: bool,
    pub ui_apply_triggered: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportAdmissionRecord {
    pub admission_record_id: String,
    pub candidate_id: String,
    pub file_ref: ManagementProjectionFileRef,
    pub record_id: Option<ManagementProjectionRecordId>,
    pub record_kind: Option<ManagementProjectionRecordKind>,
    pub status: PlanningProjectionImportAdmissionStatus,
    pub blockers: Vec<PlanningProjectionImportAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub apply_permitted: bool,
    pub task_promotion_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionImportAdmissionStatus {
    AdmittedStopped,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionImportAdmissionBlocker {
    CandidateBlocked { summary: String },
    UnreviewedCandidate { summary: String },
    ConflictStaged { summary: String },
    DuplicateCandidate { summary: String },
    MissingRecordId { summary: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportConflictStagingRequest {
    pub staging_id: String,
    pub candidates: Vec<PlanningProjectionImportScanCandidate>,
    pub admissions: Vec<PlanningProjectionImportAdmissionRecord>,
    pub conflict_inputs: Vec<PlanningProjectionImportConflictInput>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportConflictInput {
    pub candidate_id: String,
    pub kind: PlanningProjectionImportConflictKind,
    pub summary: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportConflictSet {
    pub staging_id: String,
    pub conflicts: Vec<PlanningProjectionImportConflictRecord>,
    pub conflict_count: usize,
    pub missing_candidate_ref_count: usize,
    pub missing_admission_ref_count: usize,
    pub apply_blocked: bool,
    pub conflict_resolution_performed: bool,
    pub active_planning_mutation_performed: bool,
    pub task_creation_performed: bool,
    pub task_promotion_performed: bool,
    pub agent_scheduling_performed: bool,
    pub provider_execution_performed: bool,
    pub scm_mutation_performed: bool,
    pub forge_mutation_performed: bool,
    pub raw_payload_retained: bool,
    pub ui_apply_triggered: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportConflictRecord {
    pub conflict_id: String,
    pub candidate_id: String,
    pub admission_record_id: Option<String>,
    pub file_ref: Option<ManagementProjectionFileRef>,
    pub record_id: Option<ManagementProjectionRecordId>,
    pub record_kind: Option<ManagementProjectionRecordKind>,
    pub kind: PlanningProjectionImportConflictKind,
    pub summary: String,
    pub evidence_refs: Vec<String>,
    pub apply_blocked: bool,
    pub resolution_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningProjectionImportConflictKind {
    ArtifactTitle,
    ArtifactBody,
    ReviewState,
    Lineage,
    DuplicateTaskSeedId,
    TaskSeedPromotionState,
    MissingSourceRef,
    Custom(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportDiagnosticsInput {
    pub candidates: Vec<PlanningProjectionImportScanCandidate>,
    pub admissions: Vec<PlanningProjectionImportAdmissionRecord>,
    pub conflicts: Vec<PlanningProjectionImportConflictRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportDiagnostics {
    pub diagnostics_id: String,
    pub candidate_count: usize,
    pub ready_candidate_count: usize,
    pub blocked_candidate_count: usize,
    pub admission_count: usize,
    pub admitted_stopped_count: usize,
    pub duplicate_noop_count: usize,
    pub blocked_admission_count: usize,
    pub conflict_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub candidate_status_buckets: Vec<PlanningProjectionImportDiagnosticBucket>,
    pub admission_status_buckets: Vec<PlanningProjectionImportDiagnosticBucket>,
    pub conflict_kind_buckets: Vec<PlanningProjectionImportDiagnosticBucket>,
    pub apply_blocked: bool,
    pub apply_permitted: bool,
    pub task_promotion_permitted: bool,
    pub provider_execution_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub forge_mutation_permitted: bool,
    pub raw_payload_retained: bool,
    pub ui_apply_permitted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningProjectionImportDiagnosticBucket {
    pub label: String,
    pub count: usize,
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
    pub receipts: Vec<EngineRuntimeReceiptRecord>,
    pub authoritative_state_mutated: bool,
    pub scm_mutation_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionAppliedRecord {
    pub record_id: ManagementProjectionRecordId,
    pub file_ref: ManagementProjectionFileRef,
    pub revision_id: RevisionId,
    pub receipt_id: EngineRuntimeReceiptRecordId,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionApplyBlock {
    pub record_id: Option<ManagementProjectionRecordId>,
    pub file_ref: ManagementProjectionFileRef,
    pub kind: ManagementProjectionApplyBlockKind,
    pub summary: String,
    pub conflict: Option<ManagementProjectionConflictReport>,
    pub receipt_id: Option<EngineRuntimeReceiptRecordId>,
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
