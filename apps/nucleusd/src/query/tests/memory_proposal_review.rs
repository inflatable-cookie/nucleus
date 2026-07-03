use nucleus_server::{
    ControlMemoryProposalReviewDiagnosticEntryDto, ControlMemoryProposalReviewDiagnosticsDto,
};

use super::*;

#[test]
fn memory_proposal_review_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::memory_proposal_review_response_lines(
        "memory-proposal-review-diagnostics",
        ControlMemoryProposalReviewDiagnosticsDto {
            project_id: "project:nucleus-local".to_owned(),
            proposal_records: 1,
            queued_count: 0,
            deferred_count: 0,
            rejected_count: 0,
            reviewed_for_promotion_count: 1,
            blocked_count: 0,
            needs_review_count: 0,
            entries: vec![ControlMemoryProposalReviewDiagnosticEntryDto {
                proposal_id: "memory-proposal:1".to_owned(),
                scope_ref: "project:nucleus-local".to_owned(),
                proposal_status: "review_requested".to_owned(),
                review_status: "reviewed_for_promotion".to_owned(),
                reviewer_ref_present: true,
                note_present: true,
                source_ref_count: 1,
                link_ref_count: 0,
            }],
            client_can_mutate: false,
            accepted_memory_created: false,
            projection_written: false,
            embedding_generated: false,
            provider_native_memory_synced: false,
            automatic_extraction_run: false,
            raw_payload_exposed: false,
            private_note_exposed: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=memory-proposal-review-diagnostics"));
    assert!(rendered.contains("records=1"));
    assert!(rendered.contains("reviewed_for_promotion=1"));
    assert!(rendered.contains("accepted_memory_created=false"));
    assert!(rendered.contains("raw_payload_exposed=false"));
    assert!(rendered.contains("private_note_exposed=false"));
    assert!(!rendered.contains("Hidden note"));
    assert!(!rendered.contains("raw_payload="));
    assert!(!rendered.contains("provider_write_executed=true"));
}
