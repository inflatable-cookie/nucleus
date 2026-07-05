use crate::accepted_memory_projection::{AcceptedMemorySummary, AcceptedMemorySummaryStatus};
use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionRecord,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};
use crate::accepted_memory_projection_import_conflicts::{
    AcceptedMemoryProjectionImportConflictRecord, AcceptedMemoryProjectionImportConflictStatus,
};
use crate::accepted_memory_projection_import_records::{
    AcceptedMemoryProjectionImportAdmissionRecord, AcceptedMemoryProjectionImportAdmissionStatus,
    AcceptedMemoryProjectionImportCandidateRecord, AcceptedMemoryProjectionImportCandidateStatus,
};
use crate::accepted_memory_projection_policy::AcceptedMemoryProjectionPolicyStatus;
use crate::accepted_memory_projection_write_admission::AcceptedMemoryProjectionWriteAdmissionStatus;
use crate::accepted_memory_projection_write_diagnostics::AcceptedMemoryProjectionWriteDiagnosticEntry;

use super::types::{
    AcceptedMemoryReviewReadinessRecord, AcceptedMemoryReviewReadinessSource,
    AcceptedMemoryReviewReadinessStatus,
};

pub(super) fn from_accepted_memories(
    memories: &[AcceptedMemorySummary],
) -> Vec<AcceptedMemoryReviewReadinessRecord> {
    memories.iter().map(from_accepted_memory).collect()
}

pub(super) fn from_projection_writes(
    entries: &[AcceptedMemoryProjectionWriteDiagnosticEntry],
) -> Vec<AcceptedMemoryReviewReadinessRecord> {
    entries.iter().flat_map(from_projection_write).collect()
}

pub(super) fn from_import_candidates(
    candidates: &[AcceptedMemoryProjectionImportCandidateRecord],
) -> Vec<AcceptedMemoryReviewReadinessRecord> {
    candidates.iter().map(from_import_candidate).collect()
}

pub(super) fn from_import_admissions(
    admissions: &[AcceptedMemoryProjectionImportAdmissionRecord],
) -> Vec<AcceptedMemoryReviewReadinessRecord> {
    admissions.iter().map(from_import_admission).collect()
}

pub(super) fn from_import_conflicts(
    conflicts: &[AcceptedMemoryProjectionImportConflictRecord],
) -> Vec<AcceptedMemoryReviewReadinessRecord> {
    conflicts.iter().map(from_import_conflict).collect()
}

pub(super) fn from_apply_admissions(
    admissions: &[AcceptedMemoryProjectionImportApplyAdmissionRecord],
) -> Vec<AcceptedMemoryReviewReadinessRecord> {
    admissions.iter().map(from_apply_admission).collect()
}

fn from_accepted_memory(memory: &AcceptedMemorySummary) -> AcceptedMemoryReviewReadinessRecord {
    AcceptedMemoryReviewReadinessRecord {
        source: AcceptedMemoryReviewReadinessSource::AcceptedMemory,
        memory_id: Some(memory.memory_id.clone()),
        source_ref: format!("accepted-memory:{}", memory.memory_id),
        file_ref: None,
        status: AcceptedMemoryReviewReadinessStatus::AcceptedMemoryPresent,
        blocker_count: usize::from(memory.status != AcceptedMemorySummaryStatus::Accepted),
        evidence_ref_count: memory.evidence_ref_count,
        approval_required: false,
    }
}

fn from_projection_write(
    entry: &AcceptedMemoryProjectionWriteDiagnosticEntry,
) -> Vec<AcceptedMemoryReviewReadinessRecord> {
    vec![
        AcceptedMemoryReviewReadinessRecord {
            source: AcceptedMemoryReviewReadinessSource::ProjectionPolicy,
            memory_id: Some(entry.memory_id.clone()),
            source_ref: entry.plan_ref.clone(),
            file_ref: entry.file_ref.clone(),
            status: projection_policy_status(&entry.policy_status),
            blocker_count: entry.policy_blockers.len() + entry.export_blockers.len(),
            evidence_ref_count: 0,
            approval_required: false,
        },
        AcceptedMemoryReviewReadinessRecord {
            source: AcceptedMemoryReviewReadinessSource::ProjectionWrite,
            memory_id: Some(entry.memory_id.clone()),
            source_ref: entry.plan_ref.clone(),
            file_ref: entry.file_ref.clone(),
            status: projection_write_status(&entry.admission_status),
            blocker_count: entry.admission_blockers.len() + entry.payload_blockers.len(),
            evidence_ref_count: 0,
            approval_required: false,
        },
    ]
}

fn from_import_candidate(
    candidate: &AcceptedMemoryProjectionImportCandidateRecord,
) -> AcceptedMemoryReviewReadinessRecord {
    AcceptedMemoryReviewReadinessRecord {
        source: AcceptedMemoryReviewReadinessSource::ImportCandidate,
        memory_id: candidate.memory_id.clone(),
        source_ref: candidate.candidate_ref.clone(),
        file_ref: Some(candidate.file_ref.clone()),
        status: match candidate.status {
            AcceptedMemoryProjectionImportCandidateStatus::Ready => {
                AcceptedMemoryReviewReadinessStatus::ImportCandidateReady
            }
            AcceptedMemoryProjectionImportCandidateStatus::Blocked => {
                AcceptedMemoryReviewReadinessStatus::ImportCandidateBlocked
            }
        },
        blocker_count: candidate.blockers.len(),
        evidence_ref_count: 0,
        approval_required: false,
    }
}

fn from_import_admission(
    admission: &AcceptedMemoryProjectionImportAdmissionRecord,
) -> AcceptedMemoryReviewReadinessRecord {
    AcceptedMemoryReviewReadinessRecord {
        source: AcceptedMemoryReviewReadinessSource::ImportAdmission,
        memory_id: admission.memory_id.clone(),
        source_ref: admission.admission_ref.clone(),
        file_ref: Some(admission.file_ref.clone()),
        status: match admission.status {
            AcceptedMemoryProjectionImportAdmissionStatus::Admitted => {
                AcceptedMemoryReviewReadinessStatus::ImportAdmitted
            }
            AcceptedMemoryProjectionImportAdmissionStatus::Blocked => {
                AcceptedMemoryReviewReadinessStatus::ImportBlocked
            }
        },
        blocker_count: admission.blockers.len(),
        evidence_ref_count: 0,
        approval_required: false,
    }
}

fn from_import_conflict(
    conflict: &AcceptedMemoryProjectionImportConflictRecord,
) -> AcceptedMemoryReviewReadinessRecord {
    AcceptedMemoryReviewReadinessRecord {
        source: AcceptedMemoryReviewReadinessSource::ImportConflict,
        memory_id: conflict.memory_id.clone(),
        source_ref: conflict.conflict_ref.clone(),
        file_ref: Some(conflict.file_ref.clone()),
        status: import_conflict_status(&conflict.status),
        blocker_count: conflict.blockers.len(),
        evidence_ref_count: 0,
        approval_required: false,
    }
}

fn from_apply_admission(
    admission: &AcceptedMemoryProjectionImportApplyAdmissionRecord,
) -> AcceptedMemoryReviewReadinessRecord {
    let approval_required = apply_admission_requires_approval(admission);

    AcceptedMemoryReviewReadinessRecord {
        source: AcceptedMemoryReviewReadinessSource::ImportApplyAdmission,
        memory_id: admission.memory_id.clone(),
        source_ref: admission.apply_admission_ref.clone(),
        file_ref: Some(admission.file_ref.clone()),
        status: apply_admission_status(admission, approval_required),
        blocker_count: admission.blockers.len(),
        evidence_ref_count: admission.evidence_refs.len(),
        approval_required,
    }
}

fn projection_policy_status(
    status: &AcceptedMemoryProjectionPolicyStatus,
) -> AcceptedMemoryReviewReadinessStatus {
    match status {
        AcceptedMemoryProjectionPolicyStatus::Projectable => {
            AcceptedMemoryReviewReadinessStatus::Projectable
        }
        AcceptedMemoryProjectionPolicyStatus::LocalOnly
        | AcceptedMemoryProjectionPolicyStatus::Blocked
        | AcceptedMemoryProjectionPolicyStatus::ReviewRequired => {
            AcceptedMemoryReviewReadinessStatus::ProjectionBlocked
        }
    }
}

fn projection_write_status(
    status: &AcceptedMemoryProjectionWriteAdmissionStatus,
) -> AcceptedMemoryReviewReadinessStatus {
    match status {
        AcceptedMemoryProjectionWriteAdmissionStatus::Admitted => {
            AcceptedMemoryReviewReadinessStatus::ProjectionWriteAdmitted
        }
        AcceptedMemoryProjectionWriteAdmissionStatus::Blocked => {
            AcceptedMemoryReviewReadinessStatus::ProjectionWriteBlocked
        }
    }
}

fn import_conflict_status(
    status: &AcceptedMemoryProjectionImportConflictStatus,
) -> AcceptedMemoryReviewReadinessStatus {
    match status {
        AcceptedMemoryProjectionImportConflictStatus::NoConflict => {
            AcceptedMemoryReviewReadinessStatus::ImportAdmitted
        }
        AcceptedMemoryProjectionImportConflictStatus::DuplicateNoop => {
            AcceptedMemoryReviewReadinessStatus::DuplicateNoop
        }
        AcceptedMemoryProjectionImportConflictStatus::SemanticConflict
        | AcceptedMemoryProjectionImportConflictStatus::PolicyConflict => {
            AcceptedMemoryReviewReadinessStatus::Conflict
        }
        AcceptedMemoryProjectionImportConflictStatus::Blocked => {
            AcceptedMemoryReviewReadinessStatus::ImportBlocked
        }
    }
}

fn apply_admission_status(
    admission: &AcceptedMemoryProjectionImportApplyAdmissionRecord,
    approval_required: bool,
) -> AcceptedMemoryReviewReadinessStatus {
    if approval_required {
        return AcceptedMemoryReviewReadinessStatus::ApprovalRequired;
    }

    match admission.status {
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted => {
            AcceptedMemoryReviewReadinessStatus::ApplyAdmitted
        }
        AcceptedMemoryProjectionImportApplyAdmissionStatus::DuplicateNoop => {
            AcceptedMemoryReviewReadinessStatus::DuplicateNoop
        }
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked => {
            AcceptedMemoryReviewReadinessStatus::ApplyBlocked
        }
    }
}

fn apply_admission_requires_approval(
    admission: &AcceptedMemoryProjectionImportApplyAdmissionRecord,
) -> bool {
    admission.blockers.iter().any(|blocker| {
        matches!(
            blocker,
            AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingOperatorRef
                | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingApprovalRef
        )
    })
}
