use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    ControlQueryDto, ControlRequestBodyDto, ControlRequestEnvelopeDto, CONTROL_API_PROTOCOL_FAMILY,
    CONTROL_API_PROTOCOL_VERSION_V1,
};

use crate::DesktopState;

#[test]
fn desktop_state_routes_product_workflow_summary_query_to_typed_dto() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-product-workflow-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-product-workflow".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::ProductWorkflowSummary {
                    query_id: "desktop-query-product-workflow".to_owned(),
                    action: "summary".to_owned(),
                    project_id: "project:nucleus-local".to_owned(),
                },
            },
        })
        .expect("desktop product workflow query should route through the server adapter");
    let json = serde_json::to_string(&response).expect("response json");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::ProductWorkflowSummary { summary }
            if summary.project_id == "project:nucleus-local"
                && summary.project.display_name == Some("Nucleus Local".to_owned())
                && summary.source_counts.task_candidates == 1
                && summary.task_lanes.iter().any(|lane| lane.lane == "ready" && lane.count == 1)
                && !summary.no_effects.task_mutation_performed
                && !summary.no_effects.provider_execution_performed
                && !summary.no_effects.provider_write_performed
                && !summary.no_effects.scm_or_forge_mutation_performed
                && !summary.no_effects.accepted_memory_apply_performed
                && !summary.no_effects.projection_write_performed
                && !summary.no_effects.agent_scheduling_performed
                && !summary.no_effects.ui_effect_performed
    ));
    assert_product_workflow_response_is_sanitized(&json);

    let _ = std::fs::remove_file(database_path);
}

fn assert_product_workflow_response_is_sanitized(json: &str) {
    for forbidden in [
        "access_token",
        "authorization",
        "raw_request_body",
        "raw_response_body",
        "provider_payload_bytes",
        "credential_material",
        "terminal_stream",
    ] {
        assert!(
            !json.contains(forbidden),
            "product workflow response should not contain {forbidden}"
        );
    }
}
