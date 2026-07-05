use crate::accepted_memory_projection_import_admission::{
    AcceptedMemoryProjectionImportAdmissionBlocker, AcceptedMemoryProjectionImportAdmissionStatus,
    AcceptedMemoryProjectionImportCandidateBlocker, AcceptedMemoryProjectionImportCandidateStatus,
};
use crate::accepted_memory_projection_import_conflicts::{
    AcceptedMemoryProjectionImportConflictBlocker, AcceptedMemoryProjectionImportConflictStatus,
};

use super::accepted_memory_projection_import::ControlAcceptedMemoryProjectionImportBlockerDto;

pub(super) fn candidate_status(status: &AcceptedMemoryProjectionImportCandidateStatus) -> String {
    match status {
        AcceptedMemoryProjectionImportCandidateStatus::Ready => "ready",
        AcceptedMemoryProjectionImportCandidateStatus::Blocked => "blocked",
    }
    .to_owned()
}

pub(super) fn admission_status(status: &AcceptedMemoryProjectionImportAdmissionStatus) -> String {
    match status {
        AcceptedMemoryProjectionImportAdmissionStatus::Admitted => "admitted",
        AcceptedMemoryProjectionImportAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

pub(super) fn conflict_status(status: &AcceptedMemoryProjectionImportConflictStatus) -> String {
    match status {
        AcceptedMemoryProjectionImportConflictStatus::NoConflict => "no_conflict",
        AcceptedMemoryProjectionImportConflictStatus::DuplicateNoop => "duplicate_noop",
        AcceptedMemoryProjectionImportConflictStatus::SemanticConflict => "semantic_conflict",
        AcceptedMemoryProjectionImportConflictStatus::PolicyConflict => "policy_conflict",
        AcceptedMemoryProjectionImportConflictStatus::Blocked => "blocked",
    }
    .to_owned()
}

pub(super) fn candidate_blocker(
    blocker_value: &AcceptedMemoryProjectionImportCandidateBlocker,
) -> ControlAcceptedMemoryProjectionImportBlockerDto {
    match blocker_value {
        AcceptedMemoryProjectionImportCandidateBlocker::UnsafeFileRef { reason } => {
            blocker("unsafe_file_ref", Some(reason.clone()))
        }
        AcceptedMemoryProjectionImportCandidateBlocker::DecodeFailed { reason } => {
            blocker("decode_failed", Some(reason.clone()))
        }
        AcceptedMemoryProjectionImportCandidateBlocker::UnsupportedSchema { schema_version } => {
            blocker("unsupported_schema", Some(schema_version.to_string()))
        }
        AcceptedMemoryProjectionImportCandidateBlocker::MissingMemoryId => {
            blocker("missing_memory_id", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::MemoryIdFileRefMismatch {
            expected_file_ref,
        } => blocker(
            "memory_id_file_ref_mismatch",
            Some(expected_file_ref.clone()),
        ),
        AcceptedMemoryProjectionImportCandidateBlocker::MissingProjectScope => {
            blocker("missing_project_scope", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::OutOfScopeProject { .. } => {
            blocker("out_of_scope_project", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::UnsupportedMemoryKind { kind } => {
            blocker("unsupported_memory_kind", Some(kind.clone()))
        }
        AcceptedMemoryProjectionImportCandidateBlocker::NonAcceptedStatus { status } => {
            blocker("non_accepted_status", Some(format!("{status:?}")))
        }
        AcceptedMemoryProjectionImportCandidateBlocker::UserPrivateSensitivity => {
            blocker("user_private_sensitivity", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::SecretAdjacentSensitivity => {
            blocker("secret_adjacent_sensitivity", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::RestrictedSensitivity => {
            blocker("restricted_sensitivity", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::ReviewQueueRetention => {
            blocker("review_queue_retention", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::LocalOnlyRetention => {
            blocker("local_only_retention", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::ExpiringRetention => {
            blocker("expiring_retention", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::ArchiveRetention => {
            blocker("archive_retention", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::MissingAcceptedByRef => {
            blocker("missing_accepted_by_ref", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::MissingReviewerRef => {
            blocker("missing_reviewer_ref", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::MissingAcceptedAt => {
            blocker("missing_accepted_at", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::DuplicateFileRef => {
            blocker("duplicate_file_ref", None)
        }
        AcceptedMemoryProjectionImportCandidateBlocker::DuplicateMemoryId => {
            blocker("duplicate_memory_id", None)
        }
    }
}

pub(super) fn admission_blocker(
    blocker_value: &AcceptedMemoryProjectionImportAdmissionBlocker,
) -> ControlAcceptedMemoryProjectionImportBlockerDto {
    match blocker_value {
        AcceptedMemoryProjectionImportAdmissionBlocker::CandidateNotReady => {
            blocker("candidate_not_ready", None)
        }
        AcceptedMemoryProjectionImportAdmissionBlocker::CandidateBlockersPresent => {
            blocker("candidate_blockers_present", None)
        }
        AcceptedMemoryProjectionImportAdmissionBlocker::DuplicateCandidate => {
            blocker("duplicate_candidate", None)
        }
        AcceptedMemoryProjectionImportAdmissionBlocker::MissingDecodedPayload => {
            blocker("missing_decoded_payload", None)
        }
    }
}

pub(super) fn conflict_blocker(
    blocker_value: &AcceptedMemoryProjectionImportConflictBlocker,
) -> ControlAcceptedMemoryProjectionImportBlockerDto {
    match blocker_value {
        AcceptedMemoryProjectionImportConflictBlocker::AdmissionNotAdmitted => {
            blocker("admission_not_admitted", None)
        }
        AcceptedMemoryProjectionImportConflictBlocker::MissingMemoryId => {
            blocker("missing_memory_id", None)
        }
        AcceptedMemoryProjectionImportConflictBlocker::MissingPayload => {
            blocker("missing_payload", None)
        }
        AcceptedMemoryProjectionImportConflictBlocker::BodyMismatch => {
            blocker("body_mismatch", None)
        }
        AcceptedMemoryProjectionImportConflictBlocker::SupersessionMismatch => {
            blocker("supersession_mismatch", None)
        }
        AcceptedMemoryProjectionImportConflictBlocker::ReviewEvidenceMismatch => {
            blocker("review_evidence_mismatch", None)
        }
        AcceptedMemoryProjectionImportConflictBlocker::SensitivityMismatch => {
            blocker("sensitivity_mismatch", None)
        }
        AcceptedMemoryProjectionImportConflictBlocker::RetentionMismatch => {
            blocker("retention_mismatch", None)
        }
    }
}

fn blocker(kind: &str, detail: Option<String>) -> ControlAcceptedMemoryProjectionImportBlockerDto {
    ControlAcceptedMemoryProjectionImportBlockerDto {
        kind: kind.to_owned(),
        detail,
    }
}
