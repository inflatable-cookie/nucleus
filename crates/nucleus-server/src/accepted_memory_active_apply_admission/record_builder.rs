use nucleus_memory::AcceptedMemoryReviewReceiptAdmissionStatusStorage;

use crate::accepted_memory_active_apply_admission::blockers::{
    active_apply_blockers, sorted_unique_non_empty,
};
use crate::accepted_memory_active_apply_admission::refs::accepted_memory_active_apply_admission_ref;
use crate::accepted_memory_active_apply_admission::{
    AcceptedMemoryActiveApplyAdmissionBlocker, AcceptedMemoryActiveApplyAdmissionInput,
    AcceptedMemoryActiveApplyAdmissionRecord, AcceptedMemoryActiveApplyAdmissionStatus,
};

pub(super) fn active_apply_admission_record(
    input: AcceptedMemoryActiveApplyAdmissionInput,
) -> AcceptedMemoryActiveApplyAdmissionRecord {
    let blockers = active_apply_blockers(&input);
    let status = active_apply_status(&input.review_receipt.admission_status, &blockers);
    let review = input.review_receipt;

    AcceptedMemoryActiveApplyAdmissionRecord {
        active_apply_admission_ref: accepted_memory_active_apply_admission_ref(&input.request_id),
        request_id: input.request_id,
        review_receipt_id: review.review_receipt_id,
        project_id: review.project_id,
        command_id: review.command_id,
        apply_admission_ref: review.apply_admission_ref,
        import_admission_ref: review.import_admission_ref,
        conflict_ref: review.conflict_ref,
        candidate_ref: review.candidate_ref,
        memory_id: review.memory_id,
        file_ref: review.file_ref,
        operator_ref: input.operator_ref,
        approval_ref: input.approval_ref,
        review_operator_ref: review.operator_ref,
        review_approval_ref: review.approval_ref,
        provenance_refs: sorted_unique_non_empty(input.provenance_refs),
        evidence_refs: sorted_unique_non_empty(input.evidence_refs),
        review_decision: review.decision,
        review_status: review.status,
        review_admission_status: review.admission_status,
        status,
        blockers,
        active_memory_apply_performed: false,
        projection_write_performed: false,
        scm_effect_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        automatic_extraction_performed: false,
        task_mutation_performed: false,
        agent_scheduling_performed: false,
        ui_effect_performed: false,
    }
}

fn active_apply_status(
    review_admission_status: &AcceptedMemoryReviewReceiptAdmissionStatusStorage,
    blockers: &[AcceptedMemoryActiveApplyAdmissionBlocker],
) -> AcceptedMemoryActiveApplyAdmissionStatus {
    if blockers.is_empty() {
        return AcceptedMemoryActiveApplyAdmissionStatus::Admitted;
    }
    if *review_admission_status == AcceptedMemoryReviewReceiptAdmissionStatusStorage::DuplicateNoop
        && blockers.iter().all(|blocker| {
            *blocker == AcceptedMemoryActiveApplyAdmissionBlocker::ReviewAdmissionDuplicateNoop
        })
    {
        return AcceptedMemoryActiveApplyAdmissionStatus::DuplicateNoop;
    }
    AcceptedMemoryActiveApplyAdmissionStatus::Blocked
}
