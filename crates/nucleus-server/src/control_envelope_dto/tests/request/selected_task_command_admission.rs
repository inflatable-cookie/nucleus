use super::*;

#[test]
fn request_envelope_dto_serializes_selected_task_command_admission_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:command-admission".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:command-admission".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::SelectedTaskCommandAdmission(
                SelectedTaskCommandAdmissionQuery {
                    project_id: ProjectId("project:dto".to_owned()),
                    task_id: nucleus_tasks::TaskId("task:dto".to_owned()),
                    family: crate::SelectedTaskActionFamily::StartSelectedTask,
                    expected_revision: Some(RevisionId("rev:dto".to_owned())),
                    reason: None,
                    operator_ref: "operator:desktop".to_owned(),
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
            kind: ServerQueryKind::SelectedTaskCommandAdmission(query),
            ..
        }) if query.project_id.0 == "project:dto"
            && query.task_id.0 == "task:dto"
            && query.expected_revision == Some(RevisionId("rev:dto".to_owned()))
            && query.operator_ref == "operator:desktop"
    ));
    assert!(json.contains("\"kind\":\"selected_task_command_admission\""));
    assert!(json.contains("\"action\":\"dry_run\""));
    assert!(json.contains("\"family\":\"start_selected_task\""));
}
