use super::*;

#[test]
fn response_envelope_dto_serializes_live_evidence_completion_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:completion".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(empty_completion_diagnostics()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::LiveEvidenceCompletion(record),
        } if record.timeline_entry_count == 0
            && !record.client_mutation_authority
            && !record.provider_authority_granted
            && !record.scm_authority_granted
    ));
    assert!(json.contains("\"domain\":\"live_evidence_completion\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_completion_scm_readiness_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:completion-scm".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmReadiness(empty_completion_scm_diagnostics()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::CompletionScmReadiness(record),
        } if record.candidate_count == 0
            && record.repair_required
            && !record.scm_authority_granted
            && !record.forge_authority_granted
            && !record.provider_authority_granted
    ));
    assert!(json.contains("\"domain\":\"completion_scm_readiness\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_completion_scm_capture_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:completion-capture".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapture(empty_completion_scm_capture()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::CompletionScmCapture(record),
        } if record.admission_count == 0
            && !record.scm_capture_executed
            && !record.forge_change_request_created
            && !record.raw_material_exposed
    ));
    assert!(json.contains("\"domain\":\"completion_scm_capture\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_completion_scm_capture_preparation_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:diagnostics:completion-preparation".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CompletionScmCapturePreparation(
                empty_completion_scm_capture_preparation(),
            ),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::CompletionScmCapturePreparation(record),
        } if record.plan_count == 0
            && !record.scm_capture_authority_granted
            && !record.forge_authority_granted
            && !record.raw_material_exposed
    ));
    assert!(json.contains("\"domain\":\"completion_scm_capture_preparation\""));
    assert_diagnostics_json_is_sanitized(&json);
}
