use nucleus_memory::{
    AcceptedMemoryReviewReceiptAdmissionStatusStorage, AcceptedMemoryReviewReceiptDecisionStorage,
    AcceptedMemoryReviewReceiptStatusStorage,
};

use crate::accepted_memory_active_apply_admission::{
    AcceptedMemoryActiveApplyAdmissionBlocker, AcceptedMemoryActiveApplyAdmissionInput,
};

pub(super) fn active_apply_blockers(
    input: &AcceptedMemoryActiveApplyAdmissionInput,
) -> Vec<AcceptedMemoryActiveApplyAdmissionBlocker> {
    let mut blockers = Vec::new();

    add_request_ref_blockers(&mut blockers, input);
    add_review_state_blockers(&mut blockers, input);
    add_stale_ref_blockers(&mut blockers, input);
    add_requested_effect_blockers(&mut blockers, input);

    blockers
}

pub(super) fn sorted_unique_non_empty(refs: Vec<String>) -> Vec<String> {
    let mut refs = refs
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    refs.sort();
    refs.dedup();
    refs
}

fn add_request_ref_blockers(
    blockers: &mut Vec<AcceptedMemoryActiveApplyAdmissionBlocker>,
    input: &AcceptedMemoryActiveApplyAdmissionInput,
) {
    if input.request_id.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingRequestId);
    }
    if input.operator_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingOperatorRef);
    }
    if input.approval_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingApprovalRef);
    }
    if input.review_receipt.review_receipt_id.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingReviewReceiptId);
    }
    if input
        .review_receipt
        .approval_ref
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingReviewApprovalRef);
    }
    if input.expected_apply_admission_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingApplyAdmissionRef);
    }
    if input.expected_import_admission_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingImportAdmissionRef);
    }
    if input.expected_conflict_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingConflictRef);
    }
    if input.expected_candidate_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingCandidateRef);
    }
    if input.expected_memory_id.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingMemoryId);
    }
    if input.expected_file_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingFileRef);
    }
    if sorted_unique_non_empty(input.provenance_refs.clone()).is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingProvenanceRefs);
    }
    if sorted_unique_non_empty(input.evidence_refs.clone()).is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::MissingEvidenceRefs);
    }
}

fn add_review_state_blockers(
    blockers: &mut Vec<AcceptedMemoryActiveApplyAdmissionBlocker>,
    input: &AcceptedMemoryActiveApplyAdmissionInput,
) {
    if input.review_receipt.decision == AcceptedMemoryReviewReceiptDecisionStorage::Defer
        || input.review_receipt.status == AcceptedMemoryReviewReceiptStatusStorage::Deferred
    {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ReviewDeferred);
    }
    if input.review_receipt.decision == AcceptedMemoryReviewReceiptDecisionStorage::Reject
        || input.review_receipt.status == AcceptedMemoryReviewReceiptStatusStorage::Rejected
    {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ReviewRejected);
    }
    if input.review_receipt.status == AcceptedMemoryReviewReceiptStatusStorage::Blocked {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ReviewBlocked);
    }

    if input.review_receipt.decision != AcceptedMemoryReviewReceiptDecisionStorage::Approve
        || input.review_receipt.status != AcceptedMemoryReviewReceiptStatusStorage::Approved
    {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ReviewNotApproved);
    }

    match input.review_receipt.admission_status {
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::Admitted => {}
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::DuplicateNoop => {
            blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ReviewAdmissionDuplicateNoop);
        }
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::Blocked => {
            blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ReviewAdmissionBlocked);
        }
    }
    if !input.review_receipt.blockers.is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ReviewBlockersPresent);
    }
    if !input.review_receipt.admission_blockers.is_empty() {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::AdmissionBlockersPresent);
    }
}

fn add_stale_ref_blockers(
    blockers: &mut Vec<AcceptedMemoryActiveApplyAdmissionBlocker>,
    input: &AcceptedMemoryActiveApplyAdmissionInput,
) {
    let review = &input.review_receipt;
    if input.expected_apply_admission_ref != review.apply_admission_ref {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::StaleApplyAdmissionRef);
    }
    if input.expected_import_admission_ref != review.import_admission_ref {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::StaleImportAdmissionRef);
    }
    if input.expected_conflict_ref != review.conflict_ref {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::StaleConflictRef);
    }
    if input.expected_candidate_ref != review.candidate_ref {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::StaleCandidateRef);
    }
    if input.expected_memory_id != review.memory_id {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::StaleMemoryId);
    }
    if input.expected_file_ref != review.file_ref {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::StaleFileRef);
    }
    if sorted_unique_non_empty(input.provenance_refs.clone()) != review.provenance_refs {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::StaleProvenanceRefs);
    }
    if sorted_unique_non_empty(input.evidence_refs.clone()) != review.evidence_refs {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::StaleEvidenceRefs);
    }
}

fn add_requested_effect_blockers(
    blockers: &mut Vec<AcceptedMemoryActiveApplyAdmissionBlocker>,
    input: &AcceptedMemoryActiveApplyAdmissionInput,
) {
    if input.raw_payload_present {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::RawPayloadPresent);
    }
    if input.active_memory_mutation_requested {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ActiveMemoryMutationRequested);
    }
    if input.projection_write_requested {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ProjectionWriteRequested);
    }
    if input.scm_effect_requested {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ScmEffectRequested);
    }
    if input.embedding_requested {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::EmbeddingRequested);
    }
    if input.provider_sync_requested {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::ProviderSyncRequested);
    }
    if input.automatic_extraction_requested {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::AutomaticExtractionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::TaskMutationRequested);
    }
    if input.agent_scheduling_requested {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::AgentSchedulingRequested);
    }
    if input.ui_effect_requested {
        blockers.push(AcceptedMemoryActiveApplyAdmissionBlocker::UiEffectRequested);
    }
}
