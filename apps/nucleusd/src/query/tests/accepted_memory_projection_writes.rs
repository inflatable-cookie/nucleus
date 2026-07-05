use super::*;

#[test]
fn accepted_memory_projection_writes_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::accepted_memory_projection_writes_response_lines(
        "accepted-memory-projection-writes",
        ControlAcceptedMemoryProjectionWriteDiagnosticsDto {
            project_id: "project:nucleus-local".to_owned(),
            entries: vec![ControlAcceptedMemoryProjectionWriteEntryDto {
                memory_id: "memory:nucleus-local:bootstrap".to_owned(),
                plan_ref: "accepted-memory-export-plan:memory:nucleus-local:bootstrap".to_owned(),
                file_ref: Some("nucleus/memory/memory:nucleus-local:bootstrap.toml".to_owned()),
                policy_status: "projectable".to_owned(),
                export_status: "stopped".to_owned(),
                admission_status: "admitted".to_owned(),
                payload_status: "ready".to_owned(),
                materialization_status: "not_run".to_owned(),
                policy_blockers: Vec::new(),
                export_blockers: Vec::new(),
                admission_blockers: Vec::new(),
                payload_blockers: vec![ControlAcceptedMemoryProjectionWriteBlockerDto {
                    kind: "example_blocker".to_owned(),
                    detail: Some("sanitized-detail".to_owned()),
                }],
            }],
            counts: ControlAcceptedMemoryProjectionWriteCountsDto {
                accepted_records: 1,
                out_of_scope_accepted_records: 0,
                admitted_writes: 1,
                blocked_writes: 0,
                payload_ready_records: 1,
                payload_blocked_records: 0,
                materialized_files: 0,
                skipped_records: 2,
                skipped_proposal_records: 1,
                skipped_unsupported_records: 0,
                skipped_decode_errors: 1,
                policy_blockers: 0,
                export_blockers: 0,
                admission_blockers: 0,
                payload_blockers: 1,
                file_refs: 1,
            },
            projection_write_performed: false,
            scm_effect_performed: false,
            import_or_apply_performed: false,
            embedding_available: false,
            provider_sync_available: false,
            task_mutation_performed: false,
            ui_effect_performed: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=accepted-memory-projection-writes"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("admitted_writes=1"));
    assert!(rendered.contains("materialized_files=0"));
    assert!(rendered.contains("projection_write_performed=false"));
    assert!(rendered.contains("scm_effect_performed=false"));
    assert!(rendered.contains("import_or_apply_performed=false"));
    assert!(rendered.contains("embedding_available=false"));
    assert!(rendered.contains("provider_sync_available=false"));
    assert!(rendered.contains("task_mutation_performed=false"));
    assert!(rendered.contains("ui_effect_performed=false"));
    assert!(rendered.contains("payload_blockers=example_blocker:sanitized-detail"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("provider_payload"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("terminal_stream"));
}
