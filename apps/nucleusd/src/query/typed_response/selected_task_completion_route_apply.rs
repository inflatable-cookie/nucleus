use nucleus_server::ControlSelectedTaskCompletionRouteApplyDto;

pub(crate) fn selected_task_completion_route_apply_response_lines(
    label: &str,
    apply: ControlSelectedTaskCompletionRouteApplyDto,
) -> Vec<String> {
    vec![
        format!("domain={label}"),
        format!("apply_id={}", apply.apply_id),
        format!("project_id={}", apply.project_id),
        format!("task_id={}", apply.task_id),
        format!("route_admission_id={}", apply.route_admission_id),
        format!("route_id={}", apply.route_id),
        format!(
            "review_decision_ref={}",
            apply.review_decision_ref.as_deref().unwrap_or("none")
        ),
        format!("status={}", apply.status),
        format!(
            "command={}",
            apply
                .command
                .as_ref()
                .map(|command| command.action.as_str())
                .unwrap_or("none")
        ),
        format!(
            "command_admission_status={}",
            apply
                .command_admission
                .as_ref()
                .map(|admission| admission.status.as_str())
                .unwrap_or("none")
        ),
        format!(
            "refusal={}",
            apply
                .refusal
                .as_ref()
                .map(|refusal| refusal.kind.as_str())
                .unwrap_or("none")
        ),
        format!("evidence_refs={}", apply.evidence_refs.len()),
        format!("operator_ref={}", apply.operator_ref),
        format!(
            "no_effects review_mutation={} task_lifecycle_mutation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            apply.no_effects.review_mutation_performed,
            apply.no_effects.task_lifecycle_mutation_performed,
            apply.no_effects.provider_execution_performed,
            apply.no_effects.provider_write_performed,
            apply.no_effects.scm_or_forge_mutation_performed,
            apply.no_effects.accepted_memory_apply_performed,
            apply.no_effects.planning_apply_performed,
            apply.no_effects.projection_write_performed,
            apply.no_effects.agent_scheduling_performed,
            apply.no_effects.ui_effect_performed
        ),
        "mode=read_only_preview".to_owned(),
        "client_can_mutate=false".to_owned(),
        "command_execution_available=false".to_owned(),
        "provider_execution_available=false".to_owned(),
        "agent_scheduling_available=false".to_owned(),
        "scm_or_forge_execution_available=false".to_owned(),
        "payloads_exposed=false".to_owned(),
    ]
}
