use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto,
    PlanningProjectionImportActiveApplyDiagnosticBucket,
    PlanningProjectionImportActiveApplyDiagnostics, ServerControlRequestId, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_planning_projection_import_active_apply_without_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:planning-projection-import-active-apply".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::PlanningProjectionImportActiveApplyDiagnostics(
                PlanningProjectionImportActiveApplyDiagnostics {
                    diagnostics_id: "planning-projection-import-active-apply-diagnostics"
                        .to_owned(),
                    admission_record_count: 2,
                    admitted_record_count: 1,
                    duplicate_noop_record_count: 0,
                    blocked_record_count: 1,
                    operation_ref_count: 1,
                    evidence_ref_count: 2,
                    blocker_count: 1,
                    stale_count: 1,
                    conflict_count: 0,
                    unsupported_count: 0,
                    repair_required_count: 0,
                    missing_ref_count: 0,
                    record_status_buckets: vec![
                        PlanningProjectionImportActiveApplyDiagnosticBucket {
                            label: "admitted_stopped".to_owned(),
                            count: 1,
                        },
                    ],
                    blocker_buckets: vec![PlanningProjectionImportActiveApplyDiagnosticBucket {
                        label: "StaleRevision".to_owned(),
                        count: 1,
                    }],
                    active_planning_mutation_permitted: false,
                    executor_invocation_permitted: false,
                    task_creation_permitted: false,
                    task_promotion_permitted: false,
                    projection_write_permitted: false,
                    agent_scheduling_permitted: false,
                    provider_execution_permitted: false,
                    scm_mutation_permitted: false,
                    forge_mutation_permitted: false,
                    semantic_merge_permitted: false,
                    accepted_memory_mutation_permitted: false,
                    callback_permitted: false,
                    interruption_permitted: false,
                    recovery_permitted: false,
                    raw_payload_retained: false,
                    payload_body_included: false,
                    private_planning_body_exposed: false,
                    provider_payload_exposed: false,
                    source_body_exposed: false,
                    ui_apply_permitted: false,
                },
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::PlanningProjectionImportActiveApplyDiagnostics { diagnostics }
            if diagnostics.admission_record_count == 2
                && diagnostics.admitted_record_count == 1
                && diagnostics.blocked_record_count == 1
                && diagnostics.stale_count == 1
                && !diagnostics.active_planning_mutation_permitted
                && !diagnostics.executor_invocation_permitted
                && !diagnostics.raw_payload_retained
                && !diagnostics.private_planning_body_exposed
                && !diagnostics.provider_payload_exposed
                && !diagnostics.source_body_exposed
    ));
    assert!(json.contains("\"type\":\"planning_projection_import_active_apply_diagnostics\""));
    assert!(json.contains("\"active_planning_mutation_permitted\":false"));
    assert!(json.contains("\"executor_invocation_permitted\":false"));
    assert!(json.contains("\"raw_payload_retained\":false"));
    assert!(json.contains("\"private_planning_body_exposed\":false"));
}
