use crate::accepted_memory_projection_import_conflicts::AcceptedMemoryProjectionImportConflictRecord;
use crate::provider_no_effects::MemoryApplyNoEffects;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportApplyAdmissionInput {
    pub request_id: String,
    pub operator_ref: String,
    pub approval_ref: String,
    pub provenance_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub conflict: AcceptedMemoryProjectionImportConflictRecord,
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
pub struct AcceptedMemoryProjectionImportApplyAdmissionSet {
    pub records: Vec<AcceptedMemoryProjectionImportApplyAdmissionRecord>,
    pub counts: AcceptedMemoryProjectionImportApplyAdmissionCounts,
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportApplyAdmissionRecord {
    pub apply_admission_ref: String,
    pub request_id: String,
    pub import_admission_ref: String,
    pub conflict_ref: String,
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub operator_ref: String,
    pub approval_ref: String,
    pub provenance_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub status: AcceptedMemoryProjectionImportApplyAdmissionStatus,
    pub blockers: Vec<AcceptedMemoryProjectionImportApplyAdmissionBlocker>,
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionImportApplyAdmissionStatus {
    Admitted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionImportApplyAdmissionBlocker {
    MissingRequestId,
    MissingOperatorRef,
    MissingApprovalRef,
    MissingProvenanceRefs,
    MissingEvidenceRefs,
    MissingImportAdmissionRef,
    MissingConflictRef,
    MissingCandidateRef,
    MissingMemoryId,
    MissingFileRef,
    DuplicateNoop,
    UnresolvedSemanticConflict,
    UnresolvedPolicyConflict,
    ImportConflictBlocked,
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
pub struct AcceptedMemoryProjectionImportApplyAdmissionCounts {
    pub inputs: usize,
    pub admitted: usize,
    pub duplicate_noops: usize,
    pub blocked: usize,
    pub blockers: usize,
    pub missing_ref_blockers: usize,
    pub conflict_blockers: usize,
    pub raw_payload_blockers: usize,
    pub effect_blockers: usize,
}
