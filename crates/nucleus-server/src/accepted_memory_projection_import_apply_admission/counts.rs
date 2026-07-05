use crate::accepted_memory_projection_import_apply_admission::types::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionCounts,
    AcceptedMemoryProjectionImportApplyAdmissionRecord,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};

pub(super) fn apply_admission_counts(
    records: &[AcceptedMemoryProjectionImportApplyAdmissionRecord],
) -> AcceptedMemoryProjectionImportApplyAdmissionCounts {
    let mut counts = AcceptedMemoryProjectionImportApplyAdmissionCounts {
        inputs: records.len(),
        admitted: 0,
        duplicate_noops: 0,
        blocked: 0,
        blockers: 0,
        missing_ref_blockers: 0,
        conflict_blockers: 0,
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
    counts: &mut AcceptedMemoryProjectionImportApplyAdmissionCounts,
    status: &AcceptedMemoryProjectionImportApplyAdmissionStatus,
) {
    match status {
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted => {
            counts.admitted += 1;
        }
        AcceptedMemoryProjectionImportApplyAdmissionStatus::DuplicateNoop => {
            counts.duplicate_noops += 1;
        }
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked => {
            counts.blocked += 1;
        }
    }
}

fn count_blocker(
    counts: &mut AcceptedMemoryProjectionImportApplyAdmissionCounts,
    blocker: &AcceptedMemoryProjectionImportApplyAdmissionBlocker,
) {
    match blocker {
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingRequestId
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingOperatorRef
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingApprovalRef
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingProvenanceRefs
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingEvidenceRefs
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingImportAdmissionRef
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingConflictRef
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingCandidateRef
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingMemoryId
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingFileRef => {
            counts.missing_ref_blockers += 1;
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::DuplicateNoop
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedSemanticConflict
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedPolicyConflict
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::ImportConflictBlocked => {
            counts.conflict_blockers += 1;
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::RawPayloadPresent => {
            counts.raw_payload_blockers += 1;
        }
        AcceptedMemoryProjectionImportApplyAdmissionBlocker::ActiveMemoryMutationRequested
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::ProjectionWriteRequested
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::ScmEffectRequested
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::EmbeddingRequested
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::ProviderSyncRequested
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::AutomaticExtractionRequested
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::TaskMutationRequested
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::AgentSchedulingRequested
        | AcceptedMemoryProjectionImportApplyAdmissionBlocker::UiEffectRequested => {
            counts.effect_blockers += 1;
        }
    }
}
