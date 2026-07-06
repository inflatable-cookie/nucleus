use super::*;

#[test]
fn request_envelope_dto_serializes_selected_task_action_readiness_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:selected-task-action".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:selected-task-action".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::SelectedTaskActionReadiness(SelectedTaskActionReadinessQuery {
                project_id: ProjectId("project:dto".to_owned()),
                task_id: nucleus_tasks::TaskId("task:dto".to_owned()),
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
            kind: ServerQueryKind::SelectedTaskActionReadiness(query),
            ..
        }) if query.project_id.0 == "project:dto" && query.task_id.0 == "task:dto"
    ));
    assert!(json.contains("\"kind\":\"selected_task_action_readiness\""));
    assert!(json.contains("\"action\":\"readiness\""));
}
