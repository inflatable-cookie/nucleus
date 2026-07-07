use nucleus_server::ControlSelectedTaskScmHandoffDto;

pub(crate) fn selected_task_scm_handoff_response_lines(
    label: &str,
    handoff: ControlSelectedTaskScmHandoffDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("handoff_id={}", handoff.handoff_id),
        format!("project_id={}", handoff.project_id),
        format!("task_id={}", handoff.task_id),
        format!(
            "readiness state={} handoff_refs={} blocker_refs={} reason={}",
            handoff.readiness.state,
            handoff.readiness.handoff_refs.len(),
            handoff.readiness.blocker_refs.len(),
            handoff.readiness.reason
        ),
        format!(
            "target shape={} target_refs={}",
            handoff.target.shape,
            handoff.target.target_refs.len()
        ),
        format!(
            "next category={} next_ref={} rationale_refs={} summary={}",
            handoff.next.category,
            handoff.next.next_ref.as_deref().unwrap_or("none"),
            handoff.next.rationale_refs.len(),
            handoff.next.summary
        ),
        format!(
            "counts task_records={} work_items={} scm_handoff_refs={} scm_work_session_refs={} provider_change_refs={} checkpoint_refs={} diff_summary_refs={} runtime_receipt_refs={} validation_refs={} review_refs={} change_request_prep_refs={} repair_refs={} gaps={}",
            handoff.source_counts.task_records,
            handoff.source_counts.work_items,
            handoff.source_counts.scm_handoff_refs,
            handoff.source_counts.scm_work_session_refs,
            handoff.source_counts.provider_change_refs,
            handoff.source_counts.checkpoint_refs,
            handoff.source_counts.diff_summary_refs,
            handoff.source_counts.runtime_receipt_refs,
            handoff.source_counts.validation_refs,
            handoff.source_counts.review_refs,
            handoff.source_counts.change_request_prep_refs,
            handoff.source_counts.repair_refs,
            handoff.source_counts.gap_count
        ),
        format!(
            "evidence work_item_refs={} scm_handoff_refs={} scm_work_session_refs={} provider_change_refs={} checkpoint_refs={} diff_summary_refs={} runtime_receipt_refs={} validation_refs={} review_refs={} change_request_prep_refs={} repair_refs={}",
            handoff.evidence.work_item_refs.len(),
            handoff.evidence.scm_handoff_refs.len(),
            handoff.evidence.scm_work_session_refs.len(),
            handoff.evidence.provider_change_refs.len(),
            handoff.evidence.checkpoint_refs.len(),
            handoff.evidence.diff_summary_refs.len(),
            handoff.evidence.runtime_receipt_refs.len(),
            handoff.evidence.validation_refs.len(),
            handoff.evidence.review_refs.len(),
            handoff.evidence.change_request_prep_refs.len(),
            handoff.evidence.repair_refs.len()
        ),
        format!(
            "no_effects scm_mutation={} forge_mutation={} credential_resolution={} task_mutation={} provider_execution={} review_mutation={} accepted_memory_apply={} planning_apply={} projection_write={} ui_effect={}",
            handoff.no_effects.scm_mutation_performed,
            handoff.no_effects.forge_mutation_performed,
            handoff.no_effects.credential_resolution_performed,
            handoff.no_effects.task_mutation_performed,
            handoff.no_effects.provider_execution_performed,
            handoff.no_effects.review_mutation_performed,
            handoff.no_effects.accepted_memory_apply_performed,
            handoff.no_effects.planning_apply_performed,
            handoff.no_effects.projection_write_performed,
            handoff.no_effects.ui_effect_performed
        ),
        "payloads_exposed=false".to_owned(),
        "client_can_execute=false".to_owned(),
        "client_can_publish=false".to_owned(),
        "credential_resolution_available=false".to_owned(),
        "provider_execution_available=false".to_owned(),
        "scm_or_forge_execution_available=false".to_owned(),
    ];

    lines.extend(
        handoff
            .gaps
            .into_iter()
            .map(|gap| format!("gap area={} reason={}", gap.area, gap.reason)),
    );

    lines
}
