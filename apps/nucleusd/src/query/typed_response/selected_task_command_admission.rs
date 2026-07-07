use nucleus_server::ControlSelectedTaskCommandAdmissionDto;

pub(crate) fn selected_task_command_admission_response_lines(
    label: &str,
    admission: ControlSelectedTaskCommandAdmissionDto,
) -> Vec<String> {
    let command_action = admission
        .command
        .as_ref()
        .map(|command| command.action.as_str())
        .unwrap_or("none");
    let command_task_id = admission
        .command
        .as_ref()
        .map(|command| command.task_id.as_str())
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
    let candidate_disposition = admission
        .candidate
        .as_ref()
        .map(|candidate| candidate.disposition.as_str())
        .unwrap_or("none");
    let expected_revision_required = admission
        .candidate
        .as_ref()
        .map(|candidate| candidate.expected_revision_required)
        .unwrap_or(false);
    let reason_required = admission
        .candidate
        .as_ref()
        .map(|candidate| candidate.reason_required)
        .unwrap_or(false);

    vec![
        format!("domain={label}"),
        "mode=dry_run".to_owned(),
        format!("admission_id={}", admission.admission_id),
        format!("project_id={}", admission.project_id),
        format!("task_id={}", admission.task_id),
        format!("family={}", admission.family),
        format!("status={}", admission.status),
        format!("operator_ref={}", admission.operator_ref),
        format!("command_action={command_action}"),
        format!("command_task_id={command_task_id}"),
        format!("candidate_disposition={candidate_disposition}"),
        format!("expected_revision_required={expected_revision_required}"),
        format!("reason_required={reason_required}"),
        format!("refusal_kind={refusal_kind}"),
        format!("refusal_reason={refusal_reason}"),
        format!("evidence_refs={}", admission.evidence_refs.len()),
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
        "command_executed=false".to_owned(),
        "client_can_mutate=false".to_owned(),
    ]
}
