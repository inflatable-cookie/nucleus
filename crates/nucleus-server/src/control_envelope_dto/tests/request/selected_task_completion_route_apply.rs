use super::*;

#[test]
fn request_envelope_dto_serializes_selected_task_completion_route_apply_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:completion-route-apply".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:completion-route-apply".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::SelectedTaskCompletionRouteApply(
                SelectedTaskCompletionRouteApplyQuery {
                    project_id: ProjectId("project:dto".to_owned()),
                    task_id: nucleus_tasks::TaskId("task:dto".to_owned()),
                    expected_revision: Some(RevisionId("rev:dto".to_owned())),
                    operator_ref: "operator:dto".to_owned(),
                    route_admission_id: Some("selected-task-route-admission:task:dto".to_owned()),
                    review_decision_ref: Some("selected-task-review-decision:task:dto".to_owned()),
                    evidence_refs: vec!["checkpoint:dto".to_owned(), "diff:dto".to_owned()],
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
            kind: ServerQueryKind::SelectedTaskCompletionRouteApply(query),
            ..
        }) if query.project_id.0 == "project:dto"
            && query.task_id.0 == "task:dto"
            && query.expected_revision == Some(RevisionId("rev:dto".to_owned()))
            && query.operator_ref == "operator:dto"
            && query.route_admission_id.as_deref() == Some("selected-task-route-admission:task:dto")
            && query.review_decision_ref.as_deref() == Some("selected-task-review-decision:task:dto")
            && query.evidence_refs == vec!["checkpoint:dto".to_owned(), "diff:dto".to_owned()]
    ));
    assert!(json.contains("\"kind\":\"selected_task_completion_route_apply\""));
    assert!(json.contains("\"action\":\"preview\""));
    assert!(json.contains("\"operator_ref\":\"operator:dto\""));
    assert!(json.contains("\"route_admission_id\":\"selected-task-route-admission:task:dto\""));
}
