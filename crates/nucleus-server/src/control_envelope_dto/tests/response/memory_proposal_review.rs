use nucleus_projects::ProjectId;

use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_memory_proposal_review_diagnostics() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:memory-review-diagnostics".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::MemoryProposalReviewDiagnostics(
            crate::MemoryProposalReviewDiagnostics {
                project_id: ProjectId("project:nucleus".to_owned()),
                proposal_records: 1,
                queued_count: 0,
                deferred_count: 0,
                rejected_count: 0,
                reviewed_for_promotion_count: 1,
                blocked_count: 0,
                needs_review_count: 0,
                entries: vec![crate::MemoryProposalReviewDiagnosticEntry {
                    proposal_id: "memory-proposal:1".to_owned(),
                    scope_ref: "project:nucleus".to_owned(),
                    proposal_status: crate::MemoryProposalReviewProposalStatus::ReviewRequested,
                    review_status: crate::MemoryProposalReviewReviewStatus::ReviewedForPromotion,
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
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let ControlResponseBodyDto::MemoryProposalReviewDiagnostics { diagnostics } = dto.body else {
        panic!("expected memory proposal review diagnostics dto");
    };

    assert_eq!(diagnostics.project_id, "project:nucleus");
    assert_eq!(diagnostics.proposal_records, 1);
    assert_eq!(diagnostics.reviewed_for_promotion_count, 1);
    assert_eq!(diagnostics.entries[0].proposal_status, "review_requested");
    assert_eq!(
        diagnostics.entries[0].review_status,
        "reviewed_for_promotion"
    );
    assert!(!diagnostics.raw_payload_exposed);
    assert!(!diagnostics.private_note_exposed);
}
