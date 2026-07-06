use crate::accepted_memory_import_apply_review_command::types::{
    AcceptedMemoryImportApplyReviewBlocker, AcceptedMemoryImportApplyReviewCounts,
    AcceptedMemoryImportApplyReviewReceipt, AcceptedMemoryImportApplyReviewStatus,
};
use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};

pub(super) fn review_receipt_counts(
    receipts: &[AcceptedMemoryImportApplyReviewReceipt],
) -> AcceptedMemoryImportApplyReviewCounts {
    let mut counts = AcceptedMemoryImportApplyReviewCounts {
        inputs: receipts.len(),
        approved: 0,
        deferred: 0,
        rejected: 0,
        blocked: 0,
        duplicate_noops: 0,
        conflicts: 0,
        approval_required: 0,
        blockers: 0,
        missing_ref_blockers: 0,
        admission_blockers: 0,
        raw_payload_blockers: 0,
        effect_blockers: 0,
        provenance_refs: 0,
        evidence_refs: 0,
    };

    for receipt in receipts {
        count_status(&mut counts, &receipt.status);
        count_admission_state(&mut counts, receipt);
        counts.provenance_refs += receipt.provenance_refs.len();
        counts.evidence_refs += receipt.evidence_refs.len();
        for blocker in &receipt.blockers {
            counts.blockers += 1;
            count_blocker(&mut counts, blocker);
        }
    }

    counts
}

fn count_admission_state(
    counts: &mut AcceptedMemoryImportApplyReviewCounts,
    receipt: &AcceptedMemoryImportApplyReviewReceipt,
) {
    if receipt.admission_status == AcceptedMemoryProjectionImportApplyAdmissionStatus::DuplicateNoop
    {
        counts.duplicate_noops += 1;
    }
    if receipt
        .admission_blockers
        .iter()
        .any(is_conflict_admission_blocker)
    {
        counts.conflicts += 1;
    }
    if receipt.admission_status == AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted
        && receipt.decision == crate::AcceptedMemoryImportApplyReviewDecision::Approve
    {
        counts.approval_required += 1;
    }
}

fn is_conflict_admission_blocker(
    blocker: &AcceptedMemoryProjectionImportApplyAdmissionBlocker,
) -> bool {
    matches!(
        blocker,
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedSemanticConflict
            | AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedPolicyConflict
            | AcceptedMemoryProjectionImportApplyAdmissionBlocker::ImportConflictBlocked
    )
}

fn count_status(
    counts: &mut AcceptedMemoryImportApplyReviewCounts,
    status: &AcceptedMemoryImportApplyReviewStatus,
) {
    match status {
        AcceptedMemoryImportApplyReviewStatus::Approved => counts.approved += 1,
        AcceptedMemoryImportApplyReviewStatus::Deferred => counts.deferred += 1,
        AcceptedMemoryImportApplyReviewStatus::Rejected => counts.rejected += 1,
        AcceptedMemoryImportApplyReviewStatus::Blocked => counts.blocked += 1,
    }
}

fn count_blocker(
    counts: &mut AcceptedMemoryImportApplyReviewCounts,
    blocker: &AcceptedMemoryImportApplyReviewBlocker,
) {
    match blocker {
        AcceptedMemoryImportApplyReviewBlocker::MissingCommandId
        | AcceptedMemoryImportApplyReviewBlocker::MissingOperatorRef
        | AcceptedMemoryImportApplyReviewBlocker::MissingApprovalRef
        | AcceptedMemoryImportApplyReviewBlocker::MissingDecisionReasonRef
        | AcceptedMemoryImportApplyReviewBlocker::MissingProvenanceRefs
        | AcceptedMemoryImportApplyReviewBlocker::MissingEvidenceRefs
        | AcceptedMemoryImportApplyReviewBlocker::MissingApplyAdmissionRef
        | AcceptedMemoryImportApplyReviewBlocker::MissingImportAdmissionRef
        | AcceptedMemoryImportApplyReviewBlocker::MissingConflictRef
        | AcceptedMemoryImportApplyReviewBlocker::MissingCandidateRef
        | AcceptedMemoryImportApplyReviewBlocker::MissingMemoryId
        | AcceptedMemoryImportApplyReviewBlocker::MissingFileRef => {
            counts.missing_ref_blockers += 1;
        }
        AcceptedMemoryImportApplyReviewBlocker::AdmissionNotAdmitted
        | AcceptedMemoryImportApplyReviewBlocker::AdmissionDuplicateNoop
        | AcceptedMemoryImportApplyReviewBlocker::AdmissionBlocked
        | AcceptedMemoryImportApplyReviewBlocker::AdmissionBlockersPresent => {
            counts.admission_blockers += 1;
        }
        AcceptedMemoryImportApplyReviewBlocker::RawPayloadPresent => {
            counts.raw_payload_blockers += 1;
        }
        AcceptedMemoryImportApplyReviewBlocker::ActiveMemoryMutationRequested
        | AcceptedMemoryImportApplyReviewBlocker::ProjectionWriteRequested
        | AcceptedMemoryImportApplyReviewBlocker::ScmEffectRequested
        | AcceptedMemoryImportApplyReviewBlocker::EmbeddingRequested
        | AcceptedMemoryImportApplyReviewBlocker::ProviderSyncRequested
        | AcceptedMemoryImportApplyReviewBlocker::AutomaticExtractionRequested
        | AcceptedMemoryImportApplyReviewBlocker::TaskMutationRequested
        | AcceptedMemoryImportApplyReviewBlocker::AgentSchedulingRequested
        | AcceptedMemoryImportApplyReviewBlocker::UiEffectRequested => {
            counts.effect_blockers += 1;
        }
    }
}
