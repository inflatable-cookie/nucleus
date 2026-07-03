use super::helpers::unique_sorted;
use super::store::STOPPED_REQUEST_PREFIX;
use super::types::{
    PlanningCapturePublicationStoppedRequestBlocker, PlanningCapturePublicationStoppedRequestInput,
    PlanningCapturePublicationStoppedRequestRecord, PlanningCapturePublicationStoppedRequestStatus,
};

pub(super) fn request_record(
    input: PlanningCapturePublicationStoppedRequestInput,
    request_id: String,
    status: PlanningCapturePublicationStoppedRequestStatus,
    blockers: Vec<PlanningCapturePublicationStoppedRequestBlocker>,
    duplicate_request_detected: bool,
) -> PlanningCapturePublicationStoppedRequestRecord {
    let admission = input.admission;
    PlanningCapturePublicationStoppedRequestRecord {
        request_id,
        admission_id: admission.admission_id,
        preparation_id: admission.preparation_id,
        plan_item_id: admission.plan_item_id,
        task_id: admission.task_id,
        work_item_id: admission.work_item_id,
        completion_id: admission.completion_id,
        operator_ref: admission.operator_ref,
        approval_ref: admission.approval_ref,
        evidence_refs: unique_sorted(admission.evidence_refs),
        adapter_family: admission.adapter_family,
        operation: admission.operation,
        adapter_label: admission.adapter_label,
        workflow_label: admission.workflow_label,
        management_file_refs: unique_sorted(admission.management_file_refs),
        status,
        blockers,
        duplicate_request_detected,
        command_execution_permitted: false,
        runner_handoff_permitted: false,
        commit_permitted: false,
        snapshot_permitted: false,
        publish_permitted: false,
        push_permitted: false,
        forge_share_permitted: false,
        provider_write_permitted: false,
        projection_import_permitted: false,
        task_promotion_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_payload_retained: false,
    }
}

pub(super) fn request_id(admission_id: &str) -> String {
    format!("{STOPPED_REQUEST_PREFIX}{admission_id}")
}
