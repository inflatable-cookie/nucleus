use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, PlanningProjectionFileWriteDiagnostics,
    ServerControlRequestId, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_planning_projection_file_write_diagnostics_without_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:planning-projection-write".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::PlanningProjectionFileWriteDiagnostics(
                PlanningProjectionFileWriteDiagnostics {
                    materialized_planning_artifact_files: 1,
                    materialized_planning_task_seed_files: 1,
                    invalid_ref_count: 0,
                    unsupported_record_count: 0,
                    encode_failure_count: 0,
                    skipped_write_count: 0,
                    issues: Vec::new(),
                    import_or_apply_authority: false,
                    scm_mutation_authority: false,
                },
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::PlanningProjectionFileWriteDiagnostics { diagnostics }
            if diagnostics.materialized_planning_artifact_files == 1
                && diagnostics.materialized_planning_task_seed_files == 1
                && diagnostics.issues.is_empty()
                && !diagnostics.import_or_apply_authority
                && !diagnostics.scm_mutation_authority
    ));
    assert!(json.contains("\"type\":\"planning_projection_file_write_diagnostics\""));
    assert!(json.contains("\"import_or_apply_authority\":false"));
    assert!(json.contains("\"scm_mutation_authority\":false"));
}
