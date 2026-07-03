use super::*;

#[test]
fn request_envelope_dto_serializes_memory_proposal_review_diagnostics_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:memory-review-diagnostics".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:memory-review-diagnostics".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::MemoryProposalReviewDiagnostics(
                MemoryProposalReviewDiagnosticsQuery {
                    project_id: ProjectId("project:nucleus".to_owned()),
                },
            ),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    let ServerControlRequestKind::Query(query) = restored.kind else {
        panic!("expected query");
    };
    let ServerQueryKind::MemoryProposalReviewDiagnostics(query) = query.kind else {
        panic!("expected memory proposal review diagnostics query");
    };
    assert_eq!(query.project_id.0, "project:nucleus");
}
