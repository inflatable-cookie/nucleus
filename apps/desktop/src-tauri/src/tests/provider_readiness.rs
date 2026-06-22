use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    ControlQueryDto, ControlRequestBodyDto, ControlRequestEnvelopeDto, CONTROL_API_PROTOCOL_FAMILY,
    CONTROL_API_PROTOCOL_VERSION_V1,
};

use crate::DesktopState;

#[test]
fn desktop_state_routes_provider_readiness_overview_query_to_typed_dto() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-provider-readiness-overview-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-provider-readiness-overview".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::ProviderReadinessOverview {
                    query_id: "desktop-query-provider-readiness-overview".to_owned(),
                    action: "overview".to_owned(),
                },
            },
        })
        .expect("desktop provider readiness overview should route through the server adapter");
    let json = serde_json::to_string(&response).expect("response json");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::ProviderReadinessOverview { overview }
            if overview.overview_id == "forge-readiness-overview"
                && overview.projection_id == "forge-read-intent-projection"
                && overview.status == "ready"
                && overview.total_read_intent_count == 3
                && overview.ready_count == 3
                && overview.missing_evidence_family_count == 0
                && overview.supported_read_families == vec![
                    "credential_status".to_owned(),
                    "repository_metadata".to_owned(),
                    "pull_request".to_owned(),
                ]
                && overview.represented_read_families == vec![
                    "credential_status".to_owned(),
                    "repository_metadata".to_owned(),
                    "pull_request".to_owned(),
                ]
                && !overview.credential_resolution_performed
                && !overview.provider_network_call_performed
                && !overview.provider_effect_executed
                && !overview.raw_provider_payload_retained
    ));
    assert_provider_response_is_sanitized(&json, "provider readiness overview");

    let _ = std::fs::remove_file(database_path);
}

#[test]
fn desktop_state_routes_provider_readiness_drilldown_query_to_typed_dto() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-provider-readiness-drilldown-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-provider-readiness-drilldown".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::ProviderReadIntent {
                    query_id: "desktop-query-provider-readiness-drilldown".to_owned(),
                    action: "projection".to_owned(),
                },
            },
        })
        .expect("desktop provider readiness drilldown should route through the server adapter");
    let json = serde_json::to_string(&response).expect("response json");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::ProviderReadIntent { result }
            if result.projection.projection_id == "forge-read-intent-projection"
                && result.projection.total_count == 3
                && result.projection.credential_status_count == 1
                && result.projection.repository_metadata_count == 1
                && result.projection.pull_request_count == 1
                && result.projection.ready_count == 3
                && result.source_counts.credential_status_records == 1
                && result.source_counts.repository_metadata_records == 1
                && result.source_counts.pull_request_records == 1
                && !result.provider_network_call_performed
                && !result.provider_effect_executed
                && !result.raw_provider_payload_retained
    ));
    assert_provider_response_is_sanitized(&json, "provider readiness drilldown");

    let _ = std::fs::remove_file(database_path);
}

fn assert_provider_response_is_sanitized(json: &str, label: &str) {
    for forbidden in [
        "access_token",
        "authorization",
        "raw_request_body",
        "raw_response_body",
        "provider_payload_bytes",
        "credential_material",
    ] {
        assert!(
            !json.contains(forbidden),
            "{label} response should not contain {forbidden}"
        );
    }
}
