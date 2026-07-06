use nucleus_server::ControlPlanningProjectionFileWriteDiagnosticsDto;

#[test]
fn planning_projection_file_write_response_lines_are_read_only_and_sanitized() {
    let lines = crate::query::typed_response::planning_projection_file_write_response_lines(
        "planning-projection-file-write-diagnostics",
        ControlPlanningProjectionFileWriteDiagnosticsDto {
            materialized_planning_artifact_files: 1,
            materialized_planning_task_seed_files: 1,
            invalid_ref_count: 0,
            unsupported_record_count: 0,
            encode_failure_count: 0,
            skipped_write_count: 0,
            issues: Vec::new(),
            import_or_apply_authority: false,
            scm_mutation_authority: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=planning-projection-file-write-diagnostics"));
    assert!(rendered.contains("records=2"));
    assert!(rendered.contains("planning_artifacts=1"));
    assert!(rendered.contains("planning_task_seeds=1"));
    assert!(rendered.contains("import_or_apply_authority=false"));
    assert!(rendered.contains("scm_mutation_authority=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("problem_statement"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("provider_write_executed=true"));
}
