use super::helpers::unique_sorted;
use super::store::PREPARATION_PREFIX;
use super::types::{
    CompletionScmCapturePreparationPersistenceBlocker,
    CompletionScmCapturePreparationPersistenceInput,
    CompletionScmCapturePreparationPersistenceRecord,
    CompletionScmCapturePreparationPersistenceStatus,
};

pub(super) fn persistence_record(
    input: CompletionScmCapturePreparationPersistenceInput,
    persisted_preparation_id: String,
    status: CompletionScmCapturePreparationPersistenceStatus,
    blockers: Vec<CompletionScmCapturePreparationPersistenceBlocker>,
    duplicate_preparation_detected: bool,
) -> CompletionScmCapturePreparationPersistenceRecord {
    CompletionScmCapturePreparationPersistenceRecord {
        persisted_preparation_id,
        plan_item_id: input.plan_item.plan_item_id,
        preparation_candidate_id: input.plan_item.preparation_candidate_id,
        admission_id: input.admission_id,
        readiness_id: input.readiness_id,
        capture_candidate_id: input.capture_candidate_id,
        task_id: input.plan_item.task_id,
        work_item_id: input.plan_item.work_item_id,
        completion_id: input.plan_item.completion_id,
        operator_ref: input.operator_ref,
        evidence_refs: unique_sorted(input.evidence_refs),
        adapter_label: input.plan_item.adapter_label,
        workflow_label: input.plan_item.workflow_label,
        plan_status: input.plan_item.status,
        plan_blockers: input.plan_item.blockers,
        status,
        blockers,
        duplicate_preparation_detected,
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

pub(super) fn persisted_preparation_id(plan_item_id: &str) -> String {
    format!("{PREPARATION_PREFIX}{plan_item_id}")
}
