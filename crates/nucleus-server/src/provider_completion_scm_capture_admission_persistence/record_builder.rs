use super::helpers::unique_sorted;
use super::types::{
    CompletionScmCaptureAdmissionPersistenceBlocker, CompletionScmCaptureAdmissionPersistenceInput,
    CompletionScmCaptureAdmissionPersistenceRecord, CompletionScmCaptureAdmissionPersistenceStatus,
};
use super::COMPLETION_SCM_CAPTURE_ADMISSION_PREFIX;

pub(super) fn persistence_record(
    input: CompletionScmCaptureAdmissionPersistenceInput,
    persisted_admission_id: String,
    status: CompletionScmCaptureAdmissionPersistenceStatus,
    blockers: Vec<CompletionScmCaptureAdmissionPersistenceBlocker>,
    duplicate_admission_detected: bool,
) -> CompletionScmCaptureAdmissionPersistenceRecord {
    CompletionScmCaptureAdmissionPersistenceRecord {
        persisted_admission_id,
        admission_id: input.admission.admission_id,
        request_id: input.admission.request_id,
        readiness_id: input.admission.readiness_id,
        candidate_id: input.admission.candidate_id,
        task_id: input.admission.task_id,
        work_item_id: input.admission.work_item_id,
        completion_id: input.admission.completion_id,
        operator_ref: input.admission.operator_ref,
        evidence_refs: unique_sorted(input.admission.evidence_refs),
        admission_status: input.admission.status,
        status,
        blockers,
        admission_blockers: input.admission.blockers,
        duplicate_admission_detected,
        scm_capture_permitted: false,
        scm_publish_permitted: false,
        forge_change_request_permitted: false,
        forge_merge_permitted: false,
        provider_write_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_material_retained: false,
    }
}

pub(super) fn blockers(
    input: &CompletionScmCaptureAdmissionPersistenceInput,
) -> Vec<CompletionScmCaptureAdmissionPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.admission.evidence_refs.is_empty() {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_material_present {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::RawMaterialPresent);
    }
    if input.scm_capture_requested || input.admission.scm_capture_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ScmCaptureRequested);
    }
    if input.scm_publish_requested || input.admission.scm_publish_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ScmPublishRequested);
    }
    if input.forge_change_request_requested || input.admission.forge_change_request_created {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ForgeChangeRequestRequested);
    }
    if input.forge_merge_requested || input.admission.forge_merge_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ForgeMergeRequested);
    }
    if input.provider_write_requested || input.admission.provider_write_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested || input.admission.callback_response_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested || input.admission.interruption_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested || input.admission.recovery_executed {
        blockers.push(CompletionScmCaptureAdmissionPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

pub(super) fn persisted_admission_id(admission_id: &str) -> String {
    format!("{COMPLETION_SCM_CAPTURE_ADMISSION_PREFIX}{admission_id}")
}
