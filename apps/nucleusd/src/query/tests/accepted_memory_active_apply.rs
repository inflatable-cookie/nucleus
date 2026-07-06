use nucleus_server::{
    ControlAcceptedMemoryActiveApplyCountsDto, ControlAcceptedMemoryActiveApplyDiagnosticsDto,
    ControlAcceptedMemoryActiveApplyRecordDto,
};

#[test]
fn accepted_memory_active_apply_response_lines_are_read_only_and_sanitized() {
    let lines = crate::query::typed_response::accepted_memory_active_apply_response_lines(
        "accepted-memory-active-apply-diagnostics",
        ControlAcceptedMemoryActiveApplyDiagnosticsDto {
            diagnostics_id: "accepted-memory-active-apply-diagnostics".to_owned(),
            project_id: "project:nucleus".to_owned(),
            records: vec![ControlAcceptedMemoryActiveApplyRecordDto {
                active_apply_admission_ref: "accepted-memory-active-apply:review:1".to_owned(),
                request_id: "request:1".to_owned(),
                review_receipt_id: "review:1".to_owned(),
                project_id: "project:nucleus".to_owned(),
                command_id: "command:1".to_owned(),
                apply_admission_ref: "apply:1".to_owned(),
                import_admission_ref: "import:1".to_owned(),
                conflict_ref: "conflict:1".to_owned(),
                candidate_ref: "candidate:1".to_owned(),
                memory_id: "memory:1".to_owned(),
                file_ref: "nucleus/memory/memory-1.toml".to_owned(),
                operator_ref: "operator:diagnostics".to_owned(),
                approval_ref: "approval:active-apply".to_owned(),
                provenance_refs: vec!["provenance:1".to_owned()],
                evidence_refs: vec!["evidence:1".to_owned()],
                review_decision: "approve".to_owned(),
                review_status: "approved".to_owned(),
                review_admission_status: "admitted".to_owned(),
                status: "admitted".to_owned(),
                blockers: Vec::new(),
            }],
            counts: ControlAcceptedMemoryActiveApplyCountsDto {
                source_records: 1,
                admitted: 1,
                duplicate_noops: 0,
                blocked: 0,
                blockers: 0,
                missing_ref_blockers: 0,
                review_state_blockers: 0,
                stale_ref_blockers: 0,
                raw_payload_blockers: 0,
                effect_blockers: 0,
                unsupported_records_skipped: 0,
                other_project_records_skipped: 0,
                decode_failed_records: 0,
            },
            active_memory_apply_performed: false,
            projection_write_performed: false,
            scm_effect_performed: false,
            embedding_available: false,
            provider_sync_available: false,
            automatic_extraction_performed: false,
            task_mutation_performed: false,
            agent_scheduling_performed: false,
            ui_effect_performed: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=accepted-memory-active-apply-diagnostics"));
    assert!(rendered.contains("records=1"));
    assert!(rendered.contains("admitted=1"));
    assert!(rendered.contains("active_memory_apply_performed=false"));
    assert!(rendered.contains("projection_write_performed=false"));
    assert!(rendered.contains("scm_effect_performed=false"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("provider_payload"));
}
