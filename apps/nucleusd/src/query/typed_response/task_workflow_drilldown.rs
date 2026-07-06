use nucleus_server::ControlTaskWorkflowDrilldownDto;

pub(crate) fn task_workflow_drilldown_response_lines(
    label: &str,
    drilldown: ControlTaskWorkflowDrilldownDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("drilldown_id={}", drilldown.drilldown_id),
        format!("project_id={}", drilldown.project_id),
        format!("task_id={}", drilldown.task_id),
        format!(
            "task_present={} title={} activity={} assignment={} action_type={}",
            drilldown.task.is_some(),
            drilldown
                .task
                .as_ref()
                .map(|task| task.title.as_str())
                .unwrap_or("-"),
            drilldown
                .task
                .as_ref()
                .map(|task| task.activity.as_str())
                .unwrap_or("-"),
            drilldown
                .task
                .as_ref()
                .map(|task| task.assignment.as_str())
                .unwrap_or("-"),
            drilldown
                .task
                .as_ref()
                .map(|task| task.action_type.as_str())
                .unwrap_or("-")
        ),
        format!(
            "readiness lane={} rationale_refs={}",
            drilldown
                .readiness
                .as_ref()
                .map(|readiness| readiness.lane.as_str())
                .unwrap_or("-"),
            drilldown
                .readiness
                .as_ref()
                .map(|readiness| readiness.rationale_refs.len())
                .unwrap_or(0)
        ),
        format!(
            "counts task_records={} readiness_refs={} timeline_entry_refs={} work_items={} runtime_receipt_refs={} command_evidence_refs={} task_completion_refs={} review_refs={} scm_handoff_refs={}",
            drilldown.source_counts.task_records,
            drilldown.source_counts.readiness_refs,
            drilldown.source_counts.timeline_entry_refs,
            drilldown.source_counts.work_items,
            drilldown.source_counts.runtime_receipt_refs,
            drilldown.source_counts.command_evidence_refs,
            drilldown.source_counts.task_completion_refs,
            drilldown.source_counts.review_refs,
            drilldown.source_counts.scm_handoff_refs
        ),
        format!(
            "next source={} next_ref={} blocked_reason={}",
            drilldown.next.source,
            drilldown.next.next_ref.unwrap_or_else(|| "-".to_owned()),
            drilldown.next.blocked_reason.unwrap_or_else(|| "-".to_owned())
        ),
        format!(
            "no_effects task_mutation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            drilldown.no_effects.task_mutation_performed,
            drilldown.no_effects.provider_execution_performed,
            drilldown.no_effects.provider_write_performed,
            drilldown.no_effects.scm_or_forge_mutation_performed,
            drilldown.no_effects.accepted_memory_apply_performed,
            drilldown.no_effects.planning_apply_performed,
            drilldown.no_effects.projection_write_performed,
            drilldown.no_effects.agent_scheduling_performed,
            drilldown.no_effects.ui_effect_performed
        ),
        format!("timeline_refs={}", drilldown.timeline.entry_refs.len()),
        format!(
            "runtime_refs receipts={} command_evidence={} completions={}",
            drilldown.runtime.runtime_receipt_refs.len(),
            drilldown.runtime.command_evidence_refs.len(),
            drilldown.runtime.task_completion_refs.len()
        ),
        format!("review_refs={}", drilldown.review.review_refs.len()),
        format!("scm_handoff_refs={}", drilldown.scm_handoff.handoff_refs.len()),
        format!("gaps={}", drilldown.gaps.len()),
        "payloads_exposed=false".to_owned(),
        "client_can_mutate=false".to_owned(),
        "provider_execution_available=false".to_owned(),
    ];

    lines.extend(drilldown.work_progress.work_items.into_iter().map(|item| {
        format!(
            "work_item ref={} runtime={} review={} receipts={} checkpoints={} diffs={} validations={} artifacts={} issues={}",
            item.work_item_ref,
            item.runtime_status,
            item.review_status,
            item.receipt_refs.len(),
            item.checkpoint_refs.len(),
            item.diff_summary_refs.len(),
            item.validation_refs.len(),
            item.artifact_refs.len(),
            item.issue_refs.len()
        )
    }));
    lines.extend(
        drilldown
            .gaps
            .into_iter()
            .map(|gap| format!("gap area={} reason={}", gap.area, gap.reason)),
    );

    lines
}
