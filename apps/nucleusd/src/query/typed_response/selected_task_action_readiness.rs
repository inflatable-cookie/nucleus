use nucleus_server::ControlSelectedTaskActionReadinessDto;

pub(crate) fn selected_task_action_readiness_response_lines(
    label: &str,
    readiness: ControlSelectedTaskActionReadinessDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("readiness_id={}", readiness.readiness_id),
        format!("project_id={}", readiness.project_id),
        format!("task_id={}", readiness.task_id),
        format!(
            "counts actions={} blockers={} task_records={} readiness_refs={} work_items={} active_work_items={} completed_work_items={} runtime_evidence_refs={} completion_refs={} review_refs={} scm_handoff_refs={} gaps={}",
            readiness.actions.len(),
            readiness.blockers.len(),
            readiness.source_counts.task_records,
            readiness.source_counts.readiness_refs,
            readiness.source_counts.work_items,
            readiness.source_counts.active_work_items,
            readiness.source_counts.completed_work_items,
            readiness.source_counts.runtime_evidence_refs,
            readiness.source_counts.completion_refs,
            readiness.source_counts.review_refs,
            readiness.source_counts.scm_handoff_refs,
            readiness.source_counts.gap_count
        ),
        format!(
            "no_effects task_mutation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            readiness.no_effects.task_mutation_performed,
            readiness.no_effects.provider_execution_performed,
            readiness.no_effects.provider_write_performed,
            readiness.no_effects.scm_or_forge_mutation_performed,
            readiness.no_effects.accepted_memory_apply_performed,
            readiness.no_effects.planning_apply_performed,
            readiness.no_effects.projection_write_performed,
            readiness.no_effects.agent_scheduling_performed,
            readiness.no_effects.ui_effect_performed
        ),
        "payloads_exposed=false".to_owned(),
        "client_can_execute=false".to_owned(),
        "provider_execution_available=false".to_owned(),
        "scm_or_forge_execution_available=false".to_owned(),
    ];

    lines.extend(readiness.actions.into_iter().map(|action| {
        format!(
            "action family={} status={} evidence_refs={} blocker_refs={} reason={}",
            action.family,
            action.status,
            action.evidence_refs.len(),
            action.blocker_refs.len(),
            action.reason
        )
    }));
    lines.extend(readiness.blockers.into_iter().map(|blocker| {
        format!(
            "blocker family={} evidence_refs={} reason={}",
            blocker.family,
            blocker.evidence_refs.len(),
            blocker.reason
        )
    }));

    lines
}
