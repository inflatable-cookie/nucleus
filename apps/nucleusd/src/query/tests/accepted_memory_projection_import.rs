use super::*;

#[test]
fn accepted_memory_projection_import_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::accepted_memory_projection_import_response_lines(
        "accepted-memory-projection-import",
        ControlAcceptedMemoryProjectionImportDiagnosticsDto {
            project_id: "project:nucleus-local".to_owned(),
            candidates: vec![ControlAcceptedMemoryProjectionImportCandidateDto {
                candidate_ref: "accepted-memory-import-candidate:nucleus/memory/memory:1.toml"
                    .to_owned(),
                memory_id: Some("memory:1".to_owned()),
                file_ref: "nucleus/memory/memory:1.toml".to_owned(),
                status: "ready".to_owned(),
                summary: Some(ControlAcceptedMemoryProjectionImportSummaryDto {
                    title: "Sanitized title".to_owned(),
                    body_kind: "summary".to_owned(),
                    body_summary: "Sanitized summary".to_owned(),
                }),
                blockers: Vec::new(),
            }],
            admissions: vec![ControlAcceptedMemoryProjectionImportAdmissionDto {
                admission_ref: "accepted-memory-import-admission:candidate".to_owned(),
                candidate_ref: "accepted-memory-import-candidate:nucleus/memory/memory:1.toml"
                    .to_owned(),
                memory_id: Some("memory:1".to_owned()),
                file_ref: "nucleus/memory/memory:1.toml".to_owned(),
                status: "admitted".to_owned(),
                blockers: Vec::new(),
            }],
            conflicts: vec![ControlAcceptedMemoryProjectionImportConflictDto {
                conflict_ref: "accepted-memory-import-conflict:admission".to_owned(),
                admission_ref: "accepted-memory-import-admission:candidate".to_owned(),
                candidate_ref: "accepted-memory-import-candidate:nucleus/memory/memory:1.toml"
                    .to_owned(),
                memory_id: Some("memory:1".to_owned()),
                file_ref: "nucleus/memory/memory:1.toml".to_owned(),
                status: "duplicate_noop".to_owned(),
                summary: None,
                blockers: vec![ControlAcceptedMemoryProjectionImportBlockerDto {
                    kind: "example_blocker".to_owned(),
                    detail: Some("sanitized-detail".to_owned()),
                }],
            }],
            counts: ControlAcceptedMemoryProjectionImportCountsDto {
                source_records: 1,
                accepted_records: 1,
                out_of_scope_accepted_records: 0,
                skipped_records: 0,
                skipped_proposal_records: 0,
                skipped_unsupported_records: 0,
                skipped_decode_errors: 0,
                skipped_encode_errors: 0,
                input_files: 1,
                candidates: 1,
                ready_candidates: 1,
                blocked_candidates: 0,
                admitted_imports: 1,
                blocked_imports: 0,
                no_conflicts: 0,
                duplicate_noops: 1,
                semantic_conflicts: 0,
                policy_conflicts: 0,
                blocked_conflicts: 0,
                candidate_blockers: 0,
                admission_blockers: 0,
                conflict_blockers: 1,
                file_refs: 1,
            },
            projected_file_read_performed: false,
            active_memory_apply_performed: false,
            scm_effect_performed: false,
            embedding_available: false,
            provider_sync_available: false,
            task_mutation_performed: false,
            ui_effect_performed: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=accepted-memory-projection-import"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("duplicate_noops=1"));
    assert!(rendered.contains("projected_file_read_performed=false"));
    assert!(rendered.contains("active_memory_apply_performed=false"));
    assert!(rendered.contains("scm_effect_performed=false"));
    assert!(rendered.contains("embedding_available=false"));
    assert!(rendered.contains("provider_sync_available=false"));
    assert!(rendered.contains("task_mutation_performed=false"));
    assert!(rendered.contains("ui_effect_performed=false"));
    assert!(rendered.contains("blockers=example_blocker:sanitized-detail"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("provider_payload"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("terminal_stream"));
}
