use crate::accepted_memory_import_apply_review_command::types::{
    AcceptedMemoryImportApplyReviewBlocker, AcceptedMemoryImportApplyReviewDecision,
    AcceptedMemoryImportApplyReviewInput,
};
use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionRecord,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};

pub(super) fn review_blockers(
    input: &AcceptedMemoryImportApplyReviewInput,
) -> Vec<AcceptedMemoryImportApplyReviewBlocker> {
    let mut blockers = Vec::new();

    add_request_ref_blockers(&mut blockers, input);
    add_admission_blockers(&mut blockers, input);
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
    blockers: &mut Vec<AcceptedMemoryImportApplyReviewBlocker>,
    input: &AcceptedMemoryImportApplyReviewInput,
) {
    if input.command_id.trim().is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingCommandId);
    }
    if input.operator_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingOperatorRef);
    }
    if input.decision == AcceptedMemoryImportApplyReviewDecision::Approve
        && input.approval_ref.trim().is_empty()
    {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingApprovalRef);
    }
    if matches!(
        input.decision,
        AcceptedMemoryImportApplyReviewDecision::Defer
            | AcceptedMemoryImportApplyReviewDecision::Reject
    ) && input.decision_reason_ref.trim().is_empty()
    {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingDecisionReasonRef);
    }
    if sorted_unique_non_empty(input.provenance_refs.clone()).is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingProvenanceRefs);
    }
    if sorted_unique_non_empty(input.evidence_refs.clone()).is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingEvidenceRefs);
    }
}

fn add_admission_blockers(
    blockers: &mut Vec<AcceptedMemoryImportApplyReviewBlocker>,
    input: &AcceptedMemoryImportApplyReviewInput,
) {
    let admission = &input.admission;
    add_admission_ref_blockers(blockers, admission);

    if input.decision != AcceptedMemoryImportApplyReviewDecision::Approve {
        return;
    }

    match admission.status {
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted => {}
        AcceptedMemoryProjectionImportApplyAdmissionStatus::DuplicateNoop => {
            blockers.push(AcceptedMemoryImportApplyReviewBlocker::AdmissionDuplicateNoop);
        }
        AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked => {
            blockers.push(AcceptedMemoryImportApplyReviewBlocker::AdmissionBlocked);
        }
    }
    if !admission.blockers.is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::AdmissionBlockersPresent);
    }
}

fn add_admission_ref_blockers(
    blockers: &mut Vec<AcceptedMemoryImportApplyReviewBlocker>,
    admission: &AcceptedMemoryProjectionImportApplyAdmissionRecord,
) {
    if admission.apply_admission_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingApplyAdmissionRef);
    }
    if admission.import_admission_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingImportAdmissionRef);
    }
    if admission.conflict_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingConflictRef);
    }
    if admission.candidate_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingCandidateRef);
    }
    if admission
        .memory_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingMemoryId);
    }
    if admission.file_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::MissingFileRef);
    }
}

fn add_requested_effect_blockers(
    blockers: &mut Vec<AcceptedMemoryImportApplyReviewBlocker>,
    input: &AcceptedMemoryImportApplyReviewInput,
) {
    if input.raw_payload_present {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::RawPayloadPresent);
    }
    if input.active_memory_mutation_requested {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::ActiveMemoryMutationRequested);
    }
    if input.projection_write_requested {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::ProjectionWriteRequested);
    }
    if input.scm_effect_requested {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::ScmEffectRequested);
    }
    if input.embedding_requested {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::EmbeddingRequested);
    }
    if input.provider_sync_requested {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::ProviderSyncRequested);
    }
    if input.automatic_extraction_requested {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::AutomaticExtractionRequested);
    }
    if input.task_mutation_requested {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::TaskMutationRequested);
    }
    if input.agent_scheduling_requested {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::AgentSchedulingRequested);
    }
    if input.ui_effect_requested {
        blockers.push(AcceptedMemoryImportApplyReviewBlocker::UiEffectRequested);
    }
}
