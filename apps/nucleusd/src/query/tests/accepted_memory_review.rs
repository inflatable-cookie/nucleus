use super::*;
use nucleus_server::{
    ControlAcceptedMemoryReviewReadinessCountsDto, ControlAcceptedMemoryReviewReadinessDto,
    ControlAcceptedMemoryReviewReadinessRecordDto,
};

#[test]
fn accepted_memory_review_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::accepted_memory_review_response_lines(
        "accepted-memory-review-readiness",
        ControlAcceptedMemoryReviewReadinessDto {
            project_id: "project:nucleus-local".to_owned(),
            records: vec![ControlAcceptedMemoryReviewReadinessRecordDto {
                source: "import_apply_admission".to_owned(),
                memory_id: Some("memory:1".to_owned()),
                source_ref: "accepted-memory-import-apply-admission:request:1".to_owned(),
                file_ref: Some("nucleus/memory/memory:1.toml".to_owned()),
                status: "approval_required".to_owned(),
                blocker_count: 2,
                evidence_ref_count: 2,
                approval_required: true,
            }],
            counts: ControlAcceptedMemoryReviewReadinessCountsDto {
                records: 1,
                accepted_memories: 1,
                projectable: 1,
                projection_blocked: 0,
                projection_write_admitted: 1,
                projection_write_blocked: 0,
                import_candidates_ready: 1,
                import_candidates_blocked: 0,
                import_admitted: 1,
                import_blocked: 0,
                duplicate_noops: 0,
                conflicts: 0,
                apply_admitted: 0,
                approval_required: 1,
                apply_blocked: 0,
                blocker_count: 2,
                evidence_ref_count: 2,
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

    assert!(rendered.contains("domain=accepted-memory-review-readiness"));
    assert!(rendered.contains("approval_required=1"));
    assert!(rendered.contains("active_memory_apply_performed=false"));
    assert!(rendered.contains("projection_write_performed=false"));
    assert!(rendered.contains("scm_effect_performed=false"));
    assert!(rendered.contains("embedding_available=false"));
    assert!(rendered.contains("provider_sync_available=false"));
    assert!(rendered.contains("automatic_extraction_performed=false"));
    assert!(rendered.contains("task_mutation_performed=false"));
    assert!(rendered.contains("agent_scheduling_performed=false"));
    assert!(rendered.contains("ui_effect_performed=false"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("provider_payload"));
    assert!(!rendered.contains("private_memory_body"));
    assert!(!rendered.contains("terminal_stream"));
}
