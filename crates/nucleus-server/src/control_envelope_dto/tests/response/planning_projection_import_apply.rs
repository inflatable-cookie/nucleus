use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto,
    PlanningProjectionImportApplyDiagnosticBucket, PlanningProjectionImportApplyDiagnostics,
    ServerControlRequestId, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_planning_projection_import_apply_without_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:planning-projection-import-apply".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::PlanningProjectionImportApplyDiagnostics(
                PlanningProjectionImportApplyDiagnostics {
                    diagnostics_id: "planning-projection-import-apply-diagnostics".to_owned(),
                    stopped_apply_record_count: 2,
                    persisted_apply_record_count: 1,
                    duplicate_noop_record_count: 0,
                    blocked_apply_record_count: 1,
                    planned_operation_count: 1,
                    skipped_operation_count: 0,
                    blocked_operation_count: 1,
                    ready_count: 1,
                    blocked_count: 1,
                    conflict_count: 1,
                    stale_count: 0,
                    duplicate_noop_count: 0,
                    repair_required_count: 0,
                    blocker_count: 1,
                    evidence_ref_count: 2,
                    record_status_buckets: vec![PlanningProjectionImportApplyDiagnosticBucket {
                        label: "persisted".to_owned(),
                        count: 1,
                    }],
                    blocker_buckets: vec![PlanningProjectionImportApplyDiagnosticBucket {
                        label: "ConflictStaged".to_owned(),
                        count: 1,
                    }],
                    active_planning_mutation_permitted: false,
                    task_creation_permitted: false,
                    task_promotion_permitted: false,
                    projection_write_permitted: false,
                    agent_scheduling_permitted: false,
                    provider_execution_permitted: false,
                    scm_mutation_permitted: false,
                    forge_mutation_permitted: false,
                    semantic_merge_permitted: false,
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
        ControlResponseBodyDto::PlanningProjectionImportApplyDiagnostics { diagnostics }
            if diagnostics.stopped_apply_record_count == 2
                && diagnostics.ready_count == 1
                && diagnostics.blocked_count == 1
                && diagnostics.conflict_count == 1
                && !diagnostics.active_planning_mutation_permitted
                && !diagnostics.raw_payload_retained
                && !diagnostics.private_planning_body_exposed
                && !diagnostics.provider_payload_exposed
                && !diagnostics.source_body_exposed
    ));
    assert!(json.contains("\"type\":\"planning_projection_import_apply_diagnostics\""));
    assert!(json.contains("\"active_planning_mutation_permitted\":false"));
    assert!(json.contains("\"provider_execution_permitted\":false"));
    assert!(json.contains("\"raw_payload_retained\":false"));
    assert!(json.contains("\"private_planning_body_exposed\":false"));
}
