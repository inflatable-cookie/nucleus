use nucleus_server::ControlTaskSeedPromotionDiagnosticsDto;

pub(crate) fn task_seed_promotion_response_lines(
    label: &str,
    diagnostics: ControlTaskSeedPromotionDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={}", diagnostics.project_id),
        format!("records={}", diagnostics.task_seed_records),
        format!(
            "counts ready={} blocked={} rejected={} promoted={} duplicate_promoted_task_refs={} missing_promoted_task_refs={}",
            diagnostics.ready_count,
            diagnostics.blocked_count,
            diagnostics.rejected_count,
            diagnostics.promoted_count,
            diagnostics.duplicate_promoted_task_ref_count,
            diagnostics.missing_promoted_task_ref_count
        ),
        format!("client_can_mutate={}", diagnostics.client_can_mutate),
        format!(
            "task_creation_performed={}",
            diagnostics.task_creation_performed
        ),
        format!(
            "provider_execution_performed={}",
            diagnostics.provider_execution_performed
        ),
        format!(
            "raw_planning_body_exposed={}",
            diagnostics.raw_planning_body_exposed
        ),
    ];
    lines.extend(diagnostics.entries.into_iter().map(|entry| {
        format!(
            "seed seed_id={} readiness={} review={} promotion={} promoted_task_ref={} promoted_task_exists={} duplicate_promoted_task_ref={} blocking_questions={}",
            entry.seed_id,
            entry.readiness,
            entry.review_state,
            entry.promotion_state,
            entry.promoted_task_ref.unwrap_or_else(|| "none".to_owned()),
            entry.promoted_task_exists,
            entry.duplicate_promoted_task_ref,
            entry.blocking_question_count
        )
    }));
    lines
}
