use nucleus_server::ControlSelectedTaskReworkPreparationDto;

pub(crate) fn selected_task_rework_preparation_response_lines(
    label: &str,
    preparation: ControlSelectedTaskReworkPreparationDto,
) -> Vec<String> {
    vec![
        format!("domain={label}"),
        format!("preparation_id={}", preparation.preparation_id),
        format!("project_id={}", preparation.project_id),
        format!("task_id={}", preparation.task_id),
        format!("route_admission_id={}", preparation.route_admission_id),
        format!("route_id={}", preparation.route_id),
        format!(
            "review_decision_ref={}",
            preparation
                .review_decision_ref
                .as_deref()
                .unwrap_or("none")
        ),
        format!("status={}", preparation.status),
        format!(
            "refusal={}",
            preparation
                .refusal
                .as_ref()
                .map(|refusal| refusal.kind.as_str())
                .unwrap_or("none")
        ),
        format!(
            "reviewed_work_item_refs={}",
            preparation.reviewed_work_item_refs.len()
        ),
        format!(
            "reviewed_evidence_refs={}",
            preparation.reviewed_evidence_refs.len()
        ),
        format!("operator_ref={}", preparation.operator_ref),
        format!(
            "expected_task_revision={}",
            preparation
                .expected_task_revision
                .as_deref()
                .unwrap_or("none")
        ),
        format!(
            "expected_work_item_revision={}",
            preparation
                .expected_work_item_revision
                .as_deref()
                .unwrap_or("none")
        ),
        format!(
            "rework_summary={}",
            preparation.rework_summary.as_deref().unwrap_or("none")
        ),
        format!(
            "no_effects review_mutation={} task_lifecycle_mutation={} work_item_creation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            preparation.no_effects.review_mutation_performed,
            preparation.no_effects.task_lifecycle_mutation_performed,
            preparation.no_effects.work_item_creation_performed,
            preparation.no_effects.provider_execution_performed,
            preparation.no_effects.provider_write_performed,
            preparation.no_effects.scm_or_forge_mutation_performed,
            preparation.no_effects.accepted_memory_apply_performed,
            preparation.no_effects.planning_apply_performed,
            preparation.no_effects.projection_write_performed,
            preparation.no_effects.agent_scheduling_performed,
            preparation.no_effects.ui_effect_performed
        ),
        "mode=read_only_preview".to_owned(),
        "client_can_mutate=false".to_owned(),
        "work_item_creation_available=false".to_owned(),
        "provider_execution_available=false".to_owned(),
        "agent_scheduling_available=false".to_owned(),
        "scm_or_forge_execution_available=false".to_owned(),
        "payloads_exposed=false".to_owned(),
    ]
}
