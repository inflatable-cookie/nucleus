use nucleus_server::{
    ControlAcceptedMemoryReviewReceiptStorageCountsDto,
    ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto,
    ControlAcceptedMemoryReviewReceiptStorageRecordDto,
};

#[test]
fn accepted_memory_review_receipt_storage_response_lines_are_read_only_and_sanitized() {
    let lines = crate::query::typed_response::accepted_memory_review_receipt_storage_response_lines(
        "accepted-memory-review-receipt-storage-diagnostics",
        ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto {
            diagnostics_id: "accepted-memory-review-receipt-storage-diagnostics".to_owned(),
            project_id: "project:nucleus".to_owned(),
            receipts: vec![ControlAcceptedMemoryReviewReceiptStorageRecordDto {
                review_receipt_id: "accepted-memory-import-apply-review:command:1".to_owned(),
                command_id: "command:1".to_owned(),
                operator_ref: "operator:tom".to_owned(),
                approval_ref: Some("approval:1".to_owned()),
                decision_reason_ref: None,
                apply_admission_ref: "apply:1".to_owned(),
                import_admission_ref: "import:1".to_owned(),
                conflict_ref: "conflict:1".to_owned(),
                candidate_ref: "candidate:1".to_owned(),
                memory_id: "memory:1".to_owned(),
                file_ref: "nucleus/memory/memory-1.toml".to_owned(),
                provenance_refs: vec!["provenance:1".to_owned()],
                evidence_refs: vec!["evidence:1".to_owned()],
                decision: "approve".to_owned(),
                status: "approved".to_owned(),
                admission_status: "admitted".to_owned(),
                blockers: Vec::new(),
                admission_blockers: Vec::new(),
            }],
            counts: ControlAcceptedMemoryReviewReceiptStorageCountsDto {
                records: 1,
                approved: 1,
                deferred: 0,
                rejected: 0,
                blocked: 0,
                admitted: 1,
                duplicate_noops: 0,
                admission_blocked: 0,
                blockers: 0,
                admission_blockers: 0,
                provenance_refs: 1,
                evidence_refs: 1,
                unsupported_records_skipped: 0,
                other_project_records_skipped: 0,
                decode_failed_records: 0,
            },
            review_receipts_persisted: true,
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

    assert!(rendered.contains("domain=accepted-memory-review-receipt-storage-diagnostics"));
    assert!(rendered.contains("records=1"));
    assert!(rendered.contains("approved=1"));
    assert!(rendered.contains("review_receipts_persisted=true"));
    assert!(rendered.contains("active_memory_apply_performed=false"));
    assert!(rendered.contains("projection_write_performed=false"));
    assert!(rendered.contains("scm_effect_performed=false"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("provider_payload"));
}
