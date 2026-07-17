use nucleus_server::{
    ControlAcceptedMemoryImportApplyReviewCountsDto,
    ControlAcceptedMemoryImportApplyReviewDiagnosticsDto,
    ControlAcceptedMemoryImportApplyReviewReceiptDto,
};

#[test]
fn accepted_memory_import_apply_review_response_lines_are_read_only_and_sanitized() {
    let lines = crate::query::typed_response::accepted_memory_import_apply_review_response_lines(
        "accepted-memory-import-apply-review-diagnostics",
        ControlAcceptedMemoryImportApplyReviewDiagnosticsDto {
            diagnostics_id: "accepted-memory-import-apply-review-diagnostics".to_owned(),
            project_id: "project:nucleus".to_owned(),
            receipts: vec![ControlAcceptedMemoryImportApplyReviewReceiptDto {
                review_receipt_ref: "accepted-memory-import-apply-review:command:1".to_owned(),
                command_id: "command:1".to_owned(),
                apply_admission_ref: "apply:1".to_owned(),
                import_admission_ref: "import:1".to_owned(),
                conflict_ref: "conflict:1".to_owned(),
                candidate_ref: "candidate:1".to_owned(),
                memory_id: Some("memory:1".to_owned()),
                file_ref: "nucleus/memory/memory-1.toml".to_owned(),
                operator_ref: "operator:diagnostics".to_owned(),
                approval_ref: "approval:1".to_owned(),
                decision_reason_ref: String::new(),
                admission_status: "admitted".to_owned(),
                admission_blockers: Vec::new(),
                decision: "approve".to_owned(),
                status: "approved".to_owned(),
                blockers: Vec::new(),
                provenance_refs: vec!["provenance:1".to_owned()],
                evidence_refs: vec!["evidence:1".to_owned()],
            }],
            counts: ControlAcceptedMemoryImportApplyReviewCountsDto {
                inputs: 1,
                approved: 1,
                deferred: 0,
                rejected: 0,
                blocked: 0,
                duplicate_noops: 0,
                conflicts: 0,
                approval_required: 1,
                blockers: 0,
                missing_ref_blockers: 0,
                admission_blockers: 0,
                raw_payload_blockers: 0,
                effect_blockers: 0,
                provenance_refs: 1,
                evidence_refs: 1,
            },
            review_receipts_persisted: false,
            no_effects: nucleus_server::MemoryApplyNoEffects::none(),
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=accepted-memory-import-apply-review-diagnostics"));
    assert!(rendered.contains("approved=1"));
    assert!(rendered.contains("approval_required=1"));
    assert!(rendered.contains("review_receipts_persisted=false"));
    assert!(rendered.contains("active_memory_apply_performed=false"));
    assert!(rendered.contains("projection_write_performed=false"));
    assert!(rendered.contains("scm_effect_performed=false"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("provider_payload"));
}
