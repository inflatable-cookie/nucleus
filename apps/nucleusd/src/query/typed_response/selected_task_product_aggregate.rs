use nucleus_server::ControlSelectedTaskProductAggregateDto;

pub(crate) fn selected_task_product_aggregate_response_lines(
    label: &str,
    aggregate: ControlSelectedTaskProductAggregateDto,
) -> Vec<String> {
    vec![
        format!("domain={label}"),
        format!("aggregate_id={}", aggregate.aggregate_id),
        format!("project_id={}", aggregate.project_id),
        format!("task_id={}", aggregate.task_id),
        format!(
            "task title={} activity={} assignment={} action_type={}",
            aggregate.identity.title.as_deref().unwrap_or("none"),
            aggregate.identity.activity.as_deref().unwrap_or("none"),
            aggregate.identity.assignment.as_deref().unwrap_or("none"),
            aggregate.identity.action_type.as_deref().unwrap_or("none")
        ),
        format!(
            "next phase={} action={} next_ref={} blocked_reason={}",
            aggregate.workflow.phase,
            aggregate.workflow.primary_next_action,
            aggregate.workflow.next_ref.as_deref().unwrap_or("none"),
            aggregate
                .workflow
                .blocked_reason
                .as_deref()
                .unwrap_or("none")
        ),
        format!(
            "readiness allowed_actions={} blockers={} unavailable_actions={}",
            aggregate.readiness.allowed_action_count,
            aggregate.readiness.blockers.len(),
            aggregate.readiness.unavailable_actions.len()
        ),
        format!(
            "command_previews admitted={} refused={} total={}",
            aggregate.command_previews.admitted_count,
            aggregate.command_previews.refused_count,
            aggregate.command_previews.previews.len()
        ),
        format!(
            "work_evidence work_items={} active={} completed={} evidence_refs={} timeline_refs={}",
            aggregate.work_evidence.work_item_refs.len(),
            aggregate.work_evidence.active_work_item_count,
            aggregate.work_evidence.completed_work_item_count,
            aggregate.work_evidence.evidence_refs.len(),
            aggregate.work_evidence.timeline_refs.len()
        ),
        format!(
            "review state={} route_status={} primary_route={} decision_available={} evidence_refs={}",
            aggregate.review.state.as_deref().unwrap_or("none"),
            aggregate.review.route_status.as_deref().unwrap_or("none"),
            aggregate.review.primary_route.as_deref().unwrap_or("none"),
            aggregate.review.decision_available,
            aggregate.review.evidence_refs.len()
        ),
        format!(
            "rework status={} reviewed_work_item_refs={} reviewed_evidence_refs={} refusal={}",
            aggregate.rework.status.as_deref().unwrap_or("none"),
            aggregate.rework.reviewed_work_item_refs.len(),
            aggregate.rework.reviewed_evidence_refs.len(),
            aggregate.rework.refusal_reason.as_deref().unwrap_or("none")
        ),
        format!(
            "completion status={} command_available={} evidence_refs={} refusal={}",
            aggregate.completion.status.as_deref().unwrap_or("none"),
            aggregate.completion.command_available,
            aggregate.completion.evidence_refs.len(),
            aggregate.completion.refusal_reason.as_deref().unwrap_or("none")
        ),
        format!(
            "scm_handoff state={} next_category={} target_shape={} evidence_refs={} gaps={}",
            aggregate.scm_handoff.state.as_deref().unwrap_or("none"),
            aggregate
                .scm_handoff
                .next_category
                .as_deref()
                .unwrap_or("none"),
            aggregate
                .scm_handoff
                .target_shape
                .as_deref()
                .unwrap_or("none"),
            aggregate.scm_handoff.evidence_refs.len(),
            aggregate.scm_handoff.gap_count
        ),
        format!(
            "source_health sources={} missing={} partial={} gaps={}",
            aggregate.source_health.sources.len(),
            aggregate.source_health.missing_count,
            aggregate.source_health.partial_count,
            aggregate.gaps.len()
        ),
        format!(
            "no_effects task_mutation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            aggregate.no_effects.task_mutation_performed,
            aggregate.no_effects.provider_execution_performed,
            aggregate.no_effects.provider_write_performed,
            aggregate.no_effects.scm_or_forge_mutation_performed,
            aggregate.no_effects.accepted_memory_apply_performed,
            aggregate.no_effects.planning_apply_performed,
            aggregate.no_effects.projection_write_performed,
            aggregate.no_effects.agent_scheduling_performed,
            aggregate.no_effects.ui_effect_performed
        ),
        "mode=read_only_product_aggregate".to_owned(),
        "client_can_mutate=false".to_owned(),
        "provider_execution_available=false".to_owned(),
        "scm_or_forge_execution_available=false".to_owned(),
        "proof_payload_dump=false".to_owned(),
        "payloads_exposed=false".to_owned(),
    ]
}
