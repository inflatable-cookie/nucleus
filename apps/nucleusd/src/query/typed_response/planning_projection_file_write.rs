use nucleus_server::ControlPlanningProjectionFileWriteDiagnosticsDto;

pub(crate) fn planning_projection_file_write_response_lines(
    label: &str,
    diagnostics: ControlPlanningProjectionFileWriteDiagnosticsDto,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!(
            "records={}",
            diagnostics.materialized_planning_artifact_files
                + diagnostics.materialized_planning_task_seed_files
        ),
        format!(
            "counts planning_artifacts={} planning_task_seeds={} invalid_refs={} unsupported_records={} encode_failures={} skipped_writes={} issues={}",
            diagnostics.materialized_planning_artifact_files,
            diagnostics.materialized_planning_task_seed_files,
            diagnostics.invalid_ref_count,
            diagnostics.unsupported_record_count,
            diagnostics.encode_failure_count,
            diagnostics.skipped_write_count,
            diagnostics.issues.len()
        ),
        format!(
            "import_or_apply_authority={}",
            diagnostics.import_or_apply_authority
        ),
        format!("scm_mutation_authority={}", diagnostics.scm_mutation_authority),
        "payloads_exposed=false".to_owned(),
    ];

    lines.extend(diagnostics.issues.into_iter().map(|issue| {
        format!(
            "issue class={} file_ref={} summary={}",
            issue.class,
            issue.file_ref.unwrap_or_else(|| "-".to_owned()),
            issue.summary
        )
    }));

    lines
}
