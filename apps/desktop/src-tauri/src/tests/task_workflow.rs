use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    ControlQueryDto, ControlRequestBodyDto, ControlRequestEnvelopeDto, CONTROL_API_PROTOCOL_FAMILY,
    CONTROL_API_PROTOCOL_VERSION_V1,
};

use crate::DesktopState;

#[test]
fn desktop_state_routes_task_workflow_drilldown_query_to_typed_dto() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-task-workflow-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-task-workflow".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::TaskWorkflowDrilldown {
                    query_id: "desktop-query-task-workflow".to_owned(),
                    action: "drilldown".to_owned(),
                    project_id: "project:nucleus-local".to_owned(),
                    task_id: "task:nucleus-local:bootstrap".to_owned(),
                },
            },
        })
        .expect("desktop task workflow drilldown should route through the server adapter");
    let json = serde_json::to_string(&response).expect("response json");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::TaskWorkflowDrilldown { drilldown }
            if drilldown.project_id == "project:nucleus-local"
                && drilldown.task_id == "task:nucleus-local:bootstrap"
                && drilldown
                    .task
                    .as_ref()
                    .is_some_and(|task| task.title == "Review Nucleus task workflow")
                && drilldown.source_counts.task_records == 1
                && !drilldown.no_effects.task_mutation_performed
                && !drilldown.no_effects.provider_execution_performed
                && !drilldown.no_effects.provider_write_performed
                && !drilldown.no_effects.scm_or_forge_mutation_performed
                && !drilldown.no_effects.accepted_memory_apply_performed
                && !drilldown.no_effects.planning_apply_performed
                && !drilldown.no_effects.projection_write_performed
                && !drilldown.no_effects.agent_scheduling_performed
                && !drilldown.no_effects.ui_effect_performed
    ));
    assert_task_workflow_response_is_sanitized(&json);

    let _ = std::fs::remove_file(database_path);
}

fn assert_task_workflow_response_is_sanitized(json: &str) {
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
            "task workflow drilldown response should not contain {forbidden}"
        );
    }
}
