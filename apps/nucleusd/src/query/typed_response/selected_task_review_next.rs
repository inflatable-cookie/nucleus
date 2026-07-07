use nucleus_server::ControlSelectedTaskReviewNextDto;

pub(crate) fn selected_task_review_next_response_lines(
    label: &str,
    review_next: ControlSelectedTaskReviewNextDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("review_next_id={}", review_next.review_next_id),
        format!("project_id={}", review_next.project_id),
        format!("task_id={}", review_next.task_id),
        format!(
            "review state={} work_item_refs={} evidence_refs={} reason={}",
            review_next.review.state,
            review_next.review.work_item_refs.len(),
            review_next.review.evidence_refs.len(),
            review_next.review.reason
        ),
        format!(
            "next category={} next_ref={} rationale_refs={} summary={}",
            review_next.next.category,
            review_next.next.next_ref.as_deref().unwrap_or("none"),
            review_next.next.rationale_refs.len(),
            review_next.next.summary
        ),
        format!(
            "counts task_records={} work_items={} active_work_items={} completed_work_items={} reviewable_work_items={} receipt_refs={} checkpoint_refs={} diff_summary_refs={} validation_refs={} timeline_refs={} review_refs={} task_completion_refs={} guidance_refs={} gaps={}",
            review_next.source_counts.task_records,
            review_next.source_counts.work_items,
            review_next.source_counts.active_work_items,
            review_next.source_counts.completed_work_items,
            review_next.source_counts.reviewable_work_items,
            review_next.source_counts.receipt_refs,
            review_next.source_counts.checkpoint_refs,
            review_next.source_counts.diff_summary_refs,
            review_next.source_counts.validation_refs,
            review_next.source_counts.timeline_refs,
            review_next.source_counts.review_refs,
            review_next.source_counts.task_completion_refs,
            review_next.source_counts.guidance_refs,
            review_next.source_counts.gap_count
        ),
        format!(
            "evidence receipt_refs={} checkpoint_refs={} diff_summary_refs={} validation_refs={} timeline_refs={} review_refs={}",
            review_next.evidence.receipt_refs.len(),
            review_next.evidence.checkpoint_refs.len(),
            review_next.evidence.diff_summary_refs.len(),
            review_next.evidence.validation_refs.len(),
            review_next.evidence.timeline_refs.len(),
            review_next.evidence.review_refs.len()
        ),
        format!(
            "no_effects review_mutation={} task_mutation={} provider_execution={} provider_write={} scm_or_forge_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} agent_scheduling={} ui_effect={}",
            review_next.no_effects.review_mutation_performed,
            review_next.no_effects.task_mutation_performed,
            review_next.no_effects.provider_execution_performed,
            review_next.no_effects.provider_write_performed,
            review_next.no_effects.scm_or_forge_mutation_performed,
            review_next.no_effects.accepted_memory_apply_performed,
            review_next.no_effects.planning_apply_performed,
            review_next.no_effects.projection_write_performed,
            review_next.no_effects.agent_scheduling_performed,
            review_next.no_effects.ui_effect_performed
        ),
        "payloads_exposed=false".to_owned(),
        "client_can_execute=false".to_owned(),
        "client_can_review=false".to_owned(),
        "provider_execution_available=false".to_owned(),
        "scm_or_forge_execution_available=false".to_owned(),
    ];

    lines.extend(
        review_next
            .gaps
            .into_iter()
            .map(|gap| format!("gap area={} reason={}", gap.area, gap.reason)),
    );

    lines
}
