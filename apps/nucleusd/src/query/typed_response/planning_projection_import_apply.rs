use nucleus_server::{
    ControlPlanningProjectionImportApplyBucketDto,
    ControlPlanningProjectionImportApplyDiagnosticsDto,
};

pub(crate) fn planning_projection_import_apply_response_lines(
    label: &str,
    diagnostics: ControlPlanningProjectionImportApplyDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("diagnostics_id={}", diagnostics.diagnostics_id),
        format!("records={}", diagnostics.stopped_apply_record_count),
        format!(
            "counts persisted={} duplicate_noop_records={} blocked_records={} planned_operations={} skipped_operations={} blocked_operations={} ready={} blocked={} conflict={} stale={} duplicate_noop={} repair_required={} blockers={} evidence_refs={}",
            diagnostics.persisted_apply_record_count,
            diagnostics.duplicate_noop_record_count,
            diagnostics.blocked_apply_record_count,
            diagnostics.planned_operation_count,
            diagnostics.skipped_operation_count,
            diagnostics.blocked_operation_count,
            diagnostics.ready_count,
            diagnostics.blocked_count,
            diagnostics.conflict_count,
            diagnostics.stale_count,
            diagnostics.duplicate_noop_count,
            diagnostics.repair_required_count,
            diagnostics.blocker_count,
            diagnostics.evidence_ref_count
        ),
        format!(
            "active_planning_mutation_permitted={}",
            diagnostics.active_planning_mutation_permitted
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
    buckets: Vec<ControlPlanningProjectionImportApplyBucketDto>,
) {
    lines.extend(
        buckets
            .into_iter()
            .map(|bucket| format!("{label} label={} count={}", bucket.label, bucket.count)),
    );
}
