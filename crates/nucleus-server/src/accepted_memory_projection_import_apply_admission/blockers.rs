use crate::accepted_memory_projection_import_apply_admission::types::{
    AcceptedMemoryProjectionImportApplyAdmissionBlocker,
    AcceptedMemoryProjectionImportApplyAdmissionInput,
};
use crate::accepted_memory_projection_import_conflicts::{
    AcceptedMemoryProjectionImportConflictRecord, AcceptedMemoryProjectionImportConflictStatus,
};

pub(super) fn apply_admission_blockers(
    input: &AcceptedMemoryProjectionImportApplyAdmissionInput,
) -> Vec<AcceptedMemoryProjectionImportApplyAdmissionBlocker> {
    let mut blockers = Vec::new();

    add_request_ref_blockers(&mut blockers, input);
    add_conflict_record_blockers(&mut blockers, &input.conflict);
    add_requested_effect_blockers(&mut blockers, input);

    blockers
}

pub(super) fn sorted_unique_non_empty(refs: Vec<String>) -> Vec<String> {
    let mut refs = non_empty_refs(&refs);
    refs.sort();
    refs.dedup();
    refs
}

pub(super) fn non_empty_refs(refs: &[String]) -> Vec<String> {
    refs.iter()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .collect()
}

fn add_request_ref_blockers(
    blockers: &mut Vec<AcceptedMemoryProjectionImportApplyAdmissionBlocker>,
    input: &AcceptedMemoryProjectionImportApplyAdmissionInput,
) {
    if input.request_id.trim().is_empty() {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingRequestId);
    }
    if input.operator_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingOperatorRef);
    }
    if input.approval_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingApprovalRef);
    }
    if non_empty_refs(&input.provenance_refs).is_empty() {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingProvenanceRefs);
    }
    if non_empty_refs(&input.evidence_refs).is_empty() {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingEvidenceRefs);
    }
}

fn add_conflict_record_blockers(
    blockers: &mut Vec<AcceptedMemoryProjectionImportApplyAdmissionBlocker>,
    conflict: &AcceptedMemoryProjectionImportConflictRecord,
) {
    if conflict.admission_ref.trim().is_empty() {
        blockers
            .push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingImportAdmissionRef);
    }
    if conflict.conflict_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingConflictRef);
    }
    if conflict.candidate_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingCandidateRef);
    }
    if conflict
        .memory_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingMemoryId);
    }
    if conflict.file_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingFileRef);
    }

    add_conflict_status_blockers(blockers, &conflict.status);
}

fn add_conflict_status_blockers(
    blockers: &mut Vec<AcceptedMemoryProjectionImportApplyAdmissionBlocker>,
    status: &AcceptedMemoryProjectionImportConflictStatus,
) {
    match status {
        AcceptedMemoryProjectionImportConflictStatus::NoConflict => {}
        AcceptedMemoryProjectionImportConflictStatus::DuplicateNoop => {
            blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::DuplicateNoop);
        }
        AcceptedMemoryProjectionImportConflictStatus::SemanticConflict => blockers
            .push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedSemanticConflict),
        AcceptedMemoryProjectionImportConflictStatus::PolicyConflict => blockers
            .push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::UnresolvedPolicyConflict),
        AcceptedMemoryProjectionImportConflictStatus::Blocked => {
            blockers
                .push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::ImportConflictBlocked);
        }
    }
}

fn add_requested_effect_blockers(
    blockers: &mut Vec<AcceptedMemoryProjectionImportApplyAdmissionBlocker>,
    input: &AcceptedMemoryProjectionImportApplyAdmissionInput,
) {
    if input.raw_payload_present {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::RawPayloadPresent);
    }
    if input.active_memory_mutation_requested {
        blockers.push(
            AcceptedMemoryProjectionImportApplyAdmissionBlocker::ActiveMemoryMutationRequested,
        );
    }
    if input.projection_write_requested {
        blockers
            .push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::ProjectionWriteRequested);
    }
    if input.scm_effect_requested {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::ScmEffectRequested);
    }
    if input.embedding_requested {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::EmbeddingRequested);
    }
    if input.provider_sync_requested {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::ProviderSyncRequested);
    }
    if input.automatic_extraction_requested {
        blockers.push(
            AcceptedMemoryProjectionImportApplyAdmissionBlocker::AutomaticExtractionRequested,
        );
    }
    if input.task_mutation_requested {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::TaskMutationRequested);
    }
    if input.agent_scheduling_requested {
        blockers
            .push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::AgentSchedulingRequested);
    }
    if input.ui_effect_requested {
        blockers.push(AcceptedMemoryProjectionImportApplyAdmissionBlocker::UiEffectRequested);
    }
}
