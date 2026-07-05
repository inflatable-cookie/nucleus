//! Accepted-memory projection import records.

use nucleus_memory::AcceptedMemoryStorageStatus;
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_payload::AcceptedMemoryProjectionPayload;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportInput {
    pub file_ref: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportAdmissionSet {
    pub project_id: ProjectId,
    pub candidates: Vec<AcceptedMemoryProjectionImportCandidateRecord>,
    pub admissions: Vec<AcceptedMemoryProjectionImportAdmissionRecord>,
    pub counts: AcceptedMemoryProjectionImportAdmissionCounts,
    pub active_memory_apply_performed: bool,
    pub scm_effect_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportCandidateRecord {
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub status: AcceptedMemoryProjectionImportCandidateStatus,
    pub payload: Option<AcceptedMemoryProjectionPayload>,
    pub summary: Option<AcceptedMemoryProjectionImportCandidateSummary>,
    pub blockers: Vec<AcceptedMemoryProjectionImportCandidateBlocker>,
    pub active_memory_apply_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportCandidateSummary {
    pub title: String,
    pub body_kind: String,
    pub body_summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportAdmissionRecord {
    pub admission_ref: String,
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub status: AcceptedMemoryProjectionImportAdmissionStatus,
    pub payload: Option<AcceptedMemoryProjectionPayload>,
    pub blockers: Vec<AcceptedMemoryProjectionImportAdmissionBlocker>,
    pub active_memory_apply_performed: bool,
    pub scm_effect_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionImportCandidateStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionImportAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionImportCandidateBlocker {
    UnsafeFileRef { reason: String },
    DecodeFailed { reason: String },
    UnsupportedSchema { schema_version: u16 },
    MissingMemoryId,
    MemoryIdFileRefMismatch { expected_file_ref: String },
    MissingProjectScope,
    OutOfScopeProject { expected_project_ref: String },
    UnsupportedMemoryKind { kind: String },
    NonAcceptedStatus { status: AcceptedMemoryStorageStatus },
    UserPrivateSensitivity,
    SecretAdjacentSensitivity,
    RestrictedSensitivity,
    ReviewQueueRetention,
    LocalOnlyRetention,
    ExpiringRetention,
    ArchiveRetention,
    MissingAcceptedByRef,
    MissingReviewerRef,
    MissingAcceptedAt,
    DuplicateFileRef,
    DuplicateMemoryId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionImportAdmissionBlocker {
    CandidateNotReady,
    CandidateBlockersPresent,
    DuplicateCandidate,
    MissingDecodedPayload,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportAdmissionCounts {
    pub inputs: usize,
    pub ready_candidates: usize,
    pub blocked_candidates: usize,
    pub admitted_imports: usize,
    pub blocked_imports: usize,
    pub unsafe_file_refs: usize,
    pub decode_failures: usize,
    pub unsupported_schemas: usize,
    pub duplicate_candidates: usize,
    pub policy_blockers: usize,
    pub review_blockers: usize,
    pub admission_blockers: usize,
}

impl AcceptedMemoryProjectionImportAdmissionCounts {
    pub(super) fn from_records(
        inputs: usize,
        candidates: &[AcceptedMemoryProjectionImportCandidateRecord],
        admissions: &[AcceptedMemoryProjectionImportAdmissionRecord],
    ) -> Self {
        let mut counts = Self {
            inputs,
            ready_candidates: 0,
            blocked_candidates: 0,
            admitted_imports: 0,
            blocked_imports: 0,
            unsafe_file_refs: 0,
            decode_failures: 0,
            unsupported_schemas: 0,
            duplicate_candidates: 0,
            policy_blockers: 0,
            review_blockers: 0,
            admission_blockers: 0,
        };

        count_candidates(&mut counts, candidates);
        count_admissions(&mut counts, admissions);
        counts
    }
}

fn count_candidates(
    counts: &mut AcceptedMemoryProjectionImportAdmissionCounts,
    candidates: &[AcceptedMemoryProjectionImportCandidateRecord],
) {
    for candidate in candidates {
        match candidate.status {
            AcceptedMemoryProjectionImportCandidateStatus::Ready => counts.ready_candidates += 1,
            AcceptedMemoryProjectionImportCandidateStatus::Blocked => {
                counts.blocked_candidates += 1;
            }
        }

        for blocker in &candidate.blockers {
            count_candidate_blocker(counts, blocker);
        }
    }
}

fn count_candidate_blocker(
    counts: &mut AcceptedMemoryProjectionImportAdmissionCounts,
    blocker: &AcceptedMemoryProjectionImportCandidateBlocker,
) {
    match blocker {
        AcceptedMemoryProjectionImportCandidateBlocker::UnsafeFileRef { .. } => {
            counts.unsafe_file_refs += 1;
        }
        AcceptedMemoryProjectionImportCandidateBlocker::DecodeFailed { .. } => {
            counts.decode_failures += 1;
        }
        AcceptedMemoryProjectionImportCandidateBlocker::UnsupportedSchema { .. } => {
            counts.unsupported_schemas += 1;
        }
        AcceptedMemoryProjectionImportCandidateBlocker::DuplicateFileRef
        | AcceptedMemoryProjectionImportCandidateBlocker::DuplicateMemoryId => {
            counts.duplicate_candidates += 1;
        }
        AcceptedMemoryProjectionImportCandidateBlocker::MissingProjectScope
        | AcceptedMemoryProjectionImportCandidateBlocker::OutOfScopeProject { .. }
        | AcceptedMemoryProjectionImportCandidateBlocker::UnsupportedMemoryKind { .. }
        | AcceptedMemoryProjectionImportCandidateBlocker::NonAcceptedStatus { .. }
        | AcceptedMemoryProjectionImportCandidateBlocker::UserPrivateSensitivity
        | AcceptedMemoryProjectionImportCandidateBlocker::SecretAdjacentSensitivity
        | AcceptedMemoryProjectionImportCandidateBlocker::RestrictedSensitivity
        | AcceptedMemoryProjectionImportCandidateBlocker::ReviewQueueRetention
        | AcceptedMemoryProjectionImportCandidateBlocker::LocalOnlyRetention
        | AcceptedMemoryProjectionImportCandidateBlocker::ExpiringRetention
        | AcceptedMemoryProjectionImportCandidateBlocker::ArchiveRetention => {
            counts.policy_blockers += 1;
        }
        AcceptedMemoryProjectionImportCandidateBlocker::MissingAcceptedByRef
        | AcceptedMemoryProjectionImportCandidateBlocker::MissingReviewerRef
        | AcceptedMemoryProjectionImportCandidateBlocker::MissingAcceptedAt => {
            counts.review_blockers += 1;
        }
        AcceptedMemoryProjectionImportCandidateBlocker::MissingMemoryId
        | AcceptedMemoryProjectionImportCandidateBlocker::MemoryIdFileRefMismatch { .. } => {}
    }
}

fn count_admissions(
    counts: &mut AcceptedMemoryProjectionImportAdmissionCounts,
    admissions: &[AcceptedMemoryProjectionImportAdmissionRecord],
) {
    for admission in admissions {
        match admission.status {
            AcceptedMemoryProjectionImportAdmissionStatus::Admitted => {
                counts.admitted_imports += 1;
            }
            AcceptedMemoryProjectionImportAdmissionStatus::Blocked => {
                counts.blocked_imports += 1;
            }
        }
        counts.admission_blockers += admission.blockers.len();
    }
}
