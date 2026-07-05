use super::*;
use nucleus_server::{
    ControlAcceptedMemoryProjectionImportApplyBlockerDto,
    ControlAcceptedMemoryProjectionImportApplyCountsDto,
    ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto,
    ControlAcceptedMemoryProjectionImportApplyRecordDto,
};

#[test]
fn accepted_memory_projection_import_apply_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::accepted_memory_projection_import_apply_response_lines(
        "accepted-memory-projection-import-apply",
        ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto {
            diagnostics_id: "accepted-memory-import-apply-diagnostics".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            records: vec![ControlAcceptedMemoryProjectionImportApplyRecordDto {
                apply_admission_ref: "accepted-memory-import-apply-admission:request:1".to_owned(),
                request_id: "request:1".to_owned(),
                import_admission_ref: "accepted-memory-import-admission:candidate".to_owned(),
                conflict_ref: "accepted-memory-import-conflict:admission".to_owned(),
                candidate_ref: "accepted-memory-import-candidate:nucleus/memory/memory:1.toml"
                    .to_owned(),
                memory_id: Some("memory:1".to_owned()),
                file_ref: "nucleus/memory/memory:1.toml".to_owned(),
                operator_ref: String::new(),
                approval_ref: String::new(),
                provenance_refs: vec!["nucleus/memory/memory:1.toml".to_owned()],
                evidence_refs: vec!["candidate:1".to_owned(), "admission:1".to_owned()],
                status: "blocked".to_owned(),
                blockers: vec![ControlAcceptedMemoryProjectionImportApplyBlockerDto {
                    kind: "missing_approval_ref".to_owned(),
                    detail: None,
                }],
            }],
            counts: ControlAcceptedMemoryProjectionImportApplyCountsDto {
                source_records: 1,
                import_conflicts: 1,
                apply_admissions: 1,
                admitted: 0,
                duplicate_noops: 0,
                blocked: 1,
                blockers: 1,
                missing_ref_blockers: 1,
                conflict_blockers: 0,
                raw_payload_blockers: 0,
                effect_blockers: 0,
                provenance_refs: 1,
                evidence_refs: 2,
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

    assert!(rendered.contains("domain=accepted-memory-projection-import-apply"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("apply_admissions=1"));
    assert!(rendered.contains("blocked=1"));
    assert!(rendered.contains("active_memory_apply_performed=false"));
    assert!(rendered.contains("projection_write_performed=false"));
    assert!(rendered.contains("scm_effect_performed=false"));
    assert!(rendered.contains("embedding_available=false"));
    assert!(rendered.contains("provider_sync_available=false"));
    assert!(rendered.contains("automatic_extraction_performed=false"));
    assert!(rendered.contains("task_mutation_performed=false"));
    assert!(rendered.contains("agent_scheduling_performed=false"));
    assert!(rendered.contains("ui_effect_performed=false"));
    assert!(rendered.contains("blockers=missing_approval_ref"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("provider_payload"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("terminal_stream"));
}
