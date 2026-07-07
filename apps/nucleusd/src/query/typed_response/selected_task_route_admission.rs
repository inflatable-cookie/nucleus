use nucleus_server::ControlSelectedTaskRouteAdmissionDto;

pub(crate) fn selected_task_route_admission_response_lines(
    label: &str,
    admission: ControlSelectedTaskRouteAdmissionDto,
) -> Vec<String> {
    vec![
        format!("domain={label}"),
        format!("admission_id={}", admission.admission_id),
        format!("project_id={}", admission.project_id),
        format!("task_id={}", admission.task_id),
        format!("route_id={}", admission.route_id),
        format!("completion_status={}", admission.completion.status),
        format!(
            "completion_command={}",
            admission
                .completion
                .command_admission
                .as_ref()
                .and_then(|command| command.command.as_ref())
                .map(|command| command.action.as_str())
                .unwrap_or("none")
        ),
        format!(
            "completion_refusal={}",
            admission
                .completion
                .refusal
                .as_ref()
                .map(|refusal| refusal.kind.as_str())
                .unwrap_or("none")
        ),
        format!(
            "rework_delegation_status={}",
            admission.rework_delegation.status
        ),
        format!(
            "rework_preview={}",
            admission
                .rework_delegation
                .rework_preview
                .as_ref()
                .map(|preview| preview.family.as_str())
                .unwrap_or("none")
        ),
        format!(
            "delegation_preview={}",
            admission
                .rework_delegation
                .delegation_preview
                .as_ref()
                .map(|preview| preview.family.as_str())
                .unwrap_or("none")
        ),
        format!(
            "rework_delegation_refusal={}",
            admission
                .rework_delegation
                .refusal
                .as_ref()
                .map(|refusal| refusal.kind.as_str())
                .unwrap_or("none")
        ),
        format!("completion_evidence_refs={}", admission.completion.evidence_refs.len()),
        format!(
            "rework_evidence_refs={}",
            admission.rework_delegation.evidence_refs.len()
        ),
        format!(
            "no_effects review_mutation={} task_lifecycle_mutation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            admission.no_effects.review_mutation_performed,
            admission.no_effects.task_lifecycle_mutation_performed,
            admission.no_effects.provider_execution_performed,
            admission.no_effects.provider_write_performed,
            admission.no_effects.scm_or_forge_mutation_performed,
            admission.no_effects.accepted_memory_apply_performed,
            admission.no_effects.planning_apply_performed,
            admission.no_effects.projection_write_performed,
            admission.no_effects.agent_scheduling_performed,
            admission.no_effects.ui_effect_performed
        ),
        "mode=read_only".to_owned(),
        "client_can_mutate=false".to_owned(),
        "provider_execution_available=false".to_owned(),
        "agent_scheduling_available=false".to_owned(),
        "scm_or_forge_execution_available=false".to_owned(),
        "payloads_exposed=false".to_owned(),
    ]
}
