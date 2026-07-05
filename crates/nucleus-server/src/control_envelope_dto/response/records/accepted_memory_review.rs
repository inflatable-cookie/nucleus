use serde::{Deserialize, Serialize};

use crate::accepted_memory_review_readiness::{
    AcceptedMemoryReviewReadiness, AcceptedMemoryReviewReadinessCounts,
    AcceptedMemoryReviewReadinessRecord, AcceptedMemoryReviewReadinessSource,
    AcceptedMemoryReviewReadinessStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryReviewReadinessDto {
    pub project_id: String,
    pub records: Vec<ControlAcceptedMemoryReviewReadinessRecordDto>,
    pub counts: ControlAcceptedMemoryReviewReadinessCountsDto,
    pub active_memory_apply_performed: bool,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub automatic_extraction_performed: bool,
    pub task_mutation_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryReviewReadinessRecordDto {
    pub source: String,
    pub memory_id: Option<String>,
    pub source_ref: String,
    pub file_ref: Option<String>,
    pub status: String,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub approval_required: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlAcceptedMemoryReviewReadinessCountsDto {
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
            active_memory_apply_performed: readiness.active_memory_apply_performed,
            projection_write_performed: readiness.projection_write_performed,
            scm_effect_performed: readiness.scm_effect_performed,
            embedding_available: readiness.embedding_available,
            provider_sync_available: readiness.provider_sync_available,
            automatic_extraction_performed: readiness.automatic_extraction_performed,
            task_mutation_performed: readiness.task_mutation_performed,
            agent_scheduling_performed: readiness.agent_scheduling_performed,
            ui_effect_performed: readiness.ui_effect_performed,
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
