use crate::provider_no_effects::MemoryApplyNoEffects;
use nucleus_projects::ProjectId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReviewReadiness {
    pub project_id: ProjectId,
    pub records: Vec<AcceptedMemoryReviewReadinessRecord>,
    pub counts: AcceptedMemoryReviewReadinessCounts,
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReviewReadinessRecord {
    pub source: AcceptedMemoryReviewReadinessSource,
    pub memory_id: Option<String>,
    pub source_ref: String,
    pub file_ref: Option<String>,
    pub status: AcceptedMemoryReviewReadinessStatus,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub approval_required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryReviewReadinessSource {
    AcceptedMemory,
    ProjectionPolicy,
    ProjectionWrite,
    ImportCandidate,
    ImportAdmission,
    ImportConflict,
    ImportApplyAdmission,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryReviewReadinessStatus {
    AcceptedMemoryPresent,
    Projectable,
    ProjectionBlocked,
    ProjectionWriteAdmitted,
    ProjectionWriteBlocked,
    ImportCandidateReady,
    ImportCandidateBlocked,
    ImportAdmitted,
    ImportBlocked,
    DuplicateNoop,
    Conflict,
    ApplyAdmitted,
    ApprovalRequired,
    ApplyBlocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReviewReadinessCounts {
    pub records: usize,
    pub accepted_memories: usize,
    pub projectable: usize,
    pub projection_blocked: usize,
    pub projection_write_admitted: usize,
    pub projection_write_blocked: usize,
    pub import_candidates_ready: usize,
    pub import_candidates_blocked: usize,
    pub import_admitted: usize,
    pub import_blocked: usize,
    pub duplicate_noops: usize,
    pub conflicts: usize,
    pub apply_admitted: usize,
    pub approval_required: usize,
    pub apply_blocked: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
}
