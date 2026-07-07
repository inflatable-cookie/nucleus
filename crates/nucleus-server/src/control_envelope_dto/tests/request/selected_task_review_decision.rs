use super::*;

#[test]
fn request_envelope_dto_serializes_selected_task_review_decision_admission_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:review-decision-admission".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:review-decision-admission".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::SelectedTaskReviewDecisionAdmission(
                SelectedTaskReviewDecisionAdmissionQuery {
                    project_id: ProjectId("project:dto".to_owned()),
                    task_id: nucleus_tasks::TaskId("task:dto".to_owned()),
                    action: crate::SelectedTaskReviewDecisionAction::AcceptEvidence,
                    expected_revision: Some(RevisionId("rev:dto".to_owned())),
                    current_revision: Some(RevisionId("rev:dto".to_owned())),
                    reason: None,
                    operator_ref: "operator:desktop".to_owned(),
                    reviewed_evidence_refs: vec!["receipt:dto".to_owned()],
                    idempotency_key: "idempotency:dto".to_owned(),
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
            kind: ServerQueryKind::SelectedTaskReviewDecisionAdmission(query),
            ..
        }) if query.project_id.0 == "project:dto"
            && query.task_id.0 == "task:dto"
            && query.expected_revision == Some(RevisionId("rev:dto".to_owned()))
            && query.current_revision == Some(RevisionId("rev:dto".to_owned()))
            && query.operator_ref == "operator:desktop"
            && query.reviewed_evidence_refs == vec!["receipt:dto".to_owned()]
            && query.idempotency_key == "idempotency:dto"
    ));
    assert!(json.contains("\"kind\":\"selected_task_review_decision_admission\""));
    assert!(json.contains("\"action\":\"dry_run\""));
    assert!(json.contains("\"decision_action\":\"accept_evidence\""));
    assert!(!json.contains("raw_payload"));
}

#[test]
fn request_envelope_dto_serializes_selected_task_review_decision_apply_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:review-decision-apply".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:review-decision-apply".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::SelectedTaskReviewDecisionApply(
                SelectedTaskReviewDecisionApplyQuery {
                    project_id: ProjectId("project:dto".to_owned()),
                    task_id: nucleus_tasks::TaskId("task:dto".to_owned()),
                    action: crate::SelectedTaskReviewDecisionAction::RequestChanges,
                    expected_revision: Some(RevisionId("rev:dto".to_owned())),
                    current_revision: None,
                    reason: Some("needs one more validation ref".to_owned()),
                    operator_ref: "operator:desktop".to_owned(),
                    reviewed_evidence_refs: vec!["receipt:dto".to_owned()],
                    idempotency_key: "idempotency:dto:apply".to_owned(),
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
            kind: ServerQueryKind::SelectedTaskReviewDecisionApply(query),
            ..
        }) if query.project_id.0 == "project:dto"
            && query.task_id.0 == "task:dto"
            && query.reason == Some("needs one more validation ref".to_owned())
            && query.idempotency_key == "idempotency:dto:apply"
    ));
    assert!(json.contains("\"kind\":\"selected_task_review_decision_apply\""));
    assert!(json.contains("\"action\":\"apply\""));
    assert!(json.contains("\"decision_action\":\"request_changes\""));
    assert!(!json.contains("raw_payload"));
}
