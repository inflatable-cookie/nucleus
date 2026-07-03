use nucleus_server::{
    ControlPlanningProjectionImportBucketDto, ControlPlanningProjectionImportDiagnosticsDto,
};

pub(crate) fn planning_projection_import_response_lines(
    label: &str,
    diagnostics: ControlPlanningProjectionImportDiagnosticsDto,
) -> Vec<String> {
    let records =
        diagnostics.candidate_count + diagnostics.admission_count + diagnostics.conflict_count;
    let mut lines = vec![
        format!("domain={label}"),
        format!("diagnostics_id={}", diagnostics.diagnostics_id),
        format!("records={records}"),
        format!(
            "counts candidates={} ready_candidates={} blocked_candidates={} admissions={} admitted_stopped={} duplicate_noop={} blocked_admissions={} conflicts={} blockers={} evidence_refs={}",
            diagnostics.candidate_count,
            diagnostics.ready_candidate_count,
            diagnostics.blocked_candidate_count,
            diagnostics.admission_count,
            diagnostics.admitted_stopped_count,
            diagnostics.duplicate_noop_count,
            diagnostics.blocked_admission_count,
            diagnostics.conflict_count,
            diagnostics.blocker_count,
            diagnostics.evidence_ref_count
        ),
        format!("apply_blocked={}", diagnostics.apply_blocked),
        format!("apply_permitted={}", diagnostics.apply_permitted),
        format!(
            "task_promotion_permitted={}",
            diagnostics.task_promotion_permitted
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
        format!("raw_payload_retained={}", diagnostics.raw_payload_retained),
        format!("ui_apply_permitted={}", diagnostics.ui_apply_permitted),
        "payloads_exposed=false".to_owned(),
    ];

    append_buckets(
        &mut lines,
        "candidate_status",
        diagnostics.candidate_status_buckets,
    );
    append_buckets(
        &mut lines,
        "admission_status",
        diagnostics.admission_status_buckets,
    );
    append_buckets(
        &mut lines,
        "conflict_kind",
        diagnostics.conflict_kind_buckets,
    );

    lines
}

fn append_buckets(
    lines: &mut Vec<String>,
    label: &str,
    buckets: Vec<ControlPlanningProjectionImportBucketDto>,
) {
    lines.extend(
        buckets
            .into_iter()
            .map(|bucket| format!("{label} label={} count={}", bucket.label, bucket.count)),
    );
}
