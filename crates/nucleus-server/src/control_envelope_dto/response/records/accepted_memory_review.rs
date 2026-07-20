use crate::provider_no_effects::MemoryApplyNoEffects;
use serde::{Deserialize, Serialize};

use crate::accepted_memory_review_readiness::{
    AcceptedMemoryReviewReadiness, AcceptedMemoryReviewReadinessCounts,
    AcceptedMemoryReviewReadinessRecord, AcceptedMemoryReviewReadinessSource,
    AcceptedMemoryReviewReadinessStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryReviewReadinessDto {
    pub project_id: String,
    pub records: Vec<ControlAcceptedMemoryReviewReadinessRecordDto>,
    pub counts: ControlAcceptedMemoryReviewReadinessCountsDto,
    #[serde(flatten)]
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryReviewReadinessRecordDto {
    pub source: String,
    pub memory_id: Option<String>,
    pub source_ref: String,
    pub file_ref: Option<String>,
    pub status: String,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    #[ts(as = "u32")]
    pub evidence_ref_count: usize,
    pub approval_required: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryReviewReadinessCountsDto {
    #[ts(as = "u32")]
    pub records: usize,
    #[ts(as = "u32")]
    pub accepted_memories: usize,
    #[ts(as = "u32")]
    pub projectable: usize,
    #[ts(as = "u32")]
    pub projection_blocked: usize,
    #[ts(as = "u32")]
    pub projection_write_admitted: usize,
    #[ts(as = "u32")]
    pub projection_write_blocked: usize,
    #[ts(as = "u32")]
    pub import_candidates_ready: usize,
    #[ts(as = "u32")]
    pub import_candidates_blocked: usize,
    #[ts(as = "u32")]
    pub import_admitted: usize,
    #[ts(as = "u32")]
    pub import_blocked: usize,
    #[ts(as = "u32")]
    pub duplicate_noops: usize,
    #[ts(as = "u32")]
    pub conflicts: usize,
    #[ts(as = "u32")]
    pub apply_admitted: usize,
    #[ts(as = "u32")]
    pub approval_required: usize,
    #[ts(as = "u32")]
    pub apply_blocked: usize,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    #[ts(as = "u32")]
    pub evidence_ref_count: usize,
}

impl From<&AcceptedMemoryReviewReadiness> for ControlAcceptedMemoryReviewReadinessDto {
    fn from(readiness: &AcceptedMemoryReviewReadiness) -> Self {
        Self {
            project_id: readiness.project_id.0.clone(),
            records: readiness
                .records
                .iter()
                .map(ControlAcceptedMemoryReviewReadinessRecordDto::from)
                .collect(),
            counts: ControlAcceptedMemoryReviewReadinessCountsDto::from(&readiness.counts),
            no_effects: readiness.no_effects,
        }
    }
}

impl From<&AcceptedMemoryReviewReadinessRecord> for ControlAcceptedMemoryReviewReadinessRecordDto {
    fn from(record: &AcceptedMemoryReviewReadinessRecord) -> Self {
        Self {
            source: readiness_source(&record.source),
            memory_id: record.memory_id.clone(),
            source_ref: record.source_ref.clone(),
            file_ref: record.file_ref.clone(),
            status: readiness_status(&record.status),
            blocker_count: record.blocker_count,
            evidence_ref_count: record.evidence_ref_count,
            approval_required: record.approval_required,
        }
    }
}

impl From<&AcceptedMemoryReviewReadinessCounts> for ControlAcceptedMemoryReviewReadinessCountsDto {
    fn from(counts: &AcceptedMemoryReviewReadinessCounts) -> Self {
        Self {
            records: counts.records,
            accepted_memories: counts.accepted_memories,
            projectable: counts.projectable,
            projection_blocked: counts.projection_blocked,
            projection_write_admitted: counts.projection_write_admitted,
            projection_write_blocked: counts.projection_write_blocked,
            import_candidates_ready: counts.import_candidates_ready,
            import_candidates_blocked: counts.import_candidates_blocked,
            import_admitted: counts.import_admitted,
            import_blocked: counts.import_blocked,
            duplicate_noops: counts.duplicate_noops,
            conflicts: counts.conflicts,
            apply_admitted: counts.apply_admitted,
            approval_required: counts.approval_required,
            apply_blocked: counts.apply_blocked,
            blocker_count: counts.blocker_count,
            evidence_ref_count: counts.evidence_ref_count,
        }
    }
}

fn readiness_source(source: &AcceptedMemoryReviewReadinessSource) -> String {
    match source {
        AcceptedMemoryReviewReadinessSource::AcceptedMemory => "accepted_memory",
        AcceptedMemoryReviewReadinessSource::ProjectionPolicy => "projection_policy",
        AcceptedMemoryReviewReadinessSource::ProjectionWrite => "projection_write",
        AcceptedMemoryReviewReadinessSource::ImportCandidate => "import_candidate",
        AcceptedMemoryReviewReadinessSource::ImportAdmission => "import_admission",
        AcceptedMemoryReviewReadinessSource::ImportConflict => "import_conflict",
        AcceptedMemoryReviewReadinessSource::ImportApplyAdmission => "import_apply_admission",
    }
    .to_owned()
}

fn readiness_status(status: &AcceptedMemoryReviewReadinessStatus) -> String {
    match status {
        AcceptedMemoryReviewReadinessStatus::AcceptedMemoryPresent => "accepted_memory_present",
        AcceptedMemoryReviewReadinessStatus::Projectable => "projectable",
        AcceptedMemoryReviewReadinessStatus::ProjectionBlocked => "projection_blocked",
        AcceptedMemoryReviewReadinessStatus::ProjectionWriteAdmitted => "projection_write_admitted",
        AcceptedMemoryReviewReadinessStatus::ProjectionWriteBlocked => "projection_write_blocked",
        AcceptedMemoryReviewReadinessStatus::ImportCandidateReady => "import_candidate_ready",
        AcceptedMemoryReviewReadinessStatus::ImportCandidateBlocked => "import_candidate_blocked",
        AcceptedMemoryReviewReadinessStatus::ImportAdmitted => "import_admitted",
        AcceptedMemoryReviewReadinessStatus::ImportBlocked => "import_blocked",
        AcceptedMemoryReviewReadinessStatus::DuplicateNoop => "duplicate_noop",
        AcceptedMemoryReviewReadinessStatus::Conflict => "conflict",
        AcceptedMemoryReviewReadinessStatus::ApplyAdmitted => "apply_admitted",
        AcceptedMemoryReviewReadinessStatus::ApprovalRequired => "approval_required",
        AcceptedMemoryReviewReadinessStatus::ApplyBlocked => "apply_blocked",
    }
    .to_owned()
}
