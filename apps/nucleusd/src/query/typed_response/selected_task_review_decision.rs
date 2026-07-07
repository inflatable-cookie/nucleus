use nucleus_server::{
    ControlSelectedTaskReviewDecisionAdmissionDto, ControlSelectedTaskReviewDecisionRecordDto,
};

pub(crate) fn selected_task_review_decision_admission_response_lines(
    label: &str,
    admission: ControlSelectedTaskReviewDecisionAdmissionDto,
) -> Vec<String> {
    let outcome = admission
        .command
        .as_ref()
        .map(|command| command.outcome.as_str())
        .unwrap_or("none");
    let expected_revision = admission
        .command
        .as_ref()
        .map(|command| command.expected_revision.as_str())
        .unwrap_or("none");
    let refusal_kind = admission
        .refusal
        .as_ref()
        .map(|refusal| refusal.kind.as_str())
        .unwrap_or("none");
    let refusal_reason = admission
        .refusal
        .as_ref()
        .map(|refusal| refusal.reason.as_str())
        .unwrap_or("none");

    vec![
        format!("domain={label}"),
        "mode=dry_run".to_owned(),
        format!("admission_id={}", admission.admission_id),
        format!("decision_id={}", admission.decision_id),
        format!("project_id={}", admission.project_id),
        format!("task_id={}", admission.task_id),
        format!("action={}", admission.action),
        format!("status={}", admission.status),
        format!("outcome={outcome}"),
        format!("operator_ref={}", admission.operator_ref),
        format!("expected_revision={expected_revision}"),
        format!("refusal_kind={refusal_kind}"),
        format!("refusal_reason={refusal_reason}"),
        format!("evidence_refs={}", admission.evidence_refs.len()),
        format!(
            "review_mutation_performed={}",
            admission.no_effects.review_mutation_performed
        ),
        format!(
            "task_mutation_performed={}",
            admission.no_effects.task_mutation_performed
        ),
        format!(
            "provider_execution_performed={}",
            admission.no_effects.provider_execution_performed
        ),
        format!(
            "scm_or_forge_mutation_performed={}",
            admission.no_effects.scm_or_forge_mutation_performed
        ),
        "client_can_mutate=false".to_owned(),
    ]
}

pub(crate) fn selected_task_review_decision_apply_response_lines(
    label: &str,
    record: ControlSelectedTaskReviewDecisionRecordDto,
) -> Vec<String> {
    vec![
        format!("domain={label}"),
        "mode=apply".to_owned(),
        format!("decision_id={}", record.decision_id),
        format!("admission_id={}", record.admission_id),
        format!("project_id={}", record.project_id),
        format!("task_id={}", record.task_id),
        format!("action={}", record.action),
        format!("outcome={}", record.outcome),
        format!("status={}", record.status),
        format!("operator_ref={}", record.operator_ref),
        format!("expected_revision={}", record.expected_revision),
        format!("work_item_refs={}", record.work_item_refs.len()),
        format!(
            "reviewed_evidence_refs={}",
            record.reviewed_evidence_refs.len()
        ),
        format!("receipt_refs={}", record.receipt_refs.len()),
        format!("timeline_refs={}", record.timeline_refs.len()),
        format!("blockers={}", record.blockers.len()),
        format!(
            "duplicate_decision_detected={}",
            record.duplicate_decision_detected
        ),
        format!(
            "review_mutation_performed={}",
            record.review_mutation_performed
        ),
        format!(
            "task_lifecycle_mutation_performed={}",
            record.task_lifecycle_mutation_performed
        ),
        format!(
            "provider_execution_performed={}",
            record.provider_execution_performed
        ),
        format!(
            "scm_or_forge_mutation_performed={}",
            record.scm_or_forge_mutation_performed
        ),
        format!(
            "raw_provider_material_retained={}",
            record.raw_provider_material_retained
        ),
        format!(
            "raw_command_output_retained={}",
            record.raw_command_output_retained
        ),
    ]
}
