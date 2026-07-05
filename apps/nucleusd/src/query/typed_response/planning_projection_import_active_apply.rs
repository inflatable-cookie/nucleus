use nucleus_server::{
    ControlPlanningProjectionImportActiveApplyBucketDto,
    ControlPlanningProjectionImportActiveApplyDiagnosticsDto,
};

pub(crate) fn planning_projection_import_active_apply_response_lines(
    label: &str,
    diagnostics: ControlPlanningProjectionImportActiveApplyDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("diagnostics_id={}", diagnostics.diagnostics_id),
        format!("records={}", diagnostics.admission_record_count),
        format!(
            "counts admitted={} duplicate_noop={} blocked={} operation_refs={} evidence_refs={} blockers={} stale={} conflict={} unsupported={} repair_required={} missing_ref={}",
            diagnostics.admitted_record_count,
            diagnostics.duplicate_noop_record_count,
            diagnostics.blocked_record_count,
            diagnostics.operation_ref_count,
            diagnostics.evidence_ref_count,
            diagnostics.blocker_count,
            diagnostics.stale_count,
            diagnostics.conflict_count,
            diagnostics.unsupported_count,
            diagnostics.repair_required_count,
            diagnostics.missing_ref_count
        ),
        format!(
            "active_planning_mutation_permitted={}",
            diagnostics.active_planning_mutation_permitted
        ),
        format!(
            "executor_invocation_permitted={}",
            diagnostics.executor_invocation_permitted
        ),
        format!("task_creation_permitted={}", diagnostics.task_creation_permitted),
        format!(
            "task_promotion_permitted={}",
            diagnostics.task_promotion_permitted
        ),
        format!(
            "projection_write_permitted={}",
            diagnostics.projection_write_permitted
        ),
        format!(
            "provider_execution_permitted={}",
            diagnostics.provider_execution_permitted
        ),
        format!(
            "scm_mutation_permitted={}",
            diagnostics.scm_mutation_permitted
        ),
        format!(
            "forge_mutation_permitted={}",
            diagnostics.forge_mutation_permitted
        ),
        format!(
            "semantic_merge_permitted={}",
            diagnostics.semantic_merge_permitted
        ),
        format!(
            "accepted_memory_mutation_permitted={}",
            diagnostics.accepted_memory_mutation_permitted
        ),
        format!("callback_permitted={}", diagnostics.callback_permitted),
        format!("interruption_permitted={}", diagnostics.interruption_permitted),
        format!("recovery_permitted={}", diagnostics.recovery_permitted),
        format!("raw_payload_retained={}", diagnostics.raw_payload_retained),
        format!("payload_body_included={}", diagnostics.payload_body_included),
        format!(
            "private_planning_body_exposed={}",
            diagnostics.private_planning_body_exposed
        ),
        format!(
            "provider_payload_exposed={}",
            diagnostics.provider_payload_exposed
        ),
        format!("source_body_exposed={}", diagnostics.source_body_exposed),
        format!("ui_apply_permitted={}", diagnostics.ui_apply_permitted),
    ];

    append_buckets(
        &mut lines,
        "record_status",
        diagnostics.record_status_buckets,
    );
    append_buckets(&mut lines, "blocker", diagnostics.blocker_buckets);
    lines
}

fn append_buckets(
    lines: &mut Vec<String>,
    label: &str,
    buckets: Vec<ControlPlanningProjectionImportActiveApplyBucketDto>,
) {
    lines.extend(
        buckets
            .into_iter()
            .map(|bucket| format!("{label} label={} count={}", bucket.label, bucket.count)),
    );
}
