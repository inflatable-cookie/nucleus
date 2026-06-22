use crate::{
    ControlProviderLiveReadSmokeEvidenceDiagnosticsDto, ControlResponseBodyDto,
    ControlResponseEnvelopeDto, ProviderLiveReadApprovedSmokeEvidenceDiagnostics,
    ServerControlRequestId, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult,
};

#[test]
fn response_envelope_serializes_smoke_evidence_diagnostics_without_raw_payloads() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:provider-live-read-smoke-evidence".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::ProviderLiveReadSmokeEvidenceDiagnostics(diagnostics()),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::ProviderLiveReadSmokeEvidenceDiagnostics { diagnostics }
            if diagnostics.diagnostics_id == "provider-live-read-approved-smoke-evidence-diagnostics"
                && diagnostics.evidence_count == 1
                && diagnostics.promoted_count == 1
                && diagnostics.provider_network_read_performed_count == 1
                && diagnostics.blocker_count == 0
                && !diagnostics.provider_write_executed
                && !diagnostics.task_mutation_executed
                && !diagnostics.raw_provider_payload_retained
    ));
    for forbidden in [
        "access_token",
        "authorization",
        "cookie",
        "raw_stdout",
        "raw_stderr",
        "raw_response_body",
        "credential_material",
    ] {
        assert!(
            !json.contains(forbidden),
            "provider live-read smoke evidence DTO should not contain {forbidden}"
        );
    }
}

#[test]
fn public_dto_type_exposes_no_effect_flags() {
    let dto = ControlProviderLiveReadSmokeEvidenceDiagnosticsDto::from(&diagnostics());

    assert_eq!(dto.provider_network_read_performed_count, 1);
    assert!(!dto.provider_write_executed);
    assert!(!dto.callback_effect_executed);
    assert!(!dto.interruption_effect_executed);
    assert!(!dto.recovery_effect_executed);
    assert!(!dto.task_mutation_executed);
    assert!(!dto.raw_provider_payload_retained);
}

fn diagnostics() -> ProviderLiveReadApprovedSmokeEvidenceDiagnostics {
    ProviderLiveReadApprovedSmokeEvidenceDiagnostics {
        diagnostics_id: "provider-live-read-approved-smoke-evidence-diagnostics".to_owned(),
        evidence_count: 1,
        promoted_count: 1,
        repair_required_count: 0,
        blocked_count: 0,
        duplicate_count: 0,
        provider_network_read_performed_count: 1,
        blocker_count: 0,
        provider_write_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}
