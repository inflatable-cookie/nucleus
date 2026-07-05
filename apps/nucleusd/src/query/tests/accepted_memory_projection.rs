use super::*;

#[test]
fn accepted_memory_projection_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::accepted_memory_projection_response_lines(
        "accepted-memory-projection",
        ControlAcceptedMemoryProjectionDiagnosticsDto {
            project_id: "project:nucleus-local".to_owned(),
            entries: vec![ControlAcceptedMemoryProjectionEntryDto {
                memory_id: "memory:nucleus-local:bootstrap".to_owned(),
                plan_ref: "accepted-memory-export-plan:memory:nucleus-local:bootstrap".to_owned(),
                file_ref: Some("nucleus/memory/memory:nucleus-local:bootstrap.toml".to_owned()),
                export_status: "blocked".to_owned(),
                policy_status: "review_required".to_owned(),
                policy_blockers: vec![ControlAcceptedMemoryProjectionBlockerDto {
                    kind: "missing_review_evidence".to_owned(),
                    detail: None,
                }],
                export_blockers: vec![ControlAcceptedMemoryProjectionBlockerDto {
                    kind: "policy_denied".to_owned(),
                    detail: None,
                }],
            }],
            counts: ControlAcceptedMemoryProjectionCountsDto {
                accepted_records: 1,
                out_of_scope_accepted_records: 0,
                projectable_records: 0,
                local_only_records: 0,
                blocked_records: 0,
                review_required_records: 1,
                skipped_records: 2,
                skipped_proposal_records: 1,
                skipped_unsupported_records: 0,
                skipped_decode_errors: 1,
                policy_blockers: 1,
                export_blockers: 1,
                file_refs: 1,
            },
            projection_write_performed: false,
            scm_effect_performed: false,
            import_or_apply_performed: false,
            embedding_available: false,
            provider_sync_available: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=accepted-memory-projection"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("entries=1"));
    assert!(rendered.contains("accepted_records=1"));
    assert!(rendered.contains("review_required_records=1"));
    assert!(rendered.contains("skipped_records=2"));
    assert!(rendered.contains("projection_write_performed=false"));
    assert!(rendered.contains("scm_effect_performed=false"));
    assert!(rendered.contains("import_or_apply_performed=false"));
    assert!(rendered.contains("embedding_available=false"));
    assert!(rendered.contains("provider_sync_available=false"));
    assert!(rendered.contains("file_ref=nucleus/memory/memory:nucleus-local:bootstrap.toml"));
    assert!(rendered.contains("policy_blockers=missing_review_evidence"));
    assert!(rendered.contains("export_blockers=policy_denied"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("provider_payload"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("terminal_stream"));
}
