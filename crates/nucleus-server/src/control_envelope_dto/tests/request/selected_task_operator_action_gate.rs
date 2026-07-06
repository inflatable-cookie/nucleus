use super::*;

#[test]
fn request_envelope_dto_serializes_selected_task_operator_action_gate_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:operator-gate".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:operator-gate".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::SelectedTaskOperatorActionGate(
                SelectedTaskOperatorActionGateQuery {
                    project_id: ProjectId("project:dto".to_owned()),
                    task_id: nucleus_tasks::TaskId("task:dto".to_owned()),
                },
            ),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::SelectedTaskOperatorActionGate(query),
            ..
        }) if query.project_id.0 == "project:dto" && query.task_id.0 == "task:dto"
    ));
    assert!(json.contains("\"kind\":\"selected_task_operator_action_gate\""));
    assert!(json.contains("\"action\":\"gate\""));
}
