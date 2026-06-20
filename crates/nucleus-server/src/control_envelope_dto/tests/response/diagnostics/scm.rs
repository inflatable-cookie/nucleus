use super::*;

#[test]
fn response_envelope_dto_serializes_scm_capture_dry_run_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:diagnostics:scm-capture-dry-run".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRun(empty_scm_capture_dry_run()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::ScmCaptureDryRun(record),
        } if record.plan_count == 0
            && !record.scm_dry_run_authority_granted
            && !record.scm_capture_authority_granted
            && !record.forge_authority_granted
            && !record.raw_material_exposed
    ));
    assert!(json.contains("\"domain\":\"scm_capture_dry_run\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_scm_capture_dry_run_execution_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:diagnostics:scm-capture-dry-run-execution".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureDryRunExecution(
                empty_scm_capture_dry_run_execution(),
            ),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::ScmCaptureDryRunExecution(record),
        } if record.receipt_count == 0
            && !record.scm_capture_executed
            && !record.forge_authority_granted
            && !record.raw_material_exposed
    ));
    assert!(json.contains("\"domain\":\"scm_capture_dry_run_execution\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_git_dry_run_execution_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:diagnostics:git-dry-run-execution".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::GitDryRunExecution(empty_git_dry_run_execution()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::GitDryRunExecution(record),
        } if record.execution_count == 0
            && !record.commit_executed
            && !record.forge_effect_executed
            && !record.provider_write_executed
            && !record.raw_output_retained
    ));
    assert!(json.contains("\"domain\":\"git_dry_run_execution\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_scm_capture_workflow_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:diagnostics:scm-capture-workflow".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureWorkflow(empty_scm_capture_workflow()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::ScmCaptureWorkflow(record),
        } if record.workflow_count == 0
            && record.replay_only
            && !record.scm_mutation_authority_granted
            && !record.provider_authority_granted
            && !record.raw_output_retained
    ));
    assert!(json.contains("\"domain\":\"scm_capture_workflow\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_scm_capture_review_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:scm-capture-review".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReview(empty_scm_capture_review()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::ScmCaptureReview(record),
        } if record.readiness_count == 0
            && !record.operator_decision_created
            && !record.change_request_authority_granted
            && !record.scm_mutation_authority_granted
            && !record.provider_authority_granted
            && !record.raw_output_retained
    ));
    assert!(json.contains("\"domain\":\"scm_capture_review\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_scm_capture_review_decision_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:diagnostics:scm-capture-review-decision".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmCaptureReviewDecision(
                empty_scm_capture_review_decision(),
            ),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::ScmCaptureReviewDecision(record),
        } if record.decision_count == 0
            && !record.change_request_authority_granted
            && !record.scm_mutation_authority_granted
            && !record.provider_authority_granted
            && !record.raw_output_retained
    ));
    assert!(json.contains("\"domain\":\"scm_capture_review_decision\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_scm_change_request_prep_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:diagnostics:scm-change-request-prep".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmChangeRequestPreparation(
                empty_scm_change_request_prep(),
            ),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::ScmChangeRequestPreparation(record),
        } if record.admission_count == 0
            && record.adapter_neutral
            && !record.branch_or_snapshot_authority_granted
            && !record.forge_authority_granted
            && !record.raw_output_retained
    ));
    assert!(json.contains("\"domain\":\"scm_change_request_preparation\""));
    assert_diagnostics_json_is_sanitized(&json);
}
