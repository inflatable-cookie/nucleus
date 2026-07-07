use nucleus_server::ControlSelectedTaskReviewOutcomeRouteDto;

pub(crate) fn selected_task_review_outcome_route_response_lines(
    label: &str,
    route: ControlSelectedTaskReviewOutcomeRouteDto,
) -> Vec<String> {
    vec![
        format!("domain={label}"),
        format!("route_id={}", route.route_id),
        format!("project_id={}", route.project_id),
        format!("task_id={}", route.task_id),
        format!("status={}", route.status),
        format!("primary_route={}", route.primary_route),
        format!(
            "decision_ref={}",
            route.decision_ref.as_deref().unwrap_or("none")
        ),
        format!(
            "decision_outcome={}",
            route.decision_outcome.as_deref().unwrap_or("none")
        ),
        format!("candidates={}", route.candidates.len()),
        format!("work_item_refs={}", route.work_item_refs.len()),
        format!("evidence_refs={}", route.evidence_refs.len()),
        format!(
            "downstream_command_hints={}",
            route.downstream_command_hints.len()
        ),
        format!("blockers={}", route.blockers.len()),
        format!(
            "counts decision_records={} work_item_refs={} evidence_refs={} review_gap_count={} scm_handoff_refs={} downstream_command_hints={} blockers={}",
            route.source_counts.decision_records,
            route.source_counts.work_item_refs,
            route.source_counts.evidence_refs,
            route.source_counts.review_gap_count,
            route.source_counts.scm_handoff_refs,
            route.source_counts.downstream_command_hints,
            route.source_counts.blockers
        ),
        format!(
            "no_effects review_mutation={} task_lifecycle_mutation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            route.no_effects.review_mutation_performed,
            route.no_effects.task_lifecycle_mutation_performed,
            route.no_effects.provider_execution_performed,
            route.no_effects.provider_write_performed,
            route.no_effects.scm_or_forge_mutation_performed,
            route.no_effects.accepted_memory_apply_performed,
            route.no_effects.planning_apply_performed,
            route.no_effects.projection_write_performed,
            route.no_effects.agent_scheduling_performed,
            route.no_effects.ui_effect_performed
        ),
        "mode=read_only".to_owned(),
        "client_can_mutate=false".to_owned(),
        "provider_execution_available=false".to_owned(),
        "scm_or_forge_execution_available=false".to_owned(),
        "payloads_exposed=false".to_owned(),
    ]
}
