use super::*;

#[test]
fn request_envelope_dto_serializes_selected_task_route_admission_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:route-admission".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:route-admission".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::SelectedTaskRouteAdmission(SelectedTaskRouteAdmissionQuery {
                project_id: ProjectId("project:dto".to_owned()),
                task_id: nucleus_tasks::TaskId("task:dto".to_owned()),
                expected_revision: Some(RevisionId("rev:dto".to_owned())),
                operator_ref: "operator:dto".to_owned(),
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
            kind: ServerQueryKind::SelectedTaskRouteAdmission(query),
            ..
        }) if query.project_id.0 == "project:dto"
            && query.task_id.0 == "task:dto"
            && query.expected_revision == Some(RevisionId("rev:dto".to_owned()))
            && query.operator_ref == "operator:dto"
    ));
    assert!(json.contains("\"kind\":\"selected_task_route_admission\""));
    assert!(json.contains("\"action\":\"admission\""));
    assert!(json.contains("\"operator_ref\":\"operator:dto\""));
}
