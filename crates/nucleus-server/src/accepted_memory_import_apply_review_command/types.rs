use crate::provider_no_effects::{MemoryApplyNoEffects};
use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionRecord,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryImportApplyReviewInput {
    pub command_id: String,
    pub operator_ref: String,
    pub approval_ref: String,
    pub decision_reason_ref: String,
    pub decision: AcceptedMemoryImportApplyReviewDecision,
    pub provenance_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub admission: AcceptedMemoryProjectionImportApplyAdmissionRecord,
    pub raw_payload_present: bool,
    pub active_memory_mutation_requested: bool,
    pub projection_write_requested: bool,
    pub scm_effect_requested: bool,
    pub embedding_requested: bool,
    pub provider_sync_requested: bool,
    pub automatic_extraction_requested: bool,
    pub task_mutation_requested: bool,
    pub agent_scheduling_requested: bool,
    pub ui_effect_requested: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryImportApplyReviewSet {
    pub receipts: Vec<AcceptedMemoryImportApplyReviewReceipt>,
    pub counts: AcceptedMemoryImportApplyReviewCounts,
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryImportApplyReviewReceipt {
    pub review_receipt_ref: String,
    pub command_id: String,
    pub apply_admission_ref: String,
    pub import_admission_ref: String,
    pub conflict_ref: String,
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub operator_ref: String,
    pub approval_ref: String,
    pub decision_reason_ref: String,
    pub admission_status: AcceptedMemoryProjectionImportApplyAdmissionStatus,
    pub admission_blockers: Vec<AcceptedMemoryProjectionImportApplyAdmissionBlocker>,
    pub decision: AcceptedMemoryImportApplyReviewDecision,
    pub status: AcceptedMemoryImportApplyReviewStatus,
    pub blockers: Vec<AcceptedMemoryImportApplyReviewBlocker>,
    pub provenance_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryImportApplyReviewDecision {
    Approve,
    Defer,
    Reject,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryImportApplyReviewStatus {
    Approved,
    Deferred,
    Rejected,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryImportApplyReviewBlocker {
    MissingCommandId,
    MissingOperatorRef,
    MissingApprovalRef,
    MissingDecisionReasonRef,
    MissingProvenanceRefs,
    MissingEvidenceRefs,
    MissingApplyAdmissionRef,
    MissingImportAdmissionRef,
    MissingConflictRef,
    MissingCandidateRef,
    MissingMemoryId,
    MissingFileRef,
    AdmissionNotAdmitted,
    AdmissionDuplicateNoop,
    AdmissionBlocked,
    AdmissionBlockersPresent,
    RawPayloadPresent,
    ActiveMemoryMutationRequested,
    ProjectionWriteRequested,
    ScmEffectRequested,
    EmbeddingRequested,
    ProviderSyncRequested,
    AutomaticExtractionRequested,
    TaskMutationRequested,
    AgentSchedulingRequested,
    UiEffectRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryImportApplyReviewCounts {
    pub inputs: usize,
    pub approved: usize,
    pub deferred: usize,
    pub rejected: usize,
    pub blocked: usize,
    pub duplicate_noops: usize,
    pub conflicts: usize,
    pub approval_required: usize,
    pub blockers: usize,
    pub missing_ref_blockers: usize,
    pub admission_blockers: usize,
    pub raw_payload_blockers: usize,
    pub effect_blockers: usize,
    pub provenance_refs: usize,
    pub evidence_refs: usize,
}
