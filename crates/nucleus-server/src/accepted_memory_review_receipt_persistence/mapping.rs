use nucleus_memory::{
    AcceptedMemoryReviewReceiptAdmissionBlockerStorage,
    AcceptedMemoryReviewReceiptAdmissionStatusStorage, AcceptedMemoryReviewReceiptBlockerStorage,
    AcceptedMemoryReviewReceiptDecisionStorage, AcceptedMemoryReviewReceiptStatusStorage,
    AcceptedMemoryReviewReceiptStorageRecord,
    ACCEPTED_MEMORY_REVIEW_RECEIPT_STORAGE_SCHEMA_VERSION,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_import_apply_review_command::{
    AcceptedMemoryImportApplyReviewBlocker, AcceptedMemoryImportApplyReviewDecision,
    AcceptedMemoryImportApplyReviewReceipt, AcceptedMemoryImportApplyReviewStatus,
};
use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};

/// Build the sanitized durable storage record for a review receipt.
pub fn accepted_memory_review_receipt_storage_record(
    project_id: ProjectId,
    receipt: &AcceptedMemoryImportApplyReviewReceipt,
) -> AcceptedMemoryReviewReceiptStorageRecord {
    AcceptedMemoryReviewReceiptStorageRecord {
        schema_version: ACCEPTED_MEMORY_REVIEW_RECEIPT_STORAGE_SCHEMA_VERSION,
        review_receipt_id: receipt.review_receipt_ref.clone(),
        project_id: project_id.0,
        command_id: receipt.command_id.clone(),
        operator_ref: receipt.operator_ref.clone(),
        approval_ref: non_empty_option(&receipt.approval_ref),
        decision_reason_ref: non_empty_option(&receipt.decision_reason_ref),
        apply_admission_ref: receipt.apply_admission_ref.clone(),
        import_admission_ref: receipt.import_admission_ref.clone(),
        conflict_ref: receipt.conflict_ref.clone(),
        candidate_ref: receipt.candidate_ref.clone(),
        memory_id: receipt.memory_id.clone().unwrap_or_default(),
        file_ref: receipt.file_ref.clone(),
        provenance_refs: receipt.provenance_refs.clone(),
        evidence_refs: receipt.evidence_refs.clone(),
        decision: review_decision_storage(&receipt.decision),
        status: review_status_storage(&receipt.status),
        admission_status: admission_status_storage(&receipt.admission_status),
        blockers: receipt
            .blockers
            .iter()
            .map(review_blocker_storage)
            .collect(),
        admission_blockers: receipt
            .admission_blockers
            .iter()
            .map(admission_blocker_storage)
            .collect(),
        reviewed_at: None,
        updated_at: None,
    }
}

fn non_empty_option(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn review_decision_storage(
    value: &AcceptedMemoryImportApplyReviewDecision,
) -> AcceptedMemoryReviewReceiptDecisionStorage {
    match value {
        AcceptedMemoryImportApplyReviewDecision::Approve => {
            AcceptedMemoryReviewReceiptDecisionStorage::Approve
        }
        AcceptedMemoryImportApplyReviewDecision::Defer => {
            AcceptedMemoryReviewReceiptDecisionStorage::Defer
        }
        AcceptedMemoryImportApplyReviewDecision::Reject => {
            AcceptedMemoryReviewReceiptDecisionStorage::Reject
        }
    }
}

fn review_status_storage(
    value: &AcceptedMemoryImportApplyReviewStatus,
) -> AcceptedMemoryReviewReceiptStatusStorage {
    match value {
        AcceptedMemoryImportApplyReviewStatus::Approved => {
            AcceptedMemoryReviewReceiptStatusStorage::Approved
        }
        AcceptedMemoryImportApplyReviewStatus::Deferred => {
            AcceptedMemoryReviewReceiptStatusStorage::Deferred
        }
        AcceptedMemoryImportApplyReviewStatus::Rejected => {
            AcceptedMemoryReviewReceiptStatusStorage::Rejected
        }
        AcceptedMemoryImportApplyReviewStatus::Blocked => {
            AcceptedMemoryReviewReceiptStatusStorage::Blocked
        }
    }
}

fn admission_status_storage(
    value: &AcceptedMemoryProjectionImportApplyAdmissionStatus,
) -> AcceptedMemoryReviewReceiptAdmissionStatusStorage {
    match value {
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted => {
            AcceptedMemoryReviewReceiptAdmissionStatusStorage::Admitted
        }
        AcceptedMemoryProjectionImportApplyAdmissionStatus::DuplicateNoop => {
            AcceptedMemoryReviewReceiptAdmissionStatusStorage::DuplicateNoop
        }
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked => {
            AcceptedMemoryReviewReceiptAdmissionStatusStorage::Blocked
        }
    }
}

fn review_blocker_storage(
    value: &AcceptedMemoryImportApplyReviewBlocker,
) -> AcceptedMemoryReviewReceiptBlockerStorage {
    match value {
        AcceptedMemoryImportApplyReviewBlocker::MissingCommandId => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingCommandId
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingOperatorRef => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingOperatorRef
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingApprovalRef => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingApprovalRef
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingDecisionReasonRef => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingDecisionReasonRef
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingProvenanceRefs => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingProvenanceRefs
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingEvidenceRefs => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingEvidenceRefs
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingApplyAdmissionRef => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingApplyAdmissionRef
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingImportAdmissionRef => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingImportAdmissionRef
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingConflictRef => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingConflictRef
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingCandidateRef => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingCandidateRef
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingMemoryId => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingMemoryId
        }
        AcceptedMemoryImportApplyReviewBlocker::MissingFileRef => {
            AcceptedMemoryReviewReceiptBlockerStorage::MissingFileRef
        }
        AcceptedMemoryImportApplyReviewBlocker::AdmissionNotAdmitted => {
            AcceptedMemoryReviewReceiptBlockerStorage::AdmissionNotAdmitted
        }
        AcceptedMemoryImportApplyReviewBlocker::AdmissionDuplicateNoop => {
            AcceptedMemoryReviewReceiptBlockerStorage::AdmissionDuplicateNoop
        }
        AcceptedMemoryImportApplyReviewBlocker::AdmissionBlocked => {
            AcceptedMemoryReviewReceiptBlockerStorage::AdmissionBlocked
        }
        AcceptedMemoryImportApplyReviewBlocker::AdmissionBlockersPresent => {
            AcceptedMemoryReviewReceiptBlockerStorage::AdmissionBlockersPresent
        }
        AcceptedMemoryImportApplyReviewBlocker::RawPayloadPresent => {
            AcceptedMemoryReviewReceiptBlockerStorage::RawPayloadPresent
        }
        AcceptedMemoryImportApplyReviewBlocker::ActiveMemoryMutationRequested => {
            AcceptedMemoryReviewReceiptBlockerStorage::ActiveMemoryMutationRequested
        }
        AcceptedMemoryImportApplyReviewBlocker::ProjectionWriteRequested => {
            AcceptedMemoryReviewReceiptBlockerStorage::ProjectionWriteRequested
        }
        AcceptedMemoryImportApplyReviewBlocker::ScmEffectRequested => {
            AcceptedMemoryReviewReceiptBlockerStorage::ScmEffectRequested
        }
        AcceptedMemoryImportApplyReviewBlocker::EmbeddingRequested => {
            AcceptedMemoryReviewReceiptBlockerStorage::EmbeddingRequested
        }
        AcceptedMemoryImportApplyReviewBlocker::ProviderSyncRequested => {
            AcceptedMemoryReviewReceiptBlockerStorage::ProviderSyncRequested
        }
        AcceptedMemoryImportApplyReviewBlocker::AutomaticExtractionRequested => {
            AcceptedMemoryReviewReceiptBlockerStorage::AutomaticExtractionRequested
        }
        AcceptedMemoryImportApplyReviewBlocker::TaskMutationRequested => {
            AcceptedMemoryReviewReceiptBlockerStorage::TaskMutationRequested
        }
        AcceptedMemoryImportApplyReviewBlocker::AgentSchedulingRequested => {
            AcceptedMemoryReviewReceiptBlockerStorage::AgentSchedulingRequested
        }
        AcceptedMemoryImportApplyReviewBlocker::UiEffectRequested => {
            AcceptedMemoryReviewReceiptBlockerStorage::UiEffectRequested
        }
    }
}

fn admission_blocker_storage(
    value: &AcceptedMemoryProjectionImportApplyAdmissionBlocker,
) -> AcceptedMemoryReviewReceiptAdmissionBlockerStorage {
    match value {
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingRequestId => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingRequestId
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingOperatorRef => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingOperatorRef
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingApprovalRef => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingApprovalRef
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingProvenanceRefs => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingProvenanceRefs
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingEvidenceRefs => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingEvidenceRefs
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingImportAdmissionRef => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingImportAdmissionRef
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingConflictRef => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingConflictRef
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingCandidateRef => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingCandidateRef
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingMemoryId => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingMemoryId
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingFileRef => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::MissingFileRef
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::DuplicateNoop => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::DuplicateNoop
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedSemanticConflict => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::UnresolvedSemanticConflict
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedPolicyConflict => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::UnresolvedPolicyConflict
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ImportConflictBlocked => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::ImportConflictBlocked
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::RawPayloadPresent => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::RawPayloadPresent
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ActiveMemoryMutationRequested => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::ActiveMemoryMutationRequested
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ProjectionWriteRequested => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::ProjectionWriteRequested
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ScmEffectRequested => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::ScmEffectRequested
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::EmbeddingRequested => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::EmbeddingRequested
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ProviderSyncRequested => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::ProviderSyncRequested
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::AutomaticExtractionRequested => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::AutomaticExtractionRequested
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::TaskMutationRequested => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::TaskMutationRequested
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::AgentSchedulingRequested => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::AgentSchedulingRequested
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::UiEffectRequested => {
            AcceptedMemoryReviewReceiptAdmissionBlockerStorage::UiEffectRequested
        }
    }
}
