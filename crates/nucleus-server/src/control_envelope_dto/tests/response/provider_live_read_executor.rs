use crate::{
    ControlProviderLiveReadExecutorDiagnosticsDto, ControlResponseBodyDto,
    ControlResponseEnvelopeDto, ProviderLiveReadServerExecutorDiagnostics, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_live_read_executor_diagnostics_without_effect_authority() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:provider-live-read-executor".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::ProviderLiveReadExecutorDiagnostics(diagnostics()),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::ProviderLiveReadExecutorDiagnostics { diagnostics }
            if diagnostics.diagnostics_id == "provider-live-read-server-executor-diagnostics"
                && diagnostics.request_count == 1
                && diagnostics.ready_request_count == 1
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
        "raw_request_body",
        "raw_response_body",
        "provider_payload_bytes",
    ] {
        assert!(
            !json.contains(forbidden),
            "provider live-read executor DTO should not contain {forbidden}"
        );
    }
}

#[test]
fn public_dto_type_exposes_no_effect_flags() {
    let dto = ControlProviderLiveReadExecutorDiagnosticsDto::from(&diagnostics());

    assert_eq!(dto.provider_network_read_performed_count, 1);
    assert!(!dto.provider_write_executed);
    assert!(!dto.callback_effect_executed);
    assert!(!dto.interruption_effect_executed);
    assert!(!dto.recovery_effect_executed);
    assert!(!dto.task_mutation_executed);
    assert!(!dto.raw_provider_payload_retained);
}

fn diagnostics() -> ProviderLiveReadServerExecutorDiagnostics {
    ProviderLiveReadServerExecutorDiagnostics {
        diagnostics_id: "provider-live-read-server-executor-diagnostics".to_owned(),
        request_count: 1,
        ready_request_count: 1,
        blocked_request_count: 0,
        descriptor_ready_count: 1,
        sanitized_output_count: 1,
        parse_error_count: 0,
        receipt_count: 1,
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
