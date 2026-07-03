use super::*;

#[test]
fn request_envelope_dto_serializes_planning_sessions_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:planning-sessions".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:planning-sessions".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::PlanningSessions(PlanningSessionsQuery {
                project_id: ProjectId("project:dto".to_owned()),
            }),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::PlanningSessions(query),
            ..
        }) if query.project_id.0 == "project:dto"
    ));
    assert!(json.contains("\"kind\":\"planning_sessions\""));
    assert!(json.contains("\"action\":\"sessions\""));
}
