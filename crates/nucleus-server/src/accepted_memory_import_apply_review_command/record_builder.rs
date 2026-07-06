use crate::accepted_memory_import_apply_review_command::blockers::{
    review_blockers, sorted_unique_non_empty,
};
use crate::accepted_memory_import_apply_review_command::refs::accepted_memory_import_apply_review_receipt_ref;
use crate::accepted_memory_import_apply_review_command::types::{
    AcceptedMemoryImportApplyReviewDecision, AcceptedMemoryImportApplyReviewInput,
    AcceptedMemoryImportApplyReviewReceipt, AcceptedMemoryImportApplyReviewStatus,
};

pub(super) fn review_receipt(
    input: AcceptedMemoryImportApplyReviewInput,
) -> AcceptedMemoryImportApplyReviewReceipt {
    let blockers = review_blockers(&input);
    let status = review_status(&input.decision, &blockers);
    let admission = input.admission;
    let admission_status = admission.status.clone();
    let admission_blockers = admission.blockers.clone();

    AcceptedMemoryImportApplyReviewReceipt {
        review_receipt_ref: accepted_memory_import_apply_review_receipt_ref(&input.command_id),
        command_id: input.command_id,
        apply_admission_ref: admission.apply_admission_ref,
        import_admission_ref: admission.import_admission_ref,
        conflict_ref: admission.conflict_ref,
        candidate_ref: admission.candidate_ref,
        memory_id: admission.memory_id,
        file_ref: admission.file_ref,
        operator_ref: input.operator_ref,
        approval_ref: input.approval_ref,
        decision_reason_ref: input.decision_reason_ref,
        admission_status,
        admission_blockers,
        decision: input.decision,
        status,
        blockers,
        provenance_refs: sorted_unique_non_empty(input.provenance_refs),
        evidence_refs: sorted_unique_non_empty(input.evidence_refs),
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

fn review_status(
    decision: &AcceptedMemoryImportApplyReviewDecision,
    blockers: &[crate::AcceptedMemoryImportApplyReviewBlocker],
) -> AcceptedMemoryImportApplyReviewStatus {
    if !blockers.is_empty() {
        return AcceptedMemoryImportApplyReviewStatus::Blocked;
    }

    match decision {
        AcceptedMemoryImportApplyReviewDecision::Approve => {
            AcceptedMemoryImportApplyReviewStatus::Approved
        }
        AcceptedMemoryImportApplyReviewDecision::Defer => {
            AcceptedMemoryImportApplyReviewStatus::Deferred
        }
        AcceptedMemoryImportApplyReviewDecision::Reject => {
            AcceptedMemoryImportApplyReviewStatus::Rejected
        }
    }
}
