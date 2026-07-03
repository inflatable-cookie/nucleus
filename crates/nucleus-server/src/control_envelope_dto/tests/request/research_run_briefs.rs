use super::*;

#[test]
fn request_envelope_dto_serializes_research_run_briefs_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:research-run-briefs".to_owned()),
        client_id: ClientId("client:dto".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:research-run-briefs".to_owned()),
            client_id: ClientId("client:dto".to_owned()),
            kind: ServerQueryKind::ResearchRunBriefs(ResearchRunBriefsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            }),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let round_trip = ServerControlRequest::try_from(decoded).expect("request");

    let ServerControlRequestKind::Query(query) = round_trip.kind else {
        panic!("expected query");
    };
    let ServerQueryKind::ResearchRunBriefs(query) = query.kind else {
        panic!("expected research run briefs query");
    };

    assert_eq!(query.project_id.0, "project:nucleus");
    assert!(json.contains("\"kind\":\"research_run_briefs\""));
}
