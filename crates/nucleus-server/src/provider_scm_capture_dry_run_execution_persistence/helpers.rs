use nucleus_local_store::{LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload};

use crate::{
    ScmCaptureDryRunExecutionPersistenceBlocker, ScmCaptureDryRunExecutionPersistenceInput,
    ScmCaptureDryRunExecutionPersistenceRecord, ScmCaptureDryRunExecutionPersistenceStatus,
};

const SCM_CAPTURE_DRY_RUN_EXECUTION_PREFIX: &str = "scm-capture-dry-run-execution:";

pub(super) fn persistence_record(
    input: ScmCaptureDryRunExecutionPersistenceInput,
    persisted_execution_receipt_id: String,
    persistence_status: ScmCaptureDryRunExecutionPersistenceStatus,
    persistence_blockers: Vec<ScmCaptureDryRunExecutionPersistenceBlocker>,
    duplicate_execution_receipt_detected: bool,
) -> ScmCaptureDryRunExecutionPersistenceRecord {
    ScmCaptureDryRunExecutionPersistenceRecord {
        persisted_execution_receipt_id,
        receipt_id: input.receipt.receipt_id,
        capability_item_id: input.receipt.capability_item_id,
        admission_id: input.receipt.admission_id,
        persisted_dry_run_plan_id: input.receipt.persisted_dry_run_plan_id,
        dry_run_plan_item_id: input.receipt.dry_run_plan_item_id,
        task_id: input.receipt.task_id,
        work_item_id: input.receipt.work_item_id,
        completion_id: input.receipt.completion_id,
        operator_ref: input.receipt.operator_ref,
        adapter_label: input.receipt.adapter_label,
        workflow_label: input.receipt.workflow_label,
        outcome: input.receipt.outcome,
        receipt_blockers: input.receipt.blockers,
        persistence_status,
        persistence_blockers,
        duplicate_execution_receipt_detected,
        evidence_refs: unique_sorted(input.receipt.evidence_refs),
        changed_path_count: input.receipt.changed_path_count,
        summary_line_count: input.receipt.summary_line_count,
        scm_dry_run_executed: input.receipt.scm_dry_run_executed,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_change_request_created: false,
        forge_merge_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_material_exposed: false,
    }
}

pub(super) fn blockers(
    input: &ScmCaptureDryRunExecutionPersistenceInput,
) -> Vec<ScmCaptureDryRunExecutionPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.receipt.evidence_refs.is_empty() {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_output_present {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::RawOutputPresent);
    }
    if input.scm_capture_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::CaptureRequested);
    }
    if input.scm_publish_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::PublishRequested);
    }
    if input.forge_change_request_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::ForgeChangeRequestRequested);
    }
    if input.forge_merge_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::ForgeMergeRequested);
    }
    if input.provider_write_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

pub(super) fn persisted_execution_receipt_id(receipt_id: &str) -> String {
    format!("{SCM_CAPTURE_DRY_RUN_EXECUTION_PREFIX}{receipt_id}")
}

pub(super) fn is_scm_capture_dry_run_execution_record(record: &LocalStoreRecord) -> bool {
    record
        .id
        .0
        .starts_with(SCM_CAPTURE_DRY_RUN_EXECUTION_PREFIX)
}

pub(super) fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

pub(super) fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}
