use crate::control_api::{
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerDiagnosticsQueryResult, ServerDiagnosticsSnapshot, ServerQueryResult,
};
use crate::control_envelope_dto::*;
use crate::diagnostics_read_models::{
    codex_callback_diagnostics, codex_ingestion_diagnostics, codex_interruption_diagnostics,
    codex_live_spawn_smoke_diagnostics, codex_provider_diagnostics, codex_recovery_diagnostics,
    codex_subscription_diagnostics, codex_transport_executor_diagnostics,
    codex_turn_start_diagnostics, effigy_diagnostics, scm_session_diagnostics, steward_diagnostics,
    sync_diagnostics, task_agent_diagnostics,
};
use crate::ids::ServerControlRequestId;
use nucleus_native_harness::NativeEffigyProjectIntegration;

#[test]
fn response_envelope_dto_serializes_all_diagnostics_without_authority() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:all".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::All(empty_diagnostics_snapshot()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert!(matches!(
        decoded.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::All(snapshot),
        } if !snapshot.steward.client_can_mutate
            && !snapshot.effigy.client_can_run_effigy
            && !snapshot.management_sync.client_can_mutate_provider
            && !snapshot.scm_session.client_can_mutate_working_copy
            && snapshot.steward.source_status == "empty"
            && snapshot.effigy.source_status == "disabled"
            && snapshot.management_sync.source_status == "empty"
            && snapshot.scm_session.source_status == "empty"
            && snapshot.task_agent.source_status == "empty"
            && snapshot.codex_provider.source_status == "empty"
            && !snapshot.codex_provider.client_can_control_provider
    ));
    assert!(json.contains("\"type\":\"diagnostics\""));
    assert!(json.contains("\"domain\":\"all\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_codex_provider_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:codex".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CodexProvider(empty_codex_provider_diagnostics()),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::CodexProvider(record),
        } if record.source_status == "empty"
            && !record.client_can_control_provider
            && !record.client_can_mutate_tasks
            && !record.recovery.client_can_resume_provider
    ));
    assert!(json.contains("\"domain\":\"codex_provider\""));
    assert_diagnostics_json_is_sanitized(&json);
}

#[test]
fn response_envelope_dto_serializes_single_diagnostics_domain() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:diagnostics:steward".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::Steward(steward_diagnostics(&[], &[], &[])),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::Diagnostics {
            result: ControlDiagnosticsResultDto::Steward(record),
        } if !record.client_can_mutate
            && record.source_status == "empty"
            && record.proposals.is_empty()
            && record.command_admissions.is_empty()
            && record.command_outcomes.is_empty()
    ));
    assert!(json.contains("\"domain\":\"steward\""));
    assert_diagnostics_json_is_sanitized(&json);
}

fn empty_diagnostics_snapshot() -> ServerDiagnosticsSnapshot {
    ServerDiagnosticsSnapshot {
        steward: steward_diagnostics(&[], &[], &[]),
        effigy: effigy_diagnostics(
            &NativeEffigyProjectIntegration::disabled("effigy unavailable"),
            None,
            None,
        ),
        management_sync: sync_diagnostics(&[], &[], &[], &[]),
        scm_session: scm_session_diagnostics(&[], &[], &[]),
        task_agent: task_agent_diagnostics(&[]),
        codex_provider: empty_codex_provider_diagnostics(),
    }
}

fn empty_codex_provider_diagnostics() -> crate::CodexProviderDiagnosticsDto {
    codex_provider_diagnostics(
        codex_ingestion_diagnostics(&[]),
        codex_live_spawn_smoke_diagnostics(&[]),
        codex_turn_start_diagnostics(&[]),
        codex_subscription_diagnostics(&[], &[]),
        codex_transport_executor_diagnostics(&[], &[], &[], &[]),
        codex_callback_diagnostics(&[]),
        codex_interruption_diagnostics(&[]),
        codex_recovery_diagnostics(&[]),
    )
}

fn assert_diagnostics_json_is_sanitized(json: &str) {
    for forbidden in [
        "raw_stdout",
        "raw_stderr",
        "payload",
        "bytes",
        "credential",
        "secret",
        "command_request",
        "provider_payload",
    ] {
        assert!(
            !json.contains(forbidden),
            "diagnostics DTO should not contain {forbidden}"
        );
    }
}
