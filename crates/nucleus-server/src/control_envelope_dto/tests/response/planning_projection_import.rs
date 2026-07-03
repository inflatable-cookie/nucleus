use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, PlanningProjectionImportDiagnosticBucket,
    PlanningProjectionImportDiagnostics, ServerControlRequestId, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_planning_projection_import_without_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:planning-projection-import".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::PlanningProjectionImportDiagnostics(
                PlanningProjectionImportDiagnostics {
                    diagnostics_id: "planning-projection-import-diagnostics".to_owned(),
                    candidate_count: 2,
                    ready_candidate_count: 1,
                    blocked_candidate_count: 1,
                    admission_count: 1,
                    admitted_stopped_count: 1,
                    duplicate_noop_count: 0,
                    blocked_admission_count: 0,
                    conflict_count: 1,
                    blocker_count: 1,
                    evidence_ref_count: 2,
                    candidate_status_buckets: vec![PlanningProjectionImportDiagnosticBucket {
                        label: "ready".to_owned(),
                        count: 1,
                    }],
                    admission_status_buckets: vec![PlanningProjectionImportDiagnosticBucket {
                        label: "admitted_stopped".to_owned(),
                        count: 1,
                    }],
                    conflict_kind_buckets: vec![PlanningProjectionImportDiagnosticBucket {
                        label: "artifact_title".to_owned(),
                        count: 1,
                    }],
                    apply_blocked: true,
                    apply_permitted: false,
                    task_promotion_permitted: false,
                    provider_execution_permitted: false,
                    scm_mutation_permitted: false,
                    forge_mutation_permitted: false,
                    raw_payload_retained: false,
                    ui_apply_permitted: false,
                },
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::PlanningProjectionImportDiagnostics { diagnostics }
            if diagnostics.candidate_count == 2
                && diagnostics.ready_candidate_count == 1
                && diagnostics.admitted_stopped_count == 1
                && diagnostics.conflict_count == 1
                && diagnostics.candidate_status_buckets[0].label == "ready"
                && diagnostics.admission_status_buckets[0].label == "admitted_stopped"
                && diagnostics.conflict_kind_buckets[0].label == "artifact_title"
                && diagnostics.apply_blocked
                && !diagnostics.apply_permitted
                && !diagnostics.task_promotion_permitted
                && !diagnostics.provider_execution_permitted
                && !diagnostics.scm_mutation_permitted
                && !diagnostics.forge_mutation_permitted
                && !diagnostics.raw_payload_retained
                && !diagnostics.ui_apply_permitted
    ));
    assert!(json.contains("\"type\":\"planning_projection_import_diagnostics\""));
    assert!(json.contains("\"apply_permitted\":false"));
    assert!(json.contains("\"task_promotion_permitted\":false"));
    assert!(json.contains("\"provider_execution_permitted\":false"));
    assert!(json.contains("\"scm_mutation_permitted\":false"));
    assert!(json.contains("\"forge_mutation_permitted\":false"));
    assert!(json.contains("\"raw_payload_retained\":false"));
    assert!(json.contains("\"ui_apply_permitted\":false"));
}
