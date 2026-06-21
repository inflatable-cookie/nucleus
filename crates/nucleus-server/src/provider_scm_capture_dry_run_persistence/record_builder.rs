use super::{
    helpers::unique_sorted,
    types::{
        ScmCaptureDryRunPersistenceBlocker, ScmCaptureDryRunPersistenceInput,
        ScmCaptureDryRunPersistenceRecord, ScmCaptureDryRunPersistenceStatus,
    },
    SCM_CAPTURE_DRY_RUN_PREFIX,
};

pub(super) fn persistence_record(
    input: ScmCaptureDryRunPersistenceInput,
    persisted_dry_run_plan_id: String,
    status: ScmCaptureDryRunPersistenceStatus,
    blockers: Vec<ScmCaptureDryRunPersistenceBlocker>,
    duplicate_dry_run_plan_detected: bool,
) -> ScmCaptureDryRunPersistenceRecord {
    ScmCaptureDryRunPersistenceRecord {
        persisted_dry_run_plan_id,
        dry_run_plan_item_id: input.plan_item.dry_run_plan_item_id,
        dry_run_candidate_id: input.plan_item.dry_run_candidate_id,
        persisted_preparation_id: input.plan_item.persisted_preparation_id,
        plan_item_id: input.plan_item.plan_item_id,
        admission_id: input.plan_item.admission_id,
        readiness_id: input.plan_item.readiness_id,
        capture_candidate_id: input.plan_item.capture_candidate_id,
        task_id: input.plan_item.task_id,
        work_item_id: input.plan_item.work_item_id,
        completion_id: input.plan_item.completion_id,
        operator_ref: input.plan_item.operator_ref,
        evidence_refs: unique_sorted(input.plan_item.evidence_refs),
        adapter_label: input.plan_item.adapter_label,
        workflow_label: input.plan_item.workflow_label,
        plan_status: input.plan_item.status,
        plan_blockers: input.plan_item.blockers,
        status,
        blockers,
        duplicate_dry_run_plan_detected,
        scm_dry_run_permitted: false,
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
    input: &ScmCaptureDryRunPersistenceInput,
) -> Vec<ScmCaptureDryRunPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.plan_item.evidence_refs.is_empty() {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_material_present {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::RawMaterialPresent);
    }
    if input.scm_dry_run_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ScmDryRunRequested);
    }
    if input.scm_capture_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ScmCaptureRequested);
    }
    if input.scm_publish_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ScmPublishRequested);
    }
    if input.forge_change_request_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ForgeChangeRequestRequested);
    }
    if input.forge_merge_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ForgeMergeRequested);
    }
    if input.provider_write_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(ScmCaptureDryRunPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

pub(super) fn persisted_dry_run_plan_id(plan_item_id: &str) -> String {
    format!("{SCM_CAPTURE_DRY_RUN_PREFIX}{plan_item_id}")
}
