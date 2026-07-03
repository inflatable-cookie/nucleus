use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto,
    PlanningCapturePublicationStoppedRequestDiagnosticBucket,
    PlanningCapturePublicationStoppedRequestDiagnostics, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_planning_capture_publication_without_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:planning-capture-publication".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::PlanningCapturePublicationDiagnostics(
                PlanningCapturePublicationStoppedRequestDiagnostics {
                    diagnostics_id: "planning-capture-publication".to_owned(),
                    request_count: 1,
                    persisted_request_count: 1,
                    duplicate_request_count: 0,
                    blocked_request_count: 0,
                    blocker_count: 0,
                    adapter_family_buckets: vec![
                        PlanningCapturePublicationStoppedRequestDiagnosticBucket {
                            label: "snapshot_publication_like".to_owned(),
                            count: 1,
                        },
                    ],
                    operation_buckets: vec![
                        PlanningCapturePublicationStoppedRequestDiagnosticBucket {
                            label: "publish".to_owned(),
                            count: 1,
                        },
                    ],
                    evidence_ref_count: 1,
                    management_file_ref_count: 1,
                    command_execution_permitted: false,
                    runner_handoff_permitted: false,
                    commit_permitted: false,
                    snapshot_permitted: false,
                    publish_permitted: false,
                    push_permitted: false,
                    forge_share_permitted: false,
                    provider_write_permitted: false,
                    projection_import_permitted: false,
                    task_promotion_permitted: false,
                    callback_response_permitted: false,
                    interruption_permitted: false,
                    recovery_permitted: false,
                    raw_payload_retained: false,
                },
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::PlanningCapturePublicationDiagnostics { diagnostics }
            if diagnostics.request_count == 1
                && diagnostics.persisted_request_count == 1
                && diagnostics.adapter_family_buckets[0].label == "snapshot_publication_like"
                && diagnostics.operation_buckets[0].label == "publish"
                && !diagnostics.command_execution_permitted
                && !diagnostics.runner_handoff_permitted
                && !diagnostics.publish_permitted
                && !diagnostics.projection_import_permitted
                && !diagnostics.task_promotion_permitted
    ));
    assert!(json.contains("\"type\":\"planning_capture_publication_diagnostics\""));
    assert!(json.contains("\"command_execution_permitted\":false"));
    assert!(json.contains("\"projection_import_permitted\":false"));
    assert!(json.contains("\"task_promotion_permitted\":false"));
}
