use crate::accepted_memory_active_apply_admission::{
    AcceptedMemoryActiveApplyAdmissionBlocker, AcceptedMemoryActiveApplyAdmissionCounts,
    AcceptedMemoryActiveApplyAdmissionRecord, AcceptedMemoryActiveApplyAdmissionStatus,
};

pub(super) fn active_apply_admission_counts(
    records: &[AcceptedMemoryActiveApplyAdmissionRecord],
) -> AcceptedMemoryActiveApplyAdmissionCounts {
    let mut counts = AcceptedMemoryActiveApplyAdmissionCounts {
        inputs: records.len(),
        admitted: 0,
        duplicate_noops: 0,
        blocked: 0,
        blockers: 0,
        missing_ref_blockers: 0,
        review_state_blockers: 0,
        stale_ref_blockers: 0,
        raw_payload_blockers: 0,
        effect_blockers: 0,
    };

    for record in records {
        count_status(&mut counts, &record.status);
        for blocker in &record.blockers {
            counts.blockers += 1;
            count_blocker(&mut counts, blocker);
        }
    }

    counts
}

fn count_status(
    counts: &mut AcceptedMemoryActiveApplyAdmissionCounts,
    status: &AcceptedMemoryActiveApplyAdmissionStatus,
) {
    match status {
        AcceptedMemoryActiveApplyAdmissionStatus::Admitted => counts.admitted += 1,
        AcceptedMemoryActiveApplyAdmissionStatus::DuplicateNoop => counts.duplicate_noops += 1,
        AcceptedMemoryActiveApplyAdmissionStatus::Blocked => counts.blocked += 1,
    }
}

fn count_blocker(
    counts: &mut AcceptedMemoryActiveApplyAdmissionCounts,
    blocker: &AcceptedMemoryActiveApplyAdmissionBlocker,
) {
    match blocker {
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingRequestId
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingOperatorRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingApprovalRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingReviewReceiptId
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingReviewApprovalRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingApplyAdmissionRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingImportAdmissionRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingConflictRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingCandidateRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingMemoryId
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingFileRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingProvenanceRefs
        | AcceptedMemoryActiveApplyAdmissionBlocker::MissingEvidenceRefs => {
            counts.missing_ref_blockers += 1;
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::ReviewNotApproved
        | AcceptedMemoryActiveApplyAdmissionBlocker::ReviewDeferred
        | AcceptedMemoryActiveApplyAdmissionBlocker::ReviewRejected
        | AcceptedMemoryActiveApplyAdmissionBlocker::ReviewBlocked
        | AcceptedMemoryActiveApplyAdmissionBlocker::ReviewAdmissionDuplicateNoop
        | AcceptedMemoryActiveApplyAdmissionBlocker::ReviewAdmissionBlocked
        | AcceptedMemoryActiveApplyAdmissionBlocker::ReviewBlockersPresent
        | AcceptedMemoryActiveApplyAdmissionBlocker::AdmissionBlockersPresent => {
            counts.review_state_blockers += 1;
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::StaleApplyAdmissionRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::StaleImportAdmissionRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::StaleConflictRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::StaleCandidateRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::StaleMemoryId
        | AcceptedMemoryActiveApplyAdmissionBlocker::StaleFileRef
        | AcceptedMemoryActiveApplyAdmissionBlocker::StaleProvenanceRefs
        | AcceptedMemoryActiveApplyAdmissionBlocker::StaleEvidenceRefs => {
            counts.stale_ref_blockers += 1;
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::RawPayloadPresent => {
            counts.raw_payload_blockers += 1;
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::ActiveMemoryMutationRequested
        | AcceptedMemoryActiveApplyAdmissionBlocker::ProjectionWriteRequested
        | AcceptedMemoryActiveApplyAdmissionBlocker::ScmEffectRequested
        | AcceptedMemoryActiveApplyAdmissionBlocker::EmbeddingRequested
        | AcceptedMemoryActiveApplyAdmissionBlocker::ProviderSyncRequested
        | AcceptedMemoryActiveApplyAdmissionBlocker::AutomaticExtractionRequested
        | AcceptedMemoryActiveApplyAdmissionBlocker::TaskMutationRequested
        | AcceptedMemoryActiveApplyAdmissionBlocker::AgentSchedulingRequested
        | AcceptedMemoryActiveApplyAdmissionBlocker::UiEffectRequested => {
            counts.effect_blockers += 1;
        }
    }
}
